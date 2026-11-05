// SPDX-License-Identifier: GPL-3.0-only
// Records each factory engine's structure in src/preset-lineage.json where it changed, and writes src/preset-migrations.json:
// how the user presets of every earlier structure move to today's (#627, D-865; scripts/lineage-lib.ts says how rows are
// matched). gen-assemblies runs it after writing the assemblies; run it alone after editing src/preset-maps.ts, then
// `npm run export-defs` (the FM-1's copy). From web/:
//   npx vite-node scripts/preset-lineage.ts             record today's structures, write the migrations
//   npx vite-node scripts/preset-lineage.ts --report    also print every step's map
//   npx vite-node scripts/preset-lineage.ts --seed v1.2.0 v1.3.0 ...   rebuild the lineage from those release tags and
//       today (each tag's structures checked against its presets.h: the fingerprints, and the Init preset's values in
//       canonical row order)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { toQ16 } from '../src/patchbin';
import type { Migration } from '../src/preset-migrate';
import { entryOf, factoryEngines, lineageText, LINEAGE_FILE, LINEAGE_ABOUT, migrationsOf, migrationsText, MIGRATIONS_FILE, todaysEngines, updateLineage, type Lineage, type Problem } from './lineage-lib';

const ROOT = new URL('../../', import.meta.url).pathname;
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });

/** the lineage from release tags (oldest first) and today, checked against each tag's factory presets */
function seed(tags: string[]): Lineage {
  const out: Lineage = { about: LINEAGE_ABOUT, engines: {} };
  const add = (name: string, e: ReturnType<typeof entryOf>, since?: string): void => {
    const list = (out.engines[name] ??= []);
    const head = list[list.length - 1];
    if (head?.structure === e.structure) list[list.length - 1] = { ...e, since: head.since };
    else list.push(since ? { ...e, since } : e);
  };
  for (const tag of tags) {
    const files = git('ls-tree', '--name-only', tag, 'web/src/assemblies/').split('\n').filter((f) => f.endsWith('.json'));
    const engines = factoryEngines(files.map((f) => ({ name: f.replace(/^.*\//, ''), text: git('show', `${tag}:${f}`) })));
    const ph = git('show', `${tag}:firmware/src/presets.h`);
    const fpv = new Map([...ph.matchAll(/static const int32_t (FPV_\d+)\[\d+\] = \{([^}]*)\}/g)].map((m) => [m[1], m[2].split(',').map(Number)]));
    const init = new Map([...ph.matchAll(/\{0x([0-9a-f]{8})u, "INIT", (\d+), (FPV_\d+)\}/g)].map((m) => [m[1], fpv.get(m[3])!]));
    for (const [name, def] of engines) {
      const e = entryOf(def);
      const want = init.get(e.structure);
      if (!want) throw new Error(`${tag}: ${name}'s structure ${e.structure} is not in its presets.h`);
      const vals = e.rows.map((r) => {
        const t = r[0].split('+')[0];
        const m = /^([^#]+)#(\d+)\.(.+)$/.exec(t)!;
        const mod = def.modules.find((x) => x.id === Number(m[2]))!;
        return toQ16(mod.params[m[3]] ?? DEFS[mod.type].params.find((p) => p.name === m[3])?.default ?? 0);
      });
      if (vals.length !== want.length || vals.some((v, i) => Math.abs(v - want[i]) > 1)) throw new Error(`${tag}: ${name}'s Init values in canonical order differ from its presets.h`);
      add(name, e, tag.replace(/^v/, ''));
    }
  }
  for (const [name, def] of todaysEngines()) add(name, entryOf(def));
  return out;
}

const args = process.argv.slice(2);
let lineage: Lineage, migrations: Record<string, Migration>, steps: ReturnType<typeof migrationsOf>['steps'], problems: Problem[];
if (args[0] === '--seed') {
  lineage = seed(args.slice(1));
  writeFileSync(LINEAGE_FILE, lineageText(lineage));
  ({ migrations, steps, problems } = migrationsOf(lineage));
  writeFileSync(MIGRATIONS_FILE, migrationsText(migrations));
} else ({ lineage, migrations, steps, problems } = updateLineage());
if (args.includes('--report') || args[0] === '--seed') for (const s of steps) {
  const list = lineage.engines[s.engine];
  const a = list.find((e) => e.structure === s.from)!, b = list.find((e) => e.structure === s.to)!;
  console.log(`\n${s.engine} ${s.from}${a.since ? ` (${a.since})` : ''} -> ${s.to}${b.since ? ` (${b.since})` : ''}: ${s.step.how}${s.step.why ? `, ${s.step.why}` : ''}`);
  if (s.step.how === 'none') continue;
  s.step.ops.forEach((op, k) => {
    const to = `${b.rows[k][0]} "${b.rows[k][1]}"`;
    const from = op.k === 'copy' ? `${a.rows[op.i][0]} "${a.rows[op.i][1]}"` : op.k === 'init' ? 'Init' : `table of ${op.rows.map((i) => a.rows[i][0]).join(', ')}`;
    if (op.k !== 'copy' || a.rows[op.i][0] !== b.rows[k][0] || a.rows[op.i][1] !== b.rows[k][1]) console.log(`  ${to} <- ${from}`);
  });
  if (s.step.dropped.length) console.log(`  dropped: ${s.step.dropped.join(', ')}`);
}
console.log(`preset migrations: ${Object.keys(migrations).length} earlier structures move (${Object.values(migrations).map((m) => m.engine).filter((x, i, l) => l.indexOf(x) === i).join(', ')})`);
for (const p of problems) console.error(p.message);
if (problems.length) process.exit(1);
