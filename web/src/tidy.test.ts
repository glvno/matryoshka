// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assembliesOf, childrenOf, makeAssembly, overlaps, parentOf, type AssemblyInst, type Rect } from './assembly';
import { DEFS } from './modules';
import { devicesOf } from './pages';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { PRESETS } from './presets';
import { clearAround, isPile, numberedSeries, pushAside, TIDY_GAP, TIDY_GAP_X, tidy, tidyAssembly, type TidySizes } from './tidy';

const W = 250;
const H = 300;
const sizes: TidySizes = { module: () => ({ w: W, h: H }), container: () => ({ w: W, h: 200 }), frame: () => ({ pad: 12, head: 30, minW: 0 }) };
const at = (p: Patch, id: number) => { const m = p.modules.find((x) => x.id === id)!; return [m.x, m.y]; };
const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
  if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`bad cable ${a}.${ap} -> ${b}.${bp}`);
};
/** varied card sizes, as the editor's are */
const varied = (id: number) => ({ w: 200 + (id % 5) * 60, h: 120 + (id % 7) * 50 });
const variedSizes: TidySizes = { module: varied, container: varied, frame: () => ({ pad: 12, head: 30, minW: 0 }), gutter: 40 };

/** the boxes Tidy placed on one level (the canvas, or inside an expanded assembly): cards, collapsed cards, frames */
function boxesOf(p: Patch, sz: TidySizes, inside: AssemblyInst | null = null): Rect[] {
  const asms = assembliesOf(p);
  const inAsm = new Set(asms.flatMap((a) => a.modules));
  const frame = (a: AssemblyInst): Rect => {
    const rs = [...a.modules.map((id) => p.modules.find((m) => m.id === id)!).map((m) => ({ x: m.x, y: m.y, ...sz.module(m.id) })), ...childrenOf(p, a).filter((c) => !c.drawer).map(card)];
    const l = Math.min(...rs.map((r) => r.x)), t = Math.min(...rs.map((r) => r.y));
    return { x: l - 12, y: t - 42, w: Math.max(...rs.map((r) => r.x + r.w)) - l + 24, h: Math.max(...rs.map((r) => r.y + r.h)) - t + 54 };
  };
  const card = (a: AssemblyInst): Rect => (a.open ? frame(a) : { x: a.x, y: a.y, ...sz.container(a.id) });
  const mods = inside ? inside.modules : p.modules.filter((m) => !inAsm.has(m.id) && m.type !== 'fm1').map((m) => m.id);
  const kids = (inside ? childrenOf(p, inside) : asms.filter((a) => !parentOf(p, a.id))).filter((a) => !a.drawer);
  return [...mods.map((id) => p.modules.find((m) => m.id === id)!).map((m) => ({ x: m.x, y: m.y, ...sz.module(m.id) })), ...kids.map(card)];
}
const noOverlap = (rs: Rect[], what: string): void => rs.forEach((a, i) => rs.slice(i + 1).forEach((b) => expect(overlaps(a, b), what).toBe(false)));

