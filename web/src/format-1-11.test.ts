// SPDX-License-Identifier: GPL-3.0-only
// #667 (format 51, the 1.11 format): a module record carries its parameter count and leaves out the parameters after it,
// which are at their defaults (patchbin.ts COUNTED, storedParams). The encoder writes it only for a patch that would not
// fit the FM-1's bytes in an older format (or that uses something else of 1.11); the budget counts the smaller form.
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from './patch';
import { FLAG_CABLES3, fm1Edits, morphRoom, COUNTED, presenceOf, PRES_ATT1, PRES_P2, REC_TEMPLATE, DEVICE, deviceBudget, deviceSection, encodePatch, FORMAT_1_11, fm1Rows, formatOf, layout, PANEL_BYTES, storedParams, toQ16, TYPE_ORDER, VERSION } from './patchbin';
import { deviceView } from './poly';
import { PRESETS } from './presets';
import { relocatedPatches } from './community-factory';
import { communityEntries } from './community';
import { decodeShare } from './share';
import { oracleMorph, ORACLE_B } from './test-morph';

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
    expect([FORMAT_1_11, COUNTED]).toEqual([51, 51]);
    expect(VERSION).toBeGreaterThanOrEqual(51);   // (1.12 moved on: format-1-12.test.ts)
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
    expect(b[at + 1]).toBe(n | REC_TEMPLATE);   // (its attenuverters and matrix at their template: left out, D-1000)
    expect(rd32(b, at + 2 + 4 * DEFS.lfo.params.findIndex((q) => q.name === 'rate'))).toBe(toQ16(3.5));
    at += 2 + 4 * n + (DEFS.lfo.data ?? 0);
    expect(b[at]).toBe(TYPE_ORDER.indexOf('output'));
    expect(b[at + 1]).toBe(storedParams(out, COUNTED, false, layout(p, undefined, true).keep.get(out.id)).length);
    // with a B side: the module mask, then the LFO's bitmap and its one B value off A (D-1004)
    lfo.paramsB = { ...lfo.params, rate: 7 };
    const m = encodePatch(p, false, true);
    expect(m.length).toBe(b.length + 1 + Math.ceil(n / 8) + 4);
  });

  it('writes the attenuverters and masks only where they are off their template: a presence byte and those items', () => {
    const p = lfoPatch();
    const lfo = p.modules[0];
    lfo.att = [0.5, 1];
    lfo.map!.p2 = ['rate', 'depth'];
    const b = encodePatch(p, false, true);
    const at = 8 + PANEL_BYTES, n = b[at + 1] & 0x3f;
    expect(b[at + 1] & REC_TEMPLATE).toBe(0);
    const blk = at + 2 + 4 * n;
    expect(b[blk]).toBe(PRES_ATT1 | PRES_P2);
    expect(rd32(b, blk + 1)).toBe(toQ16(0.5));
    const bit = (name: string): number => 1 << DEFS.lfo.params.findIndex((q) => q.name === name);
    expect(b[blk + 5] | b[blk + 6] << 8).toBe(bit('rate') | bit('depth'));
    expect(presenceOf(lfo)).toBe(PRES_ATT1 | PRES_P2);
    expect(b.length).toBe(layout(p, undefined, true).size);
  });

  it('writes a morph B side only where it differs from A, and keeps room for the B values the FM-1 may add (D-1004, D-1005)', () => {
    const p = oracleMorph();
    const plain = relocatedPatches['Oracle V']();
    const l = layout(p, undefined, true), lp = layout(plain, undefined, true);
    const { patch: dev } = deviceView(p, true);
    const withB = dev.modules.filter((m) => m.paramsB);
    const bitmaps = withB.reduce((n, m) => n + Math.ceil(storedParams(m, COUNTED, true, l.keep.get(m.id)).length / 8), 0);
    const differ = ORACLE_B.reduce((n, [, , v]) => n + Object.keys(v).length, 0);
    // (the B side: the module mask, a bitmap per module with a B side, the 8 values off A; 187 bytes before D-1004)
    expect(encodePatch(p, false, true).length - encodePatch(plain, false, true).length).toBe(Math.ceil(dev.modules.length / 8) + bitmaps + 4 * differ);
    expect(l.size - lp.size).toBeLessThan(128);   // (50 when measured, 52 with the analog oscillators of #745, 98 with Oracle V's 64 modules of #658: the module mask and a bitmap per module; 187 before D-1004)
    const room = morphRoom(dev, COUNTED, fm1Edits(p, dev, deviceSection(p, dev)), l.keep);
    expect(room).toBeGreaterThan(0);
    expect(l.counted - l.size - room).toBe(lp.counted - lp.size);   // (the budget counts the room, besides the preset names' room)
    expect(morphRoom(dev, COUNTED - 1, fm1Edits(p, dev, deviceSection(p, dev)), l.keep)).toBe(0);   // (an older format writes every B value)
  });

  it('writes the cables in 3 bytes when every port index is under 16, else in 4 (D-1002)', () => {
    const p = lfoPatch();
    const b = encodePatch(p, false, true);
    expect(b[7] & (FLAG_CABLES3 >> 8)).toBeTruthy();
    const main = addModule(p, DEFS.fm1, 0, 0), mix = addModule(p, DEFS.mixer, 0, 0);
    connect(p, DEFS, { module: main.id, port: 'sustain' }, { module: mix.id, port: 'in1' });
    connect(p, DEFS, { module: mix.id, port: 'out' }, { module: p.modules.find((m) => m.type === 'output')!.id, port: 'r' });
    const w = encodePatch(p, false, true);
    expect(w[7] & (FLAG_CABLES3 >> 8)).toBe(0);
    expect(w.length).toBe(layout(p, undefined, true).size);
  });

  it('keeps the k1..k4 knob columns out of the model: validatePatch drops them (D-1001)', () => {
    const p = lfoPatch();
    (p.modules[0].map as Record<string, string[]>).k1 = ['rate'];
    validatePatch(p, DEFS);
    expect(Object.keys(p.modules[0].map!)).toEqual(['p1', 'p2']);
  });

  it('writes a patch that fits in an older format as before (else counted), and counts the smaller form in the budget', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      const l = layout(p);
      // in its old format when that holds it; counted (Wanderer and Vernon 100, with their PATTERN track) when not
      expect(formatOf(p), name).toBe(l.base.bytes <= DEVICE.bytes ? l.base.v : COUNTED);
      expect(deviceBudget(p).items.find((i) => i.key === 'bytes')!.used, name).toBe(Math.min(l.base.bytes, l.counted));
    }
  });

  it('keeps every parameter the FM-1 can change in its copy (rows, card rows, a plain module\'s device), so it never grows there', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
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
