#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The pattern store's glue (firmware/src/patlink.c, #901) on the host with the store and the bank over RAM flash: the
# payload byte for byte against the editor's vectors (firmware/test/pattern_cases.h, written by `npm run export-defs`),
# format 59's links at load and SAVE, the SEQ page's save and load, and the link commands: firmware/test/patlink_test.c.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -Wno-unused-result -o build/patlink_test firmware/test/patlink_test.c -lm
build/patlink_test
