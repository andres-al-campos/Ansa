#!/usr/bin/env bash
# Law: no iOS view scrolls on both axes at once. On a phone it always looks
# broken; a view that seems to need it gets a different layout instead. The
# web half is no-two-axis-scroll.mjs.
#
# Catches SwiftUI's ScrollView([.horizontal, .vertical]) as written. A screen
# that pans sideways by accident, from content wider than it, is caught on the
# running app by ios/UITests/NoTwoAxisScrollTests.swift.
#
#   laws/no-two-axis-scroll.sh [dir]     (default: ios/Sources)
dir=${1:-"$(dirname "$0")/../ios/Sources"}
hits=$(grep -rnE 'ScrollView *\( *(axes: *)?\[ *\.(horizontal|vertical) *, *\.(horizontal|vertical) *\]' "$dir" || true)
if [ -z "$hits" ]; then
  echo "  ok    no-two-axis-scroll (iOS)"
  exit 0
fi
echo "  FAIL  no-two-axis-scroll (iOS): a ScrollView scrolls on both axes. Scroll one axis and wrap or truncate the other:"
echo "$hits"
exit 1
