#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Focused factory pattern selection, saved binary, range mutation and malformed provenance checks.
set -eu
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT HUP INT TERM
for test in preset_pattern_test preset_pattern_panel_test; do
    if [ "$test" = preset_pattern_panel_test ]; then
        cc -O1 -w -o "$T/$test" "firmware/test/$test.c" firmware/test/preset_pattern_proto_bridge.c -lm
    else
        cc -O1 -w -o "$T/$test" "firmware/test/$test.c" -lm
    fi
    "$T/$test"
done
