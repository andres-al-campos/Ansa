import SwiftUI
import AnsaCore

/// What a full swipe one way does.
struct RowSwipeAction {
    /// The glyph on the band the row uncovers.
    let glyph: String
    /// The band's colour.
    let tint: Color
    /// Whether the row rides out past the edge on release. Only for an action
    /// that takes the row away then and there: one that keeps it (a zoom) or
    /// asks first (a delete for good) springs it home, or a cancelled question
    /// would leave a live row parked off screen.
    let leaves: Bool
    let run: () -> Void
}

/// The horizontal swipe on an outline row: the gesture, the offset it drives,
/// and the two layers under the row that the offset uncovers. Thresholds and
/// curves live in `AnsaCore.RowSwipe`, where they're testable without a device.
struct RowSwipeView<Content: View>: View {
    /// Which way the row is travelling. Also picks the action and the colour.
    enum Direction { case left, right }

    /// Which row this is. Watched, not just stored: SwiftUI reuses this view
    /// for a different row, and the swipe state has to come with it.
    let rowId: NodeId
    let vPadding: CGFloat
    let screenWidth: CGFloat
    /// True while some *other* interaction owns this touch. The swipe stands
    /// down rather than competing with a carry or a back swipe.
    let inert: Bool
    /// Finger travelling left, and right. An outline row deletes and zooms; a
    /// Trash row deletes for good and restores.
    let left: RowSwipeAction
    let right: RowSwipeAction
    let onSwipingChanged: (Bool) -> Void
    /// The content, told whether a tap arriving now is a swipe's tail. A Button
    /// in a List keeps its tap through a sibling DragGesture, so without this
    /// every cancelled swipe opened the editor.
    @ViewBuilder let content: (_ justSwiped: Bool) -> Content

    /// Owns `offset` and the clock that returns it to zero. A class because a
    /// display link's tick has to reach state that outlives one body
    /// evaluation; as `@State` it fired once and stopped.
    @State private var motion = RowSwipeMotion()
    /// The row's own width, so a committing delete knows how far to carry it.
    @State private var width: CGFloat = 0
    /// The live direction of the finger, nil before the gesture commits to one.
    @State private var direction: Direction?
    /// The axis this touch latched onto, decided once it clears the threshold.
    /// A `.vertical` latch stands the swipe down so the list scrolls; the latch
    /// holds until the finger lifts, so a drifting scroll can't become a swipe
    /// (nor a swipe start scrolling) partway through.
    @State private var axis: RowSwipe.Axis?
    /// Latched, unlike `direction`: this outlives the release so the layers
    /// under the row stay alive while it travels home.
    @State private var settling: Direction?
    @State private var wasArmed = false
    @State private var endedAt: Date?

