#!/usr/bin/env bash
# Start (or restart) the drive server and camera stream on the Jetson, in the background.
#   ./run.sh           start both        ./run.sh stop     stop both        ./run.sh status
cd "$(dirname "$0")"
PY="$HOME/Projects/butter/butter_env/bin/python3"
stop() { pkill -f "butter-drive/server.py" 2>/dev/null; pkill -f "butter-drive/camera_server.py" 2>/dev/null; sleep 0.7; }
case "${1:-start}" in
  stop) stop; echo stopped ;;
  status) pgrep -af "butter-drive/(server|camera_server).py" || echo "not running" ;;
  *) stop
     # setsid + closed stdin so an ssh session that starts this can return
     setsid nohup "$PY" "$PWD/server.py" --speed "${SPEED:-0.05}" > /tmp/butter-drive.log 2>&1 < /dev/null &
     # always start it: it finds the camera itself and waits if none is plugged in yet
     setsid nohup "$PY" "$PWD/camera_server.py" > /tmp/butter-camera.log 2>&1 < /dev/null &
     sleep 1.5; pgrep -af "butter-drive/(server|camera_server).py"; tail -2 /tmp/butter-drive.log ;;
esac
