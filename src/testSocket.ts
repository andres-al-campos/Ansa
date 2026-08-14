/**
 * A WebSocket that does nothing, for tests that aren't about sync.
 *
 * Without it those tests open a real socket. jsdom implements WebSocket for
 * real, so rendering the outliner starts an actual connection to
 * ws://localhost:4000 — which useOutlinerSync then retries with backoff when it
 * fails. Nothing usually listens there, so it passes; but the suite quietly
 * behaves differently when a dev server *is* running, and a test that depends on
 * what else is running on the machine is not a test.
 *
 * These files stubbed EventSource for exactly this reason, and kept doing it
 * after the client moved to WebSockets. That stub silenced a global jsdom
 * doesn't define and nothing constructs, so it had been doing nothing at all.
 *
 * Deliberately inert rather than a fake that can emit: a test that wants to
 * drive the server's side of sync wants Outliner.sync.test.tsx's FakeSocket,
 * which records and replays. This one only needs to not connect.
 */

import { vi } from 'vitest'

class SilentSocket {
  onmessage: ((e: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {}
  send() {}
  close() {}
}

/** Stub the global WebSocket. Pair with `vi.unstubAllGlobals()` in afterEach. */
export function silenceSocket(): void {
  vi.stubGlobal('WebSocket', SilentSocket as unknown as typeof WebSocket)
}
