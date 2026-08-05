import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// jsdom so component tests can render; the pure-logic suites don't care either
// way. The @shared alias mirrors vite.config.ts (vitest doesn't read that one).
export default defineConfig({
  test: {
    environment: 'jsdom',
    // Background agent tasks get a git worktree under .claude/worktrees — a full
    // checkout of this repo, nested inside it. Without this, every test file is
    // collected twice: once here and once from a copy pinned to whatever commit
    // that task branched from. The duplicates are stale by construction, and a
    // failure in one reads as a failure here.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**'],
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
})
