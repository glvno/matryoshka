// SPDX-License-Identifier: GPL-3.0-only
// The master FX bus of patches from before the FX drawer (D-1010), kept only to convert them: `fxBusOf` recognizes the
// bus by its exact graph (one to four stages, Drive, Chorus, Delay, Reverb, in a root "FX" assembly feeding the Output),
// and `convertLegacyBus` turns it into an FX drawer (fx-drawer.ts) when the editor opens the patch. Cables, modules and
// their order stay exactly as they were, so the patch plays the same; only the assembly overlay changes.
// (No import of modules.ts here: validatePatch in patch.ts calls this, and modules.ts imports patch.ts.)
import { assemblyById, assembliesOf, findRef, parentOf, rowTargets, targetsOf, type AssemblyInst, type ParamRef, type PortRef, type RowTarget, type Target } from './assembly';
import { sameEnd, type Cable, type Endpoint, type ModuleDef, type ModuleInst, type Patch } from './patch';

export type FxStageKind = 'drive' | 'chorus' | 'delay' | 'reverb';
export interface FxStage {
  kind: FxStageKind;
  assembly: number;
  targets: number[];
  helpers: number[];
  /** the stage's input endpoints [L, R] and the endpoints that carry its output, per channel */
  inputs: Endpoint[];
  outputs: Endpoint[][];
}
export interface FxBus { assembly: number; stages: FxStage[] }

const KINDS: readonly FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];
/** the rows each stage's card had (the D-1010 interface promised these controls, not every quality mode) */
export const LEGACY_STAGE_ROWS: Record<FxStageKind, readonly string[]> = {
  drive: ['drive', 'mode', 'level', 'sym'],
  chorus: ['rate', 'depth', 'mix'],
  delay: ['time', 'fb', 'mix', 'sync', 'pingpong', 'note'],
  reverb: ['size', 'damp', 'mix', 'pre', 'mod', 'freeze'],
};
const typeOf = (kind: FxStageKind): string => (kind === 'drive' ? 'shape' : kind);
const outsOf = (kind: FxStageKind): string[] => (kind === 'chorus' ? ['l', 'r'] : kind === 'delay' ? ['out', 'r'] : ['out']);
const end = (module: number, port: string): Endpoint => ({ module, port });
const cableKey = (c: Cable): string => `${c.from.module}:${c.from.port}>${c.to.module}:${c.to.port}`;
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

function tiedRows(a: AssemblyInst, expected: RowTarget[][]): boolean {
  const actual = a.params.map((r) => rowTargets(r).map((t) => `${t.module}:${t.param}`));
  return actual.length === expected.length && expected.every((want) => actual.filter((got) => sameSet(got, want.map((t) => `${t.module}:${t.param}`))).length === 1);
}

function portsAre(a: AssemblyInst, side: 'inputs' | 'outputs', want: Endpoint[]): boolean {
  const got = a[side].flatMap((r) => [end(r.module, r.port), ...(r.also ?? [])]);
  return sameSet([...new Set(got.map((e) => `${e.module}:${e.port}`))], [...new Set(want.map((e) => `${e.module}:${e.port}`))]);
}

const ordinaryHelper = (m: ModuleInst): boolean => !m.paramsB && !m.range && !m.inputMap;
const mathIs = (m: ModuleInst, ka: number, kb: number): boolean => m.type === 'math' && ordinaryHelper(m) && m.params.ka === ka && m.params.kb === kb && m.params.off === 0;
interface StageGraph extends FxStage {
  rows: RowTarget[][];
  internal: Cable[];
}

