#!/bin/bash
#
# Double-click this file to start Gridiron Edge.
#
# It is a .command rather than a .app on purpose. macOS gates access to
# ~/Documents and gates one app controlling another, and an unsigned app bundle
# is denied both -- silently. The failure looks like the app doing nothing at
# all: python reports "can't open file 'server.py': Operation not permitted"
# into a log nobody reads and the port never opens.
#
# A .command is opened BY Terminal, so it runs with Terminal's permissions,
# which you have already granted. No bundle, no signing, no prompts.
#
# This window is the server. Close it, or press Ctrl-C, to stop.

cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT"

printf '\033[1;36m'
echo "  Gridiron Edge"
printf '\033[0m'
echo "  $(pwd)"
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "  python3 was not found. Install it with: xcode-select --install"
  echo
  read -r -p "  Press Return to close." _
  exit 1
fi

# Reuse a healthy server rather than fighting over the port; clear a dead one.
if curl -fsS -m 2 "$URL/health" >/dev/null 2>&1; then
  echo "  Already running — opening the app."
  open "$URL"
  echo
  read -r -p "  Press Return to close this window (the server keeps running)." _
  exit 0
fi
lsof -ti:"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true

# Stop the server when this window closes or Ctrl-C is pressed, so the server's
# lifetime matches the window's rather than outliving it invisibly.
cleanup() {
  echo
  echo "  Stopping server."
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM HUP EXIT

python3 server.py &
SERVER_PID=$!

for _ in $(seq 1 20); do
  curl -fsS -m 2 "$URL/health" >/dev/null 2>&1 && break
  sleep 0.5
done

if ! curl -fsS -m 2 "$URL/health" >/dev/null 2>&1; then
  echo "  The server did not start. Error above."
  echo
  read -r -p "  Press Return to close." _
  exit 1
fi

printf '\033[1;32m'
echo "  Running at $URL"
printf '\033[0m'
echo "  Open your ESPN draft room — the extension syncs automatically."
echo
echo "  Close this window or press Ctrl-C to stop."
echo
open "$URL"

wait "$SERVER_PID"
