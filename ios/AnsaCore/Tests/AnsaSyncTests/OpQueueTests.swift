import AnsaCore
import Foundation
import Testing

@testable import AnsaSync

/// A fresh path per test, so the suite can run in parallel and no test inherits
/// another's file.
private func tempURL() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "ansa-queue-tests")
        .appending(path: UUID().uuidString)
        .appending(path: "queue.json")
}

@MainActor
@Suite("The op queue")
struct OpQueueTests {
    @Test("starts empty when nothing was ever saved")
    func coldStart() {
        let q = OpQueue(url: tempURL())
        #expect(q.isEmpty)
        #expect(q.head == nil)
    }

    @Test("hands ops back oldest first")
    func ordering() {
        let q = OpQueue(url: tempURL())
        q.append([.setText(id: "a", text: "one"), .setText(id: "b", text: "two")])
        #expect(q.head == .setText(id: "a", text: "one"))
        q.removeHead()
        #expect(q.head == .setText(id: "b", text: "two"))
        q.removeHead()
        #expect(q.isEmpty)
    }

    /// The reason this class exists. A phone kills backgrounded apps routinely,
    /// and an op that only lived in memory is an edit the user can still see on
    /// screen that the server will never hear about.
    @Test("survives the process dying")
    func survivesRestart() {
        let url = tempURL()
        let before = OpQueue(url: url)
        before.append([.setDone(id: "a", done: true), .removeNode(id: "b")])

        // A second instance on the same path is what the next launch gets.
        let after = OpQueue(url: url)
        #expect(after.count == 2)
        #expect(after.head == .setDone(id: "a", done: true))
    }

    /// Persisting on each removal rather than once at the end of a drain. A
    /// kill mid-drain must not resurrect ops the server already applied:
    /// `toggleCollapsed` is not idempotent and would flip back.
    @Test("a drain that dies halfway does not resend what already went out")
    func persistsEachRemoval() {
        let url = tempURL()
        let before = OpQueue(url: url)
        before.append([.toggleCollapsed(id: "a"), .toggleCollapsed(id: "b")])
        before.removeHead()  // 'a' reached the server; then the app dies here.

        let after = OpQueue(url: url)
        #expect(after.count == 1)
        #expect(after.head == .toggleCollapsed(id: "b"))
    }

    @Test("an emptied queue leaves nothing behind")
    func clearsFile() {
        let url = tempURL()
        let q = OpQueue(url: url)
        q.append([.setText(id: "a", text: "x")])
        q.removeHead()
        #expect(!FileManager.default.fileExists(atPath: url.path))
        #expect(OpQueue(url: url).isEmpty)
    }

    /// A corrupt file must not be fatal. On a phone, throwing here would mean
    /// an app that cannot start until it is reinstalled — losing the whole
    /// cached tree to save a queue that is already unreadable.
    @Test("a corrupt file is discarded rather than crashing the boot")
    func corruptFile() throws {
        let url = tempURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{not json at all".utf8).write(to: url)

        let q = OpQueue(url: url)
        #expect(q.isEmpty)
        // And it still works afterwards, rather than being wedged.
        q.append([.setText(id: "a", text: "x")])
        #expect(OpQueue(url: url).count == 1)
    }

    @Test("appending nothing does not touch the file")
    func emptyAppend() {
        let url = tempURL()
        let q = OpQueue(url: url)
        q.append([])
        #expect(q.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test("removing from an empty queue is a no-op")
    func removeFromEmpty() {
        let q = OpQueue(url: tempURL())
        q.removeHead()
        #expect(q.isEmpty)
    }

    /// Every op kind has to survive the round trip, not just the two the other
    /// tests happen to use — a queue that silently drops `moveNode` on restart
    /// would lose exactly the edits that are hardest to redo from memory.
    @Test("every op kind round-trips through the file")
    func allKindsRoundTrip() {
        let ops: [Op] = [
            .setText(id: "a", text: "x"),
            .setDone(id: "a", done: true),
            .setPinned(id: "a", pinned: true),
            .toggleCollapsed(id: "a"),
            .removeNode(id: "a"),
            .addChild(id: "n", parentId: nil, text: "t", at: 1),
            .moveNode(id: "a", parentId: nil, index: 0),
        ]
        let url = tempURL()
        let before = OpQueue(url: url)
        before.append(ops)

        let after = OpQueue(url: url)
        #expect(after.count == ops.count)
        for expected in ops {
            #expect(after.head == expected)
            after.removeHead()
        }
    }
}
