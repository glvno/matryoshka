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
#ifndef __SIN_H
#define __SIN_H
#include "synth.h"

// FM-1: the table is const. MSFA_OWN_TABLES: msfa's own (SIN_DELTA: 1024 slope and value pairs, 8 KB); else the
// firmware's SIN_T (firmware/src/dsp_tables.h: sin(2 pi i / 1024) in Q30, 1025 entries), interpolated in Q30.
#define SIN_LG_N_SAMPLES 10
#define SIN_N_SAMPLES (1 << SIN_LG_N_SAMPLES)

#ifdef MSFA_OWN_TABLES
extern "C" const int32_t msfa_sintab[SIN_N_SAMPLES << 1];
#else
extern "C" const int32_t SIN_T[1025];
#endif

class Sin {
 public:
  // phase Q24 (one turn = 1 << 24), result Q24
  static int32_t lookup(int32_t phase);
};

inline
int32_t Sin::lookup(int32_t phase) {
  const int SHIFT = 24 - SIN_LG_N_SAMPLES;
  int lowbits = phase & ((1 << SHIFT) - 1);
#ifdef MSFA_OWN_TABLES
  int phase_int = (phase >> (SHIFT - 1)) & ((SIN_N_SAMPLES - 1) << 1);
  int dy = msfa_sintab[phase_int];
  int y0 = msfa_sintab[phase_int + 1];
  return y0 + (((int64_t)dy * (int64_t)lowbits) >> SHIFT);
#else
  int phase_int = (phase >> SHIFT) & (SIN_N_SAMPLES - 1);
  int32_t y0 = SIN_T[phase_int], y1 = SIN_T[phase_int + 1];
  int32_t y = y0 + (int32_t)(((int64_t)(y1 - y0) * (int64_t)lowbits) >> SHIFT);   // Q30
  return (y + 32) >> 6;
#endif
}

#endif  // __SIN_H
