// SPDX-License-Identifier: GPL-3.0-only
// The 808 Kit (gen-presets.ts) and the 808 Kit XL (scripts/xl/808-kit.ts) against the Roland TR-808's owner's manual: the
// card's rows are the TR-808's knobs and switches, named as its panel names them; the closed hihat cuts the open one; the
// XL's switches, ACCENT row and extra voices play.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { readFileSync } from 'node:fs';
import { deviceBudget, encodePatch, rangeList } from './patchbin';
import { cpuEstimate } from './cpu';
import { FM1_PRESETS, XL_PRESETS } from './presets';
import { assembliesOf } from './assembly';
import type { Patch } from './patch';

const SR = 48000;
/** the Drum map rows' keys: DRUMS (F3..F4) and the XL's DRUMS 2 (G4 A4 B4 C5) */
const BD = 53, SD = 55, CP = 57, CH = 59, OH = 60, LT = 62, RS = 64, MT = 67, HT = 69, CY = 71, AC = 72;

/** the card "808 kit": its rows as "heading: label" (a row under the same heading: its label) */
function rowsOf(p: Patch): string[] {
  const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
  return card.params.map((r) => (r.head ? `${r.head}: ${r.label}` : r.label));
}
const setRow = (p: Patch, head: string, label: string, v: number): void => {
  const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
  const i = card.params.findIndex((r) => r.head === head);
  const r = card.params.slice(i).find((x) => x.label === label)!;
  p.modules.find((m) => m.id === r.module)!.params[r.param] = v;
};

/** render `secs` after these key events ([seconds, note, velocity 0..1]), the left channel */
function play(p: Patch, events: [number, number, number][], secs: number): Float32Array {
  const e = new Engine(SR);
  e.load(p);
  const out = new Float32Array(Math.round(SR * secs));
  const BLOCK = 128;
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) {
    for (const [t, n, v] of events) {
      const s = Math.round(t * SR);
      if (s >= at && s < at + BLOCK) e.noteOn(n, v);
      if (s + 480 >= at && s + 480 < at + BLOCK) e.noteOff(n);
    }
    const l = new Float32Array(Math.min(BLOCK, out.length - at));
    e.render(l, r.subarray(0, l.length));
    out.set(l, at);
  }
  return out;
}
const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0;
  const a = Math.round(from * SR), b = Math.round(to * SR);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const differ = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length) / Math.max(rms(a, 0, a.length / SR), 1e-9);
};

describe('808 Kit (the FM-1 version)', () => {
  const kit = (): Patch => FM1_PRESETS['808 Kit']();

  it('has the TR-808\'s knobs for its eight voices, named as its panel names them, and nothing else on its card', () => {
    expect(rowsOf(kit())).toEqual([
      'bass drum: level', 'tone', 'decay',
      'snare drum: level', 'tone', 'snappy',
      'low tom: level', 'tuning',
      'rim shot: level',
      'hand clap: level',
      'cow bell: level',
      'open hihat: level', 'decay',
      'closed hihat: level',
    ]);
  });

  it('fits the FM-1', () => {
    const p = kit();
    expect(deviceBudget(p).fits).toBe(true);
    expect(cpuEstimate(p).use).toBeLessThanOrEqual(1);
  });

  it('its velocity macro ranges reach the FM-1: in the patch and in presets.h (#367)', () => {
    const p = kit();
    expect(p.modules.filter((m) => m.range?.p1?.gain).length).toBe(8);
    expect(rangeList(p).length).toBe(8);
    const bin = encodePatch(p);
    expect(bin[6] & 2).toBe(2);   // (the macro ranges section's flag)
    const h = readFileSync(new URL('../../firmware/src/presets.h', import.meta.url), 'utf8');
    const shipped = [...h.matchAll(/static const uint8_t PRESET_\d+\[\d+\] = \{([^}]*)\}/g)].map((m) => m[1].split(',').map(Number));
    expect(shipped.some((b) => b.length === bin.length && b.every((x, i) => x === bin[i]))).toBe(true);
  });

  it('the closed hihat cuts the open one, and an open hit after it sounds again', () => {
    const open = play(kit(), [[0, OH, 0.79]], 0.8);
    const cut = play(kit(), [[0, OH, 0.79], [0.1, CH, 0.79]], 0.8);
    expect(rms(open, 0.25, 0.5)).toBeGreaterThan(1e-4);
    expect(rms(cut, 0.25, 0.5)).toBeLessThan(rms(open, 0.25, 0.5) / 20);
    const again = play(kit(), [[0, OH, 0.79], [0.1, CH, 0.79], [0.2, OH, 0.79]], 0.8);
    expect(rms(again, 0.4, 0.6)).toBeGreaterThan(rms(open, 0.2, 0.4) / 3);
  });

  it('bass drum TONE and snare drum TONE change the sound', () => {
    for (const [head, key, lo, hi] of [['bass drum', BD, 150, 8000], ['snare drum', SD, 0, 1]] as const) {
      const a = kit(), b = kit();
      setRow(a, head, 'tone', lo);
      setRow(b, head, 'tone', hi);
      expect(differ(play(a, [[0, key, 0.79]], 0.3), play(b, [[0, key, 0.79]], 0.3)), head).toBeGreaterThan(0.05);
    }
  });

  it('a row\'s velocity 127 accents its drum by 127 / 100', () => {
    const plain = peak(play(kit(), [[0, BD, 100 / 127]], 0.3));
    const accent = peak(play(kit(), [[0, BD, 1]], 0.3));
    expect(accent / plain).toBeCloseTo(1.27, 1);
  });
});

