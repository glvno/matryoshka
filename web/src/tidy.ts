// SPDX-License-Identifier: GPL-3.0-only
// "Tidy up": lay the canvas out as a drawing of its signal flow, read left to right and then top to bottom (a layered
// drawing, the Sugiyama family; owner 2026-11-27, D-1446). The cables decide the columns: sound, keys, gates and clocks
// run left to right (a card sits right of everything that feeds it); modulation into a control input or a parameter pin
// pulls weakly, so a modulator sits in the column just before what it moves without stretching the chain. Main, when it is
// a card (not docked), is the leftmost column, the Output the rightmost. Within a column the cards are ordered to cross as few cables as
// possible, reading the jacks' heights on the cards and starting from the order they are in now (where the cables don't
// decide, the user's order stays); then each card moves up or down so its cables run as level as the column allows.
// Expanded assemblies are laid out inside first and placed as one block; an FX drawer stays on its card (its tab or open
// drawer is part of the card's box); a Scope sits under what it watches and a comment box above or below the card nearest
// it; cards with no cables go in rows underneath. Steps:
//   1. satellites: a Scope, a comment ride on a host card, as one block with it
//   2. cycle breaking: a greedy feedback arc set (Eades, Lin and Smyth 1993), weighted, so a modulation cable is turned
//      round before a gate or clock, and those before a sound or keys cable
//   3. columns: longest path, then the network simplex (Gansner et al. 1993) for the least weighted cable length
//   4. long cables get a slot in every column they pass (dummy nodes)
//   5. order in each column: barycentre sweeps on the jacks' heights, then adjacent swaps, keeping the best (fewest
//      weighted crossings); the current order is where it starts and stays when nothing beats it
//   6. the tallest column splits into side-by-side columns while that brings the drawing nearer a screen's shape
//   7. heights: per column, the least-squares heights that level the cables, kept in order and apart (pool adjacent
//      violators), swept left and right
//   8. columns as wide as their widest card; separate groups stacked top to bottom; lone cards in rows under them
// pushAside / clearAround make room round a frame or drawer that grew. Pure model code: the editor passes the cards' sizes
// and where their jacks are.
import { assembliesOf, childrenOf, findRef, moveAssembly, ownerOf, parentOf, type AssemblyInst, type Rect } from './assembly';
import { cableRole, type CableRole } from './cable-role';
import { DEFS } from './modules';
import type { Cable, Patch } from './patch';

/** space between cards in a column, and between the canvas edge and the drawing */
export const TIDY_GAP = 20;
/** space between columns: room for the cables between them to curve */
export const TIDY_GAP_X = 3 * TIDY_GAP;

/** a card on the canvas: `m<id>` a module's, `a<id>` a collapsed assembly's */
export type CardKey = `m${number}` | `a${number}`;
/** what sticks out of a card's box, each side */
export interface Overhang { l: number; t: number; r: number; b: number }

export interface TidySizes {
  /** a module card's size (0 when unknown: the caller's default is used) */
  module(id: number): { w: number; h: number };
  /** a collapsed assembly card's size */
  container(id: number): { w: number; h: number };
  /** an expanded assembly's frame around its content: padding (top / bottom, and `padX` left / right when it differs), header
   *  height (with a poly strip) and least width */
  frame(a: AssemblyInst): { pad: number; padX?: number; head: number; minW: number };
  /** where a cable's end shows: the card that shows the jack and the jack's centre from the card's top left (null: not
   *  drawn; absent: each jack's place in its module's list is guessed) */
  jack?(c: Cable, end: 'from' | 'to'): { card: CardKey; x: number; y: number } | null;
  /** what hangs off a card beyond its box (an FX drawer's tab or open drawer) */
  overhang?(card: CardKey): Overhang | null;
  /** room kept round an expanded assembly's frame (the cables' gutter, ribbons.ts) */
  gutter?: number;
}

type Item = { r: Rect; move: (dx: number, dy: number) => void };

/** do two boxes come closer than TIDY_GAP? */
const near = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w + TIDY_GAP && b.x < a.x + a.w + TIDY_GAP && a.y < b.y + b.h + TIDY_GAP && b.y < a.y + a.h + TIDY_GAP;

/** the strict overlap of two boxes */
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Is this a pile rather than an arrangement: at least three items, and at least half of them lying on another (a share
 * link without its layout, every card at 0, 0)?
 */
export function piled(rects: Rect[]): boolean {
  const on = rects.filter((r, i) => rects.some((o, j) => i !== j && overlap(r, o))).length;
  return on >= 3 && on * 2 >= rects.length;
}

// ---- the graph layout: boxes and cables in, boxes' places out ----

/** a box to place */
interface LNode {
  w: number;
  h: number;
  /** where it is now (its order down a column starts from this) */
  x0: number;
  y0: number;
  /** Main: the leftmost column; the Output: the rightmost */
  pin?: 'first' | 'last';
  /** an assembly's outside, seen from inside: where its inputs come from (first) and its outputs go (last); not placed */
  anchor?: boolean;
  /** a Scope: sits under the card it watches */
  watcher?: boolean;
  /** a comment box: sits above or below the card nearest it */
  note?: boolean;
}

/** a cable from box u to box v, its jacks `uy` / `vy` below the boxes' tops, and what it carries (cable-role.ts) */
interface LEdge { u: number; v: number; role: CableRole; uy: number; vy: number }

