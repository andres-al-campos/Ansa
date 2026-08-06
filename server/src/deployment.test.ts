/**
 * The production/dev switches, at both settings.
 *
 * Each of these fails quietly in exactly one direction, which is why they are
 * tested rather than eyeballed: a loopback bind in a container never receives a
 * request, and a permissive CORS policy behaves identically to a correct one
 * right up until it doesn't.
 */

import { describe, expect, it, vi } from 'vitest'
import { bindHost, corsOrigin, fatalMisconfiguration, isProduction } from './deployment.ts'

const prod = { NODE_ENV: 'production' }
const dev = { NODE_ENV: 'development' }

describe('isProduction', () => {
  it('is true only for exactly "production"', () => {
    expect(isProduction(prod)).toBe(true)
    expect(isProduction(dev)).toBe(false)
    // Not a substring match: "not-production" must not read as production.
    expect(isProduction({ NODE_ENV: 'not-production' })).toBe(false)
    expect(isProduction({})).toBe(false)
  })
})

describe('bindHost', () => {
  it('binds all interfaces in production', () => {
    // The regression this guards: a container's traffic does not arrive on
    // loopback, so a localhost bind means the health check never connects and
    // the deploy fails with a server that looks perfectly healthy in its logs.
    expect(bindHost(prod)).toBe('0.0.0.0')
  })

  it('stays on localhost in dev, covering both loopback stacks', () => {
    // 'localhost' rather than '127.0.0.1' on purpose — Safari resolves it to
    // ::1 and does not fall back to IPv4.
    expect(bindHost(dev)).toBe('localhost')
    expect(bindHost({})).toBe('localhost')
  })
})

describe('corsOrigin', () => {
  it('reflects any origin in dev, where Vite is on another port', () => {
    expect(corsOrigin(dev)).toBe(true)
  })

  it('allows nothing cross-origin in production by default', () => {
    // Same-origin requests carry no Origin header and need no CORS, so the
    // right default once the frontend is served by this server is `false`.
    expect(corsOrigin(prod)).toBe(false)
  })

  it('honours an explicit origin, for a separately hosted frontend', () => {
    expect(corsOrigin({ ...prod, ANSA_ALLOWED_ORIGIN: 'https://ansa.example' })).toBe(
      'https://ansa.example',
    )
  })
})

describe('fatalMisconfiguration', () => {
  it('never blocks a local server', () => {
    expect(fatalMisconfiguration(dev, false)).toBeNull()
    expect(fatalMisconfiguration({ ...dev, ANSA_DEV_AUTH: '1' }, false)).toBeNull()
  })

  it('leaves the public dev-stub case to auth.ts, which throws on import', async () => {
    // Not duplicated here: auth.ts refuses at import time, earlier and harder to
    // skip. Asserted rather than assumed, since dropping that guard would
    // otherwise leave the stub trusting x-ansa-user on a public URL with
    // nothing catching it.
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ANSA_DEV_AUTH', '1')
    vi.stubEnv('CLERK_SECRET_KEY', '')
    await expect(import('./auth.ts')).rejects.toThrow(/ANSA_DEV_AUTH/)
    vi.unstubAllEnvs()
  })

  it('refuses to start in production with no auth at all', () => {
    const msg = fatalMisconfiguration(prod, false)
    expect(msg).toMatch(/CLERK_SECRET_KEY/)
  })

  it('starts when Clerk is configured', () => {
    expect(fatalMisconfiguration(prod, true)).toBeNull()
    // Clerk wins over a stray dev flag rather than tripping the guard.
    expect(fatalMisconfiguration({ ...prod, ANSA_DEV_AUTH: '1' }, true)).toBeNull()
  })
})
