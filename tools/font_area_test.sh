#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The font area (#602, firmware/src/font_area.c) on the host: firmware/test/font_area_test.c (today's image against
# font_bc.h, damage and other fonts refused, the link's install and its refusals, a power cut after every byte, the
# update loader's record sweep).
#   tools/font_area_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O2 -Wall -Wextra -Wno-unused-function -Wno-unused-const-variable -o build/font_area_test firmware/test/font_area_test.c
build/font_area_test
