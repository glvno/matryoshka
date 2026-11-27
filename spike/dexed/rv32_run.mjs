// SPDX-License-Identifier: GPL-3.0-only
// Spike #1338: count rv32_bench.cc's blocks on tools/cpu/rv32.mjs's model and print them in model cycles and in
// microseconds on the FM-1 by web/src/cpu-costs.json's scale (cyclesPerUs, before any per-engine factor).
//   node spike/dexed/rv32_run.mjs ELF
import { readFileSync } from 'node:fs';
import { profile, readElf } from '../../tools/cpu/rv32.mjs';

const costs = JSON.parse(readFileSync(new URL('../../web/src/cpu-costs.json', import.meta.url)));
const { blocks } = profile(readElf(process.argv[2]), new Uint8Array(0), []);
const t = blocks.map((b) => b.total);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
let k = 0;
const out = { voices: {}, algorithms: [], noteOn: 0 };
for (const n of [1, 2, 4, 8, 16]) out.voices[n] = mean(t.slice(k, (k += 8)));
for (let a = 0; a < 32; a++) out.algorithms.push(mean(t.slice(k, (k += 4))));
out.noteOn = t[k++];
if (k !== t.length) throw new Error(`expected ${k} blocks, got ${t.length}`);
const us = (c) => (c / costs.cyclesPerUs).toFixed(1);
for (const [n, c] of Object.entries(out.voices))
  console.log(`${n.padStart(2)} voices: ${Math.round(c)} model cycles a 128-sample block (${Math.round(c / n)} a voice, ${us(c / n)} us a voice)`);
const al = out.algorithms;
console.log(`algorithms 1..32, one voice: min ${Math.round(Math.min(...al))} (alg ${al.indexOf(Math.min(...al)) + 1}), max ${Math.round(Math.max(...al))} (alg ${al.indexOf(Math.max(...al)) + 1}), mean ${Math.round(mean(al))}`);
console.log(`note-on: ${out.noteOn} model cycles`);
console.log(JSON.stringify({ cyclesPerUs: costs.cyclesPerUs, ...out }));
