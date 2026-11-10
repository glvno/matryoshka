# Oracle regression: emitted-code diagnosis, 2026-11-09

Repeated parameter and signal-pointer reads are a confirmed, avoidable cost in the integrated Oracle kernel. Two controlled compiler probes remove 64.9% of its excess executed instructions in the sampled core-1 jobs. They do not yet beat ordinary Oracle ahead-of-time (AOT) compilation. The experiment remains disabled, and none of these probes has been installed on hardware or integrated into the development branch.

The original physical result remains unchanged: [the integrated kernel was 27.5% slower](2026-11-09-integrated-oracle.md), with bit-identical host audio and healthy physical cores. This diagnosis identifies instruction costs; it does not assign portions of that physical slowdown to cache, memory or execution cycles.

## Matched method

A temporary emulator probe counts eight completed core-1 jobs while the factory Oracle holds four notes. It records each executed instruction address and RAM reads/writes, including a separate stack count. It identifies effective-parameter regions and instance-pointer fields from the prepared voice context. Counting starts at 420,000,000 core-0 emulator cycles, after notes at 3,000 emulated milliseconds; the run ends at 4,000 milliseconds. The original images produce identical totals with the basic counter and the extended parameter-address counter.

All firmware comes from measured source `6b43f9b6`, with the same JieLi toolchain cache, `ENG_AOT=1`, size optimization (`FELUCCA_SPEED=0`), and RAM/fusion/drum/pair experiments off. [Focused compiler run 42727648428](https://github.com/glvno/matryoshka/actions/runs/42727648428) rebuilds the ordinary and integrated images byte-identically to physical-test CI 42717665535, then applies three changes in sequence. No routine full suite runs. The disposable compiler branch is `docs_oracle_codegen_probe`, commit `8373fb34`; its manual workflow contains no release or publishing step.

[Raw evidence](2026-11-09-oracle-codegen.json) includes image hashes, emitted-code hashes, function totals, compressed per-instruction records, the temporary emulator patch, transformation scripts and focused exact-audio logs. Per-instruction tables are gzip-compressed and base64-encoded; their header names the columns. The decoder and emulator are the repository's pinned versions. The counts are instructions and memory accesses, not hardware cycles. Shared modulation on core 0 is outside this probe.

## Controlled changes

| Variant | Executed instructions | Effective-parameter reads | Other than stack: RAM reads | Stack reads |
|---|---:|---:|---:|---:|
| Ordinary Oracle AOT | 1,141,790 | 1,824 | 69,942 | 198,127 |
| Measured integrated kernel | 2,048,595 | 75,280 | 421,718 | 377,063 |
| Snapshot prepared voice parameters | 1,792,524 | 2,128 | 234,726 | 405,899 |
| Also snapshot fixed input signals/output pointer | 1,460,163 | 2,128 | 60,966 | 410,621 |
| Also separate oscillator-A/mix from the ladder loop | 1,459,346 | 2,128 | 63,014 | 389,030 |

Effective-parameter reads are a subset of the non-stack RAM reads, not an additional category.

The parameter probe snapshots 65 prepared values and selector choices once per voice block. It changes no arithmetic order or parameter preparation. It removes 97.2% of effective-parameter reads and 12.5% of the integrated kernel's instructions. The following probe snapshots fixed shared-signal descriptors and the final output pointer. Together they remove 64.9% of the surplus instructions above the ordinary AOT control. They still execute 27.9% more instructions than that control.

The final probe renders oscillator A and its mix into an existing private buffer before running the ladder/output loop. It preserves whole-block filter modulation and oscillator pitch lookahead. It reduces stack reads by 5.3%, but instructions by only 0.056%. Separating that particular loop boundary is therefore insufficient to solve the remaining instruction cost.

## What the emitted code establishes

- **Repeated object traversal is real.** Many effective-parameter load instructions run 2,048 times in the sampled jobs. The ordinary processors load parameters outside their sample loops. The integrated source instead uses `c->it[member]->eff[param]`, selector fields and `c->x->sh[index]` throughout the loops. The explicit snapshots remove those repeated reads in the same compiler output. Possible aliasing of sample stores with other integer memory is consistent with this behavior; the experiment does not claim to reconstruct every optimizer decision.
- **Calls were removed successfully.** Dynamic calls fall from 2,638 to 1,550. The regression therefore cannot be explained as failure to remove calls: more work executes inside the combined function.
- **Stack traffic remains substantial.** With both snapshots, stack reads are 2.07 times the control. The segment's local frame grows from 140 bytes in ordinary AOT to 804 in the integrated kernel and 1,036 with both snapshots. These are local frames, not maximum call-chain stack usage. The counts do not separate register-allocator spills from addressable local structures. Splitting the tested filter boundary reduces this traffic modestly without a comparable instruction reduction.
- **Arithmetic shortcuts also differ.** `ag_scale`, `ag_vca` and other ordinary AOT helpers skip work for zero/unity gains and constant signals. The integrated scalar helpers do not preserve all those shortcuts. Dynamic multiply instructions rise from 114,990 to 146,368 with both snapshots. The [follow-up probes](2026-11-09-oracle-shortcuts.md) isolate Scale/VCA gain shortcuts and graph-constant signals; other arithmetic differences remain unmeasured.
- **Flash size is not a cache diagnosis.** The integrated job visits fewer distinct instruction addresses: 3,111 versus 4,270 in the control. It executes those instructions more often. Actual instruction-cache conflicts, placement effects and hardware memory latency remain unmeasured. A larger total image alone does not establish the cause.

## Next correction and limits

Keep the experiment disabled. The [follow-up shortcut probes](2026-11-09-oracle-shortcuts.md) separately measure Scale/VCA zero/unity gains and graph-constant signals on top of these snapshots. Constants improve the result, but scalar gain branches regress it; the best candidate still exceeds ordinary AOT's instruction count. That report records the next bounded correction and preserves stateful DSP progression. Do not expand the compiled instrument library on the strength of these probes.

Each probe passes focused sample-exact host comparisons on ordinary, morphed and duplicate Oracle fixtures, including randomized internal changes and fallback transitions. Public-control extremes also pass with the integrated path active and zero fallback. These checks do not constitute device qualification, cold-start tests or a proven speed-up. No new ThreadSanitizer, full emulator suite, rig run or release qualification was performed for these candidates; the original evidence is preserved separately.

No rig grant or user decision is needed for the findings above. A new bounded hardware request becomes useful after a candidate closes the offline instruction gap and passes its targeted stack/correctness gates. No Oracle resource saving is claimed for browser-only XL feasibility: the measured kernel adds flash, saves no static RAM/pool/low RAM, and loses physical capacity.
