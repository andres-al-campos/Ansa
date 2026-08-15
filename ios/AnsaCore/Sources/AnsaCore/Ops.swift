/// Operations: the unit of change that travels between clients and the server.
///
/// A port of `shared/ops.ts`. The app used to send the whole tree after every
/// edit, which made concurrent writes last-writer-wins over the entire document.
/// Sending the *operation* instead makes the server the serialization point: two
/// writers interleave as two ops applied to one tree.
///
/// Every op is a pure function of its arguments. That is the property the scheme
/// rests on — the client applies an op locally for instant feedback and the
/// server applies the same op to its own tree, and both must land on the same
/// result. The two things that would break it are minting ids and reading the
/// clock, so ops that create nodes carry their ids and timestamps rather than
/// generating them on each side. That is why `addChild` takes an `id` and an
/// `at` here rather than calling `newId()`.
///
/// This is not a CRDT. Two ops that genuinely conflict still resolve
/// last-write-wins on the loser. What it buys is that non-conflicting concurrent
/// edits stop destroying each other, which was the actual failure.

import Foundation

/// Every mutation the app can make, named.
///
/// Structural ops (indent, outdent, adoptFollowing, insertAtDepth) are sent as
/// themselves rather than as the moveNode calls they decompose into:
/// `adoptFollowing` is a fold over N moves, and sending it whole means one
/// broadcast instead of N, so other clients don't watch the rows migrate one at
/// a time.
public enum Op: Equatable, Sendable {
    case addChild(id: NodeId, parentId: NodeId?, text: String, at: Double)
    case addSubtree(ids: [NodeId], parentId: NodeId?, nodes: [TreeOps.SubtreeSpec], at: Double)
    case setText(id: NodeId, text: String)
    case setDone(id: NodeId, done: Bool)
    case removeNode(id: NodeId)
    case moveNode(id: NodeId, parentId: NodeId?, index: Int)
    case indent(id: NodeId)
    case outdent(id: NodeId)
    case adoptFollowing(id: NodeId)
    case insertAtDepth(
        id: NodeId, anchorId: NodeId, depth: Int, side: TreeOps.DropSide, scope: NodeId?)
    case toggleCollapsed(id: NodeId)
    case setPinned(id: NodeId, pinned: Bool)
    case markOpened(id: NodeId, at: Double)

    /// The `op` discriminator on the wire. Must match `OP_KINDS` in ops.ts
    /// exactly — the server rejects anything else with a 400.
    public var kind: String {
        switch self {
        case .addChild: "addChild"
        case .addSubtree: "addSubtree"
        case .setText: "setText"
        case .setDone: "setDone"
        case .removeNode: "removeNode"
        case .moveNode: "moveNode"
        case .indent: "indent"
        case .outdent: "outdent"
        case .adoptFollowing: "adoptFollowing"
        case .insertAtDepth: "insertAtDepth"
        case .toggleCollapsed: "toggleCollapsed"
        case .setPinned: "setPinned"
        case .markOpened: "markOpened"
        }
    }
}

/// The conformance itself is declared on the struct in Tree.swift, because
/// Swift only synthesises `==` in the declaring file. The coding lives here,
/// next to the ops that put a spec on the wire.
extension TreeOps.SubtreeSpec {
    enum CodingKeys: String, CodingKey { case text, children }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            text: try c.decode(String.self, forKey: .text),
            children: try c.decodeIfPresent([TreeOps.SubtreeSpec].self, forKey: .children) ?? [])
    }

    /// `children` is omitted when empty, matching parseSpecs, which only sets
    /// the key when there are kids.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        if !children.isEmpty { try c.encode(children, forKey: .children) }
    }
}

// MARK: - Wire format

