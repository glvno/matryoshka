// SPDX-License-Identifier: Apache-2.0
/*
 * Copyright 2012 Google Inc.
 * Copyright 2016-2025 Pascal Gauthier.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// The DX7 module's voice (#1338): firmware/src/dx7.h (msfa, the synthesis core of Dexed, ported to C) in TypeScript, line
// for line and sample for sample. dx7.test.ts renders dx7_test.c's corpus and checks firmware/test/dx7_hashes.h. Keep the
// two in step: every integer step here is the C's (int32 wraps with | 0, (int64) a * b >> s with mulShr or Math.floor
// where the product stays below 2^53). The rate-dependent numbers come from the engine's rate with
// tools/gen_dx7_tables.py's formulas (at 44,118 Hz: dx7_tables.h). Changes from msfa are marked "FM-1:" in dx7.h.

export const DX7_N = 64;
export const DX7_VOICE = 128;
export const DX7_UNPACKED = 156;
const VEL_NONE = 100;

// ------------------------------------------------------------------ tables

/** firmware/src/dsp_tables.h SIN_T (sin in Q30) and EXP2_T (2^(i/256) in Q28), as tools/gen_dsp_tables.py makes them */
const SIN_T = Int32Array.from({ length: 1025 }, (_, i) => Math.round(Math.sin((2 * Math.PI * i) / 1024) * 2 ** 30));
const EXP2_T = Float64Array.from({ length: 257 }, (_, i) => Math.round(2 ** (i / 256) * 2 ** 28));
export const DSP_TABLES = { SIN_T, EXP2_T };

const ALG = [
  [0xc1, 0x11, 0x11, 0x14, 0x01, 0x14], [0x01, 0x11, 0x11, 0x14, 0xc1, 0x14], [0xc1, 0x11, 0x14, 0x01, 0x11, 0x14],
  [0xc1, 0x11, 0x94, 0x01, 0x11, 0x14], [0xc1, 0x14, 0x01, 0x14, 0x01, 0x14], [0xc1, 0x94, 0x01, 0x14, 0x01, 0x14],
  [0xc1, 0x11, 0x05, 0x14, 0x01, 0x14], [0x01, 0x11, 0xc5, 0x14, 0x01, 0x14], [0x01, 0x11, 0x05, 0x14, 0xc1, 0x14],
  [0x01, 0x05, 0x14, 0xc1, 0x11, 0x14], [0xc1, 0x05, 0x14, 0x01, 0x11, 0x14], [0x01, 0x05, 0x05, 0x14, 0xc1, 0x14],
  [0xc1, 0x05, 0x05, 0x14, 0x01, 0x14], [0xc1, 0x05, 0x11, 0x14, 0x01, 0x14], [0x01, 0x05, 0x11, 0x14, 0xc1, 0x14],
  [0xc1, 0x11, 0x02, 0x25, 0x05, 0x14], [0x01, 0x11, 0x02, 0x25, 0xc5, 0x14], [0x01, 0x11, 0x11, 0xc5, 0x05, 0x14],
  [0xc1, 0x14, 0x14, 0x01, 0x11, 0x14], [0x01, 0x05, 0x14, 0xc1, 0x14, 0x14], [0x01, 0x14, 0x14, 0xc1, 0x14, 0x14],
  [0xc1, 0x14, 0x14, 0x14, 0x01, 0x14], [0xc1, 0x14, 0x14, 0x01, 0x14, 0x04], [0xc1, 0x14, 0x14, 0x14, 0x04, 0x04],
  [0xc1, 0x14, 0x14, 0x04, 0x04, 0x04], [0xc1, 0x05, 0x14, 0x01, 0x14, 0x04], [0x01, 0x05, 0x14, 0xc1, 0x14, 0x04],
  [0x04, 0xc1, 0x11, 0x14, 0x01, 0x14], [0xc1, 0x14, 0x01, 0x14, 0x04, 0x04], [0x04, 0xc1, 0x11, 0x14, 0x04, 0x04],
  [0xc1, 0x14, 0x04, 0x04, 0x04, 0x04], [0xc4, 0x04, 0x04, 0x04, 0x04, 0x04],
];
/** the algorithm table (operator 6 first): bits 0-1 the output bus (0 the voice), 2 add, 4-5 the input bus, 6-7 feedback */
export const DX7_ALG: readonly (readonly number[])[] = ALG;
const OUT_ADD = 4;

