// SPDX-License-Identifier: GPL-3.0-only
// The device extras' mark for an engine no keys cable reaches (#215, D-905, D-295): its track byte is KEYS_UNREACHED
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { defIsEngine, wireEngine } from './engines';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';
import { deviceSection, encodePatch, extrasRecord, formatOf, KEYS_UNREACHED, KEYS_UNREACHED_TRACK, keysUnreached } from './patchbin';
import { deviceView } from './poly';

/** the extras' track byte of each device the binary lists, by device key */
function trackBytes(p: Patch): Map<string, number> {
  const dev = deviceView(p, true).patch;
  const devs = deviceSection(p, dev);
  const rec = extrasRecord(devs, p, dev);
  const out = new Map<string, number>();
  let at = 1;
  for (const d of devs) {
    out.set(d.key, rec[at]);
    at += 6 + rec[at + 5];
    at += 1 + 2 * rec[at];
    at += 1 + rec[at];
  }
  return out;
}

const ENGINES = FACTORY.filter((d) => defIsEngine(d));

describe('an engine no keys cable reaches (#215)', () => {
  it('is marked in the device extras (KEYS_UNREACHED) until Main\'s keys reach it, for every factory engine', () => {
    expect(ENGINES.length).toBeGreaterThan(5);
    for (const def of ENGINES) {
      const p = newPatch(DEFS);
      const a = insertAssembly(p, DEFS, def, 0, 0);
      wireEngine(p, a);   // (its audio into the Output: the device form drops what does not reach it)
      const d = deviceSection(p, deviceView(p, true).patch).find((x) => x.asm === a.id);
      expect(d, def.name).toBeDefined();
      expect(keysUnreached(p, d!), def.name).toBe(false);
      expect(trackBytes(p).get(d!.key), def.name).toBe(0xff);
      const wired = formatOf(p);
      const main = p.modules.find((m) => m.type === 'fm1')!;
      const keys = p.cables.filter((c) => c.from.module === main.id && c.from.port === 'keys');
      expect(keys.length, def.name).toBeGreaterThan(0);
      p.cables = p.cables.filter((c) => !keys.includes(c));
      expect(keysUnreached(p, d!), def.name).toBe(true);
      expect(trackBytes(p).get(d!.key), def.name).toBe(KEYS_UNREACHED);
      // the mark takes no newer format (an engine no keys reach may take an older one: its Voicing's cables go, #681)
      expect(encodePatch(p)[1], def.name).toBeLessThanOrEqual(wired);
      expect(encodePatch(p)[1], def.name).toBe(formatOf(p));
    }
  });

  it('a Steps track driving it through pitch or trig keeps its number, with the mark\'s bit (#633, D-295)', () => {
    let seen = 0;
    for (const def of ENGINES) {
      const p = newPatch(DEFS);
      const a = insertAssembly(p, DEFS, def, 0, 0);
      wireEngine(p, a);
      const main = p.modules.find((m) => m.type === 'fm1')!;
      p.cables = p.cables.filter((c) => !(c.from.module === main.id && c.from.port === 'keys'));
      const t = addModule(p, DEFS.steps, 0, 0);
      if (!a.inputs.some((r) => ['trig', 'pitch'].some((o) => connect(p, DEFS, { module: t.id, port: o }, { module: r.module, port: r.port })))) continue;
      const dev = deviceView(p, true).patch;
      const devs = deviceSection(p, dev);
      const d = devs.find((x) => x.asm === a.id)!;
      const track = devs.findIndex((x) => x.module === t.id);
      expect(d.track, def.name).toBe(t.id);
      expect(track, def.name).toBeGreaterThanOrEqual(0);
      expect(keysUnreached(p, d), def.name).toBe(true);
      expect(trackBytes(p).get(d.key), def.name).toBe(KEYS_UNREACHED_TRACK | track);
      seen++;
    }
    expect(seen, 'engines a track can drive by pitch or trig').toBeGreaterThan(0);
  });

  it('a device that is no engine is never marked', () => {
    const p = newPatch(DEFS);
    const dev = deviceView(p, true).patch;
    const devs = deviceSection(p, dev);
    expect(devs.length).toBeGreaterThan(0);
    for (const d of devs) expect(keysUnreached(p, d)).toBe(false);
    expect([...trackBytes(p).values()].every((b) => b === 0xff)).toBe(true);
  });
});
