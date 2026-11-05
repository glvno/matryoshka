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

## The shipped build against release-1.10 (2026-11-05, afternoon)

The figure that counts for users: release-1.10's head before #271 (CI run 42096997058, no second-core code: `cpu-survey-2026-11-05-rig-release-1.10-head.json`) against the merged dual-core build (CI run 42093061899): with core 1 held by its fallback (`-rig-merged-one-core.json`; the rig was barred at the time), with the split off and core 1 idle (`-rig-merged-split-off.json`), and with the split (`-rig-merged-split.json`). Steady µs a half with 8 keys held:

| patch | release-1.10 (one core) | dual-core build, core 1 held | split off, core 1 idle | split |
|---|---|---|---|---|
| Oracle V | 1915 | 1916 (+0.1 %) | 1916 (+0.1 %) | 1345 (-29.8 %) |
| Init | 548 | 567 (+3.5 %) | 575 (+4.9 %) | 572 (+4.4 %) |
| Simple FM | 582 | 608 (+4.5 %) | 609 (+4.6 %) | 612 (+5.2 %) |
| Plucked String | 1206 | 1162 (-3.6 %) | 1160 (-3.8 %) | 781 (-35.2 %) |
| Monolith D | 1111 | 1106 (-0.5 %) | 1119 (+0.7 %) | 1114 (+0.3 %) |
| Silver Box | 794 | 830 (+4.5 %) | 844 (+6.3 %) | 834 (+5.0 %) |
| Hera 6 | 2085 | 2070 (-0.7 %) | 2073 (-0.6 %) | 1379 (-33.9 %) |
| Sallen 20 | 1551 | 1551 (+0.0 %) | 1551 (+0.0 %) | 1560 (+0.6 %) |
| Expander S | 1763 | 1801 (+2.2 %) | 1776 (+0.7 %) | 1119 (-36.5 %) |
| Algo Four | 1722 | 1786 (+3.7 %) | 1797 (+4.4 %) | 1313 (-23.8 %) |
| Canvas | 2177 | 2209 (+1.5 %) | 2202 (+1.1 %) | 2224 (+2.2 %) |
| Wanderer | 1068 | 1073 (+0.5 %) | 1088 (+1.9 %) | 1082 (+1.3 %) |
| Briefcase 3 | 2159 | 2152 (-0.3 %) | 2148 (-0.5 %) | 2171 (+0.6 %) |
| Io 4 | 2392 | 2435 (+1.8 %) | 2452 (+2.5 %) | 1678 (-29.8 %) |
| Vernon 100 | 1371 | 1392 (+1.5 %) | 1403 (+2.3 %) | 1403 (+2.3 %) |
| 8 Lire | 1432 | 1453 (+1.5 %) | 1478 (+3.2 %) | 1458 (+1.8 %) |
| Elvira 2 | 1308 | 1317 (+0.7 %) | 1333 (+1.9 %) | 1322 (+1.1 %) |
| Scrounge | 2050 | 2061 (+0.5 %) | 2036 (-0.7 %) | 2019 (-1.5 %) |
| Meridian 8 | 1867 | 1892 (+1.3 %) | 1870 (+0.2 %) | 1882 (+0.8 %) |
| Perun 4 | 1902 | 1912 (+0.5 %) | 1903 (+0.1 %) | 1901 (-0.1 %) |
| 808 Kit | 2294 | 2357 (+2.7 %) | 2332 (+1.7 %) | 2331 (+1.6 %) |
| 909 Kit | 1511 | 1515 (+0.3 %) | 1517 (+0.4 %) | 1501 (-0.7 %) |
| <7PH | 1969 | 2021 (+2.6 %) | 2015 (+2.3 %) | 2014 (+2.3 %) |
| Spokes 6 | 2070 | 2160 (+4.3 %) | 2122 (+2.5 %) | 2150 (+3.9 %) |
| Cassia 1 | 2139 | 2110 (-1.4 %) | 2110 (-1.4 %) | 1342 (-37.3 %) |
| Basic Poly | 1169 | 1151 (-1.5 %) | 1166 (-0.3 %) | 779 (-33.4 %) |
| Drift Poly | 1672 | 1661 (-0.7 %) | 1648 (-1.4 %) | 1048 (-37.3 %) |
| Mono Lead | 679 | 689 (+1.5 %) | 688 (+1.3 %) | 691 (+1.8 %) |
| Supersaw Stack | 1669 | 1671 (+0.1 %) | 1668 (-0.1 %) | 1049 (-37.1 %) |
| Verona Drum 1 | 2326 | 2323 (-0.1 %) | 2307 (-0.8 %) | 2354 (+1.2 %) |

Split against release-1.10, all factory patches: mean −10.0 % with 8 keys. The poly patches run 24 to 37 % faster. The others run −1.5 to +5.2 % (Simple FM +5.2 %, Silver Box +5.0 %, Init +4.4 %): a median of 24 µs a half. The earlier tables on this page used a baseline taken with core 1 held right after the fallback test, which read 3 to 15 % lower on the light patches than either release-1.10 or the dual-core build with core 1 held. Their idle-cost figures (up to +16 %) overstate what shipping costs. The CPU model (`web/scripts/cpu-costs.ts CORES`) is fitted to this table.

The 10-minute soak on Io 4 passed on this build: 5,999 self-tests, none failed, about 440,000 render jobs on core 1. Core 1's stack held at most 1,800 bytes.