const COARSE = [
  -16777216, 0, 16777216, 26591258, 33554432, 38955489, 43368474, 47099600, 50331648, 53182516, 55732705, 58039632,
  60145690, 62083076, 63876816, 65546747, 67108864, 68576247, 69959732, 71268397, 72509921, 73690858, 74816848, 75892776,
  76922906, 77910978, 78860292, 79773775, 80654032, 81503396, 82323963, 83117622,
];
const VELOCITY = [
  0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163, 166, 170, 173, 174, 178, 181, 184, 186, 189,
  190, 194, 196, 198, 200, 202, 205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232, 233, 235, 237,
  238, 240, 241, 242, 243, 244, 246, 246, 248, 249, 250, 251, 252, 253, 254,
];
const EXP_SCALE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 16, 19, 23, 27, 33, 39, 47, 56, 66, 80, 94, 110, 126, 142, 158, 174, 190, 206, 222,
  238, 250,
];
const PMS = [0, 10, 20, 33, 55, 92, 153, 255];
const AMS = [0, 4342338, 7171437, 16777216];
const LEVELLUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];
const STATICS = [
  1764000, 1764000, 1411200, 1411200, 1190700, 1014300, 992250, 882000, 705600, 705600, 584325, 507150, 502740, 441000,
  418950, 352800, 308700, 286650, 253575, 220500, 220500, 176400, 145530, 145530, 125685, 110250, 110250, 88200, 88200,
  74970, 61740, 61740, 55125, 48510, 44100, 37485, 31311, 30870, 27562, 27562, 22050, 18522, 17640, 15435, 14112, 13230,
  11025, 9261, 9261, 7717, 6615, 6615, 5512, 5512, 4410, 3969, 3969, 3439, 2866, 2690, 2249, 1984, 1896, 1808, 1411, 1367,
  1234, 1146, 926, 837, 837, 705, 573, 573, 529, 441, 441,
];
const PENV_RATE = [
  1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 33, 34, 36, 37, 38, 39, 41, 42, 44, 46, 47, 49, 51, 53, 54, 56, 58, 60, 62, 64,
  66, 68, 70, 72, 74, 76, 79, 82, 85, 88, 91, 94, 98, 102, 106, 110, 115, 120, 125, 130, 135, 141, 147, 153, 159, 165,
  171, 178, 185, 193, 202, 211, 232, 243, 254, 255,
];
const PENV_TAB = [
  -128, -116, -104, -95, -85, -76, -68, -61, -56, -52, -49, -46, -43, -41, -39, -37, -35, -33, -32, -31, -30, -29, -28,
  -27, -26, -25, -24, -23, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3,
  -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 38, 40, 43, 46, 49, 53, 58, 65, 73, 82, 92, 103, 115, 127,
];
const LFO_SOURCE = [
  0.062541, 0.125031, 0.312393, 0.43712, 0.62461, 0.750694, 0.93633, 1.125302, 1.249609, 1.436782, 1.560915, 1.752081,
  1.875117, 2.062494, 2.247191, 2.374451, 2.560492, 2.686728, 2.873976, 2.99895, 3.188013, 3.36984, 3.500175, 3.682224,
  3.812065, 4.0008, 4.186202, 4.310716, 4.50126, 4.623209, 4.814636, 4.93048, 5.121901, 5.315191, 5.434783, 5.617346,
  5.750431, 5.946717, 6.062811, 6.248438, 6.431695, 6.564264, 6.74946, 6.868132, 7.052186, 7.25058, 7.375719, 7.556294,
  7.687577, 7.877738, 7.993605, 8.181967, 8.372405, 8.504848, 8.685079, 8.810573, 8.986341, 9.122423, 9.300595, 9.500285,
  9.607994, 9.798158, 9.950249, 10.117361, 11.251125, 11.384335, 12.562814, 13.676149, 13.904338, 15.092062, 16.366612,
  16.638935, 17.869907, 19.193858, 19.425019, 20.833333, 21.034918, 22.50225, 24.003841, 24.260068, 25.746653, 27.173913,
  27.578599, 29.052876, 30.693677, 31.191516, 32.658393, 34.31709, 34.674064, 36.416606, 38.197097, 38.550501, 40.387722,
  40.749796, 42.625746, 44.326241, 44.883303, 46.772685, 48.590865, 49.261084,
];
/** osc_freq's fine term (not rate dependent): (1 << 24) / ln 2 * ln(1 + fine / 100) */
const FINE = Array.from({ length: 100 }, (_, f) => Math.floor(24204406.323123 * Math.log(1 + 0.01 * f) + 0.5));

/** msfa's start-up numbers for a sample rate (tools/gen_dx7_tables.py) */
export interface Dx7Rate { lfoUnit: number; penvUnit: number; envSrMul: number; freqC: number; lfoDelta: number[]; fine: number[] }
const rates = new Map<number, Dx7Rate>();
export function dx7Rate(sr: number): Dx7Rate {
  let r = rates.get(sr);
  if (!r) {
    const lforatio = Math.trunc((4437500000.0 * DX7_N) / sr) >>> 0;
    r = {
      lfoUnit: Math.trunc((DX7_N * 25190424) / sr + 0.5),
      penvUnit: Math.trunc((DX7_N * 2 ** 24) / (21.3 * sr) + 0.5),
      envSrMul: Math.trunc((44100.0 / sr) * 2 ** 24),
      freqC: Math.round(2 ** 44 / sr),
      lfoDelta: LFO_SOURCE.map((x) => Math.trunc(x * lforatio) >>> 0),
      fine: FINE,
    };
    rates.set(sr, r);
  }
  return r;
}

// ------------------------------------------------------------------ integer helpers

/** (int64) a * b >> s for |a|, |b| < 2^32 and s >= 16, exact (the product may pass 2^53) */
function mulShr(a: number, b: number, s: number): number {
  const bh = Math.floor(b / 65536), bl = b - bh * 65536;
  return Math.floor((a * bh + Math.floor((a * bl) / 65536)) / 2 ** (s - 16));
}
const min = (a: number, b: number): number => (a < b ? a : b);
const max = (a: number, b: number): number => (a > b ? a : b);

