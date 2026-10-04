// The Electron main process. Ansa's desktop app is a thin native window around
// the exact same web build the browser app ships — the React app talks to the
// live Worker over HTTPS/WebSocket, so there is no API server to run. What's
// here is the window, a native menu, a couple of safety rails, and a loopback
// server that only serves the bundle (see PORT below).
//
// The web bundle is loaded from `web/` next to this file. `build.sh desktop`
// copies the root `dist/` there after building it with the live API URL and
// Clerk key inlined, so this process needs no configuration of its own — the
// values are already baked into the JS it loads.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

// The built web app, copied in by build.sh.
const WEB = path.join(__dirname, 'web')

// The loopback server binds this fixed port rather than an OS-assigned one, so
// the app's origin is stable across launches: http://127.0.0.1:41407. The
// Worker's CORS allowlist (ANSA_ALLOWED_ORIGIN) reflects an origin only if it's
// configured, and it can't allow a port that changes every start — so the
// renderer's fetches to the API would be blocked. A fixed port gives the Worker
// one known origin to trust. Chosen from the IANA ephemeral range and otherwise
// arbitrary; it just has to match the allowlisted origin on the Worker.
const PORT = 41407

// Served over a localhost HTTP server rather than loaded from `file://`. Vite
// builds the bundle with absolute asset paths (`/assets/…`) because the web app
// is served from a domain root — under a file origin those resolve to the
// filesystem root and nothing loads, leaving a blank window. A loopback server
// makes `/assets/…` resolve correctly without rebuilding the app differently
// for desktop, so the desktop bundle stays byte-identical to the deployed one.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
}

// Resolve a request path to a file inside WEB, refusing anything that escapes
// it. An SPA, so an unknown path falls back to index.html for client routing.
function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0])
  const full = path.join(WEB, clean)
  if (!full.startsWith(WEB)) return path.join(WEB, 'index.html')
  if (clean === '/' || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return path.join(WEB, 'index.html')
  }
  return full
}

// True enforces the CSP; false sends it report-only, the browser enforcing
// nothing and instead logging a console violation for every resource the policy
// *would* have blocked. Set it false to re-derive the policy after a dependency
// changes what the app loads: exercise the app (sign in, sync, open Manage
// account), read the violations, widen cspValue to cover exactly those, then set
// it back to true. Guessing a policy and enforcing it blind silently breaks
// whatever it forgot; report-only makes the omissions loud.
const CSP_ENFORCE = true

// The origins this bundle actually talks to, written next to it by build.sh from
// the deployment values (the Worker URL, the Clerk instance). Not hardcoded here:
// they are per-deployment, and a committed main.js must stay portable. Absent
// (older bundle, or a hand-built web/) → return null and skip the CSP rather than
// send a broken one.
function cspOrigins() {
  try {
    return JSON.parse(fs.readFileSync(path.join(WEB, 'csp-origins.json'), 'utf8'))
  } catch {
    return null
  }
}

// Build the Content-Security-Policy string. `self` is the loopback origin; the
// app also reaches the Worker over HTTPS and WebSocket, and Clerk over its
// Frontend API plus the shared Clerk/Cloudflare hosts its docs require. The
// script-src `unsafe-inline`/`unsafe-eval` and style-src `unsafe-inline` are
// what ClerkJS (runtime CSS-in-JS) and the bundler need; the report-only run
// will show whether they can be tightened.
function cspValue(origins) {
  const wsApi = origins.api.replace(/^https/, 'wss')
  const clerk = origins.clerkFapi
  const cloudflare = 'https://challenges.cloudflare.com'
  const protect = 'https://*.protect.clerk.com'
  // ClerkJS posts usage events to its own analytics endpoint. Blocking it is
  // harmless to the app but logs a violation on every launch, so allow the one
  // first-party host rather than live with the noise.
  const telemetry = 'https://clerk-telemetry.com'
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${clerk} ${cloudflare} ${protect}`,
    `connect-src 'self' ${origins.api} ${wsApi} ${clerk} ${protect}:* ${telemetry}`,
    `img-src 'self' data: blob: https://img.clerk.com`,
    `style-src 'self' 'unsafe-inline'`,
    `font-src 'self' data:`,
    `frame-src ${cloudflare} ${protect} ${clerk}`,
    `worker-src 'self' blob:`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ')
}

// Start the static server on the fixed loopback port. Resolves with the URL.
function serve() {
  const origins = cspOrigins()
  const csp = origins ? cspValue(origins) : null
  const cspHeader = CSP_ENFORCE
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only'
  return new Promise((resolve0, reject) => {
    const server = http.createServer((req, res) => {
      const file = resolve(req.url || '/')
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }
        // Only the HTML document carries the CSP; it governs everything the page
        // then loads, so tagging every asset response would be redundant.
        if (csp && path.extname(file) === '.html') headers[cspHeader] = csp
        res.writeHead(200, headers)
        res.end(buf)
      })
    })
    // If the port is taken it's almost always a second copy of this app already
    // running; a different port would defeat the fixed-origin point (the Worker
    // allowlist names this exact one), so fail loudly rather than fall back.
    server.on('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${PORT} is already in use — is Ansa already running?\n` +
                `Quit the other copy (or whatever holds 127.0.0.1:${PORT}) and relaunch.`,
            )
          : err,
      )
    })
    // 127.0.0.1 only — the server exists for this app's own window, and binding
    // loopback keeps it off the network entirely.
    server.listen(PORT, '127.0.0.1', () => {
      resolve0(`http://127.0.0.1:${PORT}`)
    })
  })
}

