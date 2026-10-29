// SPDX-License-Identifier: BSD-3-Clause
/*
 * BSD 3-Clause License
 * 
 * Copyright (c) 2021, Aaron Giles
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
// Envelope clock and increment patterns adapted from ymfm, Copyright (c) 2021, Aaron Giles.
// BSD-3-Clause; complete notice in LICENSES/BSD-3-Clause-ymfm.txt and web/public/LICENSE-ymfm.txt.
// Source: aaronsgiles/ymfm at 81aec25ccbb98f4873a255f7551ac4dadac59b4a, src/ymfm_fm.ipp.
import type { Ctx } from './modules';

// A standalone rate envelope, not an FM chip emulator. 3.58 MHz / 64 / 3 is the envelope clock.
// Levels are 10-bit attenuation. Decays are linear in attenuation; attack is exponential in attenuation.
// Like the DX100 controls, D1L 15 is full level and 0 is the lowest level (93 dB down).
const INCREMENTS = [
  0x00000000, 0x00000000, 0x10101010, 0x10101010,
  0x10101010, 0x10101010, 0x11101110, 0x11101110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x10101010, 0x10111010, 0x11101110, 0x11111110,
  0x11111111, 0x21112111, 0x21212121, 0x22212221,
  0x22222222, 0x42224222, 0x42424242, 0x44424442,
  0x44444444, 0x84448444, 0x84848484, 0x88848884,
  0x88888888, 0x88888888, 0x88888888, 0x88888888,
];
const LEVELS = Array.from({ length: 64 }, (_, i) => Math.round(2 ** 31 * 2 ** (-i / 64)) >>> 15);
export interface RateEnvelopeState {
  stage: number; // 0 idle, 1 attack, 2 decay 1, 3 decay 2, 4 release
  att: number;
  phase: number;
  ticks: number;
  prev: number;
  v: number;
}
export const rateEnvelopeInit = (): RateEnvelopeState => ({ stage: 0, att: 1023, phase: 0, ticks: 0, prev: 0, v: 0 });
export function rateEnvelopeProcess(c: Ctx, s: RateEnvelopeState): void {
  const integer = (name: string, fallback: number, max: number) => Math.max(0, Math.min(max, Math.round(c.p[name] ?? fallback)));
  const ar = 2 * integer('ar', 31, 31), d1r = 2 * integer('d1r', 12, 31), d2r = 2 * integer('d2r', 0, 31);
  const rr = 4 * integer('rr', 8, 15) + 2, scaling = integer('krs', 0, 3);
  const level = 15 - integer('d1l', 10, 15), target = (level === 15 ? 31 : level) * 32;
  const period = c.sr * 192;
  for (let i = 0; i < c.n; i++) {
    // C4 = MIDI 60. Yamaha labels middle C as C3; its key-code range starts at C#-1 (MIDI 13).
    const pitch = Math.round((c.inp.pitch?.[i] ?? 0) * 65536);
    const note = Math.floor((pitch * 12 + 60 * 65536 + 32768) / 65536);
    const key = Math.max(0, Math.min(31, Math.floor((note - 13) / 3)));
    const ksr = key >> (3 - scaling);
    const effective = (raw: number) => raw ? Math.min(63, raw + ksr) : 0;
    const g = c.inp.gate[i] > 0.5 ? 1 : 0;
    if (g && !s.prev) {
      if (!s.stage) s.att = 1023;
      s.stage = 1;
      if (effective(ar) >= 62) s.att = 0;
    } else if (!g && s.stage && s.stage !== 4 && (c.inp.hold?.[i] ?? 0) <= 0.5) s.stage = 4;
    s.prev = g;
    s.phase += 3580000;
    while (s.phase >= period) {
      s.phase -= period;
      s.ticks = (s.ticks + 1) & 65535;
      if (!s.stage) continue;
      if (s.stage === 1 && s.att === 0) s.stage = 2;
      if (s.stage === 2 && s.att >= target) s.stage = 3;
      const rate = effective(s.stage === 1 ? ar : s.stage === 2 ? d1r : s.stage === 3 ? d2r : rr);
      const shift = Math.max(0, 11 - (rate >> 2));
      if (s.ticks & ((1 << shift) - 1)) continue;
      const increment = (INCREMENTS[rate] >>> (4 * ((s.ticks >> shift) & 7))) & 15;
      if (s.stage === 1) {
        // A live change to maximum attack also completes the attack; no chip-register glitch is reproduced.
        s.att = rate >= 62 ? 0 : s.att + ((~s.att * increment) >> 4);
      } else {
        s.att = Math.min(1023, s.att + increment);
        if (s.att === 1023) s.stage = 0;
      }
    }
    s.v = s.stage && s.att < 1023 ? (LEVELS[s.att & 63] >> (s.att >> 6)) / 65536 : 0;
    c.out.env[i] = s.v;
  }
}
