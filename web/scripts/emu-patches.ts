// SPDX-License-Identifier: GPL-3.0-only
// Patches the emulator smoke test (tools/emu, `m1emu smoke`) seeds into the flash bank, as patch binaries:
//   build/emu/heavy-poly.m1p   eight parts of a heavy voice (six oversampled unison oscillators): far over the CPU budget,
//                              on two cores too (#271: each core renders four parts),
//                              the overload guard must drop parts until it plays
//   build/emu/heavy-mono.m1p   one part of many such oscillators: nothing to drop, the guard must mute it (OVERLOAD); twice
//                              as many since every patch shares both cores (D-1101), which made 24 fit the emulated FM-1
//   build/emu/panel.m1p        the patch buttons
//   build/emu/long-delay.m1p, long-delay-pp.m1p   a 700 ms Delay (its line in the pool's line area), plain and ping-pong
//   build/emu/low-delay.m1p, low-delay-pp.m1p     a 290 ms Delay (its line in .lowram's line area), plain and ping-pong
//                              (#273, #651: the smoke checks every block of each echo against the note's own sound)
//   build/emu/knobs.m1p        an LFO whose first page holds a 0..1 row and a switch: the knob acceleration and a switch's step
//   build/emu/7ph.m1p          the <7PH groove-box example (editor-only since D-890, its bytes kept), encoded as the
//                              factory patches are, for the piano roll's melodic PATTERN
// encodePatch(p, true) skips the budget check (these are meant to be too heavy). Run from web/:
//   npx vite-node scripts/emu-patches.ts   (tools/emu_smoke.sh does this)
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpuEstimate } from '../src/cpu';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, type Patch } from '../src/patch';
import { delayBytes, encodePatch, linePlace } from '../src/patchbin';
import { EXAMPLE_PRESETS } from '../src/presets';
import { withParts } from '../src/test-poly';

const out = new URL('../../build/emu/', import.meta.url);
mkdirSync(out, { recursive: true });

/** Main -> `n` oscillators (unison 5, feedback: the 2x oversampled path), all into one VCA opened by an ADSR -> the output */
function heavy(name: string, n: number): Patch {
  const p = emptyPatch(name);
  const main = addModule(p, DEFS.fm1, 0, 0);
  const env = addModule(p, DEFS.adsr, 0, 300);
  const vca = addModule(p, DEFS.vca, 600, 0);
  const o = addModule(p, DEFS.output, 900, 0);
  Object.assign(env.params, { a: 0.005, d: 0.2, s: 0.8, r: 0.2 });
  const wire = (a: number, ap: string, b: number, bp: string): void => {
    if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`${name}: ${ap} -> ${bp}`);
  };
  for (let i = 0; i < n; i++) {
    const osc = addModule(p, DEFS.osc, 300, i * 40);
    Object.assign(osc.params, { wave: 2, level: 0.8 / n, unison: 5, detune: 20, fb: 0.3, coarse: (i % 3) * 7 });
    wire(main.id, 'pitch', osc.id, 'pitch');
    wire(osc.id, 'out', vca.id, 'in');
  }
  wire(main.id, 'gate', env.id, 'gate');
  wire(env.id, 'env', vca.id, 'cv');
  wire(vca.id, 'out', o.id, 'l');
  wire(vca.id, 'out', o.id, 'r');
  return p;
}

/** the panel (#60): saw -> VCA (cv: the FX button, held) -> VCA (cv: the REC button, switched, saved on) -> output */
function panel(): Patch {
  const p = emptyPatch('EMU PANEL');
  const main = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 300, 0);
  const v = addModule(p, DEFS.vca, 600, 0);
  const v2 = addModule(p, DEFS.vca, 900, 0);
  const o = addModule(p, DEFS.output, 1200, 0);
  Object.assign(osc.params, { wave: 2, level: 0.8 });
  for (const [a, ap, b, bp] of [[main, 'pitch', osc, 'pitch'], [osc, 'out', v, 'in'], [main, 'fx', v, 'cv'], [v, 'out', v2, 'in'], [main, 'arp', v2, 'cv'], [v2, 'out', o, 'l']] as const)
    if (!connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp })) throw new Error(`panel: ${ap} -> ${bp}`);
  main.panel = { toggle: ['arp'], on: ['arp'], labels: { fx: 'GATE', arp: 'MUTE' } };
  return p;
}
writeFileSync(new URL('panel.m1p', out), encodePatch(panel()));

