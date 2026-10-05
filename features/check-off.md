# Check things off

Mark tasks done and see how far along a project is.

## Sub-features

- A parent is done exactly when all its children are: ticking a parent
  completes its subtree, unticking a child un-does its ancestors
- Adding a subtask to a finished task makes it unfinished again
- Progress counts leaves, so a branch with 20 leaves weighs 20 times one with 1
- A ripple of wiggles runs down a branch that just finished
- Web Home cards show "N of M done (P%)" or "All done"; iOS shows done/total

## How to get to it

- Web: the checkbox on a row, or ⌘/Ctrl+D while editing it.
- iOS: the checkbox on a row.

## Driving it

Preconditions: `./build.sh web --no-auth` running, a project with a parent and two
children.

1. Tick both children.
2. Expected: the parent shows done, and the Home card's count rises by 2.

## Gotchas

- A parent's done state is derived, not stored independently. Any change that
  moves, adds or removes children re-derives it, so a parent can flip to done
  or back without anyone ticking it.
- "Hide completed" exists in the web code with no toggle (see
  [Get around](get-around.md)); re-adding it is a markup change.
