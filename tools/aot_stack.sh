#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Check the built firmware against core 1's guarded stack while Oracle V starts and plays four/eight notes.
# The emulator's ordinary runs do not enforce this hardware limit. Use the matching bin and ELF from CI:
#   tools/aot_stack.sh BIN ELF
# Build m1emu first (tools/emu/isa_fix.sh); M1EMU may name an already built harness.
set -eu
cd "$(dirname "$0")/.."
[ "$#" -eq 2 ] || { echo 'usage: tools/aot_stack.sh BIN ELF' >&2; exit 2; }
BIN=$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$1")
ELF=$2
EMU=$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${M1EMU:-tools/emu/target/release/m1emu}")
[ -x "$EMU" ] || { echo "build m1emu first: $EMU" >&2; exit 2; }
SYMS=$(nm "$ELF")
addr() { printf '%s\n' "$SYMS" | awk -v s="$1" '$3 == s { print $1 }'; }
LOW=$(addr _c1_ustack); ON=$(addr fm1_c1_on); GAVE=$(addr fm1_c1_gave_up); PASS=$(addr c1_pass); FAIL=$(addr c1_fail)
[ -n "$LOW" ] && [ -n "$ON" ] && [ -n "$GAVE" ] && [ -n "$PASS" ] && [ -n "$FAIL" ] || { echo 'missing core-1 symbols' >&2; exit 2; }
word() { printf '%x' "$((0x$1 & ~3))"; }
mkdir -p build
OUTDIR=$(mktemp -d build/aot-stack.XXXXXX)
trap 'rm -rf "$OUTDIR"' EXIT
rc=0
OUT=$(cd "$OUTDIR" && M1EMU_C1_STACK_LOW=$(printf '%x' "$((0x$LOW + 256))") "$EMU" run "$BIN" --ms 10000 \
  --keys '3000:m903c64,3000:m904064,3000:m904364,3000:m904764,7000:m904864,7000:m904c64,7000:m904f64,7000:m905364' \
  --peek "$(word "$ON"),$(word "$GAVE"),$PASS,$FAIL" 2>&1) || rc=$?
printf '%s\n' "$OUT"
[ "$rc" -eq 0 ] || exit "$rc"
python3 - "$OUT" "$ON" "$GAVE" "$PASS" "$FAIL" <<'PY'
import re,sys
out=sys.argv[1]
on,gave,passed,failed=(int(x,16) for x in sys.argv[2:])
w={int(a,16):int(v,16) for a,v in re.findall(r'peek 0x([0-9a-f]+) = 0x([0-9a-f]+)',out)}
byte=lambda a:(w[a & ~3] >> (8*(a & 3))) & 255
assert byte(on)==1 and byte(gave)==0 and w[passed]>0 and w[failed]==0, 'core 1 did not stay healthy'
print('core 1 stack check: PASS; two cores, no failed self-tests or fallback')
PY
