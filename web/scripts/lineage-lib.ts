// SPDX-License-Identifier: GPL-3.0-only
// The factory engines' structure lineage (#627, D-865): every structure a factory engine has had, with its card rows in
// canonical row order (src/preset-lineage.json), and from it the table that moves user presets of an earlier structure to
// today's (src/preset-migrations.json, src/preset-migrate.ts). Used by scripts/preset-lineage.ts (and gen-assemblies.ts,
// which records a changed structure as it writes the assemblies), export-defs.ts (the FM-1's copy in presets.h) and the
// tests.
//
// How rows are matched from one structure to the next (an automatic map): a module is known by its type and its card rows
// (each row's parameter and label). Modules alike in that are paired in card order (the order the card shows them: voice
// 1 with voice 1; where one structure has more of a kind, the one of the same id first); a module left over is paired with the one of the same type and id (its rows were renamed). A row then
// maps to the row of the paired module with the same parameter. The map is automatic only when every earlier row finds
// its row: today's rows that have none are new and take the engine's Init value. Otherwise preset-maps.ts says what
// happens: a hand-written map (which earlier rows feed which of today's, through a table where the meaning changed), or
// none (the presets of that structure stay as they are).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rowTargets, validateAssemblyDef, type AssemblyDef } from '../src/assembly';
import { defIsEngine } from '../src/engines';
import { DEFS } from '../src/modules';
import { HAND_MAPS, type HandMap } from '../src/preset-maps';
import { cardSlug } from '../src/preset-cards';
import type { Migration, MigrationOp } from '../src/preset-migrate';
import { defStructureAndOrder } from '../src/structure';

/** a card row: its target(s) as type#id.param (joined by + for a row that sets several), its label, its place on the card */
export type LineageRow = [target: string, label: string, card: number];
export interface LineageEntry {
  structure: string;
  /** the first release that shipped it (from the tags), when known */
  since?: string;
  rows: LineageRow[];
}
export interface Lineage {
  about: string;
  /** by engine name: its structures, oldest first, today's last */
  engines: Record<string, LineageEntry[]>;
}

export const LINEAGE_ABOUT = 'Every structure each factory engine has had, oldest first, today\'s last; each card row as [type#id.param, label, place on the card], in canonical row order. Written by web/scripts/preset-lineage.ts (and gen-assemblies). Do not edit: hand-written maps go in web/src/preset-maps.ts.';

const SRC = new URL('../src/', import.meta.url);
export const LINEAGE_FILE = new URL('preset-lineage.json', SRC);
export const MIGRATIONS_FILE = new URL('preset-migrations.json', SRC);

export const readLineage = (): Lineage => existsSync(LINEAGE_FILE) ? JSON.parse(readFileSync(LINEAGE_FILE, 'utf8')) as Lineage : { about: LINEAGE_ABOUT, engines: {} };

/** a definition's structure and card rows, in canonical order */
export function entryOf(def: AssemblyDef): LineageEntry {
  const { structure, order } = defStructureAndOrder(def);
  const typeOf = new Map(def.modules.map((m) => [m.id, m.type]));
  const rows = order.map((i): LineageRow => {
    const r = def.params[i];
    return [rowTargets(r).map((t) => `${typeOf.get(t.module)}#${t.module}.${t.param}`).join('+'), r.label, i];
  });
  return { structure, rows };
}

/** a factory effect with a preset card (#661) ships presets too: its structures are kept as an engine's */
const CARD_DIR = new URL('../presets/cards/', import.meta.url);
const hasCard = (def: AssemblyDef): boolean => existsSync(new URL(`${cardSlug(def.name)}.txt`, CARD_DIR));

