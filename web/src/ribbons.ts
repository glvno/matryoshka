// SPDX-License-Identifier: GPL-3.0-only
// Ribbon cables through an expanded assembly's frame (glvno/matryoshka#85). A cable with one end inside an open frame and
// one outside passes the frame's border in a ribbon: inputs cross the left edge, outputs the right edge, just under the
// header, in the collapsed card's order; the cables run parallel for RIBBON_LEN with a clamp across them at the border.
// A cable crosses one ribbon per open border (innermost frame first on the way out, outermost first on the way in).
// Outside, a cable that can reach its opening without passing over the frame goes straight there; any other runs along
// the frame's outline in a gutter (GUTTER outside the border, one fixed lane per cable, RIBBON_GAP apart, round the
// corners as nested arcs), joining it at the point nearest its outside end, going the shorter way round, and bending into
// its row at the opening. Pure geometry: the editor hands in positions (world coordinates) and its own curve.

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
  const h = Math.max(24, Math.hypot(q.x - p.x, q.y - p.y) * 0.4);
  return [p, { x: p.x + tp.x * h, y: p.y + tp.y * h }, { x: q.x - tq.x * h, y: q.y - tq.y * h }, q];
}

/** a circular arc as one cubic (spans up to a quarter turn), centre c, radius r, from angle a0 to a1 (radians, y down) */
function arc(c: Pt, r: number, a0: number, a1: number): Pt[] {
  const k = (4 / 3) * Math.tan((a1 - a0) / 4) * r;
  const p0 = { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) };
  const p3 = { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) };
  return [p0, { x: p0.x - k * Math.sin(a0), y: p0.y + k * Math.cos(a0) }, { x: p3.x + k * Math.sin(a1), y: p3.y - k * Math.cos(a1) }, p3];
}

/** join segments that each start where the last one ended */
const chain = (segs: Pt[][]): Pt[] => segs.reduce<Pt[]>((all, s, i) => (i ? all.concat(s.slice(1)) : s.slice()), []);
/** a chain of cubics run backwards */
const reversed = (pts: Pt[]): Pt[] => pts.slice().reverse();

const tangentOut = (d: CableEnd): Pt => (d === 'up' ? { x: 0, y: -1 } : d === 'down' ? { x: 0, y: 1 } : { x: 1, y: 0 });
const tangentIn = (d: CableEnd): Pt => (d === 'up' ? { x: 0, y: 1 } : d === 'down' ? { x: 0, y: -1 } : { x: 1, y: 0 });

/** how far outside the border the innermost gutter lane runs; the frame's corner radius (style.css .frame) */
export const GUTTER = 10;
const CORNER = 12;
/** the bend from a gutter lane into a ribbon row */
const TURN = 6;
/** room the editor keeps round an expanded frame for the gutter (ten lanes) */
export const GUTTER_ROOM = GUTTER + 10 * RIBBON_GAP;

type Piece = { line: [Pt, Pt] } | { arc: { c: Pt; r: number; a0: number; a1: number } };

/**
 * A frame's outline `d` outside its border: a rounded rectangle, walked clockwise (on screen) from the top edge's left end.
 * `at(t)` / `param(p)` map between length along it and points; `path(t0, t1, cw)` is the stretch between two lengths.
 */
class Outline {
  readonly pieces: { piece: Piece; len: number }[] = [];
  readonly len: number;
  constructor(readonly r: Rect, readonly d: number) {
    const rr = CORNER + d;
    const x0 = r.x - d, y0 = r.y - d, x1 = r.x + r.w + d, y1 = r.y + r.h + d;
    const q = Math.PI / 2;
    const add = (piece: Piece): void => {
      const len = 'line' in piece ? Math.hypot(piece.line[1].x - piece.line[0].x, piece.line[1].y - piece.line[0].y) : piece.arc.r * (piece.arc.a1 - piece.arc.a0);
      this.pieces.push({ piece, len });
    };
    add({ line: [{ x: x0 + rr, y: y0 }, { x: x1 - rr, y: y0 }] });
    add({ arc: { c: { x: x1 - rr, y: y0 + rr }, r: rr, a0: -q, a1: 0 } });
    add({ line: [{ x: x1, y: y0 + rr }, { x: x1, y: y1 - rr }] });
    add({ arc: { c: { x: x1 - rr, y: y1 - rr }, r: rr, a0: 0, a1: q } });
    add({ line: [{ x: x1 - rr, y: y1 }, { x: x0 + rr, y: y1 }] });
    add({ arc: { c: { x: x0 + rr, y: y1 - rr }, r: rr, a0: q, a1: 2 * q } });
    add({ line: [{ x: x0, y: y1 - rr }, { x: x0, y: y0 + rr }] });
    add({ arc: { c: { x: x0 + rr, y: y0 + rr }, r: rr, a0: 2 * q, a1: 3 * q } });
    this.len = this.pieces.reduce((n, p) => n + p.len, 0);
  }

