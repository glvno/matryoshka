#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The emulator smoke test: the firmware on fm1-emu (tools/emu, `m1emu smoke`), driven through its panel and TRS MIDI,
# judged by its LCD, audio and flash; the factory patches' levels against the web engine (web/scripts/emu-levels.ts).
#   tools/emu_smoke.sh [BIN]     (default build/matryoshka.bin; M1EMU_STRICT=1:
#                                 level differences fail too). Snapshots, a WAV and the levels go to build/emu/.
# Needs cargo and node (npm ci in web/). Also: npm run emu:smoke (finds a firmware the way npm run emu does).
set -e
cd "$(dirname "$0")/.."
BIN="${1:-build/matryoshka.bin}"
mkdir -p build/emu
(cd web && npx vite-node scripts/emu-levels.ts && npx vite-node scripts/emu-patches.ts)
ISA="$(tools/emu/isa_fix.sh)"   # fm1-emu decoder fix (tools/emu/isa_fix.sh)
cargo build --release --quiet --manifest-path tools/emu/Cargo.toml --config "$ISA"
OUT="build/emu/smoke"
rm -rf "$OUT"
exec tools/emu/target/release/m1emu smoke "$BIN" --levels build/emu/levels.txt --out "$OUT" \
  ${M1EMU_STRICT:+--strict}
