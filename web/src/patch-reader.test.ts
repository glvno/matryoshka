// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 reader (patch-reader.ts, bin-parse.ts, D-1354): a binary read back is a patch that writes the same bytes, in
// every format the encoder writes, with its patterns from the FM-1's store where the binary links them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, newPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { COUNTED, encodePatch, SLIM, VERSION, WRITE_FLOOR } from './patchbin';
import { linkedIds, parseBinary } from './bin-parse';
import { readFromFm1, readLabel, type FromFm1 } from './patch-reader';
import { FM1_PRESETS, make } from './presets';
import { browserLibrary, patchDefs, shippedLibrary } from './assembly-match';
import { encodePayload, payloadHash } from './pattern-store';
import { setKind, setSwitches } from './buttons';

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
    ['68: the Harmonizer\'s inversion keys', () => harmonized('invkeys', { invkeys: 1 })]);
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
    expect([...formats].sort((a, b) => a - b).join(' ')).toBe('46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68');
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

  it('reads a 1.25 binary with the old master FX bus (formats 55..65): the same sound, the bus effects a plain card, no bus written back', () => {
    // Monolith D as 1.25.0 wrote it to a slot: format 55, flag bit 14 the D-1010 bus (four stages over its FX device's
    // shapers, choruses, delays and reverb)
    const bin = new Uint8Array(readFileSync(new URL('./test-fixtures/monolith-d-1.25.0.bin', import.meta.url)));
    const src = parseBinary(bin)!;
    expect(src).not.toBeNull();
    expect(src.version).toBeGreaterThanOrEqual(55);
    expect(src.version).toBeLessThanOrEqual(65);
    expect(src.bus).toBe(true);
    expect(src.rack).toBeUndefined();
    for (const library of [browserLibrary(), [...shippedLibrary(), ...Object.values(FM1_PRESETS).flatMap((mk) => patchDefs(mk()))]]) {
      const read = readFromFm1(bin, { name: 'Monolith D', library })!;
      expect(read).not.toBeNull();
      expect(read.exact).toBe(false);   // (the editor writes no bus)
      expect([read.devices, read.recognised]).toEqual([2, 1]);   // (Monolith D rebuilt; the bus's FX device has no definition)
      const again = parseBinary(encodePatch(read.patch, true))!;
      // what the FM-1 plays: the bus is metadata the engine skips (eng_skip_fx), the cables carry the sound
      for (const k of ['modules', 'cables', 'groups', 'routes', 'panel', 'buttons', 'devices'] as const) expect(again[k], k).toEqual(src[k]);
      expect(again.version).toBe(src.version);
      expect(again.bus).toBe(false);
      expect(again.rack).toBeUndefined();
      expect(again.flags).toBe(src.flags & ~(1 << 14));
      // the bus's FX device comes back as a plain card, not an FX drawer (nothing in the binary but the bus says it was
      // one, and the reader drops the bus); its device extras list the same members, its rows in the card's own order
      const fx = read.patch.assemblies!.find((a) => a.name === 'FX')!;
      expect(fx.drawer).toBeUndefined();
      expect(read.patch.assemblies!.some((a) => a.drawer)).toBe(false);
      expect(fx.modules.map((id) => read.patch.modules.find((m) => m.id === id)!.type)).toEqual(expect.arrayContaining(['shape', 'chorus', 'delay', 'reverb']));
      const fxExtra = src.extras.findIndex((e) => e.members.length && e.track === 255 && e.structure !== 0);
      expect(again.extras[fxExtra].members).toEqual(src.extras[fxExtra].members);
      expect([...again.extras[fxExtra].rows].sort()).toEqual([...src.extras[fxExtra].rows].sort());
      expect(again.extras.filter((_, i) => i !== fxExtra)).toEqual(src.extras.filter((_, i) => i !== fxExtra));
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