  /** the point and clockwise direction at length t */
  at(t: number): { p: Pt; dir: Pt } {
    t = ((t % this.len) + this.len) % this.len;
    for (const { piece, len } of this.pieces) {
      if (t <= len + 1e-9) {
        if ('line' in piece) {
          const [a, b] = piece.line;
          const u = len ? t / len : 0;
          return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, dir: { x: (b.x - a.x) / (len || 1), y: (b.y - a.y) / (len || 1) } };
        }
        const { c, r, a0 } = piece.arc;
        const a = a0 + t / r;
        return { p: { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }, dir: { x: -Math.sin(a), y: Math.cos(a) } };
      }
      t -= len;
    }
    return this.at(0);
  }

  /** the length along the outline of the point nearest p */
  param(p: Pt): number {
    let best = Infinity, bestT = 0, base = 0;
    for (const { piece, len } of this.pieces) {
      let t: number;
      if ('line' in piece) {
        const [a, b] = piece.line;
        const u = len ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len))) : 0;
        t = u * len;
      } else {
        const { c, r, a0, a1 } = piece.arc;
        let a = Math.atan2(p.y - c.y, p.x - c.x);
        while (a < a0 - Math.PI) a += 2 * Math.PI;
        while (a > a0 + Math.PI) a -= 2 * Math.PI;
        t = Math.max(0, Math.min(a1 - a0, a - a0)) * r;
      }
      const q = this.at(base + t).p;
      const dist = Math.hypot(q.x - p.x, q.y - p.y);
      if (dist < best) (best = dist), (bestT = base + t);
      base += len;
    }
    return bestT;
  }

  /** the clockwise stretch from t0 to t1 as cubics */
  private cw(t0: number, t1: number): Pt[] {
    const L = this.len;
    t0 = ((t0 % L) + L) % L;
    let span = (((t1 - t0) % L) + L) % L;
    const segs: Pt[][] = [];
    let base = 0;
    // walk the pieces twice round so a stretch may wrap past the start
    for (let lap = 0; lap < 2 && span > 1e-6; lap++)
      for (const { piece, len } of this.pieces) {
        const from = Math.max(t0 - base, 0), to = Math.min(t0 - base + span, len);
        if (to > from + 1e-6 && t0 - base < len) {
          if ('line' in piece) segs.push(straight(this.at(base + from).p, this.at(base + to).p));
          else segs.push(arc(piece.arc.c, piece.arc.r, piece.arc.a0 + from / piece.arc.r, piece.arc.a0 + to / piece.arc.r));
          span -= to - from;
          t0 = base + to;
        }
        base += len;
        if (span <= 1e-6) break;
      }
    return segs.length ? chain(segs) : [this.at(t0).p];
  }

  /** the stretch from t0 to t1, clockwise or not */
  path(t0: number, t1: number, cw: boolean): Pt[] {
    return cw ? this.cw(t0, t1) : reversed(this.cw(t1, t0));
  }
}

