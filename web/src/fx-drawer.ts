// SPDX-License-Identifier: GPL-3.0-only
// FX drawers (docs/ledger/vocabulary.md "FX drawer"): an instrument's own chain of stereo audio effects, or the Output
// drawer shared by the whole patch. A drawer is an assembly with `drawer` (assembly.ts); its children are its effects in
// signal order, each an assembly with `chain` (its stereo in / out jacks). This file is the only place that writes the
// chain's cables: after every drawer edit `rewire` makes them follow the chain, so taking an effect out never leaves the
// sound with a gap (#1214). Plain modules and mono assemblies become stereo effects first (`wrapEffect`): an in-line
// effect runs as an L/R pair, a stereo one (mono in, two outputs) as a pair with a correction, a wet one takes a mono mix
// and adds its wet to both sides (the D-1010 bus's rules).
import {
  addChild,
  allModules,
  assembliesOf,
  assemblyById,
  assemblyOf,
  deleteAssembly,
  descendants,
  drawerOf,
  drawerOfEffect,
  drawers,
  effectsOf,
  findRef,
  insertAssembly,
  makeAssembly,
  moveAssembly,
  outputDrawer,
  ownerOf,
  parentOf,
  reconcile,
  removeChild,
  removeMember,
  rowTargets,
  targetsOf,
  toDef,
  validateAssemblyDef,
  type AssemblyDef,
  type AssemblyInst,
  type ParamRef,
  type PortRef,
  type Target,
} from './assembly';
import { convertLegacyBus as convertBus, LEGACY_STAGE_ROWS, type FxStageKind } from './fx-legacy';
import { DEFS } from './modules';
import { addModule, connect, disconnect, sameEnd, type Cable, type Endpoint, type ModuleInst, type Patch } from './patch';

// (the drawers' read side lives in assembly.ts, so the engine and the binary read it without the catalog)
export {
  chainHelpers, deviceModules, drawerOf, drawerOfEffect, drawers, effectsOf, outputDrawer, ownerOf, rackOf,
  type Rack, type RackDrawer, type RackEffect,
} from './assembly';

/** how an effect sits in the stereo chain: true stereo, an L/R pair of a mono effect, or a mono effect's wet added to both sides */
export type ChainMode = 'stereo' | 'pair' | 'wet';
/** a chain channel: 0 = left, 1 = right */
export type Channel = 0 | 1;
/** the Library's headings for the modes */
export const CHAIN_MODE_LABELS: Record<ChainMode, string> = { stereo: 'Stereo', pair: 'In line, as an L/R pair', wet: 'Wet, added to both sides' };

/** an effect the Library offers: a module type or a factory assembly (the plain card the canvas gets) */
export interface EffectEntry {
  name: string;
  mode: ChainMode;
  blurb: string;
  source: { type: string } | { def: AssemblyDef };
}
/** what insertEffect takes: a module or an assembly in the patch, a saved assembly, or a module type */
export type EffectSource = { module: number } | { assembly: number } | { def: AssemblyDef } | { type: string };

// ---- the effects there are ----

/** module types that are audio effects: their mode, the Library name when it is not the type's label, and a blurb */
const MODULE_EFFECTS: Record<string, { mode: ChainMode; name?: string; blurb: string }> = {
  shape: { mode: 'pair', name: 'Drive', blurb: 'Pushes the sound into distortion, from warm to harsh.' },
  filter: { mode: 'pair', blurb: 'Cuts lows or highs; sweep it for movement.' },
  ladder: { mode: 'pair', blurb: 'A warm low-pass filter with a singing peak.' },
  vowel: { mode: 'pair', blurb: 'Makes the sound speak vowels.' },
  phaser: { mode: 'pair', blurb: 'A sweeping, swirling notch.' },
  crush: { mode: 'pair', blurb: 'Lo-fi grit: fewer bits, a lower sample rate.' },
  dyn: { mode: 'pair', blurb: 'Evens out the loud and quiet parts.' },
  comb: { mode: 'pair', blurb: 'A tuned, metallic ring.' },
  modal: { mode: 'pair', blurb: 'Makes the sound ring like a struck object.' },
  shift: { mode: 'pair', blurb: 'Moves every frequency by the same amount, for clangy or drifting tones.' },
  limit: { mode: 'pair', blurb: 'Keeps the peaks under a ceiling.' },
  eq: { mode: 'pair', blurb: 'Boosts or cuts one band of frequencies.' },
  chorus: { mode: 'stereo', blurb: 'Thickens the sound with slightly detuned copies, spread left and right.' },
  delay: { mode: 'stereo', blurb: 'Repeats the sound as echoes.' },
  pan: { mode: 'stereo', blurb: 'Places the sound between left and right.' },
  reverb: { mode: 'wet', blurb: 'Adds the sound of a room or a hall.' },
  grain: { mode: 'wet', blurb: 'Breaks the sound into tiny grains and scatters them.' },
};
/** factory assemblies (src/assemblies/<file>.json, Effects and Textures shelves) that are audio effects */
const ASSEMBLY_EFFECTS: Record<string, { mode: ChainMode; name: string; blurb: string }> = {
  'auto-pan': { mode: 'stereo', name: 'Auto pan', blurb: 'Moves the sound from side to side.' },
  'overdrive': { mode: 'pair', name: 'Overdrive', blurb: 'Smooth drive with a tone filter.' },
  'octave-fuzz': { mode: 'pair', name: 'Octave fuzz', blurb: 'Fuzz with an octave above.' },
  'eq': { mode: 'pair', name: 'Three-band EQ', blurb: 'Shapes the lows, mids and highs.' },
  'envelope-filter': { mode: 'pair', name: 'Envelope filter', blurb: 'A filter that opens the louder you play.' },
  'talking-filter': { mode: 'pair', name: 'Talking filter', blurb: 'A vowel filter that follows how loud you play.' },
  'barber-pole': { mode: 'pair', name: 'Barber pole', blurb: 'A sweep that seems to rise forever.' },
  'resonator-bank': { mode: 'pair', name: 'Resonator bank', blurb: 'Tuned resonators that ring along with the sound.' },
  'sidechain-pump': { mode: 'pair', name: 'Sidechain pump', blurb: 'Ducks the sound in time, for a pumping feel.' },
  'slicer': { mode: 'pair', name: 'Slicer', blurb: 'Chops the sound into rhythmic slices.' },
  'stutter': { mode: 'pair', name: 'Stutter', blurb: 'Repeats short bits of the sound in time.' },
  'echo': { mode: 'wet', name: 'Echo', blurb: 'Echoes that fade into a soft room.' },
  'ducking-delay': { mode: 'wet', name: 'Ducking delay', blurb: 'Echoes that stay quiet while you play and swell in the gaps.' },
  'shimmer': { mode: 'wet', name: 'Shimmer', blurb: 'A reverb that rises an octave as it fades.' },
  'gated-reverb': { mode: 'wet', name: 'Gated reverb', blurb: 'A big reverb cut off short.' },
  'cloud': { mode: 'wet', name: 'Cloud', blurb: 'Turns the sound into a cloud of grains.' },
  'time-smear': { mode: 'wet', name: 'Time smear', blurb: 'Blurs the sound in time.' },
};
/** the D-1010 stage each legacy-form module type makes (its rows, its starting values) */
const LEGACY_KIND: Record<string, FxStageKind> = { shape: 'drive', chorus: 'chorus', delay: 'delay', reverb: 'reverb' };

