// SPDX-License-Identifier: GPL-3.0-only
// Oracle V XL: the Prophet-5's full modulation, which the FM-1 version (scripts/gen-assemblies.ts, Oracle V) cut to fit.
// Source: Sequential's Prophet-5 User's Guide 1.3 (Oscillators, LFO, Wheel-Mod, Poly Mod).
// - Poly Mod, per voice: the filter envelope and oscillator B, each by its own amount, into oscillator A's frequency, its
//   pulse width and the filter cutoff, all at audio rate. Oscillator A is two band-limited saws a pulse width apart in
//   phase (their difference is the pulse), so its width moves per sample; its saw and pulse sound together, as on the
//   original. The filter is the Multimode's 24 dB low pass, whose cutoff follows its cv per sample (the Ladder's moves once
//   per 128-sample block).
// - Wheel-Mod: the LFO and a noise source mixed (source mix), through the mod wheel plus the LFO's initial amount, into
//   frequency A, frequency B, pulse width A, pulse width B and the filter, each by its own amount. Frequency A and B move per
//   sample (the FM-1 version's vibrato went into the fine tune once per block).
// - Oscillator B's keyboard switch and lo freq (4 octaves further down: an LFO per voice for Poly Mod).
// The five voices, the card's first pages and the K1..K4 rows stay as on the FM-1 version; the new rows are on pages after.
import { players, level } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';

// the FM-1 version's local module ids (src/assemblies/oracle-v.json)
const LFO = 1, WHEEL = 2, VIB = 3, NOISE = 4, GLIDE = 6, OSC_B = 7, OSC_A = 8, POLY_ENV = 9, SYNC = 10, FENV = 11, FILTER = 12;
/** the pm index that makes the pm input a phase offset in cycles (2 pi, on the parameter's 0.01 steps) */
const CYCLES = 6.28;

