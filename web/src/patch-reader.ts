// SPDX-License-Identifier: GPL-3.0-only
// A patch read back from its binary (the FM-1 sends a slot's bytes since 1.26: SLOT_GET, device.ts readSlotBin): the
// inverse of patchbin.ts encodePatch. bin-parse.ts reads the sections; this file turns them into a patch the editor opens.
//
// What the binary carries: the sound whole (every module the FM-1 runs with its values, bypass, stereo mode, morph B side,
// matrix and attenuverters, input routes and macro ranges; every cable with its side; the poly groups with their voice
// settings and flaws), the Steps tracks' names, notes, patterns, songs, P-locks and pattern links, the Drum maps' row names
// and keys, the panel (button kinds, switches, labels, Toggle targets, Page lists), the MIDI learn mappings, the FX rack,
// and the FM-1's device pages: each device's name, pages, rows (labels, the further parameters a row sets, a Selector's
// position names, a VOICES row's top), the modules it is made of, its card rows in their canonical order, its structure
// fingerprint (structure.ts) and the preset it was set to.
// What it drops (the editor's own, D-1356): canvas positions and the view, assembly nesting below a device, the cards'
// layout (columns, spans, copies, headings with no rows, embedded cards), exposed ports, captions and blurbs, patch notes
// and comment boxes, Scope modules, modules the device compile pass removed (dead ones: they play nothing), the keys cables
// (the poly groups and the Drum map records say where keys go), Voicing modules (each is a Part per poly group), the
// morph's name and the 303 pattern names; a pattern linked to the FM-1's store is in the store, not in the binary.
//
// So the reader rebuilds the sound exactly and the structure from hints (D-1355): each device of the pages becomes a card
// (an assembly made of its members, its rows from its pages) or a plain module, placed in the device order; each poly
// group becomes a poly assembly fed by a Voicing; then assembly-match.ts swaps each card for the assembly definition this
// browser has with the same structure fingerprint, when one does, and makes the FX drawers again. Each step is kept only
// while every section the binary holds still encodes as it did (readFromFm1): matching never changes what the FM-1 plays.
// A binary of formats 55..65 with the old master FX bus comes back as FX drawers, as the editor opens such a patch's JSON
// (fx-drawer.ts restoreLegacyBus), and is written back as format 66's FX rack.
import { DEFS, DRUM_MAP_DEFAULT, PANEL_BUTTONS } from './modules';
import {
  defaultMap, defaultParams, trackName, validatePatch, type Cable, type ModuleInst, type Patch, type ParamDef, type Source,
} from './patch';
import { assembliesOf, boundary, type AssemblyDef, type AssemblyInst, type ParamRef, type PortRef } from './assembly';
import { toggleTargets } from './buttons';
import { encodePatch, mapSource, POLY_ROW, POLY_ROW_PARAMS, Q, toQ16 } from './patchbin';
import { parseBinary, type BinGroup, type BinPatch } from './bin-parse';
import { wordShort, wordsNotes, type Pattern, type StepLock } from './track';
import { applyPayload, fnv, FNV0 } from './pattern-store';
import { SHARED_TYPES } from './patch';
import { ALLOC } from './poly';
import { matchAssemblies, rebuildRack } from './assembly-match';
import { restoreLegacyBus } from './fx-drawer';
import type { MidiBinding } from './midi-learn';

export { linkedIds } from './bin-parse';

/** a patch read from the FM-1 (readFromFm1) */
export interface FromFm1 {
  patch: Patch;
  /** the binary's assembly devices (cards) */
  devices: number;
  /** of those, rebuilt from an assembly definition this browser has */
  recognised: number;
  /** the patch encodes back to the bytes read */
  exact: boolean;
}

/** where each top-level card goes on the canvas: columns of three, so the reading order (pages.ts devicesOf) is the device
 *  order the binary lists */
const COLUMN = 420, ROW = 640, PER_COLUMN = 3;
export const placeAt = (k: number): { x: number; y: number } => ({ x: 40 + COLUMN * Math.floor(k / PER_COLUMN), y: 40 + ROW * (k % PER_COLUMN) });