/** the long delay (#273): a 30 ms saw burst on each note into a Delay at the FM-1's longest time (`time` ms, all wet; ping-pong with
 * feedback 0.5, so the right side hears the second echo): silent until the first echo arrives `time` ms after the note */
/** A short burst on a note into a Delay of `ms` (length and time). Plain: all wet on the left, the note itself (dry) on the
 * right, so the left is the right `ms` later. Ping-pong (feedback 0.5, mix 0.5): the note on both sides, then its echoes,
 * left (as loud), right (half), left (a quarter). The smoke test (tools/emu/src/smoke.rs long_delay) compares every
 * block of each echo with the note (#651). */
function longDelay(name: string, ms: number, pingpong: number, area: 0 | 1): Patch {
  const p = emptyPatch(name);
  const main = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 300, 0);
  const env = addModule(p, DEFS.adsr, 300, 300);
  const v = addModule(p, DEFS.vca, 600, 0);
  const d = addModule(p, DEFS.delay, 900, 0);
  const o = addModule(p, DEFS.output, 1200, 0);
  Object.assign(osc.params, { wave: 2, level: 0.8 });
  Object.assign(env.params, { a: 0.001, d: 0.03, s: 0, r: 0.01 });
  Object.assign(d.params, { time: ms, length: ms, fb: pingpong ? 0.5 : 0, mix: pingpong ? 0.5 : 1, pingpong });
  const [rm, rp] = pingpong ? [d, 'r'] : [v, 'out'];   // (the right side: the Delay's, or the note itself)
  for (const [a, ap, b, bp] of [[main, 'pitch', osc, 'pitch'], [main, 'gate', env, 'gate'], [osc, 'out', v, 'in'], [env, 'env', v, 'cv'], [v, 'out', d, 'in'], [d, 'out', o, 'l'], [rm, rp, o, 'r']] as const)
    if (!connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp })) throw new Error(`${name}: ${ap} -> ${bp}`);
  // (the line's area as the FM-1 places it: 0 .lowram, 1 the pool)
  if (linePlace([delayBytes(ms)])?.[0] !== area) throw new Error(`${name}: its line is not in area ${area}`);
  return p;
}
for (const [file, name, ms, pp, area] of [
  ['long-delay.m1p', 'EMU LONG DELAY', 700, 0, 1], ['long-delay-pp.m1p', 'EMU LONG PINGPONG', 700, 1, 1],
  ['low-delay.m1p', 'EMU LOW DELAY', 290, 0, 0], ['low-delay-pp.m1p', 'EMU LOW PINGPONG', 290, 1, 0],
] as const)
  writeFileSync(new URL(file, out), encodePatch(longDelay(name, ms, pp, area)));

/** the knobs (#340, #405): one LFO, the home device; its first page K1..K4 = WAVE, RATE, DEPTH (0..1 in 0.01 steps, at 0)
 * and SYNC (a switch, at SYNC). The smoke test turns DEPTH for the knob acceleration and SYNC for a switch's single step */
function knobs(): Patch {
  const p = emptyPatch('EMU KNOBS');
  addModule(p, DEFS.fm1, 0, 0);
  const lfo = addModule(p, DEFS.lfo, 300, 0);
  const o = addModule(p, DEFS.output, 600, 0);
  Object.assign(lfo.params, { depth: 0, sync: 1 });
  if (!connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: o.id, port: 'l' })) throw new Error('knobs: out -> l');
  return p;
}
writeFileSync(new URL('knobs.m1p', out), encodePatch(knobs()));

for (const [file, p] of [
  ['heavy-poly.m1p', withParts(heavy('EMU HEAVY POLY', 6), 8)],
  ['heavy-mono.m1p', heavy('EMU HEAVY MONO', 48)],
] as const) {
  writeFileSync(new URL(file, out), encodePatch(p, true));
  console.log(`${file}: CPU estimate ${Math.round(cpuEstimate(p).use * 100)} %`);
}

writeFileSync(new URL('7ph.m1p', out), encodePatch(EXAMPLE_PRESETS['<7PH'](), true, false, 1));
