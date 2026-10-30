// SPDX-License-Identifier: GPL-3.0-only
// Preset cards (#413): a factory engine's presets written by hand as a text file, web/presets/cards/<slug>.txt (the slug is
// the engine's name in lower case, runs of other characters as "-": "Hera 6" is hera-6.txt). factory-presets.ts reads
// them: an engine with a card ships Init plus the card's presets, in the card's order, in the browser and in the FM-1's
// ROM (export-defs); an engine without one keeps the rule-made variations. The file:
//
//   engine: Hera 6                 the engine's name, once, before the first preset
//   preset: Brass                  starts a preset (its name, up to PRESET_NAME_MAX characters; the FM-1 shows 16)
//     filters / cutoff = 1800 Hz   a row's value: "section / label = value"; the label alone when it is the only one
//     dco / wave = saw             a choice row takes the choice's name (a Selector row its named position's, or its
//                                  number); a switch takes on or off
//     env / a = 0.05 s             a number is in the row's unit (the unit may be left out), snapped to the row's step
//   # a comment                    comments and blank lines go anywhere
//
// A row not listed keeps Init's value. A section that lists a label twice (two envelopes in one section) numbers them:
// "envelopes / a (1)", "envelopes / a (2)". A screen row (an envelope's shape, a scope) is not a value and cannot be set.
// The parser reports every mistake with its line; a card with a mistake is not used (factory-presets.ts falls back to the
// rules and warns). The reverse, a preset as a block of text, serves `npm run presets -- show` and the library import.
import type { AssemblyDef } from './assembly';
import { PRESET_NAME_MAX, type Preset } from './device-presets';
import { DEFS, selectCount } from './modules';
import type { ParamDef } from './patch';
import { defStructureAndOrder } from './structure';

/** a card row as the text form sees it */
export interface CardRow {
  /** its index in the definition's rows (AssemblyDef.params) */
  i: number;
  /** the heading it sits under on the card ("" before the first heading) */
  section: string;
  label: string;
  /** how the text form names it: "section / label", numbered when the section repeats the label */
  key: string;
  type: string;
  param: string;
  /** the parameter; undefined for a screen row, which is not a value */
  pd?: ParamDef;
  /** the value Init has */
  init: number;
  /** a Selector row's position names (#358), position 1 first, as many as the Selector has positions */
  names?: string[];
  /** a Selector row's number of positions (its `count`): the row's range is 1..this */
  positions?: number;
}

