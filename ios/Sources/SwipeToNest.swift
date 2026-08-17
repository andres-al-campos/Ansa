import SwiftUI

/// Drag a row sideways to change its depth: right indents, left outdents.
///
/// A drag rather than SwiftUI's `swipeActions`, which reveal a button and spring
/// back — that costs a swipe plus a tap per level, and moving a row three levels
/// would be three separate gestures. Dragging matches what the gesture means
/// (the row goes where you push it) and lets one continuous drag cross several
/// levels.
///
/// The row follows the finger only as far as the moves that are actually legal.
/// A row that cannot indent — the first child of its parent, with no sibling
/// above to adopt it — stays put under the finger instead of sliding and
/// snapping back, so the limit is visible during the gesture rather than after
/// it.
struct SwipeToNest: ViewModifier {
    /// One level of depth. Matches the row's indent so the row lands where the
    /// drag visually promised.
    static let step: CGFloat = 18

    /// How far past a step boundary the finger must travel before that level is
    /// committed. Without it, a row resting exactly on a boundary flickers
    /// between two depths as the finger jitters.
    private static let hysteresis: CGFloat = 6

    let canIndent: Bool
    let canOutdent: Bool
    let onIndent: () -> Void
    let onOutdent: () -> Void
    /// Called when a drag starts and again when it ends.
    ///
    /// A drag is a mid-edit state exactly as typing is: adopting a server tree
    /// while a finger is on a row renumbers the rows under it, so the drag
    /// finishes against a row that has moved or is no longer there.
    let onDragging: (Bool) -> Void

    @State private var offset: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .animation(.interactiveSpring, value: offset)
            // Derived from the offset rather than set inside the gesture
            // handlers, so an interrupted or cancelled drag cannot leave the
            // client stuck busy and silently not receiving.
            .onChange(of: offset != 0) { _, dragging in onDragging(dragging) }
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        // Vertical drags belong to the List's scrolling. Without
                        // this the row grabs the gesture and scrolling stops
                        // working anywhere near a row, which is everywhere.
                        guard abs(value.translation.width) > abs(value.translation.height) else {
                            return
                        }
                        offset = clamp(value.translation.width)
                    }
                    .onEnded { value in
                        guard abs(value.translation.width) > abs(value.translation.height) else {
                            offset = 0
                            return
                        }
                        commit(clamp(value.translation.width))
                        offset = 0
                    }
            )
    }

    /// Stop the row at the last legal depth, so the gesture cannot promise a
    /// move that will not happen.
    private func clamp(_ width: CGFloat) -> CGFloat {
        if width > 0 { return canIndent ? min(width, Self.step) : 0 }
        return canOutdent ? max(width, -Self.step) : 0
    }

    private func commit(_ width: CGFloat) {
        let threshold = Self.step - Self.hysteresis
        if width >= threshold, canIndent { onIndent() }
        if width <= -threshold, canOutdent { onOutdent() }
    }
}

extension View {
    func swipeToNest(
        canIndent: Bool,
        canOutdent: Bool,
        onIndent: @escaping () -> Void,
        onOutdent: @escaping () -> Void,
        onDragging: @escaping (Bool) -> Void
    ) -> some View {
        modifier(
            SwipeToNest(
                canIndent: canIndent, canOutdent: canOutdent,
                onIndent: onIndent, onOutdent: onOutdent,
                onDragging: onDragging))
    }
}
