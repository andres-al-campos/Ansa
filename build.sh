#!/usr/bin/env bash
#
# Build and install the Ansa desktop app — the everyday "run the thing I'm
# working on" path. No arguments packages a real .app (with the macOS 26 Liquid
# Glass icon), installs it to /Applications/_vibe_coded replacing the last one,
# and launches it. The other modes are behind explicit arguments:
#
#   ./build.sh              package the desktop .app and install it, the default
#   ./build.sh desktop      dev run of the desktop app (hot-reload window)
#   ./build.sh web          run the local web stack: API + Vite app together
#   ./build.sh web --no-auth  the same without sign-in, even with a Keychain secret
#   ./build.sh check        typecheck, tests and laws, no stack or simulator
#   ./build.sh check --drives  all of that, then the web and iOS drives on a no-sign-in stack
#   ./build.sh deploy       test, then publish the API and the app
#   ./build.sh deploy api   the Worker only
#   ./build.sh deploy app   the Pages bundle only
#
# Deploy lives here rather than in its own script so there is one entry point
# and no question about which file is current.
#
# The packaged default is the only build that shows the real Liquid Glass icon:
# it renders only in a packaged app, not under the dev run's `npm start`. `dist`
# ad-hoc signs for local use; a Developer ID signed/notarised build is separate.
#
# The web stack runs `wrangler dev`, the *same code that is deployed* — the
# Worker, with real Durable Objects, against local throwaway storage.
#
set -euo pipefail

# Run from the repo root regardless of where this is called from.
cd "$(dirname "$0")"

# ANSA_APP_PORT moves it, for when another project already holds 5173.
APP_PORT=${ANSA_APP_PORT:-5173}
# wrangler's own default, and the port src/api.ts falls back to in dev.
API_PORT=8787
APP_URL="http://localhost:${APP_PORT}"

# The deployed pieces. The app is a Pages project; the API is a separate Worker
# that this build has to be pointed at, because Vite inlines the URL at build
# time and a bundle built without it has no idea where its API is.
PAGES_PROJECT=ansaflow
WORKER_API=https://ansa.id3arium.workers.dev

# The bundle path deploy_app just built, for smoke_app to wait for. Empty on the
# paths that don't build one — `deploy api` still smoke-checks the app it did
# not touch, and there the contents check on whatever is live is the right test.
DEPLOYED_JS=

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
    [ "$port" = "$APP_PORT" ] && echo "If it isn't Ansa, run on another port instead: ANSA_APP_PORT=5174 ./build.sh web" >&2
    exit 1
  fi
}
# Only `web` binds the app port. Deploying builds and uploads a bundle; the
# desktop paths run Electron or package a .app — none hold 5173. Guarding them
# refused perfectly good runs because something unrelated happened to hold the
# port. `$1` rather than a parsed variable because parsing happens further down.
case "${1:-}" in
  web) check_port_free "$APP_PORT" "app" ;;
esac

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
  if [ -n "${WORKER_ENV:-}" ]; then rm -f "$WORKER_ENV"; fi
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
# secret store when deployed. The Worker reads them from its env bindings, so it
# doesn't know or care which one filled it — keep it that way.
#
# Add the secret with (it prompts, so it stays out of shell history):
#   security add-generic-password -a "$USER" -s ansa-clerk-secret -w
keychain_secret() {
  security find-generic-password -s "$1" -w 2>/dev/null || true
}

# `web --no-auth` skips the Keychain, so the app opens with no sign-in on a
# machine that has a secret. It's what an agent driving the app uses.
if [ "${1:-}" = "web" ] && [ "${2:-}" = "--no-auth" ]; then
  unset CLERK_SECRET_KEY VITE_CLERK_PUBLISHABLE_KEY
  NO_AUTH=1
fi

# An already-set env var wins, so CI and Railway work with this same script.
if [ -z "${NO_AUTH:-}" ] && [ -z "${CLERK_SECRET_KEY:-}" ]; then
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

