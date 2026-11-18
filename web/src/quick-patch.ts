// SPDX-License-Identifier: GPL-3.0-only
// Quick patch (#1091): build a patch from the keyboard, without aiming at jacks or panning. This file is the part without a
// screen: what a card offers as ports and which one Enter takes, the search for modules, the typed chain
// (`lfo.out > multimode.cv; multimode.lp > vca.in > output.in`), following cables, blueprints and where a new card goes.
// quick-patch-view.ts draws the field and the ring and drives the editor with these.
import { allModules, assembliesOf, assemblyById, assemblyOf, cardWidth, findRef, insertAssembly, overlaps, paramColumns, parentOf, targetsOf, tiedTo, type AssemblyDef, type Rect } from './assembly';
import { score } from './fuzzy';
import { keyRouteError } from './key-routing';
import { longName, moduleKeywords, moduleTitle } from './labels';
import { moduleRows } from './pages';
import { connectParameter, isPin, parameterInputs } from './parameter-routing';
import { addModule, connect, sameEnd, type Cable, type Endpoint, type ModuleDef, type ParamDef, type Patch, type SignalKind } from './patch';

/** a card on the canvas: a module's, or a collapsed assembly's */
export type Card = { kind: 'module' | 'assembly'; id: number };
export const sameCard = (a: Card | null | undefined, b: Card | null | undefined): boolean => !!a && !!b && a.kind === b.kind && a.id === b.id;
export const cardKey = (c: Card): string => `${c.kind[0]}${c.id}`;

/** a port a card offers: a jack, or a parameter's thumb (a cable dropped on it routes to the parameter) */
export interface QPort {
  dir: 'in' | 'out';
  /** what is typed to pick it: the port's or parameter's short name (`cv`, `lp24`, `cutoff`), an assembly card's label */
  name: string;
  /** what the ring shows */
  label: string;
  kind: SignalKind;
  /** the inner ends it stands for: one, or an assembly's merged jack's several (none for a thumb) */
  ends: Endpoint[];
  /** a thumb: the parameter a cable dropped on it reaches */
  param?: Endpoint & { param: string };
  /** a jack that is a parameter's dedicated input (the Multimode's cv sets cutoff): the parameters it moves */
  drives?: string[];
}

/** the card a module shows on: itself, or the outermost collapsed assembly that hides it */
export function cardOf(p: Patch, module: number): Card {
  let hidden: number | undefined;
  for (let a = assemblyOf(p, module); a; a = parentOf(p, a.id)) if (!a.open) hidden = a.id;
  return hidden !== undefined ? { kind: 'assembly', id: hidden } : { kind: 'module', id: module };
}

/** whether a card is still in the patch (an undo can take it away) */
export const cardExists = (p: Patch, c: Card): boolean =>
  c.kind === 'module' ? p.modules.some((m) => m.id === c.id) : !!assemblyById(p, c.id);

/** a card's name as the canvas shows it */
export function cardTitle(p: Patch, defs: Record<string, ModuleDef>, c: Card): string {
  if (c.kind === 'assembly') {
    const a = assemblyById(p, c.id);
    return a ? a.label || a.name : '?';
  }
  const m = p.modules.find((x) => x.id === c.id);
  return m ? moduleTitle(m, defs[m.type]?.label ?? m.type) : '?';
}

/** a parameter row takes a cable (editor.ts paramRow: its thumb, switch or selector is a jack) */
const takesCable = (def: ModuleDef, pd: ParamDef, routed: boolean): boolean =>
  !pd.screen && !pd.fixed && !(def.type === 'fm1' && pd.name === 'tempo') && (!!def.paramInputs || !!pd.input || routed);

/** the parameters a jack sets: its dedicated parameter, and that parameter's amount (`cv` → cutoff and `cvamt`) */
const drivenBy = (def: ModuleDef, port: string): string[] => {
  const own = def.params.filter((pd) => pd.input === port).map((pd) => pd.name);
  return own.length && def.params.some((pd) => pd.name === `${port}amt`) ? [...own, `${port}amt`] : own;
};

