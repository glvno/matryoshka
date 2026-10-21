// SPDX-License-Identifier: GPL-3.0-only
// The patch card (glvno/matryoshka#163): a 1200 x 900 PNG of the patch, drawn from the patch data (never a screenshot of
// the page), for a post. Always the dark theme, whatever the app shows: the colours are the dark tokens of style.css,
// copied here once (patch-card.test.ts checks they still match). Header: MATRYOSHKA PATCH, the title, the notes, "by"
// and the engines; the map: the canvas's top-level cards (collapsed assemblies and the modules not inside one) at their
// saved places, scaled to fit, with the cables between them in their role colours (cable-role.ts); footer: the counts,
// the FM-1 fit and "play it: link in the comments". cardLayout is pure (tests run it in node); renderPatchCard draws.
import { allModules, assembliesOf, findRef, hiddenAssemblies, hiddenModules, paramColumns, parentOf, type AssemblyInst } from './assembly';
import { cableRole, type CableRole } from './cable-role';
import { instIsEngine } from './engines';
import { moduleName } from './labels';
import { DEFS } from './modules';
import { deviceBudget } from './patchbin';
import type { ModuleDef, Patch } from './patch';

export const CARD_W = 1200, CARD_H = 900;
const PAD = 56;
/** the header's baselines: the title, the first line of notes (and the lines' step); the footer's top */
const TITLE_Y = 145, NOTES_Y = 181, NOTE_LH = 26, FOOTER_Y = CARD_H - PAD - 36;
/** the margin inside the map; the dock's height (the Main module, along the map's bottom) */
const MAP_IN = 24, DOCK_H = 26;
/** a small patch is not blown up past this (a real card is 236 px wide on the canvas) */
const MAX_SCALE = 0.8;
/** a box's label: its font size, the room either side, and a generous width per (upper-case, condensed) character */
export const LABEL_PX = 13, LABEL_PAD = 8, LABEL_CHAR = 8;

/** the dark theme's tokens (style.css, `:root[data-theme="dark"]` and the --ref-* palette) */
export const DARK = {
  bg: '#171f21', // --ref-night
  panel: '#202a2c', // --ref-ink
  ink: '#fff7e8', // --ref-ivory
  muted: '#b4b8ad', // --ref-mist
  line: '#344345', // --ref-slate
  stone: '#63695f', // the card border, a step under --muted
  accent: '#e7775d', // --ref-coral: the signal cables
  secondary: '#79c7c1', // --ref-seafoam: modulation
  gate: '#e8b65a', // --ref-gold: gates, triggers, clocks
  warn: '#ffb3a1',
  map: '#1b2426', // the map's ground, between --ref-night and --ref-ink
} as const;

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export interface CardBox extends Rect { label: string; kind: 'module' | 'assembly' | 'frame' | 'dock' }
/** a cable; `dock`: which end is at the dock (it leaves or meets the dock's top edge, not a side) */
export interface CardLine { from: Pt; to: Pt; role: CableRole; dock?: 'from' | 'to' }
export interface CardLayout { map: Rect; boxes: CardBox[]; lines: CardLine[]; scale: number }

/** a card's size on the canvas, estimated from its rows (the editor measures the DOM; the card has none) */
function moduleSize(def: ModuleDef | undefined): { w: number; h: number } {
  if (!def) return { w: 236, h: 120 };
  const rows = def.params.length + (def.views?.length ?? 0) + Math.max(0, Math.max(def.inputs.length, def.outputs.length) - 4) / 2;
  return { w: 236, h: Math.min(540, Math.max(90, 44 + 26 * rows)) };
}
function assemblySize(a: AssemblyInst): { w: number; h: number } {
  const cols = paramColumns(a.params);
  const rows = Math.max(1, ...cols.map((c) => c.length), Math.ceil(Math.max(a.inputs.length, a.outputs.length) / 2));
  return { w: cols.length > 1 ? cols.length * 320 - 20 : 236, h: Math.min(540, 50 + 30 * rows) };
}

/** `text` cut to fit `width` at about `charW` per character, with an ellipsis; '' when not even one letter fits */
export function cutLabel(text: string, width: number, charW = LABEL_CHAR): string {
  const n = Math.floor(width / charW);
  if (text.length <= n) return text;
  return n >= 2 ? `${text.slice(0, n - 1).trimEnd()}…` : '';
}

