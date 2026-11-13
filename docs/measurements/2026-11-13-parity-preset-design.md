# Hardware-parity preset design — 2026-11-13

## Scope and evidence

The initial dry-card pass below retained all 28 existing sounds on five parity-engine cards and added twelve distinct playing roles; Monolith was curated separately. The current FX-authored pass preserves those synth designs and adds complete rack recall plus nine lo-fi synth designs. Factory module topology, voice caps, protected instrument parameters and production bank defaults remain unchanged.

The descriptions below are **design intentions inferred from the control circuits**, not listening approval. Registers are proposed incoming MIDI note ranges, not measured limits. Integration checks all six curated cards, calibrates named levels on the selected bank graphs while holding bank defaults fixed, and renders every retained selected-bank sound. Every sound on these five cards and Monolith has separate standard/performance clips, raw diagnostic audio, constant-gain matched audio and spectrograms. Measured transient peaks require additional reductions to Acid Scream, Keyed Color and Monolith's Pocket Pulse; the Expander Highpass Pluck level is also corrected. These checks do not claim recorded FM-1 audio or owner listening.

The initial audio package auditioned these core sounds with added effects bypassed. That did not fulfill the owner's FX-preset goal and is historical dry evidence only. The replacement uses `factory-fx-recipes.ts` and `factory-lofi-presets.ts` to author each sound's rack; FXP1 restores synth values, all promoted FX controls and enabled stages together. Dry Init and deliberately dry bass/contrast sounds remain dry. Intrinsic effects remain part of the synth card.

## Fmini-1 benchmark: actual final presets

