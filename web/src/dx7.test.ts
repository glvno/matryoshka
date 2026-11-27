// SPDX-License-Identifier: GPL-3.0-only
// The DX7 voice in TypeScript (dx7.ts) against the C (firmware/src/dx7.h): the tables it works out, and firmware/test/
// dx7_test.c's corpus rendered here must give the hashes in firmware/test/dx7_hashes.h (tools/dx7_test.sh checks the C
// against the same file), so the two engines agree sample for sample.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DSP_TABLES, DX7_UNPACKED, DX7_VOICE, dx7New, dx7Pack, dx7Rate, dx7Run, dx7Unpack, type Dx7Io } from './dx7';

const root = resolve(__dirname, '../..');
const header = (file: string): string => readFileSync(resolve(root, file), 'utf8');
/** a C array's numbers */
const array = (src: string, name: string): number[] =>
  src.slice(src.indexOf(`${name}[`)).split('{')[1].split('}')[0].split(',').map((x) => x.trim()).filter(Boolean).map((x) => Number(x.replace(/u$/, '')));
const define = (src: string, name: string): number => Number(new RegExp(`#define ${name} (\\d+)`).exec(src)![1]);

// ------------------------------------------------------------------ dx7_test.c's corpus, step for step

let rs = 0;
function R(n: number): number {
  rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
  return (rs >>> 8) % (n + 1);
}

function randomVoice(u: Uint8Array, alg: number): void {
  const top = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
  for (let op = 0; op < 6; op++) for (let i = 0; i < 21; i++) u[op * 21 + i] = R(top[i]);
  for (let op = 0; op < 6; op++) {
    const q = op * 21;
    for (let i = 0; i < 4; i++) u[q + i] = 30 + R(69);
    for (let i = 4; i < 7; i++) u[q + i] = 60 + R(39);
    u[q + 7] = R(3) ? 0 : R(99);
    u[q + 9] = R(40);
    u[q + 10] = R(40);
    u[q + 15] = R(3);
    u[q + 16] = 75 + R(24);
    if (R(4)) u[q + 17] = 0;
    u[q + 18] = R(op < 2 ? 3 : 8);
  }
  for (let i = 126; i < 134; i++) u[i] = R(99);
  for (let i = 130; i < 134; i++) u[i] = 40 + R(20);
  u[134] = alg < 0 ? R(31) : alg;
  u[135] = R(7);
  u[136] = R(1);
  for (let i = 137; i < 141; i++) u[i] = R(99);
  u[141] = R(1);
  u[142] = R(5);
  u[143] = R(7);
  u[144] = 12 + R(24);
  for (let i = 145; i < 155; i++) u[i] = 65 + R(25);
  u[155] = 0x3f;
}

function initVoice(): Uint8Array {
  const b = new Uint8Array(DX7_VOICE);
  for (let op = 0; op < 6; op++) {
    const d = op * 17;
    for (let i = 0; i < 7; i++) b[d + i] = 99;
    b[d + 8] = 39;
    b[d + 14] = op === 5 ? 99 : 0;
    b[d + 15] = 1 << 1;
    b[d + 12] = 7 << 3;
  }
  for (let i = 102; i < 106; i++) b[i] = 99;
  for (let i = 106; i < 110; i++) b[i] = 50;
  b[111] = 1 << 3;
  b[112] = 35;
  b[116] = (3 << 4) | 1;
  b[117] = 24;
  b.set([...'INIT VOICE'].map((c) => c.charCodeAt(0)), 118);
  return b;
}

const CASES = 48, LEN = 26470;
const extSig = (kind: number, g: number): number => (kind ? ((g >>> 5) & 1 ? 40000 : -40000) : ((g * 1500) & 0x1ffff) - 65536);

