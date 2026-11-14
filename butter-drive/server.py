#!/usr/bin/env python3
"""
butter-drive: tiny WebSocket motor server for Butter (Jetson Orin Nano, 4x mecanum, on/off H-bridges).

    python3 server.py                 # real motors (Jetson.GPIO)
    python3 server.py --mock          # anywhere: prints motor states, no GPIO

Protocol (JSON over ws://<jetson>:8770):
  -> {"cmd":"hello"}                          <- {"type":"hello","robot":"butter","mock":bool}
  -> {"cmd":"drive","dir":"forward","ttl":450} <- {"type":"ack","dir":"forward"}
       dir: forward|backward|left|right|strafe_left|strafe_right|stop   (left/right = rotate in place)
  -> {"cmd":"say","text":"hi","mp3":"<base64>"}  plays mp3 if given (ffmpeg), else espeak text
  -> {"cmd":"status"}                         <- {"type":"status","dir":..,"clients":n}

SAFETY
  * Motors stop if no drive command arrives within its ttl (default 450 ms, capped at 1000 ms).
  * Motors stop when the controlling client disconnects, and on exit/SIGTERM.
  * Only one controller at a time: the newest client to send "drive" owns the motors.
  * Stop any other service that drives the GPIO (e.g. the follow-me loop) before running this.
"""
import argparse
import asyncio
import base64
import json
import logging
import shutil
import signal
import subprocess
import time

import websockets

log = logging.getLogger("butter-drive")

# Pin map (BOARD numbering) from Anh's Butter notes. Each wheel = (IN1, IN2); forward = IN2 HIGH, IN1 LOW.
WHEELS = {
    "LF": (11, 13),
    "LR": (15, 16),
    "RF": (33, 31),
    "RR": (29, 18),
}
# +1 forward, -1 backward, 0 off. Mecanum X-roller layout.
PATTERNS = {
    "stop":         {"LF": 0,  "LR": 0,  "RF": 0,  "RR": 0},
    "forward":      {"LF": 1,  "LR": 1,  "RF": 1,  "RR": 1},
    "backward":     {"LF": -1, "LR": -1, "RF": -1, "RR": -1},
    "left":         {"LF": -1, "LR": -1, "RF": 1,  "RR": 1},   # rotate counter-clockwise
    "right":        {"LF": 1,  "LR": 1,  "RF": -1, "RR": -1},  # rotate clockwise
    "strafe_left":  {"LF": -1, "LR": 1,  "RF": 1,  "RR": -1},
    "strafe_right": {"LF": 1,  "LR": -1, "RF": -1, "RR": 1},
}
MAX_TTL_MS = 1000
# Settings from the existing Butter audio pipeline (speaker = card 2, S16_LE 44.1k stereo only)
APLAY = ["aplay", "-q", "-D", "hw:2,0"]
ESPEAK = ["espeak", "-v", "en-us+m5", "-s", "170", "--stdout"]


class Motors:
    def __init__(self, mock: bool):
        self.mock = mock
        self.state = "stop"
        self.history = []  # (time, dir) for tests/debugging
        if not mock:
            import Jetson.GPIO as GPIO  # noqa: N814
            self.GPIO = GPIO
            GPIO.setwarnings(False)
            GPIO.setmode(GPIO.BOARD)
            for a, b in WHEELS.values():
                GPIO.setup(a, GPIO.OUT, initial=GPIO.LOW)
                GPIO.setup(b, GPIO.OUT, initial=GPIO.LOW)

    def pins_for(self, direction):
        """Return {pin: level} for a direction. Pure, used by tests."""
        out = {}
        for wheel, sgn in PATTERNS[direction].items():
            in1, in2 = WHEELS[wheel]
            out[in1] = 1 if sgn < 0 else 0
            out[in2] = 1 if sgn > 0 else 0
        return out

    def set(self, direction):
        if direction not in PATTERNS:
            raise ValueError(direction)
        if direction == self.state:
            return
        levels = self.pins_for(direction)
        if not self.mock:
            # all low first so an H-bridge never sees IN1=IN2=1 mid-switch
            for pin in levels:
                self.GPIO.output(pin, self.GPIO.LOW)
            for pin, lvl in levels.items():
                if lvl:
                    self.GPIO.output(pin, self.GPIO.HIGH)
        self.state = direction
        self.history.append((time.monotonic(), direction))
        log.info("motors -> %s", direction)

    def cleanup(self):
        self.set("stop")
        if not self.mock:
            self.GPIO.cleanup()


