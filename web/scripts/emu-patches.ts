// SPDX-License-Identifier: GPL-3.0-only
// Patches the emulator smoke test (tools/emu, `m1emu smoke`) seeds into the flash bank, as patch binaries:
//   build/emu/heavy-poly.m1p   eight parts of a heavy voice (oversampled unison oscillators): far over the CPU budget,
//                              the overload guard must drop parts until it plays
//   build/emu/heavy-mono.m1p   one part of many such oscillators: nothing to drop, the guard must mute it (OVERLOAD)
// encodePatch(p, true) skips the budget check (these are meant to be too heavy). Run from web/:
//   npx vite-node scripts/emu-patches.ts   (tools/emu_smoke.sh does this)
import { mkdirSync, writeFileSync } from 'node:fs';
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

for (const [file, p] of [
  ['heavy-poly.m1p', withParts(heavy('EMU HEAVY POLY', 3), 8)],
  ['heavy-mono.m1p', heavy('EMU HEAVY MONO', 24)],
] as const) {
  writeFileSync(new URL(file, out), encodePatch(p, true));
  console.log(`${file}: CPU estimate ${Math.round(cpuEstimate(p).use * 100)} %`);
}