function sin(phase: number): number {
  const low = phase & 16383, i = (phase >> 14) & 1023, y0 = SIN_T[i];
  const y = y0 + Math.floor(((SIN_T[i + 1] - y0) * low) / 16384);
  return (y + 32) >> 6;
}

function exp2(x: number): number {
  const i = (x >>> 16) & 255, r = x & 0xffff;
  const m = EXP2_T[i] + Math.floor(((EXP2_T[i + 1] - EXP2_T[i]) * r) / 65536);
  const sh = 4 - (x >> 24);
  return sh >= 0 ? (sh > 31 ? 0 : m >> sh) : m << -sh;
}

function freq(R: Dx7Rate, lf: number): number {
  const i = (lf >>> 16) & 255, r = lf & 0xffff;
  const m = EXP2_T[i] + Math.floor(((EXP2_T[i + 1] - EXP2_T[i]) * r) / 65536);
  const mh = Math.floor(m / 16384), ml = m - mh * 16384;
  const y = Math.floor((mh * R.freqC + Math.floor((ml * R.freqC + 2 ** 27) / 16384)) / 16384);
  const sh = 20 - (lf >> 24);
  return sh > 31 ? 0 : sh < 0 ? 0x7fffffff : y >> sh;
}

// ------------------------------------------------------------------ envelope

interface Env { level: number; target: number; inc: number; statics: number; outlevel: number; rates: number[]; levels: number[]; scaling: number; ix: number; rising: boolean; down: boolean; init: boolean }
const newEnv = (): Env => ({ level: 0, target: 0, inc: 0, statics: 0, outlevel: 0, rates: [0, 0, 0, 0], levels: [0, 0, 0, 0], scaling: 0, ix: 0, rising: false, down: false, init: false });

const scaleout = (o: number): number => (o >= 20 ? 28 + o : LEVELLUT[o]);

function envAdvance(R: Dx7Rate, e: Env, ix: number): void {
  e.ix = ix;
  if (ix >= 4) return;
  const newlevel = e.levels[ix];
  let actual = scaleout(newlevel) >> 1;
  actual = (actual << 6) + e.outlevel - 4256;
  actual = actual < 16 ? 16 : actual;
  e.target = actual << 16;
  e.rising = e.target > e.level;
  const qrate = min(((e.rates[ix] * 41) >> 6) + e.scaling, 63);
  if (e.target === e.level || (ix === 0 && newlevel === 0)) {
    const sr = min(e.rates[ix] + e.scaling, 99);
    let sc = sr < 77 ? STATICS[sr] : 20 * (99 - sr);
    if (sr < 77 && ix === 0 && newlevel === 0) sc = Math.trunc(sc / 20);
    e.statics = Math.floor((sc * R.envSrMul) / 2 ** 24);
  } else e.statics = 0;
  const inc = (4 + (qrate & 3)) << (2 + 6 + (qrate >> 2));
  e.inc = Math.floor((inc * R.envSrMul) / 2 ** 24);
}

function envInit(R: Dx7Rate, e: Env, v: Uint8Array, at: number, outlevel: number, scaling: number): void {
  e.init = true;
  for (let i = 0; i < 4; i++) (e.rates[i] = v[at + i]), (e.levels[i] = v[at + 4 + i]);
  e.outlevel = outlevel;
  e.scaling = scaling;
  e.level = 0;
  e.down = true;
  envAdvance(R, e, 0);
}

function envUpdate(R: Dx7Rate, e: Env, v: Uint8Array, at: number, outlevel: number, scaling: number): void {
  for (let i = 0; i < 4; i++) (e.rates[i] = v[at + i]), (e.levels[i] = v[at + 4 + i]);
  e.outlevel = outlevel;
  e.scaling = scaling;
  if (e.down) {
    let actual = scaleout(e.levels[2]) >> 1;
    actual = (actual << 6) - 4256;
    actual = actual < 16 ? 16 : actual;
    e.target = actual << 16;
    envAdvance(R, e, 2);
  }
}

function envSample(R: Dx7Rate, e: Env): number {
  if (e.statics) {
    e.statics -= DX7_N;
    if (e.statics <= 0) {
      e.statics = 0;
      envAdvance(R, e, e.ix + 1);
    }
  }
  if (e.ix < 3 || (e.ix < 4 && !e.down)) {
    if (e.statics) {
      // (waiting)
    } else if (e.rising) {
      const jump = 1716 << 16;
      if (e.level < jump) e.level = jump;
      e.level += (((17 << 24) - e.level) >> 24) * e.inc;
      if (e.level >= e.target) {
        e.level = e.target;
        envAdvance(R, e, e.ix + 1);
      }
    } else {
      e.level -= e.inc;
      if (e.level <= e.target) {
        e.level = e.target;
        envAdvance(R, e, e.ix + 1);
      }
    }
  }
  return e.level;
}

function envKeydown(R: Dx7Rate, e: Env, d: boolean): void {
  if (e.down !== d) {
    e.down = d;
    envAdvance(R, e, d ? 0 : 3);
  }
}

// ------------------------------------------------------------------ pitch envelope

interface PEnv { level: number; target: number; inc: number; rates: number[]; levels: number[]; ix: number; rising: boolean; down: boolean }

function penvAdvance(R: Dx7Rate, p: PEnv, ix: number): void {
  p.ix = ix;
  if (ix < 4) {
    p.target = PENV_TAB[p.levels[ix]] * (1 << 19);
    p.rising = p.target > p.level;
    p.inc = PENV_RATE[p.rates[ix]] * R.penvUnit;
  }
}

