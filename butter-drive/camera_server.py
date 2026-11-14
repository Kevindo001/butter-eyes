#!/usr/bin/env python3
"""Minimal MJPEG camera stream for Butter, only if the existing Flask camera isn't running.
    python3 camera_server.py [--device 0] [--port 5600]
Stream: http://<jetson-ip>:5600/  (also /stream). Stdlib + OpenCV only."""
import argparse
import glob
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

latest = None
lock = threading.Lock()


def open_camera(width, height, prefer=None):
    """First /dev/video* that actually returns frames (the number changes when the camera is replugged)."""
    devs = sorted(glob.glob("/dev/video*"), key=lambda d: int(d.replace("/dev/video", "")))
    if prefer is not None:
        devs = [f"/dev/video{prefer}"] + [d for d in devs if d != f"/dev/video{prefer}"]
    for d in devs:
        cap = cv2.VideoCapture(int(d.replace("/dev/video", "")), cv2.CAP_V4L2)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        ok, _ = cap.read()
        if ok:
            print(f"camera: {d}", flush=True)
            return cap
        cap.release()
    return None


def grab(dev, width, height):
    global latest
    cap, fails = None, 0
    while True:
        if cap is None:
            cap = open_camera(width, height, dev)
            if cap is None:
                time.sleep(1.0)  # unplugged: keep looking
                continue
        ok, frame = cap.read()
        if not ok:
            fails += 1
            if fails > 15:  # camera went away: reopen (maybe under a new number)
                cap.release(); cap, fails = None, 0
                with lock:
                    latest = None
            time.sleep(0.05)
            continue
        fails = 0
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            with lock:
                latest = jpg.tobytes()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path not in ("/", "/stream"):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                with lock:
                    jpg = latest
                if jpg:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                time.sleep(1 / 20)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, default=None, help="force /dev/videoN (default: auto)")
    ap.add_argument("--port", type=int, default=5600)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    a = ap.parse_args()
    threading.Thread(target=grab, args=(a.device, a.width, a.height), daemon=True).start()
    print(f"camera stream on http://0.0.0.0:{a.port}/")
    ThreadingHTTPServer(("0.0.0.0", a.port), H).serve_forever()
