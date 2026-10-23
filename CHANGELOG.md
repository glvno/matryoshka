# Changelog

What changed in Matryoshka for the people who use it: the web editor and the FM-1 firmware, which are released together.
The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The development log from before 1.0 is in
[docs/CHANGELOG-pre-1.0.md](docs/CHANGELOG-pre-1.0.md).

## Unreleased

- Every melodic factory patch (all but the 808 Kit, the 909 Kit and <7PH) has an **arpeggiator on ARP** and an empty
  16-step **PATTERN** track: Main's keys go through PATTERN into the arpeggiator, then the voice. The arpeggiator starts
  off, so a patch sounds as before (a few milliseconds later, through PATTERN) until ARP is pressed; notes entered on
  PATTERN play on PLAY, through the arpeggiator when ARP is on. Scrounge, Meridian 8 and Perun 4 keep their pattern
  and get the arpeggiator. Oracle V and Algo Four now estimate at about 84 % and 86 % of the FM-1's CPU. On the FM-1
  the arpeggiator comes after the voice in the device order and a patch still opens on the voice (Init opens on its
  new one-voice Voicing). An FM-1 in use gets the new patches only from MENU > SYSTEM > FACTORY RESET; a normal update
  leaves the saved slots as they are.
- ARP's light, when ARP switches an arpeggiator: lit while it arpeggiates, dark while it is off (the LED, the bar's
  ARP ON / OFF, the editor's dock and EMU agree). Other Toggles keep their light: lit while their target is bypassed.
- A bypassed Arpeggiator (ARP as its Toggle, or its card's power switch) now plays the keys straight through instead of
  arpeggiating anyway; switching it lets go of what it was playing. An Arpeggiator can play a Steps track's notes (the
  track's keys out into its keys in) and can drive Drum maps, in the editor and on the FM-1. On the FM-1 the black
  keys still play the Drum map's rows when a track plays it through an arpeggiator (8 Lire, Elvira 2, Scrounge,
  Meridian 8, Perun 4).
- FM-1: the battery in the top right corner of the screen: 0 to 3 bars, a bolt while a computer powers it over USB, and
  LOW BATTERY in the top bar once when it runs low. MENU > SYSTEM > BATTERY shows the reading behind it. The thresholds
  are the stock firmware's (via Felucca) and are still to be checked on a real FM-1 (#240).
- FM-1 drums on the black keys everywhere: whenever the keys reach a Drum map (a drum patch like the 808 Kit, or an
  armed drum track), black keys 1..8 play its rows 1..8 on every page, recording or not, and the white keys play nothing
  (they still switch steps on the SEQ page). A melodic patch, or <7PH's PATTERN, still gets every key. MIDI
  out sends the row's note for a black key and nothing for a white one, so a recording played back hits the same rows;
  MIDI notes coming in still play a row by its note.
- FM-1: a drum track's SEQ page is now an 8 × 16 grid, every row's hits at once with the row names at the left, the
  selected row highlighted, the playhead's column, accents in coral and OCT- / OCT+ for steps past 16. A hit, a step or a
  row pick redraws only its cell or two names, so recording hits no longer redraws the page or switches the row shown.
  SELECT also picks the row, with REC on or off. REC on an armed drum track is this grid (step entry stays for melodic
  tracks).
- FM-1: REC with nothing armed opens the SEQ page on a drum track, so the hits are seen landing; REC off stays there.
- The first community patch: **Lire + Elvira**, 8 Lire and Elvira 2 layered on one keyboard (slimmed to fit the FM-1),
  under Community in the Open picker and the palette.
- FM-1: no key press is lost or late while the screen redraws. A note (or a hit on the SEQ page) pressed and let go
  during a full redraw used to be missed, and any key waited for the redraw to end; now every press and release plays,
  in order, within a moment of the press (#230).
- A new factory patch, **<7PH** (patch 23, a groove box, after the 909 Kit): the 909 Kit's drums and the Silver Box playing a
  16-step acid bass line in B flat minor on its own PATTERN track, at 124 BPM. PLAY starts both, Main's keys play the
  bass, arming DRUMS (REC held + its black key on the FM-1) puts the keys on the kit, and the kit's mixer balances kick,
  snare, hats and bass. An FM-1 in use gets it only from MENU > SYSTEM > FACTORY RESET, which rewrites the whole bank;
  a normal update leaves the saved slots as they are.
- The SEQ page's white keys: B now switches its step, and A# (a black key) no longer does; before, every B did nothing
  and every A# both picked a track and switched the next step (since 1.0, on the FM-1 and in EMU).
- The tutorial's text follows the new navigation and the removed Riff button (play notes on the keys, or Note for a
  held C4; LIBRARY → Assemblies; + Module and New patch in the PATCH panel).
- After an update to a new version, a returning visitor sees a short "what's new" card once, linking to the full
  release notes; the About card has a What's new link too.
