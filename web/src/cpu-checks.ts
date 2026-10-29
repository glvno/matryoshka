// SPDX-License-Identifier: GPL-3.0-only
// The whole patches the CPU model is checked on: scripts/cpu-costs.ts counts them on the emulator (cpu-costs.json `checks`),
// cpu.test.ts holds the model to those counts. Each with the notes held while counting.
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { DEFS } from './modules';
import { connect, newPatch, type Patch } from './patch';
import { deviceBudget } from './patchbin';
import { FM1_PRESETS } from './presets';
import { deviceView } from './poly';
import { withParts } from './test-poly';
import { acid } from './test-patches';

export function cpuChecks(note: number): { name: string; patch: Patch; notes: number[] }[] {
  const chord = [note - 12, note - 5, note, note + 4];
  // one note per voice of the patch's largest poly group: a voice with no note goes idle (engine.c part_quiet), and the
  // estimate is the worst case, every voice playing
  const voices = (p: Patch): number[] => {
    const n = Math.max(1, ...deviceView(p, true).groups.map((g) => g.cfg.parts));
    return Array.from({ length: n }, (_, i) => note + [0, 4, 7, 11, 14, 17, 21, 24][i % 8] - (i >= 8 ? 12 : 0));
  };
  const out = Object.entries(FM1_PRESETS).map(([name, make]) => { const patch = make(); return { name, patch, notes: voices(patch) }; });
  out.push({ name: 'Acid, 4 parts', patch: withParts(acid(), 4), notes: chord });
  const morph = acid();
  for (const m of morph.modules) if (m.type !== 'fm1') m.paramsB = { ...m.params };
  out.push({ name: 'Acid, morph', patch: morph, notes: [note] });
  for (const def of FACTORY) {                     // those the FM-1 can load (a CPU estimate over 100 % is checked too)
    const patch = newPatch(DEFS, def.name);
    const a = insertAssembly(patch, DEFS, def, 300, 0);
    const sink = patch.modules.find((m) => m.type === 'output')!;
    for (const o of a.outputs) connect(patch, DEFS, { module: o.module, port: o.port }, { module: sink.id, port: 'l' });   // heard, so the FM-1 runs it (device-compile.ts drops what is not)
    // played: the keys into a Voice allocator, the Main pitch / gate / velocity into inputs of those names
    const main = patch.modules[0].id;
    for (const i of a.inputs) {
      const from = i.port === 'keys' ? 'keys' : (['pitch', 'gate', 'vel'] as const).find((k) => i.port === k || i.label === k);
      if (from) connect(patch, DEFS, { module: main, port: from }, { module: i.module, port: i.port });
    }
    if (deviceBudget(patch).over.every((i) => i.key === 'cpu')) out.push({ name: `assembly ${def.name}`, patch, notes: voices(patch).length > 1 ? voices(patch) : chord });
  }
  return out;
}

/** modules whose cost depends on what they are fed (grains alive, a compressor working): the table holds their worst case */
export const BUSY_TYPES = new Set(['grain', 'dyn']);

/** checks the model may overestimate by more than usual: a busy module (above), or a filter whose cutoff an LFO moves (the
 * model charges a cutoff that moves every sample; a slow LFO changes the Q16 value only every few samples, and the filter
 * works out its coefficients only then) */
export function looseModel(p: Patch): boolean {
  if (p.modules.some((m) => BUSY_TYPES.has(m.type))) return true;
  // an envelope or a glide into an oscillator's pitch (a drum's sweep, portamento): the model charges every sample as
  // moving, it settles sooner
  const byId = new Map(p.modules.map((m) => [m.id, m]));
  const fromEnv = (id: number, seen = new Set<number>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (['adsr', 'env', 'env8', 'glide'].includes(byId.get(id)?.type ?? '')) return true;
    return p.cables.some((c) => c.to.module === id && fromEnv(c.from.module, seen));
  };
  if (p.cables.some((c) => c.to.port === 'pitch' && fromEnv(c.from.module))) return true;
  // an LFO whose rate a knob or another signal sets: the model charges it at its fastest (a pitch it moves every sample)
  if (p.modules.some((m) => m.type === 'lfo' && Math.round(m.params.wave ?? 0) !== 4 && p.cables.some((c) => c.to.module === m.id))) return true;
  return p.cables.some((c) => c.to.port === 'cv' && p.modules.find((m) => m.id === c.to.module)?.type === 'filter' && p.modules.find((m) => m.id === c.from.module)?.type === 'lfo');
}
