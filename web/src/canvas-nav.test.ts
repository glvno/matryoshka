// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { edgeSpeed, EDGE_SPEED, GESTURE_GAP_MS, navKey, NOTCH_ZOOM, notches, PAN_SLOP, PanPress, WheelGestures, wheelZoom, type WheelSample, type WheelSetting } from './canvas-nav';

/** a recorded-style gesture: deltas every `dt` ms from `t0` */
function gesture(deltas: Partial<WheelSample>[], t0 = 0, dt = 16): WheelSample[] {
  return deltas.map((d, i) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, timeStamp: t0 + i * dt, ...d }));
}

const actions = (events: WheelSample[], setting: WheelSetting = 'auto', g = new WheelGestures()): string[] =>
  events.map((e) => g.classify(e, setting).action);

// shapes seen from real devices (Chromium unless noted): a notched wheel sends whole notches of 120 in wheelDeltaY
const notched = gesture([{ deltaY: 100, wheelDeltaY: -120 }, { deltaY: 100, wheelDeltaY: -120 }, { deltaY: 200, wheelDeltaY: -240 }], 0, 60);
// a free-spinning MagSpeed-style wheel: a fast run of notches, still whole in wheelDeltaY
const freeSpin = gesture(Array.from({ length: 30 }, () => ({ deltaY: -100, wheelDeltaY: 120 })), 0, 8);
// the Magic Mouse is a touch surface: fine deltas, a little sideways drift
const magicMouse = gesture([{ deltaY: 2, deltaX: 0.5, wheelDeltaY: -6 }, { deltaY: 6.5, wheelDeltaY: -19 }, { deltaY: 12, deltaX: -1, wheelDeltaY: -36 }]);
// a MacBook trackpad, straight down: no sideways delta, wheelDeltaY three times the pixels
const macTrackpad = gesture([{ deltaY: 1, wheelDeltaY: -3 }, { deltaY: 4, wheelDeltaY: -12 }, { deltaY: 40, wheelDeltaY: -120 }, { deltaY: 22, wheelDeltaY: -66 }]);
// a Windows precision touchpad: fractional pixels
const precision = gesture([{ deltaY: 3.3333, wheelDeltaY: -4 }, { deltaY: 7.1, wheelDeltaY: -8 }, { deltaY: 12.5, wheelDeltaY: -15 }]);
// Firefox: a mouse wheel in lines (3 per notch), no legacy field
const firefoxLines = gesture([{ deltaY: 3, deltaMode: 1 }, { deltaY: 3, deltaMode: 1 }, { deltaY: 6, deltaMode: 1 }], 0, 50);
// Firefox with a hi-res wheel in pixels, no legacy field: fine deltas, nothing decides but their size
const firefoxHiRes = gesture([{ deltaY: 4.5 }, { deltaY: 9.25 }, { deltaY: 18.5 }]);
// Firefox, a plain wheel in pixels (the page read deltaY first)
const firefoxPixels = gesture([{ deltaY: 48 }, { deltaY: 48 }]);

describe('the wheel classifier (#1075)', () => {
  it('zooms with a notched mouse wheel and a free-spinning one', () => {
    expect(actions(notched)).toEqual(['zoom', 'zoom', 'zoom']);
    expect(new Set(actions(freeSpin))).toEqual(new Set(['zoom']));
  });

  it('pans with a trackpad: MacBook, Windows precision, the Magic Mouse', () => {
    // (the MacBook's 40 px step reads as a whole notch, but the gesture was decided at its first event)
    expect(actions(macTrackpad)).toEqual(['pan', 'pan', 'pan', 'pan']);
    expect(actions(precision)).toEqual(['pan', 'pan', 'pan']);
    expect(actions(magicMouse)).toEqual(['pan', 'pan', 'pan']);
  });

  it('zooms with Firefox line deltas, and decides pixel deltas without a legacy field by their size', () => {
    expect(actions(firefoxLines)).toEqual(['zoom', 'zoom', 'zoom']);
    expect(actions(firefoxHiRes)).toEqual(['pan', 'pan', 'pan']);
    expect(actions(firefoxPixels)).toEqual(['zoom', 'zoom']);
  });

  it('counts notches the browser divided by the pixel ratio (Chromium at 125 %, a page zoom)', () => {
    // one notch at 125 %: deltaY 80, wheelDeltaY 96
    const scaled = gesture([{ deltaY: 80, wheelDeltaY: -96, scale: 1.25 }, { deltaY: -160, wheelDeltaY: 192, scale: 1.25 }], 0, 60);
    expect(actions(scaled)).toEqual(['zoom', 'zoom']);
    expect(scaled.map(notches)).toEqual([-1, 2]);
    // a Retina trackpad's first small steps stay a pan
    expect(actions(gesture([{ deltaY: 2, wheelDeltaY: -6, scale: 2 }, { deltaY: 7, wheelDeltaY: -21, scale: 2 }]))).toEqual(['pan', 'pan']);
  });

  it('never flips inside a gesture; a quiet gap starts a new one', () => {
    const g = new WheelGestures();
    // a wheel notch, then a sideways delta within the gap: still the gesture's zoom
    expect(actions(gesture([{ deltaY: 100, wheelDeltaY: -120 }, { deltaY: 3, deltaX: 2, wheelDeltaY: -9 }]), 'auto', g)).toEqual(['zoom', 'zoom']);
    // after the gap the trackpad is seen as one
    expect(actions(gesture([{ deltaY: 3, deltaX: 2, wheelDeltaY: -9 }], 16 + GESTURE_GAP_MS + 1), 'auto', g)).toEqual(['pan']);
  });

  it('Ctrl / Cmd (a pinch) always zooms, Shift always pans sideways, whatever the gesture', () => {
    const g = new WheelGestures();
    expect(actions(gesture([{ deltaY: 1, wheelDeltaY: -3 }, { deltaY: 2, ctrlKey: true }, { deltaY: 2, metaKey: true }]), 'pan', g)).toEqual(['pan', 'zoom', 'zoom']);
    expect(actions(gesture([{ deltaY: 100, wheelDeltaY: -120, shiftKey: true }]), 'zoom')).toEqual(['pan-x']);
  });

  it('the setting decides a plain wheel; a sideways delta (a touch surface) pans even on zoom', () => {
    expect(actions(macTrackpad, 'zoom')).toEqual(['zoom', 'zoom', 'zoom', 'zoom']);
    expect(actions(magicMouse, 'zoom')).toEqual(['pan', 'pan', 'pan']);
    expect(actions(notched, 'pan')).toEqual(['pan', 'pan', 'pan']);
    expect(actions(firefoxLines, 'pan')).toEqual(['pan', 'pan', 'pan']);
  });

  it('flags only the first event of a gesture auto guessed (for the one-time hint)', () => {
    const g = new WheelGestures();
    expect(notched.map((e) => g.classify(e, 'auto').guess)).toEqual([true, false, false]);
    expect(gesture([{ deltaY: 2, deltaX: 1 }], 10_000).map((e) => g.classify(e, 'auto').guess)).toEqual([false]);
    expect(gesture([{ deltaY: 100, wheelDeltaY: -120 }], 20_000).map((e) => g.classify(e, 'zoom').guess)).toEqual([false]);
    expect(gesture([{ deltaY: 2, ctrlKey: true }], 30_000).map((e) => g.classify(e, 'auto').guess)).toEqual([false]);
  });

  it('zooms a notch by NOTCH_ZOOM, from the legacy field or the lines, and a pinch smoothly', () => {
    expect(wheelZoom(notched[0])).toBeCloseTo(1 / NOTCH_ZOOM);
    expect(wheelZoom(freeSpin[0])).toBeCloseTo(NOTCH_ZOOM);
    expect(wheelZoom(firefoxLines[0])).toBeCloseTo(1 / NOTCH_ZOOM);
    expect(wheelZoom(gesture([{ deltaY: -4, ctrlKey: true, wheelDeltaY: 120 }])[0])).toBeCloseTo(Math.exp(4 / 400));
  });
});

