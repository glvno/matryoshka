#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Is the C engine's output unchanged? Renders every golden kit (build/golden, made by tools/golden.sh) with the engine
# of git revision BASE and with the working tree's, and compares the two outputs sample for sample (for optimizations
# that must not change a single bit).
#   tools/engine_exact.sh [BASE]        (default HEAD; M1_VOICES=4 for the four-voice build)
set -e
cd "$(dirname "$0")/.."
BASE="${1:-HEAD}"
CF="${M1_VOICES:+-DENG_VOICES=$M1_VOICES}"
T=build/exact
rm -rf "$T" && mkdir -p "$T/base/src" "$T/base/test" "$T/out"
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts)
for f in $(git ls-tree --name-only "$BASE" firmware/src/); do git show "$BASE:$f" > "$T/base/src/$(basename "$f")"; done
cp firmware/test/host_test.c "$T/base/test/"
gcc -O1 -w $CF -o "$T/base_test" "$T/base/test/host_test.c" -lm
gcc -O1 -w $CF -o "$T/new_test" firmware/test/host_test.c -lm
fail=0 n=0
for p in build/golden/*.m1p; do
  k="${p%.m1p}"; b="$(basename "$k")"
  if [ "$M1_VOICES" = 4 ] && [ "$b" = grain ]; then continue; fi
  HOST_TEST_DUMP="$T/out/$b.base" "$T/base_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  HOST_TEST_DUMP="$T/out/$b.new" "$T/new_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  n=$((n + 1))
  if ! cmp -s "$T/out/$b.base" "$T/out/$b.new"; then echo "DIFFERS $b"; fail=1; fi
done
[ $fail = 0 ] && echo "all $n kits bit-identical to $BASE"
exit $fail