function penvSet(R: Dx7Rate, p: PEnv, v: Uint8Array, at: number): void {
  for (let i = 0; i < 4; i++) (p.rates[i] = v[at + i]), (p.levels[i] = v[at + 4 + i]);
  p.level = PENV_TAB[v[at + 7]] * (1 << 19);
  p.down = true;
  penvAdvance(R, p, 0);
}

function penvSample(R: Dx7Rate, p: PEnv): number {
  if (p.ix < 3 || (p.ix < 4 && !p.down)) {
    if (p.rising) {
      p.level += p.inc;
      if (p.level >= p.target) {
        p.level = p.target;
        penvAdvance(R, p, p.ix + 1);
      }
    } else {
      p.level -= p.inc;
      if (p.level <= p.target) {
        p.level = p.target;
        penvAdvance(R, p, p.ix + 1);
      }
    }
  }
  return p.level;
}

function penvKeydown(R: Dx7Rate, p: PEnv, d: boolean): void {
  if (p.down !== d) {
    p.down = d;
    penvAdvance(R, p, d ? 0 : 3);
  }
}

// ------------------------------------------------------------------ LFO

interface Lfo { phase: number; delta: number; delaystate: number; delayinc: number; delayinc2: number; wave: number; rand: number; sync: boolean }

function lfoReset(R: Dx7Rate, l: Lfo, v: Uint8Array, at: number): void {
  let a = 99 - v[at + 1];
  l.delta = R.lfoDelta[v[at]];
  if (a === 99) {
    l.delayinc = 0xffffffff;
    l.delayinc2 = 0xffffffff;
  } else {
    a = (16 + (a & 15)) << (1 + (a >> 4));
    l.delayinc = Math.imul(R.lfoUnit, a) >>> 0;
    a &= 0xff80;
    a = max(0x80, a);
    l.delayinc2 = Math.imul(R.lfoUnit, a) >>> 0;
  }
  l.wave = v[at + 5];
  l.sync = v[at + 4] !== 0;
}

function lfoSample(l: Lfo): number {
  l.phase = (l.phase + l.delta) >>> 0;
  const ph = l.phase;
  switch (l.wave) {
    case 0: return ((ph >>> 7) ^ -(ph >>> 31)) & 0xffffff;
    case 1: return (~ph ^ 0x80000000) >>> 8;
    case 2: return (ph ^ 0x80000000) >>> 8;
    case 3: return (~ph >>> 7) & (1 << 24);
    case 4: return (1 << 23) + (sin(ph >>> 8) >> 1);
    case 5:
      if (ph < l.delta) l.rand = (l.rand * 179 + 17) & 0xff;
      return ((l.rand ^ 0x80) + 1) << 16;
  }
  return 1 << 23;
}

function lfoDelay(l: Lfo): number {
  const delta = l.delaystate < 0x80000000 ? l.delayinc : l.delayinc2;
  const d = l.delaystate + delta;
  if (d > 0xffffffff) return 1 << 24;
  l.delaystate = d;
  return d < 0x80000000 ? 0 : (d >>> 7) & 0xffffff;
}

function lfoKeydown(l: Lfo, phase: number): void {
  l.phase = l.sync ? 0x7fffffff : phase >>> 0;
  l.delaystate = 0;
}

// ------------------------------------------------------------------ operators and the algorithm

interface Op { levelIn: number; gainOut: number; freq: number; phase: number }

const LEVEL_THRESH = 1120;

function extAt(x: Int32Array, at: number, xn: number, i: number): number {
  let s = x[at + (i < xn ? i : xn - 1)];
  s = s > 131072 ? 131072 : s < -131072 ? -131072 : s;
  return s * 256;
}

function kMod(o: Int32Array, oat: number, inp: Int32Array, iat: number, ph: number, f: number, g1: number, g2: number, add: boolean): void {
  const dg = (g2 - g1 + 32) >> 6;
  let g = g1;
  for (let i = 0; i < DX7_N; i++) {
    g += dg;
    const y = Math.floor((sin((ph + inp[iat + i]) | 0) * g) / 16777216);
    o[oat + i] = add ? o[oat + i] + y : y;
    ph = (ph + f) | 0;
  }
}

function kPure(o: Int32Array, oat: number, ph: number, f: number, g1: number, g2: number, add: boolean): void {
  const dg = (g2 - g1 + 32) >> 6;
  let g = g1;
  for (let i = 0; i < DX7_N; i++) {
    g += dg;
    const y = Math.floor((sin(ph) * g) / 16777216);
    o[oat + i] = add ? o[oat + i] + y : y;
    ph = (ph + f) | 0;
  }
}

function kFb(o: Int32Array, oat: number, ph: number, f: number, g1: number, g2: number, fb: Int32Array, shift: number, add: boolean): void {
  const dg = (g2 - g1 + 32) >> 6;
  let g = g1, y0 = fb[0], y = fb[1];
  for (let i = 0; i < DX7_N; i++) {
    const s = (y0 + y) >> (shift + 1);
    g += dg;
    y0 = y;
    y = Math.floor((sin((ph + s) | 0) * g) / 16777216);
    o[oat + i] = add ? o[oat + i] + y : y;
    ph = (ph + f) | 0;
  }
  fb[0] = y0;
  fb[1] = y;
}

