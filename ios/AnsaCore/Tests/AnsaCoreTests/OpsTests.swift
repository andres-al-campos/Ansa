/// Ported from `shared/ops.test.ts`, case for case.
///
/// `parseOp` has no Swift counterpart — the decoder is the validator here, so
/// the parse cases are ported as decode successes and failures. That is the
/// honest equivalent: on the phone the thing that can hand `applyOp` a malformed
/// op is `JSONDecoder`, not a hand-rolled switch.

import Foundation
import Testing
@testable import AnsaCore

/// The ops fixture, which numbers `order` per parent rather than globally.
///
///  taxes
///    gather -> g1 (done) g2
///    forms  -> p1 p2
///  flat
///    f1 f2
func opsFixture() -> Tree {
    let spec: [(NodeId, NodeId?, String, Bool)] = [
        ("taxes", nil, "File the tax return", false),
        ("gather", "taxes", "Gather documents", false),
        ("g1", "gather", "Find last year's return", true),
        ("g2", "gather", "Download bank CSV", false),
        ("forms", "taxes", "Fill in the forms", false),
        ("p1", "forms", "Page 1", false),
        ("p2", "forms", "Page 2", false),
        ("flat", nil, "Sort out the flat", false),
        ("f1", "flat", "Bins", false),
        ("f2", "flat", "Hoover", false),
    ]
    var order: [NodeId: Int] = [:]
    let rootKey = "\u{0}root"
    return spec.map { item in
        let key = item.1 ?? rootKey
        let o = order[key] ?? 0
        order[key] = o + 1
        return Node(
            id: item.0, parentId: item.1, text: item.2, done: item.3,
            order: o, collapsed: false, createdAt: 0)
    }
}

private func ids(_ tree: Tree, _ parentId: NodeId?) -> [NodeId] {
    TreeOps.childrenOf(tree, parentId).map(\.id)
}

/// The property the whole scheme rests on: applying an op must land on exactly
/// what calling the underlying pure function does. Client and server both go
/// through applyOp, so if this drifts the two sides silently disagree.
@Suite("applyOp matches the pure op it names")
struct ApplyOpTests {
    @Test("setText")
    func setText() {
        let t = opsFixture()
        #expect(
            TreeOps.applyOp(t, .setText(id: "g2", text: "Bank CSVs")).tree
                == TreeOps.setText(t, "g2", "Bank CSVs"))
    }

    @Test("setDone, and passes back the ancestors that flipped")
    func setDone() {
        let t = opsFixture()
        let direct = TreeOps.setDone(t, "g2", true)
        let viaOp = TreeOps.applyOp(t, .setDone(id: "g2", done: true))
        #expect(viaOp.tree == direct.tree)
        #expect(viaOp.completed == direct.completed)
        // g1 was already done, so finishing g2 completes gather.
        #expect(viaOp.completed.contains("gather"))
    }

    @Test("removeNode")
    func removeNode() {
        let t = opsFixture()
        #expect(
            TreeOps.applyOp(t, .removeNode(id: "gather")).tree
                == TreeOps.reconcileDone(TreeOps.removeNode(t, "gather")))
    }

    @Test("moveNode")
    func moveNode() {
        let t = opsFixture()
        #expect(
            TreeOps.applyOp(t, .moveNode(id: "g1", parentId: "forms", index: 1)).tree
                == TreeOps.reconcileDone(TreeOps.moveNode(t, "g1", "forms", 1)))
    }

    @Test("indent")
    func indent() {
        let t = opsFixture()
        #expect(TreeOps.applyOp(t, .indent(id: "g2")).tree == TreeOps.reconcileDone(TreeOps.indent(t, "g2")))
    }

    @Test("outdent")
    func outdent() {
        let t = opsFixture()
        #expect(TreeOps.applyOp(t, .outdent(id: "g2")).tree == TreeOps.reconcileDone(TreeOps.outdent(t, "g2")))
    }

    @Test("adoptFollowing")
    func adoptFollowing() {
        let t = opsFixture()
        #expect(
            TreeOps.applyOp(t, .adoptFollowing(id: "gather")).tree
                == TreeOps.reconcileDone(TreeOps.adoptFollowing(t, "gather")))
    }

    @Test("insertAtDepth")
    func insertAtDepth() {
        let t = opsFixture()
        let op = Op.insertAtDepth(
            id: "f1", anchorId: "p1", depth: 1, side: .after, scope: "taxes")
        #expect(
            TreeOps.applyOp(t, op).tree
                == TreeOps.reconcileDone(TreeOps.insertAtDepth(t, "f1", "p1", 1, .after, "taxes")))
    }

    @Test("toggleCollapsed")
    func toggleCollapsed() {
        let t = opsFixture()
        #expect(
            TreeOps.applyOp(t, .toggleCollapsed(id: "forms")).tree
                == TreeOps.toggleCollapsed(t, "forms"))
    }

    @Test("setPinned")
    func setPinned() {
        let t = opsFixture()
        #expect(
            TreeOps.applyOp(t, .setPinned(id: "flat", pinned: true)).tree
                == TreeOps.setPinned(t, "flat", true))
    }

    @Test("markOpened stores the timestamp the op carried, not the clock")
    func markOpened() {
        let at = 1_700_000_000_000.0
        let next = TreeOps.applyOp(opsFixture(), .markOpened(id: "flat", at: at)).tree
        #expect(TreeOps.byId(next, "flat")?.lastOpenedAt == at)
    }
}