/** a value from its Q16.16; `pd`'s default exactly when it is the default as written (0.3 is 19661 / 65536 in the binary:
 *  the patch shows 0.3, as the one it was written from did, and writes the same bytes) */
const fromQ = (raw: number, pd?: ParamDef): number => (pd && raw === toQ16(pd.default) ? pd.default : raw / Q);

/** the sections as a patch, every card plain (see the top of this file); `name` the patch's name */
export function plainPatch(b: BinPatch, name: string): { patch: Patch; keys: string[] } {
  const id = (i: number): number => i + 1;
  const isPart = (i: number): boolean => b.modules[i].type === 'part';
  // (a Voicing driving several poly groups is a Part in each; deviceView appends the later ones after every other module)
  const firstPart = b.modules.findIndex((m, i) => isPart(i) && b.modules.slice(i).every((x) => x.type === 'part'));
  const allocOf = b.modules.map((_, i) => i);
  const cfgKey = (g: BinGroup): string => JSON.stringify({ ...g, flaws: undefined });
  if (firstPart >= 0) for (let i = firstPart; i < b.modules.length; i++) {
    const g = b.groups[b.modules[i].group - 1];
    if (!g) continue;
    const twin = b.modules.findIndex((m, j) => j < firstPart && m.type === 'part' && m.group && cfgKey(b.groups[m.group - 1]) === cfgKey(g));
    if (twin >= 0) allocOf[i] = twin;
  }
  const at = (i: number): number => id(allocOf[i]);
  const modules: ModuleInst[] = [];
  b.modules.forEach((bm, i) => {
    if (allocOf[i] !== i) return;
    const type = bm.type === 'part' ? ALLOC : bm.type;
    const def = DEFS[type];
    const m: ModuleInst = { id: id(i), type, x: 0, y: 0, params: defaultParams(def) };
    if (bm.type === 'part') {
      const g = bm.group ? b.groups[bm.group - 1] : undefined;
      m.params.voices = g ? g.parts : 1;
      if (g) Object.assign(m.params, { assign: g.assign, legato: g.legato, priority: g.priority, unison: g.unison ? (g.unisonShare ? 2 : 1) : 0, stack: g.unisonParts, steal: g.steal ? 1 : 0, channel: g.channel, low: g.low, high: g.high });
    } else {
      const ps = def.params;
      bm.params.forEach((raw, j) => { m.params[ps[j].name] = fromQ(raw, ps[j]); });
      if (bm.b) {
        m.paramsB = { ...m.params };
        bm.b.forEach((raw, j) => { m.paramsB![ps[j].name] = fromQ(raw, ps[j]); });
      }
    }
    if (bm.bypass) m.bypass = true;
    if (bm.stereo) m.stereo = true;
    if (def.paramInputs) {
      m.att = bm.att ? [fromQ(bm.att[0]), fromQ(bm.att[1])] : [1, 1];
      // (the macro ranges' order follows the map's, patch.ts fixMatrix: the ranged names first, as the binary lists them)
      const dm = defaultMap(def);
      const map = {} as Record<Source, string[]>;
      (['p1', 'p2'] as const).forEach((s, pin) => {
        const mask = s === 'p1' ? bm.p1 : bm.p2;
        const names = mask === undefined ? dm[s] : def.params.filter((_, k) => mask & (1 << k)).map((q) => q.name);
        const ranged = b.ranges.filter((r) => r.module === i && r.pin === pin).map((r) => def.params[r.par]?.name).filter((n) => n && names.includes(n));
        map[s] = [...ranged, ...names.filter((n) => !ranged.includes(n))];
      });
      m.map = map;
    }
    if (type === 'steps') {
      const s = String.fromCharCode(...bm.data.filter((c) => c));
      if (s) m.name = s;
    }
    modules.push(m);
  });
  const byId = new Map(modules.map((m) => [m.id, m]));
  const mod = (i: number): ModuleInst => byId.get(at(i))!;
  const portName = (i: number, k: number, dir: 'in' | 'out'): string => {
    const d = DEFS[b.modules[i].type];
    return (dir === 'in' ? d.inputs : d.outputs)[k]?.name ?? '';
  };
  const cables: Cable[] = [];
  const add = (c: Cable): void => {
    if (!cables.some((x) => x.from.module === c.from.module && x.from.port === c.from.port && x.to.module === c.to.module && x.to.port === c.to.port)) cables.push(c);
  };
  for (const c of b.cables) add({ from: { module: at(c.from), port: portName(c.from, c.fromPort, 'out') }, to: { module: at(c.to), port: portName(c.to, c.toPort, 'in') }, ...(c.side ? { side: c.side } : {}) });
  // the keys cables (deviceView drops them): each Voicing's from what plays its group, a Drum map's from its record, an
  // Arpeggiator's or Harmonizer's with none from Main
  const main = b.modules.findIndex((m) => m.type === 'fm1');
  const keysFrom = (i: number): Cable['from'] => ({ module: i < 0 ? id(main) : at(i), port: 'keys' });
  if (main >= 0) {
    b.modules.forEach((bm, i) => {
      if (bm.type === 'part') {
        const g = bm.group ? b.groups[bm.group - 1] : undefined;
        add({ from: keysFrom(g ? g.src : -1), to: { module: at(i), port: 'keys' } });
      }
      if (bm.type === 'drummap' && bm.data[0]) add({ from: keysFrom(bm.data[0] === 1 ? -1 : bm.data[0] - 2), to: { module: id(i), port: 'keys' } });
    });
    b.modules.forEach((bm, i) => {
      if ((bm.type === 'arp' || bm.type === 'harm') && !cables.some((c) => c.to.module === id(i) && c.to.port === 'keys')) add({ from: keysFrom(-1), to: { module: id(i), port: 'keys' } });
    });
  }
  // a Part whose cables all went to modules the compile pass dropped: deviceView drops a Voicing that feeds nothing, so it
  // feeds a VCA nobody hears (the pass drops that one again: the binary stays as read)
  const grouped = new Set(b.modules.flatMap((m) => (m.type !== 'part' && m.group ? [m.group] : [])));
  for (const m of [...modules]) {
    const part = b.modules[m.id - 1];
    if (m.type !== ALLOC || cables.some((c) => c.from.module === m.id) || (part.group && grouped.has(part.group))) continue;
    const sink: ModuleInst = { id: Math.max(...modules.map((x) => x.id)) + 1, type: 'vca', x: 0, y: 0, params: defaultParams(DEFS.vca) };
    modules.push(sink);
    byId.set(sink.id, sink);
    add({ from: { module: m.id, port: 'gate' }, to: { module: sink.id, port: 'cv' } });
  }
  const p: Patch = { version: 2, name, modules, cables, assemblies: [] };
  const asms: AssemblyInst[] = p.assemblies!;
  let nextAsm = 1;
  const newAsm = (label: string, members: number[], params: ParamRef[] = []): AssemblyInst => {
    const io = boundary(p, members);
    const ref = (t: { module: number; port: string }): PortRef => ({ module: t.module, port: t.port, label: t.port });
    const a: AssemblyInst = { v: 1, id: nextAsm++, name: label, label, x: 0, y: 0, open: false, modules: members, inputs: io.inputs.map(ref), outputs: io.outputs.map(ref), params };
    asms.push(a);
    return a;
  };
  // the device pages: each card an assembly of its members, its rows from its pages
  const devKeys: string[] = [];
  const claimed = new Set<number>();
  const viewOf = (type: string): string | undefined => DEFS[type].views?.[0]?.name;
  const paramOf = (i: number, par: number): string | undefined =>
    b.modules[i]?.type === 'part' ? (par & POLY_ROW ? POLY_ROW_PARAMS[par & 0x3f] : undefined) : DEFS[b.modules[i]?.type ?? '']?.params[par]?.name;
  const cards: { k: number; a: AssemblyInst }[] = [];
  b.devices.forEach((d, k) => {
    if (d.kind !== 1) {
      const m = mod(d.module);
      if (d.kind === 2 && m) m.name = d.name;
      devKeys.push(`m${m?.id}`);
      return;
    }
    const members = [...new Set((b.extras[k]?.members ?? []).map(at))].filter((x) => !claimed.has(x));
    members.forEach((x) => claimed.add(x));
    const params: ParamRef[] = [];
    d.pages.forEach((pg, j) => {
      const title = pg.name || d.name;
      const first: Partial<ParamRef> = {};
      // (a section's first page starts at a heading, the first section's but when it is the device's name; its other pages
      // at a group break)
      if (pg.part === 0 && (j > 0 || title !== d.name)) first.head = title;
      else if (j > 0) first.group = true;
      const items: ParamRef[] = [];
      const view = pg.display >= 0 ? viewOf(b.modules[pg.display]?.type ?? '') : undefined;
      if (view) items.push({ module: at(pg.display), param: view, label: '' });
      for (const r of pg.rows) {
        const param = paramOf(r.module, r.par);
        if (!param) continue;
        const ref: ParamRef = { module: at(r.module), param, label: r.label || param };
        const also = r.also.flatMap(([mi, q]) => { const n = paramOf(mi, q); return n ? [{ module: at(mi), param: n }] : []; });
        if (also.length) ref.also = also;
        if (r.names.length) ref.names = r.names;
        if (r.top) ref.top = r.top;
        items.push(ref);
      }
      if (items.length) Object.assign(items[0], first);
      params.push(...items);
    });
    // (card rows the pages do not show: parameters set from a module's screen)
    for (const [mi, q] of b.extras[k]?.rows ?? []) {
      if (mi === 0xff) continue;
      const param = paramOf(mi, q);
      if (param && !params.some((r) => r.module === at(mi) && r.param === param)) params.push({ module: at(mi), param, label: param });
    }
    const a = newAsm(d.name, members, params);
    if (b.extras[k]?.preset) a.preset = b.extras[k].preset;
    cards.push({ k, a });
    devKeys.push(`a${a.id}`);
  });
  // the poly groups: each a poly assembly (the card itself when it holds nothing else), fed by its Voicing
  b.groups.forEach((g, gi) => {
    const group = b.modules.flatMap((m, i) => (m.group === gi + 1 && m.type !== 'part' ? [at(i)] : []));
    if (!group.length) return;
    const flaws = g.flaws.slice();
    while (flaws.length && JSON.stringify(flaws[flaws.length - 1]) === JSON.stringify({ detune: 0, drift: 0, bright: 0, env: 0, level: 100 })) flaws.pop();
    const poly = flaws.length ? { flaws } : {};
    const card = cards.find((c) => group.every((x) => c.a.modules.includes(x)));
    if (card) {
      const rest = card.a.modules.filter((x) => !group.includes(x));
      if (rest.every((x) => byId.get(x)!.type === ALLOC || SHARED_TYPES.has(byId.get(x)!.type))) {
        card.a.poly = poly;
        return;
      }
      card.a.modules = rest;
      const inner = newAsm(`${card.a.label} voices`, group);
      inner.poly = poly;
      card.a.children = [...(card.a.children ?? []), inner.id];
      return;
    }
    group.forEach((x) => claimed.add(x));
    newAsm('voices', group).poly = poly;
  });
  // (poly assemblies go first in the overlay: their order is the poly groups')
  asms.sort((u, v) => Number(!u.poly) - Number(!v.poly));
  // modules on no page that would be devices if they stood alone go into a card with no rows (it is no device either)
  const inAsm = new Set(asms.flatMap((a) => a.modules));
  const shown = new Set(b.devices.filter((d) => d.kind !== 1).map((d) => at(d.module)));
  const hidden = modules.filter((m) => !inAsm.has(m.id) && !shown.has(m.id) && m.type !== 'part' && Object.keys(m.params).length);
  if (hidden.length) newAsm('not on the FM-1', hidden.map((m) => m.id));
  // positions: the devices in order, column by column; the cards' members below their card
  const top = new Set(asms.filter((a) => !asms.some((x) => x.children?.includes(a.id))).map((a) => a.id));
  let k = 0;
  const placed = new Set<number>();
  for (const key of devKeys) {
    const at = placeAt(k++);
    if (key[0] === 'm') { const m = byId.get(Number(key.slice(1))); if (m) { m.x = at.x; m.y = at.y; placed.add(m.id); } continue; }
    const a = asms.find((x) => x.id === Number(key.slice(1)))!;
    a.x = at.x;
    a.y = at.y;
  }
  for (const a of asms) if (top.has(a.id) && !devKeys.includes(`a${a.id}`)) Object.assign(a, placeAt(k++));
  for (const m of modules) if (!placed.has(m.id) && !inAsm.has(m.id)) Object.assign(m, placeAt(k++));
  for (const a of asms) {
    const host = top.has(a.id) ? a : asms.find((x) => x.children?.includes(a.id)) ?? a;
    a.modules.forEach((mid, i) => Object.assign(byId.get(mid)!, { x: host.x + (i % 4) * 280, y: host.y + 2000 + Math.floor(i / 4) * 320 }));
    if (!top.has(a.id)) Object.assign(a, { x: host.x, y: host.y + 1600 });
  }
  // the panel and its buttons
  const mainMod = main >= 0 ? byId.get(id(main)) : undefined;
  if (mainMod) {
    const panel: NonNullable<ModuleInst['panel']> = {};
    const kinds = b.buttons?.kinds ?? [];
    const KINDS = ['gate', 'nothing', 'bypass', 'page'] as const;
    const toggle = PANEL_BUTTONS.filter((_, i) => b.panel.switches & (1 << i));
    if (toggle.length) panel.toggle = toggle;
    const on = PANEL_BUTTONS.filter((bt, i) => b.panel.on & (1 << i) && KINDS[kinds[i] ?? 0] !== 'bypass');
    if (on.length) panel.on = on;
    const labels = Object.fromEntries(PANEL_BUTTONS.map((bt, i) => [bt, b.panel.labels[i]]).filter(([, s]) => s));
    if (Object.keys(labels).length) panel.labels = labels;
    PANEL_BUTTONS.forEach((bt, i) => {
      const kind = KINDS[kinds[i] ?? 0];
      if (kind === 'gate') return;
      (panel.kinds ??= {})[bt] = kind;
      if (kind === 'bypass') {
        const ids = (b.buttons!.toggles.get(bt) ?? []).map(at);
        const asm = ids.length > 1 ? asms.find((a) => !a.poly && a.params.length && a.modules.length === ids.length && ids.every((x) => a.modules.includes(x))) : undefined;
        if (asm) (panel.targets ??= {})[bt] = { asm: asm.id };
        else if (ids.length) (panel.targets ??= {})[bt] = { module: ids[0] };
      }
      if (kind === 'page') (panel.pages ??= {})[bt] = (b.buttons!.pages.get(bt) ?? []).flatMap(([d, pg]) => (devKeys[d] ? [{ device: devKeys[d], page: pg }] : []));
    });
    mainMod.panel = panel;
    // the transport: the selected pattern, the song playing, the songs
    if (b.patterns && (b.patterns.pattern || b.patterns.song || b.patterns.songs.length)) {
      mainMod.seq = {};
      if (b.patterns.pattern) mainMod.seq.pattern = b.patterns.pattern;
      if (b.patterns.song) mainMod.seq.song = b.patterns.song;
      if (b.patterns.songs.length) mainMod.seq.songs = b.patterns.songs;
    }
  }
  // the tracks: notes, patterns, P-locks, factory pattern origins; the Drum maps' row names
  for (const [i, words] of b.notes) { const m = mod(i); if (m) m.notes = wordsNotes(words); }
  for (const t of b.patterns?.tracks ?? []) {
    const m = mod(t.module);
    if (!m) continue;
    m.patterns = t.patterns.map((x): Pattern | null => {
      if (!x) return null;
      const pat: Pattern = {};
      const notes = x.short ? x.words.map(wordShort) : wordsNotes(x.words);
      if (notes.length) pat.notes = notes;
      if (x.len) pat.len = x.len;
      if (x.rate !== 0xff) pat.rate = x.rate;
      return pat;
    });
  }
  for (const t of b.locks) {
    const m = mod(t.module);
    if (!m) continue;
    for (const { p: pi, locks } of t.pats) {
      const list: StepLock[] = locks.flatMap((l) => {
        const [mi, q] = t.rows[l.row]?.[0] ?? [];
        const target = mi === undefined ? undefined : b.modules[mi];
        const pd: ParamDef | undefined = target ? DEFS[target.type].params[q] : undefined;
        return pd ? [{ at: l.at, module: at(mi!), param: pd.name, value: fromQ(l.value) }] : [];
      });
      if (!pi) m.locks = list;
      else {
        m.patterns ??= [];
        while (m.patterns.length < pi) m.patterns.push(null);
        (m.patterns[pi - 1] ??= {}).locks = list;
      }
    }
  }
  for (const o of b.origins) {
    const m = mod(o.module);
    if (!m) continue;
    m.factoryPatterns ??= { version: 1, ids: [] };
    while (m.factoryPatterns.ids.length <= o.pattern) m.factoryPatterns.ids.push(null);
    m.factoryPatterns.ids[o.pattern] = o.id.toString(16).padStart(8, '0');
  }
  for (const [i, names] of b.drumNames) {
    const m = mod(i);
    if (!m) continue;
    const own = names.map((s, r) => (s === undefined || trackName(s) === trackName(DRUM_MAP_DEFAULT[r]?.name) ? '' : s));
    if (own.some((s) => s)) m.names = own;
  }
  // the input routes, macro ranges and MIDI learn mappings
  for (const r of b.routes) {
    const m = mod(r.module), def = DEFS[b.modules[r.module].type];
    const port = def.inputs[r.input]?.name;
    if (!m || !port) continue;
    const names = def.params.filter((_, k) => r.mask & (1 << k)).map((q) => q.name);
    if (names.length) (m.inputMap ??= {})[port] = names;
  }
  for (const r of b.ranges) {
    const m = mod(r.module), name = DEFS[b.modules[r.module].type].params[r.par]?.name;
    if (!m || !name) continue;
    const s = r.pin ? 'p2' : 'p1';
    ((m.range ??= {})[s] ??= {})[name] = r.bi ? [r.lo / 255, r.hi / 255, 1] : [r.lo / 255, r.hi / 255];
  }
  const learn: MidiBinding[] = b.maps.flatMap((x) => {
    const param = paramOf(x.module, x.par);
    return param ? [{ src: mapSource(x.src), module: at(x.module), param, lo: x.lo / 255, hi: x.hi / 255 }] : [];
  });
  if (learn.length) p.midiLearn = learn;
  return { patch: p, keys: devKeys };
}

