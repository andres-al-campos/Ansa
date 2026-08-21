/// Ported from `shared/tree.test.ts`, case for case.
///
/// These are the specification rather than a safety net. The Swift and the
/// TypeScript are two implementations of one model, and the failure mode of
/// drift is not a wrong-looking screen but a corrupted tree — a client that
/// indents differently from the server writes ops the server applies elsewhere.
/// Keeping the same fixture and the same expectations is what makes "they
/// agree" checkable rather than assumed.
///
/// When the TypeScript gains a case, port it here.

import Testing
@testable import AnsaCore

/// The fixture from the TypeScript suite, node for node.
///
///  taxes
///    gather
///      g1 (done)  g2  g3
///    forms
///      p1 -> p1a p1b
///      p2 -> p2a, p2b -> p2b1 p2b2
///  flat
///    f1 f2
func fixture() -> Tree {
    let spec: [(NodeId, NodeId?, String, Bool)] = [
        ("taxes", nil, "File the tax return", false),
        ("gather", "taxes", "Gather documents", false),
        ("g1", "gather", "Find last year's return", true),
        ("g2", "gather", "Download bank CSV", false),
        ("g3", "gather", "Dig out the P60", false),
        ("forms", "taxes", "Fill the forms", false),
        ("p1", "forms", "Page 1", false),
        ("p1a", "p1", "Name and address", false),
        ("p1b", "p1", "NI number", false),
        ("p2", "forms", "Page 2", false),
        ("p2a", "p2", "Salary", false),
        ("p2b", "p2", "Freelance income", false),
        ("p2b1", "p2b", "Total the invoices", false),
        ("p2b2", "p2b", "Convert the USD ones", false),
        ("flat", nil, "Sort out the flat", false),
        ("f1", "flat", "Email the landlord", false),
        ("f2", "flat", "Book a carpet clean", false),
    ]
    return spec.enumerated().map { index, item in
        Node(
            id: item.0, parentId: item.1, text: item.2, done: item.3,
            order: index, collapsed: false, createdAt: 0
        )
    }
}

@Suite("structure")
struct StructureTests {
    @Test("finds roots and direct children")
    func rootsAndChildren() {
        let t = fixture()
        #expect(TreeOps.childrenOf(t, nil).map(\.id) == ["taxes", "flat"])
        #expect(TreeOps.childrenOf(t, "forms").map(\.id) == ["p1", "p2"])
    }

    @Test("knows a leaf from a parent")
    func leaves() {
        let t = fixture()
        #expect(TreeOps.isLeaf(t, "p1a"))
        #expect(!TreeOps.isLeaf(t, "p2b"))
    }

    @Test("walks lineage root-first")
    func lineage() {
        #expect(
            TreeOps.lineageOf(fixture(), "p2b1").map(\.id)
                == ["taxes", "forms", "p2", "p2b", "p2b1"]
        )
    }
}

@Suite("leavesUnder — the leaf filter")
struct LeavesUnderTests {
    @Test("flattens the whole subtree, not just direct children")
    func flattens() {
        // p2b1/p2b2 sit 3 levels under `forms` and must still show.
        #expect(
            TreeOps.leavesUnder(fixture(), "forms").map(\.id)
                == ["p1a", "p1b", "p2a", "p2b1", "p2b2"]
        )
    }

    @Test("excludes intermediate parents")
    func excludesParents() {
        #expect(!TreeOps.leavesUnder(fixture(), "forms").map(\.id).contains("p2b"))
    }

    @Test("scopes to the given node only")
    func scoped() {
        #expect(TreeOps.leavesUnder(fixture(), "flat").map(\.id) == ["f1", "f2"])
    }
}

