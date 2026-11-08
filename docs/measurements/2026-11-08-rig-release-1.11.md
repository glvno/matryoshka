# The 1.11 batch on the test rig, 2026-11-08

The head of `release-1.11` at 991f6acb (firmware CI run 42462440721) was installed on the test rig with the boot check as its gate. The owner approved that install in chat on 2026-11-08. This build's only emulator failure was 8.4: Cassia 1 with 8 keys held. The owner's FM-1 was unplugged for the measurements, so the rig was the only FM-1 connected. USB audio was not streaming during the survey (`tools/m1_link.py uac` counted 0 packets a second), as in the 1.10 surveys.

Measured with `tools/rig_cpu_survey.py` on the factory patches of `firmware/src/presets.h`. Each patch was uploaded live, then held at rest and with 1, 4 and 8 notes over USB MIDI, 2 s each, with the longest audio interrupt sampled every 0.5 s. Files:

- `cpu-survey-2026-11-08-rig-release-1.11-head.json`: every factory patch, the transport stopped.
- `cpu-survey-2026-11-08-rig-release-1.11-head-run.json`: nine patches with the transport running (`--run`, 3 s a phase).

"Steady" is the median of the samples after the first. The first sample includes the patch load. The budget is 2,902 µs a half buffer. "Model" is `cpuEstimate` in `web/src/cpu.ts` on the same head: what the second core leaves on core 0, every voice playing.

## The patches in the brief

| patch | model % | rig steady %: rest / 1 / 4 / 8 keys | parts shed (4 / 8 keys) | overload mute | 1.10 rig, 8 keys |
|---|---|---|---|---|---|
| Hera 5 | 109.4 | 66.2 / 84.9 / 84.1 / 85.4 | 1 / 2 (3 late halves) | no | 47.5 (Hera 6) |
| Cassia 1 (4 voices) | 87.1 | 61.1 / 94.5 / 62.0 / 63.5 | 2 / 2 | no | 46.2 |
| Oracle V (5 voices) | 98.0 | 55.1 / 78.3 / 99.2 / 78.9 | 0 / 1 (1 late half) | no | 46.3 |
| Algo Four (8 voices) | 96.5 | 36.0 / 53.1 / 68.6 / 86.8 | 0 / 0 | no | 45.2 |
| Briefcase 3 | 87.0 | 88.1 / 88.7 / 89.8 / 91.1 | 0 / 0 | no | 74.8 |
| 808 Kit | 92.1 | muted from the load on | none | yes, in every phase | 80.3 |
| Verona Drum 1 | 90.4 | muted from the load on | none | yes, in every phase | 81.1 |
| Canvas | 79.9 | 89.3 / 90.0 / 91.7 / muted | 0 / 0 | yes, with 8 keys | 76.6 |
| 8 Lire | 76.4 | 74.8 / 77.3 / 78.1 / 80.5 | 0 / 0 | no | 50.2 |
| Wanderer (the XL in its slot) | 43.0 | 59.1 / 60.0 / 61.3 / 63.2 | 0 / 0 | no | 37.3 |

With the transport running, the figures are the same within a point: Briefcase 3 runs 88 to 91 %. 808 Kit and Verona Drum 1 stay muted. Canvas mutes with 8 keys.

An overload mute leaves the interrupt at about 20 µs: the patch makes no sound. The device scenarios heard the same thing. "tie 808" recorded silence from 808 Kit. Verona Drum 1's device page showed OVERLOAD: CHANGE PATCH.

Cassia 1 with one key held runs on core 0 alone, as [D-391](../ledger/engine.md#D-391) has it. That costs 92 to 94 % of the half buffer. With 4 or 8 keys the overload guard drops 2 of its 4 voices. The emulator's failing 8.4 is real on the device: the rig failed it too, with 2 parts shed and no late halves.

## Every patch costs more than on 1.10

Steady µs a half with 8 keys held, the light patches that 1.11 did not change much:

| patch | 1.10 (split) | 1.11 head | change |
|---|---|---|---|
| Init | 572 | 668 | +96 |
| Simple FM | 612 | 693 | +81 |
| Mono Lead | 691 | 787 | +96 |
| Plucked String | 781 | 884 | +103 |
| Silver Box | 834 | 1046 | +212 |
| Monolith D | 1114 | 1384 | +270 |
| 909 Kit | 1501 | 1669 | +168 |

The idle cost of a patch rose by 80 to 270 µs a half. This is beyond the run-to-run noise of about 2 %. The CPU model is calibrated on the 1.10 surveys, so it now reads low on most patches. The cause is not bisected. Firmware changes in 1.11 that touch every block include the module cap of 128 with modules in the arena (#721), the analog output rendered again for 3.5MM OUT and the count-in click (#631, #732), and the flash writes in steps (#656).

## The full device scenarios

`npm run device:scenarios` (with the install): 310 of 368 checks passed, 6 skipped. The skips were the 3.5MM OUT, MONO and MONO L by-ear checks, `editorIgnore` (by design on the rig) and the flash write check. 52 failed:

- **"play once" stopped the run's state.** It calls `emu.ms()`, which the rig's runner does not have. It left the transport running, and the scenarios after it started with the transport running. A targeted rerun of the affected scenarios passed 94 of 123.
- **Failures that come back in the rerun:**
  - The count-in click: the click plays on the analog output only, so the rig's USB recording cannot hear it.
  - mirror keys and focus turns: the editor did not follow the rig's panel (mirror -1).
  - arming, where the 808 Kit's kick plays nothing: it is muted.
  - 3.6 live drone and 6.5 old pattern, once each.
- **808 Kit and Verona Drum 1 overload** (above): tie 808, the Verona checks 2.1 to 2.5.
- **8.4:** Hera 5 shed 1 part with 2 late halves, and the INFO tab read 83 %. Cassia 1 shed 2 parts. 8.2 (Io 4) passed at 61 %.

3.5MM OUT passed every check the rig can make: the setting, the shortcut, and USB audio at the same level with it on and off (-27.9 dB). Whether OFF silences the speaker and the jack is for the owner's ears.

The flash write check (#656) was skipped in both runs. `presetTo('BASIC POLY')` did not find the patch, though the rig's bank holds it in slot 26. So whether a flash write keeps the sound is not yet measured on this build.

## The bank after the update

`tools/m1_link.py bank-info` after the install showed factory slots 1 to 29 in today's order. Slot 7 is HERA 5 and slot 12 is WANDERER at the XL's size.

Slot 30, the factory Verona Drum 1's slot, holds VERONA 1 (3,821 bytes). A VERONA DRUM 1 (2,893 bytes) sits in slot 32. It is not known whether slot 30 is an older factory patch the rewrite left alone, or a patch stored on the rig. The rig's other stored slots stayed: T110 DRONE STORED and GRAINWAVE. These scenarios did not check the device presets' migration (Canvas, Verona).

EDITOR IGNORE, set on the rig by hand, read IGNORE (`editorIgnored` in HELLO) before the install and still read IGNORE after the install and the run.
