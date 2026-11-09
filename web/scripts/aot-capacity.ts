// SPDX-License-Identifier: GPL-3.0-only
// Reproducible #808 capacity fixtures; not factory patches. Run from web/:
// npx vite-node scripts/aot-capacity.ts (writes build/aot-capacity).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FACTORY } from '../src/assemblies';
import { insertAssembly, type AssemblyInst } from '../src/assembly';
import { DEFS } from '../src/modules';
import { addModule, type Patch } from '../src/patch';
import { FM1_PRESETS } from '../src/presets';
import { deviceBudget, encodePatch } from '../src/patchbin';
import { fixNotes } from '../src/track';
import { plugIn, wire } from './factory-build';

const out = new URL('../../build/aot-capacity/', import.meta.url);
mkdirSync(out, { recursive: true });
const report: unknown[] = [];
const synthNotes = (voices: number) => fixNotes([0, 4, 8, 12].flatMap((at) =>
  [60, 64, 67, 71].slice(0, voices).map((note) => ({ at, note, len: 3, vel: 100 }))));
const drumNotes = ([kick, snare, hat]: number[]) => fixNotes([0, 2, 4, 6, 8, 10, 12, 14].flatMap((at) =>
  [hat, ...(at % 4 === 0 ? [kick] : []), ...(at % 8 === 4 ? [snare] : [])].map((note) => ({ at, note, len: 1, vel: 100 }))));
function track(p: Patch, a: AssemblyInst, voices: number, live: boolean): void {
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const t = addModule(p, DEFS.steps, 20, 2000);
  t.name = 'SYNTH';
  t.notes = synthNotes(voices);
  if (live) wire(p, main.id, 'keys', t.id, 'keys');
  plugIn(p, t.id, 'keys', a, 'keys');
  const alloc = p.modules.find((m) => a.modules.includes(m.id) && m.type === 'alloc');
  if (!alloc) throw new Error('Oracle allocator missing');
  alloc.params.voices = voices;
  for (const label of ['wheel', 'at']) {
    if (a.inputs.some((i) => i.label === label)) plugIn(p, main.id, label === 'wheel' ? 'mod' : 'at', a, label);
  }
}
function oracle(voices: number): Patch {
  const p = FM1_PRESETS['Oracle V']();
  // Keep the factory's Steps -> Arpeggiator -> Oracle key path and performance controls.
  const t = p.modules.find((m) => m.type === 'steps')!;
  t.name = 'SYNTH';
  t.notes = synthNotes(voices);
  p.modules.find((m) => m.type === 'alloc')!.params.voices = voices;
  return p;
}
function save(p: Patch, name: string): void {
  p.name = name;
  p.modules.find((m) => m.type === 'fm1')!.params.tempo = 120;
  p.modules.find((m) => m.type === 'output')!.params.level = 0.3;
  const budget = deviceBudget(p);
  const bytes = encodePatch(p, true);
  // Keep oversized fixtures for host capacity analysis, but never send them to hardware.
  writeFileSync(new URL(name + '.m1p', out), bytes);
  writeFileSync(new URL(name + '.json', out), JSON.stringify(p, null, 1) + '\n');
  report.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), budget });
  console.log(name, bytes.length, 'bytes', 'over:', budget.over.map((x) => `${x.key} ${x.used}/${x.max}`).join(', ') || 'none');
}
for (const voices of [1, 2, 4]) {
  const p = FM1_PRESETS['808 Kit']();
  const main = p.modules.find((m) => m.type === 'fm1')!;
  const drums = p.modules.find((m) => m.type === 'steps')!;
  p.cables = p.cables.filter((c) => !(c.from.module === main.id && c.to.module === drums.id));
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 300, 2500);
  track(p, a, voices, true);
  const sink = p.modules.find((m) => m.type === 'output')!;
  for (const o of a.outputs) wire(p, o.module, o.port, sink.id, 'r');
  save(p, `oracle-${voices}-808`);
}
for (const voices of [1, 2]) {
  const p = oracle(voices);
  const second = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'Oracle V')!, 300, 2500);
  track(p, second, voices, false);
  const sink = p.modules.find((m) => m.type === 'output')!;
  for (const o of second.outputs) wire(p, o.module, o.port, sink.id, 'r');
  save(p, `oracle-${voices}-twice`);
}
for (const voices of [1, 2, 4]) {
  const p = oracle(voices);
  const d = insertAssembly(p, DEFS, FACTORY.find((a) => a.name === 'drum kit')!, 300, 2500);
  const t = addModule(p, DEFS.steps, 20, 3000);
  t.name = 'DRUMS';
  t.notes = drumNotes([36, 38, 42]);
  plugIn(p, t.id, 'keys', d, 'keys');
  const sink = p.modules.find((m) => m.type === 'output')!;
  for (const o of d.outputs) wire(p, o.module, o.port, sink.id, 'r');
  save(p, `oracle-${voices}-drum-kit`);
}
for (const voices of [1, 2, 4]) {
  const p = oracle(voices);
  const sink = p.modules.find((m) => m.type === 'output')!;
  p.cables = p.cables.filter((c) => !(c.to.module === sink.id && c.to.port === 'r'));
  const t = addModule(p, DEFS.steps, 20, 3000);
  t.name = 'DRUMS';
  t.notes = drumNotes([53, 55, 59]);
  const map = addModule(p, DEFS.drummap, 200, 3000);
  wire(p, t.id, 'keys', map.id, 'keys');
  for (const [i, name] of ['boom kick', 'snare', 'hihat'].entries()) {
    map.params[`n${i + 1}`] = [53, 55, 59][i];
    const d = insertAssembly(p, DEFS, FACTORY.find((a) => a.name === name)!, 300 + 300 * i, 3000);
    plugIn(p, map.id, `g${i + 1}`, d, 'gate');
    for (const o of d.outputs) wire(p, o.module, o.port, sink.id, 'r');
  }
  save(p, `oracle-${voices}-three-drums`);
}
for (const voices of [2, 4]) {
  const p = oracle(voices);
  const sink = p.modules.find((m) => m.type === 'output')!;
  p.cables = p.cables.filter((c) => !(c.to.module === sink.id && c.to.port === 'r'));
  for (const [i, name] of ['boom kick', 'snare', 'hihat'].entries()) {
    const t = addModule(p, DEFS.steps, 20, 3000 + i * 400);
    t.name = ['KICK', 'SNARE', 'HAT'][i];
    const beats = [[0, 4, 8, 12], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14]][i];
    t.notes = fixNotes(beats.map((at) => ({ at, note: 60, len: 1, vel: 100 })));
    const d = insertAssembly(p, DEFS, FACTORY.find((a) => a.name === name)!, 300, 3000 + i * 400);
    plugIn(p, t.id, 'trig', d, 'gate');
    for (const o of d.outputs) wire(p, o.module, o.port, sink.id, 'r');
  }
  save(p, `oracle-${voices}-four-tracks`);
}
writeFileSync(new URL('manifest.json', out), JSON.stringify(report, null, 1) + '\n');
