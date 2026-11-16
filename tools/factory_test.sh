#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The factory region (#915, firmware/src/factory.c) on the host: firmware/test/factory_test.c (today's image against
# presets.h, the safety set, the link's install and its refusals, a power cut after every byte, the update loader's record
# sweep).
#   tools/factory_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O2 -Wall -Wextra -Wno-unused-function -o build/factory_test firmware/test/factory_test.c
build/factory_test
