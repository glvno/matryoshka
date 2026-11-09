# Integrated Oracle comparison, 2026-11-09

The integrated Oracle prototype is slower than ordinary ahead-of-time (AOT) Oracle compilation on the registered FM-1. Three repeated windows put Oracle alone at 2,395.2 microseconds per audio block, versus 1,878.5 for the control: 27.5% more time. The four-track workload loses capacity. The control sustains two Oracle voices alongside kick, snare and hihat; the integrated build sheds to one Oracle voice in every tested window. This implementation does not justify shipping the kernel or expanding it to other instruments.

Both images come from commit `6b43f9b60ed7005a01377fef0c774d20e041e659`, [firmware CI 42717665535](https://github.com/glvno/matryoshka/actions/runs/42717665535), in [draft PR #823](https://github.com/glvno/matryoshka/pull/823). [Raw evidence](2026-11-09-integrated-oracle.json) contains firmware and fixture hashes, exact fixture bytes, timing records, core checks and emulator results. The control's native image, install package and emulator image match the previously qualified control from CI 42710904417 byte for byte.

## What was tested

`ENG_AOT_ORACLE=1` replaces Oracle's shared routing and voice graph with a fixed signal path. It integrates the two analog oscillators, hard sync, envelopes, modulation, waveform selection, nonlinear ladder filter and output gain. Shared LFO and noise generators retain their existing DSP routines. A modulation pass preserves oscillator pitch lookahead and the ladder's whole-block cutoff calculation; the following pass renders oscillator A, the filter and output. Public controls remain live. Unsupported internal modes fall back to ordinary compiled processing before their DSP state advances. The kernel reuses the existing module state and buffers; it does not implement a compact instrument memory layout.

Both builds use `ENG_AOT=1`, `FELUCCA_SPEED=0`, `ENG_RAMCODE=0`, and disable the other fusion, drum-compilation and pairing switches. Only `ENG_AOT_ORACLE` differs. Both use two healthy cores with voice splitting enabled and no USB audio stream. The three reduced drum assemblies remain interpreted. These measurements compare against the size-optimized AOT control, not the speed-optimized released firmware.

Each workload has three five-second windows, with a one-second settling period and a patch reload before each window. Oracle alone holds four notes. The ordered four-track fixtures run separate Oracle, kick, snare and hihat patterns, with eight additional held notes exercising note stealing. The fixtures contain two, three or four Oracle voices. The A/B order is control followed by integrated; these are warm-install tests, not cold-start or extended playback qualification.

## Results

Times are mean microseconds per 128-frame audio block. The deadline is about 2,902 microseconds. Ranges are the smallest and largest of the three window means.

| Workload | Ordinary Oracle AOT | Integrated Oracle |
|---|---:|---:|
| Oracle alone, four held notes | 1,878.5 (1,877.1–1,879.2) | 2,395.2 (2,394.6–2,395.7) |
| Four tracks, two Oracle voices | 2,292.3 (2,292.0–2,292.6), passes 3/3 | Fails 3/3; sheds one voice |
| Four tracks, three Oracle voices | Fails 3/3; sheds one voice | Fails 3/3; sheds two voices |
| Four tracks, four Oracle voices | Fails 3/3; sheds two voices | Fails 3/3; sheds three voices |

A four-track window is invalid if it reports overload muting, voice shedding or any new missed audio deadline. Times after shedding are deliberately excluded from the comparison. Raw guard counters are cumulative; the controller compares each final counter with its pre-window value when setting `valid`. These records omit the pre-window snapshot, so the deadline delta cannot be independently reconstructed from the JSON; the helper now saves it for future runs. The shedding counters independently establish the measured capacity regression. The standalone timing tool does not capture those guard snapshots. Its records retain four awake voices per worker job, two per core, throughout the measured windows.

The standalone core breakdown locates the regression in processing rather than increased waiting:

| Oracle alone | Ordinary Oracle AOT | Integrated Oracle |
|---|---:|---:|
| Core 0 busy during voice rendering | 1,738.2 | 2,282.3 |
| Core 1 busy | 1,093.0 | 1,567.3 |
| Core 0 waiting for core 1 | 4.0 | 3.3 |
| Core 1 idle during voice rendering | 649.2 | 718.4 |

Both cores do more work in the integrated build. These measurements do not distinguish instruction count, parameter loads, register spills and instruction-cache effects. A larger C loop alone does not establish efficient machine code. The next useful investigation is a focused comparison of the emitted hot loops and per-sample parameter accesses, followed by one matched test if that investigation yields a concrete correction. A speed-optimized comparison would also need both images to fit the device; the present result uses size optimization on both sides. The results do not establish a speed ceiling for every purpose-built Oracle implementation.

## Correctness and resources

The host suite compares every output sample with the interpreter across factory patches, randomized internal edits, morphing, duplicate Oracle instances, variable block lengths and sequenced four-track fixtures. Public controls visit their minimum, midpoint and maximum without voice fallback. Deferred, threaded and delayed workers pass. ThreadSanitizer passes both the general Oracle fixtures and the public-control sweep; the latter executes 9,093 integrated voice calls with zero fallback. Review caught and corrected ongoing selector fades and concurrent writes to shared parameter-input buffers before these images were built.

The integrated image passes the matching 19-check emulator boot gate, the factory Oracle worker-stack gate and an ordered four-track gate that observes the integrated kernel execute on core 1. The four-track stack pointer stays at least 128 bytes above the existing guard. All physical core checks pass, with no failed self-tests or refused jobs. The largest reported core-1 stack usage is 2,788 bytes for the control and 1,916 for the integrated build.

| Resource | Control | Integrated |
|---|---:|---:|
| Application image | 559,736 bytes | 568,776 bytes |
| Application-slot free space | 21,828 bytes | 12,788 bytes |
| Static data and zero-initialized data | 20,276 bytes | 20,276 bytes |
| Engine pool | 409,084 bytes | 409,084 bytes |
| Low RAM | 27,288 bytes | 27,288 bytes |

The kernel adds 9,040 flash bytes with no static RAM, pool or low-RAM allocation. Worker stack sizes are unchanged. Public controls and exact sound are preserved, but the default-off kernel remains an experiment. Physical cold-start, listening and long-playback qualification were not performed.

The rig was restored to published 1.12.0 (`FM-1_7011200`), using package SHA256 `ab14bc3ecbfd263bea2e6eb1d5f2386282fd74a9a863dfac5b244dd6e37dea7b`. The identity, two healthy cores and analog output enabled were checked after restoration. All hardware commands stopped before release to the orchestrator.
