// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { childrenOf, makeAssembly, overlaps, parentOf, type AssemblyInst, type Rect } from './assembly';
import { DEFS } from './modules';
import { addModule, emptyPatch, type Patch } from './patch';
import { PRESETS } from './presets';
import { clearAround, isPile, pushAside, TIDY_GAP, tidy, tidyAssembly, type TidySizes } from './tidy';

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

/** two boxes come closer than TIDY_GAP */
const close = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w + TIDY_GAP && b.x < a.x + a.w + TIDY_GAP && a.y < b.y + b.h + TIDY_GAP && b.y < a.y + a.h + TIDY_GAP;

describe('an expanded frame pushes its neighbours aside (#206)', () => {
  const frame = { x: 100, y: 100, w: 600, h: 400 };

  it('moves what it covers the shortest way out, and leaves what it does not touch', () => {
    const [right, below, far] = pushAside(frame, [
      { x: 650, y: 120, w: 200, h: 200 },   // over the right edge: right is shorter
      { x: 150, y: 480, w: 200, h: 200 },   // over the bottom edge: down is shorter
      { x: 2000, y: 2000, w: 200, h: 200 },
    ]);
    expect(right).toEqual({ x: 100 + 600 + TIDY_GAP, y: 120, w: 200, h: 200 });
    expect(below).toEqual({ x: 150, y: 100 + 400 + TIDY_GAP, w: 200, h: 200 });
    expect(far).toEqual({ x: 2000, y: 2000, w: 200, h: 200 });
  });

  it('pushes on through a row: a card it moved into another moves that one too, keeping their order', () => {
    const row = [{ x: 680, y: 150, w: 200, h: 200 }, { x: 900, y: 150, w: 200, h: 200 }, { x: 1120, y: 150, w: 200, h: 200 }];
    const out = pushAside(frame, row);
    expect(out.map((r) => r.x)).toEqual([720, 940, 1160]);
    expect(out.every((r) => r.y === 150)).toBe(true);
    const all = [frame, ...out];
    all.forEach((a, i) => all.slice(i + 1).forEach((b) => expect(close(a, b)).toBe(false)));
  });

  it('moves a card up or left when that spot is free, never off the canvas', () => {
    // just above the frame's header, with room above it: up is the short way
    const [up] = pushAside(frame, [{ x: 200, y: 60, w: 200, h: 40 }]);
    expect(up).toEqual({ x: 200, y: 100 - TIDY_GAP - 40, w: 200, h: 40 });
    // at the canvas's top: it cannot go up, so it goes down past the frame
    const [down] = pushAside({ x: 0, y: 0, w: 600, h: 400 }, [{ x: 100, y: 0, w: 200, h: 100 }]);
    expect(down).toEqual({ x: 100, y: 400 + TIDY_GAP, w: 200, h: 100 });
  });

  it('keeps cards that already lay on one another where they are, when the frame does not reach them', () => {
    const pile = [{ x: 1500, y: 1500, w: 200, h: 200 }, { x: 1520, y: 1520, w: 200, h: 200 }];
    expect(pushAside(frame, pile)).toEqual(pile);
  });

  it('on the canvas: the expanded frame clears the cards and collapsed assemblies around it', () => {
    const p = emptyPatch();
    const a1 = addModule(p, DEFS.osc, 100, 100);
    const a2 = addModule(p, DEFS.adsr, 400, 100);
    const a3 = addModule(p, DEFS.vca, 100, 450);
    const right = addModule(p, DEFS.lfo, 400 + W + 30, 120);    // beside the collapsed card, under the frame once it opens
    const under = addModule(p, DEFS.noise, 150, 450 + H + 10);
    const other = addModule(p, DEFS.mixer, 2000, 2000);
    const b = makeAssembly(p, [other.id], 'b');
    const asm = makeAssembly(p, [a1.id, a2.id, a3.id], 'v');
    asm.open = true;
    clearAround(p, [asm.id], sizes);
    const f = { x: 100 - 12, y: 100 - 12 - 30, w: 400 + W - 100 + 24, h: 450 + H - 100 + 24 + 30 };
    for (const id of [right.id, under.id]) { const [x, y] = at(p, id); expect(close(f, { x, y, w: W, h: H }), String(id)).toBe(false); }
    expect(at(p, right.id)[1]).toBe(120);       // pushed right, not down
    expect(at(p, under.id)[0]).toBe(150);       // pushed down, not right
    expect([b.x, b.y]).toEqual([2000, 2000]);   // out of reach: stays
  });

  it('inside an assembly: a nested frame clears its fellow members, and the frame around it then clears the canvas', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 100, 100);
    const y = addModule(p, DEFS.adsr, 100 + W + 30, 100);
    const sibling = addModule(p, DEFS.vca, 100 + 2 * (W + 30), 100);   // 18 px right of the inner frame once it opens
    const outer = makeAssembly(p, [x.id, y.id, sibling.id], 'outer');
    const inner = makeAssembly(p, [x.id, y.id], 'inner');
    const beside = addModule(p, DEFS.lfo, 100 + 2 * (W + 30) + W + 25, 100);
    outer.open = true;
    clearAround(p, [outer.id], sizes);                // the outer frame alone: its neighbour is clear
    expect(childrenOf(p, outer)).toEqual([inner]);
    expect(parentOf(p, inner.id)).toBe(outer);
    inner.open = true;                               // its frame is wider than its collapsed card (200 wide): it covers the sibling
    const before = at(p, sibling.id)[0];
    clearAround(p, [inner.id], sizes);
    expect(at(p, sibling.id)[0]).toBeGreaterThan(before);
    const box = (id: number): Rect => { const [bx, by] = at(p, id); return { x: bx, y: by, w: W, h: H }; };
    const frameOf = (a: AssemblyInst, rs: Rect[]): Rect => {
      const l = Math.min(...rs.map((r) => r.x)), t = Math.min(...rs.map((r) => r.y));
      const r = Math.max(...rs.map((q) => q.x + q.w)), b = Math.max(...rs.map((q) => q.y + q.h));
      return { x: l - 12, y: t - 12 - 30, w: r - l + 24, h: b - t + 24 + 30 };
    };
    const innerF = frameOf(inner, [box(x.id), box(y.id)]);
    expect(close(innerF, box(sibling.id))).toBe(false);
    const outerF = frameOf(outer, [innerF, box(sibling.id)]);
    expect(close(outerF, box(beside.id))).toBe(false);
  });

  it('every factory patch: each assembly expanded on its own, tidied inside, nothing comes near its frame', () => {
    const size = (id: number) => ({ w: 200 + (id % 5) * 60, h: 120 + (id % 7) * 50 });
    const sz: TidySizes = { module: size, container: size, frame: () => ({ pad: 12, head: 30, minW: 0 }) };
    for (const [name, make] of Object.entries(PRESETS))
      for (const top of (make().assemblies ?? []).filter((a) => !(make().assemblies ?? []).some((b) => b.children?.includes(a.id)))) {
        const p = make();
        const a = p.assemblies!.find((x) => x.id === top.id)!;
        a.open = true;
        tidyAssembly(p, a, sz);
        clearAround(p, [a.id], sz);
        const inAsm = new Set(p.assemblies!.flatMap((x) => x.modules));
        const tops = p.assemblies!.filter((b) => !p.assemblies!.some((c) => c.children?.includes(b.id)));
        const mods = a.modules.map((id) => p.modules.find((m) => m.id === id)!);
        const kids = childrenOf(p, a);
        const rs = [...mods.map((m) => ({ x: m.x, y: m.y, ...size(m.id) })), ...kids.map((k) => ({ x: k.x, y: k.y, ...size(k.id) }))];
        const l = Math.min(...rs.map((r) => r.x)), t = Math.min(...rs.map((r) => r.y));
        const f = { x: l - 12, y: t - 42, w: Math.max(...rs.map((r) => r.x + r.w)) - l + 24, h: Math.max(...rs.map((r) => r.y + r.h)) - t + 54 };
        const others = [
          ...p.modules.filter((m) => !inAsm.has(m.id)).map((m) => ({ x: m.x, y: m.y, ...size(m.id) })),
          ...tops.filter((b) => b !== a).map((b) => ({ x: b.x, y: b.y, ...size(b.id) })),
        ];
        for (const o of others) expect(close(f, o), `${name} / ${a.label}`).toBe(false);
      }
  });
});
