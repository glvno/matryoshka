// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pinchStart, pinchStep } from './touch';

describe('pinchStep', () => {
  it('zooms by the ratio of the fingers’ distance to the start’s', () => {
    const p = pinchStart({ x: 100, y: 100 }, { x: 200, y: 100 }, 1);
    const s = pinchStep(p, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 50, y: 100 }, { x: 250, y: 100 }], 0.3, 2);
    expect(s.zoom).toBeCloseTo(2);
    expect(s.at).toEqual({ x: 150, y: 100 });
    expect(s.pan).toEqual({ x: 0, y: 0 }); // the midpoint stayed
  });

  it('measures from the start, not the previous move', () => {
    const p = pinchStart({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5);
    const s = pinchStep(p, [{ x: 0, y: 0 }, { x: 140, y: 0 }], [{ x: 0, y: 0 }, { x: 150, y: 0 }], 0.3, 2);
    expect(s.zoom).toBeCloseTo(0.75);
  });

  it('pans by the midpoint’s movement: the content follows the fingers', () => {
    const p = pinchStart({ x: 100, y: 100 }, { x: 200, y: 100 }, 1);
    const s = pinchStep(p, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 130, y: 80 }, { x: 230, y: 80 }], 0.3, 2);
    expect(s.zoom).toBeCloseTo(1);
    expect(s.at).toEqual({ x: 180, y: 80 });
    expect(s.pan).toEqual({ x: -30, y: 20 });
  });

  it('clamps to the zoom range', () => {
    const p = pinchStart({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    expect(pinchStep(p, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 900, y: 0 }], 0.3, 2).zoom).toBe(2);
    expect(pinchStep(p, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 5, y: 0 }], 0.3, 2).zoom).toBe(0.3);
  });

  it('fingers landing together do not divide by zero', () => {
    const p = pinchStart({ x: 10, y: 10 }, { x: 10, y: 10 }, 1);
    expect(Number.isFinite(pinchStep(p, [{ x: 10, y: 10 }, { x: 10, y: 10 }], [{ x: 10, y: 10 }, { x: 11, y: 10 }], 0.3, 2).zoom)).toBe(true);
  });
});
