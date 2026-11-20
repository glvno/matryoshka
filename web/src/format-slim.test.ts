// SPDX-License-Identifier: GPL-3.0-only
// D-1025, D-1026 (format 64's shorter layout, patchbin.ts SLIM): the panel labels by their length, the cables grouped by the
// module they go into, only the Drum map row names off their default. The encoder writes it only for a patch with an EQ
// or one that fits the FM-1's bytes in no older form; the budget counts the smallest form.
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { cablesGrouped, COUNTED, DEVICE, drumNamed, encodePatch, FLAG_CABLES3, FLAG_NAMES, GROUP_REC, layout, panelBytes, PANEL_BYTES, SLIM } from './patchbin';
import { deviceView } from './poly';
import { FM1_PRESETS } from './presets';

/** Main's keys into a Drum map, an LFO into the Output (`labels`: Main's panel labels) */
function kit(labels: Record<string, string> = {}): Patch {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0), map = addModule(p, DEFS.drummap, 0, 0);
  const lfo = addModule(p, DEFS.lfo, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  main.panel = { labels };
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: map.id, port: 'keys' });
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: out.id, port: 'r' });
  return p;
}

describe("format 64's shorter layout (D-1025)", () => {
  it('writes the panel labels by their length: the masks, a byte of the labels it holds, each a length and its characters', () => {
    const p = kit({ lfo: 'wobble' });
    const b = encodePatch(p, false, SLIM);
    const { patch: dev, groups } = deviceView(p, true);
    const at = 8 + GROUP_REC * groups.length + (groups.length ? dev.modules.length : 0);
    expect(b[1]).toBe(SLIM);
    expect(b[at + 4]).toBe(1 << 3);   // (PANEL_LABEL_KEYS: fx, scl, env, lfo, ...)
    expect(b[at + 5]).toBe(6);
    expect(String.fromCharCode(...b.slice(at + 6, at + 12))).toBe('WOBBLE');
    expect(panelBytes(dev, SLIM)).toBe(5 + 1 + 6);
    expect(panelBytes(dev, COUNTED)).toBe(PANEL_BYTES);
    expect(b.length).toBe(layout(p, undefined, SLIM).size);
  });

  it('writes only the Drum map row names off their default, the others are the default on the FM-1', () => {
    const p = kit();
    const map = p.modules.find((m) => m.type === 'drummap')!;
    const plain = encodePatch(p, false, SLIM);
    map.names = ['', 'SD'];
    expect(drumNamed(map, 0)).toBe(false);
    expect(drumNamed(map, 1)).toBe(true);
    const named = encodePatch(p, false, SLIM);
    expect((named[6] | named[7] << 8) & FLAG_NAMES).toBeTruthy();
    expect(named.length - plain.length).toBe(1 + 2);   // (row 2's length and its two characters)
    expect(encodePatch(p, false, COUNTED).length - named.length).toBeGreaterThan(8 * 8);
  });

  it('groups the cables by the module they go into when every port index is under 16, else 4 bytes a cable', () => {
    const p = kit();
    const { patch: dev } = deviceView(p, true);
    expect(cablesGrouped(dev, SLIM)).toBe(true);
    expect(cablesGrouped(dev, COUNTED)).toBe(false);
    const b = encodePatch(p, false, SLIM);
    expect(b[7] & (FLAG_CABLES3 >> 8)).toBeTruthy();
    const main = p.modules.find((m) => m.type === 'fm1')!, mix = addModule(p, DEFS.mixer, 0, 0);
    connect(p, DEFS, { module: main.id, port: 'sustain' }, { module: mix.id, port: 'in1' });
    connect(p, DEFS, { module: mix.id, port: 'out' }, { module: p.modules.find((m) => m.type === 'output')!.id, port: 'l' });
    const w = encodePatch(p, false, SLIM);
    expect(w[7] & (FLAG_CABLES3 >> 8)).toBe(0);
    expect(w.length).toBe(layout(p, undefined, SLIM).size);
  });

  it('keeps every factory patch in its older format unless none holds it, and counts the smallest form', () => {
    const slim: string[] = [];
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const l = layout(make());
      if (l.v === SLIM) {
        slim.push(name);
        expect(Math.min(l.base.bytes, l.counted), name).toBeGreaterThan(DEVICE.bytes);
      }
      expect(l.need, name).toBe(Math.min(l.base.bytes, l.counted, l.slim));
      expect(l.slim, name).toBeLessThan(l.base.bytes);
    }
    // (Scrounge's ten grooves fit only in the shorter layout, so it needs firmware 1.22: D-1056)
    expect(slim).toEqual(['Scrounge']);
    expect(DEVICE.bytes - layout(FM1_PRESETS['909 Kit']()).need).toBeGreaterThan(300);
  });

  it('writes format 64 for a patch that fits the FM-1 in no older form', () => {
    const p = FM1_PRESETS.Canvas();
    const out = p.modules.find((m) => m.type === 'output')!;
    while (layout(p).base.bytes <= DEVICE.bytes)
      connect(p, DEFS, { module: addModule(p, DEFS.const, 0, 0).id, port: 'out' }, { module: out.id, port: 'l' });
    const l = layout(p);
    expect(l.counted).toBeGreaterThan(DEVICE.bytes);
    expect(l.v).toBe(SLIM);
    expect(l.need).toBeLessThanOrEqual(DEVICE.bytes);
    expect(encodePatch(p)[1]).toBe(SLIM);
  });
});
