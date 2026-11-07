// SPDX-License-Identifier: GPL-3.0-only
// What the editor shows for a module, port, parameter or choice: the short names spelled out. Identifiers (patch files,
// engine, firmware, the binary format, the tutorial's checks) keep the short names; only the labels change. The module
// titles ADSR, LFO and VCA stay: the long forms do not fit a card's header.

const GENERIC: Record<string, string> = {
  cv: 'control voltage', cvamt: 'control amount', pw: 'pulse width', fb: 'feedback', res: 'resonance',
  pm: 'phase modulation', vel: 'velocity', mod: 'modulation', at: 'aftertouch', tol: 'tolerance', clk: 'clock',
  lp24: 'low pass 24', lp12: 'low pass 12', bp: 'band pass', hp: 'high pass', ap: 'all pass',
  pos: 'position', exc: 'excitation', trig: 'trigger', len: 'length', dir: 'direction', div: 'division',
  thresh: 'threshold', os: 'oversampling', sym: 'symmetry', struct: 'structure', bright: 'brightness', damp: 'damping',
  pre: 'pre-delay', env: 'envelope', fine: 'fine tune', coarse: 'coarse tune', bpm: 'tempo', pingpong: 'ping-pong',
  l: 'left', r: 'right', k1: 'K1', k2: 'K2', k3: 'K3', k4: 'K4',
  in1: 'in 1', in2: 'in 2', in3: 'in 3', in4: 'in 4', d2: '÷ 2', d4: '÷ 4', d8: '÷ 8',
};

const BY_TYPE: Record<string, Record<string, string>> = {
  fm1: { breath: 'breath (CC 2)', sustain: 'sustain (CC 64)', foot: 'foot switch (CC 65)' },
  adsr: { a: 'attack', d: 'decay', s: 'sustain', r: 'release', long: 'long times' },
  ladder: { fm: 'audio-rate cutoff' },
  osc: { pm2: 'phase modulation 2', pm3: 'phase modulation 3', index: 'pm index' },
  filter: { hp6: 'high pass 6' },
  lfo: { phase: 'start phase', range: 'rate range', mult: 'sync speed', shape: 'shape (0..1)', pulse: 'pulse' },
  delay: { note: 'note length', wow: 'wow / flutter' },
  pulse: { inf: 'infinite' },
  mixer: { l1: 'level 1', l2: 'level 2', l3: 'level 3', l4: 'level 4' },
  env: { l1: 'level 1', r1: 'rate 1', l2: 'level 2', r2: 'rate 2', l3: 'level 3', r3: 'rate 3', l4: 'level 4', r4: 'rate 4', shot: 'one-shot' },
  ratio: { ratio: 'frequency ratio', detune: 'detune position' },
  esp: { level: 'signal level', lowcut: 'low cut', highcut: 'high cut', cvadj: 'cv adjust', amp: 'amp out', pitch: 'pitch (F-V)' },
  shreg: { in: 'data in', len: 'loop length', flip: 'flip chance', bits: 'dac bits' },
  comp: { thresh: 'threshold', hyst: 'hysteresis', gt: 'a above b', lt: 'a below b', trig: 'rise trigger' },
  range: { inlo: 'in low', inhi: 'in high', outlo: 'out low', outhi: 'out high' },
  matrix: {
    ...Object.fromEntries([1, 2, 3, 4].flatMap((k) => [[`in${k}`, `in ${k}`], [`out${k}`, `out ${k}`]])),
    ...Object.fromEntries([1, 2, 3, 4].flatMap((i) => [1, 2, 3, 4].map((o) => [`i${i}o${o}`, `in ${i} → out ${o}`]))),
  },
  steps: { dir: 'play mode' },
  rateenv: { ar: 'attack rate', d1r: 'decay 1 rate', d1l: 'decay 1 level', d2r: 'decay 2 rate', rr: 'release rate', krs: 'key rate scaling' },
  env8: { ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [[`l${i + 1}`, `level ${i + 1}`], [`r${i + 1}`, `rate ${i + 1}`]]).flat()), sus: 'sustain step', end: 'end step' },
  seq: { s1: 'step 1', s2: 'step 2', s3: 'step 3', s4: 'step 4', s5: 'step 5', s6: 'step 6', s7: 'step 7', s8: 'step 8' },
  alloc: { trig: 'key press', stack: 'uni voices' },
  part: { trig: 'key press' },
  math: { ka: 'a gain', kb: 'b gain', off: 'offset', sub: 'subtract', mul: 'multiply', abs: 'absolute', cmp: 'compare', xor: 'bit xor' },
  pd: { dcw: 'DCW (bend)', wave2: 'wave 2', range: 'resonance range' },
  select: {
    count: 'positions', fade: 'crossfade',
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => [[`in${k}`, `in ${k}`], [`g${k}`, `gate ${k}`], [`v${k}`, `value ${k}`]])),
  },
};

