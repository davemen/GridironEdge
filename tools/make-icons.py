#!/usr/bin/env python3
"""
Generate every icon the extension and the Safari app need.

    python3 tools/make-icons.py

Stdlib only, on purpose. This repo has no build step and no package manager, so
regenerating the icons has to work on a machine with nothing installed --
Pillow would be easier and would also be the one thing you had to install
before you could change a colour. PNG is a simple enough container to write by
hand: a header, one zlib-compressed block of filtered scanlines, and a CRC.

The ball is a vesica -- the region shared by two overlapping circles -- rather
than an ellipse, because an ellipse has rounded ends and a football has points.
Everything is drawn at 4x and box-filtered down, which is what gives the tips
and the laces clean edges at 16px instead of the staircase you get from
testing one sample per pixel.
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SS = 4  # supersampling factor

# --- palette ----------------------------------------------------------------
# Leather, lit from the upper left. The dark end is the shadowed underside; the
# light end is where the highlight falls.
LEATHER_DARK = (0x6B, 0x33, 0x17)
LEATHER_MID = (0x96, 0x4E, 0x25)
LEATHER_LITE = (0xCE, 0x7C, 0x3E)
RIM = (0xE8, 0xA0, 0x62)
LACE = (0xF7, 0xF2, 0xE8)

# Light direction, already rotated into the ball's frame so the highlight
# stays in the upper left of the icon whatever ANGLE is set to.
_LX, _LY, _LZ = -0.48, -0.56, 0.68

# The plate behind it, so the icon reads as one shape on a light or dark
# toolbar rather than as a brown blob that vanishes on a brown background.
PLATE_TOP = (0x1B, 0x24, 0x3C)
PLATE_BOT = (0x0B, 0x0F, 0x1B)
GLOW = (0x38, 0xBD, 0xF8)  # cyan, very faint, upper-left -- the brand colour


def lerp(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def over(dst, src, alpha):
    """Composite src over dst at the given alpha."""
    return tuple(int(round(dst[i] + (src[i] - dst[i]) * alpha)) for i in range(3))


def write_png(path, pixels, size):
    """pixels: flat list of (r,g,b,a) tuples, row-major."""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        for x in range(size):
            raw.extend(pixels[y * size + x])

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    path.write_bytes(png)


# --- the ball ---------------------------------------------------------------
# Half-width and half-height in unit coordinates (fraction of the icon's half
# size). Solving the two-circle intersection for these gives the circle radius
# R and the centre offset D; a point is inside the ball when it is inside both.
BALL_A = 0.64
BALL_B = 0.395
_R = (BALL_B + BALL_A * BALL_A / BALL_B) / 2.0
_D = (BALL_A * BALL_A / BALL_B - BALL_B) / 2.0
ANGLE = math.radians(-32.0)
_COS, _SIN = math.cos(ANGLE), math.sin(ANGLE)

LIGHT_U = _LX * _COS - _LY * _SIN
LIGHT_V = _LX * _SIN + _LY * _COS
LIGHT_Z = _LZ


def ball_sdf(u, v):
    """Signed distance to the ball edge in rotated space. Negative is inside."""
    d1 = math.hypot(u, v - _D) - _R   # inside the lower circle
    d2 = math.hypot(u, v + _D) - _R   # inside the upper circle
    return max(d1, d2)


def render(size, plate=True):
    # Below ~24px the full drawing turns to mush: five laces land inside four
    # pixels and read as a grey smear. Small sizes get a simplified glyph --
    # fewer, fatter stitches on a slightly larger ball -- which is what the
    # toolbar and Safari's extension list actually show.
    small = size <= 24
    stitches = (-1, 0, 1) if small else (-2, -1, 0, 1, 2)
    spine_w = 0.150 if small else 0.085
    stitch_w = 0.052 if small else 0.030
    stitch_gap = 0.62 if small else 0.46
    ball_scale = 1.12 if small else 1.0

    n = size * SS
    half = n / 2.0
    # Corner radius: the standard iOS-ish squircle proportion, close enough.
    corner = n * 0.22
    acc = [[0, 0, 0, 0] for _ in range(size * size)]

    for py in range(n):
        for px in range(n):
            # Unit coordinates, -1..1, y down.
            x = (px + 0.5 - half) / half
            y = (py + 0.5 - half) / half

            r, g, b, a = 0, 0, 0, 0.0

            if plate:
                # Rounded-square mask, in pixels so the radius is exact.
                qx = abs(px + 0.5 - half) - (half - corner)
                qy = abs(py + 0.5 - half) - (half - corner)
                if qx > 0 and qy > 0:
                    dist = math.hypot(qx, qy) - corner
                else:
                    dist = max(qx, qy) - corner
                if dist < 0.7:
                    a = max(0.0, min(1.0, 0.5 - dist))
                    col = lerp(PLATE_TOP, PLATE_BOT, (y + 1) / 2)
                    # A faint cyan bloom in the upper left keeps the brand
                    # colour present without competing with the ball.
                    bloom = max(0.0, 1.0 - math.hypot(x + 0.55, y + 0.55) / 1.3)
                    col = over(col, GLOW, 0.16 * bloom * bloom)
                    r, g, b = col
            else:
                a = 0.0

            # Rotate into the ball's frame.
            u = (x * _COS - y * _SIN) / ball_scale
            v = (x * _SIN + y * _COS) / ball_scale

            d = ball_sdf(u, v) * ball_scale
            edge = 1.2 / half  # ~1 device pixel of feather

            if d < edge:
                cov = max(0.0, min(1.0, (edge - d) / (2 * edge)))

                # Shade it as a solid lit from the upper left rather than as a
                # gradient across one axis -- a one-axis ramp creates a straight
                # crease down the middle and flattens the tips, which is what
                # the first version of this icon looked like.
                nu = u / BALL_A
                nv = v / BALL_B
                h = math.sqrt(max(0.0, 1.0 - min(1.0, nu * nu + nv * nv)))
                nlen = math.sqrt(nu * nu + nv * nv + h * h) or 1.0
                diff = (nu / nlen) * LIGHT_U + (nv / nlen) * LIGHT_V + (h / nlen) * LIGHT_Z
                diff = max(0.0, min(1.0, 0.5 + 0.5 * diff))

                if diff < 0.5:
                    col = lerp(LEATHER_DARK, LEATHER_MID, diff / 0.5)
                else:
                    col = lerp(LEATHER_MID, LEATHER_LITE, (diff - 0.5) / 0.5)

                # A rim light along the shadowed edge. Without it the dark side
                # of the ball sits on the dark plate at almost the same value
                # and the silhouette looks sliced off.
                rim = max(0.0, 1.0 - h * 2.6)
                if rim > 0 and diff < 0.62:
                    col = lerp(col, RIM, rim * rim * 0.55 * (1.0 - diff / 0.62))

                # Laces: a spine along the long axis with cross stitches. Both
                # live in rotated space, so they follow the ball's tilt.
                lu, lv = u, v
                spine_half = BALL_A * 0.40
                if abs(lu) < spine_half and abs(lv) < BALL_B * spine_w:
                    col = LACE
                else:
                    for k in stitches:
                        cu = k * spine_half * stitch_gap
                        if abs(lu - cu) < BALL_A * stitch_w and abs(lv) < BALL_B * 0.32:
                            col = LACE
                            break

                r, g, b = over((r, g, b), col, cov) if a > 0 else col
                a = max(a, cov)

            i = (py // SS) * size + (px // SS)
            cell = acc[i]
            cell[0] += r * a
            cell[1] += g * a
            cell[2] += b * a
            cell[3] += a

    # Box filter down, un-premultiplying so edge pixels keep their colour.
    out = []
    total = SS * SS
    for cell in acc:
        a = cell[3] / total
        if a <= 0.0001:
            out.append((0, 0, 0, 0))
        else:
            out.append((
                max(0, min(255, int(round(cell[0] / cell[3])))),
                max(0, min(255, int(round(cell[1] / cell[3])))),
                max(0, min(255, int(round(cell[2] / cell[3])))),
                max(0, min(255, int(round(a * 255)))),
            ))
    return out


def main():
    icons = ROOT / 'icons'
    icons.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128, 256, 512):
        write_png(icons / f'icon-{size}.png', render(size), size)
        print(f'  icons/icon-{size}.png')

    # The Safari app's own icon. The converter wires up this asset catalogue;
    # macOS wants both scales of each nominal size.
    appicon = ROOT.parent / 'GridironEdge-Safari' / 'GridironEdge' / 'GridironEdge' \
        / 'Assets.xcassets' / 'AppIcon.appiconset'
    if appicon.is_dir():
        for nominal, scale in ((16, 1), (16, 2), (32, 1), (32, 2), (128, 1),
                               (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)):
            px = nominal * scale
            name = f'icon_{nominal}x{nominal}{"@2x" if scale == 2 else ""}.png'
            write_png(appicon / name, render(px), px)
            print(f'  {name} ({px}px)')
    else:
        print(f'  (no Safari app icon set at {appicon} -- skipped)')


if __name__ == '__main__':
    main()
