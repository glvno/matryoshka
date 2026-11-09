#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
# Modified for Matryoshka (glvno): the audio path for speed, the rest for size (#798).
"""The audio path for speed, everything else for size (tools/build.py).

build.py compiles modular.c to LLVM IR at -O2 without the optimizer. This script finds the functions the audio
interrupt can run (SPEED_ROOTS and, transitively, every function or table their bodies name: the engine's render, its
modules, the mix, the second core's job, USB audio's tap; and the compiler's helpers, LIBCALLS) and marks every OTHER
function 'optsize', the attribute -Os puts on each function. The IR is then compiled at -O2: the audio path gets -O2,
the UI, the stores, the editor link and the menus get what -Os gave them. The JieLi clang 4 has no '#pragma clang attribute' and no optimize("O2") attribute,
hence the IR round trip (Felucca's route for its main-loop code).
RAM code (.ram_text: the flash driver, run with the flash off; .c1_text: the second core's waiting loop) keeps
'optsize' even when the interrupt reaches it: build.py checks it calls nothing and reads no flash address, and inlining
at -O2 could break that.
  size_fns.py IN.ll OUT.ll"""
import re
import sys
from pathlib import Path

SPEED_ROOTS = ("fm1_alnk0_irq",)                 # hal/fm1_isr.S isr_alnk0 -> audio.c: the render, the mix, USB audio
# the compiler's helpers (64-bit division: div64.c; block copies: libc.c): the audio path calls them without naming them
# in the IR
LIBCALLS = ("__udivmoddi4", "__udivdi3", "__umoddi3", "__divdi3", "__moddi3", "memcpy", "memset")
KEEP_SIZE_SECTIONS = (".ram_text", ".c1_text")
IR_DEF = re.compile(r"^(define [^\n]*?@\"?([\w.$]+)\"?\([^\n]*\)(?: unnamed_addr| local_unnamed_addr)?)( #\d+[^\n]*\{)$",
                    re.M)
IR_BODY = re.compile(r"^define [^\n]*?@\"?([\w.$]+)\"?\((.*?)^\}", re.M | re.S)
IR_GLOBAL = re.compile(r"^@\"?([\w.$]+)\"? = ([^\n]*)$", re.M)
IR_REF = re.compile(r"@\"?([\w.$]+)\"?")


def speed_set(ir):
    """the functions the audio interrupt can run: SPEED_ROOTS and every function their bodies call or name, also
    through a table that names it (a pointer taken counts as called); from the unoptimised IR, before inlining (a
    superset)"""
    body = {m.group(1): m.group(2) for m in IR_BODY.finditer(ir)}
    table = {m.group(1): m.group(2) for m in IR_GLOBAL.finditer(ir)}
    seen, todo, fns = set(), [r for r in SPEED_ROOTS + LIBCALLS if r in body], set()
    missing = [r for r in SPEED_ROOTS if r not in body]
    if missing:
        raise SystemExit(f"size_fns: no definition of {', '.join(missing)} in the IR")
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        if f in body:
            fns.add(f)
        todo += [g for g in IR_REF.findall(body.get(f) or table.get(f, "")) if g not in seen and (g in body or g in table)]
    return fns


def main(src, dst):
    ir = Path(src).read_text()
    speed = speed_set(ir)
    sized, ram = [], []

    def mark(m):
        name = m.group(2)
        if name in speed and not any(f'section "{s}' in m.group(3) for s in KEEP_SIZE_SECTIONS):
            return m.group(0)
        (ram if name in speed else sized).append(name)
        return m.group(1) + " optsize" + m.group(3)
    out = IR_DEF.sub(mark, ir)
    if len(IR_DEF.findall(ir)) != len(IR_BODY.findall(ir)):
        raise SystemExit("size_fns: a function definition this script does not recognise (IR_DEF)")
    Path(dst).write_text(out)
    print(f"size_fns: {len(speed) - len(ram)} functions on the audio path built for speed, {len(sized)} for size"
          + (f", {len(ram)} RAM ones on the path kept for size ({', '.join(sorted(ram))})" if ram else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
