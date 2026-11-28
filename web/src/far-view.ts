// SPDX-License-Identifier: GPL-3.0-only
/**
 * The far levels of the semantic zoom (D-1448), drawn on one canvas in place of the cards: the names level (each card
 * only its name, the columns spread apart so every name fits) and the blocks level (each outermost assembly a block with
 * its name, the cards outside assemblies named tiles, one arrow per pair of blocks). Text is only ever on a card or a
 * block. The editor builds a FarScene from its cards (editor.ts farSnapshot); this file lays it out, draws it and finds
 * what is under a point. Coordinates are the canvas's world (layout px at the zoom of 1) unless named screen.
 */

import { LOD_NAMES } from './lod';

export type Kind = 'audio' | 'control' | 'gate' | 'keys';
export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

/** a jack on a card's edge, as the fraction of the card's width and height where it sits */
export interface FarPort { fx: number; fy: number; kind: Kind; on: boolean }
export interface FarFrame extends Rect { key: string; name: string; depth: number; parent: FarFrame | null }
export interface FarCard extends Rect {
  /** the editor's key: `m<id>` a module's card, `a<id>` a collapsed assembly's */
  key: string;
  name: string;
  tag: string;
  /** its family colour (the tag chip's) */
  color: string;
  off: boolean;
  ports: FarPort[];
  frame: FarFrame | null;
  /** its column (cards whose left edges line up), -1 for none */
  col: number;
}
/** a cable's end: a card and where on it, else a frame's edge, else a world point */
export interface FarEnd { card: FarCard | null; frame: FarFrame | null; fx: number; fy: number; x: number; y: number }
export interface FarCable { kind: Kind; mod: boolean; a: FarEnd; b: FarEnd }
interface Column { x0: number; x1: number; right: number; cards: FarCard[] }
/** what an arrow of the blocks level stands for: every cable between two units (an outermost assembly or a loose card) */
interface Flow { a: FarCard | FarFrame; b: FarCard | FarFrame; n: number; kinds: Partial<Record<Kind, number>> }
export interface FarScene { cards: FarCard[]; frames: FarFrame[]; cables: FarCable[]; cols: Column[]; bounds: Rect; units: (FarCard | FarFrame)[]; flows: Flow[] }

/** what the editor reads off its cards */
export interface RawCard extends Rect { key: string; name: string; tag: string; color: string; off: boolean; ports: FarPort[] }
export interface RawFrame extends Rect { key: string; name: string; depth: number }
export interface RawEnd { key: string | null; x: number; y: number }
export interface RawCable { kind: Kind; mod: boolean; a: RawEnd; b: RawEnd }

/** the height of an assembly's head band at the names level, screen px */
const BAND = 18;
/** the name sizes, largest first (D-1448) */
const STEPS = [17, 14, 12, 10, 9];
/** the size a card grows to hold its name at, when the columns spread apart */
const ROOM_PX = 14;

const inside = (r: Rect, x: number, y: number, pad = 0): boolean => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
const contains = (a: Rect, b: Rect): boolean => b.x >= a.x - 1 && b.y >= a.y - 1 && b.x + b.w <= a.x + a.w + 1 && b.y + b.h <= a.y + a.h + 1;
const outer = (f: FarFrame | null): FarFrame | null => { while (f?.parent) f = f.parent; return f; };
const isFrame = (u: FarCard | FarFrame): u is FarFrame => 'depth' in u;

