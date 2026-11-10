#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Focused factory pattern selection, saved binary, range mutation and malformed provenance checks.
set -eu
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT HUP INT TERM
for test in preset_pattern_test preset_pattern_panel_test; do
    cc -O1 -w -o "$T/$test" "firmware/test/$test.c" -lm
    "$T/$test"
done
