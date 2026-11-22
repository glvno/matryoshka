#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The palette (#1196) on the host: its record (firmware/src/pal_store.h) over a simulated NOR flash, the device's
# palette.c (switch, load, save, the link's PALETTE command) and the link's shared test vectors: firmware/test/palette_test.c.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
gcc -O1 -Wall -Wextra -Wno-unused-function -o build/palette_test firmware/test/palette_test.c
build/palette_test
