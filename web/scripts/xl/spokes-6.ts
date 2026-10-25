// SPDX-License-Identifier: GPL-3.0-only
// Spokes 6 XL: the Elektron Model:Cycles closer to whole, after its user manual's track parameters (PITCH, DECAY, COLOR,
// SHAPE, SWEEP, CONTOUR; VOLUME + DIST, PAN, DELAY and REVERB sends, an LFO per track; the delay's TIME and FEEDBACK, the
// reverb's SIZE and TONE). The FM-1 version (gen-assemblies.ts, Spokes 6) has no reverb, no pan, no per-track
// distortion or LFO, and its SNARE and METAL do without phase modulation (a noise colour and two squares) to fit.
//
// Per track here: the FM-1 version's rows, then `dist` (a waveshaper's drive; its level is the track's `volume`, so
// VOLUME + DIST is one stage as on the original), `pan`, the delay and reverb sends, and the LFO (`lfo speed`,
// `lfo depth`, `lfo wave`) into the voice's pitch: the original's LFO picks any destination, this one has one. The
// machines: 1 KICK and 4 PERC as on the FM-1; 2 SNARE: a body phase-modulated by a sine at an inharmonic interval (color
// = the index) and a noise burst (shape = its level, contour = its decay); 3 METAL: a square phase-modulated by a sine
// (color = the sine's interval, contour = the index) through a high pass (shape) the envelope opens (sweep); 5 TONE as
// on the FM-1; 6 CHORD: a stacked saw (color = the voicing) and the chord's middle note (shape) with a detuned copy of
// the root (spread). The tracks' swing and chance are not here (a Steps track has one swing for all its rows, and no
// chance).
import { addModule, type Patch } from '../../src/patch';
import { DEFS } from '../../src/modules';
import { Engine } from '../../src/engine';
import { fixNotes, type StepNote } from '../../src/track';
import { players, plugIn, wire } from '../factory-build';
import { around, define, KIT_NOTES } from './def';
import type { Xl } from './xl';

const NOTES = 'After the Elektron Model:Cycles manual: six FM machines (kick, snare, metal, perc, tone, chord), each with ' +
  'pitch, decay, color, shape, sweep and contour, volume + dist, pan, delay and reverb sends and an LFO into its pitch; a ' +
  'delay (time, feedback) and a reverb (size, tone). Elektron does not publish the engines: what color, shape, sweep and ' +
  'contour do per machine follows the manual and reviews, not the original\'s code. No per-track swing or chance.';

type Row = [number, string];
type Rows = Record<'pitch' | 'decay' | 'color' | 'shape' | 'sweep' | 'contour', Row>;

