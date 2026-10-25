import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Point `cloudflare:workers` at a local stub so the worker tests can run.
 *
 * A resolve.alias doesn't work: Vite treats `cloudflare:` as an external
 * protocol scheme and skips alias resolution for it, and vi.mock is too late
 * because import analysis has already failed. A pre-enforced resolveId runs
 * early enough.
 *
 * This lives here rather than in vite.config.ts because vitest doesn't read
 * that one, and because wrangler has the real module — the stub never reaches
 * anything that ships.
 */
function cloudflareStub(): Plugin {
  const stub = fileURLToPath(new URL('./worker/test/cloudflareStub.ts', import.meta.url))
  return {
    name: 'ansa:cloudflare-workers-stub',
    enforce: 'pre',
    resolveId: (id) => (id === 'cloudflare:workers' ? stub : null),
  }
}

// jsdom so component tests can render; the pure-logic suites don't care either
// way. The @shared alias mirrors vite.config.ts (vitest doesn't read that one).
export default defineConfig({
  plugins: [cloudflareStub()],
  test: {
    environment: 'jsdom',
    // Background agent tasks get a git worktree under .claude/worktrees — a full
    // checkout of this repo, nested inside it. Without this, every test file is
    // collected twice: once here and once from a copy pinned to whatever commit
    // that task branched from. The duplicates are stale by construction, and a
    // failure in one reads as a failure here. ios/build holds the iOS
    // packages' checkouts, and clerk-ios ships tests of its own.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**', 'ios/build/**'],
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
})