/** Derive a stage (a Drive / Chorus / Delay pair, or the wet-only Reverb) and its controls from its graph, not its labels. */
function stageGraph(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>): StageGraph | null {
  if (a.poly || a.children?.length || new Set(a.modules).size !== a.modules.length) return null;
  const modules = a.modules.map((id) => p.modules.find((m) => m.id === id));
  if (modules.some((m) => !m)) return null;
  for (const kind of KINDS.filter((k) => k !== 'reverb')) {
    if (modules.length !== 2 || !modules.every((m) => m!.type === typeOf(kind))) continue;
    const targets = [...a.modules];
    const [x, y] = [modules[0]!, modules[1]!];
    if (!!x.bypass !== !!y.bypass || !defs[x.type].params.every((pd) => x.params[pd.name] === y.params[pd.name] && x.paramsB?.[pd.name] === y.paramsB?.[pd.name])) return null;
    return { kind, assembly: a.id, targets, helpers: [], inputs: targets.map((id) => end(id, 'in')),
      outputs: targets.map((id) => [end(id, 'out')]),
      rows: LEGACY_STAGE_ROWS[kind].map((param) => targets.map((module) => ({ module, param }))), internal: [] };
  }
  if (modules.length !== 6) return null;
  const kernels = modules.filter((m) => m!.type === 'reverb');
  const scales = modules.filter((m) => m!.type === 'scale');
  const sends = modules.filter((m) => mathIs(m!, 0.5, 0.5));
  const returns = modules.filter((m) => mathIs(m!, 1, 1));
  const mixes = modules.filter((m) => m!.type === 'macro' && ordinaryHelper(m!));
  if (kernels.length !== 1 || scales.length !== 2 || sends.length !== 1 || returns.length !== 1 || mixes.length !== 1 ||
      kernels[0]!.params.mix !== 1 || kernels[0]!.paramsB ||
      scales.some((m) => !ordinaryHelper(m!) || m!.params.gain !== 1 || m!.params.offset !== 0) ||
      !Number.isFinite(mixes[0]!.params.value) || mixes[0]!.params.value < 0 || mixes[0]!.params.value > 1) return null;
  const [kernel, send, wet, mix] = [kernels[0]!, sends[0]!, returns[0]!, mixes[0]!];
  // canonical OFF only: all members bypassed, or the helpers already active
  const helpersOn = modules.every((m) => m === kernel || !m!.bypass);
  const helpersOff = modules.every((m) => m === kernel || !!m!.bypass);
  if (a.kept?.length || (!helpersOn && !(kernel.bypass && helpersOff))) return null;
  const has = (from: Endpoint, to: Endpoint): boolean => p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to));
  const dry = ['a', 'b'].map((port) => scales.find((m) => has(end(m!.id, 'out'), end(send.id, port))));
  if (!dry[0] || !dry[1] || dry[0] === dry[1]) return null;
  const internal: Cable[] = [
    { from: end(dry[0].id, 'out'), to: end(send.id, 'a') },
    { from: end(dry[1].id, 'out'), to: end(send.id, 'b') },
    { from: end(send.id, 'add'), to: end(kernel.id, 'in') },
    { from: end(kernel.id, 'out'), to: end(wet.id, 'a') },
    { from: end(mix.id, 'out'), to: end(wet.id, 'b') },
  ];
  return { kind: 'reverb', assembly: a.id, targets: [kernel.id], helpers: a.modules.filter((id) => id !== kernel.id),
    inputs: dry.map((m) => end(m!.id, 'in')), outputs: dry.map((m) => [end(m!.id, 'out'), end(wet.id, 'mul')]),
    rows: LEGACY_STAGE_ROWS.reverb.map((param) => [{ module: param === 'mix' ? mix.id : kernel.id, param: param === 'mix' ? 'value' : param }]), internal };
}

