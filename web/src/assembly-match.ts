// SPDX-License-Identifier: GPL-3.0-only
// Rebuilding a patch read from the FM-1 (patch-reader.ts) with the assemblies this browser knows (D-1355). The binary
// keeps, per device, the structure fingerprint of the card it was (structure.ts: its module types, the cables among them,
// the nesting and the card rows) and the modules it is made of. A definition of this browser with the same fingerprint is
// the same card: its modules are found among the device's (same types, the same cables among them, the card rows on the
// same parameters; the pages' rows pin them down where the definition's card repeats a module), and the card is made again
// from the definition (its nesting, card layout, labels, captions, ports and poly switch) around the device's own modules,
// which keep the values the binary holds. A module of the definition the device has not got (the device compile pass drops
// one that plays nothing) is put back with the definition's values. Each rebuilt card stays only while the patch still
// encodes to what the plain read gives (patch-reader.ts keeps): it never changes what the FM-1 plays.
import { FACTORY, loadLibrary } from './assemblies';
import {
  assembliesOf, assemblyById, descendants, insertAssembly, reconcile, rowTargets, toDef, type AssemblyDef, type AssemblyInst,
  type NestedDef, type ParamRef, type PortRef,
} from './assembly';
import { savedPatches } from './saved';
import { EXAMPLE_PRESETS, FM1_PRESETS } from './presets';
import { catalogEffectDef, EFFECT_CATALOG } from './fx-drawer';
import { DEFS } from './modules';
import { addModule, emptyPatch, rowDef, type Cable, type ModuleInst, type Patch } from './patch';
import { defStructure, withoutDrawers } from './structure';
import { POLY_ROW, POLY_ROW_PARAMS, deviceText } from './patchbin';
import type { BinPatch } from './bin-parse';

/** the editor's own definitions: the factory assemblies and the Library's effects as a drawer holds them, in each form a
 *  drawer has made them (the 1.27 one, the 1.26 Reverb with helpers, the legacy master bus conversion's) (built once) */
let catalog: AssemblyDef[] | null = null;
export function shippedLibrary(): AssemblyDef[] {
  catalog ??= [...FACTORY, ...EFFECT_CATALOG.flatMap((e) => [{}, { legacy: true }, { wet: 'helpers' as const }].map((form) => catalogEffectDef(e, form)))];
  return catalog;
}
/** the assemblies of the factory and example patches (built once) */
let shipped: AssemblyDef[] | null = null;
/** every assembly definition this browser has: the editor's own (shippedLibrary), the user's Library (their effects among
 *  them), and the assemblies inside the factory and example patches, the user's saved patches and `more` (the bank's own
 *  copies) */
export function browserLibrary(more: Patch[] = []): AssemblyDef[] {
  shipped ??= Object.values({ ...FM1_PRESETS, ...EXAMPLE_PRESETS }).flatMap((make) => patchDefs(make()));
  return [...shippedLibrary(), ...loadLibrary(), ...[...savedPatches().map((s) => s.patch), ...more].flatMap(patchDefs), ...shipped];
}

/** the definitions of every assembly in a patch (nested ones too: a card can be a device on its own elsewhere) */
export function patchDefs(p: Patch): AssemblyDef[] {
  return assembliesOf(p).flatMap((a) => {
    try {
      return a.drawer ? [] : [toDef(p, a)];
    } catch {
      return [];
    }
  });
}

/** a definition's nested cards as definitions of their own (a factory voice inside a bigger card) */
function nestedDefs(def: AssemblyDef): AssemblyDef[] {
  if (!def.assemblies?.length) return [];
  const p = emptyPatch();
  try {
    const a = insertAssembly(p, DEFS, def, 0, 0);
    return descendants(p, a).filter((d) => !d.drawer).map((d) => toDef(p, d));
  } catch {
    return [];
  }
}

