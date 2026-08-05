/**
 * The Ansa server: one Fastify process that owns the SQLite database and is the
 * single write path for the tree. The React app and the MCP server are both
 * just clients of this REST API, so there is exactly one source of truth.
 *
 * Two write paths, both landing in the same place. `POST /api/ops` takes a named
 * operation and replays it against the current tree — this is what the app uses,
 * and it's what makes concurrent edits from a person and a Claude interleave
 * rather than overwrite. The `/api/nodes` routes are the same operations exposed
 * one-per-endpoint for the MCP, where a REST shape is the friendlier interface.
 *
 * Every mutating response returns the full new tree, so a client can replace its
 * state without a second round-trip or any client-side merging.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { RejectedWriteError, Store, type OwnerId } from './store.ts'
import { parseOp, parseSpecs } from '../../shared/ops.ts'
import { broadcast, subscribe } from './bus.ts'
import { isClerkAuth, isDevAuth, ownerOf } from './auth.ts'
import { tutorialTree } from '../../shared/tutorial.ts'
import { invalidTree } from '../../shared/tree.ts'
import type { SubtreeSpec, Tree } from '../../shared/tree.ts'

/**
 * Validate an untrusted nested outline into a SubtreeSpec, wrapping parseSpecs
 * in the { nodes } | { error } shape the routes here reply with.
 *
 * The walk itself lives in shared/ops.ts, where the same shape is validated for
 * the addSubtree op. Two copies drifted apart is exactly how one write path ends
 * up accepting what the other rejects.
 */
function parseSubtree(input: unknown): { nodes: SubtreeSpec[] } | { error: string } {
  const nodes = parseSpecs(input, 'nodes')
  return typeof nodes === 'string' ? { error: nodes } : { nodes }
}

const here = dirname(fileURLToPath(import.meta.url))
// DB lives next to the repo root by default; override with ANSA_DB for tests.
const DB_PATH = process.env.ANSA_DB ?? resolve(here, '../../ansa.db')
const PORT = Number(process.env.PORT ?? 4000)

const store = new Store(DB_PATH)

// Reclaim the write-ahead log periodically. This process holds a connection
// open for the SSE stream, which stops WAL's own autocheckpoint from ever fully
// resetting the log — left alone it grows unboundedly against a database that
// doesn't. Five minutes is far longer than any burst of edits, so this costs
// nothing on a busy tree and still keeps an idle one tidy.
const CHECKPOINT_MS = 5 * 60_000
const checkpointTimer = setInterval(() => store.checkpoint(), CHECKPOINT_MS)
// Don't let the timer hold the process open on its own.
checkpointTimer.unref()

const app = Fastify({ logger: false })

// Ctrl-C and `kill` should still close the database, so the WAL is folded back
// in rather than left for the next start to recover.
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    clearInterval(checkpointTimer)
    app.close().finally(() => {
      store.close()
      process.exit(0)
    })
  })
}

// A write the store refused is the caller's fault, not a server fault — reply
// 400 with the store's message, which says what to do about it. Anything else
// is a genuine bug and keeps Fastify's default 500.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RejectedWriteError) return reply.code(400).send({ error: err.message })
  throw err
})

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
  allowedHeaders: ['content-type', 'x-ansa-origin', 'x-ansa-user', 'authorization'],
})

// The client that made the write, from the x-ansa-origin header. Echoed back in
// the broadcast so that client can skip re-adopting its own change.
const originOf = (req: { headers: Record<string, unknown> }): string | null => {
  const h = req.headers['x-ansa-origin']
  return typeof h === 'string' ? h : null
}
// Push the resulting tree to that owner's open streams, then hand it back.
const emit = (owner: OwnerId, tree: Tree, req: { headers: Record<string, unknown> }): Tree => {
  broadcast(owner, tree, originOf(req))
  return tree
}

/**
 * The signed-in owner, replying 401 if there isn't one.
 *
 * Returns null when it has already sent the reply, so every handler starts with
 * `const owner = await requireOwner(...); if (!owner) return`. Deliberately not
 * a preHandler hook writing onto the request: a hook that fails open — one route
 * added without it, one ordering mistake — serves another user's tree, whereas
 * a missing call here is a type error at the first use of `owner`.
 */
type Reply = { code: (n: number) => { send: (body: unknown) => unknown } }
async function requireOwner(
  req: { headers: Record<string, unknown> },
  reply: Reply,
): Promise<OwnerId | null> {
  const owner = await ownerOf(req)
  if (!owner) {
    reply.code(401).send({ error: 'Not signed in. Sign in and retry the request.' })
    return null
  }
  return owner
}

