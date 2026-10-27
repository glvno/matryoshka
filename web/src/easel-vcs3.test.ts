// SPDX-License-Identifier: GPL-3.0-only
// Canvas (the Buchla Music Easel) and Briefcase 3 (the EMS VCS3), on the FM-1 and as XLs (issue #303): their cards follow
// the originals' panels, Briefcase 3's pins are named as the VCS3's manual names them (column, then row), the Easel's
// pulser triggers its envelope by itself, and Canvas XL's patch field moves a cord.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { FM1_PRESETS, XL_PRESETS } from './presets';
import type { Patch } from './patch';

const SR = 44118;
/** the left channel, `notes` held from the start */
function play(p: Patch, notes: number[], n = SR): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  for (const k of notes) e.noteOn(k, 1);
  const l = new Float32Array(n), r = new Float32Array(n);
  e.render(l, r);
  return l;
}
const peak = (x: Float32Array, from = 0, to = x.length): number => x.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const card = (p: Patch) => p.assemblies!.find((a) => !p.assemblies!.some((b) => b.children?.includes(a.id)))!;
const row = (p: Patch, label: string, nth = 0) => card(p).params.filter((r) => r.label === label)[nth];
const set = (p: Patch, label: string, v: number, nth = 0): void => {
  const r = row(p, label, nth);
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
};

const COLUMNS = 'ABCDEFGHIJKLMNOP'.split('');

describe('Briefcase 3 (the VCS3)', () => {
  it('on the FM-1: the panel on its card, the control columns I to P on the matrix card, every pin named column then row', () => {
    const p = FM1_PRESETS['Briefcase 3']();
    const labels = card(p).params.map((r) => r.label);
    for (const l of ['frequency', 'sine', 'ramp', 'shape', 'square', 'triangle', 'colour', 'input 1', 'ring mod', 'response', 'attack', 'on', 'decay', 'signal', 'trapezoid', 'mix', 'filter 1', 'level 1', 'filter 2', 'level 2', 'x', 'y'])
      expect(labels, l).toContain(l);
    const matrix = p.assemblies!.find((a) => a.label === 'matrix')!;
    const pins = matrix.params.map((r) => r.label.split(' ')[0]);
    // 8 columns of 15 pins: row 9 (input amplifier 2) needs audio input
    expect(pins).toEqual(COLUMNS.slice(8).flatMap((c) => [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16].map((n) => `${c}${n}`)));
    expect(matrix.params.find((r) => r.label === 'I8 input 1')).toBeDefined();
    // the pins are not on the FM-1's card
    expect(labels.some((l) => /^[I-P]\d/.test(l))).toBe(false);
  });

  it('on the FM-1: the keys reach oscillator 1 through input amplifier 1 and pin I8; pulled out, the pitch stays', () => {
    const p = FM1_PRESETS['Briefcase 3']();
    const pitchOf = (q: Patch, note: number): number => {
      const x = play(q, [note], SR / 4);
      let ups = 0;
      for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) ups++;
      return ups;
    };
    // oscillator 1's sine alone, straight through
    for (const l of ['ramp', 'square', 'triangle']) for (let k = 0; k < 3; k++) if (row(p, l, k)) set(p, l, 0, k);
    set(p, 'ring mod', 0);
    set(p, 'frequency', 16000, 3);
    set(p, 'response', 0);
    const matrix = p.assemblies!.find((a) => a.label === 'matrix')!;
    for (const r of matrix.params) p.modules.find((m) => m.id === r.module)!.params[r.param] = 0;
    const pin = (label: string, v: number): void => {
      const r = matrix.params.find((q) => q.label.startsWith(label + ' '))!;
      p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
    };
    pin('I8', 1);
    const low = pitchOf(p, 48), high = pitchOf(p, 60);
    expect(high / low).toBeCloseTo(2, 1);
    pin('I8', 0);
    expect(pitchOf(p, 60)).toBe(pitchOf(p, 48));
  });

  it('Briefcase 3 XL: the whole matrix, a section per column, 16 pins each in row order', () => {
    const p = XL_PRESETS['Briefcase 3 XL']();
    const rows = card(p).params;
    const pins = rows.filter((r) => /^[A-P]\d+ /.test(r.label));
    expect(pins).toHaveLength(256);
    for (const [ci, c] of COLUMNS.entries()) {
      const col = pins.slice(ci * 16, ci * 16 + 16);
      expect(col.map((r) => r.label.split(' ')[0])).toEqual(Array.from({ length: 16 }, (_, i) => `${c}${i + 1}`));
      expect(col[0].head?.startsWith(`${c} `)).toBe(true);
      expect(col[0].col).toBe(true);
    }
    expect(p.assemblies!.some((a) => a.label === 'matrix')).toBe(false);
    for (const l of ['pan 1', 'pan 2', 'range x', 'range y', 'meter']) expect(rows.map((r) => r.label), l).toContain(l);
    expect(peak(play(p, [48]))).toBeGreaterThan(0.05);
  });

  it('Briefcase 3 XL: a signal pin routes the sound: without B14 and C14 the outputs are silent, B1 brings oscillator 1 back', () => {
    const p = XL_PRESETS['Briefcase 3 XL']();
    const pin = (label: string, v: number): void => set(p, card(p).params.find((r) => r.label.startsWith(label + ' '))!.label, v);
    pin('B14', 0);
    pin('C14', 0);
    expect(peak(play(p, [48]))).toBeLessThan(1e-6);
    pin('B1', 1);
    expect(peak(play(p, [48]))).toBeGreaterThan(0.01);
  });
});

