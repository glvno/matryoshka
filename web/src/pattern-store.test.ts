// SPDX-License-Identifier: GPL-3.0-only
// The pattern store (#901): the stored pattern payload (pattern-store.ts), format 59's links section (patchbin.ts
// linkPlan), the budget's view of links, and links left out of share links and files. The firmware writes the same
// payloads (firmware/test/pattern_cases.h from scripts/pattern-vectors.ts).
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type ModuleInst, type Patch } from './patch';
import { deviceBudget, encodePatch, FLAG_LINKS, FLAG_PATTERNS, FORMAT_LINKS, layout, linkPlan, linkRecord, lockRecord, patternRecord, SECTION_FORMATS, VERSION, type LinkStore } from './patchbin';
import { applyPayload, autoName, decodePayload, encodePayload, entryName, fnv, FNV0, fromHex, layoutOf, legacyFactoryStore, patternFile, payloadHash, portablePatch, readPatternFile, storedName, storePlan, withLinks } from './pattern-store';
import LEGACY_FACTORY_PATTERNS from './factory-store.json';
import { deviceView } from './poly';
import { inflate, encodeShare } from './share';
import { fixSeq, LINK_ID_MAX, READ_ONLY_ID, withoutLinks, type StepNote } from './track';
import { patternCases, patternCasesHeader } from '../scripts/pattern-vectors';

const n = (at: number, len: number, note: number, vel = 100, chance?: number): StepNote => ({ at, len, note, vel, ...(chance ? { chance } : {}) });

