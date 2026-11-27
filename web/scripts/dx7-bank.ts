// SPDX-License-Identifier: GPL-3.0-only
// The editor's own DX7 voices (#1338, spec section 9): original voices, never Yamaha's or anyone else's, written here as
// numbers so the bank is made the same way every time. `npx vite-node scripts/dx7-bank.ts` (from web) writes them as a
// 32-voice bank, the rest of its slots the init voice, to factory/dx7/matryoshka.syx (the DX7 card lists it), and the
// electric piano into the "DX7 Piano" example in factory/examples.json (a Voicing with 8 voices, a DX7, an Output, Main's
// mod wheel on the DX7's p1 to `mod`). dx7-bank.test.ts renders every voice and checks both files are what this writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fixAssemblies, makeAssembly } from '../src/assembly';
import { dx7Pack } from '../src/dx7';
import { bankSysex } from '../src/dx7-sysex';
import { DX7_INIT_VOICE, voiceHex } from '../src/dx7-voice';
import EXAMPLES from '../factory/examples.json';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from '../src/patch';

/** an operator: its envelope (rates and levels, 0..99), output level, frequency (ratio: coarse 0..31 and fine 0..99;
 *  fixed: 10^(coarse & 3) Hz times 10^(fine / 100)), detune (-7..7), velocity and AM sensitivity, key scaling */
interface Op {
  r: [number, number, number, number];
  l: [number, number, number, number];
  level: number;
  coarse?: number;
  fine?: number;
  fixed?: boolean;
  detune?: number;
  vel?: number;
  ams?: number;
  /** key scaling: break point (0 = A-1, 39 = C3), left and right depths, curves (0 -lin, 1 -exp, 2 +exp, 3 +lin), rate */
  bp?: number;
  ld?: number;
  rd?: number;
  lc?: number;
  rc?: number;
  rs?: number;
}

/** a voice: its name (10 characters at most), algorithm (1..32), feedback (0..7), its six operators (operator 1 first),
 *  and the voice's own values */
interface Voice {
  name: string;
  alg: number;
  fb: number;
  ops: [Op, Op, Op, Op, Op, Op];
  /** oscillator key sync (on: every note starts its operators at phase 0) */
  oks?: boolean;
  lfo?: { wave?: number; speed?: number; delay?: number; pmd?: number; amd?: number; sync?: boolean; pms?: number };
  peg?: { r: [number, number, number, number]; l: [number, number, number, number] };
  /** transpose in semitones (-24..24) */
  transpose?: number;
}

/** a voice as the DX7 packs it */
export function packVoice(v: Voice): Uint8Array {
  const u = new Uint8Array(156);
  v.ops.forEach((o, k) => {
    const d = (5 - k) * 21;   // (msfa's form lists operator 6 first)
    u.set(o.r, d);
    u.set(o.l, d + 4);
    u.set([o.bp ?? 39, o.ld ?? 0, o.rd ?? 0, o.lc ?? 0, o.rc ?? 0, o.rs ?? 0, o.ams ?? 0, o.vel ?? 0, o.level, o.fixed ? 1 : 0, o.coarse ?? 1, o.fine ?? 0, (o.detune ?? 0) + 7], d + 8);
  });
  const peg = v.peg ?? { r: [99, 99, 99, 99], l: [50, 50, 50, 50] };
  const lfo = v.lfo ?? {};
  u.set([...peg.r, ...peg.l, v.alg - 1, v.fb, v.oks === false ? 0 : 1, lfo.speed ?? 35, lfo.delay ?? 0, lfo.pmd ?? 0, lfo.amd ?? 0,
    lfo.sync === false ? 0 : 1, lfo.wave ?? 0, lfo.pms ?? 3, (v.transpose ?? 0) + 24], 126);
  u.set([...v.name.padEnd(10).slice(0, 10)].map((c) => c.charCodeAt(0)), 145);
  return dx7Pack(u);
}

const off: Op = { r: [99, 99, 99, 99], l: [99, 99, 99, 0], level: 0 };

