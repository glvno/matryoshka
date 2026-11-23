#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The palette's preset writer (#1196; firmware/src/pages_ui.c pal_capture, pal_presets_into) against the panel's PRESET
# turn on the same patch, over the panel fixtures and the real protocol writer: firmware/test/pal_preset_test.c.
set -eu
cd "$(dirname "$0")/.."
(cd web && npx vite-node scripts/golden.ts --panel-fixtures)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT HUP INT TERM
cc -O1 -w -o "$T/pal_preset_test" firmware/test/pal_preset_test.c firmware/test/preset_pattern_proto_bridge.c -lm
"$T/pal_preset_test"