/** operator inputs: Q16 samples, a view per operator (null: none), from `at` */
interface Ext { x: (Int32Array | null)[]; at: number; n: number }

function kExt(o: Int32Array, oat: number, x: Int32Array, e: Ext, g1: number, g2: number, add: boolean): void {
  const dg = (g2 - g1 + 32) >> 6;
  let g = g1;
  for (let i = 0; i < DX7_N; i++) {
    g += dg;
    const y = Math.floor((extAt(x, e.at, e.n, i) * g) / 16777216);
    o[oat + i] = add ? o[oat + i] + y : y;
  }
}

function loop(out: Int32Array, p: Op[], k: number, g1: number[], g2: number[], on: boolean[], fb: Int32Array, shift: number, e: Ext): void {
  const g = [0, 0, 0], dg = [0, 0, 0], ph = [0, 0, 0];
  let y0 = fb[0], y = fb[1];
  for (let j = 0; j < k; j++) (dg[j] = (g2[j] - g1[j] + 32) >> 6), (g[j] = g1[j]), (ph[j] = p[j].phase);
  for (let i = 0; i < DX7_N; i++) {
    let v = shift < 16 ? (y0 + y) >> (shift + 1) : 0;
    for (let j = 0; j < k; j++) {
      g[j] += dg[j];
      const x = e.x[5 - j];
      if (!on[j]) v = 0;
      else if (x) v = Math.floor((extAt(x, e.at, e.n, i) * g[j]) / 16777216);
      else v = Math.floor((sin((ph[j] + v) | 0) * g[j]) / 16777216);
      ph[j] = (ph[j] + p[j].freq) | 0;
    }
    out[i] += v;
    y0 = y;
    y = v;
  }
  if (shift < 16) (fb[0] = y0), (fb[1] = y);
}

function core(out: Int32Array, p: Op[], alg: number, fb: Int32Array, shift: number, bus: Int32Array, e: Ext): void {
  const a = ALG[alg], has = [true, false, false];
  let op = 0;
  if (alg === 3 || alg === 5) {
    const k = alg === 3 ? 3 : 2, g1 = [0, 0, 0], g2 = [0, 0, 0], on = [false, false, false];
    for (op = 0; op < k; op++) {
      g1[op] = p[op].gainOut;
      g2[op] = exp2(p[op].levelIn - (14 << 24));
      p[op].gainOut = g2[op];
      on[op] = g1[op] >= LEVEL_THRESH || g2[op] >= LEVEL_THRESH;
    }
    loop(out, p, k, g1, g2, on, fb, shift, e);
    for (op = 0; op < k; op++) p[op].phase = (p[op].phase + (p[op].freq << 6)) | 0;
  }
  for (; op < 6; op++) {
    const flags = a[op], inbus = (flags >> 4) & 3, outbus = flags & 3;
    let add = (flags & OUT_ADD) !== 0;
    const o = outbus === 0 ? out : bus, oat = outbus === 0 ? 0 : (outbus - 1) * DX7_N;
    const g1 = p[op].gainOut, g2 = exp2(p[op].levelIn - (14 << 24));
    p[op].gainOut = g2;
    if (g1 >= LEVEL_THRESH || g2 >= LEVEL_THRESH) {
      if (!has[outbus]) add = false;
      const x = e.x[5 - op];
      if (x) kExt(o, oat, x, e, g1, g2, add);
      else if (inbus === 0 || !has[inbus]) {
        if ((flags & 0xc0) === 0xc0 && shift < 16) kFb(o, oat, p[op].phase, p[op].freq, g1, g2, fb, shift, add);
        else kPure(o, oat, p[op].phase, p[op].freq, g1, g2, add);
      } else kMod(o, oat, bus, (inbus - 1) * DX7_N, p[op].phase, p[op].freq, g1, g2, add);
      has[outbus] = true;
    } else if (!add) has[outbus] = false;
    p[op].phase = (p[op].phase + (p[op].freq << 6)) | 0;
  }
}

// ------------------------------------------------------------------ a note

interface Note { env: Env[]; op: Op[]; penv: PEnv; base: number[]; fb: Int32Array; key: number; mode: number[]; ams: number[]; alg: number; opsw: number; pmd: number; pmsI: number; amd: number; init: boolean; shift: number }
const newNote = (): Note => ({
  env: Array.from({ length: 6 }, newEnv), op: Array.from({ length: 6 }, () => ({ levelIn: 0, gainOut: 0, freq: 0, phase: 0 })),
  penv: { level: 0, target: 0, inc: 0, rates: [0, 0, 0, 0], levels: [0, 0, 0, 0], ix: 0, rising: false, down: false },
  base: [0, 0, 0, 0, 0, 0], fb: new Int32Array(2), key: 0, mode: [0, 0, 0, 0, 0, 0], ams: [0, 0, 0, 0, 0, 0],
  alg: 0, opsw: 0, pmd: 0, pmsI: 0, amd: 0, init: false, shift: 0,
});

interface Ctl { pitchMod: number; ampMod: number; egMod: number; bend: number }

const DETUNE_K = 9584945, DETUNE_C = 12823545, AMS_A = 295293757, AMS_B = 423577;
export const DX7_LOGFREQ_C0 = 50857777;
export const DX7_SEMI = 1398101;

