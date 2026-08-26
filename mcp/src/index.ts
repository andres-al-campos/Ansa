/**
 * Ansa MCP server: lets another Claude do everything a human can do in the app.
 *
 * It is a thin client of the same REST API the browser uses — it never touches
 * the database directly — so a Claude and a person editing at the same time are
 * writing through one source of truth and can't diverge.
 *
 * `view_tree` renders the outline as indented text so the model can *read* the
 * current state; the rest map one-to-one to the app's atomic actions: add,
 * rename, check/uncheck, move, fold, remove.
 */

import { execFileSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { byId, childrenOf, progressOf, type Node, type NodeId, type Tree } from '../../shared/tree.ts'

const BASE = process.env.ANSA_API ?? 'https://ansa.id3arium.workers.dev'

/**
 * Whose tree this MCP server edits.
 *
 * A stdio MCP server is launched by one person's client, so it acts as that one
 * user — there's no session to derive it from.
 *
 * Two ways to say who that is. `ANSA_TOKEN` is the real one: a long-lived
 * bearer token the worker maps to a Clerk user id, which is what reaches the
 * same tree the browser and the phone see. `ANSA_USER` is the dev stub's
 * header, which only a local server with ANSA_DEV_AUTH=1 will honour — a
 * deployed worker ignores it, by design.
 */
const TOKEN = process.env.ANSA_TOKEN || keychainToken()
const USER = process.env.ANSA_USER ?? 'legacy'

/**
 * The token from the macOS Keychain, or empty if it isn't there.
 *
 * Same arrangement build.sh uses for the Clerk keys, and for the same reason:
 * this repo keeps secrets in the Keychain rather than in files, and an MCP
 * client config is a file. Without this the token's only home would be a
 * plaintext `env` block in claude_desktop_config.json.
 *
 * An env var wins when set, so a Linux machine, CI, or a container passes the
 * token the ordinary way and never reaches this.
 *
 * Add it with (it prompts, so the value stays out of shell history):
 *   security add-generic-password -a "$USER" -s ansa-mcp-token -w
 */
function keychainToken(): string {
  if (process.platform !== 'darwin') return ''
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'ansa-mcp-token', '-w'], {
      encoding: 'utf8',
      // A missing item exits non-zero and prints to stderr; that is a normal
      // "not configured" answer here, not something to show the user.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** Call the server; throw a readable error the model can act on. */
async function api(path: string, init?: RequestInit): Promise<{ tree: Tree } & Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        // Only when there's something to declare a type for. Sending it on a
        // bodyless request — every DELETE — makes Fastify expect JSON, find an
        // empty body, and reject with FST_ERR_CTP_EMPTY_JSON_BODY before the
        // route ever runs.
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-ansa-origin': 'mcp',
        // The token when there is one, the stub header otherwise. Never both:
        // sending a header the deployed worker ignores alongside a token that
        // works is how a broken token reads as a working one locally.
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : { 'x-ansa-user': USER }),
        ...init?.headers,
      },
    })
  } catch {
    throw new Error(
      `Can't reach the Ansa server at ${BASE}. If that's a local server, start ` +
        'it with `npm run server` in the Ansa repo. If it should be the deployed ' +
        'one, unset ANSA_API to use the default. Then retry.',
    )
  }
  if (res.status === 401) {
    throw new Error(
      TOKEN
        ? 'Ansa rejected the token in ANSA_TOKEN. Check it matches the hash the ' +
          'worker holds: `printf %s "$ANSA_TOKEN" | shasum -a 256` should equal ' +
          'ANSA_MCP_TOKEN_SHA256 there. Re-set it with `wrangler secret put ' +
          'ANSA_MCP_TOKEN_SHA256` if not.'
        : `Not signed in to Ansa at ${BASE}. Set ANSA_TOKEN to the MCP token ` +
          'for your account — see the MCP section of the repo README. (ANSA_USER ' +
          'only works against a local server started with ANSA_DEV_AUTH=1.)',
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Ansa API ${res.status} on ${path}: ${body || res.statusText}`)
  }
  return res.json() as Promise<{ tree: Tree } & Record<string, unknown>>
}

/** One outline line for a node, at `depth` levels of indent. */
function renderLine(n: Node, depth: number): string {
  const box = n.done ? '[x]' : '[ ]'
  const fold = n.collapsed ? ' (collapsed)' : ''
  return `${'  '.repeat(depth)}- ${box} ${n.text || '(untitled)'}  {${n.id}}${fold}`
}

/**
 * Render the tree as an indented outline with ids and done-state, so the model
 * can see structure and address nodes by id in the same glance.
 *
 * `root` scopes it to one subtree, including the root node itself. Omit it for
 * the whole tree.
 */
function renderOutline(tree: Tree, root: NodeId | null = null): string {
  const lines: string[] = []
  const walk = (parentId: NodeId | null, depth: number) => {
    for (const n of childrenOf(tree, parentId)) {
      lines.push(renderLine(n, depth))
      walk(n.id, depth + 1)
    }
  }
  if (root === null) {
    walk(null, 0)
  } else {
    const node = byId(tree, root)
    if (!node) return `(${root} is no longer in the tree)`
    lines.push(renderLine(node, 0))
    walk(root, 1)
  }
  return lines.length ? lines.join('\n') : '(empty — no tasks yet)'
}

/**
 * Just the top-level projects, one line each, with no children.
 *
 * The echo for a change to the project list itself — a project deleted, or one
 * moved to the top level. Printing every project's full contents to show that
 * the *list* changed is the whole-tree cost this scoping exists to avoid.
 */
function renderProjects(tree: Tree): string {
  const lines = childrenOf(tree, null).map((n) => renderLine(n, 0))
  return lines.length
    ? `${lines.join('\n')}\n\n(Top-level projects only. Use view_tree for the whole outline.)`
    : '(empty — no tasks yet)'
}

/**
 * What a write tool echoes back: the affected subtree, not the whole outline.
 *
 * The server returns the entire tree on every write — the right call for the
 * browser, which replaces its state wholesale over SSE and so can never be
 * partially updated. A model is a different consumer: re-printing every node
 * after each call spends context, the scarcest thing in the loop, on lines that
 * did not change. `view_tree` is still there when the whole picture is wanted.
 */
function changed(tree: Tree, id: NodeId): string {
  return `${renderOutline(tree, id)}\n\n(Subtree shown. Use view_tree for the whole outline.)`
}

/**
 * The top-level project a node sits under, or the node itself if it is one.
 *
 * Completion propagates upward — a parent auto-completes once its last child is
 * checked — so echoing only the checked node's own subtree would hide the very
 * rollup `set_done` advertises. The project is the smallest scope that always
 * contains every node whose state can have changed.
 */
function projectOf(tree: Tree, id: NodeId): NodeId {
  let node = byId(tree, id)
  while (node?.parentId) {
    const parent = byId(tree, node.parentId)
    if (!parent) break
    node = parent
  }
  return node?.id ?? id
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

const server = new McpServer({ name: 'ansa', version: '0.1.0' })

server.registerTool(
  'view_tree',
  {
    title: 'View the outline',
    description:
      'Read the whole to-do outline as indented text. Each line shows a checkbox, the title, and the node id in {braces}. Use the id to target other actions.',
    inputSchema: {},
  },
  async () => {
    const { tree } = await api('/api/tree')
    return text(renderOutline(tree))
  },
)

// A nested outline the model can hand over in one call. Recursive, so it can
// describe parents, children and grandchildren to any depth at once.
type SubtreeInput = { text: string; children?: SubtreeInput[] }
const subtreeNode: z.ZodType<SubtreeInput> = z.lazy(() =>
  z.object({
    text: z.string().describe('The task title'),
    children: z.array(subtreeNode).optional().describe('Nested sub-tasks, same shape, any depth'),
  }),
)

server.registerTool(
  'add_subtree',
  {
    title: 'Add tasks',
    description:
      'The one tool for creating tasks — from a single node to a whole nested tree of parents, children and ' +
      'grandchildren, any depth, in one call. For a single task, pass one node with no children. ' +
      'Omit parentId (or pass null) to start a brand-new project: pass exactly one top-level node (the project ' +
      'itself) with the rest of the tree under its children. Pass a parent id to graft under an existing task, ' +
      'where several top-level nodes are fine. Returns the created ids depth-first (the first id is the subtree ' +
      'root — the new project when parentId is null).',
    inputSchema: {
      parentId: z
        .string()
        .nullable()
        .optional()
        .describe('Parent node id to graft under, or null/omitted to create a new top-level project'),
      nodes: z.array(subtreeNode).min(1).describe('The nested outline to create, as [{ text, children? }]'),
    },
  },
  async ({ parentId, nodes }) => {
    const res = await api('/api/nodes/subtree', {
      method: 'POST',
      body: JSON.stringify({ parentId: parentId ?? null, nodes }),
    })
    const ids = res.ids as string[]
    const label = parentId ? `Grafted ${ids.length} tasks under ${parentId}` : `Created a new project with ${ids.length} tasks`
    return text(`${label} (root ${ids[0]}).\n\n${changed(res.tree, ids[0])}`)
  },
)

server.registerTool(
  'rename_task',
  {
    title: 'Rename a task',
    description: 'Change the title of an existing task.',
    inputSchema: { id: z.string(), text: z.string().describe('The new title') },
  },
  async ({ id, text: t }) => {
    const { tree } = await api(`/api/nodes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: t }),
    })
    return text(`Renamed ${id}.\n\n${changed(tree, id)}`)
  },
)

