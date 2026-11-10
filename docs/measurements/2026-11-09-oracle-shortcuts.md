# Oracle shortcut probes, 2026-11-09

Constant-signal snapshots improve the integrated Oracle's instruction count, but the tested zero- and unity-gain branches make it worse. None closes the gap to ordinary ahead-of-time (AOT) Oracle. Keep the experiment disabled; these results do not justify another device timing window yet.

The [physical result](2026-11-09-integrated-oracle.md) remains 27.5% slower, with healthy cores and sample-exact host audio. This report adds offline measurements; it does not replace that result with an estimated device speed-up.

## Matched comparison

[Compiler run 42730208554](https://github.com/glvno/matryoshka/actions/runs/42730208554) uses probe commit [`2b176660`](https://github.com/glvno/matryoshka/commit/2b176660c26dd6ae11b08fb7a2d09c631a331252), pins measured source `6b43f9b6`, and uses the same JieLi compiler cache and flags: `ENG_AOT=1`, `FELUCCA_SPEED=0`, RAM/fusion/drum/pair switches off. It rebuilds the ordinary control, original integrated kernel and parameter/signal snapshot baseline byte-identically to their previous binaries. Host-tested candidate headers also match the compiler artifacts byte for byte.

The unchanged [instruction counter](2026-11-09-oracle-codegen.md) records eight completed core-1 jobs holding the same four factory Oracle notes. Every rerun reproduces the previous control totals exactly. Shared modulation on core 0 is outside the capture. These are executed instruction and memory-access counts, not physical cycles or cache measurements.

All three changes start independently from the parameter-and-signal snapshot baseline. Zero gain adds an early return to scalar Scale/VCA helpers. Unity gain removes identity multiplications from those helpers while retaining the first VCA multiplication. Constants replace local signal descriptors with one value for graph-guaranteed uniform signals `sh0`, `sh2`, `sh3` and `sh5`. A fourth build combines the three changes to measure their interaction. The shared descriptors stay materialized and unchanged.

The constant probe deliberately retains `sh1` as a sample buffer: its shared selector can fade while the voice kernel runs, including a fade that finishes within a block. The four shortened signals remain uniform even through shared-selector fallback. Their values are read anew each block; none is fixed to a factory control setting.

| Variant | Instructions | Change from snapshot baseline | Multiplies | Conditional branches | Non-stack RAM reads | Stack reads |
|---|---:|---:|---:|---:|---:|---:|
| Ordinary AOT control | 1,141,790 | — | 114,990 | — | 69,942 | 198,127 |
| Original integrated | 2,048,595 | — | 143,518 | — | 421,718 | 377,063 |
| Parameter/signal snapshots | 1,460,163 | — | 146,368 | 101,272 | 60,966 | 410,621 |
| Zero-gain shortcut | 1,521,341 | +4.19% | 136,096 | 119,704 | 60,950 | 439,962 |
| Unity-gain shortcut | 1,483,737 | +1.61% | 132,032 | 119,720 | 60,966 | 430,526 |
| Constant signals | 1,402,622 | −3.94% | 147,598 | 93,054 | 53,206 | 402,771 |
| All three | 1,420,717 | −2.70% | 127,086 | 123,774 | 53,190 | 428,430 |

All changes in these instruction totals occur inside `aot0_seg1`; the other sampled functions retain their totals. Each candidate still makes 1,550 calls and reads effective parameters 2,128 times. Those are unchanged from the snapshot baseline.

## What is proven

The gain shortcuts remove arithmetic, but introduce more executed control flow and stack traffic than they save in this compiler output. Zero gain removes 10,272 multiplies but adds 18,432 conditional branches, 29,341 stack reads and 16,176 stack writes. Unity gain removes 14,336 multiplies but adds 18,448 conditional branches, 19,905 stack reads and 12,883 stack writes. Fewer multiplications alone is therefore an inadequate optimization target.

Constant signals remove 57,541 instructions and 7,760 non-stack RAM reads. They also remove 8,218 conditional branches and 7,850 stack reads. This is a useful isolated improvement, but the result still executes **22.84% more instructions than ordinary AOT** and performs **2.03 times its stack reads**. Combining gains with constants performs worse than constants alone. These measurements do not establish how much time individual instructions or cache misses cost on the FM-1.

| Variant | Firmware image bytes | `aot0_seg1` local frame bytes |
|---|---:|---:|
| Ordinary AOT control | 559,736 | 140 |
| Original integrated | 568,776 | 804 |
| Parameter/signal snapshots | 568,872 | 1,036 |
| Zero gain | 568,968 | 1,036 |
| Unity gain | 568,952 | 1,036 |
| Constants | 569,176 | 1,132 |
| Combined | 569,320 | 1,188 |

Every build uses the same static `.data+.bss` (20,276 bytes), engine pool (409,084 bytes) and low-RAM allocation (27,288 bytes). Local frames are read from emitted function prologues; they are not maximum call-chain stack usage or a stack-safety gate. The extra stack accesses are measured; this probe does not fully distinguish allocator spills from addressable local structures. These historical experiment builds are not current release/development resource budgets and establish no additional XL capacity.

## Exact behavior checks

All five host variants, including the snapshot baseline, pass 25 focused runs. They compare audio sample for sample against the interpreter and compare oscillator phase/sync plus envelope value/stage/previous-gate state after every block. The cases include ordinary and morphed Oracle, duplicate instances, randomized internal edits, bypasses, block lengths 64/100/128/256, note releases, controller modulation, zero/unity/half-gain transitions, and selector fades including shared selector 23. Stateful DSP remains active while outputs are muted and after gains return.

The public minimum/midpoint/maximum control sweep exercises 9,093 integrated voice calls with zero fallback per variant. The original duplicate fixture allows one instance to fall back, so an additional case copies supported factory voice parameters into both instances, then changes their public controls independently. It requires positive integrated hits in each instance, passes 9,454 integrated calls with zero fallback, and preserves exact audio and state in every variant.

The state assertions have negative controls: with all audio forced silent, the healthy kernel passes, but deliberately omitting either oscillator or envelope state commits fails. The combined candidate also passes ThreadSanitizer with two host lanes, delayed workers, gain transitions and fades on ordinary and duplicate fixtures. The deliberate faults and instrumentation live only in the temporary probe directory; production sources are unchanged. These tests establish focused correctness, not a full emulator suite or release qualification.

## Remaining overhead and next experiment

Keep the constant-signal probe as the best measured candidate. Do not add these scalar zero/unity branches to it. A useful next experiment would classify gain cases once per voice block and dispatch the affected arithmetic outside the sample loop, retaining the general path and all oscillator/envelope updates. Measure it separately: duplicating whole loops could consume flash or increase stack pressure. Arithmetic around mixers and unselected waveform paths also remains outside the limited Scale/VCA shortcut probes here.

The remaining instruction gap and large stack traffic give no offline reason to expect a win over ordinary AOT yet. No candidate is recommended for device measurement now; no rig request is pending. A future candidate should first beat the matched offline control and pass a targeted maximum-stack check. No user choice is required for this finding. The experiment remains disabled, isolated from main and the development branch.

[Raw evidence](2026-11-09-oracle-shortcuts.json) archives candidate headers, scripts, hashes, build logs, exact-output logs, negative controls and compressed per-instruction tables. The compiler artifact is `oracle-codegen-probe` in the linked run. Local copies are `/private/tmp/matryoshka-oracle-shortcuts-2026-11-09/compiler`; the reproducible workflow and transforms are on the disposable `docs_oracle_codegen_probe` branch. Its temporary compiler-only workflow must never be merged.
