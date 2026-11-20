# The global pad map on the test rig, 2026-11-20

PR #1164, issue #1067, [D-497](../ledger/link-and-midi.md#D-497). Firmware: run 44835110258's package for head 2c6349ac
(`FM-1_7000000`, sha256 c8281c10…). It passed the boot check (emu:boot 40/40) and was then installed with
`tools/fm1_install.py --rig` on the rig at USB location 0x01140000. The factory region was main's, version 19, set ab2d84.

Method: the rig was driven through the device test mode (TEST_KEY, TEST_TURN, TEST_SCREEN, TEST_PEAK). Real MIDI notes
were sent from the Mac to the rig's USB MIDI port on its MIDI channel (1). Its USB audio was recorded by USB location
(`tools/fm1_rec.swift`), and each hit's peak was read from the recording. TEST_PEAK reads the output before MASTER. MASTER
was low, so USB peaks sit near −50 dBFS; silence reads as no sample above zero (−200 in the table). The pads were C5 (72)
and D5 (74), neither of which is a row note in the 808 or 909 Kit, so an unmapped pad note on a kit is silent.

| Step | Result | Evidence |
|---|---|---|
| 808 Kit, before the learn: note C5 | silent | TEST_PEAK 0, USB −200 |
| HOME held + SEL | `LEARN: KNOB OR DRUM KEY` | screen |
| Black key 1 | `1 BD: HIT A PAD` | screen |
| Pad C5 | `NOTE C5 > 1 BD`, plays | screen |
| A second later | `2 SD: HIT A PAD` (auto-advance) | screen |
| Pad D5 | `NOTE D5 > 2 SD` | screen |
| HOME tap | `PADS: 2 LEARNED` | screen |
| 808 Kit: pad C5 against black key 1 (both velocity 127) | plays row 1 | TEST_PEAK 2734 against 2612 (+0.4 dB); USB −47.8 against −48.2 dBFS |
| 808 Kit: pad D5 against black key 2 (both velocity 127) | plays row 2 | TEST_PEAK 1876 against 2165 (−1.2 dB); USB −51.0 against −49.9 dBFS |
| 808 Kit: unmapped note E5 | silent | TEST_PEAK 0 |
| 909 Kit: pad C5 against black key 1 (both velocity 127) | plays row 1 (the map is global) | TEST_PEAK 2373 against 2373; USB −49.0 against −49.0 dBFS |
| 909 Kit: pad D5 against black key 2 (both velocity 127) | plays row 2 | TEST_PEAK 2815 against 3652 (−2.3 dB, the snare's noise; silent without the map); USB −47.5 against −45.3 dBFS |
| Monolith D: C5, D5, E5 (E5 unmapped) | plain notes, about equally loud | USB −50.1, −48.7, −49.6 dBFS |
| GLO › MIDI 4/4 | `MIDI 4/4`, PAD MAP `ON`, `1 BD` `NOTE C5`, CLEAR, CLEAR ALL | screen |
| K1 left: PAD MAP OFF, 808 Kit: pads C5, D5 | play as their own notes: silent, as before the learn | TEST_PEAK 0, 0 |
| K1 right: PAD MAP ON | `ON` | screen |
| CLEAR ALL turned right | `TEST INPUT: REFUSED` | the device test mode refuses the arm and GLO hold by design ([D-241](../ledger/device-ui.md#D-241)); panel_test covers the arm and the hold |
| CLEAR ALL through the link instead (the editor's PADS 0xFE) | PADS_NOW empty; MIDI 4/4 row 1 reads `-` | PADS_NOW before: rows 1, 2 = 72, 74; after: all 0xFF |
| 808 Kit after the clear: pads C5, D5 | silent, as before the learn | TEST_PEAK 0, 0 |
| Power cycle | not done | the rig cannot be power-cycled from the Mac; emu:smoke's pad-map walk covers the map across a reboot |

The rig was then reinstalled with the 1.23.0 release package (`web/public/firmware/matryoshka.fwsc` at tag v1.23.0,
sha256 67a3c5ba…), including that tag's factory region.
