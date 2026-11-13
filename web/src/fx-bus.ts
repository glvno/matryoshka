// SPDX-License-Identifier: GPL-3.0-only
// An editable ordinary-module master insert; its graph/grouping, not its name, grants FX identity.
import { exposePort, makeAssembly, mergeRows, promote, rowTargets, type AssemblyInst, type RowTarget } from './assembly';
import { DEFS } from './modules';
import { addModule, connect, disconnect, sameEnd, type Cable, type Endpoint, type ModuleInst, type Patch } from './patch';
import { FX_PRESET_CONTROLS as PARAMETERS } from './fx-preset-format';

export type FxStageKind = 'drive' | 'chorus' | 'delay' | 'reverb';
export interface FxStage { kind: FxStageKind; assembly: number; targets: number[]; helpers: number[] }
export interface FxBus { assembly: number; stages: FxStage[] }
export interface FxBusOptions { omit?: readonly FxStageKind[] }
export const FX_STAGE_TARGET_MAX = 8;

const KINDS: readonly FxStageKind[] = ['drive', 'chorus', 'delay', 'reverb'];
// The hardware interface promises these controls together, not every expensive primitive quality mode.
const typeOf = (kind: FxStageKind): string => kind === 'drive' ? 'shape' : kind;
const outsOf = (kind: FxStageKind): string[] => kind === 'chorus' ? ['l', 'r'] : kind === 'delay' ? ['out', 'r'] : ['out'];
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

function pairState(a: ModuleInst, b: ModuleInst): boolean {
  return !!a.bypass === !!b.bypass && DEFS[a.type].params.every((pd) => a.params[pd.name] === b.params[pd.name] && a.paramsB?.[pd.name] === b.paramsB?.[pd.name]);
}

const ordinaryHelper = (m: ModuleInst): boolean => !m.paramsB && !m.range && !m.inputMap;
const mathIs = (m: ModuleInst, ka: number, kb: number): boolean => m.type === 'math' && ordinaryHelper(m) && m.params.ka === ka && m.params.kb === kb && m.params.off === 0;
interface StageGraph extends FxStage {
  inputs: Endpoint[];
  outputs: Endpoint[][];
  rows: RowTarget[][];
  internal: Cable[];
}

/** Derive the wet-only Reverb and its ordinary controls without relying on labels or persisted tags. */
function stageGraph(p: Patch, a: AssemblyInst): StageGraph | null {
  if (a.poly || a.children?.length || new Set(a.modules).size !== a.modules.length) return null;
  const modules = a.modules.map((id) => p.modules.find((m) => m.id === id));
  if (modules.some((m) => !m)) return null;
  for (const kind of KINDS.filter((k) => k !== 'reverb')) {
    if (modules.length !== 2 || !modules.every((m) => m!.type === typeOf(kind))) continue;
    const targets = [...a.modules];
    if (!pairState(modules[0]!, modules[1]!)) return null;
    return { kind, assembly: a.id, targets, helpers: [], inputs: targets.map((id) => end(id, 'in')),
      outputs: targets.map((id) => [end(id, 'out')]),
      rows: PARAMETERS[kind].map((param) => targets.map((module) => ({ module, param }))), internal: [] };
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
  // The wrapper may activate helpers only for canonical OFF: all legacy members
  // bypassed, or runtime helpers already active. Individual switches stay ordinary.
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
    rows: PARAMETERS.reverb.map((param) => [{ module: param === 'mix' ? mix.id : kernel.id, param: param === 'mix' ? 'value' : param }]), internal };
}

