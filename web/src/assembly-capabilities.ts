// SPDX-License-Identifier: GPL-3.0-only
// Structural evidence for assembly conveniences. Never changes the patch or its execution plan.
import { allModules, targetsOf, type AssemblyDef, type AssemblyInst, type PortRef } from './assembly';
import { DEFS } from './modules';
import type { Cable, ModuleDef, ModuleInst, Patch, SignalKind } from './patch';

export type KindOf = (r: PortRef, dir: 'in' | 'out') => SignalKind | undefined;
export const VOICING_TYPES = new Set(['alloc', 'drummap']);
export const kindIn = (modules: ModuleInst[], defs: Record<string, ModuleDef>): KindOf => (r, dir) => {
  const d = defs[modules.find(m => m.id === r.module)?.type ?? ''];
  return (dir === 'in' ? d?.inputs : d?.outputs)?.find(p => p.name === r.port)?.kind;
};

/** Retains the historical helper's permissive default; full recognition supplies voicing traversal. */
export const isEngine = (inputs: PortRef[], outputs: PortRef[], kindOf: KindOf, voiced: (r: PortRef) => boolean = () => true): boolean =>
  inputs.some(r => kindOf(r, 'in') === 'keys' && voiced(r)) && outputs.some(r => kindOf(r, 'out') === 'audio');

export interface AssemblyGraph {
  inputs: PortRef[];
  outputs: PortRef[];
  modules: ModuleInst[];
  cables: Cable[];
  /** The original instance check looks up exposed ports in the whole patch. */
  portModules: ModuleInst[];
}
export const definitionGraph = (a: AssemblyDef): AssemblyGraph => ({ ...a, portModules: a.modules });
export function instanceGraph(p: Patch, a: AssemblyInst): AssemblyGraph {
  const ids = new Set(allModules(p, a));
  return { inputs: a.inputs, outputs: a.outputs, modules: p.modules.filter(m => ids.has(m.id)), cables: p.cables, portModules: p.modules };
}
export interface EngineCapability {
  kind: 'engine';
  inputs: { port: PortRef; voicing: number[] }[];
  outputs: PortRef[];
}

/** Same reachability as the original engine check, including merged targets and cycle protection. */
function voicingFrom(start: PortRef, g: AssemblyGraph, defs: Record<string, ModuleDef>): number[] {
  const byId = new Map(g.modules.map(m => [m.id, m]));
  const seen = new Set<number>(), found: number[] = [];
  const todo = targetsOf(start).map(t => t.module);
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const m = byId.get(id);
    if (!m) continue;
    if (VOICING_TYPES.has(m.type)) { found.push(id); continue; }
    const keysOut = defs[m.type]?.outputs.filter(o => o.kind === 'keys').map(o => o.name) ?? [];
    for (const c of g.cables) if (c.from.module === id && keysOut.includes(c.from.port) && byId.has(c.to.module)) todo.push(c.to.module);
  }
  return found;
}
export function recognizeEngine(g: AssemblyGraph, defs: Record<string, ModuleDef> = DEFS): EngineCapability | null {
  const kind = kindIn(g.portModules, defs);
  const outputs = g.outputs.filter(r => kind(r, 'out') === 'audio');
  if (!outputs.length) return null;
  const inputs = g.inputs.filter(r => kind(r, 'in') === 'keys')
    .map(port => ({ port, voicing: voicingFrom(port, g, defs) })).filter(r => r.voicing.length);
  return inputs.length ? { kind: 'engine', inputs, outputs } : null;
}

/** Primitive signal dependencies checked against their DSP implementations. Unknown types are not guessed.
 * This small table is the prototype's scope, not a factory-assembly allowlist. */
const AUDIO_FLOW: Record<string, { input: string; outputs: readonly string[] }> = {
  delay: { input: 'in', outputs: ['out'] },
  reverb: { input: 'in', outputs: ['out'] },
  filter: { input: 'in', outputs: ['lp24', 'lp12', 'bp', 'hp', 'mix', 'notch', 'peak', 'ap'] },
};
export interface AudioPath { input: PortRef; output: PortRef; modules: number[] }
export interface AudioCapability { kind: 'audio-processing'; inputs: PortRef[]; outputs: PortRef[]; paths: AudioPath[] }
export interface CapabilityReport {
  engine: EngineCapability | null;
  audio: AudioCapability | null;
  diagnostics: string[];
}

