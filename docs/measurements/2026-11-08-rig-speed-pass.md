# The 1.11.1 speed pass on the test rig, 2026-11-08

The engine speed pass of issue #781 (pull request #786, branch `speed-781`) was measured on the test rig against release 1.11.0. Every change in it is bit-exact: `tools/engine_exact.sh` renders the golden kits and every factory patch with main's engine and this one and finds them sample for sample the same. So the patches play as before and only the time differs. The main session ran the surveys.

- **Before:** the rig on the 1.11.0 release bytes (FM-1_7011100), the factory set of main after 1.11.0.
- **After:** the rig on this branch's CI build (firmware CI run 42562725002, `d13998b9`), the same factory patches.

Measured with `tools/rig_cpu_survey.py`, as in [the 1.11 batch](2026-11-08-rig-release-1.11.md). Each patch is uploaded live, then held at rest and with 1, 4 and 8 keys over USB MIDI, the transport stopped and then running. "Steady" is the median of a phase's samples after the first, in % of the 2,902 µs half buffer; "steady peak" is the most over the four phases. Files:

- `cpu-survey-2026-11-08-rig-release-1.11.0.json` and `-run.json`: before.
- `cpu-survey-2026-11-08-rig-speed-pass.json` and `-run.json`: after.
- `cpu-survey-2026-11-08-rig-speed-pass-before-cuts.json` and `-run.json`: on the same build, the five factory patches as they were before pull request #775 cut them (Oracle V and Hera at five voices, Cassia 1 at four, the 808 Kit with its mid and high toms, Verona Drum 1 with DRUM 2 and PAN), for issue #782.
- `cpu-survey-2026-11-08-rig-speed-pass-cassia-1.json` and `-run.json`: on the same build, this pull request's Cassia 1 at four voices.

| patch | steady peak %, stopped: before → after | running: before → after | 8 keys, stopped: before → after | parts shed / overload after |
|---|---|---|---|---|
| Oracle V | 78.1 → 73.8 (-4.3) | 78.6 → 75.2 (-3.4) | 78.0 → 73.8 (-4.2) | 0 / no |
| Init | 22.1 → 22.0 (-0.1) | 23.0 → 23.3 (+0.3) | 22.1 → 22.0 (-0.1) | 0 / no |
| Simple FM | 23.2 → 22.1 (-1.1) | 23.8 → 23.0 (-0.8) | 23.2 → 22.1 (-1.1) | 0 / no |
| Plucked String | 29.6 → 29.0 (-0.6) | 30.5 → 30.7 (+0.1) | 29.6 → 29.0 (-0.6) | 0 / no |
| Monolith D | 46.2 → 44.8 (-1.3) | 47.3 → 46.9 (-0.4) | 46.2 → 44.8 (-1.3) | 0 / no |
| Silver Box | 34.8 → 35.1 (+0.3) | 36.1 → 36.1 (+0.0) | 34.8 → 35.1 (+0.3) | 0 / no |
| Hera 4 | 84.7 → 83.7 (-1.1) | 85.2 → 85.3 (+0.1) | 84.7 → 83.7 (-1.1) | 0 / no |
| Sallen 20 | 62.4 → 60.8 (-1.6) | 64.0 → 62.8 (-1.1) | 62.4 → 60.8 (-1.6) | 0 / no |
| Expander S | 57.8 → 56.6 (-1.2) | 59.9 → 58.3 (-1.6) | 57.8 → 56.6 (-1.2) | 0 / no |
| Algo Four | 86.6 → 77.3 (-9.3) | 86.2 → 78.6 (-7.6) | 86.6 → 77.3 (-9.3) | 0 / no |
| Canvas | 83.5 → 82.2 (-1.2) | 85.6 → 84.1 (-1.5) | 83.4 → 82.2 (-1.2) | 0 / no |
| Wanderer | 61.2 → 60.1 (-1.1) | 62.9 → 61.7 (-1.2) | 61.2 → 60.1 (-1.1) | 0 / no |
| Briefcase 3 | 90.8 → 75.9 (-14.9) | 92.4 → 77.1 (-15.3) | 90.8 → 75.9 (-14.9) | 0 / no |
| Io 4 | 64.7 → 63.2 (-1.5) | 67.8 → 64.5 (-3.2) | 64.0 → 62.7 (-1.3) | 0 / no |
| Vernon 100 | 61.4 → 59.6 (-1.8) | 64.4 → 60.6 (-3.8) | 61.4 → 59.6 (-1.8) | 0 / no |
| 8 Lire | 79.7 → 75.5 (-4.3) | 80.1 → 77.0 (-3.1) | 79.7 → 75.5 (-4.3) | 0 / no |
| Elvira 2 | 48.7 → 47.8 (-1.0) | 49.8 → 49.5 (-0.3) | 48.7 → 47.8 (-1.0) | 0 / no |
| Scrounge | 73.7 → 69.1 (-4.7) | 80.9 → 77.3 (-3.6) | 73.7 → 69.1 (-4.7) | 0 / no |
| Meridian 8 | 66.2 → 63.3 (-3.0) | 68.5 → 67.3 (-1.3) | 66.2 → 63.3 (-3.0) | 0 / no |
| Perun 4 | 67.5 → 66.9 (-0.6) | 71.8 → 73.1 (+1.3) | 67.5 → 66.9 (-0.6) | 0 / no |
| 808 Kit | 82.4 → 78.6 (-3.7) | 86.2 → 83.8 (-2.3) | 82.4 → 78.6 (-3.7) | 0 / no |
| 909 Kit | 54.7 → 49.4 (-5.4) | 58.5 → 56.5 (-2.0) | 54.7 → 49.4 (-5.4) | 0 / no |
| <7PH | 76.8 → 71.8 (-5.0) | 85.2 → 81.4 (-3.8) | 76.8 → 71.8 (-5.0) | 0 / no |
| Spokes 6 | 75.7 → 74.3 (-1.4) | 85.4 → 83.7 (-1.7) | 75.7 → 74.3 (-1.4) | 0 / no |
| Cassia 1 | 61.9 → 53.3 (-8.5) | 63.3 → 54.5 (-8.9) | 61.9 → 53.3 (-8.5) | 0 / no |
| Basic Poly | 29.6 → 28.5 (-1.1) | 30.7 → 29.9 (-0.8) | 29.6 → 28.5 (-1.1) | 0 / no |
| Drift Poly | 39.0 → 37.5 (-1.5) | 40.0 → 38.9 (-1.2) | 39.0 → 37.5 (-1.5) | 0 / no |
| Mono Lead | 25.3 → 25.9 (+0.7) | 27.2 → 27.4 (+0.2) | 25.3 → 25.9 (+0.7) | 0 / no |
| Supersaw Stack | 37.9 → 36.8 (-1.1) | 39.1 → 38.6 (-0.5) | 37.9 → 36.8 (-1.1) | 0 / no |
| Verona Drum 1 | 83.3 → 77.8 (-5.4) | 88.6 → 85.3 (-3.3) | 83.3 → 77.8 (-5.4) | 0 / no |

