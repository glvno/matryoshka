# The headroom baseline on the registered rig, 2026-11-14

Issue #868, step 7 of its plan. The firmware is CI run 43655015787 of `main` at commit 0b7b930a, the build with modulation every 16 samples ([D-1106](../ledger/engine.md#D-1106)). It was installed through `npm run device:scenarios -- --install 43655015787` after the 30-second emulator boot check ([D-123](../ledger/releases.md#D-123)). Both cores ran; all 22 device checks passed.

The surveys were taken the same way as the factory bank's ([the survey of the same engine](cpu-survey-2026-11-14-rig-modctl.json)): `tools/rig_cpu_survey.py` reloaded each patch for each phase (at rest, then 1, 4 and 8 keys held, 2 seconds each, sampled every 0.5 seconds), once with the transport stopped and once running. A phase's steady value is the lower median of its samples after the first. The tables give each patch's largest steady value over its phases, as a share of the 2,902-microsecond half buffer. The patches were written by a throwaway script from the factory bank (`encodePatch`, as `export-defs` writes them) and surveyed from a directory of binaries.

The first sample of every phase includes the patch's load, because the survey reloads the patch for each phase. With 8 voices and every master FX stage on, Algo Four's first sample reached 3,411 microseconds (118 %). That is the load, not playing: the rest phase, with no key down, shows the same first sample.

## Raw data

- More voices, the master FX as saved: [stopped](cpu-survey-2026-11-14-rig-step7-voices.json), [running](cpu-survey-2026-11-14-rig-step7-voices-run.json).
- Every master FX stage on: [stopped](cpu-survey-2026-11-14-rig-step7-fx.json), [running](cpu-survey-2026-11-14-rig-step7-fx-run.json).
- Every master FX stage on and more voices: [stopped](cpu-survey-2026-11-14-rig-step7-fx-voices.json), [running](cpu-survey-2026-11-14-rig-step7-fx-voices-run.json).

## More voices than the patches play

The VOICES row stops at the most voices whose CPU estimate is at most 90 % ([D-870](../ledger/patches-and-presets.md#D-870)). The factory patches play 4 voices (Oracle V, Cassia 1, Algo Four) and 3 (Expander S), and their rows stop there. No phase shed a voice, muted or came out late.

| Patch, voices | Rig, stopped | Rig, running | Estimate |
|---|---:|---:|---:|
| Oracle V, 5 | 81.0 % | 81.6 % | 86.6 % |
| Cassia 1, 5 | 80.6 % | 81.7 % | 82.6 % |
| Algo Four, 8 | 79.2 % | 79.7 % | 86.3 % |
| Expander S, 6 | 75.4 % | 76.2 % | 85.4 % |

The estimate reads at least the rig at every one of these counts. Added to the fit (`web/scripts/cpu-rig-fit.ts`), they leave the engine factors unchanged ([D-365](../ledger/engine.md#D-365)): each factor is the most any of its patch's measurements needs, and the measurements at 4 voices already need more.

## Every master FX stage on (issue #847)

Twelve factory patches have a master FX bus. Each was surveyed with every stage of its bus on. No phase shed a voice, muted or came out late.

| Patch | Stages | As saved | All on | Estimate, all on |
|---|---|---:|---:|---:|
| Oracle V | drive, chorus | 71.2 % | 74.0 % | 76.9 % |
| Cassia 1 | drive, delay | 69.2 % | 73.5 % | 71.4 % |
| Expander S | drive, chorus, delay, reverb | 54.4 % | 73.2 % | 74.2 % |
| Algo Four | drive, delay, reverb | 52.1 % | 70.7 % | 69.5 % |
| Io 4 | drive, delay | 63.7 % | 66.2 % | 66.3 % |
| Canvas | delay | 64.0 % | 65.7 % | 65.5 % |
| Wanderer | drive, delay, reverb | 50.6 % | 64.7 % | 69.7 % |
| Briefcase 3 | drive, chorus, delay | 56.1 % | 62.1 % | 62.2 % |
| Sallen 20 | drive, chorus, delay | 52.4 % | 58.1 % | 58.7 % |
| Monolith D | drive, chorus, delay, reverb | 41.4 % | 55.9 % | 57.5 % |
| Vernon 100 | drive, chorus, delay | 47.4 % | 52.2 % | 53.6 % |
| Silver Box | drive, chorus, delay, reverb | 35.3 % | 49.2 % | 52.3 % |

"As saved" is the larger of stopped and running in [the bank's survey](cpu-survey-2026-11-14-rig-modctl.json), taken an hour earlier on CI run 43652865098: the same engine, with the two-core plan's module costs from before the last refit. "All on" is the larger of the two here. Every patch fits with all its stages on, the highest at 74 %. The estimate reads within 2.1 points under and 5.0 over the rig. It reads under for Cassia 1 (2.1 points) and Algo Four (1.2): their stages are outside the factory engines, which the factors do not cover.

## Every master FX stage on and more voices

| Patch, voices | Rig, stopped | Rig, running | Estimate | Shed, muted or late |
|---|---:|---:|---:|---|
| Oracle V, 5 | 83.9 % | 85.0 % | 91.7 % | none |
| Cassia 1, 5 | 83.5 % | 83.9 % | 84.6 % | none |
| Algo Four, 6 | 84.1 % | 85.5 % | 87.7 % | none |
| Algo Four, 8 | 92.6 % | 92.8 % | 100.8 % | 4 phases shed a voice |
| Expander S, 4 | 82.1 % | 82.7 % | 86.7 % | none |
| Expander S, 5 | 89.8 % | 90.1 % | 97.2 % | none |

With every stage on, Oracle V and Cassia 1 hold 5 voices at about 85 % on the rig. Algo Four holds 6. At 8 its overload guard dropped a voice ([D-362](../ledger/engine.md#D-362)). Expander S holds 4; at 5 it reaches the guard's 90 %.
