// SPDX-License-Identifier: GPL-3.0-only
// What each module output carries, in numbers (#518): the range of its signal, said in the editor's jack and cable
// tooltips and on a Scope's readout. Editor only: nothing here reaches the engines or the FM-1. An output whose range
// follows its parameters (an Offset, an Attenuverter, Math, a level) works it out from the values it has now; one that
// follows its input says so. Every output of every module type has an entry (ranges.test.ts).
import { RATIOS, RATIO_DETUNE_OCT, ratioIndex } from './modules';

type Params = Record<string, number>;
type Range = string | ((p: Params) => string);

/** a number as the ranges show it: three significant digits, a real minus sign */
export const num = (v: number): string => {
  const s = String(Number(v.toPrecision(3)));
  return s.startsWith('-') ? `−${s.slice(1)}` : s;
};
/** lo..hi */
const span = (lo: number, hi: number): string => `${num(lo)}..${num(hi)}`;
/** −a..a */
const sym = (a: number): string => span(-Math.abs(a), Math.abs(a));
const get = (p: Params, k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d);

const GATE = '0 or 1';
const PITCH = '1 per octave, 0 = middle C (C4)';
const UNIT = '0..1';
const BIPOLAR = '−1..1';
const FOLLOWS = 'audio, about the level of its input';
/** the outputs of a Voicing / Part (one voice's note) */
const VOICE: Record<string, Range> = {
  pitch: `${PITCH}; bend adds up to ±2 semitones`,
  gate: `${GATE} (1 while the voice's key is held)`,
  vel: '0..1 (velocity ÷ 127)',
  index: '−1..1 (the first part −1, the last 1; 0 with one part)',
  legato: `${GATE} (1 when the note began over a held one)`,
  jump: 'octaves, signed: the last step in pitch (1 = an octave up)',
  trig: `${GATE} (a one-sample pulse on each new note)`,
  low: `${GATE} (1 while this voice plays the lowest held note)`,
  high: `${GATE} (1 while this voice plays the highest held note)`,
  unison: `${GATE} (1 while unison is on)`,
};

/** the interval Math's a' = a × ka + off and b' = b × kb cover for inputs of −1..1 */
function mathSpan(p: Params): { a: [number, number]; b: [number, number] } {
  const ka = Math.abs(get(p, 'ka', 1)), kb = Math.abs(get(p, 'kb', 1)), off = get(p, 'off', 0);
  return { a: [off - ka, off + ka], b: [-kb, kb] };
}
const ONE_IN = ' for inputs of −1..1';

