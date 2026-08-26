import AnsaCore
import Foundation

/// One live connection, from handshake to drop.
///
/// This exists so the reconnect ladder can be tested. `SyncClient` used to
/// drive `URLSession` directly, which made "connected but quiet" and "refused"
/// the same observable event — the bug that let a healthy socket climb to its
/// 30-second backoff and go deaf. Telling those apart is the whole job here,
/// so the two are separate calls rather than one return value.
///
/// Deliberately not `AnyObject`-constrained: the fake in the tests is an actor.
public protocol EventStream: Sendable {
    /// Wait for the handshake. False means it was refused — a bad token, no
    /// network, no server — which is the only thing that should count toward
    /// the out-of-sync warning.
    func open() async -> Bool

    /// The next frame, or nil once the connection has dropped. A connection
    /// that is open but idle simply suspends here, which is the normal state:
    /// frames only arrive when somebody edits something.
    func next() async -> Broadcast?

    /// Ask the server to prove it is still there. False means it isn't.
    ///
    /// A dropped TCP connection is not always reported to the app — a phone
    /// that changes network, or a Durable Object that hibernates, can leave a
    /// socket that looks open and will never deliver anything again. Pinging is
    /// how that gets noticed rather than waited on forever.
    func ping() async -> Bool

    /// Close it. Called once the connection is finished with.
    func close() async
}

/// The real socket.
///
/// `URLSessionWebSocketTask` reports the handshake through a delegate rather
/// than through `resume()`, which returns long before the server has accepted
/// anything. `Opener` below bridges that callback to an `await`.
final class WebSocketStream: EventStream {
    private let task: URLSessionWebSocketTask
    private let opener: Opener

    init(url: URL) {
        opener = Opener()
        // A session per connection, because the delegate is per session and
        // holds this connection's continuation. Sharing `URLSession.shared`
        // would mean one delegate for every socket the app ever opens.
        let session = URLSession(
            configuration: .default, delegate: opener, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.resume()
    }

    func open() async -> Bool { await opener.opened() }

    func next() async -> Broadcast? {
        guard let message = try? await task.receive() else { return nil }
        let data: Data? =
            switch message {
            case .data(let d): d
            case .string(let s): s.data(using: .utf8)
            @unknown default: nil
            }
        guard let data else { return nil }
        // An undecodable frame is not a dropped connection. Returning nil here
        // would tear down a working socket over one bad message.
        return try? JSONDecoder().decode(Broadcast.self, from: data)
    }

    func ping() async -> Bool {
        await withCheckedContinuation { continuation in
            task.sendPing { error in continuation.resume(returning: error == nil) }
        }
    }

    func close() async {
        task.cancel(with: .goingAway, reason: nil)
        await opener.give(up: false)
    }
}

/// Turns the websocket delegate's open/close callbacks into one awaitable Bool.
///
/// Resolves at most once: whichever of open, close, or `close()` arrives first
/// wins, and the rest are dropped. Resuming a continuation twice would trap.
private final class Opener: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var result: Bool?

    func opened() async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func give(up value: Bool) async { settle(value) }

    private func settle(_ value: Bool) {
        lock.lock()
        guard result == nil else { return lock.unlock() }
        result = value
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(returning: value)
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        settle(true)
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        settle(false)
    }

    /// The handshake failing outright — no network, DNS, a refused upgrade —
    /// arrives here rather than through `didCloseWith`.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        settle(false)
    }
}
