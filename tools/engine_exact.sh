#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Is the C engine's output unchanged? Renders every golden kit (build/golden, made by tools/golden.sh) with the engine
# of git revision BASE and with the working tree's, and compares the two outputs sample for sample (for optimizations
# that must not change a single bit).
#   tools/engine_exact.sh [BASE]        (default HEAD)
set -e
cd "$(dirname "$0")/.."
BASE="${1:-HEAD}"
T=build/exact
rm -rf "$T" && mkdir -p "$T/base/src" "$T/base/test" "$T/out"
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts)
for f in $(git ls-tree --name-only "$BASE" firmware/src/); do git show "$BASE:$f" > "$T/base/src/$(basename "$f")"; done
cp firmware/test/host_test.c "$T/base/test/"
gcc -O1 -w -o "$T/base_test" "$T/base/test/host_test.c" -lm
gcc -O1 -w -o "$T/new_test" firmware/test/host_test.c -lm
gcc -O1 -w -o "$T/exact_test" firmware/test/exact_test.c -lm
"$T/exact_test" || exit 1                 # the division-free helpers against the divisions they replace
fail=0 n=0
for p in build/golden/*.m1p; do
  k="${p%.m1p}"; b="$(basename "$k")"
  HOST_TEST_DUMP="$T/out/$b.base" "$T/base_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  HOST_TEST_DUMP="$T/out/$b.new" "$T/new_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  n=$((n + 1))
  if ! cmp -s "$T/out/$b.base" "$T/out/$b.new"; then echo "DIFFERS $b"; fail=1; fi
done
# Changing modes exercises retained oscillator state; partial blocks and idle/wake exercise shared-input means.
gcc -O1 -w -I"$T/base/src" -o "$T/base_transition" firmware/test/exact_transition.c -lm
gcc -O1 -w -Ifirmware/src -o "$T/new_transition" firmware/test/exact_transition.c -lm
for b in fm-2op simple-fm poly-feedback poly-shared part-flaws side-input-fanout; do
    [ -f "build/golden/$b.m1p" ] || continue
    "$T/base_transition" "build/golden/$b.m1p" > "$T/out/$b.transitions.base"
    "$T/new_transition" "build/golden/$b.m1p" > "$T/out/$b.transitions.new"
    if ! cmp -s "$T/out/$b.transitions.base" "$T/out/$b.transitions.new"; then
        echo "DIFFERS $b transitions"; fail=1
    fi
done
[ $fail = 0 ] && echo "all $n kits and transition checks bit-identical to $BASE"
exit $fail
