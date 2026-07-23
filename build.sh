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

# Dependencies: install only when node_modules is missing, so a normal run is fast.
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

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

echo "Starting server on http://127.0.0.1:${API_PORT} …"
npm run server &
pids+=($!)

# Wait for the API to answer before starting the app, so the app's first SSE
# connect finds the server already up.
until curl -sf "http://127.0.0.1:${API_PORT}/api/tree" >/dev/null 2>&1; do
  sleep 0.3
  # If the server process died during startup, don't loop forever.
  if ! kill -0 "${pids[0]}" 2>/dev/null; then
    echo "Server failed to start. Check the output above." >&2
    exit 1
  fi
done
echo "Server is up."

echo "Starting app on http://localhost:${APP_PORT} …"
npm run dev &
pids+=($!)

echo ""
echo "Ansa is running:"
echo "  app  →  http://localhost:${APP_PORT}"
echo "  api  →  http://127.0.0.1:${API_PORT}"
echo ""
echo "Press Ctrl-C to stop both."

# Block until either child exits, then let the trap stop the other. Polled
# rather than `wait -n`, which macOS's stock bash 3.2 doesn't support.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do
  sleep 1
done
