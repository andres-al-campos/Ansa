/**
 * Who is making this request.
 *
 * The whole contract between Ansa and whatever authenticates it is one
 * function: given a request, return a stable user id, or null if the request
 * isn't signed in. Everything downstream — the store's ownerId, the SSE bus's
 * key — depends only on that string. Keeping the surface this narrow is what
 * makes the auth provider a swappable detail rather than a rewrite.
 *
 * Right now this is a stub. It reads the id straight off a header, which is
 * *not* authentication — anyone can send any header. It exists so ownership can
 * be built and tested end to end before a provider is wired in, and so the
 * shape the provider has to fill is already fixed when it arrives.
 *
 * Guarded by ANSA_DEV_AUTH so the stub can't be what's running in production by
 * accident: without it, requests are unauthenticated and the routes reject them.
 */

import type { OwnerId } from './store.ts'

export interface Identified {
  headers: Record<string, unknown>
  /** Present on the SSE route, which can't send headers — see ownerOf. */
  query?: unknown
}

/**
 * The dev fallback owner. With ANSA_DEV_AUTH=1 and no header, every request is
 * this user — which is the current single-user behaviour, so the local app keeps
 * working unchanged while the second account is reachable via the header.
 */
const DEV_OWNER: OwnerId = process.env.ANSA_DEV_USER ?? 'legacy'

// The stub trusts a header, so production is the one place it must never run —
// including when a stray ANSA_DEV_AUTH=1 rides along in a deploy env. Refusing
// to boot beats booting with every request impersonatable.
if (process.env.ANSA_DEV_AUTH === '1' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'ANSA_DEV_AUTH=1 with NODE_ENV=production: the dev auth stub trusts the ' +
      'x-ansa-user header, so anyone could act as any user. Unset ANSA_DEV_AUTH ' +
      'in this environment and wire a real auth provider in server/src/auth.ts.',
  )
}

const DEV_AUTH = process.env.ANSA_DEV_AUTH === '1'

/**
 * The signed-in user's id, or null if the request isn't authenticated.
 *
 * Falls back to the `user` query parameter because the SSE route can't send a
 * header: the browser's EventSource has no way to set one. That fallback is
 * specific to the stub — a real provider uses a cookie, which EventSource does
 * send — so it goes away with the rest of this file.
 */
export function ownerOf(req: Identified): OwnerId | null {
  if (!DEV_AUTH) return null
  const header = req.headers['x-ansa-user']
  if (typeof header === 'string' && header.length > 0) return header
  const query = req.query
  if (typeof query === 'object' && query !== null) {
    const user = (query as Record<string, unknown>).user
    if (typeof user === 'string' && user.length > 0) return user
  }
  return DEV_OWNER
}

/** True when the process is running the header stub rather than real auth. */
export const isDevAuth = DEV_AUTH
