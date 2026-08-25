/**
 * The worker's auth, with attention to the ways configuration goes wrong.
 *
 * The happy paths get exercised every time anyone opens the app; these do not,
 * which is why they are the ones written down. The MCP token gets the most
 * coverage here because it is the newest credential and the only one that is a
 * plain shared secret rather than a signed token.
 */

import { describe, expect, it } from 'vitest'
import { misconfiguredAuth, ownerOf, type AuthEnv } from './auth.ts'

const TOKEN = 'correct-horse'

/** Computed rather than pasted, so no constant here can drift from the real digest. */
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const req = (headers: Record<string, string> = {}, url = 'https://x/api/tree') =>
  new Request(url, { headers })

const bearer = (t: string) => req({ authorization: `Bearer ${t}` })

describe('the MCP token', () => {
  const base = async (): Promise<AuthEnv> => ({
    CLERK_SECRET_KEY: 'sk_test_notarealkey',
    ANSA_MCP_TOKEN_SHA256: await sha256Hex(TOKEN),
    ANSA_MCP_USER: 'user_real',
  })

  it('resolves to the configured user', async () => {
    await expect(ownerOf(bearer(TOKEN), await base())).resolves.toBe('user_real')
  })

  it('rejects a wrong token without falling through to anything else', async () => {
    await expect(ownerOf(bearer('wrong-horse'), await base())).resolves.toBeNull()
  })

  // Half a configuration is a setup someone abandoned partway, not a credential.
  // Answering to either half alone is how a deployment ends up serving the wrong
  // owner's tree while looking configured.
  it('is inert with a hash but no user id', async () => {
    const env = { ...(await base()), ANSA_MCP_USER: undefined }
    await expect(ownerOf(bearer(TOKEN), env)).resolves.toBeNull()
  })

  it('is inert with a user id but no hash', async () => {
    const env = { ...(await base()), ANSA_MCP_TOKEN_SHA256: undefined }
    await expect(ownerOf(bearer(TOKEN), env)).resolves.toBeNull()
  })

  // The token must never be what makes an unauthenticated worker answer. A
  // deployment that has lost its Clerk key should reject everything loudly,
  // rather than keep serving the one client that still works.
  it('does not authenticate when Clerk is unconfigured', async () => {
    const env = { ...(await base()), CLERK_SECRET_KEY: undefined }
    await expect(ownerOf(bearer(TOKEN), env)).resolves.toBeNull()
  })

  it('does not authenticate via the dev stub either', async () => {
    const env: AuthEnv = {
      ANSA_DEV_AUTH: '1',
      ANSA_MCP_TOKEN_SHA256: await sha256Hex(TOKEN),
      ANSA_MCP_USER: 'user_real',
    }
    // The stub answers, but from the header — not from the MCP token.
    await expect(ownerOf(bearer(TOKEN), env)).resolves.toBe('legacy')
  })

  // The stub trusts x-ansa-user. If it could still answer with Clerk
  // configured, the MCP token would be pointless: anyone could just send a
  // header instead.
  it('leaves Clerk precedence intact', async () => {
    const env = { ...(await base()), ANSA_DEV_AUTH: '1' }
    await expect(ownerOf(req({ 'x-ansa-user': 'alice' }), env)).resolves.toBeNull()
  })

  it('is not accepted from the query string', async () => {
    // The query-string path exists for WebSocket handshakes, which cannot set
    // headers. It is a short-lived Clerk session token there; a long-lived
    // shared secret in a URL would land in logs and history.
    const env = await base()
    const r = req({}, `https://x/api/stream?token=${TOKEN}`)
    await expect(ownerOf(r, env)).resolves.toBeNull()
  })
})

describe('the dev stub still refuses to run deployed', () => {
  it('reports the misconfiguration', () => {
    expect(misconfiguredAuth({ ANSA_DEV_AUTH: '1' }, false)).toMatch(/ANSA_DEV_AUTH=1/)
  })

  it('is fine locally', () => {
    expect(misconfiguredAuth({ ANSA_DEV_AUTH: '1' }, true)).toBeNull()
  })
})
