// SPDX-License-Identifier: GPL-3.0-only
// Briefcase 3's entry in factory/bank.json (D-1052): the factory assembly (gen-assemblies.ts) with its pin board beside it
// (vcs3-board.ts: the 16 Matrix tiles after the assembly), Main's keys through PATTERN and the Arpeggiator, its outputs to
// the Output. The Output keeps the entry's level unless one is given (by the loudness rule, levels.ts).
// Run from web/ after gen-assemblies.ts:  npx vite-node scripts/gen-briefcase-3.ts [--level 0.5]
// then gen-presets.ts, legacy-factory.ts and npm run export-defs.
import { readFileSync, writeFileSync } from 'node:fs';
import { around, players } from './factory-build';
import { addBoard } from './vcs3-board';
import { DEFS } from '../src/modules';
import { validatePatch, type Patch } from '../src/patch';

const file = new URL('../factory/bank.json', import.meta.url);
const bank = JSON.parse(readFileSync(file, 'utf8')) as { name: string; patch: Patch }[];
const entry = bank.find((e) => e.name === 'Briefcase 3');
if (!entry) throw new Error('factory/bank.json has no Briefcase 3');
const at = process.argv.indexOf('--level');
const level = at > 0 ? Number(process.argv[at + 1]) : entry.patch.modules.find((m) => m.type === 'output')!.params.level;
if (!(level > 0 && level <= 1)) throw new Error(`--level: ${process.argv[at + 1]} is not in 0..1`);

const x = around('Briefcase 3', 'Briefcase 3');
addBoard(x.p, x.a, undefined, { x: x.a.x, y: Math.max(...x.p.modules.map((m) => m.y)) + 600 });
x.out.params.level = level;
entry.patch = validatePatch(players(x.p), DEFS);
writeFileSync(file, JSON.stringify(bank, null, 1) + '\n');
console.log(`Briefcase 3: ${entry.patch.modules.length} modules, ${entry.patch.cables.length} cables, Output ${level}`);
