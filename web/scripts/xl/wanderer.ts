// SPDX-License-Identifier: GPL-3.0-only
// Wanderer XL: the ARP Odyssey (Rev 3, the 24 dB filter) whole, where the FM-1 version (scripts/gen-assemblies.ts,
// Wanderer) gives each VCO one oscillator to fit the FM-1's patch memory. Sources: ARP's ODYSSEY Owner's Manual (second
// edition, 1976: the panel chapters and the specifications) and Korg's ARP ODYSSEY reissue Owner's Manual (the panel,
// control by control; its DRIVE switch and VCF TYPE switch are the reissue's, not the original's).
// - Duophonic as the original: the lowest key held plays VCO 1, the highest VCO 2 (one key plays both; with no key held
//   both keep the last), one VCF, one HPF, one VCA, one ADSR and one AR. Two one-voice Voicings (priority low / high),
//   with legato on. The held gate minus the one-sample key-press pulse retriggers on every press, never on release.
// - Each VCO has its saw and its pulse at once (two Oscillators on one pitch): the audio mixer's switch picks one; the
//   pulse (with its width) feeds the ring modulator, the S/H mixer (VCO 2) and the sync; the S/H mixer's VCO 1 switch
//   picks VCO 1's saw or pulse on its own. Coarse (octaves, continuous as the original's slider) and fine (a Selector's
//   value) are in the pitch, so they move both oscillators. VCO 1's AUDIO KYBD ON / LF KYBD OFF: the keyboard, or 6
//   octaves down with the keys off (coarse then spans 0.26 to 65 Hz; the original 0.2 to 20 Hz).
// - FM: per VCO two depths, each after its source switch (VCO 1: LFO sine / LFO square, S/H / ADSR; VCO 2: LFO sine /
//   S/H mixer, S/H / ADSR). PWM: a source switch (LFO / ADSR) and a depth into the pulse width (once per block). SYNC: VCO
//   1's pulse into VCO 2's sync inputs.
// - The ring modulator is digital as the original's: the two pulses XORed, at a VCO's level. NOISE / RING MOD share one
//   slider and a switch. The noise generator's WHITE / PINK switch.
// - LFO: the sine; its square a comparator (0 / 1), which also clocks the S/H and the repeat.
// - Sample and hold: the S/H mixer (VCO 1 saw / square level, noise / VCO 2 square level), the trigger (LFO / keyboard),
//   OUTPUT LAG.
// - VCF: frequency, resonance and three modulation sliders, each after its switch (KYBD CV / S/H mixer, S/H / LFO sine,
//   ADSR / AR). HPF cutoff. VCA: AR / ADSR, its level and GAIN.
// - AR (attack, release) and ADSR, each triggered by the keyboard gate or the LFO repeat; KYBD REPEAT / AUTO REPEAT.
// - Portamento (linear, time per octave, both VCOs). The PPC's vibrato pad: Main's mod wheel brings in the LFO sine on
//   both VCOs. Its bend pads: Main's bend (+-2 semitones). The transpose: the FM-1's OCT buttons.
// Not here, and why:
// - The external audio input into the mixer: a module the engines do not have (issue #351, audio input).
// - Hardware: the pedal jack (VCO 2 FM and the VCF in place of the S/H mixer), the portamento footswitch, the CV, gate
//   and trigger jacks.
// Over the FM-1's patch memory (bytes), so it stays an XL.
import { players, plugIn } from '../factory-build';
import type { Patch } from '../../src/patch';
import type { Xl } from './xl';
import { around, define, matchLevel } from './def';

