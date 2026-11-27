/*
 * Copyright 2012 Google Inc.
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
#ifndef __EXP2_H
#define __EXP2_H
#include "synth.h"

// FM-1: the tables are const. MSFA_OWN_TABLES: msfa's own (1024 steps an octave, slope and value pairs, 8 KB); else the
// firmware's EXP2_T (firmware/src/dsp_tables.h: 2^(i/256) in Q28, 257 entries), interpolated over 16 bits.
#define EXP2_LG_N_SAMPLES 10
#define EXP2_N_SAMPLES (1 << EXP2_LG_N_SAMPLES)

#ifdef MSFA_OWN_TABLES
extern "C" const int32_t msfa_exp2tab[EXP2_N_SAMPLES << 1];
#else
extern "C" const uint32_t EXP2_T[257];
#endif

class Exp2 {
 public:
  // Q24 in, Q24 out
  static int32_t lookup(int32_t x);
};

inline
int32_t Exp2::lookup(int32_t x) {
#ifdef MSFA_OWN_TABLES
  const int SHIFT = 24 - EXP2_LG_N_SAMPLES;
  int lowbits = x & ((1 << SHIFT) - 1);
  int x_int = (x >> (SHIFT - 1)) & ((EXP2_N_SAMPLES - 1) << 1);
  int dy = msfa_exp2tab[x_int];
  int y0 = msfa_exp2tab[x_int + 1];

  int y = y0 + (((int64_t)dy * (int64_t)lowbits) >> SHIFT);
  return y >> (6 - (x >> 24));
#else
  uint32_t i = ((uint32_t)x >> 16) & 255u, r = (uint32_t)x & 0xFFFFu;
  int32_t m = (int32_t)(EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1] - EXP2_T[i]) * r) >> 16));   // Q28
  int sh = 4 - (x >> 24);
  return sh >= 0 ? m >> sh : m << -sh;
#endif
}

#endif
