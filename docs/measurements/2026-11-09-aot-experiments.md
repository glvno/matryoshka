# Compiled drums, arithmetic fusion and core sharing, 2026-11-09

These default-off experiments compare three changes to ahead-of-time (AOT) assembly compilation: combining arithmetic chains into fewer loops, compiling the reduced drum set, and sharing independent drum work between the two cores. They do not change the released firmware or factory patches. The implementation and its limits are described in [Compiled assembly experiments](../AOT-EXPERIMENTS.md).

The measured firmware comes from commit `31e6efcdd7fcfbc36ad87a3ade3298637ba7004d`, [CI run 42707591239](https://github.com/glvno/matryoshka/actions/runs/42707591239). [PR #823](https://github.com/glvno/matryoshka/pull/823) contains the experiments and their tests. The native image, install package and matching emulator image are byte-identical to the final code build in [CI run 42710904417](https://github.com/glvno/matryoshka/actions/runs/42710904417), from commit `482d20301fee4a60c165880274e9574ffc5d46ce`. [Raw evidence](2026-11-09-aot-experiments.json) includes package hashes, build switches, exact fixture binaries, timing samples and core checks.

## Matched timing

All five builds use `ENG_AOT=1`, `FELUCCA_SPEED=0` and `ENG_RAMCODE=0`. The control compiles Oracle V only. The drum builds also compile the factory boom kick, snare and hihat. This is not the full 808 Kit. Pairing includes drum compilation; the combined build enables all three experiments. No comparison here uses the speed-optimized released 1.12.0 firmware.

Each timing window lasts five seconds after a one-second settling period. Oracle V alone holds four notes. The four-track profile runs the two-voice Oracle pattern plus the three drum patterns, with eight additional held notes exercising normal note stealing. USB audio is not streaming. Values are mean microseconds per 128-frame audio block; the deadline is about 2,902 microseconds. Core busy time excludes core 0's waits and can overlap across the cores.

| Build | Oracle alone | Four tracks | Core 0 busy, four tracks | Core 1 busy, four tracks |
|---|---:|---:|---:|---:|
| Oracle AOT control | 1881.1 | 2291.4 | 2136.3 | 679.7 |
| Arithmetic fusion | 1928.8 | 2319.7 | 2168.5 | 705.2 |
| Compiled drums | 1873.7 | 2322.7 | 2169.7 | 688.2 |
| Compiled drums + pairing | 1898.1 | 2216.1 | 2011.7 | 920.9 |
| Fusion + drums + pairing | 1972.4 | 2281.6 | 2057.6 | 966.9 |

Pairing has the lowest observed four-track mean: 3.3% below the control and 4.6% below compiled drums without pairing. Its timing window records two worker jobs per block instead of one. Core 1's idle time during voice rendering falls from 1,462.2 to 1,144.0 microseconds. Core 0 still does substantially more work. Fusion alone and drum compilation alone show no improvement in these windows; combining all three saves only 0.4% against the control. These are individual short windows, not repeated statistical trials. Small differences can include code-layout and timing variation. No variant raises the passing voice count.

## Capacity

The patches have separate Oracle, kick, snare and hihat tracks, no added effects, and two, three or four Oracle voices. Every firmware variant uses identical patch bytes. The ordered fixtures store sequencers first so all four assemblies can bind to compiled templates in the drum builds. They differ from [the earlier four-track workload](2026-11-09-aot-capacity.md): its module order leaves two drums interpreted because their members span a sequencer. These tables therefore compare only the matched variants here.

Each cell covers four five-second phases with transport running and 0, 1, 4 or 8 extra held notes. Every phase reloads the patch. “Shed” is the most voices removed in a phase, “late” is the sum of missed audio-half deadlines, and “mute” is the most overload mutes reported. Any of these makes the cell a failure. Means collected after removed voices do not count as speed-ups.

| Oracle voices | Control | Fusion | Compiled drums | Drums + pairing | All three |
|---|---|---|---|---|---|
| 2 | Pass | Pass | Pass | Pass | Pass |
| 3 | Fail: shed 1, late 5, mute 0 | Fail: shed 1, late 8, mute 0 | Fail: shed 1, late 8, mute 0 | Fail: shed 1, late 1, mute 0 | Fail: shed 1, late 7, mute 0 |
| 4 | Fail: shed 2, late 9, mute 0 | Fail: shed 2, late 10, mute 0 | Fail: shed 2, late 9, mute 0 | Fail: shed 2, late 6, mute 0 | Fail: shed 2, late 10, mute 0 |

The new experiment builds were checked after warm installs. They have not had physical cold-start or extended playback qualification. The passing cells establish only the short workloads above.

## Correctness and resource checks

All five experiment combinations pass the host comparison against the interpreter, including parameter changes, morphing, bypasses, variable block lengths and sequencers running. Drum-enabled capacity runs require four compiled instances; the control and fusion-only runs require one compiled Oracle instance. Every solo track must produce audible output. Deferred and threaded workers, delayed jobs and deliberately lost paired jobs produce bit-identical output. A threaded combined run also passes ThreadSanitizer. The default engine comparison covers 473 kits, transitions and all 30 factory patches without an output change.

All five measured firmware variants pass the matching emulator boot check and the factory Oracle worker stack regression. Additional sequenced tests positively observe the paired worker with at least 128 bytes above its guard. The fused polyphonic worker also passes that 128-byte margin check. These are instruction-level stack checks, not physical timing measurements. The first sequenced test rejected a stopped transport; its setup was corrected and only the subsequent passing runs qualify the builds.

| Build | Application flash bytes | Free in the 581,564-byte application region |
|---|---:|---:|
| Oracle AOT control | 559,736 | 21,828 |
| Fusion | 559,992 | 21,572 |
| Compiled drums | 561,520 | 20,044 |
| Drums + pairing | 562,896 | 18,668 |
| All three | 563,328 | 18,236 |

The combined image adds 3,592 flash bytes over the control. Each build reserves the same 409,084-byte static pool, leaving 8,708 bytes in its region. Pairing adds 16 bytes to static data and 136 bytes to AOT state within the engine arena. A 32-bit layout probe measures 4,472 bytes of AOT state with pairing versus 4,336 without, plus at most seven bytes of alignment. This probe is separate from the firmware linker's static-pool accounting. No experiment here places code in the optional RAM-code region.

The stored patches remain expanded graphs: 3,101, 3,117 and 3,133 binary bytes at two, three and four Oracle voices. Compilation does not shrink saved patches. Compact library references and instrument swapping remain work for [#816](https://github.com/glvno/matryoshka/issues/816); custom compilation is tracked in [#817](https://github.com/glvno/matryoshka/issues/817).

## Reproduction and limits

Run `tools/aot_experiments.sh` for host checks and fixture generation. Firmware switch metadata is recorded in each package's JSON sidecar. For each package, run its matching emulator boot check, `tools/aot_stack.sh BIN ELF`, and `tools/aot_fixture_stack.py BIN ELF PATCH --worker pair --margin 128` where pairing is enabled. Use the polyphonic worker option to check the fused Oracle path.

Only then install on the registered rig with `tools/fm1_install.py --rig`. Require two healthy cores, split on, no bar, failed self-tests or refused jobs before and after every patch. Run `tools/m1_link.py --rig blocktime 5 --patch 'Oracle V' --notes 4 --json OUT.json` for the single-instrument profile. Run `build/venv/bin/python tools/rig_aot_profile.py build/aot-capacity/oracle-2-ordered-four-tracks.m1p OUT.json --hold 5` for the four-track timing columns. That command uploads the fixture, starts transport, holds notes 60, 64, 67, 71, 72, 76, 79 and 83 at velocity 100, waits one second, then captures a five-second window through diagnostic pages 132–139. It checks core health and overload counters and stops transport and releases notes on exit. Copy the ordered capacity fixtures to a directory as `.bin` files, then run `tools/rig_cpu_survey.py DIR OUT.json NAME --hold 5 --run` for each voice count. A core fault stops qualification and requires a physical power cycle before further comparisons.

These focused runs do not qualify every preset, performance-control position, effect, tempo or USB-audio workload. They do not justify changing the editor's CPU model, voice limits or build defaults. Arithmetic fusion still calls the general oscillator, filter and envelope processors. A fully specialized instrument kernel remains a separate optimization under [#808](https://github.com/glvno/matryoshka/issues/808).

After the measurements, the registered rig was restored to published 1.12.0 (`FM-1_7011200`). Both cores were healthy and analog output was enabled. The package hash and final diagnostics are included in the raw evidence. This restore does not substitute for cold-start qualification of the experimental builds.