/**
 * One owner's tree. A read, and only a read.
 *
 * This used to seed an empty tree in place, which meant a GET could create 26
 * rows. That's wrong in two ways. Merely opening the SSE stream furnished an
 * account nobody had typed anything into — and worse, an import that arrives
 * while a client is connected races rows the read path is busy inventing. The
 * data migration is the whole point of the hosted instance, so the read path
 * has to be inert.
 *
 * A new account gets an empty tree here and the tutorial from POST /api/seed,
 * which the app calls once, deliberately.
 */
function loadTree(owner: OwnerId): Tree {
  return store.load(owner)
}

// SSE stream: hold the connection open and push the owner's tree when it changes.
//
// Async only because verifying a token is. Everything after that writes to
// reply.raw and returns nothing, so the socket outlives the handler's promise —
// Fastify only takes over the response if you return a value or call send().
app.get('/api/events', async (req, reply) => {
  const owner = await ownerOf(req)
  if (!owner) {
    reply.code(401).send({ error: 'Not signed in. Sign in and reconnect the stream.' })
    return
  }
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // CORS for the stream itself; the app is served from a different origin in dev.
    'access-control-allow-origin': '*',
  })
  // Send the current tree immediately so a fresh subscriber is in sync at once.
  reply.raw.write(`data: ${JSON.stringify({ tree: loadTree(owner), origin: null })}\n\n`)
  const unsubscribe = subscribe(owner, reply.raw)
  // A comment line every 25s keeps proxies from culling an idle connection.
  const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 25000)
  req.raw.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
})

app.get('/api/tree', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  return { tree: loadTree(owner) }
})

/**
 * Give a brand-new account its tutorial project.
 *
 * Refuses when the owner already has anything, so it can't clobber a real tree
 * — that guard is what makes it safe for the client to call on every boot
 * without tracking whether it has run before. It also means an interrupted
 * phase-2 import can't be "helpfully" re-seeded on top of.
 *
 * Returns seeded:false rather than an error when the tree is non-empty: not
 * seeding an existing account is the expected outcome, not a failure.
 */
app.post('/api/seed', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  if (store.load(owner).length > 0) return { seeded: false }
  const tree = store.replaceAll(owner, tutorialTree())
  broadcast(owner, tree, originOf(req))
  return { seeded: true, tree }
})

app.post<{ Body: { parentId: string | null; text?: string } }>('/api/nodes', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  const { parentId, text } = req.body ?? { parentId: null }
  if (parentId !== null && typeof parentId !== 'string') {
    return reply.code(400).send({ error: 'parentId must be a string or null' })
  }
  const { tree, id } = store.addChild(owner, parentId, text ?? '')
  return { tree: emit(owner, tree, req), id }
})

// Graft a whole nested subtree in one write. parentId null makes a new project
// (root); a parent id nests it under an existing task. Returns the created ids
// depth-first, first id being the subtree's own root.
app.post<{ Body: { parentId?: string | null; nodes?: unknown } }>('/api/nodes/subtree', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  const { parentId = null, nodes } = req.body ?? {}
  if (parentId !== null && typeof parentId !== 'string') {
    return reply.code(400).send({ error: 'parentId must be a string or null' })
  }
  const parsed = parseSubtree(nodes)
  if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
  if (parsed.nodes.length === 0) return reply.code(400).send({ error: 'nodes must have at least one node' })
  // A new project is a single root. Extra top-level nodes would each become
  // their own project — almost never what "make a new project" means — so
  // require exactly one and let its children carry the rest of the tree.
  if (parentId === null && parsed.nodes.length !== 1) {
    return reply.code(400).send({
      error:
        'A new project needs exactly one top-level node (the project itself); put the rest under its children. To add several tasks to an existing project, pass its id as parentId.',
    })
  }
  const { tree, ids } = store.addSubtree(owner, parentId, parsed.nodes)
  return { tree: emit(owner, tree, req), ids }
})

