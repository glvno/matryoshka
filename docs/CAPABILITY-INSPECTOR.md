# Capability inspector experiment

The inspector tests whether assembly capabilities can explain an editable patch without imposing a fixed layout. It is enabled by adding `?capabilities=1` to the editor URL. The Patch menu can reopen it with **Inspect assembly capabilities…**. It opens alongside the canvas, so the same assemblies remain editable.

This is an experimental inspection interface, not the final instrument view. Its role and scope are [D-962](ledger/editor.md#D-962), Proposed for michael glaviano. The [architecture proposal](ASSEMBLY-CAPABILITIES.md) describes the wider design.

## Try it

1. Start the editor with its usual `npm run dev` command from `web/`, or use a static build of this branch. Use the existing dev server if it already serves this checkout; do not start a second one for it.
2. Open the editor with `?capabilities=1`.
3. In the inspector, choose **02 custom effects** and click **Load example**. This opens the example as the editor's patch.
4. Choose **Two filters** in the assembly list. The inspector shows the exposed audio ports and the modules on the supported path.
5. Click **Validate dry route** to check the explicitly selected input/output pair. This is a contract preview; it does not bypass playback or store a declaration.
6. Expand the assembly in the editor and remove the cable between the filters. Audio-processing recognition disappears. Undo restores it. Renaming or moving the assembly does not remove recognition.
7. Compare **01 factory effects**, **05 shared effects**, **06 no engine** and **07 nested**. A shared effect remains one assembly; a parent and child can both qualify as engines; audio processing does not require an engine.

Close the panel with its Close button or Escape while focus is inside it. Ordinary sessions without the query flag do not load the inspector or its example chunks. No experimental declarations are added to saved patches or assembly presets.

## What is recognized

`assembly-capabilities.ts` supplies the engine recognition evidence used by the existing boolean helpers in `engines.ts`. The [existing contract](capability-examples/ENGINE-CONTRACT.md) still applies, including its lack of an audible voice-to-output guarantee. Insertion behavior is unchanged.

The audio experiment describes the primitive audio dependencies of Delay, Reverb and Multimode filter. It traces those dependencies and internal audio cables from exposed audio inputs to exposed audio outputs. Each exposed audio input and output must participate in a supported path. Primitive dependencies are necessary because a module's port kinds alone do not prove which output responds to an input.

Unknown dependencies receive a diagnostic rather than an invented route. Merged audio inputs are outside this experiment. A recognized path establishes structural dependence, not audible output at every setting, a complete account of all side paths, stereo semantics or a resource saving. Control values can still mute or change the sound. Custom and factory assemblies use exactly the same query.

Recognition is refreshed after editor structure and layout notifications. The query does not cache an execution plan. The inspector lists assembly IDs and ports for investigation; these details are not proposed final instrument controls.

## Bypass contract preview

The preview validates an explicit input/output pair against the current graph. It supports a flat, complete mono serial chain of the supported audio processors, with no extra ports, feedback, branches, polyphonic assembly setting or cables entering internal control points. Multiple outside audio sources may feed the one exposed input. The preview rejects declarations that no longer match the graph.

Its reported behavior is the existing module bypass behavior: each processor passes its input to its outputs instead of processing. Processing state stops advancing and remains allocated. Tails are not heard during bypass. Reactivation can reveal the retained state. There is no claim of tail spillover, buffer reclamation or click-free switching ([D-963](ledger/editor.md#D-963), Proposed for michael glaviano).

The preview neither applies that operation nor persists its declaration. The existing ordinary bypass controls continue to work independently. The next experiment must choose a representation and verify application, restoration of mixed bypass states, reactivation and device behavior before this preview becomes a new playback control.

## Branch workflow

The temporary project branch is `capabilities-integration`. Small implementation branches target it by pull request. Normal fixes and features continue through `main`; relevant changes are merged into the project branch after their normal review. Shared project-branch history is not rebased or force-pushed. Before integration into `main`, bring it up to date and review/test the combined result. Retire the project branch when the work lands or the experiment is stopped. This scoped proposal is [D-148](ledger/releases.md#D-148), Proposed for michael glaviano; the normal `main` workflow in [D-145](ledger/releases.md#D-145), Decided, remains in force.

## Verification

Targeted checks cover legacy engine classification and insertion, factory/custom effects, missing cables, unsupported primitive dependencies, overlapping capabilities, nested/shared assemblies, mapped voicing, cycles, merged keys inputs, stale bypass mappings, external modulation, inspector refresh and focus behavior. The existing example checker remains available:

```sh
cd web
npx vitest run src/assembly-capabilities.test.ts src/capability-inspector.test.ts src/engines.test.ts src/key-routing.test.ts
npx vite-node scripts/capability-examples.ts
```

The prototype has no firmware or patch-format change. Device resource measurements and firmware capability controls remain separate work.
