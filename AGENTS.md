# Ansa

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## How this project is worked

The aim is that each question gets decided once, and that a wrong path is
cheap to back out of.

- Size a batch of work by what can judge it. Where a check can, build as much
  as the task needs: the check is the sensor. Where only a person using it
  can (how it looks, how a gesture feels), make one visible change, put it in
  front of them on the real device, and stop. A wrong guess then costs one
  batch.
- At the end of each batch, list what was decided without being told, each
  with what it was based on, or the word "guess". A choice nobody recorded
  hardens into the code and reads later as if it had been made on purpose.
- When a call or a correction is made, write its why where the next session
  reads it: a law if a machine can check it, the feature's file, or the
  Principles below.
- A problem noticed in another project gets its own task. A session holds one
  project's context, and a tangent spends it.

The bar here is look, feel and correct logic. It's a personal app, and small
leftovers are fine.

## Principles

What has been decided and why. Add a line with the why and the date when a
call is made. A rule a machine can check becomes a law instead; a fact about
one feature goes in its file.

0. Good code solves the problem it was meant to solve and is consistent with
   itself.
   - Something clearly broken or missing in this project: fix it, in its own
     commit, and report it after. Don't ask whether to. Ask first only when
     the fix changes behaviour a user may be relying on.
   - Two places that decide the same thing differently is a defect. Give the
     rule one home.

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
