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

// Resolve frequency signal (1.0 in Q24 format = 1 octave) to phase delta.

#include "synth.h"
#include "freqlut.h"

#define LG_N_SAMPLES 10
#define N_SAMPLES (1 << LG_N_SAMPLES)
#define SAMPLE_SHIFT (24 - LG_N_SAMPLES)

#define MAX_LOGFREQ_INT 20

#ifdef MSFA_OWN_TABLES
// FM-1: const, worked out for 44,118 Hz (gen_tables.py)
extern "C" const int32_t msfa_freqlut[N_SAMPLES + 1];

int32_t Freqlut::lookup(int32_t logfreq) {
  int ix = (logfreq & 0xffffff) >> SAMPLE_SHIFT;

  int32_t y0 = msfa_freqlut[ix];
  int32_t y1 = msfa_freqlut[ix + 1];
  int lowbits = logfreq & ((1 << SAMPLE_SHIFT) - 1);
  int32_t y = y0 + ((((int64_t)(y1 - y0) * (int64_t)lowbits)) >> SAMPLE_SHIFT);
  int hibits = logfreq >> 24;
  return y >> (MAX_LOGFREQ_INT - hibits);
}
#else
// FM-1: the table is 2^(i / 1024) times a constant, so the firmware's EXP2_T (2^(i/256) in Q28) gives it
extern "C" const uint32_t EXP2_T[257];
#define FREQ_C 398753027u   // round(2^44 / 44118)

int32_t Freqlut::lookup(int32_t logfreq) {
  uint32_t i = ((uint32_t)logfreq >> 16) & 255u, r = (uint32_t)logfreq & 0xFFFFu;
  uint32_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1] - EXP2_T[i]) * r) >> 16);   // Q28
  int32_t y = (int32_t)(((uint64_t)m * FREQ_C + (1u << 27)) >> 28);
  int hibits = logfreq >> 24;
  return y >> (MAX_LOGFREQ_INT - hibits);
}
#endif
