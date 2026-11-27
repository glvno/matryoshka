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
  ladder: { fm: 'audio-rate cutoff', stsat: 'stage saturation' },
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
  limit: { gr: 'gain reduction', ahead: 'lookahead' },
  euclid: { hits: 'hits (fill)', off: 'off (rests)' },
  eq: { freq: 'frequency' },
  matrix: {
    ...Object.fromEntries([1, 2, 3, 4].flatMap((k) => [[`in${k}`, `in ${k}`], [`out${k}`, `out ${k}`]])),
    ...Object.fromEntries([1, 2, 3, 4].flatMap((i) => [1, 2, 3, 4].map((o) => [`i${i}o${o}`, `in ${i} → out ${o}`]))),
  },
  steps: { dir: 'play mode' },
  harm: { type: 'chord', sus: 'sus / add', ext: '7th / 9th', invkeys: 'inversion keys' },
  lpg: { cv: 'open (cv)' },
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
  'shift.pm': `${PM_HINT('pm')} Every partial of the input is moved by the same amount, so any sound can be the carrier in an FM patch. With shift at 0 Hz, up moves the input's phase forward by it and down backward.`,
  'delay.length': 'The most time this Delay holds, set here in the editor (the FM-1 shows it). Its time plays up to it; ping-pong: half per side, as both sides share the line. It takes 8.6 KB of the FM-1\'s memory per 100 ms at rate 44k. At 22k the same memory holds 200 ms, at 11k 400 ms, and this row shows that longer time.',
  'delay.tape': 'Tape: echoes like a tape echo. Each repeat loses some highs and lows, the loop saturates softly instead of running away, and the wow / flutter row wobbles the echoes. The heads row picks up to three playback heads. Off: the plain Delay, exactly as without Tape.',
  'delay.wow': 'With Tape on: how much the tape wobbles. A slow wow (0.6 Hz) and a fast flutter (6.7 Hz) move the echo\'s time, at most 1 ms and 0.1 ms either way, so its pitch bends a little.',
  'delay.heads': 'With Tape on: which playback heads sound. Head 1 plays at the time, head 2 at twice it, head 3 at three times it, all from the same memory. Several heads share the level: each plays at a half or a third. A head past the Delay\'s length plays at its end.',
  'delay.rate': 'The rate this Delay keeps its sound at. 44k keeps every sample: full quality. 22k keeps every second sample: twice the time in the same memory, and only frequencies up to about 9 kHz. 11k keeps every fourth sample: four times the time, up to about 4.4 kHz. So echoes at a lower rate sound darker. The length row shows the time at this rate (at most 3.8 s, 7.6 s, 15.2 s, in a small patch). A new rate while it plays is a tape changing speed: the echoes already in it play on, lower at a lower rate and higher at a higher one, then the echo glides back to the time.',
  'glide.fall': 'The time a falling input takes. A rising input moves at the time row, a falling one at this: a vactrol (a lopass gate\'s light and photocell) opens quickly and closes slowly. 0: falling takes the time row too.',
  'lpg.mode': 'combo: the low pass and the gain open together, as on a Buchla 292 (a pluck darkens as it fades). lp: the low pass only, at full level. vca: the gain only, no filter.',
  'lpg.decay': 'How long the gate takes to close after a strike or when cv falls. Like a vactrol (a lamp and a light-dependent resistor), it opens in about 2 ms and closes more slowly as it nears closed.',
  'lpg.offset': 'How far the gate stays open with nothing in cv, 0..1; cv adds to it. A strike opens it fully, then it closes back to this.',
  'lpg.res': 'Resonance: a peak near the cutoff, loudest while the gate is nearly closed and gone once it is open, so a struck note rings as it fades. Its level stays the same. 0: no peak. Not used in vca mode.',
  'dx7.level': 'The output level. One carrier at output level 99 peaks at half scale; six at 99 together reach three times that, so turn this down for voices with many carriers.',
  'dx7.tune': 'Fine tuning in cents, as the DX7\'s master tune.',
  'dx7.mod': 'The mod wheel: how much of the voice\'s LFO reaches its destination, 0..1 (cable a source into p1 or p2 to move it).',
  'dx7.range': 'The mod wheel\'s range, 0..99, as the DX7\'s function setting.',
  'dx7.dest': 'Where the mod wheel sends the LFO: pitch (vibrato), amp (tremolo on the operators with AMS), EG bias (lowers the operators with AMS), or a mix.',
  'dx7.ops': 'The operator switches, as the DX7\'s OP 1..6 buttons: bit 1 is operator 1 ... bit 32 operator 6. 63: all on.',
  // the DX7 card's voice editor (#1338, dx7-view.ts): the voice's own values, not parameters
  'dx7.voice.name': 'The voice\'s name, as the DX7 shows it (10 characters, kept in the voice).',
  'dx7.voice.import': 'Load a DX7 SysEx file (.syx), or drop one onto the card: a single voice becomes this module\'s voice; a 32-voice bank is listed on the card, and a click on a name loads that voice. A wrong checksum is said, and the file is read anyway.',
  'dx7.voice.exportVoice': 'Save this voice as a DX7 single-voice SysEx file (.syx), for a DX7, Dexed or a librarian.',
  'dx7.voice.exportBank': 'Save a 32-voice DX7 bank (.syx): the bank listed on the card with this voice in the slot it came from, or, with no bank, this voice in slot 1 and the init voice in the others.',
  'dx7.voice.bank': 'The bank loaded from a .syx file. This browser keeps it under its name (up to 8 banks), never the FM-1 or the patch: the patch keeps only the module\'s voice.',
  'dx7.voice.banks': 'The DX7 banks this browser keeps, the newest first: pick one to list its voices on this card.',
  'dx7.voice.forget': 'Stop keeping this bank in this browser. The module keeps its voice.',
  'dx7.voice.alg': 'The algorithm, 1..32: how the six operators connect. The drawing shows it: carriers (filled) on the bottom line are heard, the operators above modulate the ones under them, the dashed line is the feedback loop. The FM-1 shows the number.',
  'dx7.voice.fb': 'Feedback, 0..7: how much the looped operator modulates itself (on algorithms 4 and 6, operator 4 or 5 back into 6). Higher turns a sine into a saw, then noise.',
  'dx7.voice.oks': 'Oscillator key sync: every note starts the operators at the same phase, so each attack sounds the same. Off: they run free.',
  'dx7.voice.op': 'Pick an operator to see and edit all its values below. Underlined: a carrier in this algorithm.',
  'dx7.voice.level': 'The operator\'s output level, 0..99: a carrier\'s loudness, a modulator\'s amount of modulation.',
  'dx7.voice.mode': 'ratio: the operator follows the key at a multiple of the note. fixed: it stays at one frequency whatever the key.',
  'dx7.voice.coarse': 'Coarse frequency, 0..31: the ratio (0 is 0.5) or, fixed, 1, 10, 100 or 1000 Hz.',
  'dx7.voice.fine': 'Fine frequency, 0..99: adds up to 99 % to the ratio, or multiplies a fixed frequency by up to 9.77.',
  'dx7.voice.detune': 'Detune, −7..7: a few cents off, for a slow beating against another operator.',
  'dx7.voice.freq': 'The operator\'s frequency from mode, coarse and fine: a ratio of the note, or Hz.',
  'dx7.voice.rate': 'The envelope\'s rates R1..R4, 0..99: how fast it moves to each level (99 fastest). R1-R3 run while the key is held, R4 after it is let go.',
  'dx7.voice.egLevel': 'The envelope\'s levels L1..L4, 0..99: L1-L3 while the key is held (L3 is held), L4 after it is let go and where a note starts.',
  'dx7.voice.bp': 'Key scaling break point, 0..99 (A-1 .. C8): the key where the level scaling starts on both sides.',
  'dx7.voice.ld': 'Key scaling left depth, 0..99: how much the level changes below the break point.',
  'dx7.voice.rd': 'Key scaling right depth, 0..99: how much the level changes above the break point.',
  'dx7.voice.rs': 'Rate scaling, 0..7: higher keys run the envelope faster, as on a real piano.',
  'dx7.voice.curve': 'Key scaling curve on that side: −lin / −exp lower the level away from the break point, +exp / +lin raise it.',
  'dx7.voice.vel': 'Key velocity sensitivity, 0..7: how much a harder key raises the operator\'s level.',
  'dx7.voice.ams': 'Amplitude modulation sensitivity, 0..3: how much the LFO\'s AMD (and the wheel\'s amp and EG bias) reaches this operator.',
  'dx7.voice.pegRate': 'The pitch envelope\'s rates R1..R4, 0..99, as an operator\'s.',
  'dx7.voice.pegLevel': 'The pitch envelope\'s levels L1..L4, 0..99: 50 is the note\'s pitch, 0 and 99 about four octaves down and up.',
  'dx7.voice.wave': 'The LFO\'s wave.',
  'dx7.voice.speed': 'The LFO\'s speed, 0..99 (about 0.06 to 50 Hz).',
  'dx7.voice.delay': 'The LFO\'s delay, 0..99: how long after a note it takes to fade in.',
  'dx7.voice.sync': 'LFO key sync: every note starts the LFO\'s wave again.',
  'dx7.voice.pmd': 'Pitch modulation depth, 0..99: vibrato from the LFO all the time (the wheel adds more).',
  'dx7.voice.amd': 'Amplitude modulation depth, 0..99: tremolo from the LFO on the operators with AMS.',
  'dx7.voice.pms': 'Pitch modulation sensitivity, 0..7: how far the LFO (PMD and the wheel) moves the pitch.',
  'dx7.voice.transpose': 'Transpose in semitones, −24..24 (0: C3 plays C3).',
  'delay.pingpong': 'Ping-pong: half per side. Both sides share the Delay\'s line, so each echoes up to half its length.',
  'filter.drive': 'Drive: how hard the signal pushes the resonance. Above 0, the resonance passes a soft clip inside the filter, as in a Korg MS-20: a quiet signal plays as before, a loud one has its resonance squashed and roughened. More drive clips at a lower level. It does nothing without resonance. 0: off, the clean filter, exactly as before.',
  'ladder.diode': 'Diode: the diode ladder of the Roland TB-303 and the EMS VCS3 instead of the Moog ladder. Its four stages load each other, so it falls more gently near the cutoff (about 18 dB per octave) and the cutoff is where its resonance peaks. Its level follows the resonance as the Moog ladder\'s does, so switching it keeps the patch\'s level. Stage saturation does not apply in this mode.',
  'ladder.stsat': 'Stage saturation: the soft clip at the input of every stage, not only where the signal enters the loop, as in a Moog ladder\'s transistor pairs. A driven filter growls more; a quiet one plays as before. Off: exactly as before.',
  'limit.ceiling': 'The loudest the output gets, in dB below full scale. Nothing passes it: a last hard clip catches what the gain has not.',
  'limit.gain': 'Drive into the limiter, in dB. More gain makes the sound louder up to the ceiling, and squashes it more.',
  'limit.release': 'How fast the gain comes back after a peak: 99 % of the way in this time. Short times pump and distort low notes; long times duck the sound after a loud hit.',
  'limit.ahead': 'Lookahead: the sound is delayed 1.45 ms, so the gain has come down smoothly by the time a peak arrives. Off: no delay, for a limiter inside a feedback loop; the gain drops at once on a peak, which is harsher.',
  'euclid.steps': 'The pattern\'s length in steps, 1..32. It plays round and round.',
  'euclid.hits': 'How many of the steps are hits, spread as evenly as they go (a Euclidean rhythm): 3 hits over 8 steps is the tresillo x..x..x., 5 over 8 with rotate 2 the cinquillo x.xx.xx. 0: none, all steps: every step.',
  'euclid.rotate': 'Turns the pattern: it starts this many steps later in it, so the hits come that much earlier.',
  'euclid.accent': 'How many of the hits are accented, spread as evenly over the hits as the hits are over the steps; the first hit is always one. Accented hits also play on the accent output. 0: none.',
  'euclid.rate': 'With nothing in clock: one step each this long on the FM-1\'s clock (the tempo, or MIDI clock) while the transport runs, the first when PLAY starts. With a cable in clock, each rising edge is a step and this row does nothing.',
  'eq.shape': 'The kind of band. low shelf / high shelf: everything below / above freq goes up or down by gain. bell: a peak or a dip at freq, gain high, q wide. low pass / high pass: cuts above / below freq, 12 dB per octave. notch: a deep, narrow cut at freq. Chain several EQs for more bands.',
  'eq.freq': 'Where the band sits, 10 Hz to 22 kHz: a bell\'s peak, the middle of a shelf\'s slope (half its gain), a filter\'s cutoff, a notch\'s centre. The curve keeps its analog shape right up to the top, without the squeeze (cramping) a plain digital EQ has there.',
  'eq.gain': 'How far a shelf or a bell boosts or cuts, -18..18 dB. 0: the band passes the sound unchanged. Not used by low pass, high pass or notch.',
  'eq.q': 'A bell\'s width: 0.7 is about two octaves, 4 a narrow peak, 0.1 very broad. For low pass and high pass the resonance (0.707 flat, higher a peak at freq); for a notch its width. On a shelf the knee: 0.707 a smooth slope, higher a small bump either side; a shelf stops at 2.',
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
  drummap: ['MAP', 'mod'], pd: ['PD', 'src'], select: ['SEL', 'util'], shreg: ['SHREG', 'mod'], comp: ['COMP', 'util'], range: ['RANGE', 'util'], matrix: ['MATRIX', 'util'], lpg: ['LPG', 'shp'],
  limit: ['LIMIT', 'shp'], euclid: ['EUCLID', 'mod'], eq: ['EQ', 'shp'], dx7: ['DX7', 'src'],
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
  ladder: 'filter vcf moog diode tb-303 low pass lp',
  vowel: 'filter', comb: 'filter',
  shreg: 'turing machine rungler bits random loop pattern sequence',
  comp: 'compare schmitt trigger threshold gate',
  range: 'scale map rescale bipolar unipolar curve clamp limit',
  matrix: 'pin matrix routing mixer router patch bay crosspoint',
  harm: 'chord chords orchid chord memory one finger triad seventh ninth sus inversion voicing',
  lpg: 'lpg lowpass gate lopass gate low pass gate vactrol buchla 292 pluck ping bongo strike filter vca',
  limit: 'brickwall peak ceiling clip maximizer loudness ear safety protect headphones feedback master dynamics',
  eq: 'equalizer equaliser parametric band tone bass treble presence shelf shelving bell peak peaking notch low cut high cut lowpass highpass mastering mix',
  dx7: 'dx7 yamaha fm synthesis six operator 6op algorithm dexed msfa sysex voice e piano bass bell tx802 tx7',
  euclid: 'euclidean bjorklund rhythm pattern trigger gate clock drum sequencer fill hits pulses rotate accent tresillo polyrhythm',
  // (the envelopes, modules.ts ENVELOPE_TYPES: `envelope` finds all four, the ADSR first as the commonest, owner 2026-11-19)
  adsr: 'envelope eg contour attack decay sustain release',
  env: 'envelope eg level rate dx7',
  env8: 'envelope eg eight step casio cz',
  rateenv: 'envelope eg rate',
};

/** the words a module is found by in Commands and + Add module besides its name: its label, its card tag, its former
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
