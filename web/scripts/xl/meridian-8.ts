// SPDX-License-Identifier: GPL-3.0-only
// Meridian 8 XL: the Landscape NOON, with what the FM-1 version (scripts/gen-assemblies.ts, Meridian 8) left out to fit.
// Sources: Landscape's NOON manual (landscape.fm/manuals: channels, CV inputs, CV mute, link, mod, outputs) and the
// instrument's page (landscape.fm/noon: each channel's character words).
// - The first design the FM-1 could not hold (commit 18ccc6e: it read 85 %): DOT and BACID through Multimodes whose cutoff
//   the power moves per sample (the FM-1 version: Ladders, once per block), CYMPATH a three-voice cluster (one oscillator's
//   three detuned copies) instead of one narrow square.
// - Each channel's MOD button ("change the behavior and sound of each circuit": two modes), as a crossfade from the
//   circuit to its second mode: DOT the filter pinged (band pass), DUAL its sine through a pinged filter, SYS phased, PLAST
//   static (crushed), CYMPATH the cluster uncrushed (scream), CYRINX folded (rough), LARYNX folded (squeal), BACID the
//   filter's band pass (acidic). Which second mode each circuit has is our reading of the channel's words.
// - The eight CV mute buttons: each channel takes the odd / even CV by its own switch (on, as the manual's "engaged").
// - LINK as voltage sharing both ways: a link carries both neighbours' power into both (the FM-1 version: one way, n into
//   n + 1).
// Kept as on the FM-1 version: the eight channels on the white keys from F3, their two tone sliders and volume, odd to
// the left and even to the right, the main volume, the 16-step pattern. Not here: the touch plates, the external audio
// input, the individual outputs.
import { addModule } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { level, players, wire } from '../factory-build';
import type { Xl } from './xl';
import { around, define, type Def } from './def';

/** the white keys from F3 (gen-assemblies.ts PLATE_KEYS[1], the drum kits' rows) */
const ROW_KEYS = [53, 55, 57, 59, 60, 62, 64, 65];

interface Ch {
  name: string;
  env: number;
  vca: number;
  members: number[];
  /** the inputs the channel's power reaches (besides its VCA's cv) */
  power: [number, string][];
  s1: [number, string, string];
  s2: [number, string, string];
  /** the MOD crossfade */
  mod: number;
}

