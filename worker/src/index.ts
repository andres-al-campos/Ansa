/**
 * The Worker: authenticate, pick the owner's Durable Object, forward the call.
 *
 * This replaces server/src/index.ts. The routes and their response shapes are
 * unchanged — the client and the MCP server both talk to this — but the two
 * things underneath are different:
 *
 *  - There is no `store` here. Every read and write goes to a Durable Object
 *    named after the signed-in user, so this file never sees SQL and cannot
 *    address the wrong owner's data without first getting the wrong id.
 *  - The owner id comes only from ownerOf(), which means only from a verified
 *    Clerk token (or the dev stub, which cannot run deployed). It is never read
 *    from a body or a path, so a client cannot ask for someone else's tree.
 *
 * ## Errors
 *
 * A Durable Object throwing RejectedWriteError means the request was wrong, not
 * that the server is broken, so those become 400s. Running out of daily storage
 * quota is neither, and becomes a 503 that says so — it is temporary, it has a
 * known reset time, and no amount of retrying moves it. Anything else is a
 * genuine failure and becomes a 500 with a generic message — the detail goes to
 * the log, not to the caller.
 */

import { AnsaTree } from './ansaTree.ts'
import { misconfiguredAuth, ownerOf, type AuthEnv } from './auth.ts'
import { corsHeaders, isPreflight, preflightResponse } from './cors.ts'
import { RejectedWriteError } from './treeStore.ts'
import { parseSpecs } from '../../shared/ops.ts'
import { invalidText, invalidTree } from '../../shared/tree.ts'

export { AnsaTree }

export interface Env extends AuthEnv {
  ANSA_TREE: DurableObjectNamespace<AnsaTree>
  /** Comma-separated origins allowed to call the API. See cors.ts. */
  ANSA_ALLOWED_ORIGIN?: string
}

/**
 * Was this a write the object refused, rather than a crash?
 *
 * Matched on `name` rather than `instanceof`. A Durable Object call is RPC even
 * when it looks like a method call, so a thrown error is serialized and rebuilt
 * on this side as a plain Error — the message and name survive, the prototype
 * does not. `instanceof RejectedWriteError` is therefore always false here, and
 * every refused write came back as a 500 "Something went wrong" instead of a
 * 400 carrying the reason the user needs.
 */
export function isRejectedWrite(err: unknown): boolean {
  return err instanceof Error && (err.name === 'RejectedWriteError' || err.name === 'UnknownParentError')
}

/**
 * Whether this is the account's storage quota running out for the day.
 *
 * Matched on the message because there is nothing else to match on: it is
 * raised by the runtime, not by us, so it has no distinguishing `name`, and by
 * the time it reaches here it has crossed the RPC boundary as a plain Error
 * anyway — see isRejectedWrite above.
 *
 * Worth its own case because it is the one 500 that is neither a bug nor
 * something retrying fixes, and because it is thrown from `new TreeStore`
 * before any request logic runs. That made it indistinguishable from a dead
 * server: the phone saw a 500, reported "not receiving changes", and the
 * reason — a limit with a known reset time — stayed in the Worker's logs.
 */
/**
 * Whether a single value was too big for the object's SQLite to store.
 *
 * Matched on the message for the same reason as isOverQuota: the runtime raises
 * it, so there is no `name` to key on and the prototype is gone by the time it
 * crosses the RPC boundary.
 *
 * The limit is per stored value, not per tree — a hundred thousand ordinary
 * rows write fine while one task carrying a few megabytes of pasted text does
 * not, so the fix is to shorten that one task rather than to prune the tree.
 * Without this case it landed in the generic 500, which told someone whose
 * paste was too long that something had gone wrong and left them no way to
 * guess what would work.
 */
export function isValueTooBig(err: unknown): boolean {
  return err instanceof Error && /SQLITE_TOOBIG|string or blob too big/i.test(err.message)
}