/** the ports a card offers, in the card's order: outputs, then its jacks in, then the thumbs of the rows that take a cable */
export function cardPorts(p: Patch, defs: Record<string, ModuleDef>, c: Card): QPort[] {
  if (c.kind === 'module') {
    const m = p.modules.find((x) => x.id === c.id);
    const def = m && defs[m.type];
    if (!m || !def) return [];
    const end = (port: string): Endpoint[] => [{ module: m.id, port }];
    return [
      ...def.outputs.map((o): QPort => ({ dir: 'out', name: o.name, label: longName(m.type, o.name), kind: o.kind, ends: end(o.name) })),
      ...def.inputs.filter((i) => !isPin(i.name)).map((i): QPort => {
        const drives = drivenBy(def, i.name);
        return { dir: 'in', name: i.name, label: longName(m.type, i.name), kind: i.kind, ends: end(i.name), ...(drives.length ? { drives } : {}) };
      }),
      ...moduleRows(def).filter((pd) => takesCable(def, pd, parameterInputs(m, pd).length > 0))
        .map((pd): QPort => ({ dir: 'in', name: pd.name, label: longName(m.type, pd.name), kind: 'control', ends: [], param: { module: m.id, port: '', param: pd.name } })),
    ];
  }
  const a = assemblyById(p, c.id);
  if (!a) return [];
  const kindOf = (e: Endpoint, dir: 'in' | 'out'): SignalKind => {
    const m = p.modules.find((x) => x.id === e.module);
    const def = m && defs[m.type];
    return (dir === 'in' ? def?.inputs : def?.outputs)?.find((q) => q.name === e.port)?.kind ?? 'control';
  };
  const jack = (dir: 'in' | 'out') => (r: { module: number; port: string; label: string; also?: Endpoint[] }): QPort => {
    const m = p.modules.find((x) => x.id === r.module);
    const drives = dir === 'in' && m ? drivenBy(defs[m.type], r.port) : [];
    return { dir, name: r.label, label: r.label, kind: kindOf(r, dir), ends: targetsOf(r), ...(drives.length ? { drives } : {}) };
  };
  return [
    ...a.outputs.map(jack('out')),
    ...a.inputs.map(jack('in')),
    ...a.params.flatMap((r): QPort[] => {
      const m = p.modules.find((x) => x.id === r.module);
      const def = m && defs[m.type];
      const pd = def?.params.find((q) => q.name === r.param);
      return m && def && pd && takesCable(def, pd, parameterInputs(m, pd).length > 0)
        ? [{ dir: 'in', name: r.label, label: r.label, kind: 'control', ends: [], param: { module: m.id, port: '', param: pd.name } }] : [];
    }),
  ];
}

/** the cables at a port: from an output, into a jack, or reaching a thumb's parameter (its dedicated input, a pin that
 *  routes to it, a side input routed to it). An assembly's port leaves out the cables that stay inside it */
export function portCables(p: Patch, defs: Record<string, ModuleDef>, c: Card, port: QPort): Cable[] {
  const inside = c.kind === 'assembly' ? new Set(allModules(p, assemblyById(p, c.id)!)) : null;
  const outside = (e: Endpoint): boolean => !inside || !inside.has(e.module);
  if (port.dir === 'out') return p.cables.filter((x) => port.ends.some((e) => sameEnd(x.from, e)) && outside(x.to));
  if (!port.param) return p.cables.filter((x) => port.ends.some((e) => sameEnd(x.to, e)) && outside(x.from));
  const m = p.modules.find((x) => x.id === port.param!.module);
  const pd = m && defs[m.type].params.find((q) => q.name === port.param!.param);
  if (!m || !pd) return [];
  const ins = parameterInputs(m, pd);
  return p.cables.filter((x) => x.to.module === m.id && ins.includes(x.to.port) && outside(x.from));
}

/** how well a port takes the held cable end: 0 lit (the same kind of signal), 1 allowed, -1 not (the same direction, the
 *  same card, keys with anything but keys) */
export function fit(held: QPort, port: QPort): number {
  if (held.dir === port.dir) return -1;
  if ((held.kind === 'keys') !== (port.kind === 'keys')) return -1;
  const cls = (k: SignalKind): string => (k === 'gate' ? 'control' : k);
  return held.kind === port.kind || (cls(held.kind) === cls(port.kind) && held.kind !== 'gate' && port.kind !== 'gate') ? 0 : 1;
}

/** the inputs a cable of each kind goes to first */
const FIRST_IN: Record<SignalKind, string[]> = { audio: ['in', 'l', 'in1', 'a'], control: ['cv', 'pitch'], gate: ['gate', 'trig', 'clk', 'clock'], keys: ['keys'] };

