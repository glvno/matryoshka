// SPDX-License-Identifier: GPL-3.0-only
// Quick patch (#1091): build a patch from the keyboard, without aiming at jacks or panning. This file is the part without a
// screen: what a card offers as ports and which one Enter takes, the search for modules, the typed chain
// (`lfo.out > multimode.cv; multimode.lp > vca.in > output.in`), following cables, blueprints and where a new card goes.
// quick-patch-view.ts draws the field and the ring and drives the editor with these.
import { allModules, assembliesOf, assemblyById, assemblyOf, cardWidth, deviceModules, findRef, insertAssembly, overlaps, paramColumns, parentOf, targetsOf, tiedTo, type AssemblyDef, type AssemblyInst, type Rect } from './assembly';
import { addDrawer, chainCableProblem, chainJackProblem, drawerOf, drawerOfEffect, drawerOutput, drawers, effectKind, effectsOf, insertEffect, outputDrawer, ownerOf, rewire } from './fx-drawer';
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
  /** a jack of an effect's stereo chain while it sits in an FX drawer: the editor wires it, so a cable onto it is refused
   *  with this reason (the ring greys it out, labelled chain) */
  chain?: string;
  /** what the ring writes under the name: `after FX` for an instrument's out L / R that give the sound after its drawer,
   *  `into FX` for the Output's left / right while the Output drawer runs them through its effects */
  note?: string;
}

// ---- FX drawers (D-1310..D-1316 amended for the drawer): an effect in a drawer is a card of its own, named after its
// instrument, even while the drawer is closed

/** a drawer by who owns it: an instrument (its top-level assembly's id), or the patch's Output drawer */
export type DrawerOwner = number | 'output';

const ownerKey = (p: Patch, d: AssemblyInst): DrawerOwner => { const o = ownerOf(p, d); return o === 'output' ? 'output' : o.id; };

/** the drawer of an owner, if it has one */
export const drawerFor = (p: Patch, owner: DrawerOwner): AssemblyInst | undefined => (owner === 'output' ? outputDrawer(p) : drawerOf(p, owner));

/** a drawer's name in words: `Hera 4's FX`, `Output FX` */
export function drawerName(p: Patch, owner: DrawerOwner): string {
  if (owner === 'output') return 'Output FX';
  const a = assemblyById(p, owner);
  return `${a ? a.label || a.name : '?'}'s FX`;
}

/** the drawer a card sits in as an effect, if it does */
export const drawerOfCard = (p: Patch, c: Card): AssemblyInst | undefined => (c.kind === 'assembly' ? drawerOfEffect(p, c.id) : undefined);

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** where an effect in a drawer sits, in words: `Hera 4 › FX, 3rd of 3`, `Output FX, 1st of 2`; null for any other card */
export function effectPlace(p: Patch, c: Card): string | null {
  const d = drawerOfCard(p, c);
  if (!d) return null;
  const list = effectsOf(p, d);
  const at = `${ordinal(list.findIndex((e) => e.id === c.id) + 1)} of ${list.length}`;
  const owner = ownerKey(p, d);
  return owner === 'output' ? `Output FX, ${at}` : `${ownTitle(p, { kind: 'assembly', id: owner })} › FX, ${at}`;
}

/** the instruments that can own a drawer (top-level assemblies that are neither an effect nor a drawer) and the Output, by
 *  what `@` names: a title in full, else the start of one, else the best fuzzy match; `output` is the Output drawer */
