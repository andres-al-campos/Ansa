/**
 * The seeding contract, after seed-on-read was removed.
 *
 * This is here because the bug it guards against already happened: loadOrSeed()
 * furnished an account from a GET, so merely opening the SSE stream created 26
 * rows under a Clerk id that had never typed anything. The dangerous version of
 * that is an import racing rows the read path is inventing — and the whole point
 * of the hosted instance is a data migration.
 *
 * Two properties, neither visible by reading the route:
 *   - reading never writes
 *   - seeding refuses an account that already has something
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'
import { tutorialTree } from '../../shared/tutorial.ts'
import { parseJsonBody } from './jsonBody.ts'
import { invalidTree, roots } from '../../shared/tree.ts'

const A = 'user-a'
const B = 'user-b'

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ansa-seed-'))
  store = new Store(join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * What POST /api/seed does, minus the HTTP. Mirrors the route body so the guard
 * is tested rather than the framework.
 */
function seed(owner: string): boolean {
  if (store.load(owner).length > 0) return false
  store.replaceAll(owner, tutorialTree())
  return true
}

describe('reading never writes', () => {
  it('loading an unknown owner leaves them empty', () => {
    // The regression. This used to return a seeded 26-node tree and persist it.
    expect(store.load(A)).toEqual([])
    // Still empty on the next read — nothing was created behind the first one.
    expect(store.load(A)).toEqual([])
  })

  it('loading one owner does not create rows for another', () => {
    store.load(A)
    store.load(B)
    expect(store.load(A)).toEqual([])
    expect(store.load(B)).toEqual([])
  })
})

describe('seeding refuses a non-empty account', () => {
  it('seeds an empty account exactly once', () => {
    expect(seed(A)).toBe(true)
    const first = store.load(A)
    expect(first.length).toBeGreaterThan(0)

    // The second call is the one that matters: the client calls this on every
    // boot, so a missing guard would overwrite the tree on every page load.
    expect(seed(A)).toBe(false)
    expect(store.load(A)).toEqual(first)
  })

  it('will not overwrite a tree that arrived some other way', () => {
    // Stands in for the phase-2 import: data put there by something that isn't
    // the seeder must survive a subsequent boot.
    const imported = tutorialTree().slice(0, 3).map((n) => ({ ...n, text: `imported ${n.text}` }))
    store.replaceAll(A, imported)

    expect(seed(A)).toBe(false)
    // Compared as a set: load() returns tree order, which isn't the order the
    // rows were handed to replaceAll. What's under test is that the rows are
    // still *these* rows, not the sequence they come back in.
    expect(new Set(store.load(A).map((n) => n.text))).toEqual(
      new Set(imported.map((n) => n.text)),
    )
  })

  it('seeding one owner leaves another owner empty', () => {
    seed(A)
    expect(store.load(B)).toEqual([])
  })
})

describe('a bodyless POST is accepted', () => {
  // The bug this guards: POST /api/seed carries no body, but the client sends
  // its usual content-type: application/json. Fastify's default parser rejects
  // that with FST_ERR_CTP_EMPTY_JSON_BODY *before* the route runs, so a fresh
  // account got no tutorial — and the client ignored the 400, so no error
  // either. Reproduced against a real Fastify instance because the defect was
  // entirely in the framework's parser, not in any code of ours.
  it('treats an empty application/json body as {}', async () => {
    const { default: Fastify } = await import('fastify')
    const app = Fastify()
    // The parser the real server installs, imported rather than reimplemented —
    // a copy pasted in here would stay green while production broke.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, parseJsonBody)
    app.post('/seed', async () => ({ seeded: true }))

    const empty = await app.inject({
      method: 'POST',
      url: '/seed',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(empty.statusCode).toBe(200)

    // Still strict about bodies that are present and wrong — and a client's
    // malformed JSON is a 400, not a 500 blaming the server.
    const bad = await app.inject({
      method: 'POST',
      url: '/seed',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(bad.statusCode).toBe(400)
    await app.close()
  })
})

describe('the tutorial tree itself', () => {
  it('is a single valid project', () => {
    const tree = tutorialTree()
    expect(invalidTree(tree)).toBeNull()
    // One project, so a new account looks close to empty rather than furnished.
    expect(roots(tree)).toHaveLength(1)
  })

  it('mints fresh ids per call, so two accounts can both be seeded', () => {
    // This is a primary-key collision waiting to happen: ids are unique across
    // the whole table, not per owner.
    seed(A)
    seed(B)
    const overlap = new Set(store.load(A).map((n) => n.id))
    expect(store.load(B).some((n) => overlap.has(n.id))).toBe(false)
  })
})