/**
 * The port Enter takes. Holding nothing: the first output without a cable (else the first output; a card without outputs:
 * its first free input, to patch from it). Holding an output: an input of its kind, a free one first, `cv` for a control
 * signal and `in` (the Output's `l`) for audio, jacks before thumbs; a stereo pair's `r` only when there is no `l`. Holding
 * an input: the card's first output of its kind.
 */
export function defaultPort(ports: QPort[], held: QPort | null, cabled: (q: QPort) => boolean): QPort | null {
  return rankPorts(ports, held, cabled)[0] ?? null;
}

/** the ports in the order the list offers them: the default first, then the lit ones, then the rest that fit */
export function rankPorts(ports: QPort[], held: QPort | null, cabled: (q: QPort) => boolean): QPort[] {
  const order = new Map(ports.map((q, i) => [q, i]));
  const by = (key: (q: QPort) => number) => (a: QPort, b: QPort): number => key(a) - key(b) || order.get(a)! - order.get(b)!;
  if (!held) {
    const outs = ports.filter((q) => q.dir === 'out');
    const ins = ports.filter((q) => q.dir === 'in');
    if (!outs.length) return [...ins].sort(by((q) => (cabled(q) ? 1 : 0) + (q.param ? 2 : 0)));
    return [...[...outs].sort(by((q) => (cabled(q) ? 1 : 0))), ...ins];
  }
  const ok = ports.filter((q) => fit(held, q) >= 0);
  if (held.dir === 'in') return ok.sort(by((q) => fit(held, q)));
  const first = FIRST_IN[held.kind];
  const hasL = ok.some((q) => q.name === 'l');
  const key = (q: QPort): number => {
    const named = first.indexOf(q.name);
    return fit(held, q) * 100 + (q.name === 'r' && hasL ? 50 : 0) + (q.param ? 20 : 0) + (cabled(q) ? 10 : 0) + (named < 0 ? 5 : named);
  };
  return ok.sort(by(key));
}

/** the ports a typed name picks, best first: its name or label exactly, then a name, then a word of the label, that starts
 *  with it (`lp` → lp24, `cut` → cutoff) */
export function matchPorts(ports: QPort[], text: string): QPort[] {
  const t = text.trim().toLowerCase();
  if (!t) return ports;
  const tier = (q: QPort): number => {
    const name = q.name.toLowerCase(), label = q.label.toLowerCase();
    if (name === t || label === t) return 0;
    if (name.startsWith(t)) return 1;
    if (label.startsWith(t) || label.split(/[\s/(]+/).some((w) => w.startsWith(t))) return 2;
    return -1;
  };
  return ports.map((q, i) => ({ q, i, t: tier(q) })).filter((x) => x.t >= 0).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.q);
}

// ---- search: the cards in the patch first, then a new module or assembly

export interface Blueprint { name: string; chain: string }
export interface Catalog {
  modules: { type: string; name: string; keywords: string }[];
  assemblies: { def: AssemblyDef; shelf: string; keywords: string }[];
  blueprints: Blueprint[];
}
export type Hit =
  | { kind: 'card'; card: Card; label: string; detail: string }
  | { kind: 'module'; type: string; label: string; detail: string }
  | { kind: 'assembly'; def: AssemblyDef; label: string; detail: string }
  | { kind: 'blueprint'; blueprint: Blueprint; label: string; detail: string };

/** the modules people reach for most: they win a tie (`filt` finds the Multimode filter before the Formant filter) */
const COMMON = ['osc', 'filter', 'vca', 'adsr', 'lfo', 'mixer', 'output', 'delay', 'reverb', 'noise', 'ladder', 'env', 'chorus', 'seq', 'steps'];

/** the cards a search offers: every module card (Main's too) and collapsed assembly */
export function patchCards(p: Patch): Card[] {
  const hidden = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open) for (const id of allModules(p, a)) hidden.add(id);
  const nested = (id: number): boolean => { for (let x = parentOf(p, id); x; x = parentOf(p, x.id)) if (!x.open) return true; return false; };
  return [
    ...p.modules.filter((m) => !hidden.has(m.id)).map((m): Card => ({ kind: 'module', id: m.id })),
    ...assembliesOf(p).filter((a) => !a.open && !nested(a.id)).map((a): Card => ({ kind: 'assembly', id: a.id })),
  ];
}

/**
 * Search by name, card tag, former name and the editor's search words (labels.ts moduleKeywords), with the command
 * palette's fuzzy match (fuzzy.ts). A name match beats a search-word match. At a like match a card already in the patch
 * comes first, so `out` finds the Output there is, then a new module, then a new assembly (`mm` is the Multimode filter,
 * not Shimmer); the type's own name typed in full (`filter`, `vca`) wins outright. A leading `+` offers only new ones.
 */