/** the scene from what the editor read off its cards: frames nested, cards in their frames and columns, cables' ends, flows */
export function farScene(raw: { cards: RawCard[]; frames: RawFrame[]; cables: RawCable[] }): FarScene {
  const frames: FarFrame[] = raw.frames.map((f) => ({ ...f, parent: null }));
  for (const f of frames) f.parent = frames.filter((o) => o !== f && o.depth < f.depth && contains(o, f)).sort((a, b) => b.depth - a.depth)[0] ?? null;
  const deepest = (x: number, y: number): FarFrame | null => frames.filter((f) => inside(f, x, y)).sort((a, b) => b.depth - a.depth)[0] ?? null;
  const cards: FarCard[] = raw.cards.map((c) => ({ ...c, frame: deepest(c.x + c.w / 2, c.y + c.h / 2), col: -1 }));
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const end = (e: RawEnd): FarEnd => {
    const card = e.key ? byKey.get(e.key) ?? null : null;
    return card
      ? { card, frame: null, fx: (e.x - card.x) / card.w, fy: (e.y - card.y) / card.h, x: e.x, y: e.y }
      : { card: null, frame: deepest(e.x, e.y), fx: 0, fy: 0, x: e.x, y: e.y };
  };
  const cables: FarCable[] = raw.cables.map((c) => ({ kind: c.kind, mod: c.mod, a: end(c.a), b: end(c.b) }));
  // columns: cards whose left edges line up (within 30 px)
  const cols: Column[] = [];
  for (const x of [...new Set(cards.map((c) => c.x))].sort((a, b) => a - b)) {
    const last = cols[cols.length - 1];
    if (last && x - last.x1 < 30) last.x1 = x; else cols.push({ x0: x, x1: x, right: x, cards: [] });
  }
  for (const c of cards) {
    c.col = cols.findIndex((k) => c.x >= k.x0 - 1 && c.x <= k.x1 + 1);
    cols[c.col]?.cards.push(c);
  }
  for (const k of cols) { k.cards.sort((a, b) => a.y - b.y); k.right = Math.max(...k.cards.map((c) => c.x + c.w)); }
  const all = [...cards, ...frames];
  const bounds = all.length
    ? (() => { const x0 = Math.min(...all.map((r) => r.x)), y0 = Math.min(...all.map((r) => r.y)); return { x: x0, y: y0, w: Math.max(...all.map((r) => r.x + r.w)) - x0, h: Math.max(...all.map((r) => r.y + r.h)) - y0 }; })()
    : { x: 0, y: 0, w: 0, h: 0 };
  // the blocks level's units and the cables summed between them
  const unitOf = (c: FarCard): FarCard | FarFrame => outer(c.frame) ?? c;
  const units = [...new Set(cards.map(unitOf))];
  const flows = new Map<string, Flow>();
  for (const c of cables) {
    const a = c.a.card ? unitOf(c.a.card) : outer(c.a.frame), b = c.b.card ? unitOf(c.b.card) : outer(c.b.frame);
    if (!a || !b || a === b) continue;
    const k = `${units.indexOf(a)}>${units.indexOf(b)}`;
    let f = flows.get(k);
    if (!f) flows.set(k, (f = { a, b, n: 0, kinds: {} }));
    f.n++;
    f.kinds[c.kind] = (f.kinds[c.kind] ?? 0) + 1;
  }
  return { cards, frames, cables, cols, bounds, units, flows: [...flows.values()] };
}

/** a text's width at a size in the card title's type, screen px (editor.ts gives a canvas's measureText; a test, an estimate) */
export type Measure = (text: string, px: number) => number;

/** the box (screen px) a name needs at `px`: one line, or two when that is at most 70 % as wide */
function need(name: string, px: number, measure: Measure): { w: number; h: number } {
  const words = name.toUpperCase().split(/\s+|(?<=\/)/).filter(Boolean);
  let w = measure(words.join(' '), px), lines = 1;
  for (let i = 1; i < words.length; i++) {
    const two = Math.max(measure(words.slice(0, i).join(' '), px), measure(words.slice(i).join(' '), px));
    if (two < w * 0.7) { w = two; lines = 2; }
  }
  return { w: w + 10, h: lines * px * 1.12 + 8 };
}

/** where the names level draws each card and each assembly's block at zoom z (world rects) */
export interface FarLayout { z: number; cards: Map<FarCard, Rect>; frames: Map<FarFrame, Rect>; extent: Rect }

