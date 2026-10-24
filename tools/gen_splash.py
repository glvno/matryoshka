#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 morgulbrut
"""The boot splash art (firmware/src/splash.c) -> firmware/src/splash_art.h.

  tools/gen_splash.py [OUT]

LOGO  web/public/brand/matryoshka.png, cropped to its ink, box-filtered to LOGO_H px high over the LCD background
WORD  web/public/brand/wordmark.svg (only M / L / Q / Z, absolute), rasterised 4 x 4 supersampled to WORD_W px,
      in the wordmark's dark-scheme colours

Both are composited over BG = the restyle's C_BG (ui.c, night), so their edges blend into the screen around them.
Each image is reduced to at most 16 colours (median cut in RGB565; entry 0 is the background exactly) and run-length
coded: one byte per run, colour index in the high nibble, run - 1 in the low nibble; a byte with run nibble 15 is
followed by one more byte that adds 0..255 to the run (runs of 16..271). Runs carry across rows.
Standard library only; rerun after changing the art.
"""
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "firmware" / "src" / "splash_art.h"
BRAND = ROOT / "web" / "public" / "brand"
LOGO_H = 140
WORD_W = 216
INK = (0xFF, 0xF7, 0xE8)              # wordmark.svg, prefers-color-scheme: dark
ACCENT = (0x79, 0xC7, 0xC1)
NCOL = 16
BG565 = 0x10E4                        # C_BG in firmware/src/ui.c: keep in step


