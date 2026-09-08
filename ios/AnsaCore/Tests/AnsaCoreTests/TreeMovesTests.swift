/// Ported from the movement half of `shared/tree.test.ts`, case for case.
///
/// These matter more than the lookup tests: every function here rewrites
/// `parentId` and `order`, so a disagreement with the server isn't a wrong-
/// looking screen, it's an op the server applies somewhere else.
///
/// The `invalidTree` shape cases from the TypeScript (a string `order`, a NaN
/// `createdAt`) are not ported as calls to `invalidTree` — in Swift the decoder
/// rejects them before a Tree exists, so they are tested as decode failures,
/// which is where the equivalent guard actually lives. The referential rules
/// (duplicates, dangling parents, cycles) port directly.

import Foundation
import Testing
@testable import AnsaCore

/// The visible row order, the way the app flattens the tree to render it.
func visibleOrder(_ tree: Tree, _ parentId: NodeId? = nil) -> [NodeId] {
    var out: [NodeId] = []
    for child in TreeOps.childrenOf(tree, parentId) {
        out.append(child.id)
        if !child.collapsed { out += visibleOrder(tree, child.id) }
    }
    return out
}

@Suite("addSubtree")
struct AddSubtreeTests {
    let spec = [
        TreeOps.SubtreeSpec(
            text: "Gather",
            children: [
                TreeOps.SubtreeSpec(text: "Find the P45"),
                TreeOps.SubtreeSpec(text: "Download CSV"),
            ]),
        TreeOps.SubtreeSpec(text: "Submit"),
    ]

    @Test("grafts a nested subtree under a parent in one call")
    func grafts() {
        let r = TreeOps.addSubtree(fixture(), "taxes", spec)
        // Two new top-level children plus two grandchildren = 4 ids.
        #expect(r.ids.count == 4)
        let (gather, find, download, submit) = (r.ids[0], r.ids[1], r.ids[2], r.ids[3])
        #expect(TreeOps.byId(r.tree, gather)?.text == "Gather")
        #expect(TreeOps.byId(r.tree, submit)?.text == "Submit")
        #expect(TreeOps.childrenOf(r.tree, gather).map(\.id) == [find, download])
        // Grafted after the existing children of taxes.
        #expect(
            TreeOps.childrenOf(r.tree, "taxes").map(\.text)
                == ["Gather documents", "Fill the forms", "Gather", "Submit"])
    }

    @Test("creates a brand-new project when parentId is nil")
    func newProject() {
        let before = TreeOps.roots(fixture()).count
        let r = TreeOps.addSubtree(
            fixture(), nil,
            [TreeOps.SubtreeSpec(
                text: "Plan the trip", children: [TreeOps.SubtreeSpec(text: "Book flights")])])
        #expect(TreeOps.roots(r.tree).count == before + 1)
        // The first id is the new root — the project id a caller would open.
        #expect(TreeOps.byId(r.tree, r.ids[0])?.parentId == nil)
        #expect(TreeOps.byId(r.tree, r.ids[1])?.parentId == r.ids[0])
    }

    @Test("gives every grafted node a distinct id")
    func distinctIds() {
        let ids = TreeOps.addSubtree(fixture(), "taxes", spec).ids
        #expect(Set(ids).count == ids.count)
    }

    @Test("siblings within the graft keep a dense 0..n order")
    func denseOrder() {
        let r = TreeOps.addSubtree(fixture(), nil, spec)
        #expect(TreeOps.childrenOf(r.tree, r.ids[0]).map(\.order) == [0, 1])
    }

    @Test("leaves the original tree untouched")
    func noMutation() {
        let t = fixture()
        _ = TreeOps.addSubtree(t, "taxes", spec)
        #expect(t == fixture())
    }

    @Test("a deep spec round-trips through subtreeOf")
    func deepSpec() {
        let r = TreeOps.addSubtree(
            fixture(), nil,
            [TreeOps.SubtreeSpec(
                text: "A",
                children: [TreeOps.SubtreeSpec(
                    text: "B", children: [TreeOps.SubtreeSpec(text: "C")])])])
        #expect(TreeOps.subtreeOf(r.tree, r.ids[0]).map(\.text) == ["B", "C"])
    }
}