const MODULES: Record<string, string> = {
  sh: 'Sample & hold', clkdiv: 'Clock divider', shift: 'Frequency shifter', env: 'Level/rate envelope', pd: 'Phase distortion',
  env8: 'Eight-step envelope',
};

const PD_CHOICES: Record<string, string> = {
  'dbl sine': 'double sine', 'reso 1': 'resonance I (ramp)', 'reso 2': 'resonance II (triangle)', 'reso 3': 'resonance III (trapezoid)',
};

const CHOICES: Record<string, Record<string, string>> = {
  'osc.stack': { '+oct': '+octave', '+5th': '+fifth', '+oct+5th': '+octave +fifth', '-oct': '−octave' },
  'lfo.wave': { 'S&H': 'sample & hold' },
  'lfo.div': { '1/16T': '1/16 triplet', '1/8T': '1/8 triplet', '1/16.': '1/16 dotted', '1/8.': '1/8 dotted' },
  'lfo.dir': { fwd: 'forward', back: 'backward' },
  'lfo.mult': { '/8': '÷ 8', '/4': '÷ 4', '/2': '÷ 2' },
  'delay.note': { time: 'time knob', '1/2T': '1/2 triplet', '1/2.': '1/2 dotted', '1/1T': '1/1 triplet', '1/1.': '1/1 dotted' },
  'glide.curve': { exp: 'exponential', lin: 'linear' },
  'seq.dir': { fwd: 'forward', back: 'backward' },
  'quant.scale': { 'pent maj': 'pentatonic major', 'pent min': 'pentatonic minor', whole: 'whole tone' },
  'pd.wave': PD_CHOICES,
  'pd.wave2': PD_CHOICES,
};

/** a port's or parameter's label on a module of `type` */
export const longName = (type: string, name: string): string => BY_TYPE[type]?.[name] ?? GENERIC[name] ?? name;

/** what a parameter's name says on hover (#518: a phase modulation index), undefined for most */
const PM_HINT = (input: string): string =>
  `Phase modulation index in radians: the ${input} input's signal times this moves the phase. An oscillator swings by its level, so a modulator at level 0.5 into an index of 4 moves the phase by up to 2 radians (index = level × pm).`;
