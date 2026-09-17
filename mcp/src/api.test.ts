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
  // `content-type: application/json` on a bodyless request declares a payload
  // that isn't there. The old Node server rejected that before the route ran,
  // and since every DELETE is bodyless an unconditional header made
  // `remove_task` fail 100% of the time. The Worker is lenient, but the guard
  // stays: the header is a false claim either way.
  //
  // Match the guard rather than the exact expression, so reformatting doesn't
  // fail this but dropping the condition does.
  expect(source).toMatch(/init\?\.body === undefined[\s\S]{0,80}'content-type'/)
})

test('the token is sent as a header, never in the URL', () => {
  // A long-lived credential in a query string ends up in access logs, proxy
  // logs and Referer headers. The worker refuses one there for the same reason;
  // this is the client half of that agreement.
  expect(source).toMatch(/authorization: `Bearer \$\{TOKEN\}`/)
  expect(source).not.toMatch(/[?&]token=/)
})

test('the stub header is not sent alongside a real token', () => {
  // Sending both means a broken token still "works" against a local dev server
  // via the header, so the token is never exercised until it fails in the one
  // place it matters.
  expect(source).toMatch(/TOKEN \?[\s\S]{0,120}: \{ 'x-ansa-user': USER \}/)
})

test('only view_tree echoes the whole outline', () => {
  // The server returns the entire tree on every write — right for the browser,
  // which replaces its state wholesale from the WebSocket. For a model it means every
  // call spends context re-printing nodes that did not change: measured against
  // an 86-node tree, adding one task echoed 3413 characters to say 34.
  //
  // A bare `renderOutline(tree)` is that unscoped echo. Only view_tree may use
  // it; every write scopes to what it touched.
  const unscoped = [...source.matchAll(/renderOutline\(\s*\w+\s*\)/g)]
  expect(unscoped).toHaveLength(1)

  // And that one is inside view_tree, not somewhere it leaked back into.
  const viewTree = source.slice(source.indexOf("'view_tree'"))
  expect(viewTree.slice(0, viewTree.indexOf('\n)'))).toMatch(/renderOutline\(\s*\w+\s*\)/)
})

test('set_done echoes the project, so the completion rollup stays visible', () => {
  // Checking the last child auto-completes its parent, and that parent's parent.
  // Scoping the echo to the checked node would show `[x] c2` and silently hide
  // every ancestor that flipped — the behaviour the tool description promises.
  const handler = source.slice(source.indexOf("'set_done'"))
  const body = handler.slice(0, handler.indexOf('\n)'))
  expect(body).toMatch(/changed\(tree, projectOf\(tree, id\)\)/)
})

test('remove_task reads the parent before the node is gone', () => {
  // After the DELETE there is nothing left to locate the node by, so the echo
  // has to be scoped by a parent captured beforehand. Reading it afterwards
  // yields undefined and the tool falls back to printing the whole tree.
  const handler = source.slice(source.indexOf("'remove_task'"))
  const body = handler.slice(0, handler.indexOf('\n)'))
  const lookup = body.indexOf('byId(before, id)')
  const del = body.indexOf("method: 'DELETE'")
  expect(lookup).toBeGreaterThan(-1)
  expect(lookup).toBeLessThan(del)
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

test('an env token wins over the Keychain', () => {
  // Order matters for anywhere that isn't this laptop: CI, a container, or a
  // Linux box passes ANSA_TOKEN the ordinary way, and a Keychain lookup that
  // took precedence would either shadow it or, on a machine with no `security`
  // binary, cost a failed subprocess on every start.
  expect(source).toMatch(/process\.env\.ANSA_TOKEN\s*\|\|\s*keychainToken\(\)/)
})

test('the Keychain lookup is macOS-only and fails quiet', () => {
  // `security` exists only on darwin, and a missing item is a normal "not
  // configured" answer rather than an error — a throw here would take down a
  // server that was about to work fine from an env var.
  const fn = source.slice(source.indexOf('function keychainToken'))
  expect(fn).toMatch(/process\.platform !== 'darwin'/)
  expect(fn).toMatch(/catch\s*\{\s*return ''/)
})

test('the token is never written to stdout', () => {
  // stdout is the JSON-RPC transport. A stray console.log of a credential would
  // both corrupt the protocol and put the token somewhere it gets logged.
  expect(source).not.toMatch(/console\.log\([^)]*TOKEN/)
})
