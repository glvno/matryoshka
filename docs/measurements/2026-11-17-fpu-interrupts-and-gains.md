# The FPU in interrupts, and what float kernels would gain, 2026-11-17

Issue #979, steps 1 and 2, for release 1.20. Step 1 builds every firmware for the AC791N's single-precision FPU (floating-point unit); this record answers whether code that uses the FPU may be interrupted by code that also uses it, and estimates, on the timing emulator, what the float kernels of [D-1112](../ledger/engine.md#D-1112) would save on each factory instrument. The FPU's costs come from [the rig benchmark of 2026-11-16](2026-11-16-fpu.md).

## The build is for the FPU and changed no byte

- `tools/build.py` compiles every build with `-mcpu=r3 -mfprev1 -ffp-contract=off` and links the toolchain's `pi32v2/lib/r3/` libraries. The `FM1_FPU` switch is gone.
- The app is byte for byte the same: sha256 `ba4d600a27203535558595c2c6ae5e41095816873f41610150bdf7164d5daf7e` for main at `69275f46` (firmware CI run 44216520520, artifact `matryoshka-firmware`) and for this branch (CI run 44217969175). The `M1_EMU_MIDI=1` twins are equal too (`b68999ab…`). The firmware has no float code, so the flags change nothing yet.
- JieLi's objdump prints each FPU instruction as `<unknown instruction>` and reads its second half as an instruction of its own. In the benchmark build that misreading swallowed the instruction after 4 of the 724 FPU instructions and float compares. `tools/build.py` now finds them by their encodings (fm1-emu's `crates/fm1-isa/src/fpu.rs`), disassembles a copy of the ELF with each one replaced by nops, and puts them back as lines of their own. Its checks of `.ram_text`, `.c1_text` and the calls into the chip's ROM read every instruction. An instruction that neither objdump nor the FPU's table knows fails the build. `tools/build_disasm_test.py` feeds the check a part of the benchmark build's real listing, and a call that objdump's misreading hides. The benchmark build (`M1_BENCH=1`, CI run 44217969175, job `fpu-measure`) passes the checks with its 708 FPU instructions and 16 float compares.

## Interrupts and the FPU

The question: does the audio interrupt (`fm1_alnk0_irq`), the second core (`.c1_text`, `hal/fm1_cpu1.h`) or any other interrupt save and restore the FPU's registers and status? If float may run both in an interrupt and in the code it interrupts, what must be saved, and is float at control rate in the main loop ([D-1111](../ledger/engine.md#D-1111)) safe today?

### What the FPU keeps

- **No registers of its own.** Its instructions read and write the ordinary registers `r0` to `r15` (fm1-emu's `fpu.rs` and `docs/isa-notes.md`: `3f e5` / `3f f5` with register fields only). A float travels in `r0` to `r3` with or without the FPU ([the 2026-11-16 record](2026-11-16-fpu.md), "Float calling convention").
- **No flags.** The float compares are compare-and-branch instructions on two registers (`iff (rA op rB) goto` and `iff (rA op rB) {`); they set no condition flag.
- **No status or control register known.** JieLi's clang (toolchain `jieli-linux-toolchains-20260730.1`) lists the pi32v2's registers as `r0` to `r15`, their pairs and parts, `sr4`, `sr7` to `sr9`, `cc`, `pc`, `rete`, `retx`, `reti`, `rets`, `icfg`, `icfgn`, `icfgs`, `cnum`, `psr`, `ssp`, `sspn`, `usp` and `uspn`: nothing for the FPU. Its `r3` libraries hold no `fegetround`, `fesetround` or other floating-point environment function, the toolchain has no `fenv.h`, and the `fpgetround` that `ieeefp.h` declares is defined nowhere. So the rounding is fixed: results round to nearest, as IEEE single precision does on the rig, and `ftoi` / `ftou` truncate by their encoding. No flush-to-zero mode is known, and none is needed: subnormal operands cost nothing extra.
- **libm keeps no state.** The `r3` libm's `sinf`, `cosf`, `expf`, `log2f` and `exp2f` need only libm itself (newlib's IEEE wrappers, no `errno`), so an interrupt may call one while the code it interrupted is inside another.

