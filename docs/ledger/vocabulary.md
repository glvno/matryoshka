# Vocabulary

Terms Matryoshka uses in a specific sense. One `### Term` heading each, in alphabetical order, defined in one or two sentences of plain words. A row that uses a term in bold links here. This file is written last: its terms come from the rows.

### Amendment

An in-place change to a row whose ruling still stands but whose facts moved. Written into the Decision cell as `**Amended <date> (<who>):**`.

### Arm

To make a device with a keys input hear Main's keys, cable or not. Several devices can be armed at once (a layer, or a split by their key ranges); while any is armed, only armed devices hear Main, and while none is, the cables decide. Arming reroutes only Main: other key sources keep playing what they drive.

### Arrange mode

The collapsed assembly card's mode (card menu "Arrange the card") where its rows and jacks are dragged into columns, headings, groups and spans.

### Assembly

A reusable nested building block of modules whose collapsed card shows only what it exposes. Avoid: macro, group, sub-patch.

### B side

A second set of parameter values for the same modules and cables; patch morphing fades between the patch and its B side.

### Bank

The FM-1's 64 patch slots, its only patch list; PRESET steps the occupied slots. The editor keeps one bank, its offline copy in the browser (several named banks: issue #220).

### Blurb

A factory engine's one-line description in the owner's wording, kept on the assembly definition.

### Browser-only ability

Something only the browser's engine can do, such as a Delay time past 520 ms. A patch that uses one is over the FM-1 budget, so it is a sandbox patch. `browserOnly` in `web/src/patchbin.ts` lists them.

### Budget meter

The editor's readout of how much of the FM-1's resources a patch uses; it turns red with a breakdown when the patch is over budget.

### Button kind

What a configurable patch button does in a patch: Nothing, Gate, Toggle (bypasses a module or assembly; `bypass` in code) or Page (a list of device pages).

### Card row

A parameter an assembly promotes to its collapsed card; the card rows are what the FM-1 player and presets change.

### Card rows

The parameters an assembly promotes to its collapsed card; they are what the FM-1 player can change.

### Collapse

Folding an expanded assembly back into one card. Also called closed in the model.

### Command palette

The searchable list of every editor action, module, assembly and patch, opened with `/` or Ctrl/Cmd+K.

### Community shelf

Patches other people submitted, from the curated `community.json`, shown in Library > Community. A user adds the ones they want, and only those appear in Your patches and the palette.

### Course

The whole tutorial as data: every chapter and step in `web/src/tutorial/course.json`.

### Decider

The person whose call a ruling is. Named in a `Proposed` status, in a subject file's current-state paragraph, or by default in [D-011](process.md#D-011).

### Dedicated input

An input a parameter is permanently wired to (a VCA's `cv`, a filter's cutoff `cv`); it cannot be disconnected.

### Derivative artifact

A document generated from this repository for someone: a PDF, a deck, a summary. Named by date and topic, bannered as generated and stale after a day, never committed.

### Device

A top-level module or assembly as the FM-1 player sees it, paged by SELECT, its card rows edited by K1..K4. Main is the first device and Output the last; Steps tracks are devices too. Avoid: device for the FM-1 itself (say "the FM-1").

### Device extras

The format 34 binary section after the device pages: per device its driving Steps track, structure fingerprint and remembered preset name.

### Device form

The form of a patch the engines and the FM-1 run (`deviceView`), in which every Voicing module becomes a Part module in each poly group it drives.

### Display

An editor-only row a module can have (a scope screen, an envelope shape); it is not a parameter.

### Drum map

A module that sends each key to its own row's gate (mapped voicing), as a drum engine picks its drum.

### Edit binding

Main's K1..K4 are bound to the rows of the page in focus; they edit those rows and are not signals in the patch.

### Emulator view

The EMU view of the editor's top switch: the FM-1's firmware UI compiled to WebAssembly, running in the browser (`#emu`). Also called the FM-1 view or the FM-1 tab.

### Engine

An assembly that takes keys and makes audio: its voicing turns the keys into notes for its voices. It can be a device or sit inside one, and a patch can hold several. Avoid: machine, patch (an engine is never a whole patch).

### Engines shelf

The derived first shelf of the assembly browser and the palette, listing every engine.

### Environment

The patch's devices seen as a rack of equipment, from Main to Output; the ENV button opens it on the FM-1, and in the editor the canvas is the environment. Presets are picked and rows armed there. Avoid: rack, mixer, set list.

### Expand

Unfolding an assembly card into a frame around its member cards. Also called open in the model.

