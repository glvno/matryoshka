#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the device test mode's output meter (TEST_PEAK, firmware/src/test_peak.h, #385): the audio ISR landing
# between any two of the reader's steps loses no half and reports none twice or late (firmware/test/peak_test.c).
#   tools/peak_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-parameter -o build/peak_test firmware/test/peak_test.c
build/peak_test
