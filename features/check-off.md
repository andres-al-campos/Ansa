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

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- check-off`: ticking one child leaves the parent open,
  ticking both completes it, unticking one reopens it.
- `npm run drive -- check-off-home`: the Home card reads "0 of 2 done (0%)",
  then "1 of 2 done (50%)", then "All done".

Last driven 2026-10-06, web.

## Gotchas

- A parent's done state is derived, not stored independently. Any change that
  moves, adds or removes children re-derives it, so a parent can flip to done
  or back without anyone ticking it.
- A task's own tick isn't kept while it has children. Tab a finished task
  under an open one and the open one ticks; Shift-Tab it back out and it stays
  ticked. The mirror case unticks a finished task the same way. Accepted
  (2026-10-06): keeping the tick needs a stored field in both apps, and the
  cheaper "untick when the last child leaves" rule reopens finished projects
  when their last task is deleted.
- "Hide completed" exists in the web code with no toggle (see
  [Get around](get-around.md)); re-adding it is a markup change.
