import AnsaCore
import SwiftUI

/// Renaming a row, adding a run of them, and which row the next one lands below.
///
/// One concern wearing three names: a new task is a row that starts empty and
/// focused, so adding *is* renaming with the mode flag set, and the last row
/// touched is the anchor for where the next one lands.
///
/// Focus is not here — `@FocusState` only works declared on a View, so the
/// binding stays there and `beginEdit` bridges the two.
@Observable
final class EditController {
    /// The row being renamed, or nil when nothing is. This is what causes a
    /// row's `TextField` to exist at all.
    var editing: NodeId?
    /// The live text of that field. Held outside the row so the tree can change
    /// underneath without resetting what is being typed.
    var text = ""

    /// Whether the user is in a run of adding tasks.
    ///
    /// A mode because Return has to mean one thing inside it: commit this row
    /// and open the next. Separate from `editing`, which only says a field is
    /// open — the mode is what makes the *next* one appear.
    var adding = false

    /// The row a new task lands below, or nil for the bottom of the project.
    ///
    /// Set by touching any row, so the plus button files next to whatever was
    /// last worked on. Cleared when the context it was captured in stops being
    /// true — leaving the project, or the row going away — because filing
    /// somewhere other than where the user last was is worse than the bottom.
    var captureParent: NodeId?

    /// Whether a rename is open. What the busy flag actually asks.
    var isEditing: Bool { editing != nil }

    /// Seed a rename. The caller focuses the field a turn later — `editing` is
    /// what builds it, so focusing in the same pass targets a field that does
    /// not exist yet.
    func begin(_ node: Node) {
        begin(id: node.id, text: node.text)
    }

    /// The same, for a row not in the tree yet. `addRow` opens the field before
    /// applying the ops that create the node, and that ordering is what keeps
    /// the keyboard up across the rebuild.
    func begin(id: NodeId, text newText: String) {
        text = newText
        editing = id
        // Now, not on commit. Tapping a row is the user saying which row they
        // mean, so the next task filed lands there even if the rename is
        // abandoned rather than finished.
        captureParent = id
    }

    /// Whether a commit from `from` should be honoured. A blur arrives after
    /// the field has gone, so `editing` may already name a different row and
    /// committing it would end an edit the user just started.
    func shouldCommit(from: NodeId?) -> Bool {
        guard let id = editing else { return false }
        return from == nil || from == id
    }

    /// Take the rename down. The caller applies the op and decides whether the
    /// row survived — this only clears state.
    /// - Parameter rememberAnchor: the row to keep as the capture anchor, or
    ///   nil to clear it. `begin` already set it, so this exists for the case
    ///   that invalidates it: committing an emptied row deletes it, and an
    ///   anchor pointing at a node that just went away sends the next capture
    ///   to the bottom while the chip still claims otherwise.
    func endEdit(rememberAnchor: NodeId?) {
        captureParent = rememberAnchor
        editing = nil
        text = ""
    }

    /// Leave the adding run. The caller decides what happens to the open row —
    /// this only drops the mode, so a plain rename started afterwards does not
    /// inherit it.
    func stopAdding() {
        adding = false
    }
}
