/**
 * Refused writes must stay 400s across the Durable Object RPC boundary.
 *
 * This exists because of a bug that only showed up under wrangler dev. The
 * router classified errors with `err instanceof RejectedWriteError`, which is
 * always false for an error thrown inside a Durable Object: the call is RPC
 * even though it reads as a method call, so the error is serialized and rebuilt
 * on the worker side as a plain Error. Message and name survive; the prototype
 * does not.
 *
 * The effect was that every rejected write — a dangling parent, a malformed op,
 * a cyclic import — came back as 500 "Something went wrong saving that change."
 * instead of a 400 saying what was actually wrong. The unit tests could not see
 * it, because in-process they call the class directly and instanceof works.
 */

import { describe, expect, it } from 'vitest'
import { RejectedWriteError, UnknownParentError } from './treeStore.ts'
import { isOverQuota, isRejectedWrite, isValueTooBig } from './index.ts'

/** What RPC does to a thrown error: same name and message, plain prototype. */
function acrossRpc(err: Error): Error {
  const rebuilt = new Error(err.message)
  rebuilt.name = err.name
  return rebuilt
}

describe('classifying an error that crossed the RPC boundary', () => {
  it('still recognises a refused write', () => {
    const thrown = new RejectedWriteError('That change would corrupt the tree; nothing was saved.')
    // The check that used to be here. Kept as an assertion so the reason this
    // file exists cannot quietly stop being true.
    expect(acrossRpc(thrown) instanceof RejectedWriteError).toBe(false)
    expect(isRejectedWrite(acrossRpc(thrown))).toBe(true)
  })

  it('still recognises an unknown parent', () => {
    expect(isRejectedWrite(acrossRpc(new UnknownParentError('ghost')))).toBe(true)
  })

  it('does not mistake a genuine crash for a refused write', () => {
    // A real failure must stay a 500 with a generic message. Classifying it as
    // a refused write would put internal detail in the response body.
    expect(isRejectedWrite(acrossRpc(new TypeError('x is not a function')))).toBe(false)
    expect(isRejectedWrite(new Error('disk full'))).toBe(false)
    expect(isRejectedWrite('not an error at all')).toBe(false)
    expect(isRejectedWrite(null)).toBe(false)
  })
})

describe('classifying a quota failure', () => {
  it('recognises the runtime being out of daily storage quota', () => {
    // The real message, as it appeared in the worker log when the free tier ran
    // out. It is thrown from `new TreeStore` — before any request logic — so
    // every route 500s at once and the client cannot tell it from a dead
    // server. That is what this classification exists to prevent.
    const thrown = new Error('Exceeded allowed rows written in Durable Objects free tier.')
    expect(isOverQuota(acrossRpc(thrown))).toBe(true)
    expect(isRejectedWrite(acrossRpc(thrown))).toBe(false)
  })

  it('recognises the other daily limits the same way', () => {
    expect(isOverQuota(new Error('Exceeded allowed duration limit.'))).toBe(true)
  })

  it('does not claim an ordinary failure is a quota problem', () => {
    // The distinction has to hold in both directions: a bug reported as "wait
    // until 00:00 UTC" is worse than a generic 500, because it tells someone to
    // stop looking.
    expect(isOverQuota(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isOverQuota(new UnknownParentError('ghost'))).toBe(false)
    expect(isOverQuota(undefined)).toBe(false)
  })
})

describe('classifying an oversized value', () => {
  // The message the Durable Object's SQLite actually raised, copied from the
  // worker log while writing a single node holding 4MB of text.
  const thrown = () => new Error('string or blob too big: SQLITE_TOOBIG')

  it('recognises a value too big for the object to store', () => {
    expect(isValueTooBig(acrossRpc(thrown()))).toBe(true)
  })

  it('recognises the bare SQLite code, whatever wording wraps it', () => {
    expect(isValueTooBig(new Error('SQLITE_TOOBIG'))).toBe(true)
  })

  // The three runtime failures answer with different statuses — 413, 503, 500 —
  // so a message matching two classifiers would take whichever branch is
  // checked first and give the wrong advice.
  it('is not confused with a quota failure or a refused write', () => {
    expect(isOverQuota(acrossRpc(thrown()))).toBe(false)
    expect(isRejectedWrite(acrossRpc(thrown()))).toBe(false)
    expect(isValueTooBig(new Error('Exceeded allowed rows written in Durable Objects free tier.'))).toBe(false)
    expect(isValueTooBig(new UnknownParentError('ghost'))).toBe(false)
  })

  it('does not claim an ordinary failure is a size problem', () => {
    expect(isValueTooBig(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isValueTooBig(undefined)).toBe(false)
  })
})
