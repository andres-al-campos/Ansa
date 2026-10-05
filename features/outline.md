# Outline a project

Write a project's tasks and break them down until the leaves are small enough
to do. Projects are the top-level rows; everything else nests under them.

## Sub-features

- New project from Home (web sidebar or Home grid, iOS + on Home); naming an
  empty project and pressing Enter flows straight into its first task
- Web keys while editing a row:
  - Enter: commit and open a new sibling; on an empty row, delete it
  - Shift+Enter: commit and stop adding
  - Tab / Shift+Tab: indent / outdent
  - Up / Down: move editing to the row above / below
  - ⌘/Ctrl+Backspace: delete the task and its subtree, step up a row
  - Backspace on an empty row: delete it and leave edit mode
  - ⌘/Ctrl+D: toggle done without leaving the row
  - Escape: cancel the edit
- Web: Enter with nothing focused adds a task to the current scope
- Web undo/redo: ⌘/Ctrl+Z, ⇧⌘Z or Ctrl+Y, when no field is focused
- iOS: the row is the input; an adding mode where Return asks for another row
- Limits: 200 characters per task, 5000 nodes per account

## How to get to it

- Web: open a project from the sidebar or the Home grid, click a row to edit.
- iOS: tap a project on Home, tap a row to rename, + to add.

## Driving it

Preconditions: `./build.sh web --no-auth` running (see the README).

1. Open http://localhost:5173, click + New project, type a name, press Enter.
2. Type a task, Enter, type another, Tab to nest it.
3. Expected: the second task shows indented under the first, and survives a
   reload (the server has it, not only the browser).

Last driven 2026-10-04: nesting and reload passed, and the reload reopened the
project. It also showed the first gotcha below.

## Gotchas

- Undo is web only and covers your own edits. An edit from another device or a
  Claude replaces the tree without a checkpoint, so ⌘Z doesn't undo it. iOS has
  no undo.
- A new row is a real node from the moment it appears; leaving it empty
  deletes it. Those deletes skip the trash on purpose.
- The leaf-only view still exists in the web code with no toggle; Tab is
  disabled in it. See [Get around](get-around.md).