@Suite("indent / outdent")
struct IndentTests {
    @Test("indent tucks a node under its preceding sibling, last")
    func indents() {
        let t = TreeOps.indent(fixture(), "g2")
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "g3"])
        #expect(TreeOps.childrenOf(t, "g1").map(\.id) == ["g2"])
    }

    @Test("indent is a no-op for a first child")
    func indentNoop() {
        let t = fixture()
        #expect(TreeOps.indent(t, "g1") == t)
        #expect(TreeOps.indent(t, "p1") == t)
    }

    @Test("outdent pops a node up beside its old parent, right after it")
    func outdents() {
        let t = TreeOps.outdent(fixture(), "p1a")
        #expect(TreeOps.byId(t, "p1a")?.parentId == "forms")
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["p1", "p1a", "p2"])
        #expect(TreeOps.childrenOf(t, "p1").map(\.id) == ["p1b"])
    }

    @Test("outdent is a no-op at the root")
    func outdentNoop() {
        let t = fixture()
        #expect(TreeOps.outdent(t, "taxes") == t)
    }

    @Test("indent then outdent round-trips the parent")
    func roundTrip() {
        var t = fixture()
        t = TreeOps.indent(t, "g2")
        t = TreeOps.outdent(t, "g2")
        #expect(TreeOps.byId(t, "g2")?.parentId == "gather")
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "g2", "g3"])
    }
}

@Suite("adoptFollowing")
struct AdoptFollowingTests {
    @Test("nests every following sibling under the node, in order")
    func nests() {
        let t = TreeOps.adoptFollowing(fixture(), "g1")
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1"])
        #expect(TreeOps.childrenOf(t, "g1").map(\.id) == ["g2", "g3"])
    }

    @Test("appends after any existing children")
    func appends() {
        let t = TreeOps.adoptFollowing(fixture(), "p1")
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["p1"])
        #expect(TreeOps.childrenOf(t, "p1").map(\.id) == ["p1a", "p1b", "p2"])
    }

    @Test("moves whole subtrees, keeping their descendants")
    func keepsDescendants() {
        let t = TreeOps.adoptFollowing(fixture(), "p1")
        #expect(TreeOps.childrenOf(t, "p2").map(\.id) == ["p2a", "p2b"])
    }

    @Test("is a no-op for the last sibling")
    func lastSibling() {
        let t = fixture()
        #expect(TreeOps.adoptFollowing(t, "g3") == t)
    }

    @Test("is a no-op for an unknown id")
    func unknownId() {
        let t = fixture()
        #expect(TreeOps.adoptFollowing(t, "nope") == t)
    }
}

@Suite("moveNode")
struct MoveNodeTests {
    @Test("reorders within a parent, and orders stay dense 0..n-1")
    func reorders() {
        let t = TreeOps.moveNode(fixture(), "g1", "gather", 3)
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g2", "g3", "g1"])
        #expect(TreeOps.childrenOf(t, "gather").map(\.order) == [0, 1, 2])
    }

    @Test("moves across parents, closing the source gap and renumbering both")
    func acrossParents() {
        let t = TreeOps.moveNode(fixture(), "f1", "gather", 0)
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["f1", "g1", "g2", "g3"])
        #expect(TreeOps.childrenOf(t, "gather").map(\.order) == [0, 1, 2, 3])
        #expect(TreeOps.childrenOf(t, "flat").map(\.id) == ["f2"])
        #expect(TreeOps.childrenOf(t, "flat").map(\.order) == [0])
    }

    @Test("nests a node under a leaf, making it a parent")
    func nestsUnderLeaf() {
        let t = TreeOps.moveNode(fixture(), "g2", "p1a", 0)
        #expect(TreeOps.byId(t, "g2")?.parentId == "p1a")
        #expect(TreeOps.childrenOf(t, "p1a").map(\.id) == ["g2"])
        #expect(!TreeOps.isLeaf(t, "p1a"))
    }

    @Test("can promote a node to a new root")
    func promotes() {
        let t = TreeOps.moveNode(fixture(), "p2b", nil, 1)
        #expect(TreeOps.byId(t, "p2b")?.parentId == nil)
        #expect(TreeOps.roots(t).map(\.id) == ["taxes", "p2b", "flat"])
    }

    @Test("refuses to drop a node into its own descendant (would cycle)")
    func refusesCycle() {
        let t = fixture()
        #expect(TreeOps.moveNode(t, "forms", "p2b1", 0) == t)
        #expect(TreeOps.moveNode(t, "forms", "forms", 0) == t)
    }

    @Test("clamps an out-of-range index")
    func clamps() {
        let t = TreeOps.moveNode(fixture(), "f1", "gather", 99)
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "g2", "g3", "f1"])
    }

    @Test("same-parent move to the same slot is a no-op in effect")
    func sameSlot() {
        let t = TreeOps.moveNode(fixture(), "g2", "gather", 1)
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "g2", "g3"])
    }
}