def png_rgba(path):
    """8-bit RGBA / RGB PNG, not interlaced -> (w, h, rows of (r, g, b, a))"""
    d = path.read_bytes()
    assert d[:8] == b"\x89PNG\r\n\x1a\n"
    at, idat = 8, b""
    while at < len(d):
        n, t = struct.unpack(">I4s", d[at:at + 8])
        body = d[at + 8:at + 8 + n]
        if t == b"IHDR":
            w, h, depth, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and ctype in (2, 6) and not inter, path
        elif t == b"IDAT":
            idat += body
        at += 12 + n
    bpp = 4 if ctype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * bpp
    prev = bytearray(stride)
    rows = []
    for y in range(h):
        f = raw[y * (stride + 1)]
        cur = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = cur[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                cur[i] = (cur[i] + a) & 255
            elif f == 2:
                cur[i] = (cur[i] + b) & 255
            elif f == 3:
                cur[i] = (cur[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(cur if bpp == 4 else bytearray(b"".join(bytes(cur[i:i + 3]) + b"\xff" for i in range(0, stride, 3))))
        prev = cur
    return w, h, rows


def logo_image():
    """the logo over BG, cropped to its ink and area-averaged to LOGO_H px high -> list of (r, g, b) floats"""
    w, h, rows = png_rgba(BRAND / "matryoshka.png")
    ink = [(x, y) for y in range(0, h) for x in range(0, w) if rows[y][4 * x + 3] > 8]
    x0, x1 = min(p[0] for p in ink), max(p[0] for p in ink) + 1
    y0, y1 = min(p[1] for p in ink), max(p[1] for p in ink) + 1
    oh = LOGO_H
    ow = round((x1 - x0) * oh / (y1 - y0))
    acc = [[0.0, 0.0, 0.0, 0, 0.0] for _ in range(ow * oh)]   # premultiplied r g b, samples, coverage
    for y in range(y0, y1):
        row, dy = rows[y], (y - y0) * oh // (y1 - y0)
        for x in range(x0, x1):
            a = row[4 * x + 3]
            cell = acc[dy * ow + (x - x0) * ow // (x1 - x0)]
            if a:
                k = a / 255.0
                cell[0] += row[4 * x] * k
                cell[1] += row[4 * x + 1] * k
                cell[2] += row[4 * x + 2] * k
                cell[4] += k
            cell[3] += 1
    bg = unpack(BG565)
    return ow, oh, [tuple((c[ch] + bg[ch] * (c[3] - c[4])) / c[3] for ch in range(3)) for c in acc]


def word_paths():
    """(colour, [polygons]) per path of the wordmark, in viewBox units"""
    svg = (BRAND / "wordmark.svg").read_text()
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
    gx, gy = [float(v) for v in re.search(r'<g[^>]*transform="translate\(([^)]+)\)"', svg).group(1).split()]
    out = []
    for m in re.finditer(r'<path class="(\w+)[^"]*" transform="translate\(([^)]+)\) scale\(([^)]+)\)" d="([^"]+)"', svg):
        tx, ty = [float(v) for v in m.group(2).split()]
        sx, sy = [float(v) for v in m.group(3).split()]
        def pt(x, y):
            return (gx + tx + sx * x, gy + ty + sy * y)
        polys, poly, cur = [], [], (0.0, 0.0)
        toks = re.findall(r"[MLQZ]|-?\d*\.?\d+(?:e-?\d+)?", m.group(4))
        i = 0
        while i < len(toks):
            c = toks[i]
            i += 1
            if c == "M":
                if poly:
                    polys.append(poly)
                cur = (float(toks[i]), float(toks[i + 1]))
                i += 2
                poly = [pt(*cur)]
            elif c == "L":
                cur = (float(toks[i]), float(toks[i + 1]))
                i += 2
                poly.append(pt(*cur))
            elif c == "Q":
                c1 = (float(toks[i]), float(toks[i + 1]))
                end = (float(toks[i + 2]), float(toks[i + 3]))
                i += 4
                for k in range(1, 9):
                    t = k / 8
                    poly.append(pt((1 - t) ** 2 * cur[0] + 2 * (1 - t) * t * c1[0] + t * t * end[0],
                                   (1 - t) ** 2 * cur[1] + 2 * (1 - t) * t * c1[1] + t * t * end[1]))
                cur = end
            elif c == "Z":
                if poly:
                    polys.append(poly)
                poly = []
            else:
                raise ValueError(f"wordmark.svg: unexpected token {c}")
        if poly:
            polys.append(poly)
        out.append((ACCENT if m.group(1) == "accent" else INK, polys))
    assert out, "no paths in wordmark.svg"
    return vb, out


def word_image():
    """the wordmark, nonzero fill, 4 x 4 samples per pixel, cropped to its ink -> list of (r, g, b) floats"""
    vb, paths = word_paths()
    ss = 4
    xs = [p[0] for _, ps in paths for poly in ps for p in poly]
    ys = [p[1] for _, ps in paths for poly in ps for p in poly]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    k = WORD_W / (x1 - x0)
    w, h = WORD_W, int((y1 - y0) * k + 0.999)
    img = [list(unpack(BG565)) for _ in range(w * h)]
    for col, polys in paths:
        edges = []
        for poly in polys:
            for a, b in zip(poly, poly[1:] + poly[:1]):
                ax, ay = (a[0] - x0) * k * ss, (a[1] - y0) * k * ss
                bx, by = (b[0] - x0) * k * ss, (b[1] - y0) * k * ss
                if ay != by:
                    edges.append((ax, ay, bx, by, 1 if by > ay else -1))
        cover = [0] * (w * h)
        for sy in range(h * ss):
            yc = sy + 0.5
            xings = []
            for ax, ay, bx, by, d in edges:
                if (ay <= yc < by) or (by <= yc < ay):
                    xings.append((ax + (yc - ay) * (bx - ax) / (by - ay), d))
            xings.sort()
            wind = 0
            for j in range(len(xings) - 1):
                wind += xings[j][1]
                if wind:
                    for sx in range(max(0, int(xings[j][0] + 0.5)), min(w * ss, int(xings[j + 1][0] + 0.5))):
                        cover[(sy // ss) * w + sx // ss] += 1
        for i, c in enumerate(cover):
            if c:
                f = min(c, ss * ss) / (ss * ss)
                img[i] = [img[i][j] * (1 - f) + col[j] * f for j in range(3)]
    return w, h, [tuple(p) for p in img]


def rgb565(c):
    r, g, b = (max(0, min(255, int(v + 0.5))) for v in c)
    return (r >> 3) << 11 | (g >> 2) << 5 | b >> 3


def unpack(v):
    return ((v >> 11) * 255 / 31, (v >> 5 & 63) * 255 / 63, (v & 31) * 255 / 31)


def quantize(px):
    """median cut to NCOL colours, entry 0 = BG (the background) -> (palette, indices)"""
    bg = unpack(BG565)
    near = [sum((p[ch] - bg[ch]) ** 2 for ch in range(3)) < 64 for p in px]
    black = [i for i, p in enumerate(px) if near[i]]
    rest = [i for i, p in enumerate(px) if not near[i]]
    boxes = [rest]
    while len(boxes) < NCOL - 1:
        best = None
        for bi, box in enumerate(boxes):
            if len(box) < 2:
                continue
            for ch in range(3):
                vals = [px[i][ch] for i in box]
                spread = (max(vals) - min(vals)) * len(box) ** 0.5
                if best is None or spread > best[0]:
                    best = (spread, bi, ch)
        if best is None or best[0] == 0:
            break
        _, bi, ch = best
        box = sorted(boxes.pop(bi), key=lambda i: px[i][ch])
        boxes += [box[:len(box) // 2], box[len(box) // 2:]]
    pal = [BG565]
    idx = [0] * len(px)
    for box in boxes:
        avg = tuple(sum(px[i][ch] for i in box) / len(box) for ch in range(3))
        pal.append(rgb565(avg))
    cols = [unpack(v) for v in pal]
    for i in rest:                      # nearest palette colour (not just the box): fewer stray pixels
        p = px[i]
        idx[i] = min(range(1, len(pal)), key=lambda j: sum((p[ch] - cols[j][ch]) ** 2 for ch in range(3)))
    for i in black:
        idx[i] = 0
    return pal, idx


def rle(idx):
    out, i = bytearray(), 0
    while i < len(idx):
        j = i
        while j < len(idx) and idx[j] == idx[i] and j - i < 271:
            j += 1
        n = j - i
        if n <= 15:
            out.append(idx[i] << 4 | (n - 1))
        else:
            out += bytes((idx[i] << 4 | 15, n - 16))
        i = j
    return out


def emit(name, w, h, px):
    assert w <= 240, "splash.c decodes a row into lcd_line (240 px)"
    pal, idx = quantize(px)
    data = rle(idx)
    lines = [f"static const uint16_t {name}_PAL[{len(pal)}] = {{"]
    lines.append("    " + ", ".join(f"0x{v:04X}u" for v in pal) + ",")
    lines.append("};")
    lines.append(f"static const uint8_t {name}_RLE[{len(data)}] = {{")
    for i in range(0, len(data), 16):
        lines.append("    " + ", ".join(f"0x{b:02X}" for b in data[i:i + 16]) + ",")
    lines.append("};")
    lines.append(f"static const splash_art_t {name} = {{ {w}, {h}, {name}_PAL, {name}_RLE, sizeof {name}_RLE }};")
    print(f"{name}: {w} x {h}, {len(pal)} colours, {len(data)} B RLE + {2 * len(pal)} B palette "
          f"(4 bpp packed would be {(w * h + 1) // 2} B)", file=sys.stderr)
    return "\n".join(lines)


text = "\n".join([
    "/* SPDX-License-Identifier: GPL-3.0-only */",
    "/* Generated by tools/gen_splash.py from web/public/brand. Do not edit. */",
    "typedef struct { uint16_t w, h; const uint16_t *pal; const uint8_t *rle; uint32_t len; } splash_art_t;",
    emit("SPLASH_LOGO", *logo_image()),
    emit("SPLASH_WORD", *word_image()),
    "",
])
OUT.write_text(text)
print(f"wrote {OUT}", file=sys.stderr)