describe('tidy up: the signal flow, left to right', () => {
  it('lays a chain out in cable order, left to right, whatever order the cards were in', () => {
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 0, 0).id;
    const vca = addModule(p, DEFS.vca, 300, 0).id;
    const filter = addModule(p, DEFS.filter, 600, 900).id;
    const osc = addModule(p, DEFS.osc, 900, 300).id;
    wire(p, osc, 'out', filter, 'in');
    wire(p, filter, 'lp24', vca, 'in');
    wire(p, vca, 'out', out, 'l');
    tidy(p, sizes);
    expect([osc, filter, vca, out].map((id) => at(p, id)[0])).toEqual([0, 1, 2, 3].map((k) => TIDY_GAP + k * (W + TIDY_GAP_X)));
    expect(at(p, osc)[1]).toBe(TIDY_GAP);
  });

  it('puts Main in the first column and the Output alone in the last', () => {
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 0, 0).id;
    const osc = addModule(p, DEFS.osc, 400, 0).id;
    const main = addModule(p, DEFS.fm1, 800, 0).id;
    const lone = addModule(p, DEFS.noise, 1200, 0).id;
    wire(p, main, 'pitch', osc, 'pitch');
    wire(p, osc, 'out', out, 'l');
    wire(p, lone, 'out', out, 'r');
    tidy(p, sizes);
    const xs = [main, osc, lone, out].map((id) => at(p, id)[0]);
    expect(xs[0]).toBe(TIDY_GAP);
    expect(xs[3]).toBeGreaterThan(Math.max(xs[1], xs[2]));
  });

  it('a modulator sits in the column just before what it moves, not at the far left', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 0, 0).id;
    const filter = addModule(p, DEFS.filter, 0, 0).id;
    const vca = addModule(p, DEFS.vca, 0, 0).id;
    const out = addModule(p, DEFS.output, 0, 0).id;
    const lfo = addModule(p, DEFS.lfo, 0, 0).id;
    wire(p, osc, 'out', filter, 'in');
    wire(p, filter, 'lp24', vca, 'in');
    wire(p, vca, 'out', out, 'l');
    wire(p, lfo, 'out', vca, 'cv');
    tidy(p, sizes);
    expect(at(p, lfo)[0]).toBe(at(p, filter)[0]);
    expect(at(p, lfo)[0]).toBeGreaterThan(at(p, osc)[0]);
  });

  it('cuts a loop at its weakest cable: the sound runs forward, the feedback modulation back', () => {
    const p = emptyPatch();
    const filter = addModule(p, DEFS.filter, 0, 0).id;
    const osc = addModule(p, DEFS.osc, 600, 0).id;
    const out = addModule(p, DEFS.output, 300, 0).id;
    wire(p, osc, 'out', filter, 'in');
    wire(p, filter, 'lp24', osc, 'pm');
    wire(p, filter, 'lp24', out, 'l');
    tidy(p, sizes);
    expect(at(p, osc)[0]).toBeLessThan(at(p, filter)[0]);
    expect(at(p, filter)[0]).toBeLessThan(at(p, out)[0]);
  });

  it('lays out a loop of sound cables alone, in separate columns', () => {
    const p = emptyPatch();
    const a = addModule(p, DEFS.vca, 0, 0).id;
    const b = addModule(p, DEFS.vca, 0, 0).id;
    const c = addModule(p, DEFS.vca, 0, 0).id;
    wire(p, a, 'out', b, 'in');
    wire(p, b, 'out', c, 'in');
    wire(p, c, 'out', a, 'in');
    tidy(p, sizes);
    expect(new Set([a, b, c].map((id) => at(p, id)[0])).size).toBe(3);
    noOverlap(boxesOf(p, sizes), 'loop');
  });

  it('orders a column by where the jacks are: the card fed from the lower jack goes lower', () => {
    const p = emptyPatch();
    const src = addModule(p, DEFS.filter, 0, 0).id;
    const hi = addModule(p, DEFS.vca, 0, 500).id;   // (below at first: the jacks decide)
    const lo = addModule(p, DEFS.vca, 0, 0).id;
    wire(p, src, 'lp24', hi, 'in');
    wire(p, src, 'notch', lo, 'in');
    tidy(p, { ...sizes, jack: (c, end) => ({ card: `m${c[end].module}`, x: 0, y: end === 'from' ? (c.from.port === 'lp24' ? 20 : 280) : 20 }) });
    expect(at(p, hi)[1]).toBeLessThan(at(p, lo)[1]);
  });

  it('keeps the order where the cables do not decide: separate chains stay top to bottom as they were', () => {
    const make = (firstOnTop: boolean) => {
      const p = emptyPatch();
      const a = [addModule(p, DEFS.osc, 0, firstOnTop ? 0 : 900).id, addModule(p, DEFS.vca, 500, firstOnTop ? 0 : 900).id];
      const b = [addModule(p, DEFS.noise, 0, firstOnTop ? 900 : 0).id, addModule(p, DEFS.vca, 500, firstOnTop ? 900 : 0).id];
      wire(p, a[0], 'out', a[1], 'in');
      wire(p, b[0], 'out', b[1], 'in');
      tidy(p, sizes);
      return at(p, a[0])[1] < at(p, b[0])[1];
    };
    expect(make(true)).toBe(true);
    expect(make(false)).toBe(false);
  });

  it('a Scope sits under the card it watches; a comment goes with the card nearest it', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 0, 0).id;
    const out = addModule(p, DEFS.output, 400, 0).id;
    const scope = addModule(p, DEFS.scope, 2000, 2000).id;
    wire(p, osc, 'out', out, 'l');
    wire(p, osc, 'out', scope, 'a');
    p.comments = [{ id: 1, x: 420, y: -100, w: 200, h: 40, text: 'the end' }];
    tidy(p, sizes);
    expect(at(p, scope)).toEqual([at(p, osc)[0], at(p, osc)[1] + H + TIDY_GAP]);
    expect(p.comments[0].x).toBe(at(p, out)[0]);
    expect(p.comments[0].y + 40 + TIDY_GAP).toBe(at(p, out)[1]);   // above the Output, as it was
  });

  it('an FX drawer hanging off a card counts as part of it: the next column starts past it', () => {
    const p = emptyPatch();
    const osc = addModule(p, DEFS.osc, 0, 0).id;
    const out = addModule(p, DEFS.output, 0, 0).id;
    wire(p, osc, 'out', out, 'l');
    tidy(p, { ...sizes, overhang: (k) => (k === `m${osc}` ? { l: 0, t: 0, r: 500, b: 0 } : null) });
    expect(at(p, out)[0]).toBe(at(p, osc)[0] + W + 500 + TIDY_GAP_X);
  });

  it('splits one card feeding a dozen into side-by-side columns, nearer a screen\'s shape', () => {
    const p = emptyPatch();
    const src = addModule(p, DEFS.osc, 0, 0).id;
    const outs = Array.from({ length: 12 }, () => addModule(p, DEFS.vca, 0, 0).id);
    for (const id of outs) wire(p, src, 'out', id, 'in');
    tidy(p, sizes);
    expect(new Set(outs.map((id) => at(p, id)[0])).size).toBeGreaterThan(1);
    noOverlap(boxesOf(p, sizes), 'fan');
  });

  it('moves an expanded assembly as one block, laid out inside first, with nothing overlapping its frame', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 500, 500);
    const y = addModule(p, DEFS.vca, 530, 700);
    addModule(p, DEFS.noise, 40, 40);
    const out = addModule(p, DEFS.output, 0, 900);
    wire(p, x.id, 'out', y.id, 'in');
    wire(p, y.id, 'out', out.id, 'l');
    const asm = makeAssembly(p, [x.id, y.id], 'v');
    asm.open = true;
    asm.frameSize = { width: 2000, height: 2000 };
    tidy(p, sizes);
    expect(asm.frameSize).toBeUndefined();
    expect(at(p, x.id)[1]).toBe(at(p, y.id)[1]);   // a chain inside, side by side
    expect(at(p, y.id)[0]).toBe(at(p, x.id)[0] + W + TIDY_GAP_X);
    noOverlap(boxesOf(p, sizes), 'canvas');
    expect(at(p, out.id)[0]).toBeGreaterThan(at(p, y.id)[0] + W);
  });

  it('leaves skipped modules (the docked Main) where they are, and lays out the same twice', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 900, 900);
    const osc = addModule(p, DEFS.osc, 300, 300);
    const out = addModule(p, DEFS.output, 0, 300);
    wire(p, kb.id, 'pitch', osc.id, 'pitch');
    wire(p, osc.id, 'out', out.id, 'l');
    tidy(p, sizes, new Set([kb.id]));
    const once = JSON.stringify(p);
    tidy(p, sizes, new Set([kb.id]));
    expect(JSON.stringify(p)).toBe(once);
    expect(at(p, kb.id)).toEqual([900, 900]);
    expect(at(p, osc.id)).toEqual([TIDY_GAP, TIDY_GAP]);
  });

  it('lays out one assembly inside from its top left, leaving the rest of the canvas alone', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 500, 500);
    const y = addModule(p, DEFS.vca, 500, 500); // stacked on x, as an old file leaves them
    const free = addModule(p, DEFS.noise, 900, 40);
    wire(p, x.id, 'out', y.id, 'in');
    const asm = makeAssembly(p, [x.id, y.id], 'v');
    asm.open = true;
    tidyAssembly(p, asm, sizes);
    expect(at(p, x.id)).toEqual([500, 500]);
    expect(at(p, y.id)).toEqual([500 + W + TIDY_GAP_X, 500]);
    expect(at(p, free.id)).toEqual([900, 40]);
  });

  it('spreads a pile (a share link without its layout) in rows, wider than tall, in the patch order', () => {
    const p = emptyPatch();
    const ids = Array.from({ length: 12 }, () => addModule(p, DEFS.osc, 0, 0).id);
    expect(isPile(p, sizes)).toBe(true);
    tidy(p, sizes);
    expect(isPile(p, sizes)).toBe(false);
    const boxes = ids.map((id) => { const [x, y] = at(p, id); return { x, y, w: W, h: H }; });
    noOverlap(boxes, 'pile');
    const right = Math.max(...boxes.map((b) => b.x + b.w)), bottom = Math.max(...boxes.map((b) => b.y + b.h));
    expect(right).toBeGreaterThan(bottom); // not one tall column
    expect(at(p, ids[0])).toEqual([TIDY_GAP, TIDY_GAP]);
  });

  it('finds numbered siblings: names alike but for a number, or for a last capital letter in sequence', () => {
    const s = numberedSeries(['VOICE 1', 'VOICE 12', 'Oscillator', 'AENP 1-4', 'AENP 13-16', 'MOD X', 'MOD Y', 'PAD A', 'LONE 3', 'TAPE A', 'TAPE C']);
    expect(s.map((k) => k?.num ?? null)).toEqual([1, 12, null, 1, 13, 88, 89, null, null, null, null]);
    expect(s[0]!.series).toBe(s[1]!.series);
    expect(s[3]!.series).not.toBe(s[0]!.series);
  });

  it('keeps numbered siblings in their number order, down a column and across, whatever the cables say (D-1458)', () => {
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 0, 0).id;
    const filter = addModule(p, DEFS.filter, 0, 0).id;
    const voices = [3, 1, 2, 4].map((k) => { const m = addModule(p, DEFS.osc, 0, 900 - 200 * k); m.name = `VOICE ${k}`; return m; });
    const byName = (k: number) => voices.find((m) => m.name === `VOICE ${k}`)!.id;
    // VOICE 2 runs through a filter, so the cables alone would put it a column before the others
    wire(p, byName(2), 'out', filter, 'in');
    wire(p, filter, 'lp24', out, 'l');
    for (const k of [1, 3, 4]) wire(p, byName(k), 'out', out, 'r');
    tidy(p, sizes);
    const [x1, y1] = at(p, byName(1)), [x2, y2] = at(p, byName(2));
    expect(x1).toBeLessThanOrEqual(x2);
    expect(x1 < x2 || y1 < y2).toBe(true);
    expect(at(p, byName(3))[1]).toBeLessThan(at(p, byName(4))[1]);
    expect(at(p, byName(3))[0]).toBe(at(p, byName(4))[0]);
    const order = devicesOf(p, DEFS).map((d) => d.name).filter((n) => n.startsWith('VOICE'));
    expect(order).toEqual(['VOICE 1', 'VOICE 2', 'VOICE 3', 'VOICE 4']);
  });

  it('every factory patch and example, everything expanded: nothing overlaps on any level, the same layout every time', () => {
    /** an effect in an FX drawer: the editor draws the drawer itself, Tidy leaves it alone */
    const inDrawer = (p: Patch, a: AssemblyInst): boolean => { for (let x: AssemblyInst | undefined = a; x; x = parentOf(p, x.id)) if (x.drawer) return true; return false; };
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      for (const a of assembliesOf(p)) if (!a.drawer) a.open = true;
      tidy(p, variedSizes);
      noOverlap(boxesOf(p, variedSizes), name);
      for (const a of assembliesOf(p)) if (!inDrawer(p, a)) noOverlap(boxesOf(p, variedSizes, a), `${name} / ${a.label}`);
      const q = make();
      for (const a of assembliesOf(q)) if (!a.drawer) a.open = true;
      tidy(q, variedSizes);
      expect(JSON.stringify(q), name).toBe(JSON.stringify(p));
    }
  });

  it('every factory patch, its cards piled at 0, 0: spread out with nothing overlapping', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      for (const m of p.modules) m.x = m.y = 0;
      for (const a of p.assemblies ?? []) a.x = a.y = 0;
      tidy(p, variedSizes);
      noOverlap(boxesOf(p, variedSizes), name);
    }
  });
});

