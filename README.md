# Ansa

A Workflowy-style outliner for breaking tasks down until the leaves are small
enough to actually do. *Ansa* is Latin for the handle of a thing.

## Architecture

Three processes, one source of truth:

```
React app  ─┐  writes (REST)                    ┌─ browser (WebSocket) — live
            ├──────────────▶ server ── broadcast ┤
MCP server ─┘                (SQLite)            └─ any other tab
(a Claude)
```

The same shape runs in two places. Locally the server is Fastify over a SQLite
file; deployed it's a Cloudflare Worker over one Durable Object per account.
The client can't tell them apart — same REST routes, same broadcast.

- **`src/`** — the React app. Reads and writes over REST; subscribes to changes
  over a WebSocket, so an edit from anywhere shows up without a reload. Writes
  go over HTTP rather than the socket, deliberately: the handshake is the only
  place a token is checked, so anything accepted on an open socket would skip
  authentication.
- **`server/`** — Fastify + SQLite (`ansa.db`), for local development.
- **`worker/`** — the deployed API: a Cloudflare Worker, with an `AnsaTree`
  Durable Object per account holding that account's tree in its own SQLite.
  Clerk verifies the token, and the verified user id picks the object — so the
  identity that addresses your data comes from Clerk, not from a request field.
- **`mcp/`** — an MCP server that lets another Claude do everything a human can:
  view the outline and add / rename / check / move / fold / delete tasks — and
  build a whole nested tree in one call. It is just another client of the same
  REST API, so a Claude and a person editing at once share one state and can't
  diverge.
- **`shared/`** — the tree model and pure operations (`tree.ts`) plus the seed,
  used identically by all three.

## Running it

```bash
./build.sh
```

Installs dependencies if they're missing, starts the server and the app, waits
for each to answer before moving on, and opens the browser. Ctrl-C stops both.
Set `ANSA_NO_OPEN=1` to skip opening the browser.

To run the two processes yourself instead — separate terminals, server first, so
the app's first SSE connect finds it up:

```bash
npm install
npm run server   # http://127.0.0.1:4000
npm run dev      # http://localhost:5173
```

The first run seeds the database. The app opens from a localStorage cache for an
instant first paint, then adopts the server's tree the moment SSE connects.

`npm test` runs the suite. `npm run build` type-checks and builds the app into
`dist/`.

## Deploying

```bash
./build.sh deploy
```

Runs the tests, then ships the Worker and the app, checking each live URL before
moving on. `./build.sh deploy api` or `deploy app` when only one changed.

The API goes first on purpose. If it fails, the old app is still talking to the
old API — whereas shipping the app first can leave a new client calling an API
that never updated.

Cloudflare does **not** build this project: the Pages project has no git
integration, so `wrangler` uploads a bundle built here. Environment variables
set in the Pages dashboard never run, and every `VITE_*` has to be present at
build time locally. A missing one produces a bundle that builds and uploads
cleanly and then can't sign anyone in, which is why `build.sh` greps the built
bundle for the values it needs and refuses to deploy without them.

### Secrets

| | Where it lives | Public? |
|---|---|---|
| `CLERK_SECRET_KEY` | Worker secret store, and Keychain `ansa-clerk-secret` for local | No |
| Publishable key (`pk_test_…`) | `build.sh`, and Keychain `ansa-clerk-publishable` | Yes — ships in the bundle |

The publishable key identifies the Clerk instance and authorises nothing, so
it's committed. The secret key is in neither the repo nor any file here.

**If the Worker loses its secret** — deleted and recreated, or a fresh
Cloudflare account — nothing in this repo restores it. `./build.sh deploy` will
fail its API check, because `/api/health` reports `auth: "dev"` or `"none"`
instead of `"clerk"`. Fix it with:

```bash
npx wrangler secret put CLERK_SECRET_KEY
```

It prompts for the value, so it stays out of shell history. The value is in the
Keychain as `ansa-clerk-secret`, or in the Clerk dashboard under API keys.

Clerk is on **test** keys, deliberately. The instance (`rapid-bee-20`) is what
addresses the data: a different instance mints different user ids, which address
different Durable Objects. Switching to production keys is a data migration, not
a config change.

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
`add_subtree`, `rename_task`, `set_done`, `move_task`, `toggle_collapsed`,
`remove_task`, `progress`.

`add_subtree` is the one creation tool: hand it a nested `{ text, children? }`
outline and it creates the whole thing — parents, children, grandchildren — in
a single call. A single task is just one node with no children. Pass a
`parentId` to graft under an existing task; omit it to start a new project (one
top-level node, the rest under its children).
