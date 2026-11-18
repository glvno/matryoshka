// SPDX-License-Identifier: GPL-3.0-only
// Getting round the canvas with a mouse (#1075): right- or middle-drag pans, the mouse wheel zooms at the cursor while a
// trackpad's two-finger scroll pans, keys for fit and zoom, and auto-pan while a drag nears the canvas's edge. The canvas
// is endless: the scroll space always reaches a viewport beyond the cards and the view on every side. The pure parts live
// here so they can be tested; editor.ts and main.ts wire them to the canvas and the keys.

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

// ---- the endless canvas: layout px (where cards are, any sign) in a scroll space that grows round them
//
// The scroll space starts at layout point `-origin`, so a layout point p is at scroll px (p + origin) * zoom. The camera
// is the layout point at the view's top left: what the patch's saved view keeps.

/** the camera of a scroll position */
export const cameraOf = (scroll: Pt, origin: Pt, zoom: number): Pt => ({ x: scroll.x / zoom - origin.x, y: scroll.y / zoom - origin.y });

/** the scroll position that shows the camera */
export const scrollFor = (camera: Pt, origin: Pt, zoom: number): Pt => ({ x: (camera.x + origin.x) * zoom, y: (camera.y + origin.y) * zoom });

/** the camera after a zoom from `z0` to `z1` that holds the point `at` (px from the view's top left) under it */
export const zoomCamera = (camera: Pt, at: Pt, z0: number, z1: number): Pt => ({ x: camera.x + at.x / z0 - at.x / z1, y: camera.y + at.y / z0 - at.y / z1 });

/**
 * The scroll space, in layout px: the cards' extent (`content`, null for none) and the view, each side one viewport
 * further out, so the view can always pan a viewport in any direction and a zoom around any point in it stays in the
 * space. Its edges fall on whole screen pixels at `zoom`, so the origin moves the scroll by whole pixels only.
 */
export function spaceExtent(content: Rect | null, view: Rect, zoom: number): Rect {
  const c = content ?? view;
  const x0 = Math.floor((Math.min(c.x, view.x) - view.w) * zoom) / zoom, y0 = Math.floor((Math.min(c.y, view.y) - view.h) * zoom) / zoom;
  const x1 = Math.ceil((Math.max(c.x + c.w, view.x + view.w) + view.w) * zoom) / zoom, y1 = Math.ceil((Math.max(c.y + c.h, view.y + view.h) + view.h) * zoom) / zoom;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** the view has come within half a viewport of an edge of the scroll space: time to lay it out again round the view */
export const nearEdge = (space: Rect, view: Rect): boolean => view.x - space.x < view.w / 2 || view.y - space.y < view.h / 2
  || space.x + space.w - (view.x + view.w) < view.w / 2 || space.y + space.h - (view.y + view.h) < view.h / 2;

// ---- right / middle drag

/** how far (px) a right or middle press moves before it pans; less is a click (a right-click opens the menu) */
export const PAN_SLOP = 4;

/**
 * A right or middle press on the canvas. Below `PAN_SLOP` it is still a click; past it, it pans grab-style: `move`
 * returns how far to scroll the canvas so the point under the pointer stays under it (the first pan step includes the
 * slop, so nothing is lost), and null while it is still a click.
 */
export class PanPress {
  panning = false;
  private last: Pt;
  constructor(private start: Pt) {
    this.last = start;
  }

  move(p: Pt): Pt | null {
    if (!this.panning) {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) <= PAN_SLOP) return null;
      this.panning = true;
    }
    const scroll = { x: this.last.x - p.x, y: this.last.y - p.y };
    this.last = p;
    return scroll;
  }
}

// ---- the wheel

/** the user's choice for a plain wheel (VIEW's "Scroll wheel"): auto tells a mouse from a trackpad */
export type WheelSetting = 'auto' | 'zoom' | 'pan';
export const WHEEL_SETTINGS: readonly WheelSetting[] = ['auto', 'zoom', 'pan'];

/** what a wheel event does: zoom at the cursor, pan (the browser's own scroll), or pan sideways (Shift) */
export type WheelAction = 'zoom' | 'pan' | 'pan-x';

/** the parts of a WheelEvent the classifier reads; `wheelDeltaY` is the legacy Chromium / WebKit field (absent elsewhere),
 *  `scale` the page's devicePixelRatio (where the browser divides the legacy field by it: Chromium on Windows, Linux) */
export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  timeStamp: number;
  wheelDeltaY?: number;
  scale?: number;
}

/** a quiet gap (ms) longer than this starts a new gesture */
export const GESTURE_GAP_MS = 250;

/**
 * What one wheel event does, decided once per gesture (a burst of events with no gap over `GESTURE_GAP_MS`), so one
 * gesture never flips between zoom and pan. Ctrl / Cmd (a trackpad pinch arrives as Ctrl + wheel) always zooms and Shift
 * always pans sideways, event by event. Otherwise the gesture's first event decides:
 * 1. a sideways delta: a trackpad or a touch surface such as the Magic Mouse — pan (also with the setting on zoom);
 * 2. the setting zoom or pan, when it is not auto;
 * 3. deltas in lines or pages: a mouse wheel (Firefox) — zoom;
 * 4. the legacy `wheelDeltaY` (Chromium, WebKit) a whole number of notches (120 each, or 120 divided by the pixel ratio):
 *    a mouse wheel, free-spinning ones too — zoom; otherwise a trackpad — pan;
 * 5. no legacy field: deltas that look like notches (whole pixels, 16 or more) zoom, fine ones pan.
 * `guess` is set on the first event of a gesture that auto decided from rules 3–5 (the one-time hint says so).
 */
