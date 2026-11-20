# The 808 and 909 Kits with VELOCITY, test rig, 2026-11-20

The 808 Kit's and 909 Kit's VELOCITY row (PR #1159, issue #1158, [D-1053](../ledger/fidelity.md#D-1053), [D-1055](../ledger/fidelity.md#D-1055)) against release 1.23.0 on the test rig, in one session, each build freshly installed ([D-1165](../ledger/releases.md#D-1165)).

## Builds and method

- **The branch:** firmware CI run 44817996853 (branch `kit-velocity` at 77fdb313, main merged in), installed on the rig with its factory region (version 19, set 4081bb) by `tools/fm1_install.py --rig`.
- **1.23.0:** the release package `matryoshka-1.23.0.fwsc` (FM-1_7012300), then the factory region of the v1.23.0 tag (version 18, set 969c2c), installed the same way after the branch.
- **Patches:** the 808 Kit with every stage of its master FX bus on (`808 Kit fx`) and the 909 Kit, which has no FX bus. On the branch each at VELOCITY 0 (as shipped) and 1 (`v0`, `v100`).
- **Load** (`tools/rig_cpu_survey.py`): 0, 1, 4 and 8 held keys, 2 seconds each, transport stopped and running. Worst steady is the largest lower median of a phase's samples after the first, as a share of the 2,902 µs half-block. "Dropped" counts voices shed, overloads and late halves over all phases.

## Results (worst steady %, stopped / running)

| Patch | 1.23.0 | Branch, VELOCITY 0 | Branch, VELOCITY 1 | Dropped |
|---|---|---|---|---|
| 808 Kit fx | 71.8 / 80.0 | 74.9 / 82.1 | 76.5 / 79.4 | 0 |
| 909 Kit | 64.2 / 68.6 | 66.2 / 75.4 | 66.6 / 71.6 | 0 |

Every patch is under the 85 % limit while running, at most 82.1 % (the 808 Kit with every stage on, VELOCITY 0). The release qualification of 1.23.0 measured 73.3 / 78.0 for `808 Kit fx` and 65.2 / 69.7 for the 909 Kit. The running figures move by up to about 4 points between readings of one patch: the 909 Kit read 75.4 at VELOCITY 0 and 71.6 at 1, with the same modules running. The branch adds about 2 to 3 points stopped on both kits.

The CPU estimate reads 87.2 % for `808 Kit fx` and 74.2 % for the 909 Kit on the branch: about 5 points above the rig for the 808 and in line with it for the 909.

## Raw data

Branch: [stopped](cpu-survey-2026-11-20-rig-kit-velocity.json), [running](cpu-survey-2026-11-20-rig-kit-velocity-run.json). 1.23.0: [stopped](cpu-survey-2026-11-20-rig-kit-velocity-1.23.0.json), [running](cpu-survey-2026-11-20-rig-kit-velocity-1.23.0-run.json).
