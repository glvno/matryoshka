// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildFm1EngineWasm } from '../scripts/fm1-wasm.mjs';
import { Engine } from './engine';
import { Fm1Engine } from './fm1-engine';
import { Fm1Bridge } from './fm1-engine-host';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';
import { ALLOC } from './poly';
import type { HostMsg } from './worklet';

const SR = 48000;
let bytes: Uint8Array<ArrayBuffer>;
let module: WebAssembly.Module;
beforeAll(() => {
  bytes = new Uint8Array(readFileSync(buildFm1EngineWasm(join(tmpdir(), `fm1-engine-${process.pid}.wasm`))));
  module = new WebAssembly.Module(bytes);
}, 120_000);

/** Main's keys into a sine oscillator at `level`, into the output */
function sinePatch(level = 0.8): { patch: Patch; osc: number; out: number } {
  const patch = newPatch(DEFS);
  const main = patch.modules.find((m) => m.type === 'fm1')!;
  const out = patch.modules.find((m) => m.type === 'output')!;
  const osc = addModule(patch, DEFS.osc, 0, 0);
  osc.params.level = level;
  connect(patch, DEFS, { module: main.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
  connect(patch, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
  connect(patch, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'r' });
  return { patch, osc: osc.id, out: out.id };
}

/** n frames from a renderer, in 128-frame blocks */
function frames(render: (l: Float32Array, r: Float32Array) => void, n: number): Float32Array {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let at = 0; at < n; at += 128) render(l.subarray(at, at + 128), r.subarray(at, at + 128));
  return l;
}

/** the pitch by rising zero crossings, and the rms */
function measure(x: Float32Array): { hz: number; rms: number } {
  let first = -1;
  let last = -1;
  let count = 0;
  let sum = 0;
  for (let i = 1; i < x.length; i++) {
    sum += x[i] * x[i];
    if (x[i - 1] < 0 && x[i] >= 0) {
      const at = i - 1 + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = at;
      else count++;
      last = at;
    }
  }
  return { hz: (count * SR) / (last - first), rms: Math.sqrt(sum / x.length) };
}

it('plays the binary the FM-1 would get, at the browser engine’s pitch and level, resampled to the page’s rate', () => {
  const { patch } = sinePatch();
  const fm1 = new Fm1Engine(module, SR);
  expect(fm1.rate).toBe(44118);
  expect(fm1.apply(new Fm1Bridge().load(patch))).toBe(0);
  fm1.hear({ t: 'on', note: 69, vel: 1 });
  const ts = new Engine(SR);
  ts.load(patch);
  ts.noteOn(69, 1);
  const a = measure(frames((l, r) => fm1.render(l, r), SR / 2).subarray(SR / 10));
  const b = measure(frames((l, r) => ts.render(l, r), SR / 2).subarray(SR / 10));
  expect(a.hz).toBeCloseTo(440, 0);
  expect(b.hz).toBeCloseTo(440, 0);
  expect(a.rms).toBeGreaterThan(0.01);
  expect(Math.abs(a.rms / b.rms - 1)).toBeLessThan(0.05);
});

it('takes a parameter edit live, as the device link’s PARAM, and the edits the link resends the patch for as a reload', () => {
  const { patch, out } = sinePatch();
  const bridge = new Fm1Bridge();
  const fm1 = new Fm1Engine(module, SR);
  fm1.apply(bridge.load(patch));
  fm1.hear({ t: 'on', note: 60, vel: 1 });
  expect(measure(frames((l, r) => fm1.render(l, r), 4096)).rms).toBeGreaterThan(0.01);
  const ops = bridge.translate(patch, { t: 'param', id: out, name: 'level', value: 0 });
  expect(ops).toEqual([{ op: 'param', mod: expect.any(Number), par: DEFS.output.params.findIndex((p) => p.name === 'level'), v: 0 }]);
  for (const o of ops as Exclude<typeof ops, 'reload'>) fm1.apply(o);
  const after = frames((l, r) => fm1.render(l, r), 8192);
  expect(measure(after.subarray(4096)).rms).toBeLessThan(1e-4);
  expect(bridge.translate(patch, { t: 'bypass', id: out, on: true })).toEqual([{ op: 'param', mod: expect.any(Number), par: 0xff, v: 1 }]);
  expect(bridge.translate(patch, { t: 'range', id: out, index: 0, name: 'level', range: null })).toBe('reload');
  expect(bridge.translate(patch, { t: 'songs', songs: [] })).toBe('reload');
  // (a Voice allocator's setting: the FM-1 takes the whole patch again; main.ts onParam)
  const alloc = addModule(patch, DEFS[ALLOC], 0, 0);
  fm1.apply(bridge.load(patch));
  expect(bridge.translate(patch, { t: 'param', id: alloc.id, name: DEFS[ALLOC].params[0].name, value: 2 })).toBe('reload');
  // (a module the device form has not got, and messages without a module index: nothing to translate)
  expect(bridge.translate(patch, { t: 'param', id: 9999, name: 'level', value: 0 })).toEqual([]);
  expect(bridge.translate(patch, { t: 'on', note: 60, vel: 1 })).toEqual([]);
});

it('is silent after a binary it cannot load', () => {
  const fm1 = new Fm1Engine(module, SR);
  fm1.apply(new Fm1Bridge().load(sinePatch().patch));
  fm1.hear({ t: 'on', note: 60, vel: 1 });
  expect(fm1.apply({ op: 'load', bin: new Uint8Array([1, 2, 3]) })).not.toBe(0);
  expect(frames((l, r) => fm1.render(l, r), 2048).every((v) => v === 0)).toBe(true);
});

it('bends as a 14-bit MIDI bend reaches the FM-1', () => {
  const fm1 = new Fm1Engine(module, SR);
  fm1.apply(new Fm1Bridge().load(sinePatch().patch));
  fm1.hear({ t: 'on', note: 69, vel: 1 });
  fm1.hear({ t: 'bend', v: 1 });   // (a full bend up: 16383, two semitones less 1/8192 of the range)
  expect(measure(frames((l, r) => fm1.render(l, r), SR / 2).subarray(SR / 10)).hz).toBeCloseTo(440 * 2 ** (2 / 12), -1);
});

// ---- the worklet: the switch between the engines
interface Processor {
  port: { onmessage: (event: { data: HostMsg }) => void; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Processor: new () => Processor;
beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null }; });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: new () => Processor) => { Processor = ctor; });
  await import('./worklet');   // (after the stubs: the worklet registers its processor as it loads)
});
afterAll(() => vi.unstubAllGlobals());

