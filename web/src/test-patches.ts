// SPDX-License-Identifier: GPL-3.0-only
// Small patches the tests and the golden / CPU kits are built on (the factory patches change; these do not).
import { make } from './presets';
import type { Patch } from './patch';

/** saw → 24 dB low pass → VCA, an ADSR, one note from Main; modules[1] is the oscillator */
export const subtractiveSaw = (): Patch =>
  make('Subtractive saw', (add, wire) => {
    const kb = add('fm1', 20, 40);
    const osc = add('osc', 260, 40, { wave: 2, level: 0.8 });
    const flt = add('filter', 500, 40, { cutoff: 1800, res: 0.3 });
    const env = add('adsr', 500, 260, { a: 0.01, d: 0.3, s: 0.7, r: 0.4 });
    const vca = add('vca', 740, 40);
    const out = add('output', 980, 40, { level: 0.6 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', flt, 'in');
    wire(flt, 'lp24', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
    wire(vca, 'out', out, 'r');
  });

/** an acid line: saw into a resonant filter swept by a decay envelope, an amp envelope, a delay; K1 / K2 = cutoff / resonance */
export const acid = (): Patch =>
  make('Acid', (add, wire) => {
    const kb = add('fm1', 20, 40, { k1: 0.5, k2: 0.7 });
    const osc = add('osc', 260, 40, { wave: 2, level: 0.8 });
    const flt = add('filter', 500, 40, { cutoff: 20, res: 0, cvamt: 2.5 }, { map: { p1: ['cutoff'], p2: ['res'] } });
    const fenv = add('adsr', 500, 260, { a: 0.001, d: 0.25, s: 0, r: 0.05 });
    const aenv = add('adsr', 740, 260, { a: 0.002, d: 1, s: 0.6, r: 0.08 });
    const vca = add('vca', 740, 40);
    const dly = add('delay', 980, 40, { time: 180, fb: 0.35, mix: 0.2 });
    const out = add('output', 1220, 40, { level: 0.6 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', fenv, 'gate');
    wire(kb, 'gate', aenv, 'gate');
    wire(osc, 'out', flt, 'in');
    wire(fenv, 'env', flt, 'cv');
    wire(flt, 'lp24', vca, 'in');
    wire(aenv, 'env', vca, 'cv');
    wire(vca, 'out', dly, 'in');
    wire(dly, 'out', out, 'l');
    wire(dly, 'out', out, 'r');
    wire(kb, 'k1', flt, 'p1');
    wire(kb, 'k2', flt, 'p2');
  });

/** a modulator oscillator into the phase of a carrier (index 3), an ADSR on the level */
export const twoOpFM = (): Patch =>
  make('Two-operator FM', (add, wire) => {
    const kb = add('fm1', 20, 40);
    const mod = add('osc', 260, 40, { wave: 0, coarse: 12, level: 1 });
    const car = add('osc', 500, 40, { wave: 0, pm: 3, level: 0.8 });
    const env = add('adsr', 500, 260, { a: 0.005, d: 0.4, s: 0.5, r: 0.3 });
    const vca = add('vca', 740, 40);
    const out = add('output', 980, 40, { level: 0.6 });
    wire(kb, 'pitch', mod, 'pitch');
    wire(kb, 'pitch', car, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(mod, 'out', car, 'pm');
    wire(car, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
    wire(vca, 'out', out, 'r');
  });

/** a wobble: an LFO into the filter's cutoff jack, an ADSR into the VCA's */
export const wobble = (): Patch =>
  make('Wobble', (add, wire) => {
    const kb = add('fm1', 20, 40);
    const osc = add('osc', 260, 40, { wave: 2, level: 0.8 });
    const lfo = add('lfo', 260, 260, { wave: 0, rate: 3, depth: 1 });
    const flt = add('filter', 500, 40, { cutoff: 600, res: 0.5, cvamt: 2 });
    const env = add('adsr', 500, 260, { a: 0.005, d: 0.2, s: 0.8, r: 0.1 });
    const vca = add('vca', 740, 40);
    const out = add('output', 980, 40, { level: 0.6 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', flt, 'in');
    wire(lfo, 'out', flt, 'cv');
    wire(flt, 'lp24', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
    wire(vca, 'out', out, 'r');
  });
