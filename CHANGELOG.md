# Changelog

## 1.5.1 — 2026-10-27

### Fixes

- **The editor starts about three times faster.** It no longer works out, as the page loads, every factory patch, the
  FM-1 budget of every patch in the Open picker, and the presets of every XL. A factory patch is built when it is first
  opened. The picker's FM-1 · NN % and SANDBOX chips are worked out after the page is up, while it is idle (all of them
  at once if the picker is opened first); they read as before. The factory presets of an engine are made when an engine
  of that structure is first shown. Structure fingerprints and the patch check no longer compare every cable with every
  other one. The Library's Patches section is drawn when it is shown, and remembers which patches fit the FM-1. Measured
  in headless Chrome on the built site, empty browser storage: on an M-series Mac, the page was ready
  (DOMContentLoaded) after 0.33 s (1.22 s before), with 0.56 s of script (1.13 s); with the CPU slowed 4× and a
  9 Mbit/s, 70 ms network, after 1.69 s (4.21 s), with 1.03 s of script (2.98 s). With a browser that holds 50 saved
  patches, a 64-slot bank and 20 library assemblies, mostly in the 1.3 and 1.4 formats, and an XL open: 0.47 s
  (1.42 s) on the Mac and 1.98 s (4.90 s) slowed. Script time is counted until 4 s after load, so it includes the
  chips worked out while idle (all but a few of them in the slowed run with stored patches).
- **The browser tab's icon is 12 KB** instead of the 841 KB full-size logo.

## 1.5.0 — 2026-10-27

Figures compare this release with 1.4.2. Unless a line says otherwise, an FM-1 figure is the editor's estimate:
modules and patch bytes from its budget, CPU from its CPU model, both run on each version's factory patches.

### Fixes

- **The FM-1 no longer stalls when it is plugged into a computer where no app reads its MIDI.** Each message for the
  editor (a step entered, a knob turned) waited up to 0.2 s for USB room there, as in 1.4.2. Entering steps quickly
  then froze the screen, the LEDs and the keys for seconds, and the sound cut out. On the test rig, with a build from
  before the fix (Elvira 2, sequencer running, steps entered by hand), the main loop's longest pass took 7.46 s. Now a
  message waits at most 0.05 s. Once one has waited that long with nothing read, the next ones are dropped at once,
  until the computer reads again; the editor syncs when it connects. In the emulator, after 30 steps entered with
  nothing reading, the SEQ page closes in 140 emulated ms (2,890 before). The final version is tested on the host, in
  the emulator, and by hand on the test rig.
- **USB MIDI keeps consecutive editor messages in order** instead of dropping one that arrives while the one before is
  still pending. Entering sandbox mode sends LIVE paused before its first page, so the FM-1 mutes and receives that
  page together.
- **Turning VOICES past the available memory keeps the last playable setting.** Cassia 1's fifth voice could exhaust
  the engine's memory, leaving the row at −1 and the instrument silent. A failed edit now restores the patch, shows NO
  ROOM and does not send the rejected value to the editor. Reloads pause audio while the engine is rebuilt. Checked
  with the host panel test; not yet checked on a device.
- **The patch-bytes budget counts the panel buttons' record.** A patch whose ARP, FX or LFO button is not a plain gate
  sends 9 more bytes than the editor counted. So a patch within 9 bytes of the 3,840 limit passed the budget and was
  then refused by the FM-1. The budget now equals what is sent (in 1.4.2 Oracle V showed 1,266 bytes and sent 1,275).
