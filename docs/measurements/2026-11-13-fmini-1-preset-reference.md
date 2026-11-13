# Fmini-1 preset reference and Monolith D curation

## Scope and evidence

This is a source-based design reference for the refreshed FM-1 audition bank. The reference is **Ruppert's Fmini-1**, not another project named mini-1. The official product spelling is FMini-1. Its [official site](https://ruppert.github.io/fmini-1/) links the synth, editor and browser emulator. This work read source and documentation; it did not install or execute the reference firmware, record either instrument, or establish listening approval.

Reference source is pinned to [`74375d3311889d8e28e6b2601d30f0df4faf70ab`](https://github.com/ruppert/fmini-1/commit/74375d3311889d8e28e6b2601d30f0df4faf70ab), whose commit date is 2026-11-12. The pinned site's English feature descriptions are in [`docs/index.html`](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/docs/index.html#L1309-L1347). They describe three oscillators, a four-pole ladder, two contours, mono/12-voice modes, per-preset effects, an arpeggiator and a sequencer. Those are the author's feature claims, not measurements of our Monolith D.

The authoritative factory bank is [`tools/fmini_bank.py`](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/fmini_bank.py). Read its final `build()` result: the role recipes are followed by `preset_moves()`, which changes settings, replaces sounds and moves names. [`tools/gen_fmini_presets.py`](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/gen_fmini_presets.py) encodes that result into the checked-in [`eng_fmini_presets.h`](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/firmware/src/eng_fmini_presets.h). These source files carry `GPL-3.0-only`; the [pinned README](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/README.md) credits Guilherme Ruppert and Felucca. Our card additions are original settings, not copied preset arrays, recordings or engine code.

## What the final reference bank teaches

Here, a role means a musical job such as a short bass note, a sustained lead or an organ registration. The useful benchmark is that several synthesis choices reinforce that job. It is not a claim that every reference sound is good, or that matching a recipe makes two engines sound alike.

The following observations come from the [role recipes](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/fmini_bank.py#L61-L354), interpreted with the [final changes and build order](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/fmini_bank.py#L780-L975).

| Final reference sound | Concrete design choice | Transferable design lesson, not a translated patch |
| --- | --- | --- |
| FIFTHS, slot 013 | An 8-foot root, a 4-foot oscillator lowered roughly five semitones, and a quieter root reinforcement. The encoded upper interval is about 705 cents because this recipe passes through the generator's 11-cent rounding. | Choose a harmonic interval and subordinate its mixer level instead of treating every oscillator as unison thickening. |
| CHAMELEON, slot 031 | Square-based bass with a short filter decay and zero filter sustain; loudness retains a small body. | A bass transient and its held body need not have the same duration. Distinguish this from a continuously open bass. |
| SUB BASS, slot 032 | Triangles at 32 and 16 feet, low emphasis, no filter keyboard tracking and no chorus/delay/reverb sends. Drive remains part of this reference sound. | A low register and restricted harmonic content are separate decisions from simply lowering cutoff. Do not call this example completely effect-free. |
| OBOE, slot 024 | Pulse/square sources, a small upper component, moderate emphasis and attack times slower than the hard leads. | A reed role needs source spectrum and articulation, not just a brighter lead. This is a synthesis role, not an acoustic-instrument accuracy claim. |
| MARIMBA, slot 061 | A dominant 8-foot triangle and much quieter 2-foot triangle; filter decays before loudness, both with zero sustain. | A sparse two-octave overtone plus separate timbre/loudness decays can give a struck role without three loud saws. |
| PIPE ORGAN, slot 071 | A 16/8/4-foot stack, no filter contour amount, full loudness sustain and a short independent release. Reverb is substantial. | Registration and gate-shaped articulation establish a different core from brass, even before space is added. |
| CALM SEA, slot 099 | White noise alone, no keyboard tracking, low emphasis, a slow LFO opening the filter, slow loudness edges, chorus and dark reverb. | Noise can be the primary sound, with movement specified by a time scale and modulation destination rather than by a generic FX wash. |

Important final-bank corrections:

- ROTARY ORG appears in the initial showcase recipe but is overwritten. It is not a retained factory example at this pin.
- Final MINI LEAD has oscillator 2 moved down to 16 feet and filter sustain set to 100/127. Its original `showcase()` call is not its final sound.
- `preset_moves()` clears MOD OSC on **every** factory patch, including recipes initially written with `mosc=True`. This does not remove wheel vibrato. The [reference engine](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/firmware/src/eng_fmini.c#L437-L476) applies its dedicated LFO to pitch through the wheel independently of that switch.
- Some final names retain another recipe's sound after a swap. A named recipe alone is insufficient evidence about a final slot.

### Performance and dry identity

The [reference generator](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/gen_fmini_presets.py) stores dedicated LFO rate, waveform, fade and sync; pitch/tremolo/pitch-envelope routes; glide; arpeggiator settings; and four effect sends. Those choices allow a held note and a repeated phrase to have different musical uses. They are not all available on a stock Monolith card.

The reference does **not** follow an all-dry policy. Leads often include drive and delay, organ/pad roles can have strong chorus or reverb, and CALM SEA includes space as part of its presentation. For our curation, the design criterion is narrower: oscillator balance and articulation should still identify the role with the added rack off. Compare dry and wet versions rather than crediting a long tail or greater loudness to the core engine. This is an audition criterion, not a reported listening result.

The reference's [`preset_lab.py`](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/preset_lab.py) also uses role-specific probes: bass notes, overlapping lead notes, polyphonic chords and longer atmosphere holds. It measures attack, decay, release, spectrum, width, tails, clipping and nearest feature pairs. Its loudness metric is the loudest 300 ms weighted with half an A-weighting curve; its default calibration target is -21 dB with category offsets and a -3 dBFS peak constraint. These are not BS.1770 integrated LUFS, and the numerical target must not be imported as if it were our loudness rule. Feature distance flags possible duplicates; it is not a quality score or proof that two sounds are interchangeable.

## What stock Monolith D can and cannot reproduce

The local source of truth is the [Monolith assembly generator](../../web/scripts/gen-assemblies.ts#L1079-L1257), the [oscillator implementation](../../web/src/modules.ts#L164-L239), and the [ladder implementation](../../web/src/modules.ts#L1080-L1138). The [parity issue](https://github.com/glvno/matryoshka/issues/375) separately records the hardware audio-input gap. The frozen factory patch routes Main's mod wheel to the assembly and bend to its bend input in [`web/factory/bank.json`](../../web/factory/bank.json).

| Area | Fmini-1 at the pin | Stock Monolith D card |
| --- | --- | --- |
| Voice/articulation | Mono and 12-voice modes are documented. | One voice, lowest-note priority, single trigger. Overlapping notes do not articulate like separate polyphonic voices. No voice-mode change is made here. |
| Oscillators | Six original panel waves, plus sine in the current engine; independent oscillator 2/3 offsets and random pitch drift. | Original six panel waves; oscillator 3 substitutes reverse saw for triangle/saw. Analog waveform shaping is enabled. Its per-instance waveform tolerances are not the reference's random pitch drift. No sine selection, sync or continuous pulse-width control is exposed by this card. |
| Intervals | `o(..., cents)` is encoded through `det()`, ordinarily rounding to 11-cent steps in the generator; later explicit overrides can use exact cents. | Oscillator 2/3 coarse rows are -48..48 semitones, plus fine rows -100..100 cents. A +7-semitone setting is our own interval choice, not a byte conversion. |
| Mixer | Reference oscillator/noise level bytes use a squared curve, then a softly overloaded sum. | Exposed oscillator/noise gains are linear 0..1 coefficients into the ladder. Do not equate a reference mixer byte fraction with the same Monolith coefficient. |
| Filter cutoff | The generator's `cut(f, kbd)` treats `f` as the -3 dB corner at MIDI 60 with tracking included, compensating for the reference's MIDI 41 keyboard zero. The reference also models a feedback lag pole. | The cutoff row is 20..16000 Hz; the generator's ladder has stage saturation, but not that additional reference lag state. Keyboard and contour signals then multiply its effective cutoff. The same displayed Hz value is not evidence of matching response. |
| Emphasis and contour | Emphasis uses a nonlinear 0..10 dial law. Contour encodes roughly 0..5 octaves. | Emphasis is 0..1, internally feedback gain `4 * res`; contour is a signed -4..4 gain into a one-octave-per-unit cutoff input. Inverted contours are available. No emphasis-number conversion is claimed. |
| Keyboard tracking | Continuous byte 0..127, from off to full. | OFF, 1, 2, 1+2: off, approximately one third, two thirds or full. These are named switch positions, not equal numerical ranges. |
| Envelopes | Generator time law is `12000 ** (byte / 127)` milliseconds: 1 ms..12 s. Loudness has an independent release; the filter release follows its decay. | Attack is directly 0.001..5 seconds. Each decay row is a dimensionless macro `d` with nominal time `0.001 * 5000 ** d` seconds, not seconds or a reference byte fraction. DECAY ON ties both releases to their own decay; OFF makes release minimal. |
| Modulation | Dedicated LFO/noise blend; stored LFO fade/sync, pitch-envelope and tremolo routes. Wheel vibrato uses the dedicated LFO independently of MOD OSC. | Oscillator 3/noise blend, taken **before** their audio mixer levels, gated by the wheel. Oscillator 3 can leave keyboard control and serve as a fixed low-frequency or audio-rate source. Switches route the blend to oscillator 1/2 pitch and/or filter. No separate LFO, fade, sync, tremolo, modulation-depth row or pitch-envelope route is exposed. |
| Noise | White/pink source; engine pink noise uses a multi-state filter. | WHITE/PINK switch; its pink setting colors the noise with a one-pole low-pass. The labels do not imply identical spectra. Noise may be audible, a modulation source, or both. |
| Effects and input | Per-preset drive, chorus, delay and reverb are documented. | No effects or external audio input in the core assembly. The final audition wrapper's added rack starts off and is not encoded in this card. |

These differences are reasons to design with Monolith's own controls. They are not a proposal to change its original sound model or claim reference parity beyond the existing panel behavior.

## Retained Monolith card

[`monolith-d.txt`](../../web/presets/cards/monolith-d.txt) has **13 named sounds plus Init**. All seven existing sound designs remain: Fat Bass, Glide Lead, Square Lead, Pink Wind, Soft Flute, Muted Horn and Rhea Plucked Bass. Their post-processing level rows are recalibrated separately. Rhea Plucked Bass keeps its Tom Rhea sound-chart attribution; it is not relabeled as Fmini-derived. The six additions fill different jobs rather than creating Bright/Dark copies.

The table gives design intent and proposed audition gestures, not a claim that the settings were heard or approved. MIDI note numbers avoid octave-label differences between applications. An 8-foot oscillator plays at the engine's reference register; 16/32 feet lower it by one/two octaves, while 4/2 feet raise it by one/two octaves.

| Addition | Original Monolith design | Starting gesture / variation |
| --- | --- | --- |
| Pocket Pulse | One 16-foot narrow rectangle with a quiet 32-foot triangle. Zero sustain in both contours, roughly 214 ms filter decay versus 389 ms amplitude decay, release switch off. This separates a detached pulse bass from the sustained, detuned Fat Bass and single-source Rhea pluck. | Detached MIDI 48..67. Compare held versus short gates; the macro decay is not the note-off tail when DECAY is off. |
| Fifth Signal | 8-foot saw root, quieter wide rectangle seven semitones above it, faint 4-foot triangle; restrained resonance, 110 ms glide and sustained body. | MIDI 48..72; overlap notes to inspect glide and single-trigger phrasing, then detach them to retrigger the contours. |
| Copper Pluck | Dominant 8-foot triangle and quiet 2-foot triangle. About 166 ms filter decay before 546 ms loudness decay, zero sustain and minimal note-off release. | MIDI 60..84; compare short taps with a held key. Its sparse overtone structure, register and gate behavior differ from Rhea's bass pluck. |
| Hollow Reed | Narrow pulse, a restrained unison triangle and a trace of pink noise. A 45 ms filter opening follows the start of a 25 ms amplitude attack; no detuned saw stack. | MIDI 55..79 with separate breath-length gates. Explore cutoff about 700..1600 Hz; the noise is intentional, not a test artifact. |
| Register Organ | Straight 16/8/4-foot stack with triangle/square/triangle, zero deliberate detune, no filter contour, full sustain and minimal release. A monophonic registration, not a polyphonic/rotary organ emulation. | MIDI 60..84. Change oscillator 3 mix around 0.08..0.25 to vary the upper registration without adding chorus. |
| Wheel Furnace | Root/fifth body plus quiet pink noise, an inverted filter contour, and oscillator 3 removed from keyboard control and audio mix. Its LO range and -12-semitone offset give nominally about 2 Hz, blended with 18% colored noise for **filter-only** wheel modulation. | Hold MIDI 48..72 and sweep wheel from zero to full; vary mod mix around 0..0.35. At wheel zero the negative contour still changes timbre. Oscillator 3's zero audio level does not disable its modulation. |

The additions use the existing `output / volume` loudness mechanism. Integration calibrates named levels against the selected graph while holding the default Output and Init fixed; no engine controls, ranges, routing or effects are added. Pocket Pulse receives an additional measured transient-headroom reduction. This card does not change production defaults or grant listening approval.

## Parser, rendering and handoff constraints

The [card parser](../../web/src/preset-cards.ts#L99-L211) starts each sound from Init, not from the previous sound. It accepts named selector positions, checks units and ranges, snaps numerical values to each row's step, and rejects the entire card on an error. Duplicate envelope labels require `contours / attack (1)` and `(2)` (and likewise decay/sustain). Screen rows are not values. An invalid card can otherwise fall back to rule-made presets through [factory registration](../../web/src/factory-presets.ts#L20-L32), so the parent integration check must inspect parser errors rather than assume a nonempty preset list proves acceptance.

The [loudness mechanism](../../web/src/levels.ts) assigns Monolith's `output / volume` after its nonlinear processing. Its rule uses BS.1770 integrated loudness near −18 LUFS for one held key, chord ceiling −15 LUFS and peak cap 0.88, subject to available gain and crest factor. Integration runs the existing named-preset level planner on the exact selected Monolith graph rather than copying Fmini's numerical levels.

The [audition renderer](../../web/scripts/audition-render.ts) plays a fixed 16-second diagnostic phrase with MIDI 36, 60 and 84, repeated notes, varied velocities and a chord. It attenuates Output sixteen-fold before the final clamp and restores it in the float WAV to expose hidden peaks. [`preset-auditions.ts`](../../web/scripts/preset-auditions.ts) records raw renders and constant-gain matched copies targeted at -23 LUFS with a 0.88 peak limit. Matching does not rewrite the sound. These are browser Engine renders, not hardware recordings.

The standard phrase does not move the wheel or overlap a lead line. Integration therefore renders every Monolith sound a second time with a held-note wheel sweep, ordinary/accent velocity changes and overlapping notes. The gallery distinguishes `standard` from `performance`; both retain raw diagnostic audio and constant-gain matched copies, with frequency/time plots. No knob-sweep, FM-1 audio recording or owner listening is claimed.

The selected-bank integration explicitly checks the card parser, exports the retained sounds, and renders their actual selected-profile graphs. Source hashes and coverage belong to the generated audition manifest. Production/default cutover and versioned release qualification remain gated on owner listening.
