// SPDX-License-Identifier: GPL-3.0-only
// Engines (glvno/matryoshka#159, redefined by docs/ledger/patches-and-presets.md#D-321, #189): an engine is an assembly that takes keys and makes
// audio: keys -> voicing -> voices. The rule is derived from what is inside (never names or the shelf), so the user's own
// assemblies qualify too: a `keys` input whose keys reach a Voicing module (`alloc`) or a Drum map inside it (through an
// Arpeggiator or a Steps track's keys out on the way), and at least one `audio` output. A lone voice (pitch + gate in) and
// a self-playing assembly are not engines. Inserting an engine wires it (wireEngine): Main's keys into it, and its audio
// into the Output while nothing feeds the Output yet.
import { allModules, targetsOf, type AssemblyDef, type AssemblyInst, type PortRef } from './assembly';
import { DEFS } from './modules';
import { connect, type Cable, type ModuleDef, type ModuleInst, type Patch, type SignalKind } from './patch';

type KindOf = (r: PortRef, dir: 'in' | 'out') => SignalKind | undefined;

/** the module types that voice keys: allocated (Voicing) and mapped (Drum map) */
export const VOICING_TYPES = new Set(['alloc', 'drummap']);

/** whether keys going into this input reach a voicing, following keys cables (an Arpeggiator's or a Steps track's keys out)
 *  among these modules */
function reachesVoicing(start: PortRef, modules: ModuleInst[], cables: Cable[], defs: Record<string, ModuleDef>): boolean {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const seen = new Set<number>();
  const todo = targetsOf(start).map((t) => t.module);
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const m = byId.get(id);
    if (!m) continue;
    if (VOICING_TYPES.has(m.type)) return true;
    const keysOut = defs[m.type]?.outputs.filter((o) => o.kind === 'keys').map((o) => o.name) ?? [];
    for (const c of cables) if (c.from.module === id && keysOut.includes(c.from.port) && byId.has(c.to.module)) todo.push(c.to.module);
  }
  return false;
}

/** the rule: a keys input that reaches a voicing, and an audio output */
export const isEngine = (inputs: PortRef[], outputs: PortRef[], kindOf: KindOf, voiced: (r: PortRef) => boolean = () => true): boolean =>
  inputs.some((r) => kindOf(r, 'in') === 'keys' && voiced(r)) && outputs.some((r) => kindOf(r, 'out') === 'audio');

/** a port's kind, looked up on the module it points at */
const kindIn = (modules: ModuleInst[], defs: Record<string, ModuleDef> = DEFS): KindOf => (r, dir) => {
  const d = defs[modules.find((m) => m.id === r.module)?.type ?? ''];
  return (dir === 'in' ? d?.inputs : d?.outputs)?.find((p) => p.name === r.port)?.kind;
};

export const defIsEngine = (def: AssemblyDef, defs: Record<string, ModuleDef> = DEFS): boolean =>
  isEngine(def.inputs, def.outputs, kindIn(def.modules, defs), (r) => reachesVoicing(r, def.modules, def.cables, defs));

/** an assembly's own modules, nested ones included */
const membersOf = (p: Patch, a: AssemblyInst): ModuleInst[] => {
  const ids = new Set(allModules(p, a));
  return p.modules.filter((m) => ids.has(m.id));
};

export const instIsEngine = (p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef> = DEFS): boolean =>
  isEngine(a.inputs, a.outputs, kindIn(p.modules, defs), (r) => reachesVoicing(r, membersOf(p, a), p.cables, defs));

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
