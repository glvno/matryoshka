// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, defaultMap, emptyPatch, validatePatch, type Patch } from './patch';
import { isShortNote } from './track';
import { connectParameter, setInputRoute } from './parameter-routing';
import { devicesOf } from './pages';
import { makeAssembly } from './assembly';
import { engineBytes } from './test-bin';
import { buttonRecord, deviceText, deviceBytes, deviceSection, drumMaps, extrasRecord, FLAG_DEVICES, FLAG_EXTRAS, FLAG_INPUT_MAP, FLAG_NAMES, maskBytes, rangeList, GROUP_REC, PANEL_BYTES, deviceBudget, DEVICE, encodePatch, MAX_CABLES, recordSize, TYPE_ORDER, VERSION, formatOf, paramsAt, SECTION_FORMATS, WRITE_FLOOR } from './patchbin';
import { FM1_PRESETS } from './presets';
import { deviceView, polyGroups } from './poly';
import { polyCfg, withParts } from './test-poly';
import { subtractiveSaw, wobble } from './test-patches';
import { structureOf } from './structure';
import { allModules } from './assembly';
/** how many device-form modules a device is made of (the extras' member list) */
const extrasMembers = (src: Patch, dev: Patch, d: { asm?: number; module?: number }): number => {
  const ids = new Set(dev.modules.map((m) => m.id));
  return (d.asm !== undefined ? allModules(src, src.assemblies!.find((x) => x.id === d.asm)!) : [d.module!]).filter((id) => ids.has(id)).length;
};

/** the side-input routes section: a count, then per route its module and input bytes and its parameter mask (patchbin.ts routesOf) */
const routeBytes = (p: Patch): number => {
  const masks = p.modules.flatMap((m) => Object.entries(m.inputMap ?? {}).filter(([, ps]) => ps.length).map(() => maskBytes(m.type)));
  return masks.length ? 1 + masks.reduce((n: number, b) => n + 2 + b, 0) : 0;
};

/** bytes of the patterns and songs section as the top of patchbin.ts documents it (0 without patterns or songs) */
function patternBytes(p: Patch): number {
  const seq = p.modules.find((m) => m.type === 'fm1')?.seq;
  const tracks = p.modules.filter((m) => m.type === 'steps' && m.patterns?.length);
  if (!tracks.length && !seq?.pattern && !seq?.song && !seq?.songs?.length) return 0;
  return 3 + tracks.reduce((n, m) => n + 2 + m.patterns!.reduce((k, x) => k + (x ? 3 + (x.notes ?? []).length * ((x.notes ?? []).every(isShortNote) ? 2 : 4) : 1), 0), 0)
    + 1 + (seq?.songs ?? []).reduce((n, e) => n + 1 + 2 * e.length, 0);
}

