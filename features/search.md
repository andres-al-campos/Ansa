# Search

Find a task by its text. iOS only; the web has no search.

## Sub-features

- Matches in the project you opened Search from come first, then everything
  else in project order
- Finished matches sink to the end of their group and show dimmed
- With an empty query, Recently visited lists places you've been
- Shows how many matches are in the trash

## How to get to it

- iOS: the Search pill; the page grows from it over the current screen.

## Driving it

Preconditions: `ios/build.sh sim --no-auth` running against `./build.sh web --no-auth`.

1. Open Search, type part of a task's text.
2. Expected: the task is listed under Results with the match highlighted and
   its project beneath; tapping it opens that project.

Driven by hand 2026-10-06: "zebra" found "Call the zebra keeper" from Home and
opened drive search. No repeatable drive yet; the app has no UI test target.

## Gotchas

- The matching rule lives only in the Swift code. Search on the web would need
  it ported to the shared TypeScript model first, or the two will disagree.
- The simulator tool's screenshot can keep returning the frame from the
  middle of the page's grow animation while the app has moved on. When the
  screen looks frozen, check with `xcrun simctl io booted screenshot`.