it('plays the browser engine until switched, then the FM-1 engine after a short crossfade, and back', async () => {
  const p = new Processor();
  const send = (data: HostMsg): void => p.port.onmessage({ data });
  /** the rms of the last 4096 frames of `blocks` blocks (the crossfade, 20 ms, is long over) */
  const rms = (blocks = 64): number => {
    const l = new Float32Array(128 * blocks);
    for (let b = 0; b < blocks; b++) p.process([], [[l.subarray(128 * b, 128 * b + 128), new Float32Array(128)]]);
    return measure(l.subarray(l.length - 4096)).rms;
  };
  // the browser engine plays the sine at 0.8, the FM-1 engine (a binary of the same patch at 0.2) a quarter as loud
  send({ t: 'patch', patch: sinePatch(0.8).patch });
  send({ t: 'fm1wasm', bytes: bytes.buffer });
  send({ t: 'fm1', o: new Fm1Bridge().load(sinePatch(0.2).patch) });   // (taken once it compiled)
  await vi.waitFor(() => expect(p.port.postMessage).toHaveBeenCalledWith({ fm1load: 0 }));
  send({ t: 'on', note: 69, vel: 1 });   // (both engines take the note)
  const browser = rms();
  send({ t: 'fm1use', on: true });
  expect(Math.abs(rms() / browser - 0.25)).toBeLessThan(0.01);
  send({ t: 'fm1use', on: false });
  expect(Math.abs(rms() / browser - 1)).toBeLessThan(0.01);
});
