# The two-core schedule on the registered rig, 2026-11-14

Issue #802, pull request #886, [D-1101](../ledger/engine.md#D-1101). The firmware is CI run 43551744806 of branch `docs_two-core-schedule`. It was installed through `npm run device:scenarios -- --install 43551744806` after the 30-second emulator boot check ([D-123](../ledger/releases.md#D-123)). The baseline is release 1.14.0, which was on the rig before. Its engine is the one on `main` at the time: since `v1.14.0`, `main` changed no rendering code.

`tools/rig_cpu_survey.py` played every patch of the 1.14 bank (`firmware/src/presets.h`). It reloaded the patch for each phase: at rest and with 1, 4 and 8 keys held, 2 seconds each, sampled every 0.5 seconds. A phase's steady value is the lower median of its samples after the first. The tables give each patch's largest steady value over its phases, as a share of the 2,902-microsecond half buffer. No phase on the two-core build shed a voice, muted or came out late.

## Raw data

- [Two-core build, transport stopped](cpu-survey-2026-11-14-rig-two-core.json).
- [Two-core build, transport running](cpu-survey-2026-11-14-rig-two-core-run.json).
- [Two-core build with the second core's work refused](cpu-survey-2026-11-14-rig-two-core-split-off.json), set with `tools/m1_link.py --rig cores split off`. Core 0 then renders every module while the second core waits.
- [The 1.14.0 baseline, transport stopped](cpu-survey-2026-11-14-rig-1.14.0.json), taken the same evening on the same rig.

## Core 0's peak time

| Patch | 1.14.0, stopped | Two-core, stopped | Change (points) | Two-core, running |
|---|---:|---:|---:|---:|
| Oracle V | 77.2 % | 74.4 % | -2.8 | 75.2 % |
| Monolith D | 53.0 % | 44.0 % | -9.0 | 44.7 % |
| Silver Box | 43.0 % | 37.6 % | -5.4 | 39.0 % |
| Hera 3 | 80.3 % | 67.2 % | -13.1 | 67.8 % |
| Sallen 20 | 66.2 % | 55.6 % | -10.5 | 56.7 % |
| Expander S | 65.8 % | 56.8 % | -9.1 | 58.0 % |
| Algo Four | 56.5 % | 57.0 % | +0.5 | 55.7 % |
| Canvas | 86.4 % | 66.6 % | -19.8 | 68.6 % |
| Wanderer | 67.1 % | 52.8 % | -14.3 | 54.1 % |
| Briefcase 3 | 74.9 % | 65.0 % | -10.0 | 66.4 % |
| Io 4 | 76.1 % | 68.3 % | -7.8 | 68.7 % |
| Vernon 100 | 64.9 % | 49.7 % | -15.2 | 50.7 % |
| 8 Lire | 67.3 % | 48.8 % | -18.5 | 50.5 % |
| Elvira 2 | 44.9 % | 37.4 % | -7.5 | 38.5 % |
| Scrounge | 61.7 % | 47.0 % | -14.6 | 54.7 % |
| Meridian 8 | 59.9 % | 40.0 % | -19.8 | 45.2 % |
| Perun 4 | 56.3 % | 42.2 % | -14.1 | 51.5 % |
| 808 Kit | 76.3 % | 56.6 % | -19.7 | 63.1 % |
| 909 Kit | 48.2 % | 33.0 % | -15.2 | 40.9 % |
| Spokes 6 | 64.8 % | 50.9 % | -13.9 | 65.5 % |
| Cassia 1 | 77.6 % | 76.0 % | -1.6 | 76.3 % |
| Verona Drum 1 | 76.1 % | 52.8 % | -23.3 | 61.8 % |

Patches without a poly group gain the most, because the second core did nothing for them before. The large poly patches (Oracle V, Algo Four, Cassia 1) gain little: the voice split of [D-391](../ledger/engine.md#D-391) already used both cores for them. The running column is higher for patches with Steps tracks. A Steps module stays on core 0 and keeps its place in the order, and a playing track costs more than a stopped one. There is no running baseline for 1.14.0.

## Where each core's time goes

`tools/m1_link.py --rig blocktime 3 --notes 4` (DIAG pages 132 to 139), mean microseconds per half buffer:

| Patch | All modules | Core 0 waits for core 1 | Core 1 busy |
|---|---:|---:|---:|
| 808 Kit | 1,466 | 2 | 1,267 |
| Verona Drum 1 | 1,337 | 341 | 1,181 |
| Canvas | 1,707 | 806 | 1,515 |
| Oracle V | 1,934 | 69 | 1,764 |

The schedule balances the cores by each module type's cost from the CPU table. Canvas and Verona Drum 1 leave core 0 waiting for core 1 for a quarter to half of the block. Balancing by measured cost could recover part of that.

## The second core

`tools/m1_link.py --rig cores` after each survey reported two cores and no bar. There were no failed self-tests and no refused jobs. Core 1's stack peaked at 2,332 of the 3,328 bytes it may use ([D-379](../ledger/engine.md#D-379)). The rig's dual-core scenarios passed: Io 4, Hera 4 and Cassia 1 with 8 keys held, recorded without dropouts, shedding or late halves. The full rig scenario run (66 of 70 checks passed, 4 skipped as the rig cannot judge them) passed on CI run 43548068693. That build's schedule differs only in a few module types' costs.

## The CPU model

`web/scripts/cpu-rig-fit.ts` fitted each factory engine's factor to the stopped and running surveys at the frozen scale. The 1.14 bank has no patch without an engine of its own, so the scale was not refitted. The two-core saving uses 0.75 of the modelled saving. On the patches that did not shed voices on one core, the measured saving allows up to 0.80 (Verona Drum 1). The patches that shed voices on one core were Oracle V, Hera 3, Io 4 and Cassia 1. `web/src/cpu.test.ts` holds every patch's estimate within -3 and +5 points of these surveys. It also checks that the estimate never promises more than the split-off survey shows the second core saved.

These are automated checks. They do not replace the owner's headphone, playing-feel and power-cycle checks required by [D-139](../ledger/releases.md#D-139).
