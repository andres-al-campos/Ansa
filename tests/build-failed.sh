#!/usr/bin/env bash
# Law: a failed build in ios/build.sh ends on "Build failed", not on xcodebuild's last line.
#
# Runs xcode_build against an xcodebuild that always fails, and one whose output grep
# matches nothing, under the same shell options as build.sh.
#
#   tests/build-failed.sh
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

stub() { printf '#!/bin/bash\n%s\n' "$1" > "$tmp/xcodebuild"; chmod +x "$tmp/xcodebuild"; }
run() {
  {
    echo 'set -euo pipefail'
    sed -n '/^die()/p' "$here/ios/build.sh"
    sed -n '/^xcode_build() {/,/^}/p' "$here/ios/build.sh"
    echo 'xcode_build -scheme Ansa; echo "after build"'
  } > "$tmp/step.sh"
  PATH="$tmp:$PATH" bash "$tmp/step.sh" 2>&1
}

stub 'echo "/a/B.swift:3:5: error: cannot find x in scope"; echo "** BUILD FAILED **"; exit 65'
out=$(run)
if ! grep -q "^Build failed" <<<"$out" || grep -q "after build" <<<"$out"; then
  echo "✗ build-failed: a failed build didn't stop on build.sh's \"Build failed\" message. Output:" >&2
  sed 's/^/    /' <<<"$out" >&2
  echo "  Under set -e, a failing pipeline on a line of its own ends the script there. Run the" >&2
  echo "  xcodebuild | grep pipeline as an if condition in xcode_build, and read PIPESTATUS right after." >&2
  exit 1
fi

stub 'echo "nothing grep looks for"; exit 0'
out=$(run)
if ! grep -q "after build" <<<"$out"; then
  echo "✗ build-failed: a build that succeeded with no matching output stopped the script. Output:" >&2
  sed 's/^/    /' <<<"$out" >&2
  echo "  grep exits 1 when nothing matches; xcode_build must judge the build by xcodebuild's status." >&2
  exit 1
fi
echo "✓ build-failed: a failed build ends on \"Build failed\"; a quiet successful one carries on"