export const xl: Xl = {
  base: 'Oracle V',
  build: () => {
    const def = edit('Oracle V', (e) => {
      // ---- oscillator A: two saws, the second a pulse width ahead in phase; saw - saw2 is the pulse
      Object.assign(e.m(OSC_A).params, { wave: 2, level: 1, pm: CYCLES });
      e.unwire(OSC_B, 'out', OSC_A, 'pm');
      e.unwire(OSC_A, 'out', FILTER, 'in');
      e.unwire(VIB, 'out', OSC_A, 'p1');
      e.unwire(VIB, 'out', OSC_B, 'p1');
      e.unwire(POLY_ENV, 'out', OSC_A, 'pitch');
      const zero = e.add('const', 0, 3, { value: 0 }); // (a pm input in use keeps saw 1 on the same oversampled path as saw 2)
      e.wire(zero, 'out', OSC_A, 'pm');
      const saw2 = e.add('osc', 3, 0.5, { wave: 2, level: 1, pm: CYCLES });
      e.wire(GLIDE, 'out', saw2, 'pitch');
      e.wire(SYNC, 'out', saw2, 'sync');
      const pulse = e.add('math', 3.5, 0.5, { ka: 1, kb: 1, off: 0 });
      e.wire(OSC_A, 'out', pulse, 'a');
      e.wire(saw2, 'out', pulse, 'b');
      const waves = e.add('math', 3.5, 1, { ka: 1, kb: 0, off: 0 }); // ka: saw on, kb: pulse on
      e.wire(OSC_A, 'out', waves, 'a');
      e.wire(pulse, 'sub', waves, 'b');
      // ---- the mixer per voice: A, B, noise (B and the noise at full level before it, so Poly Mod's osc B amount and the
      // wheel's noise do not depend on the mixer)
      const mix = e.add('mixer', 4, 0.5, { l1: 0.55, l2: 0.45, l3: 0, l4: 0 });
      e.unwire(OSC_B, 'out', FILTER, 'in');
      e.unwire(NOISE, 'out', FILTER, 'in');
      e.m(OSC_B).params.level = 1;
      e.m(NOISE).params.level = 1;
      e.wire(waves, 'add', mix, 'in1');
      e.wire(OSC_B, 'out', mix, 'in2');
      e.wire(NOISE, 'out', mix, 'in3');
      e.wire(mix, 'out', FILTER, 'in');
      // ---- the filter: a Multimode (cutoff per sample); the envelope amount on an attenuverter, in octaves
      e.retype(FILTER, 'filter', { cutoff: 600, res: 0.2, cvamt: 1, track: 0 });
      e.unwire(FENV, 'env', FILTER, 'cv');
      const envAmt = e.add('scale', 4.5, 1, { gain: 3.5, offset: 0 });
      e.wire(FENV, 'env', envAmt, 'in');
      e.wire(envAmt, 'out', FILTER, 'cv');
      // ---- Poly Mod: filter env (POLY_ENV) and osc B amounts summed, into freq A, pw A, filter
      Object.assign(e.m(POLY_ENV).params, { gain: 0, offset: 0 });
      const pmB = e.add('scale', 2.5, 1.5, { gain: 0, offset: 0 });
      e.wire(OSC_B, 'out', pmB, 'in');
      const bus = e.add('scale', 3, 1.5, { gain: 1, offset: 0 });
      e.wire(POLY_ENV, 'out', bus, 'in');
      e.wire(pmB, 'out', bus, 'in');
      const toFreqA = e.add('scale', 3.5, 1.5, { gain: 1, offset: 0 });
      e.wire(bus, 'out', toFreqA, 'in');
      e.wire(toFreqA, 'out', OSC_A, 'pitch');
      e.wire(toFreqA, 'out', saw2, 'pitch');
      const pw = e.add('scale', 3.5, 2, { gain: 0, offset: 0.5 }); // its offset is the pulse width, its gain Poly Mod's pw A
      e.wire(bus, 'out', pw, 'in');
      e.wire(pw, 'out', saw2, 'pm');
      const toFilter = e.add('scale', 4, 2, { gain: 0, offset: 0 });
      e.wire(bus, 'out', toFilter, 'in');
      e.wire(toFilter, 'out', FILTER, 'cv');
      // ---- oscillator B's keyboard switch (crossfade from nothing to the keys) and lo freq (an offset, octaves)
      e.unwire(GLIDE, 'out', OSC_B, 'pitch');
      const kbd = e.add('xfade', 2, 1.5, { mix: 1 });
      e.wire(GLIDE, 'out', kbd, 'b');
      e.wire(kbd, 'out', OSC_B, 'pitch');
      const lo = e.add('const', 0, 4, { value: 0 });
      e.wire(lo, 'out', OSC_B, 'pitch');
      e.join('voice', saw2, pulse, waves, mix, envAmt, pmB, bus, toFreqA, pw, toFilter, kbd);
      // ---- Wheel-Mod: LFO / noise mix, the wheel plus the initial amount, five destinations
      const noise2 = e.add('noise', 0, 3.5, { level: 1, color: 0 });
      const source = e.add('xfade', 0.5, 0.5, { mix: 0 });
      e.unwire(LFO, 'out', WHEEL, 'in');
      e.wire(LFO, 'out', source, 'a');
      e.wire(noise2, 'out', source, 'b');
      e.wire(source, 'out', WHEEL, 'in');
      const initial = e.add('const', 0, 4.5, { value: 0 });
      e.wire(initial, 'out', WHEEL, 'cv');
      e.m(VIB).params.gain = 1;
      const dest = (to: [number, string][], gain: number, r: number): number => {
        const s = e.add('scale', 0.5, r, { gain, offset: 0 });
        e.wire(VIB, 'out', s, 'in');
        for (const [m, port] of to) e.wire(s, 'out', m, port);
        return s;
      };
      const wFreqA = dest([[OSC_A, 'pitch'], [saw2, 'pitch']], 0.24, 2.5); // 0.24: the FM-1 version's vibrato, +-48 cents
      const wFreqB = dest([[OSC_B, 'pitch']], 0.24, 3);
      const wPwA = dest([[saw2, 'pm']], 0, 3.5);
      const wPwB = dest([[OSC_B, 'p2']], 0, 4); // (osc B's pulse width pin: once per block)
      const wFilter = dest([[FILTER, 'cv']], 0, 4.5);
      // ---- the card: the FM-1 version's rows, rebound where the modules changed, then the new sections
      e.rebind(e.rowAt('wave'), 'saw', waves, 'ka', 'A saw');
      e.insertRow(e.rowAt('saw') + 1, 'pulse', waves, 'kb', { inner: 'A pulse' });
      e.rebind(e.rowAt('pw'), 'pw', pw, 'offset', 'A pw');
      e.rebind(e.rowAt('A level'), 'A level', mix, 'l1');
      e.rebind(e.rowAt('B level'), 'B level', mix, 'l2');
      e.rebind(e.rowAt('noise'), 'noise', mix, 'l3');
      e.rebind(e.rowAt('env amt'), 'env amt', envAmt, 'gain');
      e.rebind(e.rowAt('pmod env→A'), 'pmod env', POLY_ENV, 'gain');
      e.rebind(e.rowAt('pmod B→A'), 'pmod osc B', pmB, 'gain');
      e.rebind(e.rowAt('vibrato'), 'wheel amt', VIB, 'gain');
      e.param('→ freq A', toFreqA, 'gain', { col: true, head: 'poly mod', inner: 'pmod → freq A' });
      e.param('→ pw A', pw, 'gain', { inner: 'pmod → pw A' });
      e.param('→ filter', toFilter, 'gain', { inner: 'pmod → filter' });
      e.param('source mix', source, 'mix', { head: 'wheel mod' });
      e.param('lfo amount', initial, 'value');
      e.param('freq A', wFreqA, 'gain');
      e.param('freq B', wFreqB, 'gain');
      e.param('pw A', wPwA, 'gain');
      e.param('pw B', wPwB, 'gain');
      e.param('filter', wFilter, 'gain');
      e.param('B kbd', kbd, 'mix', { head: 'osc B mode' });
      e.param('B lo freq', lo, 'value');
    });
    const x = aroundDef('Oracle V', def);
    x.set('voices', 5);
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES =
  'The full Prophet-5 modulation (Sequential Prophet-5 User’s Guide): Poly Mod (filter envelope and oscillator B into oscillator A’s frequency, pulse width and the filter, per voice, at audio rate) and Wheel-Mod (LFO / noise mix into both frequencies, both pulse widths and the filter), oscillator A’s saw and pulse together, oscillator B’s keyboard switch and lo freq. Five voices, as the original.';