// The drop indicator's X → indent level. Guides sit at GUIDE_X0 + d*INDENT;
// the same numbers the UI uses, so the maths is exercised end to end.
private let guideX0 = 32.0
private let indentPx = 24.0
private func guideX(_ d: Double) -> Double { guideX0 + d * indentPx }

@Suite("depthAtGap")
struct DepthAtGapTests {
    func at(_ x: Double, _ above: Int?, _ below: Int?) -> Int {
        TreeOps.depthAtGap(
            clientX: x, aboveDepth: above, belowDepth: below,
            guideX0: guideX0, indent: indentPx)
    }

    @Test("rounds the pointer X to the nearest indent stop")
    func rounds() {
        #expect(at(guideX(0), 2, 0) == 0)
        #expect(at(guideX(1), 2, 0) == 1)
        #expect(at(guideX(2), 2, 0) == 2)
    }

    @Test("lets you nest one level under the row above, no deeper")
    func nestOne() {
        #expect(at(guideX(9), 1, 0) == 2)
    }

    @Test("will not go shallower than the top level")
    func floorAtZero() {
        #expect(at(guideX0 - 200, 2, 1) == 0)
    }

    @Test("lets a row outdent in place, past the row below it")
    func outdentInPlace() {
        // Clamping to the row below made depth 0 unreachable in every gap inside
        // a parent, so promoting a child meant dragging it past that parent's
        // whole subtree.
        #expect(at(guideX(0), 1, 1) == 0)
        // The row above still bounds how deep you can go.
        #expect(at(guideX(9), 1, 1) == 2)
    }

    @Test("at the top of the list (no row above) cannot nest")
    func topOfList() {
        #expect(at(guideX(5), nil, 0) == 0)
    }

    @Test("at the end of the list (no row below) can drop to depth 0")
    func endOfList() {
        #expect(at(guideX0 - 200, 2, nil) == 0)
        #expect(at(guideX(3), 2, nil) == 3)
    }
}

@Suite("insertAtDepth")
struct InsertAtDepthTests {
    // Scope is `taxes`; anchor `p2b1` gives the deepest chain:
    // [forms(0), p2(1), p2b(2), p2b1(3)].
    @Test("deepest depth nests under the anchor itself")
    func deepest() {
        let t = TreeOps.insertAtDepth(fixture(), "f1", "p2b1", 4, .after, "taxes")
        #expect(TreeOps.childrenOf(t, "p2b1").map(\.id) == ["f1"])
    }

    @Test("one level up sits beside the anchor among its siblings")
    func besideAnchor() {
        let t = TreeOps.insertAtDepth(fixture(), "f1", "p2b1", 3, .after, "taxes")
        #expect(TreeOps.childrenOf(t, "p2b").map(\.id) == ["p2b1", "f1", "p2b2"])
    }

    @Test("an intermediate depth lands after the branch on the path")
    func intermediate() {
        let t = TreeOps.insertAtDepth(fixture(), "f1", "p2b1", 1, .after, "taxes")
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["p1", "p2", "f1"])
    }

    @Test("depth 0 lands among the scope's own children")
    func depthZero() {
        let t = TreeOps.insertAtDepth(fixture(), "f1", "p2b1", 0, .after, "taxes")
        #expect(TreeOps.childrenOf(t, "taxes").map(\.id) == ["gather", "forms", "f1"])
    }

    @Test("'before' inserts on the near side of the row on the path")
    func before() {
        let t = TreeOps.insertAtDepth(fixture(), "f1", "g2", 1, .before, "taxes")
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "f1", "g2", "g3"])
    }

    @Test("nesting under an anchor that already has children lands first, not last")
    func landsFirst() {
        // The gap sits directly under `gather`, so the drop is visually just
        // above g1. Appending after g3 would put the row where the pointer
        // never was.
        let t = TreeOps.insertAtDepth(fixture(), "f1", "gather", 1, .after, "taxes")
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["f1", "g1", "g2", "g3"])
    }

    @Test("nesting under a collapsed anchor still lands first")
    func collapsedAnchor() {
        let t = TreeOps.insertAtDepth(fixture(), "f2", "p2b", 3, .after, "taxes")
        #expect(TreeOps.childrenOf(t, "p2b").map(\.id) == ["f2", "p2b1", "p2b2"])
    }

    @Test("handles a nil scope (root-level list)")
    func nilScope() {
        let t = TreeOps.insertAtDepth(fixture(), "f1", "g2", 0, .after, nil)
        #expect(TreeOps.roots(t).map(\.id) == ["taxes", "f1", "flat"])
    }
}

