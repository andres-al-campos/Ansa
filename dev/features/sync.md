# Sign in and sync

Updated 2026-10-25 00:34, at 0.1.0.

One account, every device. An edit on any device shows up on the others
without a reload, and edits made offline go out on reconnect.

## Sub-features

- Sign in with Clerk; sign out from the account menu
- Live updates over a WebSocket on web and iOS
- Offline edits are queued and survive the app being closed or killed
- First paint comes from a local copy, then the server's tree replaces it.
  On web, edits made before it arrives stay on screen and are sent after it
- A client that has drifted from the server notices and reloads the tree
- Web: a floating toast when the live connection is down, or an edit was
  refused; iOS: a banner

## How to get to it

- Sign-in appears on first open (skipped locally). Sync needs nothing.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- sync`: opens the project in two tabs, renames Child A in
  one, and checks the other shows the new name without a reload.

`npx vitest run src/Outliner.sync.test.tsx` covers the first tree landing
mid-edit: a ticked box stays ticked, and a project being named keeps its name
field and is created with the name. It also covers a tree landing while an
edit waits out an unreachable server, and a refused edit coming off screen
without taking the edit queued behind it.

`ios/build.sh test` covers the same on iOS (the sync client's "unsent edits on
screen" tests): a tick and an add made before the first tree stay on screen,
as do edits left unsent by the last launch and edits waiting out a reconnect.
A fold doubled by a tree that already had it is set right by the drift reload
once its echo arrives.

Last driven 2026-10-06, web. On iOS, run once by hand on 2026-10-10 in the
simulator with the local Worker frozen until after a tick and a delete: before
the fix the box flipped back and stayed unticked for 40s over a server that
had it done; after, both held. Not driven: the toast.

The offline queue has no drive; tests cover it. Web
(`src/Outliner.sync.test.tsx`, `src/storage.test.ts`): a stalled queue retries
without another edit, a queue left by a killed run is sent on the next one,
and a refused edit doesn't take the one behind it. iOS (`ios/build.sh test`,
the op queue and sync client suites): the queue survives a relaunch, stops at
an unreachable server and discards a rejected op.

## Gotchas

- The web's local copy and unsent-edit queue are per browser, not per account,
  and sign-out clears neither. A second account on the same browser briefly
  sees the first one's tree.
- A blocked WebSocket (an ad-blocker rule against workers.dev did it once)
  leaves the app looking healthy while missing every remote edit; the toast is
  the only sign.
- An edit replayed after a crash can apply twice; a repeated fold flips back.
  The same goes for the screen when a tree lands while a sent op is still
  queued: an add is recognised and skipped, an indent or a fold is not, and
  shows doubled until the drift check reloads the tree (tested on iOS, not on
web).
