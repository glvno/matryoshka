#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""The LCD's type: Barlow Condensed SemiBold (web/public/fonts, OFL) as 4-bit anti-aliased bitmaps -> firmware/src/font_bc.h.

Stdlib only: a small TrueType reader (cmap 4, loca, glyf with simple and composite glyphs, hmtx) and the same nonzero
scanline fill as gen_splash.py, 4 x 4 samples per pixel. Each size keeps a line box (ascent + descent in pixels) so a
row of text is one block of `h` rows; a glyph stores its ink columns (w), where they start (x) and its advance, its ink
rows only (from the first, y, to the last: the line box's other rows are empty, which keeps the brand type about 17 KB
smaller in the flash), and 4-bit coverage per pixel (two per byte, rows padded to a byte). Each size's glyph list ends
with an entry no character maps to, whose offset ends the last glyph's rows. The firmware blends coverage between the
text's ink and paper colours (font_bc.c); the emulator's text reader (tools/emu/src/font.rs) parses this file to find
strings.

Run from the repository root:  python3 tools/gen_font.py
"""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TTF = ROOT / "web/public/fonts/BarlowCondensed-SemiBold.ttf"
OUT = ROOT / "firmware/src/font_bc.h"
AREA_BIN = ROOT / "web/public/firmware/matryoshka-font.bin"
ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
CAPS = "".join(chr(c) for c in range(0x20, 0x60))      # space .. _: capitals, digits, signs (a lowercase letter draws as its capital)
# name, pixels per em, the characters it carries (others draw as nothing). The device page's sizes (FONT_F .. FONT_T) are
# the owner's mock's (pages_ui.c's look constants check them against the _PX defines written here)
SIZES = [
    ("FONT_S", 13, ASCII),     # small captions, the menu's lines, the lists' notes
    ("FONT_M", 17, ASCII),     # the lists' names, the menu
    ("FONT_L", 24, ASCII),     # the menu's title, the sandbox card
    ("FONT_F", 14, CAPS + "bcdkmopstz"),   # the device page's footer (its height - 1) and the bars' units (kHz ms dB bpm ct st oct)
    ("FONT_H", 16, CAPS),      # the header's device and page names
    ("FONT_N", 20, CAPS),      # a bar's name
    ("FONT_V", 26, CAPS),      # a bar's value
    ("FONT_T", 32, CAPS),      # PRESET's toast: the slot and the patch's name
]
SS = 4
# The font area (#602): the sizes whose tables a device build reads from flash outside the firmware. FONT_S stays in the
# firmware: the menu, the lists and the messages use it, and without the font area every size draws its letters.
AREA = ["FONT_M", "FONT_L", "FONT_F", "FONT_H", "FONT_N", "FONT_V", "FONT_T"]
# its flash sectors (offset / 4096, run length): sectors no Matryoshka firmware wrote before. 0x93..0x96 lie between the
# firmware's area and the bank, 0xE7..0xE9 between the palette (0xE5, 0xE6) and the factory region, 0xFC..0xFE between
# the factory region and the flash chip's key sector (0xFF). A table stays inside one run.
AREA_RUNS = [(0x93, 4), (0xE7, 3), (0xFC, 3)]
AREA_MAGIC = 0x314E464D                  # "MFN1", programmed last (the commit)
AREA_LAYOUT = 1
AREA_HDR = 64
SECTOR = 0x1000


class Font:
    def __init__(self, data):
        self.d = data
        n = struct.unpack(">H", data[4:6])[0]
        self.t = {}
        for i in range(n):
            tag, _, off, ln = struct.unpack(">4sIII", data[12 + 16 * i:28 + 16 * i])
            self.t[tag.decode()] = (off, ln)
        h = self.t["head"][0]
        self.upem = struct.unpack(">H", data[h + 18:h + 20])[0]
        self.loc_long = struct.unpack(">h", data[h + 50:h + 52])[0] == 1
        hh = self.t["hhea"][0]
        self.asc, self.desc = struct.unpack(">hh", data[hh + 4:hh + 8])
        self.nh = struct.unpack(">H", data[hh + 34:hh + 36])[0]
        self.ng = struct.unpack(">H", data[self.t["maxp"][0] + 4:self.t["maxp"][0] + 6])[0]
        self.cmap = self._cmap()

    def _cmap(self):
        c = self.t["cmap"][0]
        d = self.d
        n = struct.unpack(">H", d[c + 2:c + 4])[0]
        for i in range(n):
            pid, eid, off = struct.unpack(">HHI", d[c + 4 + 8 * i:c + 12 + 8 * i])
            s = c + off
            if pid == 3 and eid in (1, 10) and struct.unpack(">H", d[s:s + 2])[0] == 4:
                segx2 = struct.unpack(">H", d[s + 6:s + 8])[0]
                seg = segx2 // 2
                ends = struct.unpack(f">{seg}H", d[s + 14:s + 14 + segx2])
                starts = struct.unpack(f">{seg}H", d[s + 16 + segx2:s + 16 + 2 * segx2])
                deltas = struct.unpack(f">{seg}h", d[s + 16 + 2 * segx2:s + 16 + 3 * segx2])
                ro = s + 16 + 3 * segx2
                offs = struct.unpack(f">{seg}H", d[ro:ro + segx2])
                out = {}
                for k in range(seg):
                    for ch in range(starts[k], ends[k] + 1):
                        if ch == 0xFFFF:
                            continue
                        if offs[k] == 0:
                            g = (ch + deltas[k]) & 0xFFFF
                        else:
                            a = ro + 2 * k + offs[k] + 2 * (ch - starts[k])
                            g = struct.unpack(">H", d[a:a + 2])[0]
                            g = (g + deltas[k]) & 0xFFFF if g else 0
                        out[ch] = g
                return out
        raise ValueError("no cmap format 4")

    def advance(self, g):
        h = self.t["hmtx"][0]
        i = min(g, self.nh - 1)
        return struct.unpack(">H", self.d[h + 4 * i:h + 4 * i + 2])[0]

    def _loc(self, g):
        l = self.t["loca"][0]
        if self.loc_long:
            a, b = struct.unpack(">II", self.d[l + 4 * g:l + 4 * g + 8])
        else:
            a, b = struct.unpack(">HH", self.d[l + 2 * g:l + 2 * g + 4])
            a, b = 2 * a, 2 * b
        return a, b

    def contours(self, g, depth=0):
        """the glyph's contours as polygons in font units (curves flattened)"""
        a, b = self._loc(g)
        if a == b:
            return []
        d = self.d
        o = self.t["glyf"][0] + a
        nc = struct.unpack(">h", d[o:o + 2])[0]
        if nc < 0:
            return self._composite(o + 10, depth)
        ends = struct.unpack(f">{nc}H", d[o + 10:o + 10 + 2 * nc])
        npt = ends[-1] + 1
        il = struct.unpack(">H", d[o + 10 + 2 * nc:o + 12 + 2 * nc])[0]
        p = o + 12 + 2 * nc + il
        flags = []
        while len(flags) < npt:
            f = d[p]
            p += 1
            flags.append(f)
            if f & 8:
                r = d[p]
                p += 1
                flags += [f] * r
        def coords(short, same):
            out, v = [], 0
            nonlocal p
            for f in flags:
                if f & short:
                    dv = d[p]
                    p += 1
                    v += dv if f & same else -dv
                elif not f & same:
                    v += struct.unpack(">h", d[p:p + 2])[0]
                    p += 2
                out.append(v)
            return out
        xs = coords(2, 16)
        ys = coords(4, 32)
        polys, s = [], 0
        for e in ends:
            pts = [(xs[i], ys[i], flags[i] & 1) for i in range(s, e + 1)]
            s = e + 1
            polys.append(flatten(pts))
        return polys

    def _composite(self, p, depth):
        d = self.d
        polys = []
        while True:
            fl, gi = struct.unpack(">HH", d[p:p + 4])
            p += 4
            if fl & 1:
                dx, dy = struct.unpack(">hh", d[p:p + 4])
                p += 4
            else:
                dx, dy = struct.unpack(">bb", d[p:p + 2])
                p += 2
            sx = sy = 1.0
            if fl & 8:
                sx = sy = struct.unpack(">h", d[p:p + 2])[0] / 16384
                p += 2
            elif fl & 0x40:
                sx, sy = [v / 16384 for v in struct.unpack(">hh", d[p:p + 4])]
                p += 4
            elif fl & 0x80:
                sx, _, _, sy = [v / 16384 for v in struct.unpack(">hhhh", d[p:p + 8])]
                p += 8
            if depth < 4:
                for poly in self.contours(gi, depth + 1):
                    polys.append([(x * sx + dx, y * sy + dy) for x, y in poly])
            if not fl & 0x20:
                break
        return polys