const built = define('Wanderer XL', (b) => {
  // ---- the keys: lowest -> VCO 1, highest -> VCO 2; portamento; the PPC's vibrato
  const lo = b.add('alloc', 0, 0, { voices: 1, priority: 1, legato: 2 });
  const hi = b.add('alloc', 0, 1, { voices: 1, priority: 2, legato: 2 });
  const gate = b.add('math', 0, 2); // held gate minus one-sample key press: retrigger only on presses
  const porta = b.add('macro', 0, 3, { value: 0 });
  const g1 = b.add('glide', 1, 0, { time: 0.001, curve: 1 });
  const g2 = b.add('glide', 1, 1, { time: 0.001, curve: 1 });
  b.pin(g1, 'p1', 'time');
  b.pin(g2, 'p1', 'time');
  const vib = b.add('vca', 1, 3, { gain: 0.05 });
  // ---- LFO (sine); a Logic on it: not = the square (0 / 1), and = the square while a key is held (KYBD REPEAT)
  const lfo = b.add('lfo', 0, 4, { wave: 0, rate: 6, depth: 1 });
  const sq = b.add('logic', 1, 4, { thresh: 0.05 });
  // ---- VCO 1
  const lf = b.add('select', 2, 0, { count: 2, pos: 1, v2: -6 });
  const fine1 = b.add('select', 2, 0.5, { count: 2, pos: 1, v1: 0 });
  const fa1 = b.add('select', 2, 1, { count: 2, pos: 1 });
  const fb1 = b.add('select', 2, 2, { count: 2, pos: 1 });
  const fm1 = b.add('math', 2, 3, { ka: 0, kb: 0, off: 0 });
  const pws1 = b.add('select', 2, 4, { count: 2, pos: 1 });
  const pwm1 = b.add('scale', 2, 5, { gain: 0, offset: 0 });
  const o1s = b.add('osc', 3, 0, { wave: 2, level: 1 });
  const o1p = b.add('osc', 3, 1, { wave: 3, level: 1, pw: 0.5 });
  b.pin(o1p, 'p1', 'pw');
  // ---- VCO 2
  const fine2 = b.add('select', 4, 0, { count: 2, pos: 1, v1: 0.0033 });
  const fa2 = b.add('select', 4, 1, { count: 2, pos: 1 });
  const fb2 = b.add('select', 4, 2, { count: 2, pos: 1 });
  const fm2 = b.add('math', 4, 3, { ka: 0, kb: 0, off: 1 });
  const pws2 = b.add('select', 4, 4, { count: 2, pos: 1 });
  const pwm2 = b.add('scale', 4, 5, { gain: 0, offset: 0 });
  const sync = b.add('select', 3, 2, { count: 2, pos: 1 });
  const o2s = b.add('osc', 5, 0, { wave: 2, level: 1 });
  const o2p = b.add('osc', 5, 1, { wave: 3, level: 1, pw: 0.35 });
  b.pin(o2p, 'p1', 'pw');
  // ---- noise (WHITE / PINK: a Selector's value into its color) and the sample and hold
  const nz = b.add('noise', 3, 3, { level: 1, color: 0 });
  const pink = b.add('select', 3, 3.5, { count: 2, pos: 1, v1: 0, v2: 1 });
  b.pin(nz, 'p1', 'color');
  const sh1 = b.add('select', 3, 4, { count: 2, pos: 1 });
  const sh2 = b.add('select', 3, 5, { count: 2, pos: 1 });
  const shMix = b.add('math', 3, 6, { ka: 0, kb: 1, off: 0 });
  const shTrig = b.add('select', 4, 6, { count: 2, pos: 1 });
  const sh = b.add('sh', 5, 6, { mode: 0 });
  const lag = b.add('glide', 6, 6, { time: 0.001, curve: 0 });
  // ---- audio mixer
  const ring = b.add('logic', 6, 2);
  const ringLvl = b.add('scale', 6, 2.5, { gain: 2, offset: -1 });
  const w1 = b.add('select', 6, 0, { count: 2, pos: 1 });
  const w2 = b.add('select', 6, 1, { count: 2, pos: 2 });
  const nr = b.add('select', 6, 3, { count: 2, pos: 1 });
  const mix = b.add('mixer', 7, 0, { l1: 0.45, l2: 0.35, l3: 0, l4: 0 });
  // ---- VCF, HPF, VCA
  const m1 = b.add('select', 7, 2, { count: 2, pos: 1 });
  const m2 = b.add('select', 7, 3, { count: 2, pos: 1 });
  const m3 = b.add('select', 7, 4, { count: 2, pos: 1 });
  const fmix = b.add('mixer', 8, 2, { l1: 0.25, l2: 0, l3: 0.6, l4: 0 });
  const flt = b.add('ladder', 8, 0, { cutoff: 900, res: 0.4, cvamt: 4, track: 0 });
  const hpf = b.add('filter', 9, 0, { cutoff: 40, res: 0 });
  const vcaSel = b.add('select', 9, 2, { count: 2, pos: 1 });
  const vcaAmt = b.add('scale', 9, 3, { gain: 1, offset: 0 });
  const vca = b.add('vca', 10, 0, { gain: 1 });
  // ---- envelopes and their triggers
  const adsr = b.add('adsr', 8, 4, { a: 0.005, d: 0.4, s: 0.4, r: 0.3 });
  const ar = b.add('adsr', 8, 5, { a: 0.004, d: 0.1, s: 1, r: 0.25 });
  const rep = b.add('select', 6, 4, { count: 2, pos: 1 });
  const adsrT = b.add('select', 7, 5, { count: 2, pos: 1 });
  const arT = b.add('select', 7, 6, { count: 2, pos: 1 });
  const scope = b.add('scope', 11, 0, { time: 16 });

  // keys, gate, portamento, vibrato, the LFO's square
  b.wire(lo, 'gate', gate, 'a');
  b.wire(lo, 'trig', gate, 'b');
  b.wire(lo, 'pitch', g1, 'in');
  b.wire(hi, 'pitch', g2, 'in');
  b.wire(porta, 'out', g1, 'p1');
  b.wire(porta, 'out', g2, 'p1');
  b.wire(lfo, 'out', vib, 'in');
  b.wire(lfo, 'out', sq, 'a');
  b.wire(gate, 'sub', sq, 'b');
  // VCO 1 pitch: the keys (or LF), fine, coarse and FM, vibrato
  b.wire(g1, 'out', lf, 'in1');
  b.wire(lf, 'out', fine1, 'in1');
  b.wire(lfo, 'out', fa1, 'in1');
  b.wire(sq, 'not', fa1, 'in2');
  b.wire(lag, 'out', fb1, 'in1');
  b.wire(adsr, 'env', fb1, 'in2');
  b.wire(fa1, 'out', fm1, 'a');
  b.wire(fb1, 'out', fm1, 'b');
  for (const o of [o1s, o1p]) {
    b.wire(fine1, 'out', o, 'pitch');
    b.wire(fm1, 'add', o, 'pitch');
    b.wire(vib, 'out', o, 'pitch');
  }
  b.wire(lfo, 'out', pws1, 'in1');
  b.wire(adsr, 'env', pws1, 'in2');
  b.wire(pws1, 'out', pwm1, 'in');
  b.wire(pwm1, 'out', o1p, 'p1');
  // VCO 2 pitch, sync
  b.wire(g2, 'out', fine2, 'in1');
  b.wire(lfo, 'out', fa2, 'in1');
  b.wire(shMix, 'add', fa2, 'in2');
  b.wire(lag, 'out', fb2, 'in1');
  b.wire(adsr, 'env', fb2, 'in2');
  b.wire(fa2, 'out', fm2, 'a');
  b.wire(fb2, 'out', fm2, 'b');
  for (const o of [o2s, o2p]) {
    b.wire(fine2, 'out', o, 'pitch');
    b.wire(fm2, 'add', o, 'pitch');
    b.wire(vib, 'out', o, 'pitch');
    b.wire(sync, 'out', o, 'sync');
  }
  b.wire(lfo, 'out', pws2, 'in1');
  b.wire(adsr, 'env', pws2, 'in2');
  b.wire(pws2, 'out', pwm2, 'in');
  b.wire(pwm2, 'out', o2p, 'p1');
  b.wire(o1p, 'out', sync, 'in2');
  // noise, sample and hold
  b.wire(pink, 'out', nz, 'p1');
  b.wire(o1s, 'out', sh1, 'in1');
  b.wire(o1p, 'out', sh1, 'in2');
  b.wire(nz, 'out', sh2, 'in1');
  b.wire(o2p, 'out', sh2, 'in2');
  b.wire(sh1, 'out', shMix, 'a');
  b.wire(sh2, 'out', shMix, 'b');
  b.wire(shMix, 'add', sh, 'in');
  b.wire(sq, 'not', shTrig, 'in1');
  b.wire(gate, 'sub', shTrig, 'in2');
  b.wire(shTrig, 'out', sh, 'clock');
  b.wire(sh, 'out', lag, 'in');
  // audio mixer
  b.wire(o1s, 'out', w1, 'in1');
  b.wire(o1p, 'out', w1, 'in2');
  b.wire(o2s, 'out', w2, 'in1');
  b.wire(o2p, 'out', w2, 'in2');
  b.wire(o1p, 'out', ring, 'a');
  b.wire(o2p, 'out', ring, 'b');
  b.wire(ring, 'xor', ringLvl, 'in');
  b.wire(nz, 'out', nr, 'in1');
  b.wire(ringLvl, 'out', nr, 'in2');
  b.wire(w1, 'out', mix, 'in1');
  b.wire(w2, 'out', mix, 'in2');
  b.wire(nr, 'out', mix, 'in3');
  // VCF, HPF, VCA
  b.wire(mix, 'out', flt, 'in');
  b.wire(g1, 'out', m1, 'in1');
  b.wire(shMix, 'add', m1, 'in2');
  b.wire(lag, 'out', m2, 'in1');
  b.wire(lfo, 'out', m2, 'in2');
  b.wire(adsr, 'env', m3, 'in1');
  b.wire(ar, 'env', m3, 'in2');
  b.wire(m1, 'out', fmix, 'in1');
  b.wire(m2, 'out', fmix, 'in2');
  b.wire(m3, 'out', fmix, 'in3');
  b.wire(fmix, 'out', flt, 'cv');
  b.wire(flt, 'lp24', hpf, 'in');
  b.wire(hpf, 'hp', vca, 'in');
  b.wire(ar, 'env', vcaSel, 'in1');
  b.wire(adsr, 'env', vcaSel, 'in2');
  b.wire(vcaSel, 'out', vcaAmt, 'in');
  b.wire(vcaAmt, 'out', vca, 'cv');
  b.wire(vca, 'out', scope, 'a');
  // envelope triggers: the keyboard gate, or the LFO repeat (KYBD REPEAT: while a key is held; AUTO REPEAT: always)
  b.wire(sq, 'and', rep, 'in1');
  b.wire(sq, 'not', rep, 'in2');
  for (const t of [adsrT, arT]) {
    b.wire(gate, 'sub', t, 'in1');
    b.wire(rep, 'out', t, 'in2');
  }
  b.wire(adsrT, 'out', adsr, 'gate');
  b.wire(arT, 'out', ar, 'gate');

  b.input('keys', lo, 'keys', [hi, 'keys']);
  b.input('wheel', vib, 'cv');
  b.output('out', vca, 'out');
  // the card, after the panel (the FM-1 version's rows and names, plus what it lacks)
  b.param('kybd', lf, 'pos', { head: 'vco 1' });
  b.param('coarse', fm1, 'off');
  b.param('fine', fine1, 'v1');
  b.param('fm 1', fm1, 'ka');
  b.param('fm 1 src', fa1, 'pos');
  b.param('fm 2', fm1, 'kb');
  b.param('fm 2 src', fb1, 'pos');
  b.param('pulse width', o1p, 'pw');
  b.param('pwm', pwm1, 'gain');
  b.param('pwm src', pws1, 'pos');
  b.param('coarse', fm2, 'off', { col: true, head: 'vco 2' });
  b.param('fine', fine2, 'v1');
  b.param('sync', sync, 'pos');
  b.param('fm 1', fm2, 'ka');
  b.param('fm 1 src', fa2, 'pos');
  b.param('fm 2', fm2, 'kb');
  b.param('fm 2 src', fb2, 'pos');
  b.param('pulse width', o2p, 'pw');
  b.param('pwm', pwm2, 'gain');
  b.param('pwm src', pws2, 'pos');
  b.param('lfo freq', lfo, 'rate', { col: true, head: 'lfo · s/h' });
  b.param('s/h 1', shMix, 'ka');
  b.param('s/h 1 src', sh1, 'pos');
  b.param('s/h 2', shMix, 'kb');
  b.param('s/h 2 src', sh2, 'pos');
  b.param('s/h trig', shTrig, 'pos');
  b.param('output lag', lag, 'time');
  b.param('portamento', porta, 'value');
  b.param('vco 1', mix, 'l1', { col: true, head: 'mixer' });
  b.param('vco 1 wave', w1, 'pos');
  b.param('vco 2', mix, 'l2');
  b.param('vco 2 wave', w2, 'pos');
  b.param('noise/ring', mix, 'l3');
  b.param('n/r src', nr, 'pos');
  b.param('noise', pink, 'pos');
  b.param('vcf freq', flt, 'cutoff', { col: true, head: 'filters · vca' });
  b.param('resonance', flt, 'res');
  b.param('mod 1', fmix, 'l1');
  b.param('mod 1 src', m1, 'pos');
  b.param('mod 2', fmix, 'l2');
  b.param('mod 2 src', m2, 'pos');
  b.param('mod 3', fmix, 'l3');
  b.param('mod 3 src', m3, 'pos');
  b.param('hpf', hpf, 'cutoff');
  b.param('vca eg', vcaSel, 'pos');
  b.param('vca level', vcaAmt, 'gain');
  b.param('gain', vcaAmt, 'offset');
  b.param('ar', ar, 'view', { col: true, head: 'envelopes' });
  b.param('attack', ar, 'a');
  b.param('release', ar, 'r');
  b.param('ar trig', arT, 'pos');
  b.param('adsr', adsr, 'view');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, adsr, q);
  b.param('adsr trig', adsrT, 'pos');
  b.param('repeat', rep, 'pos');
  b.param('out', scope, 'view');
});

