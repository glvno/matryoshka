# Assembly capabilities

This is the design proposal for an instrument interface over Matryoshka's existing modular patch model. It does not describe a shipped capability system. The approved design constraints are [D-960](ledger/editor.md#D-960) and [D-961](ledger/editor.md#D-961), both Decided. Engineering details below are candidates to test, not a patch format specification.

## Problem and intended experience

A player should be able to find synthesis, effects, arpeggiation, harmony and sequencing controls without tracing every cable. A patch author should remain free to reorder, nest, share, remove or replace those pieces where their contracts allow it. Factory patches demonstrate convenient arrangements; their arrangements do not define which patches are valid. Providing all these abilities around factory engines remains a product goal subject to each patch's FM-1 budget.

An assembly's capabilities describe what the interface can safely do with it. They do not prescribe its implementation or assign it one exclusive category. The graph remains the source of routing and execution behavior. The instrument interface presents that graph; opening it does not rewrite the graph.

## Existing model remains intact

- An assembly groups editable modules, cables, nested assemblies and exposed controls.
- An engine is recognized from an assembly's contents, under [D-321](ledger/patches-and-presets.md#D-321), Decided. The [engine contract](capability-examples/ENGINE-CONTRACT.md) documents the current implementation's precise limits.
- Presets store exposed values for one assembly structure, including assemblies that do not generate sound ([D-322](ledger/patches-and-presets.md#D-322), Decided). Interface compatibility does not imply preset compatibility.
- A patch stores the whole setup. This proposal introduces no required instrument container, slot type or engine/performance/effects nesting hierarchy.

## Candidate contracts

Each contract needs a version, required observations, optional control bindings, supported operations and failure behavior. The serialized representation is open. The following are separate candidates, not an interface hierarchy every assembly must implement.

| Capability | Required meaning to establish | Not implied |
|---|---|---|
| Engine recognition | The existing keys-to-voicing rule and exposed audio output | An audible path, a particular voice count, or replaceability |
| Audio processing | Identified audio inputs and outputs, their channel relationships and relevant paths | Wet/dry control, bypass, silence without input, or shared execution |
| Bypass | The input-to-output mapping while bypassed and handling of internal state | Tail preservation or released memory |
| Wet/dry control | An exposed control with a defined range and dry/wet meaning | Equal-power mixing or an arbitrary control named MIX |
| Note processing | Note input/output roles and ownership of generated note releases | Clock use, one output note per input, or a sequencer |
| Clock synchronization | Tempo source, clock input and transport semantics | That transport stop disables all note processing |
| Pattern playback | Pattern selection, transport behavior and stored-note ownership | That every performance assembly contains patterns |

An assembly can satisfy several contracts. A parent and its child can both qualify. Effects and Performance can be presentation groupings over these smaller abilities rather than exclusive assembly types.

Matching port kinds alone do not establish a meaningful composition. Harmony establishes a chord voicing; the Arpeggiator sequences its notes. The reverse route is intentionally prohibited by [D-783](ledger/modules.md#D-783), Decided, and is not an expansion goal. Performance contracts need to describe the note relationships and timing an operation requires, not just declare keys input and output. Modular freedom preserves these behavioral requirements.

## Recognition and author declarations

Infer facts that the graph proves. When meaning cannot be inferred, let an author identify an existing port or exposed control and validate the binding. Names such as MIX are not evidence. Factory and user assemblies use the same validation path.

Suggested resolver output is a set of recognized capabilities with their resolved targets and diagnostics. Keep unresolved or invalid declarations distinct from verified capabilities. A failed optional declaration removes its convenience controls, not the underlying patch's ability to play. Actual invalid patches still follow normal validation rules.

Recognition must not guess a preferred processor when several qualify. The presentation needs to show the actual instances and let the player select one. Nested and shared instances must retain identity; a shared reverb is one object with multiple incoming routes, not a separate reverb for each engine.

A structural edit requires recognition to be refreshed before a convenience action uses its targets. Undo must restore both the graph and any author declarations. Whether declarations affect preset fingerprints, and how older editors preserve unknown declarations, remain open format questions.

## Editor and firmware responsibilities

Candidate flow: editable graph → validated capability description → existing device compilation → resolved firmware controls. Recheck targets after compilation because module indices can change and unused modules can disappear. Do not transmit editor indices as if they were device indices.

The editor explains missing bindings and exposes the full modular model. The firmware uses bounded, validated descriptions for controls it supports. Discovery belongs at editing, compilation or load time, not in each audio block. The experiment must decide which facts the firmware verifies itself and which descriptions it receives from the compiler.

Unknown optional presentation information can be ignored only when the underlying patch format and modules are already supported. New execution semantics cannot be hidden in optional metadata; they require normal version and compatibility handling. The first experiment does not change the on-disk format or device protocol.

## Preset recall and replacement

Ordinary assembly preset loading keeps its current structure-specific meaning. Replacing an assembly remains a different operation. Matching audio ports can support preserving audio cables, but cannot authorize translating cutoff automation into feedback automation.

The sound-selection design preserves notes, arrangement, tempo, arp and harmony settings, shared effects and other sounds. It changes synthesis and effects belonging to the selected sound ([D-961](ledger/editor.md#D-961), Decided). This is a requirement for the proposed selection interface, not a new meaning for every assembly preset.

How to select several compatible assembly presets together is unresolved. Options include explicit selections applied together or a saved list of references and values. Do not introduce either format in the first experiment. A user may independently load a performance assembly's preset to change its settings. Shared-effect send amounts, ownership of effect controls exposed by multiple assemblies, and atomic undo across multiple targets need explicit decisions.

## Resource behavior

Recognition is not an optimization proof. A processor's location and dependencies determine whether it runs per voice or once after mixing. Existing shared modules and compile optimizations already save resources; measure additional savings against that baseline.

Separate absent, active and bypassed processing. Releasing buffers while bypassed needs a policy for tails, reactivation latency and allocation failure. Keeping controls available does not mean reserving every possible effect. The desired universal factory experience does not promise maximum polyphony with every effect active.

Only optimize a recognized implementation when equivalence is proven. Otherwise use the existing execution path. Report processor time, memory, flash and load cost separately. Use the existing bit-exact rule for speed-ups ([D-356](ledger/engine.md#D-356), Decided) and the current [validation stages](EMULATOR.md#choosing-checks) before device work.

## Implementation slices and exit criteria

1. **Document the baseline.** Review this proposal, the engine contract and the [example patches](capability-examples/README.md). Resolve any disagreement between recognition and the behavior a caller expects. No changed runtime or format.
2. **Extract engine recognition behind a capability query.** Keep current results and insertion behavior. Existing factory and user cases, nested engines, merged inputs and cycles retain their results. No new capability metadata is required.
3. **Prove one effects contract in the editor.** Use factory echo and a custom two-filter assembly. Identify their audio paths and prototype explicit bypass mappings. Both remain editable. Breaking a requirement removes only the relevant convenience. No bypass or memory-saving claim follows merely from audio-processing recognition.
4. **Prove the corresponding firmware controls.** Use the same accepted and rejected cases. Resolve bounded descriptions at load, check targets after device compilation, and preserve the generic execution path. Before any format change, settle versioning, unknown metadata and older-firmware behavior.
5. **Build a graph-derived instrument view.** Show nesting, sharing, missing capabilities and selected instances. Allow valid reordering and removal without hidden rewiring. Verify save/load and undo preserve the graph; toggling views changes no stored sound state.
6. **Add performance contracts one at a time.** Start with note processing. Then add clock and pattern behavior using arp, harmony and Steps. Check note release, sustained notes, transport stop, bypass, arming, fan-out, deletion and permitted processor orders. Preserve rejection of arp into harmony as a behavioral constraint.
7. **Add coordinated sound selection.** Settle its ownership and storage questions before coding. Verify the agreed preserved state and reject incompatible presets without partial application.
8. **Measure and optimize.** Compare cheap mono, expensive polyphonic, drum and shared-effects patches. Establish actual device costs for absent/bypassed/active states. Record any supported fast path and its fallback; do not silently lower polyphony to make a demonstration fit.

These are dependent implementation slices, not completed features or release commitments. Work status belongs to the pull request and later issues.

## Open decisions before expansion

- Which declarations are needed beyond structural recognition, and what is their identity across edits?
- Which stereo, multi-input, feedback and sidechain arrangements can the first audio-processing contract express?
- How does bypass treat tails and internal feedback? What happens on reactivation?
- How are nested qualifying assemblies presented without duplicate or misleading controls?
- Which facts are checked on the firmware, and how does metadata survive old-editor round trips?
- How are multiple preset selections coordinated, and do send amounts belong to the sound or the mix?
- How should performance contracts express the note relationships and timing requirements behind the permitted routes in [D-783](ledger/modules.md#D-783), Decided?

The initial examples make these questions reviewable. They do not assert that unimplemented contracts or unsupported note routes already work.