/** how hard a cable pulls its ends into neighbouring columns, and which way round a loop is cut: sound and keys most, a
 *  gate or clock less (a sequencer's clock often comes back from further on), modulation least; the outside of an
 *  assembly barely */
const WEIGHT: Record<CableRole, number> = { signal: 1, keys: 1, gate: 0.5, mod: 0.25 };
const ANCHOR_W = 0.15;
/** a long cable's slot in a column it passes */
const DUMMY_H = 8, DUMMY_SEP = 6;
/** the vertical spacing of an assembly's exposed jacks, for the anchors' ports */
const PORT_STEP = 24;
/** a screen's width : height, which splitting a tall column aims for */
const SCREEN_SHAPE = 1.6;

/** The boxes' top-left corners, the drawing's top left at 0, 0 (an anchor's is 0, 0 and means nothing). */
function layoutGraph(nodes: LNode[], edges: LEdge[]): { x: number; y: number }[] {
  const n = nodes.length;
  const live = edges.filter((e) => e.u !== e.v);
  // 1. satellites: a Scope under the card it watches, a comment above or below the card nearest it
  const host = new Array<number>(n).fill(-1);
  const above = new Array<boolean>(n).fill(false);
  const free = (i: number): boolean => !nodes[i].anchor && !nodes[i].note;
  for (let i = 0; i < n; i++) {
    if (!nodes[i].watcher || live.some((e) => e.u === i)) continue;
    const from = live.find((e) => e.v === i && free(e.u));
    if (from) host[i] = from.u;
  }
  const center = (i: number): { x: number; y: number } => ({ x: nodes[i].x0 + nodes[i].w / 2, y: nodes[i].y0 + nodes[i].h / 2 });
  for (let i = 0; i < n; i++) {
    if (!nodes[i].note) continue;
    const c = center(i);
    const gap = (j: number): number => {
      const b = nodes[j];
      return Math.hypot(Math.max(b.x0 - c.x, 0, c.x - b.x0 - b.w), Math.max(b.y0 - c.y, 0, c.y - b.y0 - b.h));
    };
    let best = -1;
    for (let j = 0; j < n; j++) if (free(j) && (best < 0 || gap(j) < gap(best))) best = j;
    if (best < 0) continue;
    host[i] = host[best] >= 0 ? host[best] : best;
    above[i] = c.y < center(best).y;
  }
  // blocks: a card with its satellites stacked above and below it, left-aligned (comments outermost)
  const blockOf = new Array<number>(n).fill(-1);
  const off = new Array<number>(n).fill(0);
  const blocks: LNode[] = [];
  for (let i = 0; i < n; i++) {
    if (host[i] >= 0) continue;
    const sats = nodes.map((_, j) => j).filter((j) => host[j] === i);
    const outer = (j: number): number => (nodes[j].note ? 0 : 1);
    const up = sats.filter((j) => above[j]).sort((a, b) => outer(a) - outer(b) || nodes[a].y0 - nodes[b].y0);
    const down = sats.filter((j) => !above[j]).sort((a, b) => outer(b) - outer(a) || nodes[a].y0 - nodes[b].y0);
    const members = [...up, i, ...down];
    let y = 0;
    for (const j of members) {
      off[j] = y;
      y += nodes[j].h + TIDY_GAP;
      blockOf[j] = blocks.length;
    }
    blocks.push({ ...nodes[i], w: Math.max(...members.map((j) => nodes[j].w)), h: y - TIDY_GAP, y0: nodes[i].y0 - off[i], watcher: false, note: false });
  }
  const bEdges: LEdge[] = live
    .map((e) => ({ u: blockOf[e.u], v: blockOf[e.v], role: e.role, uy: off[e.u] + e.uy, vy: off[e.v] + e.vy }))
    .filter((e) => e.u !== e.v);

  // groups of blocks joined by cables, the one with Main first, then from the top; lone blocks go in rows at the end
  const parent = blocks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of bEdges) parent[find(e.u)] = find(e.v);
  const groups = new Map<number, number[]>();
  const lone: number[] = [];
  blocks.forEach((b, i) => {
    const cabled = bEdges.some((e) => e.u === i || e.v === i);
    if (b.anchor && !cabled) return;
    if (!b.anchor && !b.pin && !cabled) return void lone.push(i);
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), i]);
  });
  const key = (g: number[]): number => (g.some((i) => blocks[i].pin === 'first') ? -Infinity : Math.min(...g.map((i) => blocks[i].y0)));
  const at: { x: number; y: number }[] = blocks.map(() => ({ x: 0, y: 0 }));
  let top = 0, width = 0;
  for (const g of [...groups.values()].sort((a, b) => key(a) - key(b))) {
    const local = new Map(g.map((b, k) => [b, k]));
    const r = layoutGroup(g.map((b) => blocks[b]), bEdges.filter((e) => local.has(e.u)).map((e) => ({ ...e, u: local.get(e.u)!, v: local.get(e.v)! })));
    g.forEach((b, k) => (at[b] = { x: r.at[k].x, y: top + r.at[k].y }));
    if (r.h > 0) top += r.h + 2 * TIDY_GAP;
    width = Math.max(width, r.w);
  }
  // lone cards: rows as wide as the drawing (at least four cards), in reading order
  const rowW = Math.max(width, 4 * (300 + TIDY_GAP_X));
  let x = 0, rowH = 0;
  for (const b of lone.sort((a, c) => blocks[a].y0 - blocks[c].y0 || blocks[a].x0 - blocks[c].x0)) {
    if (x > 0 && x + blocks[b].w > rowW) {
      top += rowH + TIDY_GAP;
      x = 0;
      rowH = 0;
    }
    at[b] = { x, y: top };
    x += blocks[b].w + TIDY_GAP_X;
    rowH = Math.max(rowH, blocks[b].h);
  }
  return nodes.map((_, i) => (blockOf[i] < 0 ? { x: 0, y: 0 } : { x: at[blockOf[i]].x, y: at[blockOf[i]].y + off[i] }));
}

