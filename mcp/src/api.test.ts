/**
 * The MCP server talks to the Ansa API through one `api()` helper, and every
 * tool inherits whatever that helper decides about headers. One of those
 * decisions is load-bearing in a way that isn't visible from the call sites.
 *
 * `api()` isn't exported — it's an internal of a stdio server whose tools are
 * thin wrappers over it — so this reads the source as text, the same approach
 * Outliner.geometry.test.ts takes for the CSS/TSX constants it can't execute.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

test('content-type is only sent when there is a body', () => {
  // Sending `content-type: application/json` on a bodyless request makes
  // Fastify expect a JSON payload, find none, and reject the request with
  // FST_ERR_CTP_EMPTY_JSON_BODY before the route handler runs. Every DELETE is
  // bodyless, so an unconditional header made `remove_task` fail 100% of the
  // time — it could never delete anything.
  //
  // Match the guard rather than the exact expression, so reformatting doesn't
  // fail this but dropping the condition does.
  expect(source).toMatch(/init\?\.body === undefined[\s\S]{0,80}'content-type'/)
})

test('move_task reports what happened rather than assuming success', () => {
  // A move that would form a cycle is rejected as a *silent no-op* in the tree
  // model: the unchanged tree comes back with no error. Reporting "Moved" on
  // the strength of the call returning tells the caller a move happened when
  // the tree is untouched.
  const handler = source.slice(source.indexOf("'move_task'"))
  const body = handler.slice(0, handler.indexOf('\n)'))

  // The outcome has to be read back off the returned tree.
  expect(body).toMatch(/childrenOf\(tree, parentId\)[\s\S]{0,60}n\.id === id/)
  // And the failure path has to say so, not fall through to the success text.
  expect(body).toMatch(/Did not move/)
})
