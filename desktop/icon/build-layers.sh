#!/usr/bin/env bash
# Render the icon artwork as separate transparent layers for Icon Composer.
#
# The macOS 26 Liquid Glass icon format (.icon) lights each layer independently
# — a flat PNG can only be one layer, so the ring can't catch the glass on its
# own. These are the layers to import into Icon Composer (bottom to top):
#
#   layer-tile.png   the deep navy ground (full 1024 square; Icon Composer masks
#                    the squircle and adds the glass itself, so no rounding here)
#   layer-ring.png   the gold ring alone, on transparency
#   layer-dot.png    the white centre dot alone, on transparency
#
# Geometry measured from the iOS source (ios/.../AppIcon.png): dot radius 82,
# ring band r=287..369 (centreline 328, width 82), on a 1024 canvas centred at
# 512,512. Colours sampled from the same: gold #D3A45C, dot #F7F5F1, ground
# #10131A. These layers are Icon Composer inputs, not committed build outputs.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

gen="$(mktemp -t mklayers).swift"
trap 'rm -f "$gen"' EXIT
cat > "$gen" <<'SWIFT'
import AppKit
import CoreGraphics

let dir = CommandLine.arguments[1]
let canvas = 1024
let cx = CGFloat(canvas) / 2, cy = CGFloat(canvas) / 2
let cs = CGColorSpaceCreateDeviceRGB()

func newCtx() -> CGContext {
  let ctx = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8,
                      bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))
  return ctx
}

func save(_ ctx: CGContext, _ name: String) {
  let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
  try! png.write(to: URL(fileURLWithPath: "\(dir)/\(name)"))
  print("  \(name)")
}

// Tile: the ground, full square. Icon Composer rounds and glasses it.
let tile = newCtx()
tile.setFillColor(NSColor(red: 0x10/255.0, green: 0x13/255.0, blue: 0x1A/255.0, alpha: 1).cgColor)
tile.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))
save(tile, "layer-tile.png")

// Ring: a gold stroked circle, centreline r=328, width=82.
let ring = newCtx()
ring.setStrokeColor(NSColor(red: 0xD3/255.0, green: 0xA4/255.0, blue: 0x5C/255.0, alpha: 1).cgColor)
ring.setLineWidth(82)
ring.addEllipse(in: CGRect(x: cx - 328, y: cy - 328, width: 656, height: 656))
ring.strokePath()
save(ring, "layer-ring.png")

// Dot: the white centre, r=82.
let dot = newCtx()
dot.setFillColor(NSColor(red: 0xF7/255.0, green: 0xF5/255.0, blue: 0xF1/255.0, alpha: 1).cgColor)
dot.addArc(center: CGPoint(x: cx, y: cy), radius: 82, startAngle: 0, endAngle: .pi * 2, clockwise: false)
dot.fillPath()
save(dot, "layer-dot.png")
SWIFT

echo "→ rendering layers into $here"
swift "$gen" "$here"
echo "done. Import layer-tile / layer-ring / layer-dot into Icon Composer."