export class WheelGestures {
  private last = -Infinity;
  private kind: 'zoom' | 'pan' = 'pan';
  private guessed = false;

  classify(e: WheelSample, setting: WheelSetting): { action: WheelAction; fresh: boolean; guess: boolean } {
    const fresh = e.timeStamp - this.last > GESTURE_GAP_MS;
    this.last = e.timeStamp;
    if (e.ctrlKey || e.metaKey) return { action: 'zoom', fresh, guess: false };
    if (e.shiftKey) return { action: 'pan-x', fresh, guess: false };
    if (fresh) {
      this.guessed = false;
      this.kind = this.decide(e, setting);
      return { action: this.kind, fresh, guess: this.guessed };
    }
    return { action: this.kind, fresh, guess: false };
  }

  private decide(e: WheelSample, setting: WheelSetting): 'zoom' | 'pan' {
    if (e.deltaX !== 0) return 'pan';
    if (setting !== 'auto') return setting;
    this.guessed = true;
    if (e.deltaMode !== 0) return 'zoom';
    if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0) return notches(e) ? 'zoom' : 'pan';
    return notchLike(e.deltaY) ? 'zoom' : 'pan';
  }
}

/** how many wheel notches the legacy `wheelDeltaY` holds (up is positive); 0 when it is not a whole number of them */
export function notches(e: WheelSample): number {
  const wd = e.wheelDeltaY ?? 0;
  if (wd && wd % 120 === 0) return wd / 120;
  const n = (wd * (e.scale ?? 1)) / 120;
  return Math.round(n) !== 0 && Math.abs(n - Math.round(n)) < 0.02 ? Math.round(n) : 0;
}

/** a pixel delta a wheel notch gives: (close to) whole and 16 px or more */
const notchLike = (d: number): boolean => Math.abs(d) >= 16 && Math.abs(d - Math.round(d)) < 0.01;

/** the zoom step for one notch of a mouse wheel */
export const NOTCH_ZOOM = 1.12;

/** how much one wheel event zooms (a factor): a notch is `NOTCH_ZOOM`, counted from the legacy field or the lines (a
 *  Firefox notch is 3 lines); pixel deltas (a pinch, a fine wheel) zoom smoothly by their size */
export function wheelZoom(e: WheelSample): number {
  const n = e.ctrlKey || e.metaKey ? 0 : notches(e);
  if (n) return NOTCH_ZOOM ** n;
  if (e.deltaMode === 1) return NOTCH_ZOOM ** (-e.deltaY / 3);
  if (e.deltaMode === 2) return NOTCH_ZOOM ** -e.deltaY;
  return Math.exp(-e.deltaY / 400);
}

/** a wheel delta in pixels: lines are 40 px, a page is `page` px */
export const wheelPx = (d: number, mode: number, page: number): number => (mode === 1 ? d * 40 : mode === 2 ? d * page : d);

// ---- keys

export type NavKey = 'fit' | 'fit-selection' | 'zoom-in' | 'zoom-out' | 'zoom-reset';

/** the canvas's navigation keys, by the key's place (`code`), so every layout has them: Shift+1 fit, Shift+2 the
 *  selection, Ctrl / Cmd with = (or +), − and 0 zoom in, out and to 100 % */
export function navKey(e: { code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): NavKey | null {
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'Equal' || e.code === 'NumpadAdd') return 'zoom-in';
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') return 'zoom-out';
    if ((e.code === 'Digit0' || e.code === 'Numpad0') && !e.shiftKey) return 'zoom-reset';
    return null;
  }
  if (!e.shiftKey) return null;
  return e.code === 'Digit1' ? 'fit' : e.code === 'Digit2' ? 'fit-selection' : null;
}

/** the zoom step of Ctrl / Cmd + = and − */
export const KEY_ZOOM = 1.25;

// ---- auto-pan

/** the band (px) inside the canvas's edges where a drag auto-pans, and the fastest it scrolls (px per frame) */
export const EDGE_BAND = 32;
export const EDGE_SPEED = 20;

/**
 * How far to scroll this frame while a drag's pointer is at `p` (client px) in the canvas `r`: nothing outside the edge
 * band, faster the deeper into it (the square of the depth), full speed at the edge and up to one band beyond it (a
 * pointer further out, over the sidebar, pans nothing).
 */
export function edgeSpeed(p: Pt, r: { left: number; top: number; right: number; bottom: number }, band = EDGE_BAND, max = EDGE_SPEED): Pt {
  if (p.x < r.left - band || p.x > r.right + band || p.y < r.top - band || p.y > r.bottom + band) return { x: 0, y: 0 };
  const axis = (v: number, lo: number, hi: number): number => {
    const depth = v < lo + band ? (lo + band - v) / band : v > hi - band ? -(v - (hi - band)) / band : 0;
    const d = Math.max(-1, Math.min(1, depth));
    return d && -Math.sign(d) * d * d * max;
  };
  return { x: axis(p.x, r.left, r.right), y: axis(p.y, r.top, r.bottom) };
}