def flatten(pts):
    """a TrueType contour (on / off curve points) as a polygon: quadratic segments in 6 steps"""
    if not pts:
        return []
    n = len(pts)
    # start on an on-curve point (or the midpoint of two off-curve ones)
    k = next((i for i in range(n) if pts[i][2]), None)
    if k is None:
        a, b = pts[0], pts[1]
        start = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        seq = pts[1:] + pts[:1]
    else:
        start = (pts[k][0], pts[k][1])
        seq = pts[k + 1:] + pts[:k]
    out = [start]
    cur = start
    ctrl = None
    for x, y, on in seq + [(start[0], start[1], 1)]:
        if on:
            if ctrl is None:
                out.append((x, y))
            else:
                for t in range(1, 7):
                    u = t / 6
                    out.append(((1 - u) ** 2 * cur[0] + 2 * (1 - u) * u * ctrl[0] + u * u * x,
                                (1 - u) ** 2 * cur[1] + 2 * (1 - u) * u * ctrl[1] + u * u * y))
                ctrl = None
            cur = (x, y)
        else:
            if ctrl is not None:
                mid = ((ctrl[0] + x) / 2, (ctrl[1] + y) / 2)
                for t in range(1, 7):
                    u = t / 6
                    out.append(((1 - u) ** 2 * cur[0] + 2 * (1 - u) * u * ctrl[0] + u * u * mid[0],
                                (1 - u) ** 2 * cur[1] + 2 * (1 - u) * u * ctrl[1] + u * u * mid[1]))
                cur = mid
            ctrl = (x, y)
    return out


