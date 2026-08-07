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
import { isRejectedWrite } from './index.ts'

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
