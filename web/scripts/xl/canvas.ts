// SPDX-License-Identifier: GPL-3.0-only
// Canvas XL: the Buchla Music Easel (the 208 Stored Program Sound Source and the 218 keyboard) with its patch field,
// where the FM-1 version (scripts/gen-assemblies.ts, Canvas) has a fixed patch. Source: Allen Strange, "Programming and
// Metaprogramming in the Electro-Organism: An Operating Directive for the Music Easel" (Buchla, 2nd edition 2013 for the
// 208e / 218e, "identical to the original 1973 version" but for minor changes): the front panel's sections, the patch
// field, the keyboard.
// - The switches are rows of named choices, as the panel names them (a Selector's positions, #358).
// - The patch field: each control input takes one banana cord from one of the control outputs, through its processing
//   control. Each input is a Selector (`... in`): main, pressure, sequencer, envelope, pulser (its ramp), random, mod cv
//   (the modulation oscillator), or PATCH (a cord into the assembly input). The inputs: pitch (with the polarity switch), frequency (the
//   modulation oscillator's, by `freq proc`), index, timbre, level 1, level 2, period (`period proc`: a voltage shortens
//   the period, as the manual says), portamento (`porta proc`: a voltage shortens the glide) and the inverter's input
//   (the inverter: 1 minus its input, the manual's 10 V minus it). PATCH with no cord is unpatched.
// - All control outputs are assembly ports, including four independently sampled random voltages, the inverter and
//   preset voltage. Patch any output into any field input, then select PATCH on that input's row.
// - The keyboard: the preset voltage source (`plate`: which of the four touch plates is held, the plates being hardware;
//   `preset 1..4` its pots, 0..1) added to MAIN by `add to main` (1 octaves: the FM-1's octave buttons, 2 preset, 3
//   none); pressure (Main's aftertouch) as a patch-field source.
// - The pulser's `once` (the spring-loaded position that fires it by hand) is the FX button.
// - The modulation oscillator's frequency dial is a 0..1 Macro over each range as the panel marks it: +hi 55 to 1760 Hz,
//   -high the same reversed (1760 Hz at 0), low 0.22 to 55 Hz (the Easel's starts at 0.17). Both oscillators' fine tune
//   spans half an octave, as the manual's (`fine tune` 0..1, 0.5 in tune).
// Kept from the FM-1 version (its header lists them): the sequencer, the envelope generator (its modes and trigger
// select), the random voltage, the timbre section, the modulation switch, the two gates and their modes, gate 2's source,
// the output mix and the reverb.
// Not here, and why:
// - Needing a module, or a new ability of one, in both engines: the preamp and envelope detector, the modulation switch's
//   bal. ext and gate 2's preamp source (audio input, #351 "Audio input", #274); the envelope generator's linear decay
//   (Env L/R falls exponentially).
// - Rows that read as numbers where the panel has switches: the pulse sequence (`pulse 1..5`: -1 off, anything else on; a
//   Sequencer's step at -1 is a rest, and #358 names a Selector's positions only) and the two wave switches (`waveshape`,
//   `timbre wave`: the Oscillator's waves, whose sine the Easel's switches have not got).
// - The 218's arpeggiator uses the patch's Arpeggiator page. Its continuous rate input takes Hz; the original's
//   external voltage scale is not calibrated here.
// - Unsure: whether the 208's left and right outputs split the channels; here both carry the mix.
// - Hardware and storage: the touch plates themselves, the monitor and master volume, the trim pots, the program card
//   and the local / remote / both CONTROL switch (the editor keeps the patches).
import { players, level, plugIn } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';

// the FM-1 version's local module ids (src/assemblies/canvas.json)
const PORTA = 2, P_TRIG = 3, P_MODE = 4, P_ENV = 5, P_END = 6, S_TRIG = 7, STAGES = 8, SEQ = 9, E_TRIG = 11, E_MODE = 12,
  ENV = 13, R_TRIG = 14, RND = 16, M_KBD = 17, M_RANGE = 18, MOSC = 19, MOD_SEL = 21, C_KBD = 23, P_POL = 24, P_PROC = 25,
  POSC = 26, T_PROC = 30, I_PROC = 31, G1_LVL = 33, G1_MODE = 36, SRC2 = 40, G2_LVL = 41, G2_MODE = 44;

