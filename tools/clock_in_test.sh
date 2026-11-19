#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# MIDI clock in (D-452, #870, firmware/src/clock_in.h) on the host: a looper's clock with stalls, bursts and restarts, and the
# Steps tracks on its ticks (firmware/test/clock_in_test.c).
#   tools/clock_in_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -o build/clock_in_test firmware/test/clock_in_test.c
build/clock_in_test
