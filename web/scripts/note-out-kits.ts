// SPDX-License-Identifier: GPL-3.0-only
// The patches of the Note Out host test (D-1353, tools/note_out_test.sh, firmware/test/note_out_test.c). Writes
// build/note-out/NAME.m1p:
//   edges  a square LFO (37 Hz, its edges inside blocks) into a Note Out's gate, nothing in vel, and into the Output's left
//          at level 1, so the test reads each edge's sample from the audio;
//   vel    three Note Outs on one square LFO, vel from an Offset at 0.5, -0.2 and 2 (notes 40, 41, 42; channel 1);
//   held   an Offset at 1 into a Note Out's gate (note 50): one Note On at the first sample, then nothing until it goes off;
//   many   six Note Outs on one square LFO (notes 60..65), and two on note 70 by LFOs at 13 Hz and 17 Hz (one note turned
//          on again while it is on).
// Run from web/: npx vite-node scripts/note-out-kits.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { encodePatch } from '../src/patchbin';
import { addModule, connect, newPatch, type ModuleInst, type Patch } from '../src/patch';

const OUT = new URL('../../build/note-out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

function kit(name: string, build: (p: Patch, add: (type: string, params?: Record<string, number>) => ModuleInst,
  wire: (a: ModuleInst, ap: string, b: ModuleInst, bp: string) => void) => void): void {
  const p = newPatch(DEFS, name);
  const add = (type: string, params: Record<string, number> = {}): ModuleInst => {
    const m = addModule(p, DEFS[type], 0, 0);
    Object.assign(m.params, params);
    return m;
  };
  const wire = (a: ModuleInst, ap: string, b: ModuleInst, bp: string): void =>
    void connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp });
  build(p, add, wire);
  writeFileSync(new URL(`${name}.m1p`, OUT), encodePatch(p, true));
}
const square = (rate: number) => ({ wave: 3, rate, depth: 1 });
const output = (p: Patch): ModuleInst => p.modules.find((m) => m.type === 'output')!;

kit('edges', (p, add, wire) => {
  const lfo = add('lfo', square(37)), nout = add('nout');
  const out = output(p);
  out.params.level = 1;
  wire(lfo, 'out', nout, 'gate');
  wire(lfo, 'out', out, 'l');
});
kit('vel', (_p, add, wire) => {
  const lfo = add('lfo', square(20));
  for (const [note, v] of [[40, 0.5], [41, -0.2], [42, 2]]) {
    const n = add('nout', { channel: 1, note }), c = add('const', { value: v });
    wire(lfo, 'out', n, 'gate');
    wire(c, 'out', n, 'vel');
  }
});
kit('held', (_p, add, wire) => {
  const c = add('const', { value: 1 }), n = add('nout', { note: 50 });
  wire(c, 'out', n, 'gate');
});
kit('many', (_p, add, wire) => {
  const lfo = add('lfo', square(50));
  for (let note = 60; note < 66; note++) wire(lfo, 'out', add('nout', { note }), 'gate');
  for (const rate of [13, 17]) wire(add('lfo', square(rate)), 'out', add('nout', { note: 70 }), 'gate');
});
