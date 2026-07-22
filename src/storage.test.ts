import { describe, expect, it } from 'vitest'
import { exportTree, parseTree } from './storage'
import { seedTree } from './seed'

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
