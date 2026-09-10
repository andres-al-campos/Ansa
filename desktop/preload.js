// A minimal, safe bridge. The web app is self-contained and talks only to the
// Worker, so the renderer needs no privileged API from the main process — the
// one thing it does need to know is that it's running inside the desktop shell,
// so it can show the native-style toolbar (traffic-light clearance, window
// drag region, sidebar toggle, back/forward) that the browser build has no use
// for. A single boolean is the whole surface, exposed through contextBridge so
// contextIsolation stays meaningful.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('ansaDesktop', true)
