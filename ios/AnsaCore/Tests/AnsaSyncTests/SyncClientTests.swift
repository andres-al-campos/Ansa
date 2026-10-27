import AnsaCore
import Foundation
import Testing

@testable import AnsaSync

/// The sync state machine, driven against a fake server.
///
/// No TypeScript counterpart: `src/useOutlinerSync.ts` solves the same problems
/// but is a hook, tested through the component. This is the same logic with the
/// phone's extra hazard — the OS kills a backgrounded app routinely, so "the
/// process died with unsent edits" is the common path rather than the unlucky
/// one.
///
/// Every case here is a timing rule, which is exactly what a live server cannot
/// check: the interesting states are the rare ones (offline at the wrong
/// instant, a tree arriving mid-keystroke, three drops in a row), and provoking
/// them by hand is not repeatable.

/// A fresh path per test, so nothing inherits another test's queue file.
private func tempURL() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "ansa-sync-tests")
        .appending(path: UUID().uuidString)
        .appending(path: "queue.json")
}

/// A server that never was.
///
/// Records what it was sent, in order, and answers however the test says. The
/// ordering assertions read `sent` directly, so it has to preserve arrival
/// order rather than just counting.
private actor FakeBackend: SyncBackend {
    nonisolated let origin: String

    private(set) var sent: [Op] = []
    private var tree: Tree?
    private var results: [WriteResult] = []
    private var defaultResult: WriteResult = .ok

    init(origin: String = "this-device", tree: Tree? = []) {
        self.origin = origin
        self.tree = tree
    }

    /// Queue up per-call answers. Once they run out, `defaultResult` applies —
    /// so a test can say "the first write fails, the rest are fine" without
    /// scripting every call.
    func willAnswer(_ results: [WriteResult], thereafter: WriteResult = .ok) {
        self.results = results
        self.defaultResult = thereafter
    }

    func serves(_ tree: Tree?) { self.tree = tree }

    /// How many times a tree was asked for, so a test can assert that some
    /// event did *not* cause a refetch.
    private(set) var loadTreeCalls = 0

    func loadTree() async -> Tree? {
        loadTreeCalls += 1
        return tree
    }

    /// While set, a send has reached the server but its answer has not come
    /// back: the op is stored there and still queued here.
    private var holding = false
    func holdAnswers(_ value: Bool) { holding = value }

    func send(_ op: Op) async -> WriteResult {
        sent.append(op)
        while holding { try? await Task.sleep(for: .milliseconds(1)) }
        return results.isEmpty ? defaultResult : results.removeFirst()
    }

    func eventsURL() async -> URL? { nil }

    /// Streams to hand out, one per connect attempt, oldest first. Once they
    /// run out `connect()` answers nil — a backend that cannot be reached,
    /// which is what a test that only cares about the first few attempts wants
    /// for every attempt after them.
    private var streams: [FakeStream] = []
    private(set) var connects = 0

    func willConnect(_ streams: [FakeStream]) { self.streams = streams }

    func connect() async -> (any EventStream)? {
        connects += 1
        return streams.isEmpty ? nil : streams.removeFirst()
    }
}

/// One scripted connection.
///
/// The three states this suite cares about are all expressible here: a refused
/// handshake (`opens: false`), one that opens and stays quiet (opens with no
/// frames), and one that opens and later drops (`drop()`).
private actor FakeStream: EventStream {
    private let opens: Bool
    private var frames: [Frame]
    private var dropped = false
    private var pings: Bool
    private(set) var closed = false
    private(set) var pinged = 0

    init(opens: Bool = true, frames: [Frame] = [], pings: Bool = true) {
        self.opens = opens
        self.frames = frames
        self.pings = pings
    }

    func open() async -> Bool { opens }

    func next() async -> Frame? {
        if !frames.isEmpty { return frames.removeFirst() }
        // Out of scripted frames: either the connection is finished, or it is
        // an open socket with nothing to say. The latter must not return — a
        // quiet socket suspends here rather than reporting a drop, and a test
        // that let it return nil would be testing the old behaviour.
        while !dropped { try? await Task.sleep(for: .milliseconds(1)) }
        return nil
    }

    func ping() async -> Bool {
        pinged += 1
        return pings
    }

    func close() async {
        closed = true
        dropped = true
    }

    /// End the connection, as a server going away would.
    func drop() { dropped = true }
}

