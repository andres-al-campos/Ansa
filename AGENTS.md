# Ansa

Ansa is for problems too big to face as one list. You break a big problem into
medium ones and those into small ones, zoom in on just the part that matters
right now, do it, and zoom back out, so the list never feels like it only keeps
growing.

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## Principles

The whys behind how Ansa ought to be, so a session can decide a case nobody
has met yet, and see where a rule stops. Each earns its place by deciding Calls, the rulings in `dev/features/`, which end by
naming the principle they apply. Listed in the order they were written; when
two disagree on a case, the owner decides and the winner moves up. The hook in
`dev/hooks/` starts each with the time and version it was made or reworded at.
A rule a machine can check becomes a law instead.

The bar is look, feel and correct logic. It's a personal app, and small
leftovers are fine.

- 2026-10-28 14:05, 0.1.0. **Feels like a real object.** What you touch moves with you as a thing in
  your hand would, and what you aren't touching stays put. Why: it should feel
  like handling something real, and when the screen breaks that, it jars.
- 2026-10-28 14:05, 0.1.0. **A touch elsewhere ends what you were doing.** A drag on Search's results
  takes the keyboard down, and a tap on bare frost closes Search, without
  being asked. Why: where you put your finger says what you are doing now,
  and making you tidy up the last thing first is a chore the app can do.

What matters, and how much:

- 2026-10-28 23:01, 0.1.0. A lot: the part you're zoomed into, and seeing it shrink. Progress counts
  leaves, so splitting a task doesn't set you back and every tick moves it.
- 2026-10-28 23:01, 0.1.0. A little: breaking things down and getting around (add, split, move, zoom
  in and out). They happen constantly, so they cost as close to nothing as
  they can.
- 2026-10-28 23:01, 0.1.0. Not at all: everything outside the zoom. Seeing the whole problem at once
  is what Ansa spares you; the breadcrumbs say the rest is there.

Done rows stay where they were ticked: hiding or moving them would pull rows
out from under the thumb, and they read as progress. A long flat list of done
rows is usually small items, cheap to scan and cheap to move or nest by hand,
so reorganizing stays easy instead of the app doing it. Deleting waits until a
whole branch is done, since deleting done rows takes their share of the
progress with them.

## Where things are written

- `dev/features/README.md`: what a user can do and the check for each feature.
  Read it before adding or changing one; run the feature's check after.
- `tests/README.md`: rules `./build.sh check` holds the code to.
- `designs/`: mockups, kept on this machine and out of the repo.
