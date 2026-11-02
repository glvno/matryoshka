// SPDX-License-Identifier: GPL-3.0-only
// What P-locks (#524) cost the FM-1's engine: a Steps track at 1/32 into an instrument (mono, and three voices), every
// step locking rows, against the same patch without locks, counted on the rv32im model (tools/cpu, after build.sh).
// Run from web/: npx vite-node scripts/lock-bench.ts
// @ts-ignore: plain JavaScript modules
import { pool } from '../../tools/cpu/pool.mjs';
import { DEFS } from '../src/modules';
import { encodePatch } from '../src/patchbin';
import { addModule, connect, newPatch, type Patch } from '../src/patch';
import { makeAssembly } from '../src/assembly';
import type { StepLock } from '../src/track';

const ROOT = new URL('../../', import.meta.url).pathname;
const POOL = pool({ plain: `${ROOT}build/cpu/plain.elf` });
const BLOCKS = 200;
const RUN = (4 << 16) | 1, RENDER = 3 << 16;

function kit(poly: boolean, rows: number): Patch {
  const p = newPatch(DEFS, 'lock-bench');
  const wire = (a: number, ap: string, b: number, bp: string): void => { if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${ap} -> ${bp}`); };
  const add = (type: string, params: Record<string, number> = {}): number => { const m = addModule(p, DEFS[type], 0, 0); Object.assign(m.params, params); return m.id; };
  for (const m of [...p.modules]) if (m.type !== 'fm1') p.modules.splice(p.modules.indexOf(m), 1);
  p.cables = [];
  p.modules.find((m) => m.type === 'fm1')!.params.tempo = 180;
  const st = add('steps', { len: 16, rate: 5, gate: 0.5 });
  const o = add('osc', { wave: 1 }), f = add('filter'), e = add('adsr'), v = add('vca'), out = add('output');
  let al = -1;
  if (poly) {
    al = add('alloc', { voices: 3 });
    wire(st, 'keys', al, 'keys'); wire(al, 'pitch', o, 'pitch'); wire(al, 'gate', e, 'gate');
  } else {
    wire(st, 'pitch', o, 'pitch'); wire(st, 'trig', e, 'gate');
  }
  wire(o, 'out', f, 'in'); wire(f, 'lp24', v, 'in'); wire(e, 'env', v, 'cv'); wire(v, 'out', out, 'l');
  if (poly) makeAssembly(p, [al, o, f, e, v], 'voices').poly = {};
  const s = p.modules.find((m) => m.id === st)!;
  s.notes = Array.from({ length: 16 }, (_, at) => ({ at, len: 1, note: 48 + (at % 7) * 2, vel: 100 }));
  const targets: [number, string, number][] = [[f, 'cutoff', 300], [f, 'res', 0.1], [e, 'd', 0.05], [o, 'level', 0.5]];
  const locks: StepLock[] = [];
  for (let at = 0; at < 16; at++) for (const [module, param, base] of targets.slice(0, rows)) locks.push({ at, module, param, value: base * (1 + (at % 4)) });
  if (rows) s.locks = locks;
  return p;
}

const run = async (p: Patch): Promise<number[]> => {
  const r = await POOL.run('plain', encodePatch(p, true), [RUN, ...Array(BLOCKS).fill(RENDER)]);
  if (r.exit) throw new Error(`refused (${r.exit})`);
  return r.blocks.map((b: { total: number }) => b.total);
};
const stats = (xs: number[]): { mean: number; max: number } => ({ mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), max: Math.max(...xs) });
for (const poly of [false, true])
  for (const rows of [1, 4]) {
    const [a, b] = await Promise.all([run(kit(poly, 0)), run(kit(poly, rows))]);
    const sa = stats(a.slice(5)), sb = stats(b.slice(5));
    console.log(`${poly ? 'poly 3' : 'mono  '} ${rows} row(s) locked on every step: mean ${sa.mean} -> ${sb.mean} cycles a block (+${sb.mean - sa.mean}), max ${sa.max} -> ${sb.max} (+${sb.max - sa.max})`);
  }
await POOL.close();
process.exit(0);