extension Frame {
    /// An op frame. With no hash the frame is unstamped, which the client
    /// treats as nothing to check — the tests that want a check pass one.
    fileprivate static func op(_ op: Op, origin: String?, hash: String = "") -> Frame {
        Frame(op: op, origin: origin, hash: hash)
    }
}

private func node(_ id: NodeId, _ text: String) -> Node {
    Node(id: id, parentId: nil, text: text, done: false, order: 0,
         collapsed: false, createdAt: 0)
}

@MainActor
@Suite("The sync client")
struct SyncClientTests {

    /// A client plus the trees it adopted, which is the only thing the app sees
    /// it do. `start()` is deliberately not called: it opens a real socket and
    /// a real timer, and every rule here is reachable without either.
    ///
    /// The client also keeps a stand-in for the store's tree: adopts replace
    /// it, applied ops are applied to it, and the fingerprint check reads it.
    /// Local edits are not applied to it — a test that needs the local tree
    /// ahead of the server's edits `state` itself.
    private func makeClient(
        _ api: FakeBackend, pingEvery: Duration = .milliseconds(5),
        state: Box<Tree> = Box([])
    ) -> (SyncClient, () -> [Tree]) {
        let adopted = Box<[Tree]>([])
        // Pings fast by default: the tests that care about the keepalive would
        // otherwise wait the app's 25 seconds, and the ones that do not are
        // unaffected, since a healthy fake answers every ping.
        let client = SyncClient(
            api: api, queueURL: tempURL(), pingEvery: pingEvery,
            current: { state.value },
            onApply: { state.value = TreeOps.applyOp(state.value, $0).tree }
        ) {
            state.value = $0
            adopted.value.append($0)
        }
        return (client, { adopted.value })
    }

    // ----------------------------------------------------- the stale cache

    @Test("an op made before the first adopt is held, not sent")
    func heldUntilSynced() async {
        // The widest-blast-radius rule in the class. First paint comes from
        // disk, which may be older than the server; sending against a baseline
        // the client is only guessing at applies the edit to the wrong tree.
        let api = FakeBackend()
        let (client, _) = makeClient(api)

        client.send(.setText(id: "a", text: "early"))
        // A real pause, not a poll-until-idle: this asserts an absence, and
        // waiting for the backend to go quiet returns instantly when it was
        // never busy — which would pass whether or not the rule holds.
        try? await Task.sleep(for: .milliseconds(50))

        #expect(await api.sent.isEmpty)
    }

    @Test("the held op goes out once the server's tree lands")
    func drainsAfterAdopt() async {
        let api = FakeBackend()
        let (client, _) = makeClient(api)

        client.send(.setText(id: "a", text: "early"))
        client.adoptInitial([node("a", "server")])
        await settle(api, expecting: 1)

        #expect(await api.sent == [.setText(id: "a", text: "early")])
    }

    // ---------------------------------------------------------- ordering

