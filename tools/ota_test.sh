#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the update check in firmware/src/ota.c (firmware/test/ota_test.c) against the bundled packages: the
# size check and the head check, with Matryoshka's change for M-VAVE Official Open (#183).
#   tools/ota_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
$CC -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -o build/ota_test firmware/test/ota_test.c
# FM1_OPEN_FWSC: a local copy of M-VAVE Official Open (.fwsc; not in the repository) to check against too
build/ota_test web/public/firmware/FM-1_015.fwsc web/public/firmware/matryoshka.fwsc ${FM1_OPEN_FWSC:+"$FM1_OPEN_FWSC"}