/** one connected group: cycle breaking, columns, order, heights. Places relative to the group's top left, and its size */
function layoutGroup(nodes: LNode[], edges: LEdge[]): { at: { x: number; y: number }[]; w: number; h: number } {
  const n = nodes.length;
  const weight = (e: LEdge): number => (nodes[e.u].anchor || nodes[e.v].anchor ? ANCHOR_W : WEIGHT[e.role]);
  // 2. cycle breaking: an order of the nodes; a cable running backwards in it is turned round
  const order = feedbackOrder(nodes, edges, weight);
  const pos = new Array<number>(n);
  order.forEach((v, k) => (pos[v] = k));
  const dag = edges.map((e) => (pos[e.u] < pos[e.v] ? { a: e.u, b: e.v, ay: e.uy, by: e.vy, e } : { a: e.v, b: e.u, ay: e.vy, by: e.uy, e }));
  // 3. columns
  const rank = simplexRanks(n, dag.map((d) => ({ a: d.a, b: d.b, w: weight(d.e) })), order);
  const others = (pin: 'first' | 'last'): number[] => rank.filter((_, i) => nodes[i].pin !== pin);
  for (let i = 0; i < n; i++) {
    if (nodes[i].pin === 'first') rank[i] = Math.min(0, ...others('first').map((r) => r - 1));
    if (nodes[i].pin === 'last') rank[i] = Math.max(0, ...others('last').map((r) => r + 1));
  }
  const lo = Math.min(...rank);
  for (let i = 0; i < n; i++) rank[i] -= lo;
  const R = Math.max(...rank) + 1;
  // 4. dummies: a long cable takes a slot in every column it crosses
  type CNode = { w: number; h: number; dummy: boolean; anchor: boolean; rank: number; key: number };
  const cn: CNode[] = nodes.map((nd, i) => ({ w: nd.w, h: nd.h, dummy: false, anchor: !!nd.anchor, rank: rank[i], key: nd.y0 }));
  type Seg = { a: number; b: number; ay: number; by: number; w: number };
  const segs: Seg[] = [];
  for (const d of dag) {
    const w = weight(d.e);
    const span = rank[d.b] - rank[d.a];
    const ya = nodes[d.a].y0 + d.ay, yb = nodes[d.b].y0 + d.by;
    let prev = d.a, prevY = d.ay;
    for (let k = 1; k < span; k++) {
      const id = cn.length;
      cn.push({ w: 0, h: DUMMY_H, dummy: true, anchor: false, rank: rank[d.a] + k, key: ya + ((yb - ya) * k) / span });
      segs.push({ a: prev, b: id, ay: prevY, by: DUMMY_H / 2, w: w * (k === 1 ? 1 : 2) });
      prev = id;
      prevY = DUMMY_H / 2;
    }
    segs.push({ a: prev, b: d.b, ay: prevY, by: d.by, w: span > 1 ? w * 2 : w });
  }
  const layers: number[][] = Array.from({ length: R }, () => []);
  cn.forEach((c, i) => layers[c.rank].push(i));
  for (const l of layers) l.sort((a, b) => cn[a].key - cn[b].key || a - b);
  const segsOut: Seg[][] = cn.map(() => []), segsIn: Seg[][] = cn.map(() => []);
  for (const s of segs) {
    segsOut[s.a].push(s);
    segsIn[s.b].push(s);
  }
  const sep = (a: number, b: number): number => (cn[a].dummy || cn[b].dummy ? DUMMY_SEP : TIDY_GAP);
  const height = (l: number[]): number => l.reduce((s, v, k) => s + cn[v].h + (k ? sep(l[k - 1], v) : 0), 0);
  const top = new Array<number>(cn.length).fill(0);
  const stack = (l: number[]): void => {
    let y = 0;
    l.forEach((v, k) => {
      if (k) y += sep(l[k - 1], v);
      top[v] = y;
      y += cn[v].h;
    });
  };
  layers.forEach(stack);
  // 5. order: crossings between neighbouring columns, weighted
  const crossings = (r: number): number => {
    if (r < 0 || r + 1 >= R) return 0;
    const ss = layers[r].flatMap((v) => segsOut[v]).map((s) => ({ p: top[s.a] + s.ay, q: top[s.b] + s.by, w: s.w }));
    let c = 0;
    for (let i = 0; i < ss.length; i++)
      for (let j = i + 1; j < ss.length; j++) if ((ss[i].p - ss[j].p) * (ss[i].q - ss[j].q) < 0) c += ss[i].w * ss[j].w;
    return c;
  };
  const total = (): number => {
    let c = 0;
    for (let r = 0; r + 1 < R; r++) c += crossings(r);
    return c;
  };
  const bary = (v: number, down: boolean): number => {
    let s = 0, w = 0;
    for (const g of down ? segsIn[v] : segsOut[v]) {
      s += g.w * (down ? top[g.a] + g.ay - g.by : top[g.b] + g.by - g.ay);
      w += g.w;
    }
    return w ? s / w : top[v];
  };
  let best = total(), bestLayers = layers.map((l) => [...l]);
  for (let it = 0; it < 24 && best > 0; it++) {
    const down = it % 2 === 0;
    for (let k = 1; k < R; k++) {
      const r = down ? k : R - 1 - k;
      const keys = new Map(layers[r].map((v, i) => [v, { key: bary(v, down), i }]));
      layers[r].sort((a, b) => keys.get(a)!.key - keys.get(b)!.key || keys.get(a)!.i - keys.get(b)!.i);
      stack(layers[r]);
    }
    const c = total();
    if (c < best - 1e-9) {
      best = c;
      bestLayers = layers.map((l) => [...l]);
    }
  }
  bestLayers.forEach((l, r) => (layers[r] = l));
  layers.forEach(stack);
  for (let pass = 0, better = true; better && pass < 20; pass++) {
    better = false;
    for (let r = 0; r < R; r++) {
      const l = layers[r];
      for (let i = 0; i + 1 < l.length; i++) {
        const was = crossings(r - 1) + crossings(r);
        [l[i], l[i + 1]] = [l[i + 1], l[i]];
        stack(l);
        if (crossings(r - 1) + crossings(r) < was - 1e-9) better = true;
        else {
          [l[i], l[i + 1]] = [l[i + 1], l[i]];
          stack(l);
        }
      }
    }
  }
  // 6. the tallest column splits into columns side by side, in its order, while that brings the group nearer a screen's
  //    shape: one card feeding a dozen would make a dozen-card column
  const chunks = (l: number[], parts: number): number[][] => {
    const tall = height(l);
    const out: number[][] = [[]];
    let acc = 0;
    for (const v of l) {
      if (out[out.length - 1].length && out.length < parts && acc + cn[v].h > (tall / parts) * 1.05) {
        out.push([]);
        acc = 0;
      }
      out[out.length - 1].push(v);
      acc += cn[v].h + TIDY_GAP;
    }
    return out;
  };
  const widest = (l: number[]): number => Math.max(0, ...l.filter((v) => !cn[v].dummy && !cn[v].anchor).map((v) => cn[v].w));
  const parts = layers.map(() => 1);
  const score = (): number => {
    let w = 0, h = 0;
    layers.forEach((l, r) => {
      for (const c of chunks(l, parts[r])) {
        const cw = widest(c);
        if (cw) w += cw + TIDY_GAP_X;
        h = Math.max(h, height(c));
      }
    });
    return Math.max(w / SCREEN_SHAPE, h);
  };
  for (let s = score(), guard = 0; guard < 4 * cn.length; guard++) {
    const tallest = layers
      .map((l, r) => ({ r, h: Math.max(...chunks(l, parts[r]).map(height)) }))
      .filter(({ r }) => chunks(layers[r], parts[r] + 1).length > parts[r])
      .sort((a, b) => b.h - a.h)[0];
    if (!tallest) break;
    parts[tallest.r]++;
    const t = score();
    if (t >= s - 1) {
      parts[tallest.r]--;
      break;
    }
    s = t;
  }
  const cols = layers.flatMap((l, r) => chunks(l, parts[r]));
  const colOf = new Array<number>(cn.length).fill(0);
  cols.forEach((l, c) => {
    for (const v of l) colOf[v] = c;
    stack(l);
  });
  // 7. heights: least squares towards level cables, in order and apart, swept left to right and back
  const y = [...top];
  const place = (l: number[], mode: 'down' | 'up' | 'both'): void => {
    if (l.length === 1 && cn[l[0]].anchor) return;
    const want = l.map((v) => {
      let s = 0, w = 0;
      if (mode !== 'up') for (const g of segsIn[v]) { s += g.w * (y[g.a] + g.ay - g.by); w += g.w; }
      if (mode !== 'down') for (const g of segsOut[v]) { s += g.w * (y[g.b] + g.by - g.ay); w += g.w; }
      return w ? { d: s / w, w } : { d: y[v], w: 0.01 };
    });
    const bl: { from: number; to: number; ws: number; wd: number; h: number }[] = [];
    l.forEach((v, k) => {
      bl.push({ from: k, to: k, ws: want[k].w, wd: want[k].w * want[k].d, h: cn[v].h });
      while (bl.length > 1) {
        const p = bl[bl.length - 2], c = bl[bl.length - 1];
        const gap = sep(l[p.to], l[c.from]);
        if (c.wd / c.ws >= p.wd / p.ws + p.h + gap) break;
        const shift = p.h + gap;
        p.wd += c.wd - c.ws * shift;
        p.ws += c.ws;
        p.h = shift + c.h;
        p.to = c.to;
        bl.pop();
      }
    });
    for (const b of bl) {
      let yy = b.wd / b.ws;
      for (let k = b.from; k <= b.to; k++) {
        if (k > b.from) yy += cn[l[k - 1]].h + sep(l[k - 1], l[k]);
        y[l[k]] = yy;
      }
    }
  };
  const ITER = 16;
  for (let it = 0; it < ITER; it++) {
    const down = it % 2 === 0;
    for (let k = 0; k < cols.length; k++) place(cols[down ? k : cols.length - 1 - k], it >= ITER - 4 ? 'both' : down ? 'down' : 'up');
  }
  // 8. columns as wide as their widest card (an anchor's or a long cable's column takes no room)
  const colX: number[] = [];
  let x = 0;
  for (const c of cols) {
    colX.push(x);
    const w = widest(c);
    if (w > 0) x += w + TIDY_GAP_X;
  }
  const real = nodes.map((_, i) => i).filter((i) => !nodes[i].anchor);
  const minX = Math.min(...real.map((i) => colX[colOf[i]])), minY = Math.min(...real.map((i) => y[i]));
  const at = nodes.map((nd, i) => (nd.anchor ? { x: 0, y: 0 } : { x: colX[colOf[i]] - minX, y: y[i] - minY }));
  return {
    at,
    w: Math.max(0, ...real.map((i) => at[i].x + nodes[i].w)),
    h: Math.max(0, ...real.map((i) => at[i].y + nodes[i].h)),
  };
}