server.registerTool(
  'set_done',
  {
    title: 'Check or uncheck a task',
    description:
      'Mark a task done or not done. Checking a parent completes its whole subtree; a parent auto-completes when all its children are done (and un-completes when one is unchecked).',
    inputSchema: { id: z.string(), done: z.boolean() },
  },
  async ({ id, done }) => {
    const { tree } = await api(`/api/nodes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done }),
    })
    // Scoped to the project, not the node: completion rolls up through every
    // ancestor, and those lines are the point of the call.
    return text(`Set ${id} ${done ? 'done' : 'not done'}.\n\n${changed(tree, projectOf(tree, id))}`)
  },
)

server.registerTool(
  'move_task',
  {
    title: 'Move a task',
    description:
      'Re-parent a task and place it at a 0-based index among the new parent\'s children. Pass parentId null to move it to the top level. Moving a node into itself or its own descendant is rejected.',
    inputSchema: {
      id: z.string(),
      parentId: z.string().nullable().describe('New parent id, or null for top level'),
      index: z.number().int().min(0).describe('0-based position among the destination siblings'),
    },
  },
  async ({ id, parentId, index }) => {
    const { tree } = await api(`/api/nodes/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ parentId, index }),
    })
    // A rejected move is a silent no-op in the tree model — the same tree comes
    // back — so success can't be assumed from the call returning. Check where
    // the node actually landed instead of restating the request. Asking the
    // result rather than re-deriving the rules keeps this honest if they change.
    if (!childrenOf(tree, parentId).some((n) => n.id === id)) {
      return text(
        `Did not move ${id}: a task cannot be moved into itself or one of its own ` +
          `descendants. Move it to a parent outside its own subtree, or to the top ` +
          `level with parentId null.\n\n${changed(tree, projectOf(tree, id))}`,
      )
    }
    // Show the destination, which is what confirms the move landed where asked.
    // A move to the top level has no destination subtree, so the whole outline
    // is the only honest scope for it.
    return text(
      `Moved ${id}.\n\n${parentId === null ? renderProjects(tree) : changed(tree, parentId)}`,
    )
  },
)

