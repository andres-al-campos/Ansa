# Making Ansa hosted and multi-user

The goal: **the cloud instance becomes the real Ansa.** It runs somewhere that's
always up, I use it from my desktop and my phone, and other people could have
accounts without seeing my tree. Local stops being where my data lives and
becomes a development environment.

Five phases, each one landing on its own. The order is chosen so that when
something breaks there's one candidate cause rather than four.

Phases 1 and 1.5 are done: ownership, and Clerk verifying real sessions. The dev
stub still exists but Clerk overrides it wherever it's configured, and the
process refuses to boot with the stub under `NODE_ENV=production`.

Phase 2 is next, and the deploy is the small half of it. The migration of my 59
nodes off `legacy` is the part that deserves the care.

## What already works, and what doesn't

Worth being precise about this, because the obvious framing — "move SQLite to a
real database" — is not where the work is.

**Already done: concurrent editing.** Clients send *operations*, not trees. The
server replays each op against its current tree (`shared/ops.ts`,
`server/src/index.ts`). That is why a human in the browser and a Claude on the
MCP server can edit at the same time without one clobbering the other, and it is
the part of multi-device sync that usually goes wrong. Two phones and a laptop
are the same problem as a phone and an MCP server, which is a problem already
solved.

**Done in phase 1: the single-user assumption.** Rows carry an `ownerId` and
every statement filters on it. `GET /api/tree` returns one owner's rows.

**Done in phase 1: the broadcast.** The SSE bus is keyed by owner, so a write
reaches only that owner's connections. Writes still send the whole tree to those
connections — wasteful at large tree sizes, but no longer a leak, and the cost
now grows with one user's tree rather than with users × tree size.

**Done in phase 1.5: authentication.** Clerk verifies a session JWT and the user
id is its `sub` claim. The header stub still exists for local work, but Clerk
overrides it wherever a secret key is set, so it can't downgrade a deployment.

**Not done: my data lives locally.** `ansa.db` is gitignored, uncommitted, and
holds the only copy of my tree. Under the new goal that file stops being the
real one, which makes the migration in phase 2 the highest-risk step in this
document.

**Unknown: the phone UI.** Hover states and drag-and-drop don't exist on touch.
This is iteration, not architecture, and it's yours.

---

## Phase 1 — Ownership, locally, still on SQLite ✅ DONE

Nothing deployed in this phase. The app kept running on `localhost` against the
same SQLite file. What changed is that rows belong to someone.

Shipped (`6c96659`, `f401637`):

- `ownerId` on the nodes table, with existing rows backfilled to `legacy` so the
  current database survived the migration.
- Every store method takes an `OwnerId` and every statement filters on it
  (`server/src/store.ts`). `shared/tree.ts` stayed oblivious, as intended.
- Per-owner SSE bus (`server/src/bus.ts`): `Map<OwnerId, Set<ServerResponse>>`,
  so a write reaches only that owner's connections.
- A stub `ownerOf()` in `server/src/auth.ts` — the whole contract with auth in
  one function. See phase 1.5; this is not authentication.

**The discipline that mattered:** `shared/tree.ts` is pure functions over an
array of nodes and stays oblivious to ownership. If `roots()` or `descendants()`
took an `ownerId`, every future call site would be a place someone can forget to
pass it. The store hands the tree functions a tree that is already only one
user's nodes. One filter, one place, one thing to get right — because getting it
wrong once is a data leak.

Two bugs this turned up that code review would not have:

- **Cross-owner `parentId`.** Isolation comes from the filtered load, so ops
  naming a stranger's node id no-op — but `addChild`/`addSubtree`/`moveNode`
  accepted a *parent* id from another account and stored a live cross-owner
  reference. Nothing leaked, but the tree failed its own validator and a
  stranger's delete would cascade into it. Fixed with `requireOwnParent` plus
  result validation in `applyOp`.
- **`seedTree()` returned fixed literal ids.** Correct while only one tree could
  exist; the *second* account to sign in got a 500 from a primary-key collision
  on its first request. Every unit test passed — they built trees with generated
  ids and never touched the seed. Found only by end-to-end HTTP testing.

**Verified:** 15 store tests asserting the negative (after B writes, A is
unchanged), each isolation filter sabotage-tested to confirm the tests fail by
name when it's removed; plus an end-to-end HTTP run on a throwaway database
where three accounts seeded with zero id overlap and one account's SSE stream
carried none of another's text.

## Phase 1.5 — Real auth, before anything is publicly reachable ✅ DONE

What's in the tree today is a stub that reads the user id off the `x-ansa-user`
header and trusts it. On localhost that's fine and deliberate: it let ownership
be built and tested end to end before picking a provider, and it fixed the shape
the provider has to fill. On a public URL it means anyone who knows the URL can
read and edit any tree by setting a header.