export function assemblyCapabilities(g: AssemblyGraph, defs: Record<string, ModuleDef> = DEFS): CapabilityReport {
  const engine = recognizeEngine(g, defs), diagnostics: string[] = [];
  const kind = kindIn(g.modules, defs);
  const inputs = g.inputs.filter(r => kind(r, 'in') === 'audio');
  const outputs = g.outputs.filter(r => kind(r, 'out') === 'audio');
  const byId = new Map(g.modules.map(m => [m.id, m]));
  const paths: AudioPath[] = [];
  const unknown = new Set<string>();
  for (const input of inputs) {
    // Merged inputs need an explicit channel/mixing contract; the prototype does not infer one.
    if (input.also?.length) { diagnostics.push(`Merged audio input “${input.label}” needs an explicit routing contract.`); continue; }
    const todo = [{ module: input.module, port: input.port, path: [] as number[] }];
    const seen = new Set<string>();
    while (todo.length) {
      const next = todo.shift()!;
      const key = `${next.module}:${next.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = byId.get(next.module);
      if (!m) continue;
      const flow = AUDIO_FLOW[m.type];
      if (!flow) { unknown.add(m.type); continue; }
      if (next.port !== flow.input) continue;
      const path = [...next.path, m.id];
      for (const port of flow.outputs) {
        if (!defs[m.type]?.outputs.some(o => o.name === port && o.kind === 'audio')) continue;
        for (const output of outputs) if (output.module === m.id && output.port === port) paths.push({ input, output, modules: path });
        for (const c of g.cables) if (c.from.module === m.id && c.from.port === port && byId.has(c.to.module)
          && kind({ ...c.to, label: '' }, 'in') === 'audio') todo.push({ ...c.to, path });
      }
    }
  }
  if (unknown.size) diagnostics.push(`Audio dependencies are not described yet for: ${[...unknown].join(', ')}.`);
  const complete = inputs.length > 0 && outputs.length > 0 && inputs.every(i => paths.some(p => p.input === i)) && outputs.every(o => paths.some(p => p.output === o));
  if (!complete) diagnostics.push(inputs.length && outputs.length ? 'No complete supported audio path between the exposed ports.' : 'Audio processing needs exposed audio inputs and outputs.');
  if (!engine) diagnostics.push('No engine recognized: keys must reach voicing and an audio output must be exposed.');
  return { engine, audio: complete ? { kind: 'audio-processing', inputs, outputs, paths } : null, diagnostics };
}

export const capabilitiesOf = (p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef> = DEFS): CapabilityReport =>
  assemblyCapabilities(instanceGraph(p, a), defs);

export interface BypassDraft { input: PortRef; output: PortRef }
export type BypassPreview = { ok: false; reason: string } | {
  ok: true; modules: number[]; input: PortRef; output: PortRef;
  state: 'frozen'; tails: 'muted'; memory: 'retained';
};
/** Preview a declaration for existing module bypass on a complete mono serial chain.
 * Never applies bypass, saves metadata, releases memory or promises tail spillover. */
export function previewBypass(p: Patch, a: AssemblyInst, draft: BypassDraft): BypassPreview {
  const g = instanceGraph(p, a), audio = assemblyCapabilities(g).audio;
  const same = (x: PortRef, y: PortRef) => x.module === y.module && x.port === y.port;
  if (!audio || audio.inputs.length !== 1 || audio.outputs.length !== 1) return { ok: false, reason: 'The bypass preview supports one audio input and one audio output.' };
  if (!same(audio.inputs[0], draft.input) || !same(audio.outputs[0], draft.output)) return { ok: false, reason: 'The declared ports no longer match this assembly.' };
  const path = audio.paths[0].modules;
  const members = new Set(g.modules.map(m => m.id));
  if (path.length !== members.size || g.inputs.length !== 1 || g.outputs.length !== 1
    || (a.children?.length ?? 0) > 0 || a.poly) return { ok: false, reason: 'The preview requires a flat serial audio assembly without additional ports or voices.' };
  const internal = p.cables.filter(c => members.has(c.from.module) && members.has(c.to.module));
  if (internal.length !== path.length - 1 || internal.some(c => path.indexOf(c.to.module) !== path.indexOf(c.from.module) + 1))
    return { ok: false, reason: 'Branches, feedback and additional internal modulation need a separate bypass contract.' };
  const crossing = p.cables.filter(c => members.has(c.from.module) !== members.has(c.to.module));
  if (crossing.some(c => members.has(c.to.module) ? !same({ ...c.to, label: '' }, draft.input) : !same({ ...c.from, label: '' }, draft.output)))
    return { ok: false, reason: 'An outside cable reaches an internal port; the declared dry route does not cover it.' };
  return { ok: true, modules: path, input: audio.inputs[0], output: audio.outputs[0], state: 'frozen', tails: 'muted', memory: 'retained' };
}