/** an order of the nodes with few (weighted) cables running backwards: sinks from the right, sources from the left, else
 *  the node that sends the most more than it takes; ties by where the cards are now, left first */
function feedbackOrder(nodes: LNode[], edges: LEdge[], weight: (e: LEdge) => number): number[] {
  const left = new Set(nodes.map((_, i) => i).filter((i) => !nodes[i].pin));
  const s1: number[] = [], s2: number[] = [];
  const inW = (v: number): number => edges.reduce((s, e) => s + (e.v === v && left.has(e.u) ? weight(e) : 0), 0);
  const outW = (v: number): number => edges.reduce((s, e) => s + (e.u === v && left.has(e.v) ? weight(e) : 0), 0);
  const byX = (a: number, b: number): number => nodes[a].x0 - nodes[b].x0 || nodes[a].y0 - nodes[b].y0 || a - b;
  while (left.size) {
    for (let moved = true; moved; ) {
      moved = false;
      const sinks = [...left].filter((v) => outW(v) === 0).sort(byX);
      if (sinks.length) {
        const v = sinks[sinks.length - 1];
        s2.unshift(v);
        left.delete(v);
        moved = true;
        continue;
      }
      const source = [...left].filter((v) => inW(v) === 0).sort(byX)[0];
      if (source !== undefined) {
        s1.push(source);
        left.delete(source);
        moved = true;
      }
    }
    if (!left.size) break;
    const v = [...left].sort((a, b) => outW(b) - inW(b) - (outW(a) - inW(a)) || byX(a, b))[0];
    s1.push(v);
    left.delete(v);
  }
  const pins = (p: 'first' | 'last'): number[] => nodes.map((_, i) => i).filter((i) => nodes[i].pin === p).sort(byX);
  return [...pins('first'), ...s1, ...s2, ...pins('last')];
}