function oscFreq(R: Dx7Rate, key: number, mode: number, coarse: number, fine: number, detune: number): number {
  let lf: number;
  if (mode === 0) {
    const e = exp2(-Math.floor((key * DETUNE_K) / 2 ** 24));
    const d = mulShr(mulShr(key * (detune - 7), e, 24), DETUNE_C, 32);
    lf = key + d;
    lf += COARSE[coarse & 31];
    if (fine) lf += R.fine[fine];
  } else {
    lf = (4458616 * ((coarse & 3) * 100 + fine)) >> 3;
    lf += detune > 7 ? 13457 * (detune - 7) : 0;
  }
  return lf;
}

function scaleVel(velocity: number, sens: number): number {
  const v = VELOCITY[max(0, min(127, velocity)) >> 1] - 239;
  return ((sens * v + 7) >> 3) * 16;
}
const scaleRate = (note: number, sens: number): number => (sens * min(31, max(0, Math.trunc(note / 3) - 7))) >> 3;
function scaleCurve(group: number, depth: number, curve: number): number {
  const scale = curve === 0 || curve === 3 ? (group * depth * 329) >> 12 : (EXP_SCALE[min(group, 32)] * depth * 329) >> 15;
  return curve < 2 ? -scale : scale;
}
function scaleLevel(note: number, bp: number, ld: number, rd: number, lc: number, rc: number): number {
  const off = note - bp - 17;
  return off >= 0 ? scaleCurve(Math.trunc((off + 1) / 3), rd, rc) : scaleCurve(Math.trunc(-(off - 1) / 3), ld, lc);
}
function outlevel(v: Uint8Array, o: number, note: number, velocity: number): number {
  const q = o * 21;
  let lv = scaleout(v[q + 16]) + scaleLevel(note, v[q + 8], v[q + 9], v[q + 10], v[q + 11], v[q + 12]);
  lv = min(127, lv) * 32;
  lv += scaleVel(velocity, v[q + 15]);
  return max(0, lv);
}

function noteCommon(n: Note, v: Uint8Array): void {
  const fbl = v[135];
  n.alg = v[134];
  n.shift = fbl !== 0 ? 8 - fbl : 16;
  n.pmd = (v[139] * 165) >> 6;
  n.pmsI = v[143] & 7;
  n.amd = (v[140] * 165) >> 6;
  n.opsw = v[155];
}

function noteInit(R: Dx7Rate, n: Note, v: Uint8Array, key: number, note: number, velocity: number): void {
  n.init = true;
  n.key = key;
  for (let op = 0; op < 6; op++) {
    const q = op * 21;
    envInit(R, n.env[op], v, q, outlevel(v, op, note, velocity), scaleRate(note, v[q + 13]));
    n.mode[op] = v[q + 17];
    n.base[op] = oscFreq(R, key, v[q + 17], v[q + 18], v[q + 19], v[q + 20]);
    n.ams[op] = v[q + 14] & 3;
  }
  penvSet(R, n.penv, v, 126);
  noteCommon(n, v);
}

function noteUpdate(R: Dx7Rate, n: Note, v: Uint8Array, note: number, velocity: number): void {
  for (let op = 0; op < 6; op++) {
    const q = op * 21;
    n.base[op] = oscFreq(R, n.key, v[q + 17], v[q + 18], v[q + 19], v[q + 20]);
    n.ams[op] = v[q + 14] & 3;
    n.mode[op] = v[q + 17];
    envUpdate(R, n.env[op], v, q, outlevel(v, op, note, velocity), scaleRate(note, v[q + 13]));
  }
  noteCommon(n, v);
}

function noteKeyup(R: Dx7Rate, n: Note): void {
  for (let op = 0; op < 6; op++) envKeydown(R, n.env[op], false);
  penvKeydown(R, n.penv, false);
}

function noteSync(n: Note): void {
  for (const o of n.op) (o.gainOut = 0), (o.phase = 0);
}

function notePlaying(n: Note): boolean {
  if (!n.init) return false;
  for (let i = 0; i < 6; i++) {
    const e = n.env[i];
    if (ALG[n.alg][i] & OUT_ADD && e.init && (e.ix < 4 || e.levels[3] > 0)) return true;
  }
  return false;
}

function noteCompute(R: Dx7Rate, n: Note, buf: Int32Array, lfoVal: number, lfoDel: number, c: Ctl, bus: Int32Array, e: Ext): void {
  const pmd = n.pmd * lfoDel;
  const senslfo = PMS[n.pmsI] * (lfoVal - (1 << 23));
  let pm1 = mulShr(pmd, senslfo, 39);
  pm1 = pm1 < 0 ? -pm1 : pm1;
  let pm2 = Math.floor((c.pitchMod * senslfo) / 16384);
  pm2 = pm2 < 0 ? -pm2 : pm2;
  let pitchMod = max(pm1, pm2);
  pitchMod = penvSample(R, n.penv) + pitchMod * (senslfo < 0 ? -1 : 1);
  pitchMod += c.bend;

  lfoVal = (1 << 24) - lfoVal;
  let am1 = Math.floor((n.amd * lfoDel) / 256);
  am1 = Math.floor((am1 * lfoVal) / 2 ** 24);
  const am2 = Math.floor((c.ampMod * lfoVal) / 128) >>> 0;
  let amd = am1 > am2 ? am1 : am2;
  const am3 = ((c.egMod + 1) << 17) >>> 0;
  const eg = (2 ** 24 - am3) >>> 0;
  amd = eg > amd ? eg : amd;

  for (let op = 0; op < 6; op++) {
    const o = n.op[op];
    if (!(n.opsw & (1 << op))) {
      envSample(R, n.env[op]);
      o.levelIn = 0;
    } else {
      o.freq = freq(R, (n.base[op] + (n.mode[op] ? c.bend : pitchMod)) | 0);
      let level = envSample(R, n.env[op]);
      if (n.ams[op]) {
        const sensamp = Math.floor((amd * AMS[n.ams[op]]) / 2 ** 24);
        const xx = (AMS_A + Math.floor((sensamp * AMS_B) / 65536)) | 0;
        const pt = exp2(xx & 0xffffff) >>> (24 - (xx >> 24));
        const ldiff = Math.floor((level * (pt * 16)) / 2 ** 28);
        level -= ldiff;
      }
      o.levelIn = level;
    }
  }
  core(buf, n.op, n.alg, n.fb, n.shift, bus, e);
}

