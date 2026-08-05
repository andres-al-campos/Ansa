/**
 * The auth stub's two safety properties.
 *
 * Both are about what happens when configuration is *wrong*, which is exactly
 * the case no manual run covers: locally ANSA_DEV_AUTH is always set, so the
 * unauthenticated path and the production guard never execute by hand.
 *
 * The module reads env at import time, so each test re-imports it under a fresh
 * environment via vi.resetModules().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ENV }
})

/** Import auth.ts fresh under the current process.env (see resetModules above). */
const loadAuth = () => import('./auth.ts')

beforeEach(() => {
  // Clerk wins over the stub, so the stub tests must run with it absent.
  delete process.env.CLERK_SECRET_KEY
})

describe('the dev stub is opt-in', () => {
  it('returns null when ANSA_DEV_AUTH is unset, so routes 401', async () => {
    delete process.env.ANSA_DEV_AUTH
    const { ownerOf, isDevAuth } = await loadAuth()
    expect(isDevAuth).toBe(false)
    // Even with a header that names a user — the header alone is not authority.
    await expect(ownerOf({ headers: { 'x-ansa-user': 'alice' } })).resolves.toBeNull()
  })

  it('trusts the header only once explicitly enabled', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf } = await loadAuth()
    await expect(ownerOf({ headers: { 'x-ansa-user': 'alice' } })).resolves.toBe('alice')
  })

  it('falls back to the query param for SSE, which cannot send headers', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf } = await loadAuth()
    await expect(ownerOf({ headers: {}, query: { user: 'bob' } })).resolves.toBe('bob')
  })

  it('falls back to the default owner so single-user local dev is unchanged', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf } = await loadAuth()
    await expect(ownerOf({ headers: {} })).resolves.toBe('legacy')
  })
})

describe('Clerk takes precedence over the stub', () => {
  // The stub trusts a header. If a deployment has Clerk configured *and* a
  // stray ANSA_DEV_AUTH=1, the stub must not be what answers — otherwise the
  // env var silently downgrades a real deployment to header-trust.
  it('a header-only request is rejected when Clerk is configured', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_notarealkey'
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf, isDevAuth, isClerkAuth } = await loadAuth()
    expect(isClerkAuth).toBe(true)
    expect(isDevAuth).toBe(false)
    await expect(ownerOf({ headers: { 'x-ansa-user': 'alice' } })).resolves.toBeNull()
  })

  it('a garbage bearer token is rejected rather than throwing', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_notarealkey'
    const { ownerOf } = await loadAuth()
    await expect(ownerOf({ headers: { authorization: 'Bearer not.a.jwt' } })).resolves.toBeNull()
  })

  it('a missing token is rejected', async () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_notarealkey'
    const { ownerOf } = await loadAuth()
    await expect(ownerOf({ headers: {} })).resolves.toBeNull()
  })
})

describe('the stub refuses to run in production', () => {
  // A header-trusting auth stub in production means anyone can act as anyone.
  // Failing to boot is the loud failure; booting is the silent one.
  it('throws when ANSA_DEV_AUTH=1 and NODE_ENV=production', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    process.env.NODE_ENV = 'production'
    await expect(loadAuth()).rejects.toThrow(/ANSA_DEV_AUTH=1 with NODE_ENV=production/)
  })

  it('boots fine in production when the stub is off', async () => {
    delete process.env.ANSA_DEV_AUTH
    process.env.NODE_ENV = 'production'
    const { isDevAuth } = await loadAuth()
    expect(isDevAuth).toBe(false)
  })
})