describe('Canvas (the Music Easel)', () => {
  it('Canvas XL exposes four independent random voltages and accepts a patch cord from each', () => {
    const p = XL_PRESETS['Canvas XL']();
    const a = card(p);
    const sources = [1, 2, 3, 4].map((n) => a.outputs.find((r) => r.label === `random ${n}`));
    expect(sources.every(Boolean)).toBe(true);
    const output = p.modules.find((m) => m.type === 'output')!;
    const renders = sources.map((source) => {
      const q = structuredClone(p);
      q.cables = q.cables.filter((c) => c.to.module !== output.id);
      q.cables.push({ from: { module: source!.module, port: source!.port }, to: { module: output.id, port: 'l' } });
      return play(q, [48], SR / 2);
    });
    for (let i = 0; i < renders.length; i++) {
      expect(peak(renders[i])).toBeGreaterThan(0.001);
      for (let j = 0; j < i; j++) expect(renders[i]).not.toEqual(renders[j]);
    }
    const input = a.inputs.find((r) => r.label === 'pitch in')!;
    expect(input).toBeDefined();
    set(p, 'pitch in', 8); // PATCH: a cord into the assembly's corresponding input
    set(p, 'pitch proc', 1);
    const before = play(p, [48], SR / 2);
    p.cables.push({ from: { module: sources[1]!.module, port: sources[1]!.port }, to: { module: input.module, port: input.port } });
    expect(play(p, [48], SR / 2)).not.toEqual(before);
  });

  it('on the FM-1: the card is the panel, section by section', () => {
    const heads = card(FM1_PRESETS.Canvas()).params.filter((r) => r.head).map((r) => r.head);
    expect(heads).toEqual(['sequencer', 'envelope', 'pulser', 'random', 'mod osc', 'complex osc', 'lopass gate', 'output', 'keyboard']);
  });

  it('the pulser on self triggers the envelope by itself: bursts at its period while a key is held', () => {
    const p = FM1_PRESETS.Canvas();
    set(p, 'trigger', 2, 1); // the envelope's: pulser
    set(p, 'trigger', 2, 2); // the pulser's: self
    set(p, 'period', 0.1);
    set(p, 'decay', 0.01);
    const x = play(p, [48], SR);
    let bursts = 0, on = false;
    const win = 441;
    for (let i = 0; i + win <= x.length; i += win) {
      const loud = peak(x, i, i + win) > 0.15;
      if (loud && !on) bursts++;
      on = loud;
    }
    expect(bursts).toBeGreaterThanOrEqual(8);
    expect(bursts).toBeLessThanOrEqual(11);
  });

  it('Canvas XL: the switches have the panel\'s names, and the patch field moves a cord', () => {
    const p = XL_PRESETS['Canvas XL']();
    expect(row(p, 'mode', 0).names).toEqual(['sustained', 'transient', 'off']);
    expect(row(p, 'range').names).toEqual(['- high', '+ hi', 'low']);
    const jacks = card(p).params.filter((r) => r.label.endsWith(' in'));
    expect(jacks.map((r) => r.label)).toEqual(['pitch in', 'freq in', 'index in', 'timbre in', 'level 1 in', 'level 2 in', 'period in', 'porta in', 'inverter in']);
    expect(jacks[0].names).toEqual(['main', 'pressure', 'sequencer', 'envelope', 'pulser', 'random 1', 'mod cv', 'patch']);
    const before = play(p, [48], SR / 2);
    set(p, 'pitch in', 4); // the envelope into the pitch
    set(p, 'pitch proc', 1);
    const after = play(p, [48], SR / 2);
    expect(after.some((v, i) => Math.abs(v - before[i]) > 1e-3)).toBe(true);
  });
});
