# Ansa

Ansa is for problems too big to face as one list. You break a big problem into
medium ones and those into small ones, zoom in on just the part that matters
right now, do it, and zoom back out, so the list never feels like it only keeps
growing.

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## Principles

How Ansa ought to be, so a session can decide a case nobody has met yet. Each
earns its place by deciding Calls, the rulings in `dev/features/`, which end by
naming the principle they apply. Listed in the order they were written; when
two disagree on a case, the owner decides and the winner moves up. The hook in
`dev/hooks/` starts each with the time and version it was made or reworded at.
A rule a machine can check becomes a law instead.

The bar is look, feel and correct logic. It's a personal app, and small
leftovers are fine.

- 2026-10-22 19:10, 0.1.0. **Stays under the thumb.** What the user is touching moves with them
  one-to-one, and what's the same from screen to screen doesn't move, so the
  page always feels like it is in the same place under the thumb.
- 2026-10-28 13:42, 0.1.0. **A touch elsewhere ends what you were doing.** Putting a finger on
  something new says what you are doing now, so whatever you were in the
  middle of gets out of the way without being asked: a drag on Search's
  results takes the keyboard down, and a tap on bare frost closes Search.

What matters a lot, a little, and not at all in Ansa isn't answered yet.

## Where things are written

- `dev/features/README.md`: what a user can do and the check for each feature.
  Read it before adding or changing one; run the feature's check after.
- `tests/README.md`: rules `./build.sh check` holds the code to.
- `designs/`: mockups, kept on this machine and out of the repo.