const HINTS: Record<string, string> = {
  'osc.pm': `${PM_HINT('pm')} The index input, when patched, multiplies all three.`,
  'osc.pm2': `${PM_HINT('pm2')} The index input, when patched, multiplies all three.`,
  'osc.pm3': `${PM_HINT('pm3')} The index input, when patched, multiplies all three.`,
  'osc.analog': 'The flaws of an analog oscillator, 0 = none (ideal waves). The saw\'s ramp curves a little and dips below its bottom for 25 µs at each reset; the triangle\'s peak and the pulse width sit a little off centre. Each voice has its own fixed amount of each flaw. The sine has none.',
  'wavetable.pm': PM_HINT('pm'),
  'pd.pm': PM_HINT('pm'),
  'delay.length': 'The most time this Delay holds, set here in the editor (the FM-1 shows it). Its time plays up to it; ping-pong: half per side, as both sides share the line. It takes 8.6 KB of the FM-1\'s memory per 100 ms at rate 44k. At 22k the same memory holds 200 ms, at 11k 400 ms, and this row shows that longer time.',
  'delay.tape': 'Tape: echoes like a tape echo. Each repeat loses some highs and lows, the loop saturates softly instead of running away, and the wow / flutter row wobbles the echoes. The heads row picks up to three playback heads. Off: the plain Delay, exactly as without Tape.',
  'delay.wow': 'With Tape on: how much the tape wobbles. A slow wow (0.6 Hz) and a fast flutter (6.7 Hz) move the echo\'s time, at most 1 ms and 0.1 ms either way, so its pitch bends a little.',
  'delay.heads': 'With Tape on: which playback heads sound. Head 1 plays at the time, head 2 at twice it, head 3 at three times it, all from the same memory. Several heads share the level: each plays at a half or a third. A head past the Delay\'s length plays at its end.',
  'delay.rate': 'The rate this Delay keeps its sound at. 44k keeps every sample: full quality. 22k keeps every second sample: twice the time in the same memory, and only frequencies up to about 9 kHz. 11k keeps every fourth sample: four times the time, up to about 4.4 kHz. So echoes at a lower rate sound darker. The length row shows the time at this rate (at most 3.8 s, 7.6 s, 15.2 s, in a small patch). A new rate while it plays is a tape changing speed: the echoes already in it play on, lower at a lower rate and higher at a higher one, then the echo glides back to the time.',
  'glide.fall': 'The time a falling input takes. A rising input moves at the time row, a falling one at this: a vactrol (a lopass gate\'s light and photocell) opens quickly and closes slowly. 0: falling takes the time row too.',
  'delay.pingpong': 'Ping-pong: half per side. Both sides share the Delay\'s line, so each echoes up to half its length.',
};
export const paramHint = (type: string, name: string): string | undefined => HINTS[`${type}.${name}`];

/** a module's title */
export const moduleName = (type: string, label: string): string => MODULES[type] ?? label;
/** a module as the editor names it (#518): its own name (ModuleInst.name), else its type's (moduleName; `label`: the
 * type's label, DEFS[type].label) */
export const moduleTitle = (m: { type: string; name?: string }, label: string): string => m.name || moduleName(m.type, label);

/** a choice's label (an enum parameter's value) */
export const choiceName = (type: string, param: string, choice: string): string => CHOICES[`${type}.${param}`]?.[choice] ?? choice;

/** the families a card's tag is coloured by (CSS `--tag-<family>`): sound sources, shapers in the signal path, modulation, effects, utilities */
export type TagFamily = 'src' | 'shp' | 'mod' | 'fx' | 'util';

