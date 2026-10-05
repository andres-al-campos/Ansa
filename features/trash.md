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

Preconditions: `./build.sh web` running, a project with a task.

1. Delete the task with ⌘/Ctrl+Backspace, open Trash, click restore.
2. Expected: the task is back in place and the entry is gone.

## Gotchas

- Only deliberate deletes go to the trash. Emptying a row or merging rows with
  Backspace removes without trashing, on purpose.
- Deletes made by a Claude through the MCP skip the trash and can't be
  restored.
- The project delete's confirm button is titled "Delete for good", but it goes
  to the trash.
- A restored project lands after the last project, not at its old position.
