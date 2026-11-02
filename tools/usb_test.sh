#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Host test of the USB audio function (firmware/src/usb.c, FELUCCA_UAC): descriptors, EP0 requests, the ring and packet
# logic under clock drift (firmware/test/usb_test.c), in the app's configuration and with the CDC console; and the
# MIDI-only presentation (update mode) against a FELUCCA_UAC=0 build's descriptors, byte for byte; the app's build
# (FELUCCA_OTA=1) also checks that SysEx is not held back by a full MIDI ring in an update session (#177), and that
# SysEx out never stalls the main loop on a host that stops reading (#375); both presentations' bytes are pinned below.
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
# Pinned bytes. Update mode (and the update loader's build, FELUCCA_UAC=0) stays MIDI only, byte for byte as 1.0
# shipped it: the way back. The app's layout (#67, the ledger's D-478): audio control 0, audio streaming 1 (EP 0x84),
# MIDI streaming 2 (EP 0x01 / 0x81), the AC collection {1, 2}, bcdDevice 3.90.
MIDI_DEV=120110010000004009120100000301020001
MIDI_CFG=0902650002010080320904000000010100000924010001090001010904010002010300000724010001410006240201010006240202020009240301030102010009240302040101010009050102400000000005250101010905810240000000000525010103
APP_DEV=120110010000004009120100900301020001
APP_CFG=0902AF0003010080320904000000010100000A240100011F000201020C2402010306000203000000092403020101000100090401000001020000090401010101020000072401020101000B2402010202100144AC0009058405B800010000072501010000000904020002010300000724010001410006240201010006240202020009240301030102010009240302040101010009050102400000000005250101010905810240000000000525010103
printf '%s\n%s\n' "$MIDI_DEV" "$MIDI_CFG" > build/usb_midi_pinned.hex
printf '%s\n%s\n' "$APP_DEV" "$APP_CFG" > build/usb_app_pinned.hex
build/usb_test dump audio > build/usb_app.hex
if cmp -s build/usb_midi_only.hex build/usb_midi_pinned.hex; then
  echo "ok   update mode's descriptors = the pinned MIDI-only bytes"
else
  echo "FAIL update mode's descriptors changed"; diff build/usb_midi_only.hex build/usb_midi_pinned.hex || true
  fail=1
fi
if cmp -s build/usb_app.hex build/usb_app_pinned.hex; then
  echo "ok   the app's descriptors = the pinned layout (AC 0, AS 1, MIDI 2)"
else
  echo "FAIL the app's descriptors differ from the pinned layout"; diff build/usb_app.hex build/usb_app_pinned.hex || true
  fail=1
fi
exit $fail