export function isOverQuota(err: unknown): boolean {
  return err instanceof Error && /exceeded .*(limit|free tier)/i.test(err.message)
}

/** The client instance that caused a write, so it can skip its own echo. */
function originOf(req: Request): string | null {
  return req.headers.get('x-ansa-origin')
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    // wrangler dev serves on localhost; a deployed worker never does. This is
    // what gates the header-trusting dev stub.
    const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    const cors = corsHeaders(req, env.ANSA_ALLOWED_ORIGIN, isLocalDev)

    if (isPreflight(req)) return preflightResponse(cors)

    // Liveness, deliberately unauthenticated: "is the server up" is not a
    // question about who is asking. Scripts wait on this rather than /api/tree,
    // which answers 401 when auth isn't configured and so cannot tell "down"
    // apart from "not signed in".
    if (path === '/api/health') {
      return json(
        { ok: true, auth: env.CLERK_SECRET_KEY ? 'clerk' : env.ANSA_DEV_AUTH === '1' ? 'dev' : 'none' },
        200,
        cors,
      )
    }

    // The dev stub trusts a header, so a deployed worker carrying it would let
    // anyone act as anyone. The Node server refuses to boot; a worker has no
    // boot, so this is the equivalent — checked before anything reads a body.
    const misconfigured = misconfiguredAuth(env, isLocalDev)
    if (misconfigured) {
      console.error(misconfigured)
      return json({ error: 'Server misconfigured; see the worker log.' }, 500, cors)
    }

    const owner = await ownerOf(req, env)
    if (!owner) {
      return json({ error: 'Not signed in. Sign in and try again.' }, 401, cors)
    }

    // The owner id names the object. Two requests from one account always reach
    // the same object, and no request can reach another account's.
    const tree = env.ANSA_TREE.get(env.ANSA_TREE.idFromName(owner))
    const origin = originOf(req)

    try {
      return await route({ req, url, path, tree, owner, env, origin, cors })
    } catch (err) {
      if (isRejectedWrite(err)) {
        return json({ error: (err as Error).message }, 400, cors)
      }
      if (isValueTooBig(err)) {
        return json(
          {
            error:
              'That task holds too much text to save. ' +
              'Shorten it, or split it into smaller tasks.',
          },
          413,
          cors,
        )
      }
      if (isOverQuota(err)) {
        console.error('Over quota', path, err)
        return json(
          {
            error:
              'This account has hit its daily storage limit on Cloudflare. ' +
              'Editing works again after the limit resets at 00:00 UTC; ' +
              'raise it sooner by upgrading the Workers plan.',
          },
          503,
          cors,
        )
      }
      console.error('Unhandled error', path, err)
      // Deliberately not "saving that change": this catches reads too, and
      // telling someone their edit failed when they were only listening sends
      // them off to re-type work that was never at risk.
      return json({ error: 'Something went wrong. Nothing was lost.' }, 500, cors)
    }
  },
}

interface Ctx {
  req: Request
  url: URL
  path: string
  tree: DurableObjectStub<AnsaTree>
  owner: string
  env: Env
  origin: string | null
  cors: Record<string, string>
}

