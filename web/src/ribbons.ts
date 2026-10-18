// SPDX-License-Identifier: GPL-3.0-only
// Ribbon cables through an expanded assembly's frame (glvno/matryoshka#85). A cable with one end inside an open frame and
// one outside passes the frame's border in a ribbon: inputs cross the left edge, outputs the right edge, just under the
// header, in the collapsed card's order; the cables come together, run parallel for RIBBON_LEN with a clamp across them at
// the border, and spread out again. A cable crosses one ribbon per open border (innermost frame first on the way out,
// outermost first on the way in); an end on the far side of a frame goes round it, over the top or along the bottom.
// Pure geometry: the editor hands in positions (world coordinates) and its own curve between two points.

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** how a cable leaves its start / arrives at its end: sideways (rightwards), or vertically (a docked jack, a bottom jack) */
export type CableEnd = 'side' | 'up' | 'down';

export interface RibbonFrame {
  id: number;
  rect: Rect;
  /** every module the frame holds, nested ones too */
  members: Set<number>;
  /** nesting depth (0 = top level) */
  depth: number;
  /** a cable end's place on the collapsed card (lower first), undefined when the card does not show it */
  rank(dir: 'in' | 'out', module: number, port: string, param?: string): number | undefined;
}

export interface RibbonEnd {
  pt: Pt;
  dir: CableEnd;
  module: number;
  port: string;
  /** an end on a parameter's thumb */
  param?: string;
}
export interface RibbonCable {
  from: RibbonEnd;
  to: RibbonEnd;
}

/** the points of a cable from a to b (pathOf's format: a start point, then three per cubic segment) */
export type Curve = (a: Pt, b: Pt, dirA: CableEnd, dirB: CableEnd) => Pt[];

export const RIBBON_LEN = 40;
/** centre to centre: cables are 3 px wide, so they all but touch */
export const RIBBON_GAP = 4;
/** the first cable's distance below the frame's top edge (under the 30 px header, about where a card's first jack sits) */
export const RIBBON_TOP = 46;
/** how far outside a frame a cable going round it runs */
const AROUND = 28;
/** the clamp: as wide as this, reaching this far beyond the outer cables */
export const CLAMP_W = 6;
const CLAMP_OVER = 3;

interface Crossing {
  frame: RibbonFrame;
  side: 'in' | 'out';
  cable: number;
  rank: number;
  /** tie-break: the height of the end outside the frame */
  far: number;
  y?: number;
}

export interface Ribbons {
  /** the routed cables' points, by their index in the input; cables that cross no open frame are left out */
  routes: Map<number, Pt[]>;
  /** one clamp per ribbon */
  clamps: Rect[];
}

const straight = (a: Pt, b: Pt): Pt[] => [a, { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }, { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 }, b];

/** a cubic from p (leaving along tp) to q (arriving along tq) */
function bend(p: Pt, tp: Pt, q: Pt, tq: Pt): Pt[] {
  const h = Math.max(30, Math.hypot(q.x - p.x, q.y - p.y) * 0.4);
  return [p, { x: p.x + tp.x * h, y: p.y + tp.y * h }, { x: q.x - tq.x * h, y: q.y - tq.y * h }, q];
}

/** join segments that each start where the last one ended */
const chain = (segs: Pt[][]): Pt[] => segs.reduce<Pt[]>((all, s, i) => (i ? all.concat(s.slice(1)) : s.slice()), []);

const tangentOut = (d: CableEnd): Pt => (d === 'up' ? { x: 0, y: -1 } : d === 'down' ? { x: 0, y: 1 } : { x: 1, y: 0 });