/** the card file's name for an engine: its name in lower case, runs of other characters as "-" */
export const cardSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** an engine's rows in card order (the order the card shows them, headings included) */
export function cardRows(def: AssemblyDef): CardRow[] {
  let section = '';
  const rows: CardRow[] = def.params.map((r, i) => {
    if (r.head) section = r.head;
    const m = def.modules.find((x) => x.id === r.module)!;
    const pd = DEFS[m.type]?.params.find((d) => d.name === r.param);
    const positions = m.type === 'select' && r.param === 'pos' ? selectCount(m.params) : undefined;
    const names = r.names && positions ? r.names.slice(0, positions) : undefined;
    return { i, section, label: r.label, key: '', type: m.type, param: r.param, pd: pd && !pd.screen ? pd : undefined, init: m.params[r.param] ?? pd?.default ?? 0, ...(names ? { names } : {}), ...(positions ? { positions } : {}) };
  });
  const count = new Map<string, number>();
  for (const r of rows) count.set(`${r.section}/${r.label}`, (count.get(`${r.section}/${r.label}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.section}/${r.label}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const label = count.get(k)! > 1 ? `${r.label} (${n})` : r.label;
    r.key = r.section ? `${r.section} / ${label}` : label;
  }
  return rows;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** the rows by every name the text form accepts: the key, and the label alone when no other row has it */
function rowIndex(rows: CardRow[]): Map<string, CardRow> {
  const out = new Map<string, CardRow>();
  for (const r of rows) out.set(norm(r.key), r);
  const byLabel = new Map<string, CardRow[]>();
  for (const r of rows) byLabel.set(norm(r.label), [...(byLabel.get(norm(r.label)) ?? []), r]);
  for (const [label, list] of byLabel) if (list.length === 1 && !out.has(label)) out.set(label, list[0]);
  return out;
}

/** a number as the text form writes it: at most four decimals, no trailing zeros */
const num = (v: number): string => String(+v.toFixed(4));

/** a row's value as text: the choice's name, on / off, or the number with its unit */
export function formatValue(r: CardRow, v: number): string {
  const pd = r.pd;
  if (!pd) return num(v);
  if (pd.toggle) return v ? 'on' : 'off';
  if (r.names && Number.isInteger(v) && r.names[v - pd.min]) return r.names[v - pd.min];
  if (pd.choices && Number.isInteger(v) && v >= 0 && v < pd.choices.length) return pd.choices[v];
  return pd.unit ? `${num(v)} ${pd.unit}` : num(v);
}

/** a row's value from text: the number (or choice, or switch) or why it is not one */
export function parseValue(r: CardRow, text: string): { value: number } | { error: string } {
  const pd = r.pd;
  if (!pd) return { error: `${r.key} is a screen, not a value` };
  const t = norm(text);
  const lo = pd.min;
  const hi = r.positions ?? pd.top ?? pd.max;
  if (pd.toggle && (t === 'on' || t === 'off')) return { value: t === 'on' ? 1 : 0 };
  if (r.names) {
    const k = r.names.findIndex((c) => norm(c) === t);
    if (k >= 0) return { value: pd.min + k };
  }
  if (pd.choices) {
    const k = pd.choices.findIndex((c) => norm(c) === t);
    if (k >= 0) return k <= hi ? { value: k } : { error: `${r.key}: ${pd.choices[k]} is past the FM-1's range` };
  }
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([^\d\s].*)?$/.exec(t);
  if (!m) {
    const choices = pd.toggle ? 'on or off' : r.names ? r.names.join(', ') : pd.choices ? pd.choices.join(', ') : `a number${pd.unit ? ` in ${pd.unit}` : ''}`;
    return { error: `${r.key}: "${text.trim()}" is not a value (${choices})` };
  }
  let v = Number(m[1]);
  if (m[2] && (!pd.unit || norm(pd.unit) !== m[2])) return { error: `${r.key}: ${pd.unit ? `the unit is ${pd.unit}` : 'the row has no unit'}, not "${m[2]}"` };
  if (v < lo || v > hi) return { error: `${r.key}: ${m[1]} is outside ${num(lo)}..${num(hi)}${pd.unit ? ` ${pd.unit}` : ''}` };
  if (pd.step && !pd.choices) v = +(Math.round((v - lo) / pd.step) * pd.step + lo).toFixed(6);
  return { value: Math.min(hi, Math.max(lo, v)) };
}

/** the rows' values Init has, in the preset's (canonical) order, and where each row's value sits in it */
function initValues(def: AssemblyDef, rows: CardRow[]): { structure: string; values: number[]; pos: Map<number, number> } {
  const { structure, order } = defStructureAndOrder(def);
  const pos = new Map(order.map((i, k) => [i, k]));
  return { structure, values: order.map((i) => rows[i].init), pos };
}

export interface CardParse {
  /** the engine named by the file; undefined when the file names none */
  engine?: string;
  /** Init first, then the file's presets in its order; empty when there are errors */
  presets: Preset[];
  errors: string[];
}

/** the presets a card file holds for an engine. Init is included first. Any mistake is reported with its line and leaves
 * the list empty: a card is used whole or not at all. */
export function parseCard(text: string, def: AssemblyDef): CardParse {
  const rows = cardRows(def);
  const index = rowIndex(rows);
  const { structure, values: init, pos } = initValues(def, rows);
  const errors: string[] = [];
  const presets: Preset[] = [{ structure, name: 'Init', values: init.slice(), factory: true }];
  let engine: string | undefined;
  let cur: { name: string; values: number[]; set: Set<number>; line: number; bad: boolean } | undefined;
  const names = new Set<string>(['init']);
  const close = (): void => {
    if (cur && !cur.bad && cur.set.size === 0) errors.push(`line ${cur.line}: "${cur.name}" changes nothing against Init`);
    if (cur) presets.push({ structure, name: cur.name, values: cur.values, factory: true });
    cur = undefined;
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, k) => {
    const n = k + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    let m = /^engine\s*:\s*(.+)$/i.exec(line);
    if (m) {
      if (engine !== undefined) errors.push(`line ${n}: the engine is named twice`);
      engine = m[1].trim();
      if (norm(engine) !== norm(def.name)) errors.push(`line ${n}: the file names "${engine}", the card is ${def.name}'s`);
      return;
    }
    m = /^preset\s*:\s*(.*)$/i.exec(line);
    if (m) {
      close();
      const name = m[1].trim();
      const was = errors.length;
      if (!name) errors.push(`line ${n}: a preset needs a name`);
      else if (name.length > PRESET_NAME_MAX) errors.push(`line ${n}: "${name}" is longer than ${PRESET_NAME_MAX} characters`);
      else if (names.has(norm(name))) errors.push(`line ${n}: "${name}" is named twice${norm(name) === 'init' ? ' (Init is the engine as it ships)' : ''}`);
      names.add(norm(name));
      cur = { name, values: init.slice(), set: new Set(), line: n, bad: errors.length > was };
      return;
    }
    m = /^(.+?)\s*=\s*(.+)$/.exec(line);
    if (!m) {
      errors.push(`line ${n}: not a row ("section / label = value"), a preset or the engine`);
      return;
    }
    if (!cur) {
      errors.push(`line ${n}: a row before the first "preset:"`);
      return;
    }
    const row = index.get(norm(m[1]));
    if (!row) {
      errors.push(`line ${n}: no row "${m[1].trim()}" on ${def.name}'s card`);
      return;
    }
    const v = parseValue(row, m[2]);
    if ('error' in v) {
      errors.push(`line ${n}: ${v.error}`);
      return;
    }
    const at = pos.get(row.i)!;
    if (cur.set.has(at)) errors.push(`line ${n}: ${row.key} is set twice in "${cur.name}"`);
    cur.set.add(at);
    if (Math.abs(v.value - init[at]) > 1e-9) cur.values[at] = v.value;
    else cur.set.delete(at);
  });
  close();
  if (engine === undefined) errors.push('the file names no engine ("engine: <name>" before the first preset)');
  if (presets.length < 2 && !errors.length) errors.push('the file holds no preset');
  return { engine, presets: errors.length ? [] : presets, errors };
}

/** a preset as a block of text: its name, then every row whose value differs from Init, in card order */
export function formatPreset(def: AssemblyDef, name: string, values: number[]): string {
  const rows = cardRows(def);
  const index = rowIndex(rows);
  const { values: init, pos } = initValues(def, rows);
  const out = [`preset: ${name}`];
  for (const r of rows) {
    const at = pos.get(r.i)!;
    const v = values[at] ?? init[at];
    if (!r.pd || Math.abs(v - init[at]) <= 1e-9) continue;
    // the label alone when it names only this row
    const key = index.get(norm(r.label)) === r ? r.label : r.key;
    out.push(`  ${key} = ${formatValue(r, v)}`);
  }
  return out.join('\n');
}

/** a whole card file for an engine's presets (Init is left out: it is the engine itself) */
export const formatCard = (def: AssemblyDef, presets: Preset[]): string =>
  [`engine: ${def.name}`, '', ...presets.filter((p) => p.name !== 'Init').map((p) => formatPreset(def, p.name, p.values))].join('\n\n').replace(/\n\n\n/g, '\n\n') + '\n';

/** a new card for an engine: the rules of the file, then every row with Init's value and its range, as comments */
export function cardTemplate(def: AssemblyDef): string {
  const rows = cardRows(def);
  const index = rowIndex(rows);
  const out = [
    `# ${def.name}: its factory presets, one block per preset (web/src/preset-cards.ts; npm run presets -- check).`,
    `# "preset: NAME" starts one (up to ${PRESET_NAME_MAX} characters; the FM-1 shows 16). Under it, one row per line: "row = value".`,
    '# A row not listed keeps Init\'s value. A row is "section / label", or the label alone when no other row has it.',
    '# A number is in the row\'s unit; a choice row takes a name; a switch takes on or off. Init and the ranges:',
    '#',
  ];
  let section: string | undefined;
  for (const r of rows) {
    if (r.section !== section) {
      section = r.section;
      out.push(`# ${section || '(no heading)'}`);
    }
    const key = index.get(norm(r.label)) === r ? r.label : r.key;
    if (!r.pd) {
      out.push(`#   ${key}: a screen, not a value`);
      continue;
    }
    const pd = r.pd;
    const range = pd.toggle ? 'off, on' : r.names ? r.names.join(', ') : pd.choices ? pd.choices.slice(0, (pd.top ?? pd.max) + 1).join(', ') : `${num(pd.min)}..${num(r.positions ?? pd.top ?? pd.max)}${pd.unit ? ` ${pd.unit}` : ''}`;
    out.push(`#   ${`${key} = ${formatValue(r, r.init)}`.padEnd(34)} ${range}`);
  }
  out.push('', `engine: ${def.name}`, '');
  return out.join('\n');
}

/** the rows of one engine's presets carried onto another engine that has the same rows under the same names and more
 * (an XL's engine built around its FM-1 version's card): a row is matched by its key and its parameter; the target's
 * other rows keep Init's values. Null when a preset sets a row the target has not (the XLs that are their originals'
 * whole panels name and build their rows differently, so their presets stay rule-made). */
export function projectPresets(from: AssemblyDef, presets: Preset[], to: AssemblyDef): Preset[] | null {
  const src = cardRows(from);
  const dst = cardRows(to);
  const { values: srcInit, pos: srcPos } = initValues(from, src);
  const { structure, values: dstInit, pos: dstPos } = initValues(to, dst);
  const target = new Map<string, CardRow>();
  for (const r of dst) target.set(`${norm(r.key)}|${r.type}.${r.param}`, r);
  const out: Preset[] = [];
  for (const p of presets) {
    const values = dstInit.slice();
    for (const r of src) {
      const v = p.values[srcPos.get(r.i)!];
      if (Math.abs(v - srcInit[srcPos.get(r.i)!]) <= 1e-9) continue;
      const t = target.get(`${norm(r.key)}|${r.type}.${r.param}`);
      if (!t) return null;
      values[dstPos.get(t.i)!] = v;
    }
    out.push({ structure, name: p.name, values, factory: true });
  }
  return out;
}
