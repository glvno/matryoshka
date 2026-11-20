#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 glvno
"""Pinned code addresses in the flash (tools/build.py, #1138).

The FM-1 runs its code from the flash through a 32 KB instruction cache that one audio block's code overflows, so where
each hot function sits decides how much of it is fetched again every block: a release whose bytes for the voices did not
change can still take longer when other code moves them (#1105, #1138). A pin file names functions and the flash
address each must start at, one `NAME 0xADDRESS` a line (`#` starts a comment). build.py links matryoshka.o's functions
in the order this script plans: every pinned function at its address, and between two pins the other functions, in
the compiler's order, as many as fit the gap (first fit), the rest of the gap padded; whatever fits nowhere follows the
last pin. A function's code is the compiler's own; only its place changes, as with build.py's FAST_TEXT.

  text_layout.py PINS OBJ...    print the plan (the objects in link order, matryoshka.o last)"""
import struct
import sys

TEXT_ORIGIN = 0x02000120            # firmware/app.ld XIP: .text starts here (APP_XIP in build.py)


def text_sections(path):
    """the object's code sections in file order: [(name, size, align)] for every SHT_PROGBITS section named .text*"""
    b = open(path, "rb").read()
    if b[:4] != b"\x7fELF" or b[4] != 1 or b[5] != 1:
        raise SystemExit(f"{path}: not a 32-bit little-endian ELF")
    shoff, = struct.unpack_from("<I", b, 32)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", b, 46)
    hdr = [struct.unpack_from("<IIIIIIIIII", b, shoff + i * shentsize) for i in range(shnum)]
    strtab = hdr[shstrndx][4]

    def name(off):
        return b[strtab + off:b.index(b"\0", strtab + off)].decode()
    out = []
    for h in hdr:
        n = name(h[0])
        if h[1] == 1 and h[2] & 4 and (n == ".text" or n.startswith(".text.")):   # PROGBITS, executable
            out.append((n, h[5], max(h[8], 1)))
    return out


def read_pins(path):
    """NAME -> address, in the file's order"""
    pins = {}
    for no, ln in enumerate(open(path), 1):
        ln = ln.split("#", 1)[0].split()
        if not ln:
            continue
        if len(ln) != 2:
            raise SystemExit(f"{path}:{no}: want NAME 0xADDRESS")
        pins[ln[0]] = int(ln[1], 16)
    return pins


def align(a, n):
    return (a + n - 1) // n * n


def plan(pins, lead, main):
    """the link order of `main` (matryoshka.o's code sections) after the `lead` objects' code (crt0.o's .text.crt0 first,
    then each object's .text* in link order, as app.ld places them): (lines for app.ld, {function: address}, notes).
    A pin the code before it has already passed is placed where that code ends, and noted."""
    at = TEXT_ORIGIN
    crt0 = [s for secs in lead for s in secs if s[0] == ".text.crt0"]
    for n, size, al in crt0 + [s for secs in lead for s in secs if s[0] != ".text.crt0"]:
        at = align(at, al) + size
    fn = lambda sec: sec[0][len(".text."):] if sec[0].startswith(".text.") else None
    pinned = sorted((a, s) for s in main if fn(s) in pins for a in [pins[fn(s)]])
    pool = [s for s in main if fn(s) not in pins]
    lines, where, notes, pad = [], {}, [], 0

    def put(sec):
        nonlocal at
        at = align(at, sec[2])
        if fn(sec):
            where[fn(sec)] = at
        lines.append(f"*matryoshka.o({sec[0]})")
        at += sec[1]
    for want, sec in pinned:
        for cand in list(pool):                   # first fit, in the compiler's order
            if align(align(at, cand[2]) + cand[1], sec[2]) <= want:
                pool.remove(cand)
                put(cand)
        if at > want:
            notes.append(f"{fn(sec)}: pinned at {want:#x}, the code before it ends at {at:#x} (+{at - want})")
        elif align(at, sec[2]) < want:
            lines.append(f". += {want - at};")
            pad += want - at
            at = want
        put(sec)
    for sec in pool:
        put(sec)
    notes.append(f"{len(pinned)} pinned functions, {pad} B of padding")
    return lines, where, notes


def main(argv):
    pins = read_pins(argv[0])
    objs = [text_sections(p) for p in argv[1:]]
    lines, where, notes = plan(pins, objs[:-1], objs[-1])
    print("\n".join(lines))
    print("\n".join(notes), file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