server.registerTool(
  'toggle_collapsed',
  {
    title: 'Fold or unfold a task',
    description: 'Collapse or expand a task in place (a view toggle, like clicking the twisty).',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const { tree } = await api(`/api/nodes/${id}/toggle-collapsed`, { method: 'POST' })
    return text(`Toggled fold on ${id}.\n\n${changed(tree, id)}`)
  },
)

server.registerTool(
  'remove_task',
  {
    title: 'Delete a task',
    description: 'Delete a task and everything nested under it. This cannot be undone through the API.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    // Where the node sat, read before it goes: afterwards there is nothing left
    // to locate it by, and the useful echo is the list it was removed from.
    const { tree: before } = await api('/api/tree')
    const parentId = byId(before, id)?.parentId ?? null
    const { tree } = await api(`/api/nodes/${id}`, { method: 'DELETE' })
    // A deleted project has no surviving parent to show, so fall back to the
    // top-level list — which is exactly what changed in that case.
    return text(
      `Deleted ${id} and its subtree.\n\n` +
        (parentId === null ? renderProjects(tree) : changed(tree, parentId)),
    )
  },
)

server.registerTool(
  'progress',
  {
    title: 'Progress of a task',
    description:
      'Report leaf-weighted progress under a task: how many of its smallest sub-tasks are done, out of the total, as a percentage.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const { tree } = await api('/api/tree')
    const p = progressOf(tree, id)
    return text(`${id}: ${p.done}/${p.total} leaves done (${p.pct}%).`)
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