@Suite("leaving an edited row")
struct CommitEditTests {
    @Test("an unchanged row writes nothing")
    func unchanged() {
        let t = fixture()
        guard let node = t.first else { return #expect(Bool(false)) }
        #expect(TreeOps.commitEdit(t, node.id, node.text) == nil)
        // Trimming happens before the comparison, so whitespace alone is not a
        // change either.
        #expect(TreeOps.commitEdit(t, node.id, "  \(node.text)  ") == nil)
    }

    @Test("new text renames")
    func renames() {
        let t = fixture()
        guard let node = t.first else { return #expect(Bool(false)) }
        #expect(TreeOps.commitEdit(t, node.id, " Renamed ") == .setText(id: node.id, text: "Renamed"))
    }

    @Test("emptying a row deletes it, even when it was already empty")
    func emptyDeletes() {
        // The stranded-row case: a row created and left without typing has
        // empty stored text and empty live text, and must still be removed.
        var t = fixture()
        t = TreeOps.addChild(t, nil, "").tree
        guard let blank = t.last else { return #expect(Bool(false)) }
        #expect(TreeOps.commitEdit(t, blank.id, "") == .removeNode(id: blank.id))
    }

    @Test("a row that is already gone writes nothing")
    func missing() {
        #expect(TreeOps.commitEdit(fixture(), "no-such-id", "") == nil)
    }
}

@Suite("the project list")
struct ProjectListTests {
    @Test("pinned projects come first, without disturbing manual order")
    func pinnedFirst() {
        var t = fixture()
        let rs = TreeOps.roots(t)
        guard let last = rs.last else { return #expect(Bool(false)) }
        t = TreeOps.setPinned(t, last.id, true)
        let list = TreeOps.projectList(t)
        #expect(list.first?.id == last.id)
        // The unpinned tail keeps the order it had — pinning moves one project,
        // it does not re-sort the rest.
        #expect(list.dropFirst().map(\.id) == rs.dropLast().map(\.id))
    }

    @Test("with nothing pinned it is just the roots in order")
    func unpinned() {
        #expect(TreeOps.projectList(fixture()).map(\.id) == TreeOps.roots(fixture()).map(\.id))
    }
}

@Suite("progress is leaf-weighted")
struct ProgressTests {
    @Test("a grandchild completing moves the grandparent")
    func grandchild() {
        // The bug this guards: counting direct children would leave `taxes` at
        // 0%, because `gather` is not itself done.
        let t = fixture()
        let before = TreeOps.progressOf(t, "taxes")
        let after = TreeOps.progressOf(TreeOps.setDone(t, "g2", true).tree, "taxes")
        #expect(after.done > before.done)
        #expect(after.pct > before.pct)
    }

    @Test("counts every leaf in the subtree")
    func countsLeaves() {
        // gather 3 + forms 5 = 8 leaves under taxes, one already done.
        let p = TreeOps.progressOf(fixture(), "taxes")
        #expect(p.total == 8)
        #expect(p.done == 1)
        #expect(p.pct == 13)
    }

    @Test("reaches exactly 100 when the subtree is finished")
    func hundred() {
        var t = fixture()
        for id in ["p1a", "p1b", "p2a", "p2b1", "p2b2"] {
            t = TreeOps.setDone(t, id, true).tree
        }
        #expect(TreeOps.progressOf(t, "forms") == TreeOps.Progress(done: 5, total: 5, pct: 100))
    }

    @Test("decomposing a leaf moves the denominator, it does not reset the level")
    func decomposing() {
        // Splitting work shouldn't tank the number: 1/3 -> 1/5 is a dip, not a
        // collapse to zero.
        let t = fixture()
        let before = TreeOps.progressOf(TreeOps.setDone(t, "g2", true).tree, "gather")
        var after = TreeOps.setDone(t, "g2", true).tree
        after = TreeOps.addChild(after, "g3", "sub a").tree
        after = TreeOps.addChild(after, "g3", "sub b").tree
        let p = TreeOps.progressOf(after, "gather")
        #expect(before.pct == 67)  // g1 + g2 of 3
        #expect(p.pct == 50)  // g1 + g2 of 4 (g3 became a parent of 2)
    }

    @Test("a scope counts every leaf under it")
    func scoped() {
        #expect(TreeOps.scopeProgress(fixture(), "taxes") == TreeOps.progressOf(fixture(), "taxes"))
    }

    @Test("no scope counts the whole tree")
    func wholeTree() {
        let p = TreeOps.scopeProgress(fixture(), nil)
        // Every leaf under every root, not the roots themselves — a tree of one
        // root would otherwise read as a single unit at 0% or 100%.
        #expect(p?.total == TreeOps.leavesUnder(fixture(), nil).count)
    }

    @Test("an empty tree has nothing to report, rather than 0%")
    func empty() {
        // Nil and 0% are different claims. A bar at zero says the work is
        // untouched; there is no work here at all.
        #expect(TreeOps.scopeProgress([], nil) == nil)
    }
}

@Suite("setDone cascades")
struct SetDoneTests {
    @Test("completes the parent when the last child lands, and reports it")
    func completesParent() {
        let t = fixture()
        let first = TreeOps.setDone(t, "p1a", true)
        #expect(first.completed.isEmpty)
        let second = TreeOps.setDone(first.tree, "p1b", true)
        #expect(second.completed.contains("p1"))
    }

    @Test("climbs several levels at once")
    func climbs() {
        var t = fixture()
        t = TreeOps.setDone(t, "p1a", true).tree
        t = TreeOps.setDone(t, "p1b", true).tree
        t = TreeOps.setDone(t, "p2a", true).tree
        t = TreeOps.setDone(t, "p2b1", true).tree
        let last = TreeOps.setDone(t, "p2b2", true)
        // p2b, then p2, then forms all complete off one tick.
        #expect(last.completed == ["p2b", "p2", "forms"])
    }

    @Test("ticking a parent completes its whole subtree")
    func cascadesDown() {
        let tree = TreeOps.setDone(fixture(), "forms", true).tree
        for id in ["p1", "p1a", "p1b", "p2", "p2a", "p2b", "p2b1", "p2b2"] {
            #expect(TreeOps.byId(tree, id)?.done == true, "\(id) should be done")
        }
    }

    @Test("unticking a descendant re-opens every ancestor")
    func reopensAncestors() {
        var t = TreeOps.setDone(fixture(), "taxes", true).tree
        #expect(TreeOps.byId(t, "taxes")?.done == true)
        t = TreeOps.setDone(t, "p2b2", false).tree
        for id in ["p2b", "p2", "forms", "taxes"] {
            #expect(TreeOps.byId(t, id)?.done == false, "\(id) should be re-opened")
        }
    }

    @Test("does not mutate the tree it was given")
    func noMutation() {
        let t = fixture()
        _ = TreeOps.setDone(t, "p1a", true)
        #expect(TreeOps.byId(t, "p1a")?.done == false)
    }
}

@Suite("editing")
struct EditingTests {
    @Test("removing a node takes its subtree with it")
    func removeSubtree() {
        let t = TreeOps.removeNode(fixture(), "p2")
        for id in ["p2", "p2a", "p2b", "p2b1", "p2b2"] {
            #expect(TreeOps.byId(t, id) == nil, "\(id) should be gone")
        }
        #expect(TreeOps.byId(t, "p1") != nil)
    }

    @Test("a new child lands last among its siblings")
    func addChildOrder() {
        let result = TreeOps.addChild(fixture(), "gather", "Find the P45")
        #expect(
            TreeOps.childrenOf(result.tree, "gather").map(\.id)
                == ["g1", "g2", "g3", result.id]
        )
    }

    @Test("spots ancestors so a move cannot make a cycle")
    func ancestors() {
        let t = fixture()
        #expect(TreeOps.isAncestor(t, "forms", "p2b1"))
        #expect(!TreeOps.isAncestor(t, "p2b1", "forms"))
    }
}

/// No TypeScript counterpart: the web reads its scope from the URL, so a
/// vanished node lands on a 404-ish empty route the user can navigate out of.
/// The phone holds it in view state, where the same event leaves a blank list
/// under a stale title and no way to tell what happened.
@Suite("survivingScope — where the zoom goes when its node is deleted")
struct SurvivingScopeTests {

    /// The fixture minus `id` and everything under it, the way a `removeNode`
    /// broadcast from another device arrives.
    func without(_ id: NodeId) -> Tree {
        TreeOps.removeNode(fixture(), id)
    }

    @Test("a scope that still resolves is left alone")
    func unchangedWhenPresent() {
        // The common case by a wide margin: every ordinary edit reaches here,
        // so it has to be a no-op rather than a re-derivation.
        #expect(
            TreeOps.survivingScope("p2b", was: fixture(), now: fixture()) == "p2b")
    }

    @Test("the project list stays the project list")
    func nilStaysNil() {
        #expect(TreeOps.survivingScope(nil, was: fixture(), now: fixture()) == nil)
    }

    @Test("a deleted scope falls back to its nearest surviving ancestor")
    func fallsBackToParent() {
        // Standing on `p2b1` when it goes should land on `p2b`, one level out,
        // not at the root — the user keeps their place as nearly as the tree
        // allows.
        #expect(
            TreeOps.survivingScope("p2b1", was: fixture(), now: without("p2b1"))
                == "p2b")
    }

    @Test("a deleted subtree skips past the ancestors that went with it")
    func skipsDeletedAncestors() {
        // Removing `p2` takes `p2b` and `p2b1` too. The nearest ancestor that
        // actually survived is `forms`, and walking the *old* lineage is the
        // only way to find it — none of the intermediate ids exist any more.
        #expect(
            TreeOps.survivingScope("p2b1", was: fixture(), now: without("p2"))
                == "forms")
    }