/** two boxes come closer than TIDY_GAP */
const close = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w + TIDY_GAP && b.x < a.x + a.w + TIDY_GAP && a.y < b.y + b.h + TIDY_GAP && b.y < a.y + a.h + TIDY_GAP;

describe('an expanded frame pushes its neighbours aside (#206)', () => {
  const frame = { x: 100, y: 100, w: 600, h: 400 };

  it('moves what it covers the shortest way out, and leaves what it does not touch', () => {
    const [right, below, far] = pushAside(frame, [
      { x: 650, y: 120, w: 200, h: 200 },   // over the right edge: right is shorter
      { x: 150, y: 480, w: 200, h: 200 },   // over the bottom edge: down is shorter
      { x: 2000, y: 2000, w: 200, h: 200 },
    ]);
    expect(right).toEqual({ x: 100 + 600 + TIDY_GAP, y: 120, w: 200, h: 200 });
    expect(below).toEqual({ x: 150, y: 100 + 400 + TIDY_GAP, w: 200, h: 200 });
    expect(far).toEqual({ x: 2000, y: 2000, w: 200, h: 200 });
  });

  it('pushes on through a row: a card it moved into another moves that one too, keeping their order', () => {
    const row = [{ x: 680, y: 150, w: 200, h: 200 }, { x: 900, y: 150, w: 200, h: 200 }, { x: 1120, y: 150, w: 200, h: 200 }];
    const out = pushAside(frame, row);
    expect(out.map((r) => r.x)).toEqual([720, 940, 1160]);
    expect(out.every((r) => r.y === 150)).toBe(true);
    const all = [frame, ...out];
    all.forEach((a, i) => all.slice(i + 1).forEach((b) => expect(close(a, b)).toBe(false)));
  });

  it('moves a card up or left when that spot is free, never off the canvas', () => {
    // just above the frame's header, with room above it: up is the short way
    const [up] = pushAside(frame, [{ x: 200, y: 60, w: 200, h: 40 }]);
    expect(up).toEqual({ x: 200, y: 100 - TIDY_GAP - 40, w: 200, h: 40 });
    // at the canvas's top: it cannot go up, so it goes down past the frame
    const [down] = pushAside({ x: 0, y: 0, w: 600, h: 400 }, [{ x: 100, y: 0, w: 200, h: 100 }]);
    expect(down).toEqual({ x: 100, y: 400 + TIDY_GAP, w: 200, h: 100 });
  });

  it('keeps cards that already lay on one another where they are, when the frame does not reach them', () => {
    const pile = [{ x: 1500, y: 1500, w: 200, h: 200 }, { x: 1520, y: 1520, w: 200, h: 200 }];
    expect(pushAside(frame, pile)).toEqual(pile);
  });

  it('on the canvas: the expanded frame clears the cards and collapsed assemblies around it', () => {
    const p = emptyPatch();
    const a1 = addModule(p, DEFS.osc, 100, 100);
    const a2 = addModule(p, DEFS.adsr, 400, 100);
    const a3 = addModule(p, DEFS.vca, 100, 450);
    const right = addModule(p, DEFS.lfo, 400 + W + 30, 120);    // beside the collapsed card, under the frame once it opens
    const under = addModule(p, DEFS.noise, 150, 450 + H + 10);
    const other = addModule(p, DEFS.mixer, 2000, 2000);
    const b = makeAssembly(p, [other.id], 'b');
    const asm = makeAssembly(p, [a1.id, a2.id, a3.id], 'v');
    asm.open = true;
    clearAround(p, [asm.id], sizes);
    const f = { x: 100 - 12, y: 100 - 12 - 30, w: 400 + W - 100 + 24, h: 450 + H - 100 + 24 + 30 };
    for (const id of [right.id, under.id]) { const [x, y] = at(p, id); expect(close(f, { x, y, w: W, h: H }), String(id)).toBe(false); }
    expect(at(p, right.id)[1]).toBe(120);       // pushed right, not down
    expect(at(p, under.id)[0]).toBe(150);       // pushed down, not right
    expect([b.x, b.y]).toEqual([2000, 2000]);   // out of reach: stays
  });

  it('inside an assembly: a nested frame clears its fellow members, and the frame around it then clears the canvas', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 100, 100);
    const y = addModule(p, DEFS.adsr, 100 + W + 30, 100);
    const sibling = addModule(p, DEFS.vca, 100 + 2 * (W + 30), 100);   // 18 px right of the inner frame once it opens
    const outer = makeAssembly(p, [x.id, y.id, sibling.id], 'outer');
    const inner = makeAssembly(p, [x.id, y.id], 'inner');
    const beside = addModule(p, DEFS.lfo, 100 + 2 * (W + 30) + W + 25, 100);
    outer.open = true;
    clearAround(p, [outer.id], sizes);                // the outer frame alone: its neighbour is clear
    expect(childrenOf(p, outer)).toEqual([inner]);
    expect(parentOf(p, inner.id)).toBe(outer);
    inner.open = true;                               // its frame is wider than its collapsed card (200 wide): it covers the sibling
    const before = at(p, sibling.id)[0];
    clearAround(p, [inner.id], sizes);
    expect(at(p, sibling.id)[0]).toBeGreaterThan(before);
    const box = (id: number): Rect => { const [bx, by] = at(p, id); return { x: bx, y: by, w: W, h: H }; };
    const frameOf = (a: AssemblyInst, rs: Rect[]): Rect => {
      const l = Math.min(...rs.map((r) => r.x)), t = Math.min(...rs.map((r) => r.y));
      const r = Math.max(...rs.map((q) => q.x + q.w)), b = Math.max(...rs.map((q) => q.y + q.h));
      return { x: l - 12, y: t - 12 - 30, w: r - l + 24, h: b - t + 24 + 30 };
    };
    const innerF = frameOf(inner, [box(x.id), box(y.id)]);
    expect(close(innerF, box(sibling.id))).toBe(false);
    const outerF = frameOf(outer, [innerF, box(sibling.id)]);
    expect(close(outerF, box(beside.id))).toBe(false);
  });

  it('every factory patch: each assembly expanded on its own, tidied inside, nothing comes near its frame', () => {
    const size = (id: number) => ({ w: 200 + (id % 5) * 60, h: 120 + (id % 7) * 50 });
    const sz: TidySizes = { module: size, container: size, frame: () => ({ pad: 12, head: 30, minW: 0 }) };
    for (const [name, make] of Object.entries(PRESETS))
      for (const top of (make().assemblies ?? []).filter((a) => !(make().assemblies ?? []).some((b) => b.children?.includes(a.id)))) {
        const p = make();
        const a = p.assemblies!.find((x) => x.id === top.id)!;
        a.open = true;
        tidyAssembly(p, a, sz);
        clearAround(p, [a.id], sz);
        const inAsm = new Set(p.assemblies!.flatMap((x) => x.modules));
        const tops = p.assemblies!.filter((b) => !p.assemblies!.some((c) => c.children?.includes(b.id)));
        const mods = a.modules.map((id) => p.modules.find((m) => m.id === id)!);
        const kids = childrenOf(p, a);
        const rs = [...mods.map((m) => ({ x: m.x, y: m.y, ...size(m.id) })), ...kids.map((k) => ({ x: k.x, y: k.y, ...size(k.id) }))];
        const l = Math.min(...rs.map((r) => r.x)), t = Math.min(...rs.map((r) => r.y));
        const f = { x: l - 12, y: t - 42, w: Math.max(...rs.map((r) => r.x + r.w)) - l + 24, h: Math.max(...rs.map((r) => r.y + r.h)) - t + 54 };
        const others = [
          ...p.modules.filter((m) => !inAsm.has(m.id)).map((m) => ({ x: m.x, y: m.y, ...size(m.id) })),
          ...tops.filter((b) => b !== a).map((b) => ({ x: b.x, y: b.y, ...size(b.id) })),
        ];
        for (const o of others) expect(close(f, o), `${name} / ${a.label}`).toBe(false);
      }
  });
});
