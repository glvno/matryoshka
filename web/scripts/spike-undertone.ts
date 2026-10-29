// SPDX-License-Identifier: GPL-3.0-only
// Spike (draft): Undertone, after the Moog Subharmonicon. Its FM-1 budget, that it plays on the transport, its subharmonics'
// pitches and QUANTIZE. Run from web/:  npx vite-node scripts/spike-undertone.ts
import { deviceBudget } from '../src/patchbin';
import { around, plugIn } from './factory-build';
import { Engine } from '../src/engine';
import { validatePatch } from '../src/patch';
import { DEFS } from '../src/modules';
const SR = 44118;
const render = (p: any, secs: number, run: boolean, notes: number[] = []) => {
  const e = new Engine(SR); e.load(p); e.transport(run); for (const n of notes) e.noteOn(n);
  const l = new Float32Array(Math.round(SR * secs)), r = new Float32Array(l.length); e.render(l, r); return l;
};
for (const name of ['Undertone', 'Undertone XL']) {
  const x = around(name, name);
  plugIn(x.p, x.main.id, 'run', x.a, 'play');
  x.p.modules.find((m: any) => m.type === 'output')!.params.level = 0.5;
  const p = validatePatch(x.p, DEFS);
  const l = render(p, 4, true);
  let peak = 0, hits = 0, prev = 0; const win = Math.round(SR * 0.01);
  for (let i = 0; i < l.length; i += win) { let m = 0; for (let j = i; j < i + win && j < l.length; j++) m = Math.max(m, Math.abs(l[j])); if (m > 0.05 && prev <= 0.05) hits++; prev = m; peak = Math.max(peak, m); }
  console.log(`${name}: running 4 s, peak ${peak.toFixed(3)}, onsets ${hits}`);
  const silent = render(p, 2, false);
  console.log(`  stopped 2 s, peak ${Math.max(...Array.from(silent).map(Math.abs)).toFixed(4)}`);
  // pitch of SUB 1 alone at /3 (and /11 for the XL), EGs HELD, filter open
  for (const n of name.endsWith('XL') ? [3, 11, 16] : [3, 7]) {
    const q = structuredClone(p);
    const set = (label: string, v: number, k = 0) => { const r = q.assemblies![0].params.filter((r: any) => r.label === label)[k]; q.modules.find((m: any) => m.id === r.module)!.params[r.param] = v; };
    set('eg', 3); set('vco 1 level', 0); set('sub 1 level', 1); set('vco 2 level', 0); set('sub 1 level', 0, 1); set('sub 2 level', 0, 1); set('sub 2 level', 0, 0); set('cutoff', 16000); set('resonance', 0); set('wave', 3); set('vcf eg amt', 0);
    set('sub 1 freq', name.endsWith('XL') ? (n <= 8 ? 1 - (n - 1) / 14 : 0.5 - (n - 9) / 14 - 0.01) : 9 - n);
    set('seq 1 step 1', 0); set('seq 1 step 2', 0); set('seq 1 step 3', 0); set('seq 1 step 4', 0);
    const s = render(q, 2, false).subarray(SR);
    let up = 0, first = -1, last = -1; for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) { if (first < 0) first = i; last = i; up++; }
    const hz = (up - 1) / ((last - first) / SR);
    console.log(`  SUB 1 ÷${n}: ${hz.toFixed(2)} Hz, expected ${(261.6255653 / n).toFixed(2)}`);
  }
}
// QUANTIZE: VCO 1 alone, VCO FREQ a little past E (4/12 + 0.3/12 of an octave: 0.0271 of the four-octave knob)
{
  const x = around('Undertone', 'Undertone');
  const p = validatePatch(x.p, DEFS);
  for (const [qpos, label] of [[1, 'OFF'], [2, '12-ET'], [3, '8-ET']] as const) for (const semis of [4.3, 6.4]) {
    const q = structuredClone(p);
    const set = (lab: string, v: number, k = 0) => { const r = q.assemblies![0].params.filter((r: any) => r.label === lab)[k]; q.modules.find((m: any) => m.id === r.module)!.params[r.param] = v; };
    set('eg', 3); set('vco 1 level', 1); set('sub 1 level', 0); set('sub 2 level', 0); set('vco 2 level', 0); set('sub 1 level', 0, 1); set('sub 2 level', 0, 1);
    set('cutoff', 16000); set('vcf eg amt', 0); set('wave', 3); set('quantize', qpos); set('vco 1 freq', semis / 48);
    for (let k = 1; k <= 4; k++) set(`seq 1 step ${k}`, 0);
    const s = render(q, 2, false).subarray(SR);
    let up = 0, first = -1, last = -1; for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) { if (first < 0) first = i; last = i; up++; }
    const hz = (up - 1) / ((last - first) / SR);
    console.log(`QUANTIZE ${label}, knob at +${semis} semitones: ${(12 * Math.log2(hz / 261.6255653)).toFixed(2)} semitones`);
  }
}
for (const name of ['Undertone', 'Undertone XL']) {
  const x = around(name, name);
  for (const [from, to] of [['run', 'play'], ['arp', 'reset']]) if (x.a.inputs.some((i) => i.label === to)) plugIn(x.p, x.main.id, from, x.a, to);
  const b = deviceBudget(validatePatch(x.p, DEFS));
  const g = (k: string) => b.items.find((i) => i.key === k)!;
  console.log(`${name}: modules ${g('modules').used}/${g('modules').max}, bytes ${g('bytes').used}/${g('bytes').max}, CPU ${(b.cpu.use * 100).toFixed(1)} % (estimate)`);
}
