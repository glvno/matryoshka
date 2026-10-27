#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the USB audio function (firmware/src/usb.c, FELUCCA_UAC): descriptors, EP0 requests, the ring and packet
# logic under clock drift (firmware/test/usb_test.c), in the app's configuration and with the CDC console; and the
# MIDI-only presentation (update mode) against a FELUCCA_UAC=0 build's descriptors, byte for byte; the app's build
# (FELUCCA_OTA=1) also checks that SysEx is not held back by a full MIDI ring in an update session (#177), and that
# SysEx out never stalls the main loop on a host that stops reading (#375).
#   tools/usb_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
W="-O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -Wno-missing-field-initializers"
U="-DFELUCCA_UAC=1 -DFELUCCA_UAC_48K=0 -DUAC_IN_SHIFT=8"
$CC $W $U -DFELUCCA_CDC=0 -DFELUCCA_OTA=1 -o build/usb_test firmware/test/usb_test.c
$CC $W $U -DFELUCCA_CDC=1 -o build/usb_test_cdc firmware/test/usb_test.c
$CC $W -DFELUCCA_UAC=0 -DFELUCCA_CDC=0 -o build/usb_test_midi firmware/test/usb_test.c
fail=0
build/usb_test || fail=1
echo "with the CDC console:"
build/usb_test_cdc || fail=1
build/usb_test dump > build/usb_midi_only.hex
build/usb_test_midi dump > build/usb_uac0.hex
if cmp -s build/usb_midi_only.hex build/usb_uac0.hex; then
  echo "ok   update mode's descriptors = a FELUCCA_UAC=0 build's"
else
  echo "FAIL update mode's descriptors differ from a FELUCCA_UAC=0 build's"; diff build/usb_midi_only.hex build/usb_uac0.hex || true
  fail=1
fi
exit $fail
