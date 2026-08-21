import AnsaCore
import Foundation

/// Keeping this device and the server in step.
///
/// The app is local-first: an edit applies to the in-memory tree immediately,
/// so the UI never waits on a round-trip. This is what happens after that — it
/// ships the op to the server and adopts changes coming back the other way.
/// It mirrors `src/useOutlinerSync.ts`; the problems are the same ones, and
/// they are all about timing:
///
///  - **Ordering.** Ops go out one at a time, in the order they were made. Two
///    ops from one gesture (rename, then add a sibling) must arrive in that
///    order or the second lands against a tree missing the first.
///
///  - **The stale cache.** First paint comes from disk, which may be older than
///    the server. Until the authoritative tree has been adopted once, ops are
///    held rather than sent: replaying them onto the server's real tree
///    afterwards is right, sending them while still guessing at the baseline is
///    not.
///
///  - **Death.** The queue is persisted, so it outlives the process. On a phone
///    this is the common case rather than the unlucky one — the OS kills
///    backgrounded apps routinely. It needs no separate handling: a restored op
///    is held until the first adopt and replayed, which is already what an op
///    made while offline gets.
///
///  - **Interruption.** An incoming tree must not be swapped in mid-edit, so it
///    is stashed and adopted the moment the user is idle.
///
///  - **Deafness.** A dropped socket is never noticed on its own, because
///    writes go over HTTP and keep working. The app saves fine and silently
///    stops receiving, so two devices diverge and whoever wrote last appears to
///    win. This is why the socket reconnects rather than being opened once.
///
/// That last one is routine here rather than exceptional: a Durable Object
/// hibernates idle sockets to stay inside the free tier, and the token in the
/// handshake URL expires in about a minute. Recovering from a drop is the
/// client's job.
@MainActor
public final class SyncClient {
    /// Reconnect delay, doubling on repeated failure. The floor is short
    /// because the common case is a healthy app whose socket the platform
    /// dropped, and a second of deafness is already visible. The ceiling stops
    /// an app that has been offline for an hour from hammering the API.
    private static let reconnectMin: Duration = .milliseconds(500)
    private static let reconnectMax: Duration = .seconds(30)

    /// Consecutive failed reconnects before the app is called out of sync. Not
    /// one: a single drop is ordinary — the object hibernates, the phone
    /// sleeps, wifi blips — and the reconnect usually wins within a second.
    /// Warning on the first would flicker during normal use, which teaches
    /// people to ignore the one channel that matters when sync is truly broken.
    private static let failuresBeforeWarning = 3

    /// How often a queue stalled by an unreachable server retries on its own.
    /// Without this the only thing that retries is the next edit, so an app the
    /// user stops typing in keeps what it has not saved — indefinitely, and
    /// silently. That is the same shape of bug as the deaf socket.
    private static let writeRetry: Duration = .seconds(5)

    private let api: any SyncBackend
    private let queue: OpQueue

    /// Called with a server tree that should replace local state.
    private let onAdopt: (Tree) -> Void

    /// Whether the server's authoritative tree has been adopted at least once.
    /// Until it has, queued ops stay put — see the stale-cache note above.
    private var synced = false
    /// True while a send is in flight, so the queue drains strictly in order.
    private var sending = false
    /// A tree that arrived while the user was busy, waiting for them to stop.
    private var stashed: Tree?
    /// True while the user is editing — do not yank the tree away.
    private var busy = false

    /// Whether the app was backgrounded and has not yet come back. Distinct
    /// from the socket being nil, which is also true before the first `start`.
    private var suspended = false

    private var socket: Task<Void, Never>?
    private var retryLoop: Task<Void, Never>?
    private var failures = 0

    /// False once the live connection has failed repeatedly.
    ///
    /// Only ever about *receiving*. Writes go over HTTP and are unaffected,
    /// which is why the UI should say changes are still saved — a blocked
    /// socket costs this device other people's edits, not its own.
    public private(set) var live = true

