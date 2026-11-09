#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Is the C engine's output unchanged? Renders every golden kit (build/golden, made by tools/golden.sh) and every factory
# patch (firmware/test/exact_factory.c) with the engine of git revision BASE and with the working tree's, and compares the
# two outputs sample for sample (for optimizations that must not change a single bit).
#   tools/engine_exact.sh [BASE]        (default HEAD)
set -e
cd "$(dirname "$0")/.."
BASE="${1:-HEAD}"
T=build/exact
rm -rf "$T" && mkdir -p "$T/base/src" "$T/base/test" "$T/out"
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts)
for f in $(git ls-tree --name-only "$BASE" firmware/src/); do git show "$BASE:$f" > "$T/base/src/$(basename "$f")"; done
cp firmware/test/host_test.c firmware/test/lanes_host.h "$T/base/test/"
gcc -O1 -w -o "$T/base_test" "$T/base/test/host_test.c" -lm -lpthread
gcc -O1 -w -o "$T/new_test" firmware/test/host_test.c -lm -lpthread
# (#800) the working tree's engine once more with every signal buffer filled with noise outside its value's life (ENG_POISON):
# a module that read a buffer before writing it, or after its last reader, would change the output (an older engine has no hooks)
gcc -O1 -w -DENG_POISON -o "$T/poison_test" firmware/test/host_test.c -lm -lpthread
gcc -O1 -w -o "$T/exact_test" firmware/test/exact_test.c -lm
"$T/exact_test" || exit 1                 # the division-free helpers against the divisions they replace
fail=0 n=0
for p in build/golden/*.m1p; do
  k="${p%.m1p}"; b="$(basename "$k")"
  if ! HOST_TEST_DUMP="$T/out/$b.base" "$T/base_test" "$p" "$k.ev" "$k.f32" 2>&1 > /dev/null | grep -q "eng_load failed"; then :
  else echo "new  $b (BASE does not load it: nothing to compare)"; continue; fi
  HOST_TEST_DUMP="$T/out/$b.new" "$T/new_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  n=$((n + 1))
  if ! cmp -s "$T/out/$b.base" "$T/out/$b.new"; then echo "DIFFERS $b"; fail=1; fi
  HOST_TEST_DUMP="$T/out/$b.poison" "$T/poison_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  if ! cmp -s "$T/out/$b.base" "$T/out/$b.poison"; then echo "DIFFERS $b (buffers poisoned outside their life)"; fail=1; fi
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
# Every factory patch, the working tree's set for both engines (#781: the kits hold none of them).
cp firmware/src/presets.h "$T/base/src/presets.h"
cp firmware/test/exact_factory.c "$T/base/test/"
gcc -O1 -w -o "$T/base_factory" "$T/base/test/exact_factory.c" -lm -lpthread
gcc -O1 -w -o "$T/new_factory" firmware/test/exact_factory.c -lm -lpthread
gcc -O1 -w -DENG_POISON -o "$T/poison_factory" firmware/test/exact_factory.c -lm -lpthread
"$T/base_factory" > "$T/out/factory.base"
"$T/new_factory" > "$T/out/factory.new"
"$T/poison_factory" > "$T/out/factory.poison"
for o in new poison; do
  if ! cmp -s "$T/out/factory.base" "$T/out/factory.$o"; then
      diff "$T/out/factory.base" "$T/out/factory.$o" | sed -n "s/^> /DIFFERS ($o) factory patch /p"; fail=1
  fi
done
[ $fail = 0 ] && echo "all $n kits, the transition checks and the $(wc -l < "$T/out/factory.new" | tr -d ' ') factory patches bit-identical to $BASE (also with the buffers poisoned outside their life)"
exit $fail
