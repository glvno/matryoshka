// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 reader (patch-reader.ts, bin-parse.ts, D-1354): a binary read back is a patch that writes the same bytes, in
// every format the encoder writes, with its patterns from the FM-1's store where the binary links them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS, DEVICE_SR, PANEL_BUTTONS } from './modules';
import { addModule, connect, newPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { COUNTED, encodePatch, Q, SLIM, toQ16, VERSION, WRITE_FLOOR } from './patchbin';
import { linkedIds, parseBinary, type BinPatch } from './bin-parse';
import { readFromFm1, readLabel, type FromFm1 } from './patch-reader';
import { FM1_PRESETS, make } from './presets';
import { browserLibrary, patchDefs, shippedLibrary } from './assembly-match';
import { encodePayload, payloadHash } from './pattern-store';
import { setKind, setSwitches, toggleTargets } from './buttons';
import { Engine } from './engine';

const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.prototype.every.call(a, (x: number, i: number) => x === b[i]);
/** encode, read back, encode again: the second binary is the first */
function roundTrip(p: Patch, force = 0, store?: ReadonlyMap<number, number>, patterns?: ReadonlyMap<number, Uint8Array>, library = shippedLibrary()): { bin: Uint8Array; again: Uint8Array; read: FromFm1 | null } {
  const src = validatePatch(structuredClone(p), DEFS);
  const bin = encodePatch(src, true, force, 0, store);
  const read = readFromFm1(bin, { name: src.name, library, patterns });
  expect(read).not.toBeNull();
  return { bin, again: encodePatch(read!.patch, true, force, 0, store), read };
}

/** a plain voice: Main's pitch and gate into an oscillator, an envelope and a VCA into the Output */
const voice = (name: string, extra?: (p: Patch, ids: { main: number; osc: number; vca: number; out: number }) => void): Patch => {
  const p = make(name, (add, wire) => {
    const main = add('fm1', 0, 0), osc = add('osc', 200, 0), env = add('adsr', 200, 300), vca = add('vca', 400, 0), out = add('output', 600, 0);
    wire(main, 'pitch', osc, 'pitch');
    wire(main, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
  });
  extra?.(p, { main: p.modules[0].id, osc: p.modules[1].id, vca: p.modules[3].id, out: p.modules[4].id });
  return p;
};
const add = (p: Patch, type: string, params: Record<string, number> = {}, more: Partial<ModuleInst> = {}): number => {
  const m = addModule(p, DEFS[type], 800, 0);
  Object.assign(m.params, params);
  Object.assign(m, more);
  return m.id;
};
const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
  if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`bad cable ${ap} → ${bp}`);
};

