# Backup & transfer

Updated 2026-10-25 00:34, at 0.1.0.

Export the whole account as JSON, or replace it from a file. Web only.

## Sub-features

- Export: downloads the tree as a JSON file
- Import: replaces everything with a JSON file, after a confirm
- Shows the account id this tab acts as, for when "my projects are gone" is
  really a different account

## How to get to it

- Web: the Backup & transfer fold at the bottom of the sidebar.

## Driving it

Preconditions: `./build.sh web --no-auth` running.

- `npm run drive -- backup`: exports (Playwright saves the download), imports
  that same file through the confirm, exports again, and checks the two describe
  the same tree. They differ only in key order and in `"pinned": false` written
  out where the first left it implicit.

Last driven 2026-10-06. The import replaces the local `dev` tree; the
round trip leaves it as it was.

## Gotchas

- Import replaces the whole tree for every device at once, and other clients
  get it as a whole tree.
- The file has to be a valid tree; anything else is refused before the confirm.
- The import itself can be undone with ⌘Z in that tab.