describe('binary patch format', () => {
  it('marks exactly the modules with a morph B side, including modules after the first mask byte', () => {
    const p = emptyPatch();
    for (let i = 0; i < 10; i++) addModule(p, DEFS.const, i, 0);
    p.modules[2].paramsB = { value: 0.5 };
    p.modules[9].paramsB = { value: -0.5 };
    const out = addModule(p, DEFS.output, 0, 1);
    for (const m of p.modules.slice(0, 10)) connect(p, DEFS, { module: m.id, port: 'out' }, { module: out.id, port: 'l' });
    const bin = encodePatch(p);
    const dev = deviceView(p, true).patch;
    const at = 8 + PANEL_BYTES + 4 * dev.cables.length + dev.modules.reduce((n, m) => n + recordSize(m.type, bin[1]) + 4 * paramsAt(m.type, bin[1]).length, 0);
    expect(bin[7] & 2).toBe(2);
    expect([...bin.subarray(at, at + 2)]).toEqual([1 << 2, 1 << 1]);
  });

  it('the assembly overlay of the factory patches reaches the binary only as the device pages', () => {
    let grouped = 0;
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      if (polyGroups(p).length) continue; // a poly assembly is not only layout: its cards run once per voice
      const flat = { ...p, assemblies: undefined };
      delete flat.assemblies;
      expect(engineBytes(p), name).toEqual(engineBytes(flat));
      if (p.assemblies?.length) grouped++;
    }
    expect(grouped).toBeGreaterThanOrEqual(5); // the factory patches without a poly assembly that open as cards (Init stays flat)
  });

  it('never writes the legacy disabled-input masks (format 17) and keeps macro ranges last', () => {
    const p = wobble();
    const filter = p.modules.find((m) => m.type === 'filter')!;
    const before = encodePatch(p);
    const cables = structuredClone(p.cables);
    (filter as { disabledInputs?: string[] }).disabledInputs = ['cv']; // what an older editor may have saved
    filter.range = { p1: { cutoff: [.2, .8] } };
    filter.map!.p1 = ['cutoff'];
    const b = encodePatch(p);
    expect(b[1]).toBe(formatOf(p));
    expect(b[6] & ~32).toBe(2);
    expect(b.length).toBe(before.length + 6);
    expect(b[before.length]).toBe(1); // macro range count
    expect(p.cables).toEqual(cables);
  });

  it('encodes side-input fan-out after morph, before macro ranges', () => {
    const p = wobble();
    const filter = p.modules.find((m) => m.type === 'filter')!;
    filter.paramsB = { ...filter.params, cutoff: 4000 };
    const before = encodePatch(p);
    filter.inputMap = { cv: ['res', 'cvamt'], in: ['track'] };
    filter.range = { p1: { cutoff: [.2, .8] } }; filter.map!.p1 = ['cutoff'];
    const b = encodePatch(p);
    expect(b[1]).toBe(formatOf(p));
    expect(b[6] & ~32).toBe(11);
    expect(b.length).toBe(before.length + 9 + 6);
    const routes = before.length - deviceBytes(p); // the routes come before the device pages
    expect(b[routes]).toBe(2);
    const dv = new DataView(b.buffer);
    for (const [i, port] of ['in', 'cv'].entries()) {
      const at = routes + 1 + i * 4;
      expect(b[at]).toBe(p.modules.indexOf(filter));
      expect(b[at + 1]).toBe(DEFS.filter.inputs.findIndex((pd) => pd.name === port));
      expect(dv.getUint16(at + 2, true)).toBe(DEFS.filter.params.reduce((mask, pd, j) => mask | (filter.inputMap![port].includes(pd.name) ? 1 << j : 0), 0));
    }
    expect(b[b.length - 6]).toBe(1); // the macro ranges, last
  });

  it('writes WRITE_FLOOR only while every later format just appends parameters (`since`) or a section written only when used', () => {
    // a format that changes anything else (a type, a port, a section always written) must raise WRITE_FLOOR to itself, or
    // a patch that uses it would be written in an older format that does not have it
    const later = new Set(Object.values(DEFS).flatMap((d) => d.params.map((q) => q.since ?? 0)).filter((v) => v > WRITE_FLOOR));
    for (const v of Object.keys(SECTION_FORMATS)) later.add(Number(v));
    expect([...later].sort((a, b) => a - b)).toEqual(Array.from({ length: VERSION - WRITE_FLOOR }, (_, i) => WRITE_FLOOR + 1 + i));
  });

  it('marks the parameters appended since format 34 (`since`), which the FM-1 reads an older binary without', () => {
    // format 34's types and their parameter counts where they grew (firmware/src/defs.h at v1.4.1)
    const v34: Record<string, number> = { lfo: 6, adsr: 4, delay: 5, reverb: 5, pulse: 1, drummap: 8, alloc: 8, steps: 4, filter: 5 };
    const nTypes34 = TYPE_ORDER.indexOf('pd'); // pd, env8, select came with format 35
    expect(TYPE_ORDER.slice(nTypes34)).toEqual(['pd', 'env8', 'select', 'rateenv', 'ratio', 'esp']); // Rate Env in 42, Ratio in 43, Follower in 46
    for (const t of TYPE_ORDER.slice(0, nTypes34)) {
      const ps = DEFS[t].params;
      expect(ps.filter((q) => (q.since ?? 0) <= 34).length, t).toBe(v34[t] ?? ps.length);
      ps.forEach((q, i) => expect((q.since ?? 0) >= (ps[i - 1]?.since ?? 0), `${t}.${q.name}`).toBe(true));
      expect(ps.every((q) => (q.since ?? 0) <= VERSION), t).toBe(true);
    }
    for (const t of TYPE_ORDER.slice(nTypes34)) expect(DEFS[t].params.some((q) => q.since !== undefined), t).toBe(false);
    // a module without a stored matrix routes as before: a Pulse's p2 does not reach its new `inf`
    expect(defaultMap(DEFS.pulse).p2).toEqual([]);
  });

  it('a type with more than 16 parameters (Env 8) writes its matrix and route masks as u32, every other type as u16', () => {
    expect(maskBytes('env8')).toBe(4);
    for (const t of TYPE_ORDER) expect(maskBytes(t), t).toBe(DEFS[t].params.length > 16 ? 4 : 2);
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    const e = addModule(p, DEFS.env8, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    connect(p, DEFS, { module: e.id, port: 'env' }, { module: out.id, port: 'l' });
    const before = encodePatch(p);
    connectParameter(p, DEFS, { module: lfo.id, port: 'out' }, e.id, 'sus');
    connectParameter(p, DEFS, { module: lfo.id, port: 'out' }, e.id, 'end'); // the same source: the same pin
    e.map!.k4 = ['r8', 'end'];
    connect(p, DEFS, { module: kb.id, port: 'gate' }, { module: e.id, port: 'gate' });
    setInputRoute(e, DEFS.env8, 'gate', 'sus', true);
    validatePatch(p, DEFS);
    expect(e.map!.p1).toEqual(['sus', 'end']);
    const b = encodePatch(p);
    const dv = new DataView(b.buffer);
    const rec = 8 + PANEL_BYTES + recordSize('fm1') + recordSize('lfo');
    expect(recordSize('env8')).toBe(1 + 4 * 18 + 8 + 6 * 4);
    expect(b[rec]).toBe(TYPE_ORDER.indexOf('env8'));
    const masks = rec + 1 + 4 * 18 + 8;
    const bit = (name: string): number => 2 ** DEFS.env8.params.findIndex((q) => q.name === name);
    expect(dv.getUint32(masks, true)).toBe(bit('sus') + bit('end')); // p1
    expect(dv.getUint32(masks + 5 * 4, true)).toBe(bit('r8') + bit('end')); // k4
    // the route: module, input, u32 mask, right after the cables
    const routes = rec + recordSize('env8') + recordSize('output') + 4 * p.cables.length;
    expect(b[6] & FLAG_INPUT_MAP).toBe(FLAG_INPUT_MAP);
    expect(Array.from(b.subarray(routes, routes + 3))).toEqual([1, 2, DEFS.env8.inputs.findIndex((q) => q.name === 'gate')]);
    expect(dv.getUint32(routes + 3, true)).toBe(bit('sus'));
    expect(b.length).toBeGreaterThan(before.length);
  });

  it('writes the device pages after the step values: a plain module by its index, an assembly with its pages and rows', () => {
    const p = subtractiveSaw();
    const osc = p.modules.find((m) => m.type === 'osc')!;
    const flt = p.modules.find((m) => m.type === 'filter')!;
    const a = makeAssembly(p, [osc.id, flt.id], 'voice');
    a.params = [{ module: osc.id, param: 'wave', label: 'wave' }, { module: flt.id, param: 'cutoff', label: 'cutoff', head: 'filter' }, { module: flt.id, param: 'res', label: 'res' }];
    const b = encodePatch(p);
    expect(b[6] & FLAG_DEVICES).toBe(FLAG_DEVICES);
    const devs = devicesOf(p, DEFS);
    const idx = (id: number): number => p.modules.findIndex((m) => m.id === id);
    let at = 8 + PANEL_BYTES + p.modules.reduce((n, m) => n + recordSize(m.type, b[1]), 0) + 4 * p.cables.length;
    const text = (): string => { const n = b[at++]; const t = String.fromCharCode(...b.subarray(at, at + n)); at += n; return t; };
    expect(b[at++]).toBe(devs.length);
    for (const d of devs) {
      if (d.module !== undefined) {
        expect([b[at], b[at + 1]]).toEqual([0, idx(d.module)]);
        at += 2;
        continue;
      }
      expect(b[at++]).toBe(1);
      expect(text()).toBe('voice');
      expect(b[at++]).toBe(2);
      expect(text()).toBe('voice');
      expect(Array.from(b.subarray(at, at + 4))).toEqual([0, 1, 0, 1]);
      at += 4;
      expect([b[at], b[at + 1]]).toEqual([idx(osc.id), 0]);
      at += 2;
      expect(text()).toBe('wave');
      expect(text()).toBe('filter');
      expect(Array.from(b.subarray(at, at + 4))).toEqual([0, 1, 0, 2]);
      at += 4;
      expect([b[at], b[at + 1]]).toEqual([idx(flt.id), 0]);
      at += 2;
      expect(text()).toBe('cutoff');
      at += 2;
      expect(text()).toBe('res');
    }
    expect(devs.some((d) => d.asm === a.id)).toBe(true);
    // the device extras (format 34, flag bit 8): per device its track, structure and preset name
    expect(b[7] & (FLAG_EXTRAS >> 8)).toBe(1);
    expect(b[at++]).toBe(devs.length);
    a.preset = 'Warm';
    for (const d of devs) {
      expect(b[at], d.name).toBe(0xff); // no Steps track drives anything here
      const h = new DataView(b.buffer).getUint32(at + 1, true);
      expect(h).toBe(d.asm === undefined ? 0 : parseInt(structureOf(p, a), 16) >>> 0);
      at += 5;
      expect(text()).toBe('');
      const n = b[at++];
      expect(n).toBe(d.asm === undefined ? 0 : a.params.length); // the card rows in canonical order
      at += 2 * n;
      const m = b[at++];
      expect(m).toBe(d.asm === undefined ? 1 : 2); // the modules it is made of
      at += m;
    }
    expect(at).toBe(b.length);
    const named = encodePatch(p); // the remembered preset name goes along
    expect(new TextDecoder().decode(named)).toContain('Warm');
  });

  it('the device extras say which Steps track drives a device (format 34)', () => {
    const p = FM1_PRESETS['808 Kit']();
    const devs = devicesOf(p, DEFS);
    const rec = extrasRecord(devs, p);
    const track = devs.findIndex((d) => d.kind === 'steps');
    const map = devs.findIndex((d) => d.module !== undefined && p.modules.find((m) => m.id === d.module)?.type === 'drummap');
    expect(track).toBeGreaterThanOrEqual(0);
    const entry = (i: number): number => { let at = 1; for (let k = 0; k < i; k++) { at += 6 + rec[at + 5]; at += 1 + 2 * rec[at]; at += 1 + rec[at]; } return at; };
    expect(rec[entry(map)]).toBe(track);
    expect(rec[entry(track)]).toBe(0xff);
  });

  it('carries the Drum maps\' row names for the FM-1 (format 33, flag bit 7): their own, else the defaults', () => {
    const p = FM1_PRESETS['808 Kit']();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    map.names = ['boom'];
    const b = encodePatch(p);
    expect(b[1]).toBe(formatOf(p));
    expect(b[6] & FLAG_NAMES).toBe(FLAG_NAMES);
    const text = new TextDecoder().decode(b);
    expect(text).toContain('BOOM\0\0\0\0SNARE\0\0\0CLAP');
    expect(text).toContain('COWBELL');
  });

  it('counts a summing buffer for an input with two sources, routes or not', () => {
    const p = wobble();
    const filter = p.modules.find((m) => m.type === 'filter')!;
    const cable = p.cables.find((c) => c.to.module === filter.id && c.to.port === 'cv')!;
    const one = deviceBudget(p);
    p.cables.push(structuredClone(cable));
    expect(deviceBudget(p).buffers).toBe(one.buffers + 1);
    filter.inputMap = { cv: ['res'] };
    expect(deviceBudget(p).buffers).toBe(one.buffers + 1);
  });

  it('encodes every preset with the documented layout', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const b = encodePatch(make());
      const { patch: p, groups } = deviceView(make()); // what the device gets: the allocator as a Part per poly group
      const g = groups.length;
      const dv = new DataView(b.buffer);
      expect(b[0], name).toBe(0xa1);
      expect(b[1], name).toBe(formatOf(make()));
      expect(b[2], name).toBe(p.modules.length);
      expect(b[3], name).toBe(g); // poly groups (Oracle V has one)
      expect(dv.getUint16(4, true), name).toBe(p.cables.length);
      const devs = deviceSection(make(), p);
      const txt = (t: string): number => 1 + deviceText(t).length;
      // a row's extras (#357, #358): u8 count and 2 bytes per further parameter, u8 count and a text per position name
      const more = (r: { also?: unknown[]; names?: string[] }): number => (r.also?.length || r.names?.length ? 2 + 2 * (r.also?.length ?? 0) + (r.names ?? []).reduce((k, s) => k + txt(s), 0) : 0);
      const pages = devs.length ? 1 + devs.reduce((n, d) => n + (d.module !== undefined ? 2 : 2 + txt(d.name) + d.pages.reduce((k, pg) => k + txt(pg.name) + 4 + pg.rows.reduce((j, r) => j + 2 + txt(r.label) + more(r), 0), 0)), 0)
        + 1 + devs.reduce((n, d) => n + 8 + deviceText((d.asm !== undefined ? make().assemblies?.find((x) => x.id === d.asm)?.preset : '') ?? '').length + 2 * (d.asm !== undefined ? make().assemblies!.find((x) => x.id === d.asm)!.params.length : 0) + extrasMembers(make(), p, d), 0) : 0; // and the extras
      const valued = p.modules.filter((m) => m.type === 'steps' && m.notes?.length);
      const size = 8 + GROUP_REC * g + (g ? p.modules.length : 0) + PANEL_BYTES + p.modules.reduce((s, m) => s + 1 + 4 * paramsAt(m.type, b[1]).length + (DEFS[m.type].paramInputs ? 8 + 6 * maskBytes(m.type) : 0) + (DEFS[m.type].data ?? 0), 0) + 4 * p.cables.length
        + (valued.length ? 1 + valued.reduce((n, m) => n + 2 + 4 * m.notes!.length, 0) : 0) + pages + buttonRecord(make(), p).length
        + (drumMaps(p).length ? 1 + drumMaps(p).length * (1 + 8 * 8) : 0)
        + (rangeList(p).length ? 1 + 5 * rangeList(p).length : 0) // the macro ranges (the 909 Kit's velocity VCAs)
        + routeBytes(p) // the side-input routes (Cassia 1's PD Osc: pm to range)
        + patternBytes(make()); // the patterns and songs (format 48: Silver Box's demo)
      expect(b.length, name).toBe(size);
      expect(!!(b[6] & FLAG_DEVICES), name).toBe(devs.length > 0);
      expect(!!(b[6] & FLAG_NAMES), name).toBe(drumMaps(p).length > 0);
      expect(p.cables.length).toBeLessThanOrEqual(MAX_CABLES);
    }
  });

  it('counts what a patch costs on the device: every factory preset fits, and voices multiply the per-voice part', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) expect(deviceBudget(make()).fits, name).toBe(true);
    const mono = deviceBudget(subtractiveSaw());
    const p = withParts(subtractiveSaw(), 4);
    const poly = deviceBudget(p);
    expect(poly.instances).toBeGreaterThan(mono.instances);
    expect(poly.buffers).toBeGreaterThan(mono.buffers);
    expect(poly.fits).toBe(true);
    polyCfg(p).parts = 8;
    expect(deviceBudget(p).instances).toBeLessThanOrEqual(DEVICE.instances);
  });

  it('counts parameter values as eng_load takes them: per module its type\'s, twice with a morph B side, plus per copy', () => {
    const used = (q: Patch): number => deviceBudget(q).items.find((i) => i.key === 'params')!.used;
    const mono = subtractiveSaw();
    const npar = mono.modules.reduce((n, m) => n + DEFS[m.type].params.length, 0);
    expect(used(mono)).toBe(2 * npar); // one copy each
    const p = withParts(subtractiveSaw(), 4);
    const { patch: dv, groups } = deviceView(p, true);
    const copies = (id: number): number => (groups.some((g) => g.modules.has(id)) ? 4 : 1);
    expect(used(p)).toBe(dv.modules.reduce((n, m) => n + DEFS[m.type].params.length * (1 + copies(m.id)), 0));
    const filter = mono.modules.find((m) => m.type === 'filter')!;
    filter.paramsB = { ...filter.params, cutoff: 4000 };
    expect(used(mono)).toBe(3 * npar);
  });

  it('unison: bit 7 of the group\'s legato byte', () => {
    const p = withParts(subtractiveSaw(), 4, { legato: 1 });
    expect(encodePatch(p)[10]).toBe(1);
    polyCfg(p).unison = true;
    const b = encodePatch(p);
    expect(b[1]).toBe(formatOf(p));
    expect(b[10]).toBe(0x80 | 1);
  });

  it('writes the poly groups after the header: their settings, then every module\'s group', () => {
    const p = withParts(subtractiveSaw(), 4, { assign: 1, legato: 2, priority: 1, flaws: [{ detune: -7, drift: 40, bright: 5, env: -20, level: 80 }] });
    const b = encodePatch(p);
    expect(b[3]).toBe(1);
    expect(Array.from(b.slice(8, 12))).toEqual([4, 1, 2, 1]);
    expect(Array.from(b.slice(12, 22))).toEqual([256 - 7, 40, 5, 256 - 20, 80, 0, 0, 0, 0, 100]); // part 1's flaws, part 2 has none
    const at = 8 + GROUP_REC;
    const members = polyGroups(p)[0].modules;
    // the allocator is written in its place as the group's Part (poly.ts deviceView)
    expect(Array.from(b.slice(at, at + p.modules.length))).toEqual(p.modules.map((m) => (members.has(m.id) || m.type === 'alloc' ? 1 : 0)));
    const rec = at + p.modules.length + PANEL_BYTES; // the panel section, then the module records
    expect(b[rec + p.modules.slice(0, p.modules.findIndex((m) => m.type === 'alloc')).reduce((n, m) => n + recordSize(m.type, b[1]), 0)]).toBe(TYPE_ORDER.indexOf('part'));
    expect(b.slice(at, at + p.modules.length).some((g) => g === 0)).toBe(true); // Main and Output run once
    expect(b[rec]).toBe(TYPE_ORDER.indexOf(p.modules[0].type)); // the module records follow
  });

  it('writes parameters as Q16.16 and cables as indices', () => {
    const p = subtractiveSaw();
    const b = encodePatch(p);
    // module 0 is the FM-1 panel (type byte + 4 parameters); module 1 osc starts right after
    const osc = 8 + PANEL_BYTES + 1 + 4 * DEFS.fm1.params.length;
    expect(b[8 + PANEL_BYTES]).toBe(TYPE_ORDER.indexOf('fm1'));
    expect(b[osc]).toBe(TYPE_ORDER.indexOf('osc'));
    const dv = new DataView(b.buffer);
    expect(dv.getInt32(osc + 1, true)).toBe(2 * 65536); // wave = saw (2)
    const att = osc + 1 + 4 * DEFS.osc.params.length; // osc: att1, att2, then the masks p1 p2 k1 k2 k3 k4
    expect(dv.getInt32(att, true)).toBe(65536);
    expect(dv.getInt32(att + 4, true)).toBe(65536);
    expect(Array.from(b.slice(att + 8, att + 20))).toEqual([1, 0, 2, 0, 1, 0, 2, 0, 4, 0, 8, 0]); // the default matrix, u16 LE
    const cab = 8 + PANEL_BYTES + p.modules.reduce((n, m) => n + recordSize(m.type, b[1]), 0);
    expect([b[cab], b[cab + 1], b[cab + 2], b[cab + 3]]).toEqual([0, DEFS.fm1.outputs.findIndex((o) => o.name === 'pitch'), 1, DEFS.osc.inputs.findIndex((i) => i.name === 'pitch')]);
  });

  it('lists every FM-1 limit, and a patch over one plays in the browser but is never encoded', () => {
    const p = subtractiveSaw();
    const b = deviceBudget(p);
    expect(b.items.map((i) => i.key)).toEqual(Object.keys(DEVICE));
    expect(b.items.find((i) => i.key === 'bytes')!.used).toBe(encodePatch(p).length);
    expect(b.use).toBeGreaterThan(0);
    expect(b.use).toBeLessThanOrEqual(1);
    const out = p.modules.find((m) => m.type === 'output')!;
    while (p.modules.length <= DEVICE.modules) connect(p, DEFS, { module: addModule(p, DEFS.const, 0, 0).id, port: 'out' }, { module: out.id, port: 'l' }); // wired: unwired modules are never sent
    const over = deviceBudget(p);
    expect(over.fits).toBe(false);
    expect(over.over.map((i) => i.key)).toContain('modules');
    expect(() => encodePatch(p)).toThrow(/over the FM-1 budget: modules/);
    const two = subtractiveSaw();
    const out2 = two.modules.find((m) => m.type === 'output')!;
    for (let i = 0; i < 2; i++) connect(two, DEFS, { module: addModule(two, DEFS.reverb, 0, 0).id, port: 'out' }, { module: out2.id, port: 'l' });
    expect(deviceBudget(two).over.map((i) => i.key)).toEqual(['reverbs']);
  });
});

describe('the budget\'s memory reading', () => {
  it('a slot of one or two (one reverb, one of two arpeggiators) counts only when exceeded', () => {
    const p = FM1_PRESETS.Init();
    const b = deviceBudget(p);
    expect(b.items.find((i) => i.key === 'arps')?.used).toBe(1);
    expect(b.fullest?.key).not.toBe('arps');
    expect(b.memory).toBeLessThan(0.5);
  });
});

describe('the budget counts what the FM-1 receives', () => {
  // the button record (non-gate panel buttons) went uncounted: a patch could pass the budget and still be over M1_PATCH_MAX
  it('patch bytes equal the encoded size for every factory patch', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const used = deviceBudget(p).items.find((i) => i.key === 'bytes')!.used;
      expect(used, name).toBe(encodePatch(p).length);
    }
  });
});