export function search(p: Patch, defs: Record<string, ModuleDef>, cat: Catalog, query: string): Hit[] {
  let q = query.trim().toLowerCase();
  const fresh = q.startsWith('+');
  if (fresh) q = q.slice(1).trim();
  if (!q) return [];
  const rank = (label: string, words: string, exact: string[], bonus: number): number => {
    if (exact.some((e) => e.toLowerCase() === q)) return 10000 + bonus;
    const name = score(q, label);
    if (name >= 0) return 2000 + name * 10 + bonus;
    const kw = score(q, words);
    return kw >= 0 ? 1000 + kw * 10 + bonus : -1;
  };
  const common = (type: string): number => (COMMON.includes(type) ? 4 - COMMON.indexOf(type) / COMMON.length * 3 : 0);
  // (a consecutive letter scores 30: a module wins over an assembly that matches one letter better)
  const MODULE_BONUS = 12, CARD_BONUS = MODULE_BONUS + 5;
  const out: { hit: Hit; r: number }[] = [];
  if (!fresh) {
    for (const c of patchCards(p)) {
      const label = cardTitle(p, defs, c);
      if (c.kind === 'module') {
        const m = p.modules.find((x) => x.id === c.id)!;
        const def = defs[m.type];
        const r = rank(label, `${moduleKeywords(m.type, def.label)} ${m.name ? def.label : ''}`, [m.type, def.label, label], CARD_BONUS + common(m.type));
        if (r >= 0) out.push({ hit: { kind: 'card', card: c, label, detail: 'in the patch' }, r });
      } else {
        const a = assemblyById(p, c.id)!;
        const r = rank(label, a.name, [a.name, label], CARD_BONUS);
        if (r >= 0) out.push({ hit: { kind: 'card', card: c, label, detail: 'in the patch' }, r });
      }
    }
  }
  for (const m of cat.modules) {
    const r = rank(m.name, m.keywords, [m.type, m.name], MODULE_BONUS + common(m.type));
    if (r >= 0) out.push({ hit: { kind: 'module', type: m.type, label: m.name, detail: '+ new module' }, r });
  }
  for (const a of cat.assemblies) {
    const r = rank(a.def.name, a.keywords, [a.def.name], 0);
    if (r >= 0) out.push({ hit: { kind: 'assembly', def: a.def, label: a.def.name, detail: `+ new assembly · ${a.shelf}` }, r });
  }
  for (const b of cat.blueprints) {
    const r = rank(b.name, b.chain, [b.name], -1);
    if (r >= 0) out.push({ hit: { kind: 'blueprint', blueprint: b, label: b.name, detail: `blueprint · ${b.chain}` }, r });
  }
  return out.sort((a, b) => b.r - a.r).map((x) => x.hit);
}

// ---- wiring: what a dropped cable does on the canvas (editor.ts connectJacks), between two ports

/** connect two ports, whichever way round they come; cables into one input add up. Throws with the editor's reason */
export function wire(p: Patch, defs: Record<string, ModuleDef>, a: QPort, b: QPort): void {
  if (a.dir === b.dir) throw new Error('connect an output to an input');
  const [out, input] = a.dir === 'out' ? [a, b] : [b, a];
  const one = (from: Endpoint, to: Endpoint): void => {
    if (p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to))) return;
    if (!connect(p, defs, from, to)) throw new Error(from.port === 'keys' ? keyRouteError(p, { from, to }) ?? 'Cannot connect these ports.' : 'Cannot connect these ports.');
  };
  for (const from of out.ends) {
    if (!input.param) {
      for (const to of input.ends) one(from, to);
      continue;
    }
    const { module, param } = input.param;
    const to = connectParameter(p, defs, from, module, param);
    // a card row that sets several parameters: the cable reaches every one of them
    for (const t of tiedTo(p, module, param).slice(1)) connectParameter(p, defs, from, t.module, t.param);
    // the thumb of a merged assembly jack feeds the same group of inputs
    for (const asm of assembliesOf(p)) for (const t of findRef(asm, 'in', to.module, to.port)?.also ?? []) one(from, t);
  }
}

// ---- where a new card goes

export interface Size { w: number; h: number }
/** the room left between two cards in a row, for the cables */
export const GAP = 80;
/** how far a card is moved down or up to find room */
const STEP = 40;
const CLEAR = 12;

