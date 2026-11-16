#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The floor sweep (#969): every module that can ring, struck once and then left silent for 10 s (web/scripts/floor-kits.ts),
# rendered by the C engine on the host. A kit fails when the C output's last second holds at or above -120 dBFS rms while
# the reference engine's is 10 dB or more below it: fixed-point rounding keeping a quiet ring going (host_test,
# HOST_TEST_FLOOR). tools/floor_known.txt lists the floors known and not yet fixed; one listed that is clear now fails
# too, so its line gets deleted with its fix.
#   tools/floor_test.sh
set -e
cd "$(dirname "$0")/.."
rm -rf build/floor
(cd web && npx vite-node scripts/floor-kits.ts)
mkdir -p build
gcc -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-result -o build/floor_host_test firmware/test/host_test.c -lm -lpthread
known="$(grep -v '^#' tools/floor_known.txt | awk 'NF {print $1}')"
fail=0
for p in build/floor/*.m1p; do
  n="${p%.m1p}"; k="$(basename "$n")"
  set +e
  out="$(HOST_TEST_FLOOR=1 build/floor_host_test "$p" "$n.ev" "$n.f32" | grep '^tail:')"; rc=$?
  set -e
  [ -n "$out" ] || { echo "FAIL $k: no tail line"; fail=1; continue; }
  if echo "$known" | grep -qx "$k"; then
    case "$out" in
      *FLOOR) echo "known $k: $out" ;;
      *) echo "FAIL $k: clear now, delete its line in tools/floor_known.txt ($out)"; fail=1 ;;
    esac
  else
    case "$out" in
      *FLOOR) echo "FAIL $k: $out"; fail=1 ;;
      *) echo "ok   $k: $out" ;;
    esac
  fi
done
exit $fail
