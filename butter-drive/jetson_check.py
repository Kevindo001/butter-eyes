#!/usr/bin/env python3
"""
Butter bring-up check. Run ON THE JETSON with the butter_env Python:

    PY=~/Projects/butter/butter_env/bin/python3
    $PY jetson_check.py                 # packages, camera, speaker, port (nothing moves)
    $PY jetson_check.py --wheel LF      # pulse ONE wheel forward then backward (0.6 s each)
    $PY jetson_check.py --move forward  # whole robot: forward|backward|left|right, 0.8 s
    $PY jetson_check.py --all-wheels    # each wheel in turn, asks you to confirm
    options: --speed 0.35   --secs 0.8

PUT BUTTER ON BLOCKS (wheels off the ground) before any motor step.
"""
import argparse
import glob
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
results = []


def rec(name, status, note=""):
    results.append((name, status, note))
    print(f"  [{status}] {name}{' - ' + note if note else ''}", flush=True)


def ask(q):
    try:
        return input(f"    {q} [y/n] ").strip().lower().startswith("y")
    except EOFError:
        return False


def check_basics():
    print("\n== Basics")
    try:
        import websockets
        rec("websockets", "PASS", websockets.__version__)
    except ImportError:
        rec("websockets", "FAIL", "use ~/Projects/butter/butter_env/bin/python3")
    try:
        import Jetson.GPIO as GPIO
        rec("Jetson.GPIO", "PASS", f"{GPIO.VERSION} {GPIO.model}")
    except Exception as e:
        rec("Jetson.GPIO", "FAIL", f"{e} (use the butter_env python)")
    r = subprocess.run(["systemctl", "is-active", "butter-pinmux.service"], capture_output=True, text=True)
    rec("butter-pinmux.service", "PASS" if r.stdout.strip() == "active" else "FAIL", r.stdout.strip() + " (motor pins need it)")
    busy = subprocess.run(["pgrep", "-af", "follow_me|wasd|gpio_hold_high|remote_control|butter_brain"], capture_output=True, text=True).stdout.strip()
    rec("nothing else driving motors", "WARN" if busy else "PASS", busy.replace("\n", " | ")[:160])


def check_camera():
    print("\n== Camera")
    devs = sorted(glob.glob("/dev/video*"))
    rec("video devices", "PASS" if devs else "FAIL", ", ".join(devs) or "no camera detected: check the USB plug")
    streaming = False
    try:
        with urllib.request.urlopen("http://127.0.0.1:5600/", timeout=3) as r:
            streaming = "multipart" in r.headers.get("Content-Type", "")
    except Exception:
        pass
    rec("stream on :5600", "PASS" if streaming else "WARN", "" if streaming else "not running; start: python3 camera_server.py")
    if devs and not streaming:
        try:
            from camera_server import open_camera
            cap = open_camera(640, 480)
            ok, frame = cap.read() if cap else (False, None)
            if cap:
                cap.release()
            rec("grab a frame", "PASS" if ok else "FAIL", f"{frame.shape[1]}x{frame.shape[0]}" if ok else "no camera returned a frame")
        except ImportError:
            rec("grab a frame", "SKIP", "no OpenCV in this python")


def check_speaker(play):
    print("\n== Speaker")
    from server import usb_speaker
    dev = usb_speaker()
    if not dev:
        rec("USB speaker", "FAIL", "not detected (aplay -l shows no USB card): check its USB plug / power")
        return
    rec("USB speaker", "PASS", dev)
    if play:
        cmd = f"sox -n -r 44100 -c 2 -t wav - synth 0.4 sine 660 vol 0.4 | aplay -q -D {dev}"
        r = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=10)
        rec("beep", "PASS" if r.returncode == 0 else "FAIL", "listen for a short beep" if r.returncode == 0 else r.stderr.strip()[:120])
    rec("ffmpeg (ElevenLabs voice on Butter)", "PASS" if shutil.which("ffmpeg") else "WARN")


def check_port():
    print("\n== Drive server")
    s = socket.socket(); s.settimeout(1)
    up = s.connect_ex(("127.0.0.1", 8770)) == 0
    s.close()
    rec("port 8770", "PASS", "butter-drive is running" if up else "free (start: python3 server.py)")
    return up


def motors(args):
    from server import Motors, WHEELS, ENABLE_PINS
    if check_port_busy():
        print("butter-drive is running and owns the motor pins. Stop it first: pkill -f butter-drive/server.py")
        sys.exit(2)
    import Jetson.GPIO as GPIO
    m = Motors(mock=False, speed=args.speed)
    try:
        def one(wheel, label):
            in1, in2 = WHEELS[wheel]
            hi, lo = (in2, in1) if label == "forward" else (in1, in2)
            GPIO.output(lo, GPIO.LOW); GPIO.output(hi, GPIO.HIGH)
            m.state = "test"            # PWM loop turns the enable pins on
            time.sleep(args.secs)
            GPIO.output(hi, GPIO.LOW); m.state = "stop"
            time.sleep(0.4)
        if args.wheel:
            for label in ("forward", "backward"):
                print(f"{args.wheel} {label} (pins {WHEELS[args.wheel]}, speed {m.speed})", flush=True)
                one(args.wheel, label)
        elif args.move:
            print(f"move {args.move} for {args.secs}s at speed {m.speed}", flush=True)
            m.set(args.move); time.sleep(args.secs); m.set("stop")
        elif args.all_wheels:
            for wheel in WHEELS:
                for label in ("forward", "backward"):
                    one(wheel, label)
                    ok = ask(f"Did ONLY the {wheel} wheel spin {label.upper()}?")
                    rec(f"{wheel} {label}", "PASS" if ok else "FAIL", "" if ok else f"pins {WHEELS[wheel]}, enable pins {ENABLE_PINS}")
    finally:
        m.cleanup()


def check_port_busy():
    s = socket.socket(); s.settimeout(1)
    up = s.connect_ex(("127.0.0.1", 8770)) == 0
    s.close()
    return up


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheel", choices=["LF", "LR", "RF", "RR"])
    ap.add_argument("--move", choices=["forward", "backward", "left", "right", "strafe_left", "strafe_right"])
    ap.add_argument("--all-wheels", action="store_true")
    ap.add_argument("--speed", type=float, default=0.35)
    ap.add_argument("--secs", type=float, default=0.8)
    ap.add_argument("--beep", action="store_true", help="play a test beep on the speaker")
    a = ap.parse_args()
    if a.wheel or a.move or a.all_wheels:
        motors(a)
    else:
        check_basics(); check_camera(); check_speaker(a.beep); check_port()
    fails = [r for r in results if r[1] == "FAIL"]
    if results:
        print(f"\n  {len(results) - len(fails)}/{len(results)} OK" + ("  -> fix the FAIL lines" if fails else ""))
    sys.exit(1 if fails else 0)
