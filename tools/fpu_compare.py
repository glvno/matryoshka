#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""#950 (measurement only): what the FPU flags change, from the fpu-measure CI job's builds.

  tools/fpu_compare.py [DIR]      (default build/fpu: DIR/normal, DIR/fpu, DIR/bench-soft, DIR/bench-fpu, each with
                                   matryoshka.bin and matryoshka.dis; the CI artifact matryoshka-fpu-measure)

Prints each app's size and sha256; whether FM1_FPU=1 changes the normal firmware's code (the functions whose
instructions differ, numbers ignored, and the instruction forms only one side has); in the two benchmark builds, how
many FPU instructions and calls to the software float helpers each holds; and, for the 64-bit multiply erratum
(felucca-bsp docs/CPU.md: an inlined 32 x 32 -> 64-bit multiply among 16-bit loads now and then leaves a register one
bit off), each function of the normal build with a 64-bit multiply within WINDOW instructions of a 16-bit load.
"""
import collections
import hashlib
import re
import sys
from pathlib import Path

LINE = re.compile(r"^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+)\s*\t(.*)$")   # tools/build.py's
HEAD = re.compile(r"^([^\s.<][^\s<]*):\s*$")                               # a function's label (JieLi objdump: "name:")
MUL64 = re.compile(r"\br\d+_r\d+ [-+]?= r\d+ \* r\d+")                     # mul / madd / msub .prr
LOAD16 = re.compile(r"= h\[")
FLOAT = re.compile(r"\(f\)|\b(?:ftoi|ftou|itof|utof|ftof|fmin|fmax)\b|\biff\b")
SOFT = re.compile(r"<__(?:add|sub|mul|div|neg|fix|fixuns|float|floatun|extend|trunc|eq|ne|lt|le|gt|ge|unord|cmp)\w*sf\w*")
WINDOW = 3


def functions(dis):
    """function name -> its instructions (text only: no address, no encoding, no <symbol> note)"""
    fs, cur = {}, None
    for ln in dis.splitlines():
        m = HEAD.match(ln)
        if m:
            cur = fs.setdefault(m.group(1), [])
        elif cur is not None and (m := LINE.match(ln)):
            cur.append(m.group(3).split("<")[0].strip())
    return fs


def shape(ins):
    return re.sub(r"(?<![\w.])-?\d+\b", "N", ins)


def main(argv):
    d = Path(argv[1] if len(argv) > 1 else "build/fpu")
    dis = {v: (d / v / "matryoshka.dis").read_text() for v in ("normal", "fpu", "bench-soft", "bench-fpu")}
    for v in dis:
        b = (d / v / "matryoshka.bin").read_bytes()
        print(f"{v:<11} app {len(b):7d} B  sha256 {hashlib.sha256(b).hexdigest()}")

    n, f = functions(dis["normal"]), functions(dis["fpu"])
    if (d / "normal" / "matryoshka.bin").read_bytes() == (d / "fpu" / "matryoshka.bin").read_bytes():
        print("\nFM1_FPU=1 builds the normal firmware byte for byte the same")
    else:
        changed = sorted(k for k in n.keys() & f.keys() if list(map(shape, n[k])) != list(map(shape, f[k])))
        print(f"\nFM1_FPU=1 changes the normal firmware: {len(changed)} of {len(n)} functions differ (numbers ignored); "
              f"only in normal: {sorted(n.keys() - f.keys())[:20]}; only with FM1_FPU: {sorted(f.keys() - n.keys())[:20]}")
        for k in changed[:60]:
            print(f"  {k}: {len(n[k])} -> {len(f[k])} instructions")
        cn = collections.Counter(shape(i) for v in n.values() for i in v)
        cf = collections.Counter(shape(i) for v in f.values() for i in v)
        diff = sorted(((cf[s] - cn[s], s) for s in cn.keys() | cf.keys() if cf[s] != cn[s]), key=lambda x: -abs(x[0]))
        print("  instruction forms whose count changed (FM1_FPU minus normal):")
        for k, s in diff[:40]:
            print(f"    {k:+6d}  {s}")

    print()
    for v in ("bench-soft", "bench-fpu"):
        lines = [m.group(3) for m in map(LINE.match, dis[v].splitlines()) if m]
        print(f"{v:<11} FPU instructions {sum(1 for x in lines if FLOAT.search(x)):5d}, "
              f"calls to software float helpers {sum(1 for x in lines if SOFT.search(x)):5d}")

    hits = {}
    for name, ins in n.items():
        mul = [i for i, x in enumerate(ins) if MUL64.search(x)]
        ld = [i for i, x in enumerate(ins) if LOAD16.search(x)]
        if mul:
            hits[name] = (len(mul), len(ld), sum(1 for i in mul if any(abs(i - j) <= WINDOW for j in ld)))
    both = sorted(((v[2], v[1], k, v[0]) for k, v in hits.items() if v[1]), reverse=True)
    print(f"\n64-bit multiply erratum (normal build): {len(hits)} functions inline {sum(v[0] for v in hits.values())} 64-bit "
          f"multiplies; {len(both)} of them also load 16-bit values ({sum(1 for x in both if x[0])} with a multiply within "
          f"{WINDOW} instructions of such a load):")
    for near, loads, k, mul in both:
        print(f"  {k}: {mul} multiplies, {loads} 16-bit loads, {near} multiplies within {WINDOW} of one")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
