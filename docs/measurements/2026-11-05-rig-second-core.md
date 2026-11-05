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

## The voice split (#271 step 3)

The split build is CI run 42000479134 (branch `dual-core-271-split`). On the same firmware, `tools/m1_link.py cores split off` makes core 0 render every part while core 1 stays up. Files: `cpu-survey-2026-11-05-rig-split.json` (split on), `cpu-survey-2026-11-05-rig-split-off.json` (split off, core 1 idle). Both are compared with the one-core base above. Steady µs a half with 8 keys held:

| patch | one core | core 1 idle | split | split vs one core |
|---|---|---|---|---|
| Oracle V | 1848 | 1909 (+3.3 %) | 1315 | -28.8 % |
| Init | 522 | 559 (+7.1 %) | 559 | +7.1 % |
| Simple FM | 523 | 602 (+15.1 %) | 605 | +15.7 % |
| Plucked String | 1167 | 1148 (-1.6 %) | 766 | -34.4 % |
| Monolith D | 1037 | 1122 (+8.2 %) | 1110 | +7.0 % |
| Silver Box | 753 | 834 (+10.8 %) | 826 | +9.7 % |
| Hera 6 | 2020 | 2081 (+3.0 %) | 1365 | -32.4 % |
| Sallen 20 | 1464 | 1549 (+5.8 %) | 1566 | +7.0 % |
| Expander S | 1681 | 1759 (+4.6 %) | 1119 | -33.4 % |
| Algo Four | 1669 | 1799 (+7.8 %) | 1301 | -22.0 % |
| Canvas | 2092 | 2221 (+6.2 %) | 2212 | +5.7 % |
| Wanderer | 1011 | 1106 (+9.4 %) | 1095 | +8.3 % |
| Briefcase 3 | 2081 | 2185 (+5.0 %) | 2173 | +4.4 % |
| Io 4 | 2387 | 2452 (+2.7 %) | 1673 | -29.9 % |
| Vernon 100 | 1343 | 1386 (+3.2 %) | 1392 | +3.6 % |
| 8 Lire | 1373 | 1462 (+6.5 %) | 1454 | +5.9 % |
| Elvira 2 | 1287 | 1332 (+3.5 %) | 1339 | +4.0 % |
| Scrounge | 1992 | 2056 (+3.2 %) | 2055 | +3.2 % |
| Meridian 8 | 1787 | 1877 (+5.0 %) | 1864 | +4.3 % |
| Perun 4 | 1847 | 1907 (+3.2 %) | 1890 | +2.3 % |
| 808 Kit | 2271 | 2316 (+2.0 %) | 2321 | +2.2 % |
| 909 Kit | 1474 | 1523 (+3.3 %) | 1515 | +2.8 % |
| <7PH | 1925 | 2012 (+4.5 %) | 2023 | +5.1 % |
| Spokes 6 | 2061 | 2179 (+5.7 %) | 2156 | +4.6 % |
| Cassia 1 | 2114 | 2115 (+0.0 %) | 1336 | -36.8 % |
| Basic Poly | 1142 | 1152 (+0.9 %) | 768 | -32.7 % |
| Drift Poly | 1629 | 1645 (+1.0 %) | 1044 | -35.9 % |
| Mono Lead | 621 | 679 (+9.3 %) | 682 | +9.8 % |
| Supersaw Stack | 1664 | 1667 (+0.2 %) | 1035 | -37.8 % |
| Verona Drum 1 | 2289 | 2341 (+2.3 %) | 2336 | +2.1 % |

Means over the factory patches, split against one core: rest +5.9 %, 1 key +3.2 %, 4 keys −6.6 %, 8 keys −7.0 %. The poly patches gain 22–38 % with 4 or 8 keys. Patches with no poly group of two or more parts pay only the idle cost (+2 to +16 %, the most on the lightest).

The 10-minute soak on Io 4 with the split passed. It ran 6,009 self-tests with none failed, and core 1 rendered about 420,000 jobs. Core 1's stack held at most 1,800 of its 3,584 bytes. Core 0's main stack held at most 4,976 bytes and its interrupt stack 2,624.
