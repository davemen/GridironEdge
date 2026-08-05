#!/bin/bash
#
# Keep the Gridiron Edge sync server running, always.
#
# The app cannot start this itself -- a web page has no way to launch a process,
# and that is a browser security boundary rather than a gap to work around. So
# instead macOS starts it at login and restarts it if it ever dies, and the
# question stops coming up.
#
#   ./install-autostart.sh            install and start
#   ./install-autostart.sh --remove   uninstall
#
set -euo pipefail

LABEL="com.gridironedge.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3)"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed. The server will no longer start at login."
  echo "Anything still running: lsof -ti:8000 | xargs kill"
  exit 0
fi

if [[ -z "$PY" ]]; then
  echo "python3 not found on PATH. Install it, then re-run." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$DIR/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/server.log</string>
</dict>
</plist>
PLISTEOF

# Replace any previous copy, then start.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed. Waiting for the server to answer..."
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://localhost:8000/health" >/dev/null 2>&1; then
    echo
    echo "  Running:  http://localhost:8000"
    echo "  Health:   http://localhost:8000/health"
    echo "  Log:      $DIR/server.log"
    echo
    echo "It now starts at login and restarts if it crashes."
    echo "To undo:  ./install-autostart.sh --remove"
    exit 0
  fi
  sleep 0.5
done

echo "Installed, but the server did not answer within 10s. Check $DIR/server.log" >&2
exit 1
