// SPDX-License-Identifier: GPL-3.0-only
// Golden vectors for the firmware engine: for each test patch, the binary patch (.m1p), the note events (.ev) and the
// reference output of web/src/engine.ts (.f32, float32 stereo interleaved) at the FM-1's rate (DEVICE_SR, 44118 Hz), written to build/golden/.
// Run from web/:  npx vite-node scripts/golden.ts   (tools/golden.sh does this and runs the C comparison)
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine';
import { deviceBudget, encodePatch, FLAG_INPUTS, PANEL_BYTES, recordSize, toQ16 } from '../src/patchbin';
import { cpuEstimate } from '../src/cpu';
import { DEFS, DEVICE_SR } from '../src/modules';
import { attFrame, chunkFrames, commitFrame, paramFrame, sandboxFrame, slotEraseFrame, slotFrame, slotInfoFrame } from '../src/protocol';
import { make, FM1_PRESETS, type Build } from '../src/presets';
import { addModule, defaultParams, emptyPatch, fixMatrix, paramUnit, setMorphTarget, SOURCES, stepByte, type Patch, type PolyCfg } from '../src/patch';
import { migrateSteps, overdub, type StepNote } from '../src/track';
import { makeAssembly } from '../src/assembly';
import { withParts } from '../src/test-poly';
import { acid, cardRows } from '../src/test-patches';

const SR = DEVICE_SR;
const OUT = new URL('../../build/golden/', import.meta.url);
mkdirSync(OUT, { recursive: true });

/** [frame, kind, note (a button for bon / boff; a module index for arm, -1 none, and rec), MIDI channel of a note (absent:
 * 1; rec: 1 on, 0 off; cc: controller value 0..127)]; take: the notes recorded so far go into their tracks (the editor's overdub, the panel's) */
type Ev = [number, 'on' | 'off' | 'run' | 'stop' | 'bon' | 'boff' | 'ext' | 'int' | 'tick' | 'arm' | 'arms' | 'rec' | 'take' | 'cc' | 'pat' | 'song', number, number?];
const EVENTS: Ev[] = [
  [0, 'on', 60],
  [128 * 40, 'on', 67],
  [128 * 80, 'off', 67],
  [128 * 120, 'off', 60],
];
/** a chord, two more notes than voices (stealing), staggered releases: for the polyphonic patches */
const POLY_EVENTS: Ev[] = [
  [0, 'on', 60],
  [0, 'on', 64],
  [128 * 10, 'on', 67],
  [128 * 30, 'on', 72],
  [128 * 45, 'on', 55],
  [128 * 60, 'on', 59],
  [128 * 70, 'off', 64],
  [128 * 80, 'on', 76],
  [128 * 100, 'off', 72],
  [128 * 100, 'off', 67],
  [128 * 110, 'off', 55],
  [128 * 120, 'off', 59],
  [128 * 120, 'off', 76],
  [128 * 130, 'off', 60],
];
const END_DEFAULT = 128 * 180;

const tests: Record<string, Patch> = {};
const events: Record<string, Ev[]> = {};
/** a kit's length in frames, when not END */
const ends: Record<string, number> = {};
/** a kit's binary, when not encodePatch of its patch */
const bins: Record<string, Uint8Array> = {};
// The ratio table participates in plain, unison/sync and phase-modulated oscillator paths.
for (const ratio of [0, 1, 4, 11, 42, 63]) for (const mode of ['plain', 'unison', 'fm']) {
  const name = `osc-ratio-${ratio}-${mode}`;
  tests[name] = make(name, (add, wire) => {
    const main = add('fm1', 0, 0), out = add('output', 0, 0, { level: 0.5 });
    const tuning = add('ratio', 0, 0, { ratio, detune: ratio % 7 });
    const osc = add('osc', 0, 0, { wave: 0, coarse: -12, fine: 0,
      unison: mode === 'unison' ? 3 : 1, detune: 9, pm: mode === 'fm' ? 1 : 0 });
    wire(tuning, 'pitch', osc, 'pitch');
    wire(main, 'pitch', osc, 'pitch'); wire(osc, 'out', out, 'l');
    if (mode !== 'plain') {
      const source = add('osc', 0, 0, { coarse: -24, level: 0.3 });
      wire(main, 'pitch', source, 'pitch'); wire(source, 'out', osc, mode === 'fm' ? 'pm' : 'sync');
    }
  });
}
tests['osc-ratio-live'] = make('osc-ratio-live', (add, wire) => {
  const main = add('fm1', 0, 0), out = add('output', 0, 0), osc = add('osc', 0, 0, { wave: 0, coarse: -24 });
  const tuning = add('ratio', 0, 0, { ratio: 0, detune: 0 }, { map: { p1: ['ratio', 'detune'] } });
  wire(main, 'mod', tuning, 'p1'); wire(tuning, 'pitch', osc, 'pitch');
  wire(main, 'pitch', osc, 'pitch'); wire(osc, 'out', out, 'l');
});
events['osc-ratio-live'] = [[0, 'on', 60], [128 * 30, 'cc', 1, 64], [128 * 80, 'cc', 1, 127], [128 * 120, 'cc', 1, 0]];
// Original rate-envelope extremes, pedal hold/retrigger, and key-rate scaling at low and high notes.
for (const [suffix, params] of Object.entries({
  hold: { ar: 31, d1r: 24, d1l: 10, d2r: 0, rr: 8, krs: 0 },
  decay: { ar: 14, d1r: 16, d1l: 12, d2r: 14, rr: 0, krs: 3 },
  stopped: { ar: 0, d1r: 0, d1l: 15, d2r: 0, rr: 15, krs: 3 },
  fast: { ar: 31, d1r: 31, d1l: 0, d2r: 31, rr: 15, krs: 0 },
})) {
  const name = `rateenv-${suffix}`;
  tests[name] = make(name, (add, wire) => {
    const main = add('fm1', 0, 0), env = add('rateenv', 0, 0, params), out = add('output', 0, 0, { level: 1 });
    wire(main, 'gate', env, 'gate'); wire(main, 'pitch', env, 'pitch'); wire(main, 'sustain', env, 'hold');
    wire(env, 'env', out, 'l');
  });
  events[name] = [[0, 'cc', 64, 127], [128 * 5, 'on', 36], [128 * 40, 'off', 36],
    [128 * 65, 'on', 84], [128 * 90, 'off', 84], [128 * 110, 'cc', 64, 0],
    [128 * 115, 'cc', 64, 127], [128 * 140, 'on', 60]];
}
// Pedal hold preserves the original gate's rising edges, including attacks during a sustained note.
for (const sustain of [0, 0.3, 1]) {
  const name = `adsr-hold-${sustain}`;
  tests[name] = make(name, (add, wire) => {
    const main = add('fm1', 0, 0), env = add('adsr', 0, 0, { a: .02, d: .05, s: sustain, r: .1 });
    const out = add('output', 0, 0, { level: 1 });
    wire(main, 'gate', env, 'gate'); wire(main, 'sustain', env, 'hold');
    wire(env, 'env', out, 'l');
  });
  events[name] = [[0, 'cc', 64, 64], [128 * 5, 'on', 60], [128 * 40, 'off', 60],
    [128 * 70, 'on', 60], [128 * 90, 'off', 60], [128 * 110, 'cc', 64, 63],
    [128 * 115, 'cc', 64, 127]];
}
tests['key-press-duo'] = make('key-press-duo', (add, wire) => {
  const main = add('fm1', 0, 0), out = add('output', 0, 0, { level: 1 });
  for (const [priority, port] of [[1, 'l'], [2, 'r']] as const) {
    const alloc = add('alloc', 0, 0, { voices: 1, priority, legato: 2 });
    wire(main, 'keys', alloc, 'keys');
    wire(alloc, 'trig', out, port);
  }
});
events['key-press-duo'] = [[0, 'on', 60], [128, 'on', 72], [256, 'on', 67], [512, 'off', 72], [640, 'off', 60], [768, 'off', 67]];
// Signed 16-bit audio XOR: single-output fast path and the general multiple-output path.
for (const [a, b] of [[.5, .25], [-.5, .5], [-2, 2]]) for (const multi of [false, true]) {
  const name = `math-xor-${a}-${b}-${multi}`;
  tests[name] = make(name, (add, wire) => {
    const left = add('const', 0, 0, { value: a }), right = add('const', 0, 0, { value: b });
    const op = add('math', 0, 0), out = add('output', 0, 0, { level: 1 });
    wire(left, 'out', op, 'a'); wire(right, 'out', op, 'b');
    wire(op, 'xor', out, 'l');
    if (multi) wire(op, 'abs', out, 'r');
  });
}
tests['math-xor-audio'] = make('math-xor-audio', (add, wire) => {
  const source = add('osc', 0, 0, { freq: 110, wave: 0 });
  const mask = add('const', 0, 0, { value: .625 });
  const op = add('math', 0, 0), out = add('output', 0, 0, { level: 1 });
  wire(source, 'out', op, 'a'); wire(mask, 'out', op, 'b');
  wire(op, 'xor', out, 'l');
});
for (const shape of [0, .25, .5, .75, 1]) for (const back of [0, 1]) {
  const name = `lfo-shape-${shape}-${back}`;
  tests[name] = make(name, (add, wire) => {
    const lfo = add('lfo', 0, 0, { wave: 1, rate: 7, depth: .5, dir: back });
    const source = add('const', 0, 0, { value: shape }), out = add('output', 0, 0, { level: 1 });
    wire(source, 'out', lfo, 'shape');
    wire(lfo, 'out', out, 'l');
    wire(lfo, 'pulse', out, 'r');
  });
}
for (const [n, p] of Object.entries(FM1_PRESETS)) tests[n] = p();
events['Wanderer'] = [[0, 'on', 60], [128 * 20, 'on', 72], [128 * 40, 'on', 67], [128 * 60, 'off', 72], [128 * 80, 'off', 60], [128 * 100, 'off', 67]];
tests['lfo-shape-sync'] = make('lfo-shape-sync', (add, wire) => {
  const main = add('fm1', 0, 0);
  const shape = add('const', 0, 0, { value: .37 });
  const lfo = add('lfo', 0, 0, { wave: 3, sync: 1, div: 7, phase: 90, depth: .5 });
  const out = add('output', 0, 0, { level: 1 });
  wire(main, 'clock', lfo, 'clk');
  wire(main, 'fx', lfo, 'reset');
  wire(shape, 'out', lfo, 'shape');
  wire(lfo, 'out', out, 'l');
  wire(lfo, 'pulse', out, 'r');
});
events['lfo-shape-sync'] = [[0, 'run', 0], [128 * 80, 'bon', 0], [128 * 82, 'boff', 0]];
// Sallen 20's ESP routes on the FM-1 (SIGNAL IN, ESP ROUTE): VCO 1 -> F-V into VCO 2 and ENV into the VCA, the MG ->
// TRIG into both EGs (a loop through EG 1 and VCO 1: its block of delay must fall where the editor's order puts it)
for (const [route, src] of [[2, 2], [3, 2], [4, 4]] as const) {
  const name = `sallen-esp-${route}`;
  const p = FM1_PRESETS['Sallen 20']();
  const card = p.assemblies!.find((a) => a.params.some((r) => r.label === 'esp route'))!;
  for (const [label, v] of [['signal in', src], ['esp route', route], ['threshold', 0.2]] as const) {
    const row = card.params.find((r) => r.label === label)!;
    p.modules.find((m) => m.id === row.module)!.params[row.param] = v;
  }
  tests[name] = p;
  events[name] = [[128 * 60, 'on', 57], [128 * 120, 'off', 57]];
}
for (let pos = 1; pos <= 6; pos++) {
  const name = `monolith-wave-${pos}`;
  const p = FM1_PRESETS['Monolith D']();
  const card = p.assemblies!.find((a) => a.params.some((r) => r.label === 'osc 1 wave'))!;
  for (const row of card.params.filter((r) => /^osc [123] wave$/.test(r.label)))
    p.modules.find((m) => m.id === row.module)!.params[row.param] = pos;
  tests[name] = p;
  events[name] = [[0, 'on', 60], [128 * 10, 'cc', 1, 16], [128 * 50, 'cc', 1, 0], [128 * 80, 'off', 60]];
}
for (const [cc, port] of [[2, 'breath'], [64, 'sustain'], [65, 'foot']] as const) {
  const name = `main-${port}`;
  tests[name] = make(name, (add, wire) => {
    const main = add('fm1', 0, 0), out = add('output', 0, 0, { level: 1 });
    wire(main, port, out, 'l');
  });
  events[name] = [[128, 'cc', cc, 63], [128 * 4, 'cc', cc, 127], [128 * 8, 'cc', cc, 0]];
  ends[name] = 128 * 12;
}
tests['acid'] = acid(); // also the protocol test's upload (golden.sh hands acid.m1p to proto_test)
// one card row for two filters' cutoff and resonance, a Selector's named positions (#357, #358): the page rows' extras in
// the device pages section (the engine plays it as any patch; panel_test.c turns its rows)
tests['card-rows'] = cardRows();

/**
 * A kit built the way patches were before poly assemblies (`voices`, the Main module's legato / priority / unit and its
 * spread / legato / jump / tol / drift outputs, the oscillator's drift), then loaded as the editor loads such a patch
 * (poly.ts migrateVoicing): a poly assembly with a Part module, Random modules. The conversion is part of what is checked.
 */
const makeOld = (name: string, b: Build, voices: number): Patch => {
  const p = emptyPatch(name);
  b(
    (type, x, y, params = {}, opts = {}) => {
      const m = addModule(p, DEFS[type], x, y);
      Object.assign(m.params, params);
      if (opts.map) Object.assign(m.map!, opts.map);
      if (opts.att) m.att = opts.att;
      return m.id;
    },
    (a, ap, b, bp) => void p.cables.push({ from: { module: a, port: ap }, to: { module: b, port: bp } }),
  );
  return withParts(p, voices);
};
const kit = (name: string, b: Build, voices = 1): void => {
  tests[name] = voices > 1 ? makeOld(name, b, voices) : make(name, b);
  if (voices > 1) events[name] = POLY_EVENTS;
};
/** the modules `ids` as a poly assembly with these settings (the rest of the patch plays the shared keyboard) */
// (the kits add a 'part' module where the allocator goes: it becomes a Voice allocator with these settings, Main's keys in,
// as an old patch's Part does on load; the binary the firmware gets has the Part back in its place, poly.ts deviceView)
const polyAsm = (p: Patch, ids: number[], cfg: Partial<PolyCfg>): void => {
  const alloc = p.modules.find((m) => ids.includes(m.id) && m.type === 'part')!;
  alloc.type = 'alloc';
  alloc.params = { ...defaultParams(DEFS.alloc), voices: cfg.parts ?? 4, assign: cfg.assign ?? 0, legato: cfg.legato ?? 0, priority: cfg.priority ?? 0, unison: cfg.unisonShare ? 2 : cfg.unison ? 1 : 0, stack: cfg.unisonParts ?? 0, steal: cfg.steal === false ? 0 : 1, channel: cfg.channel ?? 0, low: cfg.low ?? 0, high: cfg.high ?? 127 };
  fixMatrix(alloc, DEFS.alloc);
  const main = p.modules.find((m) => m.type === 'fm1')!;
  p.cables.push({ from: { module: main.id, port: 'keys' }, to: { module: alloc.id, port: 'keys' } });
  makeAssembly(p, ids, `poly ${ids.join(' ')}`).poly = cfg.flaws ? { flaws: cfg.flaws } : {};
};
kit('random-held', (add, wire) => {
  const clock = add('lfo', 0, 0, { wave: 3, rate: 13, depth: 1 });
  const out = add('output', 0, 0);
  for (const port of ['l', 'r']) {
    const r = add('random', 0, 0);
    wire(clock, 'out', r, 'clock');
    wire(r, 'held', out, port);
  }
});
kit('waves', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.25, l2: 0.25, l3: 0.25, l4: 0.25 });
  const out = add('output', 0, 0);
  [0, 1, 2, 3].forEach((w, i) => {
    const o = add('osc', 0, 0, { wave: w, pw: 0.3, coarse: i * 3 - 12, fine: i * 7, level: 0.9 });
    wire(kb, 'pitch', o, 'pitch');
    wire(o, 'out', mix, `in${i + 1}`);
  });
  wire(mix, 'out', out, 'l');
});
kit('lfo-sh', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const sh = add('lfo', 0, 0, { wave: 4, rate: 9, depth: 0.8 });
  const tri = add('lfo', 0, 0, { wave: 1, rate: 2.5, depth: 0.6 });
  const osc = add('osc', 0, 0, { wave: 3, pw: 0.5, level: 0.8 }, { map: { p1: ['level'], p2: ['pw'] } });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: 0.1 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(sh, 'out', osc, 'p2');
  wire(tri, 'out', sc, 'in');
  wire(sc, 'out', osc, 'p1');
  wire(osc, 'out', out, 'l');
});
const lfoKit = (name: string, slave: Record<string, number>, wireIn: (wire: (a: number, ap: string, b: number, bp: string) => void, clk: number, rst: number, lfo: number) => void): void =>
  kit(name, (add, wire) => {
    const kb = add('fm1', 0, 0);
    const clk = add('lfo', 0, 0, { wave: 3, rate: 50, depth: 1 });
    const rst = add('lfo', 0, 0, { wave: 3, rate: 1.7, depth: 1 });
    const lfo = add('lfo', 0, 0, { wave: 2, depth: 0.8, ...slave });
    const osc = add('osc', 0, 0, { wave: 3, pw: 0.5, level: 0.8 }, { map: { p1: ['level'], p2: ['pw'] } });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', osc, 'pitch');
    wireIn(wire, clk, rst, lfo);
    wire(lfo, 'out', osc, 'p1');
    wire(osc, 'out', out, 'l');
  });