def raster(polys, scale, base, h, x_shift):
    """coverage 0..15 per pixel of a w x h box: font units -> pixels (y down from the top of the line box)"""
    if not polys:
        return 0, 0, []
    pp = [[((x * scale) + x_shift, base - y * scale) for x, y in poly] for poly in polys]
    xs = [p[0] for poly in pp for p in poly]
    x0 = int(min(xs)) if min(xs) >= 0 else int(min(xs)) - 1
    x1 = int(max(xs)) + 1
    w = max(1, x1 - x0)
    edges = []
    for poly in pp:
        for a, b in zip(poly, poly[1:] + poly[:1]):
            ax, ay, bx, by = (a[0] - x0) * SS, a[1] * SS, (b[0] - x0) * SS, b[1] * SS
            if ay != by:
                edges.append((ax, ay, bx, by, 1 if by > ay else -1))
    cover = [0] * (w * h)
    for sy in range(h * SS):
        yc = sy + 0.5
        xings = []
        for ax, ay, bx, by, dd in edges:
            if (ay <= yc < by) or (by <= yc < ay):
                xings.append((ax + (yc - ay) * (bx - ax) / (by - ay), dd))
        xings.sort()
        wind = 0
        for j in range(len(xings) - 1):
            wind += xings[j][1]
            if wind:
                for sx in range(max(0, int(xings[j][0] + 0.5)), min(w * SS, int(xings[j + 1][0] + 0.5))):
                    cover[(sy // SS) * w + sx // SS] += 1
    cov = [min(15, (c * 15 + 8) // (SS * SS)) for c in cover]
    # trim empty columns at either side
    cols = [any(cov[r * w + c] for r in range(h)) for c in range(w)]
    if not any(cols):
        return x0, 0, []
    a = cols.index(True)
    b = w - cols[::-1].index(True)
    out = [cov[r * w + c] for r in range(h) for c in range(a, b)]
    return x0 + a, b - a, out


def glyph_data(f, px, chars):
    """one size: its line box (h, base), the character map, the glyph list (with its end entry) and the ink rows' bits"""
    scale = px / f.upem
    # the line box: the ink of the characters it carries, top to bottom (tighter than the font's ascender, which leaves
    # room for accents)
    ys = [y for ch in chars for poly in f.contours(f.cmap.get(ord(ch), 0)) for _, y in poly]
    base = int(max(ys) * scale + 0.999) if ys else px
    h = base + (int(-min(ys) * scale + 0.999) if ys and min(ys) < 0 else 0)
    glyphs, bits = [], []
    cmap = [255] * 95
    for ch in sorted(set(chars), key=ord):
        gid = f.cmap.get(ord(ch), 0)
        x, w, cov = raster(f.contours(gid), scale, base, h, 0.0)
        adv = round(f.advance(gid) * scale)
        cmap[ord(ch) - 0x20] = len(glyphs)
        # only the rows from the first to the last with ink (the line box's other rows are empty: font_bc.c draws nothing
        # for coverage 0, so leaving them out changes no pixel)
        ink = [r for r in range(h) if any(cov[r * w:(r + 1) * w])]
        y = ink[0] if ink else 0
        glyphs.append((w, adv, x, y, len(bits)))
        rowb = (w + 1) // 2
        for r in range(y, ink[-1] + 1 if ink else 0):
            for k in range(rowb):
                hi = cov[r * w + 2 * k] if 2 * k < w else 0
                lo = cov[r * w + 2 * k + 1] if 2 * k + 1 < w else 0
                bits.append(hi << 4 | lo)
    glyphs.append((0, 0, 0, 0, len(bits)))         # the end of the last glyph's rows (no character maps to it)
    for c in range(ord("a"), ord("z") + 1):     # a font of capitals: a lowercase letter it lacks draws as its capital
        if cmap[c - 0x20] == 255 and chr(c).upper() in chars:
            cmap[c - 0x20] = cmap[ord(chr(c).upper()) - 0x20]
    return h, base, cmap, glyphs, bits


def crc16_rec(b):
    """CRC-16, poly 0x1021, init 0 (firmware/loader/ldr_record.h ldr_rec_crc16)"""
    c = 0
    for v in b:
        c ^= v << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021 if c & 0x8000 else c << 1) & 0xFFFF
    return c


def is_record(r):
    """the 80 bytes at a sector's offset 0xF00 look like an update record (ldr_record.h ldr_is_record): the update loader
    would erase that sector"""
    crc = r[0] | r[1] << 8
    return (r[6] | r[7] << 8) == 0x5441 and crc != 0 and crc == crc16_rec(r[2:80])


def pack_area(tables):
    """the font area's image from tables [(name, bytes, align)]: each table inside one run of AREA_RUNS (best fit, the
    largest first), the header at the image's start. Returns the image, its id, its sectors and each table's flash offset.

    The header, 64 bytes, little endian: u32 magic, u8 layout, u8 sectors, u16 spare (0xFFFF), u32 the image's length,
    u32 the CRC-32 of bytes 16 .. its end (the id), u16 each sector's flash sector (offset / 4096), then 0xFF."""
    runs = []                                    # [logical start, logical end, next free]
    at = 0
    for _, n in AREA_RUNS:
        runs.append([at, at + n * SECTOR, at])
        at += n * SECTOR
    runs[0][2] = AREA_HDR
    img = bytearray(b"\xFF" * at)
    where = {}
    for name, data, align in sorted(tables, key=lambda t: -len(t[1])):
        fits = [r for r in runs if (r[2] + align - 1) // align * align + len(data) <= r[1]]
        if not fits:
            raise SystemExit(f"gen_font: {name} ({len(data)} bytes) fits in no run of the font area: it is full")
        r = min(fits, key=lambda r: r[1] - (r[2] + align - 1) // align * align - len(data))
        o = (r[2] + align - 1) // align * align
        img[o:o + len(data)] = data
        r[2] = o + len(data)
        where[name] = o
    img = img[:max(r[2] for r in runs if r[2] > r[0])]
    secs = [base + i for base, n in AREA_RUNS for i in range(n)]
    for s in range(len(secs)):                   # (the update loader erases a sector that holds an update record)
        rec = bytes(img[s * SECTOR + 0xF00:s * SECTOR + 0xF00 + 80]).ljust(80, b"\xFF")
        if is_record(rec):
            raise SystemExit(f"gen_font: the font area's sector {s} holds bytes the update loader takes for an update record")
    hdr = struct.pack("<IBBHII", AREA_MAGIC, AREA_LAYOUT, len(secs), 0xFFFF, len(img), 0) + struct.pack(f"<{len(secs)}H", *secs)
    img[:len(hdr)] = hdr
    crc = zlib.crc32(bytes(img[16:]))
    img[12:16] = struct.pack("<I", crc)
    phys = {name: secs[o // SECTOR] * SECTOR + o % SECTOR for name, o in where.items()}
    return bytes(img), crc, secs, phys


def main():
    f = Font(TTF.read_bytes())
    sizes = [(name, px, *glyph_data(f, px, chars)) for name, px, chars in SIZES]
    tables = []
    for name, px, h, base, cmap, glyphs, bits in sizes:
        if name in AREA:
            lname = name.lower()
            tables += [(f"{lname}_map", bytes(cmap), 1), (f"{lname}_g", b"".join(struct.pack("<BBbBH", *g) for g in glyphs), 2),
                       (f"{lname}_bits", bytes(bits), 1)]
    img, crc, secs, phys = pack_area(tables)
    lines = [
        "/* The glyph bitmaps below are derived from Barlow Condensed SemiBold, Copyright 2017 The Barlow Project Authors",
        " * (https://github.com/jpt/barlow), licensed under the SIL Open Font License 1.1 (web/public/fonts/OFL-BarlowCondensed.txt).",
        " * The surrounding code (tools/gen_font.py's output format): GPL-3.0-only. */",
        "/* generated by tools/gen_font.py: do not edit. 4-bit coverage, two pixels per byte (high nibble first), rows padded;",
        " * a glyph keeps only its ink rows: rows y.. while inside its bits (up to the next glyph's off; a last entry ends them) */",
        "#pragma once",
        "#include <stdint.h>",
        "",
        "typedef struct { uint8_t w, adv; int8_t x; uint8_t y; uint16_t off; } fglyph_t;   /* ink width, advance, ink start, first ink row, offset into bits */",
        "typedef struct { uint8_t h, base; const uint8_t *map; const fglyph_t *g; const uint8_t *bits; } font_t;   /* map: ASCII 0x20.. -> glyph, 255 none */",
        "",
        f"/* The font area (#602): a FONT_AREA build (the device's) reads the tables of {', '.join(AREA)} from",
        f" * {len(secs)} flash sectors outside the firmware: the image {AREA_BIN.relative_to(ROOT)}, written with this file, which the",
        " * installer puts on the FM-1 next to the firmware (firmware/src/font_area.c checks it at boot). FA_ID, the CRC-32 of the",
        " * image's bytes 16 .. its end, names the font this firmware needs; FA_SECTOR_LIST is the flash sector (offset / 4096) of",
        " * each of the image's sectors. Without that image every size draws FONT_S's letters (font_bc.c font_use). */",
        f"#define FA_ID 0x{crc:08X}u",
        f"#define FA_LEN {len(img)}u",
        f"#define FA_SECTORS {len(secs)}u",
        f"#define FA_SECTOR_LIST {{{', '.join(f'0x{s:X}u' for s in secs)}}}",
        "#if FONT_AREA",
        '#include "fm1_xip.h"',
        "#endif",
        "",
    ]
    total = moved = 0
    for name, px, h, base, cmap, glyphs, bits in sizes:
        lname = name.lower()
        lines.append(f"/* {name}: {px} px per em, line box {h} px, baseline at {base} */")
        lines.append(f"#define {name}_PX {px}")
        if name in AREA:
            lines.append("#if !FONT_AREA")
        lines.append(f"static const uint8_t {lname}_map[95] = {{{', '.join(str(v) for v in cmap)}}};")
        lines.append(f"static const fglyph_t {lname}_g[{len(glyphs)}] = {{")
        for i in range(0, len(glyphs), 8):
            lines.append("    " + " ".join("{%d, %d, %d, %d, %d}," % g for g in glyphs[i:i + 8]))
        lines.append("};")
        lines.append(f"static const uint8_t {lname}_bits[{len(bits)}] = {{")
        for i in range(0, len(bits), 24):
            lines.append("    " + ",".join(str(b) for b in bits[i:i + 24]) + ",")
        lines.append("};")
        if name in AREA:
            lines.append("#else                                           /* the same tables in the font area */")
            for t, ty in (("map", "uint8_t"), ("g", "fglyph_t"), ("bits", "uint8_t")):
                lines.append(f"#define {lname}_{t} ((const {ty} *)FM1_XIP(0x{phys[f'{lname}_{t}']:05X}u))")
            lines.append("#endif")
        lines.append(f"static const font_t {name} = {{{h}, {base}, {lname}_map, {lname}_g, {lname}_bits}};")
        lines.append("")
        size = len(bits) + 95 + 6 * len(glyphs)
        print(f"  {name}: {px} px, {len(glyphs) - 1} glyphs, {size} bytes" + (" (font area)" if name in AREA else ""))
        total += size
        moved += size if name in AREA else 0
    OUT.write_text("\n".join(lines))
    AREA_BIN.write_bytes(img)
    print(f"wrote {OUT.relative_to(ROOT)}: {total} bytes, {moved} of them in the font area")
    print(f"wrote {AREA_BIN.relative_to(ROOT)}: {len(img)} of {len(secs) * SECTOR} bytes, id 0x{crc:08X}")


if __name__ == "__main__":
    main()
