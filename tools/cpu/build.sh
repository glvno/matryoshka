#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Build the rv32im programs that tools/cpu/rv32.mjs counts (any clang with the RISC-V target and ld.lld; runs on macOS):
#   build/cpu/prof.elf   the engine with the ENG_PROF hooks (per module costs)
#   build/cpu/plain.elf  the engine without them (totals)
#   build/cpu/aot.elf    plain.elf with the compiled factory assemblies (#808, firmware/src/aot.c; prof.elf and plain.elf
#                        leave them out, ENG_AOT=0, so the model's per-module costs stay the interpreter's):
#                        CPU_ELF=build/cpu/aot.elf npm run cpu-hot
#   build/cpu/old.elf    the engine of M1-0.2 (b907693) with its 303 Acid: the patch whose CPU load was measured on the FM-1
#   build/cpu/bench.elf  the fixed-point kernels of firmware/src/bench.c, also measured on the FM-1
# The flags follow tools/build.py (-Os). The cycle counts follow the compiler: web/src/cpu-costs.json is made with the clang
# in tools/cpu/clang-version (a table made with another version differs from the committed one: D-383).
set -e
cd "$(dirname "$0")/../.."
PIN=$(cat tools/cpu/clang-version)
clang --version | head -1 | grep -qE " version $PIN( |$)" || echo "warning: $(clang --version | head -1), not clang $PIN (tools/cpu/clang-version): the counts will differ from the committed cpu-costs.json" >&2
OUT=build/cpu
mkdir -p "$OUT/old"
CC="clang --target=riscv32-unknown-elf -march=rv32im -mabi=ilp32 -Os -ffunction-sections -fno-builtin -ffreestanding -nostdlib -Wall -Wno-unused-function -fuse-ld=lld -Wl,-T,tools/cpu/link.ld"
$CC -Ifirmware/src -DENG_AOT=0 -o "$OUT/prof.elf" tools/cpu/prof.c
$CC -Ifirmware/src -DENG_AOT=0 -DNO_PROF -o "$OUT/plain.elf" tools/cpu/prof.c
$CC -Ifirmware/src -DENG_AOT=1 -DNO_PROF -o "$OUT/aot.elf" tools/cpu/prof.c
for f in engine.c engine.h defs.h dsp_tables.h presets.h; do git show "b907693:firmware/src/$f" > "$OUT/old/$f"; done
$CC -I"$OUT/old" -DNO_PROF -DOLD_PRESET -w -o "$OUT/old.elf" tools/cpu/prof.c
$CC -o "$OUT/bench.elf" tools/cpu/bench.c