/**
 * Columns for an acyclic graph: every cable at least one column long, the weighted sum of the lengths least. Longest path
 * first (a feasible start), then the network simplex: a spanning tree of tight cables; a tree cable whose cut value is
 * negative leaves, the least slack cable across the cut the other way enters, and that side moves.
 */
function simplexRanks(n: number, es: { a: number; b: number; w: number }[], topo: number[]): number[] {
  const rank = new Array<number>(n).fill(0);
  if (!n) return rank;
  for (const v of topo) for (const e of es) if (e.a === v) rank[e.b] = Math.max(rank[e.b], rank[v] + 1);
  const slack = (e: { a: number; b: number }): number => rank[e.b] - rank[e.a] - 1;
  // a tight spanning tree
  const inTree = new Array<boolean>(n).fill(false);
  const tree = new Set<number>();
  inTree[topo[0] ?? 0] = true;
  let size = 1;
  const grow = (): void => {
    for (let changed = true; changed; ) {
      changed = false;
      es.forEach((e, i) => {
        if (inTree[e.a] !== inTree[e.b] && slack(e) === 0) {
          inTree[e.a] = inTree[e.b] = true;
          tree.add(i);
          size++;
          changed = true;
        }
      });
    }
  };
  grow();
  while (size < n) {
    let bestE = -1;
    es.forEach((e, i) => {
      if (inTree[e.a] !== inTree[e.b] && (bestE < 0 || slack(e) < slack(es[bestE]))) bestE = i;
    });
    if (bestE < 0) break; // (not connected: the rest keeps its longest-path columns)
    const e = es[bestE];
    const d = inTree[e.a] ? slack(e) : -slack(e);
    for (let v = 0; v < n; v++) if (inTree[v]) rank[v] += d;
    grow();
  }
  if (size === n) {
    /** the nodes on the tail side of tree cable t */
    const side = (t: number): boolean[] => {
      const mark = new Array<boolean>(n).fill(false);
      const todo = [es[t].a];
      mark[es[t].a] = true;
      while (todo.length) {
        const v = todo.pop()!;
        for (const i of tree) {
          if (i === t) continue;
          const u = es[i].a === v ? es[i].b : es[i].b === v ? es[i].a : -1;
          if (u >= 0 && !mark[u]) {
            mark[u] = true;
            todo.push(u);
          }
        }
      }
      return mark;
    };
    for (let iter = 0; iter < 50 * n + 100; iter++) {
      let leave = -1, cutMin = -1e-9, tail: boolean[] = [];
      for (const t of tree) {
        const s = side(t);
        let cut = 0;
        for (const e of es) {
          if (s[e.a] && !s[e.b]) cut += e.w;
          else if (!s[e.a] && s[e.b]) cut -= e.w;
        }
        if (cut < cutMin) {
          cutMin = cut;
          leave = t;
          tail = s;
        }
      }
      if (leave < 0) break;
      let enter = -1;
      es.forEach((e, i) => {
        if (!tree.has(i) && !tail[e.a] && tail[e.b] && (enter < 0 || slack(e) < slack(es[enter]))) enter = i;
      });
      if (enter < 0) break;
      const d = slack(es[enter]);
      for (let v = 0; v < n; v++) if (tail[v]) rank[v] -= d;
      tree.delete(leave);
      tree.add(enter);
    }
  }
  const lo = Math.min(...rank);
  return rank.map((r) => r - lo);
}

