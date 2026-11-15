#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The pattern store (firmware/src/patstore.c, #901) and the bank's hand-over of its sectors (slotstore.c pt_claim) on the
# host over a simulated NOR flash, with a power cut at every byte: firmware/test/patstore_test.c.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O2 -Wall -Wextra -Wno-unused-function -o build/patstore_test firmware/test/patstore_test.c
build/patstore_test
