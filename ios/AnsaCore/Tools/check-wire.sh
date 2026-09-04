#!/usr/bin/env bash
#
# Cross-language wire check: encode one of every Op in Swift, then feed the
# bytes to the TypeScript parseOp the server actually runs.
#
# The Swift suite proves the client agrees with itself, and the TypeScript suite
# proves the server agrees with itself. Neither can catch the failure that
# matters most here — a Swift enum encodes to a shape the server 400s — because
# the two never meet inside either test run. This is the only check that spans
# the boundary, so it runs against the real parseOp rather than a copy of it.
#
# Not part of `swift test`: it needs node and the repo's TypeScript, which a
# bare package checkout won't have. Run it when either side's op format changes.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"
repo="$(cd "$package/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One executable built from the package sources plus a main that prints a sample
# of every op kind. Concatenated rather than imported so this needs no extra
# SwiftPM target of its own.
{
  echo 'import Foundation'
  grep -h -v '^import Foundation' \
    "$package/Sources/AnsaCore/Tree.swift" \
    "$package/Sources/AnsaCore/TreeMoves.swift" \
    "$package/Sources/AnsaCore/Ops.swift"
  cat <<'SWIFT'

let samples: [Op] = [
    .addChild(id: "a", parentId: nil, text: "x", at: 1),
    .addSubtree(
        ids: ["a", "b"], parentId: "p",
        nodes: [TreeOps.SubtreeSpec(text: "x", children: [TreeOps.SubtreeSpec(text: "y")])],
        at: 1),
    .setText(id: "a", text: "x"),
    .setDone(id: "a", done: true),
    .removeNode(id: "a"),
    // Both forms: the flag rides on the same op kind, so a plain delete and a
    // trashing one are two different payloads the server has to accept.
    .removeNode(id: "a", trash: true),
    .moveNode(id: "a", parentId: nil, index: 0),
    .indent(id: "a"),
    .outdent(id: "a"),
    .adoptFollowing(id: "a"),
    .insertAtDepth(id: "a", anchorId: "b", depth: 0, side: .after, scope: nil),
    .insertAtDepth(id: "a", anchorId: "b", depth: 2, side: .before, scope: "s"),
    .toggleCollapsed(id: "a"),
    .setPinned(id: "a", pinned: true),
    .markOpened(id: "a", at: 1),
]
print(String(decoding: try JSONEncoder().encode(samples), as: UTF8.self))
SWIFT
} > "$work/emit.swift"

swift "$work/emit.swift" > "$work/ops.json"

cd "$repo"
OPS_JSON="$work/ops.json" npx tsx -e '
import { parseOp, OP_KINDS } from "./shared/ops.ts"
import { readFileSync } from "node:fs"

const ops = JSON.parse(readFileSync(process.env.OPS_JSON!, "utf8"))
let bad = 0
for (const op of ops) {
  const result = parseOp(op)
  if ("error" in result) {
    console.error(`REJECTED ${op.op}: ${result.error}`)
    bad++
  }
}

// Coverage matters as much as validity: a new op on either side that this
// script never emits would pass silently.
const seen = new Set(ops.map((o: { op: string }) => o.op))
const missing = OP_KINDS.filter((k) => !seen.has(k))
if (missing.length) {
  console.error(`not covered by this check: ${missing.join(", ")}`)
  bad++
}

if (bad) {
  console.error(`\nThe Swift encoder and the server disagree. Fix Ops.swift to`)
  console.error(`match the shape parseOp reads in shared/ops.ts.`)
  process.exit(1)
}
console.log(`ok — the server accepts all ${ops.length} Swift-encoded ops, covering every kind`)
'
