#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The key scan (firmware/hal/fm1_input.h) on the host, against a model of the 595 chain, the matrix and the rows' slow rise:
# firmware/test/input_test.c. Every button held alone reads as itself, also when a split dim pulse's end comes late.
#   tools/input_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
$CC -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -o build/input_test firmware/test/input_test.c
build/input_test
