// SPDX-License-Identifier: GPL-3.0-only
import { writeFileSync } from 'node:fs';
import { buildPresetPatterns } from './preset-pattern-build';
const entries = buildPresetPatterns();
writeFileSync(new URL('../src/preset-patterns.json', import.meta.url), JSON.stringify(entries, null, 1) + '\n');
console.log(`${entries.length} factory sound patterns`);
