#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The render across the FM-1's two cores (#271, #802) is bit-exact: every golden kit (build/golden, tools/golden.sh) and every
# factory patch (firmware/test/exact_factory.c, the working tree's set for both) rendered by the C engine of git revision
# BASE and by the working tree's under every mode of the second core's host double (firmware/test/lanes_host.h): none
# (core 0 alone), 1 (lane 1 deferred to the wait, or rendered by core 0 when it waits for it), 2 (a thread), 2 with random
# delays, 2 with every 7th job lost (core 0 renders that lane); then mode 2 under ThreadSanitizer.
#   tools/lanes_exact.sh [BASE]     (default origin/main; BASE must load the working tree's factory patches)
set -e
cd "$(dirname "$0")/.."
BASE="${1:-origin/main}"
T=build/lanes
rm -rf "$T" && mkdir -p "$T/base/src" "$T/base/test" "$T/out"
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts)
for f in $(git ls-tree --name-only "$BASE" firmware/src/); do git show "$BASE:$f" > "$T/base/src/$(basename "$f")"; done
git show "$BASE:firmware/test/host_test.c" > "$T/base/test/host_test.c"
git show "$BASE:firmware/test/lanes_host.h" > "$T/base/test/lanes_host.h" 2>/dev/null || rm -f "$T/base/test/lanes_host.h"
gcc -O1 -w -o "$T/base_test" "$T/base/test/host_test.c" -lm -lpthread
gcc -O1 -w -o "$T/new_test" firmware/test/host_test.c -lm -lpthread
fail=0 n=0
for p in build/golden/*.m1p; do
  k="${p%.m1p}"; b="$(basename "$k")"
  HOST_TEST_DUMP="$T/out/$b.base" "$T/base_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  for mode in "0" "1" "2" "2 300" "2 0 7"; do
    set -- $mode
    tag="c$1${2:+-x$2}${3:+-l$3}"
    HOST_CORES=$1 HOST_CHAOS=${2:-0} HOST_LOST=${3:--1} HOST_TEST_DUMP="$T/out/$b.$tag" "$T/new_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
    if ! cmp -s "$T/out/$b.base" "$T/out/$b.$tag"; then echo "DIFFERS $b ($tag)"; fail=1; fi
  done
  n=$((n + 1))
done
[ $fail = 0 ] && echo "all $n kits bit-identical to $BASE in every mode (none, deferred, thread, thread with delays, lost jobs)"
cp firmware/src/presets.h "$T/base/src/presets.h"
cp firmware/test/exact_factory.c "$T/base/test/"
[ -f "$T/base/test/lanes_host.h" ] || cp firmware/test/lanes_host.h "$T/base/test/"
gcc -O1 -w -o "$T/base_factory" "$T/base/test/exact_factory.c" -lm -lpthread
gcc -O1 -w -o "$T/new_factory" firmware/test/exact_factory.c -lm -lpthread
"$T/base_factory" > "$T/out/factory.base"
ff=0
for mode in "0" "1" "2" "2 300" "2 0 7"; do
  set -- $mode
  HOST_CORES=$1 HOST_CHAOS=${2:-0} HOST_LOST=${3:--1} "$T/new_factory" > "$T/out/factory.new"
  if ! cmp -s "$T/out/factory.base" "$T/out/factory.new"; then echo "DIFFERS factory patches (mode $mode)"; ff=1; fail=1; fi
done
[ $ff = 0 ] && echo "all $(wc -l < "$T/out/factory.base" | tr -d ' ') factory patches bit-identical to $BASE in every mode"
if [ "${LANES_TSAN:-1}" = 1 ]; then
  if clang -O1 -g -w -fsanitize=thread -o "$T/tsan_test" firmware/test/host_test.c -lm -lpthread 2>/dev/null &&
     clang -O1 -g -w -fsanitize=thread -o "$T/tsan_factory" firmware/test/exact_factory.c -lm -lpthread 2>/dev/null; then
    tf=0
    for p in build/golden/*.m1p; do
      k="${p%.m1p}"
      rc=0
      HOST_CORES=2 HOST_TEST_DUMP=/dev/null TSAN_OPTIONS="halt_on_error=1 exitcode=66" "$T/tsan_test" "$p" "$k.ev" "$k.f32" > "$T/out/tsan.log" 2>&1 || rc=$?
      [ $rc = 66 ] && { echo "RACE $(basename "$k")"; grep -m3 "WARNING\|#0\|#1" "$T/out/tsan.log"; tf=1; fail=1; }
    done
    rc=0
    HOST_CORES=2 TSAN_OPTIONS="halt_on_error=1 exitcode=66" "$T/tsan_factory" > /dev/null 2> "$T/out/tsan.log" || rc=$?
    [ $rc = 66 ] && { echo "RACE in a factory patch"; grep -m3 "WARNING\|#0\|#1" "$T/out/tsan.log"; tf=1; fail=1; }
    [ $tf = 0 ] && echo "ThreadSanitizer: no race in any kit or factory patch (HOST_CORES=2)"
  else
    echo "(ThreadSanitizer not available here: skipped)"
  fi
fi
exit $fail
