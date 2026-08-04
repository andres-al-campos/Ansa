# Making Ansa hosted and multi-user

The goal: Ansa runs somewhere that's always up, I use it from my desktop and my
phone, and other people could have accounts without seeing my tree.

Four phases, each one landing on its own. The order is chosen so that when
something breaks there's one candidate cause rather than four.

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

**Not done: the single-user assumption.** It's not in one place. `roots(tree)`
means "every project in the database" — there is nothing else in there.
`GET /api/tree` returns the whole table. There is no `owner_id` on anything.

**Not done: the broadcast.** Every write sends the *entire tree* to every
connected client over SSE (`emit`), and clients replace their state wholesale.
With one user that's merely wasteful. With N users it's a data leak — everyone
receives everyone's tree — and the cost grows with the product of users and tree
size.

**Unknown: the phone UI.** Hover states and drag-and-drop don't exist on touch.
This is iteration, not architecture, and it's yours.

---

## Phase 1 — Ownership, locally, still on SQLite

Nothing deploys in this phase. The app keeps running on `localhost` against the
same SQLite file. What changes is that rows belong to someone.

- Add `owner_id` to the nodes table. Backfill every existing row to my own id so
  the current database survives the migration.
- Add auth (see below) and put the signed-in user's id on the request.
- Filter by `owner_id` **at the database boundary** — in `server/src/store.ts`,
  in the SQL. Not in the tree functions.
- Scope the SSE broadcast per owner: a write emits only to that owner's
  connections.

**The discipline that matters here:** `shared/tree.ts` is pure functions over an
array of nodes and should stay oblivious to ownership. If `roots()` or
`descendants()` start taking an `ownerId`, then every future call site is a place
someone can forget to pass it. The store hands the tree functions a tree that is
already only one user's nodes. One filter, one place, one thing to get right —
because getting it wrong once is a data leak.

**Done when:** two accounts on the same local server can't see each other's
trees, and neither one's SSE stream carries the other's nodes. Test that
directly, with two sessions — not by reading the code and concluding it looks
right.

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
  running under Vite dev.
- CORS and Private Network Access rules change once the server isn't on
  localhost — see the CORS notes; some of the current workarounds stop being
  needed and others start being.
- The WAL checkpoint timer already added matters more here: 0.5 GB is generous
  but not infinite, and an always-open SSE reader is exactly the condition that
  stops autocheckpoint from truncating.

**Done when:** I can open Ansa on my phone, over cellular, and edit a task that
shows up on my desktop.

## Phase 3 — Postgres on Neon

Only once phase 2 is stable and boring.

Neon separates storage from compute, scales to zero when idle, and has a 0.5 GB
free tier. The reason to move: a Railway volume is one disk on one machine, and
if it goes, the data goes. Neon has real backups and branching.

The migration is mostly mechanical — `better-sqlite3`'s synchronous API becomes
async, and the SQL dialect shifts slightly. The op-replay logic doesn't change,
because it operates on trees and ops rather than on rows.

**Done when:** the Railway volume can be deleted and nothing is lost.

## Phase 4 — Phone UI

Deliberately last. It's the part with no clear finish line, and it shouldn't
block the parts that do. Hover-only affordances need touch equivalents, and
drag-to-reorder needs rethinking rather than porting.

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

The switching cost is low either way. Phase 1's contract with auth is one line:
*give me a stable user id for this request.* Keep it that narrow and swapping
providers later is a small change rather than a rewrite.
