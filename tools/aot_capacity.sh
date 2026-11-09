#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Generate #808 capacity fixtures, report real engine allocations and verify both sequenced instruments sound.
# Host byte counts model the FM-1; host render speed is not hardware timing. No hardware is touched.
set -eu
cd "$(dirname "$0")/.."
(cd web && npx vite-node scripts/aot-capacity.ts)
for aot in 0 1; do
    cc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -DENG_AOT=$aot \
      firmware/test/aot_capacity.c -lm -o "build/aot-capacity/check-$aot"
    for patch in build/aot-capacity/*.m1p; do
        "build/aot-capacity/check-$aot" "$patch"
    done
done