export function ribbons(frames: RibbonFrame[], cables: RibbonCable[], curve: Curve): Ribbons {
  const crossings: Crossing[][] = cables.map(() => []);
  const all: Crossing[] = [];
  cables.forEach((c, i) => {
    const inA = (f: RibbonFrame): boolean => f.members.has(c.from.module);
    const inB = (f: RibbonFrame): boolean => f.members.has(c.to.module);
    const exits = frames.filter((f) => inA(f) && !inB(f)).sort((a, b) => b.depth - a.depth);
    const enters = frames.filter((f) => inB(f) && !inA(f)).sort((a, b) => a.depth - b.depth);
    for (const frame of exits) {
      const x: Crossing = { frame, side: 'out', cable: i, rank: frame.rank('out', c.from.module, c.from.port) ?? Infinity, far: c.to.pt.y };
      crossings[i].push(x);
      all.push(x);
    }
    for (const frame of enters) {
      const x: Crossing = { frame, side: 'in', cable: i, rank: frame.rank('in', c.to.module, c.to.port, c.to.param) ?? Infinity, far: c.from.pt.y };
      crossings[i].push(x);
      all.push(x);
    }
  });

  // slots: one ribbon per frame and edge, in the card's order
  const clamps: Rect[] = [];
  const groups = new Map<string, Crossing[]>();
  for (const x of all) {
    const k = `${x.frame.id}:${x.side}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.rank - b.rank || a.far - b.far || a.cable - b.cable);
    const r = list[0].frame.rect;
    const x = list[0].side === 'in' ? r.x : r.x + r.w;
    list.forEach((c, i) => (c.y = r.y + RIBBON_TOP + i * RIBBON_GAP));
    clamps.push({ x: x - CLAMP_W / 2, y: list[0].y! - CLAMP_OVER - 1.5, w: CLAMP_W, h: (list.length - 1) * RIBBON_GAP + 2 * CLAMP_OVER + 3 });
  }

  const routes = new Map<number, Pt[]>();
  cables.forEach((c, i) => {
    const xs = crossings[i];
    if (!xs.length) return;
    const segs: Pt[][] = [];
    let at = c.from.pt;
    let dir: CableEnd = c.from.dir;
    xs.forEach((x, k) => {
      const r = x.frame.rect;
      const edge = x.side === 'in' ? r.x : r.x + r.w;
      const s = { x: edge - RIBBON_LEN / 2, y: x.y! };
      const e = { x: edge + RIBBON_LEN / 2, y: x.y! };
      // into a ribbon: from the left, else round the frame to its left side first
      const into = x.side === 'in' ? r : null;
      if (into && at.x > s.x - 4) segs.push(...round(at, dir, s, into, 'in'));
      else segs.push(curve(at, s, dir, 'side'));
      segs.push(straight(s, e));
      at = e;
      dir = 'side';
      // out of an output ribbon towards an end on its left: round the frame first (when nothing else comes before it)
      const next = k + 1 < xs.length ? null : c.to;
      if (x.side === 'out' && next && next.pt.x < e.x + 4) {
        segs.push(...round(e, 'side', next.pt, r, 'out', next.dir));
        at = next.pt;
        dir = next.dir;
      }
    });
    if (at !== c.to.pt) segs.push(curve(at, c.to.pt, dir, c.to.dir));
    routes.set(i, chain(segs));
  });
  return { routes, clamps };
}

/**
 * Round frame `r` over its top or along its bottom (the shorter way). 'in': from `p` (anywhere right of the ribbon's start
 * `q`) to the left edge's ribbon at `q`; 'out': from the right edge's ribbon end `p` to `q`, an end on the left.
 */
function round(p: Pt, dirP: CableEnd, q: Pt, r: Rect, side: 'in' | 'out', dirQ: CableEnd = 'side'): Pt[][] {
  const top = r.y - AROUND, bottom = r.y + r.h + AROUND;
  const cost = (y: number): number => Math.abs(p.y - y) + Math.abs(q.y - y);
  const y = cost(top) <= cost(bottom) ? top : bottom;
  const left = { x: r.x - AROUND, y };
  const right = { x: r.x + r.w + AROUND, y };
  const L = { x: -1, y: 0 }, R = { x: 1, y: 0 };
  const segs: Pt[][] = [];
  if (side === 'in') {
    // to the corner above / below the right edge if p is beyond it, then along to the left corner, then down into the ribbon
    if (p.x > r.x + r.w) segs.push(bend(p, tangentOut(dirP), right, L), straight(right, left));
    else segs.push(bend(p, tangentOut(dirP), left, L));
    segs.push(bend(left, L, q, R));
  } else {
    segs.push(bend(p, R, right, L));
    const arrive = dirQ === 'up' ? { x: 0, y: 1 } : dirQ === 'down' ? { x: 0, y: -1 } : R;
    if (q.x < r.x) segs.push(straight(right, left), bend(left, L, q, arrive));
    else segs.push(bend(right, L, q, arrive));
  }
  return segs;
}
