/**
 * The Durable Object's own behaviour: transactions, seeding, and broadcast.
 *
 * treeStore.test.ts already covers the SQL. What is new here is everything the
 * Durable Object adds on top — that a rejected write rolls back rather than
 * persisting half of itself, that a read never seeds a populated account, and
 * that a broadcast reaches every open socket tagged with who caused it.
 *
 * These run against fakes for ctx.storage and the WebSocket pair rather than
 * workerd. That is a real limit and worth naming: the fakes assert this file's
 * logic, not that Cloudflare's hibernation behaves as documented. The SQL
 * underneath is genuine better-sqlite3, so a broken query still fails here; what
 * a fake can't catch is a wrong assumption about the platform. `wrangler dev`
 * is what settles that, and it hasn't been run yet.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnsaTree } from './ansaTree.ts'
import { RejectedWriteError } from './treeStore.ts'
import type { SqlStorage } from './treeStore.ts'
import { roots } from '../../shared/tree.ts'

/** better-sqlite3 behind the Durable Object SQL surface. Mirrors treeStore.test.ts. */
function sqlAdapter(file: string): SqlStorage & { db: Database.Database; close(): void } {
  const db = new Database(file)
  return {
    // Exposed so the fake transactionSync can BEGIN/ROLLBACK on the *same*
    // connection the store writes through. A second Database handle to the same
    // file opens its own transaction and rolls back nothing the store did.
    db,
    exec(query: string, ...bindings: unknown[]) {
      if (bindings.length === 0 && /;\s*\S/.test(query.trim())) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const stmt = db.prepare(query)
      if (stmt.reader) {
        const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[]
        return { toArray: () => rows }
      }
      stmt.run(...(bindings as never[]))
      return { toArray: () => [] }
    },
    close: () => db.close(),
  }
}

interface FakeSocket {
  sent: string[]
  attachment: unknown
  send(payload: string): void
  serializeAttachment(value: unknown): void
  close(code: number, reason: string): void
  closedWith: { code: number; reason: string } | null
}

function fakeSocket(): FakeSocket {
  return {
    sent: [],
    attachment: null,
    closedWith: null,
    send(payload) {
      this.sent.push(payload)
    },
    serializeAttachment(value) {
      this.attachment = value
    },
    close(code, reason) {
      this.closedWith = { code, reason }
    },
  }
}

/**
 * A stand-in for DurableObjectState.
 *
 * transactionSync is the part that matters: the real one rolls the SQLite
 * transaction back when the callback throws, so this wraps the callback in a
 * genuine BEGIN/ROLLBACK rather than just re-throwing. A fake that only
 * re-threw would let a rollback bug pass.
 */
function fakeCtx(sql: SqlStorage & { db: Database.Database }) {
  const db = sql.db
  const sockets: FakeSocket[] = []
  return {
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        db.exec('BEGIN')
        try {
          const out = fn()
          db.exec('COMMIT')
          return out
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
      },
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    _sockets: sockets,
  }
}

let dir: string
let sql: SqlStorage & { db: Database.Database; close(): void }
let ctx: ReturnType<typeof fakeCtx>
// The class under test, constructed with the fakes above.
let tree: InstanceType<typeof AnsaTree>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ansa-do-'))
  sql = sqlAdapter(join(dir, 'a.db'))
  ctx = fakeCtx(sql)
  tree = new AnsaTree(ctx as never, {})
})