/** each definition's fingerprint and its nested cards' (worked out once per definition: a library is made anew per read) */
const hashMemo = new WeakMap<AssemblyDef, { def: AssemblyDef; hash: string }[]>();
function hashed(d: AssemblyDef): { def: AssemblyDef; hash: string }[] {
  let out = hashMemo.get(d);
  if (out) return out;
  out = [d, ...nestedDefs(d)].flatMap((def) => {
    try {
      return [{ def, hash: defStructure(def) }];
    } catch {
      return [];   // (a definition that does not hash)
    }
  });
  hashMemo.set(d, out);
  return out;
}
/** the definitions by structure fingerprint */
function byStructure(library: AssemblyDef[]): Map<string, AssemblyDef[]> {
  const out = new Map<string, AssemblyDef[]>();
  for (const d of library) for (const { def, hash } of hashed(d)) out.set(hash, [...(out.get(hash) ?? []), def]);
  return out;
}

const STEPS_MAX = 200000;

/**
 * Where each of the device's modules is in definition `def` (its FX drawers left out): def local id → patch module id,
 * or null when they do not fit. `members`: the device's modules; `rows`: its pages' rows in order (patch ids).
 */
export function fitDefinition(p: Patch, members: number[], rows: { module: number; param: string }[], def: AssemblyDef): Map<number, number> | null {
  const base = withoutDrawers(def);
  if (members.length > base.modules.length) return null;
  const typeOf = new Map(p.modules.map((m) => [m.id, m.type]));
  const mset = new Set(members);
  const full = members.length === base.modules.length;
  const pc = p.cables.filter((c) => mset.has(c.from.module) && mset.has(c.to.module));
  const key = (a: number, ap: string, b: number, bp: string): string => `${a}.${ap}>${b}.${bp}`;
  const patchCables = new Map<string, number>();
  for (const c of pc) patchCables.set(key(c.from.module, c.from.port, c.to.module, c.to.port), (patchCables.get(key(c.from.module, c.from.port, c.to.module, c.to.port)) ?? 0) + 1);
  const defCables = new Map<string, number>();
  for (const c of base.cables) defCables.set(key(c.from.module, c.from.port, c.to.module, c.to.port), (defCables.get(key(c.from.module, c.from.port, c.to.module, c.to.port)) ?? 0) + 1);
  const nbr = (cs: Cable[], id: number): Cable[] => cs.filter((c) => c.from.module === id || c.to.module === id);
  // colors: type, then refined by the cables (both sides alike), used only when every module of the definition is there
  const refine = (ids: number[], type: (id: number) => string, cs: Cable[]): Map<number, string> => {
    let col = new Map(ids.map((id) => [id, type(id)]));
    for (let k = 0; k < 4; k++) {
      const next = new Map<number, string>();
      for (const id of ids) next.set(id, `${col.get(id)}|${nbr(cs, id).map((c) => (c.from.module === id ? `>${c.from.port}:${c.to.port}:${col.get(c.to.module)}` : `<${c.to.port}:${c.from.port}:${col.get(c.from.module)}`)).sort().join(',')}`);
      col = next;
    }
    return col;
  };
  const defType = new Map(base.modules.map((m) => [m.id, m.type]));
  const pCol = full ? refine(members, (id) => typeOf.get(id)!, pc) : new Map(members.map((id) => [id, typeOf.get(id)!]));
  const dCol = full ? refine(base.modules.map((m) => m.id), (id) => defType.get(id)!, base.cables) : new Map(base.modules.map((m) => [m.id, m.type]));
  const f = new Map<number, number>();   // patch id → def id
  const used = new Set<number>();
  // anchors: the definition's card rows in page order against the device's page rows
  const shown = (r: ParamRef, mods: AssemblyDef['modules']): boolean => {
    const m = mods.find((x) => x.id === r.module);
    const pd = m && rowDef(DEFS[m.type], r.param);
    return !!pd && !pd.onScreen && !pd.screen;
  };
  const defRows = [...base.params, ...(base.cards ?? []).flatMap((c) => base.assemblies?.find((n) => n.id === c)?.params ?? [])].filter((r) => shown(r, base.modules));
  let j = 0;
  for (const r of rows) {
    while (j < defRows.length && (defType.get(defRows[j].module) !== typeOf.get(r.module) || defRows[j].param !== r.param)) j++;
    if (j >= defRows.length) break;
    const d = defRows[j++].module;
    if (f.get(r.module) === undefined && !used.has(d) && pCol.get(r.module) === dCol.get(d)) { f.set(r.module, d); used.add(d); }
  }
  const consistent = (u: number, d: number): boolean => {
    for (const c of nbr(pc, u)) {
      const other = c.from.module === u ? c.to.module : c.from.module;
      const od = other === u ? d : f.get(other);
      if (od === undefined) continue;
      const k = c.from.module === u ? key(d, c.from.port, od, c.to.port) : key(od, c.from.port, d, c.to.port);
      if (!defCables.has(k)) return false;
    }
    // (a cable of the definition between two modules the device has must be in the patch too)
    for (const c of nbr(base.cables, d)) {
      const other = c.from.module === d ? c.to.module : c.from.module;
      const op = other === d ? u : [...f].find(([, x]) => x === other)?.[0];
      if (op === undefined) continue;
      const k = c.from.module === d ? key(u, c.from.port, op, c.to.port) : key(op, c.from.port, u, c.to.port);
      if (!patchCables.has(k)) return false;
    }
    return true;
  };
  for (const [u, d] of f) if (!consistent(u, d)) { f.delete(u); used.delete(d); }
  // the rest: backtracking, most constrained first, along the cables
  const order: number[] = [];
  const left = new Set(members.filter((id) => !f.has(id)));
  while (left.size) {
    let pick = [...left].find((id) => nbr(pc, id).some((c) => f.has(c.from.module) || f.has(c.to.module) || order.includes(c.from.module) || order.includes(c.to.module)));
    pick ??= [...left][0];
    order.push(pick);
    left.delete(pick);
  }
  let steps = 0;
  const go = (k: number): boolean => {
    if (k === order.length) return true;
    if (++steps > STEPS_MAX) return false;
    const u = order[k];
    for (const m of base.modules) {
      if (used.has(m.id) || dCol.get(m.id) !== pCol.get(u)) continue;
      if (!consistent(u, m.id)) continue;
      f.set(u, m.id);
      used.add(m.id);
      if (go(k + 1)) return true;
      f.delete(u);
      used.delete(m.id);
    }
    return false;
  };
  if (!go(0)) return null;
  return new Map([...f].map(([u, d]) => [d, u]));
}

