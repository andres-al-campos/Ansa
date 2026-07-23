/**
 * The Ansa server: one Fastify process that owns the SQLite database and is the
 * single write path for the tree. The React app and the MCP server are both
 * just clients of this REST API, so there is exactly one source of truth.
 *
 * Endpoints mirror the atomic tree operations one-to-one. Every mutating
 * response returns the full new tree, so a client can replace its state without
 * a second round-trip or any client-side merging.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { Store } from './store.ts'
import { broadcast, subscribe } from './bus.ts'
import { seedTree } from '../../shared/seed.ts'
import type { Tree } from '../../shared/tree.ts'

const here = dirname(fileURLToPath(import.meta.url))
// DB lives next to the repo root by default; override with ANSA_DB for tests.
const DB_PATH = process.env.ANSA_DB ?? resolve(here, '../../ansa.db')
const PORT = Number(process.env.PORT ?? 4000)

const store = new Store(DB_PATH)

// First run: an empty database opens onto a blank app, so seed it once.
if (store.load().length === 0) {
  store.replaceAll(seedTree())
}

const app = Fastify({ logger: false })

// Private Network Access: a page on localhost calling a server on the local
// network is a "private network request", and Chrome blocks the preflight
// unless the response opts in with this header. Without it every non-simple
// request (our PUT/PATCH/DELETE) fails with a bare "Failed to fetch", even
// though plain GET and curl work. Set it on every response so the preflight
// carries it. Safe for a local single-user tool bound to the loopback.
app.addHook('onRequest', async (req, reply) => {
  if (req.headers['access-control-request-private-network']) {
    reply.header('access-control-allow-private-network', 'true')
  }
})

// The app is served from vite (a different port in dev), so allow cross-origin.
await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'x-ansa-origin'],
})

// The client that made the write, from the x-ansa-origin header. Echoed back in
// the broadcast so that client can skip re-adopting its own change.
const originOf = (req: { headers: Record<string, unknown> }): string | null => {
  const h = req.headers['x-ansa-origin']
  return typeof h === 'string' ? h : null
}
// Push the resulting tree to every open stream, then hand it back to the caller.
const emit = (tree: Tree, req: { headers: Record<string, unknown> }): Tree => {
  broadcast(tree, originOf(req))
  return tree
}

// SSE stream: hold the connection open and push the tree whenever it changes.
app.get('/api/events', (req, reply) => {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // CORS for the stream itself; the app is served from a different origin in dev.
    'access-control-allow-origin': '*',
  })
  // Send the current tree immediately so a fresh subscriber is in sync at once.
  reply.raw.write(`data: ${JSON.stringify({ tree: store.load(), origin: null })}\n\n`)
  const unsubscribe = subscribe(reply.raw)
  // A comment line every 25s keeps proxies from culling an idle connection.
  const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 25000)
  req.raw.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
})

app.get('/api/tree', async () => ({ tree: store.load() }))

app.post<{ Body: { parentId: string | null; text?: string } }>('/api/nodes', async (req, reply) => {
  const { parentId, text } = req.body ?? { parentId: null }
  if (parentId !== null && typeof parentId !== 'string') {
    return reply.code(400).send({ error: 'parentId must be a string or null' })
  }
  const { tree, id } = store.addChild(parentId, text ?? '')
  return { tree: emit(tree, req), id }
})

app.patch<{ Params: { id: string }; Body: { text?: string; done?: boolean; pinned?: boolean } }>(
  '/api/nodes/:id',
  async (req, reply) => {
    const { id } = req.params
    const { text, done, pinned } = req.body ?? {}
    if (typeof text === 'string') return { tree: emit(store.rename(id, text), req) }
    if (typeof done === 'boolean') {
      const { tree, completed } = store.setDone(id, done)
      return { tree: emit(tree, req), completed }
    }
    if (typeof pinned === 'boolean') return { tree: emit(store.setPinned(id, pinned), req) }
    return reply.code(400).send({ error: 'provide text (string), done (boolean), or pinned (boolean)' })
  },
)

app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req) => ({
  tree: emit(store.remove(req.params.id), req),
}))

app.post<{ Params: { id: string }; Body: { parentId: string | null; index: number } }>(
  '/api/nodes/:id/move',
  async (req, reply) => {
    const { parentId, index } = req.body ?? { parentId: null, index: 0 }
    if (typeof index !== 'number') return reply.code(400).send({ error: 'index must be a number' })
    return { tree: emit(store.move(req.params.id, parentId, index), req) }
  },
)

app.post<{ Params: { id: string } }>('/api/nodes/:id/toggle-collapsed', async (req) => ({
  tree: emit(store.toggleCollapsed(req.params.id), req),
}))

app.put<{ Body: { tree: unknown } }>('/api/tree', async (req, reply) => {
  const { tree } = req.body ?? {}
  if (!Array.isArray(tree)) return reply.code(400).send({ error: 'tree must be an array of nodes' })
  return { tree: emit(store.replaceAll(tree as never), req) }
})

app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => console.log(`Ansa server on http://127.0.0.1:${PORT}  (db: ${DB_PATH})`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
