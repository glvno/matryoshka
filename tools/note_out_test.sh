#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Note Out (D-1353, firmware/src/engine.c m_nout, firmware/src/clock_out.h) on the host: gates to timed MIDI notes, the
# velocity, and the Note Offs a bypass, the transport stopping and a patch change send (firmware/test/note_out_test.c, on
# the patches web/scripts/note-out-kits.ts writes).
#   tools/note_out_test.sh
set -e
cd "$(dirname "$0")/.."
rm -rf build/note-out
(cd web && npx vite-node scripts/note-out-kits.ts)
${CC:-cc} -O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -o build/note_out_test firmware/test/note_out_test.c
build/note_out_test build/note-out
