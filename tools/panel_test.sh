#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The panel core (firmware/src/panel.c) driven on the host with no HAL: firmware/test/panel_test.c.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
gcc -O1 -Wall -Wno-unused-function -Wno-unused-result -Wno-macro-redefined -o build/panel_test firmware/test/panel_test.c
build/panel_test
