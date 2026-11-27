#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Spike #1338: code / rodata / data / bss bytes of ELF32 objects, and their largest symbols (no tools needed).
#   elfsize.py [--json OUT] OBJ...
import json
import struct
import sys


def sections(path):
    d = open(path, "rb").read()
    if d[:4] != b"\x7fELF" or d[4] != 1:
        raise SystemExit(f"{path}: not ELF32")
    shoff, = struct.unpack_from("<I", d, 32)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", d, 46)
    sh = [struct.unpack_from("<10I", d, shoff + i * shentsize) for i in range(shnum)]
    names = sh[shstrndx]

    def nm(off, strtab):
        e = d.index(b"\0", strtab[4] + off)
        return d[strtab[4] + off:e].decode()
    secs = [dict(name=nm(s[0], names), type=s[1], flags=s[2], size=s[5], s=s) for s in sh]
    syms = []
    for s in sh:
        if s[1] != 2:                   # SHT_SYMTAB
            continue
        strtab = sh[s[6]]
        for i in range(s[5] // 16):
            name, value, size, info, other, shndx = struct.unpack_from("<IIIBBH", d, s[4] + i * 16)
            if size and 0 < shndx < len(secs) and info & 0xF in (1, 2):   # object, function
                syms.append((nm(name, strtab), size, secs[shndx]["name"]))
    return secs, syms


def kind(s):
    alloc, write, exe = s["flags"] & 2, s["flags"] & 1, s["flags"] & 4
    if not alloc:
        return None
    if exe:
        return "code"
    if s["type"] == 8:                  # SHT_NOBITS
        return "bss"
    return "data" if write else "rodata"


def main():
    args = sys.argv[1:]
    out = None
    if args[:1] == ["--json"]:
        out, args = args[1], args[2:]
    res = {}
    print(f"{'object':28} {'code':>7} {'rodata':>7} {'data':>6} {'bss':>6}")
    tot = dict(code=0, rodata=0, data=0, bss=0)
    for p in args:
        secs, syms = sections(p)
        r = dict(code=0, rodata=0, data=0, bss=0)
        for s in secs:
            k = kind(s)
            if k:
                r[k] += s["size"]
        for k in tot:
            tot[k] += r[k]
        r["symbols"] = sorted(syms, key=lambda x: -x[1])
        res[p.split("/")[-1]] = r
        print(f"{p.split('/')[-1]:28} {r['code']:7} {r['rodata']:7} {r['data']:6} {r['bss']:6}")
    print(f"{'total':28} {tot['code']:7} {tot['rodata']:7} {tot['data']:6} {tot['bss']:6}")
    allsyms = sorted(((n, s, sec, o) for o, r in res.items() for n, s, sec in r["symbols"]), key=lambda x: -x[1])
    print("largest symbols:")
    for n, s, sec, o in allsyms[:25]:
        print(f"  {s:6} {sec:40.40} {n} ({o})")
    if out:
        json.dump(dict(objects=res, total=tot), open(out, "w"), indent=1)


main()
