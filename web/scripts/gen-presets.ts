// SPDX-License-Identifier: GPL-3.0-only
// Run from web/: npx vite-node scripts/gen-presets.ts
// Export the approved hardware defaults; editor examples are never exported here.
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildSelectedFactoryBank, factoryFile } from '../src/factory-bank';

const dir = new URL('../presets/', import.meta.url);
const bank = buildSelectedFactoryBank();
const files = new Set(bank.map(({ name }, i) => factoryFile(i, name)));
for (const file of readdirSync(dir)) if (/^\d+-.*\.json$/.test(file) && !files.has(file)) unlinkSync(new URL(file, dir));
for (const [index, { name, patch }] of bank.entries()) {
  writeFileSync(new URL(factoryFile(index, name), dir), JSON.stringify(patch, null, 1) + '\n');
  console.log(`${index + 1}: ${name}`);
}