/** a spot beside `anchor` (`right`: after it in the signal flow; `left`: before it), clear of every `occupied` card: on
 *  its row, else the nearest free row below it within a card's height or so, else above, else further below */
export function besideSpot(anchor: Rect, side: 'left' | 'right', size: Size, occupied: Rect[]): { x: number; y: number } {
  const x = side === 'right' ? anchor.x + anchor.w + GAP : anchor.x - GAP - size.w;
  const grown = occupied.map((o) => ({ x: o.x - CLEAR, y: o.y - CLEAR, w: o.w + 2 * CLEAR, h: o.h + 2 * CLEAR }));
  const NEAR = 15;
  const steps = [0, ...Array.from({ length: NEAR }, (_, i) => i + 1), ...Array.from({ length: NEAR }, (_, i) => -(i + 1)), ...Array.from({ length: 200 }, (_, i) => NEAR + 1 + i)];
  for (const s of steps) {
    const r = { x, y: anchor.y + s * STEP, w: size.w, h: size.h };
    if (!grown.some((o) => overlaps(o, r))) return { x: r.x, y: r.y };
  }
  return { x, y: anchor.y };
}

// ---- the typed chain

export interface ChainItem {
  /** the module, assembly or card name as typed, without `+`, `#n` and the port */
  name: string;
  /** `+`: always a new one */
  fresh: boolean;
  /** what names this item within the text: the same tag is the same card (`lfo`, `lfo#2`) */
  tag: string;
  port?: string;
}
export type Statement = { kind: 'chain'; items: ChainItem[] } | { kind: 'blueprint'; name: string };

/** a line that is a typed chain or a blueprint stamp rather than a search */
export const isChainText = (text: string): boolean => /[>;\n]/.test(text) || /^\s*bp\s+\S/i.test(text);

/**
 * Read a typed chain: statements split by `;` or new lines, each `a.port > b.port > c.port` or `bp <name>`. An item is a
 * name (a card in the patch, a module or an assembly), `+` in front for a new one, `#2` after it for a second one of the
 * same name, `.port` after that. Returns the first error in words.
 */
export function parseChain(text: string): { statements: Statement[] } | { error: string } {
  const statements: Statement[] = [];
  for (const raw of text.split(/[;\n]/)) {
    const line = raw.trim();
    if (!line) continue;
    const bp = /^bp\s+(.+)$/i.exec(line);
    if (bp) {
      statements.push({ kind: 'blueprint', name: bp[1].trim() });
      continue;
    }
    const parts = line.split('>').map((s) => s.trim());
    if (parts.length < 2) return { error: `"${line}": put > between two modules, as in lfo.out > vca.cv` };
    const items: ChainItem[] = [];
    for (const part of parts) {
      if (!part) return { error: `"${line}": a module is missing next to >` };
      const fresh = part.startsWith('+');
      const body = fresh ? part.slice(1).trim() : part;
      const dot = body.lastIndexOf('.');
      const head = (dot > 0 ? body.slice(0, dot) : body).trim();
      const port = dot > 0 ? body.slice(dot + 1).trim() : undefined;
      if (port === '') return { error: `"${part}": a port name is missing after the dot` };
      const hash = /^(.*?)\s*#\s*(\d+)$/.exec(head);
      const name = (hash ? hash[1] : head).trim();
      if (!name) return { error: `"${part}": a module name is missing` };
      items.push({ name, fresh, tag: `${name.toLowerCase()}#${hash ? Number(hash[2]) : 1}`, ...(port ? { port } : {}) });
    }
    statements.push({ kind: 'chain', items });
  }
  if (!statements.length) return { error: 'type a chain: lfo.out > vca.cv' };
  return { statements };
}

/** where the cards a chain makes go: `anchor` is a card it is cabled to that already has a place (null: none yet) */
export type Place = (size: Size, anchor: Rect | null, side: 'left' | 'right') => { x: number; y: number };
export interface Built { cards: Card[]; fresh: Card[]; cables: number; links: Link[] }
/** one cable a chain made, by card and port name */
export interface Link { from: Card; fromPort: string; to: Card; toPort: string }

/** an error in a typed chain or blueprint, worded for the person typing */
export class ChainError extends Error {}

