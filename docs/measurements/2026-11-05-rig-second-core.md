# The second core on the test rig (#271), 2026-11-04 / 05

Measured with `tools/rig_cpu_survey.py` on the test FM-1: the longest audio interrupt in µs, at rest and with 1, 4 and 8 notes held, sampled every 0.5 s, every factory patch. "Steady" is the median of the samples after the first. The budget is 2,902 µs a half. `tools/rig_core1_compare.py` makes the tables.

## What an idle second core costs core 0

Every run below is the same firmware as its base except where noted. The base, `cpu-survey-2026-11-05-rig-core1-held.json`, is CI run 41945370767 with core 1 held (stopped by the fallback test). Steady time, change against the base:

| run (file `…-core1-idle-*.json`) | what core 1 does | rest | 8 keys | worst patch, 8 keys |
|---|---|---|---|---|
| `poll` (CI 41945370767) | polls its mailbox back to back | +5.3 % | +4.0 % | +9.8 % (Simple FM) |
| `w0` (CI 41974239718) | a pause of 16 × 4 nops between polls | +4.9 % | +3.3 % | +10.1 % (Simple FM) |
| `w12` (CI 41980646642) | a pause of 1,024 × 4 nops | +4.6 % | +3.2 % | +8.0 % (Init) |
| `ram` (CI 41982086048) | `w12`, self-test on a table in RAM | +4.7 % | +3.1 % | +8.8 % (Simple FM) |
| `notest` (CI 41989932170) | `w12`, no periodic self-test | +4.2 % | +2.6 % | +9.6 % (Simple FM) |

Run-to-run noise is about 2 %. The cost is a near-constant 20–50 µs a half: up to about 10 % on the lightest patches, 0–3 % on the heaviest. The polling, the self-test and its flash reads are not its cause.
