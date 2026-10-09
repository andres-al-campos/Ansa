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
- iOS: Back and the edge swipe both go to where you came from, like a
  browser, not to the tree's parent. Home's Back greys out with nowhere to go
- iOS: tapping a nested place's title (marked ⌃⌄) shows the places above it.
  A top-level project's title is plain text: there's nothing above it
- Dormant on web: "leaves only" and "hide completed" views, wired through the
  render but with no toggle

## How to get to it

- Web: click a row's zoom arrow (right edge, on hover), click the bullet to
  fold, click Ansa for Home.
- iOS: swipe a row right to zoom, tap its bullet to fold, Back or an edge
  swipe to return, the title to jump up the tree.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

`npm run drive -- get-around` zooms into Parent with the arrow at the row's
right edge, checks the breadcrumb names the project, then reloads and checks
the app opens on the project.

`ios/build.sh drive get-around` (~60s, simulator) folds and unfolds a branch
with its bullet, zooms in with a full right swipe and comes back with Back,
then relaunches and checks the app lands on the project.

Last driven 2026-10-06, web; 2026-10-09, iOS: ✓, and ✗ against a build whose
bullet didn't fold and one that reopened on Home. Not driven: fold on web,
the desktop back/forward, iOS edge swipe and title jump.

## Gotchas

- Bullets fold on both platforms. They used to zoom; some older comments may
  still say so.
- Every visit stamps the place, and resume and Recently visited (iOS Search)
  read the stamp. Change where every client lands in one function, the shared
  resume rule.
- Folding is stored on the node and synced, so folding on the phone folds on
  the web too.
