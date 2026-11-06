#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The second core's self-test against the audio interrupt's hand-off (#271): a firmware CI run's build in the emulator
# with a 4-note chord held on the boot patch (Oracle V: its voices split across both cores), and fm1_c1_race_ticks set,
# which waits that long between writing a job and publishing its number (hal/fm1_cpu1.h): an interrupt that comes in that
# window and hands its own job over must not make the self-test fail. Reads back, at the end: the second core on,
# gave_up (4: the self-test's answer was wrong), the self-tests passed and failed. Exit code 1 when core 1 was given up.
#   tools/c1_race.sh RUN [TICKS]        (TICKS of TIMER4, 24 a microsecond; default 2400 = 100 us)
set -e
cd "$(dirname "$0")/.."
RUN="$1"; TICKS="${2:-2400}"
[ -n "$RUN" ] || { echo "usage: tools/c1_race.sh RUN [TICKS]"; exit 2; }
D="build/flash/$RUN"
mkdir -p "$D/elf"
[ -f "$D/matryoshka.bin" ] || gh run download "$RUN" -R glvno/matryoshka -n matryoshka-firmware -D "$D"
[ -f "$D/elf/matryoshka.elf" ] || gh run download "$RUN" -R glvno/matryoshka -n matryoshka-elf -D "$D/elf"
addr() { nm "$D/elf/matryoshka.elf" | awk -v s="$1" '$3 == s { print $1 }'; }
RACE=$(addr fm1_c1_race_ticks); ON=$(addr fm1_c1_on); GAVE=$(addr fm1_c1_gave_up); PASS=$(addr c1_pass); FAIL=$(addr c1_fail)
[ -n "$RACE" ] || { echo "run $RUN has no fm1_c1_race_ticks (a build from before the test hook)"; exit 2; }
ISA="$(tools/emu/isa_fix.sh)"
cargo build --quiet --release --manifest-path tools/emu/Cargo.toml --config "$ISA"
word() { printf '%x' $(( 0x$1 & ~3 )); }
OUT=$(tools/emu/target/release/m1emu run "$D/matryoshka.bin" --ms 12000 \
  --keys "3000:m903c64,3000:m904064,3000:m904364,3000:m904764" \
  --poke "$RACE=$(printf '%x' "$TICKS")@4000" \
  --peek "$(word $ON),$(word $GAVE),$PASS,$FAIL" 2>&1)
echo "$OUT" | grep -E "emulated|peek" 
python3 - "$OUT" "$ON" "$GAVE" <<'PY'
import re, sys
out, on, gave = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16)
pk = {int(a, 16): int(v, 16) for a, v in re.findall(r"peek 0x([0-9a-f]+) = 0x([0-9a-f]+)", out)}
byte = lambda a: (pk[a & ~3] >> (8 * (a & 3))) & 0xFF
c1_on, c1_gave = byte(on), byte(gave)
vals = list(pk.values())
print(f"core 1 on {c1_on}, gave_up {c1_gave}; self-tests passed {vals[-2]}, failed {vals[-1]}")
sys.exit(0 if c1_on == 1 and c1_gave == 0 else 1)
PY
