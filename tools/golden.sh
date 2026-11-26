#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Compare the C engine (firmware/src/engine.c, built for the host) with the TypeScript engine on golden vectors.
#   tools/golden.sh [REL_RMS]      (default: error rms <= 5 % of the reference rms; run inside `nix develop`)
# The metric is rms, not max: waveforms with edges (saw, square) shift by a fraction of a sample between the float
# reference and the Q16 pitch grid, which gives short spikes at the edges but no audible difference.
set -e
cd "$(dirname "$0")/.."
TOL="${1:-0.05}"
CF=""
rm -rf build/golden                          # (kits that are gone must not be compared from an old run)
(cd web && npx vite-node scripts/golden.ts)
mkdir -p build
gcc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-result $CF -o build/host_test firmware/test/host_test.c -lm -lpthread
gcc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-result $CF -o build/proto_test firmware/test/proto_test.c -lm
gcc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-result $CF -o build/idle_test firmware/test/idle_test.c -lm
fail=0
build/idle_test build/golden/idle-stagger.m1p build/golden/idle-stagger.ev || fail=1
build/proto_test build/golden/acid.m1p build/golden/proto.syx $(cat build/golden/proto.args) build/golden/proto-slot.syx build/golden/steps-kit.m1p build/golden/proto-sandbox.syx build/golden/steps-patterns.m1p build/golden/steps-song.m1p build/golden/steps-locks.m1p || fail=1
build/proto_test --grow build/golden/*-counted.m1p build/golden/*-slim.m1p build/golden/arm-wide*.m1p || fail=1   # (the FM-1's edits of a counted copy, format 51 and 64, and of format 67's wide member counts: grown in place, D-1005)
build/proto_test --maps build/golden/midi-learn.m1p build/golden/acid.m1p || fail=1   # (#1067: the MIDI mapping section, the FM-1's edits of it)
# (D-1025) each format 64 twin in its shorter layout against its counted twin: the same cables per module in the same order,
# panel labels and row names, and the same samples, by proto_test's render and by host_test's with the kit's events
pairs=""
for s in build/golden/*-slim.m1p; do
  c="${s%-slim.m1p}-counted.m1p"
  pairs="$pairs $c $s"
  HOST_TEST_DUMP=build/golden-slim.a build/host_test "$c" "${c%.m1p}.ev" "${c%.m1p}.f32" > /dev/null 2>&1 || true
  HOST_TEST_DUMP=build/golden-slim.b build/host_test "$s" "${c%.m1p}.ev" "${c%.m1p}.f32" > /dev/null 2>&1 || true
  if [ ! -s build/golden-slim.a ] || ! cmp -s build/golden-slim.a build/golden-slim.b; then echo "FAIL $(basename "$s"): renders differently from its counted twin"; fail=1; fi
  rm -f build/golden-slim.a build/golden-slim.b
done
# shellcheck disable=SC2086
build/proto_test --same $pairs || fail=1
# (#1141) the stereo chain renders as its pair of mono chains, sample for sample; every stereo kit renders on two lanes as
# on one (HOST_CORES)
dump() { HOST_CORES="$4" HOST_TEST_DUMP="$1" build/host_test "$2" "${3%.m1p}.ev" "${3%.m1p}.f32" > /dev/null 2>&1 || true; }
dump build/golden-st.a build/golden/stereo-chain.m1p build/golden/stereo-chain.m1p 1
dump build/golden-st.b build/golden/stereo-chain-pair.m1p build/golden/stereo-chain.m1p 1
if [ ! -s build/golden-st.a ] || ! cmp -s build/golden-st.a build/golden-st.b; then echo "FAIL stereo-chain: renders differently from stereo-chain-pair"; fail=1; fi
for p in build/golden/stereo-*.m1p build/golden/fx-drawers-stereo.m1p; do
  dump build/golden-st.a "$p" "$p" 1
  dump build/golden-st.b "$p" "$p" 2
  if [ ! -s build/golden-st.a ] || ! cmp -s build/golden-st.a build/golden-st.b; then echo "FAIL $(basename "$p"): two lanes render differently from one"; fail=1; fi
done
rm -f build/golden-st.a build/golden-st.b
for p in build/golden/*.m1p; do
  n="${p%.m1p}"
  par=""; [ -f "$n.par" ] && par="$n.par"
  out="$(build/host_test "$p" "$n.ev" "$n.f32" $par)" || { echo "FAIL $(basename "$n"): $out"; fail=1; continue; }
  err="$(echo "$out" | sed 's/.*rel_rms \([0-9.]*\).*/\1/')"
  if awk "BEGIN{exit !($err > $TOL)}"; then echo "FAIL $(basename "$n"): $out"; fail=1; else echo "ok   $(basename "$n"): $out"; fi
done
exit $fail
