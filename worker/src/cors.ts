/**
 * Cross-origin rules for the API.
 *
 * The frontend is served from Pages and the API from a worker, so unlike the
 * production Node server — which served both from one origin — every real
 * request here is cross-origin. That makes this file load-bearing rather than a
 * dev convenience.
 *
 * The rule is the same as server/src/deployment.ts: reflect anything in local
 * dev, allow only a configured list once deployed. What is *not* the same is
 * that a mistake matters more. `Access-Control-Allow-Origin: *` together with
 * credentials is rejected by browsers, but the real hazard is quieter — the
 * bearer token travels in a header, so a permissive allowlist lets any page the
 * user visits read their tree with a token it tricked the browser into sending.
 * So an unconfigured production worker allows nothing and the app fails loudly,
 * rather than defaulting open.
 */

/** Origins allowed to call the API, from the comma-separated binding. */
function allowed(configured: string | undefined): string[] {
  return (configured ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * The CORS headers for this request.
 *
 * Echoes the caller's origin rather than a wildcard, because credentials are
 * involved; `Vary: Origin` keeps a cache from serving one origin's response to
 * another. An origin that isn't allowed simply gets no CORS headers — the
 * request still executes, and the browser is what refuses to show the result.
 */
export function corsHeaders(
  req: Request,
  configured: string | undefined,
  isLocalDev: boolean,
): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin) return {}
  if (!isLocalDev && !allowed(configured).includes(origin)) return { vary: 'Origin' }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  }
}

export function isPreflight(req: Request): boolean {
  return req.method === 'OPTIONS' && req.headers.has('access-control-request-method')
}

/**
 * The preflight answer.
 *
 * x-ansa-origin is the client instance tag and x-ansa-user is the dev stub's
 * header; both are custom, so both have to be named here or the browser blocks
 * the request that carries them.
 */
export function preflightResponse(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-ansa-origin, x-ansa-user',
      'access-control-max-age': '86400',
    },
  })
}
