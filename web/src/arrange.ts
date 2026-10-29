// SPDX-License-Identifier: GPL-3.0-only
// The arrangement of an assembly card's rows, as Arrange mode edits it (#186, D-616): columns of sections (a heading and
// its rows) cut into pages (one FM-1 page: up to PAGE_ROWS knob rows). The patch keeps the flat `ParamRef` list with
// layout flags, plus `AssemblyInst.heads` for headings with no rows; `layoutOf` reads that into this tree, the operations
// below edit the tree, and `flatten` writes it back. Rows are identified by module and parameter.
import type { AssemblyInst, EmptyHead, ParamRef } from './assembly';
import { PAGE_ROWS } from './pages';

/** a heading and its rows; `head` undefined: the rows before the first heading, or a column that goes on with the heading
 * before it (only ever a column's first section) */
export interface Sec { head?: string; rows: ParamRef[] }
export interface Col { secs: Sec[] }
export type Layout = Col[];

/** whether a row takes a knob (true), is a display (false), or is not drawn on the card at all (null: set from a module's
 * screen, or gone); a row not drawn starts no page and rides with the one before it */
export type KnobOf = (r: ParamRef) => boolean | null;

export const rowKey = (r: { module: number; param: string }): string => `${r.module}:${r.param}`;

/** a row's own fields: the place fields (column, heading) belong to the tree */
function bare(r: ParamRef): ParamRef {
  const { col: _c, head: _h, ...rest } = r;
  return rest;
}

export function layoutOf(params: readonly ParamRef[], heads: readonly EmptyHead[] = []): Layout {
  const cols: Col[] = [{ secs: [] }];
  let cur: Sec | null = null;
  let rows = 0;
  for (const r of params) {
    if (r.col && rows) { cols.push({ secs: [] }); cur = null; }
    const col = cols[cols.length - 1];
    if (r.head || !cur) { cur = r.head ? { head: r.head, rows: [] } : { rows: [] }; col.secs.push(cur); }
    cur.rows.push(bare(r));
    rows++;
  }
  // empty headings: before the section their row opens, or after the section their row ends (a column's last)
  const where = new Map<string, { col: Col; sec: Sec }>();
  for (const col of cols) for (const sec of col.secs) for (const r of sec.rows) where.set(rowKey(r), { col, sec });
  const before = new Map<Sec, string[]>();
  const after = new Map<Sec, string[]>();
  for (const h of heads) {
    const at = where.get(rowKey(h));
    if (!at) continue;
    const m = h.after ? after : before;
    m.set(at.sec, [...(m.get(at.sec) ?? []), h.head]);
  }
  for (const col of cols) {
    col.secs = col.secs.flatMap((sec) => [
      ...(before.get(sec) ?? []).map((head): Sec => ({ head, rows: [] })),
      sec,
      ...(after.get(sec) ?? []).map((head): Sec => ({ head, rows: [] })),
    ]);
  }
  return params.length ? cols : [];
}

/** the flat list and the empty headings of a layout (first rows of sections and columns lose their page flags: they start
 * a page anyway) */
export function flatten(layout: Layout): { params: ParamRef[]; heads: EmptyHead[] } {
  const params: ParamRef[] = [];
  const heads: EmptyHead[] = [];
  let carry: string[] = []; // empty headings of a column with no rows: they end the column before
  for (const col of layout) {
    let waiting: string[] = [];
    let first = true;
    for (const sec of col.secs) {
      if (!sec.rows.length) { if (sec.head !== undefined) waiting.push(sec.head); continue; }
      sec.rows.forEach((r, i) => {
        const n = bare(r);
        if (i === 0) {
          delete n.group;
          delete n.pin;
          if (sec.head !== undefined) n.head = sec.head;
        }
        if (first && params.length) n.col = true;
        if (first && carry.length) {
          const last = params[params.length - 1];
          for (const head of carry) heads.push({ head, module: last.module, param: last.param, after: true });
          carry = [];
        }
        if (i === 0) for (const head of waiting) heads.push({ head, module: n.module, param: n.param });
        if (i === 0) waiting = [];
        first = false;
        params.push(n);
      });
    }
    if (waiting.length) {
      if (first) carry.push(...waiting);
      else {
        const last = params[params.length - 1];
        for (const head of waiting) heads.push({ head, module: last.module, param: last.param, after: true });
      }
    }
  }
  if (carry.length && params.length) {
    const last = params[params.length - 1];
    for (const head of carry) heads.push({ head, module: last.module, param: last.param, after: true });
  }
  // the first row of the card starts nothing
  if (params[0]) { delete params[0].group; delete params[0].pin; }
  return { params, heads };
}