It's guarded — the routes 401 without `ANSA_DEV_AUTH=1`, and the process refuses
to boot with the stub enabled under `NODE_ENV=production` (`06049a3`). Those
guards are there to make a mistake loud, not to make the stub safe.

**Why this is its own phase, ahead of the deploy.** The plan's rule is one
unfamiliar thing at a time, which argues for deploying first and adding auth
after. That rule loses here: the intermediate state is a publicly reachable URL
serving my real data to anyone. Do auth first, locally, where it's debuggable.

- Wire Clerk (see below) behind the existing `ownerOf()` — that function's
  signature is the entire contract, so this shouldn't reach past `auth.ts` and
  the sign-in UI.
- **No data migration in this phase.** Existing nodes stay owned by `legacy` and
  the local dev stub keeps returning `legacy`, so my tree is untouched by adding
  Clerk. The alternative — `UPDATE nodes SET ownerId = '<clerk id>'` — was
  considered and rejected: it rewrites every row for no benefit, and its failure
  mode is "the tree looks empty", which is the condition that preceded the data
  loss on 2026-08-04.
- The `legacy` → Clerk-id migration instead happens **once, in phase 2**, as the
  import into the hosted instance: sign in to the deployed app as a fresh
  account, then `PUT /api/tree` the local export. Rows are written with the
  right `ownerId` from the start, and the local database is never modified —
  it stays as the backup.
- The SSE route can't send headers; the stub works around that with a `user`
  query param. A real provider uses a cookie, which `EventSource` does send, so
  that workaround goes away rather than being ported.
- Delete the stub in the same commit that replaces it. A dev bypass that
  outlives its purpose is the thing that eventually ships.

**Done when:** signing out makes the tree inaccessible, and two real accounts on
the local server see different trees with no header involved — with my own tree
still readable through the dev stub, unmodified.

### What actually happened

Two of the bullets above were predictions, and both were wrong. Recorded here
rather than edited away, because the reasoning that produced them is still the
reasoning that will produce the next one.

- **The query-param workaround stayed.** It was going to be replaced by a cookie
  `EventSource` sends automatically. Clerk session tokens aren't cookies —
  they're short-lived JWTs fetched per request — so `eventsUrl()` still puts the
  token in the query string. Acceptable because the token expires in about a
  minute, which is the property that makes a URL-borne credential tolerable; a
  long-lived one there would not be.
- **The stub is still in the tree.** "Delete it in the same commit that replaces
  it" was written before the stub had a second job. It's now the only way to
  reach `legacy`, and `legacy` holds my 59 nodes until the phase-2 import. It
  stays until that import is verified, then goes.
- **Clerk wins whenever it's configured** (`auth.ts`), so the stub can't
  downgrade a real deployment even while it exists. That, plus the refusal to
  boot under `NODE_ENV=production`, is what makes keeping it survivable rather
  than merely convenient.
- **Seeding moved off the read path** (`0c0cb6a`). Not planned for this phase; it
  surfaced when a fresh Clerk sign-in visibly replaced the localStorage tree with
  demo projects. `loadOrSeed` was creating 26 rows from a GET, which is precisely
  the "seed-if-empty on a read" that phase 2 warns about — see below. New accounts
  now get one tutorial project from an explicit `POST /api/seed` that refuses a
  non-empty tree.

**Verified**, against a throwaway copy of the database rather than the real one:

- Clerk mode: `/api/tree`, `/api/ops`, `/api/seed` and `/api/events` all 401 with
  no credentials, with a forged bearer token, and with the stub's `x-ansa-user`
  header. `/api/health` stays open, deliberately.
- Two accounts: each seeded to 18 nodes. Alice renaming her own root works (the
  control), and Bob sending `setText` and `removeNode` against Alice's node id —
  named explicitly, not guessed — changes nothing and returns Bob's own tree.
- `legacy` sat at 59 nodes throughout, unmodified.

## Phase 2 — Deploy it, still on SQLite

Railway, with a volume mounted for the database file. Free tier: 1 vCPU,
0.5 GB RAM, 0.5 GB volume, $0/month after the trial converts to the $1/month
band.

0.5 GB of volume is enormous for this data. The live database is ~24 KB.

Why still SQLite: if deployment is the unfamiliar part, doing it while also
changing databases means a failure has two possible causes. Getting the same
code that works locally to work on a URL is its own piece of work — build
config, environment variables, the volume mount, the auth callback URLs pointing
at a real domain instead of localhost.

Also in this phase:

- The frontend needs to build and be served (or hosted separately) rather than
  running under Vite dev. `build.sh` stays a *development* entry point — it
  starts Vite and a local server, and after this phase that's no longer how I
  use Ansa.
- CORS and Private Network Access rules change once the server isn't on
  localhost — see the CORS notes; some of the current workarounds stop being
  needed and others start being.