async function route(c: Ctx): Promise<Response> {
  const { req, path, tree, cors } = c
  const method = req.method

  // The live stream. Upgrades to a WebSocket held by the owner's object, which
  // hibernates while idle — see ansaTree.ts for why this isn't SSE any more.
  if (path === '/api/events') {
    if (req.headers.get('upgrade') !== 'websocket') {
      return json({ error: 'This endpoint expects a WebSocket upgrade.' }, 426, cors)
    }
    // fetch() rather than an RPC method: a Response carrying a live WebSocket
    // cannot be serialized across the RPC boundary. See AnsaTree.fetch.
    return tree.fetch(req)
  }

  if (path === '/api/whoami' && method === 'GET') {
    // Exists because "no projects" and "signed in as an account that isn't the
    // one holding my data" look identical from the app. Returns the id the data
    // is actually keyed on, so it can be matched against the database.
    return json(
      {
        ownerId: c.owner,
        auth: c.env.CLERK_SECRET_KEY ? 'clerk' : 'dev',
        nodes: (await tree.load()).length,
      },
      200,
      cors,
    )
  }

  if (path === '/api/tree' && method === 'GET') {
    return json({ tree: await tree.load() }, 200, cors)
  }

  // Whole-tree replace, used by Import and the migration. The only route where
  // the caller's bytes become the database, so the shape is validated before
  // anything is written — a coercible value like `order: "3"` or a cyclic
  // parentId would store fine and then break every walk that reads it.
  if (path === '/api/tree' && method === 'PUT') {
    const body = await readJson(req)
    const bad = invalidTree(body?.tree)
    if (bad) return json({ error: bad }, 400, cors)
    return json({ tree: await tree.replaceAll(body.tree, c.origin) }, 200, cors)
  }

  // A new account's tutorial project. Returns seeded:false rather than an error
  // when the tree is non-empty — not seeding an existing account is the
  // expected outcome, not a failure — which is what makes it safe for the
  // client to call on every boot without tracking whether it has run.
  if (path === '/api/seed' && method === 'POST') {
    const { seeded, tree: seededTree } = await tree.seedIfEmpty()
    return json(seeded ? { seeded, tree: seededTree } : { seeded }, 200, cors)
  }

  // The app's write path: a named op applied to whatever the tree is now, so
  // two clients writing at once interleave instead of racing whole-document
  // overwrites. One op is one broadcast, which keeps multi-move ops like
  // adoptFollowing atomic on every other tab.
  if (path === '/api/ops' && method === 'POST') {
    const body = await readJson(req)
    const result = await tree.applyOp(body?.op ?? body, c.origin)
    return json(result, 200, cors)
  }

  if (path === '/api/nodes' && method === 'POST') {
    const body = await readJson(req)
    const parentId = body?.parentId ?? null
    if (parentId !== null && typeof parentId !== 'string') {
      return json({ error: 'parentId must be a string or null' }, 400, cors)
    }
    const text = body?.text ?? ''
    const badText = invalidText(text)
    if (badText) return json({ error: `text ${badText}` }, 400, cors)
    const { tree: next, id } = await tree.addChild(parentId, text, c.origin)
    return json({ tree: next, id }, 200, cors)
  }

  // Graft a whole nested subtree in one write. parentId null makes a new
  // project; a parent id nests it under an existing task.
  if (path === '/api/nodes/subtree' && method === 'POST') {
    const body = await readJson(req)
    const parentId = body?.parentId ?? null
    if (parentId !== null && typeof parentId !== 'string') {
      return json({ error: 'parentId must be a string or null' }, 400, cors)
    }
    const parsed = parseSpecs(body?.nodes, 'nodes')
    if (typeof parsed === 'string') return json({ error: parsed }, 400, cors)
    if (parsed.length === 0) return json({ error: 'nodes must have at least one node' }, 400, cors)
    // A new project is a single root. Extra top-level nodes would each become
    // their own project — almost never what "make a new project" means.
    if (parentId === null && parsed.length !== 1) {
      return json(
        {
          error:
            'A new project needs exactly one top-level node (the project itself); put the rest under its children. To add several tasks to an existing project, pass its id as parentId.',
        },
        400,
        cors,
      )
    }
    const { tree: next, ids } = await tree.addSubtree(parentId, body.nodes, c.origin)
    return json({ tree: next, ids }, 200, cors)
  }

  const node = path.match(/^\/api\/nodes\/([^/]+)$/)
  if (node && method === 'PATCH') {
    const id = decodeURIComponent(node[1])
    const body = await readJson(req)
    if (typeof body?.text === 'string') {
      const badText = invalidText(body.text)
      if (badText) return json({ error: `text ${badText}` }, 400, cors)
      return json({ tree: await tree.rename(id, body.text, c.origin) }, 200, cors)
    }
    if (typeof body?.done === 'boolean') {
      return json(await tree.setDone(id, body.done, c.origin), 200, cors)
    }
    if (typeof body?.pinned === 'boolean') {
      return json({ tree: await tree.setPinned(id, body.pinned, c.origin) }, 200, cors)
    }
    return json({ error: 'provide text (string), done (boolean), or pinned (boolean)' }, 400, cors)
  }

  // `?trash=1` keeps the subtree so it can be restored. Opt-in rather than the
  // default because most removals are editing mechanics — backspace merging two
  // rows, an empty row abandoned mid-edit — and a trash full of blank strings is
  // no use for the deletes that matter.
  if (node && method === 'DELETE') {
    const trash = c.url.searchParams.get('trash') === '1'
    return json({ tree: await tree.remove(decodeURIComponent(node[1]), c.origin, trash) }, 200, cors)
  }

  // ------------------------------------------------------------- the trash

  // A page of deleted subtrees, newest first. `cursor` is the `deletedAt` of the
  // last entry seen, not an offset, so the retention sweep running between two
  // pages cannot shift the window and skip an entry.
  if (path === '/api/trash' && method === 'GET') {
    const rawLimit = Number(c.url.searchParams.get('limit') ?? 50)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
    const rawCursor = c.url.searchParams.get('cursor')
    const cursor = rawCursor === null ? undefined : Number(rawCursor)
    if (cursor !== undefined && !Number.isFinite(cursor)) {
      return json({ error: 'cursor must be a number (the deletedAt of the last entry seen)' }, 400, cors)
    }
    return json(await tree.trashPage(limit, cursor), 200, cors)
  }

  const restore = path.match(/^\/api\/trash\/([^/]+)\/restore$/)
  if (restore && method === 'POST') {
    const next = await tree.restore(decodeURIComponent(restore[1]), c.origin)
    // 404 rather than a silent success: the entry is gone, which after 30 days
    // it will be, and the client showing a stale list needs to know its row is
    // no longer there rather than assume the restore worked.
    if (!next) {
      return json({ error: 'That deleted item is no longer in the trash.' }, 404, cors)
    }
    return json({ tree: next }, 200, cors)
  }

  const entry = path.match(/^\/api\/trash\/([^/]+)$/)
  if (entry && method === 'DELETE') {
    await tree.forget(decodeURIComponent(entry[1]), c.origin)
    return json({ ok: true }, 200, cors)
  }

  const move = path.match(/^\/api\/nodes\/([^/]+)\/move$/)
  if (move && method === 'POST') {
    const body = await readJson(req)
    if (typeof body?.index !== 'number') return json({ error: 'index must be a number' }, 400, cors)
    const next = await tree.move(decodeURIComponent(move[1]), body.parentId ?? null, body.index, c.origin)
    return json({ tree: next }, 200, cors)
  }

  const collapse = path.match(/^\/api\/nodes\/([^/]+)\/toggle-collapsed$/)
  if (collapse && method === 'POST') {
    return json({ tree: await tree.toggleCollapsed(decodeURIComponent(collapse[1]), c.origin) }, 200, cors)
  }

  return json({ error: `No such route: ${method} ${path}` }, 404, cors)
}

/**
 * A request's JSON body, or {} when there isn't one.
 *
 * Several routes are legitimately bodyless, and the Node server treated an
 * empty application/json body as {} for the same reason — a POST with no body
 * should not be a parse error.
 */
async function readJson(req: Request): Promise<Record<string, never>> {
  const text = await req.text()
  if (text.trim().length === 0) return {} as Record<string, never>
  try {
    return JSON.parse(text)
  } catch {
    throw new RejectedWriteError('Body must be valid JSON.')
  }
}
