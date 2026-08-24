import AnsaCore
import Foundation
import Testing
@testable import AnsaSync

/// The cache exists to stop a cold launch showing an empty account, so what it
/// must never do is *claim* emptiness — every failure here has to be
/// indistinguishable from having no cache, which is a blank paint and nothing
/// more.
@MainActor
@Suite("The tree cache")
struct TreeCacheTests {

    private func tmp() -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "ansa-cache-test-\(UUID().uuidString)")
            .appending(path: "tree.v1.json")
    }

    private func tree() -> Tree {
        [Node(id: "p", parentId: nil, text: "Project", done: false, order: 0,
              collapsed: false, createdAt: 0),
         Node(id: "a", parentId: "p", text: "task a", done: false, order: 0,
              collapsed: false, createdAt: 0)]
    }

    @Test("a saved tree comes back")
    func roundTrips() {
        let url = tmp()
        TreeCache(url: url).save(tree())
        #expect(TreeCache(url: url).load() == tree())
    }

    @Test("a missing file is a cold start, not an error")
    func coldStart() {
        #expect(TreeCache(url: tmp()).load() == nil)
    }

    @Test("a corrupt file reads as no cache")
    func corrupt() {
        let url = tmp()
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data("not json".utf8).write(to: url)
        // Nil rather than a throw: the caller's fallback is the blank paint it
        // would have had anyway, and a crash on boot over a cache file would be
        // far worse than the problem this solves.
        #expect(TreeCache(url: url).load() == nil)
    }

    @Test("an empty tree clears the file rather than storing emptiness")
    func emptyClears() {
        let url = tmp()
        let cache = TreeCache(url: url)
        cache.save(tree())
        cache.save([])
        // Storing `[]` would come back next launch as a cache that asserts the
        // user has no projects — which only the server is entitled to say.
        #expect(cache.load() == nil)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test("saving replaces rather than merging")
    func replaces() {
        let url = tmp()
        let cache = TreeCache(url: url)
        cache.save(tree())
        let smaller: Tree = [Node(id: "p", parentId: nil, text: "Project", done: false,
                                  order: 0, collapsed: false, createdAt: 0)]
        cache.save(smaller)
        // A deletion made elsewhere has to survive the cache, or the deleted
        // row comes back on the next launch.
        #expect(cache.load() == smaller)
    }
}