lfoKit('lfo-clk', { sync: 1, div: 2 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-clk-sh', { sync: 1, div: 4, wave: 4 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-bpm', { sync: 1, div: 6, bpm: 140 }, () => undefined);
lfoKit('lfo-reset', { rate: 5 }, (wire, _c, rst, lfo) => wire(rst, 'out', lfo, 'reset'));
// #351: the start phase, backward, the rate ranges and the synced speeds (cycles that end between clock ticks)
lfoKit('lfo-clk-x8', { sync: 1, div: 0, mult: 6, phase: 90 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-clk-x2-dotted', { sync: 1, div: 3, mult: 4, wave: 0, dir: 1, phase: 30 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-clk-div4', { sync: 1, div: 2, mult: 1, wave: 1, phase: 45 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-clk-x8-sh', { sync: 1, div: 1, mult: 6, wave: 4 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-bpm-x4', { sync: 1, div: 6, bpm: 140, mult: 5, wave: 3, dir: 1 }, () => undefined);
lfoKit('lfo-reset-phase', { rate: 5, wave: 0, phase: 90, dir: 1 }, (wire, _c, rst, lfo) => wire(rst, 'out', lfo, 'reset'));
lfoKit('lfo-fast-back', { rate: 20, range: 2, dir: 1, phase: 120 }, () => undefined);
lfoKit('lfo-slow', { rate: 30, range: 1, wave: 0, phase: 90 }, () => undefined);
// The slow endpoint is amplified after removing its DC offset, so a stalled phase cannot pass as a flat wave.
for (const [wide, back, shape] of [[.0008, 0, -1], [55, 0, -1], [55, 1, .3]]) {
  const name = `lfo-wide-${wide}-${back}`;
  tests[name] = make(name, (add, wire) => {
    const lfo = add('lfo', 0, 0, { wave: 2, range: 3, wide, dir: back });
    const out = add('output', 0, 0, { level: 1 });
    if (shape >= 0) {
      const source = add('const', 0, 0, { value: shape });
      wire(source, 'out', lfo, 'shape');
      wire(lfo, 'pulse', out, 'r');
    }
    let source = lfo;
    for (let i = 0; wide < .001 && i < 4; i++) {
      const gain = add('scale', 0, 0, { gain: 4, offset: i === 0 ? 4 : 0 });
      wire(source, 'out', gain, 'in'); source = gain;
    }
    wire(source, 'out', out, 'l');
  });
}
lfoKit('lfo-wide-sync', { range: 3, wide: 55, sync: 1, div: 6 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-wide-reset', { range: 3, wide: 8, wave: 0, phase: 90 }, (wire, _c, rst, lfo) => wire(rst, 'out', lfo, 'reset'));
kit('noise-svf', (add, wire) => {
  const nz = add('noise', 0, 0, { level: 0.6 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.7 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5, l3: 0.5 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(nz, 'out', flt, 'in');
  wire(flt, 'lp12', mix, 'in1');
  wire(flt, 'bp', mix, 'in2');
  wire(flt, 'hp', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
kit('filter-notch', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 0.7, depth: 1 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.6, cvamt: 2 });
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.3, l3: 0.3 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', flt, 'cv');
  wire(flt, 'notch', mix, 'in1');
  wire(flt, 'peak', mix, 'in2');
  wire(flt, 'ap', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
// the hp6 output (the MS-20 filter's resonant 6 dB high pass) alone, swept by an LFO, at high and low resonance
for (const res of [0.2, 0.95]) {
  kit(`filter-hp6-${res}`, (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 2, level: res > 0.5 ? 0.08 : 0.5 }); // (the resonance peak below the clamp)
    const lfo = add('lfo', 0, 0, { wave: 0, rate: 0.9, depth: 1 });
    const flt = add('filter', 0, 0, { cutoff: 400, res, cvamt: 2 });
    const out = add('output', 0, 0, { level: 0.5 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(osc, 'out', flt, 'in');
    wire(lfo, 'out', flt, 'cv');
    wire(flt, 'hp6', out, 'l');
  });
}
// the filter's self-oscillation (osc on): alone at full resonance (it starts from rest and rings at the cutoff), and a
// saw through it near the top with the cutoff swept
kit('filter-osc-self', (add, wire) => {
  add('fm1', 0, 0);
  const flt = add('filter', 0, 0, { cutoff: 220, res: 1, osc: 1 });
  const out = add('output', 0, 0, { level: 0.5 });
  wire(flt, 'lp12', out, 'l');
});
kit('filter-osc-driven', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.3 });
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 0.9, depth: 1 });
  const flt = add('filter', 0, 0, { cutoff: 600, res: 0.97, cvamt: 1, osc: 1 });
  const out = add('output', 0, 0, { level: 0.5 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', flt, 'cv');
  wire(flt, 'hp6', out, 'l');
});
kit('filter-morph', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 1.5, depth: 0.5 });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: 0.5 });
  const flt = add('filter', 0, 0, { cutoff: 700, res: 0.5, track: 1, morph: 0.1 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', flt, 'morph');
  wire(flt, 'mix', mix, 'in1');
  wire(flt, 'lp24', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
kit('unison', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8, unison: 5, detune: 25 });
  const osc2 = add('osc', 0, 0, { wave: 1, level: 0.5, unison: 2, detune: 60, coarse: -12 });
  const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.4 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'pitch', osc2, 'pitch');
  wire(osc, 'out', mix, 'in1');
  wire(osc2, 'out', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
// voicing (issue #22): unison with blend and stack
kit('unison-stack', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8, unison: 5, detune: 30, blend: 0.2, stack: 3 });
  const osc2 = add('osc', 0, 0, { wave: 3, level: 0.5, unison: 1, detune: 12, stack: 4, blend: 0.9 });
  const osc3 = add('osc', 0, 0, { wave: 1, level: 0.5, unison: 4, detune: 40, blend: 0 });
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.3, l3: 0.3 });
  const out = add('output', 0, 0);
  for (const o of [osc, osc2, osc3]) wire(kb, 'pitch', o, 'pitch');
  wire(osc, 'out', mix, 'in1');
  wire(osc2, 'out', mix, 'in2');
  wire(osc3, 'out', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
// mono, high priority, legato off (envelopes restart on every change of key): one glide timed by the legato output through a
// macro range (legato-only portamento), one linear glide timed by |jump| (scaled)
tests['legato-glide'] = makeOld('legato-glide', (add, wire) => {
  const kb = add('fm1', 0, 0, { legato: 1, priority: 2 });
  const g1 = add('glide', 0, 0, { time: 0.001 }, { map: { p1: ['time'] } });
  const g2 = add('glide', 0, 0, { time: 0.02, curve: 1 }, { map: { p1: ['time'] } });
  const m = add('math', 0, 0, { ka: 2 });
  // sine and triangle: a gliding pitch leaves a small phase offset between the engines, which saw / square edges magnify
  const o1 = add('osc', 0, 0, { wave: 0, level: 0.6 });
  const o2 = add('osc', 0, 0, { wave: 1, level: 0.4, coarse: -12 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.1, s: 0.4, r: 0.1 });
  const vca = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', g1, 'in');
  wire(kb, 'pitch', g2, 'in');
  wire(kb, 'legato', g1, 'p1');
  wire(kb, 'jump', m, 'a');
  wire(m, 'abs', g2, 'p1');
  wire(g1, 'out', o1, 'pitch');
  wire(g2, 'out', o2, 'pitch');
  wire(o1, 'out', mix, 'in1');
  wire(o2, 'out', mix, 'in2');
  wire(mix, 'out', vca, 'in');
  wire(kb, 'gate', env, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
}, 1);
tests['legato-glide'].modules[1].range = { p1: { time: [0, 0.6] } }; // 166 ms
events['legato-glide'] = [
  [0, 'on', 60],
  [128 * 30, 'on', 67],
  [128 * 50, 'on', 55], // high priority: 67 stays
  [128 * 70, 'off', 67], // back to 60 (the highest still held)
  [128 * 95, 'off', 60],
  [128 * 105, 'off', 55],
  [128 * 120, 'on', 72], // detached
  [128 * 150, 'off', 72],
];
// analog drift: drifting unison copies, the Main tol on the filter and its drift walk on a second oscillator, three
// notes (each with its own tolerance and walk), a unit (dropped since the flaws replaced it)
kit('drift', (add, wire) => {
  const kb = add('fm1', 0, 0, { unit: 7 });
  const o1 = add('osc', 0, 0, { wave: 2, level: 0.6, unison: 3, detune: 8, drift: 30 });
  const o2 = add('osc', 0, 0, { wave: 3, level: 0.4, drift: 12 }, { map: { p1: ['fine'] }, att: [0.5, 1] });
  const fm = add('osc', 0, 0, { wave: 0, level: 0.5, drift: 40, fb: 0.3 });
  const flt = add('filter', 0, 0, { cutoff: 1200, res: 0.3 }, { map: { p1: ['cutoff'] }, att: [0.2, 1] });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.5, r: 0.1 });
  const vca = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.3, l3: 0.3 });
  const out = add('output', 0, 0);
  for (const o of [o1, o2, fm]) wire(kb, 'pitch', o, 'pitch');
  wire(kb, 'drift', o2, 'p1');
  wire(kb, 'tol', flt, 'p1');
  wire(o1, 'out', mix, 'in1');
  wire(o2, 'out', mix, 'in2');
  wire(fm, 'out', mix, 'in3');
  wire(mix, 'out', flt, 'in');
  wire(flt, 'lp12', vca, 'in');
  wire(kb, 'gate', env, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
}, 3);
// long enough for the walks to pick new targets (every 256 blocks)
ends.drift = 128 * 700;
events.drift = [
  [0, 'on', 48],
  [0, 'on', 55],
  [128 * 20, 'on', 64],
  [128 * 300, 'off', 55],
  [128 * 320, 'on', 62],
  [128 * 650, 'off', 48],
  [128 * 650, 'off', 62],
  [128 * 650, 'off', 64],
];
// poly assemblies layered: three groups get every note. A: three parts, rotate, the oldest note taken over; its Part's
// index detunes, a shared LFO (one copy, every part) moves the pulse width, a shared filter reads the sum of its parts.
// B: two parts, reuse, low priority, legato on, FM from the sum of A's parts, its legato output opens the level. C: one
// part, high priority, legato off, its jump sets the glide time. The shared delay hears all three.
const layers: number[][] = [];
kit('poly-layers', (add, wire) => {
  add('fm1', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 0.3 });
  const pa = add('part', 0, 0);
  const oa = add('osc', 0, 0, { wave: 3, level: 0.3 }, { map: { p1: ['fine'], p2: ['pw'] }, att: [0.3, 1] });
  const ea = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.5, r: 0.1 });
  const va = add('vca', 0, 0);
  const pb = add('part', 0, 0);
  const ob = add('osc', 0, 0, { wave: 0, coarse: 12, level: 0.3, pm: 0.4 });
  const eb = add('adsr', 0, 0, { a: 0.04, d: 0.1, s: 0.2, r: 0.15 }); // a restart (legato not on) is loud
  const vb = add('vca', 0, 0, { gain: 0.5 }, { map: { p1: ['gain'] }, att: [0.5, 1] });
  const pc = add('part', 0, 0);
  const gc = add('glide', 0, 0, { time: 0.01 }, { map: { p1: ['time'] }, att: [0.3, 1] });
  const oc = add('osc', 0, 0, { wave: 1, coarse: -12, level: 0.4 });
  const ec = add('adsr', 0, 0, { a: 0.005, d: 0.1, s: 0.6, r: 0.1 });
  const vc = add('vca', 0, 0);
  const flt = add('filter', 0, 0, { cutoff: 1500, res: 0.4 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5, l3: 0.5 });
  const dly = add('delay', 0, 0, { time: 120, fb: 0.3, mix: 0.3 });
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pa, 'pitch', oa, 'pitch');
  wire(pa, 'index', oa, 'p1');
  wire(lfo, 'out', oa, 'p2');
  wire(pa, 'gate', ea, 'gate');
  wire(oa, 'out', va, 'in');
  wire(ea, 'env', va, 'cv');
  wire(va, 'out', flt, 'in');
  wire(flt, 'lp12', mix, 'in1');
  wire(pb, 'pitch', ob, 'pitch');
  wire(oa, 'out', ob, 'pm');
  wire(pb, 'gate', eb, 'gate');
  wire(pb, 'legato', vb, 'p1');
  wire(ob, 'out', vb, 'in');
  wire(eb, 'env', vb, 'cv');
  wire(vb, 'out', mix, 'in2');
  wire(pc, 'pitch', gc, 'in');
  wire(pc, 'jump', gc, 'p1');
  wire(gc, 'out', oc, 'pitch');
  wire(pc, 'gate', ec, 'gate');
  wire(oc, 'out', vc, 'in');
  wire(ec, 'env', vc, 'cv');
  wire(vc, 'out', mix, 'in3');
  wire(mix, 'out', dly, 'in');
  wire(dly, 'out', out, 'l');
  wire(dly, 'r', out, 'r');
  layers.push([pa, oa, ea, va], [pb, ob, eb, vb], [pc, gc, oc, ec, vc]);
});
polyAsm(tests['poly-layers'], layers[0], { parts: 3, assign: 0, priority: 0 });
polyAsm(tests['poly-layers'], layers[1], { parts: 2, assign: 2, priority: 1, legato: 2 });
polyAsm(tests['poly-layers'], layers[2], { parts: 1, priority: 2, legato: 1 });
// single notes first (rotate moves on, lowest stays on part 0, reuse returns to a key's part), then a chord past every
// group's part count (take-over by priority), staggered releases
events['poly-layers'] = [
  [0, 'on', 60],
  [128 * 8, 'off', 60],
  [128 * 16, 'on', 62],
  [128 * 24, 'off', 62],
  [128 * 32, 'on', 60],
  [128 * 40, 'on', 64],
  [128 * 48, 'on', 67],
  [128 * 56, 'on', 69],
  [128 * 64, 'on', 55],
  [128 * 72, 'off', 64],
  [128 * 80, 'on', 72],
  [128 * 96, 'off', 60],
  [128 * 100, 'off', 67],
  [128 * 104, 'off', 69],
  [128 * 108, 'off', 55],
  [128 * 112, 'off', 72],
];
// Shared unison: hear the selected pitches and the number of held voices.
for (const priority of [0, 1, 2]) {
  const name = `unison-share-${priority}`;
  let ids: number[] = [];
  kit(name, (add, wire) => {
    add('fm1', 0, 0);
    const part = add('part', 0, 0), pitch = add('vca', 0, 0), out = add('output', 0, 0, { level: .1 });
    wire(part, 'pitch', pitch, 'in'); wire(part, 'gate', pitch, 'cv'); wire(pitch, 'out', out, 'l');
    wire(part, 'gate', out, 'r'); ids = [part, pitch];
  });
  polyAsm(tests[name], ids, { parts: 4, unison: true, unisonShare: true, priority });
  const keys = [72, 60, 64, 67, 55, 50];
  events[name] = keys.map((key, i) => [i * 128, 'on', key] as Ev);
  events[name].push(...[50, 55, 60, 64, 67, 72].map((key, i) => [(i + 6) * 128, 'off', key] as Ev));
  // All 128 keys exercise the former C held-list limit and returning to notes that remain down.
  for (let key = 0; key < 128; key++) events[name].push([(key + 12) * 128, 'on', key]);
  for (let key = 0; key < 128; key++) events[name].push([(key + 140) * 128, 'off', key]);
  ends[name] = 269 * 128;
}
// A separate unison count limits held voices without changing the allocated poly pool.
for (const stack of [0, 1, 2, 4, 8]) for (const priority of [0, 1, 2]) {
  const name = `unison-count-${stack}-${priority}`;
  let ids: number[] = [];
  kit(name, (add, wire) => {
    add('fm1', 0, 0);
    const part = add('part', 0, 0), pitch = add('vca', 0, 0), mode = add('vca', 0, 0);
    const out = add('output', 0, 0, { level: .2 });
    wire(part, 'pitch', pitch, 'in'); wire(part, 'gate', pitch, 'cv'); wire(pitch, 'out', out, 'l');
    wire(part, 'unison', mode, 'in'); wire(part, 'gate', mode, 'cv'); wire(mode, 'out', out, 'r');
    ids = [part, pitch, mode];
  });
  polyAsm(tests[name], ids, { parts: 4, unison: true, unisonParts: stack, priority });
  events[name] = [[0, 'on', 60], [128, 'on', 67], [256, 'on', 55], [384, 'off', 67],
    [512, 'off', 55], [640, 'off', 60], [768, 'on', 72], [896, 'off', 72]];
  ends[name] = 1024;
}
// Extreme-note flags are observable per voice: multiply by that voice's pitch before summing.
for (const unison of [false, true]) for (const steal of [false, true]) {
  const name = `voice-extremes-${unison}-${steal}`;
  let ids: number[] = [];
  kit(name, (add, wire) => {
    add('fm1', 0, 0);
    const part = add('part', 0, 0), low = add('vca', 0, 0), high = add('vca', 0, 0);
    const out = add('output', 0, 0, { level: .2 });
    wire(part, 'pitch', low, 'in'); wire(part, 'low', low, 'cv'); wire(low, 'out', out, 'l');
    wire(part, 'pitch', high, 'in'); wire(part, 'high', high, 'cv'); wire(high, 'out', out, 'r');
    ids = [part, low, high];
  });
  polyAsm(tests[name], ids, { parts: 3, unison, steal });
  events[name] = [[0, 'on', 67], [128, 'on', 60], [256, 'on', 64], [384, 'on', 72], [512, 'off', 60],
    [640, 'off', 67], [768, 'off', 72], [896, 'off', 64], [1280, 'on', 55], [1408, 'off', 55]];
  ends[name] = 1536;
}
// Allocation is observable without oscillators: held voice indices left, their pitches right.
for (const assign of [0, 1, 2, 3]) for (const priority of [0, 1, 2]) for (const steal of assign === 3 ? [false, true] : [false]) {
  const name = `alloc-modes-${assign}-${priority}-${steal}`;
  let ids: number[] = [];
  kit(name, (add, wire) => {
    add('fm1', 0, 0);
    const part = add('part', 0, 0), left = add('vca', 0, 0), right = add('vca', 0, 0);
    const out = add('output', 0, 0, { level: 1 });
    wire(part, 'index', left, 'in'); wire(part, 'gate', left, 'cv'); wire(left, 'out', out, 'l');
    wire(part, 'pitch', right, 'in'); wire(part, 'gate', right, 'cv'); wire(right, 'out', out, 'r');
    ids = [part, left, right];
  });
  polyAsm(tests[name], ids, { parts: 3, assign, priority, steal });
  events[name] = [
    [0, 'on', 60], [128, 'on', 61], [256, 'on', 62], [384, 'on', 63],
    [512, 'off', 61], [640, 'off', 62], [768, 'off', 63],
    [896, 'on', 64], [1024, 'off', 64], [1152, 'on', 65],
    [1280, 'off', 60], [1408, 'off', 65], [1536, 'on', 67], [1664, 'off', 67],
    [1792, 'on', 69], [1920, 'off', 69],
  ];
  ends[name] = 2048;
}
// four parts, lowest free, every part with its own flaws: a fixed Random (tolerance) on each part's cutoff, a walking one (drift, its rate swept
// by a shared LFO) on its pitch, the Part's index on the pan; a walking Random outside (the shared keyboard's)
// on every part's resonance
const randomParts: number[] = [];
kit('part-random', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const rf = add('random', 0, 0, { mode: 0 });
  const rw = add('random', 0, 0, { mode: 1, rate: 4 }, { map: { p1: ['rate'] }, att: [0.5, 1] });
  const rs = add('random', 0, 0, { mode: 1, rate: 2 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 }, { map: { p1: ['fine'] }, att: [0.3, 1] });
  const flt = add('filter', 0, 0, { cutoff: 1200, res: 0.3 }, { map: { p1: ['cutoff'], p2: ['res'] }, att: [0.3, 0.2] });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.6, r: 0.1 });
  const vca = add('vca', 0, 0);
  const pan = add('pan', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(lfo, 'out', rw, 'p1');
  wire(rw, 'out', osc, 'p1');
  wire(rf, 'out', flt, 'p1');
  wire(rs, 'out', flt, 'p2');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', vca, 'in');
  wire(pt, 'gate', env, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', pan, 'in');
  wire(pt, 'index', pan, 'pos');
  wire(pan, 'l', out, 'l');
  wire(pan, 'r', out, 'r');
  randomParts.push(pt, rf, rw, osc, flt, env, vca, pan);
});
polyAsm(tests['part-random'], randomParts, {
  parts: 4, assign: 1,
  flaws: [{ detune: 12, drift: 60, bright: -5, env: 30, level: 90 }, { detune: -20, drift: 100, bright: 7, env: -40, level: 100 }, { detune: 0, drift: 0, bright: 0, env: 0, level: 70 }],
});
events['part-random'] = POLY_EVENTS;
ends['part-random'] = 128 * 400;
// the part flaws alone, every kind at its ends: detune and drift on the Part's pitch, bright on a filter and a ladder,
// env on an ADSR and an envelope, level on the VCA; four parts, a chord
const flawParts: number[] = [];
kit('part-flaws', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.3 });
  const lad = add('ladder', 0, 0, { cutoff: 2500, res: 0.2 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.15, s: 0.5, r: 0.08 });
  const lr = add('env', 0, 0, { r1: 0.02, r2: 0.1, r3: 0.3, r4: 0.05 });
  const vca = add('vca', 0, 0);
  const vca2 = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', lad, 'in');
  wire(lad, 'lp24', vca, 'in');
  wire(pt, 'gate', env, 'gate');
  wire(pt, 'gate', lr, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', vca2, 'in');
  wire(lr, 'env', vca2, 'cv');
  wire(vca2, 'out', out, 'l');
  flawParts.push(pt, osc, flt, lad, env, lr, vca, vca2);
});
polyAsm(tests['part-flaws'], flawParts, {
  parts: 4,
  flaws: [
    { detune: 50, drift: 100, bright: 24, env: 50, level: 100 },
    { detune: -50, drift: 0, bright: -24, env: -50, level: 50 },
    { detune: 7, drift: 40, bright: 3, env: 10, level: 0 },
  ],
});
events['part-flaws'] = POLY_EVENTS;
// unison: four voices on the one note the priority picks (high), legato off so every change of key restarts the envelopes
// of all four; the voices are told apart by their detune flaws and by the index into the pulse width
const unisonParts: number[] = [];
kit('alloc-unison', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const osc = add('osc', 0, 0, { wave: 3, level: 0.2 }, { map: { p1: ['pw'] }, att: [0.3, 1] });
  const env = add('adsr', 0, 0, { a: 0.02, d: 0.1, s: 0.5, r: 0.08 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(pt, 'index', osc, 'p1');
  wire(pt, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
  unisonParts.push(pt, osc, env, vca);
});
polyAsm(tests['alloc-unison'], unisonParts, {
  parts: 4, unison: true, priority: 2, legato: 1,
  flaws: [{ detune: 12, drift: 0, bright: 0, env: 0, level: 100 }, { detune: -9, drift: 0, bright: 0, env: 0, level: 100 }, { detune: 4, drift: 30, bright: 0, env: 0, level: 100 }],
});
events['alloc-unison'] = POLY_EVENTS;
// a paraphonic group (#125): three oscillator parts and no envelope of their own, summed into one filter and VCA that run
// once; each part reaches them at a third (engine.ts paraMix, engine.c para_w), the Part's gate at full
const paraParts: number[] = [];
kit('paraphonic', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.6 });
  const flt = add('filter', 0, 0, { cutoff: 1800, res: 0.3 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.2, s: 0.6, r: 0.1 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.7 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(pt, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
  paraParts.push(pt, osc);
});
polyAsm(tests['paraphonic'], paraParts, { parts: 3 });
events['paraphonic'] = POLY_EVENTS;
// key ranges and channels (allocator channel / low / high): A takes the keys below C4 on any channel (two parts), B the
// keys from C4 up on channel 2 only (two parts), C channel 3 only (one part). Notes on channel 1 above C4 and on channel 4
// above C4 sound nowhere; an off on the wrong channel does not end B's note.
const splits: number[][] = [];
kit('alloc-split', (add, wire) => {
  add('fm1', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5, l3: 0.5 });
  const out = add('output', 0, 0, { level: 0.6 });
  [[1, 0], [0, 12], [3, 7]].forEach(([wave, coarse], i) => {
    const pt = add('part', 0, 0);
    const osc = add('osc', 0, 0, { wave, coarse, level: 0.3 });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.1, s: 0.6, r: 0.08 });
    const vca = add('vca', 0, 0);
    wire(pt, 'pitch', osc, 'pitch');
    wire(pt, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', mix, `in${i + 1}`);
    splits.push([pt, osc, env, vca]);
  });
  wire(mix, 'out', out, 'l');
});
polyAsm(tests['alloc-split'], splits[0], { parts: 2, high: 59 });
polyAsm(tests['alloc-split'], splits[1], { parts: 2, channel: 2, low: 60 });
polyAsm(tests['alloc-split'], splits[2], { parts: 1, channel: 3 });
events['alloc-split'] = [
  [0, 'on', 48, 1],
  [128 * 10, 'on', 64, 1],
  [128 * 20, 'on', 67, 2],
  [128 * 30, 'on', 55, 2],
  [128 * 40, 'on', 72, 3],
  [128 * 50, 'on', 74, 4],
  [128 * 60, 'off', 67, 1],
  [128 * 70, 'off', 48, 1],
  [128 * 80, 'off', 72, 3],
  [128 * 90, 'off', 67, 2],
  [128 * 90, 'off', 55, 2],
  [128 * 90, 'off', 64, 1],
  [128 * 90, 'off', 74, 4],
];
ends['part-flaws'] = 128 * 400;
kit('dyn', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.9 });
  const adsr = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.3, r: 0.1 });
  const vca = add('vca', 0, 0);
  const dyn = add('dyn', 0, 0, { thresh: -18, ratio: 8, attack: 0.003, release: 0.08, gain: 6 });
  const osc2 = add('osc', 0, 0, { wave: 0, level: 0.5, coarse: 12 });
  const vca2 = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.4 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'pitch', osc2, 'pitch');
  wire(kb, 'gate', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(vca, 'out', dyn, 'in');
  wire(dyn, 'out', mix, 'in1');
  wire(osc2, 'out', vca2, 'in');
  wire(dyn, 'env', vca2, 'cv');
  wire(vca2, 'out', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
// the Follower (the MS-20's ESP): its pitch and envelope outputs on a played saw (left: pitch in octaves, right: env)
kit('esp-pitch', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const adsr = add('adsr', 0, 0, { a: 0.01, d: 0.2, s: 0.5, r: 0.1 });
  const vca = add('vca', 0, 0);
  const esp = add('esp', 0, 0, { level: 1.5, lowcut: 60, highcut: 1500, thresh: 0.2 });
  const out = add('output', 0, 0, { level: 0.5 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(vca, 'out', esp, 'in');
  wire(esp, 'pitch', out, 'l');
  wire(esp, 'env', out, 'r');
});
// the manual's patch (F-V CV OUT to a VCO, TRIG OUT to an envelope, ENV OUT to the VCA) with cv adjust a fifth up, and the
// band-passed signal mixed in
kit('esp-follow', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const src = add('osc', 0, 0, { wave: 0, level: 0.6, coarse: -12 });
  const esp = add('esp', 0, 0, { level: 1, lowcut: 40, highcut: 800, cvadj: 7, thresh: 0.15 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const adsr = add('adsr', 0, 0, { a: 0.005, d: 0.1, s: 0.6, r: 0.2 });
  const vca = add('vca', 0, 0);
  const vca2 = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.3 });
  const out = add('output', 0, 0);
  const gate = add('adsr', 0, 0, { a: 0.001, d: 0.001, s: 1, r: 0.05 });
  const amp = add('vca', 0, 0);
  wire(kb, 'pitch', src, 'pitch');
  wire(kb, 'gate', gate, 'gate');
  wire(src, 'out', amp, 'in');
  wire(gate, 'env', amp, 'cv');
  wire(amp, 'out', esp, 'in');
  wire(esp, 'pitch', osc, 'pitch');
  wire(esp, 'trig', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(vca, 'out', vca2, 'in');
  wire(esp, 'env', vca2, 'cv');
  wire(vca2, 'out', mix, 'in1');
  wire(esp, 'bp', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
kit('math-logic', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const lfo1 = add('lfo', 0, 0, { wave: 3, rate: 3, depth: 1 });
  const lfo2 = add('lfo', 0, 0, { wave: 3, rate: 5, depth: 1 });
  const lfo3 = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const lg = add('logic', 0, 0);
  const mt = add('math', 0, 0, { ka: 0.5, kb: 0.3, off: 0.1 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const adsr = add('adsr', 0, 0, { a: 0.002, d: 0.08, s: 0.2, r: 0.05 });
  const vca = add('vca', 0, 0);
  const vca2 = add('vca', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(lfo1, 'out', lg, 'a');
  wire(lfo2, 'out', lg, 'b');
  wire(lg, 'xor', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(lfo3, 'out', mt, 'a');
  wire(lfo1, 'out', mt, 'b');
  wire(mt, 'max', vca2, 'cv');
  wire(vca, 'out', vca2, 'in');
  wire(vca2, 'out', out, 'l');
  wire(mt, 'abs', osc, 'pitch');
});
kit('grain', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const adsr = add('adsr', 0, 0, { a: 0.01, d: 0.3, s: 0.5, r: 0.2 });
  const vca = add('vca', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 3, rate: 6, depth: 1 });
  // size 0.0625 is exact in Q16 and keeps len x rate clear of an integer at 44118 Hz (0.06 put span on the edge: the C
  // engine's exp2 rate is a hair lower than 2^(7/12), so the grains started one sample apart)
  const gr = add('grain', 0, 0, { position: 0.25, size: 0.0625, density: 15, pitch: 7, spray: 0.3, mix: 0.7 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(vca, 'out', gr, 'in');
  wire(lfo, 'out', gr, 'trig');
  wire(gr, 'out', out, 'l');
});
kit('comb', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const cb = add('comb', 0, 0, { fb: -0.85, damp: 0.3, mix: 0.8, coarse: 7 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'pitch', cb, 'pitch');
  wire(osc, 'out', cb, 'in');
  wire(cb, 'out', out, 'l');
});
// the phase distortion oscillator: each bend at a fixed dcw, a second waveform on the odd cycles (a bend with a
// resonance), one note three octaves up where the band limit holds the dcw back
const pdMix = (oscs: Record<string, number>[], extra?: (add: Parameters<Build>[0], wire: Parameters<Build>[1], kb: number, ids: number[]) => void): Build =>
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const mix = add('mixer', 0, 0, { l1: 0.25, l2: 0.25, l3: 0.25, l4: 0.25 });
    const out = add('output', 0, 0);
    const ids = oscs.map((p, i) => {
      const o = add('pd', 0, 0, { level: 0.9, ...p });
      wire(kb, 'pitch', o, 'pitch');
      wire(o, 'out', mix, `in${i + 1}`);
      return o;
    });
    extra?.(add, wire, kb, ids);
    wire(mix, 'out', out, 'l');
  };
kit('pd-bends', pdMix([{ wave: 0, dcw: 1 }, { wave: 1, dcw: 0.7, coarse: -12 }, { wave: 2, dcw: 0.5 }, { wave: 3, dcw: 0.9, coarse: 12 }]));
kit('pd-alt', pdMix([{ wave: 4, dcw: 0.8 }, { wave: 0, wave2: 3, dcw: 0.6 }, { wave: 1, wave2: 6, dcw: 0.7, range: 2 }, { wave: 2, dcw: 1, coarse: 36 }]));
// the resonance windows with the dcw from an envelope (its input; the parameter 0), sync from a slower oscillator, phase
// modulation from a sine
kit('pd-reso', pdMix([{ wave: 5, dcw: 0, range: 3 }, { wave: 6, dcw: 0, range: 4 }, { wave: 7, dcw: 0.2, range: 2.5, coarse: 12 }, { wave: 0, dcw: 0.4, pm: 1.5 }], (add, wire, kb, ids) => {
  const env = add('adsr', 0, 0, { a: 0.2, d: 0.6, s: 0.4, r: 0.3 });
  wire(kb, 'gate', env, 'gate');
  for (const o of ids.slice(0, 3)) wire(env, 'env', o, 'dcw');
  const sy = add('osc', 0, 0, { wave: 3, coarse: -19, level: 1 });
  wire(kb, 'pitch', sy, 'pitch');
  wire(sy, 'out', ids[1], 'sync');
  const mod = add('osc', 0, 0, { wave: 0, coarse: 7, level: 1 });
  wire(kb, 'pitch', mod, 'pitch');
  wire(mod, 'out', ids[3], 'pm');
}));
kit('modal', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const pl = add('pulse', 0, 0, { time: 0.002 });
  const nz = add('noise', 0, 0, { level: 0.8 });
  const vca = add('vca', 0, 0);
  const md = add('modal', 0, 0, { decay: 1.2, struct: 0.4, bright: 0.6, damp: 0.4 });
  const out = add('output', 0, 0);
  wire(kb, 'gate', pl, 'trig');
  wire(nz, 'out', vca, 'in');
  wire(pl, 'out', vca, 'cv');
  wire(vca, 'out', md, 'in');
  wire(kb, 'pitch', md, 'pitch');
  wire(md, 'out', out, 'l');
});
// rates and modal settings that move every block (LFOs into p1 / p2): the firmware works their divisions out only when
// they change (#289), so this kit checks it notices each change
kit('moving-rates', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const l1 = add('lfo', 0, 0, { wave: 1, rate: 3.1, depth: 0.9 });
  const l2 = add('lfo', 0, 0, { wave: 4, rate: 7, depth: 0.7 });
  const ad = add('adsr', 0, 0, { a: 0.02, d: 0.15, s: 0.5, r: 0.2 }, { map: { p1: ['a', 'r'], p2: ['d'] } });
  const en = add('env', 0, 0, {}, { map: { p1: ['r1', 'r3'], p2: ['r2', 'r4'] } });
  const nz = add('noise', 0, 0, { level: 0.3 });
  const md = add('modal', 0, 0, { decay: 0.8, struct: 0.3, bright: 0.5, damp: 0.3 }, { map: { p1: ['decay'], p2: ['bright', 'damp'] } });
  const o = add('osc', 0, 0, { wave: 3, pw: 0.4, level: 0.7 });
  const va = add('vca', 0, 0);
  const vb = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.4, l3: 0.4 });
  const out = add('output', 0, 0);
  [ad, en, md].forEach((m) => { wire(l1, 'out', m, 'p1'); wire(l2, 'out', m, 'p2'); });
  wire(kb, 'gate', ad, 'gate');
  wire(kb, 'gate', en, 'gate');
  wire(kb, 'pitch', o, 'pitch');
  wire(o, 'out', va, 'in');
  wire(ad, 'env', va, 'cv');
  wire(o, 'out', vb, 'in');
  wire(en, 'env', vb, 'cv');
  wire(nz, 'out', md, 'in');   // a steady input, so the gains (bright) count all the time
  wire(kb, 'pitch', md, 'pitch');
  wire(va, 'out', mix, 'in1');
  wire(vb, 'out', mix, 'in2');
  wire(md, 'out', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
// the eight-step envelope: a sustain mid-way (the release jumps past it, rising and falling steps after it), sus off (the
// steps run through the gate), sus = end; its rates moved by LFOs (the firmware caches one step's rates)
kit('env8', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const l1 = add('lfo', 0, 0, { wave: 1, rate: 2.3, depth: 0.8 });
  const steps = { l1: 1, r1: 0.004, l2: 0.3, r2: 0.05, l3: 0.7, r3: 0.08, l4: 0.5, r4: 0.03, l5: 0.9, r5: 0.06, l6: 0.2, r6: 0.1, l7: 0.6, r7: 0.02, l8: 0, r8: 0.15 };
  const ea = add('env8', 0, 0, { ...steps, sus: 3, end: 8 }, { map: { p1: ['r2', 'r5', 'l4'] } });
  const l2 = add('lfo', 0, 0, { wave: 3, rate: 1.7, depth: 1 });
  const eb = add('env8', 0, 0, { ...steps, sus: 1, end: 6 }, { map: { p2: ['sus', 'end'] }, att: [1, 0.25] }); // sus and end moved (u32 masks)
  const ec = add('env8', 0, 0, { ...steps, sus: 5, end: 5 });
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.4, l3: 0.4 });
  const out = add('output', 0, 0);
  wire(l1, 'out', ea, 'p1');
  wire(l2, 'out', eb, 'p2');
  [ea, eb, ec].forEach((e, i) => {
    const o = add('osc', 0, 0, { wave: i + 1, coarse: i * 7 - 7, level: 0.7 });
    const v = add('vca', 0, 0);
    wire(kb, 'pitch', o, 'pitch');
    wire(kb, 'gate', e, 'gate');
    wire(o, 'out', v, 'in');
    wire(e, 'env', v, 'cv');
    wire(v, 'out', mix, `in${i + 1}`);
  });
  wire(mix, 'out', out, 'l');
});
// the gate also routed to ec's end (a u32 route mask): held, all eight steps; let go, the end is 5
tests['env8'].modules.filter((m) => m.type === 'env8')[2].inputMap = { gate: ['end'] };
// in a poly assembly, with the env flaw: released parts go idle once their steps have run
const env8Parts: number[] = [];
kit('env8-poly', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const o = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const e = add('env8', 0, 0, { l1: 1, r1: 0.003, l2: 0.4, r2: 0.08, l3: 0.6, r3: 0.05, l4: 0.1, r4: 0.06, l5: 0.3, r5: 0.04, l6: 0, r6: 0.1, sus: 3, end: 6 });
  const v = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', o, 'pitch');
  wire(pt, 'gate', e, 'gate');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
  env8Parts.push(pt, o, e, v);
});
polyAsm(tests['env8-poly'], env8Parts, { parts: 4, flaws: [{ detune: 0, drift: 0, bright: 0, env: 40, level: 100 }, { detune: 0, drift: 0, bright: 0, env: -30, level: 100 }] });
events['env8-poly'] = POLY_EVENTS;
const rateEnvParts: number[] = [];
kit('rateenv-poly', (add, wire) => {
  const main = add('fm1', 0, 0), pt = add('part', 0, 0), env = add('rateenv', 0, 0, { ar: 24, d1r: 24, d1l: 12, d2r: 0, rr: 15, krs: 2 });
  const out = add('output', 0, 0, { level: 0.2 });
  wire(pt, 'gate', env, 'gate'); wire(pt, 'pitch', env, 'pitch'); wire(main, 'sustain', env, 'hold');
  wire(env, 'env', out, 'l'); rateEnvParts.push(pt, env);
});
polyAsm(tests['rateenv-poly'], rateEnvParts, { parts: 4 });
events['rateenv-poly'] = POLY_EVENTS;
kit('rateenv-live', (add, wire) => {
  const main = add('fm1', 0, 0), env = add('rateenv', 0, 0, { ar: 0, d1r: 0, d1l: 0, d2r: 0, rr: 0, krs: 0 },
    { map: { p1: ['ar', 'd1r', 'd1l', 'd2r', 'rr', 'krs'] } });
  const out = add('output', 0, 0, { level: 1 });
  wire(main, 'gate', env, 'gate'); wire(main, 'pitch', env, 'pitch'); wire(main, 'mod', env, 'p1');
  wire(env, 'env', out, 'l');
});
events['rateenv-live'] = [[0, 'on', 60], [128 * 20, 'cc', 1, 64], [128 * 50, 'cc', 1, 127],
  [128 * 70, 'cc', 1, 0], [128 * 100, 'cc', 1, 96], [128 * 110, 'off', 60]];
kit('shift', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.6 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const sh = add('shift', 0, 0, { shift: 80, cvamt: 200, mix: 0.9 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', sh, 'in');
  wire(lfo, 'out', sh, 'cv');
  wire(sh, 'up', out, 'l');
  wire(sh, 'down', out, 'r');
});
kit('bypass', (add, wire) => {
  // a bypassed filter (in -> every output), pan (in -> l, r) and LFO (silent, so the level stays at its base)
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 }, { map: { p1: ['level'] } });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 1 });
  const flt = add('filter', 0, 0, { cutoff: 120, res: 0.5 });
  const lad = add('ladder', 0, 0, { cutoff: 900, res: 0.3, drive: 2 });
  const pan = add('pan', 0, 0, { pan: 0.8 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(lfo, 'out', osc, 'p1');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp24', lad, 'in');
  wire(flt, 'hp', pan, 'pos');
  wire(lad, 'lp24', pan, 'in');
  wire(pan, 'l', out, 'l');
  wire(pan, 'r', out, 'r');
});
for (const m of tests.bypass.modules) if (['filter', 'pan', 'lfo'].includes(m.type)) m.bypass = true;
kit('ladder', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 2, depth: 0.6 });
  const lad = add('ladder', 0, 0, { cutoff: 500, res: 0.85, drive: 3, cvamt: 2, track: 1 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.3 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', lad, 'in');
  wire(lfo, 'out', lad, 'cv');
  wire(lad, 'lp24', mix, 'in1');
  wire(lad, 'lp12', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
kit('ladder-audio-fm', (add, wire) => {
  const input = add('osc', 0, 0, { wave: 2, level: .4 });
  const fm = add('osc', 0, 0, { wave: 0, coarse: 17, level: .6 });
  const cv = add('const', 0, 0, { value: .15 });
  const filter = add('ladder', 0, 0, { cutoff: 800, cvamt: 3, res: .3 });
  const out = add('output', 0, 0, { level: 1 });
  wire(input, 'out', filter, 'in');
  wire(fm, 'out', filter, 'fm');
  wire(cv, 'out', filter, 'cv');
  wire(filter, 'lp24', out, 'l');
  wire(filter, 'lp12', out, 'r');
});
kit('fm1-panel', (add, wire) => {
  const pn = add('fm1', 0, 0);
  const m3 = add('macro', 0, 0, { value: 0.4 }); // (Main's knobs were outputs once: Macro modules play their part)
  const m1 = add('macro', 0, 0, { value: 0.2 });
  const osc = add('osc', 0, 0, { wave: 2 }, { map: { p1: ['level'], p2: ['fine'] } });
  const out = add('output', 0, 0);
  wire(pn, 'pitch', osc, 'pitch');
  wire(m3, 'out', osc, 'p1');
  wire(m1, 'out', osc, 'p2');
  wire(osc, 'out', out, 'l');
});
kit('delay-fb', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 1, level: 0.5 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
  const vca = add('vca', 0, 0);
  const dly = add('delay', 0, 0, { time: 100, fb: 0.6, mix: 0.5 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', dly, 'in');
  wire(dly, 'out', out, 'l');
  wire(dly, 'out', out, 'r');
});
const delayKit = (name: string, params: Record<string, number>): void =>
  kit(name, (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 1, level: 0.5 });
    const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
    const vca = add('vca', 0, 0);
    const dly = add('delay', 0, 0, { fb: 0.6, mix: 0.5, ...params });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', dly, 'in');
    wire(dly, 'out', out, 'l');
    wire(dly, 'r', out, 'r');
  });
delayKit('delay-pingpong', { time: 120, pingpong: 1 });
delayKit('delay-sync', { sync: 1, div: 5, bpm: 133 });
delayKit('delay-sync-pingpong', { sync: 1, div: 6, bpm: 90, pingpong: 1 });
// #351: the extra note lengths (1/32; 1/2T, longer than the ping-pong half, is cut to it) and the swelling feedback
delayKit('delay-sync-note', { sync: 1, note: 1 });
delayKit('delay-sync-note-pingpong', { sync: 1, note: 2, pingpong: 1 });
delayKit('delay-swell', { time: 60, fb: 0.8, swell: 1 });
delayKit('delay-swell-pingpong', { time: 45, fb: 0.95, swell: 1, pingpong: 1 });
kit('feedback-pm', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 0, pm: 2 });
  const vca = add('vca', 0, 0, { gain: 0.7 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.2, s: 0.6, r: 0.2 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', osc, 'pm');
  wire(vca, 'out', out, 'l');
});
kit('osc-feedback', (add, wire) => {
  // operator feedback on a sine (saw-like), a square with feedback, both through the envelope
  const kb = add('fm1', 0, 0);
  const a = add('osc', 0, 0, { wave: 0, fb: 0.5 });
  const b = add('osc', 0, 0, { wave: 3, fb: 0.3, coarse: -12, level: 0.4 });
  const vca = add('vca', 0, 0, { gain: 0.6 });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.3, s: 0.5, r: 0.2 });
  const mix = add('mixer', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', a, 'pitch');
  wire(kb, 'pitch', b, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(a, 'out', mix, 'in1');
  wire(b, 'out', mix, 'in2');
  wire(mix, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
for (const wave of [4, 5]) for (const mode of ['plain', 'unison', 'sync', 'fm', 'feedback']) {
  kit(`osc-wave-${wave}-${mode}`, (add, wire) => {
    const carrier = add('osc', 0, 0, { wave, level: .3, coarse: -12, unison: mode === 'unison' ? 3 : 1,
      detune: 8, pm: mode === 'fm' ? .5 : 0, fb: mode === 'feedback' ? .1 : 0 });
    if (mode === 'sync' || mode === 'fm') {
      const mod = add('osc', 0, 0, { wave: mode === 'sync' ? 3 : 0, coarse: -19, level: .8 });
      wire(mod, 'out', carrier, mode === 'sync' ? 'sync' : 'pm');
    }
    const out = add('output', 0, 0, { level: 1 });
    wire(carrier, 'out', out, 'l');
  });
}
kit('fm-2op', (add, wire) => {
  // two operators: modulator (ratio 2, its own envelope, velocity on the index) into the carrier's pm, carrier feedback 0.2
  const kb = add('fm1', 0, 0);
  const mod = add('osc', 0, 0, { wave: 0, coarse: 12, level: 1 });
  const car = add('osc', 0, 0, { wave: 0, pm: 3, fb: 0.2 });
  const menv = add('adsr', 0, 0, { a: 0.002, d: 0.25, s: 0.2, r: 0.2 });
  const aenv = add('adsr', 0, 0, { a: 0.002, d: 0.8, s: 0.4, r: 0.3 });
  const mvca = add('vca', 0, 0, { gain: 0.4 }, { map: { p1: ['gain'] }, att: [1, 1] });
  const avca = add('vca', 0, 0, { gain: 0.7 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', mod, 'pitch');
  wire(kb, 'pitch', car, 'pitch');
  wire(kb, 'gate', menv, 'gate');
  wire(kb, 'gate', aenv, 'gate');
  wire(kb, 'vel', mvca, 'p1');
  wire(mod, 'out', mvca, 'in');
  wire(menv, 'env', mvca, 'cv');
  wire(mvca, 'out', car, 'pm');
  wire(car, 'out', avca, 'in');
  wire(aenv, 'env', avca, 'cv');
  wire(avca, 'out', out, 'l');
  wire(avca, 'out', out, 'r');
});
kit('sync-glide-shape', (add, wire) => {
  // key-synced oscillator, a glide on its pitch, a synced LFO on the filter, the result through the shaper in each mode
  const kb = add('fm1', 0, 0);
  const gl = add('glide', 0, 0, { time: 0.08 });
  const osc = add('osc', 0, 0, { wave: 2 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 0.5 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.4, cvamt: 2 });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.3, s: 0.6, r: 0.2 });
  const vca = add('vca', 0, 0, { gain: 0.9 });
  const soft = add('shape', 0, 0, { drive: 4, mode: 0, level: 0.4 });
  const hard = add('shape', 0, 0, { drive: 3, mode: 1, level: 0.3 });
  const fold = add('shape', 0, 0, { drive: 6, mode: 2, level: 0.3 });
  const mix = add('mixer', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', gl, 'in');
  wire(gl, 'out', osc, 'pitch');
  wire(kb, 'gate', osc, 'sync');
  wire(kb, 'gate', lfo, 'reset');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', flt, 'cv');
  wire(flt, 'lp12', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', soft, 'in');
  wire(vca, 'out', hard, 'in');
  wire(vca, 'out', fold, 'in');
  wire(soft, 'out', mix, 'in1');
  wire(hard, 'out', mix, 'in2');
  wire(fold, 'out', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
kit(
  'spread',
  (add, wire) => {
    // three voices: spread detunes the oscillators (p1 -> fine) and sets each voice's level (p1 -> gain)
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 2 }, { map: { p1: ['fine'] }, att: [0.2, 1] });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.3, s: 0.6, r: 0.2 });
    const vca = add('vca', 0, 0, { gain: 0.4 }, { map: { p1: ['gain'] }, att: [0.3, 1] });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'spread', osc, 'p1');
    wire(kb, 'spread', vca, 'p1');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
  },
  3,
);
kit('summed-inputs', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const a = add('osc', 0, 0, { wave: 2, coarse: -12, level: 0.4 });
  const b = add('osc', 0, 0, { wave: 3, coarse: 7, level: 0.4 });
  const k = add('const', 0, 0, { value: 0.25 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', a, 'pitch');
  wire(kb, 'pitch', b, 'pitch');
  wire(a, 'out', vca, 'in');
  wire(b, 'out', vca, 'in');
  wire(k, 'out', vca, 'cv');
  wire(vca, 'out', out, 'l');
});

kit('matrix-att', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 3, depth: 1 });
  const k = add('const', 0, 0, { value: 0.5 });
  const osc = add('osc', 0, 0, { wave: 0, level: 0.6 }, { map: { p1: ['level'], p2: ['level'] }, att: [-0.5, 0.3] });
  const flt = add('filter', 0, 0, { cutoff: 800, res: 0.3 }, { map: { p1: ['cutoff', 'res'], p2: ['cvamt'] }, att: [0.3, -1] });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(lfo, 'out', osc, 'p1');
  wire(k, 'out', osc, 'p2');
  wire(lfo, 'out', flt, 'p1');
  wire(k, 'out', flt, 'p2');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', out, 'l');
});

kit('reverb', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 0, level: 0.8 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
  const vca = add('vca', 0, 0);
  const rv = add('reverb', 0, 0, { size: 0.8, damp: 0.3, mix: 0.6 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', rv, 'in');
  wire(rv, 'out', out, 'l');
});
// #351: the reverb frozen once the note has gone in (a slow envelope on p1 turns freeze on)
kit('reverb-freeze', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
  const slow = add('adsr', 0, 0, { a: 0.15, d: 0.1, s: 1, r: 0.05 });
  const vca = add('vca', 0, 0);
  const rv = add('reverb', 0, 0, { size: 0.5, damp: 0.5, mix: 0.7 }, { map: { p1: ['freeze'] } });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(kb, 'gate', slow, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', rv, 'in');
  wire(slow, 'env', rv, 'p1');
  wire(rv, 'out', out, 'l');
});
// #351: Pulse's inf switched on and off by a slow square on p1; the ADSR's long times, its decay also moved by an LFO
kit('pulse-inf', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const trig = add('lfo', 0, 0, { wave: 3, rate: 9, depth: 1 });
  const sw = add('lfo', 0, 0, { wave: 3, rate: 2.3, depth: 1 });
  const pl = add('pulse', 0, 0, { time: 0.02 }, { map: { p1: ['inf'] } });
  const osc = add('osc', 0, 0, { wave: 1, level: 0.7 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(trig, 'out', pl, 'trig');
  wire(sw, 'out', pl, 'p1');
  wire(osc, 'out', vca, 'in');
  wire(pl, 'out', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
kit('adsr-long', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.6 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 0.5 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.06, s: 0.3, r: 0.07, long: 1 }, { map: { p1: ['d'] } });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(lfo, 'out', env, 'p1');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});

// polyphony: osc -> filter (its own envelope on cv) -> vca (second envelope) per voice, one delay and the output shared
kit(
  'poly-pluck',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
    const fenv = add('adsr', 0, 0, { a: 0.002, d: 0.15, s: 0.1, r: 0.1 });
    const flt = add('filter', 0, 0, { cutoff: 300, res: 0.4, cvamt: 3 });
    const aenv = add('adsr', 0, 0, { a: 0.003, d: 0.4, s: 0.3, r: 0.2 });
    const vca = add('vca', 0, 0);
    const dly = add('delay', 0, 0, { time: 120, fb: 0.4, mix: 0.3 });
    const out = add('output', 0, 0, { level: 0.6 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', fenv, 'gate');
    wire(kb, 'gate', aenv, 'gate');
    wire(osc, 'out', flt, 'in');
    wire(fenv, 'env', flt, 'cv');
    wire(flt, 'lp24', vca, 'in');
    wire(aenv, 'env', vca, 'cv');
    wire(vca, 'out', dly, 'in');
    wire(dly, 'out', out, 'l');
    wire(vca, 'out', out, 'r');
  },
  4,
);
// polyphony with shared sources: one LFO (into every voice's filter p1) and one noise (through a per-voice VCA, velocity on
// its p1), a per-voice mixer with two cables into one input, the reverb and output shared; key tracking on the filter
kit(
  'poly-shared',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 3, pw: 0.3, level: 0.4 });
    const sub = add('osc', 0, 0, { wave: 1, coarse: -12, level: 0.3 });
    const lfo = add('lfo', 0, 0, { wave: 0, rate: 2, depth: 0.4 });
    const flt = add('filter', 0, 0, { cutoff: 600, res: 0.3, track: 1 }, { map: { p1: ['cutoff'] }, att: [0.5, 1] });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.5, r: 0.15 });
    const nz = add('noise', 0, 0, { level: 0.3 });
    const nvca = add('vca', 0, 0, { gain: 0.5 }, { map: { p1: ['gain'] } });
    const mix = add('mixer', 0, 0, { l1: 0.7, l2: 0.5 });
    const vca = add('vca', 0, 0);
    const rv = add('reverb', 0, 0, { size: 0.6, damp: 0.4, mix: 0.3 });
    const out = add('output', 0, 0, { level: 0.7 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'pitch', sub, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(lfo, 'out', flt, 'p1');
    wire(osc, 'out', flt, 'in');
    wire(sub, 'out', flt, 'in');
    wire(nz, 'out', nvca, 'in');
    wire(env, 'env', nvca, 'cv');
    wire(kb, 'vel', nvca, 'p1');
    wire(flt, 'lp12', mix, 'in1');
    wire(nvca, 'out', mix, 'in2');
    wire(mix, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', rv, 'in');
    wire(rv, 'out', out, 'l');
    wire(rv, 'out', out, 'r');
  },
  3,
);
// a feedback cable inside a voice (the VCA back into the oscillator's phase) and a shared delay fed back into every voice's mixer
kit(
  'poly-feedback',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 0, pm: 1.5, level: 0.6 });
    const env = add('adsr', 0, 0, { a: 0.01, d: 0.3, s: 0.4, r: 0.2 });
    const vca = add('vca', 0, 0, { gain: 0.6 });
    const mix = add('mixer', 0, 0, { l1: 0.8, l2: 0.3 });
    const dly = add('delay', 0, 0, { time: 90, fb: 0.3, mix: 1 });
    const out = add('output', 0, 0, { level: 0.5 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', osc, 'pm');
    wire(vca, 'out', mix, 'in1');
    wire(dly, 'out', mix, 'in2');
    wire(mix, 'out', dly, 'in');
    wire(mix, 'out', out, 'l');
  },
  2,
);

// the level / rate envelope on the amplitude and (through a Scale) on the pitch of an FM pair
kit('env-lr', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const mod = add('osc', 0, 0, { wave: 0, coarse: 12, level: 0.8 });
  const car = add('osc', 0, 0, { wave: 0, pm: 2.5 });
  const ea = add('env', 0, 0, { l1: 1, r1: 0.005, l2: 0.3, r2: 0.15, l3: 0.5, r3: 0.4, l4: 0, r4: 0.3 });
  const ep = add('env', 0, 0, { l1: 1, r1: 0.002, l2: 0, r2: 0.08, l3: 0.2, r3: 0.5, l4: 0.6, r4: 0.2 });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: -0.25 });
  const va = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', mod, 'pitch');
  wire(kb, 'pitch', car, 'pitch');
  wire(ep, 'env', sc, 'in');
  wire(sc, 'out', car, 'pitch');
  wire(kb, 'gate', ea, 'gate');
  wire(kb, 'gate', ep, 'gate');
  wire(mod, 'out', car, 'pm');
  wire(car, 'out', va, 'in');
  wire(ea, 'env', va, 'cv');
  wire(va, 'out', out, 'l');
});
// two plucked strings per voice (noise and pulse bursts, damp and decay apart), plus one rung by an oscillator
kit(
  'string',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const s1 = add('string', 0, 0, { decay: 1.5, damp: 0.3, burst: 0, level: 0.6 });
    const s2 = add('string', 0, 0, { decay: 0.4, damp: 0.7, burst: 1, coarse: 12, level: 0.5 });
    const o = add('osc', 0, 0, { wave: 3, pw: 0.1, coarse: -24, level: 0.03 });
    const s3 = add('string', 0, 0, { decay: 2, damp: 0.1, coarse: 7, level: 0.3 });
    const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.6, l3: 0.4 });
    const out = add('output', 0, 0, { level: 0.6 });
    wire(kb, 'pitch', s1, 'pitch');
    wire(kb, 'pitch', s2, 'pitch');
    wire(kb, 'pitch', s3, 'pitch');
    wire(kb, 'pitch', o, 'pitch');
    wire(kb, 'gate', s1, 'gate');
    wire(kb, 'gate', s2, 'gate');
    wire(o, 'out', s3, 'exc');
    wire(s1, 'out', mix, 'in1');
    wire(s2, 'out', mix, 'in2');
    wire(s3, 'out', mix, 'in3');
    wire(mix, 'out', out, 'l');
  },
  2,
);
// the original four banks, the position swept by an LFO through p1, one of them phase modulated and synced
kit('wavetable', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const mix = add('mixer', 0, 0, { l1: 0.3, l2: 0.3, l3: 0.3, l4: 0.3 });
  const out = add('output', 0, 0);
  const mod = add('osc', 0, 0, { wave: 0, coarse: 7, level: 0.5 });
  wire(kb, 'pitch', mod, 'pitch');
  [0, 1, 2, 3].forEach((b, i) => {
    const w = add('wavetable', 0, 0, { bank: b, pos: 0.5, coarse: i === 3 ? 12 : i * -12, fine: i * 5, pm: i === 1 ? 1.5 : 0, level: 0.7 }, { map: { p1: ['pos'] }, att: [0.5, 1] });
    wire(kb, 'pitch', w, 'pitch');
    wire(lfo, 'out', w, 'p1');
    if (i === 1) wire(mod, 'out', w, 'pm');
    if (i === 2) wire(kb, 'gate', w, 'sync');
    wire(w, 'out', mix, `in${i + 1}`);
  });
  wire(mix, 'out', out, 'l');
});
// EML COLOR in the base and upper mip ranges, plus the octave-up double-saw endpoint.
for (const mode of ['sweep', 'high', 'double-saw'] as const) {
  kit(`wavetable-eml-${mode}`, (add, wire) => {
    const kb = add('fm1', 0, 0);
    const w = add('wavetable', 0, 0, { bank: 4, pos: mode === 'double-saw' ? 1 : 0.5, coarse: mode === 'high' ? 24 : -12, level: 0.7 }, { map: { p1: ['pos'] }, att: [0.5, 1] });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', w, 'pitch');
    if (mode !== 'double-saw') {
      const sweep = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
      wire(sweep, 'out', w, 'p1');
    }
    wire(w, 'out', out, 'l');
  });
}
// a shared chorus on a two-voice saw pad, l and r to the output
kit(
  'chorus',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const o = add('osc', 0, 0, { wave: 2, level: 0.5 });
    const env = add('adsr', 0, 0, { a: 0.02, d: 0.3, s: 0.7, r: 0.3 });
    const vca = add('vca', 0, 0);
    const ch = add('chorus', 0, 0, { rate: 0.8, depth: 0.7, mix: 0.6 });
    const out = add('output', 0, 0, { level: 0.7 });
    wire(kb, 'pitch', o, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(o, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', ch, 'in');
    wire(ch, 'l', out, 'l');
    wire(ch, 'r', out, 'r');
  },
  2,
);

// a clocked sequence: square LFO -> clock divider -> pendulum sequencer -> quantizer -> oscillator; the sequencer's gate
// through a pulse into the envelope; the divider's d4 syncs the oscillator
kit('seq-clock', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const clk = add('lfo', 0, 0, { wave: 3, rate: 12, depth: 1 });
  const dv = add('clkdiv', 0, 0, { div: 2 });
  const sq = add('seq', 0, 0, { s1: 0, s2: 0.25, s3: 0.58, s4: -1, s5: 0.33, s6: 1, s7: 0.75, s8: 0.1, len: 7, dir: 2 });
  const qn = add('quant', 0, 0, { scale: 2, root: 9 });
  const pl = add('pulse', 0, 0, { time: 0.03 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.08, s: 0.3, r: 0.05 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(clk, 'out', dv, 'clock');
  wire(kb, 'gate', dv, 'reset');
  wire(dv, 'out', sq, 'clock');
  wire(kb, 'gate', sq, 'reset');
  wire(sq, 'out', qn, 'in');
  wire(qn, 'out', osc, 'pitch');
  wire(kb, 'pitch', osc, 'pitch');
  wire(sq, 'gate', pl, 'trig');
  wire(pl, 'out', env, 'gate');
  wire(dv, 'd4', osc, 'sync');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
// a random melody: noise sampled by a clock, quantized to a pentatonic, a tracked S&H on the filter; a random sequencer
// on the second voice's pulse width
kit(
  'sh-random',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const clk = add('lfo', 0, 0, { wave: 3, rate: 7, depth: 1 });
    const nz = add('noise', 0, 0, { level: 1 });
    const sh = add('sh', 0, 0, { mode: 0 });
    const qn = add('quant', 0, 0, { scale: 4, root: 2 });
    const tri = add('lfo', 0, 0, { wave: 1, rate: 0.3, depth: 1 });
    const th = add('sh', 0, 0, { mode: 1 });
    const sq = add('seq', 0, 0, { s1: -0.5, s2: 0.2, s3: 0.4, s4: -0.2, len: 4, dir: 3 });
    const osc = add('osc', 0, 0, { wave: 3, pw: 0.5, level: 0.6 }, { map: { p1: ['pw'] }, att: [0.4, 1] });
    const flt = add('filter', 0, 0, { cutoff: 600, res: 0.4, cvamt: 2 });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.15, s: 0.2, r: 0.1 });
    const vca = add('vca', 0, 0);
    const out = add('output', 0, 0, { level: 0.7 });
    wire(nz, 'out', sh, 'in');
    wire(clk, 'out', sh, 'clock');
    wire(sh, 'out', qn, 'in');
    wire(qn, 'out', osc, 'pitch');
    wire(kb, 'pitch', osc, 'pitch');
    wire(tri, 'out', th, 'in');
    wire(clk, 'out', th, 'clock');
    wire(th, 'out', flt, 'cv');
    wire(clk, 'out', sq, 'clock');
    wire(sq, 'out', osc, 'p1');
    wire(osc, 'out', flt, 'in');
    wire(flt, 'lp24', vca, 'in');
    wire(clk, 'out', env, 'gate');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
  },
  2,
);

// pan by the panel's spread (three voices) and a crossfade of two oscillators swept by an LFO
kit(
  'pan-xfade',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const o1 = add('osc', 0, 0, { wave: 2, level: 0.3 });
    const o2 = add('osc', 0, 0, { wave: 1, coarse: 7, level: 0.3 });
    const o3 = add('osc', 0, 0, { wave: 3, coarse: -12, pw: 0.3, level: 0.3 });
    const pn = add('pan', 0, 0, { pan: 0.1 });
    const lfo = add('lfo', 0, 0, { wave: 1, rate: 1.3, depth: 0.5 });
    const xf = add('xfade', 0, 0, { mix: 0.5 });
    const out = add('output', 0, 0, { level: 0.4 });
    wire(kb, 'pitch', o1, 'pitch');
    wire(kb, 'pitch', o2, 'pitch');
    wire(kb, 'pitch', o3, 'pitch');
    wire(kb, 'spread', pn, 'pos');
    wire(o1, 'out', pn, 'in');
    wire(o2, 'out', xf, 'a');
    wire(o3, 'out', xf, 'b');
    wire(lfo, 'out', xf, 'pos');
    wire(pn, 'l', out, 'l');
    wire(pn, 'r', out, 'r');
    wire(xf, 'out', out, 'l');
    wire(xf, 'out', out, 'r');
  },
  3,
);
// Selectors (#351): a = four inputs (three oscillators and a value) stepped by an LFO on its pos input, with a crossfade
// that a fast triangle on b's pos changes mid-way; b = a value table (no inputs) moved by p1 (an LFO) that transposes an
// oscillator, its gates opening VCAs; c = the poly copy (three voices), instant switching
kit(
  'select',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const o1 = add('osc', 0, 0, { wave: 2, level: 0.3 });
    const o2 = add('osc', 0, 0, { wave: 1, coarse: 7, level: 0.3 });
    const o3 = add('osc', 0, 0, { wave: 3, coarse: -12, pw: 0.3, level: 0.3 });
    const step = add('lfo', 0, 0, { wave: 2, rate: 3.1, depth: 1 });
    const a = add('select', 0, 0, { pos: 1, count: 4, fade: 4, v4: 0.2 });
    const tri = add('lfo', 0, 0, { wave: 1, rate: 0.9, depth: 0.8 });
    const b = add('select', 0, 0, { pos: 1, count: 3, fade: 0, v1: 0, v2: 7 / 12, v3: 1 }, { map: { p1: ['pos'] } });
    const tone = add('osc', 0, 0, { wave: 0, level: 0.4 });
    const va = add('vca', 0, 0, { gain: 1 });
    const vb = add('vca', 0, 0, { gain: 1 });
    const c = add('select', 0, 0, { pos: 2, count: 8, fade: 30 });
    const out = add('output', 0, 0, { level: 0.4 });
    for (const o of [o1, o2, o3, tone]) wire(kb, 'pitch', o, 'pitch');
    wire(o1, 'out', a, 'in1');
    wire(o2, 'out', a, 'in2');
    wire(o3, 'out', a, 'in3');
    wire(step, 'out', a, 'pos');
    wire(tri, 'out', b, 'p1');
    wire(b, 'out', tone, 'pitch');
    wire(tone, 'out', va, 'in');
    wire(o1, 'out', vb, 'in');
    wire(b, 'g2', va, 'cv');
    wire(b, 'g3', va, 'cv');
    wire(b, 'g1', vb, 'cv');
    wire(o2, 'out', c, 'in1');
    wire(o3, 'out', c, 'in3');
    wire(tri, 'out', c, 'pos');
    wire(a, 'out', out, 'l');
    wire(va, 'out', out, 'r');
    wire(vb, 'out', out, 'r');
    wire(c, 'out', out, 'r');
  },
  3,
);
// a saw through the vowel filter swept A -> U by an LFO, then the phaser
kit('vowel-phaser', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.6 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const sc = add('scale', 0, 0, { gain: 2, offset: 2 });
  const vw = add('vowel', 0, 0, { vowel: 0, res: 0.6, level: 0.9 });
  const ph = add('phaser', 0, 0, { rate: 1.1, depth: 0.8, center: 600, fb: 0.5, mix: 0.5 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', vw, 'in');
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', vw, 'vowel');
  wire(vw, 'out', ph, 'in');
  wire(ph, 'out', out, 'l');
  wire(ph, 'out', out, 'r');
});
// coloured noise through the digitizer
kit('os-shape-crush', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8, coarse: 12 });
  const sh = add('shape', 0, 0, { mode: 1, drive: 6, level: 0.6, os: 1 });
  const cr = add('crush', 0, 0, { bits: 5, rate: 3, os: 1 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', sh, 'in');
  wire(sh, 'out', cr, 'in');
  wire(cr, 'out', out, 'l');
});
kit('wavefold', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 0, level: 0.9 });
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 0.7, depth: 1 });
  const sh = add('shape', 0, 0, { mode: 2, drive: 3, level: 0.5, os: 1, sym: 0.3, stages: 3 }, { map: { p1: ['drive'] }, att: [0.5, 1] });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', sh, 'in');
  wire(lfo, 'out', sh, 'p1');
  wire(sh, 'out', out, 'l');
});
kit('seq-glide', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const clk = add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = add('seq', 0, 0, { s1: 0, s2: 0.5, s3: -1, s4: 0.25, s5: 1, s6: 0.4, s7: -0.5, s8: 0, len: 8, glide: 0.35, gate: 0.6 });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.1, s: 0.5, r: 0.08 });
  const osc = add('osc', 0, 0, { wave: 3, level: 0.7 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(clk, 'out', sq, 'clock');
  wire(kb, 'gate', sq, 'reset');
  wire(sq, 'out', osc, 'pitch');
  wire(kb, 'pitch', osc, 'pitch');
  wire(sq, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
// morphing: the same subtractive voice twice, the B side brighter and square, an LFO on the Main's morph input
const morphVoice = (b: boolean): Build => (add, wire) => {
  const kb = add('fm1', 0, 0, { morph: 0.3 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.6, depth: 0.5 });
  const sc = add('scale', 0, 0, { gain: 1, offset: 0.2 });
  const osc = add('osc', 0, 0, { wave: b ? 3 : 2, pw: b ? 0.3 : 0.5, level: 0.7, coarse: b ? -12 : 0 });
  const env = add('adsr', 0, 0, { a: b ? 0.2 : 0.005, d: 0.2, s: b ? 0.9 : 0.4, r: b ? 0.5 : 0.1 });
  const flt = add('filter', 0, 0, { cutoff: b ? 6000 : 250, res: b ? 0.1 : 0.7 });
  const vca = add('vca', 0, 0);
  const dly = add('delay', 0, 0, { time: b ? 375 : 120, fb: b ? 0.6 : 0.2, mix: b ? 0.5 : 0.1 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', kb, 'morph');
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp24', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', dly, 'in');
  wire(dly, 'out', out, 'l');
};
kit('morph', morphVoice(false));
// macro ranges: one triangle LFO into the filter's p1 (cutoff between 150 Hz and 6 kHz in octaves) and the ADSR's p1
// (decay between 0.6 s and 30 ms, the ends swapped), a Macro into the oscillator's p2 (pulse width 0.2..0.5)
kit('macro', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const k2 = add('macro', 0, 0, { value: 0.7 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: 0.5 });
  const osc = add('osc', 0, 0, { wave: 3, level: 0.7 }, { map: { p2: ['pw'] } });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.3, r: 0.1 }, { map: { p1: ['d'] } });
  const flt = add('filter', 0, 0, { cutoff: 1200, res: 0.6 }, { map: { p1: ['cutoff'] } });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', flt, 'p1');
  wire(sc, 'out', env, 'p1');
  wire(k2, 'out', osc, 'p2');
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp24', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
{
  const m = tests.macro.modules;
  const unit = (type: string, name: string, v: number): number => paramUnit(DEFS[type].params.find((q) => q.name === name)!, v);
  m[5].range = { p1: { cutoff: [unit('filter', 'cutoff', 150), unit('filter', 'cutoff', 6000)] } };
  m[4].range = { p1: { d: [unit('adsr', 'd', 0.6), unit('adsr', 'd', 0.03)] } };
  m[3].range = { p2: { pw: [unit('osc', 'pw', 0.2), unit('osc', 'pw', 0.5)] } };
}
setMorphTarget(tests.morph, make('morph-b', morphVoice(true)), DEFS);
// #355: only the VCA has a B side. The other modules must not take a trip through morph's unit conversion.
kit('morph-unassigned', (add, wire) => {
  const main = add('fm1', 0, 0, { morph: 0.6 });
  const offset = add('const', 0, 0, { value: -0.05 });
  const osc = add('osc', 0, 0, { coarse: 7, wave: 0 });
  const vca = add('vca', 0, 0, { gain: 0.2 });
  const out = add('output', 0, 0);
  wire(main, 'pitch', osc, 'pitch');
  wire(offset, 'out', osc, 'pitch');
  wire(osc, 'out', vca, 'in');
  wire(main, 'gate', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
{
  const vca = tests['morph-unassigned'].modules.find((m) => m.type === 'vca')!;
  vca.paramsB = { ...vca.params, gain: 0.8 };
}
kit('crush-color', (add, wire) => {
  const nz = add('noise', 0, 0, { level: 0.6, color: 0.6 });
  const cr = add('crush', 0, 0, { bits: 6, rate: 5 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(nz, 'out', cr, 'in');
  wire(cr, 'out', out, 'l');
});

// Every dedicated input link at once (they are built in: a cable into cv always moves cutoff, and so on).
kit('fixed-links', (add, wire) => {
  const main = add('fm1', 0, 0, { morph: 0 });
  const osc = add('osc', 0, 0, { wave: 2, level: 1 });
  const cv = add('const', 0, 0, { value: .3 });
  const filter = add('filter', 0, 0, { cutoff: 1200, morph: .2 });
  const ladder = add('ladder', 0, 0, { cutoff: 1600, res: .1 });
  const pan = add('pan', 0, 0, { pan: -.2 });
  const xfade = add('xfade', 0, 0, { mix: .3 });
  const shift = add('shift', 0, 0, { shift: 50, cvamt: 100 });
  const vowel = add('vowel', 0, 0, { vowel: 1 });
  const amp = add('vca', 0, 0, { gain: .8 });
  const out = add('output', 0, 0, { level: 1 }); // the chain is quiet: keep the reference above the Q16 floor
  wire(main, 'pitch', osc, 'pitch');
  wire(osc, 'out', filter, 'in'); wire(filter, 'mix', ladder, 'in');
  wire(ladder, 'lp12', pan, 'in'); wire(pan, 'l', xfade, 'a'); wire(pan, 'r', xfade, 'b');
  wire(xfade, 'out', shift, 'in'); wire(shift, 'up', vowel, 'in'); wire(vowel, 'out', amp, 'in'); wire(amp, 'out', out, 'l');
  for (const [id, port] of [[main, 'morph'], [filter, 'cv'], [filter, 'morph'], [ladder, 'cv'], [pan, 'pos'], [xfade, 'pos'], [shift, 'cv'], [vowel, 'vowel'], [amp, 'cv']] as const)
    wire(cv, 'out', id, port);
});
{
  const p = tests['fixed-links'];
  const filter = p.modules.find((m) => m.type === 'filter')!;
  filter.paramsB = { ...filter.params, cutoff: 4000 };
  filter.range = { p1: { cutoff: [.2, .8] } }; // exercises all optional sections together
}

// A physical input fans out on top of its built-in link, alongside morph and macro ranges.
{
  const p = structuredClone(tests['fixed-links']);
  tests['side-input-fanout'] = p;
  const source = p.modules.find((m) => m.type === 'const')!; source.params.value = .015625;
  const amp = p.modules.find((m) => m.type === 'vca')!;
  const second = { ...structuredClone(source), id: Math.max(...p.modules.map((m) => m.id)) + 1 };
  p.modules.push(second);
  p.cables.push({ from: { module: second.id, port: 'out' }, to: { module: p.modules.find((m) => m.type === 'filter')!.id, port: 'cv' } });
  // the tiny source would close the VCA (an unplugged or near-zero cv is silence): hold it open with its own constant
  const open = { ...structuredClone(source), id: second.id + 1, params: { value: 1 } };
  p.modules.push(open);
  p.cables = p.cables.filter((c) => !(c.to.module === amp.id && c.to.port === 'cv'));
  p.cables.push({ from: { module: open.id, port: 'out' }, to: { module: amp.id, port: 'cv' } });
  for (const m of p.modules) {
    if (m.type === 'filter') m.inputMap = { cv: ['res', 'cvamt'], in: ['track'] };
    if (m.type === 'ladder') m.inputMap = { cv: ['res', 'drive'] };
    if (m.type === 'vca') m.inputMap = { in: ['gain'] };
    if (m.type === 'output') m.inputMap = { l: ['level'] };
  }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
// the Arpeggiator (#58): Main keys -> arpeggiator -> Voice allocator -> a plucky voice; the clock from the Main module's
// tempo (the transport is not needed), or one step per edge on clk; the run output and the clock output while the transport runs
const arpVoice = (name: string, arp: Record<string, number>, voices: number, tempo: number, clk = false): void => {
  tests[name] = make(name, (add, wire) => {
    const kb = add('fm1', 0, 0, { tempo });
    const a = add('arp', 200, 0, arp);
    const al = add('alloc', 400, 0, { voices });
    const o = add('osc', 600, 0, { wave: 2, level: 0.6 });
    const e = add('adsr', 600, 200, { a: 0.002, d: 0.08, s: 0.4, r: 0.05 });
    const v = add('vca', 800, 0);
    const out = add('output', 1000, 0, { level: 0.7 });
    wire(kb, 'keys', a, 'keys');
    wire(a, 'keys', al, 'keys');
    wire(al, 'pitch', o, 'pitch');
    wire(al, 'gate', e, 'gate');
    wire(al, 'vel', v, 'p1');
    wire(o, 'out', v, 'in');
    wire(e, 'env', v, 'cv');
    wire(v, 'out', out, 'l');
    if (clk) {
      const l = add('lfo', 200, 200, { wave: 3, rate: 7 });
      wire(l, 'out', a, 'clk');
    }
  });
};
arpVoice('arp-updown-poly', { mode: 2, rate: 4, octaves: 2, gate: 0.6 }, 4, 132);
events['arp-updown-poly'] = [[0, 'on', 60], [0, 'on', 64], [128 * 3, 'on', 67], [128 * 150, 'off', 64], [128 * 200, 'off', 60], [128 * 200, 'off', 67]];
ends['arp-updown-poly'] = 128 * 260;
arpVoice('arp-random-latch', { mode: 3, rate: 5, octaves: 3, gate: 1, latch: 1 }, 1, 97);
events['arp-random-latch'] = [[0, 'on', 62], [128 * 2, 'on', 69], [128 * 20, 'off', 62], [128 * 21, 'off', 69], [128 * 160, 'on', 57], [128 * 200, 'off', 57]];
ends['arp-random-latch'] = 128 * 300;
arpVoice('arp-clk-played', { mode: 4, rate: 0, octaves: 1, gate: 0.3 }, 2, 120, true);
events['arp-clk-played'] = [[0, 'on', 67], [128 * 5, 'on', 60], [128 * 9, 'on', 63], [128 * 180, 'off', 67], [128 * 180, 'off', 60], [128 * 180, 'off', 63]];
ends['arp-clk-played'] = 128 * 240;
for (const mode of ['fixed', 'moving', 'paused', 'clock'] as const) {
  const name = `arp-rate-${mode}`;
  arpVoice(name, { gate: .5 }, 2, 103, mode === 'clock');
  const p = tests[name], arp = p.modules.find((m) => m.type === 'arp')!;
  const cv = addModule(p, DEFS[mode === 'moving' ? 'lfo' : 'const'], 0, 0);
  if (mode === 'moving') Object.assign(cv.params, { wave: 1, rate: 1.5, depth: 4 });
  else cv.params.value = mode === 'fixed' ? 3.25 : 0;
  p.cables.push({ from: { module: cv.id, port: 'out' }, to: { module: arp.id, port: 'rate' } });
  events[name] = [[0, 'on', 60], [0, 'on', 64], [0, 'on', 67]];
  ends[name] = 128 * 600;
  if (mode === 'clock') {
    // Exact clock edges and gate/trigger outputs isolate scheduling from oscillator pitch-grid drift.
    const main = p.modules.find((m) => m.type === 'fm1')!;
    const alloc = p.modules.find((m) => m.type === 'alloc')!;
    const out = p.modules.find((m) => m.type === 'output')!;
    alloc.params.voices = 1;
    out.params.level = 1;
    p.cables = p.cables.filter((c) => c.to.module !== out.id && !(c.to.module === arp.id && c.to.port === 'clk'));
    p.cables.push(
      { from: { module: main.id, port: 'fx' }, to: { module: arp.id, port: 'clk' } },
      { from: { module: alloc.id, port: 'trig' }, to: { module: out.id, port: 'l' } },
      { from: { module: alloc.id, port: 'gate' }, to: { module: out.id, port: 'r' } },
    );
    for (let block = 30; block < 600; block += 30)
      events[name].push([128 * block, 'bon', 0], [128 * (block + 2), 'boff', 0]);
    const control = structuredClone(p);
    control.cables = control.cables.filter((c) => !(c.to.module === arp.id && c.to.port === 'rate'));
    tests['arp-rate-clock-control'] = control;
    events['arp-rate-clock-control'] = events[name];
    ends['arp-rate-clock-control'] = ends[name];
  }
}
// the Main module's clock (24 ppqn while the transport runs) through a divider into an envelope; run opens a second VCA
tests['main-clock-run'] = make('main-clock-run', (add, wire) => {
  const kb = add('fm1', 0, 0, { tempo: 150 });
  const d = add('clkdiv', 200, 0);
  const e = add('adsr', 400, 0, { a: 0.001, d: 0.05, s: 0, r: 0.02 });
  const o = add('osc', 400, 200, { wave: 1, level: 0.7 });
  const v = add('vca', 600, 0);
  const v2 = add('vca', 800, 0);
  const out = add('output', 1000, 0, { level: 0.7 });
  wire(kb, 'clock', d, 'clock');
  wire(d, 'd8', e, 'gate');
  wire(kb, 'pitch', o, 'pitch');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', v2, 'in');
  wire(kb, 'run', v2, 'cv');
  wire(v2, 'out', out, 'l');
});
events['main-clock-run'] = [[0, 'on', 57], [128 * 20, 'run', 0], [128 * 160, 'stop', 0], [128 * 200, 'run', 0], [128 * 250, 'off', 57]];
ends['main-clock-run'] = 128 * 280;

// the panel (#60): two Macros (K5 / K6 before the device pages) into an oscillator's level and fine tune, the FX button opens a VCA, the REC button (switched on
// in the patch: the binary's on mask) a second one
tests['panel-buttons'] = make('panel-buttons', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const k5 = add('macro', 0, 0, { value: 0.8 });
  const k6 = add('macro', 0, 0, { value: 0.3 });
  const o = add('osc', 200, 0, { wave: 2, level: 0.5 });
  const v = add('vca', 400, 0);
  const v2 = add('vca', 600, 0);
  const out = add('output', 800, 0, { level: 0.7 });
  wire(kb, 'pitch', o, 'pitch');
  wire(k5, 'out', v, 'p1');
  wire(k6, 'out', o, 'p1');
  wire(o, 'out', v, 'in');
  wire(kb, 'fx', v, 'cv');
  wire(v, 'out', v2, 'in');
  wire(kb, 'arp', v2, 'cv');
  wire(v2, 'out', out, 'l');
});
tests['panel-buttons'].modules[0].panel = { toggle: ['arp'], on: ['arp'], labels: { fx: 'GATE' } };
events['panel-buttons'] = [[0, 'on', 60], [128 * 20, 'bon', 0], [128 * 60, 'boff', 0], [128 * 80, 'bon', 0], [128 * 100, 'boff', 6], [128 * 140, 'bon', 6], [128 * 160, 'off', 60]];
ends['panel-buttons'] = 128 * 180;

// Toggle buttons (#116): FX bypasses a closed VCA while held (the oscillator gets through), ARP switches a folder that the
// patch was saved with bypassed (on: its target bypassed) back in and out
tests['button-toggle'] = make('button-toggle', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const o = add('osc', 200, 0, { wave: 0, level: 0.5 });
  const f = add('shape', 400, 0, { drive: 8 });
  const v = add('vca', 600, 0);
  const out = add('output', 800, 0, { level: 0.7 });
  wire(kb, 'pitch', o, 'pitch');
  wire(o, 'out', f, 'in');
  wire(f, 'out', v, 'in');
  wire(v, 'out', out, 'l');
});
{
  const t = tests['button-toggle'];
  const [vca, fold] = [t.modules.find((m) => m.type === 'vca')!, t.modules.find((m) => m.type === 'shape')!];
  fold.bypass = true;
  t.modules[0].panel = { toggle: ['arp'], on: ['arp'], kinds: { fx: 'bypass', arp: 'bypass', scl: 'nothing' }, targets: { fx: { module: vca.id }, arp: { module: fold.id } } };
}
events['button-toggle'] = [[0, 'on', 60], [128 * 20, 'bon', 0], [128 * 60, 'boff', 0], [128 * 70, 'bon', 0], [128 * 80, 'boff', 6], [128 * 110, 'bon', 6], [128 * 130, 'boff', 0], [128 * 150, 'off', 60]];
ends['button-toggle'] = 128 * 170;


// Steps (#83): drum tracks on the transport. A kick on the quarters (accent on the first: full velocity opens more
// level), a hat at 1/16 over 12 steps with chances (the deterministic hash), swing and a short gate, and a third track at
// 1/8T; stop and run again restart them all at step 1. The patterns are written as before #133 (step bytes) and migrated.
const pattern = (on: number[], acc: number[] = [], chance: Record<number, number> = {}): StepNote[] | undefined =>
  migrateSteps(Array.from({ length: 64 }, (_, k) => stepByte({ on: on.includes(k), accent: acc.includes(k), chance: chance[k] ?? 100 })));
const drum = (add: Parameters<Build>[0], wire: Parameters<Build>[1], x: number, wave: number, pitch: number, decay: number): { st: number; v: number } => {
  const st = add('steps', x, 0, {});
  const e = add('adsr', x, 200, { a: 0.001, d: decay, s: 0, r: 0.01 });
  const o = add('osc', x, 400, { wave, level: 0.6, coarse: pitch });
  const v = add('vca', x, 600);
  const va = add('vca', x, 800);
  const c = add('const', x, 1000, { value: 0.4 });
  wire(st, 'trig', e, 'gate');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', va, 'in');
  wire(c, 'out', va, 'cv');
  wire(st, 'vel', va, 'cv');
  return { st, v: va };
};
tests['steps-kit'] = make('steps-kit', (add, wire) => {
  const kb = add('fm1', 0, 0, { tempo: 140 });
  const out = add('output', 2000, 0, { level: 0.6 });
  const mx = add('mixer', 1800, 0);
  const a = drum(add, wire, 200, 0, -12, 0.12);
  const b = drum(add, wire, 600, 3, 12, 0.03);
  const c = drum(add, wire, 1000, 1, 0, 0.06);
  wire(a.v, 'out', mx, 'in1');
  wire(b.v, 'out', mx, 'in2');
  wire(c.v, 'out', mx, 'in3');
  wire(mx, 'out', out, 'l');
});
{
  const st = tests['steps-kit'].modules.filter((m) => m.type === 'steps');
  st[0].name = 'KICK';
  st[0].notes = pattern([0, 4, 8, 12], [0]);
  Object.assign(st[1].params, { len: 12, rate: 4, swing: 66, gate: 0.1 });
  st[1].name = 'HAT';
  st[1].notes = pattern([0, 1, 2, 3, 5, 6, 7, 9, 10, 11], [2, 6], { 1: 50, 3: 25, 5: 75, 7: 5, 9: 50, 11: 90 });
  Object.assign(st[2].params, { len: 5, rate: 3, gate: 0.6 });
  st[2].notes = pattern([0, 2, 3], [3]);
}
events['steps-kit'] = [[128 * 5, 'run', 0], [128 * 380, 'stop', 0], [128 * 420, 'run', 0]];
ends['steps-kit'] = 128 * 560;

// step values (#93): a melody track (notes and velocities) into an oscillator and a VCA, transposed 3 semitones up by a
// Constant in its transpose input; a second track with notes only (default velocities) on an external clock
tests['steps-notes'] = make('steps-notes', (add, wire) => {
  add('fm1', 0, 0, { tempo: 150 });
  const out = add('output', 2000, 0, { level: 0.6 });
  const mx = add('mixer', 1800, 0);
  const tr = add('const', 100, 400, { value: 0.25 });
  const voice = (x: number, wave: number): { st: number; v: number } => {
    const st = add('steps', x, 0, { len: 8, rate: 4, gate: 0.5 });
    const o = add('osc', x + 100, 0, { wave });
    const env = add('adsr', x + 100, 200, { a: 0.002, d: 0.08, s: 0.4, r: 0.05 });
    const v1 = add('vca', x + 200, 0);
    const v2 = add('vca', x + 300, 0);
    wire(st, 'pitch', o, 'pitch');
    wire(st, 'trig', env, 'gate');
    wire(o, 'out', v1, 'in');
    wire(env, 'env', v1, 'cv');
    wire(v1, 'out', v2, 'in');
    wire(st, 'vel', v2, 'cv');
    return { st, v: v2 };
  };
  const a = voice(200, 1);
  const b = voice(700, 2);
  wire(tr, 'out', a.st, 'transpose');
  const clk = add('lfo', 600, 400, { wave: 3, rate: 5, depth: 1 });
  wire(clk, 'out', b.st, 'clk');
  wire(a.v, 'out', mx, 'in1');
  wire(b.v, 'out', mx, 'in2');
  wire(mx, 'out', out, 'l');
});
{
  const st = tests['steps-notes'].modules.filter((m) => m.type === 'steps');
  const bytes = (on: number[], acc: number[] = []): number[] => Array.from({ length: 64 }, (_, k) => stepByte({ on: on.includes(k), accent: acc.includes(k), chance: 100 }));
  st[0].notes = migrateSteps(bytes([0, 1, 2, 3, 4, 5, 6, 7], [4]), Array.from({ length: 64 }, (_, k) => [48, 55, 60, 63, 67, 70, 72, 41][k % 8]), Array.from({ length: 64 }, (_, k) => [127, 40, 90, 20, 110, 64, 1, 100][k % 8]));
  Object.assign(st[1].params, { len: 6 });
  st[1].notes = migrateSteps(bytes([0, 2, 3, 5]), Array.from({ length: 64 }, (_, k) => [36, 36, 43, 39, 36, 31][k % 6]));
}
events['steps-notes'] = [[128 * 5, 'run', 0]];
ends['steps-notes'] = 128 * 400;

// ties (#128), now longer notes (#133): the steps-notes voices with notes held through tied steps (migrated: a held note
// through two ties, a tie after an off step plays nothing, a tie on the first step is dropped), swing on; the second
// track on an external clock
tests['steps-tie'] = structuredClone(tests['steps-notes']);
tests['steps-tie'].name = 'steps-tie';
{
  const st = tests['steps-tie'].modules.filter((m) => m.type === 'steps');
  const T = 0x80;
  Object.assign(st[0].params, { swing: 62 });
  const lanes = (l: number[]): number[] => Array.from({ length: 64 }, (_, k) => l[k % l.length]);
  st[0].notes = migrateSteps(lanes([stepByte({ on: true, accent: true, chance: 100 }), T, T, 0, T, stepByte({ on: true, accent: false, chance: 100 }), 0, T]), lanes([48, 55, 60, 63, 67, 70, 72, 41]), lanes([127, 40, 90, 20, 110, 64, 1, 100]));
  st[1].notes = migrateSteps(lanes([stepByte({ on: true, accent: false, chance: 100 }), T, 0, stepByte({ on: true, accent: false, chance: 100 }), T, T]), lanes([36, 36, 43, 39, 36, 31]));
}
events['steps-tie'] = [[128 * 5, 'run', 0]];
ends['steps-tie'] = 128 * 400;

// a track stepped by a clock in clk (an LFO square) and sent back to step 1 by the key's gate (reset); a second track on
// MIDI clock: ticks every 900 samples (about 122 bpm), then the clock stops and the tempo takes over again
tests['steps-clk'] = make('steps-clk', (add, wire) => {
  const kb = add('fm1', 0, 0, { tempo: 100 });
  const l = add('lfo', 200, 0, { wave: 3, rate: 9, depth: 1 });
  const out = add('output', 2000, 0, { level: 0.6 });
  const mx = add('mixer', 1800, 0);
  const a = drum(add, wire, 400, 2, 0, 0.05);
  const b = drum(add, wire, 800, 0, 7, 0.08);
  wire(l, 'out', a.st, 'clk');
  wire(kb, 'gate', a.st, 'reset');
  wire(a.v, 'out', mx, 'in1');
  wire(b.v, 'out', mx, 'in2');
  wire(mx, 'out', out, 'l');
});
{
  const st = tests['steps-clk'].modules.filter((m) => m.type === 'steps');
  Object.assign(st[0].params, { len: 7, swing: 60, gate: 0.4 });
  st[0].notes = pattern([0, 1, 3, 4, 6], [4], { 3: 40 });
  Object.assign(st[1].params, { len: 16, rate: 5, swing: 75 });
  st[1].notes = pattern([0, 3, 5, 6, 9, 12, 14], [0, 9], { 5: 60, 14: 30 });
}

// the rates 1/2 and 1/64 and swing to 80 % (#351, past the range's max: ParamDef.top). A 1/64 track (every second step
// half a tick after a tick) at 80 % swing, a 1/2 track, a track morphed past max (rate 1/16 -> 1/64, a choice: B; swing
// 60 -> 80, linearly), and a track whose base is past max under its pins (rate 1/64 + p2, swing 78 - p1: clamped to the
// stretch, not pulled back to max); stop and run; then MIDI clock with every seventh tick early (the half tick's step
// comes with it). Modules without a B side stay untouched by the morph (format 36, #355).
tests['steps-rates'] = make('steps-rates', (add, wire) => {
  const kb = add('fm1', 0, 0, { tempo: 133, morph: 0.6 });
  const out = add('output', 2000, 0, { level: 0.6 });
  const mx = add('mixer', 1800, 0);
  const a = drum(add, wire, 200, 0, -12, 0.03);
  const b = drum(add, wire, 600, 3, 12, 0.2);
  const c = drum(add, wire, 1000, 1, 0, 0.04);
  const d = drum(add, wire, 1400, 0, -24, 0.02);
  const up = add('const', 1400, 1200, { value: 0.125 });
  const down = add('const', 1400, 1400, { value: -0.0625 });
  wire(up, 'out', d.st, 'p2');
  wire(down, 'out', d.st, 'p1');
  wire(a.v, 'out', mx, 'in1');
  wire(b.v, 'out', mx, 'in2');
  wire(c.v, 'out', mx, 'in3');
  wire(d.v, 'out', mx, 'in4');
  wire(mx, 'out', out, 'l');
  void kb;
});
{
  const st = tests['steps-rates'].modules.filter((m) => m.type === 'steps');
  Object.assign(st[0].params, { len: 16, rate: 8, swing: 80, gate: 0.5 });
  st[0].notes = pattern([0, 1, 2, 3, 5, 6, 7, 9, 10, 12, 13, 15], [0, 8]);
  Object.assign(st[1].params, { len: 4, rate: 7, gate: 0.3 });
  st[1].notes = pattern([0, 1, 3], [1]);
  Object.assign(st[2].params, { len: 8, rate: 4, swing: 60, gate: 0.4 });
  st[2].paramsB = { ...st[2].params, rate: 8, swing: 80 };
  st[2].notes = pattern([0, 1, 2, 3, 4, 5, 6, 7], [4]);
  Object.assign(st[3].params, { len: 12, rate: 8, swing: 78, gate: 0.6 });
  st[3].map = { ...st[3].map!, p1: ['swing'], p2: ['rate'] };
  st[3].notes = pattern([0, 1, 3, 4, 5, 7, 8, 9, 11], [3], { 5: 50 });
  const ev: Ev[] = [[128 * 4, 'run', 0], [128 * 300, 'stop', 0], [128 * 330, 'run', 0], [128 * 500, 'ext', 0]];
  for (let t = 0; t < 160; t++) ev.push([128 * 500 + 900 * t - (t % 7 === 3 ? 600 : 0), 'tick', 0]);
  ev.push([128 * 500 + 900 * 160 + 200, 'int', 0]);
  events['steps-rates'] = ev;
  ends['steps-rates'] = 128 * 500 + 900 * 160 + 128 * 100;
}

// keys out (#133): a Steps track of chords (notes of different lengths, one through the loop's end and cut there, a chance
// per note, a note past len that never plays) into a Voice allocator of three voices in a poly assembly (osc, envelope,
// VCA); transposed a fifth up by a Constant; four notes at once take a voice over
const n = (at: number, len: number, note: number, vel = 100, chance?: number): StepNote => ({ at, len, note, vel, ...(chance ? { chance } : {}) });
tests['steps-keys'] = make('steps-keys', (add, wire) => {
  add('fm1', 0, 0, { tempo: 160 });
  const st = add('steps', 200, 0, { len: 12, rate: 4, gate: 0.7, swing: 58 });
  const tr = add('const', 200, 300, { value: 7 / 12 });
  const al = add('alloc', 400, 0, { voices: 3 });
  const o = add('osc', 600, 0, { wave: 1, level: 0.5 });
  const e = add('adsr', 600, 200, { a: 0.003, d: 0.1, s: 0.5, r: 0.04 });
  const v = add('vca', 800, 0);
  const out = add('output', 1000, 0, { level: 0.6 });
  wire(tr, 'out', st, 'transpose');
  wire(st, 'keys', al, 'keys');
  wire(al, 'pitch', o, 'pitch');
  wire(al, 'gate', e, 'gate');
  wire(al, 'vel', v, 'p1');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
  // right: trig and the voices' velocities (summed out of the group; a part holding its velocity never goes idle, so the
  // engines' idle judgment, which can differ by a block on a release tail, plays no part here)
  const mr = add('mixer', 1000, 200, { l1: 0.3, l2: 0.3 });
  wire(st, 'trig', mr, 'in1');
  wire(al, 'vel', mr, 'in2');
  wire(mr, 'out', out, 'r');
});
{
  const p = tests['steps-keys'];
  const ids = p.modules.filter((m) => ['alloc', 'osc', 'adsr', 'vca'].includes(m.type)).map((m) => m.id);
  makeAssembly(p, ids, 'chord voices').poly = {};
  p.modules.find((m) => m.type === 'steps')!.notes = [n(0, 4, 48), n(0, 1, 55, 70), n(0, 2, 60, 127), n(2, 1, 67, 90, 50), n(4, 2, 50), n(4, 2, 57), n(4, 2, 62), n(4, 1, 65, 40),
    n(7, 1, 64, 110, 25), n(8, 3, 45), n(9, 1, 72, 60), n(10, 6, 52, 100), n(13, 1, 70)];
}
events['steps-keys'] = [[128 * 5, 'run', 0], [128 * 500, 'stop', 0]];
ends['steps-keys'] = 128 * 560;

// keys out into one voice, legato auto: notes one after another retrigger the envelope (the off and the next on land in
// the same block: the part restarts), overlapping ones glide on without a new attack; a muted gap
tests['steps-legato'] = make('steps-legato', (add, wire) => {
  add('fm1', 0, 0, { tempo: 128 });
  const st = add('steps', 200, 0, { len: 8, rate: 5, gate: 1 });
  const al = add('alloc', 400, 0, { voices: 1, legato: 0 });
  const o = add('osc', 600, 0, { wave: 2, level: 0.5 });
  const e = add('adsr', 600, 200, { a: 0.01, d: 0.05, s: 0.3, r: 0.02 });
  const v = add('vca', 800, 0);
  const out = add('output', 1000, 0, { level: 0.6 });
  wire(st, 'keys', al, 'keys');
  wire(al, 'pitch', o, 'pitch');
  wire(al, 'gate', e, 'gate');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
});
tests['steps-legato'].modules.find((m) => m.type === 'steps')!.notes = [n(0, 1, 60), n(1, 1, 62), n(2, 2, 64), n(3, 2, 67), n(5, 1, 60), n(6, 2, 55)];
events['steps-legato'] = [[128 * 5, 'run', 0]];
ends['steps-legato'] = 128 * 400;
{
  const ev: Ev[] = [[128 * 3, 'run', 0], [128 * 40, 'on', 60], [128 * 41, 'off', 60], [128 * 150, 'on', 62], [128 * 180, 'off', 62], [128 * 200, 'ext', 0]];
  for (let t = 0; t < 200; t++) ev.push([128 * 200 + 900 * t + (t % 3) * 37, 'tick', 0]);
  ev.push([128 * 200 + 900 * 200 + 200, 'int', 0]);
  events['steps-clk'] = ev;
  ends['steps-clk'] = 128 * 200 + 900 * 200 + 128 * 120;
}

// Drum map (#137): a Steps track into one map (a row's gate while its note sounds, restarted by the same note at once
// and by a note over a held one; velocities), Main's keys into another (a key held, let go and hit again in one block)
tests['drummap'] = make('drummap', (add, wire) => {
  const main = add('fm1', 0, 0, { tempo: 150 });
  const st = add('steps', 200, 0, { len: 8, rate: 4, gate: 0.5 });
  const dm = add('drummap', 400, 0);
  const dk = add('drummap', 400, 400, { n1: 60, n2: 62 });
  const ml = add('mixer', 600, 0, { l1: 0.3, l2: 0.3, l3: 0.2, l4: 0.2 });
  const mr = add('mixer', 600, 400, { l1: 0.3, l2: 0.3, l3: 0.3, l4: 0 });
  const out = add('output', 800, 0, { level: 1 });
  wire(st, 'keys', dm, 'keys');
  wire(main, 'keys', dk, 'keys');
  wire(dm, 'g1', ml, 'in1');
  wire(dm, 'v1', ml, 'in2');
  wire(dm, 'g2', ml, 'in3');
  wire(dm, 'g4', ml, 'in4');
  wire(dk, 'g1', mr, 'in1');
  wire(dk, 'v1', mr, 'in2');
  wire(dk, 'g2', mr, 'in3');
  wire(ml, 'out', out, 'l');
  wire(mr, 'out', out, 'r');
});
tests['drummap'].modules.find((m) => m.type === 'steps')!.notes = [n(0, 2, 36), n(1, 1, 36, 90), n(2, 1, 38, 127), n(3, 2, 36, 50), n(4, 1, 42, 60), n(5, 3, 42), n(6, 1, 38, 20)];
events['drummap'] = [[128 * 4, 'run', 0], [128 * 30, 'on', 60], [128 * 60, 'on', 62], [128 * 90, 'off', 60], [128 * 90 + 40, 'on', 60],
  [128 * 120, 'off', 62], [128 * 140, 'off', 60], [128 * 300, 'stop', 0]];
ends['drummap'] = 128 * 360;

// Drum map repeat (#184): Main's keys into two maps that repeat their rows. The left one's rows are on the white keys
// F3..F4 (blocks of eight white keys, a black key plays the white key's row below it): G4 and F3 both play row 1 (the
// second held key neither restarts it nor lets it fall when the first goes), F#4 row 8, F2 row 2, F#5 row 7. The right
// one keeps the General MIDI rows (not all white: blocks of 21 semitones): A3 and D#5 both play the kick, F2 nothing.
tests['drummap-repeat'] = make('drummap-repeat', (add, wire) => {
  const main = add('fm1', 0, 0, {});
  const dw = add('drummap', 200, 0, { n1: 53, n2: 55, n3: 57, n4: 59, n5: 60, n6: 62, n7: 64, n8: 65, repeat: 1 });
  const dg = add('drummap', 200, 400, { repeat: 1 });
  const ml = add('mixer', 400, 0, { l1: 0.3, l2: 0.2, l3: 0.2, l4: 0.15 });
  const ml2 = add('mixer', 400, 200, { l1: 0.1, l2: 0, l3: 0, l4: 0 });
  const mr = add('mixer', 400, 400, { l1: 0.3, l2: 0.3, l3: 0.2, l4: 0 });
  const out = add('output', 600, 0, { level: 1 });
  wire(main, 'keys', dw, 'keys');
  wire(main, 'keys', dg, 'keys');
  wire(dw, 'g1', ml, 'in1');
  wire(dw, 'v1', ml, 'in2');
  wire(dw, 'g8', ml, 'in3');
  wire(dw, 'g2', ml2, 'in2');
  wire(dw, 'g7', ml2, 'in1');
  wire(ml2, 'out', ml, 'in4');
  wire(dg, 'g1', mr, 'in1');
  wire(dg, 'v1', mr, 'in2');
  wire(dg, 'g6', mr, 'in3');
  wire(ml, 'out', out, 'l');
  wire(mr, 'out', out, 'r');
});
events['drummap-repeat'] = [[128 * 10, 'on', 67], [128 * 30, 'on', 53], [128 * 50, 'off', 67], [128 * 70, 'off', 53],
  [128 * 80, 'on', 67], [128 * 80 + 60, 'off', 67], [128 * 82, 'on', 79], [128 * 90, 'on', 66], [128 * 110, 'off', 66],
  [128 * 130, 'on', 41], [128 * 150, 'on', 57], [128 * 160, 'on', 78], [128 * 170, 'off', 57], [128 * 190, 'off', 78],
  [128 * 200, 'off', 41], [128 * 210, 'off', 79]];
ends['drummap-repeat'] = 128 * 240;

// an Arpeggiator on ARP, saved bypassed (the factory patches' arpeggiator): bypassed it hands Main's keys straight to the
// Voicing (a chord sounds as played); ARP (index 6) switches it on (the straight notes let go, it arpeggiates the keys
// still held) and off again (its note lets go, a key pressed after plays straight)
tests['arp-bypass'] = make('arp-bypass', (add, wire) => {
  const kb = add('fm1', 0, 0, { tempo: 140 });
  const a = add('arp', 200, 0, { mode: 0, rate: 4, octaves: 2, gate: 0.5 });
  const al = add('alloc', 400, 0, { voices: 3 });
  const o = add('osc', 600, 0, { wave: 2, level: 0.5 });
  const e = add('adsr', 600, 200, { a: 0.002, d: 0.08, s: 0.5, r: 0.04 });
  const v = add('vca', 800, 0);
  const out = add('output', 1000, 0, { level: 0.6 });
  wire(kb, 'keys', a, 'keys');
  wire(a, 'keys', al, 'keys');
  wire(al, 'pitch', o, 'pitch');
  wire(al, 'gate', e, 'gate');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
});
{
  const t = tests['arp-bypass'];
  const ids = t.modules.filter((m) => ['alloc', 'osc', 'adsr', 'vca'].includes(m.type)).map((m) => m.id);
  makeAssembly(t, ids, 'voice').poly = {};
  const arp = t.modules.find((m) => m.type === 'arp')!;
  arp.bypass = true;
  t.modules[0].panel = { toggle: ['arp'], kinds: { arp: 'bypass' }, targets: { arp: { module: arp.id } } };
}
events['arp-bypass'] = [[0, 'on', 60], [128 * 2, 'on', 64], [128 * 40, 'boff', 6], [128 * 140, 'bon', 6], [128 * 150, 'on', 67], [128 * 170, 'off', 60],
  [128 * 175, 'off', 64], [128 * 190, 'off', 67]];
ends['arp-bypass'] = 128 * 230;

// a Steps track through an Arpeggiator (the factory patches' PATTERN): Main's keys into the track (they pass through it
// unarmed), its keys into the arpeggiator, the arpeggiator's into a Voicing and into a Drum map. Bypassed: the track's notes
// and the keys play straight; ARP on: both arpeggiated (the voice and the map's rows)
tests['steps-arp'] = make('steps-arp', (add, wire) => {
  const kb = add('fm1', 0, 0, { tempo: 150 });
  const st = add('steps', 200, 0, { len: 8, rate: 3, gate: 0.9 });
  const a = add('arp', 400, 0, { mode: 2, rate: 5, octaves: 1, gate: 0.6 });
  const al = add('alloc', 600, 0, { voices: 2 });
  const o = add('osc', 800, 0, { wave: 1, level: 0.5 });
  const e = add('adsr', 800, 200, { a: 0.002, d: 0.06, s: 0.5, r: 0.03 });
  const v = add('vca', 1000, 0);
  const dm = add('drummap', 600, 400, { n1: 60, n2: 64, n3: 67 });
  const mr = add('mixer', 1000, 400, { l1: 0.3, l2: 0.3, l3: 0.3, l4: 0.3 });
  const out = add('output', 1200, 0, { level: 0.6 });
  wire(kb, 'keys', st, 'keys');
  wire(st, 'keys', a, 'keys');
  wire(a, 'keys', al, 'keys');
  wire(a, 'keys', dm, 'keys');
  wire(al, 'pitch', o, 'pitch');
  wire(al, 'gate', e, 'gate');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
  wire(dm, 'g1', mr, 'in1');
  wire(dm, 'g2', mr, 'in2');
  wire(dm, 'g3', mr, 'in3');
  wire(dm, 'v1', mr, 'in4');
  wire(mr, 'out', out, 'r');
});
{
  const t = tests['steps-arp'];
  const ids = t.modules.filter((m) => ['alloc', 'osc', 'adsr', 'vca'].includes(m.type)).map((m) => m.id);
  makeAssembly(t, ids, 'voice').poly = {};
  const arp = t.modules.find((m) => m.type === 'arp')!;
  arp.bypass = true;
  t.modules[0].panel = { toggle: ['arp'], kinds: { arp: 'bypass' }, targets: { arp: { module: arp.id } } };
  t.modules.find((m) => m.type === 'steps')!.notes = [n(0, 4, 60), n(0, 4, 64, 90), n(4, 2, 67, 120), n(6, 1, 60, 70)];
}
events['steps-arp'] = [[128 * 3, 'run', 0], [128 * 60, 'on', 72], [128 * 90, 'off', 72], [128 * 120, 'boff', 6], [128 * 200, 'on', 76], [128 * 240, 'off', 76],
  [128 * 300, 'bon', 6], [128 * 340, 'on', 67], [128 * 360, 'off', 67], [128 * 400, 'stop', 0]];
ends['steps-arp'] = 128 * 440;

// arming and recording from the keys (#134, #135, #139): a melody track (transposed a fourth up) into two voices on the
// left; the shared keyboard and a second track that a cable from Main's keys feeds (into one voice) on the right. Keys
// unarmed: the keyboard and the fed track; armed: through the melody track only (recording live: a short note, a chord, a
// note held two steps), taken into the track and heard on its next passes; disarmed with a key held: it goes quiet; a
// key again unarmed
tests['steps-arm'] = make('steps-arm', (add, wire) => {
  const main = add('fm1', 0, 0, { tempo: 150 });
  const st = add('steps', 200, 0, { len: 8, rate: 4, gate: 0.5 });
  const tr = add('const', 200, 300, { value: 5 / 12 });
  const al = add('alloc', 400, 0, { voices: 2 });
  const o = add('osc', 600, 0, { wave: 1, level: 0.5 });
  const e = add('adsr', 600, 200, { a: 0.003, d: 0.1, s: 0.6, r: 0.03 });
  const v = add('vca', 800, 0);
  const fed = add('steps', 200, 600, { len: 8, rate: 4 });
  const al2 = add('alloc', 400, 600, { voices: 1 });
  const o2 = add('osc', 600, 600, { wave: 2, level: 0.4 });
  const o3 = add('osc', 600, 800, { wave: 0, level: 0.3 });
  const mr = add('mixer', 800, 600, { l1: 0.5, l2: 0.5, l3: 0.3 });
  const out = add('output', 1000, 0, { level: 0.6 });
  wire(tr, 'out', st, 'transpose');
  wire(st, 'keys', al, 'keys');
  wire(al, 'pitch', o, 'pitch');
  wire(al, 'gate', e, 'gate');
  wire(o, 'out', v, 'in');
  wire(e, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
  wire(main, 'keys', fed, 'keys');
  wire(fed, 'keys', al2, 'keys');
  wire(al2, 'pitch', o2, 'pitch');
  wire(main, 'pitch', o3, 'pitch');
  wire(o2, 'out', mr, 'in1');
  wire(o3, 'out', mr, 'in2');
  wire(main, 'gate', mr, 'in3');
  wire(mr, 'out', out, 'r');
});
{
  const p = tests['steps-arm'];
  const ids = p.modules.filter((m) => ['alloc', 'osc', 'adsr', 'vca'].includes(m.type) && m.x < 700 && m.y < 400).map((m) => m.id);
  makeAssembly(p, ids, 'arm voices').poly = {};
  p.modules.find((m) => m.type === 'steps')!.notes = [n(0, 1, 48), n(4, 2, 55)];
}
{
  const arm = tests['steps-arm'].modules.findIndex((m) => m.type === 'steps');
  events['steps-arm'] = [[128 * 4, 'run', 0], [128 * 20, 'on', 60], [128 * 40, 'off', 60],
    [128 * 50, 'arm', arm], [128 * 51, 'rec', arm, 1], [128 * 60, 'on', 64], [128 * 66, 'off', 64],
    [128 * 100, 'on', 67], [128 * 101, 'on', 71], [128 * 140, 'off', 71], [128 * 141, 'off', 67],
    [128 * 170, 'on', 62], [128 * 260, 'off', 62], [128 * 270, 'take', 0], [128 * 280, 'rec', arm, 0],
    [128 * 400, 'on', 69], [128 * 420, 'arm', -1], [128 * 440, 'on', 57], [128 * 460, 'off', 57], [128 * 470, 'off', 69], [128 * 520, 'stop', 0]];
  ends['steps-arm'] = 128 * 560;
}

tests['steps-direction-live'] = make('steps-direction-live', (add, wire) => {
  const main = add('fm1', 0, 0, { tempo: 240 });
  const st = add('steps', 0, 0, { len: 4, rate: 6, swing: 75 }, { map: { p1: ['dir'], p2: ['len'] } });
  const scale = add('scale', 0, 0, { gain: 0.05 });
  const out = add('output', 0, 0, { level: 1 });
  wire(main, 'mod', st, 'p1'); wire(main, 'breath', scale, 'in'); wire(scale, 'out', st, 'p2');
  wire(main, 'gate', st, 'reset'); wire(st, 'trig', out, 'l'); wire(st, 'vel', out, 'r');
});
tests['steps-direction-live'].modules.find(m => m.type === 'steps')!.notes = Array.from({ length: 7 }, (_, at) =>
  ({ at, len: at % 3 + 1, note: 60 + at, vel: 30 + at * 10 }));
events['steps-direction-live'] = [[0, 'run', 0], [128 * 40, 'cc', 1, 42], [128 * 80, 'cc', 1, 85],
  [128 * 120, 'cc', 1, 127], [128 * 150, 'cc', 2, 127], [128 * 180, 'on', 60], [128 * 181, 'off', 60],
  [128 * 220, 'cc', 2, 0], [128 * 260, 'cc', 1, 0]];
ends['steps-direction-live'] = 128 * 300;

// A shortened reverse pass cancels an out-of-range swung visit and releases old long notes.
for (const long of [false, true]) {
  const name = `steps-shorten-${long ? 'held' : 'swing'}`;
  tests[name] = make(name, (add, wire) => {
    const main = add('fm1', 0, 0, { tempo: 120 });
    const st = add('steps', 0, 0, { len: 2, dir: 1, swing: long ? 50 : 75 }, { map: { p1: ['len'] } });
    const scale = add('scale', 0, 0, { gain: (long ? 62 : 2) / 63 });
    const out = add('output', 0, 0, { level: 1 });
    wire(main, 'mod', scale, 'in'); wire(scale, 'out', st, 'p1');
    wire(st, 'trig', out, 'l'); wire(st, 'vel', out, 'r');
  });
  tests[name].modules.find(m => m.type === 'steps')!.notes = long
    ? [{ at: 63, len: 64, note: 63, vel: 100 }]
    : Array.from({ length: 4 }, (_, at) => ({ at, len: 1, note: 60 + at, vel: 30 + at * 20 }));
  events[name] = [[0, 'cc', 1, 127], [128, 'run', 0], [128 * (long ? 9 : 52), 'cc', 1, 0]];
  ends[name] = 128 * 220;
}

// Direction changes affect traversal, swing, note duration and live recording in both engines.
for (const dir of [1, 2, 3]) {
  for (const base of ['steps-notes', 'steps-clk', 'steps-arm']) {
    const name = `${base}-dir-${dir}`;
    tests[name] = structuredClone(tests[base]); tests[name].name = name;
    for (const m of tests[name].modules) if (m.type === 'steps') m.params.dir = dir;
    events[name] = structuredClone(events[base]); ends[name] = ends[base];
  }
}
for (const dir of [0, 1, 2, 3]) for (const len of [1, 2, 5, 64]) {
  const name = `steps-direction-${dir}-${len}`;
  tests[name] = make(name, (add, wire) => {
    add('fm1', 0, 0, { tempo: 240 });
    const st = add('steps', 0, 0, { dir, len, swing: 75, rate: 8, gate: 0.5 });
    const out = add('output', 0, 0, { level: 1 });
    wire(st, 'trig', out, 'l'); wire(st, 'vel', out, 'r');
  });
  tests[name].modules.find(m => m.type === 'steps')!.notes = Array.from({ length: len }, (_, at) =>
    ({ at, len: at === len - 1 ? 4 : 1, note: 48 + at, vel: 20 + at, chance: at % 2 ? 50 : 100 }));
  events[name] = [[0, 'run', 0], [128 * 300, 'stop', 0], [128 * 320, 'run', 0]];
  ends[name] = 128 * 600;
}

// patterns (format 48): two tracks of different lengths, each switching at the end of its own pass (a pattern chosen while
// running waits; stopped, it plays at once); a pattern with its own length, one with its own length and rate, long words
// (a chance, an odd velocity) and short ones; a pattern a track has not got plays its first, an empty one is silent; the
// same with the first track backwards and the second at random
for (const dirs of [[0, 0], [1, 3]]) {
  const name = dirs[0] ? 'steps-patterns-dir' : 'steps-patterns';
  tests[name] = make(name, (add, wire) => {
    add('fm1', 0, 0, { tempo: 240 });
    const out = add('output', 2000, 0, { level: 0.6 });
    const voice = (x: number, wave: number, p: Record<string, number>, port: string): void => {
      const st = add('steps', x, 0, p);
      const o = add('osc', x + 100, 0, { wave });
      const env = add('adsr', x + 100, 200, { a: 0.002, d: 0.05, s: 0.5, r: 0.03 });
      const v1 = add('vca', x + 200, 0);
      const v2 = add('vca', x + 300, 0);
      wire(st, 'pitch', o, 'pitch'); wire(st, 'trig', env, 'gate');
      wire(o, 'out', v1, 'in'); wire(env, 'env', v1, 'cv'); wire(v1, 'out', v2, 'in'); wire(st, 'vel', v2, 'cv');
      wire(v2, 'out', out, port);
    };
    voice(200, 1, { len: 8, rate: 6, gate: 0.5, dir: dirs[0] }, 'l');
    voice(700, 2, { len: 6, rate: 6, gate: 0.7, swing: 60, dir: dirs[1] }, 'r');
  });
  const [a, b] = tests[name].modules.filter((m) => m.type === 'steps');
  a.notes = [n(0, 1, 48), n(1, 1, 55, 127), n(2, 2, 60), n(4, 1, 63, 90), n(5, 1, 67), n(6, 2, 70, 40), n(7, 1, 72)];
  a.patterns = [
    { notes: [n(0, 2, 62, 127), n(2, 1, 65), n(3, 1, 67, 100, 50), n(4, 3, 70, 77)], len: 5 },
    { notes: [n(0, 1, 48, 127), n(1, 1, 50), n(3, 2, 53), n(5, 1, 55, 127), n(9, 1, 57), n(11, 4, 60)], len: 12, rate: 5 },
  ];
  b.notes = [n(0, 1, 36), n(2, 1, 43, 70), n(3, 1, 39), n(5, 1, 36, 127)];
  b.patterns = [{ notes: [n(0, 2, 41), n(2, 1, 41, 127), n(4, 1, 44)] }, null, {}];
  events[name] = [[128 * 5, 'run', 0], [128 * 40, 'pat', 1], [128 * 200, 'pat', 2], [128 * 420, 'pat', 3], [128 * 600, 'stop', 0],
    [128 * 620, 'pat', 1], [128 * 640, 'run', 0], [128 * 800, 'pat', 0]];
  ends[name] = 128 * 1000;
}

// songs (format 48): a song's entries, a pass each (patterns with their shift, back to the first after the last), stop and
// PLAY start it again; another song chosen while running, then none (the selected pattern again, unshifted); a track that
// plays a Drum map is never shifted (its notes stay on their rows) and a pattern it has not got plays its first
tests['steps-song'] = make('steps-song', (add, wire) => {
  add('fm1', 0, 0, { tempo: 240 });
  const out = add('output', 2000, 0, { level: 0.6 });
  const st = add('steps', 200, 0, { len: 4, rate: 6, gate: 0.5 });
  const o = add('osc', 300, 0, { wave: 1 });
  const env = add('adsr', 300, 200, { a: 0.002, d: 0.05, s: 0.5, r: 0.03 });
  const v = add('vca', 400, 0);
  wire(st, 'pitch', o, 'pitch'); wire(st, 'trig', env, 'gate'); wire(o, 'out', v, 'in'); wire(env, 'env', v, 'cv');
  wire(v, 'out', out, 'l');
  const dt = add('steps', 200, 600, { len: 4, rate: 6, gate: 0.5 });
  const dm = add('drummap', 400, 600);
  const mx = add('mixer', 600, 600, { l1: 0.4, l2: 0.3, l3: 0.3 });
  wire(dt, 'keys', dm, 'keys'); wire(dm, 'g1', mx, 'in1'); wire(dm, 'g2', mx, 'in2'); wire(dm, 'v2', mx, 'in3');
  wire(mx, 'out', out, 'r');
});
{
  const p = tests['steps-song'];
  const [a, d] = p.modules.filter((m) => m.type === 'steps');
  a.notes = [n(0, 1, 60), n(1, 1, 64), n(2, 1, 67, 127), n(3, 1, 72)];
  a.patterns = [{ notes: [n(0, 2, 48, 127), n(2, 2, 55)] }, { notes: [n(0, 1, 72), n(1, 1, 71), n(2, 1, 69, 127)], len: 3 }];
  d.notes = [n(0, 1, 36), n(2, 1, 38)];
  d.patterns = [{ notes: [n(0, 1, 36), n(1, 1, 36), n(3, 1, 38, 127)] }];
  p.modules.find((m) => m.type === 'fm1')!.seq = { song: 1, songs: [[{ pat: 0, shift: 0 }, { pat: 1, shift: 5 }, { pat: 2, shift: -7 }, { pat: 1, shift: 12 }], [{ pat: 2, shift: 3 }, { pat: 0, shift: -12 }]] };
  events['steps-song'] = [[128 * 5, 'run', 0], [128 * 300, 'stop', 0], [128 * 330, 'run', 0], [128 * 500, 'song', 2], [128 * 700, 'song', 0],
    [128 * 760, 'pat', 1], [128 * 900, 'stop', 0]];
  ends['steps-song'] = 128 * 960;
}

// arming as a set (#191): two Voicing modules on Main's keys (A's gate left, B's right) and a Drum map on them (its first
// row's gate added right); armed: only the armed ones hear Main, several at once; none: the cables again
tests['arm-set'] = make('arm-set', (add, wire) => {
  const main = add('fm1', 0, 0);
  const a = add('alloc', 200, 0, { voices: 2 });
  const b = add('alloc', 200, 300, { voices: 2 });
  const dm = add('drummap', 200, 600);
  const mr = add('mixer', 400, 300, { l1: 0.5, l2: 0.5 });
  const out = add('output', 600, 0, { level: 0.6 });
  wire(main, 'keys', a, 'keys');
  wire(main, 'keys', b, 'keys');
  wire(main, 'keys', dm, 'keys');
  wire(a, 'gate', out, 'l');
  wire(b, 'gate', mr, 'in1');
  wire(dm, 'g1', mr, 'in2');
  wire(mr, 'out', out, 'r');
});
{
  const idx = (t: string, k = 0): number => tests['arm-set'].modules.map((m, i) => (m.type === t ? i : -1)).filter((i) => i >= 0)[k];
  const bit = (...i: number[]): number => i.reduce((m, k) => m + 2 ** k, 0);
  events['arm-set'] = [[128 * 4, 'on', 60], [128 * 20, 'off', 60], [128 * 30, 'arms', bit(idx('alloc', 1))], [128 * 40, 'on', 62], [128 * 60, 'off', 62],
    [128 * 70, 'arms', bit(idx('alloc', 0), idx('drummap'))], [128 * 80, 'on', 36], [128 * 100, 'off', 36], [128 * 110, 'arms', bit(idx('alloc', 0), idx('alloc', 1))],
    [128 * 120, 'on', 64], [128 * 140, 'arms', 0], [128 * 150, 'off', 64], [128 * 160, 'on', 36], [128 * 180, 'off', 36]];
  ends['arm-set'] = 128 * 200;
}

// disabled fixed links (format 17's flag bit 2, never written since the links became permanent; the firmware still reads
// it): the binary carries the LFO -> filter cv cable with the filter's cv input masked off (the VCA's mask 0 keeps its cv),
// so the firmware must play the reference, which is the same patch without that cable
{
  const build = (masked: boolean): Patch =>
    make('disabled-inputs', (add, wire) => {
      const kb = add('fm1', 0, 0);
      const osc = add('osc', 0, 0, { wave: 2, level: 0.8 });
      const lfo = add('lfo', 0, 0, { wave: 0, rate: 3, depth: 1 });
      const flt = add('filter', 0, 0, { cutoff: 600, res: 0.5, cvamt: 2 });
      const vca = add('vca', 0, 0);
      const out = add('output', 0, 0, { level: 0.8 });
      wire(kb, 'pitch', osc, 'pitch');
      wire(osc, 'out', flt, 'in');
      if (masked) wire(lfo, 'out', flt, 'cv');
      wire(flt, 'lp24', vca, 'in');
      wire(kb, 'gate', vca, 'cv');
      wire(vca, 'out', out, 'l');
      wire(vca, 'out', out, 'r');
    });
  tests['disabled-inputs'] = build(false);
  const p = build(true);
  const enc = encodePatch(p, true);
  if (enc[3] !== 0 || enc[6] & 1) throw new Error('disabled-inputs: the mask section goes after the cables (no groups, no morph)');
  let at = 8 + PANEL_BYTES;
  for (const m of p.modules) at += recordSize(m.type, enc[1]);
  at += 4 * p.cables.length;
  const last = p.cables[p.cables.length - 1];
  const idx = (id: number): number => p.modules.findIndex((m) => m.id === id);
  if (enc[at - 4] !== idx(last.from.module) || enc[at - 2] !== idx(last.to.module)) throw new Error('disabled-inputs: the cables do not end where expected');
  const masks = p.modules.map((m) => (m.type === 'filter' ? 1 << DEFS.filter.inputs.findIndex((i) => i.name === 'cv') : 0));
  const bin = new Uint8Array(enc.length + masks.length);
  bin.set(enc.subarray(0, at));
  bin.set(masks, at);
  bin.set(enc.subarray(at), at + masks.length);
  bin[6] |= FLAG_INPUTS;
  bins['disabled-inputs'] = bin;
}

// the 909 Kit: every Drum map row by its key on the running pattern (rows 3 and 5..8 are lean voices whose VCA gain the
// row's velocity sets through a macro range)
events['909 Kit'] = [[0, 'run', 0], ...[53, 55, 57, 59, 60, 62, 64, 65].flatMap((n, i): Ev[] => [[128 * (10 + 20 * i), 'on', n], [128 * (20 + 20 * i), 'off', n]])];
// the 808 Kit: the same (each drum's velocity sets a VCA's gain through a macro range; the tom and rim strike through a
// VCA on it; the closed hihat cuts the open one through a sample and hold)
events['808 Kit'] = events['909 Kit'];

// The standalone panel runner needs only these encoded patches, not an audio-golden run.
if (process.argv.includes('--panel-fixtures')) {
  const out = new URL('../../build/panel-fixtures/', import.meta.url);
  mkdirSync(out, { recursive: true });
  for (const name of ['unison-count-0-0', 'steps-direction-1-64', 'steps-patterns'])
    writeFileSync(new URL(`${name}.m1p`, out), encodePatch(tests[name], true));
  console.log('panel fixtures generated');
  process.exit(0);
}

// the factory drum kits play on the transport: their kits start it with the notes
for (const [name, patch] of Object.entries(tests))
  if (!events[name] && patch.modules.some((m) => m.type === 'steps')) events[name] = [[0, 'run', 0], ...EVENTS];

for (const [name, patch] of Object.entries(tests)) {
  const e = new Engine(SR);
  e.load(patch);
  const END = ends[name] ?? END_DEFAULT;
  const l = new Float32Array(END);
  const r = new Float32Array(END);
  let pos = 0;
  const seg = (to: number): void => {
    if (to > pos) {
      const a = new Float32Array(to - pos);
      const b = new Float32Array(to - pos);
      e.render(a, b);
      l.set(a, pos);
      r.set(b, pos);
      pos = to;
    }
  };
  const evs = events[name] ?? EVENTS;
  const notes = new Map(patch.modules.filter((m) => m.type === 'steps').map((m) => [m.id, m.notes]));
  for (const [fr, kind, note, ch] of evs) {
    seg(fr);
    if (kind === 'arm') e.arm(note < 0 ? null : patch.modules[note].id);
    else if (kind === 'arms') e.arm(patch.modules.flatMap((m, i) => (Math.floor(note / 2 ** i) % 2 ? [`m${m.id}`] : [])));   // (#191: a mask of module indices)
    else if (kind === 'rec') e.setRec(patch.modules[note].id, !!ch);
    else if (kind === 'take')
      for (const r of e.takeRecorded()) {
        notes.set(r.id, overdub(notes.get(r.id), [r.note]));
        e.setTrack(r.id, notes.get(r.id));
      }
    else if (kind === 'cc') e.cc(note, ch ?? 0);
    else if (kind === 'pat') e.setPattern(note);
    else if (kind === 'song') e.setSong(note);
    else if (kind === 'on') e.noteOn(note, 1, ch ?? 1);
    else if (kind === 'off') e.noteOff(note, ch ?? 1);
    else if (kind === 'bon' || kind === 'boff') e.setButton(note, kind === 'bon');
    else if (kind === 'ext' || kind === 'int') e.clockExternal(kind === 'ext');
    else if (kind === 'tick') e.clockTick();
    else e.transport(kind === 'run');
  }
  seg(END);
  const st = new Float32Array(END * 2);
  for (let i = 0; i < END; i++) {
    st[2 * i] = l[i];
    st[2 * i + 1] = r[i];
  }
  const f = slug(name);
  const cpu = cpuEstimate(patch).use;
  if (cpu > 1) console.log(`${name}: estimated at ${Math.round(cpu * 100)} % of the FM-1's CPU (a correctness kit, not a real-time one)`);
  writeFileSync(new URL(`${f}.m1p`, OUT), bins[name] ?? encodePatch(patch, true));
  // the parameter values the editor's budget counts (DEVICE.params), which eng_load must take exactly (host_test checks)
  if (!bins[name]) writeFileSync(new URL(`${f}.par`, OUT), `${deviceBudget(patch).items.find((i) => i.key === 'params')!.used}\n`);
  writeFileSync(new URL(`${f}.f32`, OUT), new Uint8Array(st.buffer));
  writeFileSync(new URL(`${f}.ev`, OUT), evs.map(([fr, k, n, ch]) => (k === 'on' ? `${fr} on ${n} 127 ${ch ?? 1}` : k === 'off' ? `${fr} off ${n} ${ch ?? 1}` : k === 'bon' || k === 'boff' || k === 'arm' || k === 'arms' || k === 'pat' || k === 'song' ? `${fr} ${k} ${n}` : k === 'rec' || k === 'cc' ? `${fr} ${k} ${n} ${ch}` : `${fr} ${k}`)).join('\n') + `\n${END} end\n`);
}
// protocol test input: upload of the acid kit, then a cutoff change on its filter
{
  const p = acid();
  const bin = encodePatch(p);
  const mod = p.modules.findIndex((m) => m.type === 'filter');
  const par = DEFS.filter.params.findIndex((x) => x.name === 'cutoff');
  const val = toQ16(900);
  const attVal = toQ16(-0.5);
  const frames = [...chunkFrames(bin, 50), commitFrame(bin), paramFrame(mod, par, val), attFrame(mod, 0, attVal)];
  writeFileSync(new URL('proto.syx', OUT), Buffer.concat(frames));
  // preset bank: the patch into slot 5 as '303 ACID', an erase of slot 7 and an info request for slot 5, then a slot
  // command with a wrong CRC (must be refused)
  const bad = Uint8Array.from(bin);
  const slotFrames = [...chunkFrames(bin, 90), slotFrame(5, '303 ACID', bin), slotInfoFrame(5), slotEraseFrame(7), ...chunkFrames(bad, 90), slotFrame(6, 'BAD', bad, 0x1234)];
  writeFileSync(new URL('proto-slot.syx', OUT), Buffer.concat(slotFrames));
  writeFileSync(new URL('proto.args', OUT), `${mod} ${par} ${val} ${mod} 0 ${attVal}\n`);
}
// sandbox mode: a SANDBOX page as the editor sends it (proto_test checks every field the firmware parses; a minus sign
// arrives as '-')
writeFileSync(new URL('proto-sandbox.syx', OUT), sandboxFrame({
  patch: 'SOL 29N XL', device: 'Sol filter', page: 'FILTER 1/2', index: 2, count: 5,
  rows: [{ label: 'Cutoff', value: '2.40', unit: 'kHz', pos: 150 / 255, steps: 0 }, { label: 'Res', value: '\u221212', unit: 'dB', pos: 1, steps: 0 },
    { label: 'Wave', value: 'SAW', unit: '', pos: 0, steps: 4 }, null],
}));
console.log(`golden vectors for ${Object.keys(tests).length} patches in build/golden/`);
