# Ansa

Ansa is for problems too big to face as one list. You break a big problem into
medium ones and those into small ones, zoom in on just the part that matters
right now, do it, and zoom back out, so the list never feels like it only keeps
growing.

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## Principles

What has been decided about Ansa and why. Add a line with the why and the
date when a call is made. A rule a machine can check becomes a law instead; a
fact about one feature goes in its file.

The bar is look, feel and correct logic. It's a personal app, and small
leftovers are fine.

Look and feel:

- What is the same from screen to screen doesn't move. On an iOS back swipe
  only the list slides; the header and bottom buttons stay, and the titles
  cross-fade at half the screen's width, as iOS does. Why: less distraction.
  (2026-10-10)
- A back swipe tracks the finger one-to-one, so the page always feels like
  it is in the same place under the thumb. (2026-10-10)

What matters a lot, a little, and not at all in Ansa isn't answered yet.

## Where things are written

- `features/README.md`: what a user can do and the check for each feature.
  Read it before adding or changing one; run the feature's check after.
- `laws/README.md`: rules `./build.sh check` holds the code to.
- `designs/`: mockups, kept on this machine and out of the repo.