/// The lit guide has to name the same parent the drop lands under, so these
/// are checked against `insertAtDepth` rather than against a hand-written
/// expectation — a rule stated twice can drift.
@Suite("parentAtDepth")
struct ParentAtDepthTests {
    /// Where `insertAtDepth` actually put the row, read back off the tree.
    func landedUnder(_ depth: Int, _ anchor: NodeId, _ scope: NodeId?) -> NodeId? {
        let t = TreeOps.insertAtDepth(fixture(), "f1", anchor, depth, .after, scope)
        return t.first { $0.id == "f1" }?.parentId
    }

    @Test("agrees with insertAtDepth at every depth on the deepest chain")
    func agreesAllDepths() {
        for depth in 0...4 {
            #expect(
                TreeOps.parentAtDepth(fixture(), "p2b1", depth, "taxes")
                    == landedUnder(depth, "p2b1", "taxes"),
                "disagrees at depth \(depth)")
        }
    }

    @Test("depth 0 is the scope itself, nil at the root list")
    func depthZero() {
        #expect(TreeOps.parentAtDepth(fixture(), "p2b1", 0, "taxes") == "taxes")
        #expect(TreeOps.parentAtDepth(fixture(), "g2", 0, nil) == nil)
    }

    @Test("past the end of the chain nests under the anchor")
    func deeperThanChain() {
        #expect(TreeOps.parentAtDepth(fixture(), "p2b1", 9, "taxes") == "p2b1")
    }

    /// Two rows at the same depth under different parents. Lighting by depth
    /// alone matched both, which is the bug this exists to prevent.
    @Test("two anchors at one depth give different parents")
    func siblingsDoNotShareAGuide() {
        let t = fixture()
        #expect(TreeOps.parentAtDepth(t, "g2", 1, "taxes") == "gather")
        #expect(TreeOps.parentAtDepth(t, "p1", 1, "taxes") == "forms")
    }
}

@Suite("moveRow")
struct MoveRowTests {
    @Test("moves a row down past a plain sibling")
    func down() {
        let t = TreeOps.moveRow(fixture(), "g1", .down, visibleOrder(fixture()))
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g2", "g1", "g3"])
    }

    @Test("moves a row up past a plain sibling")
    func up() {
        let t = TreeOps.moveRow(fixture(), "g3", .up, visibleOrder(fixture()))
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "g3", "g2"])
    }

    @Test("crosses out of its parent when it runs off the top")
    func offTop() {
        let t = TreeOps.moveRow(fixture(), "g1", .up, visibleOrder(fixture()))
        #expect(TreeOps.childrenOf(t, "taxes").map(\.id) == ["g1", "gather", "forms"])
    }

    @Test("crosses out of its parent when it runs off the bottom")
    func offBottom() {
        // forms is an open parent, so g3 steps inside it.
        let t = TreeOps.moveRow(fixture(), "g3", .down, visibleOrder(fixture()))
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["g3", "p1", "p2"])
    }

    @Test("steps over a folded parent rather than into it")
    func foldedParent() {
        let base = fixture().map { node -> Node in
            guard node.id == "forms" else { return node }
            var n = node
            n.collapsed = true
            return n
        }
        let t = TreeOps.moveRow(base, "g3", .down, visibleOrder(base))
        #expect(TreeOps.childrenOf(t, "taxes").map(\.id) == ["gather", "forms", "g3"])
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["p1", "p2"])
    }

    @Test("carries its own subtree, stepping over it rather than into it")
    func carriesSubtree() {
        let t = TreeOps.moveRow(fixture(), "gather", .down, visibleOrder(fixture()))
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["gather", "p1", "p2"])
        #expect(TreeOps.childrenOf(t, "gather").map(\.id) == ["g1", "g2", "g3"])
    }

    @Test("does nothing at the very top or the very bottom")
    func ends() {
        let base = fixture()
        #expect(TreeOps.moveRow(base, "taxes", .up, visibleOrder(base)) == base)
        #expect(TreeOps.moveRow(base, "f2", .down, visibleOrder(base)) == base)
    }
}