/** Main, an output, two Steps tracks into it and a Constant (a lock target) */
function rig(): { p: Patch; a: ModuleInst; b: ModuleInst; k: ModuleInst } {
  const p = emptyPatch('PATSTORE');
  addModule(p, DEFS.fm1, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  const [a, b] = [0, 1].map((i) => {
    const m = addModule(p, DEFS.steps, 0, 0);
    connect(p, DEFS, { module: m.id, port: 'pitch' }, { module: out.id, port: i ? 'r' : 'l' });
    return m;
  });
  const k = addModule(p, DEFS.const, 0, 0);
  connect(p, DEFS, { module: k.id, port: 'out' }, { module: out.id, port: 'l' });
  a.notes = [n(0, 1, 36), n(4, 1, 38)];
  a.patterns = [{ notes: [n(0, 2, 36), n(2, 1, 42, 127)] }];
  return { p, a, b, k };
}
const main = (p: Patch): ModuleInst => p.modules.find((m) => m.type === 'fm1')!;
const link = (p: Patch, pat: number, id: number, hash = payloadHash(p, pat)): Patch => {
  main(p).seq = { ...main(p).seq, links: { ...main(p).seq?.links, [pat]: { id, hash } } };
  return p;
};
/** does `hay` hold `needle` as one run */
const holds = (hay: ArrayLike<number>, needle: number[]): boolean => {
  const h = Array.from(hay);
  for (let i = 0; i + needle.length <= h.length; i++) if (needle.every((x, j) => h[i + j] === x)) return true;
  return false;
};
const flags = (b: Uint8Array): number => b[6] | (b[7] << 8);

describe('the stored pattern payload', () => {
  it('hashes with FNV-1a, 32 bits', () => {
    expect(fnv(FNV0, [])).toBe(0x811c9dc5);
    expect(fnv(FNV0, [0x61])).toBe(0xe40c292c);   // "a"
    expect(fnv(FNV0, [...'foobar'].map((c) => c.charCodeAt(0)))).toBe(0xbf9cf968);
  });

  it('writes a pattern on short words, the tracks after the last that has it left out', () => {
    const { p } = rig();
    expect(Array.from(encodePayload(p, 1))).toEqual([1, 0, 0, 0, 0, 1, 2, 0x80, 0xff, 0x10, 0x24, 0x02, 0xaa, 0]);
  });

  it('marks a track without the pattern 0xFF and writes long words, an own length and rate', () => {
    const { p, b } = rig();
    b.patterns = [{ notes: [n(1, 1, 60, 90, 50)], len: 12, rate: 5 }];
    p.modules.find((m) => m.type === 'steps')!.patterns = undefined;
    const w = (1 | (0 << 6) | (60 << 12) | (90 << 19) | (10 << 26)) >>> 0;
    expect(Array.from(encodePayload(p, 1))).toEqual([1, 0, 0, 0, 0, 2, 0xff, 1, 12, 5, w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24, 0]);
  });

  it('writes pattern 1 with no own length or rate, every track having it', () => {
    const { p } = rig();
    expect(Array.from(encodePayload(p, 0))).toEqual([1, 0, 0, 0, 0, 2, 2, 0x80, 0xff, 0x00, 0x24, 0x04, 0x26, 0, 0x80, 0xff, 0]);
  });

  it('carries P-locks with the layout fingerprint, which is never 0', () => {
    const { p, a, k } = rig();
    a.patterns![0]!.locks = [{ at: 2, module: k.id, param: 'value', value: -0.5 }];
    const dev = deviceView(p, true).patch;
    const layout = layoutOf(dev);
    expect(layout).not.toBe(0);
    const ki = dev.modules.findIndex((m) => m.id === k.id), pi = DEFS.const.params.findIndex((q) => q.name === 'value');
    const bytes = Array.from(encodePayload(p, 1));
    expect(bytes.slice(1, 5)).toEqual([layout & 0xff, (layout >>> 8) & 0xff, (layout >>> 16) & 0xff, layout >>> 24]);
    expect(bytes.slice(-10)).toEqual([1, 0, 1, 2, ki, pi, 0x00, 0x80, 0xff, 0xff]);
    expect(decodePayload(bytes).locks).toEqual([{ track: 0, locks: [{ at: 2, module: ki, param: pi, value: -0.5 }] }]);
  });

  it('loads back into the same pattern byte for byte (notes, length, rate, locks)', () => {
    for (const c of patternCases()) {
      const payload = encodePayload(c.patch, c.pattern);
      const fresh = structuredClone(c.patch);
      for (const m of fresh.modules) if (m.type === 'steps') { m.patterns = undefined; m.locks = undefined; if (!c.pattern) m.notes = undefined; }
      const locks = applyPayload(fresh, c.pattern, payload);
      expect(Array.from(encodePayload(fresh, c.pattern)), c.name).toEqual(Array.from(payload));
      expect(locks, c.name).toBe(decodePayload(payload).locks.length ? 'applied' : 'none');
    }
  });

  it('loads into another layout without its locks, drops the pattern from tracks it has nothing for', () => {
    const { p, a, b, k } = rig();
    a.patterns![0]!.locks = [{ at: 2, module: k.id, param: 'value', value: 1 }];
    const payload = encodePayload(p, 1);
    const other = rig();
    other.b.patterns = [{ notes: [n(3, 1, 50)] }];
    const extra = addModule(other.p, DEFS.const, 0, 0);   // (another layout)
    connect(other.p, DEFS, { module: extra.id, port: 'out' }, { module: other.p.modules.find((m) => m.type === 'output')!.id, port: 'r' });
    expect(applyPayload(other.p, 1, payload)).toBe('dropped');
    expect(other.a.patterns![0]).toEqual({ notes: [n(0, 2, 36), n(2, 1, 42, 127)] });
    expect(other.b.patterns).toBeUndefined();
    expect(b.patterns).toBeUndefined();
  });

  it('refuses what is not a payload', () => {
    expect(() => decodePayload([])).toThrow();
    expect(() => decodePayload([2, 0, 0, 0, 0, 1, 0xff, 0])).toThrow();
    expect(() => decodePayload([1, 0, 0, 0, 0, 1, 0xff, 0, 9])).toThrow();   // trailing bytes
    expect(() => decodePayload([1, 5, 0, 0, 0, 1, 0xff, 0])).toThrow();      // a layout without locks
  });

  it('keeps the legacy factory patterns (factory-store.json, frozen) for old links: ids above the user ids, whole payloads', () => {
    const ids = LEGACY_FACTORY_PATTERNS.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.length).toBe(34);   // (the 808 Kit's 23 and the 909 Kit's 11)
    for (const e of LEGACY_FACTORY_PATTERNS) {
      expect(e.id).toBeGreaterThanOrEqual(READ_ONLY_ID);
      expect(e.id).toBeLessThanOrEqual(LINK_ID_MAX);
      expect(storedName(e.name)).toBe(e.name);
      expect(decodePayload(fromHex(e.payload)).tracks.length).toBeGreaterThan(0);
      expect(legacyFactoryStore().get(e.id)).toBe(fnv(FNV0, fromHex(e.payload)));
    }
  });

  it('names a new stored pattern after its patch and number, and keeps names to 16 printable capitals', () => {
    expect(autoName('Scrounge', 2)).toBe('SCROUNGE P3');
    expect(autoName('A very long patch name', 40)).toBe('A VERY LONG P41');
    expect(autoName('A very long patch name', 40).length).toBeLessThanOrEqual(16);
    expect(autoName('A very long patch name', 40).endsWith(' P41')).toBe(true);
    expect(storedName('Dub → Pressure')).toBe('DUB  PRESSURE');
  });

  it('reads back the pattern files it writes, and refuses others', () => {
    const { p } = rig();
    const payload = encodePayload(p, 1);
    const back = readPatternFile(patternFile('My beat', payload));
    expect(back.name).toBe('MY BEAT');
    expect(Array.from(back.payload)).toEqual(Array.from(payload));
    expect(() => readPatternFile('{"format":"matryoshka-presets"}')).toThrow();
    expect(() => readPatternFile(JSON.stringify({ format: 'matryoshka-pattern', version: 1, name: 'x', payload: '0102' }))).toThrow();
  });

  it('writes the cross-language vectors header', () => {
    const h = patternCasesHeader();
    expect(h).toContain(`#define N_PATTERN_CASES ${patternCases().length}`);
    expect(h).toContain('PATTERN_CASES[N_PATTERN_CASES]');
  });
});

