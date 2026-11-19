# The audio block's fixed cost, 2026-11-18

Issue #803 asks what the fixed cost of every audio block is made of and to cut what can go. In 1.20 the audio interrupt spent 138 to 167 µs of each 2,902 µs half outside the voices: TIMER5 (the LED and key scan) nested in it about 85 µs, the engine's work before the voices about 46 µs, the Output modules' sum about 29 µs and the MASTER mix about 21 µs ([the 1.20 record](2026-11-18-headroom-120.md)). This record measures pull request #1105 on the test rig and in the emulator.

## What the time is

The emulator's timing model (`M1EMU_TIMING`, `M1EMU_PROF`, [docs/EMULATOR.md](../EMULATOR.md#the-timing-model)) splits the cost by 64-byte line of code. Over the poly benchmark (`web/scripts/poly-bench.ts`) on main (CI run 44416627447), `eng_render`, the function that holds the engine's work around the voices, costs 43,500 to 47,200 device cycles a half, and 41 to 48 instruction-cache refills of 720 cycles each make about three quarters of that. The code runs from the flash, and the voices fill the 32 KB instruction cache with their own code every block, so the block's own work is fetched again every block. The work itself is small: a few hundred instructions before the voices and three passes over the block after them (zeroing it, adding each Output module, clamping).

## What changed

All in `firmware/src/engine.c` `render_voice`; the output is bit-identical (`tools/engine_exact.sh origin/main`: all 547 kits, the transition checks and the 21 factory patches, also with the buffers poisoned).

