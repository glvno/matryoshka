// SPDX-License-Identifier: GPL-3.0-only
// Lists every factory patch / preset case of quiet-load.ts with its level, through both engines (#1086).
// Run from web/: npx vite-node scripts/quiet-audit.ts [OUT.json] [--only NAME]
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFm1EngineWasm } from './fm1-wasm.mjs';
import { auditPatch, caseLine, factoryPatches, QUIET_DB, type QuietResult } from './quiet-load';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const wasm = new WebAssembly.Module(readFileSync(buildFm1EngineWasm(join(tmpdir(), `fm1-engine-quiet-${process.pid}.wasm`))));
const all: QuietResult[] = [];
for (const { name, patch } of factoryPatches()) {
  if (only && name !== only) continue;
  for (const engine of ['browser', 'fm1'] as const) {
    const t = Date.now();
    const rs = auditPatch(name, patch, engine, wasm);
    all.push(...rs);
    for (const r of rs) if (r.peak >= QUIET_DB) console.log(`LOUD ${caseLine(r)}`);
    console.log(`${name} [${engine}]: ${rs.length} cases, ${rs.filter((r) => r.peak >= QUIET_DB).length} loud, ${Date.now() - t} ms`);
  }
}
if (out) writeFileSync(out, JSON.stringify(all, null, 1) + '\n');
