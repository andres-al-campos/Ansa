# Pin

Keep the projects and tasks you're working on one tap away.

## Sub-features

- Pin a project or a task at any depth; both show on one shelf
- The shelf is arranged by hand; never-arranged pins sort after arranged ones
- A pinned project shows only under Pinned, not also under Projects

## How to get to it

- Web: a sidebar project's ⋯ menu → Pin; the pin button in a zoomed-in
  header; Unpin on the shelf row.
- iOS: the ⋯ menu on a zoomed-in scope → Pin / Unpin.

## Driving it

Preconditions: `./build.sh web --no-auth` running, a project with a task.

1. Zoom into the task, click its pin button.
2. Expected: it appears under Pinned in the sidebar, with its trail.

## Gotchas

- The Claude tools (MCP) can't pin or unpin.
