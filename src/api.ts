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
// That default is a local-dev convenience and nothing else. A deployed build has
// no server on port 4000 of its own hostname, so VITE_ANSA_API must point at the
// Worker — and because Vite inlines it at build time, an unset variable is an
// empty string rather than an error. Failing here beats shipping a build whose
// every request goes to a port that isn't listening.
const BASE =
  import.meta.env.VITE_ANSA_API ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:4000`
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
    // No content-type: this POST has no body, and Fastify rejects an empty body
    // declared as application/json with FST_ERR_CTP_EMPTY_JSON_BODY before the
    // route ever runs. That 400 is how this silently did nothing at first — a
    // fresh account got no tutorial and no error.
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
