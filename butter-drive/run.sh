#!/usr/bin/env bash
# Start (or restart) the drive server and camera stream on the Jetson, in the background.
#   ./run.sh           start both        ./run.sh stop     stop both        ./run.sh status
cd "$(dirname "$0")"
PY="$HOME/Projects/butter/butter_env/bin/python3"
stop() { pkill -f "butter-drive/server.py" 2>/dev/null; pkill -f "butter-drive/camera_server.py" 2>/dev/null; sleep 0.5; }
case "${1:-start}" in
  stop) stop; echo stopped ;;
  status) pgrep -af "butter-drive/(server|camera_server).py" || echo "not running" ;;
  *) stop
     # setsid + closed stdin so an ssh session that starts this can return
     setsid nohup "$PY" "$PWD/server.py" --speed "${SPEED:-0.35}" > /tmp/butter-drive.log 2>&1 < /dev/null &
     if [ -e /dev/video0 ]; then
       setsid nohup "$PY" "$PWD/camera_server.py" > /tmp/butter-camera.log 2>&1 < /dev/null &
     fi
     sleep 1.5; pgrep -af "butter-drive/(server|camera_server).py"; tail -2 /tmp/butter-drive.log ;;
esac