/** the port a typed name picks on a card, or with none typed (or `in` / `out` that the card does not have) the default */
export function resolvePort(p: Patch, defs: Record<string, ModuleDef>, card: Card, typed: string | undefined, held: QPort | null, want: 'in' | 'out'): QPort {
  const ports = cardPorts(p, defs, card).filter((q) => q.dir === want);
  const cabled = (q: QPort): boolean => portCables(p, defs, card, q).length > 0;
  const fallback = (): QPort | null => (held ? defaultPort(ports, held, cabled) : rankPorts(ports, null, cabled).find((q) => q.dir === want) ?? null);
  const title = cardTitle(p, defs, card);
  const list = (): string => ports.slice(0, 12).map((q) => q.name).join(', ') + (ports.length > 12 ? ', …' : '');
  if (!typed || typed.toLowerCase() === want) {
    const d = fallback();
    if (!d) throw new ChainError(`${title} has no ${want === 'in' ? 'input' : 'output'}${held ? ` that takes ${held.kind}` : ''}`);
    return d;
  }
  const found = matchPorts(ports, typed).filter((q) => !held || fit(held, q) >= 0);
  if (!found.length) throw new ChainError(`${title} has no ${want === 'in' ? 'input' : 'output'} "${typed}"${ports.length ? `. Its ${want === 'in' ? 'inputs' : 'outputs'}: ${list()}` : ''}`);
  return found[0];
}

/** a new card's size before it is drawn: wide enough for a card, as tall as its rows (refined once it is on the canvas) */
export function guessSize(defs: Record<string, ModuleDef>, what: { type: string } | { def: AssemblyDef }): Size {
  if ('def' in what) {
    const rows = Math.max(1, ...paramColumns(what.def.params).map((c) => c.length));
    return { w: cardWidth(what.def.params), h: 64 + 20 * (rows + Math.max(what.def.inputs.length, what.def.outputs.length) / 2) };
  }
  const def = defs[what.type];
  return { w: 260, h: 64 + 20 * Math.max(def.inputs.length, def.outputs.length) + 20 * Math.min(10, def.params.length) };
}

/**
 * Build typed chains into the patch: every card named, made or found, then placed (each new card beside a card it is
 * cabled to, sources left of what they feed), then the cables, statement by statement. An item in the middle of a chain
 * takes the cable into its port and passes its default output on. Throws a ChainError for an unknown name or port; the
 * caller runs it as one change, so a throw leaves the patch as it was.
 */
