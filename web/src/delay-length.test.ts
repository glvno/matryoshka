// SPDX-License-Identifier: GPL-3.0-only
// The Delay's length row and the FM-1's effect memory (docs/ledger/engine.md D-375): each Delay's line holds its length (700 ms
// for a Delay from before the row), its time plays up to it in both engines, and the lines of every line-type module share
// the FM-1's two line areas. A patch whose lines do not fit is over the FM-1 budget: a sandbox patch.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFS, delayLine, delayReach, DELAY_LENGTH_DEFAULT, DELAY_LENGTH_MAX, DELAY_SYNC_TOP, DELAY_TIME_MAX, DEVICE_SR, rowRange } from './modules';
import { addModule, connect, emptyPatch, modulate, morphValue, topOf, validatePatch, type Patch } from './patch';
import { ARENA, browserOnly, delayBytes, delayRoom, deviceBudget, encodePatch, formatOf, LINE_LOW, lineBudget, linePlace, LINES, linesAdvice, toQ16 } from './patchbin';
/** the line area the FM-1 had in its pool before the arena (#649): a 700 ms delay line, 8 string lines and a granular line */
const OLD_POOL = 167980;
import { Engine } from './engine';

const SR = 44100;
const timePd = DEFS.delay.params.find((q) => q.name === 'time')!;
const lengthPd = DEFS.delay.params.find((q) => q.name === 'length')!;
const engineC = readFileSync(new URL('../../firmware/src/engine.c', import.meta.url), 'utf8');

/** a constant 1 into a Delay (mix 1, no feedback) into the Output: silent until the echo arrives */
function delayPatch(params: Record<string, number>): Patch {
  const p = emptyPatch('Long');
  addModule(p, DEFS.fm1, 0, 0);
  const one = addModule(p, DEFS.const, 0, 0);
  one.params.value = 1;
  const dly = addModule(p, DEFS.delay, 0, 0);
  Object.assign(dly.params, { fb: 0, mix: 1, ...params });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 0.7;
  connect(p, DEFS, { module: one.id, port: 'out' }, { module: dly.id, port: 'in' });
  connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(p, DEFS, { module: dly.id, port: 'r' }, { module: out.id, port: 'r' });
  return p;
}

/** the first sample the echo is heard on, left and right */
function echoAt(params: Record<string, number>, secs = 2.5): { l: number; r: number } {
  const e = new Engine(SR);
  e.load(delayPatch(params));
  const l = new Float32Array(Math.round(SR * secs));
  const r = new Float32Array(l.length);
  e.render(l, r);
  return { l: l.findIndex((v) => v > 0.3), r: r.findIndex((v) => v > 0.3) };
}

/** a length's line in samples at SR */
const line = (ms: number): number => Math.round((SR * delayLine(ms)) / DEVICE_SR);
/** the synced delay's beat with no clock: 120 bpm */
const BEAT = Math.round(SR / 2);

/** a patch with these line-type modules (each wired from Main's gate into the Output, so the FM-1 runs it) */
function linesPatch(mods: [string, Record<string, number>?][]): Patch {
  const p = emptyPatch('Lines');
  const kb = addModule(p, DEFS.fm1, 0, 0);
  const out = addModule(p, DEFS.output, 0, 0);
  for (const [type, params] of mods) {
    const m = addModule(p, DEFS[type], 0, 0);
    Object.assign(m.params, params ?? {});
    const into = DEFS[type].inputs.find((q) => q.kind === 'audio')!.name;
    connect(p, DEFS, { module: kb.id, port: 'gate' }, { module: m.id, port: into });
    connect(p, DEFS, { module: m.id, port: DEFS[type].outputs[0].name }, { module: out.id, port: 'l' });
  }
  return p;
}