/** the voices, in the bank's order (slot 1 first) */
export const DX7_VOICES: Voice[] = [
  {
    // three pairs (algorithm 5): a soft body, a bright tine that dies fast, a quieter octave above for air; velocity opens
    // the modulators, so a hard key barks
    name: 'TINE PIANO', alg: 5, fb: 0,
    ops: [
      { r: [96, 30, 22, 62], l: [99, 82, 0, 0], level: 96, vel: 2, ams: 2, rd: 18, rc: 1, rs: 3 },
      { r: [96, 52, 30, 70], l: [99, 62, 0, 0], level: 76, vel: 6, rd: 30, rc: 1, rs: 3 },
      { r: [96, 30, 22, 62], l: [99, 82, 0, 0], level: 84, detune: 2, vel: 2, ams: 2, rd: 18, rc: 1, rs: 3 },
      { r: [98, 74, 40, 80], l: [99, 0, 0, 0], level: 62, coarse: 14, vel: 7, rd: 40, rc: 1, rs: 4 },
      { r: [96, 40, 26, 62], l: [99, 76, 0, 0], level: 76, coarse: 2, vel: 2, ams: 2, rd: 24, rc: 1, rs: 3 },
      { r: [96, 58, 32, 70], l: [99, 55, 0, 0], level: 66, vel: 5, rd: 30, rc: 1, rs: 3 },
    ],
    lfo: { wave: 4, speed: 30, amd: 0, pmd: 0 },
  },
  {
    // a carrier an octave down under a bright, quickly closing pair; operator 6's feedback adds the grit at the attack
    name: 'SOLID BASS', alg: 1, fb: 5,
    ops: [
      { r: [99, 44, 30, 72], l: [99, 88, 76, 0], level: 99, vel: 2 },
      { r: [99, 62, 42, 72], l: [99, 70, 52, 0], level: 80, vel: 5 },
      { r: [99, 50, 34, 72], l: [99, 80, 64, 0], level: 86, coarse: 0 },
      { r: [99, 70, 46, 72], l: [99, 50, 30, 0], level: 72, vel: 4 },
      { r: [99, 80, 50, 72], l: [99, 30, 0, 0], level: 64 },
      { r: [99, 85, 60, 72], l: [99, 0, 0, 0], level: 58 },
    ],
    transpose: -12,
  },
  {
    // inharmonic pairs (3.50, 1.41 and 7.13 against their carriers), long decays, a long ring after the key
    name: 'GLASS BELL', alg: 5, fb: 0,
    ops: [
      { r: [99, 28, 20, 26], l: [99, 72, 0, 0], level: 96, vel: 3 },
      { r: [99, 36, 24, 30], l: [99, 60, 0, 0], level: 70, coarse: 3, fine: 50, vel: 5 },
      { r: [99, 34, 22, 28], l: [99, 66, 0, 0], level: 84, coarse: 4, vel: 3, rd: 20, rc: 1 },
      { r: [99, 42, 26, 32], l: [99, 50, 0, 0], level: 66, coarse: 1, fine: 41, vel: 6 },
      { r: [99, 24, 18, 24], l: [99, 76, 0, 0], level: 78, coarse: 0, vel: 2 },
      { r: [99, 44, 28, 34], l: [99, 44, 0, 0], level: 60, coarse: 7, fine: 13, vel: 6 },
    ],
    transpose: 12,
  },
  {
    // one pair on operator 1 and three carriers under operator 6 (algorithm 22): the modulators swell slower than the
    // carriers, and the pitch rises a little into each note
    name: 'BRASS BAND', alg: 22, fb: 6,
    ops: [
      { r: [70, 40, 30, 60], l: [99, 92, 88, 0], level: 96, vel: 2 },
      { r: [56, 36, 30, 56], l: [99, 90, 80, 0], level: 80, vel: 4 },
      { r: [70, 40, 30, 60], l: [99, 92, 88, 0], level: 80, vel: 2 },
      { r: [70, 40, 30, 60], l: [99, 92, 88, 0], level: 72, detune: 1, vel: 2 },
      { r: [66, 40, 30, 60], l: [99, 90, 84, 0], level: 76, coarse: 2, vel: 2 },
      { r: [58, 38, 30, 56], l: [99, 88, 78, 0], level: 74, vel: 4 },
    ],
    peg: { r: [80, 70, 99, 60], l: [44, 50, 50, 50] },
    lfo: { wave: 4, speed: 34, delay: 50, pmd: 6, pms: 3 },
  },
  {
    // three soft pairs, a little detuned against each other, slow in and slow out, a slow vibrato
    name: 'SLOW PAD', alg: 5, fb: 0, oks: false,
    ops: [
      { r: [38, 30, 30, 34], l: [99, 97, 96, 0], level: 92 },
      { r: [34, 26, 30, 32], l: [99, 94, 92, 0], level: 62 },
      { r: [36, 30, 30, 34], l: [99, 97, 96, 0], level: 76, detune: 2 },
      { r: [32, 26, 30, 32], l: [99, 94, 92, 0], level: 60, detune: -4 },
      { r: [34, 30, 30, 34], l: [99, 97, 96, 0], level: 82, coarse: 2, detune: -2 },
      { r: [30, 26, 30, 32], l: [99, 94, 92, 0], level: 56, coarse: 1 },
    ],
    lfo: { wave: 0, speed: 24, pmd: 4, pms: 2 },
  },
  {
    // six carriers as drawbars (algorithm 32): 0.50, 1, 1.50, 2, 3 and 4, a little feedback on 6 for the click
    name: 'DRAWBARS', alg: 32, fb: 3,
    ops: [
      { r: [99, 99, 99, 90], l: [99, 99, 99, 0], level: 86, coarse: 0 },
      { r: [99, 99, 99, 90], l: [99, 99, 99, 0], level: 90 },
      { r: [99, 99, 99, 90], l: [99, 99, 99, 0], level: 80, coarse: 1, fine: 50 },
      { r: [99, 99, 99, 90], l: [99, 99, 99, 0], level: 84, coarse: 2 },
      { r: [99, 99, 99, 90], l: [99, 99, 99, 0], level: 76, coarse: 3 },
      { r: [99, 80, 99, 90], l: [99, 72, 72, 0], level: 74, coarse: 4 },
    ],
    lfo: { wave: 0, speed: 38, pmd: 3, pms: 3 },
  },
  {
    // two stacks of three (algorithm 3): bright at the pluck, dark in a moment
    name: 'NYLON PICK', alg: 3, fb: 4,
    ops: [
      { r: [99, 42, 26, 62], l: [99, 76, 0, 0], level: 99, vel: 2, rs: 3 },
      { r: [99, 62, 36, 66], l: [99, 46, 0, 0], level: 76, coarse: 3, vel: 5, rs: 3 },
      { r: [99, 80, 44, 66], l: [99, 0, 0, 0], level: 64, vel: 6, rs: 3 },
      { r: [99, 46, 28, 62], l: [99, 72, 0, 0], level: 84, coarse: 2, vel: 2, rs: 3 },
      { r: [99, 66, 38, 66], l: [99, 40, 0, 0], level: 72, vel: 5, rs: 3 },
      { r: [99, 84, 46, 66], l: [99, 0, 0, 0], level: 58, coarse: 2, vel: 6, rs: 3 },
    ],
  },
  {
    // algorithm 4: operator 4 feeds back into 6 through 5, a loop of three. A reedy voice from the loop alone (6, 5, 4)
    // over a soft pair on operator 1
    name: 'LOOP REED', alg: 4, fb: 6,
    ops: [
      { r: [80, 40, 30, 64], l: [99, 90, 84, 0], level: 82, vel: 2 },
      { r: [76, 40, 30, 60], l: [99, 80, 70, 0], level: 58 },
      { ...off },
      { r: [82, 40, 30, 64], l: [99, 92, 86, 0], level: 96, vel: 2 },
      { r: [72, 44, 30, 60], l: [99, 86, 76, 0], level: 76, vel: 4 },
      { r: [70, 44, 30, 60], l: [99, 84, 74, 0], level: 70, vel: 3 },
    ],
    lfo: { wave: 4, speed: 32, delay: 40, pmd: 5, pms: 3 },
  },
  {
    // algorithm 6: operator 5 feeds back into 6, a loop of two. The loop growls while operator 6's envelope is up and
    // settles into the carrier's tone as it falls; two plain pairs under it
    name: 'LOOP GROWL', alg: 6, fb: 7,
    ops: [
      { r: [99, 44, 30, 70], l: [99, 86, 76, 0], level: 90, vel: 2 },
      { r: [99, 60, 40, 70], l: [99, 64, 50, 0], level: 70, vel: 4 },
      { r: [99, 44, 30, 70], l: [99, 86, 76, 0], level: 84, coarse: 0, vel: 2 },
      { r: [99, 64, 40, 70], l: [99, 50, 30, 0], level: 62 },
      { r: [99, 44, 30, 70], l: [99, 88, 80, 0], level: 92, vel: 2 },
      { r: [99, 52, 34, 70], l: [99, 70, 40, 0], level: 66, vel: 5 },
    ],
    transpose: -12,
  },
];

