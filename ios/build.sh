#!/usr/bin/env bash
#
# Build and run the Ansa iOS app.
#
#   ./build.sh              build for the connected iPhone, install, launch
#   ./build.sh sim          the same, on a simulator, against a local wrangler
#   ./build.sh test         run the AnsaCore suite (no device needed)
#   ./build.sh wire         check the Swift op encoding against the server
#   ./build.sh clean        drop the generated project and build output
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
  ANSA_CLERK_PUBLISHABLE_KEY=$(clerk_key)
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

# A connected phone as "<devicectl identifier> <hardware udid>", or empty.
#
# Both, because the two tools name the same phone differently: devicectl uses
# its own UUID, while xcodebuild wants the hardware ECID and rejects the other
# with "unable to find a device matching the destination specifier" — which
# reads like the phone is absent rather than misidentified.
connected_udid() {
  xcrun devicectl list devices -j - 2>/dev/null \
    | python3 -c 'import json,sys
try: devs=json.load(sys.stdin)["result"]["devices"]
except Exception: devs=[]
ready=[d for d in devs
       if d.get("connectionProperties",{}).get("tunnelState") not in (None,"unavailable","disconnected")]
if ready:
    d=ready[0]
    hw=d.get("hardwareProperties",{}).get("udid","")
    if hw: print(d["identifier"], hw)' 2>/dev/null || true
}

# The connected iPhone's identifier, or instructions for getting one.
#
# Requires a live connection rather than accepting any paired device. A phone
# that has been paired once is listed forever, but xcodebuild will not accept it
# as a destination while it is away — and that failure surfaces as a wall of
# simulator names and "unable to find a device matching the destination
# specifier", which says nothing about the phone being unplugged.
# Echoes "<devicectl identifier> <hardware udid>" for a usable phone.
device_udid() {
  local udid known

  udid=$(connected_udid)
  [ -n "$udid" ] && { printf '%s' "$udid"; return; }

  # `list devices` is lazy: for a Wi-Fi-paired phone it reports the state from
  # the last session and will sit at "disconnected" indefinitely, even with the
  # phone awake on the same network. Asking for details opens the tunnel, after
  # which the listing reports it correctly. Without this a wireless phone looks
  # permanently absent.
  known=$(xcrun devicectl list devices -j - 2>/dev/null \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["devices"][0]["identifier"])
except Exception: print("")' 2>/dev/null) || known=""

  if [ -n "$known" ]; then
    echo "Waking $known over Wi-Fi…" >&2
    xcrun devicectl device info details --device "$known" >/dev/null 2>&1 || true
    udid=$(connected_udid)
    [ -n "$udid" ] && { printf '%s' "$udid"; return; }
  fi

  # Report what is actually wrong with the phone we know about, rather than a
  # generic "connect a device": a paired phone fails for a different reason than
  # no phone at all, and the fix differs.
  local paired transport
  paired=$(xcrun devicectl list devices 2>/dev/null | awk 'NR>2 && NF' | head -1)
  transport=$(xcrun devicectl list devices -j - 2>/dev/null \
    | python3 -c 'import json,sys
try: d=json.load(sys.stdin)["result"]["devices"][0]["connectionProperties"]
except Exception: print(""); raise SystemExit
print(d.get("transportType",""))' 2>/dev/null) || transport=""

  [ -n "$paired" ] || die "No iPhone is paired with this Mac.

Connect it by USB, unlock it, and tap Trust when the phone asks."

  die "Your iPhone is paired but would not connect, even after waking it.

$paired

$([ "$transport" = localNetwork ] && cat <<'WIFI'
It is paired over Wi-Fi. Unlock the phone and make sure it is on the same
network as this Mac — a locked, idle phone stops answering, which is the usual
cause. Cellular instead of Wi-Fi will do it too.
WIFI
)
Check it with:  xcrun devicectl list devices
The State column has to read 'connected' before a build can install."
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
    # Before prepare, so an absent phone fails immediately rather than after
    # "Building…" and a Keychain prompt for a build that cannot be installed.
    read -r device_id hw_udid <<<"$(device_udid)"
    prepare

    # Release, not Debug. See the note at the top: a Debug build points at
    # localhost, which on the phone is the phone.
    xcodebuild \
      -project Ansa.xcodeproj \
      -scheme "$SCHEME" \
      -configuration Release \
      -destination "id=$hw_udid" \
      -derivedDataPath build \
      -allowProvisioningUpdates \
      build | grep -E "error:|warning:|BUILD" || true

    # Unlocking is a separate requirement from connecting, and the phone can
    # satisfy the first without the second: the tunnel comes up while it is
    # asleep, then xcodebuild times out preparing the debug session. The error
    # it prints for that is buried in a destination listing, so it is called out
    # here instead.
    app=$(built_app Release-iphoneos "Is the phone unlocked? A connected but locked phone gets as far as
signing and then times out preparing for the install.")

    echo "Installing to the phone…"
    xcrun devicectl device install app --device "$device_id" "$app" >/dev/null
    xcrun devicectl device process launch --device "$device_id" "$BUNDLE_ID" >/dev/null

    echo ""
    echo "Ansa is running on your iPhone, talking to ansa.id3arium.workers.dev."
    echo "Signed with a personal team, so it stops opening after 7 days — re-run this to renew it."
    ;;

  sim)
    prepare

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

    xcodebuild \
      -project Ansa.xcodeproj \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$udid" \
      -derivedDataPath build \
      build | grep -E "error:|warning:|BUILD" || true

    app=$(built_app Debug-iphonesimulator)

    xcrun simctl install "$udid" "$app"
    xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null

    echo ""
    echo "Ansa is running on the simulator."
    echo "The app talks to http://localhost:8787 — start it with ../build.sh"
    ;;

  *)
    die "Unknown command: $1
Usage: ./build.sh [sim|test|wire|clean]   (no argument builds to the phone)"
    ;;
esac