interface Hug {
  cw: boolean;
  lane: number;
}

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

  const edgeOf = (x: Crossing): number => (x.side === 'in' ? x.frame.rect.x : x.frame.rect.x + x.frame.rect.w);
  // the point a crossing's outside part runs to or from: the cable's end, or the neighbouring crossing's stretch
  const outside = (i: number, k: number): Pt => {
    const xs = crossings[i];
    const x = xs[k];
    if (x.side === 'in') {
      const prev = xs[k - 1];
      return prev ? { x: edgeOf(prev) + RIBBON_LEN / 2, y: prev.y! } : cables[i].from.pt;
    }
    const next = xs[k + 1];
    return next ? { x: edgeOf(next) - RIBBON_LEN / 2, y: next.y! } : cables[i].to.pt;
  };

  // which crossings hug the outline (their outside part would pass over the frame), which way round, in which lane
  const hugs = new Map<Crossing, Hug>();
  for (const list of groups.values()) {
    const lanes = new Map<boolean, Crossing[]>();
    for (const x of list) {
      const k = crossings[x.cable].indexOf(x);
      const p = outside(x.cable, k);
      const edge = edgeOf(x);
      const hug = x.side === 'in' ? p.x > edge - RIBBON_LEN / 2 - 8 : p.x < edge + RIBBON_LEN / 2 + 8;
      if (!hug) continue;
      const o = new Outline(x.frame.rect, GUTTER);
      const tJ = o.param(p);
      const tT = o.param({ x: x.side === 'in' ? x.frame.rect.x - 1e4 : x.frame.rect.x + x.frame.rect.w + 1e4, y: x.y! });
      // clockwise from the join point to the opening (in), or from the opening to the leaving point (out)
      const cwLen = x.side === 'in' ? (((tT - tJ) % o.len) + o.len) % o.len : (((tJ - tT) % o.len) + o.len) % o.len;
      const cw = cwLen <= o.len / 2;
      hugs.set(x, { cw, lane: 0 });
      lanes.set(cw, [...(lanes.get(cw) ?? []), x]);
    }
    // fixed lanes, so the bundle turns into (or out of) the ribbon without crossing itself: clockwise is moving up on the
    // left edge and down on the right edge, and either way the innermost lane then takes the lowest row (otherwise the top)
    for (const [cw, xs] of lanes) {
      xs.sort((a, b) => (cw ? b.y! - a.y! : a.y! - b.y!));
      xs.forEach((x, n) => (hugs.get(x)!.lane = n));
    }
  }

  const routes = new Map<number, Pt[]>();
  cables.forEach((c, i) => {
    const xs = crossings[i];
    if (!xs.length) return;
    const segs: Pt[][] = [];
    let at = c.from.pt;
    let dir: CableEnd | null = c.from.dir;
    let tan = tangentOut(c.from.dir);
    /** from `at` to q, arriving travelling along tq (a standard end when both are) */
    const go = (q: Pt, tq: Pt, dq: CableEnd | null): void => {
      if (dir && dq) segs.push(curve(at, q, dir, dq));
      else segs.push(bend(at, tan, q, tq));
    };
    xs.forEach((x) => {
      const r = x.frame.rect;
      const edge = edgeOf(x);
      const y = x.y!;
      const s = { x: edge - RIBBON_LEN / 2, y };
      const e = { x: edge + RIBBON_LEN / 2, y };
      const h = hugs.get(x);
      if (x.side === 'in') {
        if (h) {
          // join the gutter nearest `at`, run round to the left side, bend into the ribbon's row
          const o = new Outline(r, GUTTER + h.lane * RIBBON_GAP);
          const tJ = o.param(at);
          const J = o.at(tJ);
          const lx = r.x - o.d;
          const up = h.cw; // on the left side clockwise is upwards
          const turnFrom = { x: lx, y: up ? y + TURN : y - TURN };
          const tT = o.param(turnFrom);
          go(J.p, h.cw ? J.dir : { x: -J.dir.x, y: -J.dir.y }, null);
          segs.push(o.path(tJ, tT, h.cw));
          // moving up: round the corner below the row into it; moving down: from above
          segs.push(up ? arc({ x: lx + TURN, y: y + TURN }, TURN, Math.PI, 1.5 * Math.PI) : arc({ x: lx + TURN, y: y - TURN }, TURN, Math.PI, Math.PI / 2));
          segs.push(straight({ x: lx + TURN, y }, e));
        } else {
          go(s, { x: 1, y: 0 }, 'side');
          segs.push(straight(s, e));
        }
        at = e;
        dir = 'side';
        tan = { x: 1, y: 0 };
      } else {
        // the cable comes from inside: `at` is its inside end or the last ribbon inside
        go(s, { x: 1, y: 0 }, 'side');
        if (h) {
          const o = new Outline(r, GUTTER + h.lane * RIBBON_GAP);
          const rx = r.x + r.w + o.d;
          const down = h.cw; // on the right side clockwise is downwards
          segs.push(straight(s, { x: rx - TURN, y }));
          segs.push(down ? arc({ x: rx - TURN, y: y + TURN }, TURN, -Math.PI / 2, 0) : arc({ x: rx - TURN, y: y - TURN }, TURN, Math.PI / 2, 0));
          const tT = o.param({ x: rx, y: down ? y + TURN : y - TURN });
          const q = outside(i, xs.indexOf(x));
          const tJ = o.param(q);
          segs.push(o.path(tT, tJ, h.cw));
          const J = o.at(tJ);
          at = J.p;
          dir = null;
          tan = h.cw ? J.dir : { x: -J.dir.x, y: -J.dir.y };
        } else {
          segs.push(straight(s, e));
          at = e;
          dir = 'side';
          tan = { x: 1, y: 0 };
        }
      }
    });
    go(c.to.pt, tangentIn(c.to.dir), c.to.dir);
    routes.set(i, chain(segs));
  });
  return { routes, clamps };
}
