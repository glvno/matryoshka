// SPDX-License-Identifier: GPL-3.0-only
// Expander S XL: the Oberheim Eight Voice, eight SEMs, where the FM-1 version (scripts/gen-assemblies.ts, Expander S:
// four voices) had to cut. Sources: Arturia's Oberheim SEM V manual (2nd edition, 2014: its history of the Four Voice and
// the Eight Voice, and its panel chapter, which follows the original SEM apart from the parts it marks as its own: the
// sub oscillator, LFO 2, the effects, the arpeggiator); the FM-1 version's card for what stays.
// - Eight voices, each a whole SEM (the Eight Voice: the Four Voice's programmer plus four more SEMs).
// - Each voice's own LFO (a sine, as the SEM's; their rates a few percent apart, as eight separate modules run), into its
//   oscillators' pitch per sample (the FM-1 version: one shared LFO into the fine tune, once per block).
// - Envelope 1 into the cutoff per sample, through the Multimode's cv (the FM-1 version: a parameter input, once per
//   block); the VCF's modulation source switch (envelope 1 or the LFO).
// - Each oscillator's modulation: a source switch (envelope 1 or the LFO), an FM amount into its pitch and a PWM amount
//   into its pulse width (the SEM's one bipolar knob, frequency one side, pulse width the other, as two rows).
// - Oscillator 2 synced to oscillator 1, and the filter's band pass switch. The mode stays the continuous crossfade from low
//   pass through notch (low pass plus high pass at the centre, as the SEM's mode knob) to high pass.
// The card's first pages are the FM-1 version's; the new rows come after.
import { level, players } from '../factory-build';
import type { Xl } from './xl';
import { aroundDef, edit } from './asm-edit';

// the FM-1 version's local module ids (src/assemblies/expander-s.json)
const LFO = 1, VIB = 2, PART = 3, O1 = 4, O2 = 5, FLT = 6, AMT = 7, MODE = 8, ENV1 = 9, VCA = 11;
/** the four voices after the FM-1 version's four: the same mild spread */
const MORE_FLAWS = [
  { detune: -3, drift: 20, bright: -2, env: 2, level: 98 },
  { detune: 4, drift: 30, bright: 1, env: -5, level: 100 },
  { detune: -1, drift: 25, bright: -1, env: 4, level: 96 },
  { detune: 2, drift: 20, bright: 2, env: -2, level: 99 },
];

export const xl: Xl = {
  base: 'Expander S',
  build: () => {
    const def = edit('Expander S', (e) => {
      const voice = e.nest('voice');
      voice.poly!.flaws = [...voice.poly!.flaws!, ...MORE_FLAWS];
      // ---- a LFO per voice: the LFO and its vibrato amount join the voice card; vibrato into the pitch (octaves: the pin's
      // 200 cents are 1/6 octave)
      e.join('voice', LFO, VIB);
      e.m(LFO).params.wave = 0;
      e.unwire(VIB, 'out', O1, 'p1');
      e.unwire(VIB, 'out', O2, 'p1');
      e.wire(VIB, 'out', O1, 'pitch');
      e.wire(VIB, 'out', O2, 'pitch');
      e.m(VIB).params.gain /= 6;
      const spread = e.add('scale', 0, 2.5, { gain: 0.01, offset: 0 }); // the voice's place (-1..1) a few percent off the rate
      e.wire(PART, 'index', spread, 'in');
      e.wire(spread, 'out', LFO, 'p2');
      // ---- envelope 1 (or the LFO) into the cutoff per sample, in octaves
      e.unwire(AMT, 'out', FLT, 'p1');
      e.unwire(ENV1, 'env', AMT, 'in');
      e.m(FLT).params.cvamt = 1;
      e.m(AMT).params.gain = 3;
      const filterSrc = e.add('xfade', 2, 2.5, { mix: 0 });
      e.wire(ENV1, 'env', filterSrc, 'a');
      e.wire(LFO, 'out', filterSrc, 'b');
      e.wire(filterSrc, 'out', AMT, 'in');
      e.wire(AMT, 'out', FLT, 'cv');
      // ---- each oscillator's modulation: source, FM, PWM
      const oscMod = (o: number, col: number): [number, number, number] => {
        const src = e.add('xfade', col, 3, { mix: 1 });
        e.wire(ENV1, 'env', src, 'a');
        e.wire(LFO, 'out', src, 'b');
        const fm = e.add('scale', col, 3.5, { gain: 0, offset: 0 });
        e.wire(src, 'out', fm, 'in');
        e.wire(fm, 'out', o, 'pitch');
        const pwm = e.add('scale', col, 4, { gain: 0, offset: 0 });
        e.wire(src, 'out', pwm, 'in');
        e.wire(pwm, 'out', o, 'p2');
        return [src, fm, pwm];
      };
      const [src1, fm1, pwm1] = oscMod(O1, 0.5);
      const [src2, fm2, pwm2] = oscMod(O2, 1);
      // ---- sync (2 to 1) and the band pass switch
      const sync = e.add('scale', 1.5, 1.5, { gain: 0, offset: 0 });
      e.wire(O1, 'out', sync, 'in');
      e.wire(sync, 'out', O2, 'sync');
      e.unwire(MODE, 'out', VCA, 'in');
      const bp = e.add('xfade', 3.5, 0.5, { mix: 0 });
      e.wire(MODE, 'out', bp, 'a');
      e.wire(FLT, 'bp', bp, 'b');
      e.wire(bp, 'out', VCA, 'in');
      e.join('voice', spread, filterSrc, src1, fm1, pwm1, src2, fm2, pwm2, sync, bp);
      // ---- the card
      e.param('vco 1 src', src1, 'mix', { col: true, head: 'modulation' });
      e.param('vco 1 fm', fm1, 'gain');
      e.param('vco 1 pwm', pwm1, 'gain');
      e.param('vco 2 src', src2, 'mix', { group: true });
      e.param('vco 2 fm', fm2, 'gain');
      e.param('vco 2 pwm', pwm2, 'gain');
      e.param('filter src', filterSrc, 'mix', { group: true });
      e.param('sync', sync, 'gain', { head: 'switches' });
      e.param('bp', bp, 'mix');
    });
    const x = aroundDef('Expander S', def);
    x.set('voices', 8);
    level(x.p, { chord: true });
    x.p.notes = NOTES;
    return players(x.p, true);
  },
};

const NOTES =
  'The Oberheim Eight Voice: eight SEMs, each with its own LFO (into its oscillators’ pitch per sample), envelope 1 or the LFO into its cutoff per sample, each oscillator’s FM and PWM from envelope 1 or the LFO, sync, and the filter’s band pass switch beside the low pass to notch to high pass mode. Sources: Arturia’s Oberheim SEM V manual (the original SEM’s panel and the Four / Eight Voice history).';
