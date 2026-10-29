# Pin

Updated 2026-10-28 23:39, at 0.1.0.

Keep the projects and tasks you're working on one tap away.

## Sub-features

- Pin a project or a task at any depth; both show on one shelf
- The shelf is arranged by hand; never-arranged pins sort after arranged ones
- A pinned project shows only under Pinned, not also under Projects

## How to get to it

- Web: a sidebar project's ⋯ menu → Pin; the pin button in a zoomed-in
  header; Unpin on the shelf row.
- iOS: the ⋯ menu on a zoomed-in scope → Pin / Unpin; a left swipe on a
  shelf row unpins it.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- pin`: zooms into Child A, pins it, and checks it shows in
  the sidebar.
- `ios/build.sh drive pin` (~60s, simulator): zooms into a task with a full
  right swipe, pins it from the ⋯ menu, finds it on Home's shelf, opens it from
  there and unpins it, then pins it again and unpins it with a left swipe on
  the shelf. Each step is read on screen and on the Worker.

Last driven 2026-10-06, web; 2026-10-28, iOS: ✓, and ✗ against a build whose
Pin did nothing and one whose shelf showed nothing. Not driven: shelf
ordering, pinning a project on iOS.

## Calls

- 2026-10-28 23:39, 0.1.0. Home's rows swipe left like the outline's: a pin unpins, and a project
  deletes, asking first. A pinned project unpins rather than deletes. Nothing
  goes right, since Home is the top. Applies none.

## Gotchas

- The Claude tools (MCP) can't pin or unpin.
