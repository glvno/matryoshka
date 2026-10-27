#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The panel core (firmware/src/panel.c) driven on the host with no HAL: firmware/test/panel_test.c.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
(cd web && npx vite-node scripts/golden.ts --panel-fixtures)
gcc -O1 -Wall -Wno-unused-function -Wno-unused-result -Wno-macro-redefined -o build/panel_test firmware/test/panel_test.c
build/panel_test
# MIDI must reach the engine between the same LCD transfers, including direct octave-message draws (#363).
gcc -O1 -Wall -Wno-unused-function -Wno-unused-variable -Wno-macro-redefined -Wno-int-to-pointer-cast -o build/midi_redraw_test firmware/test/midi_redraw_test.c
build/midi_redraw_test
