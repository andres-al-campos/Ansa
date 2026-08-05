/**
 * Sign-in, and the bridge from Clerk's session to the API client.
 *
 * Two things have to be true before the app renders: the user is signed in, and
 * `src/api.ts` knows how to get a token. The second is easy to forget because
 * nothing crashes without it — every request just quietly 401s — so the token
 * source is installed here, in the same component that owns the gate.
 *
 * Without a publishable key this renders children directly. That's the dev-stub
 * path: a server running ANSA_DEV_AUTH doesn't want tokens, and requiring a
 * Clerk account to run the tests or a local throwaway instance would be worse
 * than the risk, since the server is the thing that decides what it accepts.
 */

import { useEffect, type ReactNode } from 'react'
import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react'
import { seedIfEmpty, setTokenSource } from './api'

const KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? ''

/**
 * Hands api.ts a getter for the current session token.
 *
 * A getter rather than the token itself: Clerk rotates these roughly every
 * minute, so anything captured as a value would start failing a few minutes in.
 */
function InstallToken({ children }: { children: ReactNode }) {
  const { getToken } = useAuth()
  useEffect(() => {
    setTokenSource(() => getToken())
    // Only now — the request needs the token that was just installed. The server
    // no-ops when the account already has a tree, so running this on every boot
    // costs one request and can't overwrite anything.
    void seedIfEmpty()
  }, [getToken])
  return <>{children}</>
}

export default function AuthGate({ children }: { children: ReactNode }) {
  if (!KEY) return <>{children}</>
  return (
    <ClerkProvider publishableKey={KEY}>
      <SignedIn>
        <InstallToken>{children}</InstallToken>
      </SignedIn>
      <SignedOut>
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
          <SignIn routing="hash" />
        </div>
      </SignedOut>
    </ClerkProvider>
  )
}
