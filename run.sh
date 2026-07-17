#!/usr/bin/env bash
# Set up (once) and run the Flappy Bird QR server.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

# 0.0.0.0 so phones on the same Wi-Fi can reach the server.
exec ./.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
