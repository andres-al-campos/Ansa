/**
 * Move a tree from one Ansa instance to another, over the API.
 *
 * Over the API rather than by copying ansa.db onto the volume, because the rows
 * are owned by whoever is signed in: importing re-owns them from `legacy` to a
 * Clerk id as a side effect. Copying the file would land rows still owned by
 * `legacy`, which no Clerk account can ever read.
 *
 *   export:  npx tsx scripts/migrate.ts export <file>  --url <u> [--user <u>]
 *   import:  npx tsx scripts/migrate.ts import <file>  --url <u> --token <jwt>
 *   verify:  npx tsx scripts/migrate.ts verify <file>  --url <u> --token <jwt>
 *
 * The import refuses a destination that already has nodes. An interrupted
 * import is therefore safe to inspect but not to blindly retry — clear the
 * account first, deliberately, or you get a 409 rather than a silent merge with
 * half the previous attempt still in place.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { invalidTree, type Tree } from '../shared/tree.ts'

interface Args {
  cmd: string
  file: string
  url: string
  token?: string
  user?: string
  force: boolean
}

function parseArgs(argv: string[]): Args {
  const [cmd, file] = argv
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  const url = flag('url')
  if (!cmd || !file || !url) {
    throw new Error(
      'Usage: migrate.ts <export|import|verify> <file> --url <base-url> [--token <jwt>] [--user <id>] [--force]',
    )
  }
  return {
    cmd,
    file,
    url: url.replace(/\/$/, ''),
    token: flag('token'),
    user: flag('user'),
    force: argv.includes('--force'),
  }
}

function authHeaders({ token, user }: Args): Record<string, string> {
  if (token) return { authorization: `Bearer ${token}` }
  if (user) return { 'x-ansa-user': user }
  throw new Error('Need --token (a Clerk session JWT) or --user (dev-stub servers only).')
}

async function getTree(args: Args): Promise<Tree> {
  const res = await fetch(`${args.url}/api/tree`, { headers: authHeaders(args) })
  if (!res.ok) {
    throw new Error(
      `GET /api/tree failed: ${res.status}. ` +
        (res.status === 401
          ? 'The token is missing, wrong, or expired — Clerk session tokens last about a minute, so grab a fresh one immediately before running this.'
          : await res.text()),
    )
  }
  const body = (await res.json()) as { tree?: Tree } | Tree
  return Array.isArray(body) ? body : (body.tree ?? [])
}

/** A stable fingerprint of the tree's *content*, ignoring ids and ordering. */
function shape(tree: Tree): string[] {
  const byId = new Map(tree.map((n) => [n.id, n]))
  // Path from root, so a node that got re-parented reads as different even if
  // its text is unchanged.
  const path = (n: Tree[number]): string => {
    const parts: string[] = []
    let cur: Tree[number] | undefined = n
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      parts.unshift(cur.text)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return parts.join(' / ')
  }
  return tree.map((n) => `${path(n)}\t${n.done ? 'x' : ' '}`).sort()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.cmd === 'export') {
    const tree = await getTree(args)
    writeFileSync(args.file, JSON.stringify({ tree }, null, 2))
    console.log(`Exported ${tree.length} nodes to ${args.file}`)
    return
  }

  const raw = JSON.parse(readFileSync(args.file, 'utf8')) as { tree?: Tree } | Tree
  const tree = Array.isArray(raw) ? raw : (raw.tree ?? [])

  // Validate before touching the destination: a malformed file should fail here,
  // not halfway through a write.
  const bad = invalidTree(tree)
  if (bad) throw new Error(`${args.file} is not a valid tree: ${bad}`)

  if (args.cmd === 'verify') {
    const live = await getTree(args)
    const want = shape(tree)
    const got = shape(live)
    const same = want.length === got.length && want.every((v, i) => v === got[i])
    console.log(`local file:  ${tree.length} nodes`)
    console.log(`destination: ${live.length} nodes`)
    if (!same) {
      const missing = want.filter((v) => !got.includes(v)).slice(0, 5)
      const extra = got.filter((v) => !want.includes(v)).slice(0, 5)
      if (missing.length) console.log('missing from destination:', missing)
      if (extra.length) console.log('unexpected in destination:', extra)
      throw new Error('MISMATCH — do not delete the local copy.')
    }
    console.log(`MATCH — ${tree.length} nodes, same text, structure and done-state.`)
    return
  }

  if (args.cmd !== 'import') throw new Error(`Unknown command: ${args.cmd}`)

  // Refuse a destination that already holds anything. PUT /api/tree replaces
  // wholesale, so without this an accidental second run against a live account
  // is silent data loss.
  const existing = await getTree(args)
  if (existing.length > 0 && !args.force) {
    throw new Error(
      `Destination already has ${existing.length} nodes. Refusing to replace them.\n` +
        'Check you are signed in as the right account (GET /api/whoami). Pass --force\n' +
        'only if you are certain those rows should be destroyed.',
    )
  }

  const res = await fetch(`${args.url}/api/tree`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(args) },
    body: JSON.stringify({ tree }),
  })
  if (!res.ok) throw new Error(`PUT /api/tree failed: ${res.status} ${await res.text()}`)

  const live = await getTree(args)
  console.log(`Imported ${tree.length} nodes; destination now reports ${live.length}.`)
  console.log(`Now verify:  npx tsx scripts/migrate.ts verify ${args.file} --url ${args.url} --token <fresh-jwt>`)
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
