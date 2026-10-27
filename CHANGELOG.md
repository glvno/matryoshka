# Changelog

## Unreleased

- Algo Four XL uses one operator picker for all fourteen operator controls. Copies of card controls can span multiple FM-1 pages.

- Io 4 can share its four voices across held notes like Jupiter-4 UNISON II. Choose SHARE on its unison row. Both engines retain all 128 held MIDI keys.

- Voicing can stack a separate number of voices in unison while preserving its polyphonic count. Oracle V XL exposes this count and applies detune and manual chord offsets only in unison.

- Voicing adds lowest/highest held-voice gates. Algo Four XL uses them for LOW/HIGH/KON pitch bend and now receives breath and foot-switch MIDI controllers directly.

- Tutorial reference patches receive newly added module defaults when opened. Patch previews no longer let undisplayed module rows squeeze neighboring controls.
- Voicing can disable voice stealing and reset its rotation to voice one after all keys are released. Both engines and device page rows support these settings. Older patches retain their allocation behavior.

- Wavetable adds an EML COLOR bank, used by Vernon 100: triangle through sloped square, square and saw to double saw an octave higher.

- Arpeggiator has a continuous rate input in hertz, with zero to pause and external-clock precedence. Its CPU estimate now includes note scheduling.

- Voicing adds a key-press trigger. Wanderer and Wanderer XL retrigger their envelopes for every key press, including a note between two held notes, and no longer retrigger when releasing an outer note.

- Math adds signed 16-bit audio XOR. Elvira 2 XL uses it for BITMANGLER; the original instrument's exact mask sequence remains unverified.

- LFO adds a shape input and a simultaneous pulse output. Sallen 20's modulation-generator WAVEFORM knob now sweeps continuously from falling saw through triangle to rising saw and changes the pulse width.

- Ladder skips audio-rate checks when its FM input is unpatched. Selectors and gain modules avoid work for constant or unity-gain cases. All 150 audio kits and mode transitions remain bit-identical; CPU estimates distinguish the cheaper fixed gains from other or modulated gains.

- Monolith D has all six waveform positions on each oscillator, including the triangle/saw hybrid and oscillator 3's reverse saw. FILTER MODULATION uses Ladder's audio-rate input.

- Factory generation keeps Io 4's arpeggiator-only setup and four voices: the rig sheds a voice with an added PATTERN track despite its modeled fit.

- Oscillator adds sharktooth (a triangle/saw hybrid) and reverse saw, including unison, sync and phase modulation. Existing waveform indices and parameter-input ranges stay unchanged.

- Math and Logic calculate only the selected operation when one output is connected. The instruction model counts another 3% less work for Io 4, with all 134 audio kits unchanged.

- Ladder has an audio-rate cutoff input for oscillator-speed filter modulation. Its existing cutoff input retains its block-rate behavior for saved patches.

- Main exposes breath (CC 2), sustain (CC 64), and foot switch (CC 65) as independent patchable outputs in the browser and on the FM-1.

- FM sine operators skip unused feedback and waveform selection work. Polyphonic modules reuse shared control averages. The instruction model counts 28% less work for Algo Four and 5% less for Io 4; all 130 audio kits and mode-change checks remain bit-identical.

