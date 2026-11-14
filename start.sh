#!/usr/bin/env bash
# Butter: one command to start everything on the Mac.
#
#   ./start.sh              use the real Jetson if reachable, otherwise a mock robot on this Mac
#   ./start.sh --mock       always use the mock robot (no Jetson needed)
#   ./start.sh --jetson IP  use the Jetson at IP (Tailscale or LAN)
#   ./start.sh --test       run all automated tests instead of the app
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
JETSON_IP="100.127.78.50"
MODE=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --mock) MODE=mock ;;
    --jetson) MODE=jetson; JETSON_IP="$2"; shift ;;
    --test) MODE=test ;;
  esac
  shift
done

say() { printf "\033[1;33m[butter]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[butter]\033[0m %s\n" "$*"; exit 1; }

command -v node >/dev/null || die "Node.js 20+ is required: brew install node"
command -v python3 >/dev/null || die "python3 is required"
[ -f app/.env ] || die "app/.env is missing (DEEPSEEK_API_KEY, ELEVENLABS_API_KEY). Copy app/.env.example and fill it in."

if [ ! -d app/node_modules/electron ]; then
  say "Installing app dependencies (first run only, ~1 min)…"
  (cd app && npm install --no-audit --no-fund)
fi

# python venv for the mock robot / tests (avoids touching system python)
if [ ! -x butter-drive/.venv/bin/python ]; then
  say "Creating python venv for the robot server…"
  python3 -m venv butter-drive/.venv
  butter-drive/.venv/bin/pip install -q -r butter-drive/requirements.txt pytest
fi
PY="$ROOT/butter-drive/.venv/bin/python"

if [ "$MODE" = test ]; then
  say "Gesture engine + services + live API tests"
  (cd app && set -a && . ./.env && set +a && node --test test/*.test.js)
  say "Robot server tests"
  (cd butter-drive && "$PY" -m pytest -q test_server.py)
  exit 0
fi

# hard 3 s limit: with the cable unplugged, nc to the cable address can hang instead of failing
reachable() {
  nc -z "$1" 8770 >/dev/null 2>&1 & local pid=$!
  ( sleep 3; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & local killer=$!
  if wait "$pid" 2>/dev/null; then kill "$killer" 2>/dev/null; return 0; fi
  kill "$killer" 2>/dev/null; return 1
}

MOCK_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ "$MODE" = auto ]; then
  # try the USB-C cable first (always 192.168.55.1), then Tailscale
  for ip in 192.168.55.1 "$JETSON_IP"; do
    if reachable "$ip"; then JETSON_IP="$ip"; MODE=jetson; break; fi
  done
  if [ "$MODE" = jetson ]; then :; else
    say "Jetson drive server not reachable (USB 192.168.55.1 or $JETSON_IP), using the mock robot."
    say "(Start it on the Jetson with: ~/Projects/butter-drive/run.sh)"
    MODE=mock
  fi
fi

if [ "$MODE" = mock ]; then
  "$PY" butter-drive/server.py --mock --host 127.0.0.1 --port 8770 > /tmp/butter-mock.log 2>&1 &
  MOCK_PID=$!
  sleep 0.8
  export BUTTER_URL="ws://127.0.0.1:8770"
  say "Mock robot running (motor log: tail -f /tmp/butter-mock.log)"
else
  reachable "$JETSON_IP" || die "Can't reach $JETSON_IP:8770. Is server.py running on the Jetson, and are you on Tailscale/the same Wi-Fi?"
  export BUTTER_URL="ws://$JETSON_IP:8770"
  export BUTTER_CAMERA_URL="${BUTTER_CAMERA_URL:-http://$JETSON_IP:5600/}"
  say "Connecting to Butter at $JETSON_IP"
fi

say "Starting the app. First launch: allow Camera + Microphone, then do the 20 s calibration."
say "Keyboard backup: arrows = look, space = blink, D = double blink, Esc = close eyes 2s, Q/E = wink, C = recalibrate"
cd app && npx electron .
