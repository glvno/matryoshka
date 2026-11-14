#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Do the host harnesses that no other check builds still compile against firmware/src? Syntax-only, with the flags their
# runners use (tools/engine_exact.sh, tools/aot_capacity.sh, tools/fm1_sim/build.sh); their inputs (golden kits, capacity
# fixtures) are not needed to compile. Then runs the division-free helper check (firmware/test/exact_test.c) on a few cases.
#   tools/harness_compile_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
for h in transition reverb filter filter_outputs chorus control pd steps factory; do
    $CC -O1 -w -Ifirmware/src -fsyntax-only "firmware/test/exact_$h.c"
done
for aot in 0 1; do
    $CC -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -DENG_AOT=$aot -fsyntax-only firmware/test/aot_capacity.c
done
$CC -O1 -w -fsyntax-only firmware/test/fm1_sim.c
$CC -O1 -w -o build/exact_test firmware/test/exact_test.c -lm
build/exact_test 2000000
echo "harness-compile: all harnesses compile"
