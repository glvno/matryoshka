import { recoveredLines } from '../src/test-buffer-budget';
// SPDX-License-Identifier: GPL-3.0-only
// Offline #824 accounting. Emits fixtures and model counts; no device connection or factory writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FM1_PRESETS, make } from '../src/presets';
import { ARENA, BUF_BYTES, deviceBudget, encodePatch, lineBudget, linePlace, poolUse } from '../src/patchbin';
import { deviceView } from '../src/poly';
import { signalBuffers } from '../src/signal-buffers';
import { withParts } from '../src/test-poly';
import { addModule, connect, type Patch } from '../src/patch';
import { DEFS } from '../src/modules';
import { aotPatch } from './gen-aot';

const out = new URL('../../build/buffer-budget/', import.meta.url);
mkdirSync(out, { recursive: true });
const fixtures: [string, Patch][] = Object.entries(FM1_PRESETS).map(([name, build]) => [name, build()]);
function chain(feedback: boolean, late: boolean, parts: number): Patch {
  const p = make('buffer boundary', (add, wire) => {
    const main = add('fm1', 0, 0), osc = add('osc', 0, 0, { level: .2 });
    const env = add('adsr', 0, 0), amp = add('vca', 0, 0), out = add('output', 0, 0);
    const lfo = add('lfo', 0, 0, { depth: .02 });
    wire(main, 'pitch', osc, 'pitch'); wire(main, 'gate', env, 'gate');
    wire(osc, 'out', amp, 'in'); wire(env, 'env', amp, 'cv');
    let previous = amp;
    for (let i = 0; i < 8; i++) {
      const scale = add('scale', 0, 0, { gain: .9 });
      wire(previous, 'out', scale, 'in'); wire(lfo, 'out', scale, 'p1'); previous = scale;
    }
    if (feedback) wire(previous, 'out', osc, 'pm');
    if (late) wire(lfo, 'out', main, 'morph');
    wire(previous, 'out', out, 'l'); wire(previous, 'out', out, 'r');
  });
  return parts > 1 ? withParts(p, parts) : p;
}
for (const parts of [1, 2, 3, 4]) for (const feedback of [false, true]) for (const late of [false, true])
  fixtures.push([`boundary-${parts}-${+feedback}-${+late}`, chain(feedback, late, parts)]);
// The fingerprint still matches, but an extra cable forces compiled execution back to the interpreter.
{
  const { patch, asm } = aotPatch('Oracle V');
  const lfo = addModule(patch, DEFS.lfo, 0, 0);
  const target = patch.modules.find((m) => asm.modules.includes(m.id) && ['scale', 'vca'].includes(m.type))!;
  connect(patch, DEFS, { module: lfo.id, port: 'out' }, { module: target.id, port: 'in' });
  fixtures.push(['compiled-fallback', patch]);
}
// Inputs read before or after the ordinary render order must retain their values.
for (const input of ['assign', 'unison']) {
  const p = chain(false, false, 3), alloc = p.modules.find((m) => m.type === 'alloc')!;
  const lfo = p.modules.find((m) => m.type === 'lfo')!;
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: alloc.id, port: input });
  fixtures.push([`part-${input}`, p]);
}
{
  const p = chain(false, false, 3), alloc = p.modules.find((m) => m.type === 'alloc')!;
  const main = p.modules.find((m) => m.type === 'fm1')!, lfo = p.modules.find((m) => m.type === 'lfo')!;
  const arp = addModule(p, DEFS.arp, 0, 0);
  p.cables = p.cables.filter((c) => !(c.to.module === alloc.id && c.to.port === 'keys'));
  for (const [from, port, to, input] of [[main.id, 'keys', arp.id, 'keys'], [arp.id, 'keys', alloc.id, 'keys'], [lfo.id, 'out', arp.id, 'rate']] as const)
    connect(p, DEFS, { module: from, port }, { module: to, port: input });
  fixtures.push(['arpeggiator-late', p]);
}
// A deliberately long, cheap signal chain leaves little simultaneous work but many logical values.
// Four effect lines exercise the actual placement limit, independently of the CPU estimate.
fixtures.push(['recovered-lines', recoveredLines()]);
const report = fixtures.map(([name, p], i) => {
  const { patch, groups } = deviceView(p, true);
  const count = signalBuffers(patch, groups), separate = signalBuffers(patch, groups, true);
  const pool = poolUse(patch, groups), memory = lineBudget(p), budget = deviceBudget(p), shared = deviceBudget(p, 1);
  if (count.values !== pool.buffers || separate.physical !== pool.buffers) throw new Error(`${name}: logical count differs`);
  if (shared.lines.pool.physicalBuffers !== count.physical || shared.lines.used !== memory.used - (count.values - count.physical) * BUF_BYTES || shared.cpu.use !== budget.cpu.use)
    throw new Error(`${name}: runtime editor budget differs from allocation proof`);
  const bin = encodePatch(p, true), file = `${String(i).padStart(2, '0')}.m1p`;
  writeFileSync(new URL(file, out), bin);
  return { name, file, bytes: bin.length, sha256: createHash('sha256').update(bin).digest('hex'), ...count,
    recoverableBytes: (count.values - count.physical) * BUF_BYTES,
    lineArenaBytes: (() => {
      const sizes = memory.modules.flatMap((m) => Array(m.copies).fill(m.bytes / m.copies));
      const placement = linePlace(sizes, ARENA - (memory.used - memory.lines));
      return placement ? sizes.reduce((n, bytes, i) => n + (placement[i] ? bytes : 0), 0) : null;
    })(),
    arenaBeforeLines: ARENA - (memory.used - memory.lines),
    sharedArenaBeforeLines: ARENA - (shared.lines.used - shared.lines.lines),
    sharedLinesFit: linePlace(memory.modules.flatMap((m) => Array(m.copies).fill(m.bytes / m.copies)),
      ARENA - (memory.used - memory.lines) + (count.values - count.physical) * BUF_BYTES) !== null,
    memoryBytes: memory.used, cpuEstimate: budget.cpu.use, over: budget.over.map((x) => x.key) };
});
writeFileSync(new URL('expected.json', out), JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${report.length} allocation fixtures to ${out.pathname}`);
