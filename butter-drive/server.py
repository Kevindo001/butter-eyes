#!/usr/bin/env python3
"""
butter-drive: tiny WebSocket motor server for Butter (Jetson Orin Nano, 4x mecanum, 2x L298N).

    ~/Projects/butter/butter_env/bin/python3 server.py     # real motors (Jetson.GPIO lives in butter_env)
    python3 server.py --mock                               # anywhere: prints motor states, no GPIO
    options: --speed 0.35 (0.1-1.0, default duty)  --port 8770

Protocol (JSON over ws://<jetson>:8770):
  -> {"cmd":"hello"}                          <- {"type":"hello","robot":"butter","mock":bool}
  -> {"cmd":"drive","dir":"forward","ttl":450} <- {"type":"ack","dir":"forward"}
       dir: forward|backward|left|right|strafe_left|strafe_right|stop   (left/right = rotate in place)
  -> {"cmd":"speed","value":0.35}             <- {"type":"speed","value":0.35}   (0.1-1.0)
  -> {"cmd":"say","text":"hi","mp3":"<base64>"}  plays mp3 if given (ffmpeg), else Piper speaks the text
  -> {"cmd":"status"}                         <- {"type":"status","dir":..,"clients":n}

SAFETY
  * Motors stop if no drive command arrives within its ttl (default 450 ms, capped at 1000 ms).
  * Motors stop when the controlling client disconnects, and on exit/SIGTERM.
  * Only one controller at a time: the newest client to send "drive" owns the motors.
  * The L298N enable pins are LOW whenever stopped, so a stuck direction pin can't move a wheel.
  * Stop anything else that drives the GPIO (follow-me, wasd scripts) before running this.

Wiring is copied from ~/Projects/butter/config/motor.md (confirmed working there).
"""
import argparse
import asyncio
import base64
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

import websockets

log = logging.getLogger("butter-drive")

# BOARD numbering. Each wheel = (IN1, IN2); forward = IN2 HIGH, IN1 LOW.
WHEELS = {
    "LF": (11, 13),
    "LR": (16, 15),  # wired reversed on the chassis; the swapped order compensates
    "RF": (33, 31),
    "RR": (29, 18),
}
# L298N enable pins (jumpers removed): software PWM on these sets the speed.
ENABLE_PINS = (12, 35, 7, 32)  # left ENA, ENB, right ENA, ENB
PWM_PERIOD = 0.02  # 50 Hz, same as test/10_wasd_multikey_drive.py
MIN_SPEED, MAX_SPEED = 0.05, 1.0
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
PIPER_MODEL = os.path.expanduser("~/Projects/butter/models/piper/en_US-lessac-medium.onnx")
# piper is installed inside butter_env (next to the python running this), not on PATH
PIPER = shutil.which("piper") or next((p for p in [os.path.join(os.path.dirname(sys.executable), "piper")] if os.path.exists(p)), None)


# The speaker's own volume is already at its maximum and the voice already peaks at full scale, so
# the only way to be louder is to squeeze the quiet parts up (soft limiting). 3 is about +7 dB:
# clearly louder, still clean. 1 turns it off. Override with BUTTER_LOUD.
LOUD = max(1.0, float(os.environ.get("BUTTER_LOUD", "3")))


def louder(pcm16: bytes) -> bytes:
    if LOUD <= 1.0:
        return pcm16
    import numpy as np
    x = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
    y = np.tanh(LOUD * x) / np.tanh(LOUD)
    return (y * 32767.0).astype(np.int16).tobytes()


# Piper kept loaded in memory. Starting the piper program for every line cost about 2 s before the
# first sound (it reloads the voice model each time); with the voice already loaded it is ~0.15 s.
VOICE = None


def load_voice():
    """Load the voice once, in the background at startup, and run one throwaway line to warm it up."""
    global VOICE
    try:
        from piper import PiperVoice
        v = PiperVoice.load(PIPER_MODEL)
        for _ in v.synthesize("ready."):
            pass
        VOICE = v
        log.info("voice loaded and warm (sample rate %s)", v.config.sample_rate)
    except Exception as e:  # fall back to starting the piper program per line
        log.warning("could not keep the voice in memory (%s): speech will start slower", e)


def speak_warm(text, dev):
    """Synthesise sentence by sentence straight into the speaker, so sound starts on the first sentence.

    The speaker can be briefly "busy" (the desktop sound service holds it for a few seconds after
    the previous sound). Then aplay exits at once; we wait a moment and try again with the audio we
    already have, instead of dropping the line.
    """
    t0 = time.time()
    gen = iter(VOICE.synthesize(text))
    bufs, first, tries = [], None, 0
    cmd = ["aplay", "-q", "-D", dev, "-t", "raw", "-f", "S16_LE", "-r", str(VOICE.config.sample_rate), "-c", "1"]
    while tries < 40:
        tries += 1
        play = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for b in bufs:
                play.stdin.write(b)
            for chunk in gen:
                bufs.append(louder(chunk.audio_int16_bytes))
                if first is None:
                    first = time.time() - t0
                play.stdin.write(bufs[-1])
                play.stdin.flush()
            play.stdin.close()
            if play.wait() == 0:
                break
        except (BrokenPipeError, OSError):
            play.wait()
        time.sleep(0.15)
    log.info("say: voice ready after %.2f s, speaker took %d tr%s", first if first is not None else -1, tries, "y" if tries == 1 else "ies")