/** Recognize an exact terminal stereo master insert with one to four ordered, present stages. */
export function fxBusOf(p: Patch): FxBus | null {
  const assemblies = p.assemblies ?? [];
  if (new Set(p.modules.map((m) => m.id)).size !== p.modules.length || new Set(assemblies.map((a) => a.id)).size !== assemblies.length ||
      p.modules.some((m) => !Number.isSafeInteger(m.id) || m.id <= 0) || assemblies.some((a) => !Number.isSafeInteger(a.id) || a.id <= 0)) return null;
  const outputs = p.modules.filter((m) => m.type === 'output');
  if (outputs.length !== 1) return null;
  const output = outputs[0];
  const found: FxBus[] = [];
  for (const root of assemblies) {
    if (root.poly || root.bypass || !root.children?.length || root.children.length > 4 || new Set(root.children).size !== root.children.length ||
        assemblies.some((a) => a.children?.includes(root.id))) continue;
    const children = root.children.map((id) => assemblies.find((a) => a.id === id));
    if (children.some((a) => !a)) continue;
    const graphs = children.map((a) => stageGraph(p, a!));
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
        !DEFS[p.modules.find((m) => m.id === c.from.module)?.type ?? '']?.outputs.some((o) => o.name === c.from.port)) ||
        p.cables.some((c) => c.to.module === output.id && (c.to.port === 'l' || c.to.port === 'r') && !memberSet.has(c.from.module))) continue;
    if (!portsAre(root, 'inputs', inputPorts) || !portsAre(root, 'outputs', previous.flat())) continue;
    const internal = p.cables.filter((c) => memberSet.has(c.to.module) && memberSet.has(c.from.module));
    if (!sameSet(internal.map(cableKey), expected.filter((c) => memberSet.has(c.to.module)).map(cableKey))) continue;
    found.push({ assembly: root.id, stages: stages.map(({ kind, assembly, targets, helpers }) => ({ kind, assembly, targets, helpers })) });
  }
  return found.length === 1 ? found[0] : null;
}

/** A single Reverb kernel's wet-return helpers: the stage's runtime switch owns them, so their saved bypass mirrors the
 * stage but never reaches either engine as an ordinary bypass (D-1100). */
export function fxRuntimeHelpers(p: Patch): Set<number> {
  const bus = fxBusOf(p);
  return new Set(bus ? bus.stages.flatMap(s => s.kind === 'reverb' && s.targets.length === 1 ? s.helpers : []) : []);
}

function promoteRows(p: Patch, a: AssemblyInst, rows: RowTarget[][], kind: FxStageKind): void {
  rows.forEach((targets, i) => {
    for (const t of targets) promote(a, t.module, t.param, p);
    for (const t of targets.slice(1)) mergeRows(p, a, DEFS, targets[0], t);
    a.params.find((r) => r.module === targets[0].module && r.param === targets[0].param)!.label = PARAMETERS[kind][i];
  });
}

