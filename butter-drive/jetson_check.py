#!/usr/bin/env python3
"""
Butter bring-up check. Run ON THE JETSON before using the eye app:

    python3 jetson_check.py            # everything, asks you to confirm each wheel
    python3 jetson_check.py --motors   # just motors
    python3 jetson_check.py --camera   # just camera
    python3 jetson_check.py --speaker  # just speaker

PUT BUTTER ON BLOCKS (wheels off the ground) before the motor test.
Each step ends in PASS / FAIL / SKIP; a summary prints at the end.
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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
results = []


def rec(name, status, note=""):
    results.append((name, status, note))
    print(f"  [{status}] {name}{' - ' + note if note else ''}")


def ask(q):
    try:
        return input(f"    {q} [y/n] ").strip().lower().startswith("y")
    except EOFError:
        return False


def check_basics():
    print("\n== Basics")
    rec("python3", "PASS", sys.version.split()[0])
    try:
        import websockets  # noqa: F401
        rec("websockets package", "PASS")
    except ImportError:
        rec("websockets package", "FAIL", "run ./setup_jetson.sh")
    try:
        import Jetson.GPIO  # noqa: F401
        rec("Jetson.GPIO package", "PASS")
    except Exception as e:
        rec("Jetson.GPIO package", "FAIL", str(e))
    # anything else that might be driving the same pins (follow-me loop, old services)
    try:
        out = subprocess.run(["bash", "-lc", "systemctl list-units --type=service --no-legend | grep -iE 'butter|follow|motor' || true"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        rec("other Butter services", "WARN" if out else "PASS", ("stop these first: " + " | ".join(l.split()[0] for l in out.splitlines())) if out else "none running")
    except Exception:
        rec("other Butter services", "SKIP")
    ip = subprocess.run(["bash", "-lc", "tailscale ip -4 2>/dev/null | head -1"], capture_output=True, text=True).stdout.strip()
    rec("tailscale", "PASS" if ip else "WARN", ip or "no tailscale IP; use the LAN IP in the app's Settings")


def check_motors(interactive):
    print("\n== Motors  (Butter must be on blocks!)")
    if interactive and not ask("Is Butter on blocks with wheels free to spin?"):
        rec("motors", "SKIP", "not on blocks")
        return
    from server import Motors, WHEELS, PATTERNS
    try:
        m = Motors(mock=False)
    except Exception as e:
        rec("GPIO setup", "FAIL", f"{e} (pinmux service running? sudo needed? user in gpio group?)")
        return
    rec("GPIO setup", "PASS", "BOARD pins " + ", ".join(f"{k}{v}" for k, v in WHEELS.items()))
    import Jetson.GPIO as GPIO
    try:
        # 1) each wheel alone, so a swapped wire is obvious
        for wheel, (in1, in2) in WHEELS.items():
            for label, hi, lo in (("forward", in2, in1), ("backward", in1, in2)):
                GPIO.output(lo, GPIO.LOW); GPIO.output(hi, GPIO.HIGH)
                time.sleep(0.8)
                GPIO.output(hi, GPIO.LOW)
                time.sleep(0.3)
                if interactive:
                    ok = ask(f"Did ONLY the {wheel} wheel spin {label.upper()}?")
                    rec(f"{wheel} {label}", "PASS" if ok else "FAIL",
                        "" if ok else f"check wiring of pins {in1}/{in2}; if it spun the wrong way swap them in WHEELS")
            if not interactive:
                rec(f"{wheel} pulsed", "PASS", "watch it: forward then backward")
        # 2) whole-robot moves through the same code path the app uses
        for d in ("forward", "backward", "left", "right", "strafe_left", "strafe_right"):
            m.set(d); time.sleep(0.8); m.set("stop"); time.sleep(0.4)
            if interactive:
                ok = ask(f"Did the robot do '{d}' correctly? (left/right = spin in place)")
                rec(f"move {d}", "PASS" if ok else "FAIL")
    finally:
        m.cleanup()


def check_camera():
    print("\n== Camera")
    devs = sorted(glob.glob("/dev/video*"))
    rec("video devices", "PASS" if devs else "FAIL", ", ".join(devs) or "no /dev/video*: camera not connected/detected")
    # existing MJPEG server on :5600?
    found = None
    for path in ("/", "/video_feed", "/stream", "/video"):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:5600{path}", timeout=3) as r:
                ctype = r.headers.get("Content-Type", "")
                head = r.read(4096)
                if "multipart" in ctype or b"\xff\xd8" in head:
                    found = path
                    break
        except Exception:
            continue
    if found:
        rec("MJPEG stream on :5600", "PASS", f"set the app's camera URL to http://<jetson-ip>:5600{found}")
    else:
        rec("MJPEG stream on :5600", "WARN", "nothing streaming; start one with: python3 camera_server.py")
    try:
        import cv2
        idx = int(devs[0].replace("/dev/video", "")) if devs else 0
        cap = cv2.VideoCapture(idx)
        ok, frame = cap.read()
        cap.release()
        if ok:
            cv2.imwrite("/tmp/butter_cam.jpg", frame)
            rec("grab a frame (OpenCV)", "PASS", f"{frame.shape[1]}x{frame.shape[0]} saved to /tmp/butter_cam.jpg")
        else:
            rec("grab a frame (OpenCV)", "FAIL" if not found else "SKIP", "device busy (fine if the stream above is using it)" if found else "could not read a frame")
    except ImportError:
        rec("grab a frame (OpenCV)", "SKIP", "python3-opencv not installed")


def check_speaker(interactive):
    print("\n== Speaker")
    if not shutil.which("aplay"):
        rec("aplay", "FAIL", "sudo apt install alsa-utils")
        return
    cmd = "espeak -v en-us+m5 -s 170 --stdout 'Hi, I am Butter' | sox -t wav - -t wav -r 44100 -c 2 - | aplay -q -D hw:2,0"
    r = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        rec("speak test", "FAIL", r.stderr.strip()[:160] + " (is the speaker still card 2? check: aplay -l)")
    elif interactive:
        rec("speak test", "PASS" if ask("Did Butter say 'Hi, I am Butter'?") else "FAIL")
    else:
        rec("speak test", "PASS", "played (listen for it)")
    rec("ffmpeg (for the app's ElevenLabs voice on Butter)", "PASS" if shutil.which("ffmpeg") else "WARN",
        "" if shutil.which("ffmpeg") else "sudo apt install ffmpeg (otherwise Butter falls back to espeak)")


def check_port():
    print("\n== Drive server port")
    s = socket.socket()
    s.settimeout(1)
    busy = s.connect_ex(("127.0.0.1", 8770)) == 0
    s.close()
    rec("port 8770", "PASS", "butter-drive already running" if busy else "free (start with: python3 server.py)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--motors", action="store_true")
    ap.add_argument("--camera", action="store_true")
    ap.add_argument("--speaker", action="store_true")
    ap.add_argument("--auto", action="store_true", help="don't ask questions (motor pulses still happen)")
    a = ap.parse_args()
    everything = not (a.motors or a.camera or a.speaker)
    inter = not a.auto and sys.stdin.isatty()
    check_basics()
    if everything or a.camera:
        check_camera()
    if everything or a.speaker:
        check_speaker(inter)
    if everything or a.motors:
        check_motors(inter)
    if everything:
        check_port()
    fails = [r for r in results if r[1] == "FAIL"]
    print("\n== Summary")
    for n, st, note in results:
        if st != "PASS":
            print(f"  {st:5} {n}: {note}")
    print(f"\n  {len(results) - len(fails)}/{len(results)} OK" + ("  -> fix the FAIL lines, then rerun" if fails else "  -> ready: python3 server.py"))
    sys.exit(1 if fails else 0)