    @Test("a deleted project lands on the project list")
    func rootDeletionLandsHome() {
        // Nothing above a root survived because there was nothing above it.
        #expect(TreeOps.survivingScope("taxes", was: fixture(), now: without("taxes")) == nil)
        #expect(TreeOps.survivingScope("p2b1", was: fixture(), now: without("taxes")) == nil)
    }

    @Test("a scope missing from both trees lands on the project list")
    func unknownScopeLandsHome() {
        // No lineage to walk. Reachable if the scope was already stale when
        // the tree arrived, and the answer that cannot strand anyone is home.
        #expect(TreeOps.survivingScope("ghost", was: fixture(), now: fixture()) == nil)
    }
}

@Suite("resumeScope — where to land on open")
struct ResumeScopeTests {
    func withOpened(_ stamps: [NodeId: Double]) -> Tree {
        fixture().map { node in
            guard let stamp = stamps[node.id] else { return node }
            var n = node
            n.lastOpenedAt = stamp
            return n
        }
    }

    @Test("returns the most recently opened project")
    func mostRecent() {
        #expect(TreeOps.resumeScope(withOpened(["taxes": 100, "flat": 200])) == "flat")
        #expect(TreeOps.resumeScope(withOpened(["taxes": 300, "flat": 200])) == "taxes")
    }

    @Test("lands on the home list when nothing has been opened")
    func nothingOpened() {
        #expect(TreeOps.resumeScope(fixture()) == nil)
    }

    @Test("lands on the home list for an empty tree")
    func emptyTree() {
        #expect(TreeOps.resumeScope([]) == nil)
    }

    @Test("ignores a stamp on a non-root, so a stale deep scope cannot strand you")
    func ignoresNonRoot() {
        #expect(TreeOps.resumeScope(withOpened(["gather": 900])) == nil)
    }

    @Test("ignores projects that have never been opened")
    func ignoresUnopened() {
        #expect(TreeOps.resumeScope(withOpened(["taxes": 1])) == "taxes")
    }

    @Test("is unaffected by pinning, which orders the list rather than the landing")
    func pinningIrrelevant() {
        let t = withOpened(["taxes": 100, "flat": 200]).map { node -> Node in
            guard node.id == "taxes" else { return node }
            var n = node
            n.pinned = true
            return n
        }
        #expect(TreeOps.resumeScope(t) == "flat")
    }
}