describe('808 Kit XL', () => {
  const xl = (): Patch => XL_PRESETS['808 Kit XL']();

  it('has every TR-808 knob and switch on its card, in the panel\'s order', () => {
    expect(rowsOf(xl())).toEqual([
      'accent: level',
      'bass drum: level', 'tone', 'decay',
      'snare drum: level', 'tone', 'snappy',
      'low tom: level', 'tuning', 'tom/conga',
      'mid tom: level', 'tuning', 'tom/conga',
      'hi tom: level', 'tuning', 'tom/conga',
      'rim shot: level', 'rim/claves',
      'hand clap: level', 'clap/maraca',
      'cow bell: level',
      'cymbal: level', 'tone', 'decay',
      'open hihat: level', 'decay',
      'closed hihat: level',
      'pre-scale: pre-scale',
    ]);
  });

  it('names its switches\' positions and pre-scale\'s four rates', () => {
    const card = assembliesOf(xl()).find((a) => a.name === '808 kit')!;
    const names = Object.fromEntries(card.params.filter((r) => r.names).map((r, i) => [`${i} ${r.label}`, r.names]));
    expect(names).toEqual({
      '0 tom/conga': ['tom', 'conga'], '1 tom/conga': ['tom', 'conga'], '2 tom/conga': ['tom', 'conga'],
      '3 rim/claves': ['rim shot', 'claves'], '4 clap/maraca': ['hand clap', 'maracas'],
      '5 pre-scale': ['1/8T', '1/16', '1/16T', '1/32'],
    });
  });

  it('pre-scale sets both tracks\' rate: 3, 4, 6 or 8 steps a beat', () => {
    const p = xl();
    const card = assembliesOf(p).find((a) => a.name === '808 kit')!;
    const sel = p.modules.find((m) => m.id === card.params.find((r) => r.label === 'pre-scale')!.module)!;
    const tracks = p.modules.filter((m) => m.type === 'steps' && (m.name === 'DRUMS' || m.name === 'DRUMS 2'));
    expect(tracks.length).toBe(2);
    for (const t of tracks) {
      expect(p.cables.some((c) => c.from.module === sel.id && c.to.module === t.id && c.to.port === 'p1')).toBe(true);
      expect(t.range!.p1!.rate).toEqual([0, 1]);
    }
    // the positions' values are the rates' places among 1/4 1/4T 1/8 1/8T 1/16 1/16T 1/32 (0..6), over 6
    expect([1, 2, 3, 4].map((k) => Math.round(sel.params[`v${k}`] * 6))).toEqual([3, 4, 5, 6]);
    expect(sel.params.pos).toBe(2);   // (1/16 as it ships)
  });

  it('plays all eleven voices', () => {
    for (const key of [BD, SD, CP, CH, OH, LT, RS, 65, MT, HT, CY]) expect(peak(play(xl(), [[0, key, 0.79]], 0.4)), `key ${key}`).toBeGreaterThan(0.01);
  });

  it('each switch plays its second sound at position 2', () => {
    for (const [head, sw, key] of [['low tom', 'tom/conga', LT], ['mid tom', 'tom/conga', MT], ['hi tom', 'tom/conga', HT], ['rim shot', 'rim/claves', RS], ['hand clap', 'clap/maraca', CP]] as const) {
      const a = xl(), b = xl();
      setRow(b, head, sw, 2);
      const one = play(a, [[0, key, 0.79]], 0.3), two = play(b, [[0, key, 0.79]], 0.3);
      expect(peak(two), head).toBeGreaterThan(0.01);
      expect(differ(one, two), head).toBeGreaterThan(0.3);
    }
  });

  it('only the AC row accents, by ACCENT LEVEL (1 + level); a row\'s velocity does not', () => {
    const plain = peak(play(xl(), [[0, BD, 100 / 127]], 0.3));
    expect(peak(play(xl(), [[0, BD, 1]], 0.3)) / plain).toBeCloseTo(1, 2);
    expect(peak(play(xl(), [[0, BD, 100 / 127], [0, AC, 100 / 127]], 0.3)) / plain).toBeCloseTo(1.5, 1);
    const p = xl();
    setRow(p, 'accent', 'level', 1);
    expect(peak(play(p, [[0, BD, 100 / 127], [0, AC, 100 / 127]], 0.3)) / plain).toBeCloseTo(2, 1);
  });

  it('the closed hihat cuts the open one', () => {
    const open = play(xl(), [[0, OH, 0.79]], 0.8);
    const cut = play(xl(), [[0, OH, 0.79], [0.1, CH, 0.79]], 0.8);
    expect(rms(cut, 0.25, 0.5)).toBeLessThan(rms(open, 0.25, 0.5) / 20);
  });
});