- The WAL checkpoint timer already added matters more here: 0.5 GB is generous
  but not infinite, and an always-open SSE reader is exactly the condition that
  stops autocheckpoint from truncating.

### What's built, ahead of the account

Decided: the frontend is served by Fastify itself, one Railway service, one
domain. Same origin means CORS stops being a thing to configure rather than a
thing configured correctly — and CORS has already cost this project two separate
debugging sessions. Moving to a CDN later is a config change; the API doesn't
care who serves the HTML.

- `Dockerfile` + `railway.json` (`0171967`). A Dockerfile rather than
  autodetection because `better-sqlite3` is native: it needs python3/make/g++ in
  the image and a pinned Node major, since a silent ABI bump is a crash at
  `require()`.
- Production/dev switches in `server/src/deployment.ts` (`89cf702`), tested at
  both settings. Binds `0.0.0.0` in production — a container's traffic doesn't
  arrive on loopback, so a localhost bind means the health check never connects
  and the deploy fails with a server whose own logs look fine. CORS reflects any
  origin in dev and allows nothing cross-origin in production.
- `scripts/migrate.ts` (`b47fb41`) — export/import/verify. Rehearsed end to end
  between two local instances: 59 nodes out, in under a different owner, verified
  identical. The refusals were tested too, not just the happy path: re-import
  into a populated account is refused, a malformed tree is rejected before any
  write, and `verify` catches a flipped done-state that a node count matches
  straight through.

Unverified: the Docker build itself, since Docker isn't installed on this
machine. The two commands it runs (`npm run build`, `npm run start`) both work.
First `railway up` is where the image gets its real test.

**Railway settings the deploy needs:**

| Where | Name | Value |
| --- | --- | --- |
| Variables | `CLERK_SECRET_KEY` | Clerk dashboard → API keys → Secret key |
| Variables | `VITE_CLERK_PUBLISHABLE_KEY` | Publishable key. Read at *build* time — Vite inlines it, and the build now fails rather than shipping an app with no sign-in gate. |
| Variables | `NODE_ENV` | `production` |
| Variables | `ANSA_DB` | `/data/ansa.db` — must be inside the volume, or the database dies with the container on every deploy |
| Volume | mount path | `/data` |

`PORT` is injected by Railway; don't set it. After the first deploy, add the
Railway domain to Clerk's allowed origins and redirect URLs, or sign-in bounces.

**Migration, once it's up:**

```
# 1. Which account am I? Sign in on the deployed app, read the ownerId panel.
# 2. Grab a session token from devtools (they expire in ~1 min — do this last).
npx tsx scripts/migrate.ts import ~/Desktop/ansa-legacy-2026-08-05.json \
  --url https://<app>.up.railway.app --token <jwt>
npx tsx scripts/migrate.ts verify ~/Desktop/ansa-legacy-2026-08-05.json \
  --url https://<app>.up.railway.app --token <jwt>
```

Import the *plain* export, not the id-remapped one — the remap exists only for
rehearsing locally against a database that already holds those ids.

### Getting my data there — the dangerous part

The volume mounts empty. My tree is in a local, gitignored `ansa.db`. Between
those two facts is the migration, and it deserves more care than the deploy:

- **Settle which Clerk account is "me" before importing.** Clerk's `sub` is per
  *account*, not per person: signing up with Google and then with email-password
  produced two ids locally, and each got its own tree. Importing into one and
  later signing in with the other reads as total data loss.

  Not solved by account linking — those were two genuinely separate accounts,
  with nothing to link. So the check is simply: sign in on the deployed app the
  way you intend to sign in from now on, read the ownerId off the whoami panel,
  and import while signed in as that account. The migration script's refusal to
  write into a non-empty account is the backstop if the wrong one is used.
- **Export from local, import to the deployed instance,** over the API rather
  than by copying the file — `PUT /api/tree` already takes a whole tree and
  validates it, and it writes rows under whatever account is signed in, which is
  exactly the `legacy` → Clerk-id remap happening as a side effect of the
  import. Copying `ansa.db` onto the volume would skip that and leave the rows
  owned by `legacy`, so prefer the API.
- **Node ids are globally unique, not per-owner** (`id TEXT PRIMARY KEY`). On the
  cloud instance this is invisible — the volume mounts empty, so nothing
  collides. It bites in the local dry run: importing `legacy`'s export into a
  second account on the *same* database fails with
  `SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed: nodes.id`, because
  those ids are already there under `legacy`. Rehearse with an id-remapped copy
  of the export; import the plain one into the cloud. Verified 2026-08-05: the
  plain export 500s locally, the remapped one round-trips to 59/59 with the tree
  structure intact.

  New ids are UUIDs as of `5d7659b`, which chasing that collision turned up.
  `newId()` had been a timestamp plus a module-level counter, so two clients
  minting in the same millisecond both started at 1 and produced identical ids —
  a tab and the MCP server were enough, and the losing write fails on the primary
  key. That mattered before the deploy because phase 2 is the first time two
  clients are routinely live at once. The 59 rows in the export keep their old
  short ids; nothing parses them, they only have to stay distinct.
