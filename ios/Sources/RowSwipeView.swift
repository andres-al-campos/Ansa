import SwiftUI
import AnsaCore

/// The horizontal swipe on an outline row: the gesture, the offset it drives,
/// and the two layers under the row that the offset uncovers.
///
/// Extracted from `OutlineRow`, which held five pieces of `@State` for this
/// tangled among the ones for editing, dragging and focus. The decisions about
/// thresholds live a level further out again, in `AnsaCore.RowSwipe`, so they
/// can be tested without a simulator. What is left here is the part that needs
/// a view: the state machine and the three layers.
struct RowSwipeView<Content: View>: View {
    /// Which way the row is travelling. Also picks the action and the colour.
    enum Direction { case left, right }

    let vPadding: CGFloat
    let screenWidth: CGFloat
    /// True while some *other* interaction owns this touch. The swipe stands
    /// down rather than competing with a carry or a back swipe.
    let inert: Bool
    let onDelete: () -> Void
    let onZoom: () -> Void
    let onSwipingChanged: (Bool) -> Void
    /// The content, handed a flag saying whether a tap arriving now is the
    /// tail of a swipe rather than a tap.
    ///
    /// A Button inside a List does not lose its touch to a sibling
    /// DragGesture: the row slid sideways under the finger and the release
    /// still read as a tap, so every cancelled swipe opened the editor on the
    /// row it had just let go. The window is the spring back's own duration.
    @ViewBuilder let content: (_ justSwiped: Bool) -> Content

    /// How far the row is drawn from rest. The single animated value.
    @State private var offset: CGFloat = 0
    /// The row's own width, so a committing delete knows how far to carry it.
    @State private var width: CGFloat = 0
    /// The live direction of the finger, nil before the gesture commits to one.
    @State private var direction: Direction?
    /// Latched, unlike `direction`: this outlives the release so the layers
    /// under the row stay alive while it travels home.
    @State private var settling: Direction?
    @State private var wasArmed = false
    @State private var endedAt: Date?

    private let armHaptic = UIImpactFeedbackGenerator(style: .light)

    var body: some View {
        content(justSwiped)
            .background(ground)
            .offset(x: offset)
            .background(band)
            .background {
                GeometryReader { geo in
                    Color.clear
                        .onAppear { width = geo.size.width }
                        .onChange(of: geo.size.width) { _, w in width = w }
                }
            }
            .simultaneousGesture(gesture)
            .onDisappear {
                if direction != nil { onSwipingChanged(false) }
            }
            .onAppear {
                offset = 0
                direction = nil
                settling = nil
                wasArmed = false
            }
    }

    // MARK: - Layers

    /// The row's own opaque ground, drawn only while a swipe is open.
    ///
    /// The row draws none of its own — at rest it is transparent over the list
    /// — so without this the band behind it would show straight through the
    /// text.
    @ViewBuilder private var ground: some View {
        if settling != nil {
            Rectangle()
                .fill(Color(.systemBackground))
                .padding(.vertical, -vPadding)
        }
    }

    /// What the row slides off to reveal: blue on the leading half, red on the
    /// trailing one, so whichever way the row goes uncovers the colour of what
    /// releasing will do.
    ///
    /// Both halves read `settling` rather than `offset`. Reading a value that
    /// is animating to zero made each comparison go false partway home, and
    /// the band vanished from under a row that was still travelling.
    @ViewBuilder private var band: some View {
        if let settling {
            ZStack(alignment: settling == .left ? .trailing : .leading) {
                HStack(spacing: 0) {
                    Color.accentColor
                        .opacity(settling == .right && armed ? 1 : 0.5)
                    Color.red
                        .opacity(settling == .left && armed ? 1 : 0.5)
                }
                if let action {
                    Image(systemName: action.label)
                        .foregroundStyle(.white.opacity(armed ? 1 : 0.85))
                        .font(.system(size: armed ? 24 : 21, weight: .medium))
                        .frame(width: abs(offset))
                }
            }
            .animation(.easeOut(duration: 0.12), value: armed)
            .padding(.vertical, -vPadding)
        }
    }

    // MARK: - Decisions

    /// Whether a tap arriving now is the tail of a swipe that just let go.
    private var justSwiped: Bool {
        !RowSwipe.acceptsTap(elapsed: endedAt.map { Date().timeIntervalSince($0) })
    }

    private var armed: Bool {
        RowSwipe.isArmed(offset, screenWidth: screenWidth)
    }

    private var action: (label: String, run: () -> Void)? {
        switch direction {
        case .left: return ("trash.fill", onDelete)
        case .right: return ("chevron.right", onZoom)
        case nil: return nil
        }
    }

    // MARK: - Gesture

    private var gesture: some Gesture {
        DragGesture(minimumDistance: 20, coordinateSpace: .local)
            .onChanged { g in
                guard !inert else { return }
                let d = g.translation.width
                direction = abs(d) < 20 ? nil : (d < 0 ? .left : .right)
                if let direction { settling = direction }
                onSwipingChanged(direction != nil)
                if direction != nil { armHaptic.prepare() }
                guard action != nil else { return }
                offset = RowSwipe.offset(for: d, screenWidth: screenWidth)
                let nowArmed = RowSwipe.isArmed(d, screenWidth: screenWidth)
                if nowArmed != wasArmed {
                    armHaptic.impactOccurred(intensity: nowArmed ? 1 : 0.6)
                    wasArmed = nowArmed
                }
            }
            .onEnded { g in
                defer {
                    onSwipingChanged(false)
                    if direction != nil { endedAt = Date() }
                    direction = nil
                    wasArmed = false
                }
                guard !inert, let action else { springBack(); return }
                guard RowSwipe.isArmed(g.translation.width,
                                       screenWidth: screenWidth) else {
                    springBack()
                    return
                }
                // Only a delete rides out. That row is leaving, so carrying it
                // the rest of the way is what stops it vanishing from under the
                // finger. A zoom keeps the row — the screen changes around it —
                // so sliding it off would park a live row off screen.
                if direction == .left {
                    withAnimation(.easeIn(duration: 0.16)) { offset = -width }
                } else {
                    offset = 0
                    settling = nil
                }
                action.run()
            }
    }

    /// Eases the row home from a pull that did not reach the threshold.
    private func springBack() {
        withAnimation(.easeOut(duration: 0.22)) { offset = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
            if offset == 0 { settling = nil }
        }
    }
}
