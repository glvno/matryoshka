#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# The palette's switch on the bar line (#1196, firmware/src/pal_fade.h, engine.c eng_next_bar / eng_samples_to /
# eng_tick_fell) on the host: the bar math in four meters, the tick's sample at three tempos, the fade, the stop on the
# bar's sample, cancel, the transport stopping, MIDI clock in (firmware/test/pal_fade_test.c).
#   tools/pal_fade_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -o build/pal_fade_test firmware/test/pal_fade_test.c
build/pal_fade_test
