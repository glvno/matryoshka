# Oracle V compiled-code capacity, 2026-11-09

Ahead-of-time (AOT) compilation in these builds covers **Oracle V only**. The 808 Kit and all drums remain interpreted. RAM placement is a separate switch. The measurements below compare those switches with the same size-optimization setting. They do not compare directly with the released 1.12.0 package, which optimizes its audio path for speed.

Firmware comes from commit `836b736d7ff38fd37a9e88d96e828f70afcea8f0`, [CI run 42692602784](https://github.com/glvno/matryoshka/actions/runs/42692602784), merged by [PR #821](https://github.com/glvno/matryoshka/pull/821). No runtime firmware change was needed for this measurement. [Raw data](2026-11-09-aot-capacity.json) contains every timing sample, core check, build switch, package hash and exact fixture binary.

## Matched CPU comparison

The table uses mean audio-interrupt time over a five-second window with four held notes, divided by the 2,902-microsecond budget. USB audio was not streaming. Each build also played both factory patches at 0, 1, 4 and 8 held notes for ten seconds per phase, with transport stopped and running. Each phase reloads the patch. The registered rig's two cores were checked before and after each patch and timing window.

| Build | Oracle V, four voices | 808 Kit |
|---|---:|---:|
| Size control | 1985.2 µs (68.4%) | 2114.2 µs (72.9%) |
| RAM only | 1946.0 µs (67.1%) | 2002.9 µs (69.0%) |
| Oracle AOT | 1868.7 µs (64.4%) | 2083.3 µs (71.8%) |
| Oracle AOT + RAM | 1816.3 µs (62.6%) | 1963.8 µs (67.7%) |

All single-instrument surveys passed with no shed voices, overload mutes or late audio halves. Both cores stayed healthy throughout every valid run, including the overloaded capacity cases.

The surveys include load/attack peaks as well as the overload guard's mean-time samples. A figure after voice shedding or muting cannot establish a speed-up. These are short, matched runs on one rig, not a calibrated CPU model or a promise about every patch or performance-control setting.

## Multi-instrument playback

The smaller setup keeps Oracle V's synthesis and performance controls, with its voice count set to one, two, three or four. Its drums are the factory **boom kick, snare and hihat** assemblies. It has no added effects. This is not the 808 Kit: its clap, open hat, tom, rim shot and cowbell are absent, and its kick differs. The two-track version has one synth track and one drum-map track. The four-track version has separate synth, kick, snare and hat tracks. The fixtures store 120 beats per minute. The rig's global tempo was left unchanged and read back as 120 during the longer checks.

The three-voice cases were added after four voices failed and were measured only on the combined build. Their passing result cannot establish a voice-count gain over the unmeasured three-voice control.

Every cell covers four ten-second phases with transport running and 0, 1, 4 or 8 additional held notes. The programmed synth chords use the configured voice count. Extra held notes exercise normal note stealing at that count. Each phase starts from a fresh patch load. “Shed” is the most voices removed by the overload guard in one phase; “late” is the total missed audio-half deadlines across the four phases. These are failures even if the patch keeps making sound.

| Configuration | Size control | Oracle AOT + RAM |
|---|---|---|
| Two tracks, 1 synth voice | Pass | Pass |
| Two tracks, 2 synth voices | Pass | Pass |
| Two tracks, 3 synth voices | Not measured | Pass |
| Two tracks, 4 synth voices | Fail: shed 2, late 6, muted 0 | Fail: shed 0, late 1, muted 0 |
| Four tracks, 2 synth voices | Pass | Pass |
| Four tracks, 3 synth voices | Not measured | Fail: shed 1, late 2, muted 0 |
| Four tracks, 4 synth voices | Fail: shed 2, late 10, muted 0 | Fail: shed 2, late 7, muted 0 |

The host harness renders each of the four tracks alone and requires audible output. It also separates the two instruments across left and right, verifies one active compiled Oracle instance (two in the duplicate-Oracle fixtures), and compares the measured fixtures with the interpreter under threaded execution. Output is bit-identical. Host render speed is not used as a hardware measurement.

The combined build also passes two longer checks with eight additional held notes: **120 seconds** on four tracks with two Oracle voices, and **60 seconds** on two tracks with three Oracle voices. Both have nonzero output, zero shed voices, zero overload mutes and zero late audio halves. Core health is checked every 15 seconds. A one-second settling period and a five-second timing window precede each longer check. These are focused playback checks, not an endurance test or a survey of every preset and control position.

The passing four-track timing window spends 2,068.2 microseconds on core 0's voice-render work, excluding its waits, against 670.9 microseconds in core 1's jobs. Core 1 is idle for 1,402.3 microseconds while the voices render. This suggests investigating how independent instruments can share work between cores, alongside compiling the drums. It does not establish how much that change would save.

## Storage and memory

The full Oracle-plus-808 fixture needs 4,054 bytes including reserved preset-name room at one synth voice, against a 3,840-byte patch-slot budget. Two mono Oracle instruments with independent tracks also exceed the slot. Those oversized fixtures were inspected on the host and were **not uploaded**. Removing voices alone does not solve the stored-graph size limit. AOT still stores the expanded assembly graph.

The four-track fixtures fit: two Oracle voices use 3,101 binary bytes; four use 3,133. See the raw manifest for the extra reserved name room. Their engine arena has 222,096 and 155,016 bytes respectively before AOT state. They use no effect-line memory. A 32-bit layout probe gives 4,336 bytes of AOT state plus at most seven bytes of alignment, leaving at least **217,753** and **150,673** bytes respectively in this accounting. The host's native AOT state is larger (6,784 bytes), so host binding success is conservative; its rejection boundary is not an exact FM-1 capacity limit.

Each AOT firmware image occupies 559,688 of 581,564 flash bytes, leaving **21,876 bytes**. The AOT-plus-RAM build places 15,168 bytes of code in its reserved RAM region, leaving **240 bytes** there. Its static pool uses 409,084 of 417,792 bytes, leaving **8,708 bytes** outside the engine's already reserved arena. These are distinct regions, not values to add together.

Core stack-paint readings are included in the raw diagnostics. Paint misses reserved but unwritten stack space; the [instruction-level stack regression and cold-start check](2026-11-09-aot-stack.md) remains the evidence for the fixed Oracle call chain. New compiled templates need their own stack check. No guard, voice count, CPU estimate or build default changes here.

## Reproducing the fixtures

Run `tools/aot_capacity.sh` from the repository root. It writes patch JSON, binary files and a budget manifest to `build/aot-capacity/`, builds host checks with AOT off and on, and verifies the sequenced outputs. `HOST_CORES=2 build/aot_test build/aot-capacity/oracle-*-three-drums.m1p build/aot-capacity/oracle-*-four-tracks.m1p` performs the threaded exact comparison after `tools/aot_test.sh` has built that test executable.

For hardware measurements, install only a package that passed its matching emulator gate, through `tools/fm1_install.py --rig`. Check `tools/m1_link.py --rig cores` before and after every patch; require two cores, split on, no bar, no failed self-tests and no refused jobs. Stop on a core-health failure. Use `tools/rig_cpu_survey.py firmware/src/presets.h OUT.json 'Oracle V' --hold 10`, repeat with `--run`, and do the same for `'808 Kit'`. `tools/m1_link.py --rig blocktime 5 --patch 'Oracle V' --notes 4 --json OUT.json` supplies the table's timing window. Capacity surveys use a directory containing only the storage-valid `.m1p` fixtures copied as `.bin`, with `--run --hold 10`.

After the measurements, the registered rig was restored to published 1.12.0 (`FM-1_7011200`). Both cores were healthy and the device page showed analog output enabled. The restore package hash and final diagnostics are included in the raw record.

Further compiler and capacity work belongs to [#808](https://github.com/glvno/matryoshka/issues/808). Instrument swapping and library storage are tracked in [#816](https://github.com/glvno/matryoshka/issues/816); custom compilation is [#817](https://github.com/glvno/matryoshka/issues/817). Neither default switch is enabled by this measurement.
