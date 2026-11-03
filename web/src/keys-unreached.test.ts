// SPDX-License-Identifier: GPL-3.0-only
// The device extras' mark for an engine no keys cable reaches (#215, D-905, D-295): its track byte is KEYS_UNREACHED
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { defIsEngine, wireEngine } from './engines';
import { DEFS } from './modules';
import { newPatch, type Patch } from './patch';
import { deviceSection, encodePatch, extrasRecord, formatOf, KEYS_UNREACHED, keysUnreached } from './patchbin';
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
      // the mark takes no newer format
      expect(encodePatch(p)[1], def.name).toBe(wired);
    }
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
