// SPDX-License-Identifier: GPL-3.0-only
import type { FxRecipe } from './factory-fx-recipes';

export interface LofiPresetDesign {
  name: string;
  basedOn: string;
  /** Exact cardRows keys; values are actual parameters, including numeric choice/selector indices. */
  moves: Record<string, number>;
  fx: FxRecipe;
  role: string;
  /** Musical direction only: not replicas, sampled material, or artist endorsements. */
  references: string[];
}

// Copy the complete basedOn synth preset before applying moves, then project onto the selected
// graph. parseCard alone starts from Init and therefore cannot implement this inheritance.
// Numeric choices are parameter indices, not display labels: FM ratio index 4 = 1.00,
// 8 = 2.00, 25 = 8.00; detune index 3 = neutral. Use the row's choice name when passing
// these values through parseValue, whose numeric-looking names otherwise take precedence.
// Existing voices, algorithm topology, bounded DSP quality and intrinsic effect paths remain.
// Hera 4 is the canonical definition (selected bank name Hera 6); it has no added FX rack.
// Levels are conservative design starting points, not calibrated loudness or listening approval.

/** Algo Four's DX100 sounds (D-1204) in card units, one object per operator: its rows without the operator number. Ratio and
 * detune are parameter indices (modules.ts RATIOS: 0 = 0.50, 4 = 1.00, 5 = 1.41, 7 = 1.73, 8 = 2.00, 10 = 3.00,
 * 12 = 3.46, 13 = 4.00, 16 = 5.00, 19 = 6.00, 22 = 7.00, 31 = 10.00, 35 = 11.30, 63 = 25.95; detune 3 = 0, 1 = -2,
 * 5 = +2). Operators 1 and 3 have rate/level envelopes (r1, l2, r2, l3, r4), 2 and 4 ADSRs; operator 4 has no index.
 * A DX output level becomes an amplitude of 2^((OL - 99) / 8) and a modulation index of about 13 times that; a DX
 * rate R a time of about 40 s x 2^(-R / 2), a release RR the rate 2 RR + 1; a D1L step 3 dB. These conversions are
 * estimates, not measurements of a DX100. */
