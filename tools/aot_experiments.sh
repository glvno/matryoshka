#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Independent fusion and reduced-drum experiments: exact output and actual compiled-instance counts.
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/aot-experiments
(cd web && npx vite-node scripts/aot-capacity.ts)
for flags in '1 0 0' '0 1 0' '1 1 0' '0 1 1' '1 1 1'; do
    set -- $flags
    fuse=$1; drums=$2; pair=$3
    log="build/aot-experiments/fuse-$fuse-drums-$drums-pair-$pair.log"
    ENG_AOT_FUSE=$fuse ENG_AOT_DRUMS=$drums ENG_AOT_PAIR=$pair tools/aot_test.sh > "$log" 2>&1 || { tail -40 "$log"; exit 1; }
    tail -1 "$log"
    cc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -DENG_AOT=1 \
      -DENG_AOT_FUSE=$fuse -DENG_AOT_DRUMS=$drums -DENG_AOT_PAIR=$pair firmware/test/aot_capacity.c -lm -o build/aot-experiments/capacity
    expected=1; [ "$drums" = 0 ] || expected=4
    for family in three-drums ordered-four-tracks; do
        for voices in 2 3 4; do
            patch="build/aot-capacity/oracle-$voices-$family.m1p"
            AOT_TRANSPORT=1 HOST_CORES=2 build/aot_test --files-only "$patch" >> "$log"
            build/aot-experiments/capacity "$patch" "$expected" >> "$log"
            if [ "$family" = ordered-four-tracks ]; then
                for track in 0 1 2 3; do
                    build/aot-experiments/capacity "$patch" "$expected" "$track" >> "$log"
                done
            fi
        done
    done
    if [ "$pair" = 1 ]; then
        for mode in 1 2; do
            AOT_TRANSPORT=1 AOT_REQUIRE_PAIR=1 HOST_CORES=$mode HOST_CHAOS=40 \
              build/aot_test --files-only build/aot-capacity/oracle-2-ordered-four-tracks.m1p >> "$log"
        done
        AOT_TRANSPORT=1 AOT_REQUIRE_PAIR=1 AOT_LOST_PAIR=1 HOST_CORES=2 \
          build/aot_test --files-only build/aot-capacity/oracle-2-ordered-four-tracks.m1p >> "$log"
    fi
    # The original ordering deliberately falls back for the two drums spanning a Steps barrier.
    expected=1; [ "$drums" = 0 ] || expected=2
    build/aot-experiments/capacity build/aot-capacity/oracle-2-four-tracks.m1p "$expected" >> "$log"
    echo "fusion=$fuse drums=$drums pair=$pair: exact output, compiled counts and solo tracks passed ($log)"
done
