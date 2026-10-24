// SPDX-License-Identifier: GPL-3.0-only
// The level each factory patch should reach in the emulator smoke test (tools/emu, `m1emu smoke --levels`): a freshly
// loaded patch, MIDI note 60 at velocity 100 held for 500 ms (the drum kits, which have Steps tracks: with the transport running), peak of the left channel in the emulator's 16-bit units
// (full scale 1.0 = 12656: the -6 dB output ceiling times the MASTER pot at fm1-emu's default 900 of 1023, square law).
// Writes build/emu/levels.txt, one "NAME<TAB>peak<TAB>steps" line per patch, names as the LCD shows them; steps 1: it has
// Steps tracks, so the smoke test presses PLAY around its note (as for the drum kits and the sequenced engines).
// Run from web/:  npx vite-node scripts/emu-levels.ts   (npm run emu:smoke does this)
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine';
import { FM1_PRESETS } from '../src/presets';

const SR = 44100;
const FULL = 12656;
const out = new URL('../../build/emu/', import.meta.url);
mkdirSync(out, { recursive: true });
const lines: string[] = [];
for (const [name, make] of Object.entries(FM1_PRESETS)) {
  const e = new Engine(SR);
  const p = make();
  e.load(p);
  e.transport(p.modules.some((m) => m.type === 'steps')); // (the smoke test presses PLAY for these)
  const L = new Float32Array(128), R = new Float32Array(128);
  let peak = 0;
  e.noteOn(60, 100 / 127);
  for (let b = 0; b < Math.round((0.5 * SR) / 128); b++) {
    e.render(L, R);
    for (const v of L) peak = Math.max(peak, Math.abs(v));
  }
  lines.push(`${name.toUpperCase()}\t${Math.round(Math.min(peak, 1) * FULL)}\t${p.modules.some((m) => m.type === 'steps') ? 1 : 0}`);
}
writeFileSync(new URL('levels.txt', out), lines.join('\n') + '\n');
console.log(`${lines.length} levels -> build/emu/levels.txt`);