/** the card `def` made again around the patch's modules (`fit`: def local id → patch id): its assemblies with their layout,
 *  the definition's modules the patch has not got added with their values; `label` the device's name, `preset` its preset.
 *  Returns the top card. Drawers are left out (the FX rack rebuilds them). */
export function instantiate(p: Patch, def: AssemblyDef, fit: Map<number, number>, at: { x: number; y: number }, label: string, preset?: string): AssemblyInst {
  const base = withoutDrawers(def);
  const ids = new Map(fit);
  for (const src of base.modules) {
    const m0 = p.modules.find((m) => m.id === ids.get(src.id));
    if (m0) { Object.assign(m0, { x: at.x + src.x, y: at.y + 2000 + src.y }); continue; }
    const m = addModule(p, DEFS[src.type], at.x + src.x, at.y + 2000 + src.y);
    m.params = { ...m.params, ...structuredClone(src.params) };
    if (src.att) m.att = [...src.att];
    if (src.map) m.map = structuredClone(src.map);
    if (src.bypass) m.bypass = true;
    ids.set(src.id, m.id);
  }
  for (const c of base.cables) {
    if (fit.has(c.from.module) && fit.has(c.to.module)) continue;
    p.cables.push({ from: { module: ids.get(c.from.module)!, port: c.from.port }, to: { module: ids.get(c.to.module)!, port: c.to.port }, ...(c.side ? { side: c.side } : {}) });
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: ids.get(r.module)! });
  const port = (r: PortRef): PortRef => ({ ...remap(r), ...(r.also ? { also: r.also.map(remap) } : {}) });
  const row = (r: ParamRef): ParamRef => {
    const n: ParamRef = { ...remap(r) };
    if (r.also) n.also = r.also.map(remap);
    if (r.names) n.names = [...r.names];
    if (r.copies) n.copies = { ...r.copies };
    return n;
  };
  let next = Math.max(0, ...assembliesOf(p).map((a) => a.id)) + 1;
  const nested = base.assemblies ?? [];
  const asmId = new Map(nested.map((n) => [n.id, next++]));
  const claimed = new Set(nested.flatMap((n) => n.modules));
  const make = (n: NestedDef | AssemblyDef, id: number, mods: number[], top: boolean): AssemblyInst => {
    const a: AssemblyInst = {
      v: 1, id, name: n.name, label: top ? label : (n as NestedDef).label || n.name, x: top ? at.x : at.x + (n as NestedDef).x, y: top ? at.y : at.y + 2000 + (n as NestedDef).y,
      open: top ? false : (n as NestedDef).open, modules: mods.map((x) => ids.get(x)!), inputs: n.inputs.map(port), outputs: n.outputs.map(port), params: n.params.map(row),
    };
    if (n.size) a.size = { ...n.size };
    if (n.frameSize) a.frameSize = { ...n.frameSize };
    if (n.heads?.length) a.heads = n.heads.map(remap);
    if (n.children?.length) a.children = n.children.filter((c) => asmId.has(c)).map((c) => asmId.get(c)!);
    if (n.poly) a.poly = structuredClone(n.poly);
    if (n.chain) a.chain = { ins: [...n.chain.ins], outs: [...n.chain.outs], ...(n.chain.helpers?.length ? { helpers: n.chain.helpers.map((h) => ids.get(h)!) } : {}) };
    if (n.cards?.length) a.cards = n.cards.filter((c) => asmId.has(c)).map((c) => asmId.get(c)!);
    if ((n as AssemblyDef).fxMode) a.fxMode = (n as AssemblyDef).fxMode;
    return a;
  };
  const made = nested.map((n) => make(n, asmId.get(n.id)!, n.modules, false));
  const top = make(base, next++, base.modules.filter((m) => !claimed.has(m.id)).map((m) => m.id), true);
  if (preset) top.preset = preset;
  p.assemblies = [...assembliesOf(p), ...made, top];
  for (const n of [...made].reverse()) reconcile(p, n, DEFS);
  reconcile(p, top, DEFS);
  return top;
}

