# Compiled assembly experiments

The switches in [D-399](ledger/engine.md#D-399) test three separate sources of processing cost. They require `ENG_AOT=1` and default to off. Comparison builds use `FELUCCA_SPEED=0`. The released firmware, factory patches and editor capacity model are unchanged.

| Switch | What it changes |
|---|---|
| `ENG_AOT_FUSE` | Combines single-reader Scale, VCA, Math and Mixer chains into one sample loop. It keeps each fixed-point multiplication in its original order. |
| `ENG_AOT_DRUMS` | Compiles the factory boom kick, snare and hihat assemblies in addition to Oracle V. This does not compile the full 808 Kit. |
| `ENG_AOT_PAIR` | Runs two adjacent independent mono drum assemblies on separate cores. It waits for both before continuing through the patch. |

Fusion stops at stateful processors, selectors, feedback, parameter-input modulation, shared outputs and assembly boundaries. Oscillators, filters and envelopes still use the existing DSP processors. This is an arithmetic-chain experiment, not a fully fused purpose-built Oracle engine. Oracle's Ladder reads a whole envelope block to calculate its mean cutoff modulation; processing the whole voice sample by sample would change that behavior.

Pairing accepts only the processors used by the reduced drum templates. No outside module may fall between the pair's first and last members, and no cable may connect the two assemblies. Both assemblies keep private buffers. During the worker's job it uses the second lane's parameter and oscillator scratch and dummy outputs. A bypass prevents pairing for that block. A refused job runs serially; a lost job uses the existing core fallback. Polyphonic voice splitting is unchanged.

`tools/aot_experiments.sh` checks each switch combination against the interpreter, including parameters, morphing, bypasses, selector changes and variable block lengths. Capacity fixtures additionally start transport, check compiled-instance counts and render tracks alone. Pairing is checked with deferred and threaded jobs, delayed workers and a lost hand-off. These host checks establish output equality, not device speed or stack safety.

The `oracle-*-ordered-four-tracks` fixtures put sequencers first in stored module order. All four instruments can then bind to compiled templates. The original four-track fixtures retain their ordering: snare and hihat fall back because their members span a Steps module. The compiler does not reorder a user's patch around that barrier. The ordered fixtures are separate workloads and must be compared using identical bytes across firmware variants.

`tools/build.py` records each switch in the firmware package's JSON sidecar. The firmware workflow builds separate control, fusion, drums, pairing and combined packages with matching emulator images. Before installing one on the registered rig, check its emulator boot, actual stack-pointer limits and core health. Measure deadline misses and voice shedding as well as mean processing time. A mean measured after the overload guard removed voices is not a speed-up.

The baseline hardware measurements are in [the capacity report](measurements/2026-11-09-aot-capacity.md). Further measurements and the compact instrument representation are tracked in [issue #808](https://github.com/glvno/matryoshka/issues/808). Instrument replacement and library storage are tracked in [issue #816](https://github.com/glvno/matryoshka/issues/816).
