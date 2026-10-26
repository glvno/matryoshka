# Changelog

## Unreleased

- **Monolith D has the Minimoog Model D's panel.** Its card now holds the original's controls under their names:
  TUNE and a half-octave PITCH wheel, GLIDE with its on / off switch, OSCILLATOR 3 CONTROL (oscillator 3 off the keys,
  for a slow modulation source), RANGE as the six footages LO to 2', WAVEFORM as triangle, saw, square, wide and narrow
  rectangle, the WHITE / PINK noise, KEYBOARD CONTROL off, 1, 2 or both, the DECAY switch (each contour's release takes
  its decay time, or the note stops at once) and the A-440 tone. The modulation switches now switch, and the modulation
  mix comes from oscillator 3 and the noise before the mixer's volumes, so a silent noise or a quiet oscillator 3 no
  longer weakens it. Filter modulation no longer depends on the contour amount. Gone: the drive, release and scope rows,
  which the original lacks. Still missing: the shark tooth and reverse saw waveforms and the external input. The patch
  takes 36 modules (18 before), 2,703 patch bytes (1,371) and an estimated 34 % of the FM-1's CPU (22 %). Host-tested
  only, not yet on a device.
- **Silver Box accents like a TB-303.** An accented note (velocity 115 or more, a Steps accent) runs the filter
  envelope at its shortest decay, 200 ms, and that envelope times ACCENT lifts the level and, through the accent sweep
  circuit, the cutoff. At high RESONANCE the sweep is smoother and builds up over consecutive accents, as the original's
  second resonance gang does. ENV MOD no longer scales the accent. The soft clip after the filter is gone (the 303 has
  none), and so are the slide, drive and amp decay rows: the slide time and the volume envelope's decay are fixed, as on
  the original. TUNING is now the oscillator's fine tune (±1 semitone; the original's reaches ±5). The patch takes 17
  modules (14 before), 928 patch bytes (885) and an estimated 19 % of the FM-1's CPU (17 %); <7PH 63 modules (60),
  3,831 bytes of 3,840 (3,788) and 68 % (66 %). Host-tested only, not yet on a device.
- **Sallen 20 is the MS-20 as it plays with nothing patched.** The highest held key plays (the MS-20 mini's manual), VCO
  1 and 2 have SCALE as footages and their own WAVEFORM switches (VCO 1's noise, VCO 2's narrow pulse and ring modulator
  in place of the ring row), MASTER TUNE, EG 1's DELAY and EG 2's HOLD are new, and each filter has its own MG/T.EXT and
  EG2/EXT amounts (the high pass had no MG amount, and the low pass's MG depended on its EG amount). The MG's frequency
  modulation now reaches the oscillators' pitch, not just their fine tune. The soft drive after the low pass is gone.
  Still missing: the patch panel's own sections, the ESP, the MG's variable waveform and the high pass's 6 dB slope
  (ours is 12 dB). The patch takes 32 modules (19 before), 2,112 patch bytes (1,440) and an estimated 36 % of the
  FM-1's CPU (29 %). Host-tested only, not yet on a device.
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
