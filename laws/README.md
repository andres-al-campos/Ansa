# Laws

What must never happen, checked by `./build.sh check`. The feature map
(`features/`) says what must be possible; these say what must not.

Each law fails saying where the rule broke and how to fix it. A new law must be
shown to fail once against a broken copy, made in a throwaway `git worktree`
rather than this checkout.

| Law | Checks |
|---|---|
| `no-two-axis-scroll.mjs` | the web app never scrolls sideways and nothing in it scrolls both ways, on Home and a long project, at phone and desktop widths |
| `no-two-axis-scroll.sh` | no SwiftUI `ScrollView` in `ios/Sources` is written to scroll on both axes. Source text only; the next row measures |
| `ios/build.sh drive no-two-axis-scroll` | on the running iOS app, holding a 136-letter word alone and eight levels deep: nothing on Home, a project (also after turning to landscape and back), a row being edited, Search or Trash reaches past the screen's sides, and a sideways or diagonal drag leaves Home, a project and Trash where they were. Runs with the iOS drives |
| `no-ios-warnings.sh` | a clean iOS build prints no warnings, apart from App Intents' note that it skipped a framework Ansa does not use |
| `feature-map.mjs` | every row in `features/README.md` has a file and every file a row; every file's Driving it leads each check with a command, and each named drive (`scripts/drive.mjs`) and iOS UI test (`ios/UITests/`) exists |
| `row-gestures.sh` | the iOS row arms its drag with `.simultaneousGesture(armGesture)` and the bullet's fold tap stays `.highPriorityGesture(bulletGesture)`, which no UI test can check |