// ------------------------------------------------------------------ the voice

/** a packed voice (128 bytes) into msfa's form (156: the operator switches, byte 155, all on) */
export function dx7Unpack(b: ArrayLike<number>, o: Uint8Array = new Uint8Array(DX7_UNPACKED)): Uint8Array {
  for (let op = 0; op < 6; op++) {
    const s = op * 17, d = op * 21;
    for (let i = 0; i < 11; i++) o[d + i] = b[s + i] & 0x7f;
    o[d + 11] = b[s + 11] & 3;
    o[d + 12] = (b[s + 11] >> 2) & 3;
    o[d + 13] = b[s + 12] & 7;
    o[d + 20] = (b[s + 12] >> 3) & 15;
    o[d + 14] = b[s + 13] & 3;
    o[d + 15] = (b[s + 13] >> 2) & 7;
    o[d + 16] = b[s + 14] & 0x7f;
    o[d + 17] = b[s + 15] & 1;
    o[d + 18] = (b[s + 15] >> 1) & 31;
    o[d + 19] = b[s + 16] & 0x7f;
  }
  for (let i = 0; i < 9; i++) o[126 + i] = b[102 + i] & 0x7f;
  o[135] = b[111] & 7;
  o[136] = (b[111] >> 3) & 1;
  for (let i = 0; i < 4; i++) o[137 + i] = b[112 + i] & 0x7f;
  o[141] = b[116] & 1;
  o[142] = (b[116] >> 1) & 7;
  o[143] = (b[116] >> 4) & 7;
  for (let i = 0; i < 11; i++) o[144 + i] = b[117 + i] & 0x7f;
  o[155] = 0x3f;
  return o;
}

/** msfa's form into the packed voice (the DX7's own packing) */
export function dx7Pack(u: ArrayLike<number>, b: Uint8Array = new Uint8Array(DX7_VOICE)): Uint8Array {
  for (let op = 0; op < 6; op++) {
    const s = op * 21, d = op * 17;
    for (let i = 0; i < 11; i++) b[d + i] = u[s + i];
    b[d + 11] = u[s + 11] | (u[s + 12] << 2);
    b[d + 12] = u[s + 13] | (u[s + 20] << 3);
    b[d + 13] = u[s + 14] | (u[s + 15] << 2);
    b[d + 14] = u[s + 16];
    b[d + 15] = u[s + 17] | (u[s + 18] << 1);
    b[d + 16] = u[s + 19];
  }
  for (let i = 0; i < 9; i++) b[102 + i] = u[126 + i];
  b[111] = u[135] | (u[136] << 3);
  for (let i = 0; i < 4; i++) b[112 + i] = u[137 + i];
  b[116] = u[141] | (u[142] << 1) | (u[143] << 4);
  for (let i = 0; i < 11; i++) b[117 + i] = u[144 + i];
  return b;
}

/** each value's top in msfa's form: an operator's 21 (at op * 21), then 126 .. 154 */
export const DX7_RANGE = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
const RANGE_G = [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99];
/** every value into the DX7's range (dx7.h dx7_clamp) */
export function dx7Clamp(o: Uint8Array): void {
  for (let op = 0; op < 6; op++) for (let i = 0; i < 21; i++) if (o[op * 21 + i] > DX7_RANGE[i]) o[op * 21 + i] = DX7_RANGE[i];
  for (let i = 0; i < 12; i++) if (o[126 + i] > RANGE_G[i]) o[126 + i] = RANGE_G[i];
  for (let i = 138; i < 141; i++) if (o[i] > 99) o[i] = 99;
  if (o[142] > 5) o[142] = 5;
  if (o[144] > 48) o[144] = 48;
}

// ------------------------------------------------------------------ one copy of the module

export interface Dx7 { R: Dx7Rate; note: Note; lfo: Lfo; bus: Int32Array; ob: Int32Array; pitch0: number; v: Uint8Array; pos: number; seen: number; gate: boolean; live: boolean; noteKey: number; vel: number }

/** what one call reads: Q16 signals (null: not cabled) and the module's effective parameters (Q16) */
export interface Dx7Io {
  pitch: Int32Array | null; gate: Int32Array | null; vel: Int32Array | null; x: (Int32Array | null)[];
  level: number; tune: number; mod: number; range: number; dest: number; ops: number;
  /** the engine's samples since the patch loaded, at this call's sample 0 */
  t: number;
}

