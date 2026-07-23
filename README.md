# Ansa

A Workflowy-style outliner for breaking tasks down until the leaves are small
enough to actually do. *Ansa* is Latin for the handle of a thing.

## Architecture

Three processes, one source of truth:

```
React app  ─┐  writes (REST)                    ┌─ browser (SSE) — updates live
            ├──────────────▶ server ── broadcast ┤
MCP server ─┘                (SQLite)            └─ any other tab
(a Claude)
```

- **`src/`** — the React app. Reads and writes over REST; subscribes to changes
  over Server-Sent Events, so an edit from anywhere shows up without a reload.
- **`server/`** — Fastify + SQLite (`ansa.db`). The one process that owns the
  database and is the single write path. Broadcasts every change over SSE.
- **`mcp/`** — an MCP server that lets another Claude do everything a human can:
  view the outline and add / rename / check / move / fold / delete tasks. It is
  just another client of the same REST API, so a Claude and a person editing at
  once share one state and can't diverge.
- **`shared/`** — the tree model and pure operations (`tree.ts`) plus the seed,
  used identically by all three.

## Running it

```bash
npm install
npm run server   # http://127.0.0.1:4000 — start this first
npm run dev      # http://localhost:5173 — the app
```

The first run seeds the database. The app opens from a localStorage cache for an
instant first paint, then adopts the server's tree the moment SSE connects.

## The MCP server

Point an MCP client at it with a stdio command:

```json
{
  "mcpServers": {
    "ansa": {
      "command": "npx",
      "args": ["tsx", "mcp/src/index.ts"],
      "cwd": "/absolute/path/to/Ansa"
    }
  }
}
```

The server must be running (`npm run server`) — the MCP talks to it over HTTP,
set with `ANSA_API` (default `http://127.0.0.1:4000`). Tools: `view_tree`,
`add_task`, `rename_task`, `set_done`, `move_task`, `toggle_collapsed`,
`remove_task`, `progress`.
