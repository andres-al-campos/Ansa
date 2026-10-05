# Let a Claude work on it

A Claude reads and edits the same tree through an MCP server, live alongside
the person.

## Sub-features

- `view_tree`: the outline as indented text
- `add_subtree`: build a whole nested tree in one call
- `rename_task`, `set_done`, `move_task`, `toggle_collapsed`, `remove_task`
- `progress`: done counts

## How to get to it

- Register `mcp/src/index.ts` as a stdio MCP server. It reaches the live
  Worker by default and authenticates with `ANSA_TOKEN` or a token in the
  Keychain.

## Driving it

Preconditions: `./build.sh web` running.

1. Run the MCP server with `ANSA_API=http://127.0.0.1:8787` and no token, so
   the dev stub treats it as `legacy`, the same user as the local web app.
2. Call `rename_task` on a visible task.
3. Expected: the browser shows the new name without a reload.

Unverified: whether a token in the Keychain gets in the way locally.

## Gotchas

- `remove_task` deletes for good; it doesn't use the trash.
- No tools for pins or the trash.
- Every MCP write reaches other clients as a whole tree rather than a single
  change.
