# Ansa

A Workflowy-style outliner for breaking tasks down until the leaves are small
enough to actually do. *Ansa* is Latin for the handle of a thing.

## Architecture

Several clients, one source of truth:

```
React app  ─┐  writes (REST)                     ┌─ browser (WebSocket) — live
iOS app     ├──────────────▶ Worker ── broadcast ┤
MCP server ─┘             (Durable Object)       └─ any other client
(a Claude)
```

The API is a Cloudflare Worker over one Durable Object per account, deployed and
locally alike — `wrangler dev` runs the same code.

- **`src/`** — the React app. Reads and writes over REST; subscribes to changes
  over a WebSocket, so an edit from anywhere shows up without a reload. Writes
  go over HTTP rather than the socket, deliberately: the handshake is the only
  place a token is checked, so anything accepted on an open socket would skip
  authentication.
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
  used identically by every TypeScript client.
- **`desktop/`** — an Electron window around the same web build, talking to
  the live Worker. `build.sh` builds the bundle and hands it over; nothing in
  here has logic of its own.
- **`ios/`** — a SwiftUI app for the same tree, with its own `./build.sh` that
  builds, installs and launches on a connected iPhone. `AnsaCore` is the tree
  model and `AnsaSync` the client, both plain Swift packages testable without a
  device. The tree model is written twice, in Swift and TypeScript, so
  `ios/AnsaCore/Tools/check-wire.sh` checks the server can read the ops Swift
  sends and `check-agreement.sh` checks both sides' ops make the same tree.

## Running it

```bash
./build.sh
```

Packages the desktop app, installs it to `/Applications/_vibe_coded` replacing
the previous copy, and launches it. It talks to the live Worker, so this is the
everyday way to run Ansa. `./build.sh desktop` is the same thing as a
hot-reload dev window instead of a packaged app.

```bash
./build.sh web
```

Runs the web stack locally: installs dependencies if they're missing, starts
the API and the Vite app, waits for each to answer, and opens the browser.
Ctrl-C stops both. Set `ANSA_NO_OPEN=1` to skip opening the browser.

The API is the Worker itself, under `wrangler dev` on port 8787 with real
Durable Objects against throwaway local storage — the same code the deploy
ships. Cold start is around 20s.

The app opens from a localStorage cache for an instant first paint, then adopts
the server's tree once the live connection is established.

Locally the app skips the sign-in gate — the Worker runs its dev auth stub
(`build.sh` passes it `ANSA_DEV_AUTH=1`) and leaves the Clerk publishable
key unset. If `CLERK_SECRET_KEY` is set in your shell or the Keychain, the key
gets set too and you'll be asked to sign in; `./build.sh web --no-auth` skips
both.

`./build.sh check` checks everything that doesn't need a person: the
typecheck, the TypeScript and Swift suites, the Swift-to-server wire and agreement checks, and
`npm run drive`, which works the web app and the MCP in a headless browser. It
uses a `./build.sh web --no-auth` you already have running, or starts one and
stops it when done. `npm test` runs just the TypeScript suite. Before each
push, `.githooks/pre-push` runs `npm test`, plus the Swift/TypeScript agreement
check when the push changes an op; `./build.sh` turns the hook on. `npm run build`
type-checks and builds the app into `dist/`.

## Deploying

```bash
./build.sh deploy
```

Runs the tests, then ships the Worker and the app, checking each live URL before
moving on. `./build.sh deploy api` or `deploy app` when only one changed.

The API goes first on purpose. If it fails, the old app is still talking to the
old API — whereas shipping the app first can leave a new client calling an API
that never updated.

[HOSTING.md](HOSTING.md) is the plan behind the hosted setup: what each phase
was for, which are done, and what the remaining ones still need.

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

The MCP talks to an API over HTTP, set with `ANSA_API`. It defaults to the
deployed worker, so with a token set (below) it edits your real tree with no
further configuration. Point it at `http://127.0.0.1:8787` for `./build.sh web`. Tools: `view_tree`,
`add_subtree`, `rename_task`, `set_done`, `move_task`, `toggle_collapsed`,
`remove_task`, `progress`.

`add_subtree` is the one creation tool: hand it a nested `{ text, children? }`
outline and it creates the whole thing — parents, children, grandchildren — in
a single call. A single task is just one node with no children. Pass a
`parentId` to graft under an existing task; omit it to start a new project (one
top-level node, the rest under its children).

### Giving it access to your real tree

A stdio MCP server has no browser, so it cannot sign in to Clerk. Instead the
worker holds the hash of one long-lived bearer token and the user id it stands
for, and accepts that token as a third credential alongside a Clerk session.

Generate a token and register its hash — the token itself never leaves your
machine, and the worker only ever sees the digest:

```bash
export ANSA_TOKEN="$(openssl rand -hex 32)"
printf %s "$ANSA_TOKEN" | shasum -a 256 | cut -d' ' -f1 | npx wrangler secret put ANSA_MCP_TOKEN_SHA256
```

Then tell the worker which account it acts as. This is your Clerk user id — the
`user_xxx` string on your account in the Clerk dashboard under Users — and it is
the same id a browser session resolves to, which is what makes the MCP server
reach the tree you already have rather than an empty one of its own. It goes in
the `vars` block of `wrangler.jsonc`, not the secret store: a user id
authenticates nothing on its own, and having it visible is what makes a
misconfigured deployment obvious rather than mysterious.

```jsonc
"vars": {
  "ANSA_MCP_USER": "user_xxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

Then keep the token where the MCP server can find it. It reads `ANSA_TOKEN`
from the environment first, and falls back to the macOS Keychain — which is
where it belongs on this machine, since an MCP client config is a file and this
repo keeps secrets out of files:

```bash
security add-generic-password -a "$USER" -s ansa-mcp-token -w
```

It prompts for the value, so the token stays out of shell history. Nothing else
to configure: the MCP client launches the server, and the server finds it.

The environment still wins where a Keychain doesn't exist — CI, a container, a
Linux box — so those pass `ANSA_TOKEN` the ordinary way.

Three properties worth knowing, each with a test in `worker/src/auth.test.ts`:

- **Header only.** The token is never read from a query string, unlike the
  short-lived Clerk token a WebSocket handshake passes there. A lasting
  credential in a URL ends up in access logs and history.
- **Both halves or nothing.** A hash without a user id, or a user id without a
  hash, authenticates no one.
- **Clerk must be configured.** The token cannot be what makes an otherwise
  unauthenticated worker answer, so a deployment that loses its Clerk key fails
  loudly for every client instead of quietly serving only this one.

To rotate, re-run the `openssl rand` command above. The old token stops working
the moment the new hash lands.
