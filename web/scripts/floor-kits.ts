// SPDX-License-Identifier: GPL-3.0-only
// The floor sweep (#969, tools/floor_test.sh): every module type with an input it can ring from (`in` / `exc`, or a gate
// for the String and the envelopes), struck once (a 1 ms pulse at 0.5 into that input, the gate held 0.5 s), then left
// silent for 10 s; at its defaults and at a long-ring setting (feedback, resonance, decay near their tops, damping off).
// Writes build/floor/NAME.{m1p,ev,f32} (the reference output of web/src/engine.ts); host_test with HOST_TEST_FLOOR=1 then
// says whether the C engine's last second holds a floor the reference does not. Run from web/: npx vite-node scripts/floor-kits.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine';
import { encodePatch } from '../src/patchbin';
import { DEFS, DEVICE_SR } from '../src/modules';
import { addModule, connect, newPatch } from '../src/patch';

const OUT = new URL('../../build/floor/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const SR = DEVICE_SR, HOLD = 128 * 172, END = HOLD + SR * 10;
/** types with no ring to judge: the patch's frame, note and pattern sources, and the holds that keep a value on purpose */
const SKIP = ['fm1', 'output', 'part', 'alloc', 'scope', 'steps', 'drummap', 'harm', 'arp', 'seq', 'macro', 'sh', 'quant', 'shreg'];
/** the long-ring setting of a parameter, from its range */
const LONG: Record<string, (lo: number, hi: number) => number> = {
  fb: (lo, hi) => hi * 0.98, feedback: (lo, hi) => hi * 0.98, regen: (lo, hi) => hi * 0.98, res: (lo, hi) => hi * 0.97,
  decay: (lo, hi) => hi, size: (lo, hi) => hi * 0.95, damp: (lo) => lo,
};
const names: string[] = [];
for (const [type, def] of Object.entries(DEFS)) {
  if (SKIP.includes(type) || !def.outputs.length) continue;
  const inp = def.inputs.find((i) => i.name === 'in' || i.name === 'exc');
  const gated = def.inputs.some((i) => i.name === 'gate');
  if (!inp && !gated) continue;
  for (const variant of ['def', 'long']) {
    if (variant === 'long' && !def.params.some((q) => LONG[q.name])) continue;
    const name = `${type}-${variant}`;
    const p = newPatch(DEFS, name);
    const main = p.modules.find((m) => m.type === 'fm1')!, out = p.modules.find((m) => m.type === 'output')!;
    const m = addModule(p, def, 300, 0);
    if (variant === 'long') for (const q of def.params) if (LONG[q.name]) m.params[q.name] = LONG[q.name](q.min, q.max);
    if (inp) {
      const pl = addModule(p, DEFS.pulse, 0, 0), hit = addModule(p, DEFS.scale, 0, 0);
      pl.params.time = 0.001;
      Object.assign(hit.params, { gain: 0.5, offset: 0 });
      connect(p, DEFS, { module: main.id, port: 'gate' }, { module: pl.id, port: 'trig' });
      connect(p, DEFS, { module: pl.id, port: 'out' }, { module: hit.id, port: 'in' });
      connect(p, DEFS, { module: hit.id, port: 'out' }, { module: m.id, port: inp.name });
    }
    if (gated) connect(p, DEFS, { module: main.id, port: 'gate' }, { module: m.id, port: 'gate' });
    if (def.inputs.some((i) => i.name === 'pitch')) connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: m.id, port: 'pitch' });
    for (const port of ['l', 'r']) connect(p, DEFS, { module: m.id, port: def.outputs[0].name }, { module: out.id, port });
    const e = new Engine(SR);
    e.load(p);
    const st = new Float32Array(END * 2);
    const seg = (from: number, to: number): void => {
      const a = new Float32Array(to - from), b = new Float32Array(to - from);
      e.render(a, b);
      for (let i = 0; i < to - from; i++) { st[2 * (from + i)] = a[i]; st[2 * (from + i) + 1] = b[i]; }
    };
    e.noteOn(60, 1, 1);
    seg(0, HOLD);
    e.noteOff(60, 1);
    seg(HOLD, END);
    writeFileSync(new URL(`${name}.f32`, OUT), new Uint8Array(st.buffer));
    writeFileSync(new URL(`${name}.m1p`, OUT), encodePatch(p, true));
    writeFileSync(new URL(`${name}.ev`, OUT), `0 on 60 127 1\n${HOLD} off 60 1\n${END} end\n`);
    names.push(name);
  }
}
console.log(`${names.length} floor kits in build/floor/`);
