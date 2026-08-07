/**
 * Who is making this request, on Workers.
 *
 * Same one-function contract as server/src/auth.ts: given a request, return a
 * stable user id or null. Everything downstream — which Durable Object gets
 * addressed — depends only on that string.
 *
 * ## Why this is a separate file rather than a shared one
 *
 * The Node version reads process.env at module scope and freezes the result in
 * three consts. Workers has no process.env: bindings arrive per-request on the
 * env argument, and there is no module-load moment at which they exist. So the
 * configuration has to be a parameter here, not a constant. Sharing the file
 * would mean threading env through the Node version for no benefit, and the
 * logic being duplicated is thirty lines that fail closed.
 *
 * The security-relevant properties are kept identical, and that is what the
 * tests assert:
 *
 *  - Clerk wins whenever CLERK_SECRET_KEY is set, so a stray ANSA_DEV_AUTH
 *    cannot downgrade a real deployment to header-trust.
 *  - With neither configured, every request is rejected.
 *  - An invalid, expired, or forged token is simply "not signed in" — the
 *    reason is not reported, since that would leak whether a token was ever
 *    valid.
 */

import { verifyToken } from '@clerk/backend'

/** The subset of the worker's bindings that authentication reads. */
export interface AuthEnv {
  CLERK_SECRET_KEY?: string
  /**
   * The header-trusting dev stub. Only ever set in .dev.vars for `wrangler
   * dev`; a deployed worker must not have it. See assertNotProduction.
   */
  ANSA_DEV_AUTH?: string
  ANSA_DEV_USER?: string
}

/**
 * Refuse to run the dev stub in a deployed worker.
 *
 * The Node server does this at module load and throws, killing the process.
 * A worker has no equivalent moment — there is no boot to fail — so the check
 * runs per-request in the fetch handler and turns into a 500 rather than a
 * silently impersonatable deployment.
 *
 * Returns the problem, or null when the configuration is safe.
 */
export function misconfiguredAuth(env: AuthEnv, isLocalDev: boolean): string | null {
  if (env.ANSA_DEV_AUTH !== '1') return null
  if (isLocalDev) return null
  return (
    'ANSA_DEV_AUTH=1 in a deployed worker: the dev auth stub trusts the ' +
    'x-ansa-user header, so anyone could act as any user. Remove ANSA_DEV_AUTH ' +
    'from the worker (wrangler secret delete ANSA_DEV_AUTH, and check the vars ' +
    'block in wrangler.jsonc) and redeploy.'
  )
}

/** The bearer token on a request, from the header or the query string. */
function tokenOf(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()
    if (token.length > 0) return token
  }
  // A WebSocket handshake cannot set an Authorization header, so the stream
  // passes its token in the query string — the same accommodation the SSE route
  // needed. It's a short-lived Clerk session token rather than a long-lived
  // credential, which is what makes this acceptable rather than merely
  // convenient.
  const token = new URL(req.url).searchParams.get('token')
  return token && token.length > 0 ? token : null
}

/** The user id the dev stub is told to trust. Not authentication. */
function stubOwner(req: Request, env: AuthEnv): string {
  const header = req.headers.get('x-ansa-user')
  if (header && header.length > 0) return header
  const user = new URL(req.url).searchParams.get('user')
  if (user && user.length > 0) return user
  // With no header, every request is one user — the pre-auth single-user
  // behaviour, so local work needs no signed-in browser.
  return env.ANSA_DEV_USER ?? 'legacy'
}

/**
 * The signed-in user's id, or null if the request isn't authenticated.
 *
 * This id becomes the Durable Object name, so it decides which database the
 * request reaches. It must come from a verified token and never from anything
 * the client can set — which is exactly why the stub branch is unreachable
 * whenever Clerk is configured.
 */
export async function ownerOf(req: Request, env: AuthEnv): Promise<string | null> {
  const secret = env.CLERK_SECRET_KEY ?? ''
  if (secret.length > 0) {
    const token = tokenOf(req)
    if (!token) return null
    try {
      const claims = await verifyToken(token, { secretKey: secret })
      // `sub` is Clerk's stable user id. It never changes for an account, which
      // is what makes it safe as the name of the object holding their tree.
      return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null
    } catch {
      return null
    }
  }
  if (env.ANSA_DEV_AUTH === '1') return stubOwner(req, env)
  return null
}