/** the patch with its cards rebuilt from `library` where a definition fits and `keeps` holds (see the top of this file);
 *  `keys`: the editor's device key of each of the binary's devices (patch-reader.ts plainPatch) */
export function matchAssemblies(plain: Patch, keys: string[], b: BinPatch, library: AssemblyDef[], keeps: (p: Patch) => boolean): { patch: Patch; recognised: number } {
  let cur = plain, recognised = 0;
  if (!library.length) return { patch: cur, recognised };
  const index = byStructure(library);
  b.devices.forEach((d, k) => {
    if (d.kind !== 1 || keys[k]?.[0] !== 'a') return;
    const h = (b.extras[k]?.structure ?? 0).toString(16).padStart(8, '0');
    const defs = index.get(h);
    if (!defs?.length) return;
    for (const def of defs) {
      const p = structuredClone(cur);
      const card = assemblyById(p, Number(keys[k].slice(1)));
      if (!card) return;
      const members = deviceMembers(p, card);
      const rows = d.pages.flatMap((pg) => pg.rows).flatMap((r) => {
        const m = p.modules.find((x) => x.id === rowModule(p, card, r.module, b));
        if (!m) return [];
        const param = m.type === 'alloc' ? (r.par & POLY_ROW ? POLY_ROW_PARAMS[r.par & 0x3f] : undefined) : DEFS[m.type].params[r.par]?.name;
        return param ? [{ module: m.id, param }] : [];
      });
      const fit = fitDefinition(p, members, rows, def);
      if (!fit) continue;
      const top = replaceCard(p, card, def, fit, d, b, k);
      retarget(p, card.id, top.id);
      if (!keeps(p)) continue;
      cur = p;
      keys[k] = `a${top.id}`;
      recognised++;
      return;
    }
  });
  return { patch: cur, recognised };
}