# The local `web` stack and everything else want opposite defaults here, which
# is why this isn't one line.
#
# The `web` run sets the key only alongside a Keychain secret: the client gates
# on sign-in when it sees a key, so setting it unconditionally would take away
# the no-login local mode that a fresh clone with no Keychain entry depends on.
#
# Deploy and the desktop app (the bare default and the dev run) have no such
# mode. Production and the shipped app are always signed-in, so the key is always
# needed, and tying it to whether *this laptop* has a secret in its Keychain
# would make them depend on unrelated local state. The bare default is the
# packaged desktop build, so an empty `$1` counts here too.
if [ "${1:-}" != "web" ] || [ -n "${CLERK_SECRET_KEY:-}" ]; then
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
#
# 20 × 2s rather than 10: the loop returns the moment a check passes, so the
# ceiling only costs anything on a deploy that is genuinely slow — which is the
# case the old budget turned into a spurious failure.
retry_until() {
  local what=$1 attempts=${2:-20}
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
  js=$(grep -o '/assets/[^"]*\.js' <<<"$index" | head -1)
  [ -n "$js" ] || return 1
  # Is this the bundle we just built, or the one from last time? For the first
  # few seconds after an upload the URL still serves the previous deploy, which
  # has both values inlined too — so checking only the contents passes on a
  # stale copy and proves nothing. Refusing until the hashed filename matches is
  # what makes a retry mean "not landed yet" rather than "look again and hope".
  [ -z "${DEPLOYED_JS:-}" ] || [ "$js" = "$DEPLOYED_JS" ] || return 1
  local bundle
  bundle=$(curl -sf --max-time 20 "https://${PAGES_PROJECT}.pages.dev${js}" 2>/dev/null) || return 1
  grep -qF "$WORKER_API" <<<"$bundle" || return 1
  grep -qF "$VITE_CLERK_PUBLISHABLE_KEY" <<<"$bundle"
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
  # The smoke check waits for this exact filename to appear on the live site.
  # Vite hashes the name from the contents, so it is the only thing that tells
  # the new bundle apart from the one Pages is still serving.
  DEPLOYED_JS="/${js#dist/}"
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

  # Everything before either half goes out: the push hook runs only the tests a
  # change could affect, so a release is where the whole of check runs. A
  # separate process rather than a call, so check's own set -e and stack trap
  # behave as they do when run directly.
  echo "Running ./build.sh check --drives before deploying …"
  "$0" check --drives

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

# ---------------------------------------------------------------------------
# Desktop. An Electron window around the same web build the browser app ships.
# The React app talks to the live Worker, so this is a wrapper and nothing more:
# build the bundle with the live API URL and Clerk key inlined — the exact
# recipe deploy_app uses — copy it into desktop/web, and hand it to Electron.
#
#   ./build.sh desktop        dev run: hot-reload window via `npm start`
#   ./build.sh desktop dist   package a real .app and install it to
#                             /Applications/_vibe_coded, replacing the last one
#
# The dev run shows the hand-painted dock.png, because the macOS 26 Liquid Glass
# icon only renders in a *packaged* build — so `dist` is the path that shows the
# real glass on the dock. Neither is a distributable build: `dist` ad-hoc signs
# for local use only. A Developer ID signed/notarised build is separate work.

# Build the web bundle for the live Worker and stage it under desktop/web. The
# shared front half of both desktop paths — same recipe deploy_app uses.
build_desktop_bundle() {
  if [ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ]; then
    echo "No Clerk publishable key, so the desktop app would have no way to sign in." >&2
    echo "It normally comes from the Keychain (service ansa-clerk-publishable). Set it" >&2
    echo "explicitly and re-run:  VITE_CLERK_PUBLISHABLE_KEY=pk_test_… ./build.sh desktop" >&2
    exit 1
  fi

  echo "Building the web app for ${WORKER_API} …"
  VITE_ANSA_API="$WORKER_API" npm run build

  # Same artifact check as the deploy: prove Vite inlined the values rather than
  # trusting that this shell had them set. A desktop bundle missing its API URL
  # fails exactly as silently as a deployed one.
  local js
  js=$(find dist/assets -name '*.js' -print -quit)
  for needle in "$WORKER_API" "$VITE_CLERK_PUBLISHABLE_KEY"; do
    if ! grep -qF "$needle" "$js"; then
      echo "The built bundle is missing a value it needs, so it was not wrapped." >&2
      echo "Expected to find '${needle:0:24}…' in ${js}." >&2
      exit 1
    fi
  done
  echo "Bundle checks out: API URL and Clerk key are both inlined."

  # Hand the built bundle to the shell. A fresh copy each time so a stale web/
  # can't outlive the dist/ it came from.
  rm -rf desktop/web
  cp -R dist desktop/web

  # The Content-Security-Policy main.js sends has to name the exact origins this
  # bundle talks to, and those are deployment values (the Worker URL, the Clerk
  # instance) that must not be hardcoded in the committed main.js. Write them to
  # a generated, gitignored file next to the bundle instead — regenerated every
  # build, so it can never describe a different bundle than the one beside it.
  #
  # The Clerk Frontend API host is encoded in the publishable key: the base64
  # tail of pk_test_… / pk_live_… decodes to `<instance>.clerk.accounts.dev$`
  # (a trailing `$` sentinel Clerk appends). The renderer's WebSocket is the
  # Worker URL with http→ws, so ws(s) needs the same host as https.
  #
  # The tail is *unpadded* base64, and macOS `base64 -d` silently drops the final
  # incomplete group — which is the `v$` of `.dev$`, so a naive decode loses the
  # `v` and yields `.de`. Re-pad to a multiple of four first.
  local clerk_tail clerk_pad clerk_fapi
  clerk_tail=${VITE_CLERK_PUBLISHABLE_KEY#pk_*_}
  clerk_pad=$(( (4 - ${#clerk_tail} % 4) % 4 ))
  while [ "$clerk_pad" -gt 0 ]; do clerk_tail="${clerk_tail}="; clerk_pad=$((clerk_pad - 1)); done
  clerk_fapi=$(printf '%s' "$clerk_tail" | base64 -d 2>/dev/null | sed 's/\$$//')
  if [ -z "$clerk_fapi" ]; then
    echo "Could not decode the Clerk Frontend API host from the publishable key." >&2
    echo "The CSP needs it; check VITE_CLERK_PUBLISHABLE_KEY is a real pk_… key." >&2
    exit 1
  fi
  cat > desktop/web/csp-origins.json <<JSON
{
  "api": "${WORKER_API}",
  "clerkFapi": "https://${clerk_fapi}"
}
JSON
  echo "Wrote CSP origins: api=${WORKER_API}, clerk=https://${clerk_fapi}"

  if [ ! -d desktop/node_modules ]; then
    echo "Installing Electron (first run) …"
    (cd desktop && npm install)
  fi
}

# The desktop app binds a fixed loopback port (desktop/main.js PORT), so a copy
# left running from a previous build holds it and the new one dies with
# EADDRINUSE. Rather than refuse to launch, take the old one down first — a
# rebuild is meant to replace the running copy, not stand beside it. Whoever
# holds the port is the dev-run Electron, so target that by port. The packaged
# .app is different: it loads its bundle from the asar over Electron's own
# scheme and never listens on this port, so lsof can't see it — an earlier
# version killed only by port and so never replaced the installed app, leaving a
# days-old copy running while every rebuild "succeeded". So also match the
# installed app by its bundle path. Give each a moment to exit before we relaunch.
DESKTOP_PORT=41407
DESKTOP_APP="/Applications/_vibe_coded/Ansa.app"
kill_running_ansa() {
  local pids app_pids
  pids=$(lsof -tiTCP:"$DESKTOP_PORT" -sTCP:LISTEN 2>/dev/null) || true
  app_pids=$(pgrep -f "$DESKTOP_APP/Contents/MacOS/" 2>/dev/null) || true
  local all="$pids"$'\n'"$app_pids"
  all=$(printf '%s\n' "$all" | sort -u | sed '/^$/d')
  [ -z "$all" ] && return
  echo "Replacing the Ansa already running (pid ${all//$'\n'/, }) …"
  # shellcheck disable=SC2086
  kill $all 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    # `|| true`: once the app is gone both probes exit nonzero, and under
    # `set -e` a bare `still=$(…)` with a failing command substitution would
    # abort the whole build right at the point the kill succeeded.
    still=$(lsof -tiTCP:"$DESKTOP_PORT" -sTCP:LISTEN 2>/dev/null; pgrep -f "$DESKTOP_APP/Contents/MacOS/" 2>/dev/null) || true
    [ -z "$still" ] && return
    sleep 0.2
  done
  # Still alive after two seconds — hung. SIGKILL the survivors and move on; if
  # something is genuinely stuck the launch below will say so plainly.
  # shellcheck disable=SC2086
  kill -9 $all 2>/dev/null || true
  sleep 0.3
}

# Clear cookie rows left behind by an earlier loopback port.
#
# Clerk's session cookies are keyed in the store partly by source port, but
# Chromium's duplicate check ignores the port — so a cookie under the old
# random-port origin and the same one under 41407 read as duplicates and it logs
# a `Found N duplicate cookies` error per name at every launch. The old-port
# rows are dead (nothing serves those ports now) and only ever get cleared here.
#
# Must run with the app down — kill_running_ansa above guarantees that, so the
# SQLite store isn't open and this write is safe. macOS ships sqlite3; skip if
# it or the store is missing. The app also does this at startup, but only when
# it wins the race to the store, so doing it here makes the fix reliable.
purge_stale_cookies() {
  local store="$HOME/Library/Application Support/ansa-desktop/Cookies"
  [ -f "$store" ] || return
  command -v sqlite3 >/dev/null 2>&1 || return
  sqlite3 "$store" "DELETE FROM cookies WHERE source_port <> ${DESKTOP_PORT};" 2>/dev/null || true
}

# Drop Chromium's render caches so a rebuild's JS is what actually loads. The
# packaged app serves index.html and its assets through Electron, and Chromium's
# HTTP cache (Cache) and compiled-V8 cache (Code Cache) can outlive a relaunch
# and keep serving an old bundle — so the .app on disk is new but the window
# shows the last build, or one from several builds ago. Deleting these forces a
# fresh load; they're pure caches (GPU shaders, HTTP bodies, compiled JS) and
# regenerate on next launch, so nothing of the user's is lost — the tree lives
# in SQLite and cookies are handled above.
#
# Must run with the app down, which kill_running_ansa guarantees before this.
purge_render_cache() {
  local ud="$HOME/Library/Application Support/ansa-desktop"
  [ -d "$ud" ] || return
  rm -rf "$ud/Cache" "$ud/Code Cache" "$ud/GPUCache" \
    "$ud/DawnGraphiteCache" "$ud/DawnWebGPUCache" 2>/dev/null || true
}

# Dev run: build the bundle, then launch the hot-reload window.
desktop() {
  trap - INT TERM EXIT
  build_desktop_bundle
  kill_running_ansa
  purge_stale_cookies
  purge_render_cache
  echo "Launching Ansa …"
  (cd desktop && npm start)
}

# Packaged run: build the bundle, package a real .app via electron-builder
# (which compiles the Liquid Glass Ansa.icon through actool), ad-hoc sign it,
# and replace the installed copy in /Applications/_vibe_coded so a rebuild is
# the copy that opens — not last build's.
desktop_dist() {
  trap - INT TERM EXIT
  build_desktop_bundle

  echo "Packaging Ansa.app (electron-builder → actool) …"
  # No Developer ID here, so keep electron-builder from hunting for one; the
  # ad-hoc sign below is what lets the local copy launch.
  (cd desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist)

  local built="desktop/dist/mac-arm64/Ansa.app"
  if [ ! -d "$built" ]; then
    echo "electron-builder finished but ${built} isn't there." >&2
    echo "Check the packaging output above; the mac target is 'dir' in desktop/package.json." >&2
    exit 1
  fi

  # Confirm actool compiled the Liquid Glass layers in. Without Assets.car the
  # bundle silently falls back to the flat .icns, which is the whole thing this
  # path exists to avoid — so it's a failure, not a warning.
  if [ ! -f "$built/Contents/Resources/Assets.car" ]; then
    echo "The packaged app has no Assets.car, so the Liquid Glass icon didn't compile." >&2
    echo "actool needs Xcode 26+ (Icon Composer). Check: xcodebuild -version." >&2
    exit 1
  fi

  local dest
  dest="$(dirname "$DESKTOP_APP")"
  mkdir -p "$dest"
  echo "Installing to ${DESKTOP_APP} …"
  # Kill the running copy before overwriting it: replacing the .app bundle out
  # from under a live process is what left the days-old app running and its
  # cache stale. Down first, then swap, then relaunch.
  kill_running_ansa
  rm -rf "$DESKTOP_APP"
  cp -R "$built" "$DESKTOP_APP"

  # Ad-hoc sign so Gatekeeper lets an unsigned local build launch, and drop the
  # quarantine flag the copy may inherit. Local use only — this is not a
  # distributable signature.
  codesign --force --deep --sign - "$DESKTOP_APP" >/dev/null 2>&1
  xattr -dr com.apple.quarantine "$DESKTOP_APP" 2>/dev/null || true
  purge_stale_cookies
  purge_render_cache
  echo "Launching Ansa (watch the dock for the glass icon) …"
  # Wait for the killed instance to fully deregister before relaunching.
  # LaunchServices treats a bundle id that is still quitting as "open" and
  # silently no-ops `open`, which is how a rebuild could finish with no window.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$DESKTOP_APP/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 0.2
  done
  open -n "$DESKTOP_APP"
  # Confirm it actually came up; a bare `open` can fail quietly.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$DESKTOP_APP/Contents/MacOS/" >/dev/null 2>&1 && break
    sleep 0.3
  done
  if ! pgrep -f "$DESKTOP_APP/Contents/MacOS/" >/dev/null 2>&1; then
    echo "Ansa was installed but didn't launch. Open it from ${DESKTOP_APP} or re-run ./build.sh." >&2
  fi
}

# Everything that can be checked without a person. Plain check is types, the
# test suites and the laws: about a minute and a half, with no stack, ports or
# simulator, so any number of sessions can run it at once. --drives adds the
# drives, for a feature in active development and before a release: a stack
# already running in dev auth is reused, so it works alongside
# `./build.sh web --no-auth`; otherwise it starts one and stops it when done.
check() {
  trap - INT TERM EXIT
  local drives=${1:-}

  echo "Typechecking …"
  npm run typecheck
  echo "Running tests …"
  npm test
  if command -v swift >/dev/null 2>&1; then
    echo "Running the AnsaCore tests and the Swift-to-TypeScript wire and agreement checks …"
    ios/build.sh test
    ios/build.sh wire
    ios/build.sh agree
  else
    echo "Skipping the AnsaCore, wire and agreement checks: swift isn't installed (needs Xcode on macOS)."
  fi
  echo "Checking the laws …"
  tests/no-two-axis-scroll.sh
  tests/row-gestures.sh
  tests/no-ios-warnings.sh
  node tests/feature-map.mjs
  node tests/doc-stamps.mjs
  if [ "$drives" != "--drives" ]; then
    echo "Fast checks passed. The drives didn't run: ./build.sh check --drives runs them."
    return
  fi

  local health="http://127.0.0.1:${API_PORT}/api/health"
  # A stack already up is reused, so it has to be serving this checkout: one
  # started in the main checkout or another worktree would pass the drives on
  # that tree's code.
  local port pid cwd here
  here=$(git rev-parse --show-toplevel)
  for port in "$API_PORT" "$APP_PORT"; do
    pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
    [ -n "$pid" ] || continue
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    if [ "$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" != "$here" ]; then
      echo "Port ${port} is served from ${cwd:-another folder}, not this checkout, so the drives would test that code." >&2
      echo "Stop that ./build.sh web (kill ${pid}) and re-run; check starts one here." >&2
      exit 1
    fi
  done
  if ! curl -fsS "$health" 2>/dev/null | grep -q '"auth":"dev"'; then
    if curl -fsS "$health" >/dev/null 2>&1; then
      echo "The API on :${API_PORT} is running with sign-in, and the drives need it off." >&2
      echo "Stop that ./build.sh web and re-run, or start ./build.sh web --no-auth yourself." >&2
      exit 1
    fi
    # Globals, not locals: the EXIT trap runs after check() has returned.
    STACK_LOG=$(mktemp -t ansa-check-stack)
    echo "Starting the web stack without sign-in (log: ${STACK_LOG}) …"
    ANSA_NO_OPEN=1 ./build.sh web --no-auth >"$STACK_LOG" 2>&1 &
    STACK_PID=$!
    # Stop it however check ends. Its own trap takes down wrangler and Vite.
    trap 'kill "$STACK_PID" 2>/dev/null; wait "$STACK_PID" 2>/dev/null; rm -f "$STACK_LOG"' EXIT
    local waited=0
    until curl -fsS "$health" 2>/dev/null | grep -q '"auth":"dev"' \
        && curl -fsS "$APP_URL" >/dev/null 2>&1; do
      if ! kill -0 "$STACK_PID" 2>/dev/null; then
        echo "The web stack stopped before it was up. Its last lines:" >&2
        tail -n 15 "$STACK_LOG" >&2
        exit 1
      fi
      if [ "$waited" -ge 120 ]; then
        echo "The web stack wasn't up after 120s. Its last lines:" >&2
        tail -n 15 "$STACK_LOG" >&2
        exit 1
      fi
      sleep 2; waited=$((waited + 2))
    done
  fi

  echo "Running the drives …"
  ANSA_APP="$APP_URL" npm run drive
  ANSA_APP="$APP_URL" node tests/no-two-axis-scroll.mjs
  if command -v xcodebuild >/dev/null 2>&1; then
    echo "Running the iOS drives …"
    ios/build.sh drive
  else
    echo "Skipping the iOS drives: xcodebuild isn't installed (needs Xcode on macOS)."
  fi
  echo "All checks passed."
}

# Point git at the repo's hooks (dev/hooks/pre-push runs ./build.sh check;
# dev/hooks/pre-commit stamps the docs a commit changes). A git
# setting rather than a committed file, so every entry point sets it.
git -C "$(dirname "$0")" config core.hooksPath dev/hooks 2>/dev/null || true

# The bare default packages and installs the desktop app; everything else is an
# explicit argument. `web` is the only one that falls through to the run-stack
# code below — the rest handle themselves and exit here.
case "${1:-}" in
  '') desktop_dist; exit 0 ;;
  desktop)
    if [ -n "${2:-}" ]; then
      echo "'desktop' is the dev run and takes no target." >&2
      echo "For the packaged, installed build, run ./build.sh with no arguments." >&2
      exit 1
    fi
    desktop; exit 0 ;;
  deploy) deploy "${2:-both}"; exit 0 ;;
  check)
    if [ -n "${2:-}" ] && [ "$2" != "--drives" ]; then
      echo "'check' takes only --drives." >&2
      echo "Usage: ./build.sh check [--drives]" >&2
      exit 1
    fi
    check "${2:-}"; exit 0 ;;
  web)
    if [ -n "${2:-}" ] && [ "$2" != "--no-auth" ]; then
      echo "'web' takes only --no-auth." >&2
      echo "Usage: ./build.sh web [--no-auth]" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown argument: $1" >&2
    echo "Usage: ./build.sh [desktop | web | check [--drives] | deploy [app|api]]" >&2
    exit 1
    ;;
esac

# wrangler dev gives the Worker what .dev.vars holds and nothing from this
# script's environment, so the auth chosen above is handed over in a file. It's
# read after .dev.vars so it wins, and an empty CLERK_SECRET_KEY keeps --no-auth
# in dev mode even if .dev.vars has a secret. It can hold the secret, so mktemp
# makes it private to this user and cleanup removes it.
WORKER_ENV=$(mktemp -t ansa-worker-env)
{
  echo "ANSA_DEV_AUTH=${ANSA_DEV_AUTH}"
  echo "CLERK_SECRET_KEY=${CLERK_SECRET_KEY:-}"
} > "$WORKER_ENV"

API_CMD=(npx wrangler dev --port "$API_PORT")
if [ -f .dev.vars ]; then API_CMD+=(--env-file .dev.vars); fi
API_CMD+=(--env-file "$WORKER_ENV")
API_NAME="worker (wrangler dev)"
# Explicit even though src/api.ts would derive the same URL in dev, so the port
# is decided in one place.
export VITE_ANSA_API="http://localhost:${API_PORT}"

check_port_free "$API_PORT" "server"

echo "Starting ${API_NAME} on http://127.0.0.1:${API_PORT} …"
"${API_CMD[@]}" &
pids+=($!)

# Wait for the API to answer before starting the app, so the app's first
# connect finds the server already up. wrangler takes ~20s on a cold start, so
# there is no timeout here beyond the child check, which is what actually
# catches a failure.
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

# The app asks for sign-in exactly when it has the Clerk key, so the Worker has
# to be checking Clerk tokens exactly then. Either mismatch looks like a broken
# app: a sign-in that never takes, or a dev Worker behind a wall.
want_auth=dev
if [ -n "${VITE_CLERK_PUBLISHABLE_KEY:-}" ]; then want_auth=clerk; fi
got_auth=$(curl -s "http://127.0.0.1:${API_PORT}/api/health" | sed -n 's/.*"auth":"\([a-z]*\)".*/\1/p')
if [ "$got_auth" != "$want_auth" ]; then
  echo "The app expects ${want_auth} auth but the Worker reports '${got_auth}'." >&2
  echo "The Worker's auth comes from .dev.vars and the env file this script writes;" >&2
  echo "check the bindings wrangler printed above. To run without sign-in:" >&2
  echo "  ./build.sh web --no-auth" >&2
  exit 1
fi

echo "Starting app on ${APP_URL} …"
# The flag wins over vite.config.ts; strictPort there still applies.
npm run dev -- --port "$APP_PORT" &
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
