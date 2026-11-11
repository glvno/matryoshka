# Current engine recognition contract

This describes the recognition implementation in `web/src/assembly-capabilities.ts`, its callers `defIsEngine` and `instIsEngine` in `web/src/engines.ts`, and their regression tests. It is the baseline preserved by the capability query, not a stronger validation rule. The ruling is [D-321](../ledger/patches-and-presets.md#D-321), Decided.

## Recognition

An assembly qualifies when both conditions hold:

1. At least one exposed input resolves to a module input of kind `keys`, and a traversal from that input reaches a module whose type is `alloc` or `drummap`.
2. At least one exposed output resolves to a module output of kind `audio`.

The traversal starts with the input's primary module and its additional merged targets (`also`). It follows cables leaving a module's outputs whose kind is `keys`, while staying within the assembly's member modules. For an instance, members include nested children. Visited module IDs prevent cycles from looping forever. Reaching either voicing type succeeds immediately.

Port kinds come from module definitions, not labels or shelf names. Recognition does not require a factory identifier. A plain voice accepting pitch and gate, an effects assembly, or a self-playing oscillator without a qualifying keys path is not an engine under this rule.

The low-level `isEngine` helper defaults its voicing predicate to true. Callers needing the actual contract must supply the traversal predicate, as `defIsEngine` and `instIsEngine` do. Treating the helper's default as the complete contract would weaken recognition.

## What the check does not establish

It does not prove that the reached voicing drives the exposed audio output. It does not prove audible output, voice count, exclusive ownership of the path, resource fit, supported note routing, or substitutability for another engine. Additional merged targets are traversed by module ID; this traversal is not a general validator for every referenced target port.

The existing test deliberately recognizes a user's assembly with a Voicing module and a disconnected VCA exposing audio. Preserve that result during extraction. If a later operation requires a connected voice-to-audio path, give it a stronger check rather than silently changing this baseline.

## Existing insertion convenience

`wireEngine` recognizes the instance, selects its first exposed keys input and connects Main's keys to that input's targets. Recognition may have succeeded through a different exposed keys input. This distinction is an existing limitation to exercise, not a guarantee that insertion always chooses the qualifying input.

Audio connects to Output only when nothing already feeds Output. A stereo pair labeled `l` and `r` is preferred; otherwise the first two audio outputs are used. One output connects to `l`. These are insertion conveniences, separate from recognition, and do not constrain later edits.

## Baseline acceptance cases

| Case | Current expected result |
|---|---|
| Factory mono lead and a user copy with different names and positions | Both qualify |
| Keys reach Voicing through an Arpeggiator | Qualifies |
| Keys reach Drum map | Qualifies |
| Keys input exists but does not reach either voicing type | Does not qualify |
| Reached Voicing and unrelated exposed audio output | Qualifies; no signal-path guarantee |
| Pitch/gate voice or self-playing oscillator without keys | Does not qualify |
| Parent exposes a nested engine's qualifying input and audio output | Parent and child can both qualify |
| Reachability graph has a cycle | Terminates; succeeds only if a voicing type is reachable |
| First keys input is unvoiced, later keys input reaches Voicing | Recognized; insertion's first-input choice requires separate scrutiny |

The capability query's regression tests cover nested engines, merged targets, later qualifying inputs and cycles. Extracting the recognizer does not strengthen this contract or change insertion behavior.
