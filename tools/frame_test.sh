#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the main loop's turn at a received SysEx frame (firmware/src/host_frame.h, #486): a frame the USB poll
# finishes between any two of its steps reaches the editor's handler once, never the update protocol's drop
# (firmware/test/frame_test.c).
#   tools/frame_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-parameter -o build/frame_test firmware/test/frame_test.c
build/frame_test