- **Keep the local file untouched** until the hosted copy is verified by node
  count and by reading the tree back. Local becomes the backup during the
  transition, which is the one job it's still good for.
- **The deployed server should not have a seed-if-empty path.** An empty tree
  for a new account is correct behaviour; "the database looks empty, write the
  demo tree" is how 30 nodes were lost on 2026-08-04 — a migration made rows
  temporarily invisible and the seed check read that as a fresh install. On a
  hosted instance the same pair would be worse: no local file to carve rows back
  out of. Seed on explicit account creation, never on a read finding nothing.

  Done in phase 1.5 (`0c0cb6a`), ahead of schedule and not by choice — the path
  existed and was firing. Reads are now inert: `POST /api/seed` is the only way
  rows get created from nothing, and it refuses an owner who already has any.
  That guard is what makes an interrupted import safe to retry, which matters
  more here than the tutorial does.

**Done when:** I can open Ansa on my phone, over cellular, and edit a task that
shows up on my desktop — and my whole tree is there, counted against the local
copy at migration time, not assumed.

## Phase 3 — Postgres on Neon

Only once phase 2 is stable and boring.

Neon separates storage from compute, scales to zero when idle, and has a 0.5 GB
free tier. The reason to move: a Railway volume is one disk on one machine, and
if it goes, the data goes. Neon has real backups and branching.

This matters more under the "cloud is the real one" goal than it did before.
While local was the primary copy, a lost volume was an inconvenience. Once the
hosted instance holds the only current data, one disk on one machine with no
backups is the whole risk, and phase 2 should not sit in that state for long.

The migration is mostly mechanical — `better-sqlite3`'s synchronous API becomes
async, and the SQL dialect shifts slightly. The op-replay logic doesn't change,
because it operates on trees and ops rather than on rows.

**Done when:** the Railway volume can be deleted and nothing is lost — verified
by restoring from a Neon backup, not by trusting that backups exist.

## Phase 4 — Phone UI

Still last, because it's the part with no clear finish line and it shouldn't
block the parts that do. Hover-only affordances need touch equivalents, and
drag-to-reorder needs rethinking rather than porting.

One change from the original framing: with the hosted instance as the real
Ansa, the phone is a primary client rather than a bonus. Phase 2 is "done" when
the phone *works*, which is a lower bar than the phone being *good* — expect
this phase to be where most of the remaining time goes, and don't read its
position in the list as a measure of its size.

---

## Auth: Clerk, or not

You asked specifically about Clerk. Short answer: it's a good default, and there
is one real alternative worth knowing about before you commit.

Note on dates — my training cutoff is before now, so I verified this rather than
recalling it.

**Clerk.** [Free up to 50,000 monthly retained users](https://clerk.com/pricing);
Pro is $25/month past that. The free tier was
[raised from 10,000 to 50,000 in February 2026](https://saasprices.net/blog/clerk-free-plan-changes).
Worth knowing that Clerk bills *monthly retained* users, not monthly active — it
excludes people who sign up and never return, so it's a narrower unit than what
Auth0 and Supabase meter and a cost estimate built on MAU intuition will come out
[too high](https://dev.to/thiago_alvarez_a7561753aa/clerk-vs-better-auth-2026-we-verified-every-price-so-you-dont-have-to-13pk).

For Ansa this means auth is free, permanently, at any plausible scale. You get
drop-in sign-in components and you never store a password.

**Better Auth.** Open source, MIT, self-hosted — users live in your own
database, and it's
[framework-agnostic with no vendor lock-in](https://makerkit.dev/blog/tutorials/better-auth-vs-clerk).
The trade is that you own the operational surface: sessions, resets, and the
consequences of getting any of it wrong.

**The recommendation:** Clerk. The thing you don't want to be doing in this
project is running an auth system, and at Ansa's scale Clerk costs nothing.
Its one genuine drawback is that user data sits on Clerk's servers in the US
with
[no EU residency option](https://makerkit.dev/blog/tutorials/better-auth-vs-clerk) —
which matters if this ever has European users and doesn't otherwise.

The switching cost is low either way, and that contract now exists in code:
`ownerOf(req): OwnerId | null` in `server/src/auth.ts` — *give me a stable user
id for this request, or null.* Everything downstream (the store's `ownerId`, the
SSE bus's key) depends only on that string. Keeping it this narrow is what makes
the provider a swappable detail rather than a rewrite, so resist widening it
when Clerk lands.
