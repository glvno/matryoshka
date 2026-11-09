# Compiled assemblies and RAM placement on the rig, 2026-11-09

Ahead-of-time (AOT) compilation fails the two-core hardware check. Moving selected functions into RAM works in this limited comparison and saves time on the 808 Kit. Neither experiment is enabled in the normal release package. The combined Oracle V and drum-kit patch overloads on every healthy comparison build, so this test does not establish a usable multi-instrument groovebox.

The builds come from firmware CI [42673451565](https://github.com/glvno/matryoshka/actions/runs/42673451565), commit `774e1ddc9815188c2df1f04b4606b3734171ec3a`. [Build hashes and switches](2026-11-09-integration-builds.json) identify the exact packages. [Raw surveys, timing samples and core diagnostics](2026-11-09-rig-experiments.json) include the invalid runs, explicitly marked as invalid.

## Comparisons that kept both cores

The normal build uses `-O2` on the audio path. The size control and RAM experiment both use size optimization, so their difference isolates RAM placement. All builds enable signal-buffer sharing. The RAM experiment places 15,168 bytes of code in RAM and leaves 240 bytes in that region.

Each patch was reloaded at 0, 1, 4 and 8 held notes, for two seconds per phase, with transport stopped and running. The steady value is the lower median after the first sample. Each cell takes the largest steady value across the four note counts, divided by the 2,902 microsecond block budget. These are short measurements, without repeated trials to quantify noise. The individual patches completed without shedding, overload muting or late audio halves.

| Patch | Normal, stopped / running % | Size control, stopped / running % | RAM, stopped / running % |
|---|---:|---:|---:|
| Oracle V | 77.0 / 77.8 | 73.5 / 75.2 | 73.0 / 75.3 |
| 808 Kit | 75.2 / 81.4 | 77.2 / 82.2 | 72.8 / 79.0 |

RAM placement lowers the 808 Kit's worst steady result by 3.2 percentage points against the size control. Oracle V's worst result is essentially unchanged. The experiment has not had the normal build's complete factory survey or full hardware scenario coverage. These figures do not justify changing voice counts or enabling it for everyone.

The two-instrument fixture contains four-voice Oracle V and a general drum-kit assembly; it is not Oracle V plus the 808 Kit. All eight survey phases on each healthy build shed voices and then muted. The low times after muting are not performance gains. Its bytes and hash are recorded with the raw data.

## AOT hardware failure

The AOT-only build reported one core, a late job and a bar that lasts until power-off. Only one self-test and one job had completed. A cold start of the AOT-plus-RAM build reproduced that state before any benchmark ran. Its core 1 stack paint reached 3,304 bytes; the guarded user stack allows 3,328 bytes.

A warm install after the cold-start failure preserved this crash record:

- Core 1 marker `0xc1`, vector `1`, uptime `1756 ms`.
- Program counter `0x0201df18`, decoded against that build's ELF as `process+0x20`.
- Return address `0x0203d752`, decoded as `aot_blk+0x12a`.

The call into the general module processor and the near-full stack make stack exhaustion the leading hypothesis. The record does not prove it: the fault handler stores its supervisor stack pointer, not the interrupted user-stack value, and substitutes the core marker for the hardware exception detail. No guard was weakened and no speculative firmware fix was applied. Host bit-exact tests and emulator boot checks passed, but they do not reproduce the FM-1's second-core stack constraint.

There is no valid two-core AOT speed comparison. The CPU model's predicted gain remains a model result. [Issue #808](https://github.com/glvno/matryoshka/issues/808) needs the hardware fault resolved before capacity or groovebox claims can be tested.

## Keeping comparisons valid

A failed second core stays barred across firmware installs until the FM-1 is fully powered off. The first RAM run inherited AOT's bar, so its performance figures are invalid. The RAM results in the table came from a fresh power cycle, with both cores checked before and after each patch survey and each block-timing measurement. Every check in that replacement run passed.

For another comparison, install only after the matching emulator gate passes, then read `tools/m1_link.py --rig cores`. Require two cores, split on, no bar, no failed self-tests and no refused jobs. Check again after each patch. Stop if any condition fails; preserve the fault report across a warm restart before a full power cycle clears it. The `diag` command reports the preceding boot's fault, not a fault still held by the running build. Do not count results gathered with a disabled core as a two-core comparison.
