#!/usr/bin/env bash
#
# Build and run the Ansa iOS app.
#
#   ./build.sh              build for the connected iPhone, install, launch
#   ./build.sh sim          the same, on a simulator, against a local wrangler
#   ./build.sh test         run the AnsaCore suite (no device needed)
#   ./build.sh wire         check the Swift op encoding against the server
#   ./build.sh agree        check Swift and TypeScript applyOp make the same tree
#   ./build.sh drive [name] run the UI tests, or one feature's, on a simulator
#   ./build.sh clean        drop the generated project and build output
#
#   --no-auth               (sim only) build without a Clerk key, so the app
#                           skips the sign-in wall
#
# No-arg leaves the app installed and running on the phone, rather than stopping
# at a .app in a build directory — same rule as the repo-root build.sh.
#
# The phone gets a Release build, which points at the deployed Worker. That is
# not only about optimisation: a Debug build hardcodes http://localhost:8787,
# and on the phone localhost is the phone, so a debug build installed on a
# device talks to nothing. The simulator shares the Mac's network and so is the
# one place a local wrangler is reachable — which is what `sim` is for.
#
set -euo pipefail

cd "$(dirname "$0")"

SCHEME=Ansa
BUNDLE_ID=com.id3arium.ansa
# Any booted simulator is used as-is; this is only the fallback for a cold start.
DEFAULT_SIM="iPhone 16"

die() { echo "$*" >&2; exit 1; }

# --device <udid> is how ReSign tells us which phone it picked. Stripped here,
# before the dispatch below reads $1 — leaving it in place would make $1
# "--device" and the default "run" would never fire.
#
# Unset when run from a terminal, where device_udid() picks a phone itself, so
# the no-arg behaviour is unchanged.
DEVICE_ID=""
# --no-auth builds without a Clerk key, which makes the app take its
# unauthenticated path straight to the outline instead of stopping at the
# sign-in wall. For testing sync and lifecycle behaviour on the simulator
# against a local wrangler, where signing in would need real credentials and
# proves nothing about the code under test. Never for a build on the phone:
# without a key there is no user, so it talks to the dev stub's tree.
NO_AUTH=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --device)
      shift
      [ $# -gt 0 ] || die "--device needs a device identifier."
      DEVICE_ID="$1"
      ;;
    --no-auth) NO_AUTH=1 ;;
    *) args+=("$1") ;;
  esac
  shift
done
set -- "${args[@]+"${args[@]}"}"

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

# Everything both targets need before xcodebuild runs.
prepare() {
  require_config
  generate
  echo "Building…"
  # Exported rather than passed as an argument: a build setting on the command
  # line is visible to every other process via ps, and lands in shell history.
  # xcodebuild picks up ANSA_CLERK_PUBLISHABLE_KEY from the environment and
  # substitutes it into Info.plist.
  export ANSA_CLERK_PUBLISHABLE_KEY
  if [ -n "$NO_AUTH" ]; then
    ANSA_CLERK_PUBLISHABLE_KEY=""
    echo "Building without a Clerk key — the app will skip sign-in."
  else
    ANSA_CLERK_PUBLISHABLE_KEY=$(clerk_key)
  fi
}

# The .app xcodebuild just produced, or a failure that says how to see why.
# An optional second argument adds a hint about the likeliest cause.
built_app() {
  local app="build/Build/Products/$1/${SCHEME}.app" hint=${2:-}
  [ -d "$app" ] || die "Build produced no app at ${app}.
${hint:+
$hint
}
Re-run without the output filter to see the full log:
  xcodebuild -project Ansa.xcodeproj -scheme ${SCHEME} -derivedDataPath build build"
  printf '%s' "$app"
}

