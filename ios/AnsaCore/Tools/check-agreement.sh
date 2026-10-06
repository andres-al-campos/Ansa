#!/usr/bin/env bash
#
# Law 4: Swift and TypeScript applyOp produce the same tree.
#
# The phone applies each op locally and the server applies it again, and the
# two must land on the same tree. check-wire.sh proves the server can read the
# ops the phone sends; this proves they then do the same thing. TypeScript
# generates random trees and op sequences and records its result after each op,
# Swift replays them, and TypeScript compares and prints the smallest mismatch.
#
# AGREE_SEED=<n> replays a run; the seed is printed when a run fails.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"
repo="$(cd "$package/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
seed="${AGREE_SEED:-$RANDOM$RANDOM}"

cd "$repo"
npx tsx "$here/agreement.ts" gen "$work/cases.json" "$seed"

# Concatenated rather than imported, like check-wire.sh, so this needs no
# SwiftPM target of its own.
{
  echo 'import Foundation'
  grep -h -v '^import Foundation' \
    "$package/Sources/AnsaCore/Tree.swift" \
    "$package/Sources/AnsaCore/TreeMoves.swift" \
    "$package/Sources/AnsaCore/Ops.swift"
  cat <<'SWIFT'

struct Case: Decodable { let tree: [Node]; let ops: [Op] }

let input = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONDecoder().decode([Case].self, from: input)
let results: [[[Node]]] = cases.map { c in
    var tree = c.tree
    return c.ops.map { op in
        tree = TreeOps.applyOp(tree, op).tree
        return tree
    }
}
print(String(decoding: try JSONEncoder().encode(results), as: UTF8.self))
SWIFT
} > "$work/replay.swift"

swiftc -O "$work/replay.swift" -o "$work/replay" 2>&1 | grep -v warning: || true
"$work/replay" "$work/cases.json" > "$work/swift.json"

if ! npx tsx "$here/agreement.ts" compare "$work/cases.json" "$work/swift.json"; then
  echo "Replay this run with: AGREE_SEED=$seed ios/build.sh agree" >&2
  exit 1
fi
