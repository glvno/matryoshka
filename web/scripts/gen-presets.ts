// SPDX-License-Identifier: GPL-3.0-only
// Run from web/: npx vite-node scripts/gen-presets.ts
// Export the approved hardware defaults; editor examples are never exported here. Also src/factory-store.json: the
// patterns the factory patches link, as read-only entries of the FM-1's pattern store (factory-kit-patterns.ts, #923).
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildSelectedFactoryBank, factoryFile } from '../src/factory-bank';
import { kitStoreEntries } from '../src/factory-kit-patterns';
import { hexBytes } from '../src/pattern-store';

const dir = new URL('../presets/', import.meta.url);
const bank = buildSelectedFactoryBank();
const files = new Set(bank.map(({ name }, i) => factoryFile(i, name)));
for (const file of readdirSync(dir)) if (/^\d+-.*\.json$/.test(file) && !files.has(file)) unlinkSync(new URL(file, dir));
for (const [index, { name, patch }] of bank.entries()) {
  writeFileSync(new URL(factoryFile(index, name), dir), JSON.stringify(patch, null, 1) + '\n');
  console.log(`${index + 1}: ${name}`);
}
const store = kitStoreEntries(bank).map(({ payload, ...e }) => ({ ...e, payload: hexBytes(payload) }));
writeFileSync(new URL('../src/factory-store.json', import.meta.url), JSON.stringify(store, null, 1) + '\n');
console.log(`factory-store.json: ${store.length} linked patterns`);
