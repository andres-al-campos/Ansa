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

Preconditions: `./build.sh web --no-auth` running.

`npm run drive -- mcp` launches the MCP server over stdio with
`ANSA_API=http://127.0.0.1:8787`, checks `view_tree` lists a
project the browser just made, then calls `rename_task` and checks the browser
shows the new name without a reload.

Last driven 2026-10-06. Not driven: the other tools.

## Gotchas

- `remove_task` sends to the trash, like a delete in the app.
- No tools for pins or the trash.
- Every MCP write reaches other clients as a whole tree rather than a single
  change.