The reference is [ruppert/fmini-1](https://github.com/ruppert/fmini-1), not mini-1. Sources are pinned to commit `74375d3311889d8e28e6b2601d30f0df4faf70ab`:

- [Hand-designed bank recipes and final `preset_moves()`](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/fmini_bank.py).
- [Generator, units and mixer-level curve](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/tools/gen_fmini_presets.py).
- [Generated preset data](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/firmware/src/eng_fmini_presets.h).
- [GPL-3.0-only licensing](https://github.com/ruppert/fmini-1/blob/74375d3311889d8e28e6b2601d30f0df4faf70ab/LICENSING.md). Its bank source also carries the GPL-3.0-only identifier.

The source's `build(Bank())` was evaluated in a temporary directory after loading its generator, filter laws and level data. It produced 200 final records. This matters: `preset_moves()` changes the recipes after their declarations. For example, final MINI LEAD is mono, its oscillator ranges are 8'/16'/16', and its filter sustain is 100/127. Final LUSH STRINGS is slot 007, with zero filter contour amount and amplifier sustain 127/127. Final CS-80 BRASS retains a slower filter attack than amplifier attack, but the oscillator-modulation switch is cleared. The final pass clears that switch across the bank. Recipe names alone are therefore not evidence of final modulation behavior.

Useful final examples:

| Final Fmini preset | Concrete distinction used as a quality benchmark |
| --- | --- |
| MINI LEAD, 000 | Mono articulation, octave-weighted oscillator blend and a sustained contour make a lead role, rather than just an open filter. |
| PLUCK ARP, 002 | Filter sustain 10/127 and amplifier sustain 25/127 separate the initial brightness from the remaining note body. |
| SINE SOLO, 004 | One enabled triangle oscillator, no filter contour, and glide establish a sparse contrasting solo role. Its name does not make its waveform a sine. |
| CS-80 BRASS, 006 | Separate filter and amplifier attack times create a swell in brightness after amplitude has begun. |
| LUSH STRINGS, 007; SOLINA, 040 | Sustained amplitude, low emphasis and deliberate ensemble treatment distinguish accompaniment from percussive keys. Their chorus settings are not copied here. |
| CHAMELEON, 031; SEQ BASS, 035 | Short low-register contours and reduced sustain establish rhythmic bass roles independently of a pad or lead recipe. |
| VIBES, 074 | Triangle-heavy register choices and zero amplifier sustain establish a struck, decaying role. |
| NORTHERN SKY, 084 | A deliberate fifth and slow contours create a harmonic texture, not an arbitrary brighter pad. |
| CALM SEA, 099; OCEAN, 183 | Oscillators off, noise source, low keyboard dependence and slow shaping create non-pitched roles intentionally. |

These are compositional lessons, not parameter conversion. Fmini's mixer levels use a squared curve. Its cutoff conversion includes keyboard tracking at middle C and a calibrated filter law. Its contour bytes map logarithmically from 1 ms to 12 s. Our different filters, oscillators, control gains and available routes do not accept those numbers as equivalent. No Fmini code, recording or preset parameter array is copied into these cards. No audio-equivalence claim is made.

## Local control basis

The [parity issue](https://github.com/glvno/matryoshka/issues/375) defines the hardware gaps and the engines' existing feature boundaries. The primary local evidence is the implementation, not an assumption that a named model implements every circuit identically:

- [Io 4 builder](../../web/scripts/gen-assemblies.ts#L2841): four voice assignments, independent filter/amplifier contours, stepped pulse width, polarity, trigger sample-and-hold, ensemble and lever routes. [Card](../../web/presets/cards/io-4.txt).
- [Sallen 20 builder](../../web/scripts/gen-assemblies.ts#L1620): high-note-priority mono, resonant high-pass then low-pass, separate envelope generators, ring waveform and the internal External Signal Processor (ESP) routes. [Card](../../web/presets/cards/sallen-20.txt).
- [Silver Box builder](../../web/scripts/gen-assemblies.ts#L1260): one oscillator, diode ladder, filter decay, fixed amplifier envelope, legato slide and velocity-gated accent. [Card](../../web/presets/cards/silver-box.txt).
- [Vernon 100 builder](../../web/scripts/gen-assemblies.ts#L3098): lowest/highest-key duophony, COLOR wavetable positions, four switched filter outputs and two envelopes. Its builder explicitly documents uncertainty about the historical 100's continuous MODE behavior. This pass does not resolve that uncertainty. [Card](../../web/presets/cards/vernon-100.txt).
- [Wanderer builder](../../web/scripts/gen-assemblies.ts#L2405): lowest/highest-key duophony through a shared filter/amplifier, pulse XOR ring modulation, sync, clocked or key-triggered sample-and-hold, and separate AR/ADSR choices. [Card](../../web/presets/cards/wanderer.txt).

VCO means voltage-controlled oscillator, VCF voltage-controlled filter, and VCA voltage-controlled amplifier. EG means envelope generator. PWM means pulse-width modulation. S/H means sample-and-hold. AR is an attack/release contour. ADSR is an attack/decay/sustain/release contour. LP, BP, HP and BR below mean low-pass, band-pass, high-pass and band-reject filter modes.

## Io 4 — ensemble, brass, pulse and keyed contours

Use three- or four-note voicings rather than long release stacks when evaluating the four-voice instrument. There is no new velocity route: “keyed dynamics” here means note length, independent contours, key tracking and assignment, not invented velocity sensitivity.

| Sound | Purpose and proposed performance range | Actual parameter rationale |
| --- | --- | --- |
| Ensemble Pad | Sustained accompaniment. MIDI 48–79, spread chords and deliberate releases. | Saw plus sub, 1.2 kHz LP, low 0.1 resonance, 0.6 s filter and 0.8 s amplifier attacks. Native ensemble and 1.5 s amplifier release provide the sustained role. |
| Arp Pluck | Dry rhythmic pulse. MIDI 48–84, detached sixteenths or a supplied sequence. | Manual 20% pulse plus sub, 900 Hz cutoff, 2.5-octave contour and zero sustain in both envelopes. Filter decay 0.25 s precedes amplifier decay 0.3 s. Trigger rate is 8 Hz, but the card does not turn on an arpeggiator. |
| Unison Lead | Thick gliding melody. MIDI 55–79, one key or overlapping legato. | UNISON I, saw/sub, 0.12 s enabled portamento, 2 kHz filter and high amplifier sustain. Existing automatic vibrato remains absent, preserving its recorded overload precaution. The stored LFO delay is not claimed to produce vibrato at zero modulation. |
| S&H Filter | Rhythmic moving chord or held note. MIDI 48–76, hold for several trigger cycles. | Pulse through a 700 Hz resonant filter, 5 Hz trigger and 1.5 trigger-filter amount. High amplifier sustain lets the cutoff steps remain audible instead of replacing them with repeated plucks. |
| PWM Brass | Articulated brass voicing. MIDI 48–79, short chords and half-second holds. | Pulse width moves between 50% and 20% at 1.5 Hz. Sub and ensemble are off. Filter attack 80 ms is slower than amplifier attack 40 ms, separating brightness rise from amplitude. |
| Compu Piano | Decaying polyphonic key sound. MIDI 48–84, varied gate lengths. | Saw without sub, 3-octave filter envelope, 0.35 s filter decay versus 1.1 s amplifier decay, both zero sustain. Full key follow preserves upper-register articulation. Not a ROM or acoustic-piano match. |
| Compu Bass | Compact low accompaniment. MIDI 48–67 with the 16' range, detached or lightly held. | Square/sub, 350 Hz filter, low resonance, 1.5-octave contour and 0.22 s filter decay. Ensemble off and no unison leave the low register uncluttered. |
| Inverse Keys — added | A dark strike that opens during the held body. MIDI 48–79, compare short taps with one-second holds. | Inverted 2-octave filter contour at 3.6 kHz, instant filter attack, 0.65 s decay and zero filter sustain. Separate 0.9 s amplifier decay to 0.4 sustain makes the opening audible without an endless pad. 70% key follow and 100 Hz HP reduce upper-register glare and low clutter. |

## Sallen 20 — two filters and contrasting envelopes

The ESP Warble is deliberately an unstable color, not a concert-pitch replacement. The ESP has an internal noise source here, not an external recording or new audio-input capability.

| Sound | Purpose and proposed performance range | Actual parameter rationale |
| --- | --- | --- |
| Acid Scream | Aggressive mono phrase. MIDI 43–72, short notes and occasional held peaks. | Saw/square at the same footage, 8-cent separation, 300 Hz LP with 0.93 peak and 3.5-octave EG2 amount. A 0.25 s decay and low sustain provide a transient rather than an open sustained scream. |
| Growl Bass | High-pass-colored bass. MIDI 48–67 with both oscillators at 16'. | Pulse/saw, 150 Hz HP at 0.85 peak with positive EG2 modulation, against 700 Hz LP. Mixer levels retain the earlier headroom reductions; output level is not substituted for controlling filter input. |
| Ring Mod Bell | Inharmonic struck color. MIDI 48–79, isolated notes with space for tails. | Triangle drives the VCO2 ring position at 4' plus 5 semitones and 35 cents. Low direct VCO1 level leaves ring products prominent. Zero sustain, 1.8 s decay and 1.5 s release make a bell-shaped event. |
| Noise Sweep | Unpitched wind/surf transition. Any comfortable key, hold several seconds. | Noise alone, both resonant filters swept by the 0.15 Hz modulation generator. EG2 attack 1.5 s and release 2.5 s frame the texture. Reduced input level preserves the existing headroom decision. |
| ESP Warble | Unstable moving effect with a tonal anchor. MIDI 48–72, hold then change register. | Noise through the ESP's 300–600 Hz input band drives VCO2's frequency-to-voltage route. VCO1 saw remains audible. This is intentionally less pitch-stable than the ordinary mono leads. |
| Soft Reed | Restrained melodic contrast. MIDI 55–84, articulated single-note phrases. | One 25%-width pulse, modest HP/LP resonance, 1.1 kHz LP and only 0.6 EG2 amount. An 80 ms attack avoids copying the scream's transient. |
| Pinch Pluck — added | Dry, narrowing mid-register pluck. MIDI 48–79, detached notes. | Single 35%-width pulse, HP 350 Hz with negative EG2 amount −1.5 and LP 650 Hz with positive amount 2.5. As EG2 decays, HP rises and LP falls. A 0.32 s zero-sustain contour pinches the pass band and amplitude together. |
| Pitch Bloom — added | Soft note with a delayed rise. MIDI 55–79, hold at least 0.6 s. | Triangle plus quiet octave-up saw, low peaks and a broad 1.8 kHz LP. EG1 waits 0.12 s then rises over 0.35 s, adding 0.08 octave (about one semitone) to both oscillators. EG2 opens amplitude in 40 ms and sustains at 0.75. The pitch bloom is intentional, not neutral tuning. |

## Silver Box — one-voice phrasing, accent and decay

All sounds remain monophonic. The oscillator is already one octave below the incoming note. Start at MIDI 48–72 for bass phrases, and extend upward for Short Zap or Long Sweep. Compare ordinary velocity 90 with accent velocity 120. The implementation accents from velocity 115. Alternate isolated accents and runs of consecutive accents. Overlap notes for the existing fixed-time slide; no card invents a slide-speed or amplifier-decay knob. The `decay` row shapes the filter envelope, not the fixed amplifier decay. Releasing a key still cuts the amplifier short.

| Sound | Purpose and playing behavior | Actual parameter rationale |
| --- | --- | --- |
| Acid Squelch | Main resonant saw sequence. Use rests and alternate accents. | 300 Hz cutoff, 0.9 resonance, 3.2 contour, 0.25 s decay and 1.5 accent emphasize quick sweeps and resonance-linked accent accumulation. |
| Rubber Square | Rounded square phrase. Hold some notes beyond the initial sweep. | 200 Hz cutoff, 0.6 resonance, 2 contour and 0.45 s decay leave more body than Acid Squelch. Accent 1 keeps the circuit active without the strongest boost. |
| Deep Sub 303 | Less resonant bass support. Favor MIDI 48–60 and audible note releases. | Saw at 120 Hz, resonance 0.3, contour 1.2 and decay 0.6 s. “Sub” describes the role, not an added oscillator or sine waveform. |
| Short Zap | High, clipped rhythmic punctuation. MIDI 60–84, short gates. | Square, 600 Hz cutoff, 0.85 resonance, 3.8 contour and 0.12 s decay. Accent 2 provides the most forceful accent setting in this card. |
| Long Sweep | Slow filter phrase over held notes or ties. MIDI 48–79. | Saw, 400 Hz cutoff, 0.7 resonance, maximum 4 contour and 1.2 s decay. Accented notes use the circuit's shorter accented envelope, not necessarily the stored 1.2 s normal decay. |
| Dry Square — added | Plain low-mid ostinato. MIDI 48–72, gate-length variation instead of accent punches. | Resonance 0.15, 450 Hz cutoff, small 0.6 contour, 0.18 s normal decay and accent amount 0. Accented input still changes the circuit's envelope timing; zero accent amount is not a new accent-disable feature. |
| Accent Ladder — added | Expose the accent circuit instead of hiding it under a large ordinary contour. MIDI 48–72, consecutive accents followed by unaccented notes. | Saw at 180 Hz, resonance 0.82, only 0.5 normal contour, 0.75 s normal decay and accent 1.8. High resonance lengthens accent-sweep smoothing, so repeated accents can build cutoff independently of ENV MOD. |
| Open Saw — added | Open, non-squelching slide line. MIDI 48–79, emphasize overlap and note duration. | 3.2 kHz cutoff, 0.1 resonance and 0.3 contour expose the waveform and legato transition. Accent 0.35 avoids the strong boost of the acid presets. This is not a polyphonic saw patch. |

## Vernon 100 — COLOR, duophony and all four filter modes

Use one key, then add a second key above it without lifting the first. Oscillator 2 follows the lowest key and oscillator 3 the highest. The shared gate does not promise a new envelope attack on that second press. Release all keys before comparing new attacks. Keep `osc 3/ext` output at zero: that bypass is not envelope-shaped and is not needed to make these sounds usable. COLOR values are positions within the existing wave bank, not PWM. BR is a switched band-reject output, not a newly continuous filter-mode sweep.

| Sound | Purpose and proposed performance range | Actual parameter rationale |
| --- | --- | --- |
| Fat Duo Lead | Weighty two-finger line. MIDI 48–79, fourths/fifths and moving upper notes. | Two 0.75 COLOR saw-like sources with opposite small tuning offsets. Oscillator 4 follows oscillator 3 one octave down. Moderate LP resonance and filter envelope create the lead's body. |
| Wobble Bass | Periodic low-filter motion. MIDI 48–67 with oscillators 2/3 one octave down. | Low oscillator 1 triangle drives the filter through the negative side of its center-zero control. 250 Hz LP and 0.6 resonance establish the moving bass. Short release behavior follows the sustain switch, not a made-up ADSR release row. |
| Stepped Pulse | Periodic stepped two-key pattern. MIDI 48–76, hold across several modulation cycles. | Low oscillator 1 square enters pitch MIX at −0.08 and filter control at −0.45. BP at 600 Hz and resonance 0.7 emphasize each alternation. This is periodic square modulation, explicitly not random S/H. |
| Metal Clang | Struck audio-rate modulation. MIDI 48–79, isolated attacks. | Key-tracked high oscillator 1 square enters oscillator MIX at −1. Oscillators 2/3 use triangle-end COLOR with octave separation. BP and zero-sustain envelopes isolate the clang. Existing output normalization remains intact. |
| Slow Sweep Pad | Slowly moving two-key accompaniment. MIDI 48–76, hold and move the upper note. | Slightly offset COLOR 0.6 sources, low oscillator 4 triangle-side COLOR, negative oscillator-4 filter control and a little pink noise. Long envelope attacks distinguish it from a polyphonic string approximation. |
| Triangle Duo — added | Clear, soft interval playing. MIDI 48–84, hold a bass note while moving the upper voice. | COLOR 0 and 0.05, oscillator 4 absent from the audio mixer, low 0.1 resonance and restrained LP contour. Envelope 2 shapes amplitude at 20 ms attack and 0.8 sustain. The low-partial identity comes from COLOR, not heavy filtering. |
| Notch Loom — added | Animated hollow interval. MIDI 48–79, compare a held dyad with slow upper-note changes. | Contrasting COLOR 0.35/0.95 feeds BR at 700 Hz and resonance 0.45. Envelope 1 moves the notch with a 0.35 s attack and low sustain while envelope 2 keeps amplitude at 0.9 sustain. KB1 filter tracking anchors the lower voice. |
| HP Clav — added | Thin struck accompaniment. MIDI 48–79, detached dyads. | Double-saw-end COLOR 1 against square COLOR 0.5, HP at 900 Hz and resonance 0.35. Envelope 1 shapes amplitude with panel decay 0.62 and zero sustain. The longer envelope 2 drives filter control at 0.3. This contrasts both mode and articulation with Metal Clang's BP/FM route. |

## Wanderer — sync, pulse ring, held samples and duophonic playing

One key controls both oscillators. Two keys send the lowest to VCO1 and highest to VCO2 through one shared filter and amplifier, not two independent synthesizer voices. A key press retriggers the existing envelope circuit; a key release does not. That interaction belongs in the audition, especially for Sync Lead and Ring Bell. The pulse-based XOR ring modulator is not the analog multiplier used by Sallen 20.

| Sound | Purpose and proposed performance range | Actual parameter rationale |
| --- | --- | --- |
| Sync Lead | Swept sync melody. MIDI 55–79, compare one-key phrases with two-key intervals. | VCO2 begins a fifth above VCO1, sync on, ADSR pitch depth 1.5 and dominant VCO2 saw level. The envelope sweeps beyond the starting fifth; it is not merely a fixed fifth bend. |
| S/H Bleeps | Repeating stochastic pattern while a key is held. MIDI 48–79. | Noise sampled at 4 Hz, 10 ms lag, VCO1 pitch amount 0.3 and filter amount 0.5. AR repeat is keyboard-gated. VCO2 is silent, leaving a clear single pitch source under the random modulation. |
| Ring Bell | Metallic struck interval. MIDI 48–79, isolated notes or carefully chosen two-key changes. | Pulse XOR ring dominates the mix. VCO2 is 16 semitones above VCO1 plus 0.025-octave fine offset. A zero-sustain ADSR and 1.2 s decay/release provide the bell shape. |
| Punch Bass | Direct low-register attack. MIDI 48–67, short repeated notes. | Both oscillators down one octave, saw/square blend, 300 Hz LP and moderate 0.45 envelope modulation. ADSR amplitude with 0.3 s decay keeps the core bass role distinct from PWM Lead. |
| PWM Lead | Sustained, mobile melody. MIDI 55–84, single notes and occasional dyads. | Same-register saw and pulse, VCO2 pulse modulation 0.3, 5.5 Hz LFO and 0.04-octave VCO1 vibrato. High ADSR sustain and portamento establish a more continuous role than the struck presets. |
| Two Finger Reed — added | Explicitly played duophonic intervals. MIDI 48–84, hold the low note and articulate an upper line. | Equal coarse/fine tuning across the two VCOs, saw below and 25%-width pulse above, no sync or ring. Low resonance, small filter contour and AR amplitude avoid baking an interval or long decay into the preset. |
| Keyed Color — added | A different held timbre on each new attack, without random pitch. MIDI 48–79, repeat a pitch then change notes. | Noise sampled only on keyboard trigger, output lag 80 ms and filter modulation 0.3. Only VCO1 pulse is in the audio mix. Neither oscillator receives S/H pitch modulation. ADSR decay 0.45 s makes the color change part of a keyed event. |
| Pink Breath — added | Unpitched breath/swell contrast. Any key, hold for one to three seconds. | Both VCO audio levels zero, pink noise at 0.45, HP 650 Hz and LP 2.2 kHz define a band. Slow 0.35 Hz filter movement, 0.25 s AR attack and 0.45 s release shape the texture without effects. |

## Integration hand-off

The card parser includes Init automatically and rejects a whole card if any row is invalid; integration checks parser errors rather than relying on rule-generated fallback sounds. Renders preserve selected voice caps and articulation, now with actual authored FX states. Performance probes add wheel motion, velocity contrasts and overlapping notes. Default-profile CPU matrices do not qualify arbitrary edited sounds; authored settings require separate physical proof. Generated manifests bind measured scope and source hashes. Final audio quality and owner listening approval remain unclaimed.

## Lo-fi palette and musical direction

The owner's references include Nine Inch Nails, Ladytron, LCD Soundsystem, M83, The Postal Service, Boards of Canada, Aphex Twin, Autechre, The Knife, Roxy Music, Brian Eno, Neon Indian, Washed Out, Tobacco, Dan Deacon, Burial, Oneohtrix Point Never, Belong, Tim Hecker, Jefre Cantu-Ledesma, John Maus, Mr Oizo, James Blake, Ariel Pink, Toro y Moi, New Order, Caribou, My Bloody Valentine, Stereolab, Animal Collective, Com Truise, Casino Versus Japan, Grimes, The Rapture, Tycho, Ratatat, Purity Ring, Hot Chip, You'll Never Get to Heaven, Clams Casino, Broadcast, Beach House and Black Moth Super Rainbow. These are directions, not replication or endorsement claims.

| Musical role | Starting sounds | Design intent |
| --- | --- | --- |
| Mellow keys | Algo Four Amber EP / Porcelain Keys; Cassia Velvet Chords | Contrasting soft FM and phase-distortion attacks, controlled decay and restrained space. Not sampled electric/acoustic pianos. |
| Rounded bass | Monolith Low Pillow; Io Compu Bass; Silver Box Deep Sub 303 | Stable low-register support; leave room for drums instead of adding obligatory stereo tails. |
| Wavering melody | Monolith Velour Lead; Sallen Pitch Bloom; Wanderer PWM Lead | Different sources of motion: width, modulation and deliberate pitch contour. |
| Hazy accompaniment | Hera Faded Organ; Expander Dusk Chord / Velvet Bloom / Notch Strings; Io Ensemble Pad | Organ body, slow filter motion and layered space without adding voices. Hera uses its native chorus. |
| Plucked punctuation | Monolith Copper Pluck; Canvas FM Chimes; Io Arp Pluck | Clear note fronts with timed repeats, contrasting sustained pads. |
| Grit and rhythmic edge | Monolith Wheel Furnace; Silver Acid Squelch; Sallen Acid Scream | Preserve each modeled circuit's articulation; drive is a chosen timbral stage, not a blanket lo-fi switch. |
| Noise and atmosphere | Wanderer Paper Rain / Pink Breath; Monolith Pink Wind; Briefcase Space Drone | Synthetic weather, breath and smeared space, not falsely labeled field recordings or vinyl samples. |
| Electronic drums | Existing 808, 909, Verona, Spokes and other protected percussion sounds | Retain the approved kits and individual synthesized voices. Groove, swing and arrangement are separate performance choices. |

The firmware palette cannot supply recorded vocals, sample chopping, recorded guitar performances, authentic tape transport or a complete acoustic break library. Long ambient tails must pass raw-output headroom and physical CPU checks; matched listening files are not a substitute for either. The nine new synth designs expand missing roles, not a quota of cutoff variants.

## Corrected FX-authored audition evidence

The replacement gallery contains 214 sixteen-second clips covering 152 selected-bank sounds, including 62 performance clips across six parity engines. Its 110 melodic factory presets include the nine new lo-fi designs; 74 named sounds enable added rack effects. All 742 headroom observations at 44,118 and 48,000 Hz passed, with maximum raw absolute peak 0.879755. All 28 dry-Init/intentional-dry checks passed. The gallery's matched files use constant gain for comparison; raw WAVs retain diagnostic levels.

Every rendered graph matched the fresh selected-bank preset graph. Source snapshot SHA-256 is `5b3ce0ec12e635e8b50aa6e7049d4085a9c0c6c5daf65b637fd503e299166e56`. The browser checked all 428 audio URLs and 214 decoded plots, then exercised native FLAC/WAV playback controls. These are browser-engine renders, not FM-1 recordings or listening approval.

The private selected-bank firmware stores the palette in ROM. Lossless packing reproduced all 15,121 factory Q16 values exactly, and all 110 selected melodic sounds passed actual firmware-code recall and native reload at the hardware byte capacity. Physical CPU qualification remains separate from host recall, audio headroom and the default-profile stress matrix.