class Server:
    def __init__(self, motors: Motors):
        self.m = motors
        self.deadline = 0.0
        self.owner = None
        self.clients = set()
        self.say_lock = asyncio.Lock()

    async def watchdog(self):
        while True:
            await asyncio.sleep(0.05)
            if self.m.state != "stop" and time.monotonic() > self.deadline:
                self.m.set("stop")
                log.warning("watchdog: no fresh command, stopped")
                await self.broadcast({"type": "watchdog"})

    async def broadcast(self, msg):
        for ws in list(self.clients):
            try:
                await ws.send(json.dumps(msg))
            except Exception:
                pass

    async def handler(self, ws):
        self.clients.add(ws)
        log.info("client connected (%d)", len(self.clients))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                cmd = msg.get("cmd")
                if cmd == "hello":
                    await ws.send(json.dumps({"type": "hello", "robot": "butter", "mock": self.m.mock}))
                elif cmd == "drive":
                    d = msg.get("dir", "stop")
                    if d not in PATTERNS:
                        await ws.send(json.dumps({"type": "error", "error": f"bad dir {d}"}))
                        continue
                    self.owner = ws
                    ttl = min(float(msg.get("ttl", 450)), MAX_TTL_MS) / 1000
                    self.deadline = time.monotonic() + ttl
                    self.m.set(d)
                    await ws.send(json.dumps({"type": "ack", "dir": d}))
                elif cmd == "say":
                    asyncio.create_task(self.say(msg.get("text", ""), msg.get("mp3")))
                elif cmd == "status":
                    await ws.send(json.dumps({"type": "status", "dir": self.m.state, "clients": len(self.clients)}))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            if ws is self.owner:
                self.m.set("stop")
                self.owner = None
                log.info("controller disconnected: stopped")

    async def say(self, text, mp3_b64):
        async with self.say_lock:
            if self.m.mock:
                log.info("say: %r (%s)", text, "mp3" if mp3_b64 else "espeak")
                return
            try:
                if mp3_b64 and shutil.which("ffmpeg"):
                    data = base64.b64decode(mp3_b64)
                    dec = ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ar", "44100", "-ac", "2", "-f", "wav", "pipe:1"]
                    p1 = subprocess.Popen(dec, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                    p2 = subprocess.Popen(APLAY, stdin=p1.stdout)
                    p1.stdin.write(data); p1.stdin.close()
                    await asyncio.to_thread(p2.wait)
                elif text:
                    p1 = subprocess.Popen(ESPEAK + [text], stdout=subprocess.PIPE)
                    p2 = subprocess.Popen(["sox", "-t", "wav", "-", "-t", "wav", "-r", "44100", "-c", "2", "-"],
                                          stdin=p1.stdout, stdout=subprocess.PIPE)
                    p3 = subprocess.Popen(APLAY, stdin=p2.stdout)
                    await asyncio.to_thread(p3.wait)
            except Exception as e:  # never let audio kill the motor server
                log.error("say failed: %s", e)


async def main(args):
    motors = Motors(args.mock)
    srv = Server(motors)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, stop.set)
    wd = asyncio.create_task(srv.watchdog())
    async with websockets.serve(srv.handler, args.host, args.port, ping_interval=2, ping_timeout=2):
        log.info("butter-drive on ws://%s:%d (%s)", args.host, args.port, "MOCK" if args.mock else "GPIO")
        await stop.wait()
    wd.cancel()
    motors.cleanup()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--mock", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main(a))
