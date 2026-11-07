// SPDX-License-Identifier: GPL-3.0-only
// #667 (format 51, the 1.11 format): a module record carries its parameter count and leaves out the parameters after it,
// which are at their defaults (patchbin.ts COUNTED, storedParams). The encoder writes it only for a patch that would not
// fit the FM-1's bytes in an older format (or that uses something else of 1.11); the budget counts the smaller form.
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { COUNTED, DEVICE, deviceBudget, deviceSection, encodePatch, FORMAT_1_11, fm1Rows, formatOf, layout, PANEL_BYTES, storedParams, toQ16, TYPE_ORDER, VERSION } from './patchbin';
import { deviceView } from './poly';
import { FM1_PRESETS } from './presets';
import { communityEntries } from './community';
import { decodeShare } from './share';

/** an LFO into the Output */
function lfoPatch(): Patch {
  const p = emptyPatch();
  const lfo = addModule(p, DEFS.lfo, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'l' });
  return p;
}
const rd32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getInt32(at, true);

describe('counted records (#667, format 51)', () => {
  it('is the 1.11 format', () => {
    expect([VERSION, FORMAT_1_11, COUNTED]).toEqual([51, 51, 51]);
  });

  it('keeps a record\'s parameters up to the last one off its default, on either morph side, and at least `keep`', () => {
    const p = lfoPatch();
    const lfo = p.modules[0];
    const all = DEFS.lfo.params.map((q) => q.name);
    expect(storedParams(lfo, COUNTED, false)).toEqual([]);
    expect(storedParams(lfo, COUNTED - 1, false).length).toBe(all.length);   // (an older format: every parameter of it)
    lfo.params[all[2]] = DEFS.lfo.params[2].default + 1;
    expect(storedParams(lfo, COUNTED, false).map((q) => q.name)).toEqual(all.slice(0, 3));
    lfo.paramsB = { ...lfo.params, [all[5]]: DEFS.lfo.params[5].default + 1 };
    expect(storedParams(lfo, COUNTED, true).map((q) => q.name)).toEqual(all.slice(0, 6));
    expect(storedParams(lfo, COUNTED, false).map((q) => q.name)).toEqual(all.slice(0, 3));   // (no B set: B is not written)
    expect(storedParams(lfo, COUNTED, false, 4).length).toBe(4);
    expect(storedParams(lfo, COUNTED, false, 99).length).toBe(all.length);
  });

  it('writes the count after the type byte, then only those parameters, and the morph B set with as many', () => {
    const p = lfoPatch();
    const [lfo, out] = p.modules;
    lfo.params.rate = 3.5;
    const b = encodePatch(p, false, true);
    const { size, keep } = layout(p, undefined, true);
    expect(b[1]).toBe(COUNTED);
    expect(b.length).toBe(size);
    expect(keep.get(lfo.id)).toBe(DEFS.lfo.params.length);   // (a plain module's device: the FM-1 pages all of them)
    keep.delete(lfo.id);
    let at = 8 + PANEL_BYTES;
    expect(b[at]).toBe(TYPE_ORDER.indexOf('lfo'));
    const n = storedParams(lfo, COUNTED, false, DEFS.lfo.params.length).length;
    expect(b[at + 1]).toBe(n);
    expect(rd32(b, at + 2 + 4 * DEFS.lfo.params.findIndex((q) => q.name === 'rate'))).toBe(toQ16(3.5));
    at += 2 + 4 * n + (DEFS.lfo.paramInputs ? 8 + 6 * 2 : 0) + (DEFS.lfo.data ?? 0);
    expect(b[at]).toBe(TYPE_ORDER.indexOf('output'));
    expect(b[at + 1]).toBe(storedParams(out, COUNTED, false, layout(p, undefined, true).keep.get(out.id)).length);
    // with a B side: one B value per parameter the record holds
    lfo.paramsB = { ...lfo.params, rate: 7 };
    const m = encodePatch(p, false, true);
    expect(m.length).toBe(b.length + 4 * n + 4 * b[at + 1] + 1);   // (+ the B modules mask)
  });

  it('writes a patch that fits in an older format as before (else counted), and counts the smaller form in the budget', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const l = layout(p);
      // in its old format when that holds it; counted (Wanderer and Vernon 100, with their PATTERN track) when not
      expect(formatOf(p), name).toBe(l.base.bytes <= DEVICE.bytes ? l.base.v : COUNTED);
      expect(deviceBudget(p).items.find((i) => i.key === 'bytes')!.used, name).toBe(Math.min(l.base.bytes, l.counted));
    }
  });

  it('keeps every parameter the FM-1 can change in its copy (rows, card rows, a plain module\'s device), so it never grows there', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const { patch: dev } = deviceView(p, true);
      const keep = fm1Rows(p, dev, deviceSection(p, dev));
      for (const d of deviceSection(p, dev)) {
        if (d.module !== undefined) expect(keep.get(d.module), name).toBe(DEFS[dev.modules.find((m) => m.id === d.module)!.type].params.length);
        for (const pg of d.pages) for (const r of pg.rows) {
          const m = dev.modules.find((x) => x.id === r.module)!;
          if (m.type === 'part') continue;
          const i = DEFS[m.type].params.findIndex((q) => q.name === r.param);
          expect(storedParams(m, COUNTED, false, keep.get(m.id)).length, `${name} ${r.param}`).toBeGreaterThan(i);
        }
      }
    }
  });

  it('Lire + Elvira fits the FM-1 again: 3942 bytes before, counted records under 3840', async () => {
    const e = communityEntries().find((x) => x.title === 'Lire + Elvira')!;
    const p = await decodeShare(e.code, DEFS);
    const l = layout(p);
    expect(l.base.bytes).toBeGreaterThan(DEVICE.bytes);
    expect(l.counted).toBeLessThanOrEqual(DEVICE.bytes);
    const budget = deviceBudget(p);
    expect(budget.over).toEqual([]);
    const b = encodePatch(p);
    expect(b[1]).toBe(COUNTED);
    expect(b.length).toBeLessThanOrEqual(DEVICE.bytes);
  });
});
