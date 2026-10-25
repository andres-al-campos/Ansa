# Trash

Updated 2026-10-25 00:34, at 0.1.0.

Deleted tasks wait 30 days in the trash, where they can be put back.

## Sub-features

- Restore puts a subtree back under its old parent, or as a project if that
  parent is gone too
- Delete for good, now. On iOS a centred alert asks first, with Cancel
- Shows days left; a daily sweep empties entries older than 30 days
- Paged list, loaded only when opened

## How to get to it

- Web: Trash in the sidebar. Delete with ⌘/Ctrl+Backspace on a row, or a
  project's two-step delete (trash icon, then ✓).
- iOS: swipe a row left to delete; Trash row on Home. In Trash the rows swipe
  like a project's: left deletes for good (it asks first), right restores.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- trash`: deletes Child B with ⌘/Ctrl+Backspace, opens
  Trash, restores it, and checks it is back under Parent and gone from Trash.
- `ios/build.sh drive trash` (~70s, simulator): by thumb, a full left
  swipe deletes the task; in Trash, a left swipe asks and Cancel leaves the row in
  place, a right swipe from the screen's edge goes Back without restoring, and a
  right swipe restores. Each step is read on screen and on the Worker.

Every drive also ends with Trash's Delete, which removes its project for good.

Last driven 2026-10-06, web; 2026-10-09, iOS: ✓, and ✗ against builds whose
swipe didn't delete, whose Restore never reached the Worker, whose Trash rows
ignored the back swipe, whose delete swipe rode out before asking, and whose
delete asked in a dialog at the row rather than an alert. Not
driven: paging, iOS Delete for good.

The daily sweep has no drive, since it runs on a 24-hour alarm. The Worker's
tests cover it (`worker/src/ansaTree.test.ts`): the first delete arms it and
later ones don't push it out, it drops what is past 30 days, keeps what is
younger, and stops waking once the trash is empty.

## Gotchas

- Trash rows use the outline's own swipe (`RowSwipeView`), not
  `swipeActions`. A UI test's tap on a `swipeActions` button never ran its
  action, and its leading edge raced the back swipe.
- A right swipe that starts in the screen's left 64pt is Back, on Trash rows
  as on project rows (`backClaim`).
- The row swipe is hand-built, so its actions are also offered to VoiceOver
  by name (Delete and Zoom in on a task, Delete and Restore in Trash). No
  check covers this: XCUITest can't run a named action.

- Only deliberate deletes go to the trash. Emptying a row or merging rows with
  Backspace removes without trashing, on purpose.
- A restored project lands after the last project, not at its old position.