    @Test("ops leave in the order they were made")
    func strictOrdering() async {
        // A rename followed by an add is one gesture's worth of work. Arriving
        // out of order lands the second against a tree missing the first, which
        // corrupts rather than merely losing.
        let api = FakeBackend()
        let (client, _) = makeClient(api)
        client.adoptInitial([])

        client.send(
            .setText(id: "a", text: "one"),
            .setText(id: "b", text: "two"),
            .setText(id: "c", text: "three"))
        await settle(api, expecting: 3)

        #expect(
            await api.sent == [
                .setText(id: "a", text: "one"),
                .setText(id: "b", text: "two"),
                .setText(id: "c", text: "three"),
            ])
    }

    @Test("an unreachable server stops the queue rather than skipping past it")
    func unreachableHoldsTheHead() async {
        // Nothing is known about an unreachable op, so it stays at the head and
        // everything waits behind it. Dropping it would lose an edit that is
        // still on screen, and sending the next one first would reorder them.
        let api = FakeBackend()
        await api.willAnswer([.unreachable])
        let (client, _) = makeClient(api)
        client.adoptInitial([])

        client.send(.setText(id: "a", text: "one"), .setText(id: "b", text: "two"))
        await settle(api, expecting: 1)

        #expect(await api.sent == [.setText(id: "a", text: "one")])
    }

    @Test("a rejected op is discarded so the queue behind it still moves")
    func rejectedIsDropped() async {
        // The opposite call to `unreachable`, and conflating the two is what
        // wedges a queue forever: the server has judged this op and will judge
        // it the same way every time.
        let api = FakeBackend()
        await api.willAnswer([.rejected(reason: "unknown node")])
        let (client, _) = makeClient(api)
        client.adoptInitial([])

        client.send(.setText(id: "a", text: "one"), .setText(id: "b", text: "two"))
        await settle(api, expecting: 2)

        #expect(
            await api.sent == [
                .setText(id: "a", text: "one"),
                .setText(id: "b", text: "two"),
            ])
        #expect(client.rejected == 1)
    }

    // A dependent pair, which is what `commitSentinel` on the phone actually
    // emits: a new task nested under an existing one is `addChild` followed by
    // `moveNode` naming the node that `addChild` was supposed to create. The
    // rejection rule above was written for independent ops, where carrying on is
    // plainly right. Here the second op cannot succeed if the first did not, and
    // this pins what the queue does about that — which is nothing. It sends the
    // orphan and lets the server refuse it too.
    //
    // Recorded rather than fixed because the alternative is worse: dropping the
    // follower means the queue has to know which ops depend on which, and it
    // deliberately does not. The server stays consistent either way — it has
    // neither op. What diverges is the phone, which goes on showing a task the
    // server never accepted until the next adopt corrects it. If nesting a new
    // task is ever reported as not syncing, start here.
    @Test("a rejected create still sends the move that depended on it")
    func dependentPairAfterRejection() async {
        let api = FakeBackend()
        await api.willAnswer([.rejected(reason: "unknown node")])
        let (client, _) = makeClient(api)
        client.adoptInitial([])

        client.send(
            .addChild(id: "new", parentId: "parent", text: "nested", at: 1),
            .moveNode(id: "new", parentId: "parent", index: 0))
        await settle(api, expecting: 2)

        #expect(
            await api.sent == [
                .addChild(id: "new", parentId: "parent", text: "nested", at: 1),
                .moveNode(id: "new", parentId: "parent", index: 0),
            ])
        // One, not two: the fake only refuses the first. A real server would
        // refuse the orphan as well, which is the divergence described above.
        #expect(client.rejected == 1)
    }

    @Test("a rejection refetches the server's tree")
    func rejectionRefetches() async {
        // The refused edit is still on screen and never will be on the server.
        // Nothing else corrects that: a refusal produces no frame, and the
        // server no longer pushes whole trees on other people's writes.
        let api = FakeBackend(tree: [node("a", "server")])
        await api.willAnswer([.rejected(reason: "unknown node")])
        let (client, adopted) = makeClient(api)
        client.adoptInitial([])
        let adoptsBefore = await api.loadTreeCalls

        client.send(.setText(id: "a", text: "one"))
        await settle(api, expecting: 1)

        #expect(client.rejected == 1)
        #expect(await api.loadTreeCalls == adoptsBefore + 1)
        #expect(adopted().last == [node("a", "server")])
    }

    // --------------------------------------------------------- the busy gate

    @Test("a tree arriving mid-edit is stashed, not adopted")
    func busyStashes() async {
        // This is what stops text vanishing under the user mid-keystroke. It
        // also looks exactly like broken sync from outside, which is why it is
        // worth pinning: an open rename field holding this gate sent me
        // chasing a sync bug that did not exist.
        let api = FakeBackend()
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "first")])
        client.setBusy(true)

        client.deliverForTesting(tree: [node("a", "from elsewhere")], origin: "other")
        await settle(api, expecting: 0)

        #expect(adopted().count == 1)
    }

    @Test("the stashed tree lands the moment the edit ends")
    func stashAdoptsOnIdle() async {
        let api = FakeBackend()
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "first")])
        client.setBusy(true)
        client.deliverForTesting(tree: [node("a", "from elsewhere")], origin: "other")

        client.setBusy(false)
        await settle(api, expecting: 0)

        #expect(adopted().count == 2)
        #expect(adopted().last == [node("a", "from elsewhere")])
    }

    @Test("only the newest stashed tree survives")
    func stashKeepsLatest() async {
        // The stash is one slot, not a queue: each broadcast carries the whole
        // tree, so an older one is not a missed change, it is a stale copy.
        let api = FakeBackend()
        let (client, adopted) = makeClient(api)
        client.adoptInitial([])
        client.setBusy(true)

        client.deliverForTesting(tree: [node("a", "older")], origin: "other")
        client.deliverForTesting(tree: [node("a", "newer")], origin: "other")
        client.setBusy(false)
        await settle(api, expecting: 0)

        #expect(adopted().last == [node("a", "newer")])
    }

    @Test("the very first tree is adopted even mid-edit")
    func firstAdoptIgnoresBusy() async {
        // The deliberate exception to the gate. This tree is the baseline every
        // queued op replays onto, so holding it back would mean either sending
        // against a guess or stalling every write until the user stops typing.
        let api = FakeBackend()
        let (client, adopted) = makeClient(api)
        client.setBusy(true)

        client.deliverForTesting(tree: [node("a", "baseline")], origin: "other")
        await settle(api, expecting: 0)

        #expect(adopted() == [[node("a", "baseline")]])
    }

    @Test("an unchanged tree from elsewhere is still adopted")
    func identicalTreeStillAdopts() async {
        // The trash depends on this. Permanently deleting a trash entry does not
        // change the tree — the node left `nodes` when it was first deleted — so
        // the server broadcasts an identical tree purely to wake the other
        // devices. If this were skipped as a no-op, a device sitting on the trash
        // screen would keep offering Restore and Delete on an entry that is gone.
        //
        // Which is also why the screen watches an adopt counter rather than the
        // tree: `Tree` is `Equatable`, so the change it would be waiting for
        // never comes.
        let api = FakeBackend()
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "same")])

        client.deliverForTesting(tree: [node("a", "same")], origin: "other")
        await settle(api, expecting: 0)

        #expect(adopted().count == 2)
    }

    @Test("a refusal a person can act on is kept; an internal one is not")
    func rejectionReason() async {
        // The node cap is the case this exists for. "unknown node" describes a
        // race nobody can do anything about, so showing it would be noise.
        let api = FakeBackend()
        await api.willAnswer([
            .rejected(reason: "That would put this outline over 5000 tasks, which is the limit. "
                + "Delete something, or split a branch into its own project."),
            .rejected(reason: "No node with id x in this tree."),
        ])
        let (client, _) = makeClient(api)
        client.adoptInitial([])

        client.send(.setText(id: "a", text: "one"))
        await settle(api, expecting: 1)
        #expect(client.rejectedReason?.contains("split a branch") == true)

        client.send(.setText(id: "b", text: "two"))
        await settle(api, expecting: 2)
        #expect(client.rejectedReason == nil)

        // Dismissable, since the edit is gone either way.
        client.send(.setText(id: "c", text: "three"))
        await settle(api, expecting: 3)
        client.clearRejected()
        #expect(client.rejected == 0)
        #expect(client.rejectedReason == nil)
    }

    // ---------------------------------------------------------- op frames

    @Test("an op from elsewhere is applied, not adopted")
    func opIsApplied() async {
        let api = FakeBackend()
        let state = Box<Tree>([])
        let (client, adopted) = makeClient(api, state: state)
        client.adoptInitial([node("a", "before")])

        client.deliverForTesting(.op(.setText(id: "a", text: "after"), origin: "other"))
        await settle(api, expecting: 0)

        #expect(state.value.map(\.text) == ["after"])
        // One adopt: the initial one. The op did not go through `onAdopt`.
        #expect(adopted().count == 1)
    }

    @Test("ops arriving mid-edit wait, then land in order")
    func opsWaitForIdle() async {
        let api = FakeBackend()
        let state = Box<Tree>([])
        let (client, _) = makeClient(api, state: state)
        client.adoptInitial([node("a", "start")])
        client.setBusy(true)

        client.deliverForTesting(.op(.setText(id: "a", text: "one"), origin: "other"))
        client.deliverForTesting(.op(.setText(id: "a", text: "two"), origin: "other"))
        #expect(state.value.map(\.text) == ["start"])

        client.setBusy(false)
        await settle(api, expecting: 0)
        #expect(state.value.map(\.text) == ["two"])
    }

    @Test("an op before the first tree is ignored")
    func opBeforeSyncIsDropped() async {
        // There is no tree to apply it to, and the tree that is coming will
        // already include it.
        let api = FakeBackend()
        let state = Box<Tree>([node("a", "cached")])
        let (client, _) = makeClient(api, state: state)

        client.deliverForTesting(.op(.setText(id: "a", text: "applied"), origin: "other"))
        await settle(api, expecting: 0)

        #expect(state.value.map(\.text) == ["cached"])
    }

    // ------------------------------------------------- unsent edits on screen

    /// A store as the app's is: an edit applies to the tree and is queued.
    private func edit(_ op: Op, _ client: SyncClient, _ state: Box<Tree>) {
        state.value = TreeOps.applyOp(state.value, op).tree
        client.send(op)
    }

    @Test("an edit made before the first tree is still on screen after it lands")
    func earlyEditStaysOnScreen() async {
        // First paint is from cache, so a tick can land before the server's
        // tree does. The tree replaced the screen bare, the tick was sent, and
        // the box sat unticked over a server that had it done.
        let server: Tree = [node("a", "task")]
        let api = FakeBackend(tree: server)
        let state = Box<Tree>(server)
        let (client, _) = makeClient(api, state: state)

        edit(.setDone(id: "a", done: true), client, state)
        edit(.addChild(id: "b", parentId: nil, text: "added early", at: 1), client, state)
        client.adoptInitial(server)

        #expect(state.value.first { $0.id == "a" }?.done == true)
        #expect(state.value.map(\.id) == ["a", "b"])
    }

    @Test("an add the server already has is not put back a second time")
    func addAlreadyStoredIsNotDoubled() async {
        // The op reached the server and only its answer was lost, so it is
        // still queued. `addChild` appends unconditionally: replayed, it would
        // leave two rows sharing one id.
        let api = FakeBackend()
        let state = Box<Tree>([])
        let (client, _) = makeClient(api, state: state)

        edit(.addChild(id: "b", parentId: nil, text: "stored", at: 1), client, state)
        client.adoptInitial([node("b", "stored")])

        #expect(state.value.map(\.id) == ["b"])
    }

    @Test("an unsent edit to a row deleted elsewhere changes nothing")
    func editToADeletedRowIsDropped() async {
        let api = FakeBackend()
        let state = Box<Tree>([node("a", "one"), node("gone", "two")])
        let (client, _) = makeClient(api, state: state)

        edit(.setText(id: "gone", text: "renamed"), client, state)
        edit(.indent(id: "gone"), client, state)
        client.adoptInitial([node("a", "one")])

        #expect(state.value == [node("a", "one")])
    }

    @Test("edits left unsent by the last launch are on screen after the first tree")
    func restoredEditsStayOnScreen() async {
        let url = tempURL()
        let first = SyncClient(api: FakeBackend(), queueURL: url, current: { [] }, onApply: { _ in }) { _ in }
        first.send(.setText(id: "a", text: "unsent"))

        let state = Box<Tree>([node("a", "unsent")])
        let second = SyncClient(
            api: FakeBackend(), queueURL: url, current: { state.value }, onApply: { _ in }
        ) { state.value = $0 }
        second.adoptInitial([node("a", "old")])

        #expect(state.value == [node("a", "unsent")])
    }

    @Test("a later tree keeps what is still waiting to be sent")
    func laterTreeKeepsTheQueue() async {
        // Offline after syncing: the edit is queued, and a tree arriving from
        // a reconnect must not take it off the screen either.
        let api = FakeBackend()
        await api.willAnswer([], thereafter: .unreachable)
        let state = Box<Tree>([])
        let (client, _) = makeClient(api, state: state)
        client.adoptInitial([node("a", "start")])

        edit(.setText(id: "a", text: "offline"), client, state)
        await settle(api, expecting: 1)
        client.deliverForTesting(tree: [node("a", "start")], origin: "other")

        #expect(state.value == [node("a", "offline")])
    }

    @Test("a fold put back on a tree that already had it is set right by its echo")
    func doubledFoldIsCorrected() async {
        // What `withUnsent` cannot tell apart: the fold reached the server, and
        // a tree holding it lands before the answer does. Replayed, the fold
        // flips back on screen. The echo's fingerprint then disagrees with the
        // screen, and the refetch is what puts it right.
        var folded = node("a", "branch")
        folded.collapsed = true
        let api = FakeBackend(origin: "this-device", tree: [folded])
        let state = Box<Tree>([])
        let (client, _) = makeClient(api, state: state)
        client.adoptInitial([node("a", "branch")])

        await api.holdAnswers(true)
        edit(.toggleCollapsed(id: "a"), client, state)
        await settle(api, expecting: 1)
        client.deliverForTesting(tree: [folded], origin: "other", hash: TreeOps.fingerprint([folded]))
        #expect(state.value.first?.collapsed == false, "the doubled fold this test is about didn't happen")

        await api.holdAnswers(false)
        try? await Task.sleep(for: .milliseconds(20))
        client.deliverForTesting(
            .op(.toggleCollapsed(id: "a"), origin: "this-device", hash: TreeOps.fingerprint([folded])))
        for _ in 0..<500 where state.value.first?.collapsed != true {
            try? await Task.sleep(for: .milliseconds(1))
        }

        #expect(state.value.first?.collapsed == true)
        #expect(await api.loadTreeCalls == 1)
    }

    // -------------------------------------------------------- the fingerprint

    @Test("a fingerprint that disagrees refetches the tree")
    func mismatchRefetches() async {
        let api = FakeBackend(tree: [node("a", "truth")])
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "start")])

        // The server says the result is something this device did not reach.
        client.deliverForTesting(
            .op(.setText(id: "a", text: "one"), origin: "other",
                hash: TreeOps.fingerprint([node("a", "something else")])))
        // The refetch is a detached Task that hops to the backend and back, so
        // wait for it to land rather than for a fixed few milliseconds: settle()
        // expecting no sends returns at once, and under load the refetch had
        // not arrived yet (4 failures in 25 runs on a busy Mac).
        for _ in 0..<2000 where adopted().last != [node("a", "truth")] {
            try? await Task.sleep(for: .milliseconds(1))
        }
        await settle(api, expecting: 0)

        #expect(await api.loadTreeCalls == 1)
        #expect(adopted().last == [node("a", "truth")])
    }

    @Test("a fingerprint that agrees never refetches")
    func matchDoesNotRefetch() async {
        let api = FakeBackend()
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "start")])

        client.deliverForTesting(.op(.setText(id: "a", text: "one"), origin: "other"))
        client.deliverForTesting(.op(.setText(id: "a", text: "two"), origin: "other"))
        await settle(api, expecting: 0)

        #expect(await api.loadTreeCalls == 0)
        #expect(adopted().count == 1)
    }

    @Test("the check waits for this device's own echo")
    func checkWaitsForEcho() async {
        // The HTTP answer to our op can land before its echo does. The frame
        // between them carries a fingerprint from before our op, and our tree
        // already holds it — a check there would refetch a tree that is right.
        let api = FakeBackend(origin: "this-device")
        let state = Box<Tree>([])
        let (client, _) = makeClient(api, state: state)
        client.adoptInitial([node("a", "start")])

        // The local edit, as the store would have applied it.
        state.value = TreeOps.applyOp(state.value, .setText(id: "a", text: "mine")).tree
        client.send(.setText(id: "a", text: "mine"))
        await settle(api, expecting: 1)

        // Someone else's edit, stamped before ours reached the server.
        client.deliverForTesting(
            .op(.setDone(id: "a", done: true), origin: "other",
                hash: TreeOps.fingerprint([node("a", "start")].map { var n = $0; n.done = true; return n })))
        await settle(api, expecting: 1)
        #expect(await api.loadTreeCalls == 0)

        // Our echo, stamped with a tree that has both. Now it checks: it agrees.
        client.deliverForTesting(
            .op(.setText(id: "a", text: "mine"), origin: "this-device",
                hash: TreeOps.fingerprint(state.value)))
        await settle(api, expecting: 1)
        #expect(await api.loadTreeCalls == 0)
    }

    // ------------------------------------------------------------ own echo

    @Test("this device's own broadcast is not re-adopted")
    func ownEchoIsIgnored() async {
        // The local tree already has this change. Re-adopting it is how a local
        // edit gets clobbered by its own echo.
        let api = FakeBackend(origin: "this-device")
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "local")])

        // Stamped as a real echo is: with the server's tree after our write,
        // which is the one we hold. The frame's own tree is not consulted.
        client.deliverForTesting(
            tree: [node("a", "stale echo")], origin: "this-device",
            hash: TreeOps.fingerprint([node("a", "local")]))
        await settle(api, expecting: 0)

        #expect(adopted().count == 1)
        #expect(await api.loadTreeCalls == 0)
    }

    @Test("an echo still opens the write path when it arrives first")
    func echoOpensTheGate() async {
        // Two behaviours in one branch: the frame is not adopted, but it is
        // proof the server is listening, so held ops stop being held.
        let api = FakeBackend(origin: "this-device")
        let (client, adopted) = makeClient(api)

        client.send(.setText(id: "a", text: "held"))
        client.deliverForTesting(tree: [node("a", "echo")], origin: "this-device")
        await settle(api, expecting: 1)

        #expect(adopted().isEmpty)
        #expect(await api.sent == [.setText(id: "a", text: "held")])
    }

    // ------------------------------------------------------- death and replay

    @Test("an op outlives the process and replays after the next adopt")
    func survivesDeath() async {
        // The phone's normal case rather than its unlucky one. Two clients over
        // one queue file stand in for the app being killed and relaunched.
        let url = tempURL()
        let first = SyncClient(api: FakeBackend(), queueURL: url, current: { [] }, onApply: { _ in }) { _ in }
        first.send(.setText(id: "a", text: "unsent"))

        let api = FakeBackend()
        let second = SyncClient(api: api, queueURL: url, current: { [] }, onApply: { _ in }) { _ in }
        second.adoptInitial([])
        await settle(api, expecting: 1)

        #expect(await api.sent == [.setText(id: "a", text: "unsent")])
    }

    // ------------------------------------------------- the connection ladder

    @Test("a socket that opens and stays quiet is not a failure")
    func quietSocketIsHealthy() async {
        // The regression this whole seam exists for. Frames are only sent when
        // somebody edits, so silence is the normal state of a working
        // connection. Counting it as failure walked the backoff to its 30s
        // ceiling and left the phone deaf to everything the web app did, while
        // writes kept working and nothing on screen said otherwise.
        let api = FakeBackend()
        await api.willConnect([FakeStream()])
        let (client, _) = makeClient(api)

        client.start()
        defer { client.stop() }
        // Comfortably longer than the 500ms floor, so a ladder that was
        // climbing would have reconnected several times by now.
        try? await Task.sleep(for: .milliseconds(60))

        #expect(client.live)
        #expect(await api.connects == 1, "a healthy quiet socket was reconnected")
    }

    @Test("a refused handshake warns after three tries")
    func refusedHandshakeWarns() async {
        let api = FakeBackend()
        await api.willConnect([
            FakeStream(opens: false), FakeStream(opens: false), FakeStream(opens: false),
        ])
        let (client, _) = makeClient(api)

        client.start()
        defer { client.stop() }
        for _ in 0..<400 {
            if !client.live { break }
            try? await Task.sleep(for: .milliseconds(5))
        }

        #expect(!client.live, "three refusals should have raised the banner")
    }

    @Test("no credential to try with is not a refusal")
    func missingCredentialIsQuiet() async {
        // `connect()` returning nil means the attempt never happened — on a
        // signing build with no token yet, there is no URL worth opening. That
        // is the ordinary state just after launch and after every return from
        // background, and counting it raised the out-of-sync banner on a phone
        // whose connection was fine.
        let api = FakeBackend()
        await api.willConnect([])
        let (client, _) = makeClient(api)

        client.start()
        defer { client.stop() }
        // Long enough for many attempts at the 500ms floor the skip holds it
        // to, so a ladder that counted these would be well past three.
        try? await Task.sleep(for: .milliseconds(60))

        #expect(client.live, "a missing token should not raise the banner")
    }

    @Test("one refusal is not enough to warn")
    func oneRefusalIsQuiet() async {
        // A single drop is ordinary — the object hibernates, wifi blips. A
        // banner on the first would flicker through normal use and teach people
        // to ignore the one channel that matters.
        let api = FakeBackend()
        await api.willConnect([FakeStream(opens: false), FakeStream()])
        let (client, _) = makeClient(api)

        client.start()
        defer { client.stop() }
        try? await Task.sleep(for: .milliseconds(40))

        #expect(client.live)
    }

    @Test("a frame arriving over the socket is adopted")
    func socketFrameIsAdopted() async {
        let served: Tree = [node("a", "from the server")]
        let api = FakeBackend()
        await api.willConnect([FakeStream(frames: [Frame(tree: served, origin: "other")])])
        let (client, adopted) = makeClient(api)

        client.start()
        defer { client.stop() }
        for _ in 0..<200 {
            if !adopted().isEmpty { break }
            try? await Task.sleep(for: .milliseconds(5))
        }

        #expect(adopted().count == 1)
        #expect(adopted().first?.first?.text == "from the server")
    }

    @Test("a connection that opened and then dropped reconnects")
    func dropReconnects() async {
        let first = FakeStream()
        let api = FakeBackend()
        await api.willConnect([first, FakeStream()])
        let (client, _) = makeClient(api)

        client.start()
        defer { client.stop() }
        try? await Task.sleep(for: .milliseconds(20))
        await first.drop()

        for _ in 0..<200 {
            if await api.connects >= 2 { break }
            try? await Task.sleep(for: .milliseconds(5))
        }

        #expect(await api.connects >= 2, "a dropped socket was not replaced")
        // It opened, so the ladder stays at the floor and `live` never dipped.
        #expect(client.live)
    }

    @Test("a socket whose ping fails is dropped and replaced")
    func deadSocketIsNoticed() async {
        // The half-dead case: the OS never reports the drop, so `next()` waits
        // forever on a connection that will never deliver anything. Without the
        // ping nothing else in the client ever notices — the read is suspended,
        // so the reconnect ladder never gets its turn.
        let dead = FakeStream(pings: false)
        let api = FakeBackend()
        await api.willConnect([dead, FakeStream()])
        let (client, _) = makeClient(api)

        client.start()
        defer { client.stop() }

        for _ in 0..<600 {
            if await api.connects >= 2 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }

        #expect(await dead.closed, "the dead socket was left open")
        #expect(await api.connects >= 2, "nothing replaced the dead socket")
    }

    @Test("the stream is closed when the client stops")
    func stopClosesTheStream() async {
        let stream = FakeStream()
        let api = FakeBackend()
        await api.willConnect([stream])
        let (client, _) = makeClient(api)

        client.start()
        try? await Task.sleep(for: .milliseconds(20))
        client.stop()

        for _ in 0..<200 {
            if await stream.closed { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        #expect(await stream.closed, "the socket outlived the client")
    }
}

/// A reference cell, so an escaping closure can record into a local.
private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

/// Wait for the client's detached `Task { await drain() }` work to finish.
///
/// Yielding is not enough and never reliably was: `drain` hops to the backend
/// actor once per op, and a yield only offers the main actor up — it makes no
/// promise those hops have come back. A queue of three ops needs at least three
/// round trips, and the count is not something a test should have to know.
///
/// So this waits on the fake itself: it polls until the backend has been idle
/// for a few consecutive turns, meaning no further send has landed. The sleep
/// is short and the bound is generous, because the failure it guards against is
/// a flaky suite rather than a slow one.
private func settle(_ api: FakeBackend, expecting: Int) async {
    // Wait for a specific count rather than for quiet. Polling only for
    // stability cannot tell "finished" from "has not started yet", and the
    // drain is a detached Task that may not have run at all when the first
    // poll happens — so a test asserting one send passes against zero.
    for _ in 0..<500 {
        if await api.sent.count >= expecting { break }
        try? await Task.sleep(for: .milliseconds(1))
    }
    // Then let anything further land, so a test expecting N also catches an
    // N+1 the code should not have sent.
    for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(1)) }
}
