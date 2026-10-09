import Foundation
import XCTest

/// The local Worker the Debug app talks to, as the dev stub's user. Tests seed
/// what their feature needs through it and remove it for good afterwards, so
/// the local tree is left as it was found.
enum LocalAPI {
    static let base = URL(string: "http://127.0.0.1:8787")!

    /// A new project holding `tasks`. Returns the project's id.
    static func makeProject(_ name: String, tasks: [String]) async throws -> String {
        let body: [String: Any] = [
            "parentId": NSNull(),
            "nodes": [["text": name, "children": tasks.map { ["text": $0] }]],
        ]
        let data = try await call("POST", "/api/nodes/subtree", body: body)
        guard let ids = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["ids"] as? [String],
              let id = ids.first
        else {
            throw Failure("The Worker made the project but sent back no ids. Check the /api/nodes/subtree route in worker/src/index.ts.")
        }
        return id
    }

    /// A node as the Worker has it, or nil if it has none with that id.
    static func node(_ id: String) async throws -> [String: Any]? {
        let data = try await call("GET", "/api/tree")
        let tree = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["tree"] as? [[String: Any]]
        return tree?.first { $0["id"] as? String == id }
    }

    /// The children of `parent`, by text. The app makes ids of its own on
    /// some paths, so tests look nodes up rather than trusting an order.
    static func child(of parent: String, text: String) async throws -> String {
        let data = try await call("GET", "/api/tree")
        let tree = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["tree"] as? [[String: Any]] ?? []
        guard let id = tree.first(where: { $0["parentId"] as? String == parent && $0["text"] as? String == text })?["id"] as? String
        else {
            throw Failure("The Worker has no \"\(text)\" under \(parent). Check the /api/nodes/subtree route in worker/src/index.ts.")
        }
        return id
    }

    /// Whether the Worker comes to see `id` as done == `want` within a few
    /// seconds: the app sends its ops on a queue, not at the tap.
    static func settles(_ id: String, done want: Bool) async throws -> Bool {
        for _ in 0..<20 {
            if try await node(id)?["done"] as? Bool == want { return true }
            try await Task.sleep(for: .milliseconds(250))
        }
        return false
    }

    /// Deletes a node and its subtree for good, not to the trash.
    static func remove(_ id: String) async throws {
        _ = try await call("DELETE", "/api/nodes/\(id)")
    }

    private static func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = method
        req.setValue("dev", forHTTPHeaderField: "x-ansa-user")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, res: URLResponse
        do {
            (data, res) = try await URLSession.shared.data(for: req)
        } catch {
            throw Failure("Can't reach the local Worker at \(base). Start it with ./build.sh web --no-auth from the repo root, then rerun.")
        }
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Failure("\(method) \(path) answered \(status): \(String(decoding: data, as: UTF8.self)). If it's 401, the Worker is running with sign-in; restart it with ./build.sh web --no-auth.")
        }
        return data
    }

    struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}

/// A step that has to hold for the next one to mean anything. Throws rather
/// than asserting: in an async test `continueAfterFailure = false` does not
/// stop the test, so a failed assert would run on and still print its ✓.
func need(_ ok: Bool, _ fix: String) throws {
    if !ok { throw LocalAPI.Failure(fix) }
}
