# Matryoshka

A patchable synth for the M-VAVE FM-1: an editor in the browser and firmware that plays the same patches. This file is the glossary only; the design is in docs/ARCHITECTURE.md.

## Language

**Patch**:
The top of the nesting: the whole stored thing (modules, cables, assemblies and values, with its own tempo, morph and arpeggiators), one bank slot on the FM-1. Nothing contains a patch, and nothing inside one is a patch.
_Avoid_: preset (that is one device's stored card values), program

**Assembly**:
A reusable nested building block of modules whose collapsed card shows only what it exposes.
_Avoid_: macro, group, sub-patch

**Engine**:
An assembly that takes keys and makes audio: its voicing turns the keys into notes for its voices. It can be a device or sit inside one, and a patch can hold several.
_Avoid_: machine, patch (an engine is never a whole patch)

**Voicing**:
The part of an engine that turns keys into notes for its voices. Allocated voicing gives each key a free voice (one voice is monophony); mapped voicing sends each key to its own voice, as a drum engine picks its drum.
Done by a Voicing module (allocated; was "Voice allocator") or a Drum map (mapped).

**Voice**:
What plays one note inside an engine: a gate in (usually a pitch too), audio out; a kick is a drum voice. On its own it is not an engine.
_Avoid_: voice for the polyphony count (that is "voices")

**Key source**:
What feeds an engine its keys from outside it: Main (the panel keys and MIDI), a Steps track, an Arpeggiator. Never part of an engine.
_Avoid_: driver, controller

**Steps track**:
A Steps module: a sequence of notes, a key source that plays an engine through its keys out.
_Avoid_: sequence, pattern

**Environment**:
The patch's devices seen as a rack of equipment, from Main to Output; the ENV button opens it on the FM-1, and in the editor the canvas is the environment. Presets are picked and rows armed there.
_Avoid_: rack, mixer, set list

**Arm**:
To make a device with a keys input hear Main's keys, cable or not. Several devices can be armed at once (a layer, or a split by their key ranges); while any is armed, only armed devices hear Main, and while none is, the cables decide. Arming reroutes only Main: other key sources keep playing what they drive.

**Virtual cable**:
A dashed line the app draws to show a connection it makes for you (an armed device's keys, a knob's target); never saved, no undo. A cable you made is solid.
_Avoid_: ghost cable, route

**Device**:
A top-level module or assembly as the FM-1 player sees it, paged by SELECT, its card rows edited by K1..K4. Main is the first device and Output the last; Steps tracks are devices too.
_Avoid_: device for the FM-1 itself (say "the FM-1")

**Card rows**:
The parameters an assembly promotes to its collapsed card; they are what the FM-1 player can change.

**Structure**:
What makes two assemblies the same: their module types, cables, nesting and which (module, parameter) pairs are card rows; not values, positions, labels or row order.

**Preset**:
A stored set of card row values for one structure; any assembly device of that structure can load it, in the editor and on the FM-1. A device has presets when some exist for its structure; a plain module never does.
_Avoid_: variant, sound, snapshot (the A/B flip), program

**Unplugged**:
A part of a patch with no path to the Output: allowed and silent. A finished patch has none (editor-only modules such as a scope aside).
_Avoid_: dead, disconnected (as an error)

**Global**:
Belonging to the FM-1, not to any patch (the GLO page, the MENU).
_Avoid_: global for the patch's own tempo, morph and arpeggiators

**Voices**:
In the web app, polyphony (how many notes at once).
_Avoid_: voice for a single note's assembly when the count is meant