# The identifier of a paired iPhone, or instructions for pairing one.
#
# Any paired phone counts, including one the listing calls "disconnected".
# That state is stale rather than true — `list devices` reports the last
# session until something opens a tunnel, and `devicectl install` opens one
# itself. Requiring a live tunnel here rejects phones that would install fine.
#
# Only devicectl needs an id: the build targets generic/platform=iOS, so
# xcodebuild is never told which phone this is. That also sidesteps its separate
# naming scheme — it wants a hardware ECID and rejects devicectl's UUID with
# "unable to find a device matching the destination specifier".
device_udid() {
  local udid
  udid=$(xcrun devicectl list devices 2>/dev/null \
    | grep -iE 'available|connected' \
    | grep -oiE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
    | head -1) || udid=""

  [ -n "$udid" ] && { printf '%s' "$udid"; return; }

  die "No iPhone paired with this Mac.

Pair it over Wi-Fi in Xcode → Window → Devices and Simulators, or connect it
by USB and tap Trust on the phone.

Check it with:  xcrun devicectl list devices"
}

# A booted simulator's id, booting ${DEFAULT_SIM} if none is.
booted_sim() {
  # Reuse whatever is already booted; the simulator takes far longer to start
  # than the build does, and a rebuild-and-relaunch loop should not pay it.
  local udid
  udid=$(xcrun simctl list devices booted -j \
    | python3 -c 'import json,sys
devs=[d for v in json.load(sys.stdin)["devices"].values() for d in v]
print(devs[0]["udid"] if devs else "")')

  if [ -z "$udid" ]; then
    echo "No simulator booted — starting ${DEFAULT_SIM}…" >&2
    udid=$(xcrun simctl list devices available -j \
      | DEFAULT_SIM="$DEFAULT_SIM" python3 -c 'import json,os,sys
want=os.environ["DEFAULT_SIM"]
devs=[d for v in json.load(sys.stdin)["devices"].values() for d in v]
hit=[d for d in devs if d["name"]==want] or devs
print(hit[0]["udid"] if hit else "")')
    [ -n "$udid" ] || die "No iOS simulators are installed. Open Xcode → Settings → Components and add an iOS runtime."
    xcrun simctl boot "$udid" >&2
  fi
  printf '%s' "$udid"
}

case "${1:-run}" in
  test)
    swift test --package-path AnsaCore
    ;;

  wire)
    ./AnsaCore/Tools/check-wire.sh
    ;;

  agree)
    ./AnsaCore/Tools/check-agreement.sh
    ;;

  clean)
    rm -rf Ansa.xcodeproj build AnsaCore/.build
    echo "Removed the generated project and build output."
    ;;

  run)
    # A keyless build on the phone would look like it worked and quietly read
    # the dev stub's tree instead of the user's, so it is refused rather than
    # warned about.
    [ -n "$NO_AUTH" ] && die "--no-auth is for the simulator only. Use:  ./build.sh sim --no-auth"

    # Before prepare, so an absent phone fails immediately rather than after
    # "Building…" and a Keychain prompt for a build that cannot be installed.
    # An explicitly-passed device wins; otherwise pick one ourselves.
    device_id="${DEVICE_ID:-$(device_udid)}"
    prepare

    # Release, not Debug. See the note at the top: a Debug build points at
    # localhost, which on the phone is the phone.
    #
    # `generic/platform=iOS` rather than this specific phone: the build does not
    # depend on which device it lands on, and naming one means xcodebuild has to
    # resolve it — which fails while the phone is merely asleep, long after the
    # tunnel is up. Signing still happens; only the destination is generic.
    xcodebuild \
      -project Ansa.xcodeproj \
      -scheme "$SCHEME" \
      -configuration Release \
      -destination 'generic/platform=iOS' \
      -derivedDataPath build \
      -allowProvisioningUpdates \
      build | grep -E "error:|warning:|BUILD"
    # `grep`'s status is not xcodebuild's, and it is the one the shell keeps —
    # so the build's own result has to be read out of PIPESTATUS before
    # anything else runs. Without this a compile error is printed and then
    # installed straight over, and the script reports success while the device
    # keeps the previous binary: indistinguishable from a fix that did not
    # work. No `|| true`, which would make the pipeline's status its own and
    # put xcodebuild's out of reach. `set -o pipefail` is not used here because
    # grep legitimately exits 1 on a build with no matching lines at all.
    build_status=${PIPESTATUS[0]}
    [ "$build_status" -eq 0 ] || die "Build failed. The errors are above."

    # Unlocking is a separate requirement from connecting, and the phone can
    # satisfy the first without the second: the tunnel comes up while it is
    # asleep, then xcodebuild times out preparing the debug session. The error
    # it prints for that is buried in a destination listing, so it is called out
    # here instead.
    app=$(built_app Release-iphoneos "If this is a signing error, check that Xcode → Settings → Accounts still
has your Apple ID, and that the bundle id is one your team can claim.")

    # ReSign looks for a signed app at build/<Scheme>.app, a flat path rather
    # than the derivedData layout xcodebuild produces. Copied rather than
    # symlinked so the embedded provisioning profile comes with it — ReSign
    # checks for that file inside the bundle to confirm the app is signed.
    #
    # Staged before the install below, so the copy exists even when the phone
    # is asleep and devicectl fails.
    rm -rf "build/${SCHEME}.app"
    cp -R "$app" "build/${SCHEME}.app"

    echo "Installing to the phone…"
    # Retried: devicectl drops the device link mid-install often enough to be
    # routine, reporting a transient "Connection interrupted" (CoreDeviceError
    # 3002). The identical command usually succeeds on the next attempt, so
    # failing on the first drop would send you back to the terminal for nothing.
    #
    # A locked phone is not transient: iOS will not mount the developer disk
    # image until it is unlocked, so it is named and not retried. It used to
    # fall through to the Wi-Fi advice below, which sent you looking at the
    # network while the phone was simply locked.
    installed=0
    for attempt in 1 2 3; do
      if install_log=$(xcrun devicectl device install app --device "$device_id" "$app" 2>&1); then
        installed=1
        break
      fi
      if grep -q 'DeviceLocked' <<<"$install_log"; then
        die "Install failed: the iPhone is locked.

Unlock it and keep it unlocked until the install finishes, then run this again.

The signed app is at ${app} if you would rather install it from Xcode."
      fi
      [ "$attempt" -lt 3 ] && echo "  link dropped, retrying ($attempt/3)…" && sleep 2
    done
    [ "$installed" = 1 ] || die "Install failed after 3 attempts.

Wake the phone and check it is on the same network as this Mac — a sleeping
phone on Wi-Fi is the usual cause. Then run this again.

The signed app is at ${app} if you would rather install it from Xcode."

    # Launching is allowed to fail where installing is not. iOS refuses to open
    # an app on a locked phone, and that says nothing about the build — the new
    # version is already on the device either way, so treating it as an error
    # would fail a run that actually did its job.
    echo ""
    if xcrun devicectl device process launch --device "$device_id" "$BUNDLE_ID" >/dev/null 2>&1; then
      echo "Ansa is running on your iPhone, talking to ansa.id3arium.workers.dev."
    else
      echo "Ansa is installed on your iPhone — unlock the phone and open it from the"
      echo "home screen. (iOS will not launch an app onto a locked screen.)"
    fi
    echo "Signed with a personal team, so it stops opening after 7 days — re-run this to renew it."
    ;;

  drive)
    # Each feature's UI test (UITests/<Name>Tests.swift), or one by its name in
    # features/: `drive search` runs SearchTests. On a simulator, against the
    # local Worker, which the tests seed and clean up through.
    curl -fsS http://127.0.0.1:8787/api/health 2>/dev/null | grep -q '"auth":"dev"' || die \
      "The local Worker isn't up without sign-in, and the UI tests seed through it.
