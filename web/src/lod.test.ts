// SPDX-License-Identifier: GPL-3.0-only
// Semantic zoom (D-1448, D-1449): the level of detail for a zoom, snapped with ±8 % hysteresis; the title's size at the
// sliders level; the cursor kept on the element it was over when the level changes.
import { describe, expect, it } from 'vitest';
import { anchorIn, anchorShift, LOD_FULL, LOD_SLIDERS, lodFor, nameFits, titleScale, titleScaleFor } from './lod';

describe('lodFor: the level for a zoom', () => {
  it('draws the full card from 40 % up and the sliders below, away from the boundary', () => {
    expect(lodFor(1, LOD_FULL)).toBe(LOD_FULL);
    expect(lodFor(0.5, LOD_FULL)).toBe(LOD_FULL);
    expect(lodFor(0.3, LOD_FULL)).toBe(LOD_SLIDERS);
    expect(lodFor(0.07, LOD_FULL)).toBe(LOD_SLIDERS);
    expect(lodFor(0.3, LOD_SLIDERS)).toBe(LOD_SLIDERS);
    expect(lodFor(1, LOD_SLIDERS)).toBe(LOD_FULL);
  });

  it('changes level 8 % past the boundary, both ways, so a zoom resting on 40 % keeps its level', () => {
    // zooming out: the full card holds down to 0.4 / 1.08 = 37.04 %
    expect(lodFor(0.38, LOD_FULL)).toBe(LOD_FULL);
    expect(lodFor(0.371, LOD_FULL)).toBe(LOD_FULL);
    expect(lodFor(0.37, LOD_FULL)).toBe(LOD_SLIDERS);
    // zooming in: the sliders hold up to 0.4 × 1.08 = 43.2 %
    expect(lodFor(0.4, LOD_SLIDERS)).toBe(LOD_SLIDERS);
    expect(lodFor(0.43, LOD_SLIDERS)).toBe(LOD_SLIDERS);
    expect(lodFor(0.433, LOD_SLIDERS)).toBe(LOD_FULL);
    // a wobble round 40 % never flips it
    let l = LOD_FULL;
    for (const z of [0.41, 0.39, 0.4, 0.38, 0.42, 0.39]) l = lodFor(z, l);
    expect(l).toBe(LOD_FULL);
  });
});

describe('the title at the sliders level', () => {
  it('stays 12 px tall on screen: a 15 px title scaled by 0.8 / zoom', () => {
    for (const z of [0.4, 0.3, 0.16, 0.07]) expect(15 * titleScale(z) * z).toBeCloseTo(12, 9);
  });

  it('shows the name while it fits on one line of the card, else the tag', () => {
    // a 236 px card: 70.8 px on screen at 30 %, 56.8 px for the title
    expect(nameFits(70, 236, 0.3)).toBe(true);    // 56 px at 12 px
    expect(nameFits(72, 236, 0.3)).toBe(false);   // 57.6 px
    expect(nameFits(72, 236, 0.4)).toBe(true);
  });

  it('shrinks below 12 px only when even the shown text is wider than the card', () => {
    // a 30 px tag on a 236 px card: 12 px at 30 %
    expect(titleScaleFor(30, 236, 0.3)).toBeCloseTo(titleScale(0.3), 9);
    // at 7 % the card is 16.5 px wide: a 40 px tag shrinks to fit the 2.5 px left, never below nothing
    expect(titleScaleFor(40, 236, 0.07) * 40 * 0.07).toBeCloseTo(236 * 0.07 - 14, 9);
    expect(titleScaleFor(40, 100, 0.07)).toBe(0);
  });
});

describe('the cursor stays on the element it was over (D-1449)', () => {
  const at = { x: 150, y: 200 };

  it('finds the pointer as fractions of the element', () => {
    expect(anchorIn({ left: 100, top: 100, width: 200, height: 400 }, at)).toEqual({ fx: 0.25, fy: 0.25 });
    // outside it (a margin of the hit test): clamped to its edge
    expect(anchorIn({ left: 160, top: 100, width: 200, height: 400 }, at)).toEqual({ fx: 0, fy: 0.25 });
    expect(anchorIn({ left: 100, top: 100, width: 0, height: 400 }, at).fx).toBe(0.5);
  });

  it('moves the view by how far that point of the element is from the pointer once the element is redrawn', () => {
    const a = anchorIn({ left: 100, top: 100, width: 200, height: 400 }, at);
    expect(anchorShift(a, { left: 100, top: 100, width: 200, height: 400 }, at)).toEqual({ dx: 0, dy: 0 });
    // the element moved and grew (a spread column): the same quarter-point is 20 px right and 10 px up of the pointer
    expect(anchorShift(a, { left: 110, top: 50, width: 240, height: 440 }, at)).toEqual({ dx: 20, dy: -40 });
  });
});
