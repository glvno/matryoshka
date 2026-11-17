# Usable variations: how others mutate patches, and what Matryoshka's Mutate should do, 2026-11-17

Issue #1006. The owner found that 1.18.1's Mutate and Make candidates ([D-975](../ledger/editor.md#D-975), [D-987](../ledger/editor.md#D-987)) are "too random". Most candidates are useless, often because a coarse pitch change takes the sound out of tune. This record has four parts:

1. what other instruments, editors and research do (every claim links the source it was read from);
2. an audit of the parameters Mutate moves today, and a simulation of Make candidates on the factory patches;
3. how far the factory presets spread each parameter;
4. a proposal, its smallest first step, and proposed amendment text for [D-975](../ledger/editor.md#D-975) and [D-987](../ledger/editor.md#D-987).

The ledger is not edited here.

## Summary

- **Every candidate goes out of tune today.** With nothing selected, Make candidates moves every parameter of every module, the ones hidden inside assemblies too: a median of 269 parameters per candidate on the factory patches. On all 21 factory patches, 100 % of candidates at the default 10 % move at least one pitch parameter. 78 % of the semitone moves land on an interval other than an octave, a fourth or a fifth.
- **Products whose variations stay usable do four things.** They hold pitch by default or move it only by musical steps. They move only some parameters per variation. They treat switches and choices differently from knobs. They breed from good parents (the user's survivors or a preset library) instead of adding noise to everything.
- **Proposal.** Hold pitch rows by default, including the value rows whose output reaches a pitch input. With nothing selected, move only the rows the cards show. Move about a quarter of the rows per candidate. Change switches and choices by chance, not by distance. When two or more snapshots are marked keep, breed candidates from them, with pitch rows and switches copied whole from one parent.
- **Smallest first step:** hold pitch rows (a `pitch` flag on 15 parameter definitions, plus the value rows that reach a pitch input). That alone ends the out-of-tune candidates.

## 1. What others do

### Pitch: held by default, or moved only by musical steps

- **Clavia Nord Modular G2 Patch Mutator** (developed with Palle Dahlstedt) has seven "Quick Lock" categories. The first, OscFreq, covers "Semi, Freq, Fact or Partial" parameters, and the manual says it "should often be locked when you evolve keyboard patches, to avoid unwanted transpositions". Fine tune (OscFine, "often called Cent") is a separate category. ([G2 Mutator manual](https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf))
- **The u-he preset randomizer** (a third-party, open-source tool) never changes transpose or fine tune. Its code comment says "Randomizing these would make presets play out of tune". ([types.ts L38-L62](https://github.com/Fannon/u-he-preset-randomizer/blob/cbf5478c696d759ac0e0ae6ce12794cc700070b5/src/synthConfigs/types.ts#L38-L62))
- **Sonic Charge Synplant** limits pitch drift with an Atonality slider: "If you leave it at a low setting, you can be almost certain that your plant will keep its tuning when it grows." ([Synplant 1 manual](https://doczz.net/doc/821484/synplant-user-guide), a mirror of the official PDF.) In Synplant 2, "At settings above 50%, notes also become increasingly and randomly detuned", and "Correct Tuning" repairs the pitch afterwards. ([Synplant 2 manual](https://soniccharge.com/public/Synplant%20User%20Guide.pdf?dl=20240830T095912&inline))
- **Arturia MiniFreak's arpeggiator Mutate** moves notes only by musical intervals, with fixed chances: 75 % stay, 5 % each a fifth up, a fourth down, an octave up, an octave down, and 3 % and 2 % to swap with a following note. Its Spice and Rand Oct change pitch only in whole octaves. ([MiniFreak manual 4.0.1 §14.1.8, §14.2](https://dl.arturia.net/products/minifreak/manual/minifreak_Manual_4_0_1_EN.pdf))
- **Arturia PolyBrute** morphs between a preset's two sounds. Its "Morph Pitch Quantize" setting moves oscillator tuning continuously, in semitones, in octaves, in octaves and fifths, in octaves and fourths, along a major or minor triad, or switches at halfway. Its Octave buttons do not morph at all. ([PolyBrute manual 3.0.1 §10.6, §12.2.1.7](https://dl.arturia.net/products/polybrute/manual/polybrute_Manual_3_0_1_EN.pdf))
- **Ratios are kept harmonic by the parameter's own steps.**
  - On the Elektron Digitone, the carrier's ratio "is limited mostly to integers", while modulators get more inharmonic values. ([Digitone manual OS1.41, A.4](https://www.elektron.se/wp-content/uploads/2024/09/Digitone_User_Manual_ENG_OS1.41_231108.pdf))
  - Korg opsix splits operator pitch into COARSE (whole-number ratios, octaves below 1), FINE, TRANS (semitones) and DETUNE (cents). ([opsix manual p.50-51](https://cdn.korg.com/us/support/download/files/dc109944c32fd473b555fee28318cf8d.pdf))
  - Dahlstedt's MutaSynth uses a "Partial Quantizer" so that FM ratios "are always integer multiples or fractions of the fundamental". ([Dahlstedt 2001](https://www.dmu.ac.uk/documents/technology-documents/research/mtirc/nowalls/mww-dahlstedt.pdf))
  - The Synthmata DX7 / Volca FM randomizer keeps a carrier's coarse ratio at 0.5, 1 or 2. At its "atonality" setting 0, every modulator stays a whole-number ratio with no detune. ([volcaFmRandomizer.js](https://github.com/synthmata/synthmata.github.io/blob/60401f1d/script/volcaFmRandomizer.js))
- **Note randomizers snap to semitones or a scale.** Bitwig's Randomize note effect can quantize pitch to semitones, or to scale steps with the global key on. ([Bitwig 5.3 user guide §19.17.17](https://www.bitwig.com/media/bitwig_userguide/pdf/Bitwig_Studio_User_Guide_English_XfuP7Nz.pdf), [6.0 release notes](https://downloads.bitwig.com/6.0/Release-Notes-6.0.html)) Arturia Pigments' sequencer keeps random notes in the chosen scale and weights each note. ([Pigments manual 7.0.1 §17.1.11](https://dl.arturia.net/products/pigments/manual/pigments_Manual_7_0_1_EN.pdf))
- **The counter-example is VCV Rack.** Its randomize draws each knob uniformly over its whole range, and the Fundamental VCO's frequency knob (−76 to +76 semitones, not snapped) is randomizable. ([ParamQuantity.cpp L155-L170](https://github.com/VCVRack/Rack/blob/061ccf63c1758599396ac1bb10d47345d9d34076/src/engine/ParamQuantity.cpp#L155-L170), [VCO.cpp L690-L699](https://github.com/VCVRack/Rack/blob/ce3326407eb49ba188509b07912d58772b22e284/src/VCO.cpp#L690-L699))

### Parameter classes, and what is excluded by default

- **The G2 keeps a class for every parameter.** Its Quick Locks are OscFreq, OscFine, Envelope, SeqValue, SeqEvent, Delays and Effects, each with a Solo button. Output modules, compressors, MIDI modules, the vocoder, the 6-channel mixer and pitch trackers are excluded by default. Signal-type, mute and bypass switches are never evolved. The same classes drive its Patch Adjustor's Attack, Decay, Sustain, Release, Mod.Rate, Timbre, Resonance and Effects knobs. ([G2 Mutator manual](https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf))
- **Elektron** randomizes one parameter page at a time and never the trig, arpeggiator or note pages. ([Syntakt manual](https://www.elektron.se/wp-content/uploads/2026/10/Syntakt-User-Manual_ENG_OS1.42_260930.pdf), [Analog Four MKII manual, Appendix A](https://www.elektron.se/wp-content/uploads/2026/10/Analog-Four-MKII-User-Manual_ENG_OS1.56_260930.pdf), [Analog Rytm MKII manual](https://www.elektron.se/wp-content/uploads/2026/10/Analog-Rytm-MKII-User-Manual_ENG_OS1.74_260930.pdf))
- **Ableton Live** randomizes a Rack's macros, never the device parameters directly. Macros mapped to Volume are excluded by default, and each macro can be excluded. ([Live 12 manual §25.7.2](https://www.ableton.com/en/manual/instrument-drum-and-effect-racks/)) The macro's Min and Max bound where the target goes; that it bounds randomization is an inference from how macros work, not a statement in the manual.
- **Korg wavestate and modwave** do not randomize every value: "Randomize uses a combination of preset selection and select value randomization, rather than direct randomization of all parameters." Effects on or off is randomized "with probability weighted towards On". ([wavestate manual p.82](https://cdn.korg.com/us/support/download/files/a6b8a755cab87e6ee27e3d4335ef0e2b.pdf), [modwave manual](https://cdn.korg.com/us/support/download/files/20997aa422e3177454cac847c7371468.pdf))
- **Waldorf Iridium** mutates Oscillators, Pitch, Filter, Envelopes, Modulations and Effects as separate sections, each with its own amount slider, so pitch can be left alone. ([Iridium MK2 manual p.169-170](https://downloads.waldorfmusic.com/cloud/index.php/s/JMeXf5LECFMo38H/download))
- **Synplant 1** never grows its reverb size, "because it would cause disruption of the audio". ([Synplant 1 manual](https://doczz.net/doc/821484/synplant-user-guide))
- **VCV Rack** lets a module author turn off randomization per parameter (`randomizeEnabled`). Buttons are off by default, and switches snap to whole values. Fundamental excludes its modulation-depth knobs. ([ParamQuantity.hpp L60-L67](https://github.com/VCVRack/Rack/blob/061ccf63c1758599396ac1bb10d47345d9d34076/include/engine/ParamQuantity.hpp#L60-L67), [Module.hpp L153-L170](https://github.com/VCVRack/Rack/blob/061ccf63c1758599396ac1bb10d47345d9d34076/include/engine/Module.hpp#L153-L170))
- **Switches and choices are handled apart from knobs.** Edisyn (Sean Luke's patch editor) adds noise to a "metric" parameter within a window set by the mutation weight, and re-rolls a "categorical" one with a chance. Its paper warns that treating every parameter as metric leads into "garbage space". ([Luke and Hoyle, ICCC 2023](https://computationalcreativity.net/iccc23/papers/ICCC-2023_paper_119.pdf)) The u-he randomizer switches an enum with chance r. ([randomizer.ts L616-L683](https://github.com/Fannon/u-he-preset-randomizer/blob/cbf5478c696d759ac0e0ae6ce12794cc700070b5/src/randomizer.ts#L616-L683)) Reaktor and PolyBrute never blend switches; they take one parent's setting. ([Reaktor 6 Diving Deeper §5.6](https://www.native-instruments.com/fileadmin/ni_media/downloads/manuals/REAKTOR_6_Diving_Deeper_English_0817.pdf), [PolyBrute manual §10.6](https://dl.arturia.net/products/polybrute/manual/polybrute_Manual_3_0_1_EN.pdf))
- **Curated value distributions.** The G2 gives every parameter a distribution: "an attack time of 45 seconds is seldom wanted", "extreme Oscillator Frequency settings are less probable, and Oscillator Cent parameters tend towards middle values". ([G2 Mutator manual](https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf)) MutaSynth maps genes through exponential, logarithmic and cubic curves "to make the most musically useful values more probable". ([Dahlstedt 2001](https://www.dmu.ac.uk/documents/technology-documents/research/mtirc/nowalls/mww-dahlstedt.pdf)) Synplant's genes "have been extensively tuned to generate useful sounds through random mutations". ([Synplant 2 manual](https://soniccharge.com/public/Synplant%20User%20Guide.pdf?dl=20240830T095912&inline))

### How far a variation moves: how many parameters, and how much each

- **The G2 and MutaSynth have two amounts.** Mutation Probability sets how many parameters change; Mutation Range sets the largest change. The G2 links them "so that a small mutation probability will lead to few but large random parameter changes. A high probability will lead to many, but very small random changes." ([G2 Mutator manual](https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf), [Dahlstedt 2001](https://www.dmu.ac.uk/documents/technology-documents/research/mtirc/nowalls/mww-dahlstedt.pdf))
- **Yee-King's SynthBot** adds Gaussian noise (variance 0.05) to every parameter, so most changes are small and large ones are rare. ([Yee-King and Roth, ICMC 2008](https://web.archive.org/web/2016/http://www.yeeking.net/pdf/roth_yee-king_ICMC2008.pdf)) His DX7 study changes each parameter of a child with a chance of 0.01. It also notes that "a change of 0.1 in one parameter could produce a large change in feature space". ([Yee-King, Fedden and d'Inverno 2018](https://research.gold.ac.uk/id/eprint/22516/1/myk_lf_vsti_programming.pdf))
- **One amount is the commercial norm.** Reaktor moves each control "up to ± R % of the control's range". ([Reaktor 5 Addendum §6.4.6](https://docs.native-instruments.com/pdf-guides/Reaktor_5_Manual_Addendum_English.pdf)) Massive XL has one Divergence knob. ([Massive XL guide](https://docs.native-instruments.com/online-guides/massive-xl-user-guide/en/side-pane.html)) Synplant's only amount is a branch's distance from the seed. ([Synplant 2 manual](https://soniccharge.com/public/Synplant%20User%20Guide.pdf?dl=20240830T095912&inline))
- **No product found has a total distance budget** across all parameters. The nearest are the G2's and MutaSynth's mutation probability, and Edisyn's "apply 1, 2 or 4 mutations" per child. ([Luke and Hoyle, ICCC 2023](https://computationalcreativity.net/iccc23/papers/ICCC-2023_paper_119.pdf))
- **Scope comes first almost everywhere.** Products randomize a page (Elektron), a module (Massive XL, Phase Plant's per-effect dice ([Snapins docs](https://kilohearts.com/docs/snapins))), a section (Iridium, Korg's Scope), or the macros a rack's designer chose (Ableton), not the whole patch.

### Breeding: crossover and interpolation between survivors

- **G2 Cross** copies each value from the mother or the father, switching parent at random points. "During the crossover process, no random changes are made." The manual recommends it for FM: "Since it uses only 'safe' values, there is a good chance that the children will be good." G2 Interpolate blends linearly in six steps, and parameters with few values switch. ([G2 Mutator manual](https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf))
- **MutaSynth** has mating (crossover), insemination (some genes of a second parent copied into the first), and morphing (a random point on the line between two parents). Dahlstedt keeps related parameters next to each other so crossover rarely separates a carrier from its ratio. ([Dahlstedt 2001](https://www.dmu.ac.uk/documents/technology-documents/research/mtirc/nowalls/mww-dahlstedt.pdf))
- **Reaktor "Rnd Merge"** gives each control to parent A or B, then moves it from their average toward that parent by R %. ([Reaktor 5 Addendum §6.4.6](https://docs.native-instruments.com/pdf-guides/Reaktor_5_Manual_Addendum_English.pdf))
- **Edisyn** recombines a metric parameter to a random value between the parents and a categorical one to either parent. Its "Constrictor" stays "in the middle of a cloud of well-vetted patches", where garbage is less likely. ([Luke and Hoyle, ICCC 2023](https://computationalcreativity.net/iccc23/papers/ICCC-2023_paper_119.pdf))
- **Max `pattrstorage`** can switch a parameter at a threshold instead of blending it (`thresh`), which suits stepped and pitch parameters. ([pattrstorage reference](https://docs.cycling74.com/reference/pattrstorage/))
- **A blend breaks pitch.** The u-he randomizer averages parents and rounds whole numbers. A blend of 0 and 12 semitones at 20 % gives 2 semitones; that is an inference from its code ([randomizer.ts L304-L452](https://github.com/Fannon/u-he-preset-randomizer/blob/cbf5478c696d759ac0e0ae6ce12794cc700070b5/src/randomizer.ts#L304-L452)), and the reason PolyBrute quantizes morphed pitch.

### Ranges from presets

- **Mutate toward the library.** Absynth 5 mutates "towards the equivalent parts of other Sounds" in the filtered search list, with a Mutation Amount (how far toward them) and a Randomization Amount (how far off that path). ([Absynth 5 manual §11.3](https://www.native-instruments.com/fileadmin/ni_media/downloads/manuals/Absynth_Manual_English.pdf)) Massive XL's Mutate "integrate[s] settings from other presets in your library". ([Massive XL guide](https://docs.native-instruments.com/online-guides/massive-xl-user-guide/en/side-pane.html)) Serum 2's Hybridize mixes four presets from the visible browser list. ([Serum 2 user guide, Appendix B](https://www.xferrecords.com/manual/serum-2/docs))
- **Draw only values presets use.** The u-he randomizer records every value each parameter takes across the user's presets, and draws new values from that list, weighted by how often each occurs. ([analyzer.ts L84-L107](https://github.com/Fannon/u-he-preset-randomizer/blob/cbf5478c696d759ac0e0ae6ce12794cc700070b5/src/analyzer.ts#L84-L107), [randomizer.ts L557-L599](https://github.com/Fannon/u-he-preset-randomizer/blob/cbf5478c696d759ac0e0ae6ce12794cc700070b5/src/randomizer.ts#L557-L599))
- **Stay inside the presets' hull.** NI FM8 randomizes inside its four-corner morph square, so values stay between the four sounds. ([FM8 manual, mirror](http://crosstalk.arizona.edu/Data/FM8%20Manual%20English.pdf))
- **Learned preset spaces.** Edisyn trains an autoencoder on about 27,000 DX7 patches and mutates in its latent space, so results stay near real patches. ([Luke and Hoyle, ICCC 2023](https://computationalcreativity.net/iccc23/papers/ICCC-2023_paper_119.pdf)) The Flow Synthesizer learns from about 11,000 Diva presets. It kept only continuous parameters and chose the most-used 16, 32 and 64 by preset usage. ([Esling et al. 2019](https://arxiv.org/pdf/1907.00971))
- **Importance ranking.** No surveyed product ranks parameters automatically. Importance is authored (which parameters get macros or cards, author flags, module groups) or comes from preset statistics (Flow Synth).

### Population and user fatigue

- Populations are small: 6 children on the G2, 9 in MutaSynth and Johnson's prototype, 12 Synplant branches, 16 or 32 in Edisyn. ([G2](https://www.nordkeyboards.com/wt/documents/237/Nord%20Modular%20G2%20Mutator%20English%20User%20Manual%20v1.0%20Edition%20A.pdf), [Dahlstedt 2001](https://www.dmu.ac.uk/documents/technology-documents/research/mtirc/nowalls/mww-dahlstedt.pdf), [Johnson 1999](https://kar.kent.ac.uk/21844/1/exploring_the_sound-space_johnson.pdf), [Synplant 2](https://soniccharge.com/public/Synplant%20User%20Guide.pdf?dl=20240830T095912&inline), [Edisyn](https://computationalcreativity.net/iccc23/papers/ICCC-2023_paper_119.pdf))
- Takagi's survey puts "10 or 20" generations as the usual maximum, and finds coarse ratings reduce fatigue. ([Takagi 2001](https://catalog.lib.kyushu-u.ac.jp/opac_download_md/1670053/ProcIEEE_3.pdf)) Matryoshka's 2 to 8 candidates and keep-or-cut marks ([D-987](../ledger/editor.md#D-987), [D-988](../ledger/editor.md#D-988)) already fit this.

### Known failure modes others name

- Silent results: Massive XL's known issues blame "a long attack time or … low send or mix values in the effects". ([NI support FAQ](https://support.native-instruments.com/support/solutions/articles/69000884620-massive-xl-overview-faq)) The G2 manual says randomized patches are "sometimes … completely quiet … because some mixer level was set very low by accident". Synplant offers "Normalize Volume".

### Searched, not found or not verified

- Products searched without finding a patch randomizer: Vital (only a wavetable bar randomizer, [bar_editor.cpp](https://github.com/mtytel/vital/blob/636ca0ef517a4db087a6a08a6a8a5e704e21f836/src/interface/wavetable/editors/bar_editor.cpp#L37-L57)), Phase Plant (per-effect dice only), Surge XT ("Random Patch" loads an existing patch, [SurgeGUIEditor.cpp](https://github.com/surge-synthesizer/surge/blob/9655b525d753544ef829970f56ceb2248dcc1b18/src/surge-xt/gui/SurgeGUIEditor.cpp#L6442-L6445)), Dexed (only a `// TODO: pitch randomization` stub in `Source/msfa/dx7note.cc`, [repository](https://github.com/asb2m10/dexed)), the minilogue xd, and the u-he manuals. Bitwig documents no per-parameter randomize with amounts in the 5.3 guide or the 6.x release notes.
- Not verified: McCormack's "Open problems" body and Dahlstedt's 2007 chapter (only abstracts read), Yee-King's 2011 thesis, a Ctrlr DX7 randomizer, whether opsix's randomize skips FINE and DETUNE, and whether FM8 rounds morphed ratios.

## 2. Audit: what Mutate moves today

`web/src/mutate.ts` moves every parameter of a module card, and the shown rows of an assembly card, by up to ± the amount of its range (octaves for a logarithmic one). With nothing selected, Make candidates passes every module of the patch (`editor.ts` `makeCandidates`: `parent.modules.map((m) => m.id)`), so the modules inside assemblies move too.

The parameter definitions in `web/src/modules.ts` hold 288 parameters. Mutate never moves 42 of them (the modules in `MUTATE_SKIP`, [D-977](../ledger/editor.md#D-977)) nor the Delay's length (`fixed`). That leaves 245, classified here by what a move does to the sound:

| class | parameters | what is in it |
|---|---|---|
| pitch | 15 | `osc`, `wavetable`, `pd` coarse and fine; `string`, `comb`, `modal` coarse; `grain.pitch`; `esp.cvadj`; `ratio.ratio`, `ratio.detune`; `shift.shift`, `shift.cvamt` |
| value (pitch when it reaches a pitch input) | 42 | `const.value`; `scale.gain`, `scale.offset`; `math.ka`, `kb`, `off`; `select.v1`-`v8`; `seq.s1`-`s8`; `range` in and out ends; `matrix` 16 amounts |
| level | 22 | every `level`, the Mixer's inputs, the VCA's and the Dynamics' gain ([D-977](../ledger/editor.md#D-977)), and the wet mixes (`delay`, `reverb`, `chorus`, `phaser`, `grain`, `comb`, `shift` mix, `xfade.mix`) |
| time | 38 | envelope rates and times, glide, LFO and chorus and phaser rates, delay time, reverb pre-delay, decays, grain size and density, the rate envelope's rates |
| timbre | 77 | cutoffs, resonances, drives, phase modulation amounts, pulse width, wavetable position, envelope levels, depths, `osc.detune` (unison spread), `filter.cvamt` |
| switch or choice | 51 | toggles, choice lists, and small whole-number rows (`osc.wave`, `osc.unison`, `osc.stack`, `lfo.div`, `filter.track`, `shape.stages`, `select.pos` …) |

A pitch signal is in octaves (`modules.ts`: "the input in octaves like every pitch signal"), so a value row that reaches a pitch input is a pitch row in disguise. On the factory patches, 225 modules of the value types, in 19 of the 21 patches, feed a pitch input: directly, through other value modules, Mixers, Glides or Quantizers, or through a parameter input mapped to a pitch row.

### The worst offenders for going out of tune, at the default 10 %

| parameter | range | a 10 % move |
|---|---|---|
| `osc.coarse`, `wavetable.coarse`, `pd.coarse` | −48 … 48 semitones | up to ±9.6 semitones, on whole semitones |
| `const.value`, `scale.offset`, `math.off`, `select.v1`-`v8` reaching a pitch input | −4 … 4 octaves | up to ±0.8 octave, continuous: not even on a semitone |
| `range` out ends reaching a pitch input | −8 … 8 | up to ±1.6 octaves |
| `scale.gain` scaling a pitch or vibrato signal | −4 … 4 | up to ±0.8 times the signal: key tracking or vibrato depth changes |
| `string`, `comb`, `modal` coarse, `grain.pitch` | −24 … 24 semitones | up to ±4.8 semitones |
| `seq.s1`-`s8` reaching a pitch input | −1 … 1 octave | up to ±2.4 semitones, in 0.12-semitone steps |
| `ratio.ratio` | 64 DX100 ratios | up to ±6 places in the table, many of them not whole numbers (1.41, 1.57, 1.73 …) |
| `esp.cvadj` | −12 … 12 semitones | up to ±2.4 semitones, in 0.01-semitone steps |
| `osc.fine`, `wavetable.fine`, `pd.fine` | −100 … 100 cents | up to ±20 cents |
| `shift.shift` | −1000 … 1000 Hz | up to ±200 Hz: inharmonic |

### Switches hardly move

Mutate moves a switch by a share of its range and then rounds it. A toggle (0 or 1) needs a move past half its range to flip, so Mutate never flips one at any amount. A six-way choice at its first position never moves at 5 % or 10 %. Randomize does move them. So at the default amount, Mutate leaves a patch's structure alone and moves every knob.

### Make candidates on the factory patches

Method: `mutatePatch` from `web/src/mutate.ts` on each of the 21 factory patches in `web/presets/`, scope every module (what Make candidates does with nothing selected), 120 candidates each at 10 % and at 25 %, from a seeded random generator. A candidate counts as touching pitch when a pitch row, or a value row that reaches a pitch input, changes. The scripts were run from a scratch directory and are not kept.

At 10 %, across the 21 patches:

- every candidate (100 %) changes at least one pitch row, on every patch;
- a candidate moves 67 to 423 parameters, median 269;
- the median semitone move is 5 semitones (12 at 25 %);
- 78 % of semitone moves (75 % at 25 %) land on an interval other than an octave, a fourth or a fifth.

The cards of the same patches show far fewer rows. A patch's top-level assembly cards and loose module cards show a median of 58 rows, against a median of 367 movable parameters in all its modules. Briefcase 3, with loose module cards, shows 300 of 502. Most of what Make candidates moves is inside assemblies: values the assembly's maker set and did not put on the card, such as a Selector's table or a Scale feeding a pitch.

| patch | movable parameters (all modules) | rows the cards show | pitch rows on the cards |
|---|---|---|---|
| Monolith D | 316 | 54 | 4 |
| Oracle V | 367 | 68 | 2 |
| Silver Box | 134 | 27 | 0 |
| Hera 6 | 313 | 44 | 0 |
| Sallen 20 | 251 | 59 | 3 |
| Expander S | 223 | 54 | 2 |
| Algo Four | 259 | 56 | 8 |
| Canvas | 505 | 73 | 1 |
| Wanderer | 469 | 75 | 0 |
| Briefcase 3 | 502 | 300 | 0 |
| Io 4 | 402 | 58 | 0 |
| Vernon 100 | 352 | 62 | 0 |
| 8 Lire | 583 | 70 | 16 |
| Elvira 2 | 135 | 45 | 8 |
| Scrounge | 439 | 58 | 4 |
| Meridian 8 | 587 | 67 | 7 |
| 808 Kit | 593 | 28 | 0 |
| 909 Kit | 613 | 30 | 5 |
| Cassia 1 | 340 | 161 | 2 |
| Verona Drum 1 | 514 | 75 | 4 |
| Shush 101 | 245 | 50 | 1 |

[D-987](../ledger/editor.md#D-987) says Make candidates acts "with none selected, on every card". The code moves every module, also those inside an assembly. Whether a module inside an assembly counts as a card is a question for the decider (see "Questions for the decider" below).

## 3. How the factory presets spread each parameter

Method: the preset card files in `web/presets/cards/` read with the editor's own parser (`cardOf` in `factory-presets.ts`). That gives 33 engines and effects, 1,206 movable card rows, and 4 to 14 presets per card (6 for most), Init included. A row's spread is the distance between its lowest and highest preset value, as a share of its range (octaves for a logarithmic row).

| class | card rows | rows no preset changes | median spread of the rows that change |
|---|---|---|---|
| pitch | 82 | 15 % | 0.18 |
| value | 176 | 48 % | 0.12 |
| level | 171 | 22 % | 0.32 |
| time | 255 | 19 % | 0.25 |
| timbre | 270 | 28 % | 0.41 |
| switch or choice | 252 | 48 % | 0.14 |

What this says:

- **Presets are too few to give each row its own range.** Six values per row is a thin sample, and only 101 of the 245 movable parameter kinds vary in any card. A range drawn from them would lock most rows to the few values a designer picked.
- **Presets are a good pool to draw from.** Every card's presets share its rows, so a preset's value for a row is always a value that worked in that engine. That is what Absynth, Massive XL, Serum and the u-he randomizer use.
- **Designers move timbre widely and leave value rows alone.** Timbre rows spread a median 0.41 of their range. Half the value rows never change across a card's presets.
- **Designers do move coarse pitch, but on purpose.** Of the coarse-pitch preset values that differ from Init, 113 are intervals other than octaves, fourths and fifths, 49 are fourths or fifths, and 19 are octaves. They are chord voicings (8 Lire's eight voices), drum tunings (the Drum Kit's kick), and deliberate detunings (Perun 4). A designer picks the interval while listening; a random move cannot. Drum voices are the exception where a free pitch move is musical (see the open questions).

## 4. Proposal

### What Mutate and Make candidates should do by default

1. **Hold pitch.** Mutate, Randomize and Make candidates leave pitch rows alone unless the user turns on "Mutate pitch" in the command palette (the browser remembers it, as it does the amount). A pitch row is:
   - a parameter marked `pitch` in its definition: the 15 in the audit's pitch class;
   - a value row (Offset, Scale, Math, Selector values, Sequencer steps, Range, Matrix) whose module's output reaches a pitch input, or a parameter input mapped to a pitch row, through cables and through other value modules.

   This is the G2's OscFreq and OscFine Quick Locks, made the default for keyboard patches as its manual advises.
2. **With "Mutate pitch" on, move pitch only by musical steps.**
   - A semitone row moves by a whole octave, a fifth up or a fourth down, chosen the way MiniFreak's Mutate does (most rows stay; the rest split between ±12, +7 and −5).
   - A Ratio's ratio moves only between whole-number ratios and 0.5.
   - A cents row moves by up to the amount × 10 cents.
   - A value row reaching a pitch input moves by whole twelfths of an octave.
   - The Frequency shifter's shift stays held.
3. **With nothing selected, move the rows the cards show.** That is every parameter of a loose module card and the rows of each top-level assembly card, as [D-975](../ledger/editor.md#D-975) already rules for an assembly card. The modules inside an assembly move only when their own card is selected. On the factory patches this means a median of 58 rows instead of 367 parameters. Ableton's macros and the G2's default exclusions follow the same idea: what the designer exposes is what is safe to move.
4. **Move some rows, not all.** Each eligible row moves with a chance of one in four, and at least two rows move. This is the G2's and MutaSynth's mutation probability. The amount keeps its meaning: how far a row that moves may go.
5. **Change switches and choices by chance, not by distance.** A toggle flips, or a choice takes another of its values, with a chance equal to the amount (10 % → one in ten), as Edisyn and the u-he randomizer treat categorical parameters.
6. **Keep the classes' own rules.** Levels never go above the larger of their value and default ([D-977](../ledger/editor.md#D-977)). Times and logarithmic rows move in octaves ([D-975](../ledger/editor.md#D-975)). Timbre rows move as now.
7. **Breed from survivors.** When two or more snapshots are marked keep, Make candidates makes each candidate from them, not from the snapshot on screen:
   - each card's rows come from one keep, chosen at random per card, so related rows stay together (Dahlstedt's adjacency rule, G2 Cross);
   - then a Mutate at half the amount moves some rows;
   - pitch rows and switches are always copied from one parent, never blended (Reaktor, PolyBrute, Max `thresh`);
   - a row whose module is not in every keep comes from the snapshot on screen.

   With one keep or none, Make candidates mutates the snapshot on screen as now.
8. **Later: draw from the engine's presets.** For an assembly card with factory presets, a row that moves may instead take the value of a random preset of the same engine, with a chance (Absynth, Massive XL, the u-he randomizer). Pitch rows stay held unless "Mutate pitch" is on. This needs no new data: the 33 cards already exist.

Not proposed: ranges learned from presets (too few presets per row, section 3), a learned model (the corpus is 33 cards, not thousands of patches), and automatic loudness repair (the level rule of [D-977](../ledger/editor.md#D-977) already stops loud results; quiet ones are judged by ear and cut).

### Smallest first step

Hold pitch rows by default (item 1), with no palette toggle yet:

- add `pitch?: true` to `ParamDef` (`web/src/patch.ts`) and set it on the 15 pitch parameters in `web/src/modules.ts`, the way VCV Rack's module authors set `randomizeEnabled`;
- in `mutatePatch`, skip a row whose definition has `pitch`, and a value row whose module's output reaches a pitch input (a walk over `patch.cables`);
- a test in `web/src/mutate.test.ts`: a Mutate at 50 % and a Randomize of every factory patch leaves every pitch row as it was.

On the factory patches this makes every candidate keep its tuning. It changes no format: the flag is editor-only, and the FM-1 never sees it. Items 3 to 5 come next, and they are as small: a scope change in `makeCandidates`, a chance per row, and a branch for switches. Item 7 needs [D-987](../ledger/editor.md#D-987) amended, below.

### Proposed ledger amendments

The decider for both rows is michael glaviano. These are proposals; the ledger is not edited in this pull request.

**[D-975](../ledger/editor.md#D-975)**, appended to the Decision cell:

> **Amended YYYY-MM-DD (michael glaviano):** Mutate and Randomize leave pitch rows alone. A pitch row is a coarse or fine tune, a Ratio's ratio or detune, or a Frequency shifter's shift (parameters marked `pitch` in `modules.ts`). A value row whose output reaches a pitch input is a pitch row too: an Offset, Scale, Math, Selector value, Sequencer step, Range or Matrix row. "Mutate pitch" in the command palette lets pitch rows move, except the Frequency shifter's. The browser remembers the choice (`matryoshka.mutate-pitch`). With it on, a semitone row moves only by an octave, a fifth up or a fourth down. A Ratio moves only between whole-number ratios and 0.5. A fine tune moves by up to the amount times 10 cents. A value row moves by whole semitones. Mutate moves each row with a chance of one in four, and at least two rows. A switch or a choice changes with a chance equal to the amount, to another of its values.

**[D-987](../ledger/editor.md#D-987)**, replacing its last two sentences ("Candidates come from one parent at a time …"):

> With none selected, candidates move the rows the cards show: every parameter of a module card, and the rows of each assembly card. The modules inside an assembly move only when their own card is selected. When two or more snapshots are marked keep, each candidate is bred from them: each card's rows come from one keep, chosen at random per card, then a Mutate at half the amount moves some of them. Pitch rows and switches are always copied from one keep, never blended. A row whose module is not in every keep comes from the snapshot on screen. With fewer than two keeps, each candidate is a Mutate of the snapshot on screen.

## Questions for the decider

These are open; they are listed on issue #1006, not decided here.

- Does a module inside an assembly count as a "card" for Make candidates with nothing selected? The code says yes; the wording of [D-987](../ledger/editor.md#D-987) can be read either way. The proposal says no.
- Should drum voices be an exception? In a drum engine, a voice's tune is a timbre: the factory cards move kick and cowbell tunes freely. A rule could be that a pitch row whose oscillator plays no keyboard pitch (its pitch input does not reach Main's or a Voice allocator's pitch) is timbre. The first step holds them all.
- One "Mutate pitch" switch, or a lock class per kind (pitch, fine tune, envelopes, effects, as the G2's Quick Locks)?
- Is one in four right for the default chance, or should the chance follow the amount, as the G2 links them?
