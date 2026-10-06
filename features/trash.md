# Trash

Deleted tasks wait 30 days in the trash, where they can be put back.

## Sub-features

- Restore puts a subtree back under its old parent, or as a project if that
  parent is gone too
- Delete for good, now
- Shows days left; a daily sweep empties entries older than 30 days
- Paged list, loaded only when opened

## How to get to it

- Web: Trash in the sidebar. Delete with ⌘/Ctrl+Backspace on a row, or a
  project's two-step delete (trash icon, then ✓).
- iOS: swipe a row left to delete; Trash row on Home.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

`npm run drive -- trash` deletes Child B with ⌘/Ctrl+Backspace, opens
Trash, restores it, and checks it is back under Parent and gone from Trash.
Every drive also ends with Trash's Delete, which removes its project for good.

Last driven 2026-10-06, web. Not driven: the daily sweep, paging, iOS.

## Gotchas

- Only deliberate deletes go to the trash. Emptying a row or merging rows with
  Backspace removes without trashing, on purpose.
- The project delete's confirm button is titled "Delete for good", but it goes
  to the trash.
- A restored project lands after the last project, not at its old position.