/**
 * The names level's layout (D-1448, "Columns spread apart"): each card grows until its name fits at 14 px; each column
 * is as wide as its widest card and starts no earlier than its own place, nor before the column to its left ends; in a
 * column the cards keep their order and move down only as far as needed (with room for an assembly's head band where
 * the assembly changes); each assembly's block surrounds its cards, and a block that would overlap the sibling above it
 * moves down with everything below it.
 */
export function farLayout(s: FarScene, z: number, measure: Measure): FarLayout {
  const R = new Map<FarCard, Rect>();
  for (const c of s.cards) {
    const n = need(c.name, ROOM_PX, measure);
    R.set(c, { x: c.x, y: c.y, w: Math.max(c.w, n.w / z), h: Math.max(c.h, n.h / z) });
  }
  const ox = s.bounds.x, oy = s.bounds.y;
  let prevX = -Infinity, prevW = 0, prevRight = 0;
  for (const k of s.cols) {
    const X = Math.max((k.x0 - ox) * z, prevX + prevW + Math.max((k.x0 - prevRight) * z, 8));
    let colW = 0, bottom = -Infinity, prev: FarCard | null = null;
    for (const c of k.cards) {
      const r = R.get(c)!;
      const Y = Math.max((c.y - oy) * z, bottom + (prev && prev.frame !== c.frame ? BAND + 6 : 4));
      r.x = ox + X / z;
      r.y = oy + Y / z;
      bottom = Y + r.h * z;
      colW = Math.max(colW, r.w * z);
      prev = c;
    }
    prevX = X; prevW = colW; prevRight = k.right;
  }
  const within = (c: FarCard, f: FarFrame): boolean => { for (let p = c.frame; p; p = p.parent) if (p === f) return true; return false; };
  const blocks = (): Map<FarFrame, Rect> => {
    const F = new Map<FarFrame, Rect>();
    for (const f of [...s.frames].sort((a, b) => b.depth - a.depth)) {
      const rs = [...s.cards.filter((c) => within(c, f)).map((c) => R.get(c)!), ...s.frames.filter((x) => x.parent === f).map((x) => F.get(x)).filter((r): r is Rect => !!r)];
      if (!rs.length) continue;
      const pad = 5 / z, x0 = Math.min(...rs.map((r) => r.x)) - pad, y0 = Math.min(...rs.map((r) => r.y)) - (BAND + 3) / z;
      F.set(f, { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) + pad - x0, h: Math.max(...rs.map((r) => r.y + r.h)) + pad - y0 });
    }
    return F;
  };
  let F = blocks();
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const parent of [null, ...s.frames]) {
      const sib = s.frames.filter((f) => f.parent === parent && F.has(f)).sort((a, b) => a.y - b.y);
      for (let i = 1; i < sib.length; i++) for (let j = 0; j < i; j++) {
        const A = F.get(sib[j])!, B = F.get(sib[i])!;
        if (A.x + A.w <= B.x || B.x + B.w <= A.x) continue;
        const over = A.y + A.h + 6 / z - B.y;
        if (over <= 0) continue;
        for (const c of s.cards) if (c.y >= sib[i].y - 1) R.get(c)!.y += over;
        F = blocks();
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rs = [...R.values(), ...F.values()];
  const x0 = Math.min(s.bounds.x, ...rs.map((r) => r.x)), y0 = Math.min(s.bounds.y, ...rs.map((r) => r.y));
  const extent = { x: x0, y: y0, w: Math.max(s.bounds.x + s.bounds.w, ...rs.map((r) => r.x + r.w)) - x0, h: Math.max(s.bounds.y + s.bounds.h, ...rs.map((r) => r.y + r.h)) - y0 };
  return { z, cards: R, frames: F, extent };
}

/** a jack's place on a card drawn at rect r: the same fraction along the same edge */
const jackAt = (fx: number, fy: number, r: Rect): Pt => ({ x: r.x + fx * r.w, y: r.y + fy * r.h });

/** a cable end's place at the names level */
function endAt(e: FarEnd, L: FarLayout): Pt {
  if (e.card) return jackAt(e.fx, e.fy, L.cards.get(e.card) ?? e.card);
  return { x: e.x, y: e.y };
}

/** the blocks level: where each unit is drawn (a loose card grows round its centre until its name fits at 12 px, then
 *  steps out of any block it overlaps and away from the tiles above it) */
function tiles(s: FarScene, z: number, measure: Measure): Map<FarCard | FarFrame, Rect> {
  const T = new Map<FarCard | FarFrame, Rect>();
  const loose: Rect[] = [];
  for (const u of s.units) {
    if (isFrame(u)) { T.set(u, u); continue; }
    const n = need(u.name, 12, measure), w = Math.max(u.w, n.w / z), h = Math.max(u.h, n.h / z);
    const r = { x: u.x + u.w / 2 - w / 2, y: u.y + u.h / 2 - h / 2, w, h };
    for (const f of s.frames) {
      if (f.parent || r.x + r.w <= f.x || f.x + f.w <= r.x || r.y + r.h <= f.y || f.y + f.h <= r.y) continue;
      r.x = r.x + r.w / 2 < f.x + f.w / 2 ? f.x - r.w - 8 / z : f.x + f.w + 8 / z;
    }
    T.set(u, r);
    loose.push(r);
  }
  loose.sort((a, b) => a.y - b.y);
  for (let i = 1; i < loose.length; i++) for (let j = 0; j < i; j++) {
    const a = loose[j], b = loose[i];
    if (a.x + a.w > b.x && b.x + b.w > a.x && b.y < a.y + a.h + 3 / z) b.y = a.y + a.h + 3 / z;
  }
  return T;
}

/** colours, read from the page's tokens (style.css) */
export interface FarTheme { bg: string; panel: string; ink: string; muted: string; line: string; secondary: string; accent: string; audio: string; control: string; gate: string; keys: string; block: string; block2: string }

export interface FarView { z: number; cam: Pt; W: number; H: number; dpr: number }
/** what the pointer is doing: the hovered card (its cables lit), the selected cards' keys, a selection band being dragged */
export interface FarHover { card?: FarCard; selected?: Set<string>; band?: Rect }

const FONT = "'Barlow Condensed', 'Barlow Semi Condensed', system-ui, sans-serif";
function nameFont(ctx: CanvasRenderingContext2D, px: number): void {
  ctx.font = `600 ${px}px ${FONT}`;
  ctx.letterSpacing = `${(px * 0.07).toFixed(2)}px`;
}

/** the largest step at which `text` fits a box w × h (screen px), in one or two lines */
function fit(text: string, w: number, h: number, measure: Measure): { px: number; lines: string[] } | null {
  const words = text.toUpperCase().split(/\s+|(?<=\/)/).filter(Boolean);
  for (const px of STEPS) {
    const one = words.join(' ');
    if (measure(one, px) <= w && px * 1.12 <= h) return { px, lines: [one] };
    for (let i = 1; i < words.length; i++) {
      const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      if (Math.max(...lines.map((l) => measure(l, px))) <= w && 2 * px * 1.12 <= h) return { px, lines };
    }
  }
  return null;
}

const hit = (r: Rect, v: Rect, pad = 0): boolean => r.x + r.w + pad > v.x && r.y + r.h + pad > v.y && r.x - pad < v.x + v.w && r.y - pad < v.y + v.h;

/** draw the names or blocks level; returns how many cards and names it drew */
export function drawFar(ctx: CanvasRenderingContext2D, s: FarScene, level: number, layout: FarLayout | null, v: FarView, th: FarTheme, measure: Measure, hover: FarHover = {}): { cards: number; names: number } {
  const { z, cam, W, H, dpr } = v, px = 1 / z;
  const stats = { cards: 0, names: 0 };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.letterSpacing = '0px';
  ctx.clearRect(0, 0, W, H);
  const vis = { x: cam.x, y: cam.y, w: W / z, h: H / z };
  const world = (): void => ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
  const screen = (x: number, y: number): Pt => ({ x: (x - cam.x) * z, y: (y - cam.y) * z });
  const kindColor = (k: Kind): string => th[k];
  world();
  if (level !== LOD_NAMES || !layout) {
    drawBlocks(ctx, s, v, th, measure, stats, vis, screen, world);
    return stats;
  }
  const L = layout;
  // blocks
  for (const f of s.frames) {
    const r = L.frames.get(f);
    if (!r || !hit(r, vis)) continue;
    ctx.fillStyle = f.depth ? th.block2 : th.block;
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 8 * px); ctx.fill();
  }
  // cables, one by one; modulation faded (D-1448)
  const lit = hover.card ? new Set(s.cables.filter((c) => c.a.card === hover.card || c.b.card === hover.card)) : null;
  ctx.lineCap = 'round';
  for (const c of s.cables) {
    const a = endAt(c.a, L), b = endAt(c.b, L);
    const k = Math.max(40 * px, Math.abs(b.x - a.x) * 0.45);
    if (!hit({ x: Math.min(a.x, b.x) - k, y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x) + 2 * k, h: Math.abs(b.y - a.y) }, vis, 8)) continue;
    const on = lit?.has(c);
    ctx.globalAlpha = (c.mod ? 0.3 : 1) * (lit ? (on ? 1 : 0.15) : 1);
    if (on) ctx.globalAlpha = 1;
    ctx.strokeStyle = kindColor(c.kind);
    ctx.lineWidth = ({ audio: 1.7, control: 1, gate: 1.4, keys: 2 }[c.kind] + (on ? 1 : 0)) * px;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(a.x + k, a.y, b.x - k, b.y, b.x, b.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // cards: the box, a strip of the family colour, the patched jacks; then the name on the card
  const shown = s.cards.filter((c) => hit(L.cards.get(c)!, vis, 20));
  stats.cards = shown.length;
  for (const c of shown) {
    const r = L.cards.get(c)!;
    ctx.fillStyle = c.off ? mix(th.panel, th.bg, 0.5) : th.panel;
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 4 * px); ctx.fill();
    ctx.strokeStyle = hover.selected?.has(c.key) ? th.secondary : mix(th.panel, th.muted, 0.45);
    ctx.lineWidth = (hover.selected?.has(c.key) ? 2 : 1) * px; ctx.stroke();
    ctx.fillStyle = c.color; ctx.fillRect(r.x, r.y, r.w, Math.min(3 * px, r.h * 0.2));
    for (const p of c.ports) {
      if (!p.on) continue;
      const j = jackAt(p.fx, p.fy, r);
      ctx.fillStyle = kindColor(p.kind); ctx.beginPath(); ctx.arc(j.x, j.y, 2 * px, 0, 7); ctx.fill();
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  for (const c of shown) {
    const r = L.cards.get(c)!, o = screen(r.x, r.y), w = r.w * z, h = r.h * z;
    let f = fit(c.name, w - 6, h - 7, measure), tag = false;
    if (!f) { f = fit(c.tag, w - 4, h - 5, measure); tag = !!f; }
    if (!f) continue;
    nameFont(ctx, f.px);
    ctx.fillStyle = c.off ? th.muted : tag ? c.color : th.ink;
    const lh = f.px * 1.08, n = f.lines.length;
    f.lines.forEach((l, i) => ctx.fillText(l, o.x + w / 2, o.y + 3 + (h - 3) / 2 + (i - (n - 1) / 2) * lh + 0.5));
    stats.names++;
  }
  // assemblies' names on their head bands
  ctx.textAlign = 'left';
  for (const f of s.frames) {
    const r = L.frames.get(f);
    if (!r || !hit(r, vis)) continue;
    const o = screen(r.x, r.y), size = f.depth ? 12 : 14, name = f.name.toUpperCase(), nw = measure(name, size);
    if (nw + 16 > r.w * z) continue;
    ctx.fillStyle = mix(f.depth ? th.block2 : th.block, th.secondary, 0.18);
    ctx.beginPath(); ctx.roundRect(o.x, o.y, r.w * z, BAND, [7, 7, 0, 0]); ctx.fill();
    nameFont(ctx, size); ctx.fillStyle = f.depth ? th.ink : th.accent;
    // (the name stays on its band while the band's start is off the left of the view)
    ctx.fillText(name, Math.min(Math.max(o.x, 0) + 8, o.x + r.w * z - nw - 8), o.y + BAND / 2 + 0.5);
    stats.names++;
  }
  world();
  if (hover.card) {
    const r = L.cards.get(hover.card)!;
    ctx.strokeStyle = th.secondary; ctx.lineWidth = 2 * px;
    ctx.beginPath(); ctx.roundRect(r.x - 3 * px, r.y - 3 * px, r.w + 6 * px, r.h + 6 * px, 7 * px); ctx.stroke();
  }
  if (hover.band) {
    const b = hover.band;
    ctx.fillStyle = th.secondary; ctx.globalAlpha = 0.12; ctx.fillRect(b.x, b.y, b.w, b.h); ctx.globalAlpha = 1;
    ctx.strokeStyle = th.secondary; ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]); ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]);
  }
  ctx.letterSpacing = '0px';
  return stats;
}