    /// How far the row is drawn from rest, in points.
    private var offset: CGFloat { motion.offset }

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
                motion.stopReturn()
                if direction != nil { onSwipingChanged(false) }
            }
            .onAppear { rest() }
            // `onAppear` is not enough. A row you zoom into leaves the list and
            // comes back with the same id when you navigate back, so SwiftUI
            // matches it to the identity it already has and never appears it
            // again — the row returned still holding the swipe that zoomed you
            // in, and slid home in front of you.
            .onChange(of: rowId) { _, _ in rest() }
    }

    // MARK: - Layers

    /// The row is transparent at rest, so it needs a ground of its own while a
    /// swipe is open or the band shows through the text.
    @ViewBuilder private var ground: some View {
        if settling != nil {
            Rectangle()
                .fill(Color(.systemBackground))
                .padding(.vertical, -vPadding)
        }
    }

    /// What the row slides off to reveal, coloured by what releasing will do.
    /// Reads `settling`, not `offset`: keyed off a value on its way to zero,
    /// the band vanished from under a row that was still travelling.
    @ViewBuilder private var band: some View {
        if let settling {
            ZStack(alignment: settling == .left ? .trailing : .leading) {
                HStack(spacing: 0) {
                    right.tint
                        .opacity(settling == .right && armed ? 1 : 0.5)
                    left.tint
                        .opacity(settling == .left && armed ? 1 : 0.5)
                }
                if let action {
                    Image(systemName: action.glyph)
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

    private var action: RowSwipeAction? {
        switch direction {
        case .left: return left
        case .right: return right
        case nil: return nil
        }
    }

    // MARK: - Gesture

    private var gesture: some Gesture {
        DragGesture(minimumDistance: 20, coordinateSpace: .local)
            .onChanged { g in
                guard !inert else { return }
                // Decide the axis once and latch it. A scroll that drifts
                // sideways must not turn into a swipe, so once this touch is
                // vertical the swipe stands down for the rest of the gesture
                // and the list keeps scrolling.
                if axis == nil {
                    axis = RowSwipe.axis(dx: g.translation.width, dy: g.translation.height)
                }
                guard axis == .horizontal else { return }
                // The finger writes `offset` from here on.
                motion.stopReturn()
                let d = g.translation.width
                direction = abs(d) < 20 ? nil : (d < 0 ? .left : .right)
                if let direction { settling = direction }
                // Stamp the deafness clock here, not only at release. The
                // Button's tap is a sibling gesture and can be delivered in the
                // same resolution pass as this drag's end, before `body`
                // re-evaluates with a release-time `endedAt` — so the Button
                // reads a stale `justSwiped` and opens the editor on a swipe
                // that was only cancelled. Refreshing it on every move that has
                // a direction means the flag is already set, from a value the
                // content closure has seen, by the time any tap arrives.
                if direction != nil { endedAt = Date() }
                onSwipingChanged(direction != nil)
                if direction != nil { armHaptic.prepare() }
                guard action != nil else { return }
                motion.offset = RowSwipe.offset(for: d, screenWidth: screenWidth)
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
                    axis = nil
                    wasArmed = false
                }
                guard !inert, let action else { springBack(); return }
                guard RowSwipe.isArmed(g.translation.width,
                                       screenWidth: screenWidth) else {
                    springBack()
                    return
                }
                // Only an action that takes the row away rides out; see
                // `RowSwipeAction.leaves`.
                if action.leaves {
                    motion.stopReturn()
                    let out = direction == .left ? -width : width
                    withAnimation(.easeIn(duration: 0.16)) { motion.offset = out }
                } else {
                    // Stop the return before writing `offset`, like every
                    // other writer. Without it a tick already scheduled lands
                    // after this and leaves the row parked mid-swipe — which
                    // only shows up on the way back, when the row returns to
                    // the list still holding the swipe that zoomed you in.
                    motion.stopReturn()
                    motion.offset = 0
                    settling = nil
                }
                action.run()
            }
    }

    // MARK: - The return

    /// Put the row back at rest, with nothing in flight. Called when the view
    /// appears and whenever it is handed a different row.
    private func rest() {
        motion.stopReturn()
        motion.offset = 0
        direction = nil
        axis = nil
        settling = nil
        wasArmed = false
    }

    /// Deliberately not `withAnimation` — eight attempts at it read as a snap
    /// on the device. Why was never established, so don't assume it's fixed and
    /// switch back.
    private func springBack() {
        motion.returnHome { settling = nil }
    }
}

/// How far the row is drawn from rest, and the clock that walks it back to zero.
@MainActor
@Observable
final class RowSwipeMotion {
    /// The row's translation in points. Written by the finger, and by `tick` on
    /// the way home.
    var offset: CGFloat = 0

    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var from: CGFloat = 0
    @ObservationIgnored private var start: CFTimeInterval = 0
    @ObservationIgnored private var onArrival: (() -> Void)?

    /// Walks `offset` to zero over `RowSwipe.returnDuration`, then calls
    /// `onArrival` — how the caller knows the layers under the row can go.
    func returnHome(onArrival: @escaping () -> Void) {
        stopReturn()
        guard offset != 0 else { onArrival(); return }
        from = offset
        start = CACurrentMediaTime()
        self.onArrival = onArrival
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// Ends a return in progress, leaving `offset` where it reached. Must be
    /// called before anything else writes `offset`, or the two fight per frame.
    func stopReturn() {
        link?.invalidate()
        link = nil
        onArrival = nil
    }

    @objc private func tick() {
        let elapsed = CACurrentMediaTime() - start
        guard elapsed < RowSwipe.returnDuration else {
            offset = 0
            let arrived = onArrival
            stopReturn()
            arrived?()
            return
        }
        offset = RowSwipe.returnOffset(from: from, elapsed: elapsed)
    }
}
