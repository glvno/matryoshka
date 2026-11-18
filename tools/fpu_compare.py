#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""#950, #979 (measurement only): what the FPU builds hold, from the fpu-measure CI job's builds.

  tools/fpu_compare.py [DIR]      (default build/fpu: DIR/normal and DIR/bench, each with matryoshka.bin and
                                   matryoshka.dis; the CI artifact matryoshka-fpu-measure)

Every build is for the FPU (tools/build.py FPU_FLAGS, #979). Prints each app's size and sha256; in each, how many FPU
instructions and float compares it holds (tools/build.py puts them in matryoshka.dis, which JieLi's objdump cannot),
how many calls to the software float helpers (none expected), and how many instructions nobody could print (none
expected); and, for the 64-bit multiply erratum (felucca-bsp docs/CPU.md: an inlined 32 x 32 -> 64-bit multiply among
16-bit loads now and then leaves a register one bit off), each function of the normal build with a 64-bit multiply
within WINDOW instructions of a 16-bit load.
"""
import hashlib
import re
import sys
from pathlib import Path

LINE = re.compile(r"^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+)\s*\t(.*)$")   # tools/build.py's
HEAD = re.compile(r"^([^\s.<][^\s<]*):\s*$")                               # a function's label (JieLi objdump: "name:")
MUL64 = re.compile(r"\br\d+_r\d+ [-+]?= r\d+ \* r\d+")                     # mul / madd / msub .prr
LOAD16 = re.compile(r"= h\[")
FPU_OP = ("3f e5", "3f f5")   # the FPU's arithmetic and conversions (fm1-emu fpu.rs: 0xe53f, its parallel twin 0xf53f)
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


def main(argv):
    d = Path(argv[1] if len(argv) > 1 else "build/fpu")
    dis = {v: (d / v / "matryoshka.dis").read_text() for v in ("normal", "bench")}
    for v, text in dis.items():
        b = (d / v / "matryoshka.bin").read_bytes()
        lines = [m for m in map(LINE.match, text.splitlines()) if m]
        print(f"{v:<7} app {len(b):7d} B  sha256 {hashlib.sha256(b).hexdigest()}  FPU instructions "
              f"{sum(1 for m in lines if m.group(2).startswith(FPU_OP)):5d}, float compares "
              f"{sum(1 for m in lines if m.group(3).startswith('iff (')):4d}, calls to software float helpers "
              f"{sum(1 for m in lines if SOFT.search(m.group(3))):4d}, instructions nobody could print "
              f"{text.count('<unknown instruction>'):4d}")

    hits = {}
    for name, ins in functions(dis["normal"]).items():
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
