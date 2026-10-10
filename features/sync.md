# Sign in and sync

One account, every device. An edit on any device shows up on the others
without a reload, and edits made offline go out on reconnect.

## Sub-features

- Sign in with Clerk; sign out from the account menu
- Live updates over a WebSocket on web and iOS
- Offline edits are queued and survive the app being closed or killed
- First paint comes from a local copy, then the server's tree replaces it
- A client that has drifted from the server notices and reloads the tree
- Web: a floating toast when the live connection is down, or an edit was
  refused; iOS: a banner

## How to get to it

- Sign-in appears on first open (skipped locally). Sync needs nothing.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- sync`: opens the project in two tabs, renames Child A in
  one, and checks the other shows the new name without a reload.

Last driven 2026-10-06, web. Not driven: the offline queue, drift reload, the
toast, iOS.

## Gotchas

- The web's local copy and unsent-edit queue are per browser, not per account,
  and sign-out clears neither. A second account on the same browser briefly
  sees the first one's tree.
- A blocked WebSocket (an ad-blocker rule against workers.dev did it once)
  leaves the app looking healthy while missing every remote edit; the toast is
  the only sign.
- On iOS, edits queued before a kill disappear from the screen after relaunch
  until the drift check reloads the tree (traced in code, not run).
- An edit replayed after a crash can apply twice; a repeated fold flips back.
