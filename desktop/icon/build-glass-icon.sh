#!/usr/bin/env bash
# Build the macOS 26 Liquid Glass icon (Ansa.icon) from layer PNGs, headlessly.
#
# The .icon format is a folder — an icon.json manifest plus an Assets/ directory
# of layer images — that macOS renders with the live Liquid Glass shader,
# lighting each layer on its own. Icon Composer is the GUI authoring tool, but
# the format is plain JSON and Apple ships two CLIs inside it, so none of this
# needs the GUI:
#
#   ictool   renders a .icon to a PNG with the real glass shader — the preview
#            below is the actual system rendering, not an approximation;
#   actool   compiles the .icon into Assets.car (+ a fallback .icns for pre-26
#            macOS) for the app bundle. electron-builder runs this itself when
#            mac.icon points at the .icon, so this script stops at authoring +
#            preview; packaging is `npm run dist`.
#
# Layers come from build-layers.sh (tile / ring / dot as transparent PNGs).
# The manifest schema (group/layer fields, the srgb: colour format) matches
# Icon Composer's own output. Ansa.icon is the committed output; the preview PNG
# is a throwaway. Run from anywhere.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
icon="$here/Ansa.icon"
assets="$icon/Assets"
ictool="/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"

# Ensure the layer PNGs exist.
if [ ! -f "$here/layer-ring.png" ]; then
  echo "→ layers missing, running build-layers.sh"
  "$here/build-layers.sh"
fi

echo "→ assembling $icon"
rm -rf "$icon"
mkdir -p "$assets"
cp "$here/layer-tile.png" "$assets/tile.png"
cp "$here/layer-ring.png" "$assets/ring.png"
cp "$here/layer-dot.png"  "$assets/dot.png"

# The manifest. Glass is colourless by design — a glassed layer takes the
# system's material colour and the user's tint, never the artwork's own. So the
# ring and dot are NOT glassed: they keep gold/white from their PNGs. The group
# still carries specular + shadow, which gives the whole tile the glass sheen and
# the squircle its lit rim. `fill` is the deep-navy ground behind the layers.
# Colours are srgb:R,G,B,A, 0–1 — #10131A ground, gold/white ride in the PNGs.
cat > "$icon/icon.json" <<'JSON'
{
  "fill" : { "solid" : "srgb:0.06275,0.07451,0.10196,1.00000" },
  "supported-platforms" : { "squares" : "shared" },
  "groups" : [
    {
      "shadow" : { "kind" : "neutral", "opacity" : 0.5 },
      "specular" : true,
      "layers" : [
        {
          "image-name" : "ring.png",
          "name" : "Ring",
          "glass" : false
        },
        {
          "image-name" : "dot.png",
          "name" : "Dot",
          "glass" : false
        }
      ]
    }
  ]
}
JSON

echo "→ manifest written"

if [ -x "$ictool" ]; then
  echo "→ rendering glass preview (Ansa-glass-preview.png)"
  "$ictool" "$icon" --export-image \
    --output-file "$here/Ansa-glass-preview.png" \
    --platform macOS --rendition Default \
    --width 1024 --height 1024 --scale 1 \
    && echo "  preview: $here/Ansa-glass-preview.png" \
    || echo "  (preview render failed; the bundle is still valid for actool)"
else
  echo "→ ictool not found; skipping preview. Bundle is still valid."
fi

echo "done: $icon"
