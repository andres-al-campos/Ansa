/**
 * Client for the Ansa server. The server owns the SQLite database and is the
 * single source of truth; this app and the MCP are both just clients of it.
 *
 * The app computes mutations locally with the pure ops in shared/tree.ts (so
 * undo/redo and animations stay instant), then persists the whole tree with
 * `putTree`. `getTree` is used to load on start and to notice edits made
 * elsewhere — e.g. by a Claude driving the MCP.
 */

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

/** Fetch the current tree, or null if the server can't be reached. */
export async function getTree(): Promise<Tree | null> {
  try {
    const res = await fetch(`${BASE}/api/tree`)
    if (!res.ok) return null
    const data = (await res.json()) as { tree: Tree }
    return data.tree
  } catch {
    return null
  }
}

/** Persist the whole tree. Returns false if the save didn't reach the server. */
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
