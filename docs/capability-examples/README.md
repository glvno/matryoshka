# Capability design examples

These maintained patch fixtures make the [capability proposal](../ASSEMBLY-CAPABILITIES.md) concrete. They use the current patch format and contain no new capability metadata. Open the JSON files through the editor's patch loader. They are design examples, not additions to the factory bank or hardware-qualified sounds.

## Examples and future acceptance checks

| Case | Patch or operation | Current fact | Future acceptance criterion |
|---|---|---|---|
| 01 | [Factory engine and echo](01-factory-effects.json) | Mono lead feeds the factory delay/reverb assembly | Recognize engine and audio processing independently; no name-based privilege |
| 02 | [Custom effects](02-custom-effects.json) | Mono lead feeds an assembly of two ordinary filters | Give custom audio processing the same eligible controls as a factory assembly; do not infer wet/dry from arbitrary rows |
| 03 | Connect Arpeggiator keys output to Harmonizer keys input | Current `key-routing.ts` rejects this connection | Show the limitation honestly; supporting this order requires new note-routing behavior, not metadata |
| 04 | [Steps, harmony, then arp](04-harmony-arp.json) | All three are separate assemblies before mono lead; this route validates | Discover distinct performance capabilities without requiring one performance container; editing one does not duplicate the others |
| 05 | [Shared effects](05-shared-effects.json) | Two mono leads feed the same echo input; audio inputs sum their sources | Show one shared effects instance; changing one sound does not replace it or alter the other sound |
| 06 | [Audio without an engine](06-no-engine.json) | A continuous oscillator feeds the custom filters; no recognized engine | Keep the patch usable and present effects without inventing an engine or hiding the sound |
| 07 | [Nested engine and effects](07-nested.json) | Parent and nested mono lead both qualify as engines | Preserve both identities while avoiding a misleading duplicate instrument or duplicated processor allocation |
| 08 | [Drum engine and effects](08-drums.json) | The factory drum kit feeds echo | Recognize mapped voicing; do not present allocated polyphony controls merely because it is an engine |

The first effects experiment uses cases 01 and 02. Neither fixture claims to implement a general bypass contract today. An explicit bypass mapping and its state behavior must be designed and checked before a convenience control can use it.

For cases 01, 02 and 07, remove the effects assembly, expose another audio output, rename controls, and move the cards. Recognition should follow valid structural facts rather than names or screen positions. Dissolving an assembly must leave its modules available through the ordinary editor. No interface may move an effect across a voice-allocation boundary merely to make a simpler chain.

For case 04, changing the order to case 03 is an intentionally unsupported baseline operation under [D-783](../ledger/modules.md#D-783), Decided. Supporting it needs an explicit change to that ruling as well as note-on/off, sustain, transport, bypass and deletion checks. Steps contains no authored phrase in this fixture; recorded-note preservation is a later recall test, not a claim established by this example.

For cases 05 and 07, a future sound-selection operation must identify which exact assembly values it changes. Sharing or nesting alone does not infer preset ownership. Ordinary structure-specific assembly presets continue to work as before.

## Reproduce the structural checks

From `web/`:

```sh
npx vite-node scripts/capability-examples.ts
```

The checker rebuilds all seven patches using existing editor operations, loads them through `validatePatch`, verifies that validation preserves cables and module/assembly counts, checks current engine recognition counts, and compares each saved file with the rebuilt result. It also verifies that case 03 is rejected. To intentionally refresh the maintained fixtures after reviewing a source change:

```sh
npx vite-node scripts/capability-examples.ts --write
```

These checks establish valid current structure and reproducibility. They do not establish new capability behavior, audible output, processor cost, effect-tail behavior or FM-1 resource fit. The later optimization slice needs separate mono, high-cost polyphonic, drum and shared-effects measurements using the [validation stages](../EMULATOR.md#choosing-checks).
