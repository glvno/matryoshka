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
#   tools/old_format.sh [BASE]
# BASE defaults to the last firmware release, so a run reports only what changed since then: the newest release tag not
# newer than this tree's version (web/package.json), or, for a web-only release, the release whose firmware package it
# bundles (firmware_product, FM-1_7MMmmpp, in its qualification record), because a web-only tag's firmware source is not
# what it ships (D-1160). Release tags sit on release branches, outside main's history, so git describe does not find
# them (from main it found v1.20.2). At a patch format change, also run tools/old_format.sh v1.4.1, the last release with
# patch format 34 (D-250 in docs/ledger/patch-format.md).
# A kit that tools/old_format_known.txt lists for BASE renders differently on purpose: it reads "DIFFERS (known)" and does
# not fail the check. Any other difference fails it.
set -e
cd "$(dirname "$0")/.."
last_firmware_release() {
  v=$(sed -n 's/^ *"version": *"\([0-9.]*\)".*/\1/p' web/package.json)
  tag=$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | awk -F. -v v="$v" '
    BEGIN { split(v, w, "."); lim = (w[1] * 1000 + w[2]) * 1000 + w[3] }
    { n = (substr($1, 2) * 1000 + $2) * 1000 + $3; if (n <= lim && n > best) { best = n; t = $0 } }
    END { print t }')
  fw=$(sed -n 's/^ *"firmware_product": *"FM-1_7\([0-9][0-9]\)\([0-9][0-9]\)\([0-9][0-9]\)".*/\1 \2 \3/p' \
    "release/qualification/$tag.json" 2>/dev/null | awk '{ printf "v%d.%d.%d\n", $1, $2, $3 }')
  echo "${fw:-$tag}"
}
BASE="${1:-$(last_firmware_release)}"
echo "BASE $BASE"
T=build/oldfmt
rm -rf "$T" && mkdir -p "$T/base" "$T/out"
git archive "$BASE" web firmware | tar -x -C "$T/base"
ln -s "$PWD/web/node_modules" "$T/base/web/node_modules"
(cd "$T/base/web" && npx vite-node scripts/golden.ts) > /dev/null       # the older binaries: $T/base/build/golden
[ -d build/golden ] || (cd web && npx vite-node scripts/golden.ts) > /dev/null
gcc -O1 -w -o "$T/base_test" "$T/base/firmware/test/host_test.c" -lm
gcc -O1 -w -o "$T/new_test" firmware/test/host_test.c -lm -lpthread
gcc -O1 -w -o "$T/proto_test" firmware/test/proto_test.c -lm
KNOWN=tools/old_format_known.txt
known() { grep -v '^#' "$KNOWN" | grep -qx "$BASE $1"; }
fail=0 n=0 nk=0 nm=0 pairs=""
for p in "$T"/base/build/golden/*.m1p; do
  k="${p%.m1p}"; b="$(basename "$k")"
  HOST_TEST_DUMP="$T/out/$b.base" "$T/base_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  HOST_TEST_DUMP="$T/out/$b.new" "$T/new_test" "$p" "$k.ev" "$k.f32" > /dev/null || true
  n=$((n + 1))
  if [ ! -s "$T/out/$b.base" ]; then echo "DIFFERS $b (no output from $BASE)"; fail=1
  elif ! cmp -s "$T/out/$b.base" "$T/out/$b.new"; then
    if known "$b"; then echo "DIFFERS (known) $b"; nk=$((nk + 1)); else echo "DIFFERS $b"; fail=1; fi
  elif known "$b"; then echo "listed in $KNOWN but renders the same again: $b"
  fi
  # (#1067) the same binary with a MIDI mapping section after it, as MIDI learn on the FM-1 writes into a copy of any
  # format: BASE's engine ignores the bytes and plays it as without them
  if "$T/proto_test" --add-map "$p" "$T/out/$b.m1p"; then
    HOST_TEST_DUMP="$T/out/$b.mapped" "$T/base_test" "$T/out/$b.m1p" "$k.ev" "$k.f32" > /dev/null || true
    if [ -s "$T/out/$b.base" ] && cmp -s "$T/out/$b.base" "$T/out/$b.mapped"; then nm=$((nm + 1)); else echo "DIFFERS $b with a MIDI mapping section after it ($BASE)"; fail=1; fi
  fi
  new="build/golden/$b.m1p"; [ -f "$new" ] || new=-
  pairs="$pairs $p $new"
done
if [ $fail = 0 ]; then
  if [ $nk = 0 ]; then echo "all $n older binaries ($BASE) render bit-identically with today's engine"
  else echo "all $n older binaries ($BASE) render bit-identically with today's engine, except $nk known, intended differences ($KNOWN)"; fi
fi
echo "$nm older binaries with a MIDI mapping section after them render with $BASE's engine as without it"
# shellcheck disable=SC2086
"$T/proto_test" --old $pairs || fail=1
exit $fail
