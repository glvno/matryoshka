#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the USB audio function (firmware/src/usb.c, FELUCCA_UAC): descriptors, EP0 requests, the ring and packet
# logic under clock drift (firmware/test/usb_test.c), in the app's configuration and with the CDC console; and the
# MIDI-only presentation (update mode) against a FELUCCA_UAC=0 build's descriptors, byte for byte; the app's build
# (FELUCCA_OTA=1) also checks that SysEx is not held back by a full MIDI ring in an update session (#177), and that
# SysEx out never stalls the main loop on a host that stops reading (#375); the MIDI-only presentation's bytes are pinned below.
#   tools/usb_test.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p build
CC="${CC:-cc}"
W="-O1 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter -Wno-missing-field-initializers"
U="-DFELUCCA_UAC=1 -DFELUCCA_UAC_48K=0 -DUAC_IN_SHIFT=8"
$CC $W $U -DFELUCCA_CDC=0 -DFELUCCA_OTA=1 -o build/usb_test firmware/test/usb_test.c
$CC $W $U -DFELUCCA_CDC=1 -o build/usb_test_cdc firmware/test/usb_test.c
$CC $W $U -DFELUCCA_CDC=0 -DFELUCCA_OTA=1 -DUSB_LOG=0 -o build/usb_test_nolog firmware/test/usb_test.c
$CC $W $U -DFELUCCA_CDC=0 -DFELUCCA_OTA=1 -DFELUCCA_USB_HS=1 -o build/usb_test_hs firmware/test/usb_test.c   # (1.0 .. 1.8.3)
$CC $W -DFELUCCA_UAC=0 -DFELUCCA_CDC=0 -DUSB_LOG=0 -DFELUCCA_USB_HS=1 -o build/usb_test_midi firmware/test/usb_test.c   # (as the update loader)
$CC $W $U -DFELUCCA_CDC=0 -DFELUCCA_OTA=1 -DFELUCCA_DEVICE_IDENTITY=1 -o build/usb_test_identity firmware/test/usb_test.c
fail=0
build/usb_test_identity || fail=1
build/usb_test || fail=1
echo "with the CDC console:"
build/usb_test_cdc || fail=1
echo "without the setup log (USB_LOG=0):"
build/usb_test_nolog || fail=1
echo "with high speed allowed (FELUCCA_USB_HS=1, as before #535 and in the update loader):"
build/usb_test_hs || fail=1
# #535: the setup log only watches. An enumeration with every kind of answer makes the same SIE writes and EP0 packets
# with it and without it
build/usb_test trace > build/usb_trace_log.txt
build/usb_test_nolog trace > build/usb_trace_nolog.txt
if [ -s build/usb_trace_log.txt ] && cmp -s build/usb_trace_log.txt build/usb_trace_nolog.txt; then
  echo "ok   the setup log changes no SIE write or EP0 packet ($(wc -l < build/usb_trace_log.txt | tr -d ' ') in an enumeration)"
else
  echo "FAIL the setup log changes what the SIE is told"; diff build/usb_trace_log.txt build/usb_trace_nolog.txt | head -20 || true
  fail=1
fi
build/usb_test dump > build/usb_midi_only.hex
build/usb_test_midi dump > build/usb_uac0.hex
if cmp -s build/usb_midi_only.hex build/usb_uac0.hex; then
  echo "ok   update mode's descriptors = a FELUCCA_UAC=0 build's"
else
  echo "FAIL update mode's descriptors differ from a FELUCCA_UAC=0 build's"; diff build/usb_midi_only.hex build/usb_uac0.hex || true
  fail=1
fi
# Pinned bytes. Update mode (and the update loader's build, FELUCCA_UAC=0) stays MIDI only, byte for byte as 1.0
# shipped it: the way back. (The app's layout, #67 / D-478, is walked in usb_test.c walk_config.)
MIDI_DEV=120110010000004009120100000301020001
MIDI_CFG=0902650002010080320904000000010100000924010001090001010904010002010300000724010001410006240201010006240202020009240301030102010009240302040101010009050102400000000005250101010905810240000000000525010103
printf '%s\n%s\n' "$MIDI_DEV" "$MIDI_CFG" > build/usb_midi_pinned.hex
if cmp -s build/usb_midi_only.hex build/usb_midi_pinned.hex; then
  echo "ok   update mode's descriptors = the pinned MIDI-only bytes"
else
  echo "FAIL update mode's descriptors changed"; diff build/usb_midi_only.hex build/usb_midi_pinned.hex || true
  fail=1
fi
exit $fail
