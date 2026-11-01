// SPDX-License-Identifier: GPL-3.0-only
// The global tempo (D-903): the setting, its storage, the wire format, the browser engine and MIDI clock out.
import { describe, expect, it } from 'vitest';
import { clockPeriod } from './clock-out';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, emptyPatch, type Patch } from './patch';
import { CMD, FEATURE_TEMPO, frame, parse, parseInfo, parseTempoNow, tempoFrame } from './protocol';
import { clampBpm, isGlobalTempo, patchTempo, readTempo, Tempo, tempo, tempoNow } from './tempo';

const SR = 48000;
/** a patch with Main at `bpm` and a Steps module with no notes (its clock is what counts) */
function withTempo(bpm: number): Patch {
  const p = emptyPatch('t');
  addModule(p, DEFS.fm1, 0, 0).params.tempo = bpm;
  addModule(p, DEFS.output, 0, 0);
  return p;
}
/** the engine's clock ticks over `samples` */
function ticks(e: Engine, samples: number): number {
  const at = (e as unknown as { ticks: number }).ticks;
  e.render(new Float32Array(samples), new Float32Array(samples));
  return (e as unknown as { ticks: number }).ticks - at;
}

describe('the setting (tempo.ts)', () => {
  it('is Global at the open patch\'s tempo on a first visit, and reads what was stored', () => {
    expect(readTempo(null, 124)).toEqual({ mode: 'global', bpm: 124 });
    expect(readTempo('not json', 90.4)).toEqual({ mode: 'global', bpm: 90 });
    expect(readTempo(JSON.stringify({ mode: 'patch', bpm: 133 }), 124)).toEqual({ mode: 'patch', bpm: 133 });
    expect(readTempo(JSON.stringify({ mode: 'global', bpm: 999 }), 124)).toEqual({ mode: 'global', bpm: 300 });
    expect(readTempo(JSON.stringify({ mode: 'other', bpm: 100 }), 124)).toEqual({ mode: 'global', bpm: 124 });
  });

  it('plays the global tempo while Global, the patch\'s own while Patch', () => {
    const p = withTempo(124);
    expect(patchTempo(p)).toBe(124);
    expect(patchTempo(emptyPatch('none'))).toBe(120);
    expect(tempoNow({ mode: 'global', bpm: 100 }, p)).toBe(100);
    expect(tempoNow({ mode: 'patch', bpm: 100 }, p)).toBe(124);
    expect(clampBpm(19)).toBe(20);
    expect(clampBpm(Number.NaN)).toBe(120);
  });

  it('tells its listeners what changed and where from, and nothing when nothing did', () => {
    const t = new Tempo();
    const heard: string[] = [];
    t.listen((s, from, was) => heard.push(`${was.mode} ${was.bpm} > ${s.mode} ${s.bpm} (${from})`));
    t.set({ bpm: 126 });
    t.set({ bpm: 126.2 });
    t.set({ mode: 'patch' }, 'device');
    t.set({ mode: 'global', bpm: 400 }, 'emu');
    expect(heard).toEqual(['global 120 > global 126 (editor)', 'global 126 > patch 126 (device)', 'patch 126 > global 300 (emu)']);
  });

  it('makes Main\'s tempo the global tempo only while Global', () => {
    tempo.set({ mode: 'global' });
    expect(isGlobalTempo('fm1', 'tempo')).toBe(true);
    expect(isGlobalTempo('fm1', 'morph')).toBe(false);
    expect(isGlobalTempo('lfo', 'tempo')).toBe(false);
    tempo.set({ mode: 'patch' });
    expect(isGlobalTempo('fm1', 'tempo')).toBe(false);
    tempo.set({ mode: 'global' });
  });
});

describe('the wire (protocol.ts TEMPO / TEMPO_NOW, feature bit 16)', () => {
  it('sends the setting and the tempo, and reads the FM-1\'s', () => {
    const f = parse(tempoFrame(true, 300))!;
    expect(f.cmd).toBe(CMD.tempo);
    expect(f.payload).toEqual([0, 300 & 255, 1]);
    expect(parse(tempoFrame(false, 0))!.payload).toEqual([1, 0, 0]);
    expect(parseTempoNow([0, 124, 0])).toEqual({ global: true, bpm: 124 });
    expect(parseTempoNow([1, 44, 1])).toEqual({ global: false, bpm: 300 });
    expect(parseTempoNow([1, 44])).toBeNull();
  });

  it('INFO byte 9 holds feature bits 16..23; an older firmware\'s INFO has none', () => {
    const now = parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 48, 1]))!)!;
    expect(now.features & FEATURE_TEMPO).toBeTruthy();
    expect(now.patchFormats).toEqual({ min: 31, max: 48 });
    const old = parseInfo(parse(frame(CMD.info, [1, 64, 255, 7, 8, 246, 255, 31, 48]))!)!;
    expect(old.features & FEATURE_TEMPO).toBe(0);
  });
});

describe('the browser engine (engine.c tempo_glo)', () => {
  it('runs its clock at the global tempo whatever the patch says, and the patch\'s own without one', () => {
    const e = new Engine(SR);
    e.load(withTempo(124));
    expect(ticks(e, SR * 10)).toBe(Math.floor(124 * 24 / 6));    // 10 s at 124 bpm, 24 a quarter note
    e.tempoGlobal = 90;
    expect(ticks(e, SR * 10)).toBe(90 * 4);
    e.load(withTempo(150));                                      // another patch: still the global tempo
    expect(ticks(e, SR * 10)).toBe(90 * 4);
    expect(e.parameterValues().find((v) => v.params.tempo !== undefined)?.params.tempo).toBe(90);   // (Main's row shows it)
    e.tempoGlobal = null;
    expect(ticks(e, SR * 10)).toBe(150 * 4);
  });

  it('follows MIDI clock in, over the global tempo (D-452)', () => {
    const e = new Engine(SR);
    e.load(withTempo(120));
    e.tempoGlobal = 90;
    e.clockExternal(true);
    for (let i = 0; i < 10; i++) e.clockTick();
    expect(ticks(e, 128)).toBe(10);
  });

  it('gives MIDI clock out the global tempo', () => {
    const p = withTempo(124);
    expect(clockPeriod(tempoNow({ mode: 'global', bpm: 100 }, p))).toBeCloseTo(60000 / (100 * 24));
    expect(clockPeriod(tempoNow({ mode: 'patch', bpm: 100 }, p))).toBeCloseTo(60000 / (124 * 24));
  });
});