/// Creation is where client and server would drift: both would otherwise mint
/// their own ids and read their own clocks. The op carries both so the two sides
/// produce the same node.
@Suite("creation ops are deterministic")
struct CreationTests {
    @Test("addChild uses the id and timestamp from the op")
    func addChild() {
        let op = Op.addChild(id: "fixed-id", parentId: "flat", text: "Mop", at: 12345)
        let next = TreeOps.applyOp(opsFixture(), op).tree
        let made = TreeOps.byId(next, "fixed-id")
        #expect(made != nil)
        #expect(made?.text == "Mop")
        #expect(made?.parentId == "flat")
        #expect(made?.createdAt == 12345)
    }

    @Test("two machines applying the same addChild get identical trees")
    func deterministic() {
        // The client applies it to its copy; the server applies it to its own.
        let op = Op.addChild(id: "same", parentId: "flat", text: "Mop", at: 999)
        #expect(TreeOps.applyOp(opsFixture(), op).tree == TreeOps.applyOp(opsFixture(), op).tree)
    }

    @Test("addSubtree takes its ids depth-first, in the order given")
    func addSubtree() {
        let op = Op.addSubtree(
            ids: ["a", "b", "c"], parentId: "flat",
            nodes: [TreeOps.SubtreeSpec(
                text: "Kitchen",
                children: [
                    TreeOps.SubtreeSpec(text: "Sink"), TreeOps.SubtreeSpec(text: "Oven"),
                ])],
            at: 500)
        let next = TreeOps.applyOp(opsFixture(), op).tree
        #expect(TreeOps.byId(next, "a")?.text == "Kitchen")
        #expect(TreeOps.byId(next, "b")?.text == "Sink")
        #expect(TreeOps.byId(next, "c")?.text == "Oven")
        #expect(TreeOps.byId(next, "b")?.parentId == "a")
        #expect(TreeOps.byId(next, "c")?.parentId == "a")
    }

    @Test("mints an id when the op runs past the ids it was given")
    func mintsExtra() {
        let op = Op.addSubtree(
            ids: ["only-one"], parentId: "flat",
            nodes: [TreeOps.SubtreeSpec(text: "A"), TreeOps.SubtreeSpec(text: "B")], at: 0)
        let next = TreeOps.applyOp(opsFixture(), op).tree
        #expect(TreeOps.byId(next, "only-one")?.text == "A")
        // The second node still lands, under a minted id rather than throwing.
        #expect(
            TreeOps.childrenOf(next, "flat").map(\.text) == ["Bins", "Hoover", "A", "B"])
    }
}

/// A queued op can reach the server after the tree has moved on — the node it
/// names may have been deleted by someone else in the meantime. That has to be a
/// no-op, not a crash, or one racing delete would wedge the client. This is the
/// normal case on a phone coming back from offline, not an edge case.
@Suite("applyOp is total")
struct TotalityTests {
    static let unknown: [Op] = [
        .setText(id: "ghost", text: "x"),
        .setDone(id: "ghost", done: true),
        .removeNode(id: "ghost"),
        .moveNode(id: "ghost", parentId: "flat", index: 0),
        .indent(id: "ghost"),
        .outdent(id: "ghost"),
        .adoptFollowing(id: "ghost"),
        .insertAtDepth(id: "ghost", anchorId: "p1", depth: 0, side: .after, scope: nil),
        .toggleCollapsed(id: "ghost"),
        .setPinned(id: "ghost", pinned: true),
        .markOpened(id: "ghost", at: 1),
    ]

