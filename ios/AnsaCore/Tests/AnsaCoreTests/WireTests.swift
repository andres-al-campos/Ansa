/// The JSON on the wire, checked against what the Worker actually sends.
///
/// A correct model that decodes the server's tree wrongly is no better than a
/// wrong model. The two shapes that matter: `pinned` and `lastOpenedAt` are
/// *absent* rather than null when unset (treeStore.ts omits lastOpenedAt when
/// null), and a client must not start emitting nulls the server didn't send.

import Foundation
import Testing
@testable import AnsaCore

@Suite("wire format")
struct WireTests {
    // A verbatim node as the Worker serialises one, optional fields absent.
    let serverJSON = """
        [{"id":"a","parentId":null,"text":"Sort out the flat","done":false,
          "order":0,"collapsed":false,"pinned":false,"createdAt":1755000000000}]
        """

    @Test("decodes a tree exactly as the Worker sends it")
    func decodes() throws {
        let tree = try JSONDecoder().decode(Tree.self, from: Data(serverJSON.utf8))
        #expect(tree.count == 1)
        #expect(tree[0].id == "a")
        #expect(tree[0].parentId == nil)
        #expect(tree[0].pinned == false)
        #expect(tree[0].lastOpenedAt == nil)
        // Milliseconds since the epoch, past Int32 and preserved exactly.
        #expect(tree[0].createdAt == 1_755_000_000_000)
    }

    @Test("omits unset optionals rather than sending null")
    func omitsOptionals() throws {
        let node = Node(id: "a", parentId: nil, text: "x", order: 0, createdAt: 0)
        let data = try JSONEncoder().encode([node])
        let json = String(decoding: data, as: UTF8.self)
        #expect(!json.contains("lastOpenedAt"))
        #expect(!json.contains("pinned"))
        // parentId is a real null on a root, not an omission — the server's
        // schema has the column and roots are addressed by it.
        #expect(json.contains("\"parentId\":null"))
    }

    @Test("round-trips a stamped project without drift")
    func roundTrip() throws {
        var node = Node(id: "a", text: "x", order: 0, createdAt: 1_755_000_000_000)
        node.lastOpenedAt = 1_755_000_009_999
        node.pinned = true
        let back = try JSONDecoder().decode(Tree.self, from: JSONEncoder().encode([node]))
        #expect(back == [node])
    }
}

/// The same checks against bytes the Worker really produced.
///
/// The hand-written JSON above only proves the client agrees with my idea of the
/// format. This fixture was captured from `GET /api/tree` on a running Worker
/// (a throwaway seed user, not anyone's real data), so it proves the client
/// agrees with the server. Re-capture it when the wire format changes.
@Suite("against a tree the Worker actually produced")
struct RealTreeTests {
    struct TreeResponse: Decodable { let tree: Tree }

    func realTree() throws -> Tree {
        let url = try #require(
            Bundle.module.url(forResource: "real-tree", withExtension: "json"))
        return try JSONDecoder()
            .decode(TreeResponse.self, from: Data(contentsOf: url)).tree
    }

    @Test("decodes the seeded tour tree")
    func decodesReal() throws {
        let tree = try realTree()
        #expect(tree.count == 18)
        let roots = TreeOps.roots(tree)
        #expect(roots.count == 1)
        #expect(roots[0].text == "Start here — a tour of Ansa")
        #expect(roots[0].parentId == nil)
    }

    @Test("the ported walks work on a real tree, not just the fixture")
    func walksReal() throws {
        let tree = try realTree()
        let root = try #require(TreeOps.roots(tree).first)
        // Every node hangs off the single root, so the subtree is the rest.
        #expect(TreeOps.subtreeOf(tree, root.id).count == tree.count - 1)
        let p = TreeOps.progressOf(tree, root.id)
        #expect(p.total == TreeOps.leavesUnder(tree, root.id).count)
        #expect(p.total > 0)
        // Lineage of every node terminates at that root.
        for node in tree {
            #expect(TreeOps.lineageOf(tree, node.id).first?.id == root.id)
        }
    }

    @Test("fingerprints the tree exactly as the TypeScript side does")
    func fingerprintMatchesTypeScript() throws {
        // Pinned to the same constants as `shared/tree.test.ts`. The server
        // stamps every frame with its fingerprint and this device compares its
        // own; if the two implementations drift the phone refetches the tree
        // after every remote edit, which is the old behaviour and invisible.
        #expect(TreeOps.fingerprint(try realTree()) == "e314e562")
        #expect(TreeOps.fingerprint([]) == "811c9dc5")
    }

    @Test("re-encoding preserves every key the server sent")
    func reEncodeReal() throws {
        let tree = try realTree()
        let round = try JSONDecoder().decode(Tree.self, from: JSONEncoder().encode(tree))
        #expect(round == tree)

        // Key-level, not just value-level: a dropped optional would still
        // decode back to the same struct, but the server would see a different
        // object. Compare the key sets node by node.
        let url = try #require(
            Bundle.module.url(forResource: "real-tree", withExtension: "json"))
        let original = try #require(
            (try JSONSerialization.jsonObject(with: Data(contentsOf: url))
                as? [String: Any])?["tree"] as? [[String: Any]])
        let mine = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(tree))
                as? [[String: Any]])
        for (before, after) in zip(original, mine) {
            #expect(Set(before.keys) == Set(after.keys), "keys differ on \(before["id"] ?? "?")")
        }
    }
}
