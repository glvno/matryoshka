/*
 * Copyright 2016-2025 Pascal Gauthier.
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
/* Spike #1338 (never merged): Dexed's Source/msfa at c314161a, cut to what a DX7 voice needs on the FM-1. Every change
 * from Dexed is marked "FM-1:". The tables are const (gen_tables.py) and the sample rate is fixed at 44,118 Hz. */
#ifndef __SYNTH_H
#define __SYNTH_H

#include <stdint.h>
#include <stddef.h>

const static int LG_N = 6;
const static int N = (1 << LG_N);

template<typename T>
inline static T min(const T& a, const T& b) {
    return a < b ? a : b;
}

template<typename T>
inline static T max(const T& a, const T& b) {
    return a > b ? a : b;
}

#endif  // __SYNTH_H
