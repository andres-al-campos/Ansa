import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // strictPort so a busy 5173 is an error rather than a silent hop to 5174.
  // build.sh prints and opens this port, and it can't know Vite moved.
  server: { port: 5173, strictPort: true },
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
})
