#!/usr/bin/env bash
set -e

export DISPLAY=:99

# Virtual screen
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &

# Window manager (so windows are visible)
fluxbox &

# VNC server (no password for MVP)
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 &

# noVNC web client on port 7900
websockify --web=/usr/share/novnc/ 7900 localhost:5900 &

echo "noVNC: http://localhost:7900/vnc.html"
echo "App:   http://localhost:3000"

node server.js