### What the interrupts save

- `hal/fm1_isr.S`: every interrupt enters through `FM1_ISR` or `FM1_ISR_FRAME`, which push `psr`, `rets`, `reti` and `r0` to `r3`, call the C body, and pop them. The C body saves any of `r4` to `r15` it uses, as every C function does. So every register the FPU can write is saved: no FPU state is left to save.
- The interrupts: the audio interrupt `isr_alnk0` (priority 3) runs `eng_render`, the whole engine, so every float kernel of [D-1112](../ledger/engine.md#D-1112) will run in it. `TIMER5` (the key scan and the USB poll) and `TIMER2` (priority 4 both) nest inside it. The main loop, where control-rate float of [D-1111](../ledger/engine.md#D-1111) runs, is interrupted by all three.
- The fatal vectors (`hal/fm1_vec.S`) save every register.
- The second core runs the jobs the audio interrupt hands it with its interrupts off (`hal/fm1_cpu1.S`: `cli`, `icfg = 0`, its interrupt bank cleared), so nothing interrupts its float code. It has its own registers.

### The answer

- Nothing more needs saving. Float may run in the audio interrupt, in the timer interrupts and in the main loop at the same time. The cost is 0 extra cycles: a float kernel in an interrupt only uses registers that the entry or the compiler saves already (a body that needs more registers pushes them, as any C code does).
- Float at control rate in the main loop ([D-1111](../ledger/engine.md#D-1111)) is safe today.
- A proposed rule records this: [D-1114](../ledger/engine.md#D-1114) (decider: michael glaviano).

### Not checked on the device yet

- **Float interrupted on the rig.** The benchmark ran its float kernels with the interrupts off, and the firmware has no other float code, so no float code has been interrupted on the device. The evidence above is the toolchain's and the emulator's. Before the first float kernel (step 3) is merged, its rig survey should check its result bits with the interrupts on.
- **Float on the second core.** The benchmark ran on core 0. That core 1 has its own FPU is likely (each core has its own registers, and JieLi's SDK runs FPU code on both cores), not measured. The first change that runs float on core 1 checks its result bits there ([D-1114](../ledger/engine.md#D-1114)).
- **Division by zero, overflow and NaN.** None of the benchmark's kernels produced them, so whether they trap on this FPU is not known. The emulator returns IEEE infinity and NaN. Until a rig check, a float kernel does not divide by a value that can be zero.

## Step 2: the gains, estimated on the timing emulator

### The FPU in the timing model

`tools/emu/timing.txt` charges the FPU's measured costs: an add, subtract or multiply 1.6 device cycles (`fpu`), a divide 3.0 (`fpu_div`, also charged to the multiply-accumulate instructions, which our compiler does not emit), a conversion between int and float 2.3 (`fpu_cvt`). Subnormal operands cost the same. Before, the model charged an FPU instruction as an ordinary instruction (1 cycle). The fitted numbers (`miss`, `dual`) came from builds with no FPU instruction, so these costs do not change them.

The rig benchmark build (CI run 43928668815, `bench-fpu/matryoshka-emu.bin`) run in `m1emu serve` under the model and read like `tools/m1_link.py fpubench` (`fpubench-2026-11-17-emu-timing.json`), in device cycles a sample less the block loop (the emulator's 240 MHz cycles times 1.5):

| kernel | rig fixed point | rig float | emulator fixed point | emulator float |
|---|---|---|---|---|
| six resonator modes as `m_modal` runs them | 431.1 | 196.3 | 464.0 | 234.1 |
| six two-pole resonators | 286.9 | 106.7 | 268.7 | 132.5 |
| two biquad sections (`dly_aa`) | 78.5 | 57.4 | 71.0 | 64.5 |
| one-pole | 12.1 | 8.1 | 9.1 | 6.8 |
| four chained 64-bit multiplies | 37.2 | | 23.2 | |

The emulator gets the Resonator's saving right (230 device cycles a sample against the rig's 235). It reads a 64-bit multiply cheaper than the rig does (the model charges a multiply 2 cycles; the rig's chained 64-bit multiply costs 9.3), so it sees less of what float saves in the two-pole sections: 7.6 cycles a 64-bit multiply replaced, against the rig's 10.0. It also spends at least one of its 240 MHz cycles (1.5 device cycles) on every instruction and carries the difference over, so short kernels read off in either direction: the float resonators about 20 % slow, the chain of float adds 35 % fast.

### The method: a model, not a prototype kernel

- **Now:** each factory patch, and each full-parity patch that `npm run parity-status` measures (#375), played on main's firmware in the emulator with the timing model: the rig survey's 8 notes held, each module's time a half buffer (`m1emu cpu --modtime` through `web/scripts/cpu-emu.ts`) and the mean audio interrupt. The raw times: `fpu-gains-2026-11-17-emu.json`.
- **With float:** each copy of a module (each voice of a poly card is a copy) saves, a sample, what its per-sample loop's 64-bit fixed-point multiplies cost beyond their float form:
  - the Resonator: 235 device cycles (the rig's six rotated modes, measured as `m_modal` runs them);
  - the filter (state variable): 5 multiplies with one stage, 11 when its LP24 or MIX output is cabled (two stages);
  - the Ladder: 12 multiplies, 17 in its diode mode;
  - the Vowel: 15 multiplies (three band passes);
  - each multiply 10 device cycles, from the rig's two-pole kernel (30 cycles for 3 multiplies; the rotated modes give 9.8). The low estimate takes the emulator's 7.6 and its 230 for the Resonator.
- A copy saves at most 90 % of its measured time. The interrupt's time then falls in proportion to the modules' times saved. The editor's estimate (the CPU model behind the parity bands) takes the same saving a copy, at most 90 % of each module's time in that model, and the band is worked out again.
- **Left out:** the drive and self-oscillation paths of the filter (they solve the stage again every sample, so they would gain more), the coefficient work once a block (float at control rate, [D-1111](../ledger/engine.md#D-1111)), and the delay, reverb, chorus, comb, string, phaser and low-pass gate kernels (step 3's later groups). Briefcase 3's and Canvas's reverb take about 500 µs a half each, the largest module left out.

### The table, ordered by expected gain

One core has 2,901 µs a half buffer. The emulator's CPU is its mean audio interrupt with 8 notes held, as a share of that; the gain in percentage points is the central estimate, the low one in brackets. The last columns are the full-parity patch's CPU in the editor's model, as `parity-status` adds it up, and its band.

| instrument | factory patch, emulator CPU % now → with float | gain, points | saved, µs a half | full-parity patch: model CPU % now → with float | band |
|---|---|---|---|---|---|
| #852 808 Kit | 77.4 → 66.9 | 10.5 (9.6) | Resonator 334, filter 142 | 808 Kit: 80.9 → 69.4 | full |
| #861 Meridian 8 | 65.1 → 60.2 | 4.9 (4.1) | Resonator 84, filter 75, Vowel 53 | Meridian 8: 66.7 → 61.2 | full |
| #860 Hera 6 | 71.6 → 67.1 | 4.5 (3.4) | filter 192 | Hera 6 at 4: 74.8 → 69.9 | unmeasured |
| #871 Io 4 | 63.2 → 58.7 | 4.5 (3.4) | Ladder 171, filter 18 | Io 4 at 4: 65.8 → 61.0 | full |
| #862 Oracle V | 72.8 → 68.7 | 4.0 (3.1) | Ladder 171 | Oracle V XL at 5: 209.4 → 199.5 | xl-only |
| #855 Briefcase 3 | 68.3 → 64.7 | 3.5 (2.7) | filter 71, Ladder 60 | Briefcase 3: 69.6 → 66.0 | xl-only |
| #853 909 Kit | 73.2 → 70.0 | 3.2 (2.5) | filter 142 | 909 Kit: 85.1 → 81.4 | full |
| #856 Canvas | 63.4 → 61.1 | 2.4 (1.8) | Ladder 85 | Canvas at 1: 65.4 → 63.0 | full |
| #874 Silver Box | 32.2 → 30.2 | 2.1 (1.6) | Ladder 60 | Silver Box at 1: 35.4 → 33.5 | full |
| #866 Verona Drum 1 | 65.9 → 63.9 | 2.0 (1.5) | filter 89 | Verona Drum 1: 79.5 → 77.3 | unmeasured |
| #858 Elvira 2 | 31.8 → 29.9 | 1.9 (1.5) | Ladder 43, filter 18 | Elvira 2 XL: 625.2 → 613.3 | xl-only |
| #864 Scrounge | 73.1 → 71.4 | 1.7 (1.3) | Ladder 43, filter 18 | Scrounge: 80.2 → 78.4 | xl-only |
| #876 Wanderer | 48.7 → 47.0 | 1.7 (1.3) | Ladder 43, filter 18 | Wanderer: 53.6 → 52.0 | full |
| #859 Expander S | 58.4 → 56.8 | 1.6 (1.2) | filter 71 | Expander S at 1: 36.4 → 35.8 | full |
| #872 Monolith D | 40.1 → 38.7 | 1.4 (1.1) | Ladder 43 | Monolith D at 1: 41.6 → 40.3 | full |
| #976 Shush 101 | 40.1 → 38.8 | 1.3 (1.0) | Ladder 43 | Shush 101 at 1: 42.2 → 41.0 | full |
| #873 Sallen 20 | 53.2 → 52.1 | 1.1 (0.9) | filter 36 | Sallen 20 at 1: 54.7 → 53.6 | full |
| #875 Vernon 100 | 46.3 → 45.8 | 0.5 (0.4) | filter 18 | Vernon 100: 49.3 → 48.8 | full |
| #851 8 Lire | 43.5 | 0 | none of these modules | 8 Lire XL: 118.0 | xl-only |
| #854 Algo Four | 62.7 | 0 | none | Algo Four XL at 8: 341.3 | xl-only |
| #857 Cassia 1 | 72.5 | 0 | none | Cassia 1 at 8: 132.7 | xl-only |
| #865 Spokes 6 | no factory patch | | (model: filter 359) | Spokes 6 XL: 1039.1 → 1026.7 | xl-only |
| #863 Perun 4 | no factory patch | | (model: filter 178, Resonator 167) | Perun 4 XL: 242.8 → 234.5 | xl-only |

The full-parity patches marked XL do not fit the firmware's limits, so the emulator cannot play them; for them, and for the three that overloaded on the emulator (Algo Four, Cassia 1 and Oracle V at their full-parity voices, muted by the overload guard), the saving comes from the editor's model alone.

### Which parity bands move

None. A band depends on the CPU only at 90 % (reachable to tight) and 130 % (tight to xl-only), and no instrument near either line gains enough:

- Cassia 1 (132.7 %, the only one within 3 points of a line) has no Resonator, filter, Ladder or Vowel. It would need its chorus, delays and reverb in float to come under 130 %.
- Oracle V, Perun 4, Elvira 2, Spokes 6 and Algo Four stay far over 130 %. 8 Lire, Briefcase 3 and Scrounge are xl-only for limits other than the CPU.
- The "full" band does not depend on the CPU, but the headroom grows: the 808 Kit falls by 11.5 points and the 909 Kit comes under the 85 % line above which a band needs a rig check.

### The schedule for step 3

Across the factory patches, the emulator estimate saves (central, µs a half summed over the instruments that have the module):

| module | instruments | saved in all | a copy saves |
|---|---|---|---|
| filter (state variable) | 13 | 907 µs | 18 µs (one stage) to 39 µs (two) |
| Ladder | 10 | 761 µs | 43 µs (60 diode) |
| Resonator | 2 (and Perun 4 XL) | 418 µs | 84 µs |
| Vowel | 1 | 53 µs | 53 µs |

1. **The Resonator** first, as #979 plans: the largest gain a copy, measured on the rig as `m_modal` runs it, the 808 Kit's biggest saving (334 µs), and the simplest conversion (no step toward zero, [D-1109](../ledger/engine.md#D-1109)).
2. **The filter**: the most instruments (13), led by Hera 6, the 808 and 909 Kits and Verona Drum 1.
3. **The Ladder**: 10 instruments, led by Io 4 and Oracle V.
4. **The Vowel**, then the delay and reverb feedback filters (to be measured first: the reverb is Briefcase 3's and Canvas's largest module), then the one-poles.