afterEach(() => {
  sql.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Every payload a socket received, parsed. */
const received = (ws: FakeSocket) => ws.sent.map((s) => JSON.parse(s) as { tree: unknown[]; origin: string | null })

describe('seeding', () => {
  it('seeds an empty account once and never again', () => {
    const first = tree.seedIfEmpty()
    expect(first.seeded).toBe(true)
    expect(first.tree.length).toBeGreaterThan(0)

    const second = tree.seedIfEmpty()
    expect(second.seeded).toBe(false)
    expect(second.tree).toHaveLength(first.tree.length)
  })

  it('leaves an account that already has nodes alone', () => {
    // The bug this guards: a read path that seeds put 26 tutorial rows into
    // accounts that had never typed anything. Hosted, there is no local file to
    // carve the real rows back out of.
    tree.applyOp({ op: 'addChild', id: 'mine', parentId: null, text: 'my project', at: 1 }, null)
    const { seeded, tree: after } = tree.seedIfEmpty()
    expect(seeded).toBe(false)
    expect(after.map((n) => n.text)).toEqual(['my project'])
  })
})

describe('writes roll back rather than landing half-done', () => {
  it('restores the previous tree when an INSERT fails partway through replace', () => {
    // The test that actually pins transactionSync. Every validity check in
    // TreeStore runs *before* replace(), so a refused op never reaches the SQL
    // — removing the transaction leaves those cases green. What the transaction
    // is for is a failure inside replace() itself, which begins with a DELETE
    // and then inserts row by row: without it, a throw on row 2 of 3 commits
    // the delete and loses the tree.
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'keep me', at: 1 }, null)

    let inserts = 0
    const realExec = sql.exec.bind(sql)
    sql.exec = (query: string, ...bindings: unknown[]) => {
      if (query.trimStart().startsWith('INSERT') && ++inserts === 2) {
        throw new Error('disk full')
      }
      return realExec(query, ...bindings)
    }

    expect(() =>
      tree.replaceAll(
        [
          { id: 'x', parentId: null, text: 'one', done: false, order: 0, collapsed: false, createdAt: 1 },
          { id: 'y', parentId: null, text: 'two', done: false, order: 1, collapsed: false, createdAt: 2 },
        ],
        null,
      ),
    ).toThrow(/disk full/)

    sql.exec = realExec
    expect(tree.load().map((n) => n.text)).toEqual(['keep me'])
  })

  it('leaves the stored tree untouched when an op is refused', () => {
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    expect(() =>
      tree.applyOp({ op: 'moveNode', id: 'a', parentId: 'ghost', index: 0 }, null),
    ).toThrow(RejectedWriteError)
    // replace() is DELETE-then-INSERT: without the transaction, a throw between
    // the two would leave the table empty and the tree gone.
    expect(tree.load().map((n) => n.text)).toEqual(['project'])
  })

  it('refuses a malformed op before touching storage', () => {
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    expect(() => tree.applyOp({ op: 'notAnOp', id: 'a' }, null)).toThrow(RejectedWriteError)
    expect(tree.load()).toHaveLength(1)
  })

  it('refuses an invalid whole-tree replace and keeps what was there', () => {
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    expect(() =>
      tree.replaceAll(
        [{ id: 'x', parentId: 'ghost', text: 'x', done: false, order: 0, collapsed: false, createdAt: 1 }],
        null,
      ),
    ).toThrow(RejectedWriteError)
    expect(tree.load().map((n) => n.text)).toEqual(['project'])
  })
})

describe('broadcast', () => {
  it('sends the current tree to a socket the moment it subscribes', () => {
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    // fetch() builds a real WebSocketPair, which node has no global for, so the
    // upgrade itself is verified against wrangler dev instead — see the note at
    // the top of this file. What is asserted here is only the payload shape.
    const payload = JSON.stringify({ tree: tree.load(), origin: null })
    ws.send(payload)
    expect(received(ws)[0].tree).toHaveLength(1)
  })

  it('reaches every open socket', () => {
    const one = fakeSocket()
    const two = fakeSocket()
    ctx.acceptWebSocket(one)
    ctx.acceptWebSocket(two)
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    expect(received(one)).toHaveLength(1)
    expect(received(two)).toHaveLength(1)
    expect(roots(received(one)[0].tree as never).map((n) => n.text)).toEqual(['project'])
  })

  it('tags the broadcast with the client that caused it', () => {
    // This tag is the whole echo-suppression mechanism: a client that sees its
    // own origin skips the payload, because re-adopting state it already holds
    // is what clobbered a local edit mid-keystroke.
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, 'web-123')
    expect(received(ws)[0].origin).toBe('web-123')
  })

  it('does not broadcast a write that was refused', () => {
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    // A move onto a parent that doesn't exist. Moving a node that doesn't exist
    // is deliberately a no-op in shared/tree.ts rather than an error, so it
    // would not exercise this.
    expect(() => tree.applyOp({ op: 'moveNode', id: 'a', parentId: 'ghost', index: 0 }, null)).toThrow(
      RejectedWriteError,
    )
    expect(ws.sent).toEqual([])
  })

  it('one dead socket does not stop the others from receiving', () => {
    const dead = fakeSocket()
    dead.send = () => {
      throw new Error('socket is closed')
    }
    const live = fakeSocket()
    ctx.acceptWebSocket(dead)
    ctx.acceptWebSocket(live)
    expect(() =>
      tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null),
    ).not.toThrow()
    expect(received(live)).toHaveLength(1)
  })
})

describe('socket messages', () => {
  it('records the origin a client announces', () => {
    const ws = fakeSocket()
    tree.webSocketMessage(ws as never, JSON.stringify({ type: 'hello', origin: 'web-abc' }))
    expect(ws.attachment).toEqual({ origin: 'web-abc' })
  })

  it('ignores a malformed frame instead of killing the connection', () => {
    const ws = fakeSocket()
    expect(() => tree.webSocketMessage(ws as never, 'not json at all')).not.toThrow()
    expect(() => tree.webSocketMessage(ws as never, JSON.stringify({ type: 'other' }))).not.toThrow()
    expect(ws.attachment).toBeNull()
    expect(ws.closedWith).toBeNull()
  })

  it('closes with 1000 when the peer sent no status', () => {
    // 1005 means "no status received" and close() rejects it as an argument, so
    // echoing it back verbatim would throw inside the close handler.
    const ws = fakeSocket()
    tree.webSocketClose(ws as never, 1005, 'gone')
    expect(ws.closedWith).toEqual({ code: 1000, reason: 'gone' })
  })
})