- **Before the voices**, each path a block seldom takes (play once, no patch, the count-ins, MIDI clock in, a transport edge, ramps, morph, Steps keys, keys into tracks, arpeggiators) is marked `ENG_RARELY`, so the compiler lays it out at the end of the function and the work every block does sits on fewer lines. The two loops over the parts (pitch flaws, idle checks) are one loop.
- **After the voices**, `out_block` writes the block from the first Output module, adds the others and clamps in the last one's pass: one pass for one Output, instead of zeroing, adding and clamping in three. The clamp is a minimum then a maximum. The seldom paths there (play once's end, the count-in's click) are functions of their own.
- **What did not work.** A first build (CI run 44433597875) made the seldom paths before the voices functions of their own. The compiler placed them in the flash before `render_item`, which moved `render_item` and six functions after it by 4.7 KB. On the rig the engine's work before the voices fell from about 40 to 18 µs and the Output sum from about 32 to 17 µs, but the voices took 15 to 29 µs longer on both cores, so the interrupt did not get shorter (−13 to +8 µs). The final build keeps every function before `eng_render` at its address (checked against main's ELF: 459 of 459 unmoved; the 222 after it move 40 bytes). That build also had a loudness check in the MASTER mix without branches. Its mix span looked slower on the rig (9.7 → 16.9 µs), but the comparison was not fair: the scenarios that install a build turn on the test meter (`tp_on`, [D-124](../ledger/releases.md#D-124)), which adds about 7 µs to that span until the next restart. The loudness check is unchanged in this pull request.

## TIMER5 inside the audio interrupt

TIMER5 runs the LED and key scan every 100 µs and the USB and MIDI polls every 500 µs. Its time inside the audio interrupt is its own work at that rate, about 3.4 µs a tick (`tools/m1_link.py --rig t5`: 2.2 to 2.3 µs the scan, 1.7 µs a glow pulse's end in TIMER2, 0.73 pulses a tick), not a cost of nesting. Keeping it out of the audio interrupt (a higher priority for the audio interrupt, or TIMER5 masked during the render) would hold the scan back for most of every half: the LEDs' on-time, their levels and the keys' timing would change, which [D-934](../ledger/device-ui.md#D-934) rules out. This pull request leaves the scan, TIMER5, TIMER2 and every interrupt priority as they are. The one lever left is the two-core plan: when core 0 ends last, TIMER5's ticks during the voices delay the block, and a plan that counted them would give core 0 less work. That plan belongs to issue #1072's work on `sch_*`.

## On the rig

The 1.20.0 release (CI run 44324522229) against this pull request's code (CI run 44437737545), in one session, both installed through `npm run device:scenarios -- --install`, so the test meter is on in both. The pull request's merged build (CI run 44443757526) has the same code at the same addresses (0 functions moved). Its boot check fails on main's factory image since #1099 (the boot check's expectations, not the firmware; being fixed on main); CI run 44437737545 passed the boot check with its own commit's image. Block times at 8 held keys, means over about 1,040 halves, µs:

| Patch | Audio interrupt | Fixed part | Before the voices | Output sum and clamp | The voices |
|---|---|---|---|---|---|
| Algo Four fx | 1871 → 1848 (−23) | 91.5 → 75.8 | 35.8 → 32.5 | 26.7 → 12.7 | 1780 → 1772 |
| Cassia 1 fx | 1921 → 1884 (−37) | 99.7 → 74.5 | 43.1 → 30.8 | 32.9 → 18.6 | 1821 → 1810 |
| Hera 6 fx4 | 1912 → 1869 (−43) | 111.8 → 87.0 | 42.7 → 33.4 | 34.0 → 19.6 | 1800 → 1782 |
| Hera 6 gauze 2 | 1825 → 1780 (−45) | 112.0 → 87.1 | 45.0 → 33.6 | 32.6 → 19.5 | 1713 → 1693 |
| Hera 6 gauze 2, running | 1840 → 1794 (−46) | 118.7 → 91.1 | 48.4 → 35.3 | 33.0 → 19.5 | 1721 → 1703 |
| Oracle V fx | 1931 → 1889 (−42) | 99.6 → 75.3 | 43.2 → 31.8 | 30.0 → 19.8 | 1831 → 1814 |
| Oracle V fx4 | 1962 → 1917 (−45) | 102.4 → 74.5 | 45.2 → 31.0 | 31.1 → 19.8 | 1859 → 1843 |
| Oracle V fx4, running | 1978 → 1930 (−48) | 103.7 → 76.2 | 47.5 → 31.6 | 30.2 → 20.5 | 1875 → 1854 |

- The fixed part (the interrupt less the voices, TIMER5 included) falls by 16 to 28 µs. The voices also take 7 to 20 µs less on both cores (core 1 busy 10 to 16 µs less); the likely reason, not confirmed, is that the block's own code now pushes less of theirs out of the shared instruction cache. Two runs of the same 1.20.0 build in this session differ by at most 6 µs in the interrupt and 2.5 µs in the fixed part.
- TIMER5 inside the interrupt and the MASTER mix are unchanged (55 to 75 µs and about 17.5 µs).
- The worst steady load, the poly benchmark with the transport stopped (`tools/rig_cpu_survey.py`, the lower median after the first sample, the largest over 0, 1, 4 and 8 keys), % of the half:

| Patch | 1.20.0 → this pull request | Change, points |
|---|---|---|
| Algo Four fx | 67.0 → 65.9 | −1.1 |
| Cassia 1 fx | 70.0 → 69.6 | −0.4 |
| Cassia 1 fx4 | 73.6 → 72.5 | −1.1 |
| Expander S fx | 58.5 → 57.1 | −1.5 |
| Hera 6 fx | 63.6 → 62.0 | −1.6 |
| Hera 6 fx4 | 68.6 → 66.6 | −1.9 |
| Hera 6 gauze 2 | 64.9 → 63.6 | −1.3 |
| Io 4 fx | 60.6 → 59.0 | −1.6 |
| Io 4 fx4 | 63.6 → 62.6 | −1.0 |
| Oracle V fx | 69.5 → 68.6 | −0.9 |
| Oracle V fx4 | 70.7 → 69.2 | −1.6 |

- `tools/m1_link.py --rig cores` before and after: 2 cores, no bar, no failed self-test, no refused job.

## In the emulator

Poly benchmark, emulator timing model, main (CI run 44416627447) → this pull request (CI run 44437737545). Peak steady load, % of the half, and the audio interrupt's mean at 8 keys:

| Patch | Peak % | Interrupt at 8 keys, µs |
|---|---|---|
| Algo Four fx | 70.6 → 68.4 | 1973 → 1949 |
| Cassia 1 fx | 71.2 → 68.5 | 1978 → 1913 |
| Cassia 1 fx4 | 74.4 → 72.5 | 2080 → 2018 |
| Expander S fx | 61.2 → 59.3 | 1700 → 1643 |
| Hera 6 fx | 67.1 → 65.0 | 1874 → 1818 |
| Hera 6 fx4 | 72.0 → 70.1 | 1994 → 1948 |
| Hera 6 gauze 2 | 67.8 → 66.2 | 1903 → 1852 |
| Io 4 fx | 63.0 → 61.4 | 1756 → 1702 |
| Io 4 fx4 | 66.7 → 65.0 | 1862 → 1811 |
| Oracle V fx | 73.0 → 71.3 | 2039 → 1967 |
| Oracle V fx4 | 74.1 → 71.8 | 2060 → 1990 |

`eng_render` and `out_block` together: Hera 6 gauze 2 47,247 → 31,676 cycles a half (48.3 → 30.9 refills), Oracle V fx4 46,456 → 30,279 (45.6 → 27.4), Cassia 1 fx 43,524 → 26,031 (41.1 → 21.1).

## Keys, LEDs and memory

- **Key to sound** (emulator, timing model, `m1emu run` with 14 presses of a note key at 613 ms spacing, the home page's patch): the first sample after each press is the same in both builds, and every sample from the first press on is identical. Only the sound before the first press differs (5.7 to 6.3 s after power-on): the boot runs at slightly different times when the interrupt is shorter.
- **Key to LED:** the scan, its timers and the interrupt priorities are unchanged. On the rig the scan's time a tick is 3.54 → 3.41 µs, the glow pulses 0.73 a tick at 8.01 → 8.00 µs (`t5`, 5 s each). The rig cannot see its LEDs.
- **Checks:** `npm run emu:smoke` on this build, 301 checks, 0 failed; `tools/panel_test.sh` passes; `npm run device:scenarios -- --install` on the rig, 55 of 58 passed, 3 skipped as on every rig run (the OUTPUT checks the rig's USB audio cannot hear).
- **Memory:** `.lowram`, `.data`, `.bss`, the pool, `.noinit` and the RAM code are the same size; `.text` is 32 bytes longer.

## Raw data

- [rig JSON](block-fixed-2026-11-18-rig.json): the block times, TIMER5's parts and the surveys of every rig build above.