function build(e: Def): void {
  const map = e.add('drummap', 0, 0, Object.fromEntries(ROW_KEYS.map((n, r) => [`n${r + 1}`, n])));
  e.module(map).names = ['DOT', 'DUAL', 'SYS', 'PLAST', 'CYMPATH', 'CYRINX', 'LARYNX', 'BACID'];
  const odd = e.add('macro', 0, 1, { value: 0 });
  const even = e.add('macro', 0, 2, { value: 0 });
  const L = e.add('shape', 9, 0, { drive: 1.5, mode: 0, level: 0 });
  const R = e.add('shape', 9, 1, { drive: 1.5, mode: 0, level: 0 });
  e.pin(L, 'p1', 'level');
  e.pin(R, 'p1', 'level');
  const main = e.add('macro', 9, 2, { value: 0.8 });
  const scope = e.add('scope', 10, 0, { time: 16 });
  /** a channel: its power (an ADSR on its gate) into its VCA and `power`; `a` / `b` are the MOD crossfade's two inputs,
   * `post` a module between the crossfade and the VCA */
  const channel = (i: number, name: string, adsr: Record<string, number>, f: (col: number, env: number) => Omit<Ch, 'name' | 'env' | 'vca' | 'mod'> & { a: [number, string]; b: [number, string]; post?: number }): Ch => {
    const col = 1 + i;
    const env = e.add('adsr', col, 0, adsr);
    const vca = e.add('vca', col, 4, { gain: 0.8 });
    const mod = e.add('xfade', col, 3.5, { mix: 0 });
    e.wire(map, `g${i + 1}`, env, 'gate');
    const c = f(col, env);
    e.wire(c.a[0], c.a[1], mod, 'a');
    e.wire(c.b[0], c.b[1], mod, 'b');
    if (c.post) {
      e.wire(mod, 'out', c.post, 'in');
      e.wire(c.post, 'out', vca, 'in');
    } else e.wire(mod, 'out', vca, 'in');
    for (const [m, port] of [[vca, 'cv'] as [number, string], ...c.power]) e.wire(env, 'env', m, port);
    e.wire(vca, 'out', i % 2 === 0 ? L : R, 'in');
    return { name, env, vca, mod, s1: c.s1, s2: c.s2, power: [[vca, 'cv'], ...c.power], members: [env, ...c.members, mod, ...(c.post ? [c.post] : []), vca] };
  };
  const chs: Ch[] = [
    // DOT: knock / tap / flutter / filter / saw: a saw through a Multimode the power sweeps; MOD: the filter pinged
    channel(0, 'dot', { a: 0.002, d: 0.08, s: 0.6, r: 0.15 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 2, coarse: -17, level: 0.8 });
      const lp = e.add('filter', col, 2, { cutoff: 600, res: 0.4, cvamt: 3 });
      e.wire(osc, 'out', lp, 'in');
      return { members: [osc, lp], power: [[osc, 'pitch'], [lp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [lp, 'cutoff', 'filter'], a: [lp, 'lp12'], b: [lp, 'bp'] };
    }),
    // DUAL: clicks / pings / sine / filter: a sine pinged up by the power; MOD: through a resonant band pass the power sweeps
    channel(1, 'dual', { a: 0.001, d: 0.25, s: 0.3, r: 0.3 }, (col, env) => {
      const osc = e.add('osc', col, 1, { wave: 0, coarse: -24, level: 1 });
      const ping = e.add('scale', col, 2, { gain: 1.5, offset: 0 });
      const bp = e.add('filter', col, 2.5, { cutoff: 400, res: 0.9, cvamt: 3 });
      e.wire(env, 'env', ping, 'in');
      e.wire(ping, 'out', osc, 'pitch');
      e.wire(osc, 'out', bp, 'in');
      return { members: [osc, ping, bp], power: [[bp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [ping, 'gain', 'ping'], a: [osc, 'out'], b: [bp, 'bp'] };
    }),
    // SYS: hollow / laser / wood / phased: a resonator struck at the gate, the power sweeps its pitch; MOD: phased
    channel(2, 'sys', { a: 0.001, d: 0.1, s: 0.5, r: 0.2 }, (col) => {
      const strike = e.add('pulse', col, 1, { time: 0.002 });
      const hit = e.add('scale', col, 1.5, { gain: 0.03, offset: 0 });
      const res = e.add('modal', col, 2, { coarse: -10, decay: 0.4, struct: 0.3, bright: 0.6, damp: 0.4 });
      const ph = e.add('phaser', col, 2.5, { rate: 3, depth: 0.9, center: 900, fb: 0.7, mix: 1 });
      e.wire(map, 'g3', strike, 'trig');
      e.wire(strike, 'out', hit, 'in');
      e.wire(hit, 'out', res, 'in');
      e.wire(res, 'out', ph, 'in');
      return { members: [strike, hit, res, ph], power: [[res, 'pitch']], s1: [res, 'coarse', 'pitch'], s2: [res, 'struct', 'hollow'], a: [res, 'out'], b: [ph, 'out'] };
    }),
    // PLAST: stretch / wrap / static / wet / squish: noise through a comb the power stretches; MOD: static (crushed)
    channel(3, 'plast', { a: 0.003, d: 0.12, s: 0.4, r: 0.25 }, (col) => {
      const nz = e.add('noise', col, 1, { level: 0.6, color: 0.3 });
      const cb = e.add('comb', col, 2, { coarse: 5, fb: 0.85, damp: 0.3, mix: 1 });
      const st = e.add('crush', col, 2.5, { bits: 5, rate: 6 });
      e.wire(nz, 'out', cb, 'in');
      e.wire(cb, 'out', st, 'in');
      return { members: [nz, cb, st], power: [[cb, 'pitch']], s1: [cb, 'coarse', 'tone'], s2: [cb, 'fb', 'squish'], a: [cb, 'out'], b: [st, 'out'] };
    }),
    // CYMPATH: metal / strike / harmonic / scream / crumble: a three-voice cluster of narrow squares crumbled by a
    // Bitcrusher; MOD: the cluster uncrushed
    channel(4, 'cympath', { a: 0.001, d: 0.15, s: 0.2, r: 0.35 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 3, coarse: 26, pw: 0.35, level: 0.6, unison: 3, detune: 100, blend: 0.5 });
      const crush = e.add('crush', col, 2, { bits: 16, rate: 3 });
      e.wire(osc, 'out', crush, 'in');
      return { members: [osc, crush], power: [[osc, 'pitch']], s1: [osc, 'coarse', 'pitch'], s2: [crush, 'rate', 'crumble'], a: [crush, 'out'], b: [osc, 'out'] };
    }),
    // CYRINX: avian / atonal / rough / angular: a chirping triangle; MOD: folded
    channel(5, 'cyrinx', { a: 0.005, d: 0.06, s: 0.5, r: 0.12 }, (col, env) => {
      const osc = e.add('osc', col, 1, { wave: 1, coarse: 12, level: 0.9 });
      const chirp = e.add('scale', col, 2, { gain: 2, offset: 0 });
      const fold = e.add('shape', col, 2.5, { drive: 4, mode: 2, level: 0.7 });
      e.wire(env, 'env', chirp, 'in');
      e.wire(chirp, 'out', osc, 'pitch');
      e.wire(osc, 'out', fold, 'in');
      return { members: [osc, chirp, fold], power: [], s1: [osc, 'coarse', 'pitch'], s2: [chirp, 'gain', 'chirp'], a: [osc, 'out'], b: [fold, 'out'] };
    }),
    // LARYNX: vocal / round / squeal / bubble: a saw through a formant filter the power moves; MOD: folded
    channel(6, 'larynx', { a: 0.01, d: 0.2, s: 0.6, r: 0.3 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 2, coarse: -12, level: 0.8 });
      const vow = e.add('vowel', col, 2, { vowel: 0.5, res: 0.7, level: 1 });
      const sq = e.add('shape', col, 2.5, { drive: 6, mode: 2, level: 0.6 });
      e.wire(osc, 'out', vow, 'in');
      e.wire(vow, 'out', sq, 'in');
      return { members: [osc, vow, sq], power: [[osc, 'pitch'], [vow, 'vowel']], s1: [osc, 'coarse', 'pitch'], s2: [vow, 'vowel', 'vowel'], a: [vow, 'out'], b: [sq, 'out'] };
    }),
    // BACID: bass / slam / acidic: a saw into a resonant 24 dB Multimode the power sweeps, then the drive (the FM-1 version's
    // Ladder drive 2: the slam); MOD: its band pass
    channel(7, 'bacid', { a: 0.001, d: 0.18, s: 0.4, r: 0.2 }, (col) => {
      const osc = e.add('osc', col, 1, { wave: 2, coarse: -29, level: 0.9 });
      const lp = e.add('filter', col, 2, { cutoff: 150, res: 0.75, cvamt: 4 });
      const slam = e.add('shape', col, 3, { drive: 2, mode: 0, level: 0.8 });
      e.wire(osc, 'out', lp, 'in');
      return { members: [osc, lp], power: [[lp, 'cv']], s1: [osc, 'coarse', 'pitch'], s2: [lp, 'res', 'acid'], a: [lp, 'lp24'], b: [lp, 'bp'], post: slam };
    }),
  ];
  // the links: both neighbours' power, shared into both
  const links = chs.map((c, i) => {
    const to = chs[(i + 1) % chs.length];
    const link = e.add('scale', 1 + i, 5, { gain: 0, offset: 0 });
    e.wire(c.env, 'env', link, 'in');
    e.wire(to.env, 'env', link, 'in');
    for (const [m, port] of [...c.power, ...to.power]) e.wire(link, 'out', m, port);
    return link;
  });
  // the CV inputs, each channel through its CV mute
  const mutes = chs.map((c, i) => {
    const m = e.add('scale', 1 + i, 5.5, { gain: 1, offset: 0 });
    e.wire(i % 2 === 0 ? odd : even, 'out', m, 'in');
    for (const [mm, port] of c.power) e.wire(m, 'out', mm, port);
    return m;
  });
  e.wire(main, 'out', L, 'p1');
  e.wire(main, 'out', R, 'p1');
  e.wire(L, 'out', scope, 'a');
  e.wire(R, 'out', scope, 'b');
  chs.forEach((c, i) => e.nest(`${i + 1} ${c.name}`, 1 + i, 0, c.members, { inputs: [['gate', c.env, 'gate'], ['power', c.vca, 'cv']], outputs: [['out', c.vca, 'out']] }));
  e.input('keys', map, 'keys');
  e.output('l', L, 'out');
  e.output('r', R, 'out');
  chs.forEach((c, i) => {
    e.param(c.s1[2], c.s1[0], c.s1[1], { head: `${i + 1} ${c.name}`, ...(i % 4 === 0 ? { col: true } : {}) });
    e.param(c.s2[2], c.s2[0], c.s2[1]);
    e.param('vol', c.vca, 'gain');
    e.param('mod', c.mod, 'mix');
  });
  links.forEach((l, i) => e.param(`${i + 1}-${((i + 1) % 8) + 1}`, l, 'gain', i === 0 ? { col: true, head: 'link' } : {}));
  e.param('odd cv', odd, 'value', { col: true, head: 'cv' });
  e.param('even cv', even, 'value');
  mutes.forEach((m, i) => e.param(`${i + 1} cv`, m, 'gain', i === 0 ? { head: 'cv mute' } : {}));
  e.param('main', main, 'value', { head: 'out' });
  e.param('out', scope, 'view', { col: true });
}

