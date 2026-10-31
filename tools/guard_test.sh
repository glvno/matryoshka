#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The overload guard's decision (firmware/src/ovl_guard.h, issue #458) on the host: firmware/test/guard_test.c.
#   tools/guard_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
$CC -O1 -Wall -Wextra -o build/guard_test firmware/test/guard_test.c
build/guard_test
