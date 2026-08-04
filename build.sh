#!/usr/bin/env bash
#
# Start the whole Ansa stack: the SQLite server and the Vite app together.
# No arguments — this is the everyday "run the thing I'm working on" path.
# Both run with hot reload; Ctrl-C stops both.
#
set -euo pipefail

# Run from the repo root regardless of where this is called from.
cd "$(dirname "$0")"

APP_PORT=5173
API_PORT=4000
APP_URL="http://localhost:${APP_PORT}"

# Set ANSA_NO_OPEN=1 to skip auto-opening the browser (e.g. on a headless box).
NO_OPEN=${ANSA_NO_OPEN:-}

# Print a URL as a terminal hyperlink (OSC 8) so it's clickable, falling back to
# plain text on terminals that don't support it — they just show the URL.
link() {
  printf '\033]8;;%s\033\\%s\033]8;;\033\\' "$1" "$1"
}

# Open a URL in the default browser, best-effort across platforms.
open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1"                       # macOS
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1   # Linux
  fi
}

# Dependencies: install only when node_modules is missing, so a normal run is fast.
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

# Refuse to start on top of something already holding a port. Without this the
# readiness check below would see the *other* process answering, call it "up",
# and carry on with a child that died of EADDRINUSE.
check_port_free() {
  local port=$1 what=$2
  local pid
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1) || true
  if [ -n "$pid" ]; then
    echo "Port ${port} is already in use by pid ${pid} ($(ps -p "$pid" -o comm= 2>/dev/null))." >&2
    echo "That's probably an Ansa ${what} you started earlier." >&2
    echo "Stop it and re-run, or: kill ${pid}" >&2
    exit 1
  fi
}
check_port_free "$API_PORT" "server"
check_port_free "$APP_PORT" "app"

# Track child PIDs so Ctrl-C (or any exit) takes both processes down with us,
# rather than orphaning the server in the background.
pids=()

# `npm run` spawns its own grandchildren (tsx, vite); killing the npm pid alone
# leaves those running. Walk the tree and kill children before their parent.
kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "Stopping…"
  for pid in "${pids[@]}"; do
    kill_tree "$pid"
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Local dev trusts the x-ansa-user header. Without this the server 401s every
# request and the app loads to an empty screen. Never set in a deployed env.
export ANSA_DEV_AUTH=${ANSA_DEV_AUTH:-1}

echo "Starting server on http://127.0.0.1:${API_PORT} …"
npm run server &
pids+=($!)

# Wait for the API to answer before starting the app, so the app's first SSE
# connect finds the server already up.
while ! curl -sf "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; do
  # Check the child first: a dead child plus a healthy curl means something
  # else is on the port, which is a lie we don't want to wait on.
  if ! kill -0 "${pids[0]}" 2>/dev/null; then
    echo "Server failed to start. Check the output above." >&2
    exit 1
  fi
  sleep 0.3
done
if ! kill -0 "${pids[0]}" 2>/dev/null; then
  echo "Server exited during startup — port ${API_PORT} is being served by something else." >&2
  exit 1
fi
echo "Server is up."

echo "Starting app on ${APP_URL} …"
npm run dev &
pids+=($!)

# Wait for Vite to actually serve before opening a browser at it, so the tab
# doesn't land on a connection error. Bail if the app process dies meanwhile.
while ! curl -sf "${APP_URL}" >/dev/null 2>&1; do
  if ! kill -0 "${pids[1]}" 2>/dev/null; then
    echo "App failed to start. Check the output above." >&2
    exit 1
  fi
  sleep 0.3
done

echo ""
echo "Ansa is running:"
printf '  app  →  %s\n' "$(link "${APP_URL}")"
printf '  api  →  %s\n' "$(link "http://127.0.0.1:${API_PORT}")"
echo ""

if [ -z "$NO_OPEN" ]; then
  echo "Opening ${APP_URL} …"
  open_url "${APP_URL}"
fi

echo "Press Ctrl-C to stop both."

# Block until either child exits, then let the trap stop the other. Polled
# rather than `wait -n`, which macOS's stock bash 3.2 doesn't support.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do
  sleep 1
done
