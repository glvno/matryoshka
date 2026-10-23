#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The preset store (firmware/src/presetstore.c, #194) on the host over a simulated NOR flash: firmware/test/preset_test.c.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
gcc -O1 -Wall -Wextra -Wno-unused-function -o build/preset_test firmware/test/preset_test.c
build/preset_test
