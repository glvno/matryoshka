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
 * or the engine's Init value */
export type HandRow = 'init' | { from: string } | { table: string[]; lo: number[]; n: number[]; v: number[] };
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
];