// every switch's positions by name (#358), on the rows of that label (the nth of them)
const SWITCHES: [string, number, string[]][] = [
  ['kybd', 0, ['audio', 'lf']], ['sync', 0, ['off', 'on']], ['fm 1 src', 0, ['sine', 'square']], ['fm 2 src', 0, ['s/h', 'adsr']],
  ['pwm src', 0, ['lfo', 'adsr']], ['fm 1 src', 1, ['sine', 's/h mix']], ['fm 2 src', 1, ['s/h', 'adsr']], ['pwm src', 1, ['lfo', 'adsr']],
  ['s/h 1 src', 0, ['saw', 'square']], ['s/h 2 src', 0, ['noise', 'vco 2']], ['s/h trig', 0, ['lfo', 'kybd']],
  ['vco 1 wave', 0, ['saw', 'square']], ['vco 2 wave', 0, ['saw', 'square']], ['n/r src', 0, ['noise', 'ring']], ['noise', 0, ['white', 'pink']],
  ['mod 1 src', 0, ['kybd', 's/h mix']], ['mod 2 src', 0, ['s/h', 'lfo']], ['mod 3 src', 0, ['adsr', 'ar']], ['vca eg', 0, ['ar', 'adsr']],
  ['ar trig', 0, ['kybd', 'lfo']], ['adsr trig', 0, ['kybd', 'lfo']], ['repeat', 0, ['kybd', 'auto']],
];
for (const [label, nth, names] of SWITCHES) {
  const r = built.def.params.filter((q) => q.label === label)[nth];
  if (!r) throw new Error(`Wanderer XL: no row ${label}`);
  r.names = names;
}

export const xl: Xl = {
  base: 'Wanderer',
  build: (fm1: Patch): Patch => {
    const x = around('Wanderer', built);
    plugIn(x.p, x.main.id, 'mod', x.a, 'wheel');
    const p = players(x.p, true);
    matchLevel(p, fm1, [48, 60]);
    return p;
  },
};