- New navigation (#218): one switch at the top, PATCH | EMU | LIBRARY, replaces the sidebar's Patch / Library tabs, and
  the sidebar shows the current view's panels. EMU is the FM-1 view renamed ("Mirroring your FM-1" while a connected
  FM-1 drives it); LIBRARY lists its sections Patches, Assemblies and Presets. The Open picker moved next to New patch.
  Flash left the switch: **Install firmware** (Get started, the palette, `#flash`) opens the install page as a panel
  over the main area, and Connect FM-1 offers it when the FM-1 runs other firmware. `#emu`, `#library`,
  `#assemblies` and `#presets` open those views, and going to a view closes the install panel. LIBRARY hides the
  keyboard and takes the full height. The PATCH panel's header shows the whole patch name; Save, Share and ⋯ sit beside
  New patch.
- The Library manages what is stored and opens nothing (#218). **Patches** and **Presets** show two columns, In this
  browser and FM-1, with → (onto the FM-1) and ← (into this browser) on each row. The FM-1 column always shows: without
  an FM-1 it is the bank's offline copy (order, rename, remove, Add from factory ▾); with one it shows what the FM-1's
  slots (numbered 01..64, as everywhere else) really hold, named Bank when that is the offline copy, else Unsaved bank with Save as bank…. A patch too big for
  the FM-1 stays in this browser marked "browser only" (the Over budget card is gone). **Assemblies** lists only your
  own, with rename. Factory assemblies and Community patches are in the Open picker, the palette and the assembly
  browser. Deleting a patch, preset or assembly kept in this browser, or replacing an assembly, acts at once with Undo;
  only replacing something on the FM-1 asks first. The Import link field and "Add the patch from the editor" are gone
  (open the link, or Save, then →). → onto a name the offline copy already holds (your "Vernon 100" over the factory
  one) replaces that entry, with Undo, and every → says where the patch went (or that the bank is full). The switch
  keeps the address in step (PATCH none, `#emu`, `#library` / `#assemblies` / `#presets`), and the tutorial's welcome
  card shows only in PATCH.
- Choosing and arranging what an assembly card shows works on several rows at once (#186): select rows with a band,
  Shift-click or Cmd / Ctrl-click (Cmd / Ctrl+A: all, Esc: none). Choosing: Space or Enter shows them (or hides them
  when all are shown), each member card's title has a check box for all its parameters, and Select all / Select none
  sit in the frame's bar. Arranging: drag the selection as one block, drag a heading's grip to move its section, and
  every page (one FM-1 page, also one that starts because the page before is full) has a strip named as the FM-1 names
  it ("FILTER 2/3", "PAGE 1/2") whose grip moves that page alone. Delete takes the selection off the card. On a touch
  screen a long press starts a selection.
- Section headings on assembly cards are 30 % larger (13 px), so cards with headings are a little taller.
- On the FM-1, turning SELECT or ALGO shows a quick card instead of redrawing the whole page on every click: the
  device's name on red (SELECT), the page's name on blue (ALGO). The page comes back about 0.4 s after you stop, or at
  once when you turn K1..K4 (#221).
- The tutorial has no Riff button any more: Note (a held C4) is its playback, and the intro's preview holds it too.
- The FM-1's SEQ page hints name FX, the key that really sets accents and rests (they said ENV).
- Factory patches: Simple FM's modulator now gets pitch and gate from the keys, and the 808 Kit's kick, snare, clap and
  tom get every gate their drum takes (both were wired to the first target only). An FM-1 picks them up on FACTORY
  RESET; a slot already in the bank keeps its sound.
- The Flash tab reads an FM-1 that reports `FM-1_8XX` as M-VAVE firmware (as the FM-1 panel does), not as Matryoshka (#217).
- A patch too big for the FM-1 no longer lets PRESET step through the bank under Live (#200, the EMLYRA bug): Live
  pauses, the editor keeps telling the FM-1 it is there, and the FM-1 says EDITOR PATCH TOO BIG (and again when PRESET
  is turned) until the patch fits.
- On the environment, PRESET or ALGO steps the row's presets, loading them as you turn (#198); REC arms the row.
- Presets between the editor and the FM-1 (#195): Library > Presets on the FM-1 reads the FM-1's own presets, gets one
  into this browser or deletes it there, and sends all of yours to it. Under Live, a preset stored on the FM-1 (ENV held
  + SAVE) comes into your presets by itself. Nothing else syncs. Deleting asks first; a device set to the deleted preset
  keeps its sound and no longer names it (the FM-1 shows PRESET DELETED: SOUND KEPT).
- The factory engines' Steps modules are named PATTERN, not after the engine (ENV showed PERUN above PERUN 4).
- Arming on the FM-1 is a set too (#191): REC on an environment row arms or disarms that device, REC held + a black key
  adds or removes a track, several at once; only armed devices hear the keys, ARMED shows on their rows. The FM-1 tab
  and the editor arm the same devices. On the FM-1 a device can be armed when something in it already takes Main's keys
  by cable (or it is a Steps track): an engine with no cable from Main is not on the FM-1's keys at all.
- Presets on the FM-1 (#194): SEL on an assembly's page lists its presets (the factory engines' come built in);
  SELECT, ALGO or PRESET load them as you turn. ENV held + SAVE stores the device's values as a preset: over your
  preset it was set to, else as a new one named after the preset it was based on with the next number (BRIGHT 2;
  from a factory patch as it ships, INIT 2). The editor suggests the same name.
  Preset names are one name in any case: the FM-1's BRIGHT 2 is the editor's Bright 2 (one replaces the other, never a
  second copy), and a new one from the FM-1 comes into the editor as Bright 2. The FM-1 keeps about 60 of your presets in flash sectors nothing else
  uses: your 64 patch slots stay as they are, nothing to reset. A patch remembers each device's preset name (patch
  format 34: patches from this editor need this firmware). On the first start after the update, every slot still
  holding a factory patch exactly as an earlier version wrote it gets today's version of that patch (FACTORY PATCHES
  UPDATED); slots you edited and saved stay as they are, and have no presets until you send them from the editor and
  SAVE: SEL says so (OLD PATCH: SEND + SAVE IT). The fixed buttons (GLO, SEL, ENV) no longer flash "ON" in the bar.
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
  same assembly, in any patch and under any name, can load it. An assembly with presets shows a fixed-width ‹ name › picker on its header:
  the arrows step through them, the name opens the list (store over, store as new, rename, delete); a star means a value
  changed since. Loading is one undo step; the patch remembers the preset's name. Presets are matched by structure
  (the modules, cables, nesting and which rows are on the card), so changing those makes a new kind with no presets
  yet. Palette: Export presets as .json / Import presets from .json.
- Every factory engine comes with presets (#193): Init (as it ships) and variations such as Bright, Dark, Pad, Pluck,
  Tight, Long and Wet, where the engine has the rows for them. They are read-only: storing over one makes a new one.
- Arm anything that takes keys, several at once (#190): ARM (a record-style dot, red while armed) is on every engine, Voicing, Drum map and
  Steps track card, each its own toggle. While anything is armed Main's keys play only the armed devices, cabled or not (a layer: arm two
  engines); with nothing armed the cables decide. Steps tracks keep playing what they drive. A dashed keys ribbon shows where
  Main's keys go, and armed cards are edged in red; your own Main keys cables into unarmed devices are dimmed meanwhile. In the editor only for now: the
  FM-1 still arms one Steps track from its panel.
- An engine is now what its insides make it (keys → voicing → voices): an assembly whose keys reach a Voicing module or
  a Drum map, through an Arpeggiator or a Steps track if need be, and that makes audio. Assemblies with a keys input that
  nothing voices are no longer engines. The Voice assigner is now called **Voicing** (patches load as before).
  An engine's card is tagged ENG instead of ASM.
- A new engine and factory patch, **Scrounge**, after the neutral labs Scrooge: five voices played by their control
  voltage, a curve per hit (its height from the velocity, TILT its rise, GATE its fall) that sets each voice's level, pitch
  and tone at once (a boomy kick, a starved square for hats and drones, a noise snare, a growl / chirp, a squelchy bass),
  two unlabelled knobs, a volume and an A-B switch per voice, the MOD X and MOD Y tracks with their slew, a saturating
  mix, CHOP and MELT. The patch plays a pattern on PLAY; the white keys from F3 play the voices and the modulation tracks.
- A new engine and factory patch, **Meridian 8**, after the Landscape NOON: eight channels powered by their gates (DOT,
  DUAL, SYS, PLAST, CYMPATH, CYRINX, LARYNX, BACID), each with two tone sliders and a volume; the power also bends the
  pitch or the filter, so a short gate starves the sound and a held key drones. LINK lets a channel half-power its
  neighbour, ODD / EVEN CV hold the odd or even channels up; the odd channels play on the left, the even ones on the
  right, squashed a little as the passive mix is. The patch plays a pattern on PLAY.
- A new engine and factory patch, **Perun 4**, after the Erica Synths PERKONS HD-01: four drum voices with the same
  controls (tune, decay, param 1 and 2, a filter from low pass to high pass, drive, an FX send and a level): a folded
  kick, a wavetable drum, a snare of body and noise, a hat of noise and a pulse stack; a delay on the sends with an LFO on
  its time, and a master compressor. Accented steps play louder. The patch plays a pattern on PLAY.
- A new or factory-reset FM-1 has Scrounge, Meridian 8 and Perun 4 as patches 18, 19 and 20 (the 808 and 909 Kits move
  to 21 and 22); an FM-1 already in use keeps its bank: send them from the editor.

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
