#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The two-core plan is the same with and without its record of each copy's waits (engine.c sched_build, #1073): every
# factory patch (firmware/test/sched_dump.c), every golden kit (build/golden, tools/golden.sh) and each patch binary given,
# planned by the default build and by one that finds the waits again in every pass (-DENG_SCH_NORECORD, as when the arena
# has no room for the record), item by item with what each item waits for.
#   tools/sched_record.sh [PATCH.bin ..]
set -e
cd "$(dirname "$0")/.."
T=build/sched-record
rm -rf "$T" && mkdir -p "$T"
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts)
gcc -O1 -w -o "$T/record" firmware/test/sched_dump.c -lm -lpthread
gcc -O1 -w -DENG_SCH_NORECORD -o "$T/norecord" firmware/test/sched_dump.c -lm -lpthread
"$T/record" build/golden/*.m1p "$@" > "$T/record.txt"
"$T/norecord" build/golden/*.m1p "$@" > "$T/norecord.txt"
n=$(wc -l < "$T/record.txt")
on=$(grep -c '|1|' "$T/record.txt" || true)
if cmp -s "$T/record.txt" "$T/norecord.txt"; then
  echo "all $n patches planned alike with and without the wait record ($on with a schedule)"
else
  diff "$T/record.txt" "$T/norecord.txt" | head -20
  echo "PLANS DIFFER (see $T)"
  exit 1
fi