describe('the Delay\'s length row', () => {
  it('is a row of format 50 set when the patch loads; an older Delay reads 700 ms, the line it had', () => {
    expect(lengthPd).toMatchObject({ min: 10, max: DELAY_LENGTH_MAX, default: DELAY_LENGTH_DEFAULT, since: 50, fixed: true, unit: 'ms' });
    expect(DELAY_LENGTH_DEFAULT).toBe(700);
    expect(DEFS.delay.params.at(-1)).toBe(lengthPd);
    expect(delayLine(700)).toBe(30944);   // engine.c DELAY_LEN, every Delay's line before the row
    for (const ms of [10, 11, 120, 333, 700, 1001, 1900]) {
      expect(delayLine(ms) % 2).toBe(0);
      expect(delayLine(ms) - 1).toBeGreaterThanOrEqual(Math.round((ms / 1000) * DEVICE_SR));   // the whole length fits
    }
    // the firmware sizes the line the same way, and its defs.h has the row as a fixed one
    expect(engineC).toMatch(/return 2u \* \(\(ms \* ENG_SR \+ 1999u\) \/ 2000u\) \+ 60u;/);
    expect(engineC).toMatch(/#define DELAY_LEN 30944u/);
    const defs = readFileSync(new URL('../../firmware/src/defs.h', import.meta.url), 'utf8');
    expect(defs).toMatch(/#define DEF_FIXED\(t, j\) \(\(\(t\) == T_DELAY && \(j\) == DELAY_P_LENGTH\)\)/);
    expect(defs).toMatch(new RegExp(`DELAY_MAX\\[\\] = \\{${toQ16(700)},`));
    expect(defs).toMatch(/#define DELAY_SYNC_TOP 520\b/);
    // a Delay of the default length stays in the older format; any other length, or a time past 700 ms, is format 50
    expect(formatOf(delayPatch({ time: 500 }))).toBeLessThan(50);
    expect(formatOf(delayPatch({ time: 500, length: 900 }))).toBe(50);
    expect(formatOf(delayPatch({ time: 900, length: 900 }))).toBe(50);
  });

  it('plays a time within 700 ms with the default length as before: free, synced (cut to the line) and ping-pong (half)', () => {
    expect(echoAt({ time: 500 }).l).toBe(Math.round(0.5 * SR));
    expect(echoAt({ time: 700 }).l).toBe(Math.round(0.7 * SR));
    expect(DELAY_SYNC_TOP).toBe(520);
    expect(echoAt({ time: 250, sync: 1 }).l).toBe(Math.round((3 * BEAT) / 4));
    expect(echoAt({ time: 1 + (6 / 10) * (DELAY_SYNC_TOP - 1), sync: 1 }).l).toBe(BEAT);
    expect(echoAt({ time: 1 + (7 / 10) * (DELAY_SYNC_TOP - 1), sync: 1 }).l).toBe(line(700) - 1);
    expect(echoAt({ time: DELAY_TIME_MAX, pingpong: 1 }).l).toBe(Math.floor(line(700) / 2) - 1);
  });

  it('plays up to its length: a longer line reaches further, a shorter one cuts the time', () => {
    expect(echoAt({ time: 1200, length: 1600 }).l).toBe(Math.round(1.2 * SR));
    expect(echoAt({ time: 1900, length: 1900 }, 2.5).l).toBe(Math.round(1.9 * SR));
    expect(echoAt({ time: 1200 }).l).toBe(line(700) - 1);                    // (700 ms: the time is cut to it)
    expect(echoAt({ time: 500, length: 120 }).l).toBe(line(120) - 1);
    expect(echoAt({ time: 1200, sync: 1, length: 300 }).l).toBe(line(300) - 1);
    expect(echoAt({ time: 800, pingpong: 1, length: 1600 }).l).toBe(Math.round(0.8 * SR));   // ping-pong: half the line each side
    // the time row spans what the line plays (the FM-1: pages_ui.c row_top); synced it keeps its note lengths
    expect(delayReach({ length: 1600 })).toBe(1600);
    expect(delayReach({ length: 1600, pingpong: 1 })).toBe(800);
    expect(topOf(rowRange('delay', { length: 1600 }, timePd))).toBe(1600);
    expect(rowRange('delay', { length: 300 }, timePd).max).toBe(300);
    expect(rowRange('delay', { length: 300, sync: 1 }, timePd)).toBe(timePd);
  });

  it('modulation and morph past 700 ms stay in the stretch; within the range they are as before', () => {
    expect(topOf(timePd)).toBe(DELAY_LENGTH_MAX);
    expect(modulate(timePd, 300, 1)).toBe(DELAY_TIME_MAX);
    expect(modulate(timePd, 300, -1)).toBe(1);
    expect(modulate(timePd, 1200, 0)).toBe(1200);
    expect(modulate(timePd, 1600, 1)).toBe(DELAY_LENGTH_MAX);
    expect(morphValue(timePd, 300, 1200, 0.5)).toBe(750);
    expect(engineC).toMatch(/#define DELAY_TIME_TOP \(DELAY_LENGTH_MAX \* ENG_ONE\)/);
  });

  it('a time past 700 ms plays on the FM-1; only a morph B side past it is the browser\'s', () => {
    for (const time of [701, 1200, 1900]) {
      const p = delayPatch({ time, length: time });
      expect(browserOnly(p)).toEqual([]);
      expect(deviceBudget(p).fits).toBe(true);
      expect(() => encodePatch(p)).not.toThrow();
    }
    const q = delayPatch({ time: 400 });
    q.modules.find((m) => m.type === 'delay')!.paramsB = { time: 1100 };
    expect(browserOnly(q)).toEqual(['Delay over 700 ms on the morph B side: browser only']);
    expect(deviceBudget(q).fits).toBe(false);
  });

  it('a Delay saved before the row gets the length it played with', () => {
    const old = (params: Record<string, number>, paramsB?: Record<string, number>): number => {
      const p = delayPatch(params);
      const m = p.modules.find((x) => x.type === 'delay')!;
      delete m.params.length;
      if (paramsB) m.paramsB = paramsB;
      return validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules.find((x) => x.type === 'delay')!.params.length;
    };
    expect(old({ time: 500 })).toBe(700);
    expect(old({ time: 700, pingpong: 1 })).toBe(700);
    expect(old({ time: 1234 })).toBe(1240);
    expect(old({ time: 1000, pingpong: 1 })).toBe(1600);   // (the browser's 1.6 s line: 800 ms each side)
    expect(old({ time: 300 }, { time: 900 })).toBe(900);
  });
});

describe('the FM-1\'s memory (the lines: D-375; one arena, #649)', () => {
  it('has the firmware\'s two line areas and line sizes (engine.c)', () => {
    expect(engineC).toMatch(/#define STR_LEN 1104u/);
    expect(engineC).toMatch(/#define GRAIN_LEN 44118u/);
    expect(engineC).toMatch(/#define RV_LEN 8074u/);
    expect(engineC).toMatch(/#define CH_LEN 927u/);
    expect(engineC).toMatch(/#define LINE_LOW \(LINE_BYTES\(2u \* RV_LEN\) \+ LINE_BYTES\(2u \* CH_LEN\) \+ 8192u\)/);
    expect(delayBytes(700) + 8 * LINES.string + LINES.grain).toBe(OLD_POOL);
    expect(LINE_LOW).toBe(26196);
    expect(ARENA).toBe(OLD_POOL + 255 * 512 + 129 * 264 + 1536 * 4);
    expect(engineC).toMatch(/#define ENG_ARENA \(LINE_ARENA \+ 255u \* ENG_BUF_BYTES \+ 129u \* ENG_INST_BYTES \+ 1536u \* 4u\)/);
    expect(LINES).toEqual({ string: 2208, grain: 88428, reverb: 16148, chorus: 1856 });
    expect(delayBytes(700)).toBe(61888);
    expect(delayBytes(DELAY_LENGTH_MAX)).toBeLessThanOrEqual(OLD_POOL);
  });

  it('holds every patch the FM-1 played before (a 700 ms Delay, 8 strings, a Granular, a reverb, a chorus, any subset)', () => {
    for (let d = 0; d <= 1; d++) for (let s = 0; s <= 8; s++) for (let g = 0; g <= 1; g++) for (let r = 0; r <= 1; r++) for (let c = 0; c <= 1; c++) {
      const sizes = [...Array(d).fill(delayBytes(700)), ...Array(s).fill(LINES.string), ...Array(g).fill(LINES.grain), ...Array(r).fill(LINES.reverb), ...Array(c).fill(LINES.chorus)];
      expect(linePlace(sizes, OLD_POOL), `${d} ${s} ${g} ${r} ${c}`).not.toBeNull();   // (what the arena leaves a patch within the old pools)
    }
  });

  it('places the largest first, each into the area with the least room that holds it', () => {
    expect(linePlace([LINES.grain, delayBytes(700), LINES.reverb, LINES.chorus], OLD_POOL)).toEqual([1, 1, 1, 0]);
    expect(linePlace([LINES.reverb, LINES.reverb], OLD_POOL)).toEqual([0, 1]);
    expect(linePlace([OLD_POOL + 4], OLD_POOL)).toBeNull();
    // within the total but not in the two areas: a 1.75 s Delay fills most of the pool's, two reverbs do not fit the low one
    expect(delayBytes(1750) + 2 * LINES.reverb).toBeLessThan(LINE_LOW + OLD_POOL);
    expect(linePlace([delayBytes(1750), LINES.reverb, LINES.reverb], OLD_POOL)).toBeNull();
  });

  it('any number of Delays, reverbs and choruses while their lines fit; over it the patch is a sandbox patch, and says why', () => {
    const three = linesPatch([['delay', { length: 500 }], ['delay', { length: 300 }], ['delay', { length: 900 }], ['reverb'], ['reverb'], ['chorus'], ['chorus']]);
    const b = deviceBudget(three);
    expect(b.lines.fits).toBe(true);
    expect(b.fits).toBe(true);
    expect(b.lines.lines).toBe(delayBytes(500) + delayBytes(300) + delayBytes(900) + 2 * LINES.reverb + 2 * LINES.chorus);
    expect(b.lines.used).toBe(b.lines.lines + b.lines.copiesBytes + b.lines.buffersBytes + b.lines.paramsBytes);
    expect(b.items.find((i) => i.key === 'memory')).toMatchObject({ label: 'memory', max: ARENA + LINE_LOW });
    expect(() => encodePatch(three)).not.toThrow();
    const full = linesPatch([['delay', { length: 1900 }], ['delay', { length: 1900 }], ['delay', { length: 1900 }], ['grain']]);
    const f = deviceBudget(full);
    expect(f.lines.fits).toBe(false);
    expect(f.fits).toBe(false);
    expect(f.over.map((i) => i.key)).toEqual(['memory']);
    expect(linesAdvice(full)).toMatch(/^Memory full: \d+ of 356 KB used\. Shorten another Delay or remove the Granular \(86 KB\)\.$/);
    expect(() => encodePatch(full)).toThrow(/over the FM-1 budget/);
  });

  it('a Delay\'s length stops at what the memory has left besides the other lines (the editor\'s length row)', () => {
    const p = linesPatch([['grain'], ['grain'], ['delay', { length: 1500 }], ['delay', { length: 200 }], ['reverb']]);
    const id = p.modules.find((m) => m.type === 'delay' && m.params.length === 200)!.id;
    const room = delayRoom(p, id);
    expect(room % 10).toBe(0);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(DELAY_LENGTH_MAX);
    p.modules.find((m) => m.id === id)!.params.length = room;
    expect(lineBudget(p).fits).toBe(true);
    p.modules.find((m) => m.id === id)!.params.length = room + 10;
    expect(lineBudget(p).fits).toBe(false);
    const one = linesPatch([['delay']]);
    expect(delayRoom(one, one.modules.find((m) => m.type === 'delay')!.id)).toBe(DELAY_LENGTH_MAX);
  });
});