/** Recognize an exact terminal stereo master insert with one to four ordered, present stages (D-1010). */
export function fxBusOf(p: Patch, defs: Record<string, ModuleDef>): FxBus | null {
  const assemblies = p.assemblies ?? [];
  if (new Set(p.modules.map((m) => m.id)).size !== p.modules.length || new Set(assemblies.map((a) => a.id)).size !== assemblies.length ||
      p.modules.some((m) => !Number.isSafeInteger(m.id) || m.id <= 0) || assemblies.some((a) => !Number.isSafeInteger(a.id) || a.id <= 0)) return null;
  const outputs = p.modules.filter((m) => m.type === 'output');
  if (outputs.length !== 1) return null;
  const output = outputs[0];
  const found: FxBus[] = [];
  for (const root of assemblies) {
    if (root.poly || root.bypass || root.drawer || !root.children?.length || root.children.length > 4 || new Set(root.children).size !== root.children.length ||
        assemblies.some((a) => a.children?.includes(root.id))) continue;
    const children = root.children.map((id) => assemblies.find((a) => a.id === id));
    if (children.some((a) => !a || a.chain)) continue;
    const graphs = children.map((a) => stageGraph(p, a!, defs));
    if (graphs.some((s) => !s)) continue;
    const stages = (graphs as StageGraph[]).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    if (new Set(stages.map((s) => s.kind)).size !== stages.length ||
        stages.some((s) => !tiedRows(assemblies.find((a) => a.id === s.assembly)!, s.rows)) ||
        !tiedRows(root, stages.flatMap((s) => s.rows))) continue;
    const members = [...root.modules, ...children.flatMap((a) => a!.modules)];
    if (new Set(members).size !== members.length || members.some((id) => assemblies.filter((a) => a.modules.includes(id)).length !== 1) ||
        children.some((child) => assemblies.filter((a) => a.children?.includes(child!.id)).length !== 1)) continue;
    const ownAssemblies = new Set([root.id, ...stages.map((s) => s.assembly)]);
    if (assemblies.some((a) => !ownAssemblies.has(a.id) && a.params.some((r) => rowTargets(r).some((t) => members.includes(t.module))))) continue;
    const helpers = root.modules.map((id) => p.modules.find((m) => m.id === id));
    if (helpers.length !== stages.filter((s) => s.kind === 'chorus' || s.kind === 'delay').length ||
        helpers.some((m) => !m || !mathIs(m, 0.25, 0.25) || m.bypass)) continue;
    const expected: Cable[] = [];
    const link = (from: Endpoint, to: Endpoint): void => { expected.push({ from, to }); };
    const has = (from: Endpoint, to: Endpoint): boolean => p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to));
    let previous: Endpoint[][] = [];
    let valid = true;
    for (const stage of stages) {
      if (previous.length) stage.inputs.forEach((to, ch) => previous[ch].forEach((from) => link(from, to)));
      expected.push(...stage.internal);
      if (stage.kind === 'chorus' || stage.kind === 'delay') {
        const [first, second] = outsOf(stage.kind);
        const [a, b] = stage.targets;
        const taps = [end(a, first), end(a, second), end(b, first), end(b, second)];
        const matches = helpers.filter((m) => has(taps[1], end(m!.id, 'a')));
        if (matches.length !== 1) { valid = false; break; }
        const helper = matches[0]!;
        stage.helpers = [helper.id];
        for (const tap of [taps[1], taps[2]]) link(tap, end(helper.id, 'a'));
        for (const tap of [taps[0], taps[3]]) link(tap, end(helper.id, 'b'));
        stage.outputs = [[taps[0], end(helper.id, 'sub')], [taps[3], end(helper.id, 'sub')]];
      }
      const a = assemblies.find((a) => a.id === stage.assembly)!;
      const exposed = stage.kind === 'chorus' || stage.kind === 'delay'
        ? stage.targets.flatMap((id) => outsOf(stage.kind).map((port) => end(id, port))) : stage.outputs.flat();
      if (!portsAre(a, 'inputs', stage.inputs) || !portsAre(a, 'outputs', exposed)) { valid = false; break; }
      previous = stage.outputs;
    }
    if (!valid) continue;
    previous.forEach((sources, ch) => sources.forEach((from) => link(from, end(output.id, ch ? 'r' : 'l'))));
    const memberSet = new Set(members);
    const outgoing = p.cables.filter((c) => memberSet.has(c.from.module));
    if (!sameSet(outgoing.map(cableKey), expected.map(cableKey))) continue;
    const incoming = p.cables.filter((c) => memberSet.has(c.to.module) && !memberSet.has(c.from.module));
    const inputPorts = stages[0].inputs;
    if (!incoming.length || incoming.some((c) => !inputPorts.some((e) => sameEnd(e, c.to)) ||
        !defs[p.modules.find((m) => m.id === c.from.module)?.type ?? '']?.outputs.some((o) => o.name === c.from.port)) ||
        p.cables.some((c) => c.to.module === output.id && (c.to.port === 'l' || c.to.port === 'r') && !memberSet.has(c.from.module))) continue;
    if (!portsAre(root, 'inputs', inputPorts) || !portsAre(root, 'outputs', previous.flat())) continue;
    const internal = p.cables.filter((c) => memberSet.has(c.to.module) && memberSet.has(c.from.module));
    if (!sameSet(internal.map(cableKey), expected.filter((c) => memberSet.has(c.to.module)).map(cableKey))) continue;
    found.push({ assembly: root.id, stages: stages.map(({ kind, assembly, targets, helpers, inputs, outputs }) => ({ kind, assembly, targets, helpers, inputs, outputs })) });
  }
  return found.length === 1 ? found[0] : null;
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';
const refsOk = (list: unknown): boolean => Array.isArray(list) && list.every((r) => isRec(r) && Number.isInteger(r.module) && (r.also === undefined || (Array.isArray(r.also) && r.also.every(isRec))));

