#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:99
XVFB_SCREEN="${XVFB_SCREEN:-1280x720x24}"
XVFB_WAIT_SECS="${XVFB_WAIT_SECS:-10}"

cleanup() {
  kill "${novnc_pid:-}" "${x11vnc_pid:-}" "${fluxbox_pid:-}" "${xvfb_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Virtual screen
Xvfb "$DISPLAY" -screen 0 "$XVFB_SCREEN" -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!

for _ in $(seq 1 "$XVFB_WAIT_SECS"); do
  if [ -S /tmp/.X11-unix/X99 ]; then
    break
  fi
  sleep 1
done

if [ ! -S /tmp/.X11-unix/X99 ]; then
  echo "Xvfb failed to start; /tmp/.X11-unix/X99 not found"
  exit 1
fi

# Window manager
fluxbox >/tmp/fluxbox.log 2>&1 &
fluxbox_pid=$!

# VNC server
x11vnc -display "$DISPLAY" -nopw -forever -shared -rfbport 5900 -xkb >/tmp/x11vnc.log 2>&1 &
x11vnc_pid=$!

for _ in $(seq 1 10); do
  if (echo > /dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# noVNC web client
websockify --web=/usr/share/novnc/ 7900 localhost:5900 >/tmp/novnc.log 2>&1 &
novnc_pid=$!

echo "noVNC: http://localhost:7900/vnc.html"
echo "App:   http://localhost:3000"

# Start app
node /app/server.js
