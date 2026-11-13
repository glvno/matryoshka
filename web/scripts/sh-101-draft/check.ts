// SPDX-License-Identifier: GPL-3.0-only
// Behaviour checks of the SH-101 draft (issue #869): plays sh-101.json in the editor's engine and measures each switch.
// Run from web/:  npx vite-node scripts/sh-101-draft/check.ts
import { readFileSync } from 'node:fs';
import { Engine } from '../../src/engine';
import { DEFS, DEVICE_SR as SR } from '../../src/modules';
import { validatePatch, type Patch } from '../../src/patch';

const base: Patch = validatePatch(JSON.parse(readFileSync(new URL('./sh-101.json', import.meta.url), 'utf8')), DEFS);
const asm = base.assemblies![0];
const row = (label: string) => asm.params.find((r) => r.label === label)!;
/** a copy with card rows set (by label; a Selector row by its position name) */
function variant(set: Record<string, number | string>): Patch {
  const q = structuredClone(base);
  for (const [label, v] of Object.entries(set)) {
    const r = row(label);
    const value = typeof v === 'string' ? r.names!.indexOf(v) + 1 : v;
    if (typeof v === 'string' && value === 0) throw new Error(`${label}: no position ${v}`);
    for (const t of [r, ...(r.also ?? [])]) q.modules.find((m) => m.id === t.module)!.params[t.param] = value;
  }
  return q;
}
type Ev = [number, number, boolean]; // seconds, note, on
function render(p: Patch, events: Ev[], seconds: number): Float32Array {
  const e = new Engine(SR);
  e.load(structuredClone(p));
  const out = new Float32Array(Math.ceil(seconds * SR / 128) * 128), l = new Float32Array(128), r = new Float32Array(128);
  const ev = [...events].sort((a, b) => a[0] - b[0]);
  for (let o = 0, k = 0; o < out.length; o += 128) {
    while (k < ev.length && ev[k][0] * SR <= o) { const [, n, on] = ev[k++]; if (on) e.noteOn(n, 0.8); else e.noteOff(n); }
    e.render(l, r);
    out.set(l, o);
  }
  return out;
}
/** fundamental in Hz from rising zero crossings over [t0, t1) s, and the fraction of samples above zero */
function pitchDuty(x: Float32Array, t0: number, t1: number): { hz: number; duty: number } {
  const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR);
  let first = -1, last = -1, n = 0, pos = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i] > 0) pos++;
    if (x[i - 1] <= 0 && x[i] > 0) { if (first < 0) first = i; else n++; last = i; }
  }
  return { hz: n ? (n * SR) / (last - first) : 0, duty: pos / (b - a) };
}
const rms = (x: Float32Array, t0: number, t1: number): number => {
  let s = 0; const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
const st = (hz: number, ref: number) => (12 * Math.log2(hz / ref)).toFixed(2);
const C4 = 261.63;
// a dry, open voice: only the source under test, the filter open, VCA on the gate
const dry = { freq: 16000, res: 0, 'vcf env': 0, kybd: 0, vca: 'GATE', pulse: 0, saw: 0, 'sub osc': 0, noise: 0 };
const hold: Ev[] = [[0, 60, true], [1, 60, false]];

console.log('-- RANGE (saw, C4 key): semitones from C4');
for (const r of ["16'", "8'", "4'", "2'"]) console.log(r.padEnd(4), st(pitchDuty(render(variant({ ...dry, saw: 1, range: r }), hold, 1), 0.2, 0.9).hz, C4));

console.log('-- SUB OSC: semitones from C4, duty');
for (const m of ['1 OCT DOWN', '2 OCT DOWN', '2 OCT PULSE']) {
  const { hz, duty } = pitchDuty(render(variant({ ...dry, 'sub osc': 1, 'sub mode': m }), hold, 1), 0.2, 0.9);
  console.log(m.padEnd(12), st(hz, C4), duty.toFixed(3));
}

console.log('-- PWM (pulse, MAN): duty by pw');
for (const pw of [0, 0.5, 1]) console.log('pw', pw, pitchDuty(render(variant({ ...dry, pulse: 1, 'pwm source': 'MAN', pw }), hold, 1), 0.2, 0.9).duty.toFixed(3));
{
  const x = render(variant({ ...dry, pulse: 1, 'pwm source': 'LFO', pw: 1, rate: 1 }), [[0, 60, true], [2, 60, false]], 2);
  const d = [0.1, 0.35, 0.6, 0.85].map((t) => pitchDuty(x, t, t + 0.1).duty.toFixed(2));
  console.log('pwm LFO 1 Hz duty over a cycle', d.join(' '));
}

console.log('-- PORTAMENTO 0.3 s: pitch 60 ms after the second key (C4 -> C5), semitones from C5');
const legato: Ev[] = [[0, 60, true], [0.5, 72, true], [0.55, 60, false], [1.2, 72, false]];
const detached: Ev[] = [[0, 60, true], [0.45, 60, false], [0.5, 72, true], [1.2, 72, false]];
for (const mode of ['OFF', 'ON', 'AUTO']) for (const [name, ev] of [['legato', legato], ['detached', detached]] as const) {
  const x = render(variant({ ...dry, saw: 1, vca: 'GATE', portamento: 0.3, 'porta mode': mode }), ev as Ev[], 1.2);
  console.log(mode.padEnd(5), name.padEnd(9), st(pitchDuty(x, 0.54, 0.58).hz, 2 * C4));
}

console.log('-- ENV TRIGGER (VCA ENV, A 1 ms, D 0.15 s, S 0): level 20 ms after a legato second key / before it');
for (const mode of ['GATE+TRIG', 'GATE', 'LFO']) {
  const x = render(variant({ ...dry, saw: 1, vca: 'ENV', attack: 0.001, decay: 0.15 / 2.4, sustain: 0, 'env trigger': mode, rate: 4 }), legato, 1.2);
  console.log(mode.padEnd(10), 'before', rms(x, 0.45, 0.5).toFixed(3), 'after', rms(x, 0.5, 0.52).toFixed(3), ' 0.80..1.2 s', [0.8, 0.9, 1.0, 1.1].map((t) => rms(x, t, t + 0.02).toFixed(3)).join(' '));
}

console.log('-- VCA GATE vs ENV with S 0: level at 0.8 s');
for (const v of ['ENV', 'GATE']) console.log(v.padEnd(5), rms(render(variant({ ...dry, saw: 1, sustain: 0, decay: 0.05, vca: v }), hold, 1), 0.8, 0.9).toFixed(3));

console.log('-- LFO waveforms into VCO MOD 1 oct at 2 Hz: pitch spread (semitones) over 1.5 s');
for (const w of ['TRIANGLE', 'SQUARE', 'RANDOM', 'NOISE']) {
  const x = render(variant({ ...dry, saw: 1, 'vco mod': 1, waveform: w, rate: 2 }), [[0, 60, true], [2, 60, false]], 2);
  const p = Array.from({ length: 30 }, (_, i) => pitchDuty(x, 0.2 + i * 0.05, 0.25 + i * 0.05).hz).filter((h) => h > 0).map((h) => 12 * Math.log2(h / C4));
  console.log(w.padEnd(9), 'min', Math.min(...p).toFixed(1), 'max', Math.max(...p).toFixed(1), 'distinct', new Set(p.map((v) => v.toFixed(0))).size);
}

console.log('-- VCF: rms with the filter closed / with kybd at a high key / env');
console.log('freq 100, saw', rms(render(variant({ ...dry, saw: 1, freq: 100 }), hold, 1), 0.2, 0.9).toFixed(3), ' freq 16000', rms(render(variant({ ...dry, saw: 1 }), hold, 1), 0.2, 0.9).toFixed(3));
console.log('init sound rms', rms(render(base, hold, 1), 0.05, 0.9).toFixed(3));
