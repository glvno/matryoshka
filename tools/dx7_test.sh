#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The DX7 module's voice (#1338, firmware/src/dx7.h) on the host: its 32 algorithms against the DX7's OPS chip ROM
# (algorithms 4 and 6's loops too), unpacking, and the corpus's hashes that web/src/dx7.test.ts shares
# (firmware/test/dx7_test.c). DX7_WRITE=1 rewrites firmware/test/dx7_hashes.h.
#   tools/dx7_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -o build/dx7_test firmware/test/dx7_test.c
build/dx7_test