/** a patch's binary as the editor would send it to an FM-1 whose store holds `store` (id → payload hash), null when it does
 *  not encode */
function encodeFor(p: Patch, store: ReadonlyMap<number, number>): number[] | null {
  try {
    return Array.from(encodePatch(p, true, 0, 0, store));
  } catch {
    return null;
  }
}
const same = (a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean => !!a && !!b && a.length === b.length && Array.prototype.every.call(a, (x: number, i: number) => x === b[i]);

/** a binary's sections, each as text to compare (the device pages and extras one entry per device), null when it does not
 *  read */
function sectionsOf(bytes: ArrayLike<number> | null): Map<string, string> | null {
  const b = bytes && parseBinary(bytes);
  if (!b) return null;
  const text = (x: unknown): string => JSON.stringify(x, (_k, v) => (v instanceof Map ? [...v] : v));
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(b)) {
    if (k === 'devices' || k === 'extras') (v as unknown[]).forEach((x, i) => out.set(`${k} ${i}`, text(x)));
    else out.set(k, text(v));
  }
  out.set('devices', String(b.devices.length));
  return out;
}

/** does pattern p (0-based) of some track have content the binary holds itself */
const holds = (b: BinPatch, p: number): boolean =>
  (p === 0 ? b.notes.size > 0 : b.patterns?.tracks.some((t) => !!t.patterns[p - 1]) ?? false) || b.locks.some((t) => t.pats.some((x) => x.p === p));

