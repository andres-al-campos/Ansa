import { beforeEach, describe, expect, it } from 'vitest'
import { exportTree, loadQueue, parseTree, saveQueue } from './storage'
import type { Op } from '@shared/ops'
import { seedTree } from '@shared/seed'

describe('parseTree', () => {
  it('round-trips a real tree through export', () => {
    const tree = seedTree()
    const back = parseTree(exportTree(tree))
    expect(back).toEqual(tree)
  })

  it('rejects malformed JSON', () => {
    expect(parseTree('{not json')).toBeNull()
    expect(parseTree('')).toBeNull()
  })

  it('rejects a non-array', () => {
    expect(parseTree('{"id":"x"}')).toBeNull()
    expect(parseTree('"a string"')).toBeNull()
  })

  it('rejects a node missing required fields', () => {
    // no `done`, no `order`, etc.
    expect(parseTree(JSON.stringify([{ id: 'a', parentId: null, text: 'x' }]))).toBeNull()
  })

  it('rejects a node whose field has the wrong type', () => {
    const bad = [{ id: 'a', parentId: null, text: 'x', done: 'yes', order: 0, collapsed: false, createdAt: 0 }]
    expect(parseTree(JSON.stringify(bad))).toBeNull()
  })

  it('rejects duplicate ids', () => {
    const node = { id: 'a', parentId: null, text: 'x', done: false, order: 0, collapsed: false, createdAt: 0 }
    expect(parseTree(JSON.stringify([node, node]))).toBeNull()
  })

  it('rejects a dangling parentId that would orphan a branch', () => {
    const orphan = [
      { id: 'a', parentId: 'ghost', text: 'x', done: false, order: 0, collapsed: false, createdAt: 0 },
    ]
    expect(parseTree(JSON.stringify(orphan))).toBeNull()
  })

  it('accepts a valid minimal tree', () => {
    const tree = [
      { id: 'root', parentId: null, text: 'A', done: false, order: 0, collapsed: false, createdAt: 1 },
      { id: 'kid', parentId: 'root', text: 'B', done: true, order: 0, collapsed: false, createdAt: 2 },
    ]
    expect(parseTree(JSON.stringify(tree))).toEqual(tree)
  })

  it('accepts an empty tree', () => {
    expect(parseTree('[]')).toEqual([])
  })
})

describe('the persisted op queue', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips ops in order', () => {
    const ops: Op[] = [
      { op: 'setText', id: 'a', text: 'hello' },
      { op: 'indent', id: 'b' },
      { op: 'setDone', id: 'c', done: true },
    ]
    saveQueue(ops)
    expect(loadQueue()).toEqual(ops)
  })

  it('is empty when nothing was ever saved', () => {
    expect(loadQueue()).toEqual([])
  })

  it('clears the key when the queue drains, rather than storing []', () => {
    saveQueue([{ op: 'indent', id: 'a' }])
    saveQueue([])
    expect(localStorage.getItem('ansa.queue.v1')).toBeNull()
    expect(loadQueue()).toEqual([])
  })

  it('survives a corrupt blob instead of crashing the boot', () => {
    localStorage.setItem('ansa.queue.v1', '{not json')
    expect(loadQueue()).toEqual([])
    localStorage.setItem('ansa.queue.v1', '{"op":"setText"}')
    expect(loadQueue()).toEqual([])
  })

  it('drops entries that are not ops, keeping the rest', () => {
    // Shallow on purpose — the server is what validates an op's fields. This
    // only has to stop junk from reaching the send loop.
    localStorage.setItem(
      'ansa.queue.v1',
      JSON.stringify([
        { op: 'indent', id: 'a' },
        null,
        'a string',
        { op: 'notARealOp', id: 'b' },
        { op: 'setDone', id: 'c', done: false },
      ]),
    )
    expect(loadQueue()).toEqual([
      { op: 'indent', id: 'a' },
      { op: 'setDone', id: 'c', done: false },
    ])
  })
})
