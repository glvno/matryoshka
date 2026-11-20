# Oracle V with the pedal modes and A-440, test rig, 2026-11-20

Oracle V with the Prophet-5 Rev 4's release pedal modes and A-440 tone (#862, PR #1146, [D-742](../ledger/fidelity.md#D-742), [D-743](../ledger/fidelity.md#D-743)), checked on the test rig.

## Build and method

- **Firmware:** CI run 44809176552 (branch `oracle-pedal` at d012ce36, main with 1.23.0 merged), installed on the rig through the boot check (`emu:boot`, [D-123](../ledger/releases.md#D-123)). `checkDualCore` passed its CPU and voice checks (nothing shed, no overload). Its USB audio stream check failed: the Mac's recording stalled (0.40 s of audio in 4.73 s).
- **Patches:** the factory patch at five voices as shipped, with every stage of its master FX bus on (`fx`), `a440 fx` (every stage on and A-440 ON), `hold fx` (every stage on and the pedal on HOLD), and each factory preset, as the FM-1 loads it at five voices, with every stage on.
- **Load** (`tools/rig_cpu_survey.py`): 0, 1, 4 and 8 held keys, 2 seconds each, transport stopped and running. Worst steady is the largest lower median of a phase's samples after the first, as a share of the 2,902 µs half-block. "Dropped" counts voices shed, overloads and late halves over all phases.

## Results (worst steady %, stopped / running)

| Patch | As tested | Dropped |
|---|---|---|
| Oracle V, as shipped | 69.1 / 72.4 | 0 |
| Oracle V fx | 78.0 / 78.9 | 0 |
| Oracle V a440 fx | 77.8 / 78.3 | 0 |
| Oracle V hold fx | 78.4 / 77.8 | 0 |
| Init, Sync Lead, Poly Brass, Vintage Strings, Poly-Mod Bell, Unison Bass, each fx | 77.6–78.9 / 78.8–79.6 | 0 |

Every patch is under the 85 % limit while running, at most 79.6 % (Unison Bass with every stage on). The [500 Hz LFO record](2026-11-18-rig-oracle-lfo500.md) measured 71.7 / 73.9 as shipped and 79.0 / 79.9 with every stage on before this change.

The CPU estimate reads 70.6 % as shipped and 77.8 % with every stage on, and 77.5–78.1 % for each factory preset with every stage on.

## Raw data

[stopped](cpu-survey-2026-11-20-rig-oracle-pedal.json), [running](cpu-survey-2026-11-20-rig-oracle-pedal-run.json).