/** an overlay the recognizer can read without tripping (validatePatch runs before fixAssemblies repairs the overlay) */
function readable(p: Patch): boolean {
  const raw: unknown = p.assemblies;
  return Array.isArray(raw) && raw.every((a) => isRec(a) && Number.isInteger(a.id) && Array.isArray(a.modules) &&
    (a.children === undefined || Array.isArray(a.children)) && refsOk(a.inputs) && refsOk(a.outputs) && refsOk(a.params));
}

/** the one top-level instrument whose exposed outputs are exactly the bus's sources, with those outputs as [L, R] */
function soleInstrument(p: Patch, bus: FxBus): { instrument: AssemblyInst; taps: [Target, Target] } | null {
  const sources = bus.stages[0].inputs.map((to) => p.cables.filter((c) => sameEnd(c.to, to)).map((c) => c.from));
  const own = new Set([bus.assembly, ...bus.stages.map((s) => s.assembly)]);
  const holders = assembliesOf(p).filter((a) => !own.has(a.id) && !parentOf(p, a.id) && !a.chain && !a.drawer);
  const members = (a: AssemblyInst): Set<number> => {
    const ids = new Set(a.modules);
    for (let more = [...(a.children ?? [])]; more.length;) {
      const c = assemblyById(p, more.pop()!);
      if (!c) continue;
      for (const m of c.modules) ids.add(m);
      more.push(...(c.children ?? []));
    }
    return ids;
  };
  const found = holders.filter((a) => { const m = members(a); return sources.flat().some((s) => m.has(s.module)); });
  if (found.length !== 1) return null;
  const instrument = found[0];
  const key = (e: Endpoint): string => `${e.module}:${e.port}`;
  const taps = sources.map((list) => {
    const ref = list.length ? findRef(instrument, 'out', list[0].module, list[0].port) : undefined;
    return ref && sameSet([...new Set(targetsOf(ref).map(key))], [...new Set(list.map(key))]) ? { module: ref.module, port: ref.port } : null;
  });
  return taps[0] && taps[1] ? { instrument, taps: [taps[0], taps[1]] } : null;
}

/** where a stage card's FM-1 pages start (pages.ts groupStarts, for the plain rows a D-1010 card has: a heading, a group
 *  start or a column break starts a page, and so does a fifth row). pages.ts is not imported: it needs patch.ts loaded */
function pageStarts(rows: readonly ParamRef[]): number[] {
  const out: number[] = [];
  let n = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.head || r.group || r.pin || r.col || n === 4) {
      out.push(i);
      n = 0;
    }
    n++;
  });
  return out;
}

