#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the master-FX Delay / Reverb OFF tails (firmware/test/fx_tail_test.c, D-1100): a tail survives one
# silent window, a quiet one ends to exact dry / zero, an audible one never ends, and the spread clear finishes.
#   tools/fx_tail_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -std=c11 -O1 -Ifirmware/src -o build/fx_tail_test firmware/test/fx_tail_test.c -lm
build/fx_tail_test