- Morph leaves modules without a B side untouched on the FM-1, matching the browser (#355). Format 36 records which modules morph; older bank records retain their playback when loaded and upgraded.

- Random has a `clock` input and a `held` output: each rising edge draws an independent random voltage for that instance, held until the next edge. Existing fixed and wandering outputs keep their sound.

- **Lower CPU use for parameter updates.** Modules without parameter modulation copy their settings directly;
  other modules skip parameters with no routes. The instruction model counts about 3.5 % less work across its
  checks, with all 128 audio comparisons bit-identical. Device measurements are pending.
- **8 Lire XL and Hera 6 XL keep their Pad, Pluck and Wet presets after the card changes.** The variations use
  the panel controls: FAST and SHARP on 8 Lire, and chorus II on Hera.
- **8 Lire XL and Meridian 8 XL show their original panel controls** (#359). 8 Lire has 47 rows instead of 141;
  Meridian has 107 instead of 146, including its nested cards. Their patch points remain assembly ports.
- **909 Kit XL groups the original drum controls on its cards** (#359): 30 rows instead of 43. FLAM, SHUFFLE
  and SCALE use named choices. FLAM now defaults to about 22 ms (position 4), previously 24 ms.

- **Inserted assemblies keep their macro ranges** (#367). Saving and inserting an assembly no longer turns a bounded
  macro control into ordinary added modulation. Each inserted copy keeps its own ranges. A round-trip test checks
  both the rendered sound and that editing one copy leaves the others unchanged.
- **The patch-bytes budget counts the panel buttons' record.** A patch whose ARP, FX or LFO button is not a plain gate
  sends 9 more bytes than the editor counted, so one within 9 bytes of the 3,840 limit passed the budget and was then
  refused by the FM-1. The budget now equals what is sent (Oracle V: 1,290 → 1,299 bytes).
- **Monolith D has the Minimoog Model D's panel.** Its card now holds the original's controls under their names:
  TUNE and a half-octave PITCH wheel, GLIDE with its on / off switch, OSCILLATOR 3 CONTROL (oscillator 3 off the keys,
  for a slow modulation source), RANGE as the six footages LO to 2', WAVEFORM as triangle, saw, square, wide and narrow
  rectangle, the WHITE / PINK switch, KEYBOARD CONTROL off, 1, 2 or both, the DECAY switch (each contour's release takes
  its decay time, or the note stops at once) and the A-440 tone. The modulation switches now switch, and the modulation
  mix comes from oscillator 3 and the noise before the mixer's volumes, so a silent noise or a quiet oscillator 3 no
  longer weakens it. Filter modulation no longer depends on the contour amount. Gone: the drive, release and scope rows,
  which the original lacks. The switches show their positions by name (LO .. 2', TRIANGLE .. NARROW RECT, OFF / ON).
  Still missing: the shark tooth and reverse saw waveforms and the external input. The patch takes 37 modules (18
  before), 3,053 patch bytes (1,371) and an estimated 35 % of the FM-1's CPU (22 %). Host-tested only, not yet on a
  device.
- **Silver Box accents like a TB-303.** An accented note (velocity 115 or more, a Steps accent) runs the filter
  envelope at its shortest decay, 200 ms, and that envelope times ACCENT lifts the level and, through the accent sweep
  circuit, the cutoff. At high RESONANCE the sweep is smoother and builds up over consecutive accents, as the original's
  second resonance gang does. ENV MOD no longer scales the accent. The soft clip after the filter is gone (the 303 has
  none), and so are the slide, drive and amp decay rows: the slide time and the volume envelope's decay are fixed, as on
  the original. TUNING is now the oscillator's fine tune (±1 semitone; the original's reaches ±5). The patch takes 17
  modules (14 before), 928 patch bytes (885) and an estimated 19 % of the FM-1's CPU (17 %); <7PH 63 modules (60),
  3,831 bytes of 3,840 (3,788) and 68 % (66 %). The patch's Steps track is its sequencer; the 303's 64-pattern memory,
  pattern chaining with transpose and song mode are still missing. WAVEFORM still offers the oscillator's four waves:
  a saw / square switch does not fit <7PH's patch bytes. Host-tested only, not yet on a device.
- **Sallen 20 is the MS-20 as it plays with nothing patched.** The highest held key plays (the MS-20 mini's manual), VCO
  1 and 2 have SCALE as footages and their own WAVEFORM switches (VCO 1's noise, VCO 2's narrow pulse and ring modulator
  in place of the ring row), MASTER TUNE, EG 1's DELAY and EG 2's HOLD are new, and each filter has its own MG/T.EXT and
  EG2/EXT amounts (the high pass had no MG amount, and the low pass's MG depended on its EG amount). The MG's frequency
  modulation now reaches the oscillators' pitch, not just their fine tune. The soft drive after the low pass is gone.
  The patch panel's sections are there as the assembly's jacks, to patch in the browser: the sample and hold (white
  noise, clocked by the MG's rectangle), white and pink noise, the MVCA (EG 1 on its control), both envelopes' normal
  and reverse outputs, the control wheel (the mod wheel), the momentary switch (the FX button, labelled SWITCH), KBD CV
  and trigger, the MG's triangle and rectangle, and INITIAL GAIN (a row). Unpatched they leave the sound as it was. The
  scale and wave switches show their positions by name. Still missing: the ESP, the MG's variable waveform and the high
  pass's 6 dB slope (ours is 12 dB). The patch takes 41 modules (19 before), 2,567 patch bytes (1,440) and an estimated
  42 % of the FM-1's CPU (29 %). Host-tested only, not yet on a device.
- **Wanderer is now duophonic, as the ARP Odyssey is** (#303). The lowest key held plays VCO 1 and the highest plays
  VCO 2 (one key plays both), into one filter, one VCA, one ADSR and one AR; before, it was a two-voice polysynth with
  both VCOs, a filter and both envelopes per voice. New, after the Odyssey's panel: portamento, VCO 1's AUDIO / LF
  switch, both VCOs' FM (two depths each, each with its source switch), PWM (LFO / ADSR), sync, the S/H mixer (two
  levels and the noise / VCO 2 switch), the S/H trigger (LFO / keyboard) and OUTPUT LAG, the LFO's sine and square, the
  envelopes' LFO repeat (KYBD REPEAT / AUTO REPEAT), the VCF's three modulation sliders with their switches, the VCA's
  AR / ADSR switch, level and GAIN, the noise generator's white / pink, and the ring modulator as the Odyssey's (the two
  VCOs' square waves XORed). Main's mod wheel is the PPC's vibrato pad. The voices row is gone (the Odyssey has two).
  On the FM-1 each VCO is one oscillator, so the S/H mixer and the ring take the VCO's wave as the mixer has it, and the
  ring plays at half a VCO's level. Every switch shows its positions by name (AUDIO / LF, SINE / SQUARE ...). The names
  leave no room for the PATTERN track, so Wanderer has the Arpeggiator alone. The FM-1 patch takes 49 modules (17
  before), 3,803 patch bytes of 3,840 (1,260) and an estimated 37 % of the CPU (30 %); the engine counted on the
  emulator's instruction model 36 %. Host-tested only, not yet on a device.
- **Wanderer XL**, the whole ARP Odyssey in the browser: each VCO has its saw and pulse at once, so the S/H mixer has
  its own VCO 1 saw / square switch and the ring and S/H always take the pulses with their width; coarse is continuous
  and fine reaches the Odyssey's ±400 cents (the FM-1 version: semitones and ±100 cents). Its switches show their
  positions by name. It takes 4,572 patch bytes, over the FM-1's 3,840, so it stays in the browser. Not there: the external audio input (the engines have none), the
  pedal, footswitch and CV / gate / trigger jacks.
- **Canvas is now the Music Easel's panel** (#303): the sequential voltage source (five voltages, 3 to 5 stages, the
  pulse sequence), the envelope generator (sustained, transient or off; attack, sustain, decay), the pulser (triggered by
  the keys, itself or the sequencer), the random voltage, the modulation oscillator (three ranges, triangle, saw or square,
  FM or AM by its index), the complex oscillator (the timbre switch and pot, the folder, polarity), both lopass gates
  (lopass, combination or VCA; gate 2 from the mod oscillator or gate 1, out of phase), chan A and B, the reverb, the
  portamento, each with its trigger select or keyboard switch, named as the Easel's panel names them. The patch field
  is a fixed patch on the FM-1 (sequencer into pitch, envelope into the index and both levels, random into the timbre,
  each through its processing control). It sounds different. On the FM-1 (estimates, with its players): 16 → 53
  modules, 1,083 → 3,766 of 3,840 patch bytes, CPU 25 → 76 %. Host-tested only, not yet on a device.
- **Briefcase 3 gets the VCS3's pin matrix for its controls** (#303): columns I to P (the three oscillators' frequency,
  the envelope's decay, the reverb mix, the filter frequency, the two output levels), every source a row, each pin named
  as the VCS3's manual names it (I8, N6), on the assembly's matrix card in the editor. The keys reach the oscillators as
  on the VCS3, through input amplifier 1 (pins I8 and J8). The panel is filled in: oscillator 2 and 3's triangles and
  oscillator 3's audio range, noise colour, the filter and reverb levels, the envelope's signal and trapezoid levels (the
  trapezoid rests low and rises while on), two output amplifiers with their filters, the joystick. It sounds different.
  On the FM-1 (estimates): 18 → 64 of 64 modules, 1,347 → 3,828 of 3,840 patch bytes, CPU 39 → 89 %; its PATTERN track no
  longer fits (the arpeggiator stays). Host-tested only, not yet on a device.
- **Canvas XL** (the browser): the Music Easel with its patch field. Each control input picks its cord (MAIN, pressure,
  sequencer, envelope, pulser, random, mod cv or the inverter) through its processing control; the preset voltages and
  add to main, pressure, the pulser's once (the FX button), the modulation oscillator's three dial ranges and half-octave
  fine tunes.
- **Briefcase 3 XL** (the browser): the VCS3 with its whole 16 × 16 pin matrix, 256 pins on the card, a section per
  column (A meter to P output 2 level); the oscillators' full dial ranges, output filters flat in the middle, the pan
  knobs and the joystick's ranges.

- **Hera 6 XL's card is the Juno-106's panel** (#359): one row per control of the owner's manual, named as the panel
  names it. Range, PWM mode (LFO / MAN), pulse, saw, HPF (0 to 3, 0 the bass boost), VCF polarity, VCA mode (ENV /
  GATE), chorus (OFF, I, II) and the portamento switch are named switches; one PWM slider sets the width on MAN and the
  depth on LFO. The hold pedal is the FX button. 61 rows → 49 (the main card 41 → 33). The sound at the patch's values
  is unchanged (the same samples).
- **Algo Four XL's card is the DX100's parameter list** (#359), named as its display names them. Each operator's 14
  parameters show one operator at a time under an "op" row. LFO wave (SAW UP, SQUARE, TRIANGLE, S/HOLD: the sine is
  gone), LFO sync, porta mode, foot sw and each operator's on-off and AMS on-off are named switches. 153 rows → 137 (the
  main card 92 → 79, 37 at a time). The sound at the patch's values is unchanged (the same samples).
- **One card row can set several modules at once** (#357). In pick mode, "one row with…" joins a row to another of the
  same range: turning it moves both (two filters' cutoff, say), and so do a cable or
  a macro on it, a card preset and the FM-1's knob on its page. "split" gives each its own row again. A row that sets
  several shows ×2, ×3 … after its name. On the FM-1 each page row keeps where its extras are: 1,280 bytes more of the
  pool (384,360 of 417,792 bytes, from 383,080; the CI build) and 916 bytes more firmware (353,076). Host-tested
  (`tools/panel_test.sh` turns such rows), not yet on a device.
- **A Selector's positions can have names** (#358): pick mode's "names" on a card row of its position, such as SAW,
  SQUARE, PULSE. The card, the Selector's own card, Main's knobs and the FM-1's page show the names (in capitals on the
  FM-1). The position row now offers only the positions in use (1 to its count), on the card, the knobs and the FM-1.
- **Controls the original edits one at a time can show one at a time** (Arrange mode's "⧉ one at a time"): the Casio
  CZ's eight envelope steps become one rate and one level under a "step" row, and the FM-1 gives each step a page.
- **Cassia 1 uses the PD Osc and Env 8 modules and plays two voices on the FM-1.** Its two lines have the eight
  CZ waveforms, ring and noise modulation, and eight-step envelopes. It is an approximation of the CZ-1: the lines
  share a pitch envelope, and portamento, chorus and several per-line controls are missing. It takes 46 modules and
  3,733 of 3,840 patch bytes. Reducing three voices to two lowers the CPU estimate from 88 % to 62 %. On the test rig
  running the card-rows firmware (CI run 40406160864), its measured peak over rest and 1 / 4 / 8 held notes fell from
  2,920 to 2,219 microseconds (100.6 % to 76.5 % of a block). The three-voice run shed voices; the two-voice run did not
  mute. Its presets include Pluck.
- **Turning VOICES past available memory keeps the last playable setting.** Cassia's fifth voice could exhaust the
  engine's memory, leaving the row at −1 and the instrument silent. A failed edit now restores the patch, shows
  NO ROOM, and does not send the rejected value to the editor. Reloads pause audio processing while rebuilding the
  engine. Checked with the host panel test; firmware and device checks pending.
- **Io 4 now has the Roland Jupiter-4's panel.** Its card follows the owner's manual, one row per control: the VCO's
  range, sub oscillator, LFO mod, pulse width (four steps, manual or LFO) and waveform with OFF; noise; the high pass,
  the low pass with its 10 / 40 / 70 / 100 % key follow, LFO mod, envelope mod and polarity; a VCF envelope and a VCA
  envelope (the manual lists two ADSRs; Io 4 had one); the VCA level; the LFO's four waveforms. The modifier section is
  there too: the trigger (its rate clocks a noise sample & hold into the cutoff, and the arpeggiator when ARP is on), the
  LFO delay and LFO bend, the lever's three LFO / OFF / BEND switches with bend sensitivity and LFO depth (the FM-1's
  pitch bend and mod wheel), portamento, transpose, tuning, POLY I / POLY II / UNISON I, hold and the ensemble switch.
  Not there yet: UNISON II, which needs a new Voicing mode. The `voices` row and the ensemble's rate and depth rows are
  gone. On the FM-1 it now takes 56 modules (15 before), 3,650 patch bytes of 3,840 (1,060) and about 97 % of the CPU
  estimate (43 %), so it gets the arpeggiator but no PATTERN track. Host-tested only, not yet on a device.
- **Vernon 100 now has the EML ElectroComp 100's panel.** Its card follows the 100's panel, read from photos (no manual for
  the 100 was found; the EML 101's manuals explain the controls the two share). Four distinct oscillators: oscillator 2
  plays the lowest key held and oscillator 3 the highest, oscillator 4 follows oscillator 3, its own tuning or the mixer,
  and oscillator 1 is a slow or audio control oscillator with five shapes. The oscillator mixer and the filter control
  have their two centre-zero knobs each; the filter input mixer, white or pink noise, a 12 dB filter with low pass, band
  pass, high pass and band reject, cut octave and KB1 / KB2 tracking; two envelopes with the sustain switch; the
  amplitude shaper's envelope switch; the output mixer with oscillator 3 around the filter; keys per octave and
  portamento. The sample & hold, the pulse width rows and the LFO's width modulation are gone: the 100's panel has none
  of them. On the FM-1 it takes 60 modules (16 before), 3,829 patch bytes of 3,840 (1,087) and about 60 % of the CPU
  estimate (24 %), so it gets the arpeggiator but no PATTERN track. Host-tested only, not yet on a device.
- **Cassia 1 is now the whole Casio CZ-1, on the FM-1 too.** Cassia 1 XL rebuilt on the PD Osc and Env 8 fits the FM-1,
  so it takes Cassia 1's slot (24) and name, and the XL is gone ([D-348](docs/ledger/patches-and-presets.md#D-348)). Both lines play all eight waveforms with a
  second one on every other cycle; line select 1, 2, 1 + 2 and 1 + 1'; ring and noise modulation on line 2; DCO, DCW and
  DCA envelopes of eight steps with a sustain and an end step, as on the CZ (the six-step stand-in is gone); key follow,
  velocity, aftertouch, vibrato with a delay. The XL took 230 modules, 10,809 patch bytes and an estimated 736 % of the
  FM-1's CPU at four voices; Cassia 1 now takes 46 modules, 3,724 bytes of 3,840 and about 88 % at three voices (the
  FM-1's old Cassia 1: 21 modules, 1,618 bytes, 74 %). In the browser four voices render in about 8 % of real time
  (the XL took about 40 %), on a recent Mac. The envelope rows are short (r1, l1 .. r8, l8, sus, end) to fit the
  patch bytes. Its presets gain Pluck (the variations now reach Env 8). Host-tested only, not yet on a device.
- **Env 8, an eight-step envelope** after the Casio CZ's: eight levels and rates, a sustain step that holds while the
  key is down (the key's release jumps to the step after it) and an end step where it rests. With the sustain off it
  runs through like a one-shot. Its card draws the shape; on the FM-1 it has five pages (two steps a page, then
  sustain and end). About 1 to 1.4 % of the FM-1's CPU per copy, estimated.
- **Steps: two more rates and more swing.** A track also runs at 1/2 (eight times slower than 1/16, the Model:Cycles'
  1/8X and the PERKONS' ÷8) and at 1/64 (four times faster than 1/16), and its swing goes up to 80 % (75 % before), on
  the card, in the roll and on the FM-1's SEQ page. Cables and macros into rate and swing still cover 1/4 to 1/32 and
  50 to 75 %, so every patch made before plays exactly as it did.
- **A new module, Phase distortion** (PD Osc on the FM-1), after the Casio CZ: all eight CZ waveforms (saw, square,
  pulse, double sine, saw-pulse; resonance I, II and III) with a DCW amount and input, a second waveform on every other
  cycle, the resonance's range, `pm` and `sync`. High notes stay clean: the bend is held back as the note rises. One
  module plays what took Cassia 1 XL about 60 modules per line. On the FM-1 it costs about 2 to 4 % of the CPU per copy,
  estimated (host-tested only, not yet on a device).
- **A new module, the Selector:** one stepped row (1..8, or a cable: 0..1 covers the positions in use) picks one of eight
  inputs, each with a value added (with nothing patched in it is a table of eight values), and raises that position's gate
  so one choice can switch several things at once. An optional crossfade (up to 100 ms) avoids clicks. It costs about
  0.4 % of the FM-1's CPU, plus 0.1 % per gate cabled (the CPU model's figures, not measured on the FM-1). In the browser a Selector writes only the gates that are cabled (or
  watched), as the FM-1 does.
- **A Drum map can repeat its rows across the keybed** (its new REPEAT switch, off by default), so every key plays a
  row. Rows on white keys repeat in blocks of white keys, and a black key plays the row of the white key below it: rows
  on F3 to F4 come again from G4 and below E3. On the FM-1, the keys that play nothing on a Drum map (the white keys and
  black keys 9 to 11) then play a row too. Needs the firmware of the next release; not yet played on a device.
- Longer and wider ranges on five modules, on the FM-1 too (#351). Each is a new row whose default plays as before:
  - **ADSR `long`:** decay and release times 2.4 times as long, up to 12 s and 19.2 s (the Juno-106 reaches 12 s).
  - **LFO:** `phase` sets where a reset or a clock restart starts the wave (90 degrees starts a sine at its peak, as the
    DX100). `range` slow divides the rate by 25 (down to 0.0008 Hz), fast doubles it (up to 80 Hz). `dir` back runs
    the wave backward (a saw falls). `mult` makes a synced cycle up to 8 times longer (/8) or shorter (x8): a 1/16
    triplet at x8 is a 1/128 triplet, for fast synced retrigs.
  - **Delay:** `note` gives the synced delay 1/32, 1/2T, 1/2 dotted, 1/1T and 1/1 dotted in place of the time knob's
    length. `swell` scales the feedback up to 1.98 (the Model:Cycles' 198) with a soft clip in the loop, so the echoes
    grow to about full level and hold there.
  - **Reverb `freeze`:** an infinite decay. The tail holds and nothing new goes in; the dry sound still passes.
  - **Pulse `inf`:** the window stays open until it is switched off (the Model:Cycles' INF retrig length).
- **FM-1 memory:** each module now takes only the parameter slots its type needs, from a shared store of 1536 values,
  instead of room for the largest module's (18 with Env 8). With all of the above the engine's memory goes from 381,038
  to 383,086 bytes, where room for 18 parameters in every module would have taken about 9 KB more
  (`tools/pool_sizes.sh`, the stand-in estimate). The editor's budget shows the new "parameter values" line; no factory
  patch uses more than 564 of them (<7PH).
- **Patches saved on the FM-1 before this release still load and sound the same.** The new parameters above take their
  defaults in them, and saving such a patch again stores it in the new format. The editor needs this firmware to sync:
  it tells an FM-1 on an older firmware to update.
- **8 Lire and Elvira 2 play their plates from one repeating Drum map** in place of four copies, so every key now plays
  a plate (a black key the plate of the white key below it). On the FM-1 that saves CPU and
  memory: 8 Lire goes from 49 % to 42 % of the CPU and from 96 % to 85 % of the memory, Elvira 2 from 47 % to 40 % and
  from 69 % to 58 % (the editor's estimate; the counted engine: 328,704 to 282,338 and 310,792 to 265,742 cycles a
  block). Not yet checked on a device.
- **Algo Four XL: algorithms on Selectors, the DX100's LFO in full.** The algorithm row now moves one Selector per
  route in each voice, in place of a sequencer, a sample and hold, 7 comparators, 6 logic gates and 9 path VCAs per
  voice: 117 modules become 94, and the sound of every algorithm is unchanged (measured sample by sample against the
  previous version). LFO SYNC now starts the wave at its peak, the LFO wave row follows the DX100's order (1 saw up,
  2 square, 3 triangle, 4 sample and hold, 5 sine), and a new `lfo range` row reaches the DX100's 0.0008 to 55 Hz.
  It still does not fit the FM-1: at the FM-1 version's three voices it needs 94 modules of 64, 172 module instances
  of 128, 5,629 patch bytes of 3,840 and an estimated 235 % of the CPU (270 % before), so it stays an XL (at its own
  eight voices: 569 %, 641 % before).
- **Perun 4 XL on the new modules:** its tracks reach the PERKONS' ÷8 and x4 rates (1/2 and 1/64), the modulation LFO
  syncs x8 to ÷8 (`mod mult`), and the BBD syncs to 1/32, 1/2T, 1/2D, 1/1T and 1/1D (`sync note`). Its switches (algorithm,
  mode, VCF, groove, LFO wave, chord) are Selectors: they step from one position to the next and no longer blend two.
  345 modules before, 268 after; it sounds the same at every switch position. In the browser (Chrome, transport running,
  four notes held) 19.5 % of real time before, 19.2 % after. Still far over the FM-1's budget (339 % of its CPU, 268 of
  64 modules), so it stays an XL.
- **Spokes 6 XL** gains what the new ranges make possible: swing to 80 % and the 1/8X scale (Steps 1/2), the LFO's
  start phase, backward speed, slow and fast ranges and synced speeds /8 to x8, synced retrigs down to a 1/128 triplet
  and an INF retrig length, a delay `note` row and `swell` (feedback to 1.98), and a reverb `freeze`. Each track's machine
  choice is now one Selector in place of ten comparators: 836 modules become 782, and it takes about 55 % of real time
  in Chrome instead of 60 % (transport running, 4 s rendered by the engine; on a Mac). The sound as shipped is the same.
- **8 Lire XL and Elvira 2 XL rebuilt on the new modules.** 8 Lire XL's plates are one repeating Drum map, which holds
  each plate's velocity, so its 32 velocity VCAs and 8 S&Hs are gone (185 to 142 modules); a plate held on two keys now
  keeps its own velocity instead of adding the two. Elvira 2 XL's choices (programs, chords, filter types, tunings,
  LFO waves, reverb, tune follow, MODP chaining) are Selectors in place of comparator and Crossfader chains (702 to 475
  modules). Elvira 2 XL plays a test phrase slightly louder than before (peak 0.50 to 0.54). Both render faster in
  the browser: 8 Lire XL from 11.7 % to 9.9 % of real time, Elvira 2 XL from 41 % to 32 % (four notes, 3 s, Node on an
  Apple Silicon Mac).
- **Hera 6 XL:** decay and release now reach 12 s, as on the Juno-106 (the ADSR's long times; the patch sounds as before).
  The range switch and the portamento switch are Selectors: `range` 1 is 16', 2 is 8', 3 is 4'; `portamento` 1 is off,
  2 is on. On the FM-1's CPU estimate it went from 194 % to 177 % (module instances from 136 to 120 of 128), still too
  much for the FM-1, so it stays a browser patch.
- **Oracle V XL:** chord memory is one Selector per voice. `chord 2` to `chord 5` now set each voice's interval above
  the key, not above the chord note before it. FM-1 CPU estimate: 420 % to 398 %.
- **808 Kit: the Roland TR-808's controls, and its closed hihat cuts the open one.** One card, `808 kit`, holds the
  drums with the TR-808's knobs only, one page per instrument named as on its panel: bass drum (level, tone, decay),
  snare drum (level, tone, snappy), low tom (level, tuning), rim shot, hand clap, cow bell (level), open hihat (level,
  decay), closed hihat (level). New: bass drum TONE (a low pass on the kick's attack, now with a 1 ms click) and snare
  drum TONE (the balance of two body sines, about 238 and 335 Hz, the TR-808's two shells). The hihats are the factory
  hats (a square cluster and noise) on one metallic source, and a closed hit shuts an open one until the next open hit.
  The drums' other rows (tune, drop, snap, flam, stick ...) keep their values but leave the card. It still plays eight of
  the TR-808's eleven voices, and each row accents its own drum by velocity, where the TR-808 has an ACCENT row for all.
  FM-1 budget: 59 to 58 modules, 3,424 to 3,226 patch bytes of 3,840, CPU estimate 67 % to 76 % (the editor's
  estimate). Host and firmware-engine tested only (`tools/golden.sh`), not yet on a device.
- **808 Kit XL** (browser only): every TR-808 voice, knob and switch. The mid and high toms and the cymbal play from a
  second track, DRUMS 2, whose Drum map also has the ACCENT row: a step on it accents every voice on that step by
  ACCENT LEVEL, and the rows' velocities no longer accent. The tom / conga, rim shot / claves and hand clap / maracas
  switches are rows of named choices. The cymbal and hihats share six square oscillators at the TR-808's frequencies;
  the cymbal has TONE and DECAY. A pre-scale row (1/8T, 1/16, 1/16T, 1/32: 3, 4, 6 or 8 steps a beat) sets both
  tracks' rate. The TR-808's rhythm memory (A /
  B variations, fill-ins, auto fill, rhythm tracks) needs Steps features we lack (#351). 132 modules, an estimated 150 %
  of the FM-1's CPU.

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
