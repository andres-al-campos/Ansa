# Get around

Find your way through the outline: Home, projects, zooming into any task, and
back out.

## Sub-features

- Home: pinned shelf, then projects (web sidebar plus a Home grid; iOS Home)
- Zoom into any task so it fills the screen; breadcrumbs lead back out
- Fold and unfold a branch
- On open, lands in the project you last worked in, on any device (it follows
  the account, not the device)
- Desktop app: back / forward buttons and a sidebar toggle
- iOS: back follows where you came from, not the tree's parent; long-press
  Back shows the path
- Dormant on web: "leaves only" and "hide completed" views, wired through the
  render but with no toggle

## How to get to it

- Web: click a row's zoom arrow (right edge, on hover), click the bullet to
  fold, click Ansa for Home.
- iOS: swipe a row right to zoom, tap its bullet to fold, Back to return.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

`npm run drive -- get-around` zooms into Parent with the arrow at the row's
right edge, checks the breadcrumb names the project, then reloads and checks
the app opens on the project.

Last driven 2026-10-06, web. Not driven: fold, the desktop back/forward, iOS.

## Gotchas

- Bullets fold on both platforms. They used to zoom; some older comments may
  still say so.
- Every visit stamps the place, and resume and Recently visited (iOS Search)
  read the stamp. Change where every client lands in one function, the shared
  resume rule.
- Folding is stored on the node and synced, so folding on the phone folds on
  the web too.