    @Test("an op against a missing node leaves the tree alone", arguments: unknown)
    func missingNode(op: Op) {
        let t = opsFixture()
        #expect(TreeOps.applyOp(t, op).tree == t)
    }

    @Test("an op naming a missing anchor is also survivable")
    func missingAnchor() {
        let op = Op.insertAtDepth(
            id: "f1", anchorId: "ghost", depth: 0, side: .after, scope: nil)
        // The assertion is that this returns at all rather than trapping.
        _ = TreeOps.applyOp(opsFixture(), op)
    }
}

/// The regression the whole op scheme exists for. Two clients edit different
/// branches at the same time; the server replays both ops against its own tree.
/// Under the old whole-tree write the second save would have erased the first.
@Suite("concurrent edits on unrelated branches both survive")
struct ConcurrencyTests {
    @Test("a rename and an add do not clobber each other")
    func renameAndAdd() {
        // Both clients start from the same tree and act without seeing each other.
        let fromApp = Op.setText(id: "g2", text: "Bank statements")
        let fromMcp = Op.addChild(id: "new", parentId: "flat", text: "Wash up", at: 7)
        let after = TreeOps.applyOp(
            TreeOps.applyOp(opsFixture(), fromApp).tree, fromMcp).tree
        #expect(TreeOps.byId(after, "g2")?.text == "Bank statements")
        #expect(TreeOps.byId(after, "new")?.text == "Wash up")
    }

    @Test("lands the same way whichever order the two ops arrive in")
    func orderIndependent() {
        let a = Op.setText(id: "g2", text: "Bank statements")
        let b = Op.setText(id: "f1", text: "Take the bins out")
        let ab = TreeOps.applyOp(TreeOps.applyOp(opsFixture(), a).tree, b).tree
        let ba = TreeOps.applyOp(TreeOps.applyOp(opsFixture(), b).tree, a).tree
        #expect(ab == ba)
    }

    @Test("a delete on one branch leaves a concurrent move on another intact")
    func deleteAndMove() {
        let next = TreeOps.applyOp(
            TreeOps.applyOp(opsFixture(), .removeNode(id: "gather")).tree,
            .moveNode(id: "f2", parentId: "flat", index: 0)).tree
        #expect(TreeOps.byId(next, "gather") == nil)
        #expect(ids(next, "flat") == ["f2", "f1"])
    }
}

/// The wire format, which is where a Swift enum is most likely to diverge:
/// Swift's synthesised encoding nests the payload under the case name, and the
/// server's parseOp reads a flat tagged object. Every one of these would be a
/// 400 in production rather than a visible bug here.
@Suite("ops on the wire")
struct OpWireTests {
    /// One sample per kind, matching the parseOp suite in the TypeScript.
    /// Guards against adding a case to Op and forgetting the coding, which
    /// would 400 a real edit.
    static let samples: [Op] = [
        .addChild(id: "a", parentId: nil, text: "x", at: 1),
        .addSubtree(ids: ["a"], parentId: nil, nodes: [TreeOps.SubtreeSpec(text: "x")], at: 1),
        .setText(id: "a", text: "x"),
        .setDone(id: "a", done: true),
        .removeNode(id: "a"),
        .moveNode(id: "a", parentId: nil, index: 0),
        .indent(id: "a"),
        .outdent(id: "a"),
        .adoptFollowing(id: "a"),
        .insertAtDepth(id: "a", anchorId: "b", depth: 0, side: .after, scope: nil),
        .toggleCollapsed(id: "a"),
        .setPinned(id: "a", pinned: true),
        .markOpened(id: "a", at: 1),
    ]

    @Test("every op kind round-trips", arguments: samples)
    func roundTrips(op: Op) throws {
        let back = try JSONDecoder().decode(Op.self, from: JSONEncoder().encode(op))
        #expect(back == op)
    }

