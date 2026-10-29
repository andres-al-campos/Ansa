import SwiftUI

/// The web's pin, the mark beside a pinned project's name. The ⋯ menu and the
/// unpin swipe use the system's `pin` and `pin.slash` instead, so their glyphs
/// match the SF Symbols beside them in size. A lying-over version of this one
/// stood for Unpin until the owner read it as a plain pin.
///
/// The path is `PinIcon` from `src/Outliner.tsx`, on the same 14×14 grid. A
/// `Shape` rather than an asset so the two definitions stay comparable.
struct PinShape: Shape {
    func path(in rect: CGRect) -> Path {
        // The web's viewBox, scaled to whatever this is asked to fill.
        let s = min(rect.width, rect.height) / 14
        var p = Path()

        // M7 8.5V12 — the spike.
        p.move(to: CGPoint(x: 7, y: 8.5))
        p.addLine(to: CGPoint(x: 7, y: 12))

        // M4.2 2h5.6l-.8 3.2 1.4 1.6H3.6l1.4-1.6L4.2 2z — the head.
        p.move(to: CGPoint(x: 4.2, y: 2))
        p.addLine(to: CGPoint(x: 9.8, y: 2))
        p.addLine(to: CGPoint(x: 9.0, y: 5.2))
        p.addLine(to: CGPoint(x: 10.4, y: 6.8))
        p.addLine(to: CGPoint(x: 3.6, y: 6.8))
        p.addLine(to: CGPoint(x: 5.0, y: 5.2))
        p.closeSubpath()

        return p.applying(CGAffineTransform(scaleX: s, y: s))
    }
}

/// The pin as an image, stroked the way the web strokes it.
struct PinIcon: View {
    var size: CGFloat = 16

    var body: some View {
        PinShape()
            .stroke(style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }
}