/** a flat card's modules, its nested poly assembly's too */
const deviceMembers = (p: Patch, a: AssemblyInst): number[] => [...a.modules, ...descendants(p, a).flatMap((x) => x.modules)];
/** the patch id of the module a page row of the binary names (module index i is id i + 1, or the Voicing it was merged into) */
const rowModule = (p: Patch, _card: AssemblyInst, i: number, b: BinPatch): number => {
  const id = i + 1;
  if (p.modules.some((m) => m.id === id)) return id;
  // (a Part merged into its Voicing: the twin with the same group settings, patch-reader.ts plainPatch)
  const g = b.modules[i]?.group;
  const twin = b.modules.findIndex((m, j) => m.type === 'part' && j < i && b.groups[m.group - 1] && JSON.stringify({ ...b.groups[m.group - 1], flaws: 0 }) === JSON.stringify({ ...b.groups[g - 1], flaws: 0 }));
  return twin + 1;
};

/** replace flat card `card` with the definition's, keeping its place, label, preset, the binary's labels where they differ
 *  and the poly groups' flaws */
function replaceCard(p: Patch, card: AssemblyInst, def: AssemblyDef, fit: Map<number, number>, d: BinPatch['devices'][number], b: BinPatch, k: number): AssemblyInst {
  const flat = new Set([card.id, ...descendants(p, card).map((x) => x.id)]);
  const flaws = descendants(p, card).concat(card).find((x) => x.poly)?.poly;
  p.assemblies = assembliesOf(p).filter((a) => !flat.has(a.id));
  for (const a of assembliesOf(p)) if (a.children) a.children = a.children.map((c) => (c === card.id ? -1 : c)).filter((c) => c >= 0);
  const label = deviceText(def.name) === d.name ? def.name : d.name;
  const top = instantiate(p, def, fit, { x: card.x, y: card.y }, label, b.extras[k]?.preset || undefined);
  // the poly switch carries the voice cards' flaws the binary holds
  for (const a of [top, ...descendants(p, top)]) if (a.poly) a.poly = flaws ? structuredClone(flaws) : {};
  // a row label or heading the instance has of its own (the binary's, where the definition's reads otherwise)
  const pageRows = d.pages.flatMap((pg) => pg.rows.map((r, i) => ({ r, pg, first: i === 0 })));
  const cards = [top, ...descendants(p, top).filter((x) => top.cards?.includes(x.id))];
  for (const { r, pg, first } of pageRows) {
    const id = rowModule(p, card, r.module, b);
    const m = p.modules.find((x) => x.id === id);
    if (!m) continue;
    const param = m.type === 'alloc' ? POLY_ROW_PARAMS[r.par & 0x3f] : DEFS[m.type].params[r.par]?.name;
    const ref = cards.flatMap((a) => a.params).find((x) => rowTargets(x)[0].module === id && x.param === param);
    if (!ref) continue;
    // (a counted binary writes a label that is its parameter's name, any case, empty)
    if (r.label ? deviceText(ref.label) !== r.label : deviceText(ref.label).toUpperCase() !== (param ?? '').toUpperCase()) ref.label = r.label || (param ?? '');
    if (r.par & POLY_ROW) {
      if (r.top) ref.top = r.top;
      else delete ref.top;
    }
    const title = pg.name || d.name;
    if (first && pg.part === 0 && ref.head !== undefined && deviceText(ref.head) !== title) ref.head = title;
  }
  return top;
}

/** the panel's references to card `from` (a Toggle's target, a Page button's pages) moved to card `to` */
function retarget(p: Patch, from: number, to: number): void {
  const panel = p.modules.find((m) => m.type === 'fm1')?.panel;
  for (const t of Object.values(panel?.targets ?? {})) if ('asm' in t && t.asm === from) t.asm = to;
  for (const list of Object.values(panel?.pages ?? {})) for (const x of list) if (x.device === `a${from}`) x.device = `a${to}`;
}

