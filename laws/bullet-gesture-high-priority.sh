#!/usr/bin/env bash
# Law: the iOS bullet's gesture is attached with .highPriorityGesture. A plain
# .gesture loses the touch to the List's scroll under a real finger, so the
# bullet scrolls the page instead (see the comment where OutlineView.swift
# attaches bulletGesture).
#
# Source text, because nothing else can see it: XCUITest's injected touches
# skip the List's scroll arbitration, so the reorganize and get-around UI tests
# pass with .gesture too and the bug shows only on a device
# (features/reorganize.md).
#
#   laws/bullet-gesture-high-priority.sh
cd "$(dirname "$0")/.." || exit 1
file=ios/Sources/OutlineView.swift
if grep -qE '\.highPriorityGesture\( *bulletGesture *\)' "$file"; then
  echo "  ok    bullet-gesture-high-priority (iOS)"
  exit 0
fi
echo "  FAIL  bullet-gesture-high-priority (iOS): $file no longer attaches bulletGesture with .highPriorityGesture."
echo "        A plain .gesture loses to the List's scroll on a phone, and the UI tests can't see it."
echo "        Attach it as .highPriorityGesture(bulletGesture), or if the change is deliberate, check it by hand on a phone and update this law."
grep -niE 'gesture\( *bulletGesture' "$file" | sed 's/^/        /'
exit 1
