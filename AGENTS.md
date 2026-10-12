# Ansa

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## Why this project is worked the way it is

I want to build bigger things, faster. What stops me is being the one who
checks everything and getting pulled into details. So the aim is to need me
once per question, not once per change.

How much to build before I look:

- Logic that has a check: as much as the task needs. The check is the sensor.
- Look and feel: one visible change at a time, in front of me (on the phone
  for iOS, not the simulator), then stop. I'm the sensor, and I'm picky.
- At the end of each batch, list what you decided that I didn't tell you,
  each with what it was based on, or the word "guess".

It's a personal app: look, feel and correct logic are the bar, and small
leftovers are fine. A problem you notice in another project gets its own
task, not a tangent.

## Principles

What I've decided and why, so I decide it once. When I step in with a call or
a correction, add a line here with the why and the date. A rule a machine can
check becomes a law instead; a fact about one feature goes in its file.

0. Good code solves the problem it was meant to solve and is consistent with
   itself.
   - Something clearly broken or missing in this project: fix it, in its own
     commit, and tell me after. Don't ask whether to. Ask first only when the
     fix changes behaviour I may be relying on.
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
