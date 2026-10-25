# Search

Updated 2026-10-25 00:34, at 0.1.0.

Find a task by its text. iOS only; the web has no search.

## Sub-features

- Matches in the project you opened Search from come first, then everything
  else in project order
- Finished matches sink to the end of their group and show dimmed
- With an empty query, Recently visited lists places you've been
- Shows how many matches are in the trash

## How to get to it

- iOS: the Search circle, beside Home at the bottom left; the field grows out of it over the current screen.

## Driving it

Preconditions: `./build.sh web --no-auth` running (the drive needs only its Worker).

- `ios/build.sh drive search` (~100s, most of it the build): makes a project
  holding "Call the zebra keeper" plus a word nothing else has, searches that
  word from Home, checks the task is listed with its project beneath, taps it
  and checks the project opened. Then it deletes the project for good.

Last driven 2026-10-08: ✓, and ✗ against a build whose matching was broken.

## Gotchas

- The matching rule lives only in the Swift code. Search on the web would need
  it ported to the shared TypeScript model first, or the two will disagree.
- The simulator tool's screenshot can keep returning the frame from the
  middle of the page's grow animation while the app has moved on. When the
  screen looks frozen, check with `xcrun simctl io booted screenshot`.
