// SPDX-License-Identifier: GPL-3.0-only
// Hand-written maps for user presets when a factory engine was rebuilt (#627, D-865): which rows of an earlier structure
// feed which rows of the next one, where the automatic map (scripts/lineage-lib.ts: a row that is still there keeps its
// value, a new row takes the engine's Init value) does not cover the change. A structure change whose automatic map
// leaves an earlier row out needs an entry here: a map, or `none` (the presets of that structure stay as they are). The
// tests fail until it has one. Rows are named as in src/preset-lineage.json: type#id.param, in the structure they belong
// to. A row of the newer structure not named here is matched automatically, or takes the Init value.
import { RATIOS } from './modules';

/** how one row of the newer structure gets its value: from one earlier row as it is; from one or two earlier rows read as
 * whole numbers through a table (the value at place (a - lo[0]) * n[1] + (b - lo[1]), each held inside its n places);
 * from one earlier row through a line, x * mul + add, held inside min .. max (`key`: a second earlier row read as a whole
 * number picks the line, place key - lo held inside the lines; without it there is one line); or the engine's Init value */
export type HandRow = 'init' | { from: string } | { table: string[]; lo: number[]; n: number[]; v: number[] }
  | { line: string; key?: string; lo?: number; mul: number[]; add: number[]; min: number; max: number };
export type HandMap =
  | { engine: string; from: string; to: string; why: string; rows: Record<string, HandRow> }
  | { engine: string; from: string; to: string; none: string };

/** Algo Four (#658): an oscillator's coarse (semitones, from -12: lower lands on 0.50) to the Ratio position nearest to it
 * (log distance), and its fine (cents, -4..4: beyond lands on the end) to the nearest DETUNE position (2.6 / 3 cents each) */
const COARSE_LO = -12;
const COARSE_TO_RATIO = Array.from({ length: 61 }, (_, k) => {
  const want = Math.log2(2 ** ((COARSE_LO + k) / 12));
  // 45 st is operator 4's Init, which had a fine of +70 cents with it: 14.00, as Init is now
  if (COARSE_LO + k === 45) return RATIOS.indexOf(14);
  return RATIOS.reduce((best, r, i) => (Math.abs(Math.log2(r) - want) < Math.abs(Math.log2(RATIOS[best]) - want) ? i : best), 0);
});
const FINE_TO_DETUNE = Array.from({ length: 9 }, (_, k) => Math.max(0, Math.min(6, Math.round((k - 4) / (2.6 / 3)) + 3)));
/** Oracle V's structure in 1.11 (#658) */
const ORACLE_1_11 = '6282b61f';
/** 8 Lire's structure in 1.11 (#658) */
const LIRE_1_11 = '0935c0fa';

/** the positions 1..8 of an eight-way Selector from a number 0..7 */
const ONE_UP = [1, 2, 3, 4, 5, 6, 7, 8];

