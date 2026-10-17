// SPDX-License-Identifier: GPL-3.0-only
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { DEFS } from './modules';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';

/**
 * The first-run patch: a mellow pad on the factory Oracle V (slow, soft attack, a darker filter that opens gently,
 * a long release, two detuned saws, four voices), through a reverb. The mod wheel brings in the vibrato. It fits the
 * FM-1 (the reverb costs about a fifth of the CPU: a fifth voice or a chorus on top would not fit).
 */
export function starterPatch(): Patch {
  const p = emptyPatch('Mellow Pad');
  const main = addModule(p, DEFS.fm1, 20, 20);
  const def = FACTORY.find((d) => d.name === 'Oracle V');
  const out = addModule(p, DEFS.output, 1320, 20);
  out.params.level = 0.4;
  if (!def) return p;
  const pro = insertAssembly(p, DEFS, def, 20, 60);
  // the card's rows by label; a label that repeats (a d s r) by its section: the rows after the envelope's display
  const row = (label: string, after?: string): { module: number; param: string } => {
    const from = after ? pro.params.findIndex((r) => r.label === after) : 0;
    const r = pro.params.slice(from).find((x) => x.label === label);
    if (!r) throw new Error(`Oracle V has no row ${label}`);
    return r;
  };
  const set = (label: string, v: number, after?: string): void => {
    const r = row(label, after);
    p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
  };
  set('voices', 4);
  set('glide', 0.03);
  set('fine', 9); // osc B: the detune that makes the pair breathe
  set('A level', 0.5);
  set('B level', 0.45);
  set('cutoff', 900);
  set('res', 0.12);
  set('env amt', 1.6);
  for (const [k, v] of [['a', 1.2], ['d', 2.5], ['s', 0.45], ['r', 2.8]] as const) set(k, v, 'filter env');
  for (const [k, v] of [['a', 0.9], ['d', 1.5], ['s', 0.85], ['r', 3]] as const) set(k, v, 'amp env');
  set('lfo rate', 4.8);
  set('vibrato', 0.12);
  const rev = addModule(p, DEFS.reverb, 1020, 20);
  Object.assign(rev.params, { size: 0.82, damp: 0.55, mix: 0.38, pre: 20, mod: 0.4 });
  const keys = pro.inputs.find((r) => r.label === 'keys')!;
  const wheel = pro.inputs.find((r) => r.label === 'wheel')!;
  const o = pro.outputs.find((r) => r.label === 'out')!;
  for (const [from, to] of [
    [{ module: main.id, port: 'keys' }, { module: keys.module, port: keys.port }],
    [{ module: main.id, port: 'mod' }, { module: wheel.module, port: wheel.port }],
    [{ module: o.module, port: o.port }, { module: rev.id, port: 'in' }],
    [{ module: rev.id, port: 'out' }, { module: out.id, port: 'l' }],
    [{ module: rev.id, port: 'out' }, { module: out.id, port: 'r' }],
  ] as const)
    connect(p, DEFS, from, to);
  return p;
}