function corpusCase(c: number): { hash: number; peak: number } {
  rs = (0x9e3779b9 ^ Math.imul(c, 7919)) >>> 0;
  let pk: Uint8Array;
  if (c === 0) pk = initVoice();
  else {
    const u = new Uint8Array(DX7_UNPACKED);
    randomVoice(u, c % 32);
    pk = dx7Pack(u);
  }
  const s = dx7New(44118, pk);
  const gate = new Int32Array(128), pitch = new Int32Array(128), vel = new Int32Array(128), out = new Int32Array(128);
  const xs = Array.from({ length: 6 }, () => new Int32Array(128));
  const io: Dx7Io = { pitch, gate, vel: c % 5 === 4 ? null : vel, x: [null, null, null, null, null, null], level: 0, tune: 0, mod: 0, range: 0, dest: 0, ops: 0, t: 0 };
  io.level = 32768 + R(32768);
  io.tune = (R(200) - 100) * 65536;
  io.mod = R(65536);
  io.range = R(99) * 65536;
  io.dest = R(6) * 65536;
  io.ops = (R(3) === 0 ? R(63) | 1 : 63) * 65536;
  const xk = Array.from({ length: 6 }, () => (c >= 32 && R(3) === 0 ? R(1) : -1));
  const on = R(500), off = on + 8000 + R(4000), re = off + 3000 + R(2000);
  const p0 = Math.trunc(((R(48) - 24) * 65536) / 12), vl = R(65536);
  let h = 2166136261, peak = 0, t = 0;
  while (t < LEN) {
    let n = c & 1 ? 1 + R(127) : 128;
    if (t + n > LEN) n = LEN - t;
    for (let i = 0; i < n; i++) {
      const g = t + i;
      gate[i] = (g >= on && g < off) || g >= re ? 65536 : 0;
      pitch[i] = p0 + (g >= on + 3000 ? Math.trunc((2 * 65536) / 12) : 0) + (g >= re ? Math.trunc((7 * 65536) / 12) : 0);
      vel[i] = g >= re ? 65536 - vl : vl;
      for (let j = 0; j < 6; j++) xs[j][i] = xk[j] >= 0 ? extSig(xk[j], g) : 0;
    }
    for (let j = 0; j < 6; j++) io.x[j] = xk[j] >= 0 ? xs[j] : null;
    io.t = t;
    dx7Run(s, io, out, n);
    for (let i = 0; i < n; i++) {
      h = Math.imul((h ^ out[i]) >>> 0, 16777619) >>> 0;
      if (out[i] > peak) peak = out[i];
    }
    t += n;
  }
  return { hash: h, peak };
}

// ------------------------------------------------------------------ the checks

describe('the DX7 voice in TypeScript is the C', () => {
  it('works out the firmware tables and dx7_tables.h at 44,118 Hz', () => {
    const dsp = header('firmware/src/dsp_tables.h'), dx7 = header('firmware/src/dx7_tables.h'), r = dx7Rate(44118);
    expect(Array.from(DSP_TABLES.SIN_T)).toEqual(array(dsp, 'SIN_T'));
    expect(Array.from(DSP_TABLES.EXP2_T)).toEqual(array(dsp, 'EXP2_T'));
    expect(r.lfoDelta).toEqual(array(dx7, 'DX7_LFO_DELTA'));
    expect(r.fine).toEqual(array(dx7, 'DX7_FINE'));
    expect([r.lfoUnit, r.penvUnit, r.envSrMul, r.freqC]).toEqual(
      ['DX7_LFO_UNIT', 'DX7_PITCHENV_UNIT', 'DX7_ENV_SRMUL', 'DX7_FREQ_C'].map((d) => define(dx7, d)),
    );
  });

  it('unpacks what the DX7 packs', () => {
    for (let t = 0; t < 200; t++) {
      rs = 5000 + t;
      const u = new Uint8Array(DX7_UNPACKED);
      randomVoice(u, -1);
      expect(Array.from(dx7Unpack(dx7Pack(u)))).toEqual(Array.from(u));
    }
  });

  it("renders dx7_test.c's corpus to dx7_hashes.h, sample for sample", () => {
    const want = header('firmware/test/dx7_hashes.h').split('{')[1].split('}')[0].split(',').map((x) => Number(x.trim().replace(/u$/, '')));
    expect(want.length).toBe(CASES);
    const got = Array.from({ length: CASES }, (_, c) => corpusCase(c));
    expect(got.map((g) => g.hash.toString(16))).toEqual(want.map((w) => w.toString(16)));
    for (const g of got) expect(g.peak).toBeGreaterThan(300);
  });
});
