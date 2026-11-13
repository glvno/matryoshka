// SPDX-License-Identifier: GPL-3.0-only
// Regenerate only the Effects shelf's master insert: npx vite-node scripts/gen-master-fx.ts
import { writeFileSync } from 'node:fs';
import { masterFxDef } from './master-fx';

writeFileSync(new URL('../src/assemblies/master-fx.json', import.meta.url), JSON.stringify(masterFxDef(), null, 2) + '\n');