// ---- the patch: cards, assemblies and cables as boxes and edges, level by level ----

const NONE: Overhang = { l: 0, t: 0, r: 0, b: 0 };

/** a box on one level: a module's card, a collapsed assembly's card, an expanded assembly's frame (laid out inside
 *  already), a comment box, or the level's outside (an anchor) */
interface LevelItem {
  node: LNode;
  /** the box now: the card and what hangs off it */
  box: Rect;
  move: (dx: number, dy: number) => void;
}

/**
 * Tidy the whole canvas (the file's header). `skip` = module ids that are not on the canvas (the docked Main). Expanded
 * assemblies are laid out inside first and lose a size the user gave their frame, so the frame fits its tidied content.
 * Positions change in `p`.
 */
export function tidy(p: Patch, sizes: TidySizes, skip: Set<number> = new Set()): void {
  level(p, sizes, skip, null);
}

/** Tidy the inside of one expanded assembly (its first expansion in a session), keeping its top left corner */
export function tidyAssembly(p: Patch, a: AssemblyInst, sizes: TidySizes): void {
  if (a.open && !a.drawer) level(p, sizes, new Set(), a);
}

/** lay out one level (the canvas, or the inside of `container`); returns the frame's box with its gutter, null when empty */
function level(p: Patch, sizes: TidySizes, skip: Set<number>, container: AssemblyInst | null): Rect | null {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const modules = (container ? container.modules : p.modules.filter((m) => !inAsm.has(m.id)).map((m) => m.id)).filter((id) => !skip.has(id));
  const asms = (container ? childrenOf(p, container) : assembliesOf(p).filter((a) => !parentOf(p, a.id))).filter((a) => !a.drawer);
  const items: LevelItem[] = [];
  const itemOf = new Map<CardKey, number>();
  const hang = (k: CardKey): Overhang => sizes.overhang?.(k) ?? NONE;
  const typeOf = (id: number): string => p.modules.find((m) => m.id === id)?.type ?? '';
  for (const id of modules) {
    const m = p.modules.find((x) => x.id === id);
    if (!m) continue;
    const s = sizes.module(id), oh = hang(`m${id}`);
    const box = { x: m.x - oh.l, y: m.y - oh.t, w: s.w + oh.l + oh.r, h: s.h + oh.t + oh.b };
    itemOf.set(`m${id}`, items.length);
    items.push({
      node: { w: box.w, h: box.h, x0: box.x, y0: box.y, pin: m.type === 'fm1' ? 'first' : m.type === 'output' ? 'last' : undefined, watcher: !DEFS[m.type]?.outputs.length && m.type !== 'output' },
      box,
      move: (dx, dy) => { m.x += dx; m.y += dy; },
    });
  }
  for (const a of asms) {
    let box: Rect | null;
    if (a.open) box = level(p, sizes, skip, a);
    else {
      const s = sizes.container(a.id), oh = hang(`a${a.id}`);
      box = { x: a.x - oh.l, y: a.y - oh.t, w: s.w + oh.l + oh.r, h: s.h + oh.t + oh.b };
    }
    if (!box) continue;
    itemOf.set(`a${a.id}`, items.length);
    items.push({ node: { w: box.w, h: box.h, x0: box.x, y0: box.y }, box, move: (dx, dy) => moveAssembly(p, a, dx, dy) });
  }
  if (!container)
    for (const c of p.comments ?? []) {
      const box = { x: c.x, y: c.y, w: c.w, h: c.h };
      items.push({ node: { w: c.w, h: c.h, x0: c.x, y0: c.y, note: true }, box, move: (dx, dy) => { c.x += dx; c.y += dy; } });
    }
  const real = items.length;
  if (!real) return null;
  const left0 = Math.min(...items.map((it) => it.box.x)), top0 = Math.min(...items.map((it) => it.box.y));
  let inAnchor = -1, outAnchor = -1;
  if (container) {
    const anchor = (pin: 'first' | 'last', x0: number): number =>
      items.push({ node: { w: 0, h: 0, x0, y0: top0, anchor: true, pin }, box: { x: 0, y: 0, w: 0, h: 0 }, move: () => {} }) - 1;
    inAnchor = anchor('first', left0 - 1e6);
    outAnchor = anchor('last', left0 + 1e6);
  }
  /** the item a module shows in on this level: its card, the assembly on this level it is inside, the Output for the
   *  Output's drawer; -1 for the outside (an anchor's), null for nothing on this level (the docked Main, the level's own
   *  drawer) */
  const where = (mid: number): number | null => {
    if (skip.has(mid)) return null;
    const own = itemOf.get(`m${mid}`);
    if (own !== undefined) return own;
    let a = assembliesOf(p).find((x) => x.modules.includes(mid));
    for (let guard = 0; a && guard < 64; guard++) {
      if (a.drawer) {
        const owner = ownerOf(p, a);
        if (owner === 'output') {
          const out = p.modules.find((m) => m.type === 'output');
          return out ? where(out.id) : null;
        }
        if (owner === container) return null;
      }
      const at = itemOf.get(`a${a.id}`);
      if (at !== undefined) return at;
      const up = parentOf(p, a.id);
      if (up && up === container) return null;
      a = up;
    }
    return -1;
  };
  /** a cable end's height on its item's box */
  const jackY = (c: Cable, end: 'from' | 'to', i: number): number => {
    const it = items[i], ep = c[end];
    if (it.node.anchor) {
      const list = end === 'to' ? container!.inputs : container!.outputs;
      const r = findRef(container!, end === 'to' ? 'in' : 'out', ep.module, ep.port);
      return Math.max(0, r ? list.indexOf(r) : 0) * PORT_STEP;
    }
    const j = sizes.jack?.(c, end);
    if (j) {
      const id = Number(j.card.slice(1));
      const card = j.card[0] === 'm' ? p.modules.find((m) => m.id === id) : assembliesOf(p).find((a) => a.id === id);
      if (card) return Math.min(it.box.h, Math.max(0, card.y + j.y - it.box.y));
    }
    // not drawn: the jack's place in the module's list on its own card, else the box's middle
    if (itemOf.get(`m${ep.module}`) === i) {
      const def = DEFS[typeOf(ep.module)];
      const k = (end === 'to' ? def?.inputs : def?.outputs)?.findIndex((q) => q.name === ep.port) ?? -1;
      if (k >= 0) return Math.min(it.box.h, 40 + k * PORT_STEP);
    }
    return it.box.h / 2;
  };
  const edges: LEdge[] = [];
  for (const c of p.cables) {
    let u = where(c.from.module), v = where(c.to.module);
    if (u === null || v === null || (u < 0 && v < 0) || (!container && (u < 0 || v < 0))) continue;
    if (u < 0) u = inAnchor;
    if (v < 0) v = outAnchor;
    if (u === v) continue;
    edges.push({ u, v, role: cableRole(DEFS[typeOf(c.to.module)], c.to.port), uy: jackY(c, 'from', u), vy: jackY(c, 'to', v) });
  }
  const at = layoutGraph(items.map((it) => it.node), edges);
  const x0 = container ? left0 : TIDY_GAP, y0 = container ? top0 : TIDY_GAP;
  for (let i = 0; i < real; i++) {
    const it = items[i];
    const dx = Math.round(x0 + at[i].x) - it.box.x, dy = Math.round(y0 + at[i].y) - it.box.y;
    if (dx || dy) it.move(dx, dy);
    it.box = { ...it.box, x: it.box.x + dx, y: it.box.y + dy };
  }
  if (!container) return null;
  delete container.frameSize;
  // the frame as the editor draws it, round the cards with its padding and header; then with what hangs off the cards and
  // the cables' gutter
  const { pad, head, minW } = sizes.frame(container);
  const padX = sizes.frame(container).padX ?? pad;
  const cards = items.slice(0, real).map((it, i) => {
    const id = modules.find((m) => itemOf.get(`m${m}`) === i);
    const m = id === undefined ? undefined : p.modules.find((x) => x.id === id);
    return m ? { x: m.x, y: m.y, ...sizes.module(m.id) } : it.box;
  });
  const l = Math.min(...cards.map((r) => r.x)), t = Math.min(...cards.map((r) => r.y));
  const r = Math.max(...cards.map((q) => q.x + q.w)), b = Math.max(...cards.map((q) => q.y + q.h));
  const all = [{ x: l - padX, y: t - pad - head, w: Math.max(r - l + 2 * padX, minW), h: b - t + 2 * pad + head }, ...items.slice(0, real).map((it) => it.box)];
  const g = sizes.gutter ?? 0;
  const L = Math.min(...all.map((q) => q.x)) - g, T = Math.min(...all.map((q) => q.y)) - g;
  return { x: L, y: T, w: Math.max(...all.map((q) => q.x + q.w)) + g - L, h: Math.max(...all.map((q) => q.y + q.h)) + g - T };
}