@Suite("invalidTree — the referential rules")
struct InvalidTreeTests {
    func node(_ id: NodeId, _ parentId: NodeId?) -> Node {
        Node(id: id, parentId: parentId, text: id, order: 0, createdAt: 0)
    }

    @Test("accepts a well-formed tree")
    func accepts() {
        #expect(TreeOps.invalidTree([node("a", nil), node("b", "a")]) == nil)
    }

    @Test("accepts an empty tree")
    func acceptsEmpty() {
        // A database with no projects is a legitimate state, not a broken one.
        #expect(TreeOps.invalidTree([]) == nil)
    }

    @Test("rejects duplicate ids")
    func duplicates() {
        // byId would find one node while removeNode drops both.
        #expect(TreeOps.invalidTree([node("a", nil), node("a", nil)]) == "duplicate node id: a")
    }

    @Test("rejects a parentId that points at nothing")
    func dangling() {
        let bad = TreeOps.invalidTree([node("a", nil), node("b", "ghost")])
        #expect(bad?.contains("parentId that doesn't exist") == true)
    }

    @Test("rejects a node that is its own parent")
    func selfParent() {
        #expect(TreeOps.invalidTree([node("a", "a")]) == "node a is its own ancestor")
    }

    @Test("rejects a longer parent cycle")
    func longCycle() {
        let bad = TreeOps.invalidTree([node("a", "c"), node("b", "a"), node("c", "b")])
        #expect(bad?.contains("own ancestor") == true)
    }

    @Test("accepts a deep chain without mistaking it for a cycle")
    func deepChain() {
        // Depth alone must not trip the cycle check — the memoisation is what
        // keeps this linear, and a bug there shows up as a false rejection.
        let chain = (0..<500).map { i in node("n\(i)", i == 0 ? nil : "n\(i - 1)") }
        #expect(TreeOps.invalidTree(chain) == nil)
    }

    @Test("the decoder rejects the shape errors invalidTree checks in TypeScript")
    func decoderGuardsShape() throws {
        // In TypeScript invalidTree does this work because JSON.parse produces
        // anything. Here the decoder is the guard, so that is what gets tested.
        let cases = [
            #"[{"id":"a","parentId":null,"text":"a","done":false,"order":"3","collapsed":false,"createdAt":0}]"#,
            #"[{"id":"a","parentId":null,"text":"a","done":false,"order":0,"collapsed":false,"createdAt":"0"}]"#,
            #"[{"id":"a","parentId":null,"text":"a","done":false,"order":0,"collapsed":false,"createdAt":0,"pinned":"yes"}]"#,
            #"[{"id":"b"}]"#,
        ]
        for json in cases {
            #expect(throws: (any Error).self) {
                try JSONDecoder().decode(Tree.self, from: Data(json.utf8))
            }
        }
    }

    @Test("tolerates unknown extra keys")
    func extraKeys() throws {
        // A field from a newer client shouldn't make the tree unreadable.
        let json = #"[{"id":"a","parentId":null,"text":"a","done":false,"order":0,"collapsed":false,"createdAt":0,"somethingNew":1}]"#
        let tree = try JSONDecoder().decode(Tree.self, from: Data(json.utf8))
        #expect(TreeOps.invalidTree(tree) == nil)
    }

    @Test("accepts the optional root-only fields when present")
    func optionalFields() {
        var n = node("a", nil)
        n.pinned = true
        n.lastOpenedAt = 123
        #expect(TreeOps.invalidTree([n]) == nil)
    }
}

@Suite("projects")
struct ProjectTests {
    func pinning(_ ids: [NodeId]) -> Tree {
        fixture().map { node in
            guard ids.contains(node.id) else { return node }
            var n = node
            n.pinned = true
            return n
        }
    }

    @Test("splits roots into pinned and unpinned, both in manual order")
    func splits() {
        let s = TreeOps.projectSections(pinning(["flat"]))
        #expect(s.pinned.map(\.id) == ["flat"])
        #expect(s.unpinned.map(\.id) == ["taxes"])
    }

