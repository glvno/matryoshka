// SPDX-License-Identifier: GPL-3.0-only
// Original role-led candidates, not measured or listening-approved settings. Design references:
// docs/measurements/2026-11-13-{fmini-1-preset-reference,parity-preset-design}.md.
// A present stage is ON and specifies every promoted control; an absent stage is OFF.
// Intrinsic instrument effects, approved DSP quality and voice counts remain untouched.
export interface FxRecipe {
  reason: string;
  drive?: { drive: number; mode: number; level: number; sym: number };
  chorus?: { rate: number; depth: number; mix: number };
  delay?: { time: number; fb: number; mix: number; sync: number; pingpong: number; note: number };
  reverb?: { size: number; damp: number; mix: number; pre: number; mod: number; freeze: number };
}

export const FACTORY_FX_MASKS: Record<string, number> = {
  'Monolith D': 15,
  'Silver Box': 15,
  'Algo Four': 13,
  'Oracle V': 3,
  'Canvas': 4,
  'Expander S': 15,
  'Briefcase 3': 7,
  'Wanderer': 13,
  'Cassia 1': 5,
  'Vernon 100': 7,
  'Sallen 20': 7,
  'Io 4': 5,
};

// Drive mode 0 is soft clip; its small-signal slope is 1.5, so level compensates drive.
// Symmetry stays zero: this insert has no post-shaper DC blocker. No quality controls change.
// Chorus rate is Hz; depth spans an 8 ms excursion around 12 ms; mix is a crossfade.
// Delay time is ms. The rack has 500 ms full-rate lines (250 ms per ping-pong half).
// No clock is wired to this rack: free times are intentional, not a promise of tempo sync.
// Reverb mix is an additive wet return, NOT a dry/wet crossfade. Size maps exponentially
// to decay, pre is ms, and larger damp darkens the tail. Mod/freeze stay zero for bounded cost.
export const FACTORY_FX_RECIPES: Record<string, Record<string, FxRecipe>> = {
  'Monolith D': {
    'Fat Bass': {
      reason: 'Compensated saturation roughens the detuned low stack into a compact dance bass without spreading its fundamental or filling rests.',
      drive: { drive: 2.6, mode: 0, level: 0.29, sym: 0 },
    },
    'Glide Lead': {
      reason: 'Driven edges and an audible 330 ms answer give overlapping leads a wiry singing role; a short dark room joins repeats without replacing the glide.',
      drive: { drive: 2.1, mode: 0, level: 0.4, sym: 0 },
      delay: { time: 330, fb: 0.29, mix: 0.26, sync: 0, pingpong: 0, note: 0 },
      reverb: { size: 0.34, damp: 0.7, mix: 0.12, pre: 18, mod: 0, freeze: 0 },
    },
    'Square Lead': {
      reason: 'Slow deep chorus makes the hollow pulse body woozy; a short stereo answer contrasts with the longer centered Glide Lead echo.',
      chorus: { rate: 0.28, depth: 0.52, mix: 0.34 },
      delay: { time: 185, fb: 0.18, mix: 0.18, sync: 0, pingpong: 1, note: 0 },
    },
    'Pink Wind': {
      reason: 'Deep slow chorus smears the noise into a dark diffuse cloud; the long tail belongs to the transition role, not every melodic sound.',
      chorus: { rate: 0.12, depth: 0.65, mix: 0.4 },
      reverb: { size: 0.76, damp: 0.86, mix: 0.34, pre: 0, mod: 0, freeze: 0 },
    },
    'Soft Flute': {
      reason: 'A small dark chamber leaves the sparse triangles and breath-length attack exposed, with no chorus detuning.',
      reverb: { size: 0.38, damp: 0.7, mix: 0.14, pre: 12, mod: 0, freeze: 0 },
    },
    'Muted Horn': {
      reason: 'A close room follows the delayed brightness rise without a discrete echo turning brass articulation into a repeated phrase.',
      reverb: { size: 0.24, damp: 0.76, mix: 0.1, pre: 9, mod: 0, freeze: 0 },
    },
    'Rhea Plucked Bass': {
      reason: 'Deliberately dry: preserve the attributed single-source bass contour and the separation between its filter decay and loudness decay.',
    },
    'Pocket Pulse': {
      reason: 'Deliberately dry: keep the detached pulse/sub attack, zero-sustain body and immediate note-off useful for a tight bass pattern.',
    },
    'Fifth Signal': {
      reason: 'A clear 375 ms repeat makes the root/fifth figure answer itself without chorus blurring the deliberately tuned interval.',
      delay: { time: 375, fb: 0.24, mix: 0.22, sync: 0, pingpong: 0, note: 0 },
      reverb: { size: 0.32, damp: 0.6, mix: 0.08, pre: 20, mod: 0, freeze: 0 },
    },
    'Copper Pluck': {
      reason: 'A clear 150 ms stereo reflection makes the sparse wooden strike dance; a predelayed dark room frames it without softening the initial transient.',
      delay: { time: 150, fb: 0.18, mix: 0.24, sync: 0, pingpong: 1, note: 0 },
      reverb: { size: 0.4, damp: 0.72, mix: 0.19, pre: 24, mod: 0, freeze: 0 },
    },
    'Hollow Reed': {
      reason: 'One quiet 95 ms reflection adds intimacy to the pulse-and-noise reed without modulating its pitch or concealing its staggered attacks.',
      delay: { time: 95, fb: 0.05, mix: 0.12, sync: 0, pingpong: 0, note: 0 },
    },
    'Register Organ': {
      reason: 'An unmodulated hall carries the straight 16/8/4-foot registration after gate-off; no chorus implies a rotary or detuned organ.',
      reverb: { size: 0.68, damp: 0.65, mix: 0.28, pre: 24, mod: 0, freeze: 0 },
    },
    'Wheel Furnace': {
      reason: 'Level-compensated hard clipping makes the inverted contour abrasive; short stereo echoes expose the wheel-filter gestures against their recent history.',
      drive: { drive: 3, mode: 1, level: 0.4, sym: 0 },
      delay: { time: 220, fb: 0.27, mix: 0.24, sync: 0, pingpong: 1, note: 0 },
    },
  },
  'Silver Box': {
    'Acid Squelch': {
      reason: 'Strong compensated soft clipping gives the acid sequence a torn edge while a tight 125 ms repeat punctuates rests; no reverb obscures slide.',
      drive: { drive: 3.6, mode: 0, level: 0.35, sym: 0 },
      delay: { time: 125, fb: 0.18, mix: 0.16, sync: 0, pingpong: 0, note: 0 },
    },
    'Rubber Square': {
      reason: 'A slow shallow chorus gently widens the rounded held body, keeping the lower square phrase mostly direct and echo-free.',
      chorus: { rate: 0.3, depth: 0.16, mix: 0.14 },
    },
    'Deep Sub 303': {
      reason: 'Deliberately dry: protect low-register support and audible gate releases instead of adding stereo bass or accumulated delay energy.',
    },
    'Short Zap': {
      reason: 'A 100 ms stereo answer turns short high accents into punctuation without clipping away their velocity contrast or adding a long tail.',
      delay: { time: 100, fb: 0.2, mix: 0.25, sync: 0, pingpong: 1, note: 0 },
    },
    'Long Sweep': {
      reason: 'An audible 375 ms echo trail smears the long normal sweep into dark space, contrasting with dry Accent Ladder and the clipped rhythmic acid sound.',
      delay: { time: 375, fb: 0.38, mix: 0.32, sync: 0, pingpong: 0, note: 0 },
      reverb: { size: 0.5, damp: 0.78, mix: 0.15, pre: 16, mod: 0, freeze: 0 },
    },
    'Dry Square': {
      reason: 'Deliberately dry: the plain low-mid ostinato is a gate-length and waveform study, with no accent punch to turn into an effect send.',
    },
    'Accent Ladder': {
      reason: 'Deliberately dry: consecutive accents must expose the resonance-linked sweep accumulation without a compressor-like drive or echoes impersonating accents.',
    },
    'Open Saw': {
      reason: 'Light chorus and a short single slap give the open slide line a different setting from the squelching sequences while retaining legato clarity.',
      chorus: { rate: 0.55, depth: 0.18, mix: 0.17 },
      delay: { time: 85, fb: 0, mix: 0.11, sync: 0, pingpong: 0, note: 0 },
    },
  },
  'Algo Four': {
    'Solid Bass': {
      reason: 'Deliberately dry: the fast FM bite and low body already separate the rhythmic bass role; preserve the click without extra nonlinear harmonics.',
    },
    'Lately Bass': {
      reason: 'Compensated saturation turns the FM feedback growl into a rough dance-bass hook, with no delay smearing repeated notes.',
      drive: { drive: 2.8, mode: 0, level: 0.2, sym: 0 },
    },
    'E Piano': {
      reason: 'A short dark room gives the decaying electric-piano body depth while leaving the high-ratio tine attack clear and unmodulated.',
      reverb: { size: 0.36, damp: 0.72, mix: 0.16, pre: 18, mod: 0, freeze: 0 },
    },
    'Tubular Bell': {
      reason: 'A clear stereo reflection and predelayed dark hall frame crystalline inharmonic strikes; modest echo feedback leaves the long FM decay recognizable.',
      delay: { time: 230, fb: 0.17, mix: 0.19, sync: 0, pingpong: 1, note: 0 },
      reverb: { size: 0.63, damp: 0.75, mix: 0.27, pre: 30, mod: 0, freeze: 0 },
    },
    'Brass Stab': {
      reason: 'A close room supports the two swelling FM stacks without a beat-length echo making a short brass chord sustain through the next hit.',
      reverb: { size: 0.22, damp: 0.68, mix: 0.11, pre: 10, mod: 0, freeze: 0 },
    },
  },
  'Oracle V': {
    'Sync Lead': {
      reason: 'Compensated saturation gives the poly-mod sync sweep a wiry edge; shallow chorus spreads the lead without inventing a missing delay stage.',
      drive: { drive: 2.2, mode: 0, level: 0.47, sym: 0 },
      chorus: { rate: 0.48, depth: 0.18, mix: 0.2 },
    },
    'Poly Brass': {
      reason: 'Low-depth chorus broadens the brass sustain while keeping the distinct amplitude and filter attacks predominantly direct.',
      chorus: { rate: 0.65, depth: 0.16, mix: 0.18 },
    },
    'Vintage Strings': {
      reason: 'Slow deep chorus makes the long saw envelopes hazy and gently unstable rather than pristine; no drive pushes the previously headroom-limited voice sum.',
      chorus: { rate: 0.18, depth: 0.62, mix: 0.4 },
    },
    'Poly-Mod Bell': {
      reason: 'Deliberately dry: preserve the audio-rate FM sidebands and percussive decay; the available drive/chorus rack would change the bell rather than add a room.',
    },
    'Unison Bass': {
      reason: 'Deliberately dry: the unison oscillator stack already supplies weight; neither added harmonics nor moving stereo copies improve its tight low-register job.',
    },
  },
  'Canvas': {
    'Sequencer Run': {
      reason: 'A 270 ms echo sits one and a half 180 ms pulser steps behind the run, adding an offbeat answer while its internal reverb remains intact.',
      delay: { time: 270, fb: 0.19, mix: 0.17, sync: 0, pingpong: 0, note: 0 },
    },
    'Complex Lead': {
      reason: 'A compact 210 ms stereo echo answers the folded FM lead without another distortion stage or a second reverb on its intrinsic space.',
      delay: { time: 210, fb: 0.29, mix: 0.27, sync: 0, pingpong: 1, note: 0 },
    },
    'Easel Bongos': {
      reason: 'A 125 ms reflection fills the midpoint between 250 ms bongo pulses; low feedback preserves the random timbre of each fresh strike.',
      delay: { time: 125, fb: 0.16, mix: 0.28, sync: 0, pingpong: 1, note: 0 },
    },
    'Fold Drone': {
      reason: 'A prominent 470 ms echo smears the folded drone behind its intrinsic tremolo and reverb, deliberately denser than the articulated pulser sounds.',
      delay: { time: 470, fb: 0.42, mix: 0.32, sync: 0, pingpong: 0, note: 0 },
    },
    'FM Chimes': {
      reason: 'A clear 375 ms answer offsets the 500 ms chime sequence, making a bright interlocking pattern over its existing long decay and reverb.',
      delay: { time: 375, fb: 0.23, mix: 0.24, sync: 0, pingpong: 0, note: 0 },
    },
  },
  'Expander S': {
    'SEM Brass': {
      reason: 'A restrained room supports the stereo brass swell without adding another detune layer to its two saws and native vibrato.',
      reverb: { size: 0.27, damp: 0.68, mix: 0.12, pre: 14, mod: 0, freeze: 0 },
    },
    'SEM Bass': {
      reason: 'Gentle level-compensated saturation joins the saw and octave square into one bass body; all time effects stay off for rhythmic definition.',
      drive: { drive: 1.2, mode: 0, level: 0.49, sym: 0 },
    },
    'Notch Strings': {
      reason: 'Deep slow chorus blurs the notch strings into hazy accompaniment while a dark hall carries releases; no drive pushes the sustained polyphonic sum.',
      chorus: { rate: 0.16, depth: 0.56, mix: 0.34 },
      reverb: { size: 0.64, damp: 0.82, mix: 0.24, pre: 22, mod: 0, freeze: 0 },
    },
    'Highpass Pluck': {
      reason: 'A restrained 160 ms stereo answer extends the thin pulse strike without extra drive on its previously headroom-sensitive transient.',
      delay: { time: 160, fb: 0.14, mix: 0.16, sync: 0, pingpong: 1, note: 0 },
    },
    'Unison Lead': {
      reason: 'A clear 310 ms repeat and small dark room frame the already detuned unison line, avoiding extra chorus or saturation on its voice sum.',
      delay: { time: 310, fb: 0.21, mix: 0.18, sync: 0, pingpong: 0, note: 0 },
      reverb: { size: 0.3, damp: 0.72, mix: 0.08, pre: 20, mod: 0, freeze: 0 },
    },
  },
  'Briefcase 3': {
    'Space Drone': {
      reason: 'Very slow deep chorus and a long repeating memory smear the close oscillators over their intrinsic reverb; this is an intentionally dense drone, not a neutral room.',
      chorus: { rate: 0.1, depth: 0.68, mix: 0.38 },
      delay: { time: 480, fb: 0.34, mix: 0.25, sync: 0, pingpong: 0, note: 0 },
    },
    'Ring Mod Clang': {
      reason: 'A 190 ms stereo reflection makes the metallic strike answer across the field while retaining its intrinsic decay and reverb.',
      delay: { time: 190, fb: 0.22, mix: 0.25, sync: 0, pingpong: 1, note: 0 },
    },
    'Resonant Ping': {
      reason: 'Added rack deliberately dry: the self-oscillating filter ping already feeds substantial intrinsic reverb; preserve its pitch and avoid regenerative peak buildup.',
    },
    'Sea Noise': {
      reason: 'Slow deep chorus spreads the surf after its existing reverb; no repeating echo or drive competes with the long noise swell.',
      chorus: { rate: 0.14, depth: 0.6, mix: 0.36 },
    },
    'Buzz Lead': {
      reason: 'Compensated hard clipping gives the buzzing source a frayed edge while a short slap supports its rhythmic trapezoid phrase without multiplying vibrato.',
      drive: { drive: 2.6, mode: 1, level: 0.34, sym: 0 },
      delay: { time: 115, fb: 0.09, mix: 0.18, sync: 0, pingpong: 0, note: 0 },
    },
  },
  'Wanderer': {
    'Sync Lead': {
      reason: 'A 290 ms repeat follows the swept sync envelope and a small room connects phrases; no drive masks the distinction between one-key and duophonic sync.',
      delay: { time: 290, fb: 0.22, mix: 0.2, sync: 0, pingpong: 0, note: 0 },
      reverb: { size: 0.3, damp: 0.7, mix: 0.09, pre: 17, mod: 0, freeze: 0 },
    },
    'S/H Bleeps': {
      reason: 'A 125 ms stereo echo answers halfway between the 4 Hz samples; restrained feedback keeps new random pitches distinct from their history.',
      delay: { time: 125, fb: 0.26, mix: 0.3, sync: 0, pingpong: 1, note: 0 },
    },
    'Ring Bell': {
      reason: 'A predelayed dark hall suspends the metallic XOR ring after the strike without drive or chorus altering its deliberately inharmonic interval.',
      reverb: { size: 0.66, damp: 0.76, mix: 0.28, pre: 28, mod: 0, freeze: 0 },
    },
    'Punch Bass': {
      reason: 'Deliberately dry: preserve the direct octave-down attack and short ADSR body for repeated low notes rather than adding a second rhythmic layer.',
    },
    'PWM Lead': {
      reason: 'A 215 ms stereo answer and light room complement existing PWM, vibrato and glide without adding another pitch-modulation process.',
      delay: { time: 215, fb: 0.22, mix: 0.2, sync: 0, pingpong: 1, note: 0 },
      reverb: { size: 0.34, damp: 0.68, mix: 0.1, pre: 18, mod: 0, freeze: 0 },
    },
    'Two Finger Reed': {
      reason: 'A close chamber gives played intervals a shared space while preserving the independently moving upper line and short AR releases.',
      reverb: { size: 0.26, damp: 0.72, mix: 0.12, pre: 12, mod: 0, freeze: 0 },
    },
    'Keyed Color': {
      reason: 'Deliberately dry: each new attack must reveal its own held random cutoff, not the previous color returning as an echo; retain the calibrated transient.',
    },
    'Pink Breath': {
      reason: 'A long dark hall turns the band-limited breath into a smeared transition texture, contrasting with the dry keyed-color attacks and compact bass.',
      reverb: { size: 0.78, damp: 0.86, mix: 0.32, pre: 5, mod: 0, freeze: 0 },
    },
  },
  'Cassia 1': {
    'PD Bass': {
      reason: 'Added rack deliberately dry: retain velocity-shaped phase-distortion bite and the existing intrinsic chorus setting, without regenerating low notes.',
    },
    'PD Brass': {
      reason: 'One quiet 90 ms slap adds proximity behind the brass swell; no extra drive flattens its velocity and aftertouch response.',
      delay: { time: 90, fb: 0.04, mix: 0.12, sync: 0, pingpong: 0, note: 0 },
    },
    'Glass Bell': {
      reason: 'A sparse 235 ms stereo reflection answers the ring-modulated strike while low feedback respects the long unsustained DCA decay.',
      delay: { time: 235, fb: 0.17, mix: 0.18, sync: 0, pingpong: 1, note: 0 },
    },
    'Reso Pad': {
      reason: 'A prominent 430 ms echo lets the evolving resonance-wave pad leave a hazy harmonic memory behind its intrinsic chorus, without added distortion.',
      delay: { time: 430, fb: 0.36, mix: 0.29, sync: 0, pingpong: 0, note: 0 },
    },
    'Tine Piano': {
      reason: 'A short 145 ms stereo reflection surrounds the tine/body contrast while modest feedback leaves room for the velocity-sensitive key attack.',
      delay: { time: 145, fb: 0.1, mix: 0.15, sync: 0, pingpong: 1, note: 0 },
    },
  },
  'Vernon 100': {
    'Fat Duo Lead': {
      reason: 'Compensated saturation binds the two played saws and subordinate sub; a 285 ms answer follows the upper melody without chorus blurring intervals.',
      drive: { drive: 1.8, mode: 0, level: 0.45, sym: 0 },
      delay: { time: 285, fb: 0.23, mix: 0.22, sync: 0, pingpong: 0, note: 0 },
    },
    'Wobble Bass': {
      reason: 'Compensated saturation roughens the moving bass body while all time effects stay off, keeping the oscillator-driven wobble explicit and danceable.',
      drive: { drive: 2.6, mode: 0, level: 0.29, sym: 0 },
    },
    'Stepped Pulse': {
      reason: 'A clear 170 ms stereo answer adds wiry counter-motion behind the periodic square-modulated steps; no chorus suggests a random or smoothly bent pitch route.',
      delay: { time: 170, fb: 0.23, mix: 0.26, sync: 0, pingpong: 1, note: 0 },
    },
    'Metal Clang': {
      reason: 'A sparse 225 ms stereo reflection frames the struck audio-rate modulation; omit drive to retain its sidebands and avoid emphasizing the normalized transient.',
      delay: { time: 225, fb: 0.13, mix: 0.16, sync: 0, pingpong: 1, note: 0 },
    },
    'Slow Sweep Pad': {
      reason: 'Deep slow chorus and a 440 ms repeating memory turn the held dyad into woozy accompaniment, contrasting with the unprocessed Triangle Duo.',
      chorus: { rate: 0.13, depth: 0.6, mix: 0.38 },
      delay: { time: 440, fb: 0.32, mix: 0.24, sync: 0, pingpong: 0, note: 0 },
    },
    'Triangle Duo': {
      reason: 'Deliberately dry: clear low-partial intervals and the moving upper voice are the showcase; no chorus detuning, nonlinear overtones or repeated dyads.',
    },
    'Notch Loom': {
      reason: 'A shallow slow chorus gives the contrasting COLOR sources lateral movement without saturation filling in the moving band-reject hollow.',
      chorus: { rate: 0.27, depth: 0.22, mix: 0.23 },
    },
    'HP Clav': {
      reason: 'One short 75 ms reflection adds a close percussive response while leaving the high-pass strike and contrasting envelope lengths distinct.',
      delay: { time: 75, fb: 0, mix: 0.14, sync: 0, pingpong: 0, note: 0 },
    },
  },
  'Sallen 20': {
    'Acid Scream': {
      reason: 'A quiet 140 ms answer gives the resonant phrase a second rhythmic edge; no extra drive or chorus burdens its already forceful calibrated transient.',
      delay: { time: 140, fb: 0.12, mix: 0.13, sync: 0, pingpong: 0, note: 0 },
    },
    'Growl Bass': {
      reason: 'Deliberately dry: the resonant high-pass supplies the growl; preserve the reduced filter-input levels and keep the low-register contour unblurred.',
    },
    'Ring Mod Bell': {
      reason: 'A 230 ms stereo echo supplies space without a nonexistent reverb stage; low regeneration retains the separate multiplier-ring strike and long EG2 decay.',
      delay: { time: 230, fb: 0.24, mix: 0.29, sync: 0, pingpong: 1, note: 0 },
    },
    'Noise Sweep': {
      reason: 'Deep slow chorus and a long echo smear the dual-filter surf into a wide noise texture; no drive adds harmonics to its resonant peaks.',
      chorus: { rate: 0.11, depth: 0.62, mix: 0.36 },
      delay: { time: 460, fb: 0.3, mix: 0.23, sync: 0, pingpong: 0, note: 0 },
    },
    'ESP Warble': {
      reason: 'A sparse 175 ms stereo answer lets unstable ESP pitches leave a short trace while the direct saw remains an anchor; no chorus further obscures the pitch route.',
      delay: { time: 175, fb: 0.15, mix: 0.18, sync: 0, pingpong: 1, note: 0 },
    },
    'Soft Reed': {
      reason: 'A single 105 ms reflection supports breath-sized phrasing without drive roughening the restrained pulse or chorus turning it into a pad.',
      delay: { time: 105, fb: 0.03, mix: 0.12, sync: 0, pingpong: 0, note: 0 },
    },
    'Pinch Pluck': {
      reason: 'Deliberately dry: the opposed HP/LP contours must audibly close into a narrow tail, with no delay keeping the original broad attack alive.',
    },
    'Pitch Bloom': {
      reason: 'A subdued 390 ms repeat answers during the delayed pitch rise, exposing the bloom without chorus adding a competing pitch trajectory.',
      delay: { time: 390, fb: 0.16, mix: 0.16, sync: 0, pingpong: 0, note: 0 },
    },
  },
  'Io 4': {
    'Ensemble Pad': {
      reason: 'A 420 ms echo leaves a hazy memory behind the native ensemble and long releases, without extra pitch modulation or drive on the four-voice sum.',
      delay: { time: 420, fb: 0.32, mix: 0.25, sync: 0, pingpong: 0, note: 0 },
    },
    'Arp Pluck': {
      reason: 'A 187 ms stereo repeat adds a dotted-sixteenth-like answer near 120 BPM to articulated manual or external patterns, without claiming an enabled internal arp or tempo lock.',
      delay: { time: 187, fb: 0.25, mix: 0.29, sync: 0, pingpong: 1, note: 0 },
    },
    'Unison Lead': {
      reason: 'A 300 ms echo follows the gliding unison melody; keep drive off and the existing no-vibrato precaution intact rather than thickening it again.',
      delay: { time: 300, fb: 0.18, mix: 0.17, sync: 0, pingpong: 0, note: 0 },
    },
    'S&H Filter': {
      reason: 'A 100 ms stereo echo answers halfway between 5 Hz cutoff samples; a low return leaves the current held chord and each fresh step in front.',
      delay: { time: 100, fb: 0.13, mix: 0.16, sync: 0, pingpong: 1, note: 0 },
    },
    'PWM Brass': {
      reason: 'One 80 ms slap gives the brass a close reflection without another chorus competing with PWM or long repeats masking its slower brightness attack.',
      delay: { time: 80, fb: 0, mix: 0.11, sync: 0, pingpong: 0, note: 0 },
    },
    'Compu Piano': {
      reason: 'A 155 ms stereo reflection frames decaying chords while preserving the difference between the short filter decay and longer saw-piano body.',
      delay: { time: 155, fb: 0.12, mix: 0.21, sync: 0, pingpong: 1, note: 0 },
    },
    'Compu Bass': {
      reason: 'Deliberately dry: the square/sub accompaniment needs compact note endings and an unmodulated low image, not another layer of harmonics or repeats.',
    },
    'Inverse Keys': {
      reason: 'A low-feedback 340 ms answer overlaps the opening held body, contrasting its dark new strike with the previous note without drive masking the inverted contour.',
      delay: { time: 340, fb: 0.16, mix: 0.18, sync: 0, pingpong: 0, note: 0 },
    },
  },
};
