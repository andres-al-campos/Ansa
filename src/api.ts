/**
 * Client for the Ansa server. The server owns the SQLite database and is the
 * single source of truth; this app and the MCP are both just clients of it.
 *
 * The app computes mutations locally with the pure ops in shared/tree.ts (so
 * undo/redo and animations stay instant) and sends the *operation* with
 * `sendOp`, which the server replays against its own tree. Changes made
 * elsewhere — another tab, or a Claude driving the MCP — arrive over the
 * WebSocket at `eventsUrl()` rather than by polling.
 */

import type { Op } from '@shared/ops'
import type { Tree } from '@shared/tree'

// Match the API host to the page's own hostname. Chrome treats `localhost` and
// `127.0.0.1` as different origins for Private Network Access, and blocks a
// localhost page from calling 127.0.0.1 — so a hardcoded 127.0.0.1 breaks when
// the app is served from localhost. Deriving the host sidesteps that entirely.
//
// That default is a local-dev convenience and nothing else: 8787 is where
// `wrangler dev` listens under ./build.sh web. A deployed build has no server
// on that port of its own hostname, so VITE_ANSA_API must point at the Worker — and because Vite inlines it at build time, an unset variable is an
// empty string rather than an error. Failing here beats shipping a build whose
// every request goes to a port that isn't listening.
const BASE =
  import.meta.env.VITE_ANSA_API ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:8787`
    : missingApiBase())

function missingApiBase(): never {
  throw new Error(
    'This build has no VITE_ANSA_API, so it does not know where the Ansa API is.\n' +
      'Set it to the Worker URL (https://ansa.<subdomain>.workers.dev) in the Pages\n' +
      'project under Settings → Environment variables, then redeploy.',
  )
}

/**
 * A per-tab id sent on every write. The server echoes it back on the
 * broadcast, so this tab can recognise the echo of its own change and skip
 * re-adopting it — which is what stops a local edit being clobbered by its own
 * broadcast (and by any adopt that would otherwise race the save).
 *
 * A UUID because two tabs sharing an origin is a silent bug, not a loud one:
 * each would mistake the other's broadcasts for its own echo and skip them, so
 * the tabs quietly stop syncing to each other.
 */
export const ORIGIN = `web-${crypto.randomUUID()}`

/**
 * Who this client is acting as when the server is running the dev stub.
 *
 * The server trusts this header as-is, so it is not authentication. It's only
 * used when the server has no Clerk key configured; a Clerk-backed server
 * ignores it entirely. Set VITE_ANSA_USER to run a second account in another
 * browser profile and check that the two trees stay apart.
 */
const USER = import.meta.env.VITE_ANSA_USER ?? 'legacy'

/**
 * How to get the current Clerk session token, installed by the provider at
 * startup.
 *
 * A function rather than a value because these tokens are short-lived — Clerk
 * rotates them roughly every minute, so anything cached here would start
 * failing a few minutes into a session. A module-level setter rather than
 * threading a token through every call site: this file is imported by non-React
 * code (the persist effect, the socket wiring) and shouldn't need a hook.
 */
type TokenSource = () => Promise<string | null>
let getToken: TokenSource = async () => null

export function setTokenSource(source: TokenSource): void {
  getToken = source
}

/**
 * The headers every write carries. One place, so adding a call site can't mean
 * silently omitting identity and getting someone else's tree.
 *
 * Sends both credentials: the bearer token for a Clerk server, the user header
 * for a stub server. Each ignores the other's, so one client works against
 * either without a build flag.
 */
const headers = async (): Promise<Record<string, string>> => {
  const base: Record<string, string> = {
    'content-type': 'application/json',
    'x-ansa-origin': ORIGIN,
    'x-ansa-user': USER,
  }
  const token = await getToken()
  if (token) base.authorization = `Bearer ${token}`
  return base
}

/**
 * The live stream's URL: a WebSocket, carrying a credential in the query string.
 *
 * The query string is forced, not chosen. Neither EventSource nor the browser's
 * WebSocket constructor can set an Authorization header, so a handshake has no
 * other place to put a credential. What makes it acceptable is that a Clerk
 * session token expires in about a minute — a URL that leaks into a log is
 * stale by the time anyone reads it. A long-lived key here would not be.
 *
 * The scheme has to be derived rather than hardcoded: BASE is http(s) for the
 * REST calls, and a WebSocket needs ws(s). Hardcoding `wss` breaks local dev
 * over plain http, and hardcoding `ws` fails on the deployed https origin
 * because browsers refuse a plaintext socket from a secure page.
 *
 * Async and a function — not the constant it used to be — because the token has
 * to be fetched, and because a reconnect needs a *fresh* one rather than the
 * one this module happened to see at import time.
 */
export async function eventsUrl(): Promise<string> {
  const token = await getToken()
  const credential = token
    ? `token=${encodeURIComponent(token)}`
    : `user=${encodeURIComponent(USER)}`
  return `${BASE.replace(/^http/, 'ws')}/api/events?${credential}`
}

/**
 * Persist the whole tree. Returns false if the save didn't reach the server.
 *
 * Only import and seeding use this now — it overwrites the server's tree
 * wholesale, so it's the right shape for "replace everything" and the wrong one
 * for an edit. Ordinary edits go through `sendOp`.
 */
export async function putTree(tree: Tree): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/tree`, {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ tree }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** What the server reports about the current session. */
export interface WhoAmI {
  /** The id rows are filtered on — match this against the database, not a name. */
  ownerId: string
  auth: 'clerk' | 'dev'
  nodes: number
}

/** Who the server thinks this tab is. Null when the session isn't accepted. */
export async function whoami(): Promise<WhoAmI | null> {
  try {
    const res = await fetch(`${BASE}/api/whoami`, { headers: await headers() })
    return res.ok ? ((await res.json()) as WhoAmI) : null
  } catch {
    return null
  }
}