/** the factory engines (and effects with a card) of the assembly files in a directory (today's: src/assemblies), by name */
export function factoryEngines(files: { name: string; text: string }[]): Map<string, AssemblyDef> {
  const out = new Map<string, AssemblyDef>();
  for (const f of files.filter((x) => x.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const def = validateAssemblyDef(JSON.parse(f.text), DEFS);
    if (defIsEngine(def) || hasCard(def)) out.set(def.name, def);
  }
  return out;
}
export const todaysEngines = (): Map<string, AssemblyDef> => {
  const dir = new URL('assemblies/', SRC);
  return factoryEngines(readdirSync(dir).map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') })));
};

/** a step from one structure to the next: for each of the newer's rows, how it gets its value from the older's */
type StepOp = { k: 'copy'; i: number } | { k: 'init' } | { k: 'table'; rows: number[]; lo: number[]; n: number[]; v: number[] };
export interface Step { ops: StepOp[]; dropped: string[]; how: 'auto' | 'hand' | 'none'; why?: string }

const parseTarget = (t: string): { type: string; id: number; param: string } => {
  const m = /^([^#]+)#(\d+)\.(.+)$/.exec(t);
  if (!m) throw new Error(`a row target "${t}"`);
  return { type: m[1], id: Number(m[2]), param: m[3] };
};
/** a row's module (its first target's) and the parameters it sets, without module ids */
const rowParts = (r: LineageRow): { mod: string; type: string; id: number; params: string } => {
  const ts = r[0].split('+').map(parseTarget);
  return { mod: `${ts[0].type}#${ts[0].id}`, type: ts[0].type, id: ts[0].id, params: ts.map((t) => t.param).join('+') };
};

/** the automatic row matching: for each newer row, the older row it is (-1 none) */
export function matchRows(older: LineageRow[], newer: LineageRow[]): number[] {
  interface Mod { key: string; type: string; id: number; sig: string; card: number }
  const mods = (rows: LineageRow[]): Mod[] => {
    const by = new Map<string, { type: string; id: number; parts: string[]; card: number }>();
    for (const r of rows) {
      const p = rowParts(r);
      const m = by.get(p.mod) ?? { type: p.type, id: p.id, parts: [], card: Infinity };
      m.parts.push(`${p.params}:${r[1]}`);
      m.card = Math.min(m.card, r[2]);
      by.set(p.mod, m);
    }
    return [...by.entries()].map(([key, m]) => ({ key, type: m.type, id: m.id, sig: `${m.type}|${m.parts.sort().join('|')}`, card: m.card })).sort((a, b) => a.card - b.card);
  };
  const a = mods(older), b = mods(newer);
  const pair = new Map<string, string>();   // newer module -> older module
  const usedA = new Set<string>();
  // modules alike in type and card rows, in card order; where one structure has more of a kind than the other (a row
  // renamed into another's name), the one of the same id first
  const count = (l: Mod[], sig: string): number => l.filter((x) => x.sig === sig).length;
  for (const m of b) {
    if (count(a, m.sig) === count(b, m.sig)) continue;
    const o = a.find((x) => !usedA.has(x.key) && x.sig === m.sig && x.key === m.key);
    if (o) { pair.set(m.key, o.key); usedA.add(o.key); }
  }
  for (const m of b) {
    if (pair.has(m.key)) continue;
    const o = a.find((x) => !usedA.has(x.key) && x.sig === m.sig);
    if (o) { pair.set(m.key, o.key); usedA.add(o.key); }
  }
  // a module left over: the one of the same type and id (renamed rows)
  for (const m of b) {
    if (pair.has(m.key)) continue;
    const o = a.find((x) => !usedA.has(x.key) && x.key === m.key);
    if (o) { pair.set(m.key, o.key); usedA.add(o.key); }
  }
  const used = new Set<number>();
  return newer.map((r) => {
    const p = rowParts(r);
    const om = pair.get(p.mod);
    if (!om) return -1;
    const j = older.findIndex((x, k) => !used.has(k) && rowParts(x).mod === om && rowParts(x).params === p.params);
    if (j >= 0) used.add(j);
    return j;
  });
}

/** the step from one structure to the next: a hand-written map if preset-maps.ts has one, else the automatic one when it
 * keeps every earlier row; null when neither (a structure change with no decision yet) */
export function stepOf(engine: string, older: LineageEntry, newer: LineageEntry, hands: HandMap[] = HAND_MAPS): Step | null {
  const hand = hands.find((h) => h.engine === engine && h.from === older.structure && h.to === newer.structure);
  if (hand && 'none' in hand) return { ops: [], dropped: [], how: 'none', why: hand.none };
  const auto = matchRows(older.rows, newer.rows);
  const ops: StepOp[] = auto.map((i) => (i >= 0 ? { k: 'copy', i } : { k: 'init' }));
  if (hand) {
    const oldAt = (t: string): number => {
      const i = older.rows.findIndex((r) => r[0] === t);
      if (i < 0) throw new Error(`preset-maps.ts: ${engine} ${older.structure} has no row ${t}`);
      return i;
    };
    for (const [t, how] of Object.entries(hand.rows)) {
      const k = newer.rows.findIndex((r) => r[0] === t);
      if (k < 0) throw new Error(`preset-maps.ts: ${engine} ${newer.structure} has no row ${t}`);
      if (how === 'init') ops[k] = { k: 'init' };
      else if ('from' in how) ops[k] = { k: 'copy', i: oldAt(how.from) };
      else {
        const size = how.n.reduce((x, y) => x * y, 1);
        if (how.table.length !== how.lo.length || how.table.length !== how.n.length || how.v.length !== size || how.table.length > 2) throw new Error(`preset-maps.ts: ${engine} ${t}: a table's sizes`);
        ops[k] = { k: 'table', rows: how.table.map(oldAt), lo: how.lo, n: how.n, v: how.v };
      }
    }
  }
  const read = new Set<number>();
  for (const op of ops) if (op.k === 'copy') read.add(op.i); else if (op.k === 'table') op.rows.forEach((i) => read.add(i));
  const dropped = older.rows.filter((_, i) => !read.has(i)).map((r) => `${r[0]} "${r[1]}"`);
  if (!hand && dropped.length) return null;
  return { ops, dropped, how: hand ? 'hand' : 'auto', why: hand && 'why' in hand ? hand.why : undefined };
}

/** a step after another: the earlier rows each of the last structure's rows reads (null: a table over a row that is not
 * kept as it was, which no map needs yet) */
function compose(first: StepOp[], then: StepOp[]): StepOp[] | null {
  const out: StepOp[] = [];
  for (const op of then) {
    if (op.k === 'init') out.push(op);
    else if (op.k === 'copy') out.push(first[op.i]);
    else {
      const rows = op.rows.map((i) => first[i]);
      if (rows.some((r) => r.k !== 'copy')) return null;
      out.push({ ...op, rows: rows.map((r) => (r as { i: number }).i) });
    }
  }
  return out;
}

export interface Problem { engine: string; from: string; to: string; message: string }

/** the migrations of every earlier structure that moves, oldest first within each engine; and the structure changes no
 * map covers (each one fails the tests until preset-maps.ts has a map or a none for it) */
export function migrationsOf(lineage: Lineage, hands: HandMap[] = HAND_MAPS): { migrations: Record<string, Migration>; steps: { engine: string; from: string; to: string; step: Step }[]; problems: Problem[] } {
  const migrations: Record<string, Migration> = {};
  const steps: { engine: string; from: string; to: string; step: Step }[] = [];
  const problems: Problem[] = [];
  for (const [engine, list] of Object.entries(lineage.engines).sort(([a], [b]) => a.localeCompare(b))) {
    const st: (Step | null)[] = [];
    for (let i = 0; i + 1 < list.length; i++) {
      const s = stepOf(engine, list[i], list[i + 1], hands);
      st.push(s);
      if (s) steps.push({ engine, from: list[i].structure, to: list[i + 1].structure, step: s });
      else problems.push({ engine, from: list[i].structure, to: list[i + 1].structure, message: `${engine}: its structure ${list[i].structure} became ${list[i + 1].structure} and ${list[i].rows.length - matchRows(list[i].rows, list[i + 1].rows).filter((x) => x >= 0).length} of its rows have no row in the new one: write a map or a none in web/src/preset-maps.ts` });
    }
    const today = list[list.length - 1];
    for (let i = 0; i + 1 < list.length; i++) {
      let ops: StepOp[] | null = null;
      for (let j = i; j + 1 < list.length; j++) {
        const s = st[j];
        if (!s || s.how === 'none') { ops = null; break; }
        ops = ops ? compose(ops, s.ops) : s.ops;
        if (!ops) { problems.push({ engine, from: list[i].structure, to: today.structure, message: `${engine}: a table in the map from ${list[j].structure} reads a row that ${list[i].structure} does not keep as it was` }); break; }
      }
      if (!ops) continue;
      if (migrations[list[i].structure]) throw new Error(`the structure ${list[i].structure} is in two engines' lineage`);
      migrations[list[i].structure] = {
        engine, to: today.structure, n: list[i].rows.length,
        rows: ops.map((op): MigrationOp => (op.k === 'copy' ? op.i : op.k === 'init' ? -1 : { rows: op.rows, lo: op.lo, n: op.n, v: op.v })),
      };
    }
  }
  return { migrations, steps, problems };
}

/** today's lineage: each factory engine's structure today added as its newest entry where it changed (an entry that no
 * release shipped, `released` false, is replaced rather than kept); an engine new today starts one */
export function recordToday(lineage: Lineage, engines: Map<string, AssemblyDef>, released: (structure: string) => boolean): { lineage: Lineage; changed: string[] } {
  const out: Lineage = { about: LINEAGE_ABOUT, engines: { ...lineage.engines } };
  const changed: string[] = [];
  for (const [name, def] of engines) {
    const now = entryOf(def);
    const list = [...(out.engines[name] ?? [])];
    const head = list[list.length - 1];
    if (head && head.structure === now.structure && JSON.stringify(head.rows) === JSON.stringify(now.rows)) continue;
    if (head && head.structure !== now.structure && !head.since && !released(head.structure)) list.pop();   // (never shipped)
    let since: string | undefined;
    if (list.length && list[list.length - 1].structure === now.structure) since = list.pop()!.since;   // (the same structure: its labels, ids or card places moved, or an unshipped change undone)
    list.push(since ? { ...now, since } : now);
    out.engines[name] = list;
    changed.push(name);
  }
  return { lineage: out, changed };
}

/** the lineage as its file holds it: one row a line */
export function lineageText(l: Lineage): string {
  const eng = Object.entries(l.engines).sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => `    ${JSON.stringify(name)}: [\n${list.map((e) => `      {"structure": ${JSON.stringify(e.structure)}, ${e.since ? `"since": ${JSON.stringify(e.since)}, ` : ''}"rows": [\n${e.rows.map((r) => `        ${JSON.stringify(r)}`).join(',\n')}\n      ]}`).join(',\n')}\n    ]`);
  return `{\n  "about": ${JSON.stringify(l.about)},\n  "engines": {\n${eng.join(',\n')}\n  }\n}\n`;
}
export const migrationsText = (m: Record<string, Migration>): string =>
  `{\n${Object.entries(m).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`;

const ROOT = new URL('../../', import.meta.url).pathname;
const git = (...a: string[]): string => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });

/** a structure some release tag's firmware has factory presets for (so user presets of it may exist); without git or
 * the tags, every one */
export function releasedCheck(): (structure: string) => boolean {
  let tags: string[] = [];
  try { tags = git('tag', '-l', 'v*').split('\n').filter(Boolean); } catch { return () => true; }
  if (!tags.length) return () => true;   // (a checkout without the tags: keep every one)
  const seen = new Map<string, boolean>();
  return (s) => {
    if (!seen.has(s)) {
      let hit = false;
      try { hit = git('grep', '-l', '-F', `{0x${s}u, "`, ...tags, '--', 'firmware/src/presets.h').trim() !== ''; } catch { hit = false; }
      seen.set(s, hit);
    }
    return seen.get(s)!;
  };
}

/** record today's structures in the lineage file and write the migrations (gen-assemblies, preset-lineage.ts) */
export function updateLineage(): { lineage: Lineage; changed: string[] } & ReturnType<typeof migrationsOf> {
  const { lineage, changed } = recordToday(readLineage(), todaysEngines(), releasedCheck());
  writeFileSync(LINEAGE_FILE, lineageText(lineage));
  const m = migrationsOf(lineage);
  writeFileSync(MIGRATIONS_FILE, migrationsText(m.migrations));
  return { lineage, changed, ...m };
}
