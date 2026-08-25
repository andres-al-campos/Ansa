#!/usr/bin/env python3
"""Draw the Ansa app icon and write it into the asset catalog.

The mark is the expanded-parent bullet: a cream dot inside a brass ring, the
one shape Ansa uses that no other outliner does. Every dimension is a fraction
of the tile, expressed in dot radii the way the design was decided — gap and
stroke are both multiples of the dot's radius, so the proportions survive any
size.

The ring carries a soft bloom. It peaks *at* the ring's radius and falls off
both inward and outward, which reads as the ring emitting light rather than the
dot being watched — a glow centred on the dot turns the mark into an eye.

Run with no arguments to regenerate Sources/Assets.xcassets. Requires rsvg or
qlmanage for rasterizing; both ship differently, so we shell out to whichever
is present.
"""
import os, shutil, subprocess, sys

GROUND = '#10131a'   # the app's --ground
RING   = '#D3A45C'   # the app's dark --brass, unmodified (DropPalette.swift)
DOT    = '#F7F5F1'

GAP    = 2.5   # dot-edge to ring-inner, in dot radii
THICK  = 1.0   # ring stroke width, in dot radii
TARGET = .315  # ring's outer edge as a fraction of the tile
BLOOM  = 0.8
SPREAD = 2.6   # bloom reach, in stroke widths. Past ~4 the glow reaches the
               # tile edge and the ground stops reading as dark.

# Solve for the dot so the ring's outer edge lands on TARGET:
#   outer = r(1 + GAP) + THICK*r
DOT_R = TARGET / (1 + GAP + THICK)


def svg(size):
    c = size / 2
    r = size * DOT_R
    inner = r + GAP * r
    sw = THICK * r
    ring_c = inner + sw / 2          # stroke is centred, so this is mid-radius

    sp = sw * SPREAD
    outer = ring_c + sp
    peak = ring_c / outer
    hw = sp / outer
    s0 = max(0.0, peak - hw)
    s1 = max(0.0, peak - hw * .45)
    s2 = min(1.0, peak + hw * .45)
    s3 = min(1.0, peak + hw)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">'
        f'<defs><radialGradient id="glow">'
        f'<stop offset="{s0:.4f}" stop-color="{RING}" stop-opacity="0"/>'
        f'<stop offset="{s1:.4f}" stop-color="{RING}" stop-opacity="{.30*BLOOM:.4f}"/>'
        f'<stop offset="{peak:.4f}" stop-color="{RING}" stop-opacity="{.58*BLOOM:.4f}"/>'
        f'<stop offset="{s2:.4f}" stop-color="{RING}" stop-opacity="{.30*BLOOM:.4f}"/>'
        f'<stop offset="{s3:.4f}" stop-color="{RING}" stop-opacity="0"/>'
        f'</radialGradient></defs>'
        # No rounded corners: iOS masks the icon itself, and baking a radius in
        # leaves a dark seam outside the system's mask.
        f'<rect width="{size}" height="{size}" fill="{GROUND}"/>'
        f'<circle cx="{c}" cy="{c}" r="{outer:.3f}" fill="url(#glow)"/>'
        f'<circle cx="{c}" cy="{c}" r="{ring_c:.3f}" fill="none" '
        f'stroke="{RING}" stroke-width="{sw:.3f}"/>'
        f'<circle cx="{c}" cy="{c}" r="{r:.3f}" fill="{DOT}"/>'
        f'</svg>'
    )


def rasterize(svg_path, png_path, size):
    """rsvg-convert if available, else qlmanage. qlmanage renders at the SVG's
    natural size and pads to a square, so the SVG is authored at 1024 already."""
    if shutil.which('rsvg-convert'):
        subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                        '-o', png_path, svg_path], check=True)
        return
    out = os.path.dirname(png_path)
    subprocess.run(['qlmanage', '-t', '-s', str(size), '-o', out, svg_path],
                   check=True, capture_output=True)
    made = os.path.join(out, os.path.basename(svg_path) + '.png')
    if not os.path.exists(made):
        sys.exit('Could not rasterize the icon. Install librsvg '
                 '(`brew install librsvg`) and run this again.')
    os.replace(made, png_path)


def flatten(png_path):
    """App icons must be opaque — an alpha channel fails App Store validation.

    Done by hand rather than with sips (which only composites onto white) or a
    JPEG round trip (which bands the bloom's gradient). The render is already
    opaque over the ground rect, so this drops the alpha channel rather than
    compositing: unfilter each scanline, keep RGB, re-filter as type 0.
    """
    import struct, zlib

    raw = open(png_path, 'rb').read()
    pos, chunks = 8, []
    while pos < len(raw):
        ln = struct.unpack('>I', raw[pos:pos + 4])[0]
        kind = raw[pos + 4:pos + 8]
        chunks.append((kind, raw[pos + 8:pos + 8 + ln]))
        pos += 12 + ln

    hdr = dict(chunks)[b'IHDR']
    w, h, depth, ctype = struct.unpack('>IIBB', hdr[:10])
    if ctype != 6:
        return                      # already opaque
    if depth != 8:
        sys.exit('Expected an 8-bit render; got %d-bit.' % depth)

    data = zlib.decompress(b''.join(c for k, c in chunks if k == b'IDAT'))
    stride = w * 4
    out, prev = bytearray(), bytearray(stride)
    for y in range(h):
        i = y * (stride + 1)
        ft, line = data[i], bytearray(data[i + 1:i + 1 + stride])
        for x in range(stride):                     # undo the row filter
            a = line[x - 4] if x >= 4 else 0
            b = prev[x]
            c = prev[x - 4] if x >= 4 else 0
            if ft == 1:   line[x] = (line[x] + a) & 255
            elif ft == 2: line[x] = (line[x] + b) & 255
            elif ft == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif ft == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        prev = line
        out.append(0)                               # filter type: none
        for x in range(0, stride, 4):
            out += line[x:x + 3]                    # RGB, alpha dropped

    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body
                + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff))

    with open(png_path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(bytes(out), 9)))
        f.write(chunk(b'IEND', b''))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    dest = os.path.join(root, 'Sources', 'Assets.xcassets',
                        'AppIcon.appiconset')
    os.makedirs(dest, exist_ok=True)
    src = os.path.join(dest, 'AppIcon.svg')
    with open(src, 'w') as f:
        f.write(svg(1024))
    png = os.path.join(dest, 'AppIcon.png')
    rasterize(src, png, 1024)
    flatten(png)
    os.remove(src)
    print(f'Wrote {dest}/AppIcon.png  (dot r = {DOT_R:.4f} of the tile)')


if __name__ == '__main__':
    main()