export const HAND_MAPS: HandMap[] = [
  {
    engine: 'Verona Drum 1', from: 'db9de761', to: '7bd94d43',
    why: 'issue #782: MASTER controls both stereo output amplifiers at the same value; PAN starts centered',
    rows: { 'macro#3.value': { from: 'mixer#3.l1' } },
  },
  // ---- the whole TR-808 (D-1053): every row of the eight-voice card keeps its value but the low tom's TUNING, which was
  // its body's coarse tune (semitones) and is now the TR-808's TUNING knob, a Macro over seven semitones either way of
  // the body's -12 (a tuning further out lands on the knob's end). The open hihat's DECAY is named, as the cymbal's
  // DECAY (an envelope's r3 too) would otherwise take it. The new voices, switches, ACCENT and PRE-SCALE start at Init.
  {
    engine: '808 kit', from: 'b3d5b969', to: '5609dff3',
    why: 'D-1053: the whole TR-808; the low tom\'s tuning on its ±7-semitone knob',
    rows: {
      'macro#13.value': { line: 'modal#42.coarse', mul: [1 / 14], add: [19 / 14], min: 0, max: 1 },
      'env#55.r3': { from: 'env#35.r3' }, 'env#103.r3': 'init',
    },
  },
  // ---- the whole DRM1 MKIV (D-899): each row of the six-channel card goes to the same channel's row of the same label
  // (HI HAT is HI HAT 1); the duplicated drum and hat modules would otherwise pair with the wrong channel. The snare's NOISE
  // and REVERB were its envelopes' peaks with one VCA at 1 and are now their VCAs' gains: the same number. MULTI's PITCH 2
  // / 3 were the oscillators' coarse tune (semitones, PITCH's 19 its middle) and are now octaves below PITCH. DRUM 2, HI
  // HAT 2, the TRIG switches and NOISE COLOR start at Init.
  {
    engine: 'Verona Drum 1', from: '7bd94d43', to: 'ad27b323',
    why: 'D-899: the whole DRM1 MKIV; rows by channel and label',
    rows: {
      'env#8.r2': { from: 'env#8.r2' }, 'osc#4.coarse': { from: 'osc#4.coarse' }, 'scale#6.gain': { from: 'scale#6.gain' }, 'env#5.r2': { from: 'env#5.r2' },
      'shape#7.drive': { from: 'shape#7.drive' }, 'vca#11.gain': { from: 'vca#10.gain' }, 'env#12.l1': { from: 'env#11.l1' }, 'pan#96.pan': { from: 'pan#60.pan' },
      'vca#13.gain': { from: 'vca#12.gain' }, 'env#17.r2': { from: 'env#16.r2' }, 'osc#14.coarse': { from: 'osc#13.coarse' }, 'scale#18.gain': { from: 'scale#17.gain' },
      'env#21.l1': { from: 'env#20.l1' }, 'scale#16.gain': { from: 'scale#15.gain' }, 'osc#15.coarse': { from: 'osc#14.coarse' }, 'shape#19.drive': { from: 'shape#18.drive' },
      'pan#97.pan': { from: 'pan#61.pan' }, 'vca#22.gain': { from: 'vca#21.gain' }, 'env#23.r2': { from: 'env#22.r2' }, 'scale#24.offset': { from: 'scale#23.offset' },
      'scale#24.gain': { from: 'scale#23.gain' }, 'env#35.l1': { from: 'env#28.l1' }, 'filter#36.cutoff': { from: 'filter#29.cutoff' }, 'pan#99.pan': { from: 'pan#62.pan' },
      'vca#37.gain': { from: 'vca#30.gain' }, 'env#40.r2': { from: 'env#33.r2' }, 'vca#41.gain': { from: 'env#33.l1' }, 'env#38.r2': { from: 'env#31.r2' },
      'vca#39.gain': { from: 'env#31.l1' }, 'env#42.l1': { from: 'env#34.l1' }, 'filter#43.res': { from: 'filter#35.res' }, 'filter#43.cutoff': { from: 'filter#35.cutoff' },
      'pan#100.pan': { from: 'pan#63.pan' }, 'vca#44.gain': { from: 'vca#36.gain' }, 'env#48.r3': { from: 'env#40.r3' }, 'filter#51.cutoff': { from: 'filter#43.cutoff' },
      'scale#50.gain': { from: 'scale#42.gain' }, 'env#49.l1': { from: 'env#41.l1' }, 'filter#51.res': { from: 'filter#43.res' }, 'xfade#46.mix': { from: 'xfade#38.mix' },
      'osc#45.coarse': { from: 'osc#37.coarse' }, 'pan#101.pan': { from: 'pan#64.pan' }, 'vca#54.gain': { from: 'vca#46.gain' }, 'env#66.r2': { from: 'env#54.r2' },
      'vca#67.gain': { from: 'vca#55.gain' }, 'lfo#60.wide': { from: 'lfo#49.wide' }, 'vca#65.gain': { from: 'vca#53.gain' }, 'filter#68.res': { from: 'filter#56.res' },
      'filter#68.cutoff': { from: 'filter#56.cutoff' }, 'pan#103.pan': { from: 'pan#65.pan' }, 'vca#69.gain': { from: 'vca#57.gain' }, 'macro#2.value': { from: 'macro#3.value' },
      'const#28.value': { line: 'osc#26.coarse', mul: [1 / 12], add: [-19 / 12], min: -4, max: 4 },
      'const#32.value': { line: 'osc#27.coarse', mul: [1 / 12], add: [-19 / 12], min: -4, max: 4 },
      // DRUM 2, HI HAT 2, the TRIG switches and NOISE COLOR: Init (not a copy of the pair's old values)
      'env#73.r2': 'init', 'osc#70.coarse': 'init', 'scale#74.gain': 'init', 'env#77.l1': 'init', 'scale#72.gain': 'init', 'osc#71.coarse': 'init',
      'shape#75.drive': 'init', 'pan#98.pan': 'init', 'vca#78.gain': 'init', 'select#57.pos': 'init', 'env#82.r3': 'init', 'filter#85.cutoff': 'init',
      'scale#84.gain': 'init', 'env#83.l1': 'init', 'filter#85.res': 'init', 'xfade#80.mix': 'init', 'osc#79.coarse': 'init', 'select#91.pos': 'init',
      'pan#102.pan': 'init', 'vca#88.gain': 'init', 'noise#64.color': 'init',
    },
  },
  // ---- the whole NOON (D-1054): each channel's pitch, second slider and volume go to its `main`, `secondary` and `volume`
  // (DOT's and BACID's Ladder cutoff and resonance are now their Multimode's, the same numbers). CYMPATH's pitch was its
  // oscillator's coarse tune and is now the main slider's Macro, -10 .. +40 semitones over 0 .. 1. A one-way LINK amount
  // above 0 turns its button on (8-1 is 8>1); at 0 or below (a ducking link) it stays off. `main` is `main volume`, the
  // same number. The odd and even CV rows have no row now (nor the CV mute buttons); MOD, mute and 1>8 start at Init.
  {
    engine: 'Meridian 8', from: 'dfc4cd9c', to: 'bef10cad',
    why: 'D-1054: the whole NOON; rows by channel',
    rows: {
      'osc#23.coarse': { from: 'osc#10.coarse' }, 'filter#24.cutoff': { from: 'ladder#11.cutoff' }, 'vca#21.gain': { from: 'vca#9.gain' },
      'osc#32.coarse': { from: 'osc#14.coarse' }, 'scale#33.gain': { from: 'scale#15.gain' }, 'vca#30.gain': { from: 'vca#13.gain' },
      'modal#44.coarse': { from: 'modal#20.coarse' }, 'modal#44.struct': { from: 'modal#20.struct' }, 'vca#40.gain': { from: 'vca#17.gain' },
      'comb#54.coarse': { from: 'comb#24.coarse' }, 'comb#54.fb': { from: 'comb#24.fb' }, 'vca#51.gain': { from: 'vca#22.gain' },
      'macro#64.value': { line: 'osc#27.coarse', mul: [1 / 50], add: [10 / 50], min: 0, max: 1 },
      'crush#67.rate': { from: 'crush#28.rate' }, 'vca#61.gain': { from: 'vca#26.gain' },
      'osc#75.coarse': { from: 'osc#31.coarse' }, 'scale#76.gain': { from: 'scale#32.gain' }, 'vca#73.gain': { from: 'vca#30.gain' },
      'osc#85.coarse': { from: 'osc#35.coarse' }, 'vowel#86.vowel': { from: 'vowel#36.vowel' }, 'vca#83.gain': { from: 'vca#34.gain' },
      'osc#95.coarse': { from: 'osc#39.coarse' }, 'filter#96.res': { from: 'ladder#40.res' }, 'vca#93.gain': { from: 'vca#38.gain' },
      'select#5.pos': { line: 'scale#41.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#107.pos': { line: 'scale#42.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#108.pos': { line: 'scale#43.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#109.pos': { line: 'scale#44.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#110.pos': { line: 'scale#45.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#111.pos': { line: 'scale#46.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#112.pos': { line: 'scale#47.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'select#113.pos': { line: 'scale#48.gain', mul: [1000], add: [1], min: 1, max: 2 },
      'shape#8.level+shape#9.level': { from: 'macro#6.value' },
    },
  },
  // ---- 1.5.0 (#430's predecessors): the FM-1 instruments rebuilt at parity with their originals. Their 1.2 .. 1.4
  // structures had other modules and rows altogether: no map.
  ...([
    ['Briefcase 3', '06ea3383', 'cf5034d5'], ['Canvas', 'b708700b', '5ae3f8ec'], ['Io 4', '6573011a', 'bcfb20df'],
    ['Monolith D', '404a1620', '44089bcc'], ['Sallen 20', '52587cb7', '2db4c1e1'], ['Silver Box', 'e18a8dd2', '105fd470'],
    ['Vernon 100', '00c036a8', '41211a52'], ['Wanderer', '1486a89e', '2700d0b6'],
  ] as const).map(([engine, from, to]): HandMap => ({ engine, from, to, none: 'rebuilt in 1.5.0 from the original\'s panel: other modules and rows' })),

  // ---- 1.7.0, D-852: the hold and drone rows are Macros, not Consts. The number that reaches the voice at a row value is
  // the same, so the value carries over as it is.
  {
    engine: '8 Lire', from: 'd34140e9', to: '15c37cee', why: 'D-852: the hold rows became Macros (same value)',
    rows: { 'macro#41.value': { from: 'const#41.value' }, 'macro#42.value': { from: 'const#42.value' } },
  },
  {
    engine: 'Elvira 2', from: '90b55ac5', to: '2596beed', why: 'D-852: the drone rows became Macros (same value)',
    rows: {
      'macro#9.value': { from: 'const#9.value' }, 'macro#14.value': { from: 'const#14.value' },
      'macro#19.value': { from: 'const#19.value' }, 'macro#24.value': { from: 'const#24.value' },
    },
  },

  // ---- 1.7.0, issue #430 (D-706): Cassia 1's line controls follow the CZ-1's. A line's wave was a number 0..7 (saw ..
  // reso 3) and is now a Selector at that position + 1; wave 2 was 0..8 (off, saw .. reso 3) and is now a Selector of off
  // and seven waveforms (reso 3 is left out: it lands on reso 2). The line row (1, 2, 1+2') and the 1+1' switch are one
  // Selector: 1, 2, 1+1', 1+2'. The ring and noise switches (each 1 off, 2 on; noise after ring) are one mod row: 1 off,
  // 2 ring, 3 noise.
  {
    engine: 'Cassia 1', from: '62d178d5', to: '2b89b424', why: 'issue #430: the waves, line and modulation became Selectors',
    rows: {
      'select#10.pos': { table: ['const#10.value'], lo: [0], n: [8], v: ONE_UP },
      'select#13.pos': { table: ['const#13.value'], lo: [0], n: [8], v: ONE_UP },
      'select#11.pos': { table: ['const#11.value'], lo: [0], n: [8], v: ONE_UP },
      'select#14.pos': { table: ['const#14.value'], lo: [0], n: [8], v: ONE_UP },
      // line 1, 2, 1+2' (old) by 1+1' off, on: 1, 2, 1+1' (3), 1+2' (4)
      'select#9.pos': { table: ['select#43.pos', 'const#9.value'], lo: [1, 0], n: [3, 2], v: [1, 1, 2, 2, 4, 3] },
      // ring off, on by noise off, on: noise wins (it comes after the ring)
      'select#37.pos': { table: ['select#40.pos', 'select#42.pos'], lo: [1, 1], n: [2, 2], v: [1, 3, 2, 3] },
    },
  },

  // ---- 1.11, issue #681: Io 4's KEY ASSIGNMENT is one Selector (POLY I, POLY II, UNISON I, UNISON II) whose cables set
  // the Voicing's assign and unison, where it was the Voicing's assign row (rotate, lowest, reuse, reset) and unison row
  // (off, on, share). Unison on is UNISON I and share UNISON II, whatever the assign; with unison off, lowest is POLY II
  // and the other assign modes (rotate, and reuse and reset, which the JP-4 has not got) are POLY I.
  {
    engine: 'Io 4', from: 'bcfb20df', to: '908f8d0d', why: 'issue #681: the assign and unison rows became one key assign switch',
    rows: {
      'select#55.pos': { table: ['alloc#1.assign', 'alloc#1.unison'], lo: [0, 0], n: [4, 3], v: [1, 3, 4, 2, 3, 4, 1, 3, 4, 1, 3, 4] },
    },
  },

  // ---- 1.11, issue #658: Algo Four plays the DX100's eight algorithms with eight voices, an operator's pitch is a Ratio
  // (the DX100's 64 frequency ratios and seven DETUNE positions) where it was the oscillator's coarse (semitones) and fine
  // (cents), and one volume row after the voices takes the two stack mix rows' place. A coarse value lands on the ratio
  // nearest to it (below 0.50: 0.50; 45, Init's, on 14.00); a fine value on the DETUNE position nearest to it (0.87 cents a position; beyond
  // +-2.6 cents: +-3). The volume takes stack 1→2 mix's value. The index rows of operators 1 and 3 keep theirs.
  {
    engine: 'Algo Four', from: '666a5214', to: '2e17ed93', why: 'issue #658: algorithms, the DX100 ratio table, one volume row',
    rows: {
      'osc#2.pm': { from: 'osc#2.pm' },
      'osc#10.pm': { from: 'osc#8.pm' },
      'osc#14.fb': { from: 'osc#11.fb' },
      'mixer#25.l1': { from: 'mixer#14.l1' },
      ...Object.fromEntries(([['ratio#5', 'osc#2'], ['ratio#9', 'osc#5'], ['ratio#13', 'osc#8'], ['ratio#17', 'osc#11']] as const).flatMap(([to, from]) => [
        [`${to}.ratio`, { table: [`${from}.coarse`], lo: [COARSE_LO], n: [COARSE_TO_RATIO.length], v: COARSE_TO_RATIO }],
        [`${to}.detune`, { table: [`${from}.fine`], lo: [-4], n: [9], v: FINE_TO_DETUNE }],
      ])),
    },
  },

  // ---- 1.11, issue #658: Oracle V gets the Prophet-5's functions its FM-1 version had cut. Oscillator A's wave became its
  // SAW and PULSE switches (square: pulse only; any other wave: saw only), B's its SAW, TRI and PULSE (sine and triangle:
  // tri; square: pulse; the others: saw), the LFO's wave its SAW, TRI and SQUARE (sine, triangle, S&H and random: tri). The
  // A, B and noise levels moved to the mixer, the envelope amount from the filter to its own row, the vibrato to Wheel-Mod's
  // freq A and freq B. Poly Mod's filter envelope amount keeps its value; its osc B amount (a phase-modulation index
  // before, a frequency amount now) starts at Init.
  {
    engine: 'Oracle V', from: '7a7a26f6', to: ORACLE_1_11, why: 'issue #658: the Prophet-5 functions the FM-1 version had cut',
    rows: {
      ...Object.fromEntries(['adsr#11', 'adsr#13'].flatMap((m) => ['a', 'd', 's', 'r', 'view'].map((q) => [`${m}.${q}`, { from: `${m}.${q}` }]))),
      ...Object.fromEntries(['alloc#5.voices', 'alloc#5.unison', 'glide#6.time', 'ladder#12.cutoff', 'ladder#12.res', 'ladder#12.track', 'lfo#1.rate',
        'osc#7.coarse', 'osc#7.fine', 'scale#10.gain', 'scale#9.gain', 'scale#3.gain', 'vca#14.gain', 'scope#15.view', 'scope#16.view', 'scope#17.view']
        .map((r) => [r, { from: r }])),
      'mixer#31.l1': { from: 'osc#8.level' },
      'mixer#31.l2': { from: 'osc#7.level' },
      'mixer#31.l3': { from: 'noise#4.level' },
      'scale#20.offset': { from: 'osc#8.pw' },
      'scale#40.gain': { from: 'ladder#12.cvamt' },
      'scale#52.gain': { from: 'scale#3.gain' },
      // the wave switches (1 OFF, 2 ON) from the waves (osc: sine, triangle, saw, square, sharktooth, reverse saw; LFO: sine,
      // triangle, saw, square, S&H, random)
      'select#24.pos': { table: ['osc#8.wave'], lo: [0], n: [6], v: [2, 2, 2, 1, 2, 2] },
      'select#25.pos': { table: ['osc#8.wave'], lo: [0], n: [6], v: [1, 1, 1, 2, 1, 1] },
      'select#28.pos': { table: ['osc#7.wave'], lo: [0], n: [6], v: [1, 1, 2, 1, 2, 2] },
      'select#29.pos': { table: ['osc#7.wave'], lo: [0], n: [6], v: [2, 2, 1, 1, 1, 1] },
      'select#30.pos': { table: ['osc#7.wave'], lo: [0], n: [6], v: [1, 1, 1, 2, 1, 1] },
      'select#47.pos': { table: ['lfo#1.wave'], lo: [0], n: [6], v: [1, 1, 2, 1, 1, 1] },
      'select#48.pos': { table: ['lfo#1.wave'], lo: [0], n: [6], v: [2, 2, 1, 1, 2, 2] },
      'select#49.pos': { table: ['lfo#1.wave'], lo: [0], n: [6], v: [1, 1, 1, 2, 1, 1] },
    },
  },
  // ---- 1.11: Wanderer XL took Wanderer's slot (D-348): each VCO plays its saw and its pulse at once, the mixer's wave
  // switches pick one, and the rows moved to other modules. A row keeps its value where it is the same control; a VCO's
  // wave (sine, triangle, saw, square, sharktooth, reverse saw) becomes its switch (square: SQUARE, the others: SAW); the
  // noise colour (0 white, 1 pink) its WHITE / PINK switch. Coarse (semitones before, octaves now) and fine (cents before)
  // start at Init: the new rows are no whole numbers of the old ones.
  {
    engine: 'Wanderer', from: '2700d0b6', to: '9133c74f', why: 'Wanderer XL took the slot (D-348): two oscillators a VCO',
    rows: {
      'select#10.pos': { from: 'select#9.pos' }, 'math#14.ka': { from: 'math#12.ka' },
      'select#12.pos': { from: 'select#10.pos' }, 'math#14.kb': { from: 'math#12.kb' },
      'select#13.pos': { from: 'select#11.pos' }, 'osc#18.pw': { from: 'osc#15.pw' },
      'scale#16.gain': { from: 'scale#14.gain' }, 'select#15.pos': { from: 'select#13.pos' },
      'select#25.pos': { from: 'select#21.pos' }, 'math#22.ka': { from: 'math#18.ka' },
      'select#20.pos': { from: 'select#16.pos' }, 'math#22.kb': { from: 'math#18.kb' },
      'select#21.pos': { from: 'select#17.pos' }, 'osc#27.pw': { from: 'osc#22.pw' },
      'scale#24.gain': { from: 'scale#20.gain' }, 'select#23.pos': { from: 'select#19.pos' },
      'lfo#8.rate': { from: 'lfo#8.rate' }, 'math#32.ka': { from: 'math#25.ka' }, 'math#32.kb': { from: 'math#25.kb' },
      'select#31.pos': { from: 'select#24.pos' }, 'select#33.pos': { from: 'select#26.pos' },
      'glide#35.time': { from: 'glide#28.time' }, 'macro#4.value': { from: 'macro#4.value' },
      'mixer#41.l1': { from: 'mixer#31.l1' }, 'mixer#41.l2': { from: 'mixer#31.l2' },
      'mixer#41.l3': { from: 'mixer#31.l3' }, 'select#40.pos': { from: 'select#30.pos' },
      'ladder#46.cutoff': { from: 'ladder#36.cutoff' }, 'ladder#46.res': { from: 'ladder#36.res' },
      'mixer#45.l1': { from: 'mixer#35.l1' }, 'select#42.pos': { from: 'select#32.pos' },
      'mixer#45.l2': { from: 'mixer#35.l2' }, 'select#43.pos': { from: 'select#33.pos' },
      'mixer#45.l3': { from: 'mixer#35.l3' }, 'select#44.pos': { from: 'select#34.pos' },
      'filter#47.cutoff': { from: 'filter#37.cutoff' }, 'select#48.pos': { from: 'select#38.pos' },
      'scale#49.gain': { from: 'scale#39.gain' }, 'scale#49.offset': { from: 'scale#39.offset' },
      'adsr#52.view': { from: 'adsr#42.view' }, 'adsr#52.a': { from: 'adsr#42.a' }, 'adsr#52.r': { from: 'adsr#42.r' },
      'select#55.pos': { from: 'select#46.pos' }, 'adsr#51.view': { from: 'adsr#41.view' },
      'adsr#51.a': { from: 'adsr#41.a' }, 'adsr#51.d': { from: 'adsr#41.d' }, 'adsr#51.s': { from: 'adsr#41.s' },
      'adsr#51.r': { from: 'adsr#41.r' }, 'select#54.pos': { from: 'select#45.pos' },
      'select#53.pos': { from: 'select#44.pos' }, 'scope#56.view': { from: 'scope#47.view' },
      'select#38.pos': { table: ['osc#15.wave'], lo: [0], n: [6], v: [1, 1, 1, 2, 1, 1] },
      'select#39.pos': { table: ['osc#22.wave'], lo: [0], n: [6], v: [1, 1, 1, 2, 1, 1] },
      'select#29.pos': { table: ['noise#23.color'], lo: [0], n: [2], v: [1, 2] },
    },
  },

  // ---- 1.11: Hera 4 took Hera 6's slot with Hera 6 XL's Juno-106 panel at five voices (owner ruling 2026-11-07). The
  // Ladder became a Multimode filter (cutoff and resonance keep their values), the filter's envelope amount and key follow
  // moved to their own rows, the PWM depth to the PWM slider; the DCO's wave (sine, triangle, saw, square, sharktooth,
  // reverse saw) became its PULSE and SAW switches (square: pulse only; the others: saw only). The envelope's times keep
  // their numbers on the ADSR's long range, so they run 2.4 times longer. The chorus switch, the HPF's four positions and
  // the rest start at Init.
  {
    engine: 'Hera 4', from: '7ec3be68', to: '24fe2e10', why: 'Hera 4 took the slot (owner ruling 2026-11-07): the Juno-106 panel',
    rows: {
      'filter#9.cutoff': { from: 'ladder#9.cutoff' }, 'filter#9.res': { from: 'ladder#9.res' }, 'scale#32.gain': { from: 'ladder#9.cvamt' },
      'scale#36.gain': { from: 'ladder#9.track' }, 'macro#45.value': { from: 'scale#3.gain' },
      'select#29.pos': { table: ['osc#7.wave'], lo: [0], n: [6], v: [1, 1, 1, 2, 1, 1] },
      'select#31.pos': { table: ['osc#7.wave'], lo: [0], n: [6], v: [2, 2, 2, 1, 2, 2] },
    },
  },

  // ---- 1.11, issue #658: 8 Lire follows the Lyra-8's manual (8 Lire XL's build): each pair's FM source switch (FM, OFF,
  // LFO) where each group had a bus of levels (the other group, the LFO, the delay's output), the structure switch, TOTAL
  // FB and LINK, two delay lines (TIME 1 / 2, MOD 1 / 2, SELF / LFO, TRIANGLE / SQUARE, FB, MIX), the distortion's MIX
  // and VOL. A pair's source is LFO when its group's bus took the LFO or the delay's output, else FM; TOTAL FB is on when
  // group 1-4 took the delay's output. The delay's time is TIME 1 and its LFO depth both MODs; its feedback is FB; VOL
  // takes the old output level; AND / OR from the old crossfade (0 AND, 1 OR).
  {
    engine: '8 Lire', from: '24f65535', to: LIRE_1_11, why: 'issue #658: the Lyra-8 manual\'s switches, two delay lines, distortion mix',
    rows: {
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
        [`osc#${34 + 3 * i}.coarse`, { from: `osc#${12 + 3 * i}.coarse` }], [`osc#${34 + 3 * i}.fine`, { from: `osc#${12 + 3 * i}.fine` }],
        [`adsr#${35 + 3 * i}.a`, { from: `adsr#${13 + 3 * i}.a` }], [`adsr#${35 + 3 * i}.r`, { from: `adsr#${13 + 3 * i}.r` }],
      ]).flat()),
      'macro#62.value': { from: 'macro#42.value' },
      'macro#63.value': { from: 'macro#43.value' },
      ...Object.fromEntries([0, 1, 2, 3].flatMap((p) => [[`scale#${30 + p}.gain`, { from: `scale#${8 + p}.gain` }], [`shape#${58 + p}.drive`, { from: `shape#${36 + p}.drive` }]])),
      ...Object.fromEntries([0, 1, 2, 3].map((p) => {
        const bus = p < 2 ? 'mixer#40' : 'mixer#41';
        return [`select#${26 + p}.pos`, { table: [`${bus}.l2`, `${bus}.l3`], lo: [0, 0], n: [2, 2], v: [1, 3, 3, 3] }];
      })),
      'select#10.pos': { table: ['mixer#40.l3'], lo: [0], n: [2], v: [1, 2] },
      'lfo#2.rate': { from: 'lfo#2.rate' },
      'lfo#3.rate': { from: 'lfo#3.rate' },
      'select#7.pos': { table: ['xfade#5.mix'], lo: [0], n: [2], v: [1, 2] },
      'delay#12.time': { from: 'delay#7.time' },
      'scale#13.gain+scale#19.gain': { from: 'delay#7.fb' },
      'xfade#68.mix': { from: 'delay#7.mix' },
      'scale#17.gain': { from: 'scale#6.gain' },
      'scale#23.gain': { from: 'scale#6.gain' },
      'shape#69.drive': { from: 'shape#47.drive' },
      'mixer#71.l1': { from: 'shape#47.level' },
      'scope#72.view': { from: 'scope#48.view' },
    },
  },
  // ---- 1.11, D-348: Canvas is Canvas XL's design (the owner, 2026-11-07: "Canvas XL replaces Canvas in its factory slot →
  // Yes"). The mod osc's frequency was the Oscillator's coarse (semitones above the keys; - high played as + hi, low five
  // octaves down) and is now a 0..1 dial over each range: + hi 5 x dial - 2.25 octaves, - high 2.75 - 5 x dial, low
  // 8 x dial - 10.25. The value lands where it plays the same pitch (held inside 0..1). Both fine tunes were the
  // Oscillators' fine (cents) and are now half an octave on a 0..1 knob, 0.5 in tune. The patch field's inputs start as the
  // fixed patch was wired, so every other row keeps its value.
  {
    engine: 'Canvas', from: '5ae3f8ec', to: '24a7a8f1', why: 'D-348: Canvas XL\'s frequency dial and half-octave fine tunes',
    rows: {
      'macro#55.value': { line: 'osc#19.coarse', key: 'select#18.pos', lo: 1, mul: [-1 / 60, 1 / 60, 1 / 96], add: [0.55, 0.45, 0.65625], min: 0, max: 1 },
      'macro#59.value': { line: 'osc#19.fine', mul: [1 / 600], add: [0.5], min: 0, max: 1 },
      'macro#61.value': { line: 'osc#26.fine', mul: [1 / 600], add: [0.5], min: 0, max: 1 },
    },
  },
  // ---- D-745 amended (2026-11-14): Expander S's envelopes are the SEM's ADS, the decay also the release, so the two
  // release rows went. Every other row keeps its value; the old releases have no row to go to.
  { engine: 'Expander S', from: '81f409f6', to: 'b3a433a3', why: 'D-745: the SEM\'s ADS envelopes: the release rows went', rows: {} },
  // ---- D-1052: Briefcase 3 is Briefcase 3 XL's design with its pins on Matrix tiles beside it. An oscillator's
  // frequency was its column's offset (octaves) and is now its dial, 1.875 octaves a unit from -1.5 (oscillator 3: -2.56):
  // the value lands where it plays the same pitch. Filter 1 and 2 were each output filter's morph (low pass to high pass)
  // and are now its knob (flat at 0.5, darker left, thinner right): the number carries over. Every other row keeps its
  // value; pan 1, pan 2, range x and range y start at Init. The pins were never in a preset.
  {
    engine: 'Briefcase 3', from: 'cf5034d5', to: 'b44a8aec', why: 'D-1052: the frequency dials and the output filter knobs',
    rows: {
      'const#33.value': { line: 'scale#8.offset', mul: [1 / 1.875], add: [1.5 / 1.875], min: -4, max: 4 },
      'const#35.value': { line: 'scale#9.offset', mul: [1 / 1.875], add: [1.5 / 1.875], min: -4, max: 4 },
      'const#37.value': { line: 'scale#10.offset', mul: [1 / 1.875], add: [2.56 / 1.875], min: -4, max: 4 },
      'macro#40.value': { from: 'filter#26.morph' }, 'macro#45.value': { from: 'filter#29.morph' },
    },
  },
];
