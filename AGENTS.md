# Ansa

A Workflowy-style outliner: a React web app, a Cloudflare Worker, an iOS app
and an MCP server over one tree. `./build.sh` is the entry point; `ios/` has
its own `AGENTS.md`.

## Why this project is worked the way it is

I want to build bigger things, faster. What stops me is being the one who
checks everything and getting pulled into details. So the aim is to need me
once per question, not once per change.

- Whenever I had to step in (a bug I caught, a call I made, a correction),
  write down the why where the next agent will read it: a law if a machine
  can check it, the feature's file, or `designs/principles.md`.
- Where the why is already written, act on it without me.
- Where it isn't, get something in front of me fast and say what you
  inferred. Today that's mostly look and feel: I'm picky about it, and on iOS
  it's judged by thumb on the phone, not in the simulator.
- Checking only has to be good enough that I don't find logic breaks by
  using the app. It's a personal app: look, feel and correct logic are the
  bar, and small leftovers are fine.
- A problem you notice in another project gets its own task, not a tangent.

## Where things are written

- `features/README.md`: what a user can do and the check for each feature.
  Read it before adding or changing one; run the feature's check after.
- `laws/README.md`: rules `./build.sh check` holds the code to.
- `designs/principles.md`: look-and-feel calls and the why behind each, in my
  words. Read it before any design change, and add to it when I make a call.
  It's kept on this machine, not in the repo.
