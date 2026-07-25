/**
 * Client for the Ansa server. The server owns the SQLite database and is the
 * single source of truth; this app and the MCP are both just clients of it.
 *
 * The app computes mutations locally with the pure ops in shared/tree.ts (so
 * undo/redo and animations stay instant) and sends the *operation* with
 * `sendOp`, which the server replays against its own tree. Changes made
 * elsewhere — another tab, or a Claude driving the MCP — arrive over the SSE
 * stream at EVENTS_URL rather than by polling.
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

export const EVENTS_URL = `${BASE}/api/events`

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
      headers: { 'content-type': 'application/json', 'x-ansa-origin': ORIGIN },
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
      headers: { 'content-type': 'application/json', 'x-ansa-origin': ORIGIN },
      body: JSON.stringify({ op }),
    })
    return res.ok
  } catch {
    return false
  }
}
