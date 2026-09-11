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
 *
 * In a production build that path is a hole rather than a convenience, and it
 * fails open — the app renders with no gate at all. This is not hypothetical:
 * a Docker build shipped exactly that, because Vite inlines the key at BUILD
 * time and an unset variable is silently an empty string rather than an error.
 * So a production build with no key refuses to run instead of running unguarded.
 * The server would still reject every request, but an app that looks signed-in
 * and fails every call is a worse thing to debug than one that says why.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react'
import { dark } from '@clerk/themes'
import { seedIfEmpty, setTokenSource } from './api'

const KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? ''

/**
 * Clerk's own modals (sign-in, Manage account) render in their own chrome, and
 * they don't watch `prefers-color-scheme` the way the rest of the app does —
 * `appearance` is read at mount. So track the media query ourselves and hand
 * Clerk its `dark` baseTheme only while the system is dark; light gets Clerk's
 * default. This keeps the account popover's "Manage account" from opening a
 * white modal on a dark app.
 */
function usePrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setPrefersDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return prefersDark
}

/**
 * Hands api.ts a getter for the current session token.
 *
 * A getter rather than the token itself: Clerk rotates these roughly every
 * minute, so anything captured as a value would start failing a few minutes in.
 */
function InstallToken({ children }: { children: ReactNode }) {
  const { getToken } = useAuth()

  // During render, not in an effect. React runs child effects before parent
  // ones, and the children here include the outliner — so an effect would
  // install the token source *after* the outliner had already opened its socket
  // and fired its first requests. Those went out unauthenticated: the socket
  // fell back to `?user=legacy` and every call came back 401, which looked like
  // a sync bug rather than a startup-ordering one.
  //
  // Safe during render because this only assigns a module-level variable. It
  // sets no state and schedules no work, so it can't loop or tear.
  setTokenSource(() => getToken())

  useEffect(() => {
    // The server no-ops when the account already has a tree, so running this on
    // every boot costs one request and can't overwrite anything.
    void seedIfEmpty()
  }, [getToken])

  return <>{children}</>
}

export default function AuthGate({ children }: { children: ReactNode }) {
  // Called before any early return so the hook count is stable across renders.
  const prefersDark = usePrefersDark()

  if (!KEY) {
    if (import.meta.env.DEV) return <>{children}</>
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '2rem' }}>
        <div style={{ maxWidth: '32rem' }}>
          <h1>Ansa can't start</h1>
          <p>
            This build has no Clerk publishable key, so there is no way to sign in. It was built
            without <code>VITE_CLERK_PUBLISHABLE_KEY</code> set.
          </p>
          <p>
            Set it in the Pages project (Settings → Environment variables) and redeploy. The value
            starts with <code>pk_</code> and comes from the Clerk dashboard under API keys.
          </p>
        </div>
      </div>
    )
  }
  return (
    <ClerkProvider
      publishableKey={KEY}
      appearance={prefersDark ? { baseTheme: dark } : undefined}
    >
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
