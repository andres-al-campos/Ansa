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
 *   merge:   npx tsx scripts/migrate.ts merge  <file>  --url <u> --token <jwt>
 *   verify:  npx tsx scripts/migrate.ts verify <file>  --url <u> --token <jwt> [--subset]
 *
 * import *replaces* and refuses a destination that already has nodes. An
 * interrupted import is therefore safe to inspect but not to blindly retry —
 * clear the account first, deliberately, or you get a 409 rather than a silent
 * merge with half the previous attempt still in place.
 *
 * merge *appends*, keeping what the destination already holds. It is a separate
 * command rather than a flag because the difference — whether existing nodes
 * survive — is too large to hang on something mistypeable. It refuses on any id
 * shared between the two trees, since the merge is a concatenation and a shared
 * id would silently drop a node.
 *
 * After a merge, verify with --subset: the destination legitimately holds more
 * than the file, so an exact-match check would report a false mismatch.
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
  /** verify: pass when the destination is expected to hold more than the file. */
  subset: boolean
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
      'Usage: migrate.ts <export|import|merge|verify> <file> --url <base-url> [--token <jwt>] [--user <id>] [--force] [--subset]',
    )
  }
  return {
    cmd,
    file,
    url: url.replace(/\/$/, ''),
    token: flag('token'),
    user: flag('user'),
    force: argv.includes('--force'),
    subset: argv.includes('--subset'),
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
    // After a merge the destination holds its own nodes too, so "identical" is
    // the wrong test — every node from the file must be present, and extras are
    // expected rather than a failure.
    const same = args.subset
      ? want.every((v) => got.includes(v))
      : want.length === got.length && want.every((v, i) => v === got[i])
    console.log(`local file:  ${tree.length} nodes`)
    console.log(`destination: ${live.length} nodes`)
    if (!same) {
      const missing = want.filter((v) => !got.includes(v)).slice(0, 5)
      if (missing.length) console.log('missing from destination:', missing)
      // Under --subset the destination keeps its own nodes, so extras are the
      // point of the exercise rather than evidence of a problem.
      if (!args.subset) {
        const extra = got.filter((v) => !want.includes(v)).slice(0, 5)
        if (extra.length) console.log('unexpected in destination:', extra)
      }
      throw new Error('MISMATCH — do not delete the local copy.')
    }
    console.log(
      args.subset
        ? `MATCH — all ${tree.length} nodes present (destination holds ${live.length} in total).`
        : `MATCH — ${tree.length} nodes, same text, structure and done-state.`,
    )
    return
  }

  if (args.cmd === 'merge') {
    // Append rather than replace. A separate command rather than a flag on
    // import, because the two differ by "the destination's existing nodes
    // survive" — too big a difference to hang on a flag someone can mistype.
    const existing = await getTree(args)

    // Ids must be disjoint. The merged tree is a plain concatenation, so a
    // shared id would mean two different nodes claiming one identity — the
    // reader keeps whichever it sees last and the other silently vanishes.
    const existingIds = new Set(existing.map((n) => n.id))
    const clashes = tree.filter((n) => existingIds.has(n.id)).map((n) => n.id)
    if (clashes.length > 0) {
      throw new Error(
        `${clashes.length} node id(s) exist in both trees: ${clashes.slice(0, 5).join(', ')}\n` +
          'Concatenating would drop one node per collision. Re-id the incoming file first.',
      )
    }

    const merged = [...existing, ...tree]
    const bad = invalidTree(merged)
    if (bad) throw new Error(`Merged tree is invalid: ${bad}`)

    console.log(`Destination has ${existing.length}; adding ${tree.length}; result ${merged.length}.`)

    const res = await fetch(`${args.url}/api/tree`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(args) },
      body: JSON.stringify({ tree: merged }),
    })
    if (!res.ok) throw new Error(`PUT /api/tree failed: ${res.status} ${await res.text()}`)

    const live = await getTree(args)
    console.log(`Merged. Destination now reports ${live.length} nodes.`)
    if (live.length !== merged.length) {
      throw new Error(`Expected ${merged.length} nodes after merge, got ${live.length}.`)
    }
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
