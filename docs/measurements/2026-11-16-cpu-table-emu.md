# The CPU cost table from the emulator, against the test rig (2026-11-16)

Issue #959 asks for the editor's CPU estimate to take its module costs from the emulator's timing model instead of from cycles counted on a stand-in processor ([D-1107](../ledger/engine.md#D-1107)). This page records the first such table, how far it is from the test rig, and why the editor keeps its current table for now ([D-981](../ledger/editor.md#D-981)).

- **Firmware:** CI run 43959004111 (`matryoshka-firmware`, `matryoshka-elf`), which matches the branch's head. Timing model: `tools/emu/timing.txt`.
- **Table:** [`2026-11-16-cpu-table-emu.json`](2026-11-16-cpu-table-emu.json), from the second sweep below. `npm run cpu-costs-emu` makes it (`web/scripts/cpu-costs-emu.ts`).
- **Rig figures:** each factory patch's steady peak. This is the median of a phase's 500 ms peaks after the first, the most over the phases it played without shedding voices, transport stopped and running. `web/scripts/cpu-rig-check.ts` makes the comparison (`--table` for the emulator's table), and `web/scripts/cpu-rig-fit.ts --table` refits the engine factors on it.
- **Points:** percentage points of the 2901 µs audio block.

## Summary

| Estimate | 1.14 bank (22 patches): rms, range | Today's factory patches (20): rms, range |
|---|---|---|
| The emulator itself, each whole patch (mean of the audio interrupt) | 3.2 points, −7.6 to +3.9 | 5.7 points, −13.3 to +15.7 |
| First sweep, alone, no cold-code term | 19.3 points, −7.6 to +40.7 | 25.0 points, −7.6 to +44.4 |
| First sweep, alone, with the cold-code term | 9.4 points | 9.9 points |
| Second sweep (the table above), alone, with the cold-code term | 13.5 points, −5.2 to +36.2 | 19.9 points, −4.7 to +45.4 |
| Second sweep, with engine factors refitted on it | 0.3 points, 0.0 to +1.1 | 8.0 points, −9.6 to +22.9 |
| Shipped estimate (counted cycles, with its engine factors) | 0.5 points, −0.1 to +1.6 | 6.5 points, −9.8 to +22.4 |

`cpu.test.ts` holds every patch of the 1.14 bank within −3 / +5 points of the rig. No table alone gets there. The emulator's own whole-patch figures don't get there either: on the 1.14 bank they spread from −7.6 to +3.9 points. That spread of 11.5 points is wider than the test's 8-point window, so no sum of module costs from this timing model can fit every patch inside the window. The best constant offset would put 18 of the 22 inside. The gap is the timing model's fidelity on whole patches, not the table. So the editor keeps the shipped table and its engine factors ([D-365](../ledger/engine.md#D-365)), as [D-1107](../ledger/engine.md#D-1107) provides until a new table matches the rig.

## The cold-code term

The first table over-read big poly engines by 40–55 % against the emulator's own module times for the same patches: Hera 4 +55 %, Vernon 100 +52 %, Oracle V +50 %, Io 4 +40 %, Expander S +39 %. Small assemblies came within about 10 %. The module times inside the factory patches show why. A module type's first copy in a block is slow, and every later copy is fast. For example, the 8 Lire patch has eight Oscillators. One measured 24 k cycles a block and the other seven 5–8 k, while the table had 37 k for each. Measured alone, a module pays for its code and tables fetched cold every block, and in a patch only the first copy of its type pays that.

The term is `TypeCost.cold`: cycles counted once per type a patch runs, and taken off every copy. `cpu-costs-emu.ts` fits it on the factory patches' own module times. For each type with n ≥ 2 copies in a patch, the table's cycles less the measured cycles are cold × (n − 1), by least squares over the 98 whole-patch checks. Each type's term lies between 0 and 0.9 of its run cost. The second sweep's terms, in cycles: adsr 7050, chorus 250, const 2648, crush 5693, delay 12900, drummap 2666, env 6194, glide 4634, ladder 7324, lfo 8473, logic 5433, macro 2631, math 6079, matrix 6810, mixer 4121, modal 7445, noise 3166, osc 9815, pan 1246, part 3603, pd 16442, pulse 1336, random 2390, ratio 2703, scale 2181, select 4314, seq 1687, sh 344, shape 7471, steps 6658, wavetable 3195, xfade 1554.

The term took the first sweep's error from 25.0 to 9.9 points rms on today's factory patches. Against the emulator's own whole-patch module times, the second sweep's model reads 23 % rms off (13 % high on average, from −30 % to +66 %; Wanderer −15 %, 8 Lire +66 %).

## A module alone measures warm or cold

A module's time measured alone depends on the rest of the test patch, not only on its own settings. The same LFO, one alone and then with copies beside it, in cycles a block (core 0 / core 1):

| LFO setting | Alone | Two copies | Three copies |
|---|---:|---:|---:|
| Default | 9414 | 4597 / 0, 0 / 3761 | 3301 / 0, 0 / 3562, 2848 / 0 |
| Depth 0.5 | 39339 | 5809 / 0, 0 / 2466 | 5764 / 0, 0 / 2506, 3466 / 0 |
| Direction 1 | 42641 | 4442 / 0, 0 / 3837 | 3791 / 0, 0 / 4707, 2859 / 0 |
| Shape input patched | 37643 | 36627 / 0, 0 / 29982 | 37016 / 0, 0 / 30749, 27749 / 0 |

With the shape input patched, the LFO really does more work: every copy costs about 30 k. At depth 0.5 or direction 1, the LFO alone costs 39–43 k, and the same setting beside a second copy costs 2.5–6 k. The lone LFO's code was fetched cold every block; beside a copy it stayed in the cache. Whether a lone module's code survives from one block to the next depends on what else runs, including the firmware's main loop, so the alone measurements mix warm and cold times.

The table is therefore not reproducible from one sweep to the next. The sweep chooses which settings matter by their effects. Effects that come out near-equal change order between runs, and a reordered grid is measured anew. The second sweep, run on the same firmware and the same code with 64,210 of 72,540 patches read from the first sweep's cache, played 8,330 patches again. It chose other grids for the LFO, Noise, ADSR, Filter, Delay, Glide, Env and Wavetable. The LFO's depth now adds about 30 k cycles below depth 1, where the first sweep had at most 2.8 k. Its error against the rig moved from 9.9 to 19.9 points rms on today's factory patches.

A table of warm costs would avoid this. Each test patch would hold two copies of the module, read the second copy's time, and leave the cold fetch to the cold-code term. That needs a new sweep of about 3–4 hours ([D-981](../ledger/editor.md#D-981), not yet settled). It can't reach the test's window while the emulator's own whole patches miss the rig by more than the window allows.

## The other terms

- **Steady peak (`PEAK`):** the fit on the second sweep is −334 µs a block, because the table over-reads on average. A peak is never below the mean, so the term stays at 0.
- **Second core (`CORES`):** idle cost 29 µs, split efficiency 0.75, as in the shipped table. On the first sweep with the cold-code term, the rig's survey with the second core's work refused allows a split efficiency of at most 0.65. With the engine factors refitted on the second sweep, it allows 0.78.
- **Engine factors refitted on the second sweep:** from 0.52 (8 Lire) to 1.50 (Oracle V, the cap), with the poly-group factors from 0.53 (Hera 4) to 1.0 (Expander S). With them, today's 808 Kit reads 95.3 % against the rig's 72.3 %, above its 90 % voices top ([D-870](../ledger/patches-and-presets.md#D-870)), so `kit808.test.ts` fails. The model-against-emulator checks and two other `cpu.test.ts` cases fail too (the oscillator's FM mode costing 1.8× its plain mode; Io 4's voice flaws).
- **Schedule:** the two-core schedule's units stay the shipped table's (`CpuTable.schedule`), so `defs.h` does not change.

## Per patch

Each figure is a share of the audio block, with its error against the rig in points in brackets. "Emulator, whole patch" is the mean audio interrupt of the whole patch on the emulator, holding one note per voice as the checks do (`m1emu cpu --modtime`, `isr_us`). "Emulator table" is the second sweep's table with the cold-code term, alone or with the engine factors refitted on it. "Shipped estimate" is the editor's estimate today.

### Today's factory patches, each on the newest rig survey that played it

| Patch | Rig % | Emulator, whole patch % | Emulator table alone % | Emulator table, factors refitted % | Shipped estimate % | Rig survey |
|---|---:|---:|---:|---:|---:|---|
| Monolith D | 41.4 | 41.7 (+0.3) | 41.6 (+0.2) | 41.6 (+0.2) | 41.6 (+0.2) | `2026-11-15-rig-osc-phase` |
| Oracle V | 71.4 | 77.5 (+6.1) | 97.4 (+26.1) | 74.5 (+3.1) | 75.6 (+4.2) | `2026-11-15-rig-osc-phase` |
| Silver Box | 35.3 | 34.4 (-0.9) | 30.6 (-4.7) | 35.4 (+0.1) | 35.4 (+0.1) | `2026-11-14-rig-modctl` |
| Hera 6 | 84.6 | 75.7 (-8.9) | 96.8 (+12.2) | 75.0 (-9.6) | 74.8 (-9.8) | `2026-11-15-rig-osc-phase` |
| Sallen 20 | 52.4 | 55.6 (+3.2) | 55.5 (+3.1) | 54.1 (+1.7) | 54.7 (+2.3) | `2026-11-14-rig-modctl` |
| Expander S | 64.5 | 61.1 (-3.4) | 63.5 (-0.9) | 65.0 (+0.6) | 63.7 (-0.8) | `2026-11-15-rig-rack-priority` |
| Algo Four | 49.8 | 65.5 (+15.7) | 95.3 (+45.4) | 72.6 (+22.8) | 72.2 (+22.4) | `2026-11-15-rig-osc-phase` |
| Canvas | 64.0 | 64.3 (+0.3) | 72.3 (+8.3) | 65.1 (+1.1) | 65.4 (+1.4) | `2026-11-14-rig-modctl` |
| Wanderer | 50.9 | 50.5 (-0.4) | 47.4 (-3.5) | 52.9 (+2.0) | 53.6 (+2.7) | `2026-11-15-rig-osc-phase` |
| Briefcase 3 | 66.6 | 68.3 (+1.7) | 74.8 (+8.3) | 60.6 (-6.0) | 69.3 (+2.8) | `2026-11-15-rig-briefcase-board` |
| Io 4 | 63.8 | 65.2 (+1.4) | 79.1 (+15.2) | 65.7 (+1.9) | 65.8 (+1.9) | `2026-11-15-rig-osc-phase` |
| Vernon 100 | 47.4 | 49.9 (+2.5) | 55.2 (+7.8) | 49.5 (+2.0) | 49.3 (+1.9) | `2026-11-14-rig-modctl` |
| 8 Lire | 43.6 | 44.3 (+0.7) | 79.8 (+36.2) | 43.6 (+0.0) | 43.8 (+0.2) | `2026-11-14-rig-modctl` |
| Elvira 2 | 35.2 | 32.8 (-2.4) | 35.0 (-0.2) | 35.3 (+0.1) | 35.4 (+0.2) | `2026-11-14-rig-modctl` |
| Scrounge | 85.9 | 72.6 (-13.3) | 86.8 (+0.9) | 78.4 (-7.5) | 80.1 (-5.8) | `2026-11-15-rig-scrounge-full` |
| Meridian 8 | 65.0 | 65.7 (+0.7) | 91.7 (+26.7) | 65.6 (+0.6) | 66.7 (+1.6) | `2026-11-15-rig-meridian-full` |
| 808 Kit | 72.3 | 74.8 (+2.5) | 109.9 (+37.6) | 95.3 (+22.9) | 80.9 (+8.6) | `2026-11-15-rig-808-full` |
| 909 Kit | 78.8 | 73.8 (-5.0) | 108.7 (+30.0) | 79.0 (+0.2) | 85.1 (+6.3) | `2026-11-15-rig-909-full` |
| Cassia 1 | 72.1 | 74.1 (+2.0) | 84.1 (+12.0) | 70.9 (-1.2) | 71.0 (-1.1) | `2026-11-15-rig-rack-priority` |
| Verona Drum 1 | 71.7 | 66.5 (-5.2) | 82.3 (+10.6) | 76.9 (+5.2) | 79.5 (+7.8) | `2026-11-15-rig-verona-full` |

### The 1.14 bank's graphs on their rig survey (`cpu-survey-2026-11-14-rig-modctl*.json`)

| Patch | Rig % | Emulator, whole patch % | Emulator table alone % | Shipped estimate % | Rig survey |
|---|---:|---:|---:|---:|---|
| Oracle V | 71.2 | 74.3 (+3.1) | 94.2 (+23.0) | 71.5 (+0.3) | `2026-11-14-rig-modctl` |
| Monolith D | 41.4 | 41.7 (+0.3) | 41.6 (+0.2) | 41.6 (+0.2) | `2026-11-14-rig-modctl` |
| Silver Box | 35.3 | 34.4 (-0.9) | 30.6 (-4.7) | 35.4 (+0.1) | `2026-11-14-rig-modctl` |
| Hera 3 | 63.7 | 62.3 (-1.4) | 80.6 (+16.9) | 63.7 (+0.0) | `2026-11-14-rig-modctl` |
| Sallen 20 | 52.4 | 53.9 (+1.5) | 53.9 (+1.5) | 53.1 (+0.7) | `2026-11-14-rig-modctl` |
| Expander S | 54.4 | 54.7 (+0.3) | 53.0 (-1.4) | 54.5 (+0.1) | `2026-11-14-rig-modctl` |
| Algo Four | 52.1 | 48.7 (-3.4) | 67.1 (+15.0) | 52.8 (+0.7) | `2026-11-14-rig-modctl` |
| Canvas | 64.0 | 64.5 (+0.5) | 72.2 (+8.3) | 65.5 (+1.6) | `2026-11-14-rig-modctl` |
| Wanderer | 50.6 | 49.0 (-1.6) | 45.4 (-5.2) | 50.8 (+0.3) | `2026-11-14-rig-modctl` |
| Briefcase 3 | 56.1 | 60.0 (+3.9) | 72.3 (+16.2) | 56.5 (+0.3) | `2026-11-14-rig-modctl` |
| Io 4 | 63.8 | 64.4 (+0.6) | 77.4 (+13.6) | 64.0 (+0.3) | `2026-11-14-rig-modctl` |
| Vernon 100 | 47.4 | 48.2 (+0.8) | 53.5 (+6.1) | 47.6 (+0.1) | `2026-11-14-rig-modctl` |
| 8 Lire | 43.6 | 44.3 (+0.7) | 79.8 (+36.2) | 43.8 (+0.2) | `2026-11-14-rig-modctl` |
| Elvira 2 | 35.2 | 32.8 (-2.4) | 35.0 (-0.2) | 35.4 (+0.2) | `2026-11-14-rig-modctl` |
| Scrounge | 49.3 | 44.0 (-5.3) | 57.1 (+7.9) | 49.3 (+0.0) | `2026-11-14-rig-modctl` |
| Meridian 8 | 40.1 | 43.4 (+3.3) | 55.4 (+15.4) | 41.2 (+1.1) | `2026-11-14-rig-modctl` |
| Perun 4 | 44.9 | 39.5 (-5.4) | 56.5 (+11.6) | 45.1 (+0.2) | `2026-11-14-rig-modctl` |
| 808 Kit | 56.0 | 55.8 (-0.2) | 64.8 (+8.8) | 56.5 (+0.4) | `2026-11-14-rig-modctl` |
| 909 Kit | 35.6 | 30.7 (-4.9) | 47.9 (+12.3) | 35.6 (-0.1) | `2026-11-14-rig-modctl` |
| Spokes 6 | 54.0 | 46.4 (-7.6) | 68.0 (+14.0) | 55.1 (+1.0) | `2026-11-14-rig-modctl` |
| Cassia 1 | 69.2 | 69.2 (+0.0) | 82.4 (+13.2) | 69.3 (+0.0) | `2026-11-14-rig-modctl` |
| Verona Drum 1 | 56.0 | 51.1 (-4.9) | 60.0 (+4.0) | 56.3 (+0.3) | `2026-11-14-rig-modctl` |
