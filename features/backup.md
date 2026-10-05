# Backup & transfer

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

Partly blocked: Export is a browser download. Import can be driven with a file
input and a confirm dialog.

## Gotchas

- Import replaces the whole tree for every device at once, and other clients
  get it as a whole tree.
- The file has to be a valid tree; anything else is refused before the confirm.
- The import itself can be undone with ⌘Z in that tab.