/** the map's top on the card: under the title, or under its notes (up to three lines) */
export const mapTop = (noteLines: number): number => (noteLines > 0 ? NOTES_Y + (Math.min(3, noteLines) - 1) * NOTE_LH + 30 : TITLE_Y + 42);
/** about how many lines the notes wrap to on the card (the renderer counts them exactly and passes its count) */
export const noteLinesOf = (p: Patch): number => {
  const n = notesOf(p).length;
  return n ? Math.min(3, Math.ceil(n / 100)) : 0;
};
const notesOf = (p: Patch): string => (typeof p.notes === 'string' ? p.notes.trim() : '');

/**
 * The map in card coordinates: one box per top-level card (a collapsed assembly that is not inside another collapsed one,
 * a module not inside a collapsed assembly), a dashed frame per open assembly around its cards, the Main module as the
 * dock along the bottom (where the app shows it), and a line per cable between two different boxes (a cable inside one
 * box is left out; equal ones drawn once). The cards' sizes are estimates (the patch keeps no sizes), cut back where one
 * would run into the next. `noteLines`: how many lines of notes the header shows.
 */
export function cardLayout(p: Patch, defs: Record<string, ModuleDef>, noteLines = noteLinesOf(p)): CardLayout {
  const top = mapTop(noteLines);
  const map = { x: PAD, y: top, w: CARD_W - 2 * PAD, h: FOOTER_Y - 22 - top };
  const hiddenM = hiddenModules(p);
  const hiddenA = hiddenAssemblies(p);
  type Item = { x: number; y: number; w: number; h: number; label: string; kind: 'module' | 'assembly'; asm?: AssemblyInst };
  const items: Item[] = [];
  const owner = new Map<number, number>(); // module id -> item index; -1: the dock
  const main = p.modules.find((m) => m.type === 'fm1' && !hiddenM.has(m.id));
  if (main) owner.set(main.id, -1);
  for (const m of p.modules) {
    if (hiddenM.has(m.id) || m === main) continue;
    const def = defs[m.type];
    owner.set(m.id, items.length);
    items.push({ x: m.x, y: m.y, ...moduleSize(def), label: moduleName(m.type, def?.label ?? m.type).toUpperCase(), kind: 'module' });
  }
  for (const a of assembliesOf(p)) {
    if (a.open || hiddenA.has(a.id)) continue;
    const i = items.length;
    for (const id of allModules(p, a)) owner.set(id, i);
    items.push({ x: a.x, y: a.y, ...assemblySize(a), label: (a.label || a.name).toUpperCase(), kind: 'assembly', asm: a });
  }
  // an estimated size never runs into the card to its right (in about the same row) or below it
  for (const a of items)
    for (const b of items)
      if (b !== a && b.x > a.x && Math.abs(b.y - a.y) < 40) a.w = Math.max(60, Math.min(a.w, b.x - a.x - 20));
  for (const a of items)
    for (const b of items)
      if (b !== a && b.y > a.y && b.x < a.x + a.w && a.x < b.x + b.w) a.h = Math.max(50, Math.min(a.h, b.y - a.y - 20));
  // open assemblies: a frame around their visible cards (an outer frame a little further out than its children's)
  const frames: Item[] = [];
  for (const a of assembliesOf(p)) {
    if (!a.open || hiddenA.has(a.id)) continue;
    const ids = new Set(allModules(p, a));
    const inner = [...new Set([...owner].filter(([id, i]) => i >= 0 && ids.has(id)).map(([, i]) => i))].map((i) => items[i]);
    if (!inner.length) continue;
    let depth = 0;
    for (let x = parentOf(p, a.id); x && depth < 8; x = parentOf(p, x.id)) depth++;
    const g = 16 + 10 * (3 - Math.min(3, depth));
    const x0 = Math.min(...inner.map((b) => b.x)) - g, y0 = Math.min(...inner.map((b) => b.y)) - g - 24;
    const x1 = Math.max(...inner.map((b) => b.x + b.w)) + g, y1 = Math.max(...inner.map((b) => b.y + b.h)) + g;
    frames.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: (a.label || a.name).toUpperCase(), kind: 'assembly' });
  }
  const iw = map.w - 2 * MAP_IN, ih = map.h - 2 * MAP_IN - (main ? DOCK_H + MAP_IN : 0);
  const dock: CardBox | undefined = main && { x: map.x + MAP_IN, y: map.y + map.h - MAP_IN - DOCK_H, w: iw, h: DOCK_H, label: 'MAIN', kind: 'dock' };
  const all = [...frames, ...items];
  const bx0 = all.length ? Math.min(...all.map((b) => b.x)) : 0, by0 = all.length ? Math.min(...all.map((b) => b.y)) : 0;
  const bw = Math.max(1, ...all.map((b) => b.x + b.w - bx0)), bh = Math.max(1, ...all.map((b) => b.y + b.h - by0));
  const scale = Math.min(MAX_SCALE, iw / bw, ih / bh);
  const ox = map.x + MAP_IN + (iw - bw * scale) / 2, oy = map.y + MAP_IN + (ih - bh * scale) / 2;
  const place = (b: Item, kind: CardBox['kind']): CardBox => {
    const w = Math.max(4, b.w * scale), h = Math.max(4, b.h * scale);
    const label = h >= LABEL_PX + 8 ? cutLabel(b.label, w - 2 * LABEL_PAD) : '';
    return { x: ox + (b.x - bx0) * scale, y: oy + (b.y - by0) * scale, w, h, label, kind };
  };
  const placed = items.map((b) => place(b, b.kind));
  const boxes = [...frames.map((f) => place(f, 'frame')), ...placed, ...(dock ? [dock] : [])];

  /** where on a box's edge a port sits: its place among the card's (or the assembly's exposed) ports of that side */
  const edgeY = (i: number, module: number, port: string, dir: 'in' | 'out'): number => {
    const it = items[i];
    let k = -1, n = 1;
    if (it.asm) {
      const list = dir === 'in' ? it.asm.inputs : it.asm.outputs;
      const ref = findRef(it.asm, dir, module, port);
      k = ref ? list.indexOf(ref) : -1;
      n = list.length;
    } else {
      const def = defs[p.modules.find((m) => m.id === module)?.type ?? ''];
      const list = (dir === 'in' ? def?.inputs : def?.outputs) ?? [];
      k = list.findIndex((q) => q.name === port);
      n = list.length;
    }
    const b = placed[i];
    const f = k < 0 ? 0.5 : (k + 1) / (n + 1);
    return b.y + Math.min(b.h - 4, Math.max(Math.min(LABEL_PX + 10, b.h / 2), b.h * f));
  };
  const inDock = (x: number): number => Math.min(dock!.x + dock!.w - 8, Math.max(dock!.x + 8, x));
  const lines: CardLine[] = [];
  const seen = new Set<string>();
  for (const c of p.cables) {
    const a = owner.get(c.from.module), b = owner.get(c.to.module);
    if (a === undefined || b === undefined || a === b) continue;
    const role = cableRole(defs[p.modules.find((m) => m.id === c.to.module)?.type ?? ''], c.to.port);
    let line: CardLine;
    if (a < 0) {
      // out of the dock's top edge, up into the card's input
      const t = placed[b];
      line = { from: { x: inDock(t.x - 30 * scale), y: dock!.y }, to: { x: t.x, y: edgeY(b, c.to.module, c.to.port, 'in') }, role, dock: 'from' };
    } else if (b < 0) {
      const f = placed[a];
      line = { from: { x: f.x + f.w, y: edgeY(a, c.from.module, c.from.port, 'out') }, to: { x: inDock(f.x + f.w + 30 * scale), y: dock!.y }, role, dock: 'to' };
    } else {
      line = { from: { x: placed[a].x + placed[a].w, y: edgeY(a, c.from.module, c.from.port, 'out') }, to: { x: placed[b].x, y: edgeY(b, c.to.module, c.to.port, 'in') }, role };
    }
    const key = `${Math.round(line.from.x)},${Math.round(line.from.y)},${Math.round(line.to.x)},${Math.round(line.to.y)},${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return { map, boxes, lines, scale };
}

export interface PatchFacts {
  modules: number;
  cables: number;
  /** the engines (engines.ts) by name, outermost only, each once */
  engines: string[];
  /** fits the FM-1, and the estimated CPU there in % (null when it cannot be counted) */
  fits: boolean;
  cpu: number | null;
}

export function patchFacts(p: Patch, defs: Record<string, ModuleDef>): PatchFacts {
  const engines: string[] = [];
  for (const a of assembliesOf(p)) {
    if (!instIsEngine(p, a, defs)) continue;
    let inEngine = false;
    for (let x = parentOf(p, a.id), d = 0; x && d < 8; x = parentOf(p, x.id), d++) if (instIsEngine(p, x, defs)) inEngine = true;
    const name = a.name || a.label;
    if (!inEngine && name && !engines.includes(name)) engines.push(name);
  }
  let fits = false, cpu: number | null = null;
  try {
    const b = deviceBudget(p);
    fits = b.fits;
    cpu = Math.round(b.cpu.use * 100);
  } catch {
    /* cannot be counted: shown as "Browser only" */
  }
  return { modules: p.modules.length, cables: p.cables.length, engines, fits, cpu };
}

/** the FM-1 line, as the budget panel says it: "Plays on the FM-1 · 71 %", or "Browser only" with how far over the CPU is */
export function fitLine(f: PatchFacts): string {
  if (f.fits) return f.cpu === null ? 'Plays on the FM-1' : `Plays on the FM-1 · ${f.cpu} %`;
  return f.cpu !== null && f.cpu > 100 ? `Browser only · ${f.cpu} % of the FM-1` : 'Browser only · too much for the FM-1';
}

const plural = (n: number, one: string): string => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;

export interface CardOptions {
  /** the author's name: "by <name>" when given */
  by?: string;
}

const F_HEAD = "700 15px 'Barlow Semi Condensed', system-ui, sans-serif";
const titleFont = (px: number): string => `700 ${px}px 'Barlow Semi Condensed', system-ui, sans-serif`;
const F_BODY = (px: number): string => `500 ${px}px 'Barlow', system-ui, sans-serif`;
const F_LABEL = `600 ${LABEL_PX}px 'Barlow Condensed', 'Barlow Semi Condensed', system-ui, sans-serif`;
const FONTS = [F_HEAD, titleFont(76), F_BODY(20), F_LABEL];

type Ctx = CanvasRenderingContext2D;

/** `text` cut with an ellipsis to fit `max` pixels in the context's font */
function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}

/** up to `max` lines of `text` wrapped at `width`; the last cut with an ellipsis when there is more */
function wrap(ctx: Ctx, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    const next = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length && ctx.measureText(next).width <= width) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  const kept = lines.slice(0, max);
  if (lines.length > max) kept[max - 1] = fit(ctx, `${lines.slice(max - 1).join(' ')}`, width - 1);
  return kept.map((l) => fit(ctx, l, width));
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function pill(ctx: Ctx, x: number, y: number, text: string, warn: boolean): number {
  ctx.font = F_BODY(17);
  const w = ctx.measureText(text).width + 28;
  roundRect(ctx, x, y, w, 36, 18);
  if (warn) {
    ctx.strokeStyle = DARK.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = DARK.line;
    ctx.fill();
  }
  ctx.fillStyle = warn ? DARK.warn : DARK.ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 14, y + 19);
  return w;
}

function drawCable(ctx: Ctx, l: CardLine, k: number): void {
  const dx = Math.max(30, Math.abs(l.to.x - l.from.x) / 2), dy = Math.max(30, Math.abs(l.to.y - l.from.y) / 2);
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(l.from.x, l.from.y);
    const c1 = l.dock === 'from' ? [l.from.x, l.from.y - dy] : [l.from.x + dx, l.from.y];
    const c2 = l.dock === 'to' ? [l.to.x, l.to.y - dy] : [l.to.x - dx, l.to.y];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], l.to.x, l.to.y);
  };
  const stroke = (color: string, w: number): void => {
    path();
    ctx.strokeStyle = color;
    ctx.lineWidth = w * k;
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  if (l.role === 'signal') stroke(DARK.accent, 6);
  else if (l.role === 'mod') stroke(DARK.secondary, 3.5);
  else if (l.role === 'gate') (stroke(DARK.gate, 6), stroke(DARK.map, 2.4)); // a hollow rail, as on the canvas
  else (stroke(DARK.ink, 7), stroke(DARK.map, 4.6), stroke(DARK.ink, 1.2)); // keys: a three-wire ribbon
}

/** draw the card on a 1200 x 900 context (fonts already loaded) */
export function drawPatchCard(ctx: Ctx, p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): void {
  const facts = patchFacts(p, defs);
  ctx.save();
  ctx.fillStyle = DARK.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.textBaseline = 'alphabetic';

  // header, right column: by, engines (the title gets the rest of the width)
  ctx.font = F_BODY(18);
  ctx.textAlign = 'right';
  const by = opts.by?.trim();
  const right = [by ? `by ${by}` : '', facts.engines.length ? `Engines: ${facts.engines.join(', ')}` : ''].filter(Boolean).map((t) => fit(ctx, t, 380));
  const rightW = Math.max(0, ...right.map((t) => ctx.measureText(t).width));
  ctx.fillStyle = DARK.muted;
  right.forEach((t, i) => ctx.fillText(t, CARD_W - PAD, PAD + 16 + i * 26));
  ctx.textAlign = 'left';

  ctx.font = F_HEAD;
  ctx.fillStyle = DARK.accent;
  ctx.letterSpacing = '2.4px';
  ctx.fillText('MATRYOSHKA PATCH', PAD, PAD + 14);
  // the title: upper case, as large as fits beside the right column (76 down to 40 px), then cut
  const titleMax = CARD_W - 2 * PAD - (rightW ? rightW + 32 : 0);
  const title = (p.name.trim() || 'Untitled').toUpperCase();
  let px = 76;
  ctx.letterSpacing = '1.5px';
  for (; px > 40; px -= 4) {
    ctx.font = titleFont(px);
    if (ctx.measureText(title).width <= titleMax) break;
  }
  ctx.font = titleFont(px);
  ctx.fillStyle = DARK.ink;
  ctx.fillText(fit(ctx, title, titleMax), PAD, TITLE_Y);
  ctx.letterSpacing = '0px';
  const notes = notesOf(p);
  ctx.font = F_BODY(20);
  const noteLines = notes ? wrap(ctx, notes, CARD_W - 2 * PAD, 3) : [];
  ctx.fillStyle = DARK.muted;
  noteLines.forEach((l, i) => ctx.fillText(l, PAD, NOTES_Y + i * NOTE_LH));

  // the map
  const layout = cardLayout(p, defs, noteLines.length);
  const { map } = layout;
  roundRect(ctx, map.x, map.y, map.w, map.h, 14);
  ctx.fillStyle = DARK.map;
  ctx.fill();
  ctx.strokeStyle = DARK.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  roundRect(ctx, map.x, map.y, map.w, map.h, 14);
  ctx.clip();
  const k = Math.min(1, Math.max(0.45, layout.scale / 0.5));
  const r = Math.max(3, 10 * Math.min(1, layout.scale / 0.6));
  for (const b of layout.boxes.filter((b) => b.kind === 'frame')) {
    roundRect(ctx, b.x, b.y, b.w, b.h, r + 2);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = DARK.stone;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const l of layout.lines) drawCable(ctx, l, k);
  ctx.font = F_LABEL;
  ctx.letterSpacing = '1.2px';
  for (const b of layout.boxes) {
    if (b.kind !== 'frame') {
      roundRect(ctx, b.x, b.y, b.w, b.h, b.kind === 'dock' ? 6 : r);
      ctx.fillStyle = DARK.panel;
      ctx.fill();
      ctx.strokeStyle = DARK.stone;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (b.kind === 'assembly' && b.w > 14 && b.h > 14) {
        // an assembly: a second outline inside, one doll in another
        roundRect(ctx, b.x + 4, b.y + 4, b.w - 8, b.h - 8, Math.max(2, r - 3));
        ctx.strokeStyle = DARK.line;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (!b.label) continue;
    const label = fit(ctx, b.label, b.w - 2 * LABEL_PAD);
    if (!label) continue;
    ctx.fillStyle = b.kind === 'frame' ? DARK.muted : DARK.ink;
    ctx.fillText(label, b.x + LABEL_PAD, b.kind === 'dock' ? b.y + b.h / 2 + LABEL_PX * 0.36 : b.y + LABEL_PX + 8);
  }
  ctx.restore();
  ctx.letterSpacing = '0px';

  // footer
  let x = PAD;
  x += pill(ctx, x, FOOTER_Y, plural(facts.modules, 'module'), false) + 12;
  x += pill(ctx, x, FOOTER_Y, plural(facts.cables, 'cable'), false) + 12;
  pill(ctx, x, FOOTER_Y, fitLine(facts), !facts.fits);
  ctx.font = F_BODY(17);
  ctx.fillStyle = DARK.muted;
  ctx.textAlign = 'right';
  ctx.fillText('play it: link in the comments', CARD_W - PAD, FOOTER_Y + 19);
  ctx.restore();
}

/** wait for the card's fonts (style.css loads them from public/fonts); a font that fails falls back to system-ui */
async function loadFonts(): Promise<void> {
  try {
    await Promise.all(FONTS.map((f) => document.fonts.load(f)));
  } catch {
    /* drawn in the fallback font */
  }
}

/** draw the card onto `canvas` (sized to 1200 x 900) */
export async function paintPatchCard(canvas: HTMLCanvasElement, p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): Promise<void> {
  await loadFonts();
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  drawPatchCard(canvas.getContext('2d')!, p, opts, defs);
}

/** the card as a PNG */
export async function renderPatchCard(p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): Promise<Blob> {
  const canvas = document.createElement('canvas');
  await paintPatchCard(canvas, p, opts, defs);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('the card could not be drawn'))), 'image/png'));
}

/** a file name for the patch: its name, safe for a file system */
export const fileStem = (p: Patch): string => p.name.replace(/[^\w.-]+/g, '_') || 'patch';

/** download the card as `<patch name>.png` */
export async function savePatchCard(p: Patch, opts: CardOptions = {}, defs: Record<string, ModuleDef> = DEFS): Promise<void> {
  const blob = await renderPatchCard(p, opts, defs);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileStem(p)}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
