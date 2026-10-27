#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Do patches saved in an older patch format still play the same on today's firmware? Builds the golden kits (every factory
# patch among them) with the encoder of git revision BASE, an earlier release, and then:
#   1. renders each of those older binaries with BASE's C engine and with the working tree's, and compares the two
#      outputs sample for sample (today's engine reads an older record with its format's parameter count, eng_npar, and
#      gives the parameters added since their defaults);
#   2. proto_test --old: each older binary passes m1_valid, and eng_upgrade (m1_set_current) turns it into a valid binary of
#      today's format that renders bit-identically to the older one, and counts how many come out byte for byte as
#      today's encoder writes the same kit (build/golden, from tools/golden.sh).
#   tools/old_format.sh [BASE]        (default v1.4.1, the last release with patch format 34)
set -e
cd "$(dirname "$0")/.."
BASE="${1:-v1.4.1}"
T=build/oldfmt
rm -rf "$T" && mkdir -p "$T/base" "$T/out"
git archive "$BASE" web firmware | tar -x -C "$T/base"
ln -s "$PWD/web/node_modules" "$T/base/web/node_modules"
(cd "$T/base/web" && npx vite-node scripts/golden.ts) > /dev/null       # the older binaries: $T/base/build/golden
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts) > /dev/null
gcc -O1 -w -o "$T/base_test" "$T/base/firmware/test/host_test.c" -lm
gcc -O1 -w -o "$T/new_test" firmware/test/host_test.c -lm
gcc -O1 -w -o "$T/proto_test" firmware/test/proto_test.c -lm
fail=0 n=0 pairs=""
for p in "$T"/base/build/golden/*.m1p; do
  k="${p%.m1p}"; b="$(basename "$k")"
  HOST_TEST_DUMP="$T/out/$b.base" "$T/base_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  HOST_TEST_DUMP="$T/out/$b.new" "$T/new_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  n=$((n + 1))
  if [ ! -s "$T/out/$b.base" ] || ! cmp -s "$T/out/$b.base" "$T/out/$b.new"; then echo "DIFFERS $b"; fail=1; fi
  new="build/golden/$b.m1p"; [ -f "$new" ] || new=-
  pairs="$pairs $p $new"
done
[ $fail = 0 ] && echo "all $n older binaries ($BASE) render bit-identically with today's engine"
# shellcheck disable=SC2086
"$T/proto_test" --old $pairs || fail=1
exit $fail
