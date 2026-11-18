# The filters in float on the rig, 2026-11-17

Issue #979, step 4, for release 1.20; pull request #1074. The Multimode filter, the Ladder (both modes) and the Formant filter hold their states and compute in single-precision float on the FM-1 ([D-1112](../ledger/engine.md#D-1112)). This record gives the second-core check of [D-1114](../ledger/engine.md#D-1114), the build's memory and the rig's CPU before and after, against the estimate of [the step-2 record](2026-11-17-fpu-interrupts-and-gains.md).

## The builds

- Before: the Resonator in float, the filters in fixed point (main at `bdeee487`, the same engine as CI run 44227662455 of `fpu-resonator`).
- After: CI run 44243998179 of `fpu-filters`, installed on the test rig through the rig installer after the emulator boot check ([D-123](../ledger/releases.md#D-123)); the second-core check again on CI run 44248468331 (the same filters, the probe's hash fixed), installed the same way. Both passed the rig's dual-core scenarios, 22 of 22.

## Memory (CI build logs, main's run 44241663949 against 44243998179)

| | before | after |
|---|---|---|
| image | 549,672 B | 540,136 B (−9,536) |
| RAM `.data` + `.bss` | 20,100 B | 20,164 B (+64: the check's hashes) |
| pool | 409,592 of 417,792 B | 409,592 B (headroom 8,200 B, unchanged) |
| `.lowram` | 48 B free | 48 B free (unchanged) |
| `.ram_text` / `.c1_text` | 1,187 / 57 instructions | unchanged, no calls |

The listing (`matryoshka.dis`) calls no software float helper and no libm function.

## The second-core check

`tools/m1_link.py --rig fpucheck` (DIAG page 140, `main.c` `fpu_check`) on CI run 44243998179, with Hera 6 loaded, at rest and with 8 keys held ([raw: 0 keys](fpucheck-2026-11-18-rig-fpu-filters-0keys.json), [8 keys](fpucheck-2026-11-18-rig-fpu-filters-8keys.json)):

- Core 1 ran the probe (job taken, back in time, its stack at most 2,148 B of 3,584) and its hashes equal core 0's in all six cases: the filter with self-oscillation, drive, cv and morph; the filter's lp12 alone; the Ladder with stsat and an audio-rate fm; the diode mode; the Formant filter; the Resonator.
- Core 0's 32 runs from the main loop gave the same hashes every time, at rest and with Hera 6's 8 voices playing. The audio interrupt, which runs the float filters itself, interrupted those runs (one run 3,104 µs at rest, 3,467 µs with 8 keys: longer than a half buffer), so float code interrupted by float code kept its result bits.
- The host's hashes differed in every case on that build: the probe hashed the whole `inst_t` union, which holds pointers, so its size differs between the 32-bit FM-1 and a 64-bit host. Commit `087888ff` hashes the module's own state only. On its build (CI run 44248468331), at rest and with 8 keys held, core 0, core 1 and the host (`firmware/test/fpu_probe.c`, Apple clang and GCC 14) gave the same hashes in all six cases, and core 0's 32 runs did not differ ([raw: 0 keys](fpucheck-2026-11-18-rig-fpu-filters-fixed-0keys.json), [8 keys](fpucheck-2026-11-18-rig-fpu-filters-fixed-8keys.json)): `11c96a92 51ca2f53 5dd8d5cf 3faa9188 f31baa1c 949362e1`. The second core's FPU computes these kernels bit for bit as core 0's and as IEEE single precision on the host.

The table below is the first build's (whole-union hashes).

| case | core 0 | core 1 |
|---|---|---|
| filter osc drive | 22ee34d2 | 22ee34d2 |
| filter lp12 | e37c5153 | e37c5153 |
| ladder stsat fm | 063829ef | 063829ef |
| ladder diode | 814564a8 | 814564a8 |
| formant | 1cea9b9c | 1cea9b9c |
| resonator | a0d2ae61 | a0d2ae61 |

## CPU on the rig

`tools/rig_cpu_survey.py`, transport stopped, 2 s a phase, at rest and with 1, 4 and 8 keys held; before on CI run 44227662455 (the float Resonator, run by FloatFx just before), after on CI run 44243998179. Raw: [before](cpu-survey-2026-11-17-rig-fpu-filters-before.json), [after](cpu-survey-2026-11-17-rig-fpu-filters-after.json); the owner's Hera 6 with Delay and Reverb (#1073): [before](cpu-survey-2026-11-17-rig-fpu-filters-before-owner.json) on main's CI run 44241663949, [after](cpu-survey-2026-11-17-rig-fpu-filters-after-owner.json). Steady = the overload guard's mean audio-interrupt time over a phase's samples after the first, of 2,902 µs. No phase shed a part or overloaded; the owner's patch had one late half at 8 keys before and none after.

### Against the estimate

The estimate is the step-2 record's central saving of the filter, the Ladder and the Vowel (µs a half, 8 keys held); the rig figure is the fall of the steady mean.

| patch | rig saved, mean over 0/1/4/8 keys | at 8 keys | estimate | rig / estimate at 8 keys |
|---|---|---|---|---|
| Monolith D | 63 | 64 | 43 | 1.48 |
| Oracle V | 104 | 128 | 171 | 0.75 |
| Silver Box | 79 | 84 | 60 | 1.41 |
| Hera 6 | 88 | 127 | 192 | 0.66 |
| Sallen 20 | 89 | 86 | 36 | 2.40 |
| Expander S | 68 | 98 | 71 | 1.38 |
| Canvas | 83 | 77 | 85 | 0.91 |
| Wanderer | 84 | 86 | 61 | 1.42 |
| Briefcase 3 | 126 | 134 | 131 | 1.02 |
| Io 4 | 79 | 126 | 189 | 0.67 |
| Vernon 100 | 67 | 75 | 18 | 4.15 |
| Elvira 2 | 74 | 79 | 61 | 1.29 |
| Scrounge | 54 | 62 | 61 | 1.02 |
| Meridian 8 | 122 | 121 | 128 | 0.95 |
| 808 Kit | 112 | 114 | 142 | 0.80 |
| 909 Kit | 63 | 61 | 142 | 0.43 |
| Verona Drum 1 | 54 | 50 | 89 | 0.56 |
| Shush 101 | 49 | 50 | 43 | 1.16 |

Over the 18 patches the rig saved 1,622 µs at 8 keys against 1,733 estimated (0.94). The estimate is high for the poly instruments (Hera 6 0.66, Io 4 0.67, Oracle V 0.75) and the drum kits (909 Kit 0.43, Verona Drum 1 0.56): it charged every copy's full per-sample saving, while idle parts are skipped and the survey's held notes do not wake every drum. It is low for the mono and small patches (Vernon 100, Sallen 20, Monolith D, Silver Box, Wanderer: 1.4 to 4.2): it left out the coefficient work once a block or every 4th sample, which float also made cheaper, and the drive and self-oscillation paths (Sallen 20 runs both filters with osc). Part of each difference is the image's new layout (9.5 KB smaller), which moves every function's place in the cache.

### The owner's poly patch (#1073)

| patch | keys | peak µs before → after | steady mean µs before → after | estimate saved µs |
|---|---|---|---|---|
| Hera 6 gauze 2 | 0 | 2922 → 2742 | 1525 → 1468 (-58) |  |
| Hera 6 gauze 2 | 1 | 2843 → 2711 | 1922 → 1833 (-88) |  |
| Hera 6 gauze 2 | 4 | 2853 → 2733 | 2565 → 2446 (-118) |  |
| Hera 6 gauze 2 | 8 | 2913 → 2768 | 2571 → 2460 (-111) late1/0 |  |

### Peaks

| patch | peak µs before → after, worst phase |
|---|---|
| Monolith D | 1295 → 1221 (44.6 → 42.1 %) |
| Oracle V | 2381 → 2252 (82.0 → 77.6 %) |
| Silver Box | 1140 → 1085 (39.3 → 37.4 %) |
| Hera 6 | 2365 → 2193 (81.5 → 75.6 %) |
| Sallen 20 | 1737 → 1607 (59.9 → 55.4 %) |
| Expander S | 1946 → 1854 (67.1 → 63.9 %) |
| Canvas | 2008 → 1919 (69.2 → 66.1 %) |
| Wanderer | 1658 → 1566 (57.1 → 54.0 %) |
| Briefcase 3 | 2138 → 2046 (73.7 → 70.5 %) |
| Io 4 | 2090 → 2002 (72.0 → 69.0 %) |
| Vernon 100 | 1497 → 1446 (51.6 → 49.8 %) |
| Elvira 2 | 1132 → 1084 (39.0 → 37.4 %) |
| Scrounge | 2876 → 2750 (99.1 → 94.8 %) |
| Meridian 8 | 1989 → 1897 (68.5 → 65.4 %) |
| 808 Kit | 2218 → 2137 (76.4 → 73.6 %) |
| 909 Kit | 2366 → 2311 (81.5 → 79.6 %) |
| Verona Drum 1 | 2040 → 2016 (70.3 → 69.5 %) |
| Shush 101 | 1373 → 1387 (47.3 → 47.8 %) |

### Every phase

| patch | keys | peak µs before → after | steady mean µs before → after | estimate saved µs |
|---|---|---|---|---|
| Monolith D | 0 | 1237 → 1140 | 1069 → 1001 (-68) |  |
| Monolith D | 1 | 1243 → 1147 | 1083 → 1018 (-66) |  |
| Monolith D | 4 | 1243 → 1189 | 1075 → 1020 (-56) |  |
| Monolith D | 8 | 1295 → 1221 | 1082 → 1018 (-64) | 43 |
| Oracle V | 0 | 2370 → 2230 | 893 → 786 (-107) |  |
| Oracle V | 1 | 2344 → 2250 | 1492 → 1441 (-51) |  |
| Oracle V | 4 | 2367 → 2244 | 2056 → 1927 (-129) |  |
| Oracle V | 8 | 2381 → 2252 | 2068 → 1940 (-128) | 171 |
| Silver Box | 0 | 1064 → 984 | 884 → 803 (-80) |  |
| Silver Box | 1 | 1040 → 964 | 909 → 839 (-71) |  |
| Silver Box | 4 | 1103 → 1053 | 917 → 836 (-81) |  |
| Silver Box | 8 | 1140 → 1085 | 927 → 843 (-84) | 60 |
| Hera 6 | 0 | 2272 → 2159 | 1023 → 1003 (-20) |  |
| Hera 6 | 1 | 2285 → 2193 | 1618 → 1543 (-76) |  |
| Hera 6 | 4 | 2252 → 2146 | 2015 → 1884 (-131) |  |
| Hera 6 | 8 | 2365 → 2190 | 2021 → 1894 (-127) | 192 |
| Sallen 20 | 0 | 1632 → 1540 | 1451 → 1368 (-83) |  |
| Sallen 20 | 1 | 1603 → 1554 | 1472 → 1376 (-96) |  |
| Sallen 20 | 4 | 1680 → 1597 | 1481 → 1391 (-90) |  |
| Sallen 20 | 8 | 1737 → 1607 | 1483 → 1397 (-86) | 36 |
| Expander S | 0 | 1942 → 1848 | 633 → 595 (-38) |  |
| Expander S | 1 | 1944 → 1835 | 1269 → 1227 (-42) |  |
| Expander S | 4 | 1903 → 1848 | 1669 → 1574 (-95) |  |
| Expander S | 8 | 1946 → 1854 | 1677 → 1579 (-98) | 71 |
| Canvas | 0 | 1947 → 1892 | 1729 → 1651 (-77) |  |
| Canvas | 1 | 1954 → 1878 | 1756 → 1671 (-86) |  |
| Canvas | 4 | 1943 → 1895 | 1776 → 1684 (-91) |  |
| Canvas | 8 | 2008 → 1919 | 1787 → 1710 (-77) | 85 |
| Wanderer | 0 | 1543 → 1458 | 1368 → 1276 (-92) |  |
| Wanderer | 1 | 1553 → 1475 | 1362 → 1290 (-72) |  |
| Wanderer | 4 | 1553 → 1476 | 1377 → 1292 (-85) |  |
| Wanderer | 8 | 1658 → 1566 | 1390 → 1303 (-86) | 61 |
| Briefcase 3 | 0 | 2114 → 1986 | 1937 → 1816 (-121) |  |
| Briefcase 3 | 1 | 2127 → 2000 | 1911 → 1788 (-123) |  |
| Briefcase 3 | 4 | 2106 → 2032 | 1912 → 1785 (-127) |  |
| Briefcase 3 | 8 | 2138 → 2046 | 1914 → 1780 (-134) | 131 |
| Io 4 | 0 | 2028 → 1884 | 1001 → 1019 (+19) |  |
| Io 4 | 1 | 2073 → 1957 | 1445 → 1365 (-81) |  |
| Io 4 | 4 | 2077 → 2002 | 1795 → 1668 (-128) |  |
| Io 4 | 8 | 2090 → 1970 | 1798 → 1672 (-126) | 189 |
| Vernon 100 | 0 | 1492 → 1398 | 1262 → 1199 (-62) |  |
| Vernon 100 | 1 | 1423 → 1403 | 1283 → 1213 (-70) |  |
| Vernon 100 | 4 | 1476 → 1416 | 1278 → 1216 (-62) |  |
| Vernon 100 | 8 | 1497 → 1446 | 1289 → 1214 (-75) | 18 |
| Elvira 2 | 0 | 1033 → 1021 | 857 → 798 (-59) |  |
| Elvira 2 | 1 | 1005 → 922 | 896 → 815 (-81) |  |
| Elvira 2 | 4 | 1069 → 989 | 898 → 818 (-79) |  |
| Elvira 2 | 8 | 1132 → 1084 | 895 → 817 (-79) | 61 |
| Scrounge | 0 | 2206 → 2238 | 2048 → 2023 (-25) |  |
| Scrounge | 1 | 2269 → 2259 | 2122 → 2059 (-63) |  |
| Scrounge | 4 | 2671 → 2586 | 2123 → 2057 (-66) |  |
| Scrounge | 8 | 2876 → 2750 | 2118 → 2055 (-62) | 61 |
| Meridian 8 | 0 | 1934 → 1778 | 1719 → 1592 (-126) |  |
| Meridian 8 | 1 | 1889 → 1810 | 1741 → 1620 (-121) |  |
| Meridian 8 | 4 | 1926 → 1768 | 1743 → 1625 (-118) |  |
| Meridian 8 | 8 | 1989 → 1897 | 1743 → 1622 (-121) | 128 |
| 808 Kit | 0 | 2142 → 2027 | 1894 → 1788 (-106) |  |
| 808 Kit | 1 | 2096 → 1975 | 1926 → 1809 (-117) |  |
| 808 Kit | 4 | 2143 → 2043 | 1929 → 1819 (-110) |  |
| 808 Kit | 8 | 2218 → 2137 | 1931 → 1817 (-114) | 142 |
| 909 Kit | 0 | 2347 → 2311 | 2033 → 1981 (-52) |  |
| 909 Kit | 1 | 2366 → 2192 | 2065 → 1998 (-67) |  |
| 909 Kit | 4 | 2346 → 2305 | 2088 → 2018 (-70) |  |
| 909 Kit | 8 | 2366 → 2278 | 2085 → 2024 (-61) | 142 |
| Verona Drum 1 | 0 | 1982 → 1932 | 1759 → 1704 (-54) |  |
| Verona Drum 1 | 1 | 1977 → 1937 | 1788 → 1733 (-55) |  |
| Verona Drum 1 | 4 | 2003 → 1967 | 1785 → 1727 (-58) |  |
| Verona Drum 1 | 8 | 2040 → 2016 | 1782 → 1732 (-50) | 89 |
| Shush 101 | 0 | 1360 → 1269 | 1164 → 1105 (-58) |  |
| Shush 101 | 1 | 1350 → 1286 | 1170 → 1124 (-46) |  |
| Shush 101 | 4 | 1336 → 1328 | 1184 → 1143 (-41) |  |
| Shush 101 | 8 | 1373 → 1387 | 1196 → 1146 (-50) | 43 |

