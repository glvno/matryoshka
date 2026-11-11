// SPDX-License-Identifier: GPL-3.0-only
// Engines (glvno/matryoshka#159, redefined by docs/ledger/patches-and-presets.md#D-321, #189): an engine is an assembly that takes keys and makes
// audio: keys -> voicing -> voices. The rule is derived from what is inside (never names or the shelf), so the user's own
// assemblies qualify too: a `keys` input whose keys reach a Voicing module (`alloc`) or a Drum map inside it (through an
// Arpeggiator or a Steps track's keys out on the way), and at least one `audio` output. A lone voice (pitch + gate in) and
// a self-playing assembly are not engines. Inserting an engine wires it (wireEngine): Main's keys into it, and its audio
// into the Output while nothing feeds the Output yet.
import { targetsOf, type AssemblyDef, type AssemblyInst, type PortRef } from './assembly';
import { definitionGraph, instanceGraph, kindIn, recognizeEngine, type KindOf } from './assembly-capabilities';
export { isEngine, VOICING_TYPES } from './assembly-capabilities';
import { DEFS } from './modules';
import { connect, type ModuleDef, type Patch } from './patch';

/** Engine consumers keep their existing boolean interface; the query also exposes its evidence. */
export const defIsEngine = (def: AssemblyDef, defs: Record<string, ModuleDef> = DEFS): boolean =>
  recognizeEngine(definitionGraph(def), defs) !== null;

export const instIsEngine = (p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef> = DEFS): boolean =>
  recognizeEngine(instanceGraph(p, a), defs) !== null;

/** an engine's audio outputs, as the Output takes them: [l, r] for stereo (the ones labelled l and r if there are), [l] for mono */
export function audioOuts(outputs: PortRef[], kindOf: KindOf): PortRef[] {
  const audio = outputs.filter((r) => kindOf(r, 'out') === 'audio');
  const l = audio.find((r) => r.label === 'l');
  const r = audio.find((x) => x.label === 'r');
  if (l && r) return [l, r];
  return audio.slice(0, 2);
}

/** whether a definition plays in stereo (two audio outputs or more) */
export const defIsStereo = (def: AssemblyDef, defs: Record<string, ModuleDef> = DEFS): boolean => audioOuts(def.outputs, kindIn(def.modules, defs)).length > 1;

/** whether anything is cabled into the Output */
export const feedsOutput = (p: Patch): boolean => {
  const out = p.modules.find((m) => m.type === 'output');
  return !!out && p.cables.some((c) => c.to.module === out.id);
};

export interface Wired {
  /** Main's keys were cabled into the engine */
  keys: boolean;
  /** how many of its outputs went into the Output: 0 (the Output was fed already), 1 (mono) or 2 (stereo) */
  out: number;
}

/** wire an engine just put into the patch: Main's keys into its keys input (Main's keys may feed several allocators), and
 *  its audio into the Output when nothing feeds the Output yet. A non-engine is left alone. */
export function wireEngine(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef> = DEFS): Wired {
  const done: Wired = { keys: false, out: 0 };
  const kindOf = kindIn(p.modules, defs);
  if (!instIsEngine(p, a, defs)) return done;
  const main = p.modules.find((m) => m.type === 'fm1');
  const keysIn = a.inputs.find((r) => kindOf(r, 'in') === 'keys')!;
  if (main) for (const t of targetsOf(keysIn)) done.keys = connect(p, defs, { module: main.id, port: 'keys' }, t) || done.keys;
  const out = p.modules.find((m) => m.type === 'output');
  if (out && !feedsOutput(p)) {
    audioOuts(a.outputs, kindOf).forEach((r, i) => {
      if (connect(p, defs, { module: r.module, port: r.port }, { module: out.id, port: i ? 'r' : 'l' })) done.out++;
    });
  }
  return done;
}

/** the status line after an engine was wired */
export const wiredText = (name: string, w: Wired): string =>
  `"${name}" inserted${w.keys ? ', wired to the keys' : ''}${w.out === 2 ? ' and the Output (l, r)' : w.out === 1 ? ' and the Output' : ''}: play a key.`;
