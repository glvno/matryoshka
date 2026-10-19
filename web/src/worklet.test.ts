// SPDX-License-Identifier: GPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import { withParts } from './test-poly';
import { polyGroups } from './poly';
import type { HostMsg } from './worklet';
import { subtractiveSaw } from './test-patches';

interface ViewMessage { view: string; chans: { raw: Float32Array }[]; sr: number }
interface Processor {
  port: { onmessage: (event: { data: HostMsg }) => void; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Processor: new () => Processor;
beforeAll(async () => {
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null }; });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: new () => Processor) => { Processor = ctor; });
  await import('./worklet');
});
afterAll(() => vi.unstubAllGlobals());

function send(processor: Processor, data: HostMsg): void { processor.port.onmessage({ data }); }
function render(processor: Processor, blocks = 12) {
  const channels = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < blocks; i++) expect(processor.process([], [channels])).toBe(true);
  return channels;
}
function views(processor: Processor): ViewMessage[] {
  return processor.port.postMessage.mock.calls.map(([message]) => message).filter(message => typeof message.view === 'string');
}
function stereoPatch(): Patch {
  const patch = emptyPatch();
  const left = addModule(patch, DEFS.const, 0, 0);
  const right = addModule(patch, DEFS.const, 0, 0);
  const extra = addModule(patch, DEFS.const, 0, 0);
  const output = addModule(patch, DEFS.output, 0, 0);
  left.params.value = .5; right.params.value = -.75; extra.params.value = .25;
  output.params.level = .5;
  connect(patch, DEFS, { module: left.id, port: 'out' }, { module: output.id, port: 'l' });
  connect(patch, DEFS, { module: extra.id, port: 'out' }, { module: output.id, port: 'l' });
  connect(patch, DEFS, { module: right.id, port: 'out' }, { module: output.id, port: 'r' });
  return patch;
}

it('streams nothing until a Scope view is set, then follows that output through every factory preset and a polyphonic load', () => {
  const processor = new Processor();
  const poly = withParts(subtractiveSaw(), 4);
  for (const [index, patch] of [...Object.values(PRESETS).map(make => make()), poly].entries()) {
    processor.port.postMessage.mockClear();
    send(processor, { t: 'patch', patch, revision: index + 1 });
    send(processor, { t: 'on', note: 60, vel: .8 });
    send(processor, { t: 'on', note: 67, vel: .8 });
    render(processor);
    expect(views(processor), `${patch.name}: a trace without a view`).toEqual([]);
    const m = patch.modules.find(m => DEFS[m.type].outputs.some(o => o.kind === 'audio'))!;
    const port = DEFS[m.type].outputs.find(o => o.kind === 'audio')!.name;
    send(processor, { t: 'view', key: 'x', chans: [[{ id: m.id, port }]], samples: 256 });
    render(processor);
    const messages = views(processor);
    expect(messages.map(v => v.view), patch.name).toEqual(['x']);
    expect(messages[0].chans[0].raw.every(Number.isFinite)).toBe(true);
    send(processor, { t: 'unview', key: 'x' });
    expect(processor.port.postMessage.mock.calls.some(([m]) => m.error), patch.name).toBe(false);
  }
});

it('a Scope view reads its outputs without cancellation and a new patch does not retain its samples', () => {
  const processor = new Processor();
  const patch = stereoPatch();
  const [left, right] = patch.modules;
  send(processor, { t: 'patch', patch, revision: 1 });
  send(processor, { t: 'view', key: 'v', chans: [[{ id: left.id, port: 'out' }], [{ id: right.id, port: 'out' }]], samples: 256 });
  render(processor, 36);
  const [a, b] = views(processor).at(-1)!.chans;
  expect(a.raw.every(value => value === .5)).toBe(true);
  expect(b.raw.every(value => value === -.75)).toBe(true);
  processor.port.postMessage.mockClear();
  send(processor, { t: 'patch', patch: emptyPatch(), revision: 2 });
  render(processor);
  for (const message of views(processor)) for (const c of message.chans) expect(c.raw.every(value => value === 0)).toBe(true);
});

it('per-voice Scope inputs (#54): one ring per voice, summing to the trace', () => {
  const processor = new Processor();
  const patch = withParts(subtractiveSaw(), 4);
  const group = polyGroups(patch)[0].modules;
  const m = patch.modules.find(m => group.has(m.id) && DEFS[m.type].outputs.some(o => o.kind === 'audio'))!;
  const port = DEFS[m.type].outputs.find(o => o.kind === 'audio')!.name;
  send(processor, { t: 'patch', patch, revision: 1 });
  for (const note of [60, 64, 67]) send(processor, { t: 'on', note, vel: .8 });
  send(processor, { t: 'view', key: 'scope', chans: [[{ id: m.id, port }], [{ id: m.id, port }, { id: m.id, port }]], samples: 256, voices: true });
  render(processor, 36);
  const calls = processor.port.postMessage.mock.calls.map(([message]) => message);
  // the Scope: input a per voice, input b (the same output cabled twice) per voice doubled
  const view = calls.filter(c => c.view === 'scope').at(-1) as { chans: { raw: Float32Array }[]; voices: { raw: Float32Array }[][] };
  expect(view.voices).toHaveLength(2);
  const [a, b] = view.voices;
  expect(a).toHaveLength(4);
  expect(a.filter(v => v.raw.some(x => x !== 0)).length).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < view.chans[0].raw.length; i += 13) {
    expect(a.reduce((s, v) => s + v.raw[i], 0)).toBeCloseTo(view.chans[0].raw[i], 5);
    for (let k = 0; k < 4; k++) expect(b[k].raw[i]).toBeCloseTo(2 * a[k].raw[i], 5);
  }
});
