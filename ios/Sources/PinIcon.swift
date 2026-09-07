import SwiftUI

/// The web's pin, drawn here so the same action looks the same on both screens.
///
/// Standing up when tapping will pin, lying over at 45° when tapping will
/// unpin. Not `pin.slash`: a slash negates a *state*, so on a button that says
/// what the tap does it reads backwards.
///
/// The path is `PinIcon` from `src/Outliner.tsx`, on the same 14×14 grid. A
/// `Shape` rather than an asset so the two definitions stay comparable.
struct PinShape: Shape {
    /// Whether the pin lies over, which is what "tapping unpins" looks like.
    var over = false

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

        // Rotating about the centre keeps it inside the same box at either
        // state, so the two never shift the layout around them.
        let t = CGAffineTransform(scaleX: s, y: s)
            .concatenating(
                over
                    ? CGAffineTransform(translationX: -7 * s, y: -7 * s)
                        .concatenating(CGAffineTransform(rotationAngle: .pi / 4))
                        .concatenating(CGAffineTransform(translationX: 7 * s, y: 7 * s))
                    : .identity)

        return p.applying(t)
    }
}

/// The pin as an image, stroked the way the web strokes it.
struct PinIcon: View {
    /// True when tapping would unpin — so the pin is drawn lying over.
    var over = false
    var size: CGFloat = 16

    var body: some View {
        PinShape(over: over)
            .stroke(style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }
}

extension PinIcon {
    /// The same pin as a bitmap. A `Menu`'s rows are drawn by UIKit, which
    /// takes a `UIImage` and silently shows nothing for a SwiftUI view.
    /// Template-rendered so the menu tints it like an SF Symbol beside it.
    static func image(over: Bool, size: CGFloat = 17) -> UIImage {
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        let image = UIGraphicsImageRenderer(size: bounds.size).image { ctx in
            // Inset by half the stroke, so neither end of a round cap is
            // clipped by the edge of the bitmap.
            let inset = bounds.insetBy(dx: 0.7, dy: 0.7)
            let path = PinShape(over: over).path(in: inset)
            let cg = UIBezierPath(cgPath: path.cgPath)
            cg.apply(CGAffineTransform(translationX: 0.7, y: 0.7))
            cg.lineWidth = 1.4
            cg.lineCapStyle = .round
            cg.lineJoinStyle = .round
            UIColor.label.setStroke()
            cg.stroke()
            _ = ctx
        }
        return image.withRenderingMode(.alwaysTemplate)
    }
}