    @Test("the flat list puts pinned first")
    func flatList() {
        #expect(TreeOps.projectList(pinning(["flat"])).map(\.id) == ["flat", "taxes"])
        // Unpinned keeps the tree's own order.
        #expect(TreeOps.projectList(fixture()).map(\.id) == ["taxes", "flat"])
    }

    /// Pin these ids and arrange them densely, in the order given.
    func shelf(_ ids: [NodeId]) -> Tree {
        pinning(ids).map { node in
            guard let i = ids.firstIndex(of: node.id) else { return node }
            var n = node
            n.pinOrder = i
            return n
        }
    }

    @Test("the shelf holds projects and tasks in one list")
    func shelfIsOneList() {
        // Arranged by hand, so it cannot also be grouped by kind — the two
        // rules would disagree the moment a task was dragged above a project.
        #expect(
            TreeOps.pinnedItems(shelf(["gather", "taxes"])).map(\.node.id)
                == ["gather", "taxes"])
    }

    @Test("a pinned project has an empty trail")
    func projectTrail() {
        // Which is also what says it is a project — a root has nothing above it.
        #expect(TreeOps.pinnedItems(pinning(["taxes"]))[0].trail.isEmpty)
    }

    @Test("an unarranged pin sorts after every arranged one")
    func absentSortsLast() {
        // Absent means never dragged, so a new pin lands at the end rather than
        // displacing an order someone set by hand.
        let tree = TreeOps.setPinOrder(pinning(["taxes", "gather"]), "gather", 0)
        #expect(TreeOps.pinnedItems(tree).map(\.node.id) == ["gather", "taxes"])
    }

    @Test("an untouched shelf falls back to depth then order")
    func shelfFallback() {
        // The old rule, kept so shipping pinOrder needs no backfill.
        #expect(
            TreeOps.pinnedItems(pinning(["p2b1", "gather"])).map(\.node.id)
                == ["gather", "p2b1"])
    }

    @Test("a deleted node takes its shelf entry with it")
    func shelfDropsDeleted() {
        // Membership is still the flag, so no stale pinOrder can resurrect it.
        #expect(TreeOps.pinnedItems(TreeOps.removeNode(shelf(["p2b1"]), "p2b")).isEmpty)
    }

    @Test("reordering renumbers only what moved")
    func reorderMinimal() {
        // Every pin below the swap keeps its position, so an op for it would be
        // a write that changes nothing.
        let ops = TreeOps.reorderPinsOps(shelf(["taxes", "gather", "p2b1"]), from: 0, to: 1)
        #expect(ops.count == 2)
        #expect(ops.map(\.kind) == ["setPinOrder", "setPinOrder"])
    }

    @Test("reordering an unarranged shelf writes every position")
    func reorderArranges() {
        // Nothing has a pinOrder yet, so the first drag is what takes the list
        // off the depth fallback.
        let ops = TreeOps.reorderPinsOps(pinning(["taxes", "gather"]), from: 1, to: 0)
        #expect(ops.count == 2)
    }

    @Test("a pin dropped where it started writes nothing")
    func reorderNoop() {
        #expect(TreeOps.reorderPinsOps(shelf(["taxes", "gather"]), from: 0, to: 0).isEmpty)
        #expect(TreeOps.reorderPinsOps(shelf(["taxes"]), from: 5, to: 0).isEmpty)
    }

    @Test("a drag down the shelf lands where it was dropped")
    func reorderDownward() {
        // SwiftUI's `onMove` reports the destination before the row is lifted
        // out, so a downward drag arrives one past where it lands. The view
        // subtracts that; this pins the convention `reorderPinsOps` expects —
        // an index into the list *without* the moved row.
        let tree = shelf(["taxes", "gather", "p2b1"])
        let moved = TreeOps.reorderPinsOps(tree, from: 0, to: 2)
            .reduce(tree) { TreeOps.applyOp($0, $1).tree }
        #expect(TreeOps.pinnedItems(moved).map(\.node.id) == ["gather", "p2b1", "taxes"])
    }

    @Test("the ops and the shelf's own sort agree")
    func reorderRoundTrip() {
        // One is derived from the other, so a disagreement would mean a drag
        // that lands somewhere other than where it was dropped.
        let tree = shelf(["taxes", "gather", "p2b1"])
        let moved = TreeOps.reorderPinsOps(tree, from: 2, to: 0)
            .reduce(tree) { TreeOps.applyOp($0, $1).tree }
        #expect(TreeOps.pinnedItems(moved).map(\.node.id) == ["p2b1", "taxes", "gather"])
    }

    @Test("depthOf counts edges from the root")
    func depth() {
        let t = fixture()
        #expect(TreeOps.depthOf(t, "taxes") == 0)
        #expect(TreeOps.depthOf(t, "gather") == 1)
        // taxes → forms → p2 → p2b → p2b1
        #expect(TreeOps.depthOf(t, "p2b1") == 4)
    }
}