function drawBlocks(ctx: CanvasRenderingContext2D, s: FarScene, v: FarView, th: FarTheme, measure: Measure, stats: { cards: number; names: number }, vis: Rect, screen: (x: number, y: number) => Pt, world: () => void): void {
  const { z, dpr } = v, px = 1 / z;
  const T = tiles(s, z, measure);
  for (const f of s.frames) {
    if (!hit(f, vis)) continue;
    ctx.fillStyle = f.depth ? th.block2 : th.block;
    ctx.beginPath(); ctx.roundRect(f.x, f.y, f.w, f.h, 10 * px); ctx.fill();
  }
  // one arrow per pair of units, as thick as their cables, coloured by the strongest kind
  const order: Kind[] = ['audio', 'keys', 'gate', 'control'];
  ctx.lineCap = 'round';
  for (const f of s.flows) {
    const A = T.get(f.a), B = T.get(f.b);
    if (!A || !B) continue;
    const ac = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, bc = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
    const dx = bc.x - ac.x, dy = bc.y - ac.y;
    const d = Math.abs(dx) >= Math.abs(dy) * 0.6 ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
    const a = { x: ac.x + d.x * A.w / 2, y: ac.y + d.y * A.h / 2 }, b = { x: bc.x - d.x * (B.w / 2 + 6 * px), y: bc.y - d.y * (B.h / 2 + 6 * px) };
    const kind = order.find((k) => f.kinds[k]) ?? 'control';
    const w = (1.2 + 1.3 * Math.log2(1 + f.n)) * px, len = Math.max(30 * px, Math.abs((b.x - a.x) * d.x + (b.y - a.y) * d.y) * 0.45);
    ctx.strokeStyle = ctx.fillStyle = th[kind];
    ctx.globalAlpha = kind === 'control' ? 0.55 : 0.95;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(a.x + d.x * len, a.y + d.y * len, b.x - d.x * len, b.y - d.y * len, b.x, b.y); ctx.stroke();
    const ang = Math.atan2(d.y, d.x), sz = (5 + w * z) * px;
    ctx.beginPath();
    ctx.moveTo(b.x + Math.cos(ang) * sz * 0.9, b.y + Math.sin(ang) * sz * 0.9);
    ctx.lineTo(b.x + Math.cos(ang + 2.5) * sz, b.y + Math.sin(ang + 2.5) * sz);
    ctx.lineTo(b.x + Math.cos(ang - 2.5) * sz, b.y + Math.sin(ang - 2.5) * sz);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  // what is drawn on top, screen px: a block's name goes only where it crosses none of it
  const taken: Rect[] = [];
  for (const u of s.units) {
    if (isFrame(u)) continue;
    const r = T.get(u)!;
    if (!hit(r, vis, 20)) continue;
    stats.cards++;
    const o = screen(r.x, r.y), w = r.w * z, h = r.h * z;
    taken.push({ x: o.x, y: o.y, w, h });
    ctx.fillStyle = th.panel; ctx.beginPath(); ctx.roundRect(o.x, o.y, w, h, 4); ctx.fill();
    ctx.strokeStyle = mix(th.panel, th.muted, 0.45); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = u.color; ctx.fillRect(o.x, o.y, w, 2.5);
    const f = fit(u.name, w - 4, h - 3, measure) ?? fit(u.tag, w - 2, h - 2, measure);
    if (!f) continue;
    nameFont(ctx, Math.min(f.px, 12)); ctx.fillStyle = th.ink;
    f.lines.forEach((l, i) => ctx.fillText(l, o.x + w / 2, o.y + h / 2 + (i - (f.lines.length - 1) / 2) * 13 + 1));
    stats.names++;
  }
  // block names, centred on the block (D-1448, round 2 answer 5), where they fit and cross no tile or other name; a block
  // with blocks inside has its name along its top edge, as near the middle as is clear of them, else along its bottom
  // edge, else across its middle, else top centre over them (an outer block's name before its inner blocks' names)
  const over = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const f of s.frames) {
    if (!hit(f, vis)) continue;
    const o = screen(f.x, f.y), w = f.w * z, h = f.h * z, size = f.depth ? 12 : 15, name = f.name.toUpperCase();
    const nw = measure(name, size);
    if (nw + 16 > w || size + 8 > h) continue;
    const kids = s.frames.filter((x) => x.parent === f).map((k) => { const q = screen(k.x, k.y); return { x: q.x, y: q.y, w: k.w * z, h: k.h * z }; });
    const at = (cx: number, cy: number): Rect => ({ x: cx - nw / 2 - 4, y: cy - size / 2 - 3, w: nw + 8, h: size + 6 });
    const free = (b: Rect): boolean => !taken.some((t) => over(t, b)) && !kids.some((k) => over(k, b));
    let box: Rect | undefined;
    if (!kids.length) box = at(o.x + w / 2, o.y + h / 2);
    else {
      const lo = o.x + 8 + nw / 2, hi = o.x + w - 8 - nw / 2, mid = o.x + w / 2;
      for (const cy of [o.y + size / 2 + 6, o.y + h - size / 2 - 6, o.y + h / 2]) {
        for (let d = 0; !box && d <= w / 2 + 12; d += 12) box = [mid - d, mid + d].map((cx) => at(Math.min(hi, Math.max(lo, cx)), cy)).find(free);
        if (box) break;
      }
      box ??= at(mid, o.y + size / 2 + 6);
    }
    if (!box || taken.some((t) => over(t, box!))) continue;
    taken.push(box);
    nameFont(ctx, size); ctx.fillStyle = f.depth ? th.ink : th.accent;
    ctx.fillText(name, box.x + box.w / 2, box.y + box.h / 2);
    stats.names++;
  }
  ctx.letterSpacing = '0px';
  world();
}

