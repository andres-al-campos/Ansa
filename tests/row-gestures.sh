#!/usr/bin/env bash
# Law: the outline row's two gestures keep the priorities OutlineView.swift's
# comments give them.
#
#   - The row arms a drag with .simultaneousGesture(armGesture). Not
#     .highPriorityGesture: the label is a Button covering most of the row, and
#     taking the touch stops it firing (the code comment). Not .gesture: a
#     parent's plain gesture yields to its children's, so a hold on the label
#     Button would likely never arm. That half is SwiftUI's general rule, not
#     checked here.
#   - The bullet's fold tap is .highPriorityGesture(bulletGesture). A plain
#     .gesture lost the touch to the List's scroll when the drag lived on the
#     bullet; that the tap alone still needs it is the code comment's word,
#     not checked on a device.
#
#   - Lists are held still during a back swipe, a row's swipe and a reorder
#     drag by one .scrollDisabled on the page in OutlineView.swift. Home's list
#     once lacked its own copy and scrolled while the page slid away. A screen
#     that needs to stop scrolling for another reason adds its condition there.
#
# Source text, because nothing else can see it: XCUITest's injected touches
# skip the List's scroll arbitration, so the UI tests pass with the wrong
# priority and the bug shows only on a device (dev/features/reorganize.md).
#
#   tests/row-gestures.sh
cd "$(dirname "$0")/.." || exit 1
file=ios/Sources/OutlineView.swift
problems=()

if ! grep -qE '\.simultaneousGesture\( *armGesture *\)' "$file"; then
  problems+=("The row no longer arms its drag with .simultaneousGesture(armGesture).
        As .highPriorityGesture it stops the row's label Button firing (OutlineView's comment); as .gesture it likely yields to that Button and never arms (unverified).
        Attach it as .simultaneousGesture(armGesture). The UI tests can't see this; check a deliberate change by hand on a phone.")
fi
if ! grep -qE '\.highPriorityGesture\( *bulletGesture *\)' "$file"; then
  problems+=("The bullet's fold tap is no longer .highPriorityGesture(bulletGesture).
        The code comment says a plain gesture loses the touch to the List's scroll; that is unverified on a device for the tap alone.
        Attach it as .highPriorityGesture(bulletGesture), or check the change by hand on a phone and update this law.")
fi

holds=$(grep -rn '\.scrollDisabled(' ios/Sources | grep -v '^[^:]*:[0-9]*: *//')
if [ "$(printf '%s\n' "$holds" | grep -c .)" -ne 1 ] || ! printf '%s' "$holds" | grep -q "^$file:.*backPull > 0"; then
  problems+=("Lists must be held still by exactly one .scrollDisabled, on the page in $file, and it must include backPull > 0. Found:
$(printf '%s\n' "${holds:-        none}" | sed 's/^/          /')
        Fold any other into the page's condition; a per-list copy is one a new screen forgets.")
fi
if [ ${#problems[@]} -eq 0 ]; then
  echo "  ok    row-gestures (iOS)"
  exit 0
fi
echo "  FAIL  row-gestures (iOS): $file"
for p in "${problems[@]}"; do echo "        $p"; done
grep -nE '[gG]esture\( *(armGesture|bulletGesture) *\)' "$file" | sed 's/^/        /'
exit 1
