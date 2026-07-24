import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// jsdom so component tests can render; the pure-logic suites don't care either
// way. The @shared alias mirrors vite.config.ts (vitest doesn't read that one).
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
})
