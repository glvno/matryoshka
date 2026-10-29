# MIDI timing during screen redraws

Measured on the registered FM-1 test rig on 2026-10-26 for [issue #363](https://github.com/glvno/matryoshka/issues/363).
The baseline was the card-row firmware from build `40406160864`. The corrected firmware is commit `b743c39`,
built by [firmware run 40416335294](https://github.com/glvno/matryoshka/actions/runs/40416335294).
Its package SHA-256 is `26ad194e0aa5582504c8779ed84bdb2ffaeff0d28c70a07db4ba873bbe58b1dd`.

The failure remains audible with the faster screen drawing. Notes received while drawing waited in the input
queue until the main loop returned. A short note's press and release could then reach the engine together,
before it rendered another audio block.

## Device method

A temporary live patch connects Main's pitch to an Oscillator, and Main's gate to a VCA. The oscillator passes
through a low-pass Filter set to 12 kHz, then the VCA and Output. No envelope obscures the note edges. The bank
is not written. The master volume is raised.

CoreMIDI schedules every note and test-panel command in advance, using host timestamps. The rig's USB audio
is recorded directly through PortAudio as 44.1 kHz stereo. Each recording contains the full requested sample
count and reports no host input overflow. An initial sustained-note recording is continuous. A Python sender
using sleeps had large timing jitter and was discarded before these measurements. The first FFmpeg capture
also returned too few samples and was discarded.

For SELECT and ALGO, 50 notes arrive 80 ms apart and last 30 ms. A knob turn arrives 10 ms after every second
note begins. For octave buttons, 200 notes arrive 20 ms apart and last 6.67 ms. Alternating OCT- and OCT+ presses
arrive 1 ms after every second note begins and are released 34 ms later. The firmware's test commands drive
its panel input path. Both runs use the same patch and schedules.

Note onsets are counted from the recorded waveform's one-millisecond peak windows. This measures distinct
sounding notes and their spacing, not arrival-to-audio latency. The audio engine renders blocks of about
2.9 ms, so a small spread around the scheduled interval also appears when idle.

| Test | Notes sent | Before: notes heard | After: notes heard | Before: interval range | After: interval range |
|---|---:|---:|---:|---|---|
| Idle, 80 ms spacing | 50 | 50 | 50 | 77.8–81.8 ms | 77.8–81.8 ms |
| SELECT, 80 ms spacing | 50 | 25 | 50 | 159.6–162.6 ms | 77.8–81.8 ms |
| ALGO, 80 ms spacing | 50 | 25 | 50 | 159.6–162.6 ms | 77.8–81.8 ms |
| Idle, 20 ms spacing | 200 | 200 | 200 | 17.0–21.0 ms | 17.0–22.9 ms |
| Octave buttons, 20 ms spacing | 200 | 100 | 200 | 36.9–40.9 ms | 17.0–22.9 ms |

SELECT reproduced twice before the fix with the same 25/50 result. Octave buttons passed at 80 ms spacing;
the faster test exposed their shorter interruption. Faster redraws do not remove the underlying failure.

These precise device measurements use USB MIDI. A physical TRS controller was also connected, but its
arpeggio recording produced one continuous pitch and gate, so it supplied no usable note timing measurement.
The host regression exercises the actual TRS parser, including clock bytes between note bytes, through the
same queue and dispatcher as USB. It is not a measurement of the physical TRS port's timing.

Raw WAV recordings and JSON onset lists are retained in the working checkout's
`build/midi-redraw-before/` and `build/midi-redraw-after/` folders.

## Regression and compatibility checks

`tools/panel_test.sh` includes `firmware/test/midi_redraw_test.c`. Its USB and TRS cases failed before the fix
and pass afterward. Notes arrive between actual panel rendering calls and must play and release before
the draw ends, including octave messages outside the main page renderer. It also checks clock, transport,
modulation, pitch bend, aftertouch, zero-velocity note-on, all-notes-off, channel filtering, and dispatch
being held while the engine is stopped for loading. Screen commands keep their input order. A command
that draws cannot reenter the dispatcher or alter a screen buffer still being transferred.

Golden audio comparisons, USB tests, panel tests, older-format checks, web tests and TypeScript checks pass.
All 79 older patch binaries still render identically. Before installation, the exact build passed 158
emulator smoke checks with no level warnings and all 26 editor/MIDI emulator checks. After installation, all
26 editor/MIDI scenarios also passed on the registered device.

The screen-transfer rule is recorded as proposed in [D-469](../ledger/link-and-midi.md#D-469).
