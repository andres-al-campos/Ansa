#!/usr/bin/env bash
# Law: the iOS app builds without warnings. A warning is an error that has not
# bitten yet, and one nobody reads hides the next.
#
# Every one of Ansa's files is recompiled each time, into its own directory: an
# incremental build prints warnings only for the files it recompiles, which is
# how six of them sat unseen behind builds that looked clean. Touching Ansa's
# sources does that and keeps the third-party packages built, which a `clean`
# would throw away and take a minute and a half to rebuild. For the simulator
# on Apple silicon only, and unsigned, so it needs no phone, team or Clerk key.
#
# One warning is let through by its text: App Intents' metadata step says it
# skipped a framework Ansa does not use. It comes from Apple's tooling, not
# from Ansa's code, and no build setting turns it off.
#
#   tests/no-ios-warnings.sh
cd "$(dirname "$0")/../ios" || exit 1

command -v xcodebuild >/dev/null 2>&1 || {
  echo "Skipping no-ios-warnings: xcodebuild isn't installed (needs Xcode on macOS)."
  exit 0
}
command -v xcodegen >/dev/null 2>&1 || {
  echo "no-ios-warnings: xcodegen is not installed. Install it with:  brew install xcodegen" >&2
  exit 1
}
[ -f Config.xcconfig ] || {
  echo "no-ios-warnings: ios/Config.xcconfig is missing. Make it with:  cp ios/Config.example.xcconfig ios/Config.xcconfig" >&2
  exit 1
}
xcodegen generate --quiet || { echo "no-ios-warnings: xcodegen couldn't generate the project; its errors are above." >&2; exit 1; }

log=build/warnings.log
mkdir -p build
find Sources AnsaCore/Sources Info.plist -type f -exec touch {} +
ANSA_CLERK_PUBLISHABLE_KEY="" xcodebuild \
  -project Ansa.xcodeproj -scheme Ansa -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/warnings \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
  build >"$log" 2>&1
status=$?

if [ "$status" -ne 0 ]; then
  echo "no-ios-warnings: the iOS build failed. The errors:" >&2
  grep -E 'error:' "$log" | sort -u | head -20 >&2
  echo "The full log is ios/${log}." >&2
  exit 1
fi

warnings=$(grep -E 'warning:' "$log" \
  | grep -viE 'Metadata extraction skipped[.,] no AppIntents.framework dependency found' \
  | sed -E 's|^/.*/ios/|ios/|' | sort -u)

if [ -n "$warnings" ]; then
  echo "no-ios-warnings: the iOS build has warnings:" >&2
  echo "$warnings" | sed 's/^/  /' >&2
  echo "Fix each at the line it names; don't silence it with a build setting. The full log is ios/${log}." >&2
  exit 1
fi
echo "✓ the iOS app builds clean, with no warnings"
