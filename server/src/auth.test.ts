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

describe('the dev stub is opt-in', () => {
  it('returns null when ANSA_DEV_AUTH is unset, so routes 401', async () => {
    delete process.env.ANSA_DEV_AUTH
    const { ownerOf, isDevAuth } = await loadAuth()
    expect(isDevAuth).toBe(false)
    // Even with a header that names a user — the header alone is not authority.
    expect(ownerOf({ headers: { 'x-ansa-user': 'alice' } })).toBeNull()
  })

  it('trusts the header only once explicitly enabled', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf } = await loadAuth()
    expect(ownerOf({ headers: { 'x-ansa-user': 'alice' } })).toBe('alice')
  })

  it('falls back to the query param for SSE, which cannot send headers', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf } = await loadAuth()
    expect(ownerOf({ headers: {}, query: { user: 'bob' } })).toBe('bob')
  })

  it('falls back to the default owner so single-user local dev is unchanged', async () => {
    process.env.ANSA_DEV_AUTH = '1'
    const { ownerOf } = await loadAuth()
    expect(ownerOf({ headers: {} })).toBe('legacy')
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
