// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { RIBBON_GAP, RIBBON_LEN, RIBBON_TOP, ribbons, type Curve, type Pt, type RibbonCable, type RibbonFrame } from './ribbons';

/** a plain cubic between two points (the editor's curve has slack and stubs; the routing does not care) */
const curve: Curve = (a, b) => [a, { x: a.x + 20, y: a.y }, { x: b.x - 20, y: b.y }, b];
const frame = (id: number, x: number, y: number, w: number, h: number, members: number[], depth = 0, order: Record<string, number> = {}): RibbonFrame => ({
  id, rect: { x, y, w, h }, members: new Set(members), depth,
  rank: (dir, module, port, param) => order[`${dir}:${module}:${param ?? port}`],
});
const end = (x: number, y: number, module: number, port = 'p', param?: string) => ({ pt: { x, y }, dir: 'side' as const, module, port, param });
/** the path passes this straight stretch: two consecutive anchor points */
const passes = (pts: Pt[], a: Pt, b: Pt): boolean => pts.some((p, i) => i % 3 === 0 && p.x === a.x && p.y === a.y && pts[i + 3]?.x === b.x && pts[i + 3]?.y === b.y);

describe('ribbon cables through an open frame (#85)', () => {
  const f = frame(1, 400, 100, 600, 500, [10, 11, 12]);

  it('leaves cables that cross no open frame alone', () => {
    const { routes, clamps } = ribbons([f], [{ from: end(0, 0, 1), to: end(50, 0, 2) }, { from: end(500, 300, 10), to: end(700, 300, 11) }], curve);
    expect(routes.size).toBe(0);
    expect(clamps).toEqual([]);
  });

  it('brings inputs in on the left edge and outputs out on the right, under the header, with a clamp at each border', () => {
    const c: RibbonCable[] = [{ from: end(100, 400, 1), to: end(600, 450, 10) }, { from: end(700, 450, 11), to: end(1200, 300, 2) }];
    const { routes, clamps } = ribbons([f], c, curve);
    const y = 100 + RIBBON_TOP;
    expect(passes(routes.get(0)!, { x: 400 - RIBBON_LEN / 2, y }, { x: 400 + RIBBON_LEN / 2, y })).toBe(true);
    expect(passes(routes.get(1)!, { x: 1000 - RIBBON_LEN / 2, y }, { x: 1000 + RIBBON_LEN / 2, y })).toBe(true);
    expect(clamps.map((r) => r.x + r.w / 2).sort()).toEqual([1000, 400]);
    for (const r of [routes.get(0)!, routes.get(1)!]) {
      expect(r[0]).toEqual(c[routes.get(0) === r ? 0 : 1].from.pt);
      expect(r.at(-1)).toEqual(c[routes.get(0) === r ? 0 : 1].to.pt);
    }
  });

  it('orders a ribbon like the collapsed card, not by height', () => {
    const g = frame(1, 400, 100, 600, 500, [10, 11], 0, { 'in:10:a': 1, 'in:11:cutoff': 0 });
    const c = [{ from: end(0, 100, 1), to: end(600, 200, 10, 'a') }, { from: end(0, 900, 2), to: end(600, 400, 11, 'p1', 'cutoff') }];
    const { routes, clamps } = ribbons([g], c, curve);
    const y = 100 + RIBBON_TOP;
    expect(passes(routes.get(1)!, { x: 380, y }, { x: 420, y })).toBe(true); // rank 0 first, though it comes from below
    expect(passes(routes.get(0)!, { x: 380, y: y + RIBBON_GAP }, { x: 420, y: y + RIBBON_GAP })).toBe(true);
    expect(clamps).toHaveLength(1);
    expect(clamps[0].h).toBeGreaterThan(RIBBON_GAP);
  });

  it('goes round the frame to an end on the far side, outside the frame', () => {
    // an output inside to a module left of the frame; an outside module right of the frame feeding an input inside
    const c = [{ from: end(700, 300, 11), to: end(100, 150, 2) }, { from: end(1300, 200, 3), to: end(600, 300, 10) }];
    const { routes } = ribbons([f], c, curve);
    for (const i of [0, 1]) {
      const pts = routes.get(i)!;
      const anchors = pts.filter((_, k) => k % 3 === 0);
      // every anchor between the ribbon and the far end is outside the frame (above it here: the ribbon is near the top)
      expect(anchors.some((p) => p.y < 100)).toBe(true);
    }
  });

  it('crosses one ribbon per open border, the outer frame first on the way in', () => {
    const outer = frame(1, 400, 100, 900, 700, [10, 11]);
    const inner = frame(2, 600, 300, 400, 300, [11], 1);
    const { routes, clamps } = ribbons([inner, outer], [{ from: end(100, 500, 1), to: end(800, 450, 11) }], curve);
    const pts = routes.get(0)!;
    const sx = pts.findIndex((p) => p.x === 400 - RIBBON_LEN / 2);
    const ix = pts.findIndex((p) => p.x === 600 - RIBBON_LEN / 2);
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(ix).toBeGreaterThan(sx);
    expect(clamps).toHaveLength(2);
  });
});

describe('the gutter along an open frame', () => {
  const f = frame(1, 400, 100, 600, 500, [10, 11, 12]);
  const inside = (p: Pt, r = f.rect): boolean => p.x > r.x + 1 && p.x < r.x + r.w - 1 && p.y > r.y + 1 && p.y < r.y + r.h - 1;

  it('a cable that can go straight in does not hug', () => {
    const { routes } = ribbons([f], [{ from: end(100, 140, 1), to: end(600, 300, 10) }], curve);
    const pts = routes.get(0)!;
    expect(pts.some((p) => p.y < 100)).toBe(false); // never over the top
  });

  it('cables from below and from the right run outside the frame to the left opening, in separate lanes', () => {
    const c = [{ from: end(700, 900, 1), to: end(600, 300, 10, 'a') }, { from: end(1400, 300, 2), to: end(600, 350, 11, 'b') }, { from: end(800, 950, 3), to: end(620, 400, 12, 'c') }];
    const { routes } = ribbons([f], c, curve);
    for (const [i, pts] of routes) {
      const anchors = pts.filter((_, k) => k % 3 === 0);
      const before = anchors.slice(0, anchors.findIndex((p) => p.x >= 400 - RIBBON_LEN / 2 + 1 && p.y < 100 + RIBBON_TOP + 20 && p.y >= 100 + RIBBON_TOP - 1));
      // up to the ribbon, nothing passes over the frame
      for (const p of before) expect(inside(p), `cable ${i} at ${p.x},${p.y}`).toBe(false);
    }
    // the two cables coming up the left side keep distinct lanes there (distinct x where the left edge's straight run starts)
    const leftXs = [0, 2].map((i) => routes.get(i)!.find((p, k) => k % 3 === 0 && p.x < 400 && p.y > 500)?.x);
    expect(leftXs[0]).toBeDefined();
    expect(leftXs[0]).not.toBe(leftXs[1]);
  });

  it('an output to a module on the left leaves the right opening and runs round outside', () => {
    const { routes } = ribbons([f], [{ from: end(700, 450, 11), to: end(100, 700, 2) }], curve);
    const anchors = routes.get(0)!.filter((_, k) => k % 3 === 0);
    const after = anchors.slice(anchors.findIndex((p) => p.x > 1000));
    for (const p of after) expect(inside(p)).toBe(false);
    expect(anchors.at(-1)).toEqual({ x: 100, y: 700 });
  });
});
