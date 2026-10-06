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
 *
 * ## The MCP token
 *
 * A third credential, for a headless client that has no browser to sign in
 * with: a long-lived bearer token mapped to one Clerk user id. It is checked
 * only when Clerk is configured, so it can never be what makes an otherwise
 * unauthenticated deployment answer — a worker that has lost its Clerk key
 * rejects everything, rather than quietly serving the one client that still
 * works while every browser fails.
 */

import { verifyToken } from '@clerk/backend'

/** The subset of the worker's bindings that authentication reads. */
export interface AuthEnv {
  CLERK_SECRET_KEY?: string
  /**
   * The header-trusting dev stub. Only ever set for `wrangler dev`, by
   * build.sh's local run; a deployed worker must not have it. See
   * assertNotProduction.
   */
  ANSA_DEV_AUTH?: string
  /**
   * SHA-256 of the MCP server's bearer token, hex-encoded.
   *
   * The hash rather than the token, so the value sitting in the worker's
   * configuration is not itself a working credential. A secret:
   * `wrangler secret put ANSA_MCP_TOKEN_SHA256`.
   */
  ANSA_MCP_TOKEN_SHA256?: string
  /**
   * The Clerk user id that token acts as — the same `user_xxx` a browser
   * session resolves to, which is what makes the MCP server reach the real
   * tree rather than one of its own.
   *
   * A var rather than a secret, in wrangler.jsonc. It authenticates nothing by
   * itself — without the token's hash it is just a string naming an account —
   * and keeping it visible is what makes a half-configured worker diagnosable.
   */
  ANSA_MCP_USER?: string
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

/**
 * The bearer token from the Authorization header only.
 *
 * Separate from `tokenOf` because the query-string fallback there is an
 * accommodation for WebSocket handshakes, which cannot set headers. That is
 * acceptable for a Clerk session token, which lives about a minute. It is not
 * acceptable for the MCP token, which is long-lived: a URL ends up in access
 * logs, proxy logs, browser history and Referer headers, none of which are
 * places a lasting credential should come to rest.
 */
function headerTokenOf(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
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
function stubOwner(req: Request): string {
  const header = req.headers.get('x-ansa-user')
  if (header && header.length > 0) return header
  const user = new URL(req.url).searchParams.get('user')
  if (user && user.length > 0) return user
  // With no header, every request is the one test user every client defaults
  // to, so a client that sends a token instead (the MCP with a Keychain token)
  // still lands on the same tree as the browser.
  return 'dev'
}

/**
 * SHA-256 of `input`, hex-encoded, matching `sha256sum` and `shasum -a 256`.
 *
 * WebCrypto rather than node:crypto: it is the one hashing API present in both
 * the Workers runtime and the test environment without `nodejs_compat`.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compare two strings without leaking where they diverge.
 *
 * A plain `===` returns as soon as it finds a differing byte, so the time it
 * takes reveals how many leading bytes were right — enough to walk a secret out
 * one byte at a time given enough attempts. This always reads both strings
 * fully and accumulates the difference.
 *
 * Both inputs here are hex digests of fixed length, so comparing lengths first
 * gives nothing away.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * The user the MCP token stands for, or null if this isn't that token.
 *
 * Both halves must be configured. A hash without a user id, or a user id
 * without a hash, is a half-finished setup rather than a working credential,
 * and answering to either alone would be a way to get the wrong answer quietly.
 */
async function mcpOwner(token: string, env: AuthEnv): Promise<string | null> {
  const expected = env.ANSA_MCP_TOKEN_SHA256 ?? ''
  const user = env.ANSA_MCP_USER ?? ''
  if (expected.length === 0 || user.length === 0) return null
  const actual = await sha256Hex(token)
  return constantTimeEqual(actual, expected) ? user : null
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
    // Before Clerk, because the MCP token is not a JWT: letting verifyToken
    // reject it first would log a scary parse error for a perfectly valid
    // credential on every headless request. Header-only — see headerTokenOf.
    const headerToken = headerTokenOf(req)
    if (headerToken) {
      const mcp = await mcpOwner(headerToken, env)
      if (mcp) return mcp
    }
    try {
      const claims = await verifyToken(token, { secretKey: secret })
      // `sub` is Clerk's stable user id. It never changes for an account, which
      // is what makes it safe as the name of the object holding their tree.
      return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null
    } catch (err) {
      // The caller is told only "not signed in" — reporting why would leak
      // whether a token was ever valid. But the operator needs the reason: a
      // rejected-for-no-visible-reason token looks identical to a broken socket
      // from the browser, which is exactly how a misconfiguration once read as
      // "live sync is down". The message names the cause (expired, wrong issuer,
      // wrong key); the token itself is never logged.
      console.error('Token rejected:', err instanceof Error ? err.message : err)
      return null
    }
  }
  if (env.ANSA_DEV_AUTH === '1') return stubOwner(req)
  return null
}