/** Clone and insert only missing interface effects; omit all four to leave the instrument graph unchanged. */
export function withFxBus(source: Patch, options: FxBusOptions = {}): Patch {
  const p: Patch = structuredClone(source);
  if (fxBusOf(p)) return p;
  const kinds = KINDS.filter((kind) => !options.omit?.includes(kind));
  if (!kinds.length) return p;
  const outputs = p.modules.filter((m) => m.type === 'output');
  if (outputs.length !== 1) throw new Error('FX bus needs exactly one master Output');
  const output = outputs[0];
  const original = p.cables.filter((c) => c.to.module === output.id && (c.to.port === 'l' || c.to.port === 'r'));
  const left = original.filter((c) => c.to.port === 'l');
  const right = original.filter((c) => c.to.port === 'r');
  if (!left.length && !right.length) throw new Error('FX bus needs a connected master Output');
  const x = Math.max(...p.modules.map((m) => m.x), 0) + 320;
  const y = Math.min(...p.modules.map((m) => m.y), 20);
  // Direct members precede stage members, preserving one contiguous allModules device-member run.
  const corrections = new Map<FxStageKind, number>();
  for (const kind of kinds.filter((k) => k === 'chorus' || k === 'delay')) {
    const m = addModule(p, DEFS.math, x + corrections.size * 320, y + 1680);
    Object.assign(m.params, { ka: 0.25, kb: 0.25, off: 0 });
    corrections.set(kind, m.id);
  }
  const wire = (from: Endpoint, to: Endpoint): void => {
    if (!connect(p, DEFS, from, to)) throw new Error(`Cannot connect FX bus ${from.module}:${from.port} to ${to.module}:${to.port}`);
  };
  const stages: { kind: FxStageKind; members: number[]; inputs: Endpoint[]; rows: RowTarget[][] }[] = [];
  let previous: Endpoint[][] = [];
  for (const [i, kind] of kinds.entries()) {
    let members: number[];
    let inputs: Endpoint[];
    let rows: RowTarget[][];
    let next: Endpoint[][];
    if (kind === 'reverb') {
      const kernel = addModule(p, DEFS.reverb, x + i * 320, y);
      kernel.params.mix = 1;
      const dry = [0, 1].map((ch) => addModule(p, DEFS.scale, x + i * 320, y + (ch + 1) * 280));
      const send = addModule(p, DEFS.math, x + i * 320, y + 840);
      Object.assign(send.params, { ka: 0.5, kb: 0.5, off: 0 });
      const mix = addModule(p, DEFS.macro, x + i * 320, y + 1120);
      mix.params.value = DEFS.reverb.params.find((pd) => pd.name === 'mix')!.default;
      const wet = addModule(p, DEFS.math, x + i * 320, y + 1400);
      Object.assign(wet.params, { ka: 1, kb: 1, off: 0 });
      members = [kernel.id, ...dry.map((m) => m.id), send.id, mix.id, wet.id];
      for (const id of members) p.modules.find((m) => m.id === id)!.bypass = true;
      dry.forEach((m, ch) => wire(end(m.id, 'out'), end(send.id, ch ? 'b' : 'a')));
      wire(end(send.id, 'add'), end(kernel.id, 'in'));
      wire(end(kernel.id, 'out'), end(wet.id, 'a'));
      wire(end(mix.id, 'out'), end(wet.id, 'b'));
      inputs = dry.map((m) => end(m.id, 'in'));
      // The dry channels never collapse or depend on the wet control. Generic Math bypass silences the wet return.
      next = dry.map((m) => [end(m.id, 'out'), end(wet.id, 'mul')]);
      rows = PARAMETERS.reverb.map((param) => [{ module: param === 'mix' ? mix.id : kernel.id, param: param === 'mix' ? 'value' : param }]);
    } else {
      const targets = [0, 1].map((ch) => {
        const m = addModule(p, DEFS[typeOf(kind)], x + i * 320, y + ch * 560);
        m.bypass = true;
        if (kind === 'drive') Object.assign(m.params, { drive: 1, level: 1 });
        if (kind === 'delay') Object.assign(m.params, { length: 500, rate: 0 });
        return m.id;
      });
      members = targets;
      inputs = targets.map((id) => end(id, 'in'));
      rows = PARAMETERS[kind].map((param) => targets.map((module) => ({ module, param })));
      if (kind === 'chorus' || kind === 'delay') {
        // C=.25*(Ar+Bl-Al-Br); L=Al+C, R=Br+C. Native stereo on mono, identity at every bypassed mix.
        const [first, second] = outsOf(kind);
        const [a, b] = targets;
        const taps = [end(a, first), end(a, second), end(b, first), end(b, second)];
        const helper = corrections.get(kind)!;
        for (const tap of [taps[1], taps[2]]) wire(tap, end(helper, 'a'));
        for (const tap of [taps[0], taps[3]]) wire(tap, end(helper, 'b'));
        next = [[taps[0], end(helper, 'sub')], [taps[3], end(helper, 'sub')]];
      } else next = targets.map((id) => [end(id, 'out')]);
    }
    if (previous.length) inputs.forEach((to, ch) => previous[ch].forEach((from) => wire(from, to)));
    else [left, right.length ? right : left].forEach((cables, ch) => cables.forEach((c) => wire(c.from, inputs[ch])));
    previous = next;
    stages.push({ kind, members, inputs, rows });
  }
  for (const c of original) disconnect(p, c);
  previous.forEach((sources, ch) => sources.forEach((from) => wire(from, end(output.id, ch ? 'r' : 'l'))));
  const children = stages.map((stage) => {
    const a = makeAssembly(p, stage.members, stage.kind === 'drive' ? 'Drive' : stage.kind[0].toUpperCase() + stage.kind.slice(1));
    promoteRows(p, a, stage.rows, stage.kind);
    for (const input of stage.inputs) exposePort(a, 'in', input.module, input.port);
    // The group switch's own form (bypassAssembly): no member was off before it, so all come back on with it.
    a.bypass = true;
    a.kept = [];
    return a;
  });
  const root = makeAssembly(p, [...corrections.values()], 'FX', children.map((a) => a.id));
  for (const input of stages[0].inputs) exposePort(root, 'in', input.module, input.port, undefined, p);
  for (const stage of stages) {
    promoteRows(p, root, stage.rows, stage.kind);
    const first = root.params.find((r) => r.module === stage.rows[0][0].module)!;
    first.head = stage.kind === 'drive' ? 'Drive' : stage.kind[0].toUpperCase() + stage.kind.slice(1);
  }
  if (!fxBusOf(p)) throw new Error('FX bus construction did not produce a proven stereo master insert');
  return p;
}