export const xl: Xl = {
  base: 'Canvas',
  build: () => {
    const def = edit('Canvas', (e) => {
      // ---- keyboard: the preset voltages added to MAIN; pressure (Main's aftertouch) as a source
      const preset = e.add('select', 0, 5, { count: 4, pos: 1, v1: 0, v2: 0.25, v3: 0.5, v4: 1 });
      const addMain = e.add('select', 1, 5, { count: 3, pos: 3 });
      e.wire(preset, 'out', addMain, 'in2');
      e.wire(addMain, 'out', PORTA, 'in');
      const pressure = e.add('scale', 2, 5, { gain: 1, offset: 0 });
      e.input('pressure', pressure, 'in');
      // ---- the pulser's once: the FX button; its ramp (the period's rise turned upside down, 0 between cycles)
      e.input('once', P_MODE, 'in3');
      const P_RAMP = e.add('math', 3, 5, { ka: -1, kb: 1, off: 1 });
      e.wire(P_ENV, 'env', P_RAMP, 'a');
      e.wire(P_END, 'or', P_RAMP, 'b');
      // ---- the modulation oscillator's frequency dial over each range (the Oscillator four octaves down, the low range a
      // further four by its Selector value): -high 1760..55 Hz, +hi 55..1760 Hz, low 0.22..55 Hz
      const dial = e.add('macro', 4, 5, { value: 0.5667 }); // +hi, 7 semitones above the keys as the FM-1 version
      Object.assign(e.m(MOSC).params, { coarse: -48, fine: 0 });
      // per range a Math (a = b = the dial): off + (ka + kb) m, plus the Selector's value and the Oscillator's -4
      const ranges: [number, number, number][] = [[-4, 2.75, -1], [4, -2.25, 1], [4, -2.25, 4]];
      Object.assign(e.m(M_RANGE).params, { v1: 4, v2: 4, v3: -4 });
      ranges.forEach(([ka, off, kb], i) => {
        const m = e.add('math', 5 + i, 5, { ka, kb, off });
        e.wire(dial, 'out', m, 'a');
        e.wire(dial, 'out', m, 'b');
        e.wire(m, 'add', M_RANGE, `in${i + 1}`);
      });
      // ---- fine tune, half an octave, on both oscillators (their own fine rows go)
      const fine = (col: number, oscs: number[]): number => {
        const knob = e.add('macro', col, 7, { value: 0.5 });
        const span = e.add('scale', col, 8, { gain: 0.5, offset: -0.25 });
        e.wire(knob, 'out', span, 'in');
        for (const o of oscs) e.wire(span, 'out', o, 'pitch');
        return knob;
      };
      const mFine = fine(8, [MOSC]);
      const cFine = fine(9, [POSC, POSC + 1]); // (the timbre wave on the same pitch)
      e.rebind(e.rowAt('frequency'), 'frequency', dial, 'value');
      e.rebind(e.rowAt('fine tune'), 'fine tune', mFine, 'value');
      e.rebind(e.rowAt('fine tune', 1), 'fine tune', cFine, 'value');
      // ---- the patch field: the sources, the inverter, then one Selector per input
      const inv = e.add('scale', 10, 5, { gain: -1, offset: 1 });
      const sources: [number, string][] = [[PORTA, 'out'], [pressure, 'out'], [SEQ, 'out'], [ENV, 'env'], [P_RAMP, 'mul'], [RND, 'out'], [MOSC, 'out']];
      const randoms: [number, string][] = [[RND, 'out']];
      for (let i = 0; i < 3; i++) {
        const sample = e.add('random', 15 + i, 5);
        e.wire(R_TRIG, 'out', sample, 'clock');
        randoms.push([sample, 'held']);
      }
      const output = (label: string, module: number, port: string): void => { e.def.outputs.push({ label, module, port }); };
      ['main', 'pressure', 'sequencer', 'envelope', 'pulser', 'random 1', 'mod cv'].forEach((label, i) => output(label, ...sources[i]));
      randoms.slice(1).forEach(([m, port], i) => output(`random ${i + 2}`, m, port));
      output('inverter', inv, 'out');
      output('preset', preset, 'out');
      const jack = (row: number, pos: number, to: [number, string][]): number => {
        const s = e.add('select', row, 6, { count: 8, pos });
        sources.forEach(([m, port], i) => e.wire(m, port, s, `in${i + 1}`));
        for (const [m, port] of to) e.wire(s, 'out', m, port);
        return s;
      };
      // the fixed patch's cables give way to the inputs' Selectors (set as the FM-1 version is patched)
      e.unwire(SEQ, 'out', P_PROC, 'in');
      e.unwire(ENV, 'env', I_PROC, 'in');
      e.unwire(RND, 'out', T_PROC, 'in');
      e.unwire(ENV, 'env', G1_LVL, 'in');
      e.unwire(ENV, 'env', G2_LVL, 'in');
      const pitchIn = jack(0, 3, [[P_PROC, 'in']]);
      const fProc = e.add('scale', 11, 5, { gain: 0, offset: 0 });
      e.wire(fProc, 'out', MOSC, 'pitch');
      const freqIn = jack(1, 7, [[fProc, 'in']]);
      const indexIn = jack(2, 4, [[I_PROC, 'in']]);
      const timbreIn = jack(3, 6, [[T_PROC, 'in']]);
      const level1In = jack(4, 4, [[G1_LVL, 'in']]);
      const level2In = jack(5, 4, [[G2_LVL, 'in']]);
      // period and portamento: a voltage shortens them (pins on the times: a full-swing source at processing 1 moves the time
      // over its whole range)
      const perProc = e.add('scale', 12, 5, { gain: 0, offset: 0 });
      e.m(P_ENV).map!.p1 = ['r1'];
      e.m(P_ENV).att = [-1, 1];
      e.wire(perProc, 'out', P_ENV, 'p1');
      const periodIn = jack(6, 1, [[perProc, 'in']]);
      const portaProc = e.add('scale', 13, 5, { gain: 0, offset: 0 });
      e.m(PORTA).map!.p1 = ['time'];
      e.m(PORTA).att = [-1, 1];
      e.wire(portaProc, 'out', PORTA, 'p1');
      const portaIn = jack(7, 2, [[portaProc, 'in']]);
      const invIn = e.add('select', 14, 5, { count: 8, pos: 4 });
      sources.slice(0, 7).forEach(([m, port], i) => e.wire(m, port, invIn, `in${i + 1}`));
      e.wire(invIn, 'out', inv, 'in');
      // ---- the card: the new keyboard rows after the portamento, the processing controls in their sections, the patch
      // field's inputs last
      e.insertRow(e.rowAt('out'), 'add to main', addMain, 'pos');
      e.insertRow(e.rowAt('out'), 'plate', preset, 'pos');
      for (const n of [1, 2, 3, 4]) e.insertRow(e.rowAt('out'), `preset ${n}`, preset, `v${n}`);
      e.insertRow(e.rowAt('index'), 'freq proc', fProc, 'gain');
      e.insertRow(e.rowAt('period') + 1, 'period proc', perProc, 'gain');
      e.insertRow(e.rowAt('portamento') + 1, 'porta proc', portaProc, 'gain');
      const at = e.rowAt('out');
      const field: [string, number][] = [['pitch in', pitchIn], ['freq in', freqIn], ['index in', indexIn], ['timbre in', timbreIn], ['level 1 in', level1In], ['level 2 in', level2In], ['period in', periodIn], ['porta in', portaIn], ['inverter in', invIn]];
      // The eighth choice accepts a real cord, so every output (including all randoms and preset voltage) can reach
      // every input without a limit imposed by the Selector's eight positions.
      field.forEach(([label, s]) => e.input(label, s, 'in8'));
      field.forEach(([label, s], i) => e.insertRow(at + i, label, s, 'pos', i === 0 ? { col: true, head: 'patch field' } : {}));
      // ---- the switches as the panel names their positions (a Selector's row of named choices, #358)
      const SOURCES = ['main', 'pressure', 'sequencer', 'envelope', 'pulser', 'random 1', 'mod cv', 'patch'];
      const names = new Map<number, string[]>([
        [S_TRIG, ['keyboard', 'pulser', 'off']], [STAGES, ['3', '4', '5']], [E_TRIG, ['keyboard', 'pulser', 'sequencer']],
        [E_MODE, ['sustained', 'transient', 'off']], [P_TRIG, ['keyboard', 'self', 'sequencer']], [P_MODE, ['triggered', 'off', 'once']],
        [R_TRIG, ['keyboard', 'pulser', 'sequencer']], [M_KBD, ['on', 'off']], [M_RANGE, ['- high', '+ hi', 'low']],
        [MOD_SEL, ['bal. ext', 'f.m. osc', 'a.m. osc']], [C_KBD, ['on', 'off']], [P_POL, ['-', '+']], [G1_MODE, ['lopass', 'combination', 'vca']],
        [G2_MODE, ['lopass', 'combination', 'vca']], [SRC2, ['preamp', 'mod osc', 'gate 1']], [addMain, ['octaves', 'preset', 'none']],
        [preset, ['1', '2', '3', '4']], ...field.map(([, s]) => [s, SOURCES] as [number, string[]]),
      ]);
      for (const r of e.def.params) if (r.param === 'pos' && names.has(r.module)) r.names = names.get(r.module);
    });
    const x = aroundDef('Canvas', def);
    plugIn(x.p, x.main.id, 'at', x.a, 'pressure');
    plugIn(x.p, x.main.id, 'fx', x.a, 'once');
    level(x.p);
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES = 'Music Easel patch field with four independent random outputs. Select PATCH to connect any control source to an input. FX fires the pulser. The Arpeggiator has a rate input in Hz. Missing: external audio/preamp/envelope detector and linear decay. Pulse/wave rows use numbers; sine is extra. Plates, trims, program cards and local/remote switching need hardware or storage. Low range starts at 0.22 Hz, not 0.17. Output split remains unverified.';