def usb_speaker():
    """ALSA device of the USB speaker (its card number changes with what's plugged in), or None."""
    try:
        out = subprocess.run(["aplay", "-l"], capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if line.startswith("card ") and "USB" in line:
            return f"plughw:{line.split()[1].rstrip(':')},0"
    return None


class Motors:
    def __init__(self, mock: bool, speed: float = 0.35):
        self.mock = mock
        self.state = "stop"
        self.speed = max(MIN_SPEED, min(MAX_SPEED, speed))
        self.history = []  # (time, dir) for tests/debugging
        self._run = True
        if not mock:
            import Jetson.GPIO as GPIO  # noqa: N814
            self.GPIO = GPIO
            GPIO.setwarnings(False)
            GPIO.setmode(GPIO.BOARD)
            for a, b in WHEELS.values():
                GPIO.setup(a, GPIO.OUT, initial=GPIO.LOW)
                GPIO.setup(b, GPIO.OUT, initial=GPIO.LOW)
            GPIO.setup(list(ENABLE_PINS), GPIO.OUT, initial=GPIO.LOW)
            threading.Thread(target=self._pwm_loop, daemon=True).start()

    def _pwm_loop(self):
        """Software PWM on the enable pins. Enable stays LOW whenever stopped."""
        G, pins = self.GPIO, list(ENABLE_PINS)
        while self._run:
            duty = self.speed if self.state != "stop" else 0.0
            if duty <= 0.0:
                G.output(pins, G.LOW)
                time.sleep(PWM_PERIOD)
            elif duty >= 1.0:
                G.output(pins, G.HIGH)
                time.sleep(PWM_PERIOD)
            else:
                G.output(pins, G.HIGH)
                time.sleep(PWM_PERIOD * duty)
                G.output(pins, G.LOW)
                time.sleep(PWM_PERIOD * (1 - duty))
        G.output(pins, G.LOW)

    def set_speed(self, value):
        self.speed = max(MIN_SPEED, min(MAX_SPEED, float(value)))
        return self.speed

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
        self._run = False
        if not self.mock:
            time.sleep(PWM_PERIOD * 2)
            self.GPIO.output(list(ENABLE_PINS), self.GPIO.LOW)
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
                    await ws.send(json.dumps({"type": "hello", "robot": "butter", "mock": self.m.mock, "speed": self.m.speed}))
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
                elif cmd == "speed":
                    try:
                        v = self.m.set_speed(msg.get("value"))
                        await ws.send(json.dumps({"type": "speed", "value": v}))
                    except (TypeError, ValueError):
                        await ws.send(json.dumps({"type": "error", "error": "bad speed"}))
                elif cmd == "say":
                    asyncio.create_task(self.say(msg.get("text", ""), msg.get("mp3")))
                elif cmd == "status":
                    await ws.send(json.dumps({"type": "status", "dir": self.m.state, "speed": self.m.speed, "clients": len(self.clients)}))
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
                log.info("say: %r (%s)", text, "mp3" if mp3_b64 else "piper")
                return
            dev = usb_speaker()
            if not dev:
                log.warning("say: no USB speaker found (aplay -l)")
                return
            play = ["aplay", "-q", "-D", dev]
            try:
                if mp3_b64 and shutil.which("ffmpeg"):
                    boost = ["-af", "volume=9dB,alimiter=limit=0.97:level=disabled"] if LOUD > 1.0 else []  # same idea for the mp3 voice
                    dec = ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *boost, "-ar", "44100", "-ac", "2", "-f", "wav", "pipe:1"]
                    p1 = subprocess.Popen(dec, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                    p2 = subprocess.Popen(play, stdin=p1.stdout)
                    p1.stdin.write(base64.b64decode(mp3_b64)); p1.stdin.close()
                    await asyncio.to_thread(p2.wait)
                elif text and VOICE is not None:
                    await asyncio.to_thread(speak_warm, text, dev)
                elif text and PIPER and os.path.exists(PIPER_MODEL):
                    p1 = subprocess.Popen([PIPER, "--model", PIPER_MODEL, "--output_raw"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                    p2 = subprocess.Popen(["sox", "-t", "raw", "-r", "22050", "-e", "signed", "-b", "16", "-c", "1", "-",
                                           "-t", "wav", "-r", "44100", "-c", "2", "-"], stdin=p1.stdout, stdout=subprocess.PIPE)
                    p3 = subprocess.Popen(play, stdin=p2.stdout)
                    p1.stdin.write(text.encode()); p1.stdin.close()
                    await asyncio.to_thread(p3.wait)
                else:
                    log.warning("say: nothing to speak with (no mp3, and Piper not found)")
            except Exception as e:  # never let audio kill the motor server
                log.error("say failed: %s", e)


async def main(args):
    motors = Motors(args.mock, args.speed)
    srv = Server(motors)
    if not args.mock and os.path.exists(PIPER_MODEL):
        threading.Thread(target=load_voice, daemon=True).start()  # never delays the motors coming up
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
    ap.add_argument("--speed", type=float, default=0.35, help="motor duty 0.1-1.0")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main(a))