export function dx7SetVoice(s: Dx7, packed: ArrayLike<number>): void {
  const sw = s.v[155];
  dx7Unpack(packed, s.v);
  dx7Clamp(s.v);
  s.v[155] = sw;
  lfoReset(s.R, s.lfo, s.v, 137);
  if (s.live) noteUpdate(s.R, s.note, s.v, s.noteKey, s.vel);
}

export function dx7New(sr: number, packed: ArrayLike<number>): Dx7 {
  const s: Dx7 = {
    R: dx7Rate(sr), note: newNote(), lfo: { phase: 0, delta: 0, delaystate: 0, delayinc: 0, delayinc2: 0, wave: 0, rand: 0, sync: false },
    bus: new Int32Array(2 * DX7_N), ob: new Int32Array(DX7_N), pitch0: 0,
    v: new Uint8Array(DX7_UNPACKED), pos: DX7_N, seen: DX7_N, gate: false, live: false, noteKey: 0, vel: 0,
  };
  s.v[155] = 0x3f;
  dx7SetVoice(s, packed);
  return s;
}

const whole = (q16: number): number => (q16 + 32768) >> 16;

function edge(s: Dx7, io: Dx7Io, i: number, up: boolean): void {
  if (up) {
    let p = io.pitch ? io.pitch[i] : 0;
    p = p < -(5 << 16) ? -(5 << 16) : p > 365909 ? 365909 : p;
    const note = ((p * 12 + 32768) >> 16) + 60 + s.v[144] - 24;
    const key = DX7_LOGFREQ_C0 + 60 * DX7_SEMI + p * 256 + (s.v[144] - 24) * DX7_SEMI;
    const vel = io.vel ? whole(max(0, min(65536, io.vel[i])) * 127) : VEL_NONE;
    s.pitch0 = p;
    s.noteKey = max(0, min(127, note));
    s.vel = max(0, min(127, vel));
    noteInit(s.R, s.note, s.v, key, s.noteKey, s.vel);
    if (s.v[136]) noteSync(s.note);
    lfoKeydown(s.lfo, Math.imul(s.lfo.delta, Math.floor((io.t + i) / DX7_N)));
    s.live = true;
  } else if (s.note.init) noteKeyup(s.R, s.note);
  s.gate = up;
}

function scan(s: Dx7, io: Dx7Io, from: number, to: number): void {
  if (!io.gate) {
    if (s.gate) edge(s, io, from, false);
    return;
  }
  for (let i = from; i < to; i++) {
    const g = io.gate[i] > 32768;
    if (g !== s.gate) edge(s, io, i, g);
  }
}

const ext: Ext = { x: [null, null, null, null, null, null], at: 0, n: 0 };
const ctl: Ctl = { pitchMod: 0, ampMod: 0, egMod: 0, bend: 0 };

function block(s: Dx7, io: Dx7Io, i: number, avail: number): void {
  scan(s, io, i, i + avail);
  s.ob.fill(0);
  if (s.live) {
    const p = io.pitch ? io.pitch[i] : 0;
    const cc = whole(max(0, min(65536, io.mod)) * 127), dest = whole(io.dest) + 1;
    const total = Math.trunc((cc * max(0, min(99, whole(io.range)))) / 100);
    ctl.pitchMod = dest & 1 ? total : 0;
    ctl.ampMod = dest & 2 ? total : 0;
    ctl.egMod = dest & 4 ? total : 127;
    let d = p - s.pitch0;
    d = d < -(8 << 16) ? -(8 << 16) : d > 8 << 16 ? 8 << 16 : d;
    ctl.bend = d * 256 + Math.floor((io.tune * 13981) / 65536);
    for (let j = 0; j < 6; j++) ext.x[j] = io.x[j];
    ext.at = i;
    ext.n = avail;
    const lv = lfoSample(s.lfo), ld = lfoDelay(s.lfo);
    noteCompute(s.R, s.note, s.ob, lv, ld, ctl, s.bus, ext);
    for (let j = 0; j < DX7_N; j++) {
      const val = s.ob[j] >> 4;
      s.ob[j] = (val < -(1 << 24) ? -0x8000 : val >= 1 << 24 ? 0x7fff : val >> 9) * 8;
    }
    if (!s.gate && !notePlaying(s.note)) s.live = false;
  }
  s.pos = 0;
  s.seen = avail;
}

/** n samples (any count) into out, Q16 */
export function dx7Run(s: Dx7, io: Dx7Io, out: Int32Array, n: number): void {
  const u = whole(io.ops);
  let ops = 0;
  for (let k = 0; k < 6; k++) ops |= ((u >> k) & 1) << (5 - k);
  if (s.v[155] !== ops) s.v[155] = s.note.opsw = ops;
  for (let i = 0; i < n; i++) {
    if (s.pos === DX7_N) block(s, io, i, n - i < DX7_N ? n - i : DX7_N);
    else if (s.pos >= s.seen) scan(s, io, i, i + 1);
    out[i] = Math.floor((s.ob[s.pos++] * io.level) / 65536);
  }
}

/** for the idle-part rule: the gate is low and the carriers have all finished */
export const dx7Quiet = (s: Dx7): boolean => !s.gate && !s.live;