/// Hand-written rather than synthesised, because the wire format is a flat
/// tagged object (`{"op":"setText","id":"a","text":"x"}`) and Swift's default
/// enum encoding nests the payload under the case name. The server's `parseOp`
/// reads the flat shape; anything else is a 400.
extension Op: Codable {
    private enum K: String, CodingKey {
        case op, id, ids, parentId, text, done, index, at, nodes
        case anchorId, depth, side, scope, pinned
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(kind, forKey: .op)
        switch self {
        case let .addChild(id, parentId, text, at):
            try c.encode(id, forKey: .id)
            try c.encode(parentId, forKey: .parentId)  // null means the root list
            try c.encode(text, forKey: .text)
            try c.encode(at, forKey: .at)
        case let .addSubtree(ids, parentId, nodes, at):
            try c.encode(ids, forKey: .ids)
            try c.encode(parentId, forKey: .parentId)
            try c.encode(nodes, forKey: .nodes)
            try c.encode(at, forKey: .at)
        case let .setText(id, text):
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
        case let .setDone(id, done):
            try c.encode(id, forKey: .id)
            try c.encode(done, forKey: .done)
        case let .removeNode(id):
            try c.encode(id, forKey: .id)
        case let .moveNode(id, parentId, index):
            try c.encode(id, forKey: .id)
            try c.encode(parentId, forKey: .parentId)
            try c.encode(index, forKey: .index)
        case let .indent(id), let .outdent(id), let .adoptFollowing(id),
             let .toggleCollapsed(id):
            try c.encode(id, forKey: .id)
        case let .insertAtDepth(id, anchorId, depth, side, scope):
            try c.encode(id, forKey: .id)
            try c.encode(anchorId, forKey: .anchorId)
            try c.encode(depth, forKey: .depth)
            try c.encode(side, forKey: .side)
            try c.encode(scope, forKey: .scope)  // null means the root list
        case let .setPinned(id, pinned):
            try c.encode(id, forKey: .id)
            try c.encode(pinned, forKey: .pinned)
        case let .markOpened(id, at):
            try c.encode(id, forKey: .id)
            try c.encode(at, forKey: .at)
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let kind = try c.decode(String.self, forKey: .op)

        // parentId and scope are genuinely nullable — null means "the root
        // list", so a decoded null and a missing key have to stay distinct.
        //
        // `decode(NodeId?.self)` is what makes that hold: unlike
        // `decodeIfPresent`, it throws keyNotFound on an absent key and returns
        // nil only for a literal null. A truncated op therefore fails rather
        // than quietly re-rooting a node. Do not "simplify" this to
        // decodeIfPresent — the two read identically and mean opposite things.
        func nullable(_ key: K) throws -> NodeId? {
            try c.decode(NodeId?.self, forKey: key)
        }
        func id() throws -> NodeId { try c.decode(NodeId.self, forKey: .id) }

        switch kind {
        case "addChild":
            self = .addChild(
                id: try id(), parentId: try nullable(.parentId),
                text: try c.decode(String.self, forKey: .text),
                at: try c.decode(Double.self, forKey: .at))
        case "addSubtree":
            self = .addSubtree(
                ids: try c.decode([NodeId].self, forKey: .ids),
                parentId: try nullable(.parentId),
                nodes: try c.decode([TreeOps.SubtreeSpec].self, forKey: .nodes),
                at: try c.decode(Double.self, forKey: .at))
        case "setText":
            self = .setText(id: try id(), text: try c.decode(String.self, forKey: .text))
        case "setDone":
            self = .setDone(id: try id(), done: try c.decode(Bool.self, forKey: .done))
        case "removeNode":
            self = .removeNode(id: try id())
        case "moveNode":
            self = .moveNode(
                id: try id(), parentId: try nullable(.parentId),
                index: try c.decode(Int.self, forKey: .index))
        case "indent":
            self = .indent(id: try id())
        case "outdent":
            self = .outdent(id: try id())
        case "adoptFollowing":
            self = .adoptFollowing(id: try id())
        case "insertAtDepth":
            self = .insertAtDepth(
                id: try id(),
                anchorId: try c.decode(NodeId.self, forKey: .anchorId),
                depth: try c.decode(Int.self, forKey: .depth),
                side: try c.decode(TreeOps.DropSide.self, forKey: .side),
                scope: try nullable(.scope))
        case "toggleCollapsed":
            self = .toggleCollapsed(id: try id())
        case "setPinned":
            self = .setPinned(id: try id(), pinned: try c.decode(Bool.self, forKey: .pinned))
        case "markOpened":
            self = .markOpened(id: try id(), at: try c.decode(Double.self, forKey: .at))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .op, in: c, debugDescription: "unknown op: \(kind)")
        }
    }
}

// MARK: - Apply

extension TreeOps {
    /// Apply an op to a tree, returning the new tree.
    ///
    /// Total and non-throwing: an op naming a node that no longer exists returns
    /// the tree unchanged, matching how the underlying pure ops already behave.
    /// That is what lets a queued op arrive after the tree moved on and be a
    /// harmless no-op rather than a crash — the alternative is a client that
    /// wedges whenever it races a delete, which is the normal case for a phone
    /// coming back from offline.
    ///
    /// `completed` rides along from setDone: the ids of parents that flipped to
    /// done, which the UI uses to fire the completion animation.
    public static func applyOp(_ tree: Tree, _ op: Op) -> (tree: Tree, completed: [NodeId]) {
        switch op {
        case let .addChild(id, parentId, text, at):
            return (addChild(tree, parentId, text, id: id, now: at).tree, [])
        case let .addSubtree(ids, parentId, nodes, at):
            return (addSubtree(tree, parentId, nodes, withIds: ids, now: at).tree, [])
        case let .setText(id, text):
            return (setText(tree, id, text), [])
        case let .setDone(id, done):
            return setDone(tree, id, done)
        case let .removeNode(id):
            return (removeNode(tree, id), [])
        case let .moveNode(id, parentId, index):
            return (moveNode(tree, id, parentId, index), [])
        case let .indent(id):
            return (indent(tree, id), [])
        case let .outdent(id):
            return (outdent(tree, id), [])
        case let .adoptFollowing(id):
            return (adoptFollowing(tree, id), [])
        case let .insertAtDepth(id, anchorId, depth, side, scope):
            return (insertAtDepth(tree, id, anchorId, depth, side, scope), [])
        case let .toggleCollapsed(id):
            return (toggleCollapsed(tree, id), [])
        case let .setPinned(id, pinned):
            return (setPinned(tree, id, pinned), [])
        case let .markOpened(id, at):
            return (markOpened(tree, id, at: at), [])
        }
    }
}
