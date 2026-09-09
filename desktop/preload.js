// Nothing to bridge. The web app is self-contained and talks only to the
// Worker, so the renderer needs no privileged API from the main process. This
// file exists because a preload keeps contextIsolation meaningful — an empty
// one is the correct amount of surface to expose.
