# The combined 1.12 build on the registered rig, 2026-11-09

The default build was measured on the registered FM-1 at its recorded USB location. Only that device was used. Firmware CI [42673451565](https://github.com/glvno/matryoshka/actions/runs/42673451565), commit `774e1ddc9815188c2df1f04b4606b3734171ec3a`, contains the combined changes and the qualification fixes. AOT compilation and RAM placement were disabled; buffer sharing was enabled; the audio path used `-O2`. [The build manifest](2026-11-09-integration-builds.json) records the hashes and switches.

## Method

`tools/rig_cpu_survey.py firmware/src/presets.h OUT.json` uploaded every factory patch at rest and with 1, 4 and 8 held notes. A second pass used `--run` to start each patch's transport. Each phase reloaded the patch, held it for two seconds and sampled every half second. Reloading prevents a voice dropped in one phase from making the next phase look cheaper.

Steady time is the lower median of a phase's samples after the first. The table takes the largest steady time across its four note counts, as a percentage of the 2,902 microsecond half buffer. The raw peak includes the first block and is not the same measure. USB audio was not streaming during the block-time measurements taken after the survey.

- [Stopped playback](cpu-survey-2026-11-09-rig-integration.json).
- [Running playback](cpu-survey-2026-11-09-rig-integration-run.json).

All 240 phases completed without voice shedding, overload muting or late audio halves. This checks the existing voice counts; it does not establish that higher counts fit.

| Factory patch | Steady %, stopped | Steady %, running |
|---|---:|---:|
| Oracle V | 77.7 | 77.3 |
| Init | 23.9 | 24.6 |
| Simple FM | 23.4 | 24.1 |
| Plucked String | 31.4 | 32.3 |
| Monolith D | 47.8 | 48.8 |
| Silver Box | 37.8 | 38.6 |
| Hera 4 | 83.4 | 85.1 |
| Sallen 20 | 64.3 | 65.2 |
| Expander S | 59.2 | 60.2 |
| Algo Four | 74.4 | 75.7 |
| Canvas | 83.8 | 84.9 |
| Wanderer | 63.7 | 64.5 |
| Briefcase 3 | 76.4 | 78.2 |
| Io 4 | 65.6 | 68.7 |
| Vernon 100 | 61.3 | 62.9 |
| 8 Lire | 74.8 | 76.2 |
| Elvira 2 | 49.7 | 51.5 |
| Scrounge | 67.9 | 73.4 |
| Meridian 8 | 63.6 | 68.8 |
| Perun 4 | 66.4 | 73.5 |
| 808 Kit | 76.2 | 80.3 |
| 909 Kit | 49.6 | 54.1 |
| <7PH | 73.2 | 81.6 |
| Spokes 6 | 72.5 | 83.7 |
| Cassia 1 | 76.1 | 76.3 |
| Basic Poly | 31.0 | 32.4 |
| Drift Poly | 40.0 | 41.6 |
| Mono Lead | 29.3 | 29.9 |
| Supersaw Stack | 39.3 | 41.2 |
| Verona Drum 1 | 76.2 | 81.3 |

## Comparison with released 1.11.1

The rig was then installed with the published 1.11.1 package (`FM-1_7011101`, SHA-256 `368def10bf83e1ee0c524173a3d270d21eb8f5171ecd7785e02be34018a35cef`). Seven representative patches were measured again with the same controller, patch bytes, note counts and timing. The following numbers take the larger steady result across stopped and running playback. They describe the combined changes, not the isolated effect of `-O2` or any individual optimization.

- [1.11.1 stopped playback](cpu-survey-2026-11-09-rig-1.11.1.json).
- [1.11.1 running playback](cpu-survey-2026-11-09-rig-1.11.1-run.json).

| Patch | 1.11.1 steady % | Combined build steady % | Change, percentage points |
|---|---:|---:|---:|
| Oracle V | 74.4 | 77.7 | +3.3 |
| Init | 21.0 | 24.6 | +3.7 |
| Hera 4 | 84.5 | 85.1 | +0.6 |
| Algo Four | 77.3 | 75.7 | -1.6 |
| 808 Kit | 83.0 | 80.3 | -2.7 |
| Cassia 1 | 77.3 | 76.3 | -1.0 |
| Verona Drum 1 | 85.4 | 81.3 | -4.1 |

The change is not a universal speed-up. Oracle V and Init need more time in this batch, while several heavier patches need less. These observations do not isolate the cause of each difference. No automatic increase in factory voices accompanies the calibration.

## CPU model

`web/scripts/cpu-rig-fit.ts` fits the combined build's two complete surveys. The resulting scale is 195.8 counted cycles per microsecond, plus 270 microseconds per block. The scaled second-core idle cost is 29 microseconds. Factory engine factors range from 0.64 to 1.28. `web/scripts/cpu-costs.ts` freezes these values; `web/src/cpu-costs.json` records the generated table and source surveys. The 169 CPU tests passed, including each measured factory patch's allowed model error. Regenerating the firmware headers produced no change.

## Correctness evidence

The corrected build passed 324 emulator smoke checks with no failures or level warnings. Host comparison against the consolidated pre-fix commit `fbee51f8` kept all 30 factory patches bit-identical, including poisoned-buffer runs. The only changed golden outputs were the positive Cadd9 inversion cases deliberately corrected by the Harmonizer fix; the full 475-kit reference comparison passed.

The complete hardware batch's failed checks were rerun selectively. The old-pattern and flash-recording checks passed. The teaching-controls check passed after it stored a fresh factory patch in an empty temporary bank slot and erased that slot afterwards; an existing edited bank entry had invalidated its fixture. The corrected firmware then passed all 30 focused Live-edit and dual-core checks, including recordings on Io 4, Hera 4 and Cassia 1 with no dropped voices, overloads or audio dropouts.

These are automated checks. They do not replace the owner's headphone, playing-feel and power-cycle checks required by [D-139](../ledger/releases.md#D-139).