/** write a layout back to the card: its rows and its headings with no rows */
export function setLayout(a: AssemblyInst, layout: Layout): void {
  const f = flatten(layout);
  a.params = f.params;
  if (f.heads.length) a.heads = f.heads;
  else delete a.heads;
}

/** a section's pages: one starts at its first row, at a page flag (`group` set by hand, `pin` kept), at each copy of a run
 * shown one at a time and after it (assembly.ts copyStarts), or when the page already has PAGE_ROWS knob rows; a row not
 * drawn rides with the page before it */
export function pagesOf(sec: Sec, knob: KnobOf): ParamRef[][] {
  const out: ParamRef[][] = [];
  let cur: ParamRef[] | null = null;
  let n = 0;
  let left = 0, size = 1, at = 0, ended = false;   // a run of copies: rows left in it, rows per copy, the row's place in it
  sec.rows.forEach((r, i) => {
    if (r.copies && !left && i + r.copies.rows * r.copies.count <= sec.rows.length && !sec.rows.slice(i + 1, i + r.copies.rows * r.copies.count).some((x) => x.copies)) {
      left = r.copies.rows * r.copies.count;
      size = r.copies.rows;
      at = 0;
    }
    const copy = (left > 0 && at % size === 0) || ended;
    const k = knob(r);
    if (k !== null && (!cur || r.group || r.pin || copy || n >= PAGE_ROWS)) { cur = []; out.push(cur); n = 0; }
    if (!cur) { cur = []; out.push(cur); }
    cur.push(r);
    if (k) n++;
    ended = false;
    if (left) {
      at++;
      left--;
      ended = left === 0;
    }
  });
  return out;
}

/** every page start that is not a section's first row gets a flag, so moving rows never reflows the pages around them */
export function pinPages(layout: Layout, knob: KnobOf): void {
  for (const col of layout) for (const sec of col.secs) for (const pg of pagesOf(sec, knob).slice(1)) if (!pg[0].group) pg[0].pin = true;
}

/** a landing place for rows or pages: in `sec`, before the row `before` or after the row `after` (neither: at its end);
 * `start` takes over the page flag of the row it goes before (the rows open that page) */
export interface RowSpot { sec: Sec; before?: string; after?: string; start?: boolean }

/** move rows (their keys, in card order) to a spot; as a page (`page`) they start a page of their own there */
export function moveRows(layout: Layout, keys: readonly string[], to: RowSpot, knob: KnobOf, page = false): void {
  pinPages(layout, knob);
  const set = new Set(keys);
  const moving: ParamRef[] = [];
  let pageFlag: 'group' | 'pin' = 'pin';
  for (const col of layout) for (const sec of col.secs) {
    sec.rows.forEach((r, i) => {
      if (!set.has(rowKey(r))) return;
      if (!moving.length && r.group) pageFlag = 'group';
      // a row that starts a page hands that start to the next row that stays
      if (r.group || r.pin) {
        const next = sec.rows.slice(i + 1).find((x) => !set.has(rowKey(x)));
        if (next && !next.group && !next.pin) next[r.group ? 'group' : 'pin'] = true;
      }
    });
    for (const r of sec.rows) if (set.has(rowKey(r))) moving.push(r);
    sec.rows = sec.rows.filter((r) => !set.has(rowKey(r)));
  }
  if (!moving.length) return;
  for (const r of moving) { delete r.group; delete r.pin; }
  const rows = to.sec.rows;
  const at = to.after !== undefined ? rows.findIndex((r) => rowKey(r) === to.after) + 1
    : to.before !== undefined ? rows.findIndex((r) => rowKey(r) === to.before) : rows.length;
  const where = at < 0 ? rows.length : at;
  const target = to.before !== undefined ? rows[where] : undefined;
  if (to.start && target && (target.group || target.pin)) {
    moving[0][target.group ? 'group' : 'pin'] = true;
    delete target.group;
    delete target.pin;
  }
  rows.splice(where, 0, ...moving);
  if (page) {
    if (where > 0) moving[0][pageFlag] = true;
    const next = rows[where + moving.length];
    if (next && !next.group && !next.pin) next.pin = true;
  }
  normalize(layout);
}

