/* SPDX-License-Identifier: BSD-3-Clause */
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
#pragma once
#include <stdint.h>

typedef struct {
    uint32_t phase, ticks;
    int32_t att;
    uint8_t stage, prev;
} rate_env_t;

static const uint32_t RATE_ENV_INCREMENTS[64] = {
    0x00000000u, 0x00000000u, 0x10101010u, 0x10101010u,
    0x10101010u, 0x10101010u, 0x11101110u, 0x11101110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x10101010u, 0x10111010u, 0x11101110u, 0x11111110u,
    0x11111111u, 0x21112111u, 0x21212121u, 0x22212221u,
    0x22222222u, 0x42224222u, 0x42424242u, 0x44424442u,
    0x44444444u, 0x84448444u, 0x84848484u, 0x88848884u,
    0x88888888u, 0x88888888u, 0x88888888u, 0x88888888u,
};

static inline uint32_t rate_env_effective(uint32_t raw, uint32_t ksr)
{
    return !raw ? 0 : raw + ksr > 63 ? 63 : raw + ksr;
}

/* Same integer envelope clock as web/src/rate-envelope.ts. The caller converts attenuation to Q16 level. */
static inline void rate_env_sample(rate_env_t *s, uint32_t period, uint32_t g, uint32_t hold,
                                   uint32_t ar, uint32_t d1r, uint32_t target, uint32_t d2r, uint32_t rr, uint32_t ksr)
{
    if (g && !s->prev) {
        if (!s->stage) s->att = 1023;
        s->stage = 1;
        if (rate_env_effective(ar, ksr) >= 62) s->att = 0;
    } else if (!g && s->stage && s->stage != 4 && !hold) s->stage = 4;
    s->prev = (uint8_t)g;
    s->phase += 3580000u;
    while (s->phase >= period) {
        uint32_t rate, shift, increment;
        s->phase -= period;
        s->ticks = (s->ticks + 1u) & 65535u;
        if (!s->stage) continue;
        if (s->stage == 1 && s->att == 0) s->stage = 2;
        if (s->stage == 2 && (uint32_t)s->att >= target) s->stage = 3;
        rate = rate_env_effective(s->stage == 1 ? ar : s->stage == 2 ? d1r : s->stage == 3 ? d2r : rr, ksr);
        shift = (rate >> 2) < 11 ? 11 - (rate >> 2) : 0;
        if (s->ticks & ((1u << shift) - 1u)) continue;
        increment = (RATE_ENV_INCREMENTS[rate] >> (4u * ((s->ticks >> shift) & 7u))) & 15u;
        if (s->stage == 1) {
            s->att = rate >= 62 ? 0 : s->att + ((~s->att * (int32_t)increment) >> 4);
        } else {
            s->att += (int32_t)increment;
            if (s->att >= 1023) { s->att = 1023; s->stage = 0; }
        }
    }
}
