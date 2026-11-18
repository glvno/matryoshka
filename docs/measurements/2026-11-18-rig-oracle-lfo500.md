# Oracle V with the 500 Hz LFO, test rig, 2026-11-18

Oracle V's LFO rebuilt to reach the Prophet-5's 500 Hz, with Wheel-Mod freq A and B at audio rate (#862, [D-743](../ledger/fidelity.md#D-743)), checked on the test rig.

## Build and method

- **Firmware:** CI run 44356704011 (branch `docs_oracle-lfo500`), installed on the rig through the boot check (`emu:boot`, [D-123](../ledger/releases.md#D-123)); `checkDualCore` passed on it (22 of 22 checks).
- **Patches:** the factory patch at five voices as shipped, with every stage of its master FX bus on (`fx`), each factory preset with every stage on, and `lfo500 fx`: every stage on with `lfo freq` 4 (500 Hz) and `lfo amount` 1.
- **Load** (`tools/rig_cpu_survey.py`): 0, 1, 4 and 8 held keys, 2 seconds each, transport stopped and running. Worst steady is the largest lower median of a phase's samples after the first, as a share of the 2,902 µs half-block. "Dropped" counts voices shed, overloads and late halves over all phases.

## Results (worst steady %, stopped / running)

| Patch | As tested | Dropped |
|---|---|---|
| Oracle V, as shipped | 71.7 / 73.9 | 0 |
| Oracle V fx | 79.0 / 79.9 | 0 |
| Oracle V lfo500 fx | 80.0 / 81.2 | 0 |
| Init, Sync Lead, Poly Brass, Vintage Strings, Poly-Mod Bell, Unison Bass, each fx | 70.3–70.8 / 72.2–73.1 | 0 |

The presets were measured at the card's four voices, before #1093 made them load five; FxVoices' rig run of the presets at five with every stage on, without this change, measured 79.0–80.9 %. The factory patch was measured at five. Before this change the 1.20 record measured 70.9 / 73.6 as shipped and 78.9 / 79.9 with every stage on ([the 1.20 voices record](2026-11-18-rig-voices-120.md)).

The CPU estimate, with the master FX bus's own rig factor (#1093), reads 83.9 % with every stage on (75.5 % as shipped), and 82.8–84.3 % for each factory preset at five voices with every stage on.

## Raw data

[stopped](cpu-survey-2026-11-18-rig-oracle-lfo500.json), [running](cpu-survey-2026-11-18-rig-oracle-lfo500-run.json).