/// The predicates a UI uses to decide whether to offer a gesture.
///
/// Tested against the moves themselves rather than against hand-listed cases:
/// the whole risk here is drift, where `canIndent` and `indent` disagree and the
/// row either refuses a legal move or animates one that never happens. Applying
/// the move and comparing is the ground truth, so these assert exactly that, for
/// every node in the fixture.
@Suite("canIndent / canOutdent agree with the moves")
struct NestPredicateTests {
    @Test("canIndent is true exactly when indent changes the tree")
    func indentAgrees() {
        let t = fixture()
        for node in t {
            let moved = TreeOps.indent(t, node.id) != t
            #expect(
                TreeOps.canIndent(t, node.id) == moved,
                "canIndent disagrees with indent on \(node.id)")
        }
    }

    @Test("canOutdent is true exactly when outdent changes the tree")
    func outdentAgrees() {
        let t = fixture()
        for node in t {
            let moved = TreeOps.outdent(t, node.id) != t
            #expect(
                TreeOps.canOutdent(t, node.id) == moved,
                "canOutdent disagrees with outdent on \(node.id)")
        }
    }

    @Test("an unknown id can do neither")
    func unknownId() {
        let t = fixture()
        #expect(!TreeOps.canIndent(t, "ghost"))
        #expect(!TreeOps.canOutdent(t, "ghost"))
    }

    @Test("a first child cannot indent but can outdent")
    func firstChild() {
        let t = fixture()
        let first = TreeOps.childrenOf(t, "gather")[0]
        #expect(!TreeOps.canIndent(t, first.id))
        #expect(TreeOps.canOutdent(t, first.id))
    }

    @Test("a first root can do neither")
    func firstRoot() {
        let t = fixture()
        let first = TreeOps.childrenOf(t, nil)[0]
        #expect(!TreeOps.canIndent(t, first.id))
        #expect(!TreeOps.canOutdent(t, first.id))
    }
}

/// The ops a client sends for indent/outdent.
///
/// The wire has `moveNode`, not `indent`, so the destination is resolved before
/// sending. These assert the op lands the tree in exactly the state the direct
/// move would — if they ever diverge, the screen and the server disagree about
/// what a swipe did, which is the worst failure this codebase has.
@Suite("indentOp / outdentOp match the direct moves")
struct NestOpTests {
    @Test("indentOp applied equals indent, for every node")
    func indentMatches() {
        let t = fixture()
        for node in t {
            // reconcileDone, because applying an op now includes it: the
            // property under test is that the two land on the same tree, not
            // that applyOp is the bare move.
            let direct = TreeOps.reconcileDone(TreeOps.indent(t, node.id))
            let viaOp = TreeOps.indentOp(t, node.id).map { TreeOps.applyOp(t, $0).tree } ?? t
            #expect(viaOp == direct, "indentOp disagrees with indent on \(node.id)")
        }
    }

    @Test("outdentOp applied equals outdent, for every node")
    func outdentMatches() {
        let t = fixture()
        for node in t {
            let direct = TreeOps.reconcileDone(TreeOps.outdent(t, node.id))
            let viaOp = TreeOps.outdentOp(t, node.id).map { TreeOps.applyOp(t, $0).tree } ?? t
            #expect(viaOp == direct, "outdentOp disagrees with outdent on \(node.id)")
        }
    }

    /// The op is nil in exactly the cases the predicate refuses, so a UI that
    /// offers the gesture on canIndent never produces a nil op.
    @Test("an op exists exactly when the predicate allows it")
    func opsMatchPredicates() {
        let t = fixture()
        for node in t {
            #expect((TreeOps.indentOp(t, node.id) != nil) == TreeOps.canIndent(t, node.id))
            #expect((TreeOps.outdentOp(t, node.id) != nil) == TreeOps.canOutdent(t, node.id))
        }
    }
}
