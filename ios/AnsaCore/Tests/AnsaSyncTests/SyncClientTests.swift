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

    func loadTree() async -> Tree? { tree }

    func send(_ op: Op) async -> WriteResult {
        sent.append(op)
        return results.isEmpty ? defaultResult : results.removeFirst()
    }

    func eventsURL() async -> URL? { nil }
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
    private func makeClient(
        _ api: FakeBackend
    ) -> (SyncClient, () -> [Tree]) {
        let adopted = Box<[Tree]>([])
        let client = SyncClient(api: api, queueURL: tempURL()) { adopted.value.append($0) }
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

    // ------------------------------------------------------------ own echo

    @Test("this device's own broadcast is not re-adopted")
    func ownEchoIsIgnored() async {
        // The local tree already has this change. Re-adopting it is how a local
        // edit gets clobbered by its own echo.
        let api = FakeBackend(origin: "this-device")
        let (client, adopted) = makeClient(api)
        client.adoptInitial([node("a", "local")])

        client.deliverForTesting(tree: [node("a", "stale echo")], origin: "this-device")
        await settle(api, expecting: 0)

        #expect(adopted().count == 1)
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
        let first = SyncClient(api: FakeBackend(), queueURL: url) { _ in }
        first.send(.setText(id: "a", text: "unsent"))

        let api = FakeBackend()
        let second = SyncClient(api: api, queueURL: url) { _ in }
        second.adoptInitial([])
        await settle(api, expecting: 1)

        #expect(await api.sent == [.setText(id: "a", text: "unsent")])
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