/** module type → output → its range (text, or text from the module's parameters) */
export const OUTPUT_RANGES: Record<string, Record<string, Range>> = {
  fm1: {
    pitch: `${PITCH}; the bend wheel adds up to ±2 semitones`,
    gate: `${GATE} (1 while a key is held)`,
    vel: '0..1 (velocity ÷ 127)',
    clock: `${GATE}: a pulse 24 times per quarter note while the transport runs`,
    bend: `${BIPOLAR} (the bend wheel)`,
    mod: `${UNIT} (the mod wheel)`,
    at: `${UNIT} (aftertouch)`,
    keys: 'the held keys, for a Voicing or an Arpeggiator (on a scope: 1 while a key is held)',
    run: `${GATE} (1 while the transport runs)`,
    fx: `${GATE} (1 while the button is held or switched on)`,
    scl: `${GATE} (1 while the button is held or switched on)`,
    env: `${GATE} (1 while the button is held or switched on)`,
    lfo: `${GATE} (1 while the button is held or switched on)`,
    edit: `${GATE} (1 while the button is held or switched on)`,
    glo: `${GATE} (1 while the button is held or switched on)`,
    arp: `${GATE} (1 while the button is held or switched on)`,
    breath: `${UNIT} (MIDI CC 2)`,
    sustain: `${UNIT} (MIDI CC 64, the sustain pedal)`,
    foot: `${UNIT} (MIDI CC 65)`,
  },
  osc: { out: (p) => `audio ${sym(get(p, 'level', 1))} (±1 × level)` },
  lfo: {
    out: (p) => `${sym(get(p, 'depth', 1))} (±1 × depth)`,
    pulse: (p) => `${sym(get(p, 'depth', 1))}: a square wave (±1 × depth)`,
  },
  noise: { out: (p) => `audio ${sym(get(p, 'level', 0.5))} (±1 × level)` },
  const: { out: (p) => `${num(get(p, 'value', 0))}, constant (the value)` },
  macro: { out: (p) => `${num(get(p, 'value', 0.5))} now (the value, 0..1)` },
  scale: {
    out: (p) => {
      const g = get(p, 'gain', 1), o = get(p, 'offset', 0);
      return `in × ${num(g)} + ${num(o)}: ${span(o - Math.abs(g), o + Math.abs(g))} for an input of −1..1`;
    },
  },
  adsr: { env: UNIT },
  vca: { out: (p) => `audio: in × cv × ${num(get(p, 'gain', 1))} (gain); ±1 in with cv 1 gives ${sym(get(p, 'gain', 1))}` },
  filter: Object.fromEntries(['lp24', 'lp12', 'bp', 'hp', 'mix', 'notch', 'peak', 'ap', 'hp6'].map((k) => [k, `${FOLLOWS}; resonance can lift it (self-oscillation about ±0.5)`])),
  mixer: {
    out: (p) => {
      const sum = [1, 2, 3, 4].reduce((s, n) => s + Math.abs(get(p, `l${n}`, 0.7)), 0);
      return `audio: the inputs × their levels, summed; four ±1 inputs give up to ${sym(sum)}`;
    },
  },
  delay: { out: `${FOLLOWS}; feedback can build above it`, r: `${FOLLOWS}; feedback can build above it` },
  reverb: { out: FOLLOWS },
  output: {},
  glide: { out: 'its input, slowed: the same range as what comes in' },
  shape: { out: (p) => `audio, at most about ${sym(get(p, 'level', 0.7))} (±1 × level)` },
  env: { env: '0..1 (the levels l1..l4)' },
  string: { out: (p) => `audio, about ${sym(get(p, 'level', 1))} at the pluck, dying away (±1 × level)` },
  wavetable: { out: (p) => `audio ${sym(get(p, 'level', 1))} (±1 × level)` },
  chorus: { l: FOLLOWS, r: FOLLOWS },
  seq: { out: '−1..1 (the steps s1..s8)', gate: GATE },
  clkdiv: { out: GATE, d2: GATE, d4: GATE, d8: GATE },
  sh: { out: 'the held input: the same range as what comes in' },
  quant: { out: `${PITCH}: its input, on the notes of the scale` },
  pulse: { out: GATE },
  pan: { l: `${FOLLOWS} (equal power: 0.71 of it in the middle)`, r: `${FOLLOWS} (equal power: 0.71 of it in the middle)` },
  xfade: { out: `${FOLLOWS} (a mix of a and b)` },
  vowel: { out: (p) => `audio, about the input × ${num(get(p, 'level', 1))} (level)` },
  phaser: { out: FOLLOWS },
  crush: { out: FOLLOWS },
  ladder: { lp24: `${FOLLOWS}; drive and resonance can lift it`, lp12: `${FOLLOWS}; drive and resonance can lift it` },
  dyn: {
    out: (p) => `${FOLLOWS}, compressed, then +${num(get(p, 'gain', 0))} dB`,
    env: '0 and up: the level the compressor hears (1 = a full-scale signal)',
  },
  math: {
    add: (p) => { const { a, b } = mathSpan(p); return span(a[0] + b[0], a[1] + b[1]) + ONE_IN; },
    sub: (p) => { const { a, b } = mathSpan(p); return span(a[0] - b[1], a[1] - b[0]) + ONE_IN; },
    mul: (p) => {
      const { a, b } = mathSpan(p);
      const c = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
      return span(Math.min(...c), Math.max(...c)) + ONE_IN;
    },
    min: (p) => { const { a, b } = mathSpan(p); return span(Math.min(a[0], b[0]), Math.min(a[1], b[1])) + ONE_IN; },
    max: (p) => { const { a, b } = mathSpan(p); return span(Math.max(a[0], b[0]), Math.max(a[1], b[1])) + ONE_IN; },
    abs: (p) => {
      const { a } = mathSpan(p);
      const lo = a[0] <= 0 && a[1] >= 0 ? 0 : Math.min(Math.abs(a[0]), Math.abs(a[1]));
      return span(lo, Math.max(Math.abs(a[0]), Math.abs(a[1]))) + ONE_IN;
    },
    cmp: `${GATE} (1 while a' > b')`,
    xor: 'audio −1..1 (the bits of a\' and b\' as 16-bit samples, exclusive or)',
  },
  logic: { and: GATE, or: GATE, xor: GATE, not: GATE },
  grain: { out: `${FOLLOWS}; overlapping grains add up (density × size)` },
  comb: { out: `${FOLLOWS}; feedback near ±1 lifts it` },
  modal: { out: 'audio, about the level of what strikes it; a long decay rings above it' },
  shift: { up: FOLLOWS, down: FOLLOWS },
  part: VOICE,
  random: { out: BIPOLAR, held: `${BIPOLAR} (a new value on each clock)` },
  alloc: VOICE,
  scope: {},
  arp: { keys: 'keys, for a Voicing (on a scope: 1 while its note plays)' },
  steps: {
    trig: `${GATE} (high for each step's note)`,
    pitch: `${PITCH}, plus the transpose input`,
    vel: '0..1 (velocity ÷ 127)',
    keys: 'keys, for a Voicing (on a scope: 1 while a note plays)',
  },
  drummap: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
    [`g${i + 1}`, `${GATE} (1 while the row's note is held)`],
    [`v${i + 1}`, '0..1 (the row\'s last velocity ÷ 127)'],
  ]).flat()),
  pd: { out: (p) => `audio ${sym(get(p, 'level', 0.8))} (±1 × level)` },
  env8: { env: '0..1 (the levels l1..l8)' },
  select: {
    out: (p) => {
      const n = Math.round(get(p, 'count', 8));
      const vs = Array.from({ length: n }, (_, i) => get(p, `v${i + 1}`, 0));
      return `the chosen input plus its value (v1..v${n} now ${span(Math.min(...vs), Math.max(...vs))})`;
    },
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`g${i + 1}`, `${GATE} (1 while position ${i + 1} is chosen)`])),
  },
  rateenv: { env: UNIT },
  ratio: {
    pitch: (p) => {
      const r = RATIOS[ratioIndex(p.ratio)];
      const d = RATIO_DETUNE_OCT[Math.max(0, Math.min(6, Math.round(get(p, 'detune', 3))))];
      return `octaves to add to a pitch (1 = an octave): ${num(Math.log2(r) + d)} now, ×${r.toFixed(2)}`;
    },
  },
  esp: {
    amp: (p) => `audio: the input × ${num(get(p, 'level', 1))} (level), held to ±16`,
    bp: `${FOLLOWS} (band-passed)`,
    pitch: `${PITCH}: the pitch it hears`,
    env: '0 and up: the level it hears (1 = a full-scale signal)',
    trig: `${GATE} (1 while the level is over thresh)`,
  },
};

/** the range an output carries, worked out from the module's parameters now ('' for an output without one) */
export function outputRange(type: string, port: string, params: Params = {}): string {
  const r = OUTPUT_RANGES[type]?.[port];
  if (r === undefined) return '';
  return typeof r === 'string' ? r : r(params);
}
