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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { childrenOf, progressOf, type NodeId, type Tree } from '../../shared/tree.ts'

const BASE = process.env.ANSA_API ?? 'http://127.0.0.1:4000'

/** Call the server; throw a readable error the model can act on. */
async function api(path: string, init?: RequestInit): Promise<{ tree: Tree } & Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-ansa-origin': 'mcp', ...init?.headers },
    })
  } catch {
    throw new Error(
      `Can't reach the Ansa server at ${BASE}. Start it with \`npm run server\` in the Ansa repo, then retry.`,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Ansa API ${res.status} on ${path}: ${body || res.statusText}`)
  }
  return res.json() as Promise<{ tree: Tree } & Record<string, unknown>>
}

/** Render the tree as an indented outline with ids and done-state, so the model
 *  can see structure and address nodes by id in the same glance. */
function renderOutline(tree: Tree): string {
  const lines: string[] = []
  const walk = (parentId: NodeId | null, depth: number) => {
    for (const n of childrenOf(tree, parentId)) {
      const box = n.done ? '[x]' : '[ ]'
      const fold = n.collapsed ? ' (collapsed)' : ''
      lines.push(`${'  '.repeat(depth)}- ${box} ${n.text || '(untitled)'}  {${n.id}}${fold}`)
      walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.length ? lines.join('\n') : '(empty — no tasks yet)'
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
    return text(`${label} (root ${ids[0]}).\n\n${renderOutline(res.tree)}`)
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
    return text(`Renamed ${id}.\n\n${renderOutline(tree)}`)
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
    return text(`Set ${id} ${done ? 'done' : 'not done'}.\n\n${renderOutline(tree)}`)
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
    return text(`Moved ${id}.\n\n${renderOutline(tree)}`)
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
    return text(`Toggled fold on ${id}.\n\n${renderOutline(tree)}`)
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
    const { tree } = await api(`/api/nodes/${id}`, { method: 'DELETE' })
    return text(`Deleted ${id} and its subtree.\n\n${renderOutline(tree)}`)
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