const FACTORY_FILES = import.meta.glob('./assemblies/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

/** every audio effect the Library offers, module types first (each mode's entries in this order) */
export const EFFECT_CATALOG: EffectEntry[] = [
  ...Object.entries(MODULE_EFFECTS).filter(([type]) => DEFS[type]).map(([type, e]): EffectEntry =>
    ({ name: e.name ?? DEFS[type].label, mode: e.mode, blurb: e.blurb, source: { type } })),
  ...Object.entries(ASSEMBLY_EFFECTS).flatMap(([file, e]): EffectEntry[] => {
    const raw = FACTORY_FILES[`./assemblies/${file}.json`];
    if (!raw) return [];
    const def = validateAssemblyDef(structuredClone(raw), DEFS);
    return [{ name: e.name, mode: e.mode, blurb: def.blurb ?? e.blurb, source: { def } }];
  }),
];

/** how a module type or a factory assembly (by its Library name or its file's name) sits in the chain; null: not an effect */
export function effectKind(typeOrDefName: string): ChainMode | null {
  if (MODULE_EFFECTS[typeOrDefName]) return MODULE_EFFECTS[typeOrDefName].mode;
  const n = typeOrDefName.toLowerCase();
  return EFFECT_CATALOG.find((e) => e.name.toLowerCase() === n || ('def' in e.source && e.source.def.name.toLowerCase() === n))?.mode
    ?? ASSEMBLY_EFFECTS[typeOrDefName]?.mode ?? null;
}

const catalogDefs = new Map<EffectEntry, AssemblyDef>();
/** a catalog entry as the effect a drawer holds (its stereo wrapper), as a saved assembly; for Drive, Chorus, Delay and
 *  Reverb exactly the stage of the D-1010 bus, so presets of converted patches load onto a new one */
export function catalogEffectDef(entry: EffectEntry): AssemblyDef {
  let def = catalogDefs.get(entry);
  if (!def) {
    const p: Patch = { version: 2, name: 'scratch', modules: [], cables: [] };
    let e: AssemblyInst;
    if ('type' in entry.source) {
      const m = addModule(p, DEFS[entry.source.type], 0, 0);
      const kind = LEGACY_KIND[m.type];
      if (kind === 'drive') Object.assign(m.params, { drive: 1, level: 1 });
      if (kind === 'delay') Object.assign(m.params, { length: 500, rate: 0 });
      e = wrapEffect(p, { module: m.id }, entry.mode, entry.name);
    } else {
      const a = insertAssembly(p, DEFS, structuredClone(entry.source.def), 0, 0);
      e = wrapEffect(p, { assembly: a.id }, entry.mode, entry.name);
    }
    def = toDef(p, e);
    catalogDefs.set(entry, def);
  }
  return structuredClone(def);
}

/** what convertLegacyBus makes of a D-1010 stage of this kind, as a saved assembly (presets of converted patches key on it) */
export function legacyEffectDef(kind: FxStageKind): AssemblyDef {
  const type = kind === 'drive' ? 'shape' : kind;
  return catalogEffectDef(EFFECT_CATALOG.find((e) => 'type' in e.source && e.source.type === type)!);
}

/** the endpoints of an effect's chain input / output on a channel (a jack's `also` included) */
export const chainIns = (e: AssemblyInst, ch: Channel): Target[] => targetsOf(e.inputs[e.chain!.ins[ch]]);
export const chainOuts = (e: AssemblyInst, ch: Channel): Target[] => targetsOf(e.outputs[e.chain!.outs[ch]]);

/** the endpoints an instrument drawer's tap on a channel stands for: its instrument's jack, with that jack's `also` */
function tapEnds(p: Patch, d: AssemblyInst, ch: Channel): Target[] {
  const t = d.drawer!.taps![ch];
  const owner = parentOf(p, d.id);
  const ref = owner && findRef(owner, 'out', t.module, t.port);
  return ref ? targetsOf(ref) : [{ module: t.module, port: t.port }];
}

const outputModule = (p: Patch): ModuleInst | undefined => {
  const outs = p.modules.filter((m) => m.type === 'output');
  return outs.length === 1 ? outs[0] : undefined;
};

/**
 * Where an instrument's sound after its FX comes out on a channel: the last effect's chain output, or the tap while the
 * drawer is empty. Cables "from the instrument's out L / R" are made from these. None: the instrument has no drawer.
 */
export function drawerOutput(p: Patch, instrumentId: number, ch: Channel): Endpoint[] {
  const d = drawerOf(p, instrumentId);
  if (!d?.drawer?.taps) return [];
  const fx = effectsOf(p, d);
  return fx.length ? chainOuts(fx[fx.length - 1], ch) : tapEnds(p, d, ch);
}

const has = (list: readonly Endpoint[], e: Endpoint): boolean => list.some((x) => sameEnd(x, e));

/**
 * Why a new cable may not use this jack (`dir`: whether the endpoint is an input or an output), or null. The chain's
 * jacks belong to the editor: an effect's chain input while it is in a drawer, an effect's chain output except the last
 * one of an instrument's drawer (that is the drawer's output), and an instrument's tapped outputs while its drawer holds
 * effects. Modulation inputs of effects in a drawer stay ordinary; so do the Output's inputs (rewire takes a new source
 * there into the Output drawer).
 */
export function chainJackProblem(p: Patch, end: Endpoint, dir: 'in' | 'out'): string | null {
  for (const d of drawers(p)) {
    const owner = ownerOf(p, d);
    const whose = owner === 'output' ? 'the Output' : `${owner.label}'s`;
    const fx = effectsOf(p, d);
    const why = `This jack is part of ${whose} FX chain: drag the effect out of the drawer, or cable the drawer's output instead.`;
    for (const [k, e] of fx.entries()) {
      if (dir === 'in' && (has(chainIns(e, 0), end) || has(chainIns(e, 1), end))) return why;
      if (dir === 'out' && (has(chainOuts(e, 0), end) || has(chainOuts(e, 1), end)) && (owner === 'output' || k < fx.length - 1)) {
        return owner === 'output' ? `This jack is part of the Output FX chain: drag the effect out of the drawer to cable it.` : why;
      }
    }
    if (dir === 'out' && owner !== 'output' && fx.length && (has(tapEnds(p, d, 0), end) || has(tapEnds(p, d, 1), end)))
      return `This jack feeds ${owner.label}'s FX drawer: cable the drawer's output instead.`;
  }
  return null;
}

/** why a new cable from `from` to `to` would break an FX chain, or null: either jack is the chain's (chainJackProblem), or
 *  it would take a drawer's output back into its own instrument */
export function chainCableProblem(p: Patch, from: Endpoint, to: Endpoint): string | null {
  const why = chainJackProblem(p, from, 'out') ?? chainJackProblem(p, to, 'in');
  if (why) return why;
  for (const d of drawers(p)) {
    const owner = ownerOf(p, d);
    if (owner === 'output') continue;
    const outs = [...drawerOutput(p, owner.id, 0), ...drawerOutput(p, owner.id, 1)];
    if (has(outs, from) && allModules(p, owner).includes(to.module)) return `${owner.label}'s FX drawer output cannot go back into ${owner.label}.`;
  }
  return null;
}

// ---- the chain's cables ----

/** the chain's ends before an edit: what feeds it per channel, and where its output goes per channel */
interface Ends { sources: Endpoint[][]; dests: Endpoint[][] }

const key = (e: Endpoint): string => `${e.module}:${e.port}`;
const addOnce = (list: Endpoint[], e: Endpoint): void => { if (!has(list, e)) list.push({ module: e.module, port: e.port }); };

/** the cables of a drawer's chain (the editor's): into an effect's chain input from outside that effect; from a tap or an
 *  effect's chain output to outside the instrument (an instrument drawer); into the Output's l / r, and from an effect's
 *  chain output to outside that effect (the Output drawer) */
function chainCables(p: Patch, d: AssemblyInst): Cable[] {
  const fx = effectsOf(p, d);
  const members = new Map(fx.map((e) => [e, new Set(allModules(p, e))]));
  const ins = fx.map((e) => ({ e, ends: [...chainIns(e, 0), ...chainIns(e, 1)] }));
  const outs = fx.flatMap((e) => [...chainOuts(e, 0), ...chainOuts(e, 1)].map((x) => ({ e, x })));
  const intoChain = (c: Cable): boolean => ins.some(({ e, ends }) => has(ends, c.to) && !members.get(e)!.has(c.from.module));
  const owner = ownerOf(p, d);
  if (owner === 'output') {
    const out = outputModule(p);
    return p.cables.filter((c) => intoChain(c) || (out && c.to.module === out.id && (c.to.port === 'l' || c.to.port === 'r')) ||
      outs.some(({ e, x }) => sameEnd(x, c.from) && !members.get(e)!.has(c.to.module)));
  }
  const region = new Set(allModules(p, owner));
  const from = [...tapEnds(p, d, 0), ...tapEnds(p, d, 1), ...outs.map(({ x }) => x)];
  return p.cables.filter((c) => intoChain(c) || (has(from, c.from) && !region.has(c.to.module)));
}

/** a drawer's ends as its cables show them now (see the invariant in rewire) */
function endsOf(p: Patch, d: AssemblyInst): Ends {
  const fx = effectsOf(p, d);
  const cables = chainCables(p, d);
  const owner = ownerOf(p, d);
  if (owner === 'output') {
    const out = outputModule(p);
    if (!out) return { sources: [[], []], dests: [[], []] };
    const region = new Set(allModules(p, d));
    const sources: Endpoint[][] = [[], []];
    for (const c of cables) {
      if (region.has(c.from.module)) continue;
      if (c.to.module === out.id) addOnce(sources[c.to.port === 'r' ? 1 : 0], c.from);
      else for (const ch of [0, 1] as const) if (fx.some((e) => has(chainIns(e, ch), c.to))) addOnce(sources[ch], c.from);
    }
    if (!sources[1].length) sources[1] = [...sources[0]];
    return { sources, dests: [[{ module: out.id, port: 'l' }], [{ module: out.id, port: 'r' }]] };
  }
  const region = new Set(allModules(p, owner));
  const fromCh: Endpoint[][] = [0, 1].map((ch) => [...tapEnds(p, d, ch as Channel), ...fx.flatMap((e) => chainOuts(e, ch as Channel))]);
  const dests: Endpoint[][] = [[], []];
  for (const c of cables) {
    if (region.has(c.to.module)) continue;
    const l = has(fromCh[0], c.from), r = has(fromCh[1], c.from);
    if (!l && !r) continue;
    addOnce(dests[l && r ? (c.to.port === 'r' ? 1 : 0) : l ? 0 : 1], c.to);
  }
  // a mono instrument cabled only into the Output's l: its R side goes to the Output's r (which plays l while it is free)
  const out = outputModule(p);
  const taps = d.drawer!.taps!;
  if (out && !dests[1].length && sameEnd(taps[0], taps[1]) && has(dests[0], { module: out.id, port: 'l' }) &&
      !p.cables.some((c) => c.to.module === out.id && c.to.port === 'r'))
    dests[1].push({ module: out.id, port: 'r' });
  return { sources: [tapEnds(p, d, 0), tapEnds(p, d, 1)], dests };
}

/** make a drawer's chain cables what the invariant wants from `ends`, touching no cable that already is right */
function applyChain(p: Patch, d: AssemblyInst, ends: Ends): void {
  const want: Cable[] = [];
  const link = (from: Endpoint[], to: Endpoint[]): void => {
    for (const f of from) for (const t of to) if (!want.some((c) => sameEnd(c.from, f) && sameEnd(c.to, t))) want.push({ from: { ...f }, to: { ...t } });
  };
  let prev = ends.sources;
  for (const e of effectsOf(p, d)) {
    for (const ch of [0, 1] as const) link(prev[ch], chainIns(e, ch));
    prev = [chainOuts(e, 0), chainOuts(e, 1)];
  }
  for (const ch of [0, 1] as const) link(prev[ch], ends.dests[ch]);
  const wanted = new Set(want.map((c) => `${key(c.from)}>${key(c.to)}`));
  for (const c of chainCables(p, d)) if (!wanted.has(`${key(c.from)}>${key(c.to)}`)) disconnect(p, c);
  for (const c of want) connect(p, DEFS, c.from, c.to);
}

/**
 * Make a drawer's cables follow its chain, for each channel: an instrument's drawer: tap → E1 in, Ek out → Ek+1 in, En out
 * → the drawer's destinations (where the chain's end went, outside the instrument); empty: tap → destinations. The Output
 * drawer: its sources (what fed the Output's l / r from outside the drawer; the right side takes the left's when it had
 * none) → E1 in, ..., En out → the Output's l / r; empty: sources → l / r. A jack's `also` endpoints all connect.
 */
export function rewire(p: Patch, drawer: AssemblyInst): void {
  applyChain(p, drawer, endsOf(p, drawer));
}

// ---- editing drawers ----

const nextId = (p: Patch): number => assembliesOf(p).reduce((m, a) => Math.max(m, a.id), 0) + 1;
const kindOf = (m: ModuleInst | undefined, dir: 'in' | 'out', port: string): string | undefined =>
  m && (dir === 'in' ? DEFS[m.type]?.inputs : DEFS[m.type]?.outputs)?.find((q) => q.name === port)?.kind;
const moduleById = (p: Patch, id: number): ModuleInst | undefined => p.modules.find((m) => m.id === id);

/**
 * Give an instrument (a top-level assembly) its FX drawer, or the patch its Output drawer; an existing one is returned.
 * An instrument's drawer taps the outputs it has cabled to the Output (l, r), else its first two audio outputs, else its
 * one (both sides). Throws when there is nothing to tap.
 */
export function addDrawer(p: Patch, owner: number | 'output'): AssemblyInst {
  if (owner === 'output') {
    const had = outputDrawer(p);
    if (had) return had;
    const out = outputModule(p);
    if (!out) throw new Error('The Output drawer needs the patch\'s Output.');
    const d: AssemblyInst = { v: 1, id: nextId(p), name: 'Output FX', label: 'Output FX', x: out.x, y: out.y, open: false, modules: [], inputs: [], outputs: [], params: [], drawer: {} };
    p.assemblies = [...assembliesOf(p), d];
    rewire(p, d);
    return d;
  }
  const inst = assemblyById(p, owner);
  if (!inst || parentOf(p, inst.id) || inst.drawer || inst.chain) throw new Error('Only an instrument on the canvas has an FX drawer.');
  const had = drawerOf(p, owner);
  if (had) return had;
  const audio = inst.outputs.filter((r) => kindOf(moduleById(p, r.module), 'out', r.port) === 'audio');
  const out = outputModule(p);
  const cabled = (port: 'l' | 'r'): PortRef | undefined => inst.outputs.find((r) => p.cables.some((c) => has(targetsOf(r), c.from) && c.to.module === out?.id && c.to.port === port));
  const l = cabled('l') ?? audio[0];
  const r = (cabled('l') ? cabled('r') ?? cabled('l') : audio[1] ?? audio[0])!;
  if (!l) throw new Error(`${inst.label} has no audio output for an FX drawer.`);
  const d: AssemblyInst = {
    v: 1, id: nextId(p), name: 'FX', label: `${inst.label} FX`, x: inst.x, y: inst.y, open: false, modules: [], inputs: [], outputs: [], params: [],
    drawer: { taps: [{ module: l.module, port: l.port }, { module: r.module, port: r.port }] },
  };
  p.assemblies = [...assembliesOf(p), d];
  inst.children = [...(inst.children ?? []), d.id];
  rewire(p, d);
  return d;
}

/** take every cable off an effect's chain jacks that runs to or from outside it (its modulation cables stay) */
function unplug(p: Patch, e: AssemblyInst): void {
  const members = new Set(allModules(p, e));
  const ins = [...chainIns(e, 0), ...chainIns(e, 1)];
  const outs = [...chainOuts(e, 0), ...chainOuts(e, 1)];
  p.cables = p.cables.filter((c) => !(has(ins, c.to) && !members.has(c.from.module)) && !(has(outs, c.from) && !members.has(c.to.module)));
}

/** put an effect at `at` in a drawer's children (the end when out of range) */
function place(d: AssemblyInst, id: number, at?: number): void {
  const rest = (d.children ?? []).filter((x) => x !== id);
  rest.splice(at === undefined || at < 0 || at > rest.length ? rest.length : at, 0, id);
  d.children = rest;
}

/**
 * Put an effect into a drawer at `at` (default: the end) and rewire. The effect is a module or an assembly of the patch
 * (it leaves where it was: its former audio cables go, its modulation cables stay; a drawer it was in closes the gap),
 * a saved assembly or a catalog module type (made new). Plain modules and assemblies without `chain` are wrapped first
 * (wrapEffect). Returns the effect.
 */
export function insertEffect(p: Patch, drawer: AssemblyInst, effect: EffectSource, at?: number): AssemblyInst {
  if (!drawer.drawer) throw new Error(`"${drawer.label}" is no FX drawer.`);
  const owner = ownerOf(p, drawer);
  const where = owner === 'output' ? drawer : owner;
  let e: AssemblyInst;
  let extra: Ends = { sources: [[], []], dests: [[], []] };
  if ('def' in effect) {
    const made = insertAssembly(p, DEFS, structuredClone(effect.def), where.x, where.y);
    e = made.chain ? made : wrapEffect(p, { assembly: made.id });
  } else if ('type' in effect) {
    const entry = EFFECT_CATALOG.find((x) => 'type' in x.source && x.source.type === effect.type);
    if (!entry) throw new Error(`A ${DEFS[effect.type]?.label ?? effect.type} is no audio effect: it cannot go in an FX drawer.`);
    e = insertAssembly(p, DEFS, catalogEffectDef(entry), where.x, where.y);
  } else if ('module' in effect) {
    const host = assemblyOf(p, effect.module);
    if (host) removeMember(p, host, effect.module);
    const m = moduleById(p, effect.module);
    const ports = m && audioPorts(p, { module: m });
    if (ports) extra = inLine(p, drawer, ports, new Set([effect.module]));
    e = wrapEffect(p, { module: effect.module });
  } else {
    const a = assemblyById(p, effect.assembly);
    if (!a || a.drawer) throw new Error('That is no effect.');
    const from = drawerOfEffect(p, a.id);
    if (from === drawer) {
      moveEffect(p, drawer, a.id, at ?? effectsOf(p, drawer).length - 1);
      return a;
    }
    if (from) leave(p, from, a);
    else if (parentOf(p, a.id)) removeChild(p, parentOf(p, a.id)!, a.id);
    const ports = a.chain ? { input: [...chainIns(a, 0), ...chainIns(a, 1)], outputs: [chainOuts(a, 0), chainOuts(a, 1)] } : audioPorts(p, { assembly: a });
    if (ports && !from) extra = inLine(p, drawer, ports, new Set(allModules(p, a)));
    if (a.chain) {
      unplug(p, a);
      e = a;
    } else e = wrapEffect(p, { assembly: a.id });
  }
  const ends = endsOf(p, drawer);
  for (const ch of [0, 1] as const) {
    for (const s of extra.sources[ch]) addOnce(ends.sources[ch], s);
    for (const t of extra.dests[ch]) addOnce(ends.dests[ch], t);
  }
  addChild(p, drawer, e.id);
  place(drawer, e.id, at);
  applyChain(p, drawer, ends);
  return e;
}

/**
 * What a canvas effect did in line with a drawer's sound, kept when it moves into that drawer (so the sound never stops):
 * one fed by an instrument drawer's output hands its destinations to the drawer; one feeding the Output hands what fed it
 * to the Output drawer.
 */
function inLine(p: Patch, d: AssemblyInst, ports: { input: Endpoint[]; outputs: Endpoint[][] }, inside: Set<number>): Ends {
  const extra: Ends = { sources: [[], []], dests: [[], []] };
  const owner = ownerOf(p, d);
  if (owner !== 'output') {
    const end = [...drawerOutput(p, owner.id, 0), ...drawerOutput(p, owner.id, 1)];
    if (!p.cables.some((c) => has(ports.input, c.to) && has(end, c.from))) return extra;
    ports.outputs.forEach((list, k) => {
      for (const c of p.cables) if (has(list, c.from) && !inside.has(c.to.module))
        addOnce(extra.dests[ports.outputs.length > 1 ? Math.min(k, 1) : c.to.port === 'r' ? 1 : 0], c.to);
    });
    return extra;
  }
  const out = outputModule(p);
  if (!out || !p.cables.some((c) => has(ports.outputs.flat(), c.from) && c.to.module === out.id)) return extra;
  for (const c of p.cables) if (has(ports.input, c.to) && !inside.has(c.from.module)) for (const ch of [0, 1] as const) addOnce(extra.sources[ch], c.from);
  return extra;
}

/** an effect leaves its drawer: it becomes top level with nothing on its chain jacks, and the chain closes the gap */
function leave(p: Patch, d: AssemblyInst, e: AssemblyInst): void {
  const ends = endsOf(p, d);
  unplug(p, e);
  removeChild(p, d, e.id);
  applyChain(p, d, ends);
}

/** move an effect to position `to` in its drawer's chain and rewire */
export function moveEffect(p: Patch, drawer: AssemblyInst, effectId: number, to: number): void {
  if (!drawer.children?.includes(effectId)) return;
  const ends = endsOf(p, drawer);
  place(drawer, effectId, Math.max(0, to));
  applyChain(p, drawer, ends);
}

/** drag an effect out of its drawer onto the canvas at (x, y): an ordinary top-level effect, nothing on its chain jacks;
 *  the chain closes the gap */
export function takeOut(p: Patch, effectId: number, x: number, y: number): void {
  const e = assemblyById(p, effectId);
  const d = e && drawerOfEffect(p, effectId);
  if (!e || !d) return;
  leave(p, d, e);
  moveAssembly(p, e, x - e.x, y - e.y);
}

/** delete an effect with its modules; the chain (if it was in a drawer) closes the gap */
export function removeEffect(p: Patch, effectId: number): void {
  const d = drawerOfEffect(p, effectId);
  const ends = d && endsOf(p, d);
  deleteAssembly(p, effectId);
  if (d && ends) applyChain(p, d, ends);
}

/** the D-1010 bus of an old patch as an FX drawer (fx-legacy.ts; validatePatch does it on open) */
export const convertLegacyBus = (p: Patch): Patch => convertBus(p, DEFS);

// ---- wrapping: a plain module or a mono assembly as a stereo effect ----

/** the parameters a wrapped module's card shows: the D-1010 stage's for its legacy types, else every one its card has */
const moduleRowNames = (type: string): string[] =>
  LEGACY_KIND[type] ? [...LEGACY_STAGE_ROWS[LEGACY_KIND[type]]] : DEFS[type].params.filter((pd) => !pd.onScreen && !pd.screen).map((pd) => pd.name);

/** a copy of a module beside it: the same values, matrix and switch */
function twinModule(p: Patch, m: ModuleInst): ModuleInst {
  const b = addModule(p, DEFS[m.type], m.x, m.y + 280);
  b.params = structuredClone(m.params);
  for (const k of ['att', 'map', 'range', 'inputMap', 'paramsB', 'mutateLock'] as const) if (m[k]) (b as unknown as Record<string, unknown>)[k] = structuredClone(m[k]);
  if (m.bypass) b.bypass = true;
  return b;
}

const math = (p: Patch, x: number, y: number, ka: number, kb: number): ModuleInst => {
  const m = addModule(p, DEFS.math, x, y);
  Object.assign(m.params, { ka, kb, off: 0 });
  return m;
};
const wire = (p: Patch, from: Endpoint, to: Endpoint): void => { connect(p, DEFS, from, to); };
const ref = (ends: Endpoint[], label: string): PortRef =>
  ({ module: ends[0].module, port: ends[0].port, label, ...(ends.length > 1 ? { also: ends.slice(1).map((e) => ({ module: e.module, port: e.port })) } : {}) });

/** the correction of a stereo pair (C = .25 (Ar + Bl - Al - Br); out L = Al + C, out R = Br + C): a Math cabled from the
 *  pair's outputs [A first, A second] and [B first, B second]; returns it and the outputs [L, R] */
function correction(p: Patch, a: Endpoint[][], b: Endpoint[][], x: number, y: number): { helper: ModuleInst; outs: Endpoint[][] } {
  const helper = math(p, x, y, 0.25, 0.25);
  for (const e of [...a[1], ...b[0]]) wire(p, e, { module: helper.id, port: 'a' });
  for (const e of [...a[0], ...b[1]]) wire(p, e, { module: helper.id, port: 'b' });
  const sub = { module: helper.id, port: 'sub' };
  return { helper, outs: [[...a[0], sub], [...b[1], sub]] };
}

/** a wet effect's mix around a mono kernel fed `into`: the dry scales (L, R), the send (their mean) and what `wet` adds
 *  (the return); returns the new modules and the outputs [L, R] */
function wetMix(p: Patch, into: Endpoint[], x: number, y: number, wet: (send: ModuleInst) => { ret: ModuleInst[]; out: Endpoint }) {
  const dry = [0, 1].map((ch) => addModule(p, DEFS.scale, x, y + (ch + 1) * 280));
  const send = math(p, x, y + 840, 0.5, 0.5);
  dry.forEach((m, ch) => wire(p, { module: m.id, port: 'out' }, { module: send.id, port: ch ? 'b' : 'a' }));
  for (const t of into) wire(p, { module: send.id, port: 'add' }, t);
  const { ret, out } = wet(send);
  return { dry, send, ret, outs: dry.map((m) => [{ module: m.id, port: 'out' }, out]) };
}

/** inputs a wrapper shows that feed the same jack on both copies of a pair become one jack feeding both */
function tieTwins(a: AssemblyInst, twin: Map<number, number>): void {
  if (!twin.size || !a.chain) return;
  const chainRefs = a.chain.ins.map((i) => a.inputs[i]);
  const gone = new Set<PortRef>();
  for (const r of a.inputs) {
    const t = twin.get(r.module);
    if (t === undefined || chainRefs.includes(r) || gone.has(r)) continue;
    const other = a.inputs.find((x) => x !== r && !chainRefs.includes(x) && !gone.has(x) && x.module === t && x.port === r.port);
    if (!other) continue;
    r.also = [...(r.also ?? []), ...targetsOf(other)];
    gone.add(other);
  }
  a.inputs = a.inputs.filter((x) => !gone.has(x));
  a.chain.ins = [a.inputs.indexOf(chainRefs[0]), a.inputs.indexOf(chainRefs[1])];
}

/** a module's or an assembly's audio input and outputs (their first audio ones; an assembly without an audio output kind
 *  offers its first output) */
function audioPorts(p: Patch, src: { module: ModuleInst } | { assembly: AssemblyInst }): { input: Endpoint[]; outputs: Endpoint[][] } | null {
  if ('module' in src) {
    const d = DEFS[src.module.type];
    const input = d.inputs.find((q) => q.kind === 'audio')?.name;
    const outs = d.outputs.filter((q) => q.kind === 'audio').map((q) => q.name);
    if (!input || !outs.length) return null;
    return { input: [{ module: src.module.id, port: input }], outputs: outs.map((port) => [{ module: src.module.id, port }]) };
  }
  const a = src.assembly;
  const audio = (dir: 'in' | 'out') => (r: PortRef): boolean => kindOf(moduleById(p, r.module), dir, r.port) === 'audio';
  const input = a.inputs.find(audio('in'));
  const outs = a.outputs.filter(audio('out'));
  const outputs = outs.length ? outs : a.outputs.slice(0, 1);
  if (!input || !outputs.length) return null;
  return { input: targetsOf(input), outputs: outputs.map(targetsOf) };
}

/**
 * Make a top-level module or assembly a stereo effect (an assembly with `chain`) in `mode` (default: its catalog mode;
 * an unknown assembly with two audio outputs is stereo, else a pair). A pair: a copy beside it (an assembly's copy made
 * with toDef / insertAssembly), every row of the card tied to the copy's, modulation cables into the original copied onto
 * the copy; stereo: a pair with the correction Math; wet: the mix around it (a module's own mix moves to a Mix row). Its
 * former audio cables go. Returns the wrapper (named `name`, else the catalog name).
 */
export function wrapEffect(p: Patch, target: { module: number } | { assembly: number }, mode?: ChainMode, name?: string): AssemblyInst {
  if ('module' in target) {
    const m = moduleById(p, target.module);
    if (!m) throw new Error(`No module ${target.module}.`);
    const info = MODULE_EFFECTS[m.type];
    const ports = audioPorts(p, { module: m });
    if (!info || !ports) throw new Error(`A ${DEFS[m.type]?.label ?? m.type} is no audio effect: it cannot go in an FX drawer.`);
    return wrapModule(p, m, mode ?? info.mode, name ?? info.name ?? DEFS[m.type].label, ports);
  }
  const a = assemblyById(p, target.assembly);
  if (!a) throw new Error(`No assembly ${target.assembly}.`);
  if (a.chain) return a;
  const ports = audioPorts(p, { assembly: a });
  if (!ports) throw new Error(`"${a.label}" has no audio input and output: it cannot go in an FX drawer.`);
  const known = EFFECT_CATALOG.find((e) => 'def' in e.source && e.source.def.name === a.name);
  return wrapAssembly(p, a, mode ?? known?.mode ?? (ports.outputs.length > 1 ? 'stereo' : 'pair'), name ?? known?.name ?? a.label, ports);
}

/** cut every cable into `input` and out of `outputs` from or to modules outside `inside` */
function cutAudio(p: Patch, inside: Set<number>, input: Endpoint[], outputs: Endpoint[]): void {
  p.cables = p.cables.filter((c) => !(has(input, c.to) && !inside.has(c.from.module)) && !(has(outputs, c.from) && !inside.has(c.to.module)));
}

function wrapModule(p: Patch, m: ModuleInst, mode: ChainMode, name: string, ports: { input: Endpoint[]; outputs: Endpoint[][] }): AssemblyInst {
  cutAudio(p, new Set([m.id]), ports.input, ports.outputs.flat());
  const rows = moduleRowNames(m.type);
  if (mode === 'wet') {
    const oldMix = m.params.mix;
    if (oldMix !== undefined) m.params.mix = 1;
    let mixMod: ModuleInst | undefined;
    const w = wetMix(p, ports.input, m.x, m.y, () => {
      mixMod = addModule(p, DEFS.macro, m.x, m.y + 1120);
      mixMod.params.value = oldMix ?? 1;
      const ret = math(p, m.x, m.y + 1400, 1, 1);
      for (const e of ports.outputs[0]) wire(p, e, { module: ret.id, port: 'a' });
      wire(p, { module: mixMod.id, port: 'out' }, { module: ret.id, port: 'b' });
      return { ret: [mixMod, ret], out: { module: ret.id, port: 'mul' } };
    });
    const helpers = [...w.dry, w.send, ...w.ret].map((x) => x.id);
    const a = makeAssembly(p, [m.id, ...helpers], name);
    a.params = rows.map((param) => (param === 'mix' && oldMix !== undefined ? { module: mixMod!.id, param: 'value', label: 'mix' } : { module: m.id, param, label: param }));
    return finish(p, a, w.dry.map((d) => [{ module: d.id, port: 'in' }]), w.outs, helpers, !!m.bypass, new Map());
  }
  const b = twinModule(p, m);
  for (const c of p.cables.filter((c) => c.to.module === m.id && !has(ports.input, c.to))) wire(p, c.from, { module: b.id, port: c.to.port });
  const bEnds = (list: Endpoint[]): Endpoint[] => list.map((e) => ({ module: b.id, port: e.port }));
  let outs: Endpoint[][];
  const helpers: number[] = [];
  if (mode === 'stereo' && ports.outputs.length > 1) {
    const c = correction(p, ports.outputs.slice(0, 2), ports.outputs.slice(0, 2).map(bEnds), m.x, m.y + 560);
    helpers.push(c.helper.id);
    outs = c.outs;
  } else outs = [ports.outputs[0], bEnds(ports.outputs[0])];
  const a = makeAssembly(p, [m.id, b.id, ...helpers], name);
  a.params = rows.map((param) => ({ module: m.id, param, label: param, also: [{ module: b.id, param }] }));
  return finish(p, a, [ports.input, bEnds(ports.input)], outs, helpers, !!m.bypass, new Map([[m.id, b.id]]));
}

function wrapAssembly(p: Patch, src: AssemblyInst, mode: ChainMode, name: string, ports: { input: Endpoint[]; outputs: Endpoint[][] }): AssemblyInst {
  const inside = new Set(allModules(p, src));
  cutAudio(p, inside, ports.input, ports.outputs.flat());
  const x = src.x, y = src.y;
  const layout = (r: ParamRef): Partial<ParamRef> => {
    const { module: _m, param: _p, label: _l, also: _a, ...rest } = r;
    return rest;
  };
  if (mode === 'wet') {
    const w = wetMix(p, ports.input, x, y + 300, (send) => {
      const ret = math(p, x, y + 1400, 1, 1);
      for (const e of ports.outputs[0]) wire(p, e, { module: ret.id, port: 'a' });
      wire(p, { module: send.id, port: 'add' }, { module: ret.id, port: 'b' });
      return { ret: [ret], out: { module: ret.id, port: 'sub' } };
    });
    const helpers = [...w.dry, w.send, ...w.ret].map((m) => m.id);
    const a = makeAssembly(p, helpers, name, [src.id]);
    a.params = src.params.map((r) => ({ ...layout(r), module: r.module, param: r.param, label: r.label, ...(r.also ? { also: r.also.map((t) => ({ ...t })) } : {}) }));
    return finish(p, a, w.dry.map((d) => [{ module: d.id, port: 'in' }]), w.outs, helpers, false, new Map());
  }
  const order = [...src.modules, ...descendants(p, src).flatMap((d) => d.modules)];
  const before = p.modules.length;
  const copy = insertAssembly(p, DEFS, toDef(p, src), x, y + 300);
  const twin = new Map(order.map((id, i) => [id, p.modules[before + i].id]));
  const tw = (list: Endpoint[]): Endpoint[] => list.map((e) => ({ module: twin.get(e.module)!, port: e.port }));
  for (const c of p.cables.filter((c) => inside.has(c.to.module) && !inside.has(c.from.module) && !has(ports.input, c.to)))
    wire(p, c.from, { module: twin.get(c.to.module)!, port: c.to.port });
  let outs: Endpoint[][];
  const helpers: number[] = [];
  if (mode === 'stereo' && ports.outputs.length > 1) {
    const c = correction(p, ports.outputs.slice(0, 2), ports.outputs.slice(0, 2).map(tw), x, y + 600);
    helpers.push(c.helper.id);
    outs = c.outs;
  } else outs = [ports.outputs[0], tw(ports.outputs[0])];
  const a = makeAssembly(p, helpers, name, [src.id, copy.id]);
  a.params = src.params.map((r) => ({
    ...layout(r), module: r.module, param: r.param, label: r.label,
    also: [...(r.also ?? []).map((t) => ({ ...t })), ...rowTargets(r).map((t) => ({ module: twin.get(t.module)!, param: t.param }))],
  }));
  return finish(p, a, [ports.input, tw(ports.input)], outs, helpers, false, twin);
}

/** a wrapper's chain jacks, helpers and switch set, the overlay reconciled */
function finish(p: Patch, a: AssemblyInst, ins: Endpoint[][], outs: Endpoint[][], helpers: number[], off: boolean, twin: Map<number, number>): AssemblyInst {
  a.inputs = [ref(ins[0], 'in L'), ref(ins[1], 'in R')];
  a.outputs = [ref(outs[0], 'out L'), ref(outs[1], 'out R')];
  a.chain = { ins: [0, 1], outs: [0, 1], ...(helpers.length ? { helpers } : {}) };
  if (off) {
    a.bypass = true;
    a.kept = [];
  }
  reconcile(p, a, DEFS);
  tieTwins(a, twin);
  return a;
}