/**
 * A patch read from an FM-1 slot's binary (see the top of this file), or null when this editor does not read it. `patterns`:
 * the payloads of the stored patterns it links (PAT_GET, by id): a pattern the binary leaves to the store takes its payload,
 * and its link stays; one whose payload is missing is left empty and its link dropped (D-1356). `library`: the assembly
 * definitions to rebuild the cards from (assembly-match.ts browserLibrary).
 */
export function readFromFm1(bin: ArrayLike<number>, opts: { name: string; library?: AssemblyDef[]; patterns?: ReadonlyMap<number, ArrayLike<number>> }): FromFm1 | null {
  const b = parseBinary(bin);
  if (!b) return null;
  let plain: Patch, keys: string[];
  try {
    ({ patch: plain, keys } = plainPatch(b, opts.name));
  } catch {
    return null;
  }
  const store = new Map<number, number>();
  const links: Record<number, { id: number; hash: number }> = {};
  for (const [p, id] of b.links) {
    const payload = opts.patterns?.get(id);
    const own = holds(b, p);   // (an edited linked pattern: the binary holds it whole, and the FM-1's SAVE writes it over the stored one)
    if (!payload && !own) continue;
    if (payload && !own) {
      try {
        applyPayload(plain, p, payload);
      } catch {
        continue;
      }
    }
    const hash = payload ? fnv(FNV0, payload) : 0;
    store.set(id, hash);
    links[p] = { id, hash };
  }
  const main = plain.modules.find((m) => m.type === 'fm1');
  if (main && Object.keys(links).length) main.seq = { ...main.seq, links };
  try {
    plain = validatePatch(plain, DEFS);
  } catch {
    return null;
  }
  const devices = b.devices.filter((d) => d.kind === 1).length;
  // a rebuilt card stays while every section the patch encodes as the binary holds it still does (and the card's own
  // device entries may only get closer): the FM-1 plays the same
  const want = sectionsOf(bin)!;
  const matching = (p: Patch): Set<string> => {
    const got = sectionsOf(encodeFor(p, store));
    return new Set(got ? [...want].filter(([k, v]) => got.get(k) === v).map(([k]) => k) : []);
  };
  let held = matching(plain);
  const keeps = (p: Patch): boolean => {
    const now = matching(p);
    if (![...held].every((k) => now.has(k))) return false;
    held = now;
    return true;
  };
  const rebuilt = matchAssemblies(plain, keys, b, opts.library ?? [], keeps);
  let patch = rebuilt.patch;
  if (b.rack) {   // (the FX drawers, around the cards as they are now)
    const p = structuredClone(patch);
    rebuildRack(p, keys, b);
    if (keeps(p)) patch = p;
  }
  if (b.bus) {
    // (the old master FX bus as FX drawers, kept while the modules and cables, what plays, stay as they are: the drawers
    // are written in format 66, whose rack, devices, extras and module layout differ by design, and an FX button that
    // paged the bus does nothing now, fx-legacy.ts convertLegacyBus: the FM-1's FX button finds the drawers)
    const p = restoreLegacyBus(patch, b.bus.map((s) => ({ kind: s.kind, targets: s.targets.map((i) => i + 1) })));
    const sound = (q: Patch): string => JSON.stringify([q.modules.map(({ panel: _, ...m }) => m), q.cables]);
    if (p && sound(p) === sound(patch)) {
      patch = p;
      held = matching(p);
    }
  }
  if (b.buttons?.toggles.size) {   // (a Toggle that switches several modules: the card whose switch moves exactly them)
    const p = structuredClone(patch);
    retargetToggles(p, b);
    if (keeps(p)) patch = p;
  }
  return { patch, devices, recognised: rebuilt.recognised, exact: same(encodeFor(patch, store), bin) };
}

/** each Toggle's target: the module it switches, or the card (an instrument, an effect, a drawer) whose switch moves the
 *  modules the binary lists for it, in its order */
function retargetToggles(p: Patch, b: BinPatch): void {
  const panel = p.modules.find((m) => m.type === 'fm1')?.panel;
  if (!panel) return;
  for (const [bt, list] of b.buttons!.toggles) {
    const want = list.map((i) => i + 1).join(',');
    if (list.length < 2) continue;
    for (const a of assembliesOf(p)) {
      (panel.targets ??= {})[bt] = { asm: a.id };
      if (toggleTargets(p, bt).join(',') === want) break;
      delete panel.targets[bt];
    }
  }
}

/** what the editor says it opened (readFromFm1) */
export function readLabel(r: FromFm1): string {
  const cards = r.devices ? `${r.recognised} of ${r.devices} assembl${r.devices === 1 ? 'y' : 'ies'} recognised` : 'no assemblies';
  return `Read from the FM-1 · layout rebuilt · ${cards}`;
}
