# Reorganize

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

Last driven 2026-10-06, web. Not driven: card, sidebar and pin reordering;
iOS.

## Gotchas

- On web, a pointer that moves after pressing a bullet starts a drag at once;
  a press without moving arms only after a hold longer than a click. On touch,
  moving cancels and only the hold arms, because moving means scrolling.
- iOS and the server each work out where a moved or indented row lands, from
  separate Swift and TypeScript code. If they disagree, the row jumps when the
  drift check refetches. Nothing tests that they agree.