const built = define('Spokes 6 XL', (b) => {
  const map = b.add('drummap', 0, 0, Object.fromEntries(KIT_NOTES.map((n, r) => [`n${r + 1}`, n])));
  b.module(map).names = ['KICK', 'SNARE', 'METAL', 'PERC', 'ROW 5', 'ROW 6', 'ROW 7', 'ROW 8'];
  // the stereo mix: A takes tracks 1..4, B tracks 5 and 6, A's sum and the returns
  const lA = b.add('mixer', 8, 0, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const rA = b.add('mixer', 8, 0.5, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const lB = b.add('mixer', 8, 1, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const rB = b.add('mixer', 8, 1.5, { l1: 1, l2: 1, l3: 1, l4: 1 });
  const dsA = b.add('mixer', 8, 2, { l1: 0, l2: 0.15, l3: 0.1, l4: 0.3 });
  const dsB = b.add('mixer', 8, 2.5, { l1: 0.25, l2: 0.2, l3: 1, l4: 0 });
  const rsA = b.add('mixer', 8, 3, { l1: 0, l2: 0.25, l3: 0.2, l4: 0.2 });
  const rsB = b.add('mixer', 8, 3.5, { l1: 0.2, l2: 0.5, l3: 1, l4: 0 });
  const dly = b.add('delay', 9, 2, { time: 375, fb: 0.4, mix: 1, pingpong: 1 });
  const rev = b.add('reverb', 9, 3, { size: 0.6, damp: 0.5, mix: 1 });
  const scope = b.add('scope', 10, 0, { time: 16 });
  b.wire(lA, 'out', lB, 'in3');
  b.wire(rA, 'out', rB, 'in3');
  b.wire(dsA, 'out', dsB, 'in3');
  b.wire(rsA, 'out', rsB, 'in3');
  b.wire(dsB, 'out', dly, 'in');
  b.wire(rsB, 'out', rev, 'in');
  b.wire(dly, 'out', lB, 'in4');
  b.wire(dly, 'r', rB, 'in4');
  b.wire(rev, 'out', lB, 'in4');
  b.wire(rev, 'out', rB, 'in4');
  b.wire(lB, 'out', scope, 'a');
  b.wire(rB, 'out', scope, 'b');

  type T = { name: string; members: number[]; out: number[]; pitched: number[]; gate: [number, string][]; pitchIn?: number; rows: Rows; dist: number; pan: number; lfo: number; ds: Row; rs: Row };
  const tracks: T[] = [];
  const track = (i: number, name: string, volume: number, make: (col: number) => Omit<T, 'name' | 'dist' | 'pan' | 'lfo' | 'ds' | 'rs'>): void => {
    const col = 1 + i;
    const t = make(col);
    const dist = b.add('shape', col, 5, { drive: 1, mode: 0, level: volume });
    const pan = b.add('pan', col, 5.5, { pan: [0, -0.15, 0.3, -0.35, 0.1, 0.25][i] });
    const lfo = b.add('lfo', col, 6, { wave: 0, rate: 2, depth: 0 });
    for (const o of t.out) b.wire(o, 'out', dist, 'in');
    b.wire(dist, 'out', pan, 'in');
    const n = i < 4 ? i + 1 : i - 3;
    const [l, r, ds, rs] = i < 4 ? [lA, rA, dsA, rsA] : [lB, rB, dsB, rsB];
    b.wire(pan, 'l', l, `in${n}`);
    b.wire(pan, 'r', r, `in${n}`);
    b.wire(dist, 'out', ds, `in${n}`);
    b.wire(dist, 'out', rs, `in${n}`);
    for (const o of t.pitched) b.wire(lfo, 'out', o, 'pitch');
    tracks.push({ name, ...t, dist, pan, lfo, members: [...t.members, dist, pan, lfo], ds: [ds, `l${n}`], rs: [rs, `l${n}`] });
  };
  /** a drum track's amp envelope: a Drum map row's gate, its velocity the height (pin p1 on l1) */
  const ampEnv = (col: number, r: number, decay: number): number => {
    const env = b.add('env', col, 0, { l1: 0, r1: 0.001, l2: 0, r2: decay, l3: 0, r3: 0.001, l4: 0, r4: 0.001, shot: 1 });
    b.pin(env, 'p1', 'l1');
    b.wire(map, `g${r}`, env, 'gate');
    b.wire(map, `v${r}`, env, 'p1');
    return env;
  };
  track(0, 'kick', 0.9, (col) => {
    const env = ampEnv(col, 1, 0.45);
    const penv = b.add('adsr', col, 1, { a: 0.001, d: 0.05, s: 0, r: 0.08 });
    const sweep = b.add('scale', col, 2, { gain: 2.5, offset: -2.25 });
    const car = b.add('osc', col, 3, { wave: 0, pm: 0.4, level: 1 });
    const op = b.add('osc', col, 3.5, { wave: 0, coarse: 12, level: 1 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(map, 'g1', penv, 'gate');
    b.wire(penv, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { members: [env, penv, sweep, car, op, vca], out: [vca], pitched: [car, op], gate: [[env, 'gate'], [penv, 'gate']], rows: { pitch: [sweep, 'offset'], decay: [env, 'r2'], color: [car, 'pm'], shape: [op, 'coarse'], sweep: [sweep, 'gain'], contour: [penv, 'd'] } };
  });
  track(1, 'snare', 0.85, (col) => {
    const env = ampEnv(col, 2, 0.16);
    const sweep = b.add('scale', col, 1, { gain: 0.5, offset: -0.75 });
    const car = b.add('osc', col, 2, { wave: 0, pm: 1.2, level: 0.8 });
    const op = b.add('osc', col, 2.5, { wave: 0, coarse: 6, fine: 30, level: 1 });
    const vca = b.add('vca', col, 3, { gain: 1 });
    const nz = b.add('noise', col, 3.5, { level: 0.8, color: 0.3 });
    const nenv = b.add('adsr', col, 4, { a: 0.001, d: 0.12, s: 0, r: 0.15 });
    const nvca = b.add('vca', col, 4.5, { gain: 1 });
    b.wire(env, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    b.wire(map, 'g2', nenv, 'gate');
    b.wire(nz, 'out', nvca, 'in');
    b.wire(nenv, 'env', nvca, 'cv');
    return { members: [env, sweep, car, op, vca, nz, nenv, nvca], out: [vca, nvca], pitched: [car, op], gate: [[env, 'gate'], [nenv, 'gate']], rows: { pitch: [sweep, 'offset'], decay: [env, 'r2'], color: [car, 'pm'], shape: [nz, 'level'], sweep: [sweep, 'gain'], contour: [nenv, 'd'] } };
  });
  track(2, 'metal', 0.9, (col) => {
    const env = ampEnv(col, 3, 0.12);
    const pitch = b.add('scale', col, 1, { gain: 0, offset: 2.5 });
    const car = b.add('osc', col, 2, { wave: 3, pw: 0.5, pm: 2, level: 0.8 });
    const op = b.add('osc', col, 2.5, { wave: 0, coarse: 7, fine: 35, level: 1 });
    const open = b.add('scale', col, 3, { gain: 1, offset: 0 });
    const hp = b.add('filter', col, 3.5, { cutoff: 2500, res: 0.1, cvamt: 2 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(pitch, 'out', car, 'pitch');
    b.wire(pitch, 'out', op, 'pitch');
    b.wire(op, 'out', car, 'pm');
    b.wire(env, 'env', open, 'in');
    b.wire(open, 'out', hp, 'cv');
    b.wire(car, 'out', hp, 'in');
    b.wire(hp, 'hp', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { members: [env, pitch, car, op, open, hp, vca], out: [vca], pitched: [car, op], gate: [[env, 'gate']], rows: { pitch: [pitch, 'offset'], decay: [env, 'r2'], color: [op, 'coarse'], shape: [hp, 'cutoff'], sweep: [open, 'gain'], contour: [car, 'pm'] } };
  });
  track(3, 'perc', 0.6, (col) => {
    const env = ampEnv(col, 4, 0.25);
    const sweep = b.add('scale', col, 1, { gain: 0.3, offset: -0.5 });
    const ienv = b.add('adsr', col, 1.5, { a: 0.001, d: 0.08, s: 0, r: 0.1 });
    const car = b.add('osc', col, 2, { wave: 0, pm: 2.5, level: 1 });
    const op = b.add('osc', col, 2.5, { wave: 0, coarse: 19, level: 1 });
    const ivca = b.add('vca', col, 3, { gain: 1 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(map, 'g4', ienv, 'gate');
    b.wire(env, 'env', sweep, 'in');
    b.wire(sweep, 'out', car, 'pitch');
    b.wire(sweep, 'out', op, 'pitch');
    b.wire(op, 'out', ivca, 'in');
    b.wire(ienv, 'env', ivca, 'cv');
    b.wire(ivca, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { members: [env, sweep, ienv, car, op, ivca, vca], out: [vca], pitched: [car, op], gate: [[env, 'gate'], [ienv, 'gate']], rows: { pitch: [sweep, 'offset'], decay: [env, 'r2'], color: [car, 'pm'], shape: [op, 'coarse'], sweep: [sweep, 'gain'], contour: [ienv, 'd'] } };
  });
  track(4, 'tone', 0.35, (col) => {
    const pitch = b.add('scale', col, 0, { gain: 1, offset: 0 });
    const env = b.add('adsr', col, 1, { a: 0.002, d: 0.5, s: 0, r: 0.3 });
    const ienv = b.add('adsr', col, 1.5, { a: 0.001, d: 0.3, s: 0, r: 0.3 });
    const op = b.add('osc', col, 2, { wave: 0, coarse: 12, level: 1 });
    const nz = b.add('noise', col, 2.5, { level: 0, color: 0 });
    const ivca = b.add('vca', col, 3, { gain: 1 });
    const car = b.add('osc', col, 3.5, { wave: 0, pm: 1.5, level: 1 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    b.wire(pitch, 'out', op, 'pitch');
    b.wire(pitch, 'out', car, 'pitch');
    b.wire(op, 'out', ivca, 'in');
    b.wire(nz, 'out', ivca, 'in');
    b.wire(ienv, 'env', ivca, 'cv');
    b.wire(ivca, 'out', car, 'pm');
    b.wire(car, 'out', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { pitchIn: pitch, members: [pitch, env, ienv, op, nz, ivca, car, vca], out: [vca], pitched: [car, op], gate: [[env, 'gate'], [ienv, 'gate']], rows: { pitch: [pitch, 'offset'], decay: [env, 'd'], color: [op, 'coarse'], shape: [car, 'pm'], sweep: [nz, 'level'], contour: [ienv, 'd'] } };
  });
  let spread = 0;
  track(5, 'chord', 0.7, (col) => {
    const pitch = b.add('scale', col, 0, { gain: 1, offset: 0 });
    const env = b.add('adsr', col, 1, { a: 0.005, d: 0.8, s: 0, r: 0.4 });
    const o1 = b.add('osc', col, 2, { wave: 2, stack: 2, level: 0.45 });
    const o2 = b.add('osc', col, 2.3, { wave: 2, coarse: 3, fine: 4, level: 0.3 });
    const o3 = b.add('osc', col, 2.6, { wave: 2, fine: -12, level: 0.25 });
    const lp = b.add('filter', col, 3, { cutoff: 2000, res: 0.2 });
    const vca = b.add('vca', col, 4, { gain: 1 });
    spread = o3;
    for (const o of [o1, o2, o3]) {
      b.wire(pitch, 'out', o, 'pitch');
      b.wire(o, 'out', lp, 'in');
    }
    b.wire(lp, 'lp24', vca, 'in');
    b.wire(env, 'env', vca, 'cv');
    return { pitchIn: pitch, members: [pitch, env, o1, o2, o3, lp, vca], out: [vca], pitched: [o1, o2, o3], gate: [[env, 'gate']], rows: { pitch: [pitch, 'offset'], decay: [env, 'd'], color: [o1, 'stack'], shape: [o2, 'coarse'], sweep: [lp, 'cutoff'], contour: [env, 'a'] } };
  });
  tracks.forEach((t, i) => b.nest(`${i + 1} ${t.name}`, 1 + i, 0, t.members, {
    inputs: i < 4 ? [['gate', ...t.gate[0]], ['accent', t.gate[0][0], 'p1']] : [],
    outputs: [['l', t.pan, 'l'], ['r', t.pan, 'r']],
  }));
  b.input('keys', map, 'keys');
  b.input('tone pitch', tracks[4].pitchIn!, 'in');
  b.input('tone gate', ...tracks[4].gate[0], ...tracks[4].gate.slice(1));
  b.input('chord pitch', tracks[5].pitchIn!, 'in');
  b.input('chord gate', ...tracks[5].gate[0]);
  b.output('l', lB, 'out');
  b.output('r', rB, 'out');
  tracks.forEach((t, i) => {
    const r = t.rows;
    b.param('pitch', ...r.pitch, { head: `${i + 1} ${t.name}`, ...(i % 2 === 0 ? { col: true } : {}) });
    b.param('decay', ...r.decay);
    b.param('color', ...r.color);
    b.param('shape', ...r.shape);
    b.param('sweep', ...r.sweep);
    b.param('contour', ...r.contour);
    if (t.name === 'chord') b.param('spread', spread, 'fine');
    b.param('volume', t.dist, 'level', { group: true });
    b.param('dist', t.dist, 'drive');
    b.param('pan', t.pan, 'pan');
    b.param('delay', ...t.ds);
    b.param('reverb', ...t.rs, { group: true });
    b.param('lfo speed', t.lfo, 'rate');
    b.param('lfo depth', t.lfo, 'depth');
    b.param('lfo wave', t.lfo, 'wave');
  });
  b.param('time', dly, 'time', { col: true, head: 'delay' });
  b.param('feedback', dly, 'fb');
  b.param('size', rev, 'size', { head: 'reverb' });
  b.param('tone', rev, 'damp');
  b.param('out', scope, 'view', { col: true });
});

const SR = 44118;
/** the RMS and peak of a patch over `secs` with the transport running (its patterns playing) */
function playing(p: Patch, secs = 4): { rms: number; peak: number } {
  const e = new Engine(SR);
  e.load(p);
  e.transport(true);
  const l = new Float32Array(SR * secs), r = new Float32Array(l.length);
  e.render(l, r);
  let sum = 0, peak = 0;
  for (let i = 0; i < l.length; i++) {
    sum += l[i] * l[i] + r[i] * r[i];
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  }
  return { rms: Math.sqrt(sum / (2 * l.length)), peak };
}

export const xl: Xl = {
  base: 'Spokes 6',
  build: (fm1: Patch): Patch => {
    const x = around('Spokes 6', built);
    const p = x.p;
    p.notes = NOTES;
    x.main.params.tempo = fm1.modules.find((m) => m.type === 'fm1')!.params.tempo;
    // the FM-1 version's three tracks and their patterns, cabled the same way: Main's keys into TONE
    p.cables = p.cables.filter((c) => !(c.from.module === x.main.id && c.from.port === 'keys'));
    for (const [i, name] of ['DRUMS', 'TONE', 'CHORD'].entries()) {
      const src = fm1.modules.find((m) => m.type === 'steps' && m.name === name)!;
      const st = addModule(p, DEFS.steps, 20, 300 * (i + 1));
      st.name = name;
      st.notes = fixNotes(structuredClone(src.notes ?? []) as StepNote[]);
      if (name === 'DRUMS') plugIn(p, st.id, 'keys', x.a, 'keys');
      else {
        plugIn(p, st.id, 'pitch', x.a, `${name.toLowerCase()} pitch`);
        plugIn(p, st.id, 'trig', x.a, `${name.toLowerCase()} gate`);
      }
      if (name === 'TONE') wire(p, x.main.id, 'keys', st.id, 'keys');
    }
    p.octave = -1;
    const q = players(p, true);
    // the level: the XL's patterns as loud as the FM-1 version's (RMS), playing, kept under a peak of 0.95
    const out = q.modules.find((m) => m.type === 'output')!;
    out.params.level = 0.1;
    const got = playing(q);
    const lv = Math.min((0.1 * playing(fm1).rms) / Math.max(got.rms, 1e-9), (0.1 * 0.95) / Math.max(got.peak, 1e-9));
    out.params.level = Math.round(Math.max(0.01, Math.min(1, lv)) * 100) / 100;
    return q;
  },
};
