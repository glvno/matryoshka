#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 morgulbrut
"""Talk to the Matryoshka firmware over USB-MIDI SysEx (protocol: web/src/protocol.ts), without the browser.

  tools/m1_link.py info
  tools/m1_link.py upload PATCH.m1p       (binary patches: build/golden/*.m1p from tools/golden.sh)
  tools/m1_link.py store
  tools/m1_link.py bank                   (write the factory presets from firmware/src/presets.h into the flash bank)
  tools/m1_link.py bank-info              (list the bank slots on the FM-1)
  tools/m1_link.py bank-clear             (empty the bank: the next boot writes the factory patches again)
  tools/m1_link.py param MODULE PARAM VALUE     (module / parameter index, value as a float)
  tools/m1_link.py note 60 [seconds]
  tools/m1_link.py program N              (factory patch N, MIDI program change)
  tools/m1_link.py cpu                    (the audio ISR's load: now, and the peak since the last cpu read)
  tools/m1_link.py uac [SECONDS]          (the USB audio stream: state, glitch counters, rate adjustments, the ring's fill
                                           range; SECONDS: read again after that long and print the changes per second)
  tools/m1_link.py mem                    (#273: the boot's proof of .lowram and how deep each stack has gone since boot)
  tools/m1_link.py cores [inject | split on|off | stress on|off]   (#271: the second core: 2 CORES / 1 CORE, its self-tests; inject: one
                                           wrong job, which must fall back to one core until power-off; split off: core 0
                                           renders every part, core 1 stays up, for measuring; on again at boot; stress on:
                                           the self-test every 1 ms with its hand-off's race window widened, off at boot)
  tools/m1_link.py uitime [reset]         (the LCD's draw times: the last and the worst of each kind, in ms; reset zeroes them)
  tools/m1_link.py clock [SECONDS [BPM [run]]]   (#473: MIDI clock out, DIAG page 116: ticks sent and dropped; SECONDS:
                                           also time the ticks this computer receives, by CoreMIDI's timestamps, and print
                                           the mean period, the deviation of each period and of each tick from a straight
                                           grid, and the link's refused sends over that time, DIAG page 117; BPM: at that
                                           global tempo (TEMPO, set back after); run: with the transport running)
  tools/m1_link.py usblog [arm|wrap]      (#535: the USB setup log, DIAG pages 40..71 and 104..107: every control transfer a host started
                                           since boot (or since `arm`) and the firmware's answer, bus resets, suspends, the
                                           address taking effect; kept while the FM-1 stays powered, so a failed host's log
                                           can be read on another. arm: keep the next 64 entries (a one-shot capture), wrap:
                                           the newest again)
  tools/m1_link.py blocktime [SECONDS] [--notes N] [--patch NAME] [--json FILE]
                                          (#802, #803, DIAG pages 132..139: what an audio block's time is made of, over
                                           SECONDS (default 3): each part of the audio interrupt, the voices, TIMER5's
                                           interrupts, the second core's busy and idle time and its hand-offs, mean and
                                           most per block; --patch: a factory patch (firmware/src/presets.h) uploaded live
                                           first; --notes: hold the first N of the rig survey's 8 notes (C4 E4 G4 B4 C5 E5
                                           G5 B5) from 1 s before the window to its end; --json: the raw values too. Reads
                                           only, except that page 139 holds the main loop 5 ms)