/** the bank file: our voices, then the init voice in every slot left */
export const dx7BankFile = (): Uint8Array => bankSysex(DX7_VOICES.map(packVoice), DX7_INIT_VOICE);

/** the bank's file, under web/ */
export const DX7_BANK_PATH = 'factory/dx7/matryoshka.syx';
/** the example that plays the bank's electric piano */
export const DX7_EXAMPLE = 'DX7 Piano';

/**
 * The "DX7 Piano" example: Main's keys through Steps and the (bypassed) arpeggiator, as every editor example, into a
 * Voicing of 8 voices and a DX7 playing TINE PIANO, one copy per voice (a poly assembly), into the Output. Main's mod
 * wheel goes to the DX7's p1, mapped to `mod`, and the wheel's DX7 assignment is `amp`: the wheel brings in the
 * piano's tremolo (its carriers' AM sensitivity, the voice's sine LFO).
 */
export function dx7Example(): Patch {
  const p = emptyPatch(DX7_EXAMPLE);
  const add = (type: string, x: number, y: number, params: Record<string, number> = {}) => {
    const m = addModule(p, DEFS[type], x, y);
    Object.assign(m.params, params);
    return m;
  };
  const wire = (from: number, fromPort: string, to: number, toPort: string): void => {
    if (!connect(p, DEFS, { module: from, port: fromPort }, { module: to, port: toPort })) throw new Error(`${DX7_EXAMPLE}: ${fromPort} -> ${toPort} refused`);
  };
  const main = add('fm1', 20, 20, { morph: 0, tempo: 120 });
  const alloc = add('alloc', 20, 620, { voices: 8 });
  const dx = add('dx7', 20, 60, { level: 0.6, dest: 1, range: 70 });
  dx.voice = voiceHex(packVoice(DX7_VOICES[0]));
  dx.map = { ...dx.map, p1: ['mod'] };
  const out = add('output', 1040, 20, { level: 0.43 });
  const steps = add('steps', 20, 920);
  steps.name = 'PATTERN';
  const arp = add('arp', 1040, 920);
  arp.bypass = true;
  main.panel = { toggle: ['arp'], kinds: { arp: 'bypass' }, targets: { arp: { module: arp.id } } };
  wire(main.id, 'keys', steps.id, 'keys');
  wire(steps.id, 'keys', arp.id, 'keys');
  wire(arp.id, 'keys', alloc.id, 'keys');
  for (const port of ['pitch', 'gate', 'vel']) wire(alloc.id, port, dx.id, port);
  wire(main.id, 'mod', dx.id, 'p1');
  wire(dx.id, 'out', out.id, 'l');
  wire(dx.id, 'out', out.id, 'r');
  const a = makeAssembly(p, [alloc.id, dx.id], 'dx7 piano');
  a.inputs = [{ module: alloc.id, port: 'keys', label: 'keys' }];
  a.outputs = [{ module: dx.id, port: 'out', label: 'out' }];
  a.params = [{ module: alloc.id, param: 'voices', label: 'voices' }, ...['level', 'tune', 'mod', 'range', 'dest'].map((param) => ({ module: dx.id, param, label: param }))];
  a.poly = {};
  p.notes = 'A DX7 playing our own electric piano (TINE PIANO), eight voices. The mod wheel brings in its tremolo. More voices: the bank on the DX7 card.';
  fixAssemblies(p, DEFS);   // (the cards as the editor holds them once opened: factory-reconciled.test.ts)
  return validatePatch(p, DEFS);
}

/** factory/examples.json with the example in its place (appended the first time) */
export function examplesWithDx7(): typeof EXAMPLES {
  const entry = { name: DX7_EXAMPLE, patch: dx7Example() } as unknown as (typeof EXAMPLES)[number];
  const at = EXAMPLES.findIndex((e) => e.name === DX7_EXAMPLE);
  return at < 0 ? [...EXAMPLES, entry] : EXAMPLES.map((e, i) => (i === at ? entry : e));
}

if (process.argv.includes('--write')) {
  const web = (f: string): URL => new URL(`../${f}`, import.meta.url);
  mkdirSync(web('factory/dx7'), { recursive: true });
  writeFileSync(web(DX7_BANK_PATH), dx7BankFile());
  writeFileSync(web('factory/examples.json'), `${JSON.stringify(examplesWithDx7(), null, 1)}\n`);
  console.log(`wrote ${DX7_BANK_PATH} (${DX7_VOICES.length} voices) and the ${DX7_EXAMPLE} example`);
}
