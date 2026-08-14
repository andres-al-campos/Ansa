#!/usr/bin/env bash
#
# Start the whole Ansa stack: the SQLite server and the Vite app together.
# No arguments — this is the everyday "run the thing I'm working on" path.
# Both run with hot reload; Ctrl-C stops both.
#
#   ./build.sh              run locally (server + app), the default
#   ./build.sh deploy       test, then publish the API and the app
#   ./build.sh deploy api   the Worker only
#   ./build.sh deploy app   the Pages bundle only
#
# Deploy lives here rather than in its own script so there is one entry point
# and no question about which file is current.
#
set -euo pipefail

# Run from the repo root regardless of where this is called from.
cd "$(dirname "$0")"

APP_PORT=5173
API_PORT=4000
APP_URL="http://localhost:${APP_PORT}"

# The deployed pieces. The app is a Pages project; the API is a separate Worker
# that this build has to be pointed at, because Vite inlines the URL at build
# time and a bundle built without it has no idea where its API is.
PAGES_PROJECT=ansaflow
WORKER_API=https://ansa.id3arium.workers.dev

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
  # Nothing was started, so there is nothing to stop. Reached when the script
  # exits early — a usage error, or a deploy — and announcing "Stopping…" there
  # buries the actual message. The ${#pids[@]:-0} guard is also what keeps
  # `set -u` from turning an early exit into an unbound-variable error.
  if [ "${#pids[@]:-0}" -eq 0 ]; then
    return
  fi
  echo ""
  echo "Stopping…"
  for pid in "${pids[@]}"; do
    kill_tree "$pid"
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Secrets come from the macOS Keychain locally and from the platform's own
# secret store when deployed. The server only ever reads process.env, so it
# doesn't know or care which one filled it — keep it that way.
#
# Add the secret with (it prompts, so it stays out of shell history):
#   security add-generic-password -a "$USER" -s ansa-clerk-secret -w
keychain_secret() {
  security find-generic-password -s "$1" -w 2>/dev/null || true
}

# An already-set env var wins, so CI and Railway work with this same script.
if [ -z "${CLERK_SECRET_KEY:-}" ]; then
  CLERK_SECRET_KEY=$(keychain_secret ansa-clerk-secret)
  export CLERK_SECRET_KEY
fi

# Local dev trusts the x-ansa-user header. Without this the server 401s every
# request and the app loads to an empty screen. Never set in a deployed env.
#
# auth.ts makes Clerk win when both are configured, so this only takes effect
# when the Keychain had no secret — local then behaves exactly as it did before
# auth landed.
export ANSA_DEV_AUTH=${ANSA_DEV_AUTH:-1}

# The Clerk *publishable* key is public by design — it ships in the JS bundle
# and identifies the instance, it doesn't authorise anything. It lives here
# rather than in .env because .env is gitignored and a fresh clone has to work.
CLERK_PUBLISHABLE_DEFAULT=pk_test_cmFwaWQtYmVlLTIwLmNsZXJrLmFjY291bnRzLmRldiQ

# Local and deploy want opposite defaults here, which is why this isn't one line.
#
# Locally the key is set only alongside a Keychain secret: the client gates on
# sign-in when it sees a key, so setting it unconditionally would take away the
# no-login local mode that a fresh clone with no Keychain entry depends on.
#
# A deploy has no such mode. Production is always signed-in, so the key is
# always needed, and tying it to whether *this laptop* has a secret in its
# Keychain would make the deploy depend on unrelated local state.
if [ "${1:-}" = "deploy" ] || [ -n "${CLERK_SECRET_KEY:-}" ]; then
  export VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY:-$(keychain_secret ansa-clerk-publishable)}
  export VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY:-$CLERK_PUBLISHABLE_DEFAULT}
fi

# ---------------------------------------------------------------------------
# Deploy. Two halves that ship together by default, because they share a wire
# format: an app expecting an op the API doesn't accept yet is the failure this
# avoids. `deploy app` / `deploy api` are for when you know only one changed.
#
# Every VITE_* the client needs has to be set at build time. Cloudflare is not
# building this — the Pages project has no git integration — so the variables
# configured in the Pages dashboard never run. That is not a detail: a deploy
# that sets only some of them produces a bundle that builds cleanly, uploads
# cleanly, and then can't sign anyone in. It has happened once already.
#
# So the checks below refuse rather than warn, and they check the built bundle
# rather than the environment that produced it.
# ---------------------------------------------------------------------------

# The Worker: the API, the Durable Objects, and the auth. Deployed before the
# app so a failure here leaves the old app talking to the old API, rather than
# a new app talking to an API that never updated.
#
# No env vars to pass — wrangler.jsonc carries the config, and CLERK_SECRET_KEY
# lives in the Worker's own secret store (`wrangler secret put`), never here.
deploy_api() {
  echo "Deploying the API worker …"
  npx wrangler deploy
}

