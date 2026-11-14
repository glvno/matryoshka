#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The compiled factory assemblies (#808, firmware/src/aot.c) against the interpreter, in one build (firmware/test/aot_test.c):
# every factory patch and the patches of web/scripts/aot-kits.ts, played and with every parameter moved, sample for sample;
# with no second core, with the lanes run inline in the other order, and with the second core as a thread.
#   tools/aot_test.sh
set -e
cd "$(dirname "$0")/.."
(cd web && npx vite-node scripts/aot-kits.ts)
mkdir -p build
gcc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-result -o build/aot_test firmware/test/aot_test.c -lm -lpthread
fail=0
for c in 0 1 2; do
  HOST_CORES=$c build/aot_test build/aot/*.m1p > build/aot_test.$c.txt || fail=1
  grep -v "0 compiled instances" build/aot_test.$c.txt | sed "s/^/cores $c: /"
done
# it must have run compiled where it can, and fallen back where it must
expect() { grep -Eq "$1" build/aot_test.0.txt || { echo "aot: expected '$1'"; fail=1; }; }
expect "^oracle-v-plain.m1p +fuzzed, 1 compiled instance$"
expect "^oracle-v-twice.m1p +fuzzed, 2 compiled instances$"
expect "^oracle-v-drums.m1p +fuzzed, 1 compiled instance$"
expect "^oracle-v-morph.m1p +fuzzed, 1 compiled instance$"
expect "^oracle-v-outside.m1p +fuzzed, 0 compiled instances$"
exit $fail