// Drop cookie rows left behind by an earlier port, before Chromium opens the
// store.
//
// Clerk keeps the session in cookies on the app's origin. The cookie store's
// unique key includes the source port, but Chromium's duplicate check keys only
// on (host, path) — so a cookie written under the old random-port origin and
// the same cookie under the fixed port 41407 look like duplicates to it, and it
// logs a `Found N duplicate cookies` error for each at startup. Only the 41407
// rows are reachable now; the old-port rows are dead weight that will never be
// rewritten, so nothing but this ever clears them.
//
// The cookie API can't see the port, so this goes at the SQLite layer through
// the system `sqlite3`. Writing the store while Chromium has it open would
// corrupt it, so this runs before the window (and any request that opens the
// store) and refuses if any process already holds the file — a launch that
// races it simply keeps the stale rows for one more run rather than risking the
// database. macOS ships sqlite3; if it's missing, skip quietly.
function purgeStaleCookies() {
  const store = path.join(app.getPath('userData'), 'Cookies')
  if (!fs.existsSync(store)) return
  try {
    const holders = execFileSync('lsof', ['-t', store], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    // Any holder at all — another copy, or Chromium in this very process having
    // already opened the store — means writing it now could corrupt it. Skip;
    // the stale rows survive one more launch, which is only log noise.
    if (holders) return
  } catch {
    // lsof exits non-zero when nothing holds the file; that's the clear-to-write
    // case, so fall through.
  }
  try {
    execFileSync('sqlite3', [store, `DELETE FROM cookies WHERE source_port <> ${PORT};`], {
      stdio: 'ignore',
    })
  } catch (err) {
    console.warn('Could not purge stale cookies:', err?.message ?? err)
  }
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    // The traffic lights sit inside the content, which reads as a modern Mac
    // app rather than a web page in a chrome box. The web app draws its own
    // toolbar in that band (the `.app.desktop` styles, switched on by the
    // preload flag) — a drag region with the sidebar toggle and back/forward.
    titleBarStyle: 'hiddenInset',
    // Inset the lights from the window's top-left corner. hiddenInset already
    // nudges them in, but the default sits tight against the edge; a little more
    // room gives the toolbar's sidebar run breathing space around them. The
    // toolbar CSS reserves the horizontal clearance (padding-left on the side
    // run); this only sets where macOS draws the lights.
    trafficLightPosition: { x: 19, y: 18 },
    webPreferences: {
      // Nothing here needs Node in the page, so keep the renderer sandboxed.
      // The bundle is ordinary web code that only talks to the Worker.
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.loadURL(url)

  // The desktop toolbar, window drag region, and traffic-light clearance all
  // live in the shared web CSS now, switched on by the `.app.desktop` class the
  // renderer sets from the preload's `ansaDesktop` flag. Nothing to inject here.

  // A link to anywhere but the app's own origin opens in the real browser, not
  // in a second app window with no way back. Clerk's in-page navigation is hash
  // routing on this same origin, so it never trips this.
  const isApp = (target) => target.startsWith(url)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isApp(target)) return { action: 'allow' }
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    if (!isApp(target)) {
      e.preventDefault()
      void shell.openExternal(target)
    }
  })

  return win
}

// A standard Mac menu. Without an explicit one the app has no Edit menu, which
// means no ⌘C/⌘V/⌘Z/⌘A in the outline's text fields — the roles below wire
// those to the focused field for free.
function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  // In a packaged app the .icns in the bundle is the dock icon already. Under
  // `npm start` (the build.sh desktop path) Electron shows its own default
  // icon, so point the dock at the same artwork. A PNG, not the .icns:
  // dock.setIcon wants a raster image and fails to load an icon set.
  if (!app.isPackaged) {
    const icon = path.join(__dirname, 'icon', 'dock.png')
    if (fs.existsSync(icon)) app.dock?.setIcon(icon)
  }

  buildMenu()
  // Before anything opens the cookie store: clear rows from an earlier port so
  // Chromium doesn't log them as duplicates. Guarded against a store in use.
  purgeStaleCookies()
  let url
  try {
    url = await serve()
  } catch (err) {
    // The fixed port was taken (see serve). Show why and quit — a blank window
    // with no explanation is worse than a dialog that names the cause.
    dialog.showErrorBox('Ansa could not start', err.message)
    app.quit()
    return
  }
  createWindow(url)

  // The Mac convention: clicking the dock icon with no windows open makes one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url)
  })
})

// Also the Mac convention: the app stays running when its last window closes,
// so it lives in the dock until explicitly quit. Every other platform quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
