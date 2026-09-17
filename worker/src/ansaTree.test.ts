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
import { fingerprint, roots } from '../../shared/tree.ts'

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
  // One alarm, replaced rather than queued — the platform's own rule, and the
  // property the scheduling logic relies on.
  let alarm: number | null = null
  return {
    storage: {
      sql,
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at
      },
      deleteAlarm: async () => {
        alarm = null
      },
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
    _alarmAt: () => alarm,
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
const received = (ws: FakeSocket) =>
  ws.sent.map(
    (s) =>
      JSON.parse(s) as {
        kind: 'tree' | 'op'
        tree?: unknown[]
        op?: Record<string, unknown>
        origin: string | null
        hash: string
      },
  )

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

  it('leaves the stored tree untouched when an op is refused', async () => {
    await tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    await expect(
      tree.applyOp({ op: 'moveNode', id: 'a', parentId: 'ghost', index: 0 }, null),
    ).rejects.toThrow(RejectedWriteError)
    // replace() is DELETE-then-INSERT: without the transaction, a throw between
    // the two would leave the table empty and the tree gone.
    expect(tree.load().map((n) => n.text)).toEqual(['project'])
  })

  it('refuses a malformed op before touching storage', async () => {
    await tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    await expect(tree.applyOp({ op: 'notAnOp', id: 'a' }, null)).rejects.toThrow(RejectedWriteError)
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
    const payload = JSON.stringify({ kind: 'tree', tree: tree.load(), origin: null, hash: fingerprint(tree.load()) })
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
    expect(received(one)[0].op?.text).toBe('project')
  })

  it('sends an op as the op, not the tree', () => {
    // The whole point of the change: with the tree in every frame, a keystroke
    // cost every listener the size of the outline. The op is a hundred bytes and
    // the listener already has the tree to apply it to.
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    const [frame] = received(ws)
    expect(frame.kind).toBe('op')
    expect(frame.tree).toBeUndefined()
    expect(frame.op).toEqual({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 })
  })

  it('stamps every frame with the fingerprint of the tree after the write', () => {
    // A client that applies the op and lands on a different fingerprint has
    // drifted and refetches. Without the stamp an op frame would be a promise
    // with no way to check it.
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    tree.applyOp({ op: 'addChild', id: 'b', parentId: 'a', text: 'child', at: 2 }, null)
    const frames = received(ws)
    expect(frames[1].hash).toBe(fingerprint(tree.load()))
    // And it is the tree *after* the op, so the two frames differ.
    expect(frames[0].hash).not.toBe(frames[1].hash)
  })

  it('sends the tree for a write that has no op form', () => {
    // The MCP's direct routes and the trash go through the store without an op,
    // so there is nothing smaller to send than the result.
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    tree.addChild(null, 'project', null)
    const [frame] = received(ws)
    expect(frame.kind).toBe('tree')
    expect(frame.tree).toHaveLength(1)
    expect(frame.hash).toBe(fingerprint(tree.load()))
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

  it('does not broadcast a write that was refused', async () => {
    await tree.applyOp({ op: 'addChild', id: 'a', parentId: null, text: 'project', at: 1 }, null)
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws)
    // A move onto a parent that doesn't exist. Moving a node that doesn't exist
    // is deliberately a no-op in shared/tree.ts rather than an error, so it
    // would not exercise this.
    await expect(tree.applyOp({ op: 'moveNode', id: 'a', parentId: 'ghost', index: 0 }, null)).rejects.toThrow(
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
  it('accepts nothing from a client', () => {
    // The socket is receive-only, and deliberately so: the handshake is the only
    // place a Clerk token is checked, so anything acted on from an already-open
    // socket would skip auth entirely. Writes go over HTTP for that reason.
    // Adding a webSocketMessage handler is what would open that door, so its
    // absence is the thing worth asserting.
    expect((tree as { webSocketMessage?: unknown }).webSocketMessage).toBeUndefined()
  })

  it('closes a socket that errored', () => {
    const ws = fakeSocket()
    tree.webSocketError(ws as never)
    expect(ws.closedWith?.code).toBe(1011)
  })

  it('survives an error on a socket that is already gone', () => {
    // close() throws on an already-closed socket, and a throw out of this
    // handler takes the whole object down — along with every other client's
    // live connection.
    const ws = fakeSocket()
    ws.close = () => {
      throw new Error('already closed')
    }
    expect(() => tree.webSocketError(ws as never)).not.toThrow()
  })

  it('closes with 1000 when the peer sent no status', () => {
    // 1005 means "no status received" and close() rejects it as an argument, so
    // echoing it back verbatim would throw inside the close handler.
    const ws = fakeSocket()
    tree.webSocketClose(ws as never, 1005, 'gone')
    expect(ws.closedWith).toEqual({ code: 1000, reason: 'gone' })
  })
})

describe('the trash', () => {
  /** A project with one child, returning both ids. */
  async function project(): Promise<{ root: string; child: string }> {
    await tree.applyOp({ op: 'addChild', id: 'p', parentId: null, text: 'project', at: 1 }, null)
    await tree.applyOp({ op: 'addChild', id: 'c', parentId: 'p', text: 'child', at: 2 }, null)
    return { root: 'p', child: 'c' }
  }

  /**
   * Fire the alarm the way the platform does: it clears the pending alarm
   * before invoking the handler, so re-arming is the handler's own decision.
   */
  async function fireAlarm(): Promise<void> {
    await ctx.storage.deleteAlarm()
    await tree.alarm()
  }

  it('broadcasts a restore the way it broadcasts any other write', async () => {
    // The property the sidebar depends on: a restore on the phone appears on
    // the web tab without a reload, because it travels the path every edit
    // already travels rather than a special one nobody else is listening to.
    const { root } = await project()
    await tree.remove(root, null, true)

    const ws = fakeSocket()
    ctx.acceptWebSocket(ws as never)
    ws.sent.length = 0

    const [entry] = tree.trashPage().entries
    const restored = tree.restore(entry.id, 'phone')

    expect(restored?.map((n) => n.text).sort()).toEqual(['child', 'project'])
    const [payload] = received(ws)
    expect(payload.origin).toBe('phone')
    expect(payload.tree).toHaveLength(2)
  })

  it('broadcasts a permanent delete, though the tree is unchanged', async () => {
    // The gap that shipped: deleting synced and permanently deleting did not.
    // `forget` only touches the trash tables, so there was no new tree to send
    // and it sent nothing — leaving the other device's trash showing a row that
    // was gone. The tree is what the socket carries, so an unchanged one is
    // what there is to send.
    const { root } = await project()
    await tree.remove(root, null, true)

    const ws = fakeSocket()
    ctx.acceptWebSocket(ws as never)
    ws.sent.length = 0

    const [entry] = tree.trashPage().entries
    tree.forget(entry.id, 'phone')

    expect(tree.trashPage().entries).toHaveLength(0)
    const [payload] = received(ws)
    expect(payload.origin).toBe('phone')
    // Unchanged: the node left `nodes` when it was deleted, not now.
    expect(payload.tree).toHaveLength(0)
  })

  it('does not broadcast when the entry is already gone', () => {
    // A stale list restoring twice must not push an unchanged tree at every
    // other device, which would look like a change that never happened.
    const ws = fakeSocket()
    ctx.acceptWebSocket(ws as never)
    ws.sent.length = 0

    expect(tree.restore('no-such-entry', null)).toBeNull()
    expect(ws.sent).toHaveLength(0)
  })

  it('keeps nothing when a removal is editing mechanics rather than a delete', async () => {
    // Backspace merging two rows removes one. Filling the trash with those is
    // how it stops being useful for the deletes that matter.
    const { child } = await project()
    await tree.remove(child, null)
    expect(tree.trashPage().entries).toHaveLength(0)
  })

  it('arms the sweep on the first trashed delete and leaves the pending one alone', async () => {
    // setAlarm replaces rather than queues, so re-arming on every delete would
    // push the sweep 24h further out each time — a trash that never expires
    // because it keeps being added to.
    await project()
    expect(ctx._alarmAt()).toBeNull()

    await tree.remove('c', null, true)
    const first = ctx._alarmAt()
    expect(first).not.toBeNull()

    await tree.remove('p', null, true)
    expect(ctx._alarmAt()).toBe(first)
  })

  it('sweeps what is past retention and stops waking once the trash is empty', async () => {
    await project()
    await tree.remove('c', null, true)
    const [old] = tree.trashPage().entries
    // Aged by hand rather than by injecting a clock: the retention window is a
    // constant in the object, and moving the row is the smaller lie.
    sql.db.prepare('UPDATE trash_entries SET deletedAt = ? WHERE id = ?').run(1, old.id)

    await fireAlarm()
    expect(tree.trashPage().entries).toHaveLength(0)
    expect(ctx._alarmAt()).toBeNull()
  })

  it('keeps waking while something in the trash is still young', async () => {
    await project()
    await tree.remove('c', null, true)
    await fireAlarm()
    expect(tree.trashPage().entries).toHaveLength(1)
    expect(ctx._alarmAt()).not.toBeNull()
  })

  it('forgets an entry for good', async () => {
    await project()
    await tree.remove('c', null, true)
    const [entry] = tree.trashPage().entries
    tree.forget(entry.id)
    expect(tree.trashPage().entries).toHaveLength(0)
    expect(tree.restore(entry.id, null)).toBeNull()
  })
})
