# Changelog

## Unreleased

- **Env 8, an eight-step envelope** after the Casio CZ's: eight levels and rates, a sustain step that holds while the
  key is down (the key's release jumps to the step after it) and an end step where it rests. With the sustain off it
  runs through like a one-shot. Its card draws the shape; on the FM-1 it has five pages (two steps a page, then
  sustain and end). About 1 to 1.4 % of the FM-1's CPU per copy, estimated.

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
