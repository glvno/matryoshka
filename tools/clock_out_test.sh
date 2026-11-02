#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# MIDI clock out (#473, firmware/src/clock_out.h) on the host: the ticks counted and timed against the tempo
# (firmware/test/clock_out_test.c).
#   tools/clock_out_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -o build/clock_out_test firmware/test/clock_out_test.c
build/clock_out_test