/** the canvas is a pile (`piled`): its module cards (not the skipped ones) lie on one another, as a share link without its
 *  layout opens */
export function isPile(p: Patch, sizes: TidySizes, skip: Set<number> = new Set()): boolean {
  return piled(p.modules.filter((m) => !skip.has(m.id)).map((m) => ({ x: m.x, y: m.y, ...sizes.module(m.id) })));
}

/**
 * Make room for a box that grew (an assembly's frame on expansion, #206): `rects` are its neighbours, and none of them may
 * come closer than TIDY_GAP to it. A neighbour in the way moves the shortest way out: right or down, or left or up when
 * that spot is free (on the canvas, near nothing). A neighbour that moved and now lies near another pushes the one further
 * right and down in turn, so the push runs on through a column or a row. Neighbours nobody moved keep their places, even
 * where they already lay on one another. Returns the neighbours' new boxes, in their order; `fixed` never moves.
 */
export function pushAside(fixed: Rect, rects: Rect[]): Rect[] {
  const out = rects.map((r) => ({ ...r }));
  const moved = new Set<number>();
  const sum = (i: number): number => out[i].x + out[i].y;
  /** the next neighbour to move and the box it has to clear: anything near the fixed box, or near one that moved */
  const clash = (): { i: number; o: Rect } | null => {
    for (let i = 0; i < out.length; i++) {
      if (near(fixed, out[i])) return { i, o: fixed };
      for (const j of moved)
        if (j !== i && near(out[i], out[j])) return sum(i) > sum(j) || (sum(i) === sum(j) && i > j) ? { i, o: out[j] } : { i: j, o: out[i] };
    }
    return null;
  };
  const free = (i: number, r: Rect): boolean => r.x >= 0 && r.y >= 0 && !near(fixed, r) && !out.some((o, j) => j !== i && near(o, r));
  for (let guard = 50 * (out.length + 1); guard > 0; guard--) {
    const c = clash();
    if (!c) break;
    const r = out[c.i], o = c.o;
    const ways = [
      { dx: o.x + o.w + TIDY_GAP - r.x, dy: 0, always: true },
      { dx: 0, dy: o.y + o.h + TIDY_GAP - r.y, always: true },
      { dx: o.x - TIDY_GAP - (r.x + r.w), dy: 0, always: false },
      { dx: 0, dy: o.y - TIDY_GAP - (r.y + r.h), always: false },
    ].sort((u, v) => Math.abs(u.dx + u.dy) - Math.abs(v.dx + v.dy));
    const way = ways.find((w) => w.always || free(c.i, { ...r, x: r.x + w.dx, y: r.y + w.dy }))!;
    r.x += way.dx;
    r.y += way.dy;
    moved.add(c.i);
  }
  return out;
}