export function findOwner(p: Patch, text: string): DrawerOwner | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  const owners: { owner: DrawerOwner; title: string }[] = [
    ...assembliesOf(p).filter((a) => !parentOf(p, a.id) && !a.chain && !a.drawer).map((a) => ({ owner: a.id as DrawerOwner, title: (a.label || a.name).toLowerCase() })),
    { owner: 'output', title: 'output' },
    { owner: 'output', title: 'output fx' },
  ];
  const hit = owners.find((o) => o.title === t) ?? owners.find((o) => o.title.startsWith(t))
    ?? owners.map((o) => ({ o, s: score(t, o.title) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)[0]?.o;
  return hit?.owner;
}

/** where a new effect goes in an owner's drawer: after the current card when that is one of its effects, else at the end */
export function insertPlace(p: Patch, owner: DrawerOwner, current: Card | null): { index: number | undefined; detail: string } {
  const d = drawerFor(p, owner);
  if (!d) return { index: undefined, detail: 'a new drawer' };
  const list = effectsOf(p, d);
  const i = current?.kind === 'assembly' ? list.findIndex((e) => e.id === current.id) : -1;
  return i >= 0 && i < list.length - 1 ? { index: i + 1, detail: `after ${list[i].label || list[i].name}` } : { index: undefined, detail: 'at the end' };
}

/** add a new effect into an owner's drawer (made when it has none), after `index - 1` or at the end; its card */
export function addToDrawer(p: Patch, owner: DrawerOwner, what: { type: string } | { def: AssemblyDef }, index?: number): Card {
  const d = drawerFor(p, owner) ?? addDrawer(p, owner);
  return { kind: 'assembly', id: insertEffect(p, d, what, index).id };
}

/** whether a module or an assembly (the catalog's, or one of the user's marked Use as an effect) is an audio effect, one
 *  that fits a drawer */
export const isEffect = (what: { type: string } | { def: AssemblyDef }): boolean =>
  ('def' in what && !!what.def.fxMode) || effectKind('type' in what ? what.type : what.def.name) !== null;

/** the card a module shows on: itself, the effect in an FX drawer it belongs to, or the outermost collapsed assembly that
 *  hides it */
export function cardOf(p: Patch, module: number): Card {
  let hidden: number | undefined;
  for (let a = assemblyOf(p, module); a; a = parentOf(p, a.id)) {
    if (drawerOfEffect(p, a.id)) return { kind: 'assembly', id: a.id };
    if (!a.open) hidden = a.id;
  }
  return hidden !== undefined ? { kind: 'assembly', id: hidden } : { kind: 'module', id: module };
}

/** whether a card is still in the patch (an undo can take it away) */
export const cardExists = (p: Patch, c: Card): boolean =>
  c.kind === 'module' ? p.modules.some((m) => m.id === c.id) : !!assemblyById(p, c.id);

/** a card's own name as the canvas shows it */
function ownTitle(p: Patch, c: Card, defs?: Record<string, ModuleDef>): string {
  if (c.kind === 'assembly') {
    const a = assemblyById(p, c.id);
    return a ? a.label || a.name : '?';
  }
  const m = p.modules.find((x) => x.id === c.id);
  return m ? moduleTitle(m, defs?.[m.type]?.label ?? m.type) : '?';
}

/** a card's name: as the canvas shows it, and an effect in a drawer after its instrument (`Hera 4 › Delay`) */
export function cardTitle(p: Patch, defs: Record<string, ModuleDef>, c: Card): string {
  const own = ownTitle(p, c, defs);
  const d = drawerOfCard(p, c);
  if (!d) return own;
  const owner = ownerKey(p, d);
  return `${owner === 'output' ? 'Output FX' : ownTitle(p, { kind: 'assembly', id: owner })} › ${own}`;
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
    // (the Output's left / right with an Output drawer: what comes in runs through its effects)
    const intoFx = m.type === 'output' && !!outputDrawer(p) && effectsOf(p, outputDrawer(p)!).length > 0;
    return [
      ...def.outputs.map((o): QPort => ({ dir: 'out', name: o.name, label: longName(m.type, o.name), kind: o.kind, ends: end(o.name) })),
      ...def.inputs.filter((i) => !isPin(i.name)).map((i): QPort => {
        const drives = drivenBy(def, i.name);
        const note = intoFx && OUTPUT_SIDES.includes(i.name) ? { note: 'into FX' } : {};
        return { dir: 'in', name: i.name, label: longName(m.type, i.name), kind: i.kind, ends: end(i.name), ...(drives.length ? { drives } : {}), ...note };
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
  // an effect in a drawer: its chain jacks are the editor's (refused with the reason); an instrument with a drawer of
  // effects: its out L / R give the sound after them, from the drawer's outputs
  const inDrawer = a.chain && drawerOfEffect(p, a.id) ? a.chain : null;
  const d = drawerOf(p, a.id);
  const taps = d?.drawer?.taps && effectsOf(p, d).length ? d.drawer.taps : null;
  const jack = (dir: 'in' | 'out') => (r: { module: number; port: string; label: string; also?: Endpoint[] }, i: number): QPort => {
    const m = p.modules.find((x) => x.id === r.module);
    const drives = dir === 'in' && m ? drivenBy(defs[m.type], r.port) : [];
    let ends = targetsOf(r);
    const extra: Partial<QPort> = {};
    if (inDrawer && (dir === 'in' ? inDrawer.ins : inDrawer.outs).includes(i)) {
      const why = chainJackProblem(p, ends[0], dir);
      if (why) extra.chain = why;
    }
    if (taps && dir === 'out') {
      // (a mono instrument's one out takes the left side)
      const chans = ([0, 1] as const).filter((ch) => ends.some((e) => sameEnd(e, taps[ch])) && (ch === 0 || !sameEnd(taps[0], taps[1])));
      if (chans.length) {
        ends = chans.flatMap((ch) => drawerOutput(p, a.id, ch)).filter((e, k, all) => all.findIndex((x) => sameEnd(x, e)) === k);
        extra.note = 'after FX';
      }
    }
    return { dir, name: r.label, label: r.label, kind: kindOf(r, dir), ends, ...(drives.length ? { drives } : {}), ...extra };
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
  // (the chain wires are the editor's: never followed)
  if (port.chain) return [];
  // (an instrument's drawer is not inside its card: its effects are cards of their own; but the out L / R after its FX
  // leave out the wires inside the drawer)
  const a = c.kind === 'assembly' ? assemblyById(p, c.id)! : null;
  const inside = a ? new Set(port.note === 'after FX' ? allModules(p, a) : deviceModules(p, a)) : null;
  const outside = (e: Endpoint): boolean => !inside || !inside.has(e.module);
  if (port.dir === 'out') return p.cables.filter((x) => port.ends.some((e) => sameEnd(x.from, e)) && outside(x.to));
  if (port.note === 'into FX') return outputDrawerSources(p, port.ends[0]);
  if (!port.param) return p.cables.filter((x) => port.ends.some((e) => sameEnd(x.to, e)) && outside(x.from));
  const m = p.modules.find((x) => x.id === port.param!.module);
  const pd = m && defs[m.type].params.find((q) => q.name === port.param!.param);
  if (!m || !pd) return [];
  const ins = parameterInputs(m, pd);
  return p.cables.filter((x) => x.to.module === m.id && ins.includes(x.to.port) && outside(x.from));
}

/** the Output's inputs an Output drawer takes */
const OUTPUT_SIDES = ['l', 'r'];

/** what feeds the Output's left or right while an Output drawer of effects sits in front of it: the cables into its first
 *  effect's chain input on that side from outside the drawer */
function outputDrawerSources(p: Patch, side: Endpoint): Cable[] {
  const d = outputDrawer(p);
  const first = d && effectsOf(p, d)[0];
  if (!d || !first?.chain) return [];
  const ref = first.inputs[first.chain.ins[side.port === 'r' ? 1 : 0]];
  const inside = new Set(allModules(p, d));
  return ref ? p.cables.filter((x) => targetsOf(ref).some((e) => sameEnd(x.to, e)) && !inside.has(x.from.module)) : [];
}

/** how well a port takes the held cable end: 0 lit (the same kind of signal), 1 allowed, -1 not (the same direction, the
 *  same card, keys with anything but keys) */
export function fit(held: QPort, port: QPort): number {
  if (held.dir === port.dir || held.chain || port.chain) return -1;
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
  return rankPorts(ports, held, cabled).find((q) => !q.chain) ?? null;
}

/** the ports in the order the list offers them: the default first, then the lit ones, then the rest that fit; a drawer's
 *  chain jacks last (picking one says why not) */
export function rankPorts(ports: QPort[], held: QPort | null, cabled: (q: QPort) => boolean): QPort[] {
  const chain = ports.filter((q) => q.chain && (!held || held.dir !== q.dir));
  return [...rankFree(ports.filter((q) => !q.chain), held, cabled), ...chain];
}

function rankFree(ports: QPort[], held: QPort | null, cabled: (q: QPort) => boolean): QPort[] {
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
/** a new module or assembly goes on the canvas, or with `into` into that owner's FX drawer */
export type Hit =
  | { kind: 'card'; card: Card; label: string; detail: string }
  | { kind: 'module'; type: string; label: string; detail: string; into?: DrawerOwner }
  | { kind: 'assembly'; def: AssemblyDef; label: string; detail: string; into?: DrawerOwner }
  | { kind: 'blueprint'; blueprint: Blueprint; label: string; detail: string };

/** the modules people reach for most: they win a tie (`filt` finds the Multimode filter before the Formant filter) */
const COMMON = ['osc', 'filter', 'vca', 'adsr', 'lfo', 'mixer', 'output', 'delay', 'reverb', 'noise', 'ladder', 'env', 'chorus', 'seq', 'steps'];

/** the cards a search offers: every module card (Main's too) and collapsed assembly, and every effect in an FX drawer,
 *  open or closed, right after its instrument's card (the Output drawer's last); a drawer itself is not a card */
export function patchCards(p: Patch): Card[] {
  const ds = drawers(p);
  const fx = new Set(ds.flatMap((d) => effectsOf(p, d).map((e) => e.id)));
  const hidden = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open || fx.has(a.id)) for (const id of allModules(p, a)) hidden.add(id);
  const nested = (id: number): boolean => { for (let x = parentOf(p, id); x; x = parentOf(p, x.id)) if (!x.open || x.drawer || fx.has(x.id)) return true; return false; };
  const cards: Card[] = [
    ...p.modules.filter((m) => !hidden.has(m.id)).map((m): Card => ({ kind: 'module', id: m.id })),
    ...assembliesOf(p).filter((a) => !a.open && !a.drawer && !fx.has(a.id) && !nested(a.id)).map((a): Card => ({ kind: 'assembly', id: a.id })),
  ];
  for (const d of ds) {
    const owner = ownerKey(p, d);
    const list = effectsOf(p, d).map((e): Card => ({ kind: 'assembly', id: e.id }));
    const i = owner === 'output' ? -1 : cards.findIndex((c) => c.kind === 'assembly' && c.id === owner);
    if (i < 0) cards.push(...list);
    else cards.splice(i + 1, 0, ...list);
  }
  return cards;
}

/**
 * Search by name, card tag, former name and the editor's search words (labels.ts moduleKeywords), with Commands' fuzzy
 * match (fuzzy.ts). A word typed whole that is a word of the name or the search words beats a part of one
 * (`envelope` finds every envelope, the commonest, the ADSR, first), and a name match beats a search-word match. At a like
 * match a card already in the patch comes first, so `out` finds the Output there is, then a new module, then a new
 * assembly (`mm` is the Multimode filter, not Shimmer); the type's own name typed in full (`filter`, `vca`) wins outright.
 * A leading `+` offers only new ones. `name@hera 4` looks only in Hera 4's FX drawer, and a new effect it names goes into
 * that drawer (`@output`: the Output drawer). Without `@`, a new effect is offered on the canvas first, then into each
 * drawer the patch has, as extra rows.
 */
export function search(p: Patch, defs: Record<string, ModuleDef>, cat: Catalog, query: string): Hit[] {
  let q = query.trim().toLowerCase();
  const fresh = q.startsWith('+');
  if (fresh) q = q.slice(1).trim();
  let owner: DrawerOwner | undefined;
  const atSign = q.indexOf('@');
  if (atSign >= 0) {
    const where = q.slice(atSign + 1).trim();
    q = q.slice(0, atSign).trim();
    if (where && (owner = findOwner(p, where)) === undefined) return [];
  }
  if (!q) return [];
  const rank = (label: string, words: string, exact: string[], bonus: number): number => {
    if (exact.some((e) => e.toLowerCase() === q)) return 10000 + bonus;
    if (`${label} ${words}`.toLowerCase().split(/[^a-z0-9]+/).includes(q)) return 3000 + bonus;
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
      const d = drawerOfCard(p, c);
      if (owner !== undefined && (!d || ownerKey(p, d) !== owner)) continue;
      const label = d ? ownTitle(p, c) : cardTitle(p, defs, c);
      const detail = effectPlace(p, c) ?? 'in the patch';
      if (c.kind === 'module') {
        const m = p.modules.find((x) => x.id === c.id)!;
        const def = defs[m.type];
        const r = rank(label, `${moduleKeywords(m.type, def.label)} ${m.name ? def.label : ''}`, [m.type, def.label, label], CARD_BONUS + common(m.type));
        if (r >= 0) out.push({ hit: { kind: 'card', card: c, label, detail }, r });
      } else {
        const a = assemblyById(p, c.id)!;
        const r = rank(label, `${a.name} ${d ? cardTitle(p, defs, c) : ''}`, [a.name, label], CARD_BONUS);
        if (r >= 0) out.push({ hit: { kind: 'card', card: c, label, detail }, r });
      }
    }
  }
  const into = owner !== undefined ? { into: owner } : {};
  const intoDetail = owner !== undefined ? `into ${drawerName(p, owner)}` : '';
  for (const m of cat.modules) {
    if (owner !== undefined && !isEffect({ type: m.type })) continue;
    const r = rank(m.name, m.keywords, [m.type, m.name], MODULE_BONUS + common(m.type));
    if (r >= 0) out.push({ hit: { kind: 'module', type: m.type, label: m.name, detail: intoDetail || 'module', ...into }, r });
  }
  for (const a of cat.assemblies) {
    if (owner !== undefined && !isEffect({ def: a.def })) continue;
    const r = rank(a.def.name, a.keywords, [a.def.name], 0);
    if (r >= 0) out.push({ hit: { kind: 'assembly', def: a.def, label: a.def.name, detail: intoDetail || `assembly · ${a.shelf}`, ...into }, r });
  }
  if (owner === undefined) for (const b of cat.blueprints) {
    const r = rank(b.name, b.chain, [b.name], -1);
    if (r >= 0) out.push({ hit: { kind: 'blueprint', blueprint: b, label: b.name, detail: `blueprint · ${b.chain}` }, r });
  }
  const hits = out.sort((a, b) => b.r - a.r).map((x) => x.hit);
  if (owner !== undefined) return hits;
  // a new effect: on the canvas first, then into each drawer
  const owners = drawers(p).map((d) => ownerKey(p, d));
  return hits.flatMap((h): Hit[] => {
    if ((h.kind !== 'module' && h.kind !== 'assembly') || !owners.length || !isEffect(h.kind === 'module' ? { type: h.type } : { def: h.def })) return [h];
    return [{ ...h, detail: `on the canvas · ${h.detail}` }, ...owners.map((o): Hit => ({ ...h, detail: `into ${drawerName(p, o)}`, into: o }))];
  });
}

// ---- wiring: what a dropped cable does on the canvas (editor.ts connectJacks), between two ports

/** connect two ports, whichever way round they come; cables into one input add up. Throws with the editor's reason */
export function wire(p: Patch, defs: Record<string, ModuleDef>, a: QPort, b: QPort): void {
  if (a.dir === b.dir) throw new Error('a cable joins a jack that sends to one that takes it');
  if (a.chain || b.chain) throw new Error((a.chain ?? b.chain)!);
  const [out, input] = a.dir === 'out' ? [a, b] : [b, a];
  const one = (from: Endpoint, to: Endpoint): void => {
    if (p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to))) return;
    const why = chainCableProblem(p, from, to);
    if (why) throw new Error(why);
    if (!connect(p, defs, from, to)) throw new Error(from.port === 'keys' ? keyRouteError(p, { from, to }) ?? 'Cannot connect these ports.' : 'Cannot connect these ports.');
  };
  for (const from of out.ends) {
    if (!input.param) {
      for (const to of input.ends) one(from, to);
      continue;
    }
    const { module, param } = input.param;
    const back = chainCableProblem(p, from, { module, port: '' });
    if (back) throw new Error(back);
    const to = connectParameter(p, defs, from, module, param);
    // a card row that sets several parameters: the cable reaches every one of them
    for (const t of tiedTo(p, module, param).slice(1)) connectParameter(p, defs, from, t.module, t.param);
    // the thumb of a merged assembly jack feeds the same group of inputs
    for (const asm of assembliesOf(p)) for (const t of findRef(asm, 'in', to.module, to.port)?.also ?? []) one(from, t);
  }
  // a new sound into the Output while an Output drawer sits in front of it: it joins the drawer's chain
  const od = outputDrawer(p);
  if (od && input.ends.some((e) => OUTPUT_SIDES.includes(e.port) && p.modules.find((m) => m.id === e.module)?.type === 'output')) rewire(p, od);
}

/** whether the cable `wire` would make between `a` and `b` is there already (every end of it): then it would change nothing */
export function alreadyWired(p: Patch, defs: Record<string, ModuleDef>, a: QPort, b: QPort): boolean {
  const q = structuredClone(p);
  try {
    wire(q, defs, a, b);
  } catch {
    return false;
  }
  return JSON.stringify(q) === JSON.stringify(p);
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

// ---- the radial menu's layout: rings round the card's name, the left half of each for the jacks that take a cable, the
// right half for the jacks that send

/** the most sectors one half of a ring holds before its jacks spill to the next ring out (labels stay legible) */
export const HALF_MAX = 8;
/** the most rings the menu shows; more page */
export const RINGS_MAX = 3;
/** the gap (radians) at the top and the bottom of the ring, between the halves */
export const HALF_GAP = 0.14;

/** a sector of a ring, by its angles (radians, clockwise from 3 o'clock, as on screen) and the angle of its label */
export interface Sector { a0: number; a1: number; mid: number }

/** `n` equal sectors over one half of a ring, from the top down: the left half runs down the left side, the right half
 *  down the right side; a gap at the top and the bottom keeps the halves apart */
export function halfSectors(n: number, side: 'left' | 'right'): Sector[] {
  const w = (Math.PI - 2 * HALF_GAP) / Math.max(1, n);
  return Array.from({ length: n }, (_, i) => {
    const [a0, a1] = side === 'right'
      ? [-Math.PI / 2 + HALF_GAP + i * w, -Math.PI / 2 + HALF_GAP + (i + 1) * w]
      : [(3 * Math.PI) / 2 - HALF_GAP - (i + 1) * w, (3 * Math.PI) / 2 - HALF_GAP - i * w];
    return { a0, a1, mid: (a0 + a1) / 2 };
  });
}

/** one half's items ring by ring, inside out: `items` fill the inner ring first, HALF_MAX each, and `next` (the row
 *  thumbs) start a ring of their own */
export function halfRings<T>(items: T[], next: T[] = []): T[][] {
  const chunk = (l: T[]): T[][] => Array.from({ length: Math.ceil(l.length / HALF_MAX) }, (_, i) => l.slice(i * HALF_MAX, (i + 1) * HALF_MAX));
  return [...chunk(items), ...chunk(next)];
}

/** a box on screen (client px): the canvas's visible area, between the sidebars and above the deck */
export interface Box { left: number; top: number; width: number; height: number }
/** where the radial menu and its panel (the list, the sliders) go: the disc's centre and scale, the panel's place */
export interface RadialPlace { cx: number; cy: number; scale: number; side: 'right' | 'left' | 'below'; panel: { x: number; y: number; w: number } }

/**
 * Place the radial menu (`size` across) and its panel (`panel.w` wide, `panel.h` tall) inside the canvas's visible area,
 * never over the sidebars or the deck. The disc stays in the middle with the panel on its right, else on its left; else
 * the two move together so they fit side by side; else the panel goes under the disc; else the disc shrinks beside the
 * panel. A disc taller than the area shrinks to fit it.
 */
export function radialPlace(view: Box, size: number, panel: { w: number; h: number }): RadialPlace {
  const M = 8, GAP = 12;
  const right = view.left + view.width - M, bottom = view.top + view.height - M;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const pw = Math.max(0, Math.min(panel.w, view.width - 2 * M));
  const panelY = (top: number): number => clamp(top, view.top + M, bottom - panel.h);
  const cx0 = view.left + view.width / 2, cy0 = view.top + view.height / 2;
  const k0 = Math.min(1, (view.height - 2 * M) / size);
  const s = size * k0, r = s / 2;
  if (cx0 + r + GAP + pw <= right) return { cx: cx0, cy: cy0, scale: k0, side: 'right', panel: { x: cx0 + r + GAP, y: panelY(cy0 - r), w: pw } };
  if (cx0 - r - GAP - pw >= view.left + M) return { cx: cx0, cy: cy0, scale: k0, side: 'left', panel: { x: cx0 - r - GAP - pw, y: panelY(cy0 - r), w: pw } };
  if (s + GAP + pw <= view.width - 2 * M) {
    const cx = view.left + (view.width - s - GAP - pw) / 2 + r;
    return { cx, cy: cy0, scale: k0, side: 'right', panel: { x: cx + r + GAP, y: panelY(cy0 - r), w: pw } };
  }
  if (size + GAP + panel.h <= view.height - 2 * M && size <= view.width - 2 * M) {
    const cy = view.top + (view.height - size - GAP - panel.h) / 2 + size / 2;
    return { cx: cx0, cy, scale: 1, side: 'below', panel: { x: clamp(cx0 - pw / 2, view.left + M, right - pw), y: cy + size / 2 + GAP, w: pw } };
  }
  // a narrow canvas: the disc shrinks so it fits beside the panel (to half its size at most), the panel narrows after that
  const k = Math.max(0.5, Math.min(k0, (view.width - 2 * M - GAP - pw) / size));
  const w = Math.min(pw, view.width - 2 * M - GAP - size * k);
  const cx = view.left + M + (size * k) / 2;
  return { cx, cy: cy0, scale: k, side: 'right', panel: { x: cx + (size * k) / 2 + GAP, y: panelY(cy0 - (size * k) / 2), w: Math.max(0, w) } };
}

/** an SVG path for the ring sector between radii r0 < r1 and angles a0 < a1 round (c, c) */
export function sectorPath(c: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number): string => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

// ---- the typed chain

export interface ChainItem {
  /** the module, assembly or card name as typed, without `+`, `#n` and the port */
  name: string;
  /** `+`: always a new one */
  fresh: boolean;
  /** what names this item within the text: the same tag is the same card (`lfo`, `lfo#2`, `delay@hera 4`) */
  tag: string;
  port?: string;
  /** `@hera 4`: the instrument (or `output`) whose FX drawer the effect sits in or goes into */
  at?: string;
}
export type Statement = { kind: 'chain'; items: ChainItem[] } | { kind: 'blueprint'; name: string };

/** a line that is a typed chain or a blueprint stamp rather than a search */
export const isChainText = (text: string): boolean => /[>;\n]/.test(text) || /^\s*bp\s+\S/i.test(text);

/**
 * Read a typed chain: statements split by `;` or new lines, each `a.port > b.port > c.port` or `bp <name>`. An item is a
 * name (a card in the patch, a module or an assembly), `+` in front for a new one, `#2` after it for a second one of the
 * same name, `@hera 4` after that for the FX drawer it sits in or goes into (`@output`: the Output drawer), `.port` last.
 * Returns the first error in words.
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
      const atSign = head.indexOf('@');
      const at = atSign >= 0 ? head.slice(atSign + 1).trim() : undefined;
      if (at === '') return { error: `"${part}": name the instrument after @, as in delay@hera 4, or @output` };
      const hash = /^(.*?)\s*#\s*(\d+)$/.exec((atSign >= 0 ? head.slice(0, atSign) : head).trim());
      const name = (hash ? hash[1] : atSign >= 0 ? head.slice(0, atSign) : head).trim();
      if (!name) return { error: `"${part}": a module name is missing` };
      const where = at ? `@${at.toLowerCase()}` : '';
      items.push({ name, fresh, tag: `${name.toLowerCase()}${where}#${hash ? Number(hash[2]) : 1}`, ...(port ? { port } : {}), ...(at ? { at } : {}) });
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
  const fallback = (): QPort | null => (held ? defaultPort(ports, held, cabled) : rankPorts(ports, null, cabled).find((q) => q.dir === want && !q.chain) ?? null);
  const title = cardTitle(p, defs, card);
  const list = (): string => ports.slice(0, 12).map((q) => q.name).join(', ') + (ports.length > 12 ? ', …' : '');
  // a typed name picks the port of that name (`out` is the port named out); `in` / `out` that the card has no port of
  // pick the likely one, as nothing typed does
  const found = typed ? matchPorts(ports, typed).filter((q) => !held || fit(held, q) >= 0) : [];
  if (found.length) return found[0];
  // (a drawer's chain jack: why not, and what to do instead)
  const chain = typed ? matchPorts(ports, typed).find((q) => q.chain) : undefined;
  if (chain) throw new ChainError(chain.chain);
  if (!typed || typed.toLowerCase() === want) {
    const d = fallback();
    if (!d) throw new ChainError(want === 'in' ? `${title} has no jack that takes ${held ? held.kind : 'a cable'}` : `${title} has no jack to cable from`);
    return d;
  }
  throw new ChainError(`${title} has no port "${typed}" that fits here${ports.length ? `. It has: ${list()}` : ''}`);
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
  const bound = new Map<string, { card?: Card; make?: { type: string } | { def: AssemblyDef }; into?: DrawerOwner }>();
  const fresh: string[] = [];
  for (const s of flat) for (const it of s.items) {
    const key = `${s.scope}:${it.tag}`;
    if (bound.has(key)) continue;
    const hits = search(p, defs, cat, `${it.fresh ? '+' : ''}${it.name}${it.at ? `@${it.at}` : ''}`).filter((h) => h.kind !== 'blueprint');
    const taken = new Set([...bound.values()].flatMap((b) => (b.card ? [cardKey(b.card)] : [])));
    // a card already named by another tag is not this one: `lfo#2` is a second LFO
    const hit = hits.find((h) => h.kind !== 'card' || !taken.has(cardKey(h.card)));
    if (!hit && it.at && findOwner(p, it.at) === undefined) throw new ChainError(`no instrument called "${it.at}" to hold the effect (or @output for the Output FX)`);
    if (!hit) throw new ChainError(it.at ? `no effect called "${it.name}" for ${drawerName(p, findOwner(p, it.at)!)}` : `no module, assembly or card called "${it.name}"`);
    if (hit.kind === 'card') bound.set(key, { card: hit.card });
    else if (hit.kind === 'module' || hit.kind === 'assembly') {
      bound.set(key, { make: hit.kind === 'module' ? { type: hit.type } : { def: hit.def }, ...(hit.into !== undefined ? { into: hit.into } : {}) });
      fresh.push(key);
    }
  }
  // make the new cards (an effect for a drawer goes into it there; the others are placed below), then place each beside a
  // card it is cabled to
  const made = new Map<string, { card: Card; size: Size }>();
  const freshCards: Card[] = [];
  for (const key of fresh) {
    const b = bound.get(key)!;
    const what = b.make!;
    if (b.into !== undefined) {
      b.card = addToDrawer(p, b.into, what);
      freshCards.push(b.card);
      continue;
    }
    const card: Card = 'type' in what
      ? { kind: 'module', id: addModule(p, defs[what.type], 0, 0).id }
      : { kind: 'assembly', id: insertAssembly(p, defs, what.def, 0, 0).id };
    b.card = card;
    freshCards.push(card);
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
  return { cards, fresh: freshCards, cables, links };
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
      // (an effect in a drawer by its instrument: `delay@hera 4`)
      const d = drawerOfCard(p, c);
      const owner = d && ownerKey(p, d);
      const at = owner === undefined ? '' : `@${owner === 'output' ? 'output' : ownTitle(p, { kind: 'assembly', id: owner }).toLowerCase()}`;
      tags.set(k, `${name}${n > 1 ? `#${n}` : ''}${at}`);
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
    // (a merged jack's several inner ends, such as a drawer effect's out L with its correction, reach a card once)
    if (sameCard(card, c) || out.some((o) => sameCard(o.card, card) && (o.port === end.port || port.ends.length > 1))) continue;
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
