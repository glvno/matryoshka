#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Integrated Oracle: exact samples, active public controls, fallback transitions and concurrent workers.
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/aot-oracle
log=build/aot-oracle/exact.log
ENG_AOT_ORACLE=1 AOT_REQUIRE_ORACLE=1 tools/aot_test.sh > "$log" 2>&1 || { tail -40 "$log"; exit 1; }
(cd web && npx vite-node scripts/aot-capacity.ts)
for mode in 0 1 2; do
    AOT_ORACLE_CONTROLS=1 HOST_CORES=$mode HOST_CHAOS=40 build/aot_test --files-only \
      build/aot/oracle-v-plain.m1p >> "$log"
    AOT_ORACLE_FADE=1 AOT_REQUIRE_ORACLE=1 HOST_CORES=$mode build/aot_test --files-only \
      build/aot/oracle-v-plain.m1p >> "$log"
    for voices in 2 3 4; do
        AOT_TRANSPORT=1 AOT_REQUIRE_ORACLE=1 HOST_CORES=$mode HOST_CHAOS=40 build/aot_test --files-only \
          "build/aot-capacity/oracle-$voices-ordered-four-tracks.m1p" >> "$log"
    done
done
tail -2 "$log"
echo "integrated Oracle: exact samples, active controls, fade transitions and four-track workloads passed ($log)"
