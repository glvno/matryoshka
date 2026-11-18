# Poly synths with FX: unrolled loops and hot code in RAM, 2026-11-18

Issue #1073 asks for room for polyphonic synths soaked in effects. Its acceptance list is the owner's Hera 6 "gauze 2" and the factory Oracle V fx, Oracle V fx4 and Hera 6 fx4: all four dropped voices on the 1.19 firmware. This record measures pull request #1078's two changes on the test rig and in the emulator. The unrolled loops change nothing on the rig. Hot code in RAM makes every patch of the set cheaper, and none of the four drops a voice any more.

## The set and the method

- **Benchmark** (`web/scripts/poly-bench.ts`): the owner's gauze 2, and each polyphonic factory synth at its voice count with every stage of its own master effects bus on (`fx`). A synth whose bus lacks some stages also gets all four (Drive, Chorus, Delay, Reverb): `fx4`.
- **Load** (`tools/rig_cpu_survey.py`): each patch at 0, 1, 4 and 8 held keys, 2 seconds each, with the transport stopped and running. The steady value is the lower median after the first sample. A cell is the largest steady value over the key counts and both transport states, as a share of the 2,902 µs half-block. "Voices shed" counts the overload guard's voice drops over all eight phases.
- **Block times** (`tools/m1_link.py --rig blocktime 3 --notes 8`): the audio interrupt's spans at 8 held keys, means over about 1,040 halves. "Fixed part" is the interrupt less the voices, nested timer interrupts included.
- **Cores:** `tools/m1_link.py --rig cores` before and after each run: 2 cores, no bar, no failed self-test and no refused job, every time.
- **Builds:** the 1.19 baseline is main `bdeee487`, firmware CI run 44241663949 (#1073, comment 6970387473). "Unrolled" is CI run 44249026297, commit `6145be57`, with RAM placement off. "RAM" is CI run 44252628580, commit `bd3308a0`: the same source with RAM placement on. Both pull request builds passed `npm run emu:boot` and `npm run emu:smoke` (301 checks, 0 failed) before the rig.
- **Raw data:** [poly-headroom-2026-11-18-rig.json](poly-headroom-2026-11-18-rig.json): both surveys and every block time for the three builds.

## On the rig

| Patch | Worst steady load % (main → unrolled → RAM) | Voices shed | Audio interrupt at 8 keys, µs | Core 0 busy / waiting, µs | Core 1 busy, µs | Fixed part, µs |
|---|---|---|---|---|---|---|
| Algo Four fx | 86.4 → 86.6 → 81.4 | 0 → 0 → 0 | 2404 → 2411 → 2228 | 1674 / 575 → 1712 / 539 → 1578 / 540 | 2172 → 2161 → 2048 | 155 → 159 → 109 |
| Cassia 1 fx | 88.2 → 86.5 → 80.4 | 0 → 0 → 0 | 2437 → 2420 → 2230 | 1858 / 440 → 1843 / 420 → 1746 / 378 | 2149 → 2101 → 1980 | 139 → 157 → 106 |
| Cassia 1 fx4 | 90.6 → 90.0 → 84.1 | 0 → 0 → 0 | 2516 → 2492 → 2321 | 1885 / 493 → 1865 / 473 → 1781 / 433 | 2299 → 2246 → 2139 | 138 → 154 → 107 |
| Expander S fx | 86.1 → 86.1 → 79.4 | 0 → 0 → 0 | 2417 → 2431 → 2226 | 1533 / 736 → 1539 / 733 → 1449 / 667 | 2187 → 2179 → 2043 | 149 → 160 → 110 |
| Hera 6 fx | 90.7 → 91.4 → 83.1 | 0 → 0 → 0 | 2534 → 2545 → 2309 | 1851 / 518 → 1851 / 519 → 1703 / 491 | 2284 → 2278 → 2114 | 165 → 175 → 116 |
| **Hera 6 fx4** | 90.7 → 91.2 → 88.3 | **4 → 4 → 0** | 2530 → 2539 → 2436 | 1653 / 712 → 1697 / 666 → 1878 / 439 | 2217 → 2205 → 2173 | 166 → 176 → 118 |
| **Hera 6 gauze 2** | 95.9 → 93.0 → 90.0 | **3 → 4 → 0** | 2578 → 2585 → 2345 | 1895 / 517 → 1889 / 520 → 1737 / 491 | 2328 → 2318 → 2150 | 165 → 176 → 117 |
| Io 4 fx | 86.2 → 86.7 → 78.9 | 0 → 0 → 0 | 2415 → 2420 → 2196 | 1703 / 545 → 1691 / 551 → 1617 / 461 | 2101 → 2091 → 1947 | 167 → 178 → 118 |
| Io 4 fx4 | 89.3 → 90.7 → 83.0 | 0 → 0 → 0 | 2495 → 2509 → 2301 | 1734 / 595 → 1729 / 603 → 1666 / 515 | 2248 → 2243 → 2109 | 166 → 178 → 120 |
| **Oracle V fx** | 97.7 → 97.3 → 87.6 | **4 → 4 → 0** | 2479 → 2474 → 2422 | 1585 / 748 → 1578 / 734 → 1807 / 509 | 2249 → 2217 → 2239 | 146 → 163 → 107 |
| **Oracle V fx4** | 88.9 → 89.9 → 88.8 | **4 → 4 → 0** | 2493 → 2484 → 2455 | 1605 / 742 → 1596 / 725 → 1837 / 508 | 2263 → 2227 → 2270 | 146 → 162 → 110 |

- **Unrolled loops:** the load moves by −2.9 to +1.4 points, within the noise of a single run. Core 1, the critical path, is 5 to 53 µs quicker, but the fixed part is 4 to 18 µs slower. Of that, the Output modules' sum and clamp is 6.6 µs slower on gauze 2 (31.3 → 37.9 µs). The emulator's timing model suggests why: the unrolled code is larger, and its instruction-cache refills rise from 538 to 628 a half across the set. No patch stops shedding.
- **RAM placement, against the unrolled build:** the load falls 1.1 to 9.6 points, and the interrupt at 8 keys is 29 to 240 µs shorter. The fixed part falls by 47 to 60 µs in every patch. Core 1 is 107 to 168 µs quicker in eight patches and 32 µs quicker in Hera 6 fx4. In Oracle V fx and fx4 core 1 is 22 and 43 µs slower, and core 0 is about 230 µs busier while it waits that much less; their interrupt is still 52 and 29 µs shorter. No patch of the set sheds a voice.
- **Margin left:** the worst steady loads are gauze 2 running (90.0 %), Oracle V fx4 (88.8 %) and Hera 6 fx4 (88.3 %).

## In the emulator

The timing model (`M1EMU_TIMING`, `tools/emu/timing.txt`) over the same set; "RAM what-if" is the unrolled build with `M1EMU_RAMSIM` naming the RAM build's 54 functions. Peak steady load %:

| Patch | main → unrolled → RAM what-if → RAM build |
|---|---|
| Algo Four fx | 90.0 → 87.2 → 81.1 → 82.6 |
| Cassia 1 fx | 87.6 → 87.7 → 79.6 → 79.8 |
| Cassia 1 fx4 | 89.5 → 91.7 → 84.1 → 83.8 |
| Expander S fx | 89.0 → 85.6 → 78.4 → 77.4 |
| Hera 6 fx | 89.5 → 88.8 → 81.2 → 81.5 |
| Hera 6 fx4 | 89.6 → 87.6 → 85.7 → 84.2 |
| Hera 6 gauze 2 | 90.5 → 88.8 → 81.9 → 81.0 |
| Io 4 fx | 87.7 → 86.7 → 78.2 → 76.5 |
| Io 4 fx4 | 91.1 → 90.5 → 82.6 → 80.0 |
| Oracle V fx | 91.0 → 87.2 → 85.5 → 85.9 |
| Oracle V fx4 | 90.6 → 88.4 → 87.0 → 86.5 |

The what-if predicted −1.4 to −8.5 points; the RAM build measures −1.3 to −10.4 in the emulator and −1.1 to −9.6 on the rig. Instruction-cache refills fall from 628 to 419 a half. The emulator's split of the work between the two cores is wrong, so the per-core figures above come from the rig only.

## The function list

`tools/build.py` `FAST_TEXT`: 54 whole functions, 12,476 bytes, in the NOINIT RAM after `.noinit` (404 bytes left). The pool and `.lowram` are unchanged. The list is the code with the most instruction-cache refills per byte in the emulator's profile of the unrolled build (`m1emu cpu` with `M1EMU_PROF`), greedy up to 12.8 KB. It leaves out the P33 helpers, which run before the boot copies the code, and the compiler's 64-bit helpers, which come from a library. The biggest refill sources (`process`, the engine's per-module dispatch at 48 KB, and `eng_render`) do not fit.

## Why RAM placement used to halt the emulator

Every build with RAM placement halted the emulator 129 ms into the boot, at pc `0x13b01`. The first audio interrupt called `fm1_alnk0_irq` in RAM, ran one instruction and jumped to address 0.

- `.noinit` ended 2 bytes short of a word. The `ALIGN(4)` at the start of `.fast_text` then padded the section's start, so `_ft_start` lay 2 bytes after the section's first byte. `_ft_load` is the section's load address, and `objcopy` writes the section from its first byte. So the boot copied every byte of the RAM code 2 bytes late.
- Each RAM function therefore began with its predecessor's last instruction, mostly a return: called from the main loop, the functions returned at once and the firmware ran on. In the interrupt, the return popped 0 into pc.
- The fix: `firmware/app.ld` aligns the section itself (`.fast_text : ALIGN(4)`), and `tools/build.py` refuses a copied section whose size differs from what the boot copies. The earlier suspects were not the cause: far calls and tail calls between the flash and NOINIT decode with their full reach (`tools/emu/src/isa_tests.rs` `far_branches_between_flash_and_noinit`), so the tail-call ban is gone, and the `.ram_text` checks are unaffected.
