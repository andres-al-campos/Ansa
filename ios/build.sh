#!/usr/bin/env bash
#
# Build and run the Ansa iOS app.
#
#   ./build.sh              boot a simulator, build, install, launch
#   ./build.sh test         run the AnsaCore suite (no simulator needed)
#   ./build.sh wire         check the Swift op encoding against the server
#   ./build.sh clean        drop the generated project and build output
#
# No-arg leaves the app actually running on a booted simulator, rather than
# stopping at a .app in a build directory — same rule as the repo-root build.sh.
#
set -euo pipefail

cd "$(dirname "$0")"

SCHEME=Ansa
BUNDLE_ID=com.ansa.app
# Any booted simulator is used as-is; this is only the fallback for a cold start.
DEFAULT_SIM="iPhone 16"

die() { echo "$*" >&2; exit 1; }

require_config() {
  [ -f Config.xcconfig ] && return
  cat >&2 <<EOF
Missing Config.xcconfig — it holds your Apple Team ID, which is specific to this
machine and so is not committed.

  cp Config.example.xcconfig Config.xcconfig

Then put your 10-character Team ID in it. Find it in Xcode → Settings →
Accounts → your Apple ID → Manage Certificates, or at
developer.apple.com → Membership. A free Apple ID works; those builds expire
after 7 days.
EOF
  exit 1
}

# The Clerk publishable key, read from the login Keychain and baked into the
# app at build time.
#
# Not committed because it names a specific Clerk instance, which is account
# state rather than something a fresh clone should inherit. Not read from the
# Keychain at runtime either — an iOS app cannot see the Mac's Keychain, and the
# key is public by design, so there would be nothing to protect.
clerk_key() {
  local key
  if ! key=$(security find-generic-password -s ansa-clerk-publishable -w 2>/dev/null); then
    cat >&2 <<EOF
No Clerk publishable key in the Keychain.

Add it (the pk_test_… value from the Clerk dashboard under API Keys — the
publishable one, not the secret):

  security add-generic-password -s ansa-clerk-publishable -a "\$USER" -w pk_test_YOUR_KEY

Then run this again.
EOF
    exit 1
  fi
  printf '%s' "$key"
}

generate() {
  command -v xcodegen >/dev/null 2>&1 || die \
    "xcodegen is not installed. Install it with:  brew install xcodegen"
  xcodegen generate --quiet
}

case "${1:-run}" in
  test)
    swift test --package-path AnsaCore
    ;;

  wire)
    ./AnsaCore/Tools/check-wire.sh
    ;;

  clean)
    rm -rf Ansa.xcodeproj build AnsaCore/.build
    echo "Removed the generated project and build output."
    ;;

  run)
    require_config
    generate

    # Reuse whatever is already booted; the simulator takes far longer to start
    # than the build does, and a rebuild-and-relaunch loop should not pay it.
    udid=$(xcrun simctl list devices booted -j \
      | python3 -c 'import json,sys
devs=[d for v in json.load(sys.stdin)["devices"].values() for d in v]
print(devs[0]["udid"] if devs else "")')

    if [ -z "$udid" ]; then
      echo "No simulator booted — starting ${DEFAULT_SIM}…"
      udid=$(xcrun simctl list devices available -j \
        | DEFAULT_SIM="$DEFAULT_SIM" python3 -c 'import json,os,sys
want=os.environ["DEFAULT_SIM"]
devs=[d for v in json.load(sys.stdin)["devices"].values() for d in v]
hit=[d for d in devs if d["name"]==want] or devs
print(hit[0]["udid"] if hit else "")')
      [ -n "$udid" ] || die "No iOS simulators are installed. Open Xcode → Settings → Components and add an iOS runtime."
      xcrun simctl boot "$udid"
    fi
    open -a Simulator

    echo "Building…"
    # Exported rather than passed as an argument: a build setting on the command
    # line is visible to every other process via ps, and lands in shell history.
    # xcodebuild picks up ANSA_CLERK_PUBLISHABLE_KEY from the environment and
    # substitutes it into Info.plist.
    export ANSA_CLERK_PUBLISHABLE_KEY
    ANSA_CLERK_PUBLISHABLE_KEY=$(clerk_key)
    xcodebuild \
      -project Ansa.xcodeproj \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$udid" \
      -derivedDataPath build \
      build | grep -E "error:|warning:|BUILD" || true

    app="build/Build/Products/Debug-iphonesimulator/${SCHEME}.app"
    [ -d "$app" ] || die "Build produced no app at ${app}. Re-run without the filter to see why:
  xcodebuild -project Ansa.xcodeproj -scheme ${SCHEME} -destination id=${udid} -derivedDataPath build build"

    xcrun simctl install "$udid" "$app"
    xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null

    echo ""
    echo "Ansa is running on the simulator."
    echo "The app talks to http://localhost:8787 — start it with ../build.sh"
    ;;

  *)
    die "Unknown command: $1
Usage: ./build.sh [run|test|wire|clean]"
    ;;
esac
