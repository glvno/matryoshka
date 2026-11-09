// SPDX-License-Identifier: GPL-3.0-only
// Patches for tools/aot_test.sh (#808): build/aot/*.m1p, each rendered by firmware/test/aot_test.c with and without the
// compiled factory assemblies. Some run compiled (the assembly alone, twice, beside a drum kit, morphing), some must fall
// back to the interpreter (a cable from outside into a port the assembly does not expose, a member changed).
// Run from web/:  npx vite-node scripts/aot-kits.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { FACTORY } from '../src/assemblies';
import { insertAssembly } from '../src/assembly';
import { DEFS } from '../src/modules';
import { addModule, connect, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
import { aotPatch, AOT_ASSEMBLIES } from './gen-aot';

const OUT = new URL('../../build/aot/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const kits: Record<string, Patch> = {};
const def = (name: string) => FACTORY.find((d) => d.name === name)!;
const heard = (p: Patch, a: ReturnType<typeof insertAssembly>, port = 'l'): void => {
  const sink = p.modules.find((m) => m.type === 'output')!;
  for (const o of a.outputs) connect(p, DEFS, { module: o.module, port: o.port }, { module: sink.id, port });
};
const keyed = (p: Patch, a: ReturnType<typeof insertAssembly>): void => {
  const main = p.modules[0].id;
  for (const i of a.inputs) {
    const from = i.port === 'keys' ? 'keys' : (['pitch', 'gate', 'vel', 'mod', 'at'] as const).find((k) => i.port === k || i.label === k);
    if (from) connect(p, DEFS, { module: main, port: from }, { module: i.module, port: i.port });
  }
};
const voices = (p: Patch, n: number): void => { for (const m of p.modules) if (m.type === 'alloc') m.params.voices = n; };

for (const name of AOT_ASSEMBLIES) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  kits[`${slug}-plain`] = aotPatch(name).patch;
  {   // the wheel and aftertouch cabled from Main into the exposed inputs (the factory patch does)
    const { patch, asm } = aotPatch(name);
    keyed(patch, asm);
    kits[`${slug}-keyed`] = patch;
  }
  {   // two of it (a groovebox's two tracks of one instrument), two voices each
    const { patch } = aotPatch(name);
    const b = insertAssembly(patch, DEFS, def(name), 300, 2000);
    heard(patch, b, 'r');
    keyed(patch, b);
    voices(patch, 2);
    kits[`${slug}-twice`] = patch;
  }
  {   // beside a drum kit (the groovebox case: two instruments)
    const { patch } = aotPatch(name);
    const d = insertAssembly(patch, DEFS, def('drum kit'), 300, 2000);
    heard(patch, d, 'r');
    keyed(patch, d);
    kits[`${slug}-drums`] = patch;
  }
  {   // morphing: every member has a B side, the Main module's morph halfway
    const { patch } = aotPatch(name);
    for (const m of patch.modules) if (m.type !== 'fm1' && m.type !== 'output') m.paramsB = Object.fromEntries(Object.entries(m.params).map(([k, v]) => [k, typeof v === 'number' ? v * 0.7 : v]));
    patch.modules[0].params.morph = 0.5;
    kits[`${slug}-morph`] = patch;
  }
  {   // falls back: an LFO from outside into the first member input the assembly does not expose
    const { patch, asm } = aotPatch(name);
    const lfo = addModule(patch, DEFS.lfo, 0, 3000);
    const target = patch.modules.find((m) => asm.modules.includes(m.id) && ['scale', 'vca'].includes(m.type))!;
    connect(patch, DEFS, { module: lfo.id, port: 'out' }, { module: target.id, port: 'in' });
    kits[`${slug}-outside`] = patch;
  }
}
for (const [name, p] of Object.entries(kits)) writeFileSync(new URL(`${name}.m1p`, OUT), encodePatch(p, true));
console.log(`aot kits: ${Object.keys(kits).join(', ')}`);
