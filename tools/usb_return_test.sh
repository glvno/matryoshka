#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
for test in usb_return device_identity usb_poll_clock; do
  ${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -o "build/${test}_test" "firmware/test/${test}_test.c"
  "build/${test}_test"
done
