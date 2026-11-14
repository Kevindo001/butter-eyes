#!/usr/bin/env bash
# Run on the Jetson from this folder: ./setup_jetson.sh   (checks only, installs nothing)
cd "$(dirname "$0")"
PY="$HOME/Projects/butter/butter_env/bin/python3"
[ -x "$PY" ] || { echo "butter_env not found at $PY"; exit 1; }
exec "$PY" jetson_check.py "$@"