export const xl: Xl = {
  base: 'Meridian 8',
  build: (fm1) => {
    const x = around('Meridian 8', define('Meridian 8', build));
    const p = x.p;
    // the pattern on a Steps track, as the FM-1 version (gen-presets.ts `sequenced`): Main's keys into PATTERN, PATTERN into
    // the channels; its notes and the tempo are the FM-1 version's
    const into = x.a.inputs.find((r) => r.label === 'keys')!;
    p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
    const st = addModule(p, DEFS.steps, 20, 300);
    st.name = 'PATTERN';
    wire(p, x.main.id, 'keys', st.id, 'keys');
    for (const t of [into, ...(into.also ?? [])]) wire(p, st.id, 'keys', t.module, t.port);
    const from = fm1.modules.find((m) => m.type === 'steps' && m.name === 'PATTERN')!;
    st.notes = structuredClone(from.notes);
    for (const k of ['length', 'rate', 'swing', 'gate']) if (k in from.params) st.params[k] = from.params[k];
    x.main.params.tempo = fm1.modules.find((m) => m.type === 'fm1')!.params.tempo;
    level(p, { drums: true });
    p.octave = -1;
    p.notes = NOTES;
    return players(p, true);
  },
};

const NOTES =
  'The Landscape NOON (its manual): DOT and BACID through filters the power sweeps per sample and CYMPATH a three-voice cluster (the first design, too big for the FM-1), each channel’s MOD button (a second mode of its circuit, our reading of the channel’s words), the eight CV mute buttons, and LINK sharing power both ways between neighbours.';