describe('format 59: stored pattern links', () => {
  it('is a section format, written only by a patch with a link', () => {
    expect(VERSION).toBeGreaterThan(FORMAT_LINKS);
    expect(FORMAT_LINKS).toBe(59);
    expect(SECTION_FORMATS[59]).toBe('stored pattern links');
    expect(FLAG_LINKS).toBe(0x8000);
    const { p } = rig();
    const plain = encodePatch(p);
    expect(plain[1]).toBeLessThan(FORMAT_LINKS);
    expect(flags(plain) & FLAG_LINKS).toBe(0);
    for (const store of ['assume', 'unknown', 'none', new Map([[5, 1]])] as LinkStore[]) expect(Array.from(encodePatch(p, false, 0, 0, store))).toEqual(Array.from(plain));
  });

  it('validates links: index 1..63, id 1..0xEFFF, a u32 hash', () => {
    expect(fixSeq({ links: { 1: { id: 3, hash: 5 }, 0: { id: 1, hash: 1 }, 64: { id: 1, hash: 1 }, 2: { id: 0xf000, hash: 1 }, 3: { id: 2, hash: -1 }, 4: { id: 2, hash: 2 ** 32 }, x: { id: 1, hash: 1 } } }))
      .toEqual({ links: { 1: { id: 3, hash: 5 } } });
    expect(fixSeq({ links: {} })).toBeUndefined();
    const { p } = rig();
    link(p, 1, 9);
    expect(main(validatePatch(JSON.parse(JSON.stringify(p)), DEFS)).seq?.links).toEqual(main(p).seq?.links);
  });

  it('a clean link to a stored pattern is only the reference: the pattern stays out of the patterns section', () => {
    const { p } = rig();
    link(p, 1, 0x1234);
    const bin = encodePatch(p);   // (the store assumed to hold it, as the budget does)
    expect(bin[1]).toBe(FORMAT_LINKS);
    expect(flags(bin) & FLAG_LINKS).toBe(FLAG_LINKS);
    expect(flags(bin) & FLAG_PATTERNS).toBe(0);
    expect(holds(bin, [1, 1, 0x34, 0x12])).toBe(true);
    expect(Array.from(encodePatch(p, false, 0, 0, new Map([[0x1234, payloadHash(p, 1)]])))).toEqual(Array.from(bin));
  });

  it('an edited link (or a store whose copy differs, or one not read yet) goes inline with the reference, right after the P-locks', () => {
    const { p, a, k } = rig();
    a.locks = [{ at: 0, module: k.id, param: 'value', value: 0.5 }];
    link(p, 1, 7, 12345);
    const dev = deviceView(p, true).patch;
    const tail = [...patternRecord(p, dev), ...lockRecord(p, dev), ...linkRecord([[1, 7]])];
    const dirty = encodePatch(p);
    expect(flags(dirty) & (FLAG_LINKS | FLAG_PATTERNS)).toBe(FLAG_LINKS | FLAG_PATTERNS);
    expect(holds(dirty, tail)).toBe(true);
    link(p, 1, 7);
    for (const store of ['unknown', new Map([[7, 999]])] as LinkStore[]) expect(holds(encodePatch(p, false, 0, 0, store), tail)).toBe(true);
  });

  it('a store without the id (or no store) takes no reference: the pattern goes inline, as without the link', () => {
    const { p } = rig();
    const plain = encodePatch(p);
    link(p, 1, 7);
    expect(Array.from(encodePatch(p, false, 0, 0, new Map()))).toEqual(Array.from(plain));
    expect(Array.from(encodePatch(p, false, 0, 0, 'none'))).toEqual(Array.from(plain));
  });

  it('lists links ascending, the refs only where the store holds the pattern as it is', () => {
    const { p, b } = rig();
    b.patterns = [null, { notes: [n(0, 1, 40)] }];
    link(p, 2, 4);
    link(p, 1, 3, 77);
    const dev = deviceView(p, true).patch;
    expect(linkPlan(p, dev, 'assume')).toEqual({ entries: [[1, 3], [2, 4]], refs: [2] });
    expect(linkPlan(p, dev, new Map([[4, payloadHash(p, 2)]]))).toEqual({ entries: [[2, 4]], refs: [2] });
    expect(linkPlan(p, dev, 'unknown')).toEqual({ entries: [[1, 3], [2, 4]], refs: [] });
    expect(linkPlan(p, dev, 'none')).toEqual({ entries: [], refs: [] });
  });

  it('the budget counts what would be sent: a clean link costs its reference, not its notes', () => {
    const { p, a } = rig();
    a.patterns = [{ notes: Array.from({ length: 16 }, (_, at) => n(at, 1, 40 + at, 100, 50)) }];
    const bytes = (q: Patch): number => deviceBudget(q).items.find((i) => i.key === 'bytes')!.used;
    const inline = bytes(p);
    const clean = bytes(link(structuredClone(p), 1, 5));
    const dirty = bytes(link(structuredClone(p), 1, 5, 1));
    expect(clean).toBe(layout(link(structuredClone(p), 1, 5)).need);
    expect(clean).toBeLessThan(inline);
    expect(dirty).toBeGreaterThan(clean);
    expect(deviceBudget(link(structuredClone(p), 1, 5)).items.find((i) => i.key === 'notes')!.used).toBe(deviceBudget(p).items.find((i) => i.key === 'notes')!.used);
  });

  it('what leaves the editor carries every pattern inside and no link; a factory link gets its entry\'s pattern (G2, #1202)', async () => {
    const { p, a } = rig();
    link(p, 1, 9);
    expect(main(withoutLinks(p)).seq).toBeUndefined();
    main(p).seq!.pattern = 1;
    expect(main(withoutLinks(p)).seq).toEqual({ pattern: 1 });
    expect(main(p).seq?.links).toBeDefined();   // (the patch itself keeps them)
    const s = await encodeShare(p);
    const shared = JSON.parse(await inflate(s.full)) as Patch;
    expect(main(shared).seq).toEqual({ pattern: 1 });
    expect(shared.modules.find((m) => m.id === a.id)!.patterns).toEqual(a.patterns);   // (the linked pattern's own notes)
    const plain = rig().p;
    expect(portablePatch(plain)).toBe(plain);
    // a factory link whose pattern the patch does not hold: the entry's payload comes in, the link goes
    const legacy = LEGACY_FACTORY_PATTERNS[0], kit = { id: legacy.id, hash: fnv(FNV0, fromHex(legacy.payload)) };
    const q = rig().p;
    q.modules.filter((m) => m.type === 'steps').forEach((m) => delete m.patterns);
    link(q, 2, kit.id, kit.hash);
    const out = portablePatch(q);
    expect(main(out).seq?.links).toBeUndefined();
    expect(fnv(FNV0, encodePayload(out, 2))).toBe(kit.hash);
    expect(main(q).seq?.links?.[2]).toEqual({ id: kit.id, hash: kit.hash });   // (the editor's own copy keeps it)
    expect(main(JSON.parse(await inflate((await encodeShare(q)).full)) as Patch).seq?.links).toBeUndefined();
  });

  it('for an FM-1 that stores every pattern (#1202), each pattern with content is a link and a reference, and only pattern 1 counts', () => {
    const { p, a, b } = rig();
    a.patterns = [{ notes: Array.from({ length: 16 }, (_, at) => n(at, 1, 40 + at, 100, 50)) }];
    b.patterns = [null, null, { notes: [n(0, 1, 40)] }];
    const dev = deviceView(p, true).patch;
    expect(linkPlan(p, dev, 'every')).toEqual({ entries: [[1, 1], [3, 1]], refs: [1, 3] });
    link(p, 3, 77);
    expect(linkPlan(p, dev, 'every').entries).toEqual([[1, 1], [3, 77]]);
    const bytes = (store: 'assume' | 'every'): number => deviceBudget(p, 0, store).items.find((i) => i.key === 'bytes')!.used;
    expect(bytes('every')).toBeLessThan(bytes('assume'));
    const bin = encodePatch(p, false, 0, 0, 'every');
    expect(flags(bin) & FLAG_PATTERNS).toBe(0);
    expect(flags(bin) & FLAG_LINKS).toBe(FLAG_LINKS);
    // (the stand-in ids are as long as real ones: the binary a send makes has the same length)
    expect(encodePatch(withLinks(p, { 1: { id: 300, hash: payloadHash(p, 1) }, 3: { id: 301, hash: payloadHash(p, 3) } })).length).toBe(bin.length);
  });

  it('a send reuses an entry of the same payload (hash and length), else makes one named after the patch', () => {
    const { p, a, b } = rig();
    b.patterns = [null, { notes: [n(0, 1, 40)] }, null, { notes: [n(0, 1, 40)] }];
    a.patterns = [{ notes: [n(0, 2, 36)] }];
    const pay = (k: number): Uint8Array => encodePayload(p, k);
    expect(fnv(FNV0, pay(2))).toBe(fnv(FNV0, pay(4)));
    const entry = (id: number, payload: Uint8Array, len = payload.length) => ({ id, len, hash: fnv(FNV0, payload), layout: 0, tracks: 2, readOnly: false, kept: false, name: 'X' });
    const plan = storePlan(p, [entry(5, pay(1)), entry(3, pay(1)), entry(9, pay(2), 1)], 'A long patch name');
    expect(plan.links).toEqual({ 1: { id: 3, hash: fnv(FNV0, pay(1)) } });   // (the lowest id; 9 has another length)
    expect(plan.put.map((e) => [e.ps, e.name])).toEqual([[[2, 4], 'A LONG PATCH P03']]);
    link(p, 1, 5);
    expect(storePlan(p, [entry(3, pay(1)), entry(5, pay(1))]).links[1].id).toBe(5);   // (the one it links already)
    expect(storePlan(p, [{ ...entry(0xff00, pay(1)), readOnly: true }]).links[1]).toBeUndefined();   // (never an id above LINK_ID_MAX)
    expect(entryName('909 Kit', 2)).toBe('909 KIT P03');
    expect(entryName('909 Kit', 63)).toBe('909 KIT P64');
    expect(entryName('Twelve chars and more', 9).length).toBeLessThanOrEqual(16);
  });
});
