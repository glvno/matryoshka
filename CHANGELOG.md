# Changelog

What changed in Matryoshka for the people who use it: the web editor and the FM-1 firmware, which are released together.
The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The development log from before 1.0 is in
[docs/CHANGELOG-pre-1.0.md](docs/CHANGELOG-pre-1.0.md).

## Unreleased

- Arming on the FM-1 is a set too (#191): REC on an environment row arms or disarms that device, REC held + a black key
  adds or removes a track, several at once; only armed devices hear the keys, ARMED shows on their rows. The FM-1 tab
  and the editor arm the same devices. On the FM-1 a device can be armed when something in it already takes Main's keys
  by cable (or it is a Steps track): an engine with no cable from Main is not on the FM-1's keys at all.
- Presets on the FM-1 (#194): SEL on an assembly's page lists its presets (the factory engines' come built in);
  SELECT, ALGO or PRESET load them as you turn. ENV held + SAVE stores the device's values as a preset: over your
  preset it was set to, else under a new name. The FM-1 keeps about 60 of your presets in flash sectors nothing else
  uses: your 64 patch slots stay as they are, nothing to reset. A patch remembers each device's preset name (patch
  format 34: patches from this editor need this firmware).
- The environment on the FM-1 (#197): ENV opens a list of every device in the patch, Main first, each Steps track then
  what it plays (indented, with a stripe in the track's colour), the Output last, with each device's preset name and
  what it is doing. SELECT picks the row, K1..K4 turn its first page, SEL opens its pages; ENV or HOME goes back.
  ENV and SEL are fixed buttons now (their jacks still go high while held; a patch's role for them is dropped), and FX
  is the SEQ page's accent / rest key in place of ENV.
- GLO is the FM-1's own quick page (#199): K1..K4 set the MIDI channel, MIDI clock in, MIDI out and the LEDs (saved with
  SAVE), never the patch's. The patch's tempo and morph are on Main's device page. The SCL button is shown as SEL.
- Main, the Steps tracks and the Output are devices too (#196): SELECT steps through all of them in the environment's
  order: Main first, each Steps track followed by what it plays, then the rest, the Output last. A patch still opens on
  its first instrument. A track's page is LEN RATE SWING GATE, named after the track; SEL or SEQ there opens its steps.
  The editor's DEVICE picker follows the same order.
- Presets (#192): store an assembly's card values as a named preset (its menu: Store as a preset…), and every copy of the
  same assembly, in any patch and under any name, can load it. An assembly with presets shows ‹ name › on its header:
  the arrows step through them, the name opens the list (store over, store as new, rename, delete); a star means a value
  changed since. Loading is one undo step; the patch remembers the preset's name. Presets are matched by structure
  (the modules, cables, nesting and which rows are on the card), so changing those makes a new kind with no presets
  yet. Palette: Export presets as .json / Import presets from .json.
- Every factory engine comes with presets (#193): Init (as it ships) and variations such as Bright, Dark, Pad, Pluck,
  Tight, Long and Wet, where the engine has the rows for them. They are read-only: storing over one makes a new one.
- Arm anything that takes keys, several at once (#190): ARM is on every engine, Voicing, Drum map and Steps track card,
  each its own toggle. While anything is armed Main's keys play only the armed devices, cabled or not (a layer: arm two
  engines); with nothing armed the cables decide. Steps tracks keep playing what they drive. Dashed lines show where
  Main's keys go; your own Main keys cables into unarmed devices are dimmed meanwhile. In the editor only for now: the
  FM-1 still arms one Steps track from its panel.
- An engine is now what its insides make it (keys → voicing → voices): an assembly whose keys reach a Voicing module or
  a Drum map, through an Arpeggiator or a Steps track if need be, and that makes audio. Assemblies with a keys input that
  nothing voices are no longer engines. The Voice assigner is now called **Voicing** (patches load as before).

## 1.1.0 — 2026-10-22

- Modules are named after the hardware they stand for: Scale is now Attenuverter, Constant Offset, Shaper Waveshaper,
  Digitizer Bitcrusher, Modal Resonator, Vowel Formant filter, Freq shift Freq shifter, Clock div Clock divider,
  Crossfade Crossfader, Comb Comb filter, Filter Multimode, Glide Slew limiter and Voice allocator Voice assigner.
  Only the names changed: patches, links and banks load as before. The FM-1's screen shows the new names from the
  next firmware release.
- Direct links: https://matry0shka.pages.dev/#fm1 opens the FM-1 view, #flash the firmware install (as before); both also
  work when the address changes on an open page.
- Share links keep big patches whole: a patch over 8,000 characters as a link (the Demo) is stored on the site and
  shared as a short `#s=` link with its layout and assemblies. A link without the layout no longer drops the assemblies
  (their poly racks and device pages), and its cards open spread over the canvas instead of stacked on one spot.
- Tidy up spreads a pile of stacked cards over the canvas instead of making one tall column.
- Audio on is highlighted like the tutorial's targets while the audio is off (not started, or after Panic).
- A new engine and factory patch, **8 Lire**, after the SOMA Lyra-8: eight drone voices, each played by a white key
  (repeating from E2 to A6), each with its own tuning and attack / release, waveshaping and cross-modulation per pair and quad, HOLD to let them drone,
  a Hyper LFO and a ping-pong delay.
- A new engine and factory patch, **Elvira 2**, after the neutral labs Elmyra 2: four wavetable voices on the white keys
  (from E2 to A6), each with its tune, wave, wavetable page, a MOD that lowers its sample rate, attack / release and
  DRONE; then a saturated mix, a ladder low pass, a delay and OUCH (bite and choke), with two LFOs.
- The firmware install page is now the third view of the switch over the canvas: Patch | FM-1 | Flash (#flash still
  opens it).
- Fixed: with the editor's Live on, a knob click on the FM-1 could make a value jump (the FM-1 and the editor had come to
  hold different values). While Live is on, PRESET and program change on the FM-1 no longer load a slot of their own, and
  each knob turn reaches the editor as the exact parameter it moved.
- A new or factory-reset FM-1 has 8 Lire and Elvira 2 as patches 16 and 17 (the 808 and 909 Kits move to 18 and 19); an
  FM-1 already in use keeps its bank: send them from the editor.

## 1.0.0 — 2026-10-21

The first release of Matryoshka. It has two parts:

- a **patch editor** that runs in the browser (Chrome or Edge for the FM-1 connection), at
  https://matry0shka.pages.dev/;
- a **firmware for the M-VAVE FM-1** that turns it into a player for the patches you make in the editor.

A patch is a small modular synthesizer: modules joined by cables, played from the keys. You build it in the editor, hear it
there at once, and send it to the FM-1, which plays the same patch on its own.

### The editor

- 44 module types: oscillators (with unison, sync and FM), a wavetable oscillator, noise, filters (multimode and ladder),
  envelopes (ADSR and DX7-style level / rate), VCAs, mixers, a plucked string, a comb filter, a modal resonator,
  granular, delay, reverb, chorus, phaser, frequency shifter, shaper, digitizer, compressor, sequencers, a clock
  divider, sample and hold, a quantizer, logic and math, an arpeggiator, a scope.
- **Assemblies:** select modules and make them one card that shows only the knobs and jacks you choose. Assemblies nest
  (three levels), go into your library and into any other patch, and can be exported as files. 61 come with the editor:
  drums, voices, effects, textures, utilities and instruments modelled on well-known synthesizers.
- **17 factory patches**, from a basic init patch to the instrument recreations and two drum kits.
- **Polyphony:** a Voice allocator plays an assembly as several voices (up to 8 on the FM-1). Splits, layers and
  different MIDI channels per allocator.
- **Steps:** a step sequencer track of notes (up to 64 steps), with chance, swing and accents, edited on the card's
  grid or in a piano roll. Arm a track to play and record into it from the keys, by step or live. A Drum map turns a
  track's notes into drum hits by row.
- **Device pages:** every top-level module or assembly is a device; its rows are pages of four. The editor shows which
  rows the FM-1's knobs K1..K4 will turn.
- **The Library** keeps your patches and assemblies in the browser and writes the whole bank to the FM-1.
- **Share links:** a link that opens your patch, with its layout and assemblies, in anyone's editor.
- **Share sheet:** a link, the patch as a file, or a patch card image with its name, engine, notes and knob pages. The
  **Community shelf** lists patches other people have submitted (through a GitHub issue form, CC BY-SA 4.0).
- **Engines:** an engine is an assembly that plays from the keys and makes sound (an Engines shelf, with a short
  description of each). A new patch starts from a screen of engines, or empty; an engine you add is wired to the keys and
  the output for you.
- **Cables** show what they carry: sound bold, modulation in a second colour, gates as a hollow rail, keys as a ribbon.
  Dashed lines are links the app draws, never your own cables.
- **The tutorial** ("How a patch works" in the sidebar): thirteen chapters, from a first sound to drums and voicing.
- **The FM-1 tab** shows the FM-1's screen and panel, running the firmware's own interface in the browser.
- Undo / redo, copy / paste, a command palette (Ctrl/Cmd+K), keyboard shortcuts (`?` lists them), a CPU meter that
  estimates the patch's load on the FM-1, light and dark themes. Phones and tablets: pinch to zoom, two-finger pan, and a
  page that scrolls. Connect FM-1 sits at the canvas's top right, Share beside Save, About under the logo; the patch
  menu (⋯) holds the FM-1 & MIDI settings and file import.
- New modules and assemblies land in the part of the canvas you are looking at.

### The FM-1 firmware

- **Patch player:** SELECT and ALGO page through the patch's devices, K1..K4 turn the four rows of the page in focus,
  PRESET steps through the patches.
- **The bank:** 64 patch slots in the FM-1's flash. The first start writes the factory patches; SAVE stores the patch you
  are playing, with your edits, in its slot. The FM-1 opens the last saved slot when it starts.
- **Steps on the panel:** the SEQ page edits a track's steps on the keys (by row for a drum track); REC held with a black
  key arms a track (ARM shows on the SEQ page), REC records into it by step or live.
- **MIDI:** notes, pitch bend, mod wheel, aftertouch, program change, CC to the knobs and buttons, MIDI clock and
  Start / Stop in, over USB and the TRS MIDI input. Every panel control goes out over USB MIDI.
- **Editor link over USB:** send a patch, store it to a slot, write the whole bank from the Library, and sync: the editor
  asks when the FM-1 connects, then patch changes, knobs, buttons and the page in focus go both ways while you edit. The
  FM-1 chip in the status line shows whether it is synced.
- **USB audio out:** the FM-1 appears on a computer as a 2-channel recording device (16-bit, 44.1 kHz) carrying its
  output, alongside MIDI.
- **Safe mode:** hold SAVE at power-on to start with the fallback patch, skipping the stored state. A start that crashes
  makes the next one safe by itself.
- **Update mode:** hold OCT- and OCT+ at power-on, or MENU > SYSTEM > UPDATE MODE, to have the FM-1 wait for an install.
- A settings menu (hold HOME): LEDs, knob acceleration, MIDI channel, clock in, MIDI out, CPU, version, factory reset, and
  a short manual on the screen. PRESET shows the patch name as you turn it.
- The factory drum kits play from the keys: one row per key from F3 up, an octave below the melodic patches.

### Install and return to stock

Install from the editor's Flash tab or with `tools/fm1_install.py`; returning to the official firmware (V15) is one button
in the same tab. If your FM-1 runs anything other than the official firmware or Matryoshka, return it to stock first. See
[Install on the FM-1](README.md#install-on-the-fm-1) in the README.

### Known limits

- A power cut while the firmware is being written has been tried only in cases where the image stayed whole. A cut while
  the image is half old and half new is untested.
- The editor's CPU figures for the FM-1 are estimates, calibrated against measurements of the 17 factory patches on
  one FM-1, and agree with them within a few points. The busiest factory patch, the 808 Kit, uses about 81 % with eight
  keys held.
- MIDI clock in and program change are implemented but have not been tried on an FM-1 yet.
- The FM-1 has 64 patch slots and limits per patch (64 modules, 255 cables, 8 voices, one delay, one reverb); the editor
  warns when a patch does not fit.
- The Scope runs only in the editor.

### Coming from Modular-1 or Felucca

- Matryoshka grew out of [Modular-1](https://github.com/WiggisModular/Modular-1), and this editor used that name until
  1.0. It still reads what its earlier versions saved in the browser (patch, bank, assemblies, under the old
  `modular-1.*` names) and assembly files saved under the old format name. Older patch files load.
- **The editor moved** from https://glvno.github.io/matryoshka/ to https://matry0shka.pages.dev/. The old address
  forwards, so bookmarks and share links made before keep working. The browser keeps the editor's data per address: with
  data at the old address, it offers **Bring my patches**, which copies Your patches, the bank, the library, the open
  patch, the tutorial progress and the settings to the new one without replacing what is already there, or **Download a
  backup**, which the new editor reads with Load .json (or the palette's Import browser backup). The site counts visits
  with Cloudflare Web Analytics, which uses no cookies.
- Matryoshka stores its patches in flash sectors that Felucca uses for its projects, samples and user presets. Installing
  Matryoshka overwrites that Felucca data: save it with Felucca first. The Flash tab asks again when it finds Felucca.
  Patches stored by the official M-VAVE firmware are not touched.
