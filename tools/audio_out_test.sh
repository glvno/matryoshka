#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the audio ISR's two outputs (firmware/src/audio.c, firmware/test/audio_out_test.c): USB audio and the analog
# output under GLO > SYSTEM's USB LEVEL, OUTPUT and 3.5MM OUT (#631); with 3.5MM OUT ON the analog output is bit for bit
# what it was before the setting.
#   tools/audio_out_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -Wno-unused-variable -o build/audio_out_test firmware/test/audio_out_test.c
build/audio_out_test
