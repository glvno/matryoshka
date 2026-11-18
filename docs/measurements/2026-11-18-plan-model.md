# The two-core plan against the test rig's module times, 2026-11-18

Issue #1073 (pull request #1079). The FM-1 plans which core plays each copy of each module when a patch loads ([D-1101](../ledger/engine.md#D-1101)). This note compares three plans on the module times the test rig measured, and records why the plan in #1079 now makes two plans and keeps one.

- **Module times:** `tools/m1_link.py --rig modtime 3 --notes 8 --patch NAME` on firmware CI run 44241663949 (main at `bdeee487`), transport stopped: the 21 factory patches of `firmware/src/presets.h` and the 11 patches of the poly benchmark (`web/scripts/poly-bench.ts` on branch `fm1-poly-headroom`). The factory and seven benchmark files are in `modtime-2026-11-17-plan.json`.
- **Shedding patches:** Oracle V fx, Oracle V fx4 and Hera 6 fx4 dropped voices while they were measured, so their voices read 25 to 30 % low. Their voice modules take the larger of their own time and the time in Oracle V (factory) or Hera 6 fx at the same index (`plan-eval.ts --fix`).
- **Model:** `web/scripts/plan-eval.ts` times each lane as the FM-1 renders it: items in the patch's order, each waiting for the items whose signals it reads. Each item costs its module's measured time per copy plus 400 cycles. The 400 cycles are rendering an item outside the module's timed span; they were fitted to core 0's voices span (`blocktime`) on the eight benchmark patches that shed nothing. With them, the model of today's plan is within 23 µs (standard deviation) of the rig, mean 0. Results: `2026-11-18-plan-model.json`.
- **Points:** of the 2,902 µs half buffer. Negative is faster than today.

## The three plans

- **main:** each copy goes where it ends first, at the CPU table's costs (the FM-1 today).
- **median:** the same, at each type's median time measured on the rig (#1079's first version).
- **plan:** #1079 now. Two plans, one at the table's costs and one at the rig's. The rig's costs count an oscillator times its voices (unison or chord stack) and add 4 units an item. The rig's plan is kept only when, counted at the rig's costs, it ends at least 4 % sooner than the table's plan (`SCH_GAIN` 25).

| patch | main µs | median | plan |
|---|---|---|---|
| 808 Kit | 1788 | −1.0 | 0.0 |
| 8 Lire | 1032 | +1.9 | 0.0 |
| 909 Kit | 1939 | +0.9 | −1.6 |
| Algo Four | 1588 | −0.7 | 0.0 |
| Briefcase 3 | 1735 | −1.8 | 0.0 |
| Canvas | 1617 | −4.2 | −3.6 |
| Cassia 1 | 1832 | −1.6 | 0.0 |
| Elvira 2 | 765 | 0.0 | 0.0 |
| Expander S | 1514 | −0.8 | 0.0 |
| Hera 6 | 1824 | +1.5 | 0.0 |
| Io 4 | 1667 | −1.2 | 0.0 |
| Meridian 8 | 1603 | −1.5 | −0.5 |
| Monolith D | 924 | −1.1 | 0.0 |
| Oracle V | 1895 | −1.4 | −1.2 |
| Sallen 20 | 1333 | −1.9 | 0.0 |
| Scrounge | 1979 | −1.8 | −1.8 |
| Shush 101 | 1031 | +0.5 | +0.5 |
| Silver Box | 764 | −1.4 | 0.0 |
| Vernon 100 | 1144 | +0.9 | 0.0 |
| Verona Drum 1 | 1643 | +7.4 | −2.1 |
| Wanderer | 1238 | +0.1 | 0.0 |
| Algo Four fx | 2252 | −9.0 | −8.4 |
| Cassia 1 fx | 2279 | −5.7 | −7.0 |
| Cassia 1 fx4 | 2364 | −5.7 | −7.1 |
| Expander S fx | 2250 | −8.3 | −10.2 |
| Hera 6 fx | 2410 | −6.9 | −10.1 |
| Hera 6 fx4 | 2545 | −6.9 | −10.0 |
| Hera 6 gauze 2 | 2448 | −6.9 | −10.0 |
| Io 4 fx | 2234 | −7.8 | −8.7 |
| Io 4 fx4 | 2314 | −7.9 | −8.8 |
| Oracle V fx | 2641 | −8.2 | −8.5 |
| Oracle V fx4 | 2674 | −8.2 | −8.5 |

Factory bank: median worst +7.4 (Verona Drum 1), plan worst +0.5 (Shush 101), mean −0.5. Benchmark: plan −7.0 to −10.2, mean −8.9.

## What was found

- **The rig's per-type costs are far from per-module times.** An oscillator costs 51 to 922 units a copy across the bank. Verona Drum 1's two unison-5 oscillators cost 700 to 900 units against a median of 154; priced at the median, the plan moves them and the cross-core waits grow (+7.4). Counting an oscillator times its voices fixes Verona (−2.1).
- **With every module's own time (an oracle), the same planner gains on every patch:** benchmark −7.3 to −11.6, factory bank worst +0.2. So the order and the lane rule are good enough; the costs are what is missing. The per-type costs cannot be made that good: the first module of a type in a lane also pays for fetching its code (about 50 units for an envelope, 130 for a filter), and many types vary with their settings.
- **A local improvement pass** (move one item to the other lane while the estimate ends sooner) improves the estimate but not the rig's model: it optimizes the wrong costs. It is not used.
- **Where the rig's plan is estimated to gain less than about 4 %, the outcome is a coin toss** (8 Lire estimated 2.4 % better, +1.6 on the rig's times; Briefcase 3 2.9 % better, −1.8). Above about 5 % it gains on every patch. Keeping the table's plan below 4 % removes the bank's regressions and keeps the benchmark's gain.
- **The editor's mirror counted a one-kernel Reverb stage's helper modules as bypassed;** the patch binary never marks them bypassed, so the firmware counted them at their full cost. `schedule.ts` now takes them from `fx-bus.ts fxHelperIds`. After the change, the editor's plan equals the firmware's on all 32 patches (a host build of `engine.c` against `schedule.ts`, item by item).

## Cost of planning

- A host build of `engine.c` (Apple M-series) takes about 2.1 times as long in `sched_build` as main does: the worst factory patch 208 µs against 99 µs. Each item's waits are found again in each of the four passes.
- RAM: no change in `.data`, `.bss`, the pool or `.lowram`. The table plan's lanes while the rig's plan is made take 36 bytes of NOINIT (`sch_keep`). The second cost table (`DEF_TCOST`, 114 bytes) is in flash.
- On the FM-1: `tools/m1_link.py loadtime` measures a load's silence from the halves the engine stays stopped. Not yet run (rig turn pending).

## Not yet measured

- The rig before and after on the poly benchmark and the whole bank, stopped and running.
- Module times with the transport running (`modtime --run`) for the model's running case.
