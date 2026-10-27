// SPDX-License-Identifier: GPL-3.0-only
// Briefcase 3 XL: the EMS VCS3 with its whole 16 x 16 pin matrix, where the FM-1 version (scripts/gen-assemblies.ts,
// Briefcase 3) has the control columns only and fixed signal routes. Source: VCS3 Users Manual (EMS London): the
// specification, the matrix board, each device's controls, the output amplifiers, the joystick.
// - The matrix: every source a row, every input a column, 256 pins, each a card row named as the manual names a pin,
//   column then row ("B12": the envelope signal into output amplifier 1), the card one column of the matrix per section:
//   A meter (the scope), B and C the output amplifiers, D the envelope shaper's input, E and F the ring modulator's, G the
//   reverb's, H the filter's; I to P as on the FM-1 version. A pin is a Mixer level: 0 out, 1 in (between: an attenuated
//   pin). Pins in one column sum, as the VCS3's resistor pins do. Set as the FM-1 version is patched (H1 H2 H3 H7 H13, D10,
//   G12, B14 C14, E2 F3, A14 and the FM-1 version's control pins).
// - The oscillators' frequency dials over the VCS3's range (an Offset, -4..4 for the dial's 0..10: 1.5 octaves a
//   division, dial 6 middle C for oscillators 1 and 2 and 7.8 Hz for oscillator 3): 0.5 Hz to 16.7 kHz, and 0.015 to 500 Hz.
// - The output amplifiers: the level stops at silence (a control below it no longer comes back inverted); the output
//   filter cuts treble to the left of its centre and bass to the right, flat in the middle (`filter 1`, `filter 2`: 0.5 is
//   flat); the pan knobs (`pan 1`, `pan 2`; the manual's advice, 1 left and 2 right, is the default).
// - The joystick's two range knobs (`range x`, `range y`).
// Kept from the FM-1 version (its header lists them): the keyboard through input amplifier 1 (row 8), the column
// sensitivities, the envelope shaper's manual mode, the trapezoid's direction, the Ladder.
// Not here, and why:
// - Needing a module, or a new ability of one, in both engines: input amplifier 2 (row 9: audio input, #351 "Audio input",
//   #274; its pins are on the card and silent, and input amplifier 1 carries the keyboard, not audio); the envelope
//   shaper's automatic repeat (`off`: Env L/R does not loop) and its decay past 10 s (the VCS3's reaches 15); the triangle
//   to ramp half of oscillators 2 and 3's shape and oscillator 1's shape (the Oscillator's triangle and sine have no shape
//   control); the filter's 18 dB slope (here 24).
// - Hardware: the meter's needle and its range switch (the scope draws column A), the speaker muting switches, the
//   headphone and control output jacks, the keyboard socket.
import { level, players } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';
import type { PortRef } from '../../src/assembly';

// the FM-1 version's local module ids (src/assemblies/briefcase-3.json)
const O1S = 2, O1R = 3, O2S = 4, O2T = 5, O3S = 6, O3T = 7, FI = 8, FJ = 9, FK = 10, NZ = 11, IN1 = 12, RING = 13, FLT = 14,
  FLVL = 15, SIG = 17, TRAPL = 19, REV = 20, REVL = 21, JX = 22, JY = 23, OUT1 = { lvl: 24, vca: 25, tone: 26 },
  OUT2 = { lvl: 27, vca: 28, tone: 29 }, SCOPE = 30, MIXERS = 31;
/** the matrix's rows, 1..16: the source and its name (row 9, input amplifier 2, has none) */
const ROWS: [number, string, string][] = [
  [O1S, 'out', 'osc 1 sine'], [O1R, 'out', 'osc 1 ramp'], [O2S, 'out', 'osc 2 square'], [O2T, 'out', 'osc 2 triangle'],
  [O3S, 'out', 'osc 3 square'], [O3T, 'out', 'osc 3 triangle'], [NZ, 'out', 'noise'], [IN1, 'out', 'input 1'], [0, '', 'input 2'],
  [FLVL, 'out', 'filter'], [TRAPL, 'out', 'trapezoid'], [SIG, 'out', 'env signal'], [RING, 'out', 'ring mod'], [REVL, 'out', 'reverb'],
  [JX, 'out', 'stick x'], [JY, 'out', 'stick y'],
];
/** the signal columns: letter, the section's name, the input */
const SIGNAL: [string, string, number, string][] = [
  ['A', 'meter', SCOPE, 'a'], ['B', 'output 1', OUT1.vca, 'in'], ['C', 'output 2', OUT2.vca, 'in'], ['D', 'envelope', SIG, 'in'],
  ['E', 'ring A', RING, 'in'], ['F', 'ring B', RING, 'cv'], ['G', 'reverb', REV, 'in'], ['H', 'filter', FLT, 'in'],
];
/** the control columns (the FM-1 version's Mixers, four per column from MIXERS on, rows 1-4, 5-8, 10-13, 14-16) */
const CONTROL: [string, string][] = [['I', 'osc 1 freq'], ['J', 'osc 2 freq'], ['K', 'osc 3 freq'], ['L', 'decay'], ['M', 'reverb mix'], ['N', 'filter freq'], ['O', 'out 1 level'], ['P', 'out 2 level']];
/** the signal pins of the FM-1 version's fixed cables, and the meter on the reverb */
const PINS: Record<string, number> = { H1: 1, H2: 1, H3: 1, H7: 1, H13: 1, D10: 1, G12: 1, B14: 1, C14: 1, E2: 1, F3: 1, A14: 1 };

