// SPDX-License-Identifier: GPL-3.0-only
// Patches the emulator smoke test (tools/emu, `m1emu smoke`) seeds into the flash bank, as patch binaries:
//   build/emu/heavy-poly.m1p   eight parts of a heavy voice (oversampled unison oscillators): far over the CPU budget,
//                              the overload guard must drop parts until it plays
//   build/emu/heavy-mono.m1p   one part of many such oscillators: nothing to drop, the guard must mute it (OVERLOAD)
//   build/emu/panel.m1p        the patch buttons
//   build/emu/long-delay.m1p, long-delay-pp.m1p   the Delay at the FM-1's longest time, plain and ping-pong (#273)
//   build/emu/old-drift-poly.m1p   the newest earlier factory Drift Poly committed in git (an update finds it in the bank:
//                              the boot rewrites a slot holding it, #441)
// encodePatch(p, true) skips the budget check (these are meant to be too heavy). Run from web/:
//   npx vite-node scripts/emu-patches.ts   (tools/emu_smoke.sh does this)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpuEstimate } from '../src/cpu';
import { DEFS } from '../src/modules';
import { addModule, connect, emptyPatch, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
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
function longDelay(name: string, time: number, pingpong: number): Patch {
  const p = emptyPatch(name);
  const main = addModule(p, DEFS.fm1, 0, 0);
  const osc = addModule(p, DEFS.osc, 300, 0);
  const env = addModule(p, DEFS.adsr, 300, 300);
  const v = addModule(p, DEFS.vca, 600, 0);
  const d = addModule(p, DEFS.delay, 900, 0);
  const o = addModule(p, DEFS.output, 1200, 0);
  Object.assign(osc.params, { wave: 2, level: 0.8 });
  Object.assign(env.params, { a: 0.001, d: 0.03, s: 0, r: 0.01 });
  Object.assign(d.params, { time, fb: pingpong ? 0.5 : 0, mix: 1, pingpong });
  for (const [a, ap, b, bp] of [[main, 'pitch', osc, 'pitch'], [main, 'gate', env, 'gate'], [osc, 'out', v, 'in'], [env, 'env', v, 'cv'], [v, 'out', d, 'in'], [d, 'out', o, 'l'], [d, 'r', o, 'r']] as const)
    if (!connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp })) throw new Error(`${name}: ${ap} -> ${bp}`);
  return p;
}
writeFileSync(new URL('long-delay.m1p', out), encodePatch(longDelay('EMU LONG DELAY', DEFS.delay.params.find((q) => q.name === 'time')!.max, 0)));
writeFileSync(new URL('long-delay-pp.m1p', out), encodePatch(longDelay('EMU LONG PINGPONG', DEFS.delay.params.find((q) => q.name === 'time')!.max, 1)));

for (const [file, p] of [
  ['heavy-poly.m1p', withParts(heavy('EMU HEAVY POLY', 3), 8)],
  ['heavy-mono.m1p', heavy('EMU HEAVY MONO', 24)],
] as const) {
  writeFileSync(new URL(file, out), encodePatch(p, true));
  console.log(`${file}: CPU estimate ${Math.round(cpuEstimate(p).use * 100)} %`);
}

/** the bytes of every factory patch in a presets.h, by name */
function factoryBytes(src: string): Map<string, number[]> {
  const data = new Map<string, number[]>();
  for (const m of src.matchAll(/static const uint8_t (PRESET_\d+)\[\d+\] = \{([^}]*)\}/g)) data.set(m[1], m[2].split(',').map(Number));
  return new Map([...src.matchAll(/\{"([^"]*)", (PRESET_\d+),/g)].map((m) => [m[1], data.get(m[2])!]));
}
{ // an earlier factory patch as an update finds it in the bank (#441): the newest committed version unlike today's
  const root = new URL('../../', import.meta.url).pathname;
  const today = factoryBytes(readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8'));
  const commits = execFileSync('git', ['log', '--format=%H', '--', 'firmware/src/presets.h'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const [file, name] of [['old-drift-poly.m1p', 'DRIFT POLY']] as const) {
    const now = today.get(name)!.join(',');
    let hit: number[] | undefined;
    for (const c of commits) {
      const b = factoryBytes(execFileSync('git', ['show', `${c}:firmware/src/presets.h`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })).get(name);
      if (b && b.join(',') !== now) {
        hit = b;
        break;
      }
    }
    if (!hit) throw new Error(`${name}: no earlier factory version in git`);
    writeFileSync(new URL(file, out), Uint8Array.from(hit));
    console.log(`${file}: ${name} of an earlier presets.h, format ${hit[1]}, ${hit.length} bytes`);
  }
}