/**
 * A patch with a D-1010 master FX bus gets an FX drawer instead (contracts §6): each stage assembly becomes an effect in
 * the same order with the same rows, values and on/off states (its chain ports set; a Chorus or Delay takes the root's
 * correction Math as its helper; the Reverb's helpers stay; helpers are never bypassed); the drawer is the sole
 * instrument's whose exposed outputs feed the bus, else the Output drawer; the root assembly goes. Toggles on the root
 * switch the drawer, Page buttons that listed its pages list the effects' pages, and a factory FX button that paged it
 * does nothing now (the FM-1's FX button finds the drawers). Modules, their order and the cables do not change.
 * Without a bus the patch is returned as it is. Returns the patch (changed in place).
 */
export function convertLegacyBus(p: Patch, defs: Record<string, ModuleDef>): Patch {
  if (!readable(p)) return p;
  const bus = fxBusOf(p, defs);
  if (!bus) return p;
  const root = assemblyById(p, bus.assembly)!;
  const pageStage = pageStarts(root.params).map((i) => bus.stages.find((s) => assemblyById(p, s.assembly)!.params.some((r) => r.module === root.params[i].module))?.assembly);
  const owner = soleInstrument(p, bus);
  for (const stage of bus.stages) {
    const a = assemblyById(p, stage.assembly)!;
    if (stage.kind === 'chorus' || stage.kind === 'delay') {
      root.modules = root.modules.filter((id) => id !== stage.helpers[0]);
      a.modules.push(stage.helpers[0]);
    }
    for (const id of stage.helpers) delete p.modules.find((m) => m.id === id)!.bypass;
    const port = (list: PortRef[], ends: Endpoint[], name: string): PortRef => {
      const label = list.find((r) => targetsOf(r).some((t) => sameEnd(t, ends[0])))?.label ?? name;
      return { module: ends[0].module, port: ends[0].port, label, ...(ends.length > 1 ? { also: ends.slice(1).map((e) => ({ ...e })) } : {}) };
    };
    a.inputs = stage.inputs.map((e, ch) => port(a.inputs, [e], ch ? 'in R' : 'in L'));
    a.outputs = stage.outputs.map((ends, ch) => port(a.outputs, ends, ch ? 'out R' : 'out L'));
    a.chain = { ins: [0, 1], outs: [0, 1], helpers: [...stage.helpers] };
  }
  const at = p.assemblies!.indexOf(root);
  const drawer: AssemblyInst = {
    v: 1, id: root.id, name: root.name, label: root.label, x: owner?.instrument.x ?? root.x, y: owner?.instrument.y ?? root.y, open: false,
    modules: [], children: bus.stages.map((s) => s.assembly), inputs: [], outputs: [], params: [],
    drawer: owner ? { taps: owner.taps } : {},
  };
  // (the drawer takes the root's id: Toggles that switched the root switch the drawer)
  p.assemblies!.splice(at, 1, drawer);
  if (owner) owner.instrument.children = [...(owner.instrument.children ?? []), drawer.id];
  const panel = p.modules.find((m) => m.type === 'fm1')?.panel;
  if (!panel) return p;
  const rootKey = `a${root.id}`;
  const pages = panel.pages ?? {};
  if (panel.kinds?.fx === 'page' && (pages.fx ?? []).every((e) => e.device === rootKey)) {
    delete pages.fx;
    panel.kinds.fx = 'nothing';
  }
  const effectPages = new Map(bus.stages.map((s) => [s.assembly, pageStarts(assemblyById(p, s.assembly)!.params).length]));
  for (const [button, list] of Object.entries(pages)) {
    pages[button] = list.flatMap((e) => {
      if (e.device !== rootKey) return [e];
      const stage = pageStage[e.page];
      if (stage === undefined) return [];
      const k = pageStage.slice(0, e.page).filter((s) => s === stage).length;
      return [{ device: `a${stage}`, page: Math.min(k, Math.max(0, effectPages.get(stage)! - 1)) }];
    });
    if (!pages[button].length) delete pages[button];
  }
  if (Object.keys(pages).length) panel.pages = pages;
  else delete panel.pages;
  return p;
}