export const xl: Xl = {
  base: 'Briefcase 3',
  build: () => {
    const def = edit('Briefcase 3', (e) => {
      // ---- the matrix card goes: its pins become the main card's rows
      delete e.def.assemblies;
      delete e.def.children;
      // ---- the signal columns' fixed cables give way to their pins
      for (const s of [O1S, O1R, O2S, RING, NZ]) e.unwire(s, 'out', FLT, 'in');
      e.unwire(FLVL, 'out', SIG, 'in');
      e.unwire(SIG, 'out', REV, 'in');
      e.unwire(REVL, 'out', OUT1.vca, 'in');
      e.unwire(REVL, 'out', OUT2.vca, 'in');
      e.unwire(O1R, 'out', RING, 'in');
      e.unwire(O2S, 'out', RING, 'cv');
      e.unwire(OUT1.tone, 'mix', SCOPE, 'a');
      // ---- the joystick's ranges: rows 15 and 16 are the stick through them
      const range = (stick: number, row: number): number => {
        const r = e.add('scale', 5, row, { gain: 1, offset: 0 });
        e.wire(stick, 'out', r, 'in');
        for (let k = 0; k < CONTROL.length; k++) {
          const mx = MIXERS + k * 4 + 3;
          const port = stick === JX ? 'in2' : 'in3';
          e.unwire(stick, 'out', mx, port);
          e.wire(r, 'out', mx, port);
        }
        return r;
      };
      const rangeX = range(JX, 3), rangeY = range(JY, 4);
      const source = (n: number): [number, string] | undefined => {
        if (n === 15) return [rangeX, 'out'];
        if (n === 16) return [rangeY, 'out'];
        const [m, port] = ROWS[n - 1];
        return m ? [m, port] : undefined;
      };
      // ---- the signal columns: four Mixers each, rows 1-4, 5-8, 9-12, 13-16
      const pins: Map<string, [number, string][]> = new Map();
      SIGNAL.forEach(([c, , dst, port], ci) => {
        const col: [number, string][] = [];
        for (let k = 0; k < 4; k++) {
          const mx = e.add('mixer', 10 + ci, 6 + k, { l1: 0, l2: 0, l3: 0, l4: 0 });
          e.wire(mx, 'out', dst, port);
          for (let j = 0; j < 4; j++) {
            const n = k * 4 + j + 1;
            const src = source(n);
            if (src) e.wire(src[0], src[1], mx, `in${j + 1}`);
            e.m(mx).params[`l${j + 1}`] = PINS[`${c}${n}`] ?? 0;
            col.push([mx, `l${j + 1}`]);
          }
        }
        pins.set(c, col);
      });
      // ---- the control columns: the FM-1 version's Mixers; row 9's pin is the fourth Mixer's free fourth input
      CONTROL.forEach(([c], ci) => {
        const m = (k: number): number => MIXERS + ci * 4 + k;
        const col: [number, string][] = [];
        for (let n = 1; n <= 16; n++) {
          if (n <= 8) col.push([m(Math.floor((n - 1) / 4)), `l${((n - 1) % 4) + 1}`]);
          else if (n === 9) col.push([m(3), 'l4']);
          else if (n <= 13) col.push([m(2), `l${n - 9}`]);
          else col.push([m(3), `l${n - 13}`]);
        }
        pins.set(c, col);
      });
      // ---- the oscillators' dials over the VCS3's range: an Offset (-4..4 for the dial's 0..10) through 1.875 octaves a
      // unit (1.5 a division); the column's Attenuverter keeps the column only
      const dial = (f: number, oscs: number[], v: number, off: number): number => {
        const d = e.add('const', -2, f - FI, { value: v });
        const s = e.add('scale', -1, f - FI, { gain: 1.875, offset: off });
        e.wire(d, 'out', s, 'in');
        for (const o of oscs) e.wire(s, 'out', o, 'pitch');
        e.m(f).params.offset = 0;
        return d;
      };
      // (the FM-1 version's settings: oscillator 1 at middle C, 2 at 0.59 octaves above it, 3 at 1 Hz: its -48 semitones
      // and -4 octaves)
      const d1 = dial(FI, [O1S, O1R], 0.8, -1.5);
      const d2 = dial(FJ, [O2S, O2T], (0.59 + 1.5) / 1.875, -1.5);
      const d3 = dial(FK, [O3S, O3T], (-4 + 2.56) / 1.875, -2.56);
      e.rebind(e.rowAt('frequency', 0), 'frequency', d1, 'value');
      e.rebind(e.rowAt('frequency', 1), 'frequency', d2, 'value');
      e.rebind(e.rowAt('frequency', 2), 'frequency', d3, 'value');
      // ---- the output amplifiers: the level stops at silence, the filter cuts treble or bass around a flat centre, the pan
      const amp = (o: { lvl: number; vca: number; tone: number }, row: number, pan: number) => {
        const floor = e.add('math', 6, row + 2, { ka: 1, kb: 1, off: 0 });
        e.unwire(o.lvl, 'out', o.vca, 'cv');
        e.wire(o.lvl, 'out', floor, 'a');
        e.wire(floor, 'max', o.vca, 'cv');
        const knob = e.add('macro', 8, row + 0.5, { value: 0.5 });
        const split = e.add('math', 9, row + 2, { ka: 2, kb: 1, off: -1 });
        e.wire(knob, 'out', split, 'a');
        Object.assign(e.m(o.tone).params, { cutoff: 16000, res: 0, cvamt: 4, morph: 0 });
        e.wire(split, 'min', o.tone, 'cv');
        const hp = e.add('filter', 8, row + 2, { cutoff: 20, res: 0, cvamt: 4, morph: 0 });
        e.wire(o.tone, 'lp12', hp, 'in');
        e.wire(split, 'max', hp, 'cv');
        const p = e.add('pan', 7, row + 2, { pan });
        e.wire(hp, 'hp', p, 'in');
        return { knob, p };
      };
      const a1 = amp(OUT1, 0, -1), a2 = amp(OUT2, 1, 1);
      const sumL = e.add('mixer', 10, -1, { l1: 1, l2: 1, l3: 0, l4: 0 });
      const sumR = e.add('mixer', 11, -1, { l1: 1, l2: 1, l3: 0, l4: 0 });
      e.wire(a1.p, 'l', sumL, 'in1');
      e.wire(a2.p, 'l', sumL, 'in2');
      e.wire(a1.p, 'r', sumR, 'in1');
      e.wire(a2.p, 'r', sumR, 'in2');
      e.def.outputs = [{ module: sumL, port: 'out', label: 'l' }, { module: sumR, port: 'out', label: 'r' }] as PortRef[];
      e.rebind(e.rowAt('filter 1'), 'filter 1', a1.knob, 'value');
      e.rebind(e.rowAt('filter 2'), 'filter 2', a2.knob, 'value');
      e.insertRow(e.rowAt('level 2') + 1, 'pan 1', a1.p, 'pan');
      e.insertRow(e.rowAt('pan 1') + 1, 'pan 2', a2.p, 'pan');
      e.insertRow(e.rowAt('y') + 1, 'range x', rangeX, 'gain');
      e.insertRow(e.rowAt('range x') + 1, 'range y', rangeY, 'gain');
      e.rebind(e.rowAt('out'), 'meter', SCOPE, 'view');
      // ---- the matrix: a section per column, its 16 pins in row order
      for (const [c, name] of [...SIGNAL.map(([c, n]) => [c, n] as const), ...CONTROL]) {
        pins.get(c)!.forEach(([mx, l], i) => e.param(`${c}${i + 1} ${ROWS[i][2]}`, mx, l, i === 0 ? { col: true, head: `${c} ${name}` } : {}));
      }
    });
    const x = aroundDef('Briefcase 3', def);
    level(x.p);
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES = "EMS VCS3 with all 256 matrix pins, 0 out/1 in. Missing engine abilities: external audio (input 1 carries keys, input 2 is silent), envelope repeat and decay beyond 10 s, variable sine/triangle shapes, and the 18 dB filter (24 dB here). The scope replaces the meter; speaker switches, headphone/control outputs and keyboard sockets are hardware, not reproduced. Output filters are flat at 0.5; pan is 0 left/1 right.";
