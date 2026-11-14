// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch } from './patch';
import { deviceView } from './poly';
import { DEVICE, deviceBudget, encodePatch, formatOf, originRecord } from './patchbin';
import { DeviceLink } from './device';
import { patternRevision, PRESET_PATTERNS } from './preset-pattern-data';
function fixture() {
  const p = emptyPatch(), t = addModule(p, DEFS.steps, 0, 0);
  t.factoryPatterns = { version: 1, ids: ['fedcba98'] };
  return { p, t };
}
it('uses format 54 only with origins and counts every section byte', () => {
  const { p, t } = fixture();
  const b = encodePatch(p);
  expect(b[1]).toBe(54); expect(b[7] & 32).toBe(32);
  expect([...b.slice(-8)]).toEqual([1, 0, 0, 0, 0x98, 0xba, 0xdc, 0xfe]);
  const size = deviceBudget(p).items.find((i) => i.key === 'bytes')!.used;
  delete t.factoryPatterns;
  expect(formatOf(p)).toBeLessThan(54);
  expect(size).toBe(deviceBudget(p).items.find((i) => i.key === 'bytes')!.used + 8);
});
it('puts provenance before the final macro ranges', () => {
  const { p } = fixture();
  const filter = addModule(p, DEFS.filter, 0, 0);
  filter.map = { p1: ['cutoff'], p2: [] }; filter.range = { p1: { cutoff: [0.2, 0.8] } };
  const macro = addModule(p, DEFS.lfo, 0, 0);
  const output = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: filter.id, port: 'lp12' }, { module: output.id, port: 'l' });
  connect(p, DEFS, { module: macro.id, port: 'out' }, { module: filter.id, port: 'p1' });
  const b = encodePatch(p);
  expect([...b.slice(-14, -6)]).toEqual([...originRecord(deviceView(p, true).patch)]);
  expect(b[b.length - 6]).toBe(1);
});
it('keeps explicit unknown revisions, rejects unknown JSON versions and never infers legacy provenance', () => {
  const { p, t } = fixture();
  expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules[0].factoryPatterns).toEqual(t.factoryPatterns);
  const raw = JSON.parse(JSON.stringify(p)); raw.modules[0].factoryPatterns.version = 2;
  expect(validatePatch(raw, DEFS).modules[0].factoryPatterns).toBeUndefined();
  delete t.factoryPatterns;
  expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules[0].factoryPatterns).toBeUndefined();
});
it('binds identity to notes and playback settings, independently of object key order', () => {
  const before = PRESET_PATTERNS[0];
  expect(patternRevision(before)).toBe(before.id);
  expect(patternRevision({ ...before, notes: [before.notes[0] ^ 1, ...before.notes.slice(1)] })).not.toBe(before.id);
  expect(patternRevision({ ...before, rate: before.rate + 1 })).not.toBe(before.id);
  expect(new Set(PRESET_PATTERNS.map((p) => p.id)).size).toBe(PRESET_PATTERNS.length);
  expect(PRESET_PATTERNS.some((p) => p.id === '00000000')).toBe(false);
});
it('supports a u16 count past 255 and enforces the actual byte budget', () => {
  const { p, t } = fixture();
  for (let i = 1; i < 16; i++) addModule(p, DEFS.steps, 0, 0);
  for (const m of p.modules) m.factoryPatterns = { version: 1, ids: Array(64).fill('12345678') };
  const rec = originRecord(p);
  expect(new DataView(rec.buffer).getUint16(0, true)).toBe(1024);
  expect(rec.length).toBe(6146);
  expect(deviceBudget(p).items.find((i) => i.key === 'bytes')!.used).toBeGreaterThan(DEVICE.bytes);
  expect(() => encodePatch(p)).toThrow(/budget/);
  t.factoryPatterns!.ids.push('12345678');
  expect(() => originRecord(p)).toThrow(/63/);
});
it.each([null, { min: 31, max: 53 }, { min: 31, max: 54 }])('rejects unsupported provenance before sending any bytes (%j)', async (range) => {
  const { p } = fixture(), link = new DeviceLink();
  // No output is attached: reaching a write would fail differently. Rejection happens before chunk construction/send.
  if (range) link.info = { version: 1, maxModules: 128, maxCables: 255, flashOk: true, patchLoaded: true, midiOut: true, delays: 0, features: 0, patchFormats: range };
  await expect(link.uploadSlotBin(0, 'test', encodePatch(p))).rejects.toThrow(/Update.*origins cannot be removed/);
});