Nothing was shed and no patch was muted, before or after. Cassia 1 in this table is the two-voice patch of 1.11.0, measured before it went back to four voices.

## What the speed pass makes room for (issue #782)

On the same build, with the patches as they were before the 1.11 cuts:

| patch | steady %, stopped: rest / 1 / 4 / 8 keys | running | parts shed | fits under the 90 % bar |
|---|---|---|---|---|
| Cassia 1, four voices | 49.1 / 72.7 / 75.6 / 76.7 | 50.0 / 74.7 / 75.9 / 76.9 | 0 | yes |
| Oracle V, five voices | 52.3 / 72.4 / 91.8 / 73.8 | 53.7 / 73.8 / 91.7 / 75.3 | 1 with eight keys | no |
| Hera, five voices | 64.7 / 82.6 / 82.4 / 83.9 | 65.5 / 83.5 / 83.7 / 84.8 | 1 with four and with eight keys | no |
| 808 Kit with the mid and high toms | 90.9 / muted / muted / muted | muted | — | no |
| Verona Drum 1 with DRUM 2 and PAN | 90.6 / 90.2 / 91.9 / muted | muted | — | no |

So this pull request brings Cassia 1 back to four voices. Its own survey, this pull request's patch on this build, reads 48.9 / 72.4 / 75.1 / 76.4 % stopped and 51.2 / 74.8 / 76.1 / 77.3 % running, with nothing shed; the overload guard's mean with eight keys was 74 %. The other four stay cut: Oracle V and Hera shed a voice at five, and the two drum kits are still muted by the overload guard right after a load.

## The CPU model, refitted

`web/scripts/cpu-rig-fit.ts` on these surveys (this pull request's Cassia 1 from its own survey; Oracle V and Hera at five voices from the survey before the cuts): the rig's steady peak = 1.239 × the estimate at the scale of 2026-10-20 + 192 µs. So the scale is 188.4 cycles per µs plus 221 µs per block, and the second core's idle cost is 30 µs (in 1.11.0: 206.5 plus 244, and 27). The engines' factors run from 0.66 (Algo Four) to 1.17 (Silver Box). `scripts/cpu-costs.ts` freezes them, and `npm run cpu-costs` wrote `cpu-costs.json`. The voice tops from the refitted model are Oracle V 4, Expander S 6 and Cassia 1 4 ([D-870](../ledger/patches-and-presets.md#D-870)).