### Factory patch

A patch that ships with the editor. The FM-1's factory patches, generated by `gen-presets.ts`, ship with the firmware too, and the first boot writes them into the bank. An XL is a factory patch of the browser only.

### Fallback patch

`FALLBACK_PATCH`, one small patch compiled into the firmware (saw into VCA with an ADSR), played when a slot does not load and in safe mode.

### Fixed button

A panel button whose job the firmware sets (GLO, SEL, ENV): a patch cannot give it a Toggle or Page role.

### Fixed point

Integer arithmetic with an implied binary point (Q16.16: 1.0 = 65536); the FM-1 has no floating-point unit.

### Flaws

Per-part offsets of a poly assembly (detune, drift, brightness, envelope times, level) that make its voices differ like analog voice cards.

### FM-1 chip

The status-line indicator that shows the editor's link to the FM-1 (not connected, synced, not synced, patch too big to sync) and opens FM-1 & MIDI.

### Format 35

The binary patch format that added the PD Osc, Env 8 and Selector modules, the parameters appended to existing modules, and the device page row extras ([D-266](patch-format.md#D-266), [D-267](patch-format.md#D-267)). The current format is `VERSION` in `web/src/patchbin.ts` and `ENG_PATCH_VERSION` in `firmware/src/engine.h`.

### Forwarder

The page at the old GitHub Pages address: it sends visitors to the Cloudflare site and offers to bring their browser data along.

### Global

Belonging to the FM-1, not to any patch (the GLO page, the MENU). Avoid: global for the patch's own tempo, morph and arpeggiators.

### Golden kit

A small test patch that `tools/golden.sh` renders in both engines to check they agree.

### Group

Up to four card rows shown as one FM-1 page; groups fill in fours inside a section.

### Grouped order

The one order of devices shared by editor and firmware: Main, each Steps track followed by the devices it drives, the rest in reading order, the Output last.

### Hard fork

A copy of a repository that goes its own way for good: it takes no regular updates from the original and sends none back.

### ID block

The range of `D-###` numbers a subject file owns, declared under its title. A file that fills its block gets a second one. The ID alone tells you which file a row lives in.

### Identity

The product string a firmware reports over USB MIDI (`FM-1_<n>`, or `ota-FM-1_<n>` for an update loader); the app and installers use it to tell firmwares apart.

### Idle part

A part of a poly group that is released, has finished its envelopes and stayed silent a whole block; both engines skip it until a note reaches it.

### Install panel

The editor's firmware install page, shown as a panel over the main area and closed with its Close button (`#flash`). It is not a view of the top switch. Also called the Flash view or the Flash tab.

### Key source

What feeds an engine its keys from outside it: Main (the panel keys and MIDI), a Steps track, an Arpeggiator. Never part of an engine. Avoid: driver, controller.

### Keys in

The note-on / note-off input of a Steps track, carrying keys like Main's; Steps passes them through to keys out.

### Keys out

The note-on / note-off output of a Steps track or Main that plays an instrument.

### Lesson editor

The dev-server-only page (`/lesson-editor`) where the course is written and saved.

### Library

The editor's view for managing what is stored, in the browser and on the FM-1 (`#library`). Its sections are Patches, Assemblies and Presets; Patches and Presets show this browser and the FM-1 side by side. It opens nothing.

### Live

The editor–FM-1 sync. While it is on, the FM-1 plays the editor's patch and edits go both ways. Also called sync.

### Live take

Recording while the transport runs: played notes land on the nearest step and overdub the track.

### Macro

A module (format 29) holding one value 0..1 on one output; old knob cables migrate to Macro modules in a "Macros" assembly.

### Main

The FM-1 panel module (type `fm1`), the patch's only source of keys and MIDI.

### Main dock

The panel under the canvas where the patch's one Main module lives: knobs, device and page pickers, the FM-1's buttons.

### MIDI profile

A per-firmware table that turns a connected FM-1's MIDI messages into panel inputs, so the web app can follow any firmware.

### Not yet settled

The list at the end of every subject file: questions we know we have not answered, each with the ticket where it is being worked. Not rows; no IDs.

### Offline copy

The bank as the editor keeps it in the browser (`matryoshka.bank`): what Send bank to FM-1 writes, and what the Library's FM-1 column shows while no FM-1 is connected.

### Over budget

A patch that exceeds the FM-1's limits (modules, cables, bytes, CPU) or uses a browser-only ability. It plays in the browser only, as a sandbox patch; the editor marks it SANDBOX.

### Overlay

Editor-only data laid over the flat module and cable list (assemblies, layout); the binary keeps only the parts the FM-1 uses.

### Page

Four rows of a device's card that K1..K4 turn at once on the FM-1.

### Panel core

`firmware/src/panel.c`: the panel logic, separate from the hardware layer, shared by the device, host tests and the WebAssembly build.

### Parameter pins

The two inputs `p1` and `p2` most modules have, each with an attenuverter, routed onto parameters by a matrix.

### Paraphonic

A poly assembly whose cards do not gate their own sound, so every card sounds whether played or not; its output is mixed at 1 / cards.

### Part

The engine-only module that stands for one Voicing module inside a poly group in the device form.

### Patch

The top of the nesting: the whole stored thing (modules, cables, assemblies and values, with its own tempo, morph and arpeggiators), one bank slot on the FM-1. Nothing contains a patch, and nothing inside one is a patch. Avoid: preset (that is one device's stored card values), program.

### Patch card

A PNG image of a patch drawn from its data, for sharing.

### Patch morphing

Fading every parameter of a patch towards its B side with Main's `morph` parameter and input.

### Pattern

One of a Steps track's note lists, numbered 1 to 64, with its own length and rate or the track's. The patch has one selected pattern number, and every track plays its pattern of that number; a track that has no pattern of that number plays its pattern 1. Patterns are saved in the patch.

### Piano roll

A pitch-by-step grid for a Steps track's notes: the editor's drawer, and on the FM-1 a melodic track's SEQ page, 8 pitches at a time.

### Pick mode

The expanded assembly's mode (its `card · N` button) where member rows are check boxes choosing what the collapsed card shows.

### Pile

A patch whose cards mostly overlap, as one opened from a link without positions.

### Pin

One of a module's two hidden parameter inputs (p1, p2) that the editor assigns when a cable is dropped on a parameter.

### Poly assembly

An assembly whose members run once per voice of the Voicing module that feeds it; also called a rack of voice cards.

### Preset

A stored set of card row values for one structure; any assembly device of that structure can load it, in the editor and on the FM-1. A device has presets when some exist for its structure; a plain module never does. Avoid: variant, sound, snapshot (the A/B flip), program.

### Preset chip

The ‹ name › control on an assembly device's card that picks one of its stored presets.

### Rail

The look of a gate cable: a hollow line.

### Reference engine

The TypeScript engine in `web/src/engine.ts` and `modules.ts`; the firmware's `engine.c` is ported from it.

### Release package

The firmware package built by `release.yml` for version X.Y (`matryoshka-X.Y.fwsc` with its sidecar), the exact bytes that are device-checked, bundled with the app and attached to the GitHub release.

### Requirement

One thing a task step asks the learner to do, checked live against the patch and shown as a check box in the step's text.

### Return to stock

Installing M-VAVE's official V15 firmware, bundled with the app, in place of whatever the FM-1 runs.

### Ribbon

A cable passing an open assembly frame's border; also the three-wire look of a keys cable.

### Riff

A loop of notes (from a MIDI file) a tutorial step may store in the course. The course still validates and saves it, but nothing plays it: the tutorial has no Riff button ([D-663](tutorial.md#D-663)).

### Row

One ruling in a ledger table, with a stable ID, a Status, a Date, and a Source.

### Ruling

A choice that got a row: someone else needs to know it to do their work correctly, and it could reasonably have gone another way.

### Safe mode

A boot that plays the fallback patch compiled into the firmware and reads nothing from flash.

### Sandbox mode

The state the editor and a connected FM-1 are in when Live is on and the editor's patch is a sandbox patch. The FM-1's own sound is muted. Its keys, knobs and page buttons play and edit the patch in the browser, which makes the sound.

### Sandbox patch

A patch over the FM-1 budget: too big for the FM-1, or using a browser-only ability. It plays in the browser with no limits and is never sent to the FM-1. It is a normal patch, not an error; the editor marks it SANDBOX in gold.

### Section

The rows under one card heading; it holds one or more groups.

### Selector

The control for a choice parameter: a notched groove with the jack on the live choice.

### SEQ page

The FM-1 screen, opened by SEQ, where a track is an 8 × 16 grid and the white keys are the selected row's steps: on a drum track the rows are the Drum map's and the black keys pick them; on a melodic track it is a piano roll and the black keys pick tracks.

### Settings record

The 65th record of the bank (`SL_SETTINGS`): the slot to boot, octave, LED mode and other FM-1 settings saved with SAVE.

### Share link

A URL whose fragment `#p=` carries the patch.

### Share sheet

The dialog that shares a patch: link, card image, Post to Reddit, file.

### Shedding

The FM-1's overload response: dropping the highest part of the busiest poly group.

### Sidecar

The `<package>.json` file `tools/build.py` writes next to a package: version, identity, size and sha256.

### Slop Disclosure

The About card's section of AI-usage figures: Blood (time), Sweat (human interventions) and Tears (AI spend).

### Slot

One of the bank's 64 patch places on the FM-1, shown numbered 01..64. Program change 0 selects slot 01.

### Song

A list of up to 64 entries, each a pattern number and a shift (a transpose of up to 12 semitones either way). While a song plays, each track plays one entry per pass of its own, in order, and starts again at the first entry after the last. A patch holds up to 8 songs.

### SONG page

The FM-1's page for a patch's songs, opened from the SEQ page by tapping SEL: one row per entry, the song's number, and whether the patch plays its songs or its selected pattern.

### Source

Where a teammate can find the ruling being made: a pull request, an issue, a commit, a document, a meeting note. Never something only one person can open.

### Status line

The line under the deck with hover help, messages, the FM-1 budget and the FM-1 chip.

### Step entry

Recording in the editor with the transport stopped: the keys held together fill the cursor's step, then the cursor moves on. The FM-1 has none.

### Steps track

A Steps module: a key source that plays an engine through its keys out. It holds up to 64 patterns of notes. Avoid: sequence, and pattern for the track itself (a pattern is one of its note lists).

### Stored link

A share link `#s=<id>` whose patch is kept on the site because the inline link would be too long.

### Structure

What makes two assemblies the same: their module types, cables, nesting and which (module, parameter) pairs are card rows; not values, positions, labels or row order.

### Structure fingerprint

A 32-bit hash of an assembly's module types, cables, nesting and card-row pairs, computed by the editor (`structure.ts`); presets are matched by it.

### Subject file

One markdown file in `docs/ledger/` covering one subject, with a current-state paragraph, a table, and a Not-yet-settled list.

### Task step

A tutorial step with requirements. A Continue step has none and only breaks up text or makes a listening pause.

### Through input

The input a bypassed module passes to its outputs: `in` by default, a mixer's `in1`, a crossfader's `a`.

### Thumb

The handle of a slider, which is also the parameter's input jack.

### Tombstone

What a superseded row becomes: Status `Superseded by` the new row, Decision cell reduced to a pointer. The ID never dangles.

### Tour

The unnumbered tutorial chapter for experienced users, "Overview for advanced users".

### Trail

The list (at most 8) of screens a button press has opened; a HOME tap goes back one.

### Unplugged

A part of a patch with no path to the Output: allowed and silent. A finished patch has none (editor-only modules such as a scope aside). Avoid: dead, disconnected (as an error).

### Untouched factory slot

A slot whose bytes equal a factory patch some earlier firmware wrote (`LEGACY_FACTORY` in `presets.h`).

### Update loader

Felucca's loader (`ota-FM-1_700` for ours) that the running firmware stages during an install; it writes the flash and waits after a cut-off write for the same install to finish it.

### Update mode

An in-app mode with only USB and firmware updates running, no audio engine, left by switching the FM-1 off.

### Variation

A saved copy of the learner's patch kept by the tutorial, so work replaced by a chapter start or by Back can be restored.

### Virtual cable

A dashed line the app draws to show a connection it makes for you (an armed device's keys, a knob's target); never saved, no undo. A cable you made is solid. Avoid: ghost cable, route.

### Voice

What plays one note inside an engine: a gate in (usually a pitch too), audio out; a kick is a drum voice. On its own it is not an engine. Avoid: voice for the polyphony count (that is "voices").

### Voices

In the web app, polyphony (how many notes at once). Avoid: voice for a single note's assembly when the count is meant.

### Voicing

The part of an engine that turns keys into notes for its voices. Allocated voicing gives each key a free voice (one voice is monophony); mapped voicing sends each key to its own voice, as a drum engine picks its drum. Done by a Voicing module (allocated; also called "Voice allocator") or a Drum map (mapped).

### XL

The full browser version of a factory patch that was cut down to fit the FM-1, named after it with "XL" ("Algo Four XL"). It is the original instrument's full specification, no less, and always has a Steps track and an Arpeggiator in front of its sound. An XL never goes into the FM-1's bank. "XL" is only a name: whether a patch is a sandbox patch is worked out from the patch itself.

### Your patches

The user's own patches kept in browser storage (`matryoshka.patches`), listed in the Open picker and the Library.