/**
 * Ask the server to give a brand-new account its tutorial project.
 *
 * Safe to call on every boot: the server refuses when the tree is non-empty, so
 * this can't overwrite anything. Keeping the "have I run before?" state on the
 * server rather than in localStorage is deliberate — localStorage is per-browser,
 * and a second device would otherwise re-seed an account that already has data.
 *
 * Failure is silent by design. An empty outliner is a working outliner; the
 * tutorial is a nicety and not worth an error screen.
 */
export async function seedIfEmpty(): Promise<boolean> {
  try {
    // No content-type: this POST has no body. The old Node server rejected an
    // empty body declared as application/json before the route ran, and that
    // 400 is how this silently did nothing at first — a fresh account got no
    // tutorial and no error. The Worker doesn't check, but a bodyless request
    // shouldn't claim a body type either way.
    const { 'content-type': _omit, ...rest } = await headers()
    const res = await fetch(`${BASE}/api/seed`, { method: 'POST', headers: rest })
    if (!res.ok) {
      // Not thrown: an empty outliner still works, and a failed tutorial isn't
      // worth blocking the app. Logged because silence is what hid this.
      console.warn(`Ansa: seeding the tutorial failed (${res.status}).`)
      return false
    }
    return true
  } catch {
    // Offline, or the server is down. The live stream will sync when it returns.
    return false
  }
}

/**
 * What became of a write.
 *
 * The distinction is the whole point: 'unreachable' is about the network and
 * says nothing about the op, so retrying is right. 'rejected' is the server's
 * verdict on *this* op — it will answer the same way every time, so retrying it
 * is not persistence, it's a permanent stall that blocks every edit behind it.
 */
export type WriteResult =
  | { status: 'ok' }
  | { status: 'unreachable' }
  | { status: 'rejected'; reason: string }

/**
 * Send one operation. The server replays it against its current tree, so an op
 * made against a slightly stale local tree still merges instead of clobbering.
 *
 * A rejection is not necessarily a bug. The common cause is a race no ordering
 * can fix: this tab adds a child to a project another device deleted a moment
 * ago, so by the time the op lands its parent is gone. The op is stale rather
 * than late, and there is nowhere to put it.
 */
export async function sendOp(op: Op): Promise<WriteResult> {
  let res: Response
  try {
    res = await fetch(`${BASE}/api/ops`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ op }),
    })
  } catch {
    // Never reached the server: offline, DNS, a blocked request. The op is
    // still good.
    return { status: 'unreachable' }
  }
  if (res.ok) return { status: 'ok' }
  // 401/403 are about the session, not the op: a Clerk token expires roughly
  // every minute, and the op is still perfectly good once a fresh one is
  // fetched. Discarding edits because a token aged out would lose real work.
  if (res.status === 401 || res.status === 403) return { status: 'unreachable' }
  // 4xx is a verdict on the op. 5xx is the server failing at its own job, which
  // says nothing about whether the op is valid — so that retries like a network
  // failure rather than being thrown away.
  if (res.status >= 400 && res.status < 500) {
    const reason = await res
      .json()
      .then((b: { error?: string }) => b?.error ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`)
    return { status: 'rejected', reason }
  }
  return { status: 'unreachable' }
}

/** One line of the trash list: what was deleted, where from, when, how big. */
export interface TrashEntry {
  id: string
  rootId: string
  text: string
  deletedAt: number
  count: number
  /**
   * The project the deleted subtree came out of, or null if it was a project
   * itself. Resolved on the server, which still has the ancestors — the deleted
   * node is out of the tree, so `lineageOf` cannot reach it from here.
   */
  projectText: string | null
}

/**
 * A page of deleted subtrees, newest first.
 *
 * Fetched on demand rather than carried in the tree. The trash is looked at
 * rarely and grows without bound between sweeps, and every edit already reads
 * the whole tree — keeping it off that path is why it is stored apart.
 *
 * Throws rather than returning null. The caller is a panel the user just opened,
 * so it has somewhere to put an error, unlike the fire-and-forget writes above.
 */
export async function fetchTrash(cursor?: number): Promise<{ entries: TrashEntry[]; nextCursor?: number }> {
  const query = cursor === undefined ? '' : `?cursor=${cursor}`
  const res = await fetch(`${BASE}/api/trash${query}`, { headers: await headers() })
  if (!res.ok) throw new Error(`Could not load the trash (HTTP ${res.status}).`)
  return (await res.json()) as { entries: TrashEntry[]; nextCursor?: number }
}

/**
 * Put a deleted subtree back. Returns the whole tree the server now holds.
 *
 * The tree comes back rather than being recomputed locally: the restore's
 * landing spot is the server's call — the original parent, or top level when
 * that parent was deleted too — and guessing it here would be a second
 * implementation of a rule that has to match.
 */
export async function restoreTrash(entryId: string): Promise<Tree> {
  const res = await fetch(`${BASE}/api/trash/${encodeURIComponent(entryId)}/restore`, {
    method: 'POST',
    headers: await headers(),
  })
  if (res.status === 404) {
    throw new Error('That item is no longer in the trash.')
  }
  if (!res.ok) throw new Error(`Could not restore that item (HTTP ${res.status}).`)
  return ((await res.json()) as { tree: Tree }).tree
}

/** Drop one trashed subtree for good, before the sweep would. */
export async function forgetTrash(entryId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/trash/${encodeURIComponent(entryId)}`, {
    method: 'DELETE',
    headers: await headers(),
  })
  if (!res.ok) throw new Error(`Could not delete that item (HTTP ${res.status}).`)
}
