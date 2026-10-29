// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';

function xor(a: number, b: number, twice = false): number {
  const p = emptyPatch();
  const left = addModule(p, DEFS.const, 0, 0), right = addModule(p, DEFS.const, 0, 0);
  left.params.value = a;
  right.params.value = b;
  const op = addModule(p, DEFS.math, 0, 0), out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  const wire = (from: number, port: string, to: number, input: string): void => {
    expect(connect(p, DEFS, { module: from, port }, { module: to, port: input })).toBe(true);
  };
  wire(left.id, 'out', op.id, 'a');
  wire(right.id, 'out', op.id, 'b');
  let result = op;
  if (twice) {
    result = addModule(p, DEFS.math, 0, 0);
    wire(op.id, 'xor', result.id, 'a');
    wire(right.id, 'out', result.id, 'b');
  }
  wire(result.id, 'xor', out.id, 'l');
  const e = new Engine(44118);
  e.load(p);
  const l = new Float32Array(128);
  e.render(l, new Float32Array(128));
  return l[127];
}

it.each([[0, 0, 0], [.5, .25, .75], [-.5, .5, -1], [1, 1, 0], [-2, 0, -1], [2, 0, 32767 / 32768]])(
  'XOR of %f and %f is %f in signed 16-bit audio', (a, b, expected) => expect(xor(a, b)).toBe(expected),
);

it('flipping the same bits twice restores the quantized input', () => {
  expect(xor(.123456, .75, true)).toBe(Math.floor(.123456 * 32768) / 32768);
});

it('Elvira 2 XL routes all four BITMANGLER programs through audio XOR', async () => {
  const { XL_PRESETS } = await import('./presets');
  const p = XL_PRESETS['Elvira 2 XL']();
  const voices = p.assemblies!.filter((a) => /^voice [1-4]$/.test(a.name));
  expect(voices).toHaveLength(4);
  for (const voice of voices) for (const row of voice.params) {
    if (row.label === 'modp' || row.label === 'mod')
      p.modules.find((m) => m.id === row.module)!.params[row.param] = row.label === 'modp' ? .7 : .625;
  }
  const paths = p.cables.filter((c) => c.from.port === 'xor');
  expect(paths).toHaveLength(4);
  const e = new Engine(44118);
  e.load(p);
  for (const c of paths) e.probe(c.to.module, 'out');
  e.render(new Float32Array(1024), new Float32Array(1024));
  for (const c of paths) {
    const source = p.cables.find((w) => w.to.module === c.from.module && w.to.port === 'a')!.from;
    const samples = e.probe(source.module, source.port)!;
    const flipped = e.probe(c.from.module, 'xor')!;
    expect([...flipped]).toEqual([...samples].map((v) => (Math.max(-32768, Math.min(32767, Math.floor(v * 32768))) ^ 20480) / 32768));
    expect(e.probe(c.to.module, 'out')).toEqual(flipped);
    expect(flipped.some((v, i) => Math.abs(v - samples[i]) > .01)).toBe(true);
  }
});