# What the smoke checks are for: everything above this point verifies what was
# *uploaded*, which is a different claim from what is being *served*. Today's
# outage got through a clean build and a clean upload and only showed itself in
# a browser. These make that gap a failed deploy instead of a bug report.
#
# Retried rather than checked once: a deploy takes a few seconds to propagate,
# so a single immediate probe reports a stale copy and calls it a regression.
retry_until() {
  local what=$1 attempts=${2:-10}
  local i=1
  while [ "$i" -le "$attempts" ]; do
    if "check_$what"; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

# The Worker answers, and it found its Clerk secret. The second half matters as
# much as the first: a worker missing CLERK_SECRET_KEY deploys fine and serves
# fine, and reports auth "dev" or "none" — which would let anyone act as anyone,
# or refuse every request. Both are silent from the outside.
check_api() {
  curl -sf --max-time 10 "${WORKER_API}/api/health" 2>/dev/null | grep -q '"auth":"clerk"'
}

# The live page serves a bundle carrying both build-time values. Fetched from
# the public URL rather than read from dist/, because "it's in the file I built"
# is exactly what was true this morning while the site was broken.
check_app() {
  local index js
  index=$(curl -sf --max-time 10 "https://${PAGES_PROJECT}.pages.dev/" 2>/dev/null) || return 1
  js=$(printf '%s' "$index" | grep -o '/assets/[^"]*\.js' | head -1)
  [ -n "$js" ] || return 1
  local bundle
  bundle=$(curl -sf --max-time 20 "https://${PAGES_PROJECT}.pages.dev${js}" 2>/dev/null) || return 1
  printf '%s' "$bundle" | grep -qF "$WORKER_API" || return 1
  printf '%s' "$bundle" | grep -qF "$VITE_CLERK_PUBLISHABLE_KEY"
}

smoke_api() {
  echo "Checking the live API …"
  if retry_until api; then
    echo "  API is up and using Clerk auth."
  else
    echo "The API deployed but ${WORKER_API}/api/health isn't reporting Clerk auth." >&2
    echo "If it answers with auth 'dev' or 'none', the worker lost its secret:" >&2
    echo "  npx wrangler secret put CLERK_SECRET_KEY" >&2
    echo "The value is in your Keychain as ansa-clerk-secret." >&2
    exit 1
  fi
}

smoke_app() {
  echo "Checking the live app …"
  if retry_until app; then
    echo "  App is serving a bundle with the API URL and Clerk key inlined."
  else
    echo "The app deployed but the page being served is missing a value it needs." >&2
    echo "Open https://${PAGES_PROJECT}.pages.dev and check the console." >&2
    echo "If it says there is no Clerk publishable key, the build didn't get one —" >&2
    echo "re-run ./build.sh deploy app rather than setting it in the Pages dashboard," >&2
    echo "which does nothing here because Cloudflare isn't building this project." >&2
    exit 1
  fi
}

deploy_app() {
  if [ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ]; then
    echo "No Clerk publishable key, so the deployed app would have no way to sign in." >&2
    echo "It normally comes from the fallback above, so this means the Keychain lookup" >&2
    echo "returned something empty. Set it explicitly and re-run:" >&2
    echo "  VITE_CLERK_PUBLISHABLE_KEY=pk_test_… ./build.sh deploy" >&2
    exit 1
  fi

  echo "Building the app for ${WORKER_API} …"
  VITE_ANSA_API="$WORKER_API" npm run build

  # Check the artifact rather than the inputs. An env var that was set proves
  # what this shell knew, not what Vite inlined — and the failure mode is a
  # bundle that looks fine until someone opens it.
  local js
  js=$(find dist/assets -name '*.js' -print -quit)
  for needle in "$WORKER_API" "$VITE_CLERK_PUBLISHABLE_KEY"; do
    if ! grep -qF "$needle" "$js"; then
      echo "The built bundle is missing a value it needs, so it was not deployed." >&2
      echo "Expected to find '${needle:0:24}…' in ${js}." >&2
      echo "Re-run, and if it persists check src/api.ts and src/main.tsx for how it's read." >&2
      exit 1
    fi
  done
  echo "Bundle checks out: API URL and Clerk key are both inlined."

  npx wrangler pages deploy dist --project-name "$PAGES_PROJECT" --branch main
}

deploy() {
  # The trap is for the local path's background children; a deploy has none, and
  # leaving it armed prints a spurious "Stopping…" on success.
  trap - INT TERM EXIT

  # Tests before either half goes out. The suite is ~10s and covers the tree
  # model both sides share, so skipping it to save time is a false economy.
  echo "Running tests …"
  npm test

  # Each half is checked immediately after it ships, not both at the end: when
  # the API is broken the app deploy should not go out on top of it.
  local target=${1:-both}
  case "$target" in
    api) deploy_api; smoke_api ;;
    app) deploy_app; smoke_app ;;
    both) deploy_api; smoke_api; deploy_app; smoke_app ;;
    *)
      echo "Unknown deploy target: $target" >&2
      echo "Usage: ./build.sh deploy [app|api]" >&2
      exit 1
      ;;
  esac

  echo ""
  echo "Deployed:"
  if [ "$target" != "api" ]; then
    printf '  app  →  %s\n' "$(link "https://${PAGES_PROJECT}.pages.dev")"
  fi
  if [ "$target" != "app" ]; then
    printf '  api  →  %s\n' "$(link "$WORKER_API")"
  fi
}

case "${1:-}" in
  deploy) deploy "${2:-both}"; exit 0 ;;
  '') ;;
  *)
    echo "Unknown argument: $1" >&2
    echo "Usage: ./build.sh [deploy [app|api]]" >&2
    exit 1
    ;;
esac

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
