// SPDX-License-Identifier: GPL-3.0-only
// The far levels of the semantic zoom (D-1448): the scene read off the cards, the names level's spread columns, what is
// under a point, where an element is drawn (for the cursor anchoring, D-1449) and Fit below 16 %.
import { describe, expect, it } from 'vitest';
import { farFit, farLayout, farRect, farScene, pickFar, type Measure, type RawCable, type RawCard, type RawFrame } from './far-view';
import { LOD_BLOCKS, LOD_NAMES } from './lod';

/** the card title's type, estimated: half an em a letter */
const measure: Measure = (text, px) => text.length * px * 0.5;

const card = (key: string, name: string, x: number, y: number, w = 236, h = 150): RawCard => ({
  key, name, tag: name.slice(0, 3).toUpperCase(), color: '#226669', off: false, x, y, w, h,
  ports: [{ fx: 0, fy: 0.5, kind: 'audio', on: true }, { fx: 1, fy: 0.5, kind: 'audio', on: true }],
});
const cable = (kind: RawCable['kind'], a: RawCard, b: RawCard): RawCable => ({
  kind, mod: kind === 'control', a: { key: a.key, x: a.x + a.w, y: a.y + a.h / 2 }, b: { key: b.key, x: b.x, y: b.y + b.h / 2 },
});

// a loose sequencer feeding a voice (two cards in one column, in an assembly) and an effect (an assembly of one card)
const seq = card('m1', 'Steps', 0, 300);
const osc = card('m2', 'Oscillator', 600, 200);
const env = card('m3', 'Level / Rate Envelope', 600, 360);
const rev = card('m4', 'Reverb', 1400, 300);
const voice: RawFrame = { key: 'f1', name: 'Voice', depth: 0, x: 560, y: 140, w: 360, h: 420 };
const fx: RawFrame = { key: 'f2', name: 'Effects', depth: 0, x: 1360, y: 240, w: 320, h: 260 };
const raw = { cards: [seq, osc, env, rev], frames: [voice, fx], cables: [cable('gate', seq, osc), cable('control', seq, env), cable('audio', osc, env), cable('audio', env, rev)] };

describe('farScene: what the far levels draw, read off the cards', () => {
  it('puts each card in its assembly and sums the cables between the blocks level\'s units', () => {
    const s = farScene(raw);
    const by = (k: string) => s.cards.find((c) => c.key === k)!;
    expect(by('m1').frame).toBeNull();
    expect(by('m2').frame?.key).toBe('f1');
    expect(by('m4').frame?.key).toBe('f2');
    expect(s.units.map((u) => u.key).sort()).toEqual(['f1', 'f2', 'm1']);
    // the two cables from the sequencer into the voice are one arrow; the cable inside the voice is none
    const flow = (a: string, b: string) => s.flows.find((f) => f.a.key === a && f.b.key === b);
    expect(flow('m1', 'f1')).toMatchObject({ n: 2, kinds: { gate: 1, control: 1 } });
    expect(flow('f1', 'f2')).toMatchObject({ n: 1, kinds: { audio: 1 } });
    expect(s.flows).toHaveLength(2);
  });
});

