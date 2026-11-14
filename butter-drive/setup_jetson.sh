#!/usr/bin/env bash
# Run on the Jetson, from this folder: ./setup_jetson.sh
set -e
cd "$(dirname "$0")"
PY=python3
if [ -d "$HOME/butter_env" ]; then PY="$HOME/butter_env/bin/python3"; echo "using butter_env"; fi
$PY -m pip install -q "websockets>=12" || $PY -m pip install -q --user "websockets>=12"
$PY -c "import Jetson.GPIO" 2>/dev/null && echo "Jetson.GPIO ok" || echo "WARNING: Jetson.GPIO missing: sudo pip3 install Jetson.GPIO"
groups | grep -q gpio || echo "NOTE: add yourself to the gpio group: sudo usermod -aG gpio \$USER (then log out/in)"
command -v ffmpeg >/dev/null || echo "NOTE: sudo apt install ffmpeg  (lets Butter speak in the app's ElevenLabs voice)"
echo
echo "Next: $PY jetson_check.py     (put Butter on blocks first)"