const box = (x: number, y: number, s: { w: number; h: number }): Rect => ({ x, y, w: s.w, h: s.h });

/** an expanded assembly's frame as drawn around what it shows (its cards, its children's cards or frames), nothing
 *  rearranged; null when it shows nothing */
function frameBox(p: Patch, a: AssemblyInst, sizes: TidySizes): Rect | null {
  const boxes: Rect[] = [];
  for (const id of a.modules) {
    const m = p.modules.find((x) => x.id === id);
    if (m) boxes.push(box(m.x, m.y, sizes.module(id)));
  }
  for (const ch of childrenOf(p, a)) {
    const r = ch.open ? frameBox(p, ch, sizes) : box(ch.x, ch.y, sizes.container(ch.id));
    if (r) boxes.push(r);
  }
  if (!boxes.length) return null;
  const { pad, head, minW, padX = pad } = sizes.frame(a);
  const left = Math.min(...boxes.map((r) => r.x)), top = Math.min(...boxes.map((r) => r.y));
  const right = Math.max(...boxes.map((r) => r.x + r.w)), bottom = Math.max(...boxes.map((r) => r.y + r.h));
  return {
    x: left - padX,
    y: top - pad - head,
    w: Math.max(right - left + 2 * padX, minW, a.frameSize?.width ?? 0),
    h: Math.max(bottom - top + 2 * pad + head, a.frameSize?.height ?? 0),
  };
}

/**
 * After assemblies expand (#206): each one's frame pushes aside (`pushAside`) the cards and frames beside it, among the
 * other members of the assembly it is in, or on the canvas when it is in none. The assembly around it grew too, so that
 * frame then does the same one level up, and so on out to the canvas. `skip` = module ids not on the canvas (the docked
 * Main). Positions change in `p`.
 */
export function clearAround(p: Patch, ids: number[], sizes: TidySizes, skip: Set<number> = new Set()): void {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  for (const id of ids)
    for (let a = assembliesOf(p).find((x) => x.id === id); a?.open; a = parentOf(p, a.id)) {
      const parent = parentOf(p, a.id);
      const frame = frameBox(p, a, sizes);
      if (!frame) continue;
      const items: Item[] = [];
      for (const mid of parent ? parent.modules : p.modules.filter((m) => !inAsm.has(m.id)).map((m) => m.id)) {
        const m = p.modules.find((x) => x.id === mid);
        if (!m || skip.has(mid)) continue;
        items.push({ r: box(m.x, m.y, sizes.module(mid)), move: (dx, dy) => { m.x += dx; m.y += dy; } });
      }
      for (const b of parent ? childrenOf(p, parent) : assembliesOf(p).filter((x) => !parentOf(p, x.id))) {
        if (b === a) continue;
        const r = b.open ? frameBox(p, b, sizes) : box(b.x, b.y, sizes.container(b.id));
        if (r) items.push({ r, move: (dx, dy) => moveAssembly(p, b, dx, dy) });
      }
      pushAside(frame, items.map((it) => it.r)).forEach((r, k) => items[k].move(r.x - items[k].r.x, r.y - items[k].r.y));
    }
}