function algoMoves(voice: Record<string, number>, ...operators: Record<string, number>[]): Record<string, number> {
  const moves: Record<string, number> = {};
  for (const [row, value] of Object.entries(voice)) moves[`voice / ${row}`] = value;
  operators.forEach((op, i) => {
    for (const [row, value] of Object.entries(op)) moves[`operator ${i + 1} / ${row} ${i + 1}`] = value;
  });
  return moves;
}
export const LOFI_PRESET_DESIGNS: Record<string, LofiPresetDesign[]> = {
  'Algo Four': [
    {
      name: 'Amber EP',
      basedOn: 'E Piano',
      moves: {
        'operator 1 / index 1': 0.8,
        'operator 1 / r1 1': 0.006,
        'operator 1 / l2 1': 0.75,
        'operator 1 / r2 1': 2.2,
        'operator 1 / l3 1': 0,
        'operator 1 / r4 1': 0.3,
        'operator 2 / ratio 2': 4,
        'operator 2 / detune 2': 3,
        'operator 2 / level 2': 0.65,
        'operator 2 / a 2': 0.004,
        'operator 2 / d 2': 0.75,
        'operator 2 / s 2': 0,
        'operator 2 / r 2': 0.25,
        'operator 3 / level 3': 0.12,
        'operator 3 / index 3': 0.55,
        'operator 3 / r2 3': 0.45,
        'operator 3 / l3 3': 0,
        'operator 3 / r4 3': 0.2,
        'operator 4 / ratio 4': 25,
        'operator 4 / level 4': 0.3,
        'operator 4 / d 4': 0.05,
        'operator 4 / s 4': 0,
        'operator 4 / r 4': 0.08,
        'voice / volume': 0.36,
      },
      fx: {
        reason: 'A short dark room supports mellow chord playing; a slow shallow chorus warms the reduced-index EP body without a long rhythmic echo.',
        chorus: { rate: 0.4, depth: 0.2, mix: 0.2 },
        reverb: { size: 0.34, damp: 0.78, mix: 0.17, pre: 16, mod: 0, freeze: 0 },
      },
      role: 'Warm decaying electric-piano chords. A neutral 1:1 lower stack, reduced FM index and subordinate short upper strike replace E Piano\'s brighter detuned body; held notes decay rather than sustain. Start with three-note voicings around MIDI 48-76.',
      references: ['Hot Chip', 'The Postal Service', 'Tycho'],
    },
    {
      name: 'Porcelain Keys',
      basedOn: 'Tubular Bell',
      moves: {
        'operator 1 / index 1': 0.9,
        'operator 1 / r1 1': 0.002,
        'operator 1 / l2 1': 0.72,
        'operator 1 / r2 1': 0.9,
        'operator 1 / l3 1': 0,
        'operator 1 / r4 1': 0.4,
        'operator 2 / ratio 2': 8,
        'operator 2 / level 2': 0.48,
        'operator 2 / a 2': 0.001,
        'operator 2 / d 2': 0.42,
        'operator 2 / s 2': 0,
        'operator 2 / r 2': 0.22,
        'operator 3 / level 3': 0.12,
        'operator 3 / index 3': 0.65,
        'operator 3 / r2 3': 0.5,
        'operator 3 / l3 3': 0,
        'operator 3 / r4 3': 0.25,
        'operator 4 / level 4': 0.28,
        'operator 4 / d 4': 0.12,
        'operator 4 / s 4': 0,
        'operator 4 / r 4': 0.15,
        'voice / volume': 0.41,
      },
      fx: {
        reason: 'An articulated 187 ms stereo answer places the short harmonic strike in front of a predelayed dark hall; no drive clouds the crystalline attack.',
        delay: { time: 187, fb: 0.22, mix: 0.25, sync: 0, pingpong: 1, note: 0 },
        reverb: { size: 0.57, damp: 0.76, mix: 0.22, pre: 28, mod: 0, freeze: 0 },
      },
      role: 'Short harmonic bell keys for melodic hooks and broken chords. Replaces Tubular Bell\'s inharmonic lower ratio with 2:1 modulation and cuts carrier/modulator decays separately, rather than obtaining a short bell only by shortening an effect. Try MIDI 60-84.',
      references: ['Purity Ring', 'Grimes', 'Clams Casino'],
    },
    // DX100 owner's manual, chapter V (printed pages 40-43): the programming example's electric piano.
    {
      name: 'Ping EP',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 5, algorithm: 5, feedback: 0, volume: 0.25 },
        { ratio: 4, detune: 3, level: 1, index: 0.74, r1: 0.001, l2: 0.25, r2: 2, l3: 0.08, r4: 0.12 },
        { ratio: 4, detune: 3, level: 1, index: 0, a: 0.001, d: 2, s: 0.1, r: 0.12 },
        { ratio: 4, detune: 3, level: 0.08, index: 1.14, r1: 0.001, l2: 0, r2: 0.44, l3: 0, r4: 0.03 },
        { ratio: 22, detune: 3, level: 1, a: 0.001, d: 0.44, s: 0, r: 0.03 },
      ),
      fx: {
        reason: 'A gentle chorus stands in for the manual\'s triangle-LFO amplitude modulation of operator 2, which Algo Four lacks; a close room keeps the 7.00 ping in front.',
        chorus: { rate: 0.8, depth: 0.18, mix: 0.2 },
        reverb: { size: 0.3, damp: 0.7, mix: 0.12, pre: 12, mod: 0, freeze: 0 },
      },
      role: 'Percussive electric-piano chords with a metallic attack ping that decays away while held. Algorithm 5: a 1:1 body stack (OL 99/66) and a 7.00 ping stack (OL 70/71), the manual\'s envelopes converted. Feedback 5 and keyboard level scaling are left out: operator 4 feedback costs too much at five voices, and Algo Four has no level scaling, so high notes stay brighter than the original. Five voices keep the CPU estimate under 90 %.',
      references: ['Yamaha DX100 owner\'s manual, chapter V "Voice programming example", printed pages 40-43: https://homepages.abdn.ac.uk/d.j.benson/pages/dx7/manuals/dx100-man.pdf'],
    },
    // Yamaha DX27/DX100 Voice Programming Guide (1986), Voice 1 (printed pages 7-10).
    {
      name: 'Combo Organ',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 4, algorithm: 8, feedback: 1, volume: 0.17 },
        { ratio: 0, detune: 3, level: 0.5, index: 0, r1: 0.001, l2: 1, r2: 0.5, l3: 1, r4: 0.005 },
        { ratio: 4, detune: 3, level: 0.5, index: 0, a: 0.001, d: 0.5, s: 1, r: 0.005 },
        { ratio: 8, detune: 3, level: 0.5, index: 0, r1: 0.001, l2: 1, r2: 0.5, l3: 1, r4: 0.005 },
        { ratio: 19, detune: 3, level: 0.5, a: 0.001, d: 0.44, s: 0.35, r: 0.005 },
      ),
      fx: {
        reason: 'A fast shallow chorus stands in for the chart\'s delayed LFO vibrato; a small room supports the gated organ without a rotary claim.',
        chorus: { rate: 4, depth: 0.12, mix: 0.3 },
        reverb: { size: 0.3, damp: 0.65, mix: 0.1, pre: 10, mod: 0, freeze: 0 },
      },
      role: 'Gated combo-organ chords. Algorithm 8: four sine carriers at 0.50, 1.00, 2.00 and 6.00 (all OL 90), operator 4 at full feedback with the chart\'s short percussive dip (D1R 13, D1L 12). Feedback 7 is mapped to Algo Four\'s maximum; the chart\'s keyboard level scaling is absent. Four voices, because operator 4 feedback is costly.',
      references: ['Yamaha DX27/DX100 Voice Programming Guide (1986), Voice 1 "Combo Organ", printed pages 7-10: https://data.yamaha.com/files/download/other_assets/4/320784/DX27SE2.PDF'],
    },
    // Voice Programming Guide, Voice 2 (printed page 11).
    {
      name: 'Elec Lute',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 2, feedback: 0, volume: 0.21 },
        { ratio: 4, detune: 3, level: 1, index: 0.97, r1: 0.001, l2: 0.3, r2: 1.25, l3: 0.1, r4: 0.88 },
        { ratio: 4, detune: 3, level: 1, index: 1, a: 0.001, d: 1.25, s: 0.12, r: 0.88 },
        { ratio: 8, detune: 3, level: 0.34, index: 0, r1: 0.001, l2: 0.18, r2: 1.25, l3: 0.05, r4: 0.88 },
        { ratio: 4, detune: 3, level: 1.8, a: 0.001, d: 1.25, s: 0.12, r: 0.88 },
      ),
      fx: {
        reason: 'A restrained 160 ms stereo answer and a small room give the plucked strings a place; no chorus, as the chart keeps vibrato on the wheel.',
        delay: { time: 160, fb: 0.14, mix: 0.16, sync: 0, pingpong: 1, note: 0 },
        reverb: { size: 0.3, damp: 0.72, mix: 0.1, pre: 14, mod: 0, freeze: 0 },
      },
      role: 'Plucked-string accompaniment, a lute or guitar substitute. Algorithm 2: operators 3 (2.00, OL 57) and 4 (1.00, OL 76) modulate operator 2 (OL 69), which modulates the carrier; every envelope is the chart\'s AR 31, D1R 10, D1L 10, D2R 9, RR 5. The second decay is approximated by a low held level. No level scaling, so the top is brighter than the chart intends.',
      references: ['Yamaha DX27/DX100 Voice Programming Guide (1986), Voice 2 "Electric Lute", printed page 11: https://data.yamaha.com/files/download/other_assets/4/320784/DX27SE2.PDF'],
    },
    // Voice Programming Guide, Voice 3 (printed page 12).
    {
      name: 'Backing Brass',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 3, feedback: 0, volume: 0.22 },
        { ratio: 0, detune: 3, level: 1, index: 1, r1: 0.12, l2: 1, r2: 0.5, l3: 1, r4: 0.11 },
        { ratio: 0, detune: 3, level: 1.14, index: 0, a: 0.25, d: 0.31, s: 0, r: 0.01 },
        { ratio: 0, detune: 3, level: 0, index: 0, r1: 0.001, l2: 1, r2: 0.5, l3: 1, r4: 0.11 },
        { ratio: 0, detune: 3, level: 1.4, a: 0.25, d: 0.5, s: 1, r: 0.11 },
      ),
      fx: {
        reason: 'A slow shallow chorus widens the section and a close room places it; no echo repeats the swells.',
        chorus: { rate: 0.5, depth: 0.16, mix: 0.18 },
        reverb: { size: 0.3, damp: 0.7, mix: 0.12, pre: 12, mod: 0, freeze: 0 },
      },
      role: 'Swelling horn-section chords an octave down, behind a melody; Brass Stab stays the short hit. Algorithm 3 with operator 3 off, as charted: operator 4 (OL 67) holds the edge, operator 2 (OL 71) adds a brief brightness at the onset, the modulators slower than the carrier. Every ratio is 0.50 for the chart\'s transpose to C2. Feedback 7 is replaced by a higher operator 4 index, which keeps six voices under 90 %; the edge is smoother than the original.',
      references: ['Yamaha DX27/DX100 Voice Programming Guide (1986), Voice 3 "Backing Brass", printed page 12: https://data.yamaha.com/files/download/other_assets/4/320784/DX27SE2.PDF'],
    },
    // Voice Programming Guide, Voice 4 (printed page 13).
    {
      name: 'FM Bells',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 4, algorithm: 6, feedback: 0, volume: 0.29 },
        { ratio: 13, detune: 3, level: 0.5, index: 0.88, r1: 0.001, l2: 0, r2: 0.88, l3: 0, r4: 0.44 },
        { ratio: 8, detune: 3, level: 0.5, index: 0.88, a: 0.001, d: 0.88, s: 0, r: 0.44 },
        { ratio: 4, detune: 3, level: 0.5, index: 0.88, r1: 0.001, l2: 0, r2: 0.88, l3: 0, r4: 0.44 },
        { ratio: 35, detune: 3, level: 1, a: 0.001, d: 0.88, s: 0, r: 0.44 },
      ),
      fx: {
        reason: 'A predelayed dark hall lets the three-octave strike ring after its short decay; no chorus, as the guide finds effects wrong for this voice.',
        reverb: { size: 0.66, damp: 0.74, mix: 0.24, pre: 24, mod: 0, freeze: 0 },
      },
      role: 'Short metallic octave bells for melodic accents. Algorithm 6: one fractional modulator (5.65, OL 68) strikes three carriers an octave apart (2.00, 1.00, 0.50, all OL 90). Every ratio is doubled for the chart\'s transpose to C4, so 5.65 becomes 11.30. Four voices, because three modulated carriers are costly. Brighter and shorter than Tubular Bell.',
      references: ['Yamaha DX27/DX100 Voice Programming Guide (1986), Voice 4 "FM Bells", printed page 13: https://data.yamaha.com/files/download/other_assets/4/320784/DX27SE2.PDF'],
    },
    // Voice Programming Guide, Voice 5 (printed page 14).
    {
      name: 'Harpsi Piano',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 4, algorithm: 1, feedback: 0, volume: 0.3 },
        { ratio: 4, detune: 3, level: 1, index: 1.05, r1: 0.001, l2: 0, r2: 1.25, l3: 0, r4: 0.03 },
        { ratio: 0, detune: 3, level: 1, index: 1, a: 0.001, d: 0.5, s: 1, r: 0.03 },
        { ratio: 22, detune: 3, level: 0.3, index: 1, r1: 0.001, l2: 0, r2: 2.5, l3: 0, r4: 0.03 },
        { ratio: 16, detune: 3, level: 0.45, a: 0.001, d: 0.31, s: 0, r: 0.03 },
      ),
      fx: {
        reason: 'A small bright room only; the plucked keyboard attack and quick release stay exposed.',
        reverb: { size: 0.28, damp: 0.65, mix: 0.1, pre: 8, mod: 0, freeze: 0 },
      },
      role: 'Plucked keyboard between piano and harpsichord, strongest in the low and middle range. Algorithm 1, a four-operator chain: ratios 2.00 / 1.00 / 14.00 / 10.00 halved for the chart\'s transpose to C2. The chart scales the upper modulators down hard across the keyboard; Algo Four cannot, so their levels sit below the chart (0.3 and 0.45 instead of about 0.4 and 0.6) and the top stays bright. Four voices, because the chain is costly.',
      references: ['Yamaha DX27/DX100 Voice Programming Guide (1986), Voice 5 "Harpsi-Piano", printed page 14: https://data.yamaha.com/files/download/other_assets/4/320784/DX27SE2.PDF'],
    },
    // Authored after the DX100 preset name Old Electro and the lo-fi palette (D-897).
    {
      name: 'Dusty EP',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 5, algorithm: 5, feedback: 0, volume: 0.2 },
        { ratio: 4, detune: 3, level: 1, index: 0.6, r1: 0.003, l2: 0.3, r2: 1.4, l3: 0.08, r4: 0.3 },
        { ratio: 4, detune: 5, level: 1, index: 0, a: 0.003, d: 0.9, s: 0.1, r: 0.3 },
        { ratio: 4, detune: 1, level: 0.45, index: 0.5, r1: 0.005, l2: 0.2, r2: 0.9, l3: 0.05, r4: 0.3 },
        { ratio: 13, detune: 3, level: 1, a: 0.001, d: 0.15, s: 0, r: 0.1 },
      ),
      fx: {
        reason: 'Slow deep chorus makes the soft keys waver like a worn recording, and a very dark small room keeps them close; no echo.',
        chorus: { rate: 0.2, depth: 0.55, mix: 0.38 },
        reverb: { size: 0.3, damp: 0.85, mix: 0.14, pre: 10, mod: 0, freeze: 0 },
      },
      role: 'Dark, wavering lo-fi chord keys for beat music. Two detuned 1:1 stacks with low indices, a soft 4.00 bark that is gone in 150 ms, and a slow deep chorus. Softer and more unstable than Amber EP; no tine. Play three-note voicings around MIDI 48-72.',
      references: ['DX100 preset name "Old Electro" (owner\'s manual printed page 9), as direction only', 'Lo-fi palette roles (D-897)'],
    },
    // Authored after the DX100 preset names Hamarimba and Marimba.
    {
      name: 'Wood Marimba',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 7, feedback: 0, volume: 0.19 },
        { ratio: 4, detune: 3, level: 1, index: 0, r1: 0.001, l2: 0, r2: 0.9, l3: 0, r4: 0.3 },
        { ratio: 13, detune: 3, level: 0.25, index: 0, a: 0.001, d: 0.18, s: 0, r: 0.1 },
        { ratio: 4, detune: 3, level: 0.2, index: 2.5, r1: 0.001, l2: 0, r2: 0.12, l3: 0, r4: 0.1 },
        { ratio: 31, detune: 3, level: 1, a: 0.001, d: 0.04, s: 0, r: 0.03 },
      ),
      fx: {
        reason: 'A small dark room gives the wooden bars a floor to ring from; no echo blurs fast figures.',
        reverb: { size: 0.3, damp: 0.75, mix: 0.12, pre: 10, mod: 0, freeze: 0 },
      },
      role: 'Wooden mallet for ostinatos and fast figures. Algorithm 7: a sine fundamental decaying in 0.6 s, a quieter fourth harmonic gone in 0.18 s (the marimba bar\'s tuned overtone), and a 10.00 modulator that makes a 40 ms mallet knock on a third carrier. Try MIDI 48-84.',
      references: ['DX100 preset names "Hamarimba" and "Marimba" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset names Flap Bass and Snare Bass.
    {
      name: 'Slap Bass',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 2, algorithm: 5, feedback: 0.3, volume: 0.32 },
        { ratio: 4, detune: 3, level: 1, index: 3, r1: 0.001, l2: 0.55, r2: 0.35, l3: 0.4, r4: 0.08 },
        { ratio: 8, detune: 3, level: 1, index: 0, a: 0.001, d: 0.12, s: 0.1, r: 0.08 },
        { ratio: 4, detune: 3, level: 0.3, index: 4, r1: 0.001, l2: 0, r2: 0.15, l3: 0, r4: 0.05 },
        { ratio: 16, detune: 3, level: 1, a: 0.001, d: 0.03, s: 0, r: 0.03 },
      ),
      fx: {
        reason: 'Deliberately dry: the hollow 1:2 pop and the thumb click must stay tight against a kick.',
      },
      role: 'Funk and pop slap bass for syncopated lines. Operator 2 at 2.00 gives a hollow pop that falls to a round body in 120 ms; operator 4 at 5.00, with a little feedback, makes a 30 ms thumb click on a quieter second carrier. Two voices, so feedback stays affordable. Brighter and more percussive than Solid Bass.',
      references: ['DX100 preset names "Flap Bass" and "Snare Bass" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset name Mono Bass.
    {
      name: 'Sub Bass',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 2, algorithm: 5, feedback: 0, volume: 0.15 },
        { ratio: 4, detune: 3, level: 1, index: 1, r1: 0.002, l2: 1, r2: 0.5, l3: 1, r4: 0.08 },
        { ratio: 4, detune: 3, level: 1, index: 0, a: 0.001, d: 0.12, s: 0.08, r: 0.08 },
        { ratio: 8, detune: 3, level: 0.15, index: 0, r1: 0.002, l2: 1, r2: 0.5, l3: 1, r4: 0.08 },
        { ratio: 4, detune: 3, level: 0, a: 0.001, d: 0.12, s: 0, r: 0.2 },
      ),
      fx: {
        reason: 'Deliberately dry: a sustained low sine needs a still, centered image and clean note endings.',
      },
      role: 'Held sine sub bass under dense arrangements. A 1:1 modulator gives each note a 120 ms rounded onset and then almost nothing; a quiet octave sine helps small speakers find the pitch. Full sustain, short release. Play MIDI 33-55.',
      references: ['DX100 preset name "Mono Bass" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset name Uprt Bass.
    {
      name: 'Upright Pluck',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 2, algorithm: 5, feedback: 0, volume: 0.46 },
        { ratio: 4, detune: 3, level: 1, index: 1.4, r1: 0.008, l2: 0.35, r2: 0.4, l3: 0, r4: 0.15 },
        { ratio: 4, detune: 3, level: 1, index: 0, a: 0.005, d: 0.25, s: 0.1, r: 0.15 },
        { ratio: 4, detune: 3, level: 0.2, index: 1.2, r1: 0.002, l2: 0, r2: 0.08, l3: 0, r4: 0.05 },
        { ratio: 10, detune: 3, level: 1, a: 0.001, d: 0.06, s: 0, r: 0.05 },
      ),
      fx: {
        reason: 'A very small dark room adds wood around the pluck without lengthening its natural decay.',
        reverb: { size: 0.2, damp: 0.8, mix: 0.07, pre: 6, mod: 0, freeze: 0 },
      },
      role: 'Plucked acoustic-style bass for walking and jazz lines. A slightly soft onset, a woody 1:1 tone that darkens in 250 ms and a decay to silence in about 1.4 s, with a short finger thump from a 3.00 modulator. Decays while held, unlike Sub Bass.',
      references: ['DX100 preset name "Uprt Bass" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored glass pad.
    {
      name: 'Glass Pad',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 7, feedback: 0, volume: 0.33 },
        { ratio: 4, detune: 1, level: 0.5, index: 0, r1: 1.2, l2: 1, r2: 2, l3: 0.8, r4: 1.8 },
        { ratio: 13, detune: 5, level: 0.12, index: 0, a: 1.6, d: 3, s: 0.7, r: 1.8 },
        { ratio: 8, detune: 3, level: 0.3, index: 1, r1: 0.9, l2: 1, r2: 2.5, l3: 0.7, r4: 1.8 },
        { ratio: 22, detune: 3, level: 1, a: 1.2, d: 3, s: 0.5, r: 1.5 },
      ),
      fx: {
        reason: 'Slow chorus, a long dark echo and a hall turn the slow glassy swell into a wide wash.',
        chorus: { rate: 0.18, depth: 0.45, mix: 0.3 },
        delay: { time: 380, fb: 0.24, mix: 0.18, sync: 0, pingpong: 0, note: 0 },
        reverb: { size: 0.66, damp: 0.75, mix: 0.22, pre: 20, mod: 0, freeze: 0 },
      },
      role: 'Slow glassy pad for held chords. Algorithm 7: a soft sine body, a quiet detuned 4.00 shimmer and a 2.00 carrier that a 7.00 modulator makes glassy, all fading in over about a second. Long releases.',
      references: ['DX100 preset names "Space chime" and "Fantasy" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored evolving pad.
    {
      name: 'Dawn Sweep',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 2, feedback: 0, volume: 0.17 },
        { ratio: 4, detune: 3, level: 1, index: 1.2, r1: 0.6, l2: 1, r2: 2, l3: 0.85, r4: 2 },
        { ratio: 4, detune: 3, level: 1, index: 1, a: 2.5, d: 4, s: 0.4, r: 2 },
        { ratio: 8, detune: 3, level: 0.3, index: 0, r1: 4, l2: 0.6, r2: 5, l3: 0.3, r4: 2 },
        { ratio: 4, detune: 6, level: 0.6, a: 1.5, d: 4, s: 0.3, r: 2 },
      ),
      fx: {
        reason: 'Slow deep chorus and a large dark hall let the brightness rise and settle inside a space.',
        chorus: { rate: 0.14, depth: 0.55, mix: 0.32 },
        reverb: { size: 0.7, damp: 0.75, mix: 0.28, pre: 20, mod: 0, freeze: 0 },
      },
      role: 'Evolving pad whose tone brightens over two to four seconds and then settles: the modulator chain swells after the carrier, and a +3 detuned modulator slowly moves the spectrum. Hold chords for several seconds.',
      references: ['DX100 preset names "Lyrisyn" and "Fantasy" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset names Strings and Richstring.
    {
      name: 'FM Strings',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 3, feedback: 0, volume: 0.18 },
        { ratio: 4, detune: 3, level: 1, index: 1, r1: 0.35, l2: 1, r2: 1, l3: 0.9, r4: 0.8 },
        { ratio: 4, detune: 6, level: 1.4, index: 0, a: 0.3, d: 1.5, s: 0.7, r: 0.8 },
        { ratio: 4, detune: 3, level: 0, index: 0, r1: 0.001, l2: 1, r2: 0.5, l3: 1, r4: 0.8 },
        { ratio: 4, detune: 0, level: 1.1, a: 0.4, d: 2, s: 0.6, r: 0.8 },
      ),
      fx: {
        reason: 'An ensemble-depth chorus and a predelayed hall make the two detuned modulators a string section.',
        chorus: { rate: 0.5, depth: 0.35, mix: 0.35 },
        reverb: { size: 0.62, damp: 0.75, mix: 0.2, pre: 22, mod: 0, freeze: 0 },
      },
      role: 'Sustained string-ensemble chords. Two 1:1 modulators detuned +3 and -3 drive one carrier hard enough for a saw-like tone; a 0.35 s bow and a 0.8 s release. Steadier and brighter than Dawn Sweep.',
      references: ['DX100 preset names "Strings" and "Richstring" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset name Kotokoto.
    {
      name: 'Koto',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 5, algorithm: 5, feedback: 0, volume: 0.26 },
        { ratio: 4, detune: 3, level: 1, index: 1.8, r1: 0.001, l2: 0.4, r2: 0.8, l3: 0, r4: 0.3 },
        { ratio: 10, detune: 3, level: 1, index: 0, a: 0.001, d: 0.4, s: 0.05, r: 0.3 },
        { ratio: 8, detune: 3, level: 0.25, index: 1.5, r1: 0.001, l2: 0, r2: 0.3, l3: 0, r4: 0.2 },
        { ratio: 16, detune: 3, level: 1, a: 0.001, d: 0.06, s: 0, r: 0.05 },
      ),
      fx: {
        reason: 'A dotted 187 ms stereo answer and a small room let single plucked notes answer themselves.',
        delay: { time: 187, fb: 0.2, mix: 0.22, sync: 0, pingpong: 1, note: 0 },
        reverb: { size: 0.4, damp: 0.7, mix: 0.14, pre: 18, mod: 0, freeze: 0 },
      },
      role: 'Bright plucked koto-like melody. A 3.00 modulator gives a nasal attack that fades in 0.4 s; a 5.00 modulator plucks a quieter octave carrier for 60 ms. Sparse melodies around MIDI 60-84; sharper than Elec Lute.',
      references: ['DX100 preset name "Kotokoto" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset names Clav 1 and Clear Clav.
    {
      name: 'FM Clav',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 5, algorithm: 5, feedback: 0, volume: 0.3 },
        { ratio: 4, detune: 3, level: 1, index: 3.2, r1: 0.001, l2: 0.6, r2: 0.3, l3: 0.45, r4: 0.05 },
        { ratio: 4, detune: 3, level: 1, index: 0, a: 0.001, d: 0.15, s: 0.35, r: 0.05 },
        { ratio: 10, detune: 3, level: 0.3, index: 2, r1: 0.001, l2: 0.3, r2: 0.2, l3: 0.2, r4: 0.05 },
        { ratio: 4, detune: 3, level: 1, a: 0.001, d: 0.05, s: 0.2, r: 0.05 },
      ),
      fx: {
        reason: 'One short 85 ms reflection adds a close percussive response; the gated clav stays dry otherwise.',
        delay: { time: 85, fb: 0, mix: 0.11, sync: 0, pingpong: 0, note: 0 },
      },
      role: 'Funky clavinet-style comping that keeps its bite while held and stops at once on release. A high 1:1 index for the snap, a 3.00 second carrier for the nasal string, 50 ms releases. Play short syncopated chords.',
      references: ['DX100 preset names "Clav 1" and "Clear Clav" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset name Feed Lead.
    {
      name: 'Feed Lead',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 2, algorithm: 5, feedback: 0.4, volume: 0.25 },
        { ratio: 4, detune: 3, level: 1, index: 1.2, r1: 0.01, l2: 0.9, r2: 0.4, l3: 0.75, r4: 0.2 },
        { ratio: 4, detune: 3, level: 1, index: 0, a: 0.01, d: 0.5, s: 0.6, r: 0.2 },
        { ratio: 4, detune: 5, level: 0.5, index: 1.2, r1: 0.01, l2: 0.9, r2: 0.4, l3: 0.75, r4: 0.2 },
        { ratio: 4, detune: 3, level: 1, a: 0.01, d: 0.5, s: 0.7, r: 0.2 },
      ),
      fx: {
        reason: 'A clear 300 ms echo follows the melody and a small dark room joins the phrases.',
        delay: { time: 300, fb: 0.22, mix: 0.2, sync: 0, pingpong: 0, note: 0 },
        reverb: { size: 0.3, damp: 0.72, mix: 0.08, pre: 20, mod: 0, freeze: 0 },
      },
      role: 'Buzzy sustained solo lead. Operator 4 feeds back into a saw-like wave and drives a slightly detuned second stack next to a plainer 1:1 stack. Two voices, so feedback stays affordable; play one line.',
      references: ['DX100 preset name "Feed Lead" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset names Pan Floot and Flutewood.
    {
      name: 'Pan Flute',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 2, algorithm: 5, feedback: 1, volume: 0.23 },
        { ratio: 4, detune: 3, level: 1, index: 0.4, r1: 0.06, l2: 1, r2: 0.3, l3: 0.85, r4: 0.25 },
        { ratio: 4, detune: 3, level: 1, index: 0, a: 0.08, d: 0.5, s: 0.6, r: 0.25 },
        { ratio: 4, detune: 3, level: 0.12, index: 3, r1: 0.02, l2: 0.4, r2: 0.12, l3: 0.03, r4: 0.2 },
        { ratio: 24, detune: 3, level: 1, a: 0.01, d: 0.2, s: 0.2, r: 0.2 },
      ),
      fx: {
        reason: 'A medium hall and a soft 280 ms echo give the line air; no chorus moves its pitch.',
        delay: { time: 280, fb: 0.2, mix: 0.16, sync: 0, pingpong: 0, note: 0 },
        reverb: { size: 0.5, damp: 0.6, mix: 0.2, pre: 18, mod: 0, freeze: 0 },
      },
      role: 'Soft flute melody. A nearly pure sine with a 60 ms onset, and a quiet second carrier that operator 4 (7.85, full feedback) roughens into a short inharmonic chiff at each onset, settling to a faint edge. Two voices; play one line around MIDI 60-84.',
      references: ['DX100 preset names "Pan Floot" and "Flutewood" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset name StormWind.
    {
      name: 'Storm Wind',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 3, algorithm: 7, feedback: 1, volume: 0.18 },
        { ratio: 5, detune: 3, level: 0.12, index: 0, r1: 2, l2: 1, r2: 3, l3: 0.4, r4: 3 },
        { ratio: 4, detune: 3, level: 0, index: 0, a: 0.001, d: 0.5, s: 0, r: 0.5 },
        { ratio: 0, detune: 3, level: 1, index: 12, r1: 1.5, l2: 1, r2: 4, l3: 0.5, r4: 3 },
        { ratio: 63, detune: 3, level: 1, a: 1, d: 4, s: 0.6, r: 3 },
      ),
      fx: {
        reason: 'Deep slow chorus smears the noise into gusts and a long dark hall carries it; this transition texture is meant to be wet.',
        chorus: { rate: 0.12, depth: 0.65, mix: 0.4 },
        reverb: { size: 0.76, damp: 0.86, mix: 0.34, pre: 0, mod: 0, freeze: 0 },
      },
      role: 'Wind and storm texture for transitions. Operator 4 at 25.95 with full feedback drives a 0.50 carrier at a very high index, which makes a noise-like rumble that swells over seconds; a quiet 1.41 sine whistles above it. Three voices; hold one or two keys.',
      references: ['DX100 preset name "StormWind" (owner\'s manual printed page 9), as direction only'],
    },
    // Authored after the DX100 preset name Space chime.
    {
      name: 'Space Chime',
      basedOn: 'Init',
      moves: algoMoves(
        { voices: 6, algorithm: 7, feedback: 0, volume: 0.29 },
        { ratio: 5, detune: 3, level: 0.3, index: 0, r1: 0.001, l2: 0.5, r2: 2.5, l3: 0, r4: 2.5 },
        { ratio: 12, detune: 3, level: 0.15, index: 0, a: 0.4, d: 3, s: 0, r: 2.5 },
        { ratio: 4, detune: 3, level: 0.6, index: 2.5, r1: 0.001, l2: 0.3, r2: 2, l3: 0, r4: 2 },
        { ratio: 7, detune: 3, level: 1, a: 0.001, d: 1.5, s: 0, r: 1.5 },
      ),
      fx: {
        reason: 'A long 375 ms echo and a large predelayed hall make each inharmonic strike drift away.',
        delay: { time: 375, fb: 0.35, mix: 0.28, sync: 0, pingpong: 0, note: 0 },
        reverb: { size: 0.75, damp: 0.7, mix: 0.3, pre: 30, mod: 0, freeze: 0 },
      },
      role: 'Inharmonic struck chimes with long echoes, for intros and sparse accents. A 1.73 modulator on a 1.00 carrier, a 1.41 sine and a 3.46 sine that blooms after the strike; nothing is in tune with the harmonic series, unlike Glass Pad.',
      references: ['DX100 preset name "Space chime" (owner\'s manual printed page 9), as direction only'],
    },
  ],
  'Cassia 1': [
    {
      name: 'Velvet Chords',
      basedOn: 'Tine Piano',
      moves: {
        'line 1 / wave': 4,
        'line 2 / wave': 1,
        'line 2 / coarse': 0,
        'line 2 / fine': -5,
        'touch / level 2': 0.45,
        'touch / vel dcw': 0.22,
        'touch / dcw kf': -0.2,
        'vibrato / rate': 0.32,
        'vibrato / depth': 0.08,
        'vibrato / delay': 0.2,
        'keys / chorus': 0.38,
        'dcw 1 / r1': 0.04,
        'dcw 1 / l1': 0.3,
        'dcw 1 / r2': 0.7,
        'dcw 1 / l2': 0.18,
        'dcw 1 / r3': 1.4,
        'dcw 1 / l3': 0.12,
        'dcw 1 / r4': 0.4,
        'dca 1 / r1': 0.025,
        'dca 1 / r2': 0.7,
        'dca 1 / l2': 0.72,
        'dca 1 / r3': 1.6,
        'dca 1 / l3': 0.45,
        'dca 1 / r4': 0.45,
        'dcw 2 / r1': 0.07,
        'dcw 2 / l1': 0.22,
        'dcw 2 / r2': 0.6,
        'dcw 2 / l2': 0.12,
        'dcw 2 / r3': 1.3,
        'dcw 2 / l3': 0,
        'dca 2 / r1': 0.04,
        'dca 2 / r2': 0.6,
        'dca 2 / l2': 0.48,
        'dca 2 / r3': 1.2,
        'dca 2 / l3': 0,
        'voice / vol': 0.71,
      },
      fx: {
        reason: 'A low-feedback 205 ms stereo reflection surrounds the native chorus and slow vibrato without inventing tape wow, another chorus stage or reverb.',
        delay: { time: 205, fb: 0.16, mix: 0.2, sync: 0, pingpong: 1, note: 0 },
      },
      role: 'Soft wavering chord keys, not a tine piano: double-sine body and a quiet detuned same-register saw replace the octave ping, with lower DCW peaks, softened attacks and a held first-line body. Use the selected voice allocation; avoid release stacks.',
      references: ['Boards of Canada', 'Broadcast', 'Toro y Moi', 'Casino Versus Japan'],
    },
  ],
  'Hera 4': [
    {
      name: 'Faded Organ',
      basedOn: 'Organ',
      moves: {
        'lfo / rate': 0.38,
        'lfo / delay time': 0.08,
        'dco / lfo': 0.0083,
        'dco / pwm': 0.25,
        'dco / sub': 0.16,
        'vcf / freq': 1700,
        'vcf / res': 0.04,
        'vcf / env': 0,
        'env / a': 0.014,
        'env / d': 0.1,
        'env / s': 1,
        'env / r': 0.075,
        'vca / level': 0.47,
      },
      fx: {
        reason: 'Deliberately dry: the retained native chorus II and newly slow low-depth DCO/PWM motion supply the wavering organ character without added external space.',
      },
      role: 'Dark wavering organ for held chord accompaniment: much less sub, a 1.7 kHz low-pass and slow pitch/pulse movement distinguish it from the bright steady Organ. Its short release is nominally 0.18 s because Hera scales decay/release rows by 2.4.',
      references: ['Beach House', 'Broadcast', 'Stereolab', 'John Maus'],
    },
  ],
  'Expander S': [
    {
      name: 'Dusk Chord',
      basedOn: 'SEM Brass',
      moves: {
        'voice / width': 0.55,
        'oscillators / vco 1 wave': 3,
        'oscillators / vco 1 pw': 0.38,
        'oscillators / vco 2 wave': 1,
        'oscillators / vco 2 fine': -4,
        'oscillators / vco 1': 0.38,
        'oscillators / vco 2': 0.24,
        'filter / cutoff': 1100,
        'filter / resonance': 0.2,
        'filter / bp': 2,
        'filter / env 1 amt': 0.1,
        'envelopes / a (1)': 0.09,
        'envelopes / d (1)': 0.45,
        'envelopes / s (1)': 0,
        'envelopes / a (2)': 0.045,
        'envelopes / d (2)': 0.75,
        'envelopes / s (2)': 0,
        'lfo / vibrato': 0,
        'output / level': 2,
      },
      fx: {
        reason: 'A slow shallow chorus and 270 ms answer turn finite band-pass chords into a soft rhythmic cloud; the short room remains subordinate to the keyed decay.',
        chorus: { rate: 0.22, depth: 0.3, mix: 0.24 },
        delay: { time: 270, fb: 0.23, mix: 0.21, sync: 0, pingpong: 0, note: 0 },
        reverb: { size: 0.35, damp: 0.8, mix: 0.14, pre: 15, mod: 0, freeze: 0 },
      },
      role: 'Short dreamy chord swells: band-pass rather than brass low-pass, pulse/triangle rather than two saws, and zero sustain in both envelopes. The amplifier decays after the filter, so held keys finish rather than becoming another long pad. Play detached three-note chords.',
      references: ['Washed Out', 'Neon Indian', 'Caribou', 'Hot Chip'],
    },
    {
      name: 'Velvet Bloom',
      basedOn: 'SEM Brass',
      moves: {
        'voice / width': 0.65,
        'oscillators / vco 1 wave': 1,
        'oscillators / vco 2 wave': 3,
        'oscillators / vco 2 pw': 0.43,
        'oscillators / vco 2 fine': -4,
        'oscillators / vco 1': 0.4,
        'oscillators / vco 2': 0.2,
        'filter / cutoff': 850,
        'filter / resonance': 0.12,
        'filter / mode': 0,
        'filter / bp': 1,
        'filter / env 1 amt': 0.1,
        'envelopes / a (1)': 1.35,
        'envelopes / d (1)': 1.4,
        'envelopes / s (1)': 0.45,
        'envelopes / a (2)': 0.65,
        'envelopes / d (2)': 1.8,
        'envelopes / s (2)': 0.78,
        'lfo / vibrato': 0,
        'output / level': 0.85,
      },
      fx: {
        reason: 'Slow deep chorus and a dark diffuse hall spread the triangle-led bloom, with no drive or tempo repeats. The delayed filter opening remains the core movement.',
        chorus: { rate: 0.17, depth: 0.55, mix: 0.35 },
        reverb: { size: 0.64, damp: 0.8, mix: 0.25, pre: 18, mod: 0, freeze: 0 },
      },
      role: 'Long low-partial accompaniment distinct from Notch Strings: triangle plus quiet pulse through low-pass, no native vibrato, and brightness rising after the amplitude. Three-note voicings and deliberate releases suit the selected allocation; it is not a polyphony expansion.',
      references: ['Beach House', "You'll Never Get to Heaven", 'Belong', 'Jefre Cantu-Ledesma'],
    },
  ],
  'Monolith D': [
    {
      name: 'Low Pillow',
      basedOn: 'Fat Bass',
      moves: {
        'controllers / glide': 0.035,
        'controllers / glide on': 1,
        'controllers / decay on': 1,
        'oscillators / osc 1 wave': 1,
        'oscillators / osc 2 range': 3,
        'oscillators / osc 2 wave': 1,
        'oscillators / osc 2 fine': 0,
        'mixer / osc 1': 0.58,
        'mixer / osc 2': 0.14,
        'mixer / osc 3': 0,
        'mixer / noise': 0,
        'filter / cutoff': 420,
        'filter / emphasis': 0.08,
        'filter / contour': 0.55,
        'filter / kbd control': 2,
        'filter / filter mod': 1,
        'contours / attack (1)': 0.008,
        'contours / decay (1)': 0.66,
        'contours / sustain (1)': 0.45,
        'contours / attack (2)': 0.012,
        'contours / decay (2)': 0.69,
        'contours / sustain (2)': 0.78,
        'output / volume': 0.84,
      },
      fx: {
        reason: 'Deliberately dry: two clean triangle registers supply a soft sustained foundation, contrasting with the saturated saw basses and transient-led Rhea pluck.',
      },
      role: 'Rounded low-partial bass with a soft onset and steady held body: 32-foot triangle plus subordinate 16-foot triangle, little resonance, modest contour and no detuning. Short releases leave space for electronic drums. Start MIDI 48-67; not a sampled upright bass.',
      references: ['James Blake', 'Clams Casino', 'Tycho'],
    },
    {
      name: 'Velour Lead',
      basedOn: 'Soft Flute',
      moves: {
        'controllers / glide': 0.13,
        'controllers / glide on': 2,
        'oscillators / osc 1 wave': 5,
        'oscillators / osc 3 fine': 0,
        'mixer / osc 1': 0.48,
        'mixer / osc 2': 0,
        'mixer / osc 3': 0.08,
        'filter / cutoff': 1800,
        'filter / emphasis': 0.15,
        'filter / contour': -0.55,
        'filter / filter mod': 1,
        'contours / attack (1)': 0.18,
        'contours / decay (1)': 0.76,
        'contours / sustain (1)': 0.4,
        'contours / attack (2)': 0.025,
        'contours / decay (2)': 0.72,
        'contours / sustain (2)': 0.85,
        'output / volume': 0.48,
      },
      fx: {
        reason: 'Slow deep chorus gives the restrained pulse line its wavering edge; a soft 305 ms answer and small dark room frame a melody without adding abrasive drive.',
        chorus: { rate: 0.23, depth: 0.6, mix: 0.36 },
        delay: { time: 305, fb: 0.2, mix: 0.2, sync: 0, pingpong: 0, note: 0 },
        reverb: { size: 0.32, damp: 0.78, mix: 0.11, pre: 18, mod: 0, freeze: 0 },
      },
      role: 'Soft gliding wide-pulse melody with a quiet octave triangle and a delayed darkening filter contour. Unlike Soft Flute it has pulse harmonics and glide; unlike Hollow Reed it has no breath noise; unlike Wheel Furnace it has no fixed fifth or wheel-filter route. Play overlapping MIDI 55-79.',
      references: ['Black Moth Super Rainbow', 'Tobacco', 'Neon Indian', 'Ariel Pink'],
    },
  ],
  'Wanderer': [
    {
      name: 'Paper Rain',
      basedOn: 'Pink Breath',
      moves: {
        'mixer / noise': 1,
        'mixer / noise/ring': 0.24,
        'filters · vca / vcf freq': 3100,
        'filters · vca / resonance': 0.22,
        'filters · vca / mod 1': 0,
        'filters · vca / mod 2': 0,
        'filters · vca / mod 3': 0,
        'filters · vca / hpf': 1800,
        'filters · vca / vca level': 4,
        'lfo · s/h / lfo freq': 2.7,
        'envelopes / attack': 0.002,
        'envelopes / release': 0.045,
        'envelopes / ar trig': 2,
        'envelopes / repeat': 1,
      },
      fx: {
        reason: 'Short stereo reflections and a dark diffuse tail stretch keyed white-noise flecks into a texture while the next dry pulse stays audible. No freeze or feedback swell.',
        delay: { time: 113, fb: 0.25, mix: 0.27, sync: 0, pingpong: 1, note: 0 },
        reverb: { size: 0.63, damp: 0.82, mix: 0.24, pre: 8, mod: 0, freeze: 0 },
      },
      role: 'Key-held rhythmic noise texture: band-limited white noise with a fast AR repeatedly gated by the 2.7 Hz LFO replaces Pink Breath\'s slow pink swell. This is synthetic pulsed noise, not a rain recording, vinyl crackle, granular sampler or automatically randomized rhythm.',
      references: ['Burial', 'Tim Hecker', 'Oneohtrix Point Never', 'Animal Collective'],
    },
  ],
};