const TAGS: Record<string, [string, TagFamily]> = {
  osc: ['VCO', 'src'], noise: ['NOISE', 'src'], wavetable: ['WAVE', 'src'], string: ['STRING', 'src'], grain: ['GRAIN', 'src'],
  filter: ['VCF', 'shp'], ladder: ['VCF', 'shp'], vca: ['VCA', 'shp'], shape: ['SHAPE', 'shp'], crush: ['CRUSH', 'shp'],
  vowel: ['VOWEL', 'shp'], dyn: ['DYN', 'shp'], pan: ['PAN', 'shp'], xfade: ['XFADE', 'shp'],
  adsr: ['ENV', 'mod'], env: ['ENV', 'mod'], env8: ['ENV', 'mod'], rateenv: ['ENV', 'mod'], lfo: ['LFO', 'mod'], random: ['RAND', 'mod'], seq: ['SEQ', 'mod'], glide: ['GLIDE', 'mod'],
  sh: ['S&H', 'mod'], quant: ['QUANT', 'mod'], clkdiv: ['CLOCK', 'mod'], pulse: ['PULSE', 'mod'],
  delay: ['DELAY', 'fx'], reverb: ['VERB', 'fx'], chorus: ['CHORUS', 'fx'], phaser: ['PHASER', 'fx'], shift: ['SHIFT', 'fx'],
  comb: ['COMB', 'fx'], modal: ['MODAL', 'fx'],
  mixer: ['MIX', 'util'], math: ['MATH', 'util'], logic: ['LOGIC', 'util'], const: ['DC', 'util'], macro: ['MACRO', 'util'], scale: ['SCALE', 'util'],
  output: ['OUT', 'util'], fm1: ['MAIN', 'util'], part: ['PART', 'util'], alloc: ['VOICES', 'util'], scope: ['SCOPE', 'util'],
  drummap: ['MAP', 'mod'], pd: ['PD', 'src'], select: ['SEL', 'util'], shreg: ['SHREG', 'mod'], comp: ['COMP', 'util'], range: ['RANGE', 'util'], matrix: ['MATRIX', 'util'],
};

/** the short tag before a card's title and the family that colours it */
export const moduleTag = (type: string): { tag: string; family: TagFamily } => {
  const [tag, family] = TAGS[type] ?? [type.slice(0, 5).toUpperCase(), 'util'];
  return { tag, family };
};

/** what a module was called before the renames of 2026-10-22 (49e9d966), so a search for its old name still finds it (#513) */
const FORMER: Record<string, string> = {
  scale: 'scale', const: 'constant', filter: 'filter', comb: 'comb', modal: 'modal', shift: 'freq shift', glide: 'glide',
  shape: 'shaper', clkdiv: 'clock div', xfade: 'crossfade', vowel: 'vowel', crush: 'digitizer', part: 'voice allocator',
};

/** other words a module is searched by (#513): what it does, in the words someone looking for it would type */
const ALIASES: Record<string, string> = {
  filter: 'multimode vcf svf state variable low pass high pass band pass notch peak all pass lp hp bp',
  ladder: 'filter vcf moog low pass lp',
  vowel: 'filter', comb: 'filter',
  shreg: 'turing machine rungler bits random loop pattern sequence',
  comp: 'compare schmitt trigger threshold gate',
  range: 'scale map rescale bipolar unipolar curve clamp limit',
  matrix: 'pin matrix routing mixer router patch bay crosspoint',
};

/** the words a module is found by in the palette and + Add module besides its name: its label, its card tag, its former
 *  name and its aliases */
export const moduleKeywords = (type: string, label: string): string =>
  [label, moduleTag(type).tag, FORMER[type], ALIASES[type]].filter(Boolean).join(' ');

/** three significant figures, trailing zeros dropped */
const sig = (v: number, digits = 3): string => String(Number(v.toPrecision(digits)));

/**
 * A parameter value for a card: the number and its unit apart (the unit is drawn smaller). Three significant figures;
 * kHz from 1000 Hz, ms below one second; a + on positive values of a parameter that can go negative. `digits`: more
 * significant figures (the typing field opens with the full value, #538).
 */
export function formatValue(v: number, unit: string | undefined, signed: boolean, digits = 3): { num: string; unit: string } {
  if (!Number.isFinite(v)) return { num: String(v), unit: unit ?? '' };
  let u = unit ?? '';
  let x = v;
  if (u === 'Hz' && Math.abs(x) >= 1000) { x /= 1000; u = 'kHz'; }
  else if (u === 's' && Math.abs(x) < 1 && x !== 0) { x *= 1000; u = 'ms'; }
  const num = Math.abs(x) < 1e-9 ? '0' : sig(x, digits);
  return { num: signed && x > 0 ? `+${num}` : num, unit: u };
}