    /// How many edits the server refused this session.
    ///
    /// Separate from `live` because it is a different failure with a different
    /// consequence: `live` means this device stopped receiving and nothing of
    /// the user's is at risk, while this means an edit they made was not stored
    /// and is about to vanish from the screen at the next adopt.
    public private(set) var rejected = 0

    /// Notified when `live` or `rejected` changes, so the UI can redraw.
    public var onStatusChange: (() -> Void)?

    public init(api: any SyncBackend, queueURL: URL, onAdopt: @escaping (Tree) -> Void) {
        self.api = api
        self.queue = OpQueue(url: queueURL)
        self.onAdopt = onAdopt
    }

    /// Open the socket and start the retry loop. Idempotent.
    public func start() {
        guard socket == nil else { return }
        socket = Task { [weak self] in await self?.listen() }
        retryLoop = Task { [weak self] in
            // A plain interval rather than a backoff: drain() returns
            // immediately when the queue is empty or a send is in flight, so an
            // idle app does nothing but check a count.
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.writeRetry)
                guard let self else { return }
                if !self.queue.isEmpty { await self.drain() }
            }
        }
    }

    public func stop() {
        socket?.cancel()
        retryLoop?.cancel()
        socket = nil
        retryLoop = nil
    }

    /// Tear down the socket because the app is going into the background.
    ///
    /// iOS suspends the process within seconds, and a suspended WebSocket is a
    /// dead one whether or not it is cancelled here — but the reconnect ladder
    /// keeps running until it is, so leaving it up means waking to a task that
    /// has already climbed to its longest backoff and will sit there. Dropping
    /// it deliberately means `resume` starts fresh at the bottom of the ladder.
    ///
    /// The queue is untouched: unsent ops are on disk and are the whole reason
    /// backgrounding is safe.
    public func suspend() {
        suspended = true
        stop()
    }

    /// Reopen the socket and re-sync after the app comes back to the foreground.
    ///
    /// The refetch is not optional. The socket only broadcasts *changes*, so a
    /// reconnect alone leaves this device on whatever tree it had when it was
    /// suspended — every edit made elsewhere in between is invisible until
    /// someone happens to touch the tree again. This is the phone's version of
    /// the cold-start fetch, and unlike `adoptInitial` it has to run even though
    /// `synced` is already true.
    public func resume() {
        // Keyed on having actually been suspended, not on the socket being
        // nil. They come apart on cold launch, where `.active` arrives after
        // `start()` has already opened a socket — testing liveness there would
        // read as "nothing to resume" and skip the refetch. That is survivable
        // only because the cold path fetches on its own, which makes it a bug
        // waiting for the day that stops being true.
        guard suspended else { return }
        suspended = false
        start()

        Task { [weak self] in
            guard let self else { return }
            guard let served = await self.api.loadTree() else { return }
            // Through the same busy gate as any other server tree: coming back
            // to the app with the keyboard already up is ordinary, and adopting
            // under a half-typed row is the bug `busy` exists to prevent.
            self.adoptFromServer(served)
            await self.drain()
        }
    }

    /// Queue ops to send, in order. The caller has already applied them locally.
    public func send(_ ops: Op...) {
        queue.append(ops)
        Task { await drain() }
    }

    /// Adopt a tree fetched over HTTP at startup.
    ///
    /// The socket alone is not enough to get going: its first broadcast only
    /// arrives when something *changes*, so an app opened to an unchanged tree
    /// would sit on its cached copy indefinitely — and, because the first adopt
    /// is what releases held ops, would never send the edits it restored from
    /// the last run either.
    ///
    /// Ignored once the socket has already delivered a baseline, which is
    /// fresher than anything a fetch started at the same moment can be.
    public func adoptInitial(_ tree: Tree) {
        guard !synced else { return }
        adopt(tree)
        Task { await drain() }
    }

    /// Tell the client the user started or stopped editing.
    public func setBusy(_ value: Bool) {
        busy = value
        // They stopped — apply whatever arrived meanwhile.
        if !value, let next = stashed {
            stashed = nil
            adopt(next)
        }
    }

    /// Deliver one broadcast frame, as if it had arrived over the socket.
    ///
    /// The socket itself is not fakeable — `receive()` drives `URLSession`
    /// straight from a URL — so this is where a test injects what the server
    /// would have pushed. It is the same call `receive()` makes on a decoded
    /// frame, so what the tests exercise is the real handler rather than a
    /// parallel one written to be testable.
    func deliverForTesting(tree: Tree, origin: String?) {
        handle(Broadcast(tree: tree, origin: origin))
    }

    /// Adopting is not a local change, so it must not enqueue anything: the
    /// tree being taken *is* the server's.
    private func adopt(_ tree: Tree) {
        synced = true
        onAdopt(tree)
    }

    /// Drain the queue one op at a time.
    ///
    /// The two failures are handled oppositely, and conflating them is what
    /// wedges a queue permanently:
    ///
    ///  - **Unreachable.** Nothing is known about the op, so it stays at the
    ///    head and the whole queue waits. Dropping it would lose an edit the
    ///    user can see on screen.
    ///
    ///  - **Rejected.** The server has judged this op and will judge it the
    ///    same way every time, so it is discarded rather than retried. Keeping
    ///    it would block every later edit forever while the app looked healthy.
    private func drain() async {
        guard !sending, synced else { return }
        sending = true
        defer { sending = false }

        while let op = queue.head {
            let result = await api.send(op)
            if result == .unreachable { break }
            queue.removeHead()
            if case .rejected(let reason) = result {
                // Loud in the log because a malformed op is a client bug and
                // should be debuggable; the UI stays plain because the common
                // cause is an ordinary race the user can do nothing about.
                print("Ansa: the server refused an edit — \(reason), \(op.kind)")
                rejected += 1
                onStatusChange?()
            }
        }
    }

    /// Hold a socket open, reconnecting for as long as this task lives.
    private func listen() async {
        var backoff = Self.reconnectMin
        while !Task.isCancelled {
            let opened = await receive()
            if opened {
                // A connection that worked resets the ladder, so a later drop
                // starts fast again.
                backoff = Self.reconnectMin
                failures = 0
                if !live {
                    live = true
                    onStatusChange?()
                }
            } else {
                failures += 1
                if failures >= Self.failuresBeforeWarning, live {
                    live = false
                    onStatusChange?()
                }
            }
            guard !Task.isCancelled else { return }
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, Self.reconnectMax)
        }
    }

    /// One connection, from handshake to drop.
    ///
    /// - Returns: whether it ever opened. A handshake that fails and a socket
    ///   that opened and later dropped are the same shape here, but only the
    ///   first counts toward the out-of-sync warning.
    private func receive() async -> Bool {
        guard let url = await api.eventsURL() else { return false }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        var opened = false
        while !Task.isCancelled {
            guard let message = try? await task.receive() else { return opened }
            // The first frame to arrive is proof the handshake succeeded.
            // URLSessionWebSocketTask reports no separate open event, and
            // resume() succeeds long before the server has accepted anything.
            opened = true

            let data: Data? =
                switch message {
                case .data(let d): d
                case .string(let s): s.data(using: .utf8)
                @unknown default: nil
                }
            guard let data,
                let frame = try? JSONDecoder().decode(Broadcast.self, from: data)
            else { continue }
            handle(frame)
        }
        return opened
    }

    private func handle(_ frame: Broadcast) {
        if frame.origin == api.origin {
            // The echo of our own write. The local tree already has it, but
            // this is also proof the server is listening — so if it is the
            // first message, it still opens the write path.
            if !synced {
                synced = true
                Task { await drain() }
            }
            return
        }
        adoptFromServer(frame.tree)
        // Ops held back before this point now have a real tree to replay onto.
        Task { await drain() }
    }

    /// Take a server tree, or stash it if the user is mid-edit.
    ///
    /// Shared by the socket and by the foreground refetch so there is one busy
    /// gate rather than two that can disagree.
    private func adoptFromServer(_ tree: Tree) {
        // Until the first sync, adopt even mid-edit: this is the authoritative
        // baseline, and it has to land before any op is replayed on top of it.
        if busy, synced {
            stashed = tree
            return
        }
        adopt(tree)
    }
}
