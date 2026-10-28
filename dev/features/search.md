# Search

Updated 2026-10-28 13:19, at 0.1.0.

Find a task by its text. iOS only; the web has no search.

## Sub-features

- Matches in the project you opened Search from come first, then everything
  else in project order
- Finished matches sink to the end of their group and show dimmed
- With an empty query, Recently visited lists places you've been
- Shows how many matches are in the trash

## How to get to it

- iOS: the Search circle, beside Home at the bottom left; the field grows out of it over the current screen.
- Close it with the ✕ on an empty field, or a tap on bare frost (the header's area included).

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

- A scroll takes the keys down through Search's own focus binding, as a tap
  does, not through `.scrollDismissesKeyboard`. Left to the List, the keys
  slid down while the field snapped to Home's line in one frame, so the
  keyboard seemed to vanish. To check a change here, record the simulator
  (`xcrun simctl io booted recordVideo`) and look at the frames; a
  screenshot after the fact shows the same end state either way.

## Calls

- 2026-10-25 22:59, 0.1.0. Search lies on one seamless frost that blurs the page behind it. No band,
  header ground or row ground of its own cuts across it; the headings and
  cards sit on the frost. Alejandro, on the black stripes: "it should just be
  one seamless background." Applies none.
- 2026-10-27 20:14, 0.1.0. Search is a tool over the screen you are on, not a page you go to, so it
  has no place in Back's path. Its frost covers the header too, light enough
  that the screen shows through as itself, and a tap on bare frost closes
  it. A sharp header over heavy frost read as a new page under the old
  header. Alejandro: "the experience should be it's a tool on top of where
  I'm currently at." Applies none.
- 2026-10-28 13:11, 0.1.0. Search's list starts under the header, so at rest you see where you are,
  and scrolls up to the screen's edge over it. A blurred title band left
  above scrolled results said nothing. A sharp title was the other way out,
  and the Call above already turned it down. Applies none.
- 2026-10-28 13:11, 0.1.0. Dragging the results takes the keyboard down at once: dragging the list
  means you're done typing. The field rises and falls on the grow's curve,
  0.25s both ways; a shorter ease on the way down read as abrupt. Alejandro:
  "dragging on the search result means you're not using the kb so it should
  dismiss it." Applies *Stays under the thumb*.
