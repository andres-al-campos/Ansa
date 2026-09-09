#!/usr/bin/env bash
# Regenerate the macOS icon from the iOS app icon.
#
# The iOS icon is a full-bleed square — the system rounds the corners at display
# time. macOS does not: an app's .icns has to carry its own squircle, its own
# padding to the standard grid, and (for a dark icon like this one) a bit of
# edge treatment so it doesn't melt into a dark wallpaper. This script bakes all
# of that in:
#
#   1. render master-1024.png from the iOS PNG — squircle mask, standard padding,
#      a drop shadow, a top-down glass sheen, and a hairline light rim;
#   2. downscale it into an .iconset at every size macOS asks for;
#   3. pack the .iconset into Ansa.icns (the app/dock icon);
#   4. copy the master to dock.png for the un-packaged `npm start` dock icon,
#      which wants a raster PNG rather than an icon set.
#
# Committed outputs: Ansa.icns and dock.png. master-1024.png and Ansa.iconset/
# are regenerable intermediates and are gitignored. Run from anywhere.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../ios/Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
master="$here/master-1024.png"
iconset="$here/Ansa.iconset"
icns="$here/Ansa.icns"
dock="$here/dock.png"

[ -f "$src" ] || { echo "Source icon not found: $src
Fix: this script derives the Mac icon from the iOS app icon; restore ios/Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png or point \$src at the current one." >&2; exit 1; }

gen="$(mktemp -t mkicon).swift"
trap 'rm -f "$gen"' EXIT
cat > "$gen" <<'SWIFT'
import AppKit
import CoreGraphics

let src = CommandLine.arguments[1]
let out = CommandLine.arguments[2]
let canvas = 1024
let content = 824
let radius = CGFloat(content) * 0.2237

guard let img = NSImage(contentsOfFile: src),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else { fatalError("load failed") }

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: canvas, height: canvas,
                          bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
else { fatalError("ctx failed") }

ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))
let off = CGFloat(canvas - content) / 2
let rect = CGRect(x: off, y: off, width: CGFloat(content), height: CGFloat(content))
let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

// A soft drop shadow so the tile lifts off a dark desktop, the way native
// icons do. Drawn by filling the squircle once with shadow enabled, under the
// artwork.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -8),
              blur: 24,
              color: NSColor(white: 0, alpha: 0.45).cgColor)
ctx.addPath(path)
ctx.setFillColor(NSColor(white: 0.1, alpha: 1).cgColor)
ctx.fillPath()
ctx.restoreGState()

// The artwork, clipped to the squircle.
ctx.saveGState()
ctx.addPath(path)
ctx.clip()
ctx.draw(cg, in: rect)

// A gentle top-left sheen inside the tile, aligned with the light source below.
if let grad = CGGradient(colorsSpace: cs,
    colors: [NSColor(white: 1, alpha: 0.14).cgColor,
             NSColor(white: 1, alpha: 0.0).cgColor] as CFArray,
    locations: [0, 1]) {
  ctx.drawLinearGradient(grad,
    start: CGPoint(x: rect.minX, y: rect.maxY),
    end: CGPoint(x: rect.midX, y: rect.midY),
    options: [])
}
ctx.restoreGState()

// The rim, in two layers. A base stroke keeps the whole edge lit all the way
// around — like the even hairline Obsidian and the other dark icons carry —
// then a directional highlight on top brightens the top-left and bottom-right
// corners where the light catches. The base alone reads as generated; the
// corner catches alone leave the other edges dim. Together they read as a real
// tile with a light source.
ctx.saveGState()
ctx.addPath(path)
ctx.setLineWidth(5)
ctx.replacePathWithStrokedPath()
ctx.clip()
// Base: an even rim around the whole edge.
ctx.setFillColor(NSColor(white: 1, alpha: 0.35).cgColor)
ctx.fill(rect)
// Top-left corner catch.
if let grad = CGGradient(colorsSpace: cs,
    colors: [NSColor(white: 1, alpha: 0.95).cgColor,
             NSColor(white: 1, alpha: 0.0).cgColor] as CFArray,
    locations: [0, 0.5]) {
  ctx.drawLinearGradient(grad,
    start: CGPoint(x: rect.minX, y: rect.maxY),
    end: CGPoint(x: rect.maxX, y: rect.minY),
    options: [])
}
// Bottom-right corner catch.
if let grad = CGGradient(colorsSpace: cs,
    colors: [NSColor(white: 1, alpha: 0.0).cgColor,
             NSColor(white: 1, alpha: 0.8).cgColor] as CFArray,
    locations: [0.5, 1]) {
  ctx.drawLinearGradient(grad,
    start: CGPoint(x: rect.minX, y: rect.maxY),
    end: CGPoint(x: rect.maxX, y: rect.minY),
    options: [])
}
ctx.restoreGState()

guard let result = ctx.makeImage() else { fatalError("render failed") }
let bmp = NSBitmapImageRep(cgImage: result)
guard let png = bmp.representation(using: .png, properties: [:]) else { fatalError("encode failed") }
try! png.write(to: URL(fileURLWithPath: out))
print("OK \(out)")
SWIFT

echo "→ rendering master ($src → master-1024.png)"
swift "$gen" "$src" "$master"

echo "→ building iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
# The size/name grid macOS expects inside a .iconset (points @1x and @2x).
for spec in \
  "16 icon_16x16" "32 icon_16x16@2x" \
  "32 icon_32x32" "64 icon_32x32@2x" \
  "128 icon_128x128" "256 icon_128x128@2x" \
  "256 icon_256x256" "512 icon_256x256@2x" \
  "512 icon_512x512" "1024 icon_512x512@2x"; do
  set -- $spec
  sips -z "$1" "$1" "$master" --out "$iconset/$2.png" >/dev/null
done

echo "→ packing $icns"
iconutil -c icns "$iconset" -o "$icns"

echo "→ copying dock.png"
cp "$master" "$dock"

echo "done: $(basename "$icns"), $(basename "$dock")"
