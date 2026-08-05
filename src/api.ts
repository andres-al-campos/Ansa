/**
 * Client for the Ansa server. The server owns the SQLite database and is the
 * single source of truth; this app and the MCP are both just clients of it.
 *
 * The app computes mutations locally with the pure ops in shared/tree.ts (so
 * undo/redo and animations stay instant) and sends the *operation* with
 * `sendOp`, which the server replays against its own tree. Changes made
 * elsewhere — another tab, or a Claude driving the MCP — arrive over the SSE
 * stream at `eventsUrl()` rather than by polling.
 */

import type { Op } from '@shared/ops'
import type { Tree } from '@shared/tree'

// Match the API host to the page's own hostname. Chrome treats `localhost` and
// `127.0.0.1` as different origins for Private Network Access, and blocks a
// localhost page from calling 127.0.0.1 — so a hardcoded 127.0.0.1 breaks when
// the app is served from localhost. Deriving the host sidesteps that entirely.
const BASE =
  import.meta.env.VITE_ANSA_API ??
  `${window.location.protocol}//${window.location.hostname}:4000`

/**
 * A per-tab id sent on every write. The server echoes it back on the SSE
 * broadcast, so this tab can recognise the echo of its own change and skip
 * re-adopting it — which is what stops a local edit being clobbered by its own
 * broadcast (and by any adopt that would otherwise race the save).
 */
export const ORIGIN = `web-${Math.random().toString(36).slice(2, 10)}`

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
 * code (the persist effect, the SSE wiring) and shouldn't need a hook.
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
 * The SSE stream's URL, including a credential in the query string because
 * EventSource cannot set headers.
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
  return `${BASE}/api/events?${credential}`
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

/**
 * Send one operation. The server replays it against its current tree, so an op
 * made against a slightly stale local tree still merges instead of clobbering.
 * Returns false if it didn't reach the server, matching putTree's contract —
 * the caller decides whether that's worth retrying.
 */
export async function sendOp(op: Op): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/ops`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ op }),
    })
    return res.ok
  } catch {
    return false
  }
}
