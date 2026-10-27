# Search

Updated 2026-10-25 22:53, at 0.1.0.

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
- Search's list has to stay clear for the frost to be its one ground. A
  pinned Section header paints its own ground, and a row with
  `onGeometryChange` applied outside its `listRowBackground` loses its clear
  ground and draws black; either cut a black stripe across the frost. So the
  headings are plain rows, and the mark that finds the list's end sits inside
  the last row's background.

## Calls

- 2026-10-25 22:59, 0.1.0. Search lies on one seamless frost that blurs the page behind it. No band,
  header ground or row ground of its own cuts across it; the headings and
  cards sit on the frost. Alejandro, on the black stripes: "it should just be
  one seamless background." Applies none.
