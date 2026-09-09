// The Electron main process. Ansa's desktop app is a thin native window around
// the exact same web build the browser app ships — the React app talks to the
// live Worker over HTTPS/WebSocket, so there is no local server to run and
// nothing here but the window, a native menu, and a couple of safety rails.
//
// The web bundle is loaded from `web/` next to this file. `build.sh desktop`
// copies the root `dist/` there after building it with the live API URL and
// Clerk key inlined, so this process needs no configuration of its own — the
// values are already baked into the JS it loads.

const { app, BrowserWindow, Menu, shell } = require('electron')
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')

// The built web app, copied in by build.sh.
const WEB = path.join(__dirname, 'web')

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

// Start the static server on an OS-assigned free port. Resolves with the URL.
function serve() {
  return new Promise((resolve0) => {
    const server = http.createServer((req, res) => {
      const file = resolve(req.url || '/')
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(buf)
      })
    })
    // 127.0.0.1 only — the server exists for this app's own window, and binding
    // loopback keeps it off the network entirely.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve0(`http://127.0.0.1:${port}`)
    })
  })
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    // The traffic lights sit inside the content, which reads as a modern Mac
    // app rather than a web page in a chrome box. The app draws its own top
    // padding, so nothing lands under them.
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      // Nothing here needs Node in the page, so keep the renderer sandboxed.
      // The bundle is ordinary web code that only talks to the Worker.
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.loadURL(url)

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
  const url = await serve()
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