/** a landing place for a section: in column `col` (an index), before the section `before` (none: at the column's end) */
export interface SecSpot { col: number; before?: Sec }

export function moveSection(layout: Layout, sec: Sec, to: SecSpot): void {
  const from = layout.find((c) => c.secs.includes(sec));
  const into = layout[to.col];
  if (!from || !into || sec.head === undefined) return;
  from.secs = from.secs.filter((s) => s !== sec);
  const at = to.before ? into.secs.indexOf(to.before) : -1;
  into.secs.splice(at < 0 ? into.secs.length : at, 0, sec);
  normalize(layout);
}

/** a new heading with no rows in column `col` at section index `at` */
export function addHeading(layout: Layout, col: number, at: number, head: string): Sec {
  const sec: Sec = { head, rows: [] };
  layout[col]?.secs.splice(at, 0, sec);
  return sec;
}

/** take a heading off: with no rows it goes; its rows join the section above in the column (starting a page there), or
 * stay where they are with no heading of their own when it is the column's first */
export function removeHeading(layout: Layout, sec: Sec): void {
  const col = layout.find((c) => c.secs.includes(sec));
  if (!col) return;
  const i = col.secs.indexOf(sec);
  if (!sec.rows.length) col.secs.splice(i, 1);
  else if (i > 0) {
    const above = col.secs[i - 1];
    if (above.rows.length) sec.rows[0].pin = true;
    above.rows.push(...sec.rows);
    col.secs.splice(i, 1);
  } else delete sec.head;
  normalize(layout);
}

/** rename a heading; an empty name takes it off */
export function renameHeading(layout: Layout, sec: Sec, text: string): void {
  const t = text.trim();
  if (!t) return removeHeading(layout, sec);
  sec.head = t;
}

/** a page break by hand before `key` (a row that is not its section's first): the pages after it stay as they are */
export function addBreak(layout: Layout, key: string, knob: KnobOf): void {
  pinPages(layout, knob);
  for (const col of layout) for (const sec of col.secs) sec.rows.forEach((r, i) => {
    if (i > 0 && rowKey(r) === key) { r.group = true; delete r.pin; }
  });
}

/** take off a page break set by hand: the two pages join (rows past PAGE_ROWS knobs start a page again) */
export function removeBreak(layout: Layout, key: string): void {
  for (const col of layout) for (const sec of col.secs) for (const r of sec.rows) if (rowKey(r) === key) { delete r.group; delete r.pin; }
}

/** take rows off the card; their headings stay, empty */
export function removeRows(layout: Layout, keys: readonly string[], knob: KnobOf): void {
  pinPages(layout, knob);
  moveRows(layout, keys, { sec: { rows: [] } }, knob);
}

/** a section with no heading after the first of its column joins the section above; rowless ones without a heading go */
function normalize(layout: Layout): void {
  for (const col of layout) {
    const out: Sec[] = [];
    for (const sec of col.secs) {
      if (sec.head === undefined && !sec.rows.length) continue;
      const above = out[out.length - 1];
      if (sec.head === undefined && above) {
        if (above.rows.length && !sec.rows[0].group) sec.rows[0].pin = true;
        above.rows.push(...sec.rows);
      } else out.push(sec);
    }
    col.secs = out;
  }
}

/** the FM-1's name for a heading's pages: the heading in capitals, cut to `max`, or PAGE with none */
export const fm1Name = (head: string | undefined, max: number): string => (head?.trim() ? head.trim().slice(0, max).toUpperCase() : 'PAGE');