describe('the FM-1 reader (D-1354)', () => {
  /** the formats of the binaries read back below */
  const formats = new Set<number>();
  it('reads every factory patch back to the same bytes, its cards rebuilt from the assemblies this browser always has (the factory set and the factory patches)', () => {
    const presets = Object.entries(FM1_PRESETS).map(([name, mk]) => ({ name, p: mk() }));
    const library = [...shippedLibrary(), ...presets.flatMap((x) => patchDefs(x.p))];
    for (const { name, p } of presets) {
      const { bin, again, read } = roundTrip(p, 0, undefined, undefined, library);
      formats.add(bin[1]);
      expect(same(again, bin), name).toBe(true);
      expect(read!.exact, name).toBe(true);
      expect(read!.recognised, name).toBe(read!.devices);
    }
  });

  // a patch in each format the encoder writes: the parameters and types appended with a format (ParamDef.since,
  // ModuleDef.since), and each section a format added
  const byFormat: [string, () => Patch, number?][] = [
    ['46: the write floor', () => voice('plain')],
    ['48: patterns and songs', () => voice('patterns', (p) => {
      add(p, 'steps', {}, { notes: [{ at: 0, len: 2, note: 60, vel: 100 }], patterns: [{ notes: [{ at: 4, len: 1, note: 62, vel: 127 }], len: 8 }] });
      p.modules[0].seq = { pattern: 1, songs: [[{ pat: 0, shift: 0 }, { pat: 1, shift: 2 }]] };
    })],
    ['50: a note tied across the loop point', () => voice('wrap', (p) => {
      add(p, 'steps', {}, { notes: [{ at: 15, len: 3, note: 60, vel: 100, wrap: true }] });
    })],
    ['51: counted records', () => voice('counted'), COUNTED],
    ['55: a Harmonizer Toggle', () => voice('lfo toggle', (p, ids) => {
      const h = add(p, 'harm');
      wire(p, ids.main, 'keys', h, 'keys');
      setKind(p, 'lfo', 'bypass');
      p.modules[0].panel!.targets = { lfo: { module: h } };
      setSwitches(p, 'lfo', true);
    })],
    ['59: a pattern linked to the store', () => voice('links', (p) => {
      add(p, 'steps', {}, { patterns: [{ notes: [{ at: 1, len: 1, note: 64, vel: 100 }] }] });
      p.modules[0].seq = { links: { 1: { id: 7, hash: 0 } } };
    })],
    ['60: a trig condition', () => voice('cond', (p) => {
      add(p, 'steps', {}, { notes: [{ at: 0, len: 1, note: 60, vel: 100, cond: 1 }] });
    })],
    ['61: a cable into a Voicing priority input', () => {
      const p = voice('priority');
      const alloc = add(p, 'alloc', { voices: 1 });
      const c = add(p, 'const', { value: 1 });
      wire(p, p.modules[0].id, 'keys', alloc, 'keys');
      wire(p, alloc, 'pitch', p.modules[1].id, 'pitch');
      wire(p, c, 'out', alloc, 'priority');
      return p;
    }],
    ['64: the shorter layout', () => voice('slim'), SLIM],
    ['65: MIDI learn', () => voice('learn', (p, ids) => { p.midiLearn = [{ src: 74, module: ids.osc, param: 'coarse', lo: 0.2, hi: 0.8 }]; })],
    ['67: stereo mode and side cables', () => voice('stereo', (p) => { p.modules[3].stereo = true; })],
  ];
  /** Main's keys through a Harmonizer (and `via` after it) into a Voicing that plays the voice */
  const harmonized = (name: string, harm: Record<string, number>, via?: string): Patch => voice(name, (p, ids) => {
    const h = add(p, 'harm', harm), alloc = add(p, 'alloc', { voices: 4 });
    wire(p, ids.main, 'keys', h, 'keys');
    const mid = via ? add(p, via) : h;
    if (via) wire(p, h, 'keys', mid, 'keys');
    wire(p, mid, 'keys', alloc, 'keys');
    p.cables = p.cables.filter((c) => !(c.from.module === ids.main && c.from.port === 'pitch'));
    wire(p, alloc, 'pitch', ids.osc, 'pitch');
  });
  byFormat.push(['52: the Harmonizer', () => harmonized('harm', {})], ['53: a chained Harmonizer', () => harmonized('chain', {}, 'arp')],
    ['68: the Harmonizer\'s inversion keys', () => harmonized('invkeys', { invkeys: 1 })],
    ['70: a cable into the Freq shifter\'s pm input, its row at 0', () => voice('shift-pm', (p, ids) => {
      const sh = add(p, 'shift', { shift: 0 }), m = add(p, 'osc', { coarse: 12 });
      wire(p, ids.osc, 'out', sh, 'in');
      wire(p, m, 'out', sh, 'pm');
      wire(p, sh, 'up', ids.out, 'r');
    })]);
  // every other format that appends a parameter or a type: that one off its default
  for (let v = WRITE_FLOOR + 1; v <= VERSION; v++) {
    if (v === 52 || v === 68) continue;
    const type = Object.values(DEFS).find((d) => d.since === v && !d.params.some((q) => q.since));
    const param = Object.values(DEFS).flatMap((d) => d.params.filter((q) => q.since === v).map((q) => ({ d, q })))[0];
    if (param) byFormat.push([`${v}: ${param.d.type}.${param.q.name}`, () => voice(param.d.type, (p, ids) => {
      const id = add(p, param.d.type, { [param.q.name]: param.q.max === param.q.default ? param.q.min : param.q.max });
      const into = DEFS[param.d.type].inputs.find((i) => i.kind === 'audio' || i.kind === 'control');
      if (into) wire(p, ids.osc, 'out', id, into.name);
      const out = DEFS[param.d.type].outputs.find((o) => o.kind !== 'keys');
      if (out) wire(p, id, out.name, ids.out, 'r');
    })]);
    else if (type) byFormat.push([`${v}: the ${type.type} type`, () => voice(type.type, (p, ids) => {
      const id = add(p, type.type);
      const into = type.inputs.find((i) => i.kind === 'audio');
      if (into) wire(p, ids.osc, 'out', id, into.name);
      if (type.outputs[0]) wire(p, id, type.outputs[0].name, ids.out, 'r');
    })]);
  }
  for (const [what, mk, force] of byFormat) it(`format ${what}`, () => {
    const p = mk();
    const links = p.modules[0].seq?.links;
    const patterns = new Map<number, Uint8Array>(), store = new Map<number, number>();
    if (links) for (const [k, l] of Object.entries(links)) {
      const src = validatePatch(structuredClone(p), DEFS);
      patterns.set(l.id, encodePayload(src, Number(k)));
      l.hash = payloadHash(src, Number(k));
      store.set(l.id, l.hash);
    }
    const { bin, again } = roundTrip(p, force, links ? store : undefined, links ? patterns : undefined);
    formats.add(bin[1]);
    expect(same(again, bin)).toBe(true);
  });
  it('covers the formats', () => {
    expect([...formats].sort((a, b) => a - b).join(' ')).toBe('46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 70 71 72');
  });

  it('takes a linked pattern from the store, keeps its link, and lists the ids to fetch', () => {
    const p = validatePatch(voice('linked', (q) => {
      add(q, 'steps', {}, { patterns: [{ notes: [{ at: 2, len: 1, note: 67, vel: 100 }], len: 4 }] });
    }), DEFS);
    const payload = encodePayload(p, 1);
    p.modules[0].seq = { links: { 1: { id: 9, hash: payloadHash(p, 1) } } };
    const bin = encodePatch(p, true, 0, 0, new Map([[9, payloadHash(p, 1)]]));
    expect(linkedIds(bin)).toEqual([9]);
    expect(parseBinary(bin)!.patterns).toBeUndefined();   // (the binary leaves the pattern to the store)
    const read = readFromFm1(bin, { name: 'linked', patterns: new Map([[9, payload]]) })!;
    const track = read.patch.modules.find((m) => m.type === 'steps')!;
    expect(track.patterns?.[0]?.notes).toEqual([{ at: 2, len: 1, note: 67, vel: 100 }]);
    expect(read.patch.modules.find((m) => m.type === 'fm1')!.seq?.links?.[1]?.id).toBe(9);
    expect(read.exact).toBe(true);
    // without the store's payload the pattern is empty and the link goes (the binary carries no copy of it)
    const bare = readFromFm1(bin, { name: 'linked' })!;
    expect(bare.patch.modules.find((m) => m.type === 'steps')!.patterns).toBeUndefined();
    expect(bare.patch.modules.find((m) => m.type === 'fm1')!.seq?.links).toBeUndefined();
  });

  it('reads a 1.25 binary with the old master FX bus (formats 55..65) as FX drawers, as opening its JSON does, and writes format 66\'s rack', () => {
    // Monolith D as 1.25.0 wrote it to a slot: format 55, flag bit 14 the D-1010 bus (four stages over its FX device's
    // shapers, choruses, delays and reverb); and the same patch as 1.25.0's JSON (web/presets/00-monolith-d.json at v1.25.0)
    const bin = new Uint8Array(readFileSync(new URL('./test-fixtures/monolith-d-1.25.0.bin', import.meta.url)));
    const opened = validatePatch(JSON.parse(readFileSync(new URL('./test-fixtures/monolith-d-1.25.0.json', import.meta.url), 'utf8')), DEFS);
    const src = parseBinary(bin)!;
    expect(src).not.toBeNull();
    expect(src.version).toBeGreaterThanOrEqual(55);
    expect(src.version).toBeLessThanOrEqual(65);
    expect(src.bus?.map((s) => s.kind)).toEqual([0, 1, 2, 3]);
    expect(src.rack).toBeUndefined();
    const text = (b: BinPatch): string => JSON.stringify(b, (_k, v) => (v instanceof Map ? [...v] : v));
    // what plays: the engine on the device form, a held chord through the drawer's effects switched on
    const render = (p: Patch): Float32Array => {
      const e = new Engine(DEVICE_SR);
      e.load(p, true);
      for (const id of [41, 42, 43, 44, 45, 46, 47]) e.setBypass(id, false);
      for (const n of [48, 55, 60]) e.noteOn(n, 0.8);
      const out = new Float32Array(2 * DEVICE_SR);
      const l = new Float32Array(DEVICE_SR), r = new Float32Array(DEVICE_SR);
      e.render(l, r);
      out.set(l);
      out.set(r, DEVICE_SR);
      return out;
    };
    // (the JSON's values as the binary holds them, Q16.16, as scripts/reader-roundtrip.ts `held` does; a default stays exact)
    const held = structuredClone(opened);
    for (const m of held.modules) {
      const def = (k: string): number | undefined => DEFS[m.type]?.params.find((x) => x.name === k)?.default;
      const q = (v: number, d = NaN): number => (toQ16(v) === toQ16(d) ? d : toQ16(v) / Q);
      for (const k of Object.keys(m.params)) m.params[k] = q(m.params[k], def(k));
      if (m.att) m.att = [q(m.att[0]), q(m.att[1])];
    }
    const heard = render(held);
    expect(heard.some((x) => Math.abs(x) > 1e-3)).toBe(true);
    const targets = (p: Patch): unknown => {
      const e = new Engine(DEVICE_SR);
      e.load(p, true);
      return [PANEL_BUTTONS.map((b) => toggleTargets(p, b)), e['btnTargets']];   // (the engine's own: what each button switches)
    };
    for (const library of [browserLibrary(), [...shippedLibrary(), ...Object.values(FM1_PRESETS).flatMap((mk) => patchDefs(mk()))]]) {
      const read = readFromFm1(bin, { name: 'Monolith D', library })!;
      expect(read).not.toBeNull();
      expect(read.exact).toBe(false);   // (the editor writes no bus)
      // FX drawers, no plain "FX" card
      const asm = read.patch.assemblies!;
      expect(asm.some((a) => a.drawer)).toBe(true);
      expect(asm.some((a) => a.name === 'FX' && !a.drawer)).toBe(false);
      expect(asm.filter((a) => a.drawer).map((a) => a.name)).toEqual(opened.assemblies!.filter((a) => a.drawer).map((a) => a.name));
      // the same sound, and the FX button and the Toggles switch the same modules, as the JSON opened the old way
      expect(read.patch.modules.map((m) => [m.id, m.type])).toEqual(opened.modules.map((m) => [m.id, m.type]));
      const got = render(read.patch);
      expect(got.findIndex((x, i) => x !== heard[i]), 'first sample that differs').toBe(-1);
      expect(targets(read.patch)).toEqual(targets(opened));
      // written back: format 66's rack, byte for byte what the opened JSON writes
      const again = parseBinary(encodePatch(read.patch, true))!;
      expect(again.version).toBeGreaterThanOrEqual(66);
      expect(again.bus).toBeUndefined();
      expect(again.rack?.effects.map((e) => e.targets)).toEqual(src.bus!.map((s) => s.targets));
      expect(text(again)).toBe(text(parseBinary(encodePatch(opened, true))!));
    }
  });

  it('refuses what is no binary it reads', () => {
    const bin = encodePatch(voice('x'), true);
    expect(readFromFm1(bin.slice(0, bin.length - 1), { name: 'x' })).toBeNull();
    expect(readFromFm1([0xa2, ...bin.slice(1)], { name: 'x' })).toBeNull();
    expect(readFromFm1([0xa1, VERSION + 1, ...bin.slice(2)], { name: 'x' })).toBeNull();
    expect(readFromFm1([0xa1, WRITE_FLOOR - 1, ...bin.slice(2)], { name: 'x' })).toBeNull();
  });

  it('says what it opened', () => {
    expect(readLabel({ patch: newPatch(DEFS), devices: 4, recognised: 3, exact: true })).toBe('Read from the FM-1 · layout rebuilt · 3 of 4 assemblies recognised');
    expect(readLabel({ patch: newPatch(DEFS), devices: 0, recognised: 0, exact: true })).toBe('Read from the FM-1 · layout rebuilt · no assemblies');
  });
});
