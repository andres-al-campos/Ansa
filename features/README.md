# Ansa features

What a user can do with Ansa, how to reach it, and how to drive it. Read this
before adding anything: if it's already here, extend it instead of building it
again. Several features exist on one platform only; the file says which.

| Feature | File | Platforms | Driveable headless? |
|---|---|---|---|
| Outline a project | [outline.md](outline.md) | web, iOS | Yes, web (2026-10-04) |
| Check things off | [check-off.md](check-off.md) | web, iOS | Not yet proven |
| Reorganize | [reorganize.md](reorganize.md) | web, iOS | Not yet proven |
| Get around | [get-around.md](get-around.md) | web, iOS | Not yet proven |
| Pin | [pin.md](pin.md) | web, iOS | Not yet proven |
| Search | [search.md](search.md) | iOS only | Not yet proven |
| Trash | [trash.md](trash.md) | web, iOS | Not yet proven |
| Backup & transfer | [backup.md](backup.md) | web only | Partly: the export is a browser download |
| Sign in and sync | [sync.md](sync.md) | web, iOS | Not yet proven |
| Let a Claude work on it | [mcp.md](mcp.md) | MCP | Not yet proven |

## What counts as a feature

Something a user sets out to do, with its own way in. A sub-feature is
something you only reach inside a feature. When in doubt, keep features
separate rather than merging them.

## Each file has

- **Sub-features**: the selling points; the README's feature list comes from these.
- **How to get to it**: the user's path, per platform.
- **Driving it**: preconditions, then steps an agent can follow, or why it's blocked.
- **Gotchas**: what has bitten us, or will.

## Keeping it current

Update a feature's file in the same commit that changes the feature. Write
only what a user can do and observe: paths, commands, results. Code locations
are left out on purpose; read the code when a task needs them.

## Driving conventions

- `./build.sh web --no-auth` runs the Worker under `wrangler dev` on :8787 and
  the app on http://localhost:5173, with throwaway local storage and no
  sign-in: the dev auth stub makes every local client the user `legacy`, so
  the web app, a local MCP and the simulator all edit one tree. Use it for
  driving. Plain `./build.sh web` shows a sign-in wall on a machine with the
  Clerk secret in the Keychain.
- Doctor: `curl http://127.0.0.1:8787/api/health` should answer
  `{"ok":true,"auth":"dev"}` before driving.
- `ios/build.sh sim --no-auth` runs the iOS app in a simulator against that
  local Worker, without the sign-in wall. Plain `ios/build.sh` installs on the
  phone against the live Worker.
- `./build.sh` (no argument) installs and launches the desktop app, which talks
  to the live Worker: real data, so not for experiments. `./build.sh desktop`
  is a hot-reload window.
- The desktop app is the web build in a window. It adds back/forward and a
  sidebar toggle; everything else in these files applies to it as web.
- A feature counts as working when it was driven the way a user would and left
  evidence: a screenshot, a log line, a file.