Start it from the repo root with:  ./build.sh web --no-auth"

    only=AnsaUITests
    if [ -n "${2:-}" ]; then
      # search → SearchTests, check-off → CheckOffTests.
      class="$(printf '%s' "$2" | awk -F- '{for (i = 1; i <= NF; i++) printf "%s", toupper(substr($i, 1, 1)) substr($i, 2)}')Tests"
      [ -f "UITests/${class}.swift" ] || die "No UI test for \"$2\": there's no UITests/${class}.swift.
The ones there: $(ls UITests | sed -n 's/Tests\.swift$//p' | sed -E 's/([a-z0-9])([A-Z])/\1-\2/g' | tr 'A-Z\n' 'a-z ')"
      only="AnsaUITests/${class}"
    fi

    # The tests sign in as the dev stub's user, so the app must skip sign-in.
    NO_AUTH=1
    prepare
    udid=$(booted_sim) || exit 1
    open -a Simulator

    mkdir -p build
    log=build/drive.log
    xcodebuild test \
      -project Ansa.xcodeproj \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$udid" \
      -derivedDataPath build \
      -only-testing:"$only" >"$log" 2>&1 || true
    # xcodebuild's own summary lines and the tests' ✓ and failure messages; the
    # rest is in the log.
    grep -E "✓|error:|failed|passed|TEST (SUCCEEDED|FAILED)|BUILD FAILED" "$log" \
      | grep -vE "^\s*$" || true
    grep -q "TEST SUCCEEDED" "$log" || die "Drive failed. The full log is ios/${log}."
    ;;

  sim)
    prepare

    udid=$(booted_sim) || exit 1

    # Software keyboard, not the Mac's. A hardware keyboard means nothing ever
    # covers the bottom of the screen, so anything that has to stay clear of the
    # keyboard — a focused row near the end of a list, a button that rides above
    # it — looks right on the simulator and is broken on a phone. That is how
    # the add-task run shipped without its auto-scroll working.
    #
    # The Simulator reads this only at launch, and nothing short of a restart
    # takes effect: toggling the guest's own keyboard prefs over `simctl spawn`
    # does not move a running keyboard. So the restart is conditional — the
    # common case is a rebuild against a simulator that is already correct, and
    # that case must not pay for one.
    if [ "$(defaults read com.apple.iphonesimulator ConnectHardwareKeyboard 2>/dev/null)" != "0" ]; then
      echo "Switching the simulator to the software keyboard…"
      defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
      # Only if it is up: quitting one that is not running is a no-op that still
      # costs a second, and `open` below starts it either way.
      pgrep -q -x Simulator && osascript -e 'quit app "Simulator"'
    fi
    open -a Simulator

    xcodebuild \
      -project Ansa.xcodeproj \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$udid" \
      -derivedDataPath build \
      build | grep -E "error:|warning:|BUILD"
    # `grep`'s status is not xcodebuild's, and it is the one the shell keeps —
    # so the build's own result has to be read out of PIPESTATUS before
    # anything else runs. Without this a compile error is printed and then
    # installed straight over, and the script reports success while the device
    # keeps the previous binary: indistinguishable from a fix that did not
    # work. No `|| true`, which would make the pipeline's status its own and
    # put xcodebuild's out of reach. `set -o pipefail` is not used here because
    # grep legitimately exits 1 on a build with no matching lines at all.
    build_status=${PIPESTATUS[0]}
    [ "$build_status" -eq 0 ] || die "Build failed. The errors are above."

    app=$(built_app Debug-iphonesimulator)

    xcrun simctl install "$udid" "$app"
    xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null

    echo ""
    echo "Ansa is running on the simulator."
    echo "The app talks to http://localhost:8787 — start it with ../build.sh"
    ;;

  *)
    die "Unknown command: $1
Usage: ./build.sh [sim|test|drive [name]|wire|agree|clean] [--no-auth]   (no argument builds to the phone)"
    ;;
esac
