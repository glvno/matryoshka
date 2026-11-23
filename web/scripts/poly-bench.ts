// SPDX-License-Identifier: GPL-3.0-only
// The polyphonic headroom benchmark (#1073): the factory poly synths at their voice counts with every effect of their FX
// drawer on, and the owner's Hera 6 "gauze 2" with its Delay and Reverb, as patch binaries for the test rig's survey
// (tools/rig_cpu_survey.py DIR) and the emulator's (`m1emu cpu --bank DIR/bank.txt`).
//   - "NAME fx": the factory patch with every effect of its own FX drawer on;
//   - "NAME fx4": when its drawer lacks one of the factory four, the drawer replaced by all four (Drive, Chorus, Delay,
//     Reverb) at their defaults, all on: the heaviest factory FX.
// From web/: npx vite-node scripts/poly-bench.ts -- OUT_DIR [OWNER_PATCH.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assemblyById, bypassAssembly } from '../src/assembly';
import { cpuEstimate } from '../src/cpu';
import { withFxBus } from '../src/factory-bank';
import { convertLegacyBus, rackOf, removeEffect } from '../src/fx-drawer';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
import { FM1_PRESETS } from '../src/presets';

const POLY = ['Hera 6', 'Oracle V', 'Expander S', 'Algo Four', 'Io 4', 'Cassia 1'];

const effectsOf = (p: Patch): number[] => rackOf(p).drawers.flatMap((d) => d.effects);

function allOn(src: Patch): Patch {
  const p = structuredClone(src);
  const effects = effectsOf(p);
  if (!effects.length) throw new Error(`${p.name}: no FX drawer effects`);
  for (const id of effects) bypassAssembly(p, assemblyById(p, id)!, false);
  return p;
}

/** the patch without its FX drawers: the chains close as their effects go (fx-drawer.ts removeEffect), then the empty
 *  drawers go too */
function withoutDrawers(src: Patch): Patch {
  const p = structuredClone(src);
  for (const id of effectsOf(p)) removeEffect(p, id);
  const drawers = new Set(rackOf(p).drawers.map((d) => d.drawer));
  p.assemblies = p.assemblies!.filter((a) => !drawers.has(a.id));
  for (const a of p.assemblies) if (a.children) a.children = a.children.filter((id) => !drawers.has(id));
  return p;
}

const out = process.argv[2];
if (!out) throw new Error('usage: poly-bench.ts OUT_DIR [OWNER_PATCH.json]');
mkdirSync(out, { recursive: true });
const set: { name: string; patch: Patch }[] = [];
if (process.argv[3]) set.push({ name: 'Hera 6 gauze 2', patch: validatePatch(JSON.parse(readFileSync(process.argv[3], 'utf8')), DEFS) });
for (const name of POLY) {
  const p = FM1_PRESETS[name]();
  set.push({ name: `${name} fx`, patch: allOn(p) });
  if (effectsOf(p).length < 4) set.push({ name: `${name} fx4`, patch: allOn(convertLegacyBus(withFxBus(withoutDrawers(p)))) });
}
const bank: string[] = [];
for (const { name, patch } of set) {
  const bin = encodePatch(patch, true);
  const voices = patch.modules.filter((m) => m.type === 'alloc').map((m) => m.params.voices).join('+');
  const stages = effectsOf(patch).map((id) => assemblyById(patch, id)!.label.toLowerCase()).join('+') || 'no FX';
  writeFileSync(`${out}/${name}.bin`, bin);
  writeFileSync(`${out}/${name}.m1p`, bin);
  writeFileSync(`${out}/${name}.json`, JSON.stringify(patch));
  bank.push(`${name}\t${out}/${name}.m1p`);
  console.log(`${name.padEnd(20)} voices ${voices.padEnd(5)} ${stages.padEnd(28)} ${bin.length} B, estimate ${(100 * cpuEstimate(patch).use).toFixed(1)} %`);
}
writeFileSync(`${out}/bank.txt`, bank.join('\n') + '\n');
