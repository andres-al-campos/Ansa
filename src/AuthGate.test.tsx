import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'

// The real api module, so the token source really is installed and really is
// read back. Mocking it would test the mock's ordering rather than React's.
const setTokenSource = vi.fn()
const seedIfEmpty = vi.fn(async () => true)

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, setTokenSource, seedIfEmpty }
})

// Clerk's provider needs a publishable key and a network. Neither is available
// here and neither is what's under test — the ordering is a React question, so
// the gate's own components are stubbed down to their structure.
vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
  SignIn: () => null,
  useAuth: () => ({ getToken: async () => 'a-token' }),
}))

beforeEach(() => {
  setTokenSource.mockClear()
  seedIfEmpty.mockClear()
  vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_stub')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

test('the token source is installed before any child effect runs', async () => {
  // The bug this guards, which shipped: setTokenSource lived in InstallToken's
  // useEffect. React runs child effects before parent effects, so the outliner's
  // effect — which opens the live socket and fires the first requests — ran
  // first and read the default token source, which returns null. The socket fell
  // back to an unauthenticated `?user=legacy` URL and every startup call came
  // back 401. It presented as "live sync is broken", not as an auth problem.
  const { default: AuthGate } = await import('./AuthGate')

  let installedWhenChildEffectRan: boolean | null = null
  function Child() {
    useEffect(() => {
      installedWhenChildEffectRan = setTokenSource.mock.calls.length > 0
    }, [])
    return null
  }

  render(
    <AuthGate>
      <Child />
    </AuthGate>,
  )

  expect(installedWhenChildEffectRan).toBe(true)
})

test('the installed source returns the current token rather than a captured one', async () => {
  // Clerk rotates session tokens roughly every minute, so anything installed as
  // a value would start failing a few minutes into a session. It has to be a
  // getter that calls through on every request.
  const { default: AuthGate } = await import('./AuthGate')
  render(
    <AuthGate>
      <div />
    </AuthGate>,
  )

  const source = setTokenSource.mock.calls.at(-1)?.[0] as () => Promise<string | null>
  await expect(source()).resolves.toBe('a-token')
})
