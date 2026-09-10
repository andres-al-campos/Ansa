/**
 * Who you're signed in as, and how to sign out.
 *
 * A row at the foot of the sidebar — avatar, name, email — that opens a small
 * popover with the identity line and a Sign out. The web cousin of the iOS
 * home screen's account button (both wrap the same Clerk session), built as a
 * custom control rather than Clerk's `<UserButton>` so it wears the sidebar's
 * type and palette instead of Clerk's own chrome.
 *
 * "Manage account" opens Clerk's profile via `openUserProfile()` — the one
 * place it's worth deferring to Clerk, since re-building profile management is
 * a project of its own.
 */

import { useEffect, useRef, useState } from 'react'
import { useClerk, useUser } from '@clerk/clerk-react'

// The same key AuthGate reads. With no key, AuthGate renders the app outside
// <ClerkProvider> (the dev-stub path), and `useUser`/`useClerk` throw when
// called outside a provider — so the card can't mount its hooks at all. This is
// the web mirror of the iOS `signedIn` gate: no Clerk context, no account card.
const HAS_CLERK = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '') !== ''

function initials(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export default function AccountCard() {
  // The gate can't be a hook (they can't be conditional), so it's a plain
  // branch that decides whether the hook-using inner component mounts at all.
  if (!HAS_CLERK) return null
  return <AccountCardInner />
}

function AccountCardInner() {
  const { user } = useUser()
  const { signOut, openUserProfile } = useClerk()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // Close on a click anywhere outside, and on Escape — the two ways every
  // menu on the platform closes. Only wired while open, so it costs nothing
  // at rest.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // No user means no gate reached this — AccountCard only renders under
  // <SignedIn> — but useUser can report null for a beat while Clerk loads, so
  // render nothing rather than a card with no name in it.
  if (!user) return null

  const email = user.primaryEmailAddress?.emailAddress ?? ''
  const name = user.fullName || email
  const image = user.hasImage ? user.imageUrl : null

  const avatar = image ? (
    <img className="avatar" src={image} alt="" />
  ) : (
    <div className="avatar">{initials(user.fullName, email)}</div>
  )

  return (
    <div className={`account${open ? ' open' : ''}`} ref={wrap}>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-who-line">
            {email ? (
              <div className="who-mail">{email}</div>
            ) : (
              <div className="who-name">{name}</div>
            )}
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void openUserProfile()
            }}
          >
            Manage account
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          >
            Sign out
          </button>
        </div>
      )}
      <button
        className="account-row"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {avatar}
        <span className="who">
          <span className="who-name">{name}</span>
        </span>
        <span className="account-chev" aria-hidden>
          ⌃
        </span>
      </button>
    </div>
  )
}
