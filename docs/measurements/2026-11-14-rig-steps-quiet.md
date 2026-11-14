# A Steps track's quiet samples in one pass, on the registered rig, 2026-11-14

Issues #802 and #878, [D-1102](../ledger/engine.md#D-1102). The firmware is CI run 43571432090 of branch `docs_headroom-balance`. It was installed through `npm run device:scenarios -- --install 43571432090` after the 30-second emulator boot check ([D-123](../ledger/releases.md#D-123)). The baseline is the two-core schedule's build, CI run 43551744806, measured the same day ([the two-core measurements](2026-11-14-rig-two-core-schedule.md)).

The surveys were taken the same way as the baseline's: `tools/rig_cpu_survey.py` reloaded each patch of the 1.14 bank for each phase (at rest, then 1, 4 and 8 keys held, 2 seconds each, sampled every 0.5 seconds). A phase's steady value is the lower median of its samples after the first. The tables give each patch's largest steady value over its phases, as a share of the 2,902-microsecond half buffer. No phase shed a voice, muted or came out late.

## What changed

The rig's time for each module (below) showed a running Steps track costing about 135 microseconds a half buffer, the same in every factory patch. A Steps module runs on core 0 and holds its place against every other module ([D-1101](../ledger/engine.md#D-1101)), so that time adds straight to the block. Its per-sample loop spent most samples counting down and writing the same outputs. `m_steps` now does each run of such samples at once (`steps_quiet`, `steps_skip` in `engine.c`). A track with an external clock or a reset cable keeps the per-sample loop. The output is the same, bit for bit: `tools/engine_exact.sh origin/main` (with `exact_steps.c`, which plays patterns with swing, hits, ticks and notes ending), `tools/lanes_exact.sh` and `tools/buffer_budget.py` pass.

On the rig, Canvas's Steps module went from about 135 to 48 microseconds a half buffer, 8 keys held. The CPU table's Steps cost went from 14,611 to 3,126 cycles a block, transport running.

## Raw data

- [Transport stopped](cpu-survey-2026-11-14-rig-steps.json).
- [Transport running](cpu-survey-2026-11-14-rig-steps-run.json).
- [The second core's work refused](cpu-survey-2026-11-14-rig-steps-split-off.json), set with `tools/m1_link.py --rig cores split off`.
- [Each module's time on the baseline build](modtime-2026-11-14-rig.json), from `tools/m1_link.py --rig modtime 3 --notes 8 --patch NAME` (DIAG pages 144 to 176), transport stopped, 8 keys held. Each entry is a module of the patch as the FM-1 holds it: its mean time a half buffer on core 0's lane and on core 1's, in nanoseconds.

## Core 0's peak time

| Patch | Before, stopped | After, stopped | Before, running | After, running | Change running (points) |
|---|---:|---:|---:|---:|---:|
| Oracle V | 74.4 % | 71.8 % | 75.2 % | 72.8 % | -2.4 |
| Monolith D | 44.0 % | 40.7 % | 44.7 % | 42.1 % | -2.6 |
| Silver Box | 37.6 % | 34.7 % | 39.0 % | 36.0 % | -3.0 |
| Hera 3 | 67.2 % | 63.6 % | 67.8 % | 64.6 % | -3.2 |
| Sallen 20 | 55.6 % | 53.4 % | 56.7 % | 55.3 % | -1.4 |
| Expander S | 56.8 % | 54.4 % | 58.0 % | 55.1 % | -2.9 |
| Algo Four | 57.0 % | 52.6 % | 55.7 % | 53.3 % | -2.4 |
| Canvas | 66.6 % | 64.6 % | 68.6 % | 64.7 % | -3.9 |
| Wanderer | 52.8 % | 50.5 % | 54.1 % | 50.9 % | -3.2 |
| Briefcase 3 | 65.0 % | 62.4 % | 66.4 % | 63.6 % | -2.8 |
| Io 4 | 68.3 % | 65.3 % | 68.7 % | 65.9 % | -2.8 |
| Vernon 100 | 49.7 % | 47.1 % | 50.7 % | 48.5 % | -2.2 |
| 8 Lire | 48.8 % | 46.3 % | 50.5 % | 47.9 % | -2.6 |
| Elvira 2 | 37.4 % | 34.4 % | 38.5 % | 35.6 % | -2.9 |
| Scrounge | 47.0 % | 45.0 % | 54.7 % | 47.6 % | -7.1 |
| Meridian 8 | 40.0 % | 37.9 % | 45.2 % | 41.0 % | -4.2 |
| Perun 4 | 42.2 % | 39.4 % | 51.5 % | 43.6 % | -7.9 |
| 808 Kit | 56.6 % | 52.2 % | 63.1 % | 57.2 % | -5.9 |
| 909 Kit | 33.0 % | 29.9 % | 40.9 % | 35.5 % | -5.4 |
| Spokes 6 | 50.9 % | 47.7 % | 65.5 % | 53.4 % | -12.1 |
| Cassia 1 | 76.0 % | 74.4 % | 76.3 % | 74.0 % | -2.3 |
| Verona Drum 1 | 52.8 % | 49.6 % | 61.8 % | 55.5 % | -6.3 |

The busiest factory patch is now Cassia 1 at 74.4 % with the transport stopped, then Oracle V at 72.8 % running.

## The estimate

The engine factors were refitted to these two surveys at the same scale ([D-365](../ledger/engine.md#D-365)). They run from 0.61 (Vernon 100) to 1.28 (Mono Lead). The second core's saving still counts at 0.75 of the modelled one: `cpu.test.ts` checks that it stays under every patch's measured saving against the survey with the second core's work refused.

## What the module times show about the plan

The plan ([D-1101](../ledger/engine.md#D-1101)) charges each copy its type's cost from the CPU table (`DEF_COST`). On the rig, a type's measured time divided by that charge varies widely: about 2.5 for oscillators, 4.5 for VCAs and 0.25 for reverbs, summed over the factory patches. The editor's full estimate for each module, which counts its settings and its patched inputs, comes within 0.8 to 1.2 of the rig for most types. A model of the scheduled block, fed the baseline's measured module times, puts what a plan from the full per-module estimate would save at about 170 microseconds on Verona Drum 1, 150 on Scrounge, 80 on Sallen 20 and under 75 on every other patch. It saves nothing on Canvas: Canvas's block is bounded by its longest chain of copies that wait for each other, which ends in its Reverb (about 385 microseconds).