/** what is under a world point: a patched jack (names level), a card or tile (a 14 px target at least), else a block */
export type FarPick = { jack: Pt } | { card: FarCard } | { frame: FarFrame } | null;
export function pickFar(s: FarScene, level: number, layout: FarLayout | null, p: Pt, z: number, measure: Measure): FarPick {
  if (level === LOD_NAMES && layout) {
    for (const c of s.cards) {
      const r = layout.cards.get(c)!;
      if (!inside(r, p.x, p.y, 6 / z)) continue;
      for (const q of c.ports) {
        if (!q.on) continue;
        const j = jackAt(q.fx, q.fy, r);
        if (Math.hypot((j.x - p.x) * z, (j.y - p.y) * z) < 5) return { jack: { x: c.x + q.fx * c.w, y: c.y + q.fy * c.h } };
      }
    }
    let best: FarCard | null = null, area = Infinity;
    for (const c of s.cards) {
      const r = layout.cards.get(c)!;
      const ex = Math.max(0, (14 / z - r.w) / 2), ey = Math.max(0, (14 / z - r.h) / 2);
      if (inside({ x: r.x - ex, y: r.y - ey, w: r.w + 2 * ex, h: r.h + 2 * ey }, p.x, p.y) && r.w * r.h < area) { best = c; area = r.w * r.h; }
    }
    if (best) return { card: best };
    const f = s.frames.filter((x) => { const r = layout.frames.get(x); return r && inside(r, p.x, p.y); }).sort((a, b) => b.depth - a.depth)[0];
    return f ? { frame: f } : null;
  }
  const T = tiles(s, z, measure);
  for (const u of s.units) if (!isFrame(u) && inside(T.get(u)!, p.x, p.y, 7 / z)) return { card: u };
  const f = s.frames.filter((x) => inside(x, p.x, p.y)).sort((a, b) => b.depth - a.depth)[0];
  return f ? { frame: f } : null;
}

