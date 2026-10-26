# Outline a project

Updated 2026-10-25 20:38, at 0.1.0.

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

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- outline`: makes a project, types Parent, nests Child A and
  Child B under it with Tab, and checks the nesting survives a reload.
- `ios/build.sh drive outline` (~60s, simulator): makes a project from Home's +,
  names it, types Parent, then Child A with Indent and Child B, and checks that
  shape on the Worker.

Last driven 2026-10-06 by the script; by hand 2026-10-04, which also showed the
first gotcha below. iOS 2026-10-09: ✓, and ✗ against a build whose Indent did
nothing.

## Gotchas

- Undo is web only and covers your own edits. An edit from another device or a
  Claude replaces the tree without a checkpoint, so ⌘Z doesn't undo it. iOS has
  no undo.
- A new row is a real node from the moment it appears; leaving it empty
  deletes it. Those deletes skip the trash on purpose.
- The leaf-only view still exists in the web code with no toggle; Tab is
  disabled in it. See [Get around](get-around.md).
- On iOS, keys typed within about 100ms of Return are lost or land in the row
  just left: the new row's field takes focus a beat after Return. XCUITest on
  the on-screen keyboard types that fast; a person doesn't, and a hardware
  keyboard queues its keys. So drives end a `typeText` at each Return rather
  than typing past it. Closing the gap would take one field that stays focused
  across rows.
