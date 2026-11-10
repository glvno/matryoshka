#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/pan
cc -O2 -Wall -Wno-unused-function -o build/pan/exact firmware/test/pan_exact_test.c -lm
build/pan/exact