/** where an element (a card's or frame's key) is drawn at this level, world; null when this level draws nothing for it */
export function farRect(s: FarScene, level: number, layout: FarLayout | null, key: string, z: number, measure: Measure): Rect | null {
  const card = s.cards.find((c) => c.key === key);
  const frame = s.frames.find((f) => f.key === key);
  if (level === LOD_NAMES && layout) return card ? layout.cards.get(card) ?? null : frame ? layout.frames.get(frame) ?? null : null;
  // the blocks level: a card inside an assembly is stood for by its outermost block
  if (card) return card.frame ? outer(card.frame) : tiles(s, z, measure).get(card) ?? null;
  return frame ? outer(frame) : null;
}

/**
 * Fit for a W × H view (screen px), at a zoom below `top` (where the names level starts): the largest names-level zoom at
 * which the spread drawing fits, else the top of the blocks level (D-1448)
 */
export function farFit(s: FarScene, W: number, H: number, top: number, floor: number, blocksTop: number, measure: Measure, pad = 24): { z: number; cx: number; cy: number } {
  for (let z = top; z >= Math.max(floor, blocksTop); z /= 1.03) {
    const e = farLayout(s, z, measure).extent;
    if (e.w * z <= W - 2 * pad && e.h * z <= H - 2 * pad) return { z, cx: e.x + e.w / 2, cy: e.y + e.h / 2 };
  }
  const b = s.bounds;
  return { z: Math.max(floor, Math.min(blocksTop, (W - 2 * pad) / b.w, (H - 2 * pad) / b.h)), cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

/** a colour mixed towards another (t of b) */
function mix(a: string, b: string, t: number): string {
  const rgb = (c: string): number[] => {
    c = c.trim();
    if (c.startsWith('rgb')) return (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    if (c.length === 4) c = '#' + [...c.slice(1)].map((x) => x + x).join('');
    return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  };
  const A = rgb(a), B = rgb(b);
  if (A.length < 3 || B.length < 3 || A.some(Number.isNaN) || B.some(Number.isNaN)) return a;
  return `rgb(${A.map((x, i) => Math.round(x * (1 - t) + B[i] * t)).join(',')})`;
}
export { mix as farMix };
