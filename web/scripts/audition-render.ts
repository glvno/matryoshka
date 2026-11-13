// SPDX-License-Identifier: GPL-3.0-only
// Shared fixed-phrase diagnostic renderer for factory and effects auditions.
import { Engine } from '../src/engine';
import { DEVICE_SR } from '../src/modules';
import type { Patch } from '../src/patch';
const sr = DEVICE_SR, seconds = 16, block = 128;

type Event = { at: number; note: number; on: boolean; vel: number } | { at: number; cc: number; value: number };
export function renderAudition(patch: Patch, kind: string, gesture: 'standard' | 'performance' = 'standard'): [Float32Array, Float32Array] {
  const q = structuredClone(patch);
  // Diagnostic output: expose peaks hidden by the engine's final clamp. Scale back exactly afterward.
  q.modules.filter((m) => m.type === 'output').forEach((m) => m.params.level /= 16);
  const engine = new Engine(sr);
  engine.load(q);
  const events: Event[] = [];
  const hit = (at: number, duration: number, note: number, vel = 100 / 127) => {
    events.push({ at, note, vel, on: true }, { at: at + duration, note, vel, on: false });
  };
  if (gesture === 'performance' && kind === 'melodic') {
    hit(0, 4.5, 60);
    for (let i = 0; i <= 28; i++) events.push({ at: 0.5 + i / 8, cc: 1, value: Math.round(127 * Math.sin(Math.PI * i / 28)) });
    [48, 48, 55, 55, 48, 60, 55, 48].forEach((note, i) => hit(6 + i * 0.4, 0.3, note, (i % 3 ? 120 : 90) / 127));
    hit(10, 1.5, 60); hit(10.8, 2, 67); hit(11.6, 2.2, 72);
  } else if (kind === 'drum') engine.transport(true);
  else if (kind === 'drone') {
    const map = q.modules.find((m) => m.type === 'drummap');
    const keys = map ? [...new Set(Array.from({ length: 8 }, (_, i) => map.params[`n${i + 1}`]))] : [53, 55, 57, 59];
    keys.forEach((note, i) => hit(i * 0.2, 10 - i * 0.2, note));
  } else {
    hit(0, 2, 36); hit(3, 2, 60); hit(6, 1, 84, 0.5);
    [48, 55, 60, 63, 67, 70, 67, 63].forEach((note, i) => hit(8 + i * 0.35, 0.25, note, i % 2 ? 0.55 : 1));
    hit(12, 1, 48); hit(12, 1, 55); hit(12, 1, 60);
  }
  events.sort((a, b) => a.at - b.at || Number('on' in a && a.on) - Number('on' in b && b.on));
  const l = new Float32Array(sr * seconds), r = new Float32Array(l.length);
  const bl = new Float32Array(block), br = new Float32Array(block);
  let next = 0;
  for (let offset = 0; offset < l.length; offset += block) {
    while (next < events.length && events[next].at * sr <= offset) {
      const ev = events[next++];
      if ('cc' in ev) engine.cc(ev.cc, ev.value);
      else if (ev.on) engine.noteOn(ev.note, ev.vel); else engine.noteOff(ev.note);
    }
    if (kind === 'drum' && offset >= sr * 13) engine.transport(false);
    engine.render(bl, br);
    for (let i = 0; i < Math.min(block, l.length - offset); i++) { l[offset + i] = bl[i] * 16; r[offset + i] = br[i] * 16; }
  }
  return [l, r];
}

export function auditionWav(ch: Float32Array[], gain = 1): Buffer {
  const b = Buffer.alloc(44 + ch[0].length * 8);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  for (let i = 0; i < ch[0].length; i++) { b.writeFloatLE(ch[0][i] * gain, 44 + i * 8); b.writeFloatLE(ch[1][i] * gain, 48 + i * 8); }
  return b;
}
