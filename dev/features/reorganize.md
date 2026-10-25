# Reorganize

Updated 2026-10-25 00:34, at 0.1.0.

Move tasks around: reorder siblings, nest or un-nest them, move them to
another branch, and reorder projects and pins.

## Sub-features

- Web drag: hold or drag a row by its bullet; drop on the top quarter of a row
  (before), the middle (into, as first child) or the bottom quarter (after)
- In a gap, the pointer's horizontal position picks the depth
- Web keys: ⌥↑ / ⌥↓ reorder within siblings while editing; Tab / Shift+Tab
- iOS drag with indent steps, and edge scrolling during a drag
- Web: drag Home cards, sidebar projects and pins to reorder them (unverified on iOS)

## How to get to it

- Web: drag a row's bullet; drag a Home card or a sidebar entry.
- iOS: long-press a row's bullet and drag.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- reorganize-drag`: holds Child B's bullet, drags it onto
  the middle of Parent, and checks it lands as Parent's first child.
- `npm run drive -- reorganize-keys`: ⌥↑ moves Child B above Child A,
  Shift+Tab outdents it, and both survive a reload.
- `ios/build.sh drive reorganize` (~60s, simulator): long-presses Three's
  bullet, drags it above One, and checks the order on the Worker.

Last driven 2026-10-06, web; 2026-10-09, iOS: ✓, and ✗ against a build whose
long press didn't pick the row up. Not driven: card, sidebar and pin
reordering; iOS indent steps and edge scrolling.

The iOS drive can't see a drag that loses to the List's scroll: injected
touches skip that arbitration (see the row's `armGesture` in OutlineView.swift), and
that is how a past bug passed in the simulator. Check a change to the drag's
gestures by hand on a phone. `tests/row-gestures.sh` fails if the row's
`armGesture` stops being simultaneous or the bullet's fold tap stops being
high priority.

## Gotchas

- iOS edge scrolling starts only once the finger has been outside the 24pt
  band since the lift, then ramps from 2 to 7 rows a second over a second
  (`EdgeScrollPace` in AnsaCore). A 64pt band with no such rule scrolled a row
  picked up near the bottom all the way to the end before the finger moved.
  Each step costs the main thread about 0.35s (measured on the simulator), so
  the list tops out near 2.7 rows a second and the ramp's top end is not felt.
  (2026-10-19)

- On web, a pointer that moves after pressing a bullet starts a drag at once;
  a press without moving arms only after a hold longer than a click. On touch,
  moving cancels and only the hold arms, because moving means scrolling.
- iOS and the server each work out where a moved or indented row lands, from
  separate Swift and TypeScript code. If they disagree, the row jumps when the
  drift check refetches. Nothing tests that they agree.