app.patch<{ Params: { id: string }; Body: { text?: string; done?: boolean; pinned?: boolean } }>(
  '/api/nodes/:id',
  async (req, reply) => {
    const owner = await requireOwner(req, reply)
    if (!owner) return
    const { id } = req.params
    const { text, done, pinned } = req.body ?? {}
    if (typeof text === 'string') return { tree: emit(owner, store.rename(owner, id, text), req) }
    if (typeof done === 'boolean') {
      const { tree, completed } = store.setDone(owner, id, done)
      return { tree: emit(owner, tree, req), completed }
    }
    if (typeof pinned === 'boolean') return { tree: emit(owner, store.setPinned(owner, id, pinned), req) }
    return reply.code(400).send({ error: 'provide text (string), done (boolean), or pinned (boolean)' })
  },
)

app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  return { tree: emit(owner, store.remove(owner, req.params.id), req) }
})

app.post<{ Params: { id: string }; Body: { parentId: string | null; index: number } }>(
  '/api/nodes/:id/move',
  async (req, reply) => {
    const owner = await requireOwner(req, reply)
    if (!owner) return
    const { parentId, index } = req.body ?? { parentId: null, index: 0 }
    if (typeof index !== 'number') return reply.code(400).send({ error: 'index must be a number' })
    return { tree: emit(owner, store.move(owner, req.params.id, parentId, index), req) }
  },
)

app.post<{ Params: { id: string } }>('/api/nodes/:id/toggle-collapsed', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  return { tree: emit(owner, store.toggleCollapsed(owner, req.params.id), req) }
})

// The app's write path. Takes a named operation rather than a tree, and applies
// it to whatever the stored tree is *now* — so two clients writing at once
// interleave as two ops instead of racing whole-document overwrites. One op is
// one broadcast, which also keeps multi-move ops like adoptFollowing atomic on
// every other tab. The fine-grained /api/nodes routes below stay for the MCP.
app.post<{ Body: { op?: unknown } }>('/api/ops', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  const parsed = parseOp(req.body?.op ?? req.body)
  if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
  const { tree, completed } = store.applyOp(owner, parsed.op)
  return { tree: emit(owner, tree, req), completed }
})

// Whole-tree replace, used by Import. The only route that takes a tree rather
// than an op, and the only one where the caller's bytes become the database, so
// it validates the whole shape before writing. The table's own constraints
// reject the crude cases, but a coercible one — `order: "3"`, a cyclic
// parentId — would be stored and then break the walks that read it.
app.put<{ Body: { tree: unknown } }>('/api/tree', async (req, reply) => {
  const owner = await requireOwner(req, reply)
  if (!owner) return
  const { tree } = req.body ?? {}
  const bad = invalidTree(tree)
  if (bad) return reply.code(400).send({ error: bad })
  return { tree: emit(owner, store.replaceAll(owner, tree as Tree), req) }
})

// Liveness, deliberately unauthenticated: "is the server up" is not a question
// about who's asking. Scripts wait on this rather than on /api/tree, which
// answers 401 when auth isn't configured and so can't tell "down" apart from
// "not signed in".
app.get('/api/health', async () => ({
  ok: true,
  auth: isClerkAuth ? 'clerk' : isDevAuth ? 'dev' : 'none',
}))

// 'localhost' rather than '127.0.0.1' so this binds both loopback stacks —
// 127.0.0.1 *and* ::1 — while still refusing connections from off the machine.
//
// Vite binds ::1 only. Safari resolves localhost to ::1 first and does not fall
// back to IPv4 the way Chrome does, so an IPv4-only API meant the page loaded
// and then every request to it failed: the app worked in one browser and not
// the other, with nothing in the server log either way.
app
  .listen({ port: PORT, host: 'localhost' })
  .then(() => {
    console.log(`Ansa server on http://127.0.0.1:${PORT}  (db: ${DB_PATH})`)
    if (isClerkAuth) {
      console.log('auth: Clerk — session tokens are verified.')
    } else if (isDevAuth) {
      console.log('auth: DEV STUB — the x-ansa-user header is trusted as-is. Not for a public deploy.')
    } else {
      console.log(
        'auth: none configured — every request will 401. Set CLERK_SECRET_KEY, ' +
          'or ANSA_DEV_AUTH=1 for local use without a sign-in.',
      )
    }
  })
  .catch((err) => {
    // A lost port race is the common case, and the raw stack hides it. Say what
    // happened and how to fix it, then exit — so a stray `npm run server` dies
    // instead of leaving `tsx watch` spinning on a server that never bound.
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use — an Ansa server is probably already running.\n` +
          `Stop it first (Ctrl-C its terminal), or find it with:  lsof -tiTCP:${PORT} -sTCP:LISTEN`,
      )
    } else {
      console.error(err)
    }
    process.exit(1)
  })
