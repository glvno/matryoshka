# The master FX bus factor and more factory voices, test rig, 2026-11-18

The CPU estimate's master FX bus gets its own factor ([D-365](../ledger/engine.md#D-365)), and the voice tops of [D-870](../ledger/patches-and-presets.md#D-870) are worked out again with it. Cassia 1 plays five voices and Algo Four eight; Oracle V's, Cassia 1's and Algo Four's factory presets play their instrument's count unless they set fewer on purpose.

## The estimate

- **Fit** (`web/scripts/cpu-rig-fit.ts`): the bus factor is the least-squares fit of the rig's rise, from a poly factory patch as shipped to every stage of its bus on, on the estimate's rise. It uses 10 pairs: [the 1.20 voices surveys](2026-11-18-rig-voices-120.md) and the two surveys below. Result: 0.53. The engine factors are then refitted with those patches as targets, so each still reads at least the rig.
- At factor 1 the estimate with every stage on read 4.8 to 11.8 points over the rig (Hera 6 at six to Expander S at six). Now it reads 0 to 9.7 points over (Cassia 1 at four to Expander S at seven).

Every stage on, the estimate (%), `CPU_VOICE_TOP` 90:

| Patch | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|
| Oracle V | 73.2 | 83.2 | 91.5 | — | — |
| Cassia 1 | 73.3 | 84.8 | 96.5 | — | — |
| Algo Four | 55.6 | 63.8 | 69.9 | 78.2 | 84.3 |
| Expander S | 62.8 | 73.4 | 81.2 | 91.3 | 99.1 |
| Io 4 | 62.6 | 70.7 | 76.9 | 85.2 | 91.6 |
| Hera 6 | 65.2 | 72.7 | 79.3 | 86.8 | 93.4 |

## Build and method

- **Firmware:** CI run 44357433714 (branch `fxbus-factor-voices`), installed on the rig through the boot check (`emu:boot`, [D-123](../ledger/releases.md#D-123)); `checkDualCore` passed 22 of 22.
- **Load** (`tools/rig_cpu_survey.py`): 0, 1, 4 and 8 held keys, 2 seconds each, transport stopped and running. Worst steady is the largest lower median of a phase's samples after the first, as a share of the 2,902 µs half-block. "Dropped" counts voices shed, overloads and late halves over all phases.

## The rig (worst steady %, stopped / running)

| Patch | Worst steady | Dropped |
|---|---|---|
| Cassia 1, 5, as shipped | 72.4 / 74.0 | 0 |
| Cassia 1, 5, every stage on | 79.6 / 81.2 | 0 |
| Cassia 1 presets at 5, every stage on (Init, PD Bass, PD Brass, Glass Bell, Reso Pad, Tine Piano, Velvet Chords) | 75.2 to 82.2 (Reso Pad) | 0 |
| Algo Four, 8, as shipped | 70.1 / 72.2 | 0 |
| Algo Four, 8, every stage on | 79.5 / 80.8 | 0 |
| Algo Four presets at 8, every stage on (Init, Solid Bass, E Piano, Tubular Bell, Brass Stab, Amber EP, Porcelain Keys) | 77.6 to 81.0 (Init) | 0 |
| Oracle V presets at 5, every stage on (Init and its five presets) | 79.0 to 80.9 | 0 |
| Expander S, 4, as shipped / every stage on | 54.4 / 60.4 | 0 |
| Expander S, 7, as shipped | 72.2 / 73.8 | 0 |
| Expander S, 7, every stage on | 80.0 / 81.6 | 0 |

Every shipped count holds under 85 % with nothing dropped. Expander S at seven also holds on the rig, but its estimate (91.3 %) is over the bar, so its top stays six and it plays four; raising it on the rig's measurement is left to the owner.

## Headroom (0.95 limit)

Each affected sound at its new count, played the ways `web/src/headroom.ts` lists. Gain-only trims of the level row:

| Sound | Level row | Peak before → after |
|---|---|---|
| Algo Four Init (and the patch) | volume 0.24 → 0.19 | 1.152 → 0.912 |
| Algo Four E Piano | volume 0.25 → 0.2 | 1.112 → 0.889 |
| Algo Four Tubular Bell | volume 0.38 → 0.32 | 1.083 → 0.912 |
| Algo Four Brass Stab | volume 0.28 → 0.25 | 1.030 → 0.920 |
| Algo Four Porcelain Keys | volume 0.41 → 0.36 | 1.045 → 0.918 |
| Cassia 1 Tine Piano | vol 0.64 → 0.62 | 0.960 → 0.930 |
| Oracle V Unison Bass | volume 0.57 → 0.47 | (loudness rule: 1.7 dB over at five voices) → 0.617 |

Every other affected sound peaks at 0.913 or under. Peaks before above 1 were measured with the Output lowered and scaled back. Listening files: `build/listen-fxbus-voices/` (not committed).

## Raw data

[stopped](cpu-survey-2026-11-18-rig-fxbus-voices.json), [running](cpu-survey-2026-11-18-rig-fxbus-voices-run.json); Expander S at seven: [stopped](cpu-survey-2026-11-18-rig-fxbus-expander7.json), [running](cpu-survey-2026-11-18-rig-fxbus-expander7-run.json).