export function buildChain(p: Patch, defs: Record<string, ModuleDef>, statements: Statement[], cat: Catalog, place: Place, rectOf: (c: Card) => Rect | null): Built {
  // a blueprint statement stands for its own chain
  const flat: { kind: 'chain'; items: ChainItem[]; scope: number }[] = [];
  let scope = 0;
  for (const s of statements) {
    if (s.kind === 'chain') { flat.push({ ...s, scope: 0 }); continue; }
    const bp = cat.blueprints.find((b) => b.name.toLowerCase() === s.name.toLowerCase());
    if (!bp) throw new ChainError(`no blueprint "${s.name}"${cat.blueprints.length ? `. Saved: ${cat.blueprints.map((b) => b.name).join(', ')}` : ''}`);
    const parsed = parseChain(bp.chain);
    if ('error' in parsed) throw new ChainError(`blueprint "${bp.name}": ${parsed.error}`);
    scope++;
    for (const t of parsed.statements) if (t.kind === 'chain') flat.push({ ...t, scope });
  }
  // name every item: the same tag in one text is the same card
  const bound = new Map<string, { card?: Card; make?: { type: string } | { def: AssemblyDef } }>();
  const fresh: string[] = [];
  for (const s of flat) for (const it of s.items) {
    const key = `${s.scope}:${it.tag}`;
    if (bound.has(key)) continue;
    const hits = search(p, defs, cat, `${it.fresh ? '+' : ''}${it.name}`).filter((h) => h.kind !== 'blueprint');
    const taken = new Set([...bound.values()].flatMap((b) => (b.card ? [cardKey(b.card)] : [])));
    // a card already named by another tag is not this one: `lfo#2` is a second LFO
    const hit = hits.find((h) => h.kind !== 'card' || !taken.has(cardKey(h.card)));
    if (!hit) throw new ChainError(`no module, assembly or card called "${it.name}"`);
    if (hit.kind === 'card') bound.set(key, { card: hit.card });
    else if (hit.kind === 'module' || hit.kind === 'assembly') {
      bound.set(key, { make: hit.kind === 'module' ? { type: hit.type } : { def: hit.def } });
      fresh.push(key);
    }
  }
  // make the new cards (placed below), then place each beside a card it is cabled to
  const made = new Map<string, { card: Card; size: Size }>();
  for (const key of fresh) {
    const what = bound.get(key)!.make!;
    const card: Card = 'type' in what
      ? { kind: 'module', id: addModule(p, defs[what.type], 0, 0).id }
      : { kind: 'assembly', id: insertAssembly(p, defs, what.def, 0, 0).id };
    bound.get(key)!.card = card;
    made.set(key, { card, size: guessSize(defs, what) });
  }
  const placed = new Map<string, Rect>();
  for (const [key, b] of bound) if (!made.has(key)) { const r = rectOf(b.card!); if (r) placed.set(key, r); }
  const pairs = flat.flatMap((s) => s.items.slice(1).map((it, i) => [`${s.scope}:${s.items[i].tag}`, `${s.scope}:${it.tag}`] as const));
  const setAt = (key: string, at: { x: number; y: number }): void => {
    const { card, size } = made.get(key)!;
    const r = { ...at, ...size };
    placed.set(key, r);
    moveCard(p, card, at.x, at.y);
  };
  while ([...made.keys()].some((k) => !placed.has(k))) {
    let moved = false;
    for (const [a, b] of pairs) {
      if (placed.has(a) && !placed.has(b) && made.has(b)) (setAt(b, place(made.get(b)!.size, placed.get(a)!, 'right')), (moved = true));
      else if (placed.has(b) && !placed.has(a) && made.has(a)) (setAt(a, place(made.get(a)!.size, placed.get(b)!, 'left')), (moved = true));
    }
    if (moved) continue;
    const first = [...made.keys()].find((k) => !placed.has(k));
    if (!first) break;
    setAt(first, place(made.get(first)!.size, null, 'right'));
  }
  // the cables, statement by statement
  const links: Link[] = [];
  let cables = 0;
  for (const s of flat) {
    let from: { card: Card; port: QPort } | null = null;
    s.items.forEach((it, i) => {
      const card = bound.get(`${s.scope}:${it.tag}`)!.card!;
      if (from) {
        if (sameCard(from.card, card)) throw new ChainError(`"${it.name}" is cabled to itself`);
        const to = resolvePort(p, defs, card, it.port, from.port, 'in');
        const before = p.cables.length;
        wire(p, defs, from.port, to);
        cables += p.cables.length - before;
        links.push({ from: from.card, fromPort: from.port.name, to: card, toPort: to.name });
      }
      if (i < s.items.length - 1) from = { card, port: resolvePort(p, defs, card, i === 0 ? it.port : undefined, null, 'out') };
    });
  }
  const cards = [...new Map([...bound.values()].map((b) => [cardKey(b.card!), b.card!])).values()];
  return { cards, fresh: [...made.values()].map((m) => m.card), cables, links };
}

/** put a card at a place: a module's position, or a collapsed assembly's (its members keep their places inside) */
export function moveCard(p: Patch, c: Card, x: number, y: number): void {
  const t = c.kind === 'module' ? p.modules.find((m) => m.id === c.id) : assemblyById(p, c.id);
  if (t) (t.x = Math.round(x)), (t.y = Math.round(y));
}

/**
 * A chain as a line that builds it again (and a blueprint's text): cards it made get `+`, a second card of the same name
 * `#2`. Consecutive cables through a new card join into one statement when the cable leaves by that card's first output,
 * the one the chain grammar passes on (`+lfo.out > +filter.cv > +vca.in > output.l`).
 */
export function chainText(p: Patch, defs: Record<string, ModuleDef>, links: Link[], fresh: Card[]): string {
  const tags = new Map<string, string>();
  const counts = new Map<string, number>();
  const tagOf = (c: Card): string => {
    const k = cardKey(c);
    if (!tags.has(k)) {
      const name = c.kind === 'module' ? p.modules.find((m) => m.id === c.id)?.type ?? '?' : assemblyById(p, c.id)?.name ?? '?';
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      tags.set(k, n > 1 ? `${name}#${n}` : name);
    }
    return tags.get(k)!;
  };
  const isFresh = (c: Card): boolean => fresh.some((f) => sameCard(f, c));
  const seen = new Set<string>();
  const item = (c: Card, port: string): string => {
    const k = cardKey(c);
    const plus = isFresh(c) && !seen.has(k) ? '+' : '';
    seen.add(k);
    return `${plus}${tagOf(c)}.${port}`;
  };
  const firstOut = (c: Card): string | undefined => cardPorts(p, defs, c).find((q) => q.dir === 'out')?.name;
  const statements: string[] = [];
  let line: string[] = [];
  let last: Link | null = null;
  for (const l of links) {
    if (last && sameCard(last.to, l.from) && isFresh(l.from) && firstOut(l.from) === l.fromPort) line.push(item(l.to, l.toPort));
    else {
      if (line.length) statements.push(line.join(' > '));
      line = [item(l.from, l.fromPort), item(l.to, l.toPort)];
    }
    last = l;
  }
  if (line.length) statements.push(line.join(' > '));
  return statements.join('; ');
}

