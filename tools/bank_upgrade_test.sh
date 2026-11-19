#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Factory updates reach untouched slots (firmware/src/bank_upgrade.h, D-887) on the host: firmware/test/bank_upgrade_test.c
# (the bank over RAM NOR, the firmware tier and the factory region merged, a power cut after every byte).
#   tools/bank_upgrade_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O2 -Wall -Wextra -Wno-unused-function -o build/bank_upgrade_test firmware/test/bank_upgrade_test.c
build/bank_upgrade_test
