# Ansa

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## Why this project is worked the way it is

I want to build bigger things, faster. What stops me is being the one who
checks everything and getting pulled into details. So the aim is to need me
once per question, not once per change.

Good code solves the problem it was meant to solve and is consistent with
itself. Two rules follow from that:

- Something clearly broken or missing in this project: fix it, in its own
  commit, and tell me after. Don't ask whether to. Ask first only when the
  fix changes behaviour I may be relying on.
- Two places that decide the same thing differently is a defect. Give the
  rule one home.

How much to build before I look:

- Logic that has a check: as much as the task needs. The check is the sensor.
- Look and feel: one visible change at a time, in front of me (on the phone
  for iOS, not the simulator), then stop. I'm the sensor, and I'm picky.
- At the end of each batch, list what you decided that I didn't tell you,
  each with what it was based on, or the word "guess".

When I step in (a bug I caught, a call I made, a correction), write the why
where the next agent will read it: a law if a machine can check it, the
feature's file, or `designs/principles.md`.

It's a personal app: look, feel and correct logic are the bar, and small
leftovers are fine. A problem you notice in another project gets its own
task, not a tangent.

## Where things are written

- `features/README.md`: what a user can do and the check for each feature.
  Read it before adding or changing one; run the feature's check after.
- `laws/README.md`: rules `./build.sh check` holds the code to.
- `designs/principles.md`: look-and-feel calls and the why behind each, in my
  words. Read it before choosing how something looks or moves, and add to it
  when I make a call. It's kept on this machine, not in the repo.
