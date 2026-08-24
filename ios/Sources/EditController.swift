import AnsaCore
import SwiftUI

/// Renaming a row, and the capture field's memory of which row that was.
///
/// These are one concern wearing two names. The capture field files a new task
/// next to the row last edited, which is a fact only the edit path knows — and
/// the reason it has to be *remembered* rather than read live is that tapping
/// the capture field is itself what ends the edit. Keeping them in one type
/// puts that handoff in one place instead of spreading it across a comment.
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

    /// The capture field's draft.
    var draft = ""

    /// The row the capture field drops the next task below.
    ///
    /// Not derived from `editing`: tapping the capture field moves focus, which
    /// commits the edit and clears `editing` before a single character is
    /// typed. By the time it matters the live state is already gone, so the row
    /// is remembered as the edit closes.
    ///
    /// Cleared whenever the context it was captured in stops being true —
    /// leaving the project, tapping the X, or the row itself going away. A
    /// field that silently files somewhere other than where it says is worse
    /// than one that only ever files at the bottom.
    var captureParent: NodeId?

    /// Whether a rename is open. What the busy flag actually asks.
    var isEditing: Bool { editing != nil }

    /// Seed a rename. The caller focuses the field a turn later — `editing` is
    /// what builds it, so focusing in the same pass targets a field that does
    /// not exist yet.
    func begin(_ node: Node) {
        text = node.text
        editing = node.id
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
    func endEdit(rememberAnchor: NodeId?) {
        captureParent = rememberAnchor
        editing = nil
        text = ""
    }
}
