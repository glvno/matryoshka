# The Reverb's lines one block late, on the registered rig, 2026-11-14

Issue #802, [D-1103](../ledger/engine.md#D-1103), [D-1104](../ledger/engine.md#D-1104). The firmware is CI run 43615466841 of branch `docs_reverb-block-late`. It was installed through `npm run device:scenarios -- --install 43615466841` after the 30-second emulator boot check ([D-123](../ledger/releases.md#D-123)). The baseline is the build that plays a Steps track's quiet samples in one pass, CI run 43571432090 ([the Steps measurements](2026-11-14-rig-steps-quiet.md)).

The surveys were taken the same way as the baseline's: `tools/rig_cpu_survey.py` reloaded each patch of the 1.14 bank for each phase (at rest, then 1, 4 and 8 keys held, 2 seconds each, sampled every 0.5 seconds). A phase's steady value is the lower median of its samples after the first. The tables give each patch's largest steady value over its phases, as a share of the 2,902-microsecond half buffer. No phase shed a voice, muted or came out late.

## What changed

A Reverb's lines now hear its input one block late, with the settings of the block before ([D-1103](../ledger/engine.md#D-1103)). The two-core plan gives the lines an item of their own at the start of a core's list, so they no longer wait for the voices. The sound changed on purpose, so the C engine was checked against the TypeScript engine (`tools/golden.sh`: every golden kit within its tolerance) and against itself: `tools/lanes_exact.sh HEAD` and `tools/engine_exact.sh HEAD` show every two-core mode and the poisoned buffers bit-identical to one core, and ThreadSanitizer finds no race.

The first build, CI run 43612838276, counted each Reverb's lines at full cost even where the Reverb is an off master FX stage that never runs. That stage is off in Monolith D, Silver Box, Expander S, Algo Four and Wanderer. The plan put the unused cost first on core 0 and moved the voices to the second core. Those patches came out 2.5 to 14.7 points worse, for example Algo Four 52.6 → 67.3 % and Expander S 54.4 → 66.1 % with the transport stopped. That build's surveys were replaced by the ones below. The final build counts a module bypassed when the patch loads as passing its input through, and a bypassed Reverb's lines as nothing ([D-1104](../ledger/engine.md#D-1104), proposed).

## Raw data

- [Transport stopped](cpu-survey-2026-11-14-rig-reverb.json).
- [Transport running](cpu-survey-2026-11-14-rig-reverb-run.json).
- [The second core's work refused](cpu-survey-2026-11-14-rig-reverb-split-off.json), set with `tools/m1_link.py --rig cores split off`.

## Core 0's peak time

| Patch | Before, stopped | After, stopped | Before, running | After, running | Change running (points) |
|---|---:|---:|---:|---:|---:|
| Oracle V | 71.8 % | 72.1 % | 72.8 % | 73.8 % | +1.0 |
| Monolith D | 40.7 % | 40.5 % | 42.1 % | 42.0 % | -0.1 |
| Silver Box | 34.7 % | 35.0 % | 36.0 % | 36.4 % | +0.4 |
| Hera 3 | 63.6 % | 64.0 % | 64.6 % | 64.6 % | +0.0 |
| Sallen 20 | 53.4 % | 53.3 % | 55.3 % | 54.2 % | -1.0 |
| Expander S | 54.4 % | 53.8 % | 55.1 % | 56.2 % | +1.0 |
| Algo Four | 52.6 % | 53.5 % | 53.3 % | 54.2 % | +0.9 |
| Canvas | 64.6 % | 63.4 % | 64.7 % | 65.0 % | +0.3 |
| Wanderer | 50.5 % | 48.9 % | 50.9 % | 50.9 % | +0.0 |
| Briefcase 3 | 62.4 % | 56.0 % | 63.6 % | 57.6 % | -6.0 |
| Io 4 | 65.3 % | 66.1 % | 65.9 % | 67.2 % | +1.4 |
| Vernon 100 | 47.1 % | 46.8 % | 48.5 % | 48.7 % | +0.1 |
| 8 Lire | 46.3 % | 45.5 % | 47.9 % | 48.1 % | +0.2 |
| Elvira 2 | 34.4 % | 33.5 % | 35.6 % | 35.0 % | -0.6 |
| Scrounge | 45.0 % | 45.0 % | 47.6 % | 48.4 % | +0.9 |
| Meridian 8 | 37.9 % | 38.5 % | 41.0 % | 42.2 % | +1.2 |
| Perun 4 | 39.4 % | 39.4 % | 43.6 % | 46.2 % | +2.5 |
| 808 Kit | 52.2 % | 52.2 % | 57.2 % | 55.9 % | -1.3 |
| 909 Kit | 29.9 % | 30.6 % | 35.5 % | 35.0 % | -0.5 |
| Spokes 6 | 47.7 % | 47.6 % | 53.4 % | 53.7 % | +0.3 |
| Cassia 1 | 74.4 % | 73.5 % | 74.0 % | 74.6 % | +0.6 |
| Verona Drum 1 | 49.6 % | 50.3 % | 55.5 % | 56.3 % | +0.7 |

Briefcase 3 gains 6 points. The other patches move by less than 1.5 points either way, about what two surveys of one build differ by, except Perun 4 running (+2.5), which was not measured again.

## Why Canvas gains little

Canvas's Reverb runs (mix 0.15). `tools/m1_link.py --rig modtime` and `blocktime` on this build, 8 keys held: core 0 renders the Reverb's lines and 25 items and then waits 750 microseconds a half buffer for the second core, which renders 60 items in 1,489 microseconds. The plan balances by the CPU table's cost per module type ([D-1101](../ledger/engine.md#D-1101)). On the rig the lines take about 520 microseconds, close to the table's charge, but oscillators take about twice the table's charge and small modules more than that. So the plan believes the second core's list is shorter than it is. A plan from costs measured on the rig is the next step for Canvas.

## The estimate

The engine factors were refitted to these two surveys at the same scale ([D-365](../ledger/engine.md#D-365)). They run from 0.62 (Vernon 100) to 1.28 (Mono Lead). The second core's saving still counts at 0.75 of the modelled one, and stays under every patch's measured saving against the survey with the second core's work refused.
