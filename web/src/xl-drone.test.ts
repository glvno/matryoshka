// SPDX-License-Identifier: GPL-3.0-only
// The drone XLs' panel details (scripts/xl): 8 Lire XL's TUNE is continuous, as the Lyra-8's knob, and Meridian 8 XL's
// gate inputs take any voltage, as the NOON's, so a steady voltage there is a drone with no key held.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, type Patch } from './patch';
import { XL_PRESETS } from './presets';

const SR = 44118;

/** the top assembly's port or row with this label */
function find<K extends 'inputs' | 'params'>(p: Patch, kind: K, label: string): NonNullable<Patch['assemblies']>[number][K][number] {
  for (const a of p.assemblies ?? []) {
    const r = (a[kind] as { label?: string }[]).find((x) => x.label === label);
    if (r) return r as NonNullable<Patch['assemblies']>[number][K][number];
  }
  throw new Error(`${p.name}: no ${kind} ${label}`);
}

/** the left channel of `blocks` blocks, with these notes held from the first */
function render(p: Patch, blocks: number, notes: number[] = []): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  for (const n of notes) e.noteOn(n, 0.8);
  const out = new Float32Array(blocks * 128);
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let k = 0; k < blocks; k++) {
    e.render(L, R);
    out.set(L, k * 128);
  }
  return out;
}

const rms = (x: Float32Array, from = 0): number => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - from));
};

/** upward zero crossings after `from` */
const crossings = (x: Float32Array, from: number): number => {
  let n = 0;
  for (let i = from + 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n;
};

describe('drone XLs', () => {
  it("8 Lire XL: TUNE is continuous, an octave up doubles the voice's pitch", () => {
    const at = (octaves: number): number => {
      const p = XL_PRESETS['8 Lire XL']();
      const row = find(p, 'params', 'tune 1');
      expect(row.param).toBe('value');
      p.modules.find((m) => m.id === row.module)!.params.value = octaves;
      return crossings(render(p, 700, [53]), 20000);
    };
    const base = at(0);
    expect(base).toBeGreaterThan(20);
    expect(at(1) / base).toBeGreaterThan(1.8);
    expect(at(1) / base).toBeLessThan(2.2);
    // finer than a semitone: the row is an Offset (octaves) whose step is under a twelfth of an octave
    const step = DEFS.const.params.find((d) => d.name === 'value')!.step!;
    expect(step).toBeLessThan(1 / 12);
  });

  it('Meridian 8 XL: a steady voltage into a gate input is a drone, with no key held', () => {
    const quiet = XL_PRESETS['Meridian 8 XL']();
    const p = XL_PRESETS['Meridian 8 XL']();
    for (const x of [quiet, p]) x.modules.filter((m) => m.type === 'steps').forEach((m) => (m.notes = []));
    const gate = find(p, 'inputs', 'gate 1');
    const v = addModule(p, DEFS.const, 0, 0);
    v.params.value = 1;
    expect(connect(p, DEFS, { module: v.id, port: 'out' }, { module: gate.module, port: gate.port })).toBe(true);
    const off = rms(render(quiet, 400), 20000);
    const on = rms(render(p, 400), 20000);
    expect(on).toBeGreaterThan(0.01);
    expect(on).toBeGreaterThan(20 * off);
  });
});
