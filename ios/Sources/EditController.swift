import AnsaCore
import SwiftUI

/// Renaming a row, adding a run of them, and which row the next one lands below.
///
/// These are one concern wearing three names. A new task is a row that starts
/// empty and focused, so adding *is* renaming with the mode flag set — and
/// where it lands is a fact only the edit path knows, since the last row
/// touched is the anchor. Keeping them in one type puts that in one place
/// instead of spreading it across a comment.
///
/// Focus is deliberately not here. `@FocusState` only works declared on a View,
/// so `editing` (which row has a field) lives here while the focus binding
/// stays on the view, and `beginEdit` bridges the two.
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
    /// Adding is a mode because Return has to mean one thing inside it: commit
    /// this row and open the next. Without a mode the same key had to serve as
    /// "next task", "stop adding" and "finish this rename" at once, and the
    /// way that failed was silent — the keyboard came down and the next thing
    /// typed went into a row that was already named.
    ///
    /// Separate from `editing`, which says a field is open. Every row in a run
    /// is an edit; the mode is what makes the *next* one appear.
    var adding = false

    /// The row a new task lands below, or nil for the bottom of the project.
    ///
    /// Set by touching any row, so the plus button files next to whatever was
    /// last worked on rather than always at the end. Nil is not a missing
    /// answer — it is the honest one for a project nothing has been tapped in
    /// yet, and the bottom is where a first task belongs.
    ///
    /// Cleared whenever the context it was captured in stops being true:
    /// leaving the project, or the row itself going away. Filing silently
    /// somewhere other than where the user last was is worse than filing at the
    /// bottom.
    var captureParent: NodeId?

    /// Whether a rename is open. What the busy flag actually asks.
    var isEditing: Bool { editing != nil }

    /// Seed a rename. The caller focuses the field a turn later — `editing` is
    /// what builds it, so focusing in the same pass targets a field that does
    /// not exist yet.
    func begin(_ node: Node) {
        begin(id: node.id, text: node.text)
    }

    /// The same, for a row that does not exist in the tree yet.
    ///
    /// `addRow` opens the field before it applies the ops that create the node,
    /// so there is nothing to pass a `Node` from — and that ordering is what
    /// keeps the keyboard up across the rebuild.
    func begin(id: NodeId, text newText: String) {
        text = newText
        editing = id
        // Now, not on commit. Tapping a row is the user saying which row they
        // mean, so the next task filed lands there even if the rename is
        // abandoned rather than finished.
        captureParent = id
    }

    /// Whether a commit from `from` should be honoured.
    ///
    /// A blur arrives after the field has gone, so by then `editing` may
    /// already name a different row; committing that one would end an edit the
    /// user just started.
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
