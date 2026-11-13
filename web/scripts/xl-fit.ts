// SPDX-License-Identifier: GPL-3.0-only
// Every XL and community patch against the FM-1's limits (#649 re-audit): what it is over, its modules, copies, buffers,
// memory, bytes and CPU estimate.   npx vite-node scripts/xl-fit.ts
import { communityEntries } from '../src/community';
import { relocatedPatches } from '../src/community-factory';
import { decodeShare } from '../src/share';
import { DEFS } from '../src/modules';
import { deviceBudget } from '../src/patchbin';
import type { Patch } from '../src/patch';
const show = (n: string, p: Patch) => { const b = deviceBudget(p); const it = (k: string) => { const i = b.items.find((x) => x.key === k)!; return `${i.used}/${i.max}`; }; console.log(`${n}: over [${b.over.map((i) => i.key === 'cpu' ? `cpu ${i.used}%` : `${i.key} ${i.used}/${i.max}`).join(', ')}] mod ${it('modules')} inst ${it('instances')} buf ${it('buffers')} mem ${it('memory')} bytes ${it('bytes')} cpu ${Math.round(b.cpu.use*100)}%`); };
for (const [name, make] of Object.entries(relocatedPatches)) show(name, make());
for (const e of communityEntries()) if (!relocatedPatches[e.title]) show(e.title, await decodeShare(e.code, DEFS));
