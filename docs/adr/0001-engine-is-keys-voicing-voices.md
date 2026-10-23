---
status: accepted
---

# An engine is keys → voicing → voices

#159 called any assembly with a `keys` input and an `audio` output an engine, and a voice anything with pitch + gate in. On 2026-10-22 the owner redefined both by role rather than by ports: an **engine** is an assembly that takes keys and makes audio, its **voicing** turns the keys into notes for its **voices**, and a voice (a gate in, usually a pitch, audio out) is never an engine on its own, so a monosynth is voicing with one voice plus a voice. Voicing has two kinds, allocated (the Voice allocator, renamed "Voicing" in user-visible text) and mapped (the Drum map: each key its own voice, which is how a drum engine picks its drum and how 8 Lire and Elvira 2 take keys). Key sources (Main, Steps tracks, Arpeggiators) feed engines and are never part of one. Engines are derived from this shape, with no checkbox, and presets belong to assembly devices, not to engines, because a device's card rows are what the FM-1 edits even when the engine sits inside it.

## Considered options

- **Ports decide (#159 as it was):** any keys-in, audio-out assembly is an engine. Rejected: a pitch + gate monosynth would not count, and the Drum map engines only fit by accident.
- **An explicit Engine checkbox** (any kind of assembly, logic too, with presets): chosen for a while the same day, then dropped. Presets moved to devices, which removed the checkbox's only lasting job, and the owner decided that in synthesizer language an engine makes audio.
- **Any audio source is an engine** (the Mutable Plaits sense: a pluck alone, a kick alone): rejected; nothing then tells a voice from the instrument built of voices, and a drum engine needs keys to pick the drum.

## Consequences

- Rain-like self-playing textures and lone voices are plain assemblies: not on the Engines shelf, though as devices they can still have presets.
- The Voice allocator's user-visible name changes to Voicing; its module type id stays (type and port indices are append-only).