    @Test("encodes flat and tagged, the shape the server parses", arguments: samples)
    func flatAndTagged(op: Op) throws {
        let json = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(op)) as? [String: Any])
        #expect(json["op"] as? String == op.kind)
        // The payload sits beside the tag rather than nested under it.
        #expect(json[op.kind] == nil)
        #expect(json.count > 1)
    }

    @Test("the union covers every kind the server accepts")
    func coversEveryKind() {
        // The list in ops.ts, verbatim. A new op on either side breaks this.
        let opKinds = [
            "addChild", "addSubtree", "setText", "setDone", "removeNode", "moveNode",
            "indent", "outdent", "adoptFollowing", "insertAtDepth", "toggleCollapsed",
            "setPinned", "markOpened",
        ]
        #expect(Set(Self.samples.map(\.kind)) == Set(opKinds))
        #expect(Self.samples.count == opKinds.count)
    }

    @Test("keeps a null parentId distinct from a missing one")
    func nullParentId() throws {
        // null means "the root list" — it has to survive as a real value.
        let json = #"{"op":"moveNode","id":"a","parentId":null,"index":0}"#
        let parsed = try JSONDecoder().decode(Op.self, from: Data(json.utf8))
        #expect(parsed == .moveNode(id: "a", parentId: nil, index: 0))

        // A missing key is an error, not a silent nil — otherwise a truncated op
        // would quietly re-root a node.
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(
                Op.self, from: Data(#"{"op":"moveNode","id":"a","index":0}"#.utf8))
        }
    }

    @Test("a root-list op encodes parentId as an explicit null")
    func encodesNull() throws {
        let data = try JSONEncoder().encode(Op.addChild(id: "a", parentId: nil, text: "x", at: 1))
        #expect(String(decoding: data, as: UTF8.self).contains("\"parentId\":null"))
    }

    @Test("rejects an unknown op name")
    func unknownKind() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(
                Op.self, from: Data(#"{"op":"drop-database","id":"a"}"#.utf8))
        }
    }

    @Test("rejects a wrongly-typed field rather than coercing it")
    func wrongType() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(
                Op.self, from: Data(#"{"op":"setDone","id":"a","done":"yes"}"#.utf8))
        }
    }

    @Test("rejects a malformed nested outline")
    func malformedOutline() {
        let json = #"{"op":"addSubtree","ids":["a"],"parentId":null,"nodes":[{"nope":1}],"at":1}"#
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(Op.self, from: Data(json.utf8))
        }
    }

    @Test("a spec with no children omits the key, as parseSpecs expects")
    func omitsEmptyChildren() throws {
        let data = try JSONEncoder().encode(TreeOps.SubtreeSpec(text: "x"))
        #expect(!String(decoding: data, as: UTF8.self).contains("children"))
    }
}

/// Ported from `shared/ops.test.ts`, case for case.
///
/// A Tree is every project the owner has, so an op has to reconcile the
/// projects it touched and leave the others alone — including one that is
/// already wrong. Sweeping everything would quietly "fix" the untouched project
/// and hide that the scope was never applied.
@Suite("reconcile is scoped to the projects the op touched")
struct ReconcileScopeTests {
    func twoProjects() -> Tree {
        let spec: [(NodeId, NodeId?, Bool)] = [
            ("a", nil, false),
            ("a1", "a", true),
            ("a2", "a", false),
            // Deliberately stale: every child is done but the parent says otherwise.
            ("b", nil, false),
            ("b1", "b", true),
        ]
        return spec.enumerated().map { i, row in
            Node(
                id: row.0, parentId: row.1, text: row.0, done: row.2,
                order: i, collapsed: false, createdAt: 0
            )
        }
    }

    @Test("reconciles the touched project")
    func touched() {
        let out = TreeOps.applyOp(twoProjects(), .removeNode(id: "a2")).tree
        #expect(TreeOps.byId(out, "a")?.done == true)
    }

    @Test("leaves an untouched project exactly as it found it")
    func untouched() {
        let out = TreeOps.applyOp(twoProjects(), .removeNode(id: "a2")).tree
        #expect(TreeOps.byId(out, "b")?.done == false)
    }

    @Test("a cross-project move reconciles both ends")
    func crossProject() {
        let out = TreeOps.applyOp(
            twoProjects(), .moveNode(id: "a2", parentId: "b", index: 1)
        ).tree
        // 'a' lost its only unfinished child; 'b' gained one.
        #expect(TreeOps.byId(out, "a")?.done == true)
        #expect(TreeOps.byId(out, "b")?.done == false)
    }
}