- **Inserted assemblies keep their macro ranges** (#367). Saving and inserting an assembly no longer turns a bounded
  macro control into ordinary added modulation. Each inserted copy keeps its own ranges. A round-trip test checks both
  the rendered sound and that editing one copy leaves the others unchanged.
- **Morph leaves modules without a B side untouched on the FM-1,** as the browser does (#355). The patch now records
  which modules morph. Patches stored on the FM-1 before keep how they play when they are loaded and upgraded.

### FM-1 instruments after their originals' panels

Each of these was tested on the host (both engines), not yet on a device, unless the entry says more.

- **Silver Box is the Roland TB-303.** An accented note (velocity 115 or more, or a Steps accent) runs the filter
  envelope at its shortest decay, 200 ms. That envelope times ACCENT lifts the level and, through the accent sweep
  circuit, the cutoff. At high RESONANCE the sweep is smoother and builds up over consecutive accents, as the
  original's second resonance gang does. ENV MOD no longer scales the accent. The soft clip after the filter is gone
  (the 303 has none), and so are the slide, drive and amp decay rows: the slide time and the volume envelope's decay
  are fixed, as on the original. WAVEFORM is a named SAW / SQUARE switch. TUNING spans ±5 semitones and no more, as
  the TB-303's TUNING knob (±500 cents in its owner's manual), with no detune in the middle of the row
  ([D-702](docs/ledger/fidelity.md#D-702)); it was the oscillator's coarse tune, ±4 octaves in semitone steps. The
  cutoff row is CUT OFF FREQ, as on the panel. The patch's Steps tracks have the 303's pattern memory, pattern
  chaining with transpose and song mode (see Steps below). It comes with four demo patterns in the 303's style: acid
  lines with accents and slides, the fourth in the 303's triplet mode (12 steps of 1/16T). A song chains them with
  shifts, and the editor names the patterns as the 303 does (I-A1 .. IV-B8). Pattern 1 stays empty, so the keys still
  play it as a synth and PLAY alone plays nothing: choose the song on the FM-1 (SEL on the SEQ page, then K4 right) or
  with SONG on its card. Still missing: MIX IN, the external audio input. FM-1: 14 → 20 modules, 886 → 1,234 patch
  bytes, CPU 17 → 20 %. The copy inside `<7PH` keeps a plain waveform row and the one-semitone tuning to fit: `<7PH`
  takes 63 modules (60), 3,839 bytes of 3,840 (3,776) and 65 % of the CPU (67 %). The patterns and the song were
  tested in the emulator.
- **Monolith D has the Minimoog Model D's panel.** Its card holds the original's controls under their names: TUNE and
  a half-octave PITCH wheel, GLIDE with its on / off switch, OSCILLATOR 3 CONTROL (oscillator 3 off the keys, for a
  slow modulation source), RANGE as the six footages LO to 2', the WHITE / PINK switch, KEYBOARD CONTROL off, 1, 2 or
  both, the DECAY switch (each contour's release takes its decay time, or the note stops at once) and the A-440 tone.
  WAVEFORM has all six positions on each oscillator: triangle, the triangle / saw hybrid (oscillator 3: reverse saw),
  saw, square, wide and narrow rectangle. The modulation switches now switch. The modulation mix comes from oscillator
  3 and the noise before the mixer's volumes, so a silent noise or a quiet oscillator 3 no longer weakens it. FILTER
  MODULATION runs at audio rate and no longer depends on the contour amount. Gone: the drive, release and scope rows,
  which the original lacks. The switches show their positions by name. Still missing: the external input. FM-1: 18 →
  37 modules, 1,372 → 3,094 patch bytes, CPU 23 → 37 %.
- **Sallen 20 is the Korg MS-20.** The highest held key plays (the MS-20 mini's manual). VCO 1 and 2 have SCALE as
  footages and their own WAVEFORM switches (VCO 1's noise, VCO 2's narrow pulse and ring modulator in place of the
  ring row). MASTER TUNE, EG 1's DELAY and EG 2's HOLD are new. Each filter has its own MG/T.EXT and EG2/EXT amounts
  (the high pass had no MG amount, and the low pass's MG depended on its EG amount). The MG's frequency modulation
  reaches the oscillators' pitch, not just their fine tune. The MG's WAVEFORM knob sweeps continuously from falling
  saw through triangle to rising saw and changes the pulse width, with its triangle and rectangle out at once. The
  high pass falls 6 dB per octave below its cutoff, as the MS-20's does (it was 12 dB), so more low end passes. Both
  filters self-oscillate, so the PEAK knobs scream at the top, as on the MS-20. The soft drive after the low pass is
  gone. Its ESP (External Signal Processor) section is there: the ESP's rows, its amplifier, band-pass, F-V CV,
  envelope and trigger outputs, and VCO 1+2 CV IN, TRIGGER IN and INITIAL GAIN to patch them into, as the MS-20's
  manual does. The FM-1 has no audio input, so a SIGNAL IN row picks what the ESP hears (VCO 1, the noise or the MG).
  An ESP ROUTE row patches one of its outputs: F-V into VCO 2's pitch, ENV into the initial gain, or TRIG into both
  EGs. Both start OFF, and then the patch sounds as it does without the ESP. The patch panel's sections are the
  assembly's jacks, to patch in the browser: the sample and hold (white noise, clocked by the MG's rectangle), white
  and pink noise, the MVCA (EG 1 on its control), both envelopes' normal and reverse outputs, the control wheel (the
  mod wheel), the momentary switch (the FX button, labelled SWITCH), KBD CV and trigger, the MG's triangle and
  rectangle, INITIAL GAIN (a row) and `esp signal in` (it adds to SIGNAL IN's choice). Unpatched they leave the sound
  as it was. The scale and wave switches show their positions by name. Still missing: the ESP's external input and
  repatching on the FM-1 itself. FM-1: 19 → 48 modules, 1,425 → 3,098 patch bytes, CPU 29 → 45 % (the ESP always runs
  on the FM-1).
- **Io 4 has the Roland Jupiter-4's panel.** Its card follows the owner's manual, one row per control: the VCO's
  range, sub oscillator, LFO mod, pulse width (four steps, manual or LFO) and waveform with OFF; noise; the high pass,
  the low pass with its 10 / 40 / 70 / 100 % key follow, LFO mod, envelope mod and polarity; a VCF envelope and a VCA
  envelope (the manual lists two ADSRs; Io 4 had one); the VCA level; the LFO's four waveforms. The modifier section
  is there too: the trigger (its rate clocks a noise sample & hold into the cutoff, and the arpeggiator when ARP is
  on), the LFO delay and LFO bend, the lever's three LFO / OFF / BEND switches with bend sensitivity and LFO depth
  (the FM-1's pitch bend and mod wheel), portamento (its switch row is called SWITCH), transpose, tuning, POLY I /
  POLY II / UNISON I / UNISON II (SHARE on its unison row shares the four voices across held notes), hold and the
  ensemble switch. LFO RATE runs on the LFO's fast range, so it reaches the Jupiter-4's 80 Hz (it stopped at 40 Hz)
  ([D-704](docs/ledger/fidelity.md#D-704)). The switches show the panel's legends: RANGE 16' / 8' / 4', both WAVE
  FORMs, PW and PW MODE, KYBD FOLLOW, POLARITY, NORM / WIDE, the lever's switches and TRANSPOSE. The five OFF / ON
  switches stay numbered (1 OFF, 2 ON), and NOISE shares the VCO's second page: the FM-1's patch memory holds no more
  ([D-703](docs/ledger/fidelity.md#D-703)). The `voices` row and the ensemble's rate and depth rows are gone. Still
  missing: KEY ASSIGN as one four-position switch (it is two rows). FM-1: 15 → 56 modules, 1,049 → 3,838 of 3,840
  patch bytes, CPU 44 → 93 %, four voices. It gets the arpeggiator but no PATTERN track: with one added, the test rig
  shed a voice although the estimate said it fit.
- **Vernon 100 has the EML ElectroComp 100's panel.** Its card follows the 100's panel, read from photos (no manual
  for the 100 was found; the EML 101's manuals explain the controls the two share). Four distinct oscillators:
  oscillator 2 plays the lowest key held and oscillator 3 the highest, oscillator 4 follows oscillator 3, its own
  tuning or the mixer, and oscillator 1 is a slow or audio control oscillator with five shapes. Oscillators 2 to 4
  play the new EML COLOR wavetable bank: triangle through sloped square, square and saw to double saw an octave
  higher. The oscillator mixer and the filter control have their two centre-zero knobs each; the filter input mixer,
  white or pink noise, a 12 dB filter with low pass, band pass, high pass and band reject, cut octave and KB1 / KB2
  tracking; two envelopes with the sustain switch; the amplitude shaper's envelope switch; the output mixer with
  oscillator 3 around the filter; keys per octave and portamento. The sample & hold, the pulse width rows and the
  LFO's width modulation are gone: the 100's panel has none of them. Still missing: names for the switch positions (2
  bytes left) and the external input. FM-1: 16 → 60 modules, 1,072 → 3,838 patch bytes, CPU 24 → 58 %. It gets the
  arpeggiator but no PATTERN track.
- **Wanderer is duophonic, as the ARP Odyssey is** (#303). The lowest key held plays VCO 1 and the highest plays VCO 2
  (one key plays both), into one filter, one VCA, one ADSR and one AR; it was a two-voice polysynth with both VCOs, a
  filter and both envelopes per voice. New, after the Odyssey's panel: portamento, VCO 1's AUDIO / LF switch, both
  VCOs' FM (two depths each, each with its source switch), PWM (LFO / ADSR), sync, the S/H mixer (two levels and the
  noise / VCO 2 switch), the S/H trigger (LFO / keyboard) and OUTPUT LAG, the LFO's sine and square, the envelopes'
  LFO repeat (KYBD REPEAT / AUTO REPEAT), the VCF's three modulation sliders with their switches, the VCA's AR / ADSR
  switch, level and GAIN, the noise generator's white / pink, and the ring modulator as the Odyssey's (the two VCOs'
  square waves XORed). Main's mod wheel is the PPC's vibrato pad. The envelopes retrigger on every key press,
  including a note between two held notes, and not when an outer note is released (in Wanderer XL too). The voices row
  is gone (the Odyssey has two). On the FM-1 each VCO is one oscillator, so the S/H mixer and the ring take the VCO's
  wave as the mixer has it, and the ring plays at half a VCO's level. Every switch shows its positions by name (AUDIO
  / LF, SINE / SQUARE ...). The names leave no room for the PATTERN track, so Wanderer has the arpeggiator alone.
  FM-1: 17 → 49 modules, 1,245 → 3,824 patch bytes, CPU 30 → 33 %.
- **Canvas is the Buchla Music Easel's panel** (#303): the sequential voltage source (five voltages, 3 to 5 stages,
  the pulse sequence), the envelope generator (sustained, transient or off; attack, sustain, decay), the pulser
  (triggered by the keys, itself or the sequencer), the random voltage, the modulation oscillator (three ranges,
  triangle, saw or square, FM or AM by its index), the complex oscillator (the timbre switch and pot, the folder,
  polarity), both lopass gates (lopass, combination or VCA; gate 2 from the mod oscillator or gate 1, out of phase),
  chan A and B, the reverb, the portamento, each with its trigger select or keyboard switch, named as the Easel's
  panel names them. The patch field is a fixed patch on the FM-1 (sequencer into pitch, envelope into the index and
  both levels, random into the timbre, each through its processing control). It sounds different. FM-1: 16 → 53
  modules, 1,072 → 3,779 patch bytes, CPU 25 → 71 %.
- **Briefcase 3 gets the EMS VCS3's pin matrix for its controls** (#303): columns I to P (the three oscillators'
  frequency, the envelope's decay, the reverb mix, the filter frequency, the two output levels), every source a row,
  each pin named as the VCS3's manual names it (I8, N6), on the assembly's matrix card in the editor. The keys reach
  the oscillators as on the VCS3, through input amplifier 1 (pins I8 and J8). The panel is filled in: oscillator 2 and
  3's triangles and oscillator 3's audio range, noise colour, the filter and reverb levels, the envelope's signal and
  trapezoid levels (the trapezoid rests low and rises while on), two output amplifiers with their filters, the
  joystick. It sounds different. FM-1: 18 → 64 of 64 modules, 1,336 → 3,837 patch bytes, CPU 40 → 88 %; its PATTERN
  track no longer fits (the arpeggiator stays).
- **808 Kit has the Roland TR-808's controls, and its closed hihat cuts the open one.** One card, `808 kit`, holds the
  drums with the TR-808's knobs only, one page per instrument named as on its panel: bass drum (level, tone, decay),
  snare drum (level, tone, snappy), low tom (level, tuning), rim shot, hand clap, cow bell (level), open hihat (level,
  decay), closed hihat (level). New: bass drum TONE (a low pass on the kick's attack, now with a 1 ms click) and snare
  drum TONE (the balance of two body sines, about 238 and 335 Hz, the TR-808's two shells). The hihats are the factory
  hats (a square cluster and noise) on one metallic source, and a closed hit shuts an open one until the next open
  hit. The drums' other rows (tune, drop, snap, flam, stick ...) keep their values but leave the card. It plays eight
  of the TR-808's eleven voices, and each row accents its own drum by velocity, where the TR-808 has an ACCENT row for
  all. FM-1: 59 → 58 modules, 3,408 → 3,230 patch bytes, CPU 68 → 74 %. Also tested with the firmware's engine on the
  host (`tools/golden.sh`).
- **Cassia 1 is rebuilt on the new PD Osc and Env 8 modules.** Both lines play all eight CZ waveforms, with a second
  one on every other cycle; line select 1, 2, 1 + 2 and 1 + 1'; ring and noise modulation on line 2; DCO, DCW and DCA
  envelopes of eight steps with a sustain and an end step, as on the CZ (the six-step stand-in is gone); key follow,
  velocity, aftertouch, vibrato with a delay. The envelope rows are short (r1, l1 .. r8, l8, sus, end) to fit the
  patch bytes. Its presets gain Pluck (the variations reach Env 8). It plays two voices on the FM-1, where the CZ-1
  plays eight. Still missing: a pitch envelope per line, portamento, chorus and several per-line controls. FM-1: 21 →
  46 modules, 1,611 → 3,741 patch bytes, three → two voices, CPU 75 → 57 %. On the test rig, with a pre-release build
  (CI run 40406160864), the rebuilt Cassia 1's peak over rest and 1 / 4 / 8 held notes fell from 2,920 µs at three
  voices to 2,219 µs at two (100.6 % to 76.5 % of a block). The three-voice run shed voices; the two-voice run did not
  mute. In the browser (Node on an Apple M3 Max, four voices, four notes held) it renders in about 9 % of real time,
  where Cassia 1 XL took 44 %. Cassia 1 XL is gone for now: the browser lists Cassia 1 alone until a fuller XL is
  built ([D-348](docs/ledger/patches-and-presets.md#D-348)).
- **8 Lire and Elvira 2 play their plates from one repeating Drum map** in place of four copies, so every key now
  plays a plate (a black key the plate of the white key below it). With the speed-ups below, 8 Lire goes from 49 to
  37 % of the FM-1's CPU and from 94 to 86 % of its memory, Elvira 2 from 47 to 38 % and from 68 to 59 %. Not yet
  checked on a device.

### XLs (browser only)

- **Wanderer XL,** the whole ARP Odyssey: each VCO has its saw and pulse at once, so the S/H mixer has its own VCO 1
  saw / square switch, and the ring and S/H always take the pulses with their width. Coarse is continuous and fine
  reaches the Odyssey's ±400 cents (the FM-1 version: semitones and ±100 cents). Its switches show their positions by
  name. It takes 4,597 patch bytes, over the FM-1's 3,840. Not there: the external audio input (the engines have
  none), the pedal, footswitch and CV / gate / trigger jacks.
- **Canvas XL,** the Music Easel with its patch field. Each control input picks its cord through its processing
  control: MAIN, pressure, sequencer, envelope, pulser, four independent random voltages, mod cv or the inverter.
  Choose PATCH on an input row to connect an assembly patch cord. Also the preset voltages and add to main, pressure,
  the pulser's once (the FX button), the modulation oscillator's three dial ranges and half-octave fine tunes.
- **Briefcase 3 XL,** the VCS3 with its whole 16 × 16 pin matrix, 256 pins on the card, a section per column (A meter
  to P output 2 level); the oscillators' full dial ranges, output filters flat in the middle, the pan knobs and the
  joystick's ranges.
- **808 Kit XL:** every TR-808 voice, knob and switch. The mid and high toms and the cymbal play from a second track,
  DRUMS 2, whose Drum map also has the ACCENT row: a step on it accents every voice on that step by ACCENT LEVEL, and
  the rows' velocities no longer accent. The tom / conga, rim shot / claves and hand clap / maracas switches are rows
  of named choices. The cymbal and hihats share six square oscillators at the TR-808's frequencies; the cymbal has
  TONE and DECAY. A pre-scale row (1/8T, 1/16, 1/16T, 1/32: 3, 4, 6 or 8 steps a beat) sets both tracks' rate. The
  TR-808's rhythm memory (A / B variations, fill-ins, auto fill, rhythm tracks) is not there yet. 132 modules, an
  estimated 143 % of the FM-1's CPU.
- **Algo Four XL is the Yamaha DX100's parameter list** (#359), named as its display names them. The operators' 14
  parameters show one operator at a time under an "op" row, with one picker for all fourteen. LFO wave (SAW UP,
  SQUARE, TRIANGLE, S/HOLD: the DX100's four, in its order), LFO sync, porta mode, foot sw and each operator's on-off
  and AMS on-off are named switches. Card rows: 152 → 139 (the main card 91 → 80). The algorithm row moves one
  Selector per route in each voice, in place of a sequencer, a sample and hold, 7 comparators, 6 logic gates and 9
  path VCAs per voice. All four operators run on the new Rate Env with the original control ranges, and on the new
  Ratio module with the DX100's 64 frequency ratios and seven signed detune positions; saved oscillator tuning is
  unchanged. LFO SYNC starts the wave at its peak, and LFO SPEED covers the DX100's 0.0008 to 55 Hz. LOW / HIGH / KON
  pitch bend works, and breath and foot-switch MIDI controllers arrive directly. It plays eight voices. It still does
  not fit the FM-1: 117 → 101 modules (of 64), 6,221 → 6,349 patch bytes (of 3,840), and at its eight voices an
  estimated 646 → 480 % of the CPU.
- **Hera 6 XL's card is the Juno-106's panel** (#359): one row per control of the owner's manual, named as the panel
  names it. Range (16', 8', 4'), PWM mode (LFO / MAN), pulse, saw, HPF (0 to 3, 0 the bass boost), VCF polarity, VCA
  mode (ENV / GATE), chorus (OFF, I, II) and the portamento switch are named switches; one PWM slider sets the width
  on MAN and the depth on LFO. Card rows: 61 → 49 (the main card 41 → 33). Decay and release reach 12 s, as on the
  Juno-106. The hold pedal is MIDI sustain (CC 64): values 64 to 127 hold the sounding voices and 0 to 63 release them
  ([D-471](docs/ledger/link-and-midi.md#D-471)). FM-1 CPU estimate: 196 → 181 %, still too much for the FM-1.
- **Oracle V XL:** the original's rEL / HLd pedal modes on MIDI sustain (CC 64), a named OFF / ON Release switch, and
  a unison voice count of its own: detune and the manual chord offsets apply only in unison. Chord memory is one
  Selector per voice: `chord 2` to `chord 5` set each voice's interval above the key, not above the chord note before
  it. FM-1 CPU estimate: 425 → 402 %.
- **8 Lire XL and Meridian 8 XL show their original panel controls** (#359): 8 Lire XL has 47 rows instead of 141,
  Meridian 8 XL 107 instead of 146, including its nested cards. Their patch points remain assembly ports. 8 Lire XL's
  plates are one repeating Drum map, which holds each plate's velocity, so its 32 velocity VCAs and 8 S&Hs are gone
  (185 → 142 modules); a plate held on two keys keeps its own velocity instead of adding the two.
- **8 Lire XL and Hera 6 XL keep their Pad, Pluck and Wet presets after the card changes.** The variations use the
  panel controls: FAST and SHARP on 8 Lire, and chorus II on Hera.
- **909 Kit XL groups the original drum controls on its cards** (#359): 30 rows instead of 43. FLAM, SHUFFLE and SCALE
  use named choices. FLAM defaults to about 22 ms (position 4); it was 24 ms.
- **Elvira 2 XL:** its choices (programs, chords, filter types, tunings, LFO waves, reverb, tune follow, MODP
  chaining) are Selectors in place of comparator and Crossfader chains (702 → 475 modules). BITMANGLER uses the new
  signed audio XOR; the original instrument's exact mask sequence is unverified. It plays a test phrase slightly
  louder than before (peak 0.50 → 0.54).
- **Perun 4 XL:** its tracks reach the PERKONS' ÷8 and x4 rates (1/2 and 1/64) and the new play modes on each voice
  track; the modulation LFO syncs x8 to ÷8 (`mod mult`), and the BBD syncs to 1/32, 1/2T, 1/2D, 1/1T and 1/1D (`sync
  note`). Its switches (algorithm, mode, VCF, groove, LFO wave, chord) are Selectors: they step from one position to
  the next and no longer blend two. It sounds the same at every switch position. 345 → 268 modules; FM-1 CPU estimate
  402 → 317 %, so it stays an XL.
- **Spokes 6 XL** gains what the new ranges make possible: swing to 80 % and the 1/8X scale (Steps 1/2), the LFO's
  start phase, backward speed, slow and fast ranges and synced speeds /8 to x8, synced retrigs down to a 1/128 triplet
  and an INF retrig length, a delay `note` row and `swell` (feedback to 1.98), and a reverb `freeze`. Each track's
  machine choice is one Selector in place of ten comparators: 836 → 782 modules. The sound as shipped is the same.
- **How fast the XLs render** (Node on an Apple M3 Max, four notes held, transport running, 3 s rendered, as a share
  of real time): Elvira 2 XL 41.1 → 32.2 %, Perun 4 XL 21.1 → 21.5 %, 8 Lire XL 11.5 → 11.9 %, Spokes 6 XL
  65.4 → 65.3 %.

### Steps

- **Pattern memory and songs.** A Steps track holds up to 64 patterns, each with its own length and rate or the
  track's, saved in the patch. The patch has one selected pattern: while playing, each track switches at the end of
  its own pass; stopped, at once; a track without that pattern plays its first. Songs chain patterns: up to 8 songs of
  up to 64 entries, each a pattern and a shift of up to an octave either way (tracks that play a Drum map are never
  shifted). A song loops, and PLAY starts it at its first entry. The patterns and songs are written only when a patch
  has some, with 16-bit note words where a pattern allows (half the bytes of the usual 32-bit ones), so a patch
  without them takes no more bytes. The FM-1's note pool holds 1,536 notes per patch (512 in 1.4.2). Tested on the
  host and in the emulator.
- **Patterns and songs on the FM-1.** PRESET on the SEQ page picks the patch's pattern (1 to 64): while playing, each
  track takes it at the end of its pass, and the top bar shows both numbers (`P03>P04`) until then; stopped, it
  changes at once. Tapping SEL on the SEQ page opens the new SONG page: one row per entry, K1 sets the entry's pattern
  (on END it adds one, FX + K1 inserts a copy), K2 its shift, K4 switches between the song and the pattern, ALGO picks
  song 1 to 8, SEQ + REC deletes an entry (asked first).
- **Patterns and songs in the editor.** Each Steps card and the piano roll have a pattern strip (‹ P01 ›, or `[` /
  `]`) that picks the patch's pattern, blinks while a track waits for the end of its pass, sets a pattern's own length
  and rate, copies every track's pattern to the next empty one and clears this track's. SONG opens a songs drawer:
  tabs 1 to 8, a pattern / song switch, entries with a pattern and a shift to add, insert, delete and drag, the entry
  playing highlighted. The editor follows the FM-1's choices and edits them over the link.
- **Play modes:** backward, ping-pong and random alongside forward. Swing and live recording follow the visited steps.
  A note near the end of the grid can last up to 64 steps, so a note at step 64 still lasts its full length when the
  track plays backward.
- **Two more rates and more swing.** A track also runs at 1/2 (eight times slower than 1/16, the Model:Cycles' 1/8X
  and the PERKONS' ÷8) and at 1/64 (four times faster than 1/16), and its swing goes up to 80 % (75 % before), on the
  card, in the roll and on the FM-1's SEQ page. Cables and macros into rate and swing still cover 1/4 to 1/32 and 50
  to 75 %, so every patch made before plays exactly as it did.
- **A Drum map can repeat its rows across the keybed** (its new REPEAT switch, off by default), so every key plays a
  row. Rows on white keys repeat in blocks of white keys, and a black key plays the row of the white key below it:
  rows on F3 to F4 come again from G4 and below E3. On the FM-1, the keys that play nothing on a Drum map (the white
  keys and black keys 9 to 11) then play a row too. Not yet played on a device.

### Modules

- **New: the Selector.** One stepped row (1..8, or a cable: 0..1 covers the positions in use) picks one of eight
  inputs, each with a value added (with nothing patched in, it is a table of eight values), and raises that position's
  gate, so one choice can switch several things at once. An optional crossfade (up to 100 ms) avoids clicks. It costs
  about 0.2 to 0.3 % of the FM-1's CPU, plus about 0.1 % per gate cabled (the CPU model's figures). In the browser a
  Selector writes only the gates that are cabled (or watched), as the FM-1 does.
- **New: Phase distortion** (PD Osc on the FM-1), after the Casio CZ: all eight CZ waveforms (saw, square, pulse,
  double sine, saw-pulse; resonance I, II and III) with a DCW amount and input, a second waveform on every other
  cycle, the resonance's range, `pm` and `sync`. High notes stay clean: the bend is held back as the note rises. One
  module plays what took Cassia 1 XL about 60 modules per line. About 4 % of the FM-1's CPU per copy as Cassia 1 uses
  it (estimate).
- **New: Env 8, an eight-step envelope** after the Casio CZ's: eight levels and rates, a sustain step that holds while
  the key is down (the key's release jumps to the step after it) and an end step where it rests. With the sustain off
  it runs through like a one-shot. Its card draws the shape; on the FM-1 it has five pages (two steps a page, then
  sustain and end). About 1.2 to 1.4 % of the FM-1's CPU per copy (estimate).
- **New: the Follower,** after the Korg MS-20's External Signal Processor: it turns any signal into a pitch (in
  octaves, like the keyboard's), an envelope and a trigger, with the ESP's signal level, low cut, high cut, cv adjust
  and threshold. On the FM-1 it hears only what a patch makes.
- **New: Ratio,** the DX100's 64 frequency-ratio choices as a pitch offset.
- **New: Rate Env,** with the original attack / decay / release rates, zero-rate holds, keyboard rate scaling and
  pedal hold.
- **Longer and wider ranges on five modules,** on the FM-1 too (#351). Each is a new row whose default plays as
  before:
  - **ADSR `long`:** decay and release times 2.4 times as long, up to 12 s and 19.2 s (the Juno-106 reaches 12 s). The
    ADSR also has a hold input that defers the release and still lets new notes attack, for MIDI sustain.
  - **LFO:** `phase` sets where a reset or a clock restart starts the wave (90 degrees starts a sine at its peak, as
    the DX100). `range` slow divides the rate by 25 (down to 0.0008 Hz), fast doubles it (up to 80 Hz), and wide has a
    continuous rate of its own from 0.0008 to 55 Hz ([D-445](docs/ledger/modules.md#D-445)). The rate row shows the
    rate the LFO runs at, on the card and on the FM-1; the knob's range is unchanged
    ([D-372](docs/ledger/engine.md#D-372)). `dir` back runs the wave backward (a saw falls). `mult` makes a synced
    cycle up to 8 times longer (/8) or shorter (x8): a 1/16 triplet at x8 is a 1/128 triplet, for fast synced retrigs.
    A new shape input sweeps the wave from falling saw through triangle to rising saw and changes the pulse width, and
    a pulse output plays at the same time.
  - **Delay:** `note` gives the synced delay 1/32, 1/2T, 1/2 dotted, 1/1T and 1/1 dotted in place of the time knob's
    length. `swell` scales the feedback up to 1.98 (the Model:Cycles' 198) with a soft clip in the loop, so the echoes
    grow to about full level and hold there.
  - **Reverb `freeze`:** an infinite decay. The tail holds and nothing new goes in; the dry sound still passes.
  - **Pulse `inf`:** the window stays open until it is switched off (the Model:Cycles' INF retrig length).
- **Multimode filter:** an `hp6` output, a resonant high pass that falls 6 dB per octave below the cutoff, after the
  Korg MS-20's. A self-oscillation switch (`osc`, off by default): on, it rings a steady sine-like tone at its cutoff
  near full resonance, as the MS-20's filters do at full PEAK, even with nothing on its input
  ([D-371](docs/ledger/engine.md#D-371)).
- **Oscillator:** sharktooth (a triangle / saw hybrid) and reverse saw, including unison, sync and phase modulation.
  Existing waveform indices and parameter-input ranges stay unchanged.
- **Ladder:** an audio-rate cutoff input for oscillator-speed filter modulation. Its existing cutoff input keeps its
  block-rate behaviour for saved patches.
- **Voicing:** a separate number of voices to stack in unison, keeping the polyphonic count. SHARE spreads the voices
  across held notes, like the Jupiter-4's UNISON II; both engines keep all 128 held MIDI keys. Lowest and highest
  held-voice gates. A key-press trigger. Voice stealing can be turned off, and the rotation can reset to voice one
  once all keys are released. Both engines and the FM-1's device pages support these settings; older patches keep
  their allocation.
- **Arpeggiator:** a continuous rate input in hertz, with zero to pause; an external clock takes precedence. Its CPU
  estimate includes note scheduling.
- **Main** has breath (CC 2), sustain (CC 64) and foot switch (CC 65) as separate patchable outputs, in the browser
  and on the FM-1.
- **Random** has a `clock` input and a `held` output: each rising edge draws an independent random voltage for that
  instance, held until the next edge. Existing fixed and wandering outputs keep their sound.
- **Math** adds signed 16-bit audio XOR.
- **Wavetable** adds the EML COLOR bank (see Vernon 100).

### The editor

- **The editor has its own address: [matryoshka.lol](https://matryoshka.lol/).** The browser keeps the editor's data
  separately for each address. If you used matry0shka.pages.dev, it keeps working, and a bar at the top offers **Move
  them there**: one click opens matryoshka.lol and brings your patches, FM-1 bank, library, tutorial progress and
  settings along, without replacing anything already there. A toast lists what came over. If you never used it, a
  matry0shka.pages.dev link opens at matryoshka.lol instead, with its patch. The command palette has **Move to
  matryoshka.lol** there, and **Save browser backup** everywhere: a .json file of all of it, which **Load .json** reads.

- **One card row can set several modules at once** (#357). In pick mode, "one row with…" joins a row to another of the
  same range: turning it moves both (two filters' cutoff, say), and so do a cable or a macro on it, a card preset and
  the FM-1's knob on its page. "split" gives each its own row again. A row that sets several shows ×2, ×3 … after its
  name. Host-tested (`tools/panel_test.sh` turns such rows), not yet on a device.
- **A Selector's positions can have names** (#358): pick mode's "names" on a card row of its position, such as SAW,
  SQUARE, PULSE. The card, the Selector's own card, Main's knobs and the FM-1's page show the names (in capitals on
  the FM-1). The position row offers only the positions in use (1 to its count), on the card, the knobs and the FM-1.
- **Controls the original edits one at a time can show one at a time** (Arrange mode's "⧉ one at a time"): for example
  the Casio CZ's eight envelope steps become one rate and one level under a "step" row. The FM-1 gives each copy a
  page, and copies of card controls can span several FM-1 pages. Algo Four XL uses it for its operators.
- **Tutorial reference patches** receive newly added module defaults when opened. Patch previews no longer let
  undisplayed module rows squeeze neighbouring controls.

### On the FM-1's screen

- **The SEQ page opens with about half the screen traffic,** so it appears sooner while the sequencer plays. SEQ or
  SEL from a Steps track's device page drew the SEQ page twice (and the device page's header first). Opening the SEQ,
  SONG and menu pages cleared the screen twice, and a whole SEQ page cleared the ground under the cells it then
  painted over. Host pixel counts (`tools/panel_test.sh`, Elvira 2), not yet measured on a device: SEQ from a Steps
  track's device page 242,832 → 76,248 px; SEQ from another device page 147,576 → 76,248; the SONG page 136,664 →
  83,864; ENV 118,592 → 68,672; the menu 166,922 → 114,122; one whole SEQ page 86,616 → 68,088. The screen looks the
  same.

### Speed and memory

- **Lower CPU use.** Modules without parameter modulation copy their settings directly, and other modules skip
  parameters with no routes. FM sine operators skip unused feedback and waveform selection work, and polyphonic
  modules reuse shared control averages. Math and Logic calculate only the selected operation when one output is
  connected. The Ladder skips audio-rate checks when its FM input is unpatched, and Selectors and gain modules skip
  constant or unity-gain cases; the CPU estimate tells the cheaper fixed gains apart from other or modulated gains.
  Each step was checked bit-identical on every audio kit and mode change (`tools/engine_exact.sh`). The estimate for
  factory patches whose design did not change: Algo Four 80 → 56 %, Spokes 6 85 → 72 %, Hera 6 71 → 67 %, Expander S
  54 → 50 %, Simple FM 17 → 13 %. Not measured on a device as before and after.
- **FM-1 memory.** Each module takes only the parameter slots its type needs, from a shared store of 1,536 values,
  instead of room for the largest module's (18, with Env 8), which would have taken about 9 KB more; the editor's
  budget shows the new "parameter values" line, and no factory patch uses more than 798 of them (Io 4). Page rows that
  set several parameters take 1,280 bytes more and 916 bytes more firmware. The engine's state grows from 18,800 to
  31,512 bytes, most of it the note pool for patterns. In all, the pool goes from 381,038 to 399,638 of 417,792 bytes
  (the stand-in estimate, `tools/pool_sizes.sh`). A Steps track costs 12,644 → 14,282 cycles per block
  (`npm run cpu-costs`, host build).

### Compatibility

- **Patches saved on the FM-1 before this release still load and sound the same.** New parameters take their defaults
  in them, and saving such a patch again stores it in the new format. The editor writes a patch in the lowest format
  that holds it, so a new parameter, the filter's `osc` switch or patterns cost FM-1 bytes only in patches that use
  them ([D-281](docs/ledger/patch-format.md#D-281)). The editor checks which patch formats the firmware reads before
  syncing, and it tells an FM-1 on an older firmware to update; older firmware keeps its existing compatibility check.

## 1.4.2 — 2026-10-26

- **Incoming MIDI notes keep playing while the FM-1 screen redraws** (#363). USB and TRS notes and clock are taken
  between screen transfers, including octave messages. This fixes short notes disappearing or arriving together
  when turning SELECT or ALGO or pressing octave buttons. On the exact release package, the test rig played all
  50 notes during page changes and all 200 during octave changes at 20 ms spacing. Note spacing matched idle
  playback. See the [release measurements](docs/measurements/2026-10-26-1.4.2.md).
- **Cassia 1 joins the FM-1 factory patches.** This is the patch already published in the 1.4.1 browser, now included
  in the firmware's factory set. Existing banks stay intact; Cassia can still be sent from the editor.
  The browser keeps its 1.4.1 patches and features. The firmware engine and patch format stay
  at 1.4.0's, with the MIDI redraw fix applied.

## 1.4.1 — 2026-10-26

Web only: the FM-1 firmware is 1.4.0's. New factory patches now ship in the browser first; the FM-1 gets them as
factory patches with its next firmware release.

- **A new engine, Cassia 1,** after the Casio CZ-1: phase distortion. Each voice has the CZ's two lines: line 1 sweeps
  from a sine to the CZ saw or square, line 2 is the CZ's resonance waveform, a resonant peak that sweeps. Each line
  has its DCW envelope, with one DCA envelope, line mix, line 2 detune, key follow, velocity and vibrato. Three voices on the
  FM-1 (75 % of its CPU, estimated). Its factory patch is in the browser now and comes to the FM-1 with the next firmware
  release; until then, send it to the FM-1 over the editor link.
- **Cassia 1 XL** in the browser: all eight CZ waveforms (saw, square, pulse, double sine, saw-pulse; resonance I, II
  and III) and a second waveform on every other cycle, both lines with their own DCW and DCA envelopes of six steps
  (the CZ has eight), the 1+1' line mode, a pitch envelope, ring and noise modulation, vibrato with delay, key follow,
  velocity and aftertouch. Four voices with two lines, as the CZ-1; eight with one.
- **Every XL now has its original's whole panel**, after the original's manual; what is still missing is listed in the
  XL's notes with the reason (a module we do not have yet, hardware, or samples). Among the additions:
  - **Oracle V XL:** saw, triangle and pulse on oscillator B, the Rev 3 filter, velocity and aftertouch, unison detune,
    chord memory, the release switch, the Vintage knob.
  - **Hera 6 XL:** the DCO range, PWM mode, key transpose, bender amounts, portamento, assign modes, hold.
  - **Expander S XL:** eight SEMs, each with its own knobs, and the Eight Voice keyboard (split, unison, portamento).
    An "all SEMs" section at the top moves each control on all eight at once, keeping their differences.
  - **Algo Four XL:** one algorithm row (1 to 8), velocity, level and rate scaling, LFO delay and sync, portamento,
    pitch bend range, key shift.
  - **8 Lire XL:** the FAST switches, touch (velocity and pressure per plate), the rear jacks as inputs.
  - **Elvira 2 XL:** all eleven MOD programs, twelve filter types, the reverb, the ATT and ADD utilities, the jacks.
  - **Meridian 8 XL:** mute and CV mute buttons, nine LINK buttons, the touch plates, individual outputs.
  - **Perun 4 XL:** the LFO on any knob, CONTROL ALL, CHORD and DIGITAL NOISE modes, four sequencer tracks with
    chance, groove and fill, the BBD's controls and the compressor.
  - **909 Kit XL:** mid tom, crash and ride, TOTAL ACCENT and per-drum accent, flam, shuffle and scale.
  - **Spokes 6 XL:** all six machines on every track, chance, fill lanes, retrigs, the LFO on any destination,
    velocity routes, pads.
- The XLs are heavier in the browser. With four notes held, in Chrome on a recent Mac, as a share of real time:
  Spokes 6 XL 61 %, Cassia 1 XL 39 %, Elvira 2 XL 37 %, Expander S XL 23 %, the others 6 % to 20 %. Big XLs share as a
  stored link.

## 1.4.0 — 2026-10-25

- **A new engine, Spokes 6,** after the Elektron Model:Cycles: six FM tracks (kick, snare, metal, perc, tone, chord),
  each with pitch, decay, color, shape, sweep and contour, plus volume and a delay send. Its factory patch comes last,
  after <7PH: three Steps tracks (DRUMS, TONE, CHORD) play a 16-step groove in A minor at 120 BPM, and the keys play TONE.
  It estimates 85 % of the FM-1's CPU (not yet measured on a device).
- **Spokes 6 XL** in the browser: the same with a reverb, stereo pan, distortion and an LFO per track, and phase
  modulation on the snare and metal. It is a sandbox patch (146 % of the FM-1's CPU).

## 1.3.5 — 2026-10-25

Web only: the FM-1 firmware is 1.3.3's.

- Arrange mode is redone. Each heading and its pages sit in a faint outline, each FM-1 page in a fainter one with its
  own ⠿ handle, and the heading field shows the FM-1's name for its pages, "filter (FILTER)". A drag shows one line where
  it will land: a row can go to the start, middle or end of any page that has room, a page anywhere between pages, a
  section to the top of any column. Moving things never reshuffles the other pages.
- Arrange mode: + heading under any section or at the top of a column, and + page break between any two rows of a page;
  a page break you added has a × to join the pages again. A heading keeps its place when you move all its rows away, and
  is saved with the patch (the FM-1 and the normal card skip it).

## 1.3.4 — 2026-10-25

Web only: the FM-1 firmware is 1.3.3's.

- An assembly made of assemblies keeps the names they gave their controls and jacks: promoting a nested
  "hold pitch" slider onto the outer card shows "hold pitch", not the Macro's "value".
- A control promoted from a nested assembly lands under a heading named after it and its page there ("Lire 5-8",
  label "hold"), next to the other controls from that page. Factory assemblies and saved patches are unchanged.

## 1.3.3 — 2026-10-25

- Syncing with an FM-1 on firmware older than 1.2 now says to update it (with a button to the install panel),
  instead of failing with "the firmware refused the patch".
- The sidebar stays the same in Patch, Emu and Library; Get started, Audio on / Panic and MIDI are there in all three.
  Library's Patches, Assemblies, Presets and Community are tabs at the top. The logo takes you back to the canvas.
- 909 Kit XL has an arpeggiator (ARP, off until pressed) between its DRUMS track and the drum map, like every other XL.
- Make assembly (Ctrl/Cmd+G) works on a selection of assemblies alone: group two engines into one and promote just
  the controls you want.
- Emu: muting a track on a synced FM-1 (SEQ + a black key) now blinks that key on the emulator too, and letting go of
  SEQ no longer flips the emulator to the SEQ page.
- 8 Lire and Elvira 2 (and their XLs) call their piano roll rows VOICE 1, VOICE 2, ... instead of KICK, SNARE, ...;
  the browser's roll and the FM-1's SEQ page now show the same names on the same notes.

## 1.3.2 — 2026-10-25

Not released on its own: it ships in 1.3.3.

- FM-1: the footer's octave (= OCT =, OCT +, - OCT) changes as soon as you press OCT- / OCT+, not only once something
  else redraws the screen.

## 1.3.0 — 2026-10-24

### On the literal physical FM-1 device

- Big ol UI overhaul: 
  - Paging through params is 6x faster. 
  - Knobs respond 29x faster (lol). 
  - You no longer need a jeweler's loupe to know your current patch, device, or assembly. 
  - The UX on the FM1 sucked shit before -- sorry about that! I got swept up in patch editor feature creep and briefly forgot what my job was
 - CPU cycles down 8-13% on the FM-1; audio output is bit-identical to output before optimizations

### In the browser

- **SANDBOX MODE BABY!!!** If a patch is too big for the FM-1, the FM-1 becomes its
  controller as if it did fit on the device. 
  - I find that starting with something excessive and ambitious, then accommodating constraints later, results in cooler stuff than building reasonably for the jump, and the patch editor now suits that kind of workflow.
- **XL patches:** Every factory patch modeled after a synth whose architecture was too beefy to fit on the FM-1 now gets a browser-only version that is faithful to the OG architecture.
- **Community patches!!!** have their own Library section!!! Send me your most depraved patches, sickos!!!
- **MIDI clock out:** the editor can now keep multiple connected FM-1s in sync. Clock stopgap while I figure out Bluetooth vs GPL friction. I now understand why baudgirl is not FOSS 
- **OCT- / OCT+ on the FM-1 move the editor's octave too,** so the on-screen keyboard shows what you play.
- The FM-1 budget no longer reads a patch with an arpeggiator as half full. Now it reads it as half empty


## 1.2.2 — 2026-10-24

- **"update failed -5" explained:** the FM-1 was set up by M-VAVE's Official Open, and nothing was changed.
- **Sol 29N:** a new community patch after the Elta Music Solar 42N, playable on the FM-1.

## 1.2.1 — 2026-10-23

- **A refused return to V15 now says why,** and how to get back: nothing was erased.

## 1.2.0 — 2026-10-23

- **Presets:** store an assembly's values as a named preset and load it into any copy, in the editor and on the FM-1.
  Every factory engine comes with its own.
- **The environment page on the FM-1:** ENV lists every device in the patch, to pick, turn and open.
- **Arm several devices at once** to layer them on the keys, in the editor and on the FM-1.
- **Three new engines:** Scrounge, Meridian 8 and Perun 4, after the neutral labs Scrooge, the Landscape NOON and the
  Erica Synths PERKONS HD-01. Plus **<7PH**, a groove box patch.
- **An arpeggiator and a PATTERN track on every melodic factory patch,** on ARP.
- **A piano roll and a drum grid on the FM-1's SEQ page.**
- **The 909 Kit plays all eight rows:** five were silent.
- **No key press is lost while the FM-1's screen redraws.**
- **A battery gauge on the FM-1.**
- **New navigation:** PATCH | EMU | LIBRARY, and a Library that shows the browser and the FM-1 side by side.
- **Lire + Elvira,** the first community patch.

## 1.1.0 — 2026-10-22

- **Two new engines:** 8 Lire and Elvira 2, after the SOMA Lyra-8 and the neutral labs Elmyra 2.
- **Modules are named after the hardware they stand for:** Attenuverter, Slew limiter and so on. Patches load as before.
- **Share links keep big patches whole.**
- **With Live on, FM-1 knobs no longer make values jump.**

## 1.0.0 — 2026-10-21

The first release: a modular patch editor in the browser, and a firmware that turns the M-VAVE FM-1 into a player for its
patches.

- **44 module types,** and **assemblies** that make any group of them one card. 61 come with the editor.
- **17 factory patches,** from an init patch to instrument recreations and two drum kits.
- **Polyphony** of up to 8 voices on the FM-1, and **Steps** sequencer tracks of up to 64 steps.
- **The FM-1 plays your patches:** 64 slots, SELECT and ALGO page through the devices, K1..K4 turn the page in focus.
- **Live sync over USB:** edits, knobs and buttons go both ways.
- **USB MIDI and audio:** notes, CC and clock in, every control out, and the FM-1 as a 2-channel recording device.
- **Install and return to stock** from the browser.
- **Coming from Felucca:** installing overwrites Felucca's saved projects and samples. Save them first.
