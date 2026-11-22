// SPDX-License-Identifier: GPL-3.0-only
// Run from web/: npx vite-node scripts/gen-presets.ts
// Export the approved hardware defaults (as they ship: the patches with a demo set without it, demo-sets.ts); editor
// examples are never exported here. Also src/factory-store.json: the patterns the factory patches' demo sets link, as
// read-only entries of the FM-1's pattern store (factory-kit-patterns.ts, #923); and src/demo-set-room.json: each demo
// set's layout and the bytes it takes in a patch, which the editor keeps free in a patch of that layout (patchbin.ts).
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { buildSelectedFactoryBank, factoryFile, shippedFactoryBank } from '../src/factory-bank';
import { kitStoreEntries } from '../src/factory-kit-patterns';
import { hexBytes } from '../src/pattern-store';
import { DEMO_SET_PATCHES, demoSetRecord } from '../src/demo-sets';

const dir = new URL('../presets/', import.meta.url);
const full = buildSelectedFactoryBank({ full: true });
const bank = shippedFactoryBank(full);
const files = new Set(bank.map(({ name }, i) => factoryFile(i, name)));
for (const file of readdirSync(dir)) if (/^\d+-.*\.json$/.test(file) && !files.has(file)) unlinkSync(new URL(file, dir));
for (const [index, { name, patch }] of bank.entries()) {
  writeFileSync(new URL(factoryFile(index, name), dir), JSON.stringify(patch, null, 1) + '\n');
  console.log(`${index + 1}: ${name}`);
}
const store = kitStoreEntries(full).map(({ payload, ...e }) => ({ ...e, payload: hexBytes(payload) }));
writeFileSync(new URL('../src/factory-store.json', import.meta.url), JSON.stringify(store, null, 1) + '\n');
const room = Object.fromEntries(DEMO_SET_PATCHES.map((name) => {
  const r = demoSetRecord(full.find((c) => c.name === name)!.patch);
  return [String((r[0] | r[1] << 8 | r[2] << 16 | r[3] << 24) >>> 0), r[24] | r[25] << 8];
}));
writeFileSync(new URL('../src/demo-set-room.json', import.meta.url), JSON.stringify(room, null, 1) + '\n');
console.log(`demo-set-room.json: ${DEMO_SET_PATCHES.length} demo sets`);
console.log(`factory-store.json: ${store.length} linked patterns`);
