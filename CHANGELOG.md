# Changelog

What changed in Matryoshka for the people who use it: the web editor and the FM-1 firmware, which are released together.
The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The development log from before 1.0 is in
[docs/CHANGELOG-pre-1.0.md](docs/CHANGELOG-pre-1.0.md).

## Unreleased

## 1.0.0 — 2026-10-21

The first release of Matryoshka. It has two parts:

- a **patch editor** that runs in the browser (Chrome or Edge for the FM-1 connection), at
  https://matryoshka.pages.dev/;
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
- **The editor moved** from https://glvno.github.io/matryoshka/ to https://matryoshka.pages.dev/. The old address
  forwards, so bookmarks and share links made before keep working. The browser keeps the editor's data per address: with
  data at the old address, it offers **Bring my patches**, which copies Your patches, the bank, the library, the open
  patch, the tutorial progress and the settings to the new one without replacing what is already there, or **Download a
  backup**, which the new editor reads with Load .json (or the palette's Import browser backup). The site counts visits
  with Cloudflare Web Analytics, which uses no cookies.
- Matryoshka stores its patches in flash sectors that Felucca uses for its projects, samples and user presets. Installing
  Matryoshka overwrites that Felucca data: save it with Felucca first. The Flash tab asks again when it finds Felucca.
  Patches stored by the official M-VAVE firmware are not touched.
