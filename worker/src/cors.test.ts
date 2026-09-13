/**
 * The worker's cross-origin rules, with attention to the ways a permissive one
 * would go unnoticed.
 *
 * Every real request to this API is cross-origin, so the allowing path is
 * exercised constantly and would break loudly. The cases worth writing down are
 * the refusals: an unconfigured production worker, an origin that is close to an
 * allowed one without being it, and the local-dev escape hatch staying shut once
 * deployed. A mistake in any of those lets a page the user visits read their
 * tree, and none of them would show up as a failure while developing.
 */

import { describe, expect, it } from 'vitest'
import { corsHeaders, isPreflight, preflightResponse } from './cors.ts'

const APP = 'https://ansa.pages.dev'

const from = (origin?: string) =>
  new Request('https://api/api/tree', origin ? { headers: { origin } } : undefined)

/** Whether these headers let the caller read the response. */
const allows = (h: Record<string, string>) => h['access-control-allow-origin'] !== undefined

describe('a deployed worker', () => {
  const headers = (origin: string | undefined, configured: string | undefined) =>
    corsHeaders(from(origin), configured, false)

  it('allows a configured origin', () => {
    expect(headers(APP, APP)).toEqual({
      'access-control-allow-origin': APP,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    })
  })

  it('picks one origin out of a configured list', () => {
    expect(allows(headers(APP, `https://other.dev,${APP},https://third.dev`))).toBe(true)
  })

  it('allows nothing when the binding is unset, rather than defaulting open', () => {
    expect(allows(headers(APP, undefined))).toBe(false)
    expect(allows(headers(APP, ''))).toBe(false)
  })

  it('refuses an origin that is not on the list', () => {
    expect(allows(headers('https://evil.example', APP))).toBe(false)
  })

  // The allowlist is compared whole. A substring match here would hand the tree
  // to anyone who can register a hostname ending in the real one.
  it('refuses an origin that merely contains an allowed one', () => {
    expect(allows(headers('https://ansa.pages.dev.evil.example', APP))).toBe(false)
    expect(allows(headers('https://notansa.pages.dev', APP))).toBe(false)
  })

  it('refuses an allowed host on the wrong scheme or port', () => {
    expect(allows(headers('http://ansa.pages.dev', APP))).toBe(false)
    expect(allows(headers('https://ansa.pages.dev:8787', APP))).toBe(false)
  })

  it('still varies on Origin when it refuses, so a cache cannot cross the two', () => {
    expect(headers('https://evil.example', APP)).toEqual({ vary: 'Origin' })
  })

  it('tolerates whitespace and blanks in the binding', () => {
    expect(allows(headers(APP, ` , ${APP} , `))).toBe(true)
  })

  it('never answers with a wildcard, which credentials would make unusable', () => {
    expect(headers(APP, APP)['access-control-allow-origin']).not.toBe('*')
  })
})

describe('local dev', () => {
  it('reflects any origin', () => {
    expect(allows(corsHeaders(from('http://localhost:5173'), undefined, true))).toBe(true)
    expect(allows(corsHeaders(from('https://anything.example'), undefined, true))).toBe(true)
  })
})

describe('a request with no Origin header', () => {
  // curl, the MCP server, anything that is not a browser. There is nothing to
  // reflect and no browser to satisfy, so the headers are absent rather than
  // permissive — and absent means no `vary` either, since nothing varied.
  it('gets no CORS headers at all, in dev or deployed', () => {
    expect(corsHeaders(from(), APP, false)).toEqual({})
    expect(corsHeaders(from(), undefined, true)).toEqual({})
  })
})

describe('preflight detection', () => {
  const options = (headers: Record<string, string> = {}) =>
    new Request('https://api/api/tree', { method: 'OPTIONS', headers })

  it('is an OPTIONS carrying the request-method header', () => {
    expect(isPreflight(options({ 'access-control-request-method': 'POST' }))).toBe(true)
  })

  it('is not a bare OPTIONS', () => {
    expect(isPreflight(options())).toBe(false)
  })

  it('is not a real request, whatever headers it carries', () => {
    const get = new Request('https://api/api/tree', {
      headers: { 'access-control-request-method': 'POST' },
    })
    expect(isPreflight(get)).toBe(false)
  })
})

describe('the preflight answer', () => {
  const res = (cors: Record<string, string> = {}) => preflightResponse(cors)

  it('is an empty 204', async () => {
    const r = res()
    expect(r.status).toBe(204)
    expect(await r.text()).toBe('')
  })

  it('carries the CORS headers it was handed', () => {
    expect(res({ 'access-control-allow-origin': APP }).headers.get('access-control-allow-origin'))
      .toBe(APP)
  })

  // Both are custom headers, so a browser blocks the request carrying them
  // unless they are named here. Listed explicitly because dropping one breaks
  // only the client that sends it, which is not the one you are testing.
  it('names every custom header the clients send', () => {
    const allowed = res().headers.get('access-control-allow-headers') ?? ''
    for (const h of ['authorization', 'content-type', 'x-ansa-origin', 'x-ansa-user']) {
      expect(allowed).toContain(h)
    }
  })

  it('names every method the API answers', () => {
    const methods = res().headers.get('access-control-allow-methods') ?? ''
    for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(m)
    }
  })

  // A refused origin hands in `{ vary: 'Origin' }` and nothing else. The
  // preflight must not become permissive by adding its own allow-* headers on
  // top of a refusal.
  it('stays a refusal when handed one', () => {
    expect(res({ vary: 'Origin' }).headers.get('access-control-allow-origin')).toBeNull()
  })
})
