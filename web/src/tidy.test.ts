// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { makeAssembly, overlaps } from './assembly';
import { DEFS } from './modules';
import { addModule, emptyPatch, type Patch } from './patch';
import { PRESETS } from './presets';
import { isPile, TIDY_GAP, tidy, tidyAssembly, type TidySizes } from './tidy';

const W = 250;
const H = 300;
const sizes: TidySizes = { module: () => ({ w: W, h: H }), container: () => ({ w: W, h: 200 }), frame: () => ({ pad: 12, head: 30, minW: 0 }) };
const at = (p: Patch, id: number) => { const m = p.modules.find((x) => x.id === id)!; return [m.x, m.y]; };

describe('tidy up', () => {
  it('snaps cards into columns, keeping which column they are in and their order down it', () => {
    const p = emptyPatch();
    const a = addModule(p, DEFS.osc, 33, 400);
    const b = addModule(p, DEFS.lfo, 60, 10);
    const c = addModule(p, DEFS.vca, 700, 250);
    tidy(p, sizes);
    expect(at(p, b.id)).toEqual([TIDY_GAP, TIDY_GAP]);
    expect(at(p, a.id)).toEqual([TIDY_GAP, TIDY_GAP + H + TIDY_GAP]);
    expect(at(p, c.id)).toEqual([TIDY_GAP + W + TIDY_GAP, TIDY_GAP]);
  });

  it('moves an expanded assembly as one block, tidied inside, with nothing overlapping its frame', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 500, 500);
    const y = addModule(p, DEFS.adsr, 530, 700);
    const free = addModule(p, DEFS.noise, 40, 40);
    const asm = makeAssembly(p, [x.id, y.id], 'v');
    asm.open = true;
    asm.frameSize = { width: 2000, height: 2000 };
    tidy(p, sizes);
    expect(asm.frameSize).toBeUndefined();
    // the frame starts right of the free card's column, its content one header and padding lower
    const fx = TIDY_GAP + W + TIDY_GAP;
    expect(at(p, x.id)).toEqual([fx + 12, TIDY_GAP + 12 + 30]);
    expect(at(p, y.id)).toEqual([fx + 12, TIDY_GAP + 12 + 30 + H + TIDY_GAP]);
    const frame = { x: fx, y: TIDY_GAP, w: W + 24, h: 2 * H + TIDY_GAP + 24 + 30 };
    const [fx0, fy0] = at(p, free.id);
    expect(overlaps(frame, { x: fx0, y: fy0, w: W, h: H })).toBe(false);
  });

  it('leaves skipped modules (the docked Main) where they are, and is idempotent', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 900, 900);
    addModule(p, DEFS.osc, 300, 300);
    tidy(p, sizes, new Set([kb.id]));
    const once = JSON.stringify(p);
    tidy(p, sizes, new Set([kb.id]));
    expect(JSON.stringify(p)).toBe(once);
    expect(at(p, kb.id)).toEqual([900, 900]);
  });

  it('tidies one assembly inside from its top left, leaving the rest of the canvas alone', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 500, 500);
    const y = addModule(p, DEFS.adsr, 500, 500); // stacked on x, as an old file leaves them
    const free = addModule(p, DEFS.noise, 900, 40);
    const asm = makeAssembly(p, [x.id, y.id], 'v');
    asm.open = true;
    tidyAssembly(p, asm, sizes);
    expect(at(p, x.id)).toEqual([500, 500]);
    expect(at(p, y.id)).toEqual([500, 500 + H + TIDY_GAP]);
    expect(at(p, free.id)).toEqual([900, 40]);
  });

  it('packs a later column into the room beside a narrow card under a wide one (#121)', () => {
    const p = emptyPatch();
    const size: Record<number, { w: number; h: number }> = {};
    const card = (type: string, x: number, y: number, w: number, h: number): number => {
      const m = addModule(p, DEFS[type], x, y);
      size[m.id] = { w, h };
      return m.id;
    };
    card('lfo', 0, 0, 150, 250);
    const wide = card('osc', 300, 0, 600, 270);
    const narrow = card('filter', 300, 300, 400, 300);
    const mix1 = card('mixer', 1000, 0, 170, 90);
    const mix2 = card('mixer', 1000, 100, 170, 90);
    const big = card('reverb', 1000, 300, 400, 300);
    const out = card('output', 1500, 0, 150, 50);
    const sz: TidySizes = { ...sizes, module: (id) => size[id] };
    tidy(p, sz);
    const box = (id: number) => { const [x, y] = at(p, id); return { x, y, ...size[id] }; };
    // the big card sits beside the narrow one, under the wide one, not right of the wide one's column
    expect(box(big).x).toBe(box(narrow).x + 400 + TIDY_GAP);
    expect(box(big).y).toBeGreaterThanOrEqual(box(wide).y + 270 + TIDY_GAP);
    // the columns keep their order and their order down the column
    expect(box(mix1).x).toBeGreaterThan(box(wide).x);
    expect(box(mix2).y).toBeGreaterThan(box(mix1).y);
    expect(box(big).y).toBeGreaterThan(box(mix2).y);
    expect(box(out).x).toBeGreaterThan(box(mix1).x);
    const ids = Object.keys(size).map(Number);
    for (const a of ids) for (const b of ids) if (a < b) expect(overlaps(box(a), box(b))).toBe(false);
  });

  it('spreads a pile (a share link without its layout) over the canvas, wider than tall, in the patch order', () => {
    const p = emptyPatch();
    const ids = Array.from({ length: 12 }, () => addModule(p, DEFS.osc, 0, 0).id);
    expect(isPile(p, sizes)).toBe(true);
    tidy(p, sizes);
    expect(isPile(p, sizes)).toBe(false);
    const boxes = ids.map((id) => { const [x, y] = at(p, id); return { x, y, w: W, h: H }; });
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
    const right = Math.max(...boxes.map((b) => b.x + b.w)), bottom = Math.max(...boxes.map((b) => b.y + b.h));
    expect(right).toBeGreaterThan(bottom); // not one tall column
    expect(at(p, ids[0])).toEqual([TIDY_GAP, TIDY_GAP]);
  });

  it('every factory patch, its cards piled at 0, 0: spread out with nothing overlapping', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      for (const m of p.modules) m.x = m.y = 0;
      for (const a of p.assemblies ?? []) a.x = a.y = 0;
      const size = (id: number) => ({ w: 200 + (id % 5) * 60, h: 120 + (id % 7) * 50 });
      const sz: TidySizes = { module: size, container: size, frame: () => ({ pad: 12, head: 30, minW: 0 }) };
      tidy(p, sz);
      const inAsm = new Set((p.assemblies ?? []).flatMap((a) => a.modules));
      const boxes = [
        ...p.modules.filter((m) => !inAsm.has(m.id)).map((m) => ({ x: m.x, y: m.y, ...size(m.id) })),
        ...(p.assemblies ?? []).filter((a) => !a.open && !(p.assemblies ?? []).some((b) => b.children?.includes(a.id))).map((a) => ({ x: a.x, y: a.y, ...size(a.id) })),
      ];
      boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b), name).toBe(false)));
    }
  });

  it('every factory patch: nothing overlaps, tidied once or again (a packed layout may read as other columns)', () => {
    for (const [name, make] of Object.entries(PRESETS)) for (const times of [1, 2]) {
      const p = make();
      const size = (id: number) => ({ w: 200 + (id % 5) * 60, h: 120 + (id % 7) * 50 });
      const sz: TidySizes = { module: size, container: size, frame: () => ({ pad: 12, head: 30, minW: 0 }) };
      for (let k = 0; k < times; k++) tidy(p, sz);
      const inAsm = new Set((p.assemblies ?? []).flatMap((a) => a.modules));
      const boxes = [
        ...p.modules.filter((m) => !inAsm.has(m.id)).map((m) => ({ x: m.x, y: m.y, ...size(m.id) })),
        ...(p.assemblies ?? []).filter((a) => !a.open && !(p.assemblies ?? []).some((b) => b.children?.includes(a.id))).map((a) => ({ x: a.x, y: a.y, ...size(a.id) })),
      ];
      boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b), name).toBe(false)));
    }
  });
});
