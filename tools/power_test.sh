#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The stock V15 supply setup (firmware/hal/fm1_power.h, Melodee's, issue #735) on the host: firmware/test/power_test.c.
# The stock transaction trace from a cold and a warm start, every transfer timing out, wrong read-backs.
#   tools/power_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
$CC -O1 -Wall -Wextra -o build/power_test firmware/test/power_test.c
build/power_test