describe('farLayout: the names level spreads the columns apart', () => {
  it('grows every card to hold its name at 14 px, keeps each column\'s order and overlaps nothing', () => {
    const s = farScene(raw);
    for (const z of [0.15, 0.1, 0.06]) {
      const L = farLayout(s, z, measure);
      const rs = s.cards.map((c) => L.cards.get(c)!);
      for (const c of s.cards) expect(L.cards.get(c)!.w * z).toBeGreaterThanOrEqual(measure(c.name.toUpperCase().split(' / ')[0], 14));
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
      const [o, e] = [L.cards.get(s.cards[1])!, L.cards.get(s.cards[2])!];
      expect(o.y + o.h).toBeLessThanOrEqual(e.y);
      // the sequencer's column ends before the voice's starts, the voice's before the effects'
      expect(L.cards.get(s.cards[0])!.x + L.cards.get(s.cards[0])!.w).toBeLessThanOrEqual(o.x);
      expect(Math.max(o.x + o.w, e.x + e.w)).toBeLessThanOrEqual(L.cards.get(s.cards[3])!.x);
      // each assembly's block surrounds its cards
      const v = L.frames.get(s.frames[0])!;
      for (const r of [o, e]) expect(r.x >= v.x && r.y >= v.y && r.x + r.w <= v.x + v.w && r.y + r.h <= v.y + v.h).toBe(true);
    }
  });

  it('spreads further the further out it is, so the names keep their size on screen', () => {
    const s = farScene(raw);
    expect(farLayout(s, 0.06, measure).extent.w).toBeGreaterThan(farLayout(s, 0.15, measure).extent.w);
  });
});

describe('pickFar and farRect: what is under a point and where an element is drawn', () => {
  it('finds a card, a patched jack and an assembly at the names level, where the spread layout drew them', () => {
    const s = farScene(raw), z = 0.08, L = farLayout(s, z, measure);
    const r = L.cards.get(s.cards[1])!;
    expect(pickFar(s, LOD_NAMES, L, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, z, measure)).toEqual({ card: s.cards[1] });
    // the jack on the card's left edge zooms in to where that jack is on the card itself
    expect(pickFar(s, LOD_NAMES, L, { x: r.x, y: r.y + r.h / 2 }, z, measure)).toEqual({ jack: { x: 600, y: 275 } });
    const v = L.frames.get(s.frames[0])!;
    expect(pickFar(s, LOD_NAMES, L, { x: v.x + 2 / z, y: v.y + 2 / z }, z, measure)).toEqual({ frame: s.frames[0] });
    expect(farRect(s, LOD_NAMES, L, 'm2', z, measure)).toEqual(r);
    expect(farRect(s, LOD_NAMES, L, 'f1', z, measure)).toEqual(v);
  });

  it('at the blocks level, hands a card inside an assembly to its block and draws a loose card as a tile', () => {
    const s = farScene(raw), z = 0.03;
    expect(farRect(s, LOD_BLOCKS, null, 'm3', z, measure)).toBe(s.frames[0]);
    const tile = farRect(s, LOD_BLOCKS, null, 'm1', z, measure)!;
    expect(tile.w * z).toBeGreaterThanOrEqual(measure('STEPS', 12));
    expect(pickFar(s, LOD_BLOCKS, null, { x: tile.x + tile.w / 2, y: tile.y + tile.h / 2 }, z, measure)).toEqual({ card: s.cards[0] });
    expect(pickFar(s, LOD_BLOCKS, null, { x: 1500, y: 450 }, z, measure)).toEqual({ frame: s.frames[1] });
    expect(pickFar(s, LOD_BLOCKS, null, { x: 3000, y: 3000 }, z, measure)).toBeNull();
  });
});

describe('farFit: Fit below 16 %', () => {
  it('takes the largest names-level zoom at which the spread drawing fits, else the top of the blocks level', () => {
    const s = farScene(raw);
    const roomy = farFit(s, 600, 400, 0.16, 0.02, 0.0417, measure);
    expect(roomy.z).toBeLessThanOrEqual(0.16);
    expect(roomy.z).toBeGreaterThanOrEqual(0.0417);
    const e = farLayout(s, roomy.z, measure).extent;
    expect(e.w * roomy.z).toBeLessThanOrEqual(600 - 48);
    expect(e.h * roomy.z).toBeLessThanOrEqual(400 - 48);
    const tight = farFit(s, 120, 80, 0.16, 0.02, 0.0417, measure);
    expect(tight.z).toBeLessThanOrEqual(0.0417);
    expect(tight.z).toBeGreaterThan(0.02);
    // (and never past the 2 % floor)
    expect(farFit(s, 60, 60, 0.16, 0.02, 0.0417, measure).z).toBe(0.02);
  });
});
