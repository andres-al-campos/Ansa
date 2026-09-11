/**
 * A structural mock of `@clerk/clerk-react` for tests that render the Outliner.
 *
 * The Outliner renders <AccountCard>, which calls `useUser`/`useClerk`. Those
 * hooks assert they're inside a <ClerkProvider> and throw otherwise — and the
 * tests render the Outliner bare, with no provider and no network. Worse, the
 * card only *reaches* its hooks when a publishable key is present, and build.sh
 * exports one from the Keychain before `npm test`, so the throw appears under
 * the real deploy but not under a bare `vitest run`. Stub the two hooks the
 * card touches, signed-out, so it renders nothing.
 *
 * Mirrors the inline mock in AuthGate.test.tsx; factored here because every
 * Outliner.*.test.tsx needs the same one. Use it as:
 *   vi.mock('@clerk/clerk-react', () => clerkMock())
 */
export function clerkMock() {
  return {
    // Signed-out: the card gates on `user` and renders nothing when it's null.
    useUser: () => ({ user: null, isLoaded: true, isSignedIn: false }),
    useClerk: () => ({ signOut: async () => {}, openUserProfile: () => {} }),
  }
}
