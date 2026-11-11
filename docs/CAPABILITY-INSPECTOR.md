# Capability inspector experiment

The inspector tests whether assembly capabilities can explain an editable patch without imposing a fixed layout. It is enabled by adding `?capabilities=1` to the editor URL. The Patch menu can reopen it with **Inspect assembly capabilities…**. It opens alongside the canvas, so the same assemblies remain editable.

This is an experimental inspection interface, not the final instrument view. Its role and scope are [D-962](ledger/editor.md#D-962), Proposed for michael glaviano. The [architecture proposal](ASSEMBLY-CAPABILITIES.md) describes the wider design.

## Try it

1. Start the editor with its usual `npm run dev` command from `web/`, or use a static build of this branch. Use the existing dev server if it already serves this checkout; do not start a second one for it.
2. Open the editor with `?capabilities=1`.
3. In the inspector, choose **02 custom effects** and click **Load example**. This opens the example as the editor's patch.
4. Choose **Two filters** in the assembly list. The inspector shows the exposed audio ports and the modules on the supported path. Module names appear beside numeric patch-local IDs, so two filters with the same name remain distinguishable. The `lp12` output is labeled **low pass · 12 dB/octave**.
5. Click **Validate dry route** to check the explicitly selected input/output pair. This is a contract preview; it does not bypass playback or store a declaration.
6. Expand the assembly in the editor and remove the cable between the filters. Audio-processing recognition disappears. Undo restores it. Renaming or moving the assembly does not remove recognition.
7. Compare **01 factory effects**, **05 shared effects**, **06 no engine** and **07 nested**. A shared effect remains one assembly; a parent and child can both qualify as engines; audio processing does not require an engine.
8. Load **04 harmony arp** and select **Harmonizer**, **Arpeggiator** and **Steps** in the assembly list. The coverage note says performance recognition is not implemented. The engine and audio-processing requirement messages describe only those implemented contracts; they do not say these performance assemblies are invalid. Ordinary editing and keys-routing rules still apply.

Close the panel with its Close button or Escape while focus is inside it. Ordinary sessions without the query flag do not load the inspector or its example chunks. No experimental declarations are added to saved patches or assembly presets.

## What is recognized

`assembly-capabilities.ts` supplies the engine recognition evidence used by the existing boolean helpers in `engines.ts`. The [existing contract](capability-examples/ENGINE-CONTRACT.md) still applies, including its lack of an audible voice-to-output guarantee. Insertion behavior is unchanged.

The audio experiment describes the primitive audio dependencies of Delay, Reverb and Multimode filter. It traces those dependencies and internal audio cables from exposed audio inputs to exposed audio outputs. Each exposed audio input and output must participate in a supported path. Primitive dependencies are necessary because a module's port kinds alone do not prove which output responds to an input.

Unknown dependencies receive a diagnostic rather than an invented route. Merged audio inputs are outside this experiment. A recognized path establishes structural dependence, not audible output at every setting, a complete account of all side paths, stereo semantics or a resource saving. Control values can still mute or change the sound. Custom and factory assemblies use exactly the same query.

Performance capability recognition is not implemented. Harmony (the Harmonizer), Arp (the Arpeggiator) and Steps are not classified as performance capabilities by this inspector. Existing engine recognition can follow keys cables through such modules to voicing, but that does not establish a performance contract. The **04 harmony arp** example demonstrates the existing Steps → Harmony → Arp route before a mono lead. It contains no authored Steps phrase and does not demonstrate recorded-note preservation.

The inspector separates missing implementation from unmet requirements. It states the performance recognition limit separately from the engine and audio-processing results. A missing engine or audio-processing result means that contract's requirements were not met, not that the assembly or patch is invalid. Diagnostics remain visible for missing ports, incomplete supported audio paths and undescribed audio dependencies.

Recognition is refreshed after editor structure and layout notifications. The query does not cache an execution plan. Assembly headings, module routes, voicing targets and port references show current names beside numeric patch-local IDs. Renaming updates the displayed names without changing recognition, and IDs distinguish duplicate names. Port references also retain their raw port identifiers for investigation. These details are not proposed final instrument controls.

## Bypass contract preview

The preview validates an explicit input/output pair against the current graph. It supports a flat, complete mono serial chain of the supported audio processors, with no extra ports, feedback, branches, polyphonic assembly setting or cables entering internal control points. Multiple outside audio sources may feed the one exposed input. The preview rejects declarations that no longer match the graph.

Its reported behavior is the existing module bypass behavior: each processor passes its input to its outputs instead of processing. Processing state stops advancing and remains allocated. Tails are not heard during bypass. Reactivation can reveal the retained state. There is no claim of tail spillover, buffer reclamation or click-free switching ([D-963](ledger/editor.md#D-963), Proposed for michael glaviano).

The preview neither applies that operation nor persists its declaration. The existing ordinary bypass controls continue to work independently. The next experiment must choose a representation and verify application, restoration of mixed bypass states, reactivation and device behavior before this preview becomes a new playback control.

## Branch workflow

The inspector follows the normal `main` integration workflow in [D-145](ledger/releases.md#D-145), Decided. Its example patches, structural checker and design notes travel with the inspection feature. The wider [architecture proposal](ASSEMBLY-CAPABILITIES.md) remains a proposal; landing the inspector does not approve or implement its later playback controls, stored capability declarations, firmware changes or sound-selection interface. Targeted checks follow [D-144](ledger/releases.md#D-144), Decided; this editor-only inspection feature does not require device qualification.

## Verification

Targeted checks cover legacy engine classification and insertion, factory/custom effects, missing cables, unsupported primitive dependencies, overlapping capabilities, nested/shared assemblies, mapped voicing, cycles, merged keys inputs, stale bypass mappings, external modulation, inspector refresh and focus behavior. The existing example checker remains available:

```sh
cd web
npx vitest run src/assembly-capabilities.test.ts src/capability-inspector.test.ts src/engines.test.ts src/key-routing.test.ts
npx vite-node scripts/capability-examples.ts
```

The prototype has no firmware or patch-format change. Device resource measurements and firmware capability controls remain separate work.
