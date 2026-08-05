/**
 * Who is making this request.
 *
 * The whole contract between Ansa and whatever authenticates it is one
 * function: given a request, return a stable user id, or null if the request
 * isn't signed in. Everything downstream — the store's ownerId, the SSE bus's
 * key — depends only on that string. Keeping the surface this narrow is what
 * makes the auth provider a swappable detail rather than a rewrite.
 *
 * Two providers live here:
 *
 * - **Clerk**, when CLERK_SECRET_KEY is set. The client sends a session JWT,
 *   which is verified against Clerk's public keys. This is real authentication.
 * - **The dev stub**, when ANSA_DEV_AUTH=1. It reads the id straight off a
 *   header and trusts it, which is *not* authentication — anyone can send any
 *   header. It exists so local work doesn't need a network round-trip or a
 *   signed-in browser, and so my own tree stays reachable as `legacy` while the
 *   hosted instance is being built.
 *
 * Clerk wins when both are configured, so a stray ANSA_DEV_AUTH can't downgrade
 * a real deployment to header-trust. With neither, every request is rejected —
 * failing closed is the only safe default for this particular function.
 */

import { verifyToken } from '@clerk/backend'
import type { OwnerId } from './store.ts'

export interface Identified {
  headers: Record<string, unknown>
  /** Present on the SSE route, which can't send headers — see ownerOf. */
  query?: unknown
}

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

const CLERK_SECRET = process.env.CLERK_SECRET_KEY ?? ''
const CLERK_ON = CLERK_SECRET.length > 0
const DEV_AUTH = !CLERK_ON && process.env.ANSA_DEV_AUTH === '1'

/**
 * The dev fallback owner. With ANSA_DEV_AUTH=1 and no header, every request is
 * this user — the pre-auth single-user behaviour, so the local app and the
 * existing database keep working unchanged.
 */
const DEV_OWNER: OwnerId = process.env.ANSA_DEV_USER ?? 'legacy'

/** The bearer token on a request, from the header or the SSE query param. */
function tokenOf(req: Identified): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()
    if (token.length > 0) return token
  }
  // EventSource cannot set headers, so the stream passes its token in the query
  // string. It's a short-lived Clerk session token rather than a long-lived
  // credential, which is what makes this acceptable rather than merely
  // convenient.
  const query = req.query
  if (typeof query === 'object' && query !== null) {
    const t = (query as Record<string, unknown>).token
    if (typeof t === 'string' && t.length > 0) return t
  }
  return null
}

/** The user id from the dev stub's header or query param. */
function stubOwner(req: Identified): OwnerId | null {
  const header = req.headers['x-ansa-user']
  if (typeof header === 'string' && header.length > 0) return header
  const query = req.query
  if (typeof query === 'object' && query !== null) {
    const user = (query as Record<string, unknown>).user
    if (typeof user === 'string' && user.length > 0) return user
  }
  return DEV_OWNER
}

/**
 * The signed-in user's id, or null if the request isn't authenticated.
 *
 * Async because verifying a signature is: this is the one place the narrow
 * contract had to widen when Clerk landed. Callers must await it — a forgotten
 * await yields a truthy Promise, which is why the routes destructure the result
 * rather than testing it directly.
 */
export async function ownerOf(req: Identified): Promise<OwnerId | null> {
  if (CLERK_ON) {
    const token = tokenOf(req)
    if (!token) return null
    try {
      const claims = await verifyToken(token, { secretKey: CLERK_SECRET })
      // `sub` is Clerk's stable user id. It never changes for an account, which
      // is what makes it safe to use as the ownerId written into every row.
      return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null
    } catch {
      // An invalid, expired, or forged token is simply not signed in. The
      // reason isn't the caller's business, and distinguishing them here would
      // leak whether a given token was ever valid.
      return null
    }
  }
  if (DEV_AUTH) return stubOwner(req)
  return null
}

/** True when the process is running the header stub rather than real auth. */
export const isDevAuth = DEV_AUTH

/** True when Clerk is configured and verifying tokens. */
export const isClerkAuth = CLERK_ON