// ---- following cables

/** a card at the other end of a cable, and the port the cable ends on there */
export interface FarEnd { card: Card; port: string; title: string }

/** the far ends of the cables at a port, as cards to go to (a card at both ends of one cable only once) */
export function farEnds(p: Patch, defs: Record<string, ModuleDef>, c: Card, port: QPort): FarEnd[] {
  const out: FarEnd[] = [];
  for (const x of portCables(p, defs, c, port)) {
    const end = port.dir === 'out' ? x.to : x.from;
    const card = cardOf(p, end.module);
    if (sameCard(card, c) || out.some((o) => sameCard(o.card, card) && o.port === end.port)) continue;
    out.push({ card, port: end.port, title: cardTitle(p, defs, card) });
  }
  return out;
}

/** where Quick patch has been: back and forward along it, as a browser's history */
export class Trail {
  items: Card[] = [];
  at = -1;
  get current(): Card | null { return this.items[this.at] ?? null; }
  /** go to a card: the cards after the current one are dropped */
  push(c: Card): void {
    if (sameCard(this.current, c)) return;
    this.items = [...this.items.slice(0, this.at + 1), c];
    this.at = this.items.length - 1;
  }
  /** go to the card at index `i` (back: at - 1, forward: at + 1); null, staying put, past either end */
  go(i: number): Card | null {
    if (i < 0 || i >= this.items.length) return null;
    this.at = i;
    return this.current;
  }
  get canBack(): boolean { return this.at > 0; }
  get canForward(): boolean { return this.at < this.items.length - 1; }
  /** drop cards that are gone (an undo), keeping the place on the trail */
  keep(alive: (c: Card) => boolean): void {
    const cur = this.current;
    this.items = this.items.filter(alive);
    this.at = cur && alive(cur) ? this.items.findIndex((x) => sameCard(x, cur)) : this.items.length - 1;
  }
  clear(): void { this.items = []; this.at = -1; }
}

// ---- blueprints: saved chains, in this browser

export const BLUEPRINT_KEY = 'matryoshka.blueprints';

export function loadBlueprints(store: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): Blueprint[] {
  try {
    const raw: unknown = JSON.parse(store?.getItem(BLUEPRINT_KEY) ?? 'null');
    const list: unknown[] = raw && typeof raw === 'object' && 'list' in raw && Array.isArray(raw.list) ? raw.list : [];
    return list.flatMap((b) => {
      if (!b || typeof b !== 'object' || !('name' in b) || !('chain' in b)) return [];
      const { name, chain } = b;
      return typeof name === 'string' && typeof chain === 'string' && name.trim() && 'statements' in parseChain(chain) ? [{ name: name.trim(), chain }] : [];
    });
  } catch {
    return [];
  }
}

function storeBlueprints(list: Blueprint[], store: Pick<Storage, 'setItem'> | null): void {
  try { store?.setItem(BLUEPRINT_KEY, JSON.stringify({ v: 1, list })); } catch { /* storage full or off: kept for this page only */ }
}

/** keep a chain under a name (one of the same name is replaced); returns the list */
export function saveBlueprint(name: string, chain: string, store: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null): Blueprint[] {
  const n = name.trim();
  if (!n) throw new ChainError('a blueprint needs a name: bp save lfo-filter-vca');
  if ('error' in parseChain(chain)) throw new ChainError('there is no chain to keep yet: build one first');
  const list = [...loadBlueprints(store).filter((b) => b.name.toLowerCase() !== n.toLowerCase()), { name: n, chain }];
  storeBlueprints(list, store);
  return list;
}

export function removeBlueprint(name: string, store: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null): boolean {
  const list = loadBlueprints(store);
  const kept = list.filter((b) => b.name.toLowerCase() !== name.trim().toLowerCase());
  if (kept.length === list.length) return false;
  storeBlueprints(kept, store);
  return true;
}
