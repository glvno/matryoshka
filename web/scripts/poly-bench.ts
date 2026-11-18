// SPDX-License-Identifier: GPL-3.0-only
// The polyphonic headroom benchmark (#1073): the factory poly synths at their voice counts with every master FX stage
// on, and the owner's Hera 6 "gauze 2" with its Delay and Reverb, as patch binaries for the test rig's survey
// (tools/rig_cpu_survey.py DIR) and the emulator's (`m1emu cpu --bank DIR/bank.txt`).
//   - "NAME fx": the factory patch with every stage of its own master FX bus on;
//   - "NAME fx4": when its bus lacks a stage, the bus replaced by all four (Drive, Chorus, Delay, Reverb) at their
//     defaults, all on: the heaviest master FX the FM-1 offers.
// From web/: npx vite-node scripts/poly-bench.ts -- OUT_DIR [OWNER_PATCH.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpuEstimate } from '../src/cpu';
import { fxBusOf, withFxBus } from '../src/fx-bus';
import { setFxStageEnabled } from '../src/fx-preset';
import { DEFS } from '../src/modules';
import { connect, removeModule, validatePatch, type Patch } from '../src/patch';
import { encodePatch } from '../src/patchbin';
import { FM1_PRESETS } from '../src/presets';

const POLY = ['Hera 6', 'Oracle V', 'Expander S', 'Algo Four', 'Io 4', 'Cassia 1'];

function allOn(src: Patch): Patch {
  const p = structuredClone(src);
  const bus = fxBusOf(p);
  if (!bus) throw new Error(`${p.name}: no master FX bus`);
  for (const s of bus.stages) setFxStageEnabled(p, s, true);
  return p;
}

/** the patch without its master FX bus: what fed the bus wired straight to the Output again */
function withoutBus(src: Patch): Patch {
  const p = structuredClone(src);
  const bus = fxBusOf(p)!;
  const root = p.assemblies!.find((a) => a.id === bus.assembly)!;
  const own = new Set([root.id, ...(root.children ?? [])]);
  const members = new Set(p.assemblies!.filter((a) => own.has(a.id)).flatMap((a) => a.modules));
  // the first stage's left and right inputs: a pair's two targets, or the Reverb's dry scales (left feeds its send's a)
  const first = bus.stages[0];
  const left = first.kind === 'reverb'
    ? p.cables.find((c) => first.helpers.includes(c.from.module) && c.to.port === 'a' && members.has(c.to.module) &&
        p.modules.find((m) => m.id === c.from.module)!.type === 'scale')!.from.module
    : first.targets[0];
  const output = p.modules.find((m) => m.type === 'output')!;
  const feeds = p.cables.filter((c) => members.has(c.to.module) && !members.has(c.from.module))
    .map((c) => ({ from: c.from, port: c.to.module === left ? 'l' : 'r' }));
  for (const id of members) removeModule(p, id);
  p.assemblies = p.assemblies!.filter((a) => !own.has(a.id));
  for (const f of feeds) if (!connect(p, DEFS, f.from, { module: output.id, port: f.port })) throw new Error(`${p.name}: rewire`);
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
  if (fxBusOf(p)!.stages.length < 4) set.push({ name: `${name} fx4`, patch: allOn(validatePatch(withFxBus(withoutBus(p)), DEFS)) });
}
const bank: string[] = [];
for (const { name, patch } of set) {
  const bin = encodePatch(patch, true);
  const voices = patch.modules.filter((m) => m.type === 'alloc').map((m) => m.params.voices).join('+');
  const stages = fxBusOf(patch)?.stages.map((s) => s.kind).join('+') ?? 'no bus';
  writeFileSync(`${out}/${name}.bin`, bin);
  writeFileSync(`${out}/${name}.m1p`, bin);
  writeFileSync(`${out}/${name}.json`, JSON.stringify(patch));
  bank.push(`${name}\t${out}/${name}.m1p`);
  console.log(`${name.padEnd(20)} voices ${voices.padEnd(5)} ${stages.padEnd(28)} ${bin.length} B, estimate ${(100 * cpuEstimate(patch).use).toFixed(1)} %`);
}
writeFileSync(`${out}/bank.txt`, bank.join('\n') + '\n');
