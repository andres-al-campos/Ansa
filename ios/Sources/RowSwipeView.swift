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

    /// Owns `offset` and the clock that returns it to zero. A class, not
    /// `@State` on the view: a display link's tick closure captures whatever it
    /// was built with, and `@State` accessors belong to one body evaluation —
    /// so the first tick's write re-rendered the view and left the closure
    /// writing to a version of the row that no longer existed. It fired once
    /// and stopped. A reference the view holds across evaluations is still
    /// there on the second frame.
    @State private var motion = RowSwipeMotion()
    /// The row's own width, so a committing delete knows how far to carry it.
    @State private var width: CGFloat = 0
    /// The live direction of the finger, nil before the gesture commits to one.
    @State private var direction: Direction?
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
            .onAppear {
                motion.offset = 0
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
                // The finger is back. It writes `offset` from here on, so a
                // return still ticking would be fighting it for the same value.
                motion.stopReturn()
                let d = g.translation.width
                direction = abs(d) < 20 ? nil : (d < 0 ? .left : .right)
                if let direction { settling = direction }
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
                    motion.stopReturn()
                    withAnimation(.easeIn(duration: 0.16)) { motion.offset = -width }
                } else {
                    motion.offset = 0
                    settling = nil
                }
                action.run()
            }
    }

    // MARK: - The return

    /// Eases the row home from a pull that did not reach the threshold, by
    /// writing `offset` once per frame — the same thing the finger does.
    ///
    /// Not `withAnimation`. Eight attempts at it all read as a snap on the
    /// device. Why is not established: the probes that were supposed to settle
    /// it ran on the simulator, which renders this app at about 3fps, so a
    /// 0.22s return gets one intermediate frame there however it is driven —
    /// a working animation and a jump look identical. Do not read the switch
    /// as proof `withAnimation` was broken.
    ///
    /// What is known is that the finger path moves this row correctly, writing
    /// `offset` directly on every `onChanged`. This borrows that: the same
    /// write, driven by a clock instead of a touch.
    ///
    /// Clearing `settling` on arrival comes with it. The old code guessed with
    /// an `asyncAfter` timed to an animation it could not observe; a driver
    /// knows when it is finished.
    private func springBack() {
        motion.returnHome { settling = nil }
    }
}

/// How far the row is drawn from rest, and the clock that walks it back to zero.
///
/// A class because the return is driven a frame at a time by a `CADisplayLink`,
/// and a link's tick has to reach state that outlives one body evaluation.
@MainActor
@Observable
final class RowSwipeMotion {
    /// The row's translation in points. Written directly by the finger, and by
    /// this class's own tick on the way home.
    var offset: CGFloat = 0

    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var from: CGFloat = 0
    @ObservationIgnored private var start: CFTimeInterval = 0
    @ObservationIgnored private var onArrival: (() -> Void)?

    /// Walks `offset` to zero over `RowSwipe.returnDuration`, then calls
    /// `onArrival` — which is how the caller knows the layers under the row can
    /// go. Replaces an `asyncAfter` that was timing an animation it could not
    /// observe; a driver knows when it is finished.
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

    /// Ends a return in progress, leaving `offset` wherever it had reached.
    /// Called before starting another and whenever a finger takes the row back,
    /// so the two never write `offset` in the same frame.
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
