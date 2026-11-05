#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# A factory patch new in this firmware, placed after an update (#630, firmware/src/bank_new.h), on the host:
# firmware/test/bank_new_test.c.
#   tools/bank_new_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -o build/bank_new_test firmware/test/bank_new_test.c
build/bank_new_test
