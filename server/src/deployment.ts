/**
 * The handful of decisions that differ between "on my laptop" and "on a URL".
 *
 * Pure functions over an env bag rather than reads of `process.env` scattered
 * through index.ts, so each one can be tested at both settings. Getting any of
 * these wrong in production is quiet rather than loud — a server that binds a
 * loopback address in a container simply never receives a request, and a CORS
 * policy that reflects every origin looks identical to a correct one until
 * someone else's page calls the API.
 */

export interface Env {
  NODE_ENV?: string
  ANSA_DEV_AUTH?: string
  ANSA_ALLOWED_ORIGIN?: string
}

export function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production'
}

/**
 * Which interface to bind.
 *
 * A container gets traffic on an address that isn't loopback, so production has
 * to bind 0.0.0.0 or Railway's health check never connects. Locally the bind
 * stays 'localhost' — which covers both 127.0.0.1 and ::1, the IPv4/IPv6 split
 * that made the API reachable in Chrome but not Safari.
 */
export function bindHost(env: Env): string {
  return isProduction(env) ? '0.0.0.0' : 'localhost'
}

/**
 * The CORS origin policy.
 *
 * `true` reflects whatever Origin the request carried, which is what dev needs:
 * the app is served by Vite on a different port. In production the frontend is
 * served by this same server, so same-origin requests carry no Origin header
 * and need no CORS at all — meaning the correct production default is to allow
 * nothing cross-origin. ANSA_ALLOWED_ORIGIN is the escape hatch for hosting the
 * frontend somewhere else later.
 */
export function corsOrigin(env: Env): string | boolean {
  if (!isProduction(env)) return true
  return env.ANSA_ALLOWED_ORIGIN ?? false
}

/**
 * Whether to refuse to start.
 *
 * Covers the case auth.ts doesn't: production with no auth configured at all.
 * ANSA_DEV_AUTH=1 in production already throws at import time in auth.ts, which
 * is earlier and harder to skip than a check here, so this deliberately doesn't
 * duplicate it.
 *
 * Returns the message to die with, or null to proceed.
 */
export function fatalMisconfiguration(env: Env, clerkConfigured: boolean): string | null {
  if (!isProduction(env)) return null
  if (clerkConfigured) return null

  return (
    'Refusing to start: no CLERK_SECRET_KEY in production.\n' +
    'Every request would 401. Set CLERK_SECRET_KEY in the Railway service\n' +
    'variables (Clerk dashboard → API keys → Secret key).'
  )
}