describe('right-click or right-drag (#1075)', () => {
  it('stays a click up to PAN_SLOP px, then pans grab-style including the slop', () => {
    const p = new PanPress({ x: 100, y: 100 });
    expect(p.move({ x: 102, y: 103 })).toBeNull();
    expect(p.move({ x: 100 + PAN_SLOP, y: 100 })).toBeNull();
    expect(p.panning).toBe(false);
    // past the slop: the canvas scrolls opposite to the pointer, from the press, so the point under it stays
    expect(p.move({ x: 103, y: 104 })).toEqual({ x: -3, y: -4 });
    expect(p.panning).toBe(true);
    expect(p.move({ x: 90, y: 110 })).toEqual({ x: 13, y: -6 });
    // back near the start it is still a pan
    expect(p.move({ x: 100, y: 100 })).toEqual({ x: -10, y: 10 });
  });
});

describe('the navigation keys (#1075)', () => {
  const key = (code: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    navKey({ code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it('Shift+1 fits, Shift+2 the selection, by the key place (any layout)', () => {
    expect(key('Digit1', { shiftKey: true })).toBe('fit');
    expect(key('Digit2', { shiftKey: true })).toBe('fit-selection');
    expect(key('Digit1')).toBeNull();
    expect(key('Digit3', { shiftKey: true })).toBeNull();
    expect(key('Digit1', { shiftKey: true, altKey: true })).toBeNull();
  });

  it('Ctrl / Cmd with = (+), − and 0 zoom in, out and to 100 %', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(key('Equal', mod)).toBe('zoom-in');
      expect(key('Equal', { ...mod, shiftKey: true })).toBe('zoom-in');
      expect(key('NumpadAdd', mod)).toBe('zoom-in');
      expect(key('Minus', mod)).toBe('zoom-out');
      expect(key('NumpadSubtract', mod)).toBe('zoom-out');
      expect(key('Digit0', mod)).toBe('zoom-reset');
      expect(key('Numpad0', mod)).toBe('zoom-reset');
      expect(key('Digit1', { ...mod, shiftKey: true })).toBeNull();
    }
    expect(key('Equal')).toBeNull();
    expect(key('Digit0')).toBeNull();
  });
});

describe('auto-pan near the canvas edge (#1075)', () => {
  const r = { left: 0, top: 0, right: 800, bottom: 600 };
  it('nothing in the middle, faster deeper into the band, full speed at and just past the edge', () => {
    expect(edgeSpeed({ x: 400, y: 300 }, r)).toEqual({ x: 0, y: 0 });
    const shallow = edgeSpeed({ x: 24, y: 300 }, r).x, deep = edgeSpeed({ x: 8, y: 300 }, r).x;
    expect(shallow).toBeLessThan(0);
    expect(deep).toBeLessThan(shallow);
    expect(edgeSpeed({ x: 0, y: 300 }, r).x).toBe(-EDGE_SPEED);
    expect(edgeSpeed({ x: 820, y: 590 }, r)).toEqual({ x: EDGE_SPEED, y: expect.closeTo(EDGE_SPEED * (22 / 32) ** 2) });
    // far outside (over the sidebar): no pan
    expect(edgeSpeed({ x: -100, y: 300 }, r)).toEqual({ x: 0, y: 0 });
  });
});
