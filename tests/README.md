# Checks

What must never happen, checked by `./build.sh check`; the rows that run on
the stack or a simulator only with `--drives`. The feature map
(`dev/features/`) says what must be possible; these say what must not.

Each check fails saying where the rule broke and how to fix it. A new one must be
shown to fail once against a broken copy, made in a throwaway `git worktree`
rather than this checkout.

| Check | Kind | Holds |
|---|---|---|
| `no-two-axis-scroll.mjs` | rendering test | the web app never scrolls sideways and nothing in it scrolls both ways, on Home and a long project, at phone and desktop widths. Runs with `--drives` |
| `no-two-axis-scroll.sh` | lint | no SwiftUI `ScrollView` in `ios/Sources` is written to scroll on both axes. Source text only; on iOS nothing measures the running app |
| `no-ios-warnings.sh` | test | an iOS build that recompiles every one of Ansa's files prints no warnings, apart from App Intents' note that it skipped a framework Ansa does not use |
| `feature-map.mjs` | lint | every row in `dev/features/README.md` has a file and every file a row; every file's Driving it leads each check with a command, and each named drive (`scripts/drive.mjs`) and iOS UI test (`ios/UITests/`) exists |
| `doc-stamps.mjs` | lint | feature files and their index carry an `Updated` stamp, every Principle and Call starts with a time and a version Ansa has had, and every Principle a Call cites exists |
| `row-gestures.sh` | lint | the iOS row arms its drag with `.simultaneousGesture(armGesture)` and the bullet's fold tap stays `.highPriorityGesture(bulletGesture)`, which no UI test can check |
| `build-failed.sh` | test | a failed build in `ios/build.sh` stops on its "Build failed" message rather than ending on xcodebuild's last line, and a successful build whose output `grep` doesn't match carries on |
| `release-dmg.sh` | lint | `release.sh` builds the Mac app into a DMG and attaches that, never a zip |