/** the audio ports of a card's list, in order */
const audioRefs = (p: Patch, list: PortRef[], dir: 'in' | 'out'): number[] => list.flatMap((r, i) => {
  const m = p.modules.find((x) => x.id === r.module);
  const q = m && (dir === 'in' ? DEFS[m.type].inputs : DEFS[m.type].outputs).find((x) => x.name === r.port);
  return q?.kind === 'audio' ? [i] : [];
});

/**
 * The FX rack the binary lists made again (format 66, #1214): each listed effect's card gets its stereo chain ports (a
 * definition's when it was rebuilt from one, else its first two audio ports, the cables decide nothing the binary holds),
 * and each FX drawer becomes a drawer holding its effects in order, an instrument's inside the instrument's card (its taps:
 * the instrument's ports that feed the first effect, else those cabled to the Output), the Output drawer on its own.
 */
export function rebuildRack(p: Patch, keys: string[], b: BinPatch): void {
  if (!b.rack) return;
  const card = (k: number): AssemblyInst | undefined => (keys[k]?.[0] === 'a' ? assemblyById(p, Number(keys[k].slice(1))) : undefined);
  const effects = b.rack.effects.map((e) => card(e.device));
  for (const e of effects) {
    if (!e || e.chain) continue;
    const ins = audioRefs(p, e.inputs, 'in'), outs = audioRefs(p, e.outputs, 'out');
    if (!ins.length || !outs.length) continue;
    e.chain = { ins: [ins[0], ins[1] ?? ins[0]], outs: [outs[0], outs[1] ?? outs[0]] };
  }
  let next = Math.max(0, ...assembliesOf(p).map((a) => a.id)) + 1;
  const output = p.modules.find((m) => m.type === 'output');
  for (const dr of b.rack.drawers) {
    const list = effects.slice(dr.first, dr.first + dr.count).filter((e): e is AssemblyInst => !!e?.chain);
    const owner = dr.owner === 0xff ? undefined : card(dr.owner);
    if (dr.owner !== 0xff && !owner) continue;
    const d: AssemblyInst = { v: 1, id: next++, name: owner ? 'FX' : 'Output FX', label: owner ? `${owner.label} FX` : 'Output FX', x: (owner ?? output)?.x ?? 0, y: (owner ?? output)?.y ?? 0, open: false, modules: [], inputs: [], outputs: [], params: [], drawer: {} };
    if (list.length) d.children = list.map((e) => e.id);
    if (owner) {
      const members = new Set(deviceMembers(p, owner));
      const first = list[0];
      const feed = (ch: 0 | 1): PortRef | undefined => {
        const into = first ? targetsOfRef(first.inputs[first.chain!.ins[ch]]) : [];
        const c = p.cables.find((x) => members.has(x.from.module) && into.some((t) => t.module === x.to.module && t.port === x.to.port))
          ?? p.cables.find((x) => members.has(x.from.module) && x.to.module === output?.id && x.to.port === (ch ? 'r' : 'l'));
        return c && owner.outputs.find((r) => targetsOfRef(r).some((t) => t.module === c.from.module && t.port === c.from.port));
      };
      const audio = audioRefs(p, owner.outputs, 'out').map((i) => owner.outputs[i]);
      const l = feed(0) ?? audio[0], r = feed(1) ?? (feed(0) ? l : audio[1] ?? audio[0]);
      if (l && r) d.drawer = { taps: [{ module: l.module, port: l.port }, { module: r.module, port: r.port }] };
      owner.children = [...(owner.children ?? []), d.id];
    }
    p.assemblies = [...assembliesOf(p), d];
  }
}
const targetsOfRef = (r: PortRef | undefined): { module: number; port: string }[] => (r ? [{ module: r.module, port: r.port }, ...(r.also ?? [])] : []);

