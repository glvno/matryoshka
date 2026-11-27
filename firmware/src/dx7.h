/* SPDX-License-Identifier: Apache-2.0 */
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
/* The DX7 module's voice (#1338): msfa, the synthesis core of Dexed (Source/msfa at c314161a: env, pitchenv, lfo,
 * fm_op_kernel, fm_core, dx7note, freqlut and patch.cc's UnpackPatch), ported to C for the FM-1. One voice per engine
 * copy; engine.c's m_dx7 runs dx7_run. web/src/dx7.ts is the same code in TypeScript, sample for sample (dx7.test.ts).
 * Every change from msfa is marked "FM-1:". The main ones:
 * - FM-1: the sine, exp2 and frequency tables are the firmware's (dsp_tables.h SIN_T, EXP2_T, included before this
 *   file); the rate-dependent ones are const for 44,118 Hz (dx7_tables.h, tools/gen_dx7_tables.py).
 * - FM-1: no floating point, tuning tables, MTS-ESP, MPE, portamento, pitch-bend wheel or logger: the key, bend and glide
 *   come in through the pitch input; the modulation wheel is the module's mod parameter.
 * - FM-1: algorithms 4 and 6 close the DX7's feedback loop (operator 4, or 5, back into 6) sample by sample (dx7_loop);
 *   msfa feeds operator 6 back on itself there.
 * - FM-1: an operator can be replaced by an outside signal (dx7_k_ext).
 * - FM-1: the envelope keeps its rates and levels as bytes; out-of-range shifts (undefined in msfa) are clamped. */

#include "dx7_tables.h"

#define DX7_LG_N 6
#define DX7_N 64                     /* msfa's block: envelopes, LFO and gain ramps step every 64 samples */
#define DX7_VOICE 128                /* the packed voice (a 32-voice bulk dump's entry, VMEM) */
#define DX7_UNPACKED 156             /* msfa's form: 155 parameters (VCED) and the operator switches */
#define DX7_VEL_NONE 100             /* the velocity when nothing is cabled into vel */

static inline int dx7_min(int a, int b) { return a < b ? a : b; }
static inline int dx7_max(int a, int b) { return a > b ? a : b; }

/* ------------------------------------------------------------------ tables (msfa's, not rate dependent) */

/* fm_core.cc's algorithms, operator 6 first: bits 0-1 the output bus (0 the voice), 2 add, 4-5 the input bus, 6-7
 * feedback in / out. FM-1: bytes (msfa: int[6]) */
static const uint8_t DX7_ALG[32][6] = {
    {0xc1, 0x11, 0x11, 0x14, 0x01, 0x14}, {0x01, 0x11, 0x11, 0x14, 0xc1, 0x14}, {0xc1, 0x11, 0x14, 0x01, 0x11, 0x14},
    {0xc1, 0x11, 0x94, 0x01, 0x11, 0x14}, {0xc1, 0x14, 0x01, 0x14, 0x01, 0x14}, {0xc1, 0x94, 0x01, 0x14, 0x01, 0x14},
    {0xc1, 0x11, 0x05, 0x14, 0x01, 0x14}, {0x01, 0x11, 0xc5, 0x14, 0x01, 0x14}, {0x01, 0x11, 0x05, 0x14, 0xc1, 0x14},
    {0x01, 0x05, 0x14, 0xc1, 0x11, 0x14}, {0xc1, 0x05, 0x14, 0x01, 0x11, 0x14}, {0x01, 0x05, 0x05, 0x14, 0xc1, 0x14},
    {0xc1, 0x05, 0x05, 0x14, 0x01, 0x14}, {0xc1, 0x05, 0x11, 0x14, 0x01, 0x14}, {0x01, 0x05, 0x11, 0x14, 0xc1, 0x14},
    {0xc1, 0x11, 0x02, 0x25, 0x05, 0x14}, {0x01, 0x11, 0x02, 0x25, 0xc5, 0x14}, {0x01, 0x11, 0x11, 0xc5, 0x05, 0x14},
    {0xc1, 0x14, 0x14, 0x01, 0x11, 0x14}, {0x01, 0x05, 0x14, 0xc1, 0x14, 0x14}, {0x01, 0x14, 0x14, 0xc1, 0x14, 0x14},
    {0xc1, 0x14, 0x14, 0x14, 0x01, 0x14}, {0xc1, 0x14, 0x14, 0x01, 0x14, 0x04}, {0xc1, 0x14, 0x14, 0x14, 0x04, 0x04},
    {0xc1, 0x14, 0x14, 0x04, 0x04, 0x04}, {0xc1, 0x05, 0x14, 0x01, 0x14, 0x04}, {0x01, 0x05, 0x14, 0xc1, 0x14, 0x04},
    {0x04, 0xc1, 0x11, 0x14, 0x01, 0x14}, {0xc1, 0x14, 0x01, 0x14, 0x04, 0x04}, {0x04, 0xc1, 0x11, 0x14, 0x04, 0x04},
    {0xc1, 0x14, 0x04, 0x04, 0x04, 0x04}, {0xc4, 0x04, 0x04, 0x04, 0x04, 0x04},
};
#define DX7_OUT_ADD 4

static const int32_t DX7_COARSE[32] = {
    -16777216, 0, 16777216, 26591258, 33554432, 38955489, 43368474, 47099600,
    50331648, 53182516, 55732705, 58039632, 60145690, 62083076, 63876816,
    65546747, 67108864, 68576247, 69959732, 71268397, 72509921, 73690858,
    74816848, 75892776, 76922906, 77910978, 78860292, 79773775, 80654032,
    81503396, 82323963, 83117622
};
static const uint8_t DX7_VELOCITY[64] = {
    0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163,
    166, 170, 173, 174, 178, 181, 184, 186, 189, 190, 194, 196, 198, 200, 202,
    205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232,
    233, 235, 237, 238, 240, 241, 242, 243, 244, 246, 246, 248, 249, 250, 251,
    252, 253, 254
};
static const uint8_t DX7_EXP_SCALE[33] = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 16, 19, 23, 27, 33, 39, 47, 56, 66,
    80, 94, 110, 126, 142, 158, 174, 190, 206, 222, 238, 250
};
static const uint8_t DX7_PMS[8] = {0, 10, 20, 33, 55, 92, 153, 255};
static const uint32_t DX7_AMS[4] = {0, 4342338, 7171437, 16777216};
static const uint8_t DX7_LEVELLUT[20] = {0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46};
static const int32_t DX7_STATICS[77] = {
    1764000, 1764000, 1411200, 1411200, 1190700, 1014300, 992250,
    882000, 705600, 705600, 584325, 507150, 502740, 441000, 418950,
    352800, 308700, 286650, 253575, 220500, 220500, 176400, 145530,
    145530, 125685, 110250, 110250, 88200, 88200, 74970, 61740,
    61740, 55125, 48510, 44100, 37485, 31311, 30870, 27562, 27562,
    22050, 18522, 17640, 15435, 14112, 13230, 11025, 9261, 9261, 7717,
    6615, 6615, 5512, 5512, 4410, 3969, 3969, 3439, 2866, 2690, 2249,
    1984, 1896, 1808, 1411, 1367, 1234, 1146, 926, 837, 837, 705,
    573, 573, 529, 441, 441
};
static const uint8_t DX7_PENV_RATE[100] = {
    1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12,
    12, 13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 30, 31, 33, 34, 36, 37, 38, 39, 41, 42, 44, 46, 47,
    49, 51, 53, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 79, 82,
    85, 88, 91, 94, 98, 102, 106, 110, 115, 120, 125, 130, 135, 141, 147,
    153, 159, 165, 171, 178, 185, 193, 202, 211, 232, 243, 254, 255
};
static const int8_t DX7_PENV_TAB[100] = {
    -128, -116, -104, -95, -85, -76, -68, -61, -56, -52, -49, -46, -43,
    -41, -39, -37, -35, -33, -32, -31, -30, -29, -28, -27, -26, -25, -24,
    -23, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10,
    -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    28, 29, 30, 31, 32, 33, 34, 35, 38, 40, 43, 46, 49, 53, 58, 65, 73,
    82, 92, 103, 115, 127
};

/* ------------------------------------------------------------------ sine, exp2, frequency (FM-1: the firmware's tables) */

/* phase Q24 (one turn = 1 << 24), result Q24: SIN_T (sin in Q30, 1,025 entries) interpolated */
static inline int32_t dx7_sin(int32_t phase)
{
    int32_t low = phase & ((1 << 14) - 1), i = (phase >> 14) & 1023;
    int32_t y0 = SIN_T[i], y1 = SIN_T[i + 1];
    int32_t y = y0 + (int32_t)(((int64_t)(y1 - y0) * low) >> 14);
    return (y + 32) >> 6;
}

/* 2^x, x Q24, result Q24: EXP2_T (2^(i/256) in Q28, 257 entries) interpolated over 16 bits */
static inline int32_t dx7_exp2(int32_t x)
{
    uint32_t i = ((uint32_t)x >> 16) & 255u, r = (uint32_t)x & 0xFFFFu;
    int32_t m = (int32_t)(EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1] - EXP2_T[i]) * r) >> 16));   /* Q28 */
    int sh = 4 - (x >> 24);
    return sh >= 0 ? (sh > 31 ? 0 : m >> sh) : (int32_t)((uint32_t)m << -sh);
}

/* a frequency (1.0 in Q24 = one octave, log2 of Hz) to a phase step per sample: msfa's table is 2^(i/1024) 2^44 / SR, so
 * EXP2_T times DX7_FREQ_C gives it */
static int32_t dx7_freq(int32_t logfreq)
{
    uint32_t i = ((uint32_t)logfreq >> 16) & 255u, r = (uint32_t)logfreq & 0xFFFFu;
    uint32_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1] - EXP2_T[i]) * r) >> 16);   /* Q28 */
    int32_t y = (int32_t)(((uint64_t)m * DX7_FREQ_C + (1u << 27)) >> 28);
    int sh = 20 - (logfreq >> 24);
    return sh > 31 ? 0 : sh < 0 ? 0x7FFFFFFF : y >> sh;   /* FM-1: clamped (msfa shifts out of range) */
}

/* ------------------------------------------------------------------ envelope (env.cc) */

typedef struct {
    int32_t level, target, inc, statics;   /* level: Q24, one doubling per 1 << 24 */
    int16_t outlevel;
    uint8_t rates[4], levels[4];           /* FM-1: bytes (msfa: int) */
    uint8_t scaling, ix, rising, down, init;
} dx7_env_t;

static int dx7_scaleout(int outlevel) { return outlevel >= 20 ? 28 + outlevel : DX7_LEVELLUT[outlevel]; }

static void dx7_env_advance(dx7_env_t *e, int ix)
{
    int newlevel, actual, qrate;
    e->ix = (uint8_t)ix;
    if (ix >= 4)
        return;
    newlevel = e->levels[ix];
    actual = dx7_scaleout(newlevel) >> 1;
    actual = (actual << 6) + e->outlevel - 4256;
    actual = actual < 16 ? 16 : actual;
    e->target = actual << 16;
    e->rising = e->target > e->level;
    qrate = (e->rates[ix] * 41) >> 6;
    qrate += e->scaling;
    qrate = dx7_min(qrate, 63);
    if (e->target == e->level || (ix == 0 && newlevel == 0)) {
        int sr = dx7_min(e->rates[ix] + e->scaling, 99);
        int32_t sc = sr < 77 ? DX7_STATICS[sr] : 20 * (99 - sr);
        if (sr < 77 && ix == 0 && newlevel == 0)
            sc /= 20;                                     /* attack is scaled faster */
        e->statics = (int32_t)(((int64_t)sc * DX7_ENV_SRMUL) >> 24);
    } else
        e->statics = 0;
    e->inc = (4 + (qrate & 3)) << (2 + DX7_LG_N + (qrate >> 2));
    e->inc = (int32_t)(((int64_t)e->inc * DX7_ENV_SRMUL) >> 24);
}

static void dx7_env_init(dx7_env_t *e, const uint8_t *rl, int outlevel, int scaling)
{
    int i;
    e->init = 1;
    for (i = 0; i < 4; i++) {
        e->rates[i] = rl[i];
        e->levels[i] = rl[4 + i];
    }
    e->outlevel = (int16_t)outlevel;
    e->scaling = (uint8_t)scaling;
    e->level = 0;
    e->down = 1;
    dx7_env_advance(e, 0);
}

/* msfa Env::update: new rates and levels while a note sounds (an edit) */
static void dx7_env_update(dx7_env_t *e, const uint8_t *rl, int outlevel, int scaling)
{
    int i;
    for (i = 0; i < 4; i++) {
        e->rates[i] = rl[i];
        e->levels[i] = rl[4 + i];
    }
    e->outlevel = (int16_t)outlevel;
    e->scaling = (uint8_t)scaling;
    if (e->down) {                                        /* msfa: "for now we simply reset ourselves at level 3" */
        int actual = dx7_scaleout(e->levels[2]) >> 1;
        actual = (actual << 6) - 4256;
        actual = actual < 16 ? 16 : actual;
        e->target = actual << 16;
        dx7_env_advance(e, 2);
    }
}

static int32_t dx7_env_sample(dx7_env_t *e)
{
    if (e->statics) {
        e->statics -= DX7_N;
        if (e->statics <= 0) {
            e->statics = 0;
            dx7_env_advance(e, e->ix + 1);
        }
    }
    if (e->ix < 3 || (e->ix < 4 && !e->down)) {
        if (e->statics) {
        } else if (e->rising) {
            const int32_t jump = 1716 << 16;
            if (e->level < jump)
                e->level = jump;
            e->level += (((17 << 24) - e->level) >> 24) * e->inc;
            if (e->level >= e->target) {
                e->level = e->target;
                dx7_env_advance(e, e->ix + 1);
            }
        } else {
            e->level -= e->inc;
            if (e->level <= e->target) {
                e->level = e->target;
                dx7_env_advance(e, e->ix + 1);
            }
        }
    }
    return e->level;
}

static void dx7_env_keydown(dx7_env_t *e, int d)
{
    if (e->down != d) {
        e->down = (uint8_t)d;
        dx7_env_advance(e, d ? 0 : 3);
    }
}

static int dx7_env_active(const dx7_env_t *e) { return e->init && (e->ix < 4 || e->levels[3] > 0); }

/* ------------------------------------------------------------------ pitch envelope (pitchenv.cc) */

typedef struct {
    int32_t level, target, inc;            /* Q24 per octave */
    uint8_t rates[4], levels[4], ix, rising, down;
} dx7_penv_t;

static void dx7_penv_advance(dx7_penv_t *p, int ix)
{
    p->ix = (uint8_t)ix;
    if (ix < 4) {
        p->target = DX7_PENV_TAB[p->levels[ix]] * (1 << 19);
        p->rising = p->target > p->level;
        p->inc = DX7_PENV_RATE[p->rates[ix]] * DX7_PITCHENV_UNIT;
    }
}

static void dx7_penv_set(dx7_penv_t *p, const uint8_t *rl)
{
    int i;
    for (i = 0; i < 4; i++) {
        p->rates[i] = rl[i];
        p->levels[i] = rl[4 + i];
    }
    p->level = DX7_PENV_TAB[rl[7]] * (1 << 19);
    p->down = 1;
    dx7_penv_advance(p, 0);
}

static int32_t dx7_penv_sample(dx7_penv_t *p)
{
    if (p->ix < 3 || (p->ix < 4 && !p->down)) {
        if (p->rising) {
            p->level += p->inc;
            if (p->level >= p->target) {
                p->level = p->target;
                dx7_penv_advance(p, p->ix + 1);
            }
        } else {
            p->level -= p->inc;
            if (p->level <= p->target) {
                p->level = p->target;
                dx7_penv_advance(p, p->ix + 1);
            }
        }
    }
    return p->level;
}

static void dx7_penv_keydown(dx7_penv_t *p, int d)
{
    if (p->down != d) {
        p->down = (uint8_t)d;
        dx7_penv_advance(p, d ? 0 : 3);
    }
}

/* ------------------------------------------------------------------ LFO (lfo.cc) */

typedef struct {
    uint32_t phase, delta, delaystate, delayinc, delayinc2;   /* phase Q32 */
    uint8_t wave, rand, sync;
} dx7_lfo_t;

/* p: the voice's LFO bytes (speed, delay, PMD, AMD, sync, wave) */
static void dx7_lfo_reset(dx7_lfo_t *l, const uint8_t *p)
{
    int a = 99 - p[1];
    l->delta = DX7_LFO_DELTA[p[0]];
    if (a == 99) {
        l->delayinc = ~0u;
        l->delayinc2 = ~0u;
    } else {
        a = (16 + (a & 15)) << (1 + (a >> 4));
        l->delayinc = DX7_LFO_UNIT * (uint32_t)a;
        a &= 0xff80;
        a = dx7_max(0x80, a);
        l->delayinc2 = DX7_LFO_UNIT * (uint32_t)a;
    }
    l->wave = p[5];
    l->sync = p[4] != 0;
}

static int32_t dx7_lfo_sample(dx7_lfo_t *l)          /* 0..1 in Q24 */
{
    int32_t x;
    l->phase += l->delta;
    switch (l->wave) {
    case 0:                                           /* triangle */
        x = (int32_t)(l->phase >> 7);
        x ^= -(int32_t)(l->phase >> 31);
        return x & ((1 << 24) - 1);
    case 1:                                           /* saw down */
        return (int32_t)((~l->phase ^ (1u << 31)) >> 8);
    case 2:                                           /* saw up */
        return (int32_t)((l->phase ^ (1u << 31)) >> 8);
    case 3:                                           /* square */
        return (int32_t)(((~l->phase) >> 7) & (1u << 24));
    case 4:                                           /* sine */
        return (1 << 23) + (dx7_sin((int32_t)(l->phase >> 8)) >> 1);
    case 5:                                           /* sample and hold */
        if (l->phase < l->delta)
            l->rand = (uint8_t)((l->rand * 179 + 17) & 0xff);
        return ((l->rand ^ 0x80) + 1) << 16;
    }
    return 1 << 23;
}

static int32_t dx7_lfo_delay(dx7_lfo_t *l)           /* 0..1 in Q24 */
{
    uint32_t delta = l->delaystate < (1u << 31) ? l->delayinc : l->delayinc2;
    uint64_t d = (uint64_t)l->delaystate + delta;
    if (d > ~0u)
        return 1 << 24;
    l->delaystate = (uint32_t)d;
    return d < (1u << 31) ? 0 : (int32_t)((d >> 7) & ((1 << 24) - 1));
}

/* a key went down; phase: where a free-running LFO is now (FM-1: the engine's time, so every copy shares one phase) */
static void dx7_lfo_keydown(dx7_lfo_t *l, uint32_t phase)
{
    l->phase = l->sync ? (1u << 31) - 1u : phase;
    l->delaystate = 0;
}

/* ------------------------------------------------------------------ operator kernels (fm_op_kernel.cc) */

typedef struct {
    int32_t level_in;                      /* the level to reach (from the envelope) */
    int32_t gain_out;                      /* the gain reached at the end of the last block */
    int32_t freq, phase;
} dx7_op_t;

/* FM-1: phases wrap as unsigned numbers (msfa relies on int32 overflow, which C leaves undefined) */
static inline int32_t dx7_wrap(int32_t a, int32_t b) { return (int32_t)((uint32_t)a + (uint32_t)b); }

/* gain ramps from g1 to g2 over the block: (1 + i) / 64 of the way at sample i */
static void dx7_k_mod(int32_t *o, const int32_t *in, int32_t ph, int32_t f, int32_t g1, int32_t g2, int add)
{
    int32_t dg = (g2 - g1 + (DX7_N >> 1)) >> DX7_LG_N, g = g1;
    int i;
    for (i = 0; i < DX7_N; i++) {
        int32_t y;
        g += dg;
        y = (int32_t)(((int64_t)dx7_sin(dx7_wrap(ph, in[i])) * g) >> 24);
        o[i] = add ? o[i] + y : y;
        ph = dx7_wrap(ph, f);
    }
}

static void dx7_k_pure(int32_t *o, int32_t ph, int32_t f, int32_t g1, int32_t g2, int add)
{
    int32_t dg = (g2 - g1 + (DX7_N >> 1)) >> DX7_LG_N, g = g1;
    int i;
    for (i = 0; i < DX7_N; i++) {
        int32_t y;
        g += dg;
        y = (int32_t)(((int64_t)dx7_sin(ph) * g) >> 24);
        o[i] = add ? o[i] + y : y;
        ph = dx7_wrap(ph, f);
    }
}

static void dx7_k_fb(int32_t *o, int32_t ph, int32_t f, int32_t g1, int32_t g2, int32_t *fb, int shift, int add)
{
    int32_t dg = (g2 - g1 + (DX7_N >> 1)) >> DX7_LG_N, g = g1, y0 = fb[0], y = fb[1];
    int i;
    for (i = 0; i < DX7_N; i++) {
        int32_t s = (y0 + y) >> (shift + 1);
        g += dg;
        y0 = y;
        y = (int32_t)(((int64_t)dx7_sin(dx7_wrap(ph, s)) * g) >> 24);
        o[i] = add ? o[i] + y : y;
        ph = dx7_wrap(ph, f);
    }
    fb[0] = y0;
    fb[1] = y;
}

/* FM-1: an outside signal x (Q16, the first xn samples there, the rest hold the last) in place of the sine: x, at most
 * +-2.0, times the operator's gain */
static inline int32_t dx7_ext_at(const int32_t *x, unsigned xn, unsigned i)
{
    int32_t s = x[i < xn ? i : xn - 1u];
    s = s > (2 << 16) ? (2 << 16) : s < -(2 << 16) ? -(2 << 16) : s;
    return s * 256;
}
static void dx7_k_ext(int32_t *o, const int32_t *x, unsigned xn, int32_t g1, int32_t g2, int add)
{
    int32_t dg = (g2 - g1 + (DX7_N >> 1)) >> DX7_LG_N, g = g1;
    unsigned i;
    for (i = 0; i < DX7_N; i++) {
        int32_t y;
        g += dg;
        y = (int32_t)(((int64_t)dx7_ext_at(x, xn, i) * g) >> 24);
        o[i] = add ? o[i] + y : y;
    }
}

/* ------------------------------------------------------------------ the algorithm (fm_core.cc) */

#define DX7_LEVEL_THRESH 1120

/* FM-1: algorithms 4 and 6 as the DX7's OPS chip computes them: the k operators of the loop (6, 5, 4 or 6, 5) in turn
 * every sample, operator 6 modulated by the average of the last two outputs of the loop's last operator (the chip's
 * feedback register: footnote 5 of Ken Shirriff's "Yamaha DX7 chip reverse-engineering, part 4"). The last operator
 * adds to the voice. An operator below the level threshold gives 0, as msfa's empty bus does. */
static void dx7_loop(int32_t *out, dx7_op_t *p, int k, const int32_t *g1, const int32_t *g2, const uint8_t *on,
                     int32_t *fb, int shift, const int32_t *const *x, unsigned xn)
{
    int32_t g[3], dg[3], ph[3], y0 = fb[0], y = fb[1];
    int i, j;
    for (j = 0; j < k; j++) {
        dg[j] = (g2[j] - g1[j] + (DX7_N >> 1)) >> DX7_LG_N;
        g[j] = g1[j];
        ph[j] = p[j].phase;
    }
    for (i = 0; i < DX7_N; i++) {
        int32_t v = shift < 16 ? (y0 + y) >> (shift + 1) : 0;
        for (j = 0; j < k; j++) {
            g[j] += dg[j];
            if (!on[j])
                v = 0;
            else if (x[j])
                v = (int32_t)(((int64_t)dx7_ext_at(x[j], xn, (unsigned)i) * g[j]) >> 24);
            else
                v = (int32_t)(((int64_t)dx7_sin(dx7_wrap(ph[j], v)) * g[j]) >> 24);
            ph[j] = dx7_wrap(ph[j], p[j].freq);
        }
        out[i] += v;
        y0 = y;
        y = v;
    }
    if (shift < 16) {                                 /* (no feedback: the history stays, as msfa's) */
        fb[0] = y0;
        fb[1] = y;
    }
}

/* the six operators into out (added), operator 6 first. bus: two 64-sample buses. x[5 - op]: operator op + 1's outside
 * signal or 0 */
static void dx7_core(int32_t *out, dx7_op_t *p, int alg, int32_t *fb, int shift, int32_t *bus,
                     const int32_t *const *x, unsigned xn)
{
    const uint8_t *a = DX7_ALG[alg];
    uint8_t has[3] = {1, 0, 0};
    int op = 0;
    if (alg == 3 || alg == 5) {                       /* FM-1: algorithms 4 and 6, the loop */
        int32_t g1[3], g2[3];
        uint8_t on[3];
        const int32_t *lx[3];
        int k = alg == 3 ? 3 : 2;
        for (op = 0; op < k; op++) {
            g1[op] = p[op].gain_out;
            g2[op] = dx7_exp2(p[op].level_in - (14 << 24));
            p[op].gain_out = g2[op];
            on[op] = g1[op] >= DX7_LEVEL_THRESH || g2[op] >= DX7_LEVEL_THRESH;
            lx[op] = x[5 - op];
        }
        dx7_loop(out, p, k, g1, g2, on, fb, shift, lx, xn);
        for (op = 0; op < k; op++)
            p[op].phase = dx7_wrap(p[op].phase, (int32_t)((uint32_t)p[op].freq << DX7_LG_N));
    }
    for (; op < 6; op++) {
        int flags = a[op], add = (flags & DX7_OUT_ADD) != 0, inbus = (flags >> 4) & 3, outbus = flags & 3;
        int32_t *o = outbus == 0 ? out : bus + (outbus - 1) * DX7_N;
        int32_t g1 = p[op].gain_out, g2 = dx7_exp2(p[op].level_in - (14 << 24));
        p[op].gain_out = g2;
        if (g1 >= DX7_LEVEL_THRESH || g2 >= DX7_LEVEL_THRESH) {
            if (!has[outbus])
                add = 0;
            if (x[5 - op])
                dx7_k_ext(o, x[5 - op], xn, g1, g2, add);
            else if (inbus == 0 || !has[inbus]) {
                if ((flags & 0xc0) == 0xc0 && shift < 16)
                    dx7_k_fb(o, p[op].phase, p[op].freq, g1, g2, fb, shift, add);
                else
                    dx7_k_pure(o, p[op].phase, p[op].freq, g1, g2, add);
            } else
                dx7_k_mod(o, bus + (inbus - 1) * DX7_N, p[op].phase, p[op].freq, g1, g2, add);
            has[outbus] = 1;
        } else if (!add)
            has[outbus] = 0;
        p[op].phase = dx7_wrap(p[op].phase, (int32_t)((uint32_t)p[op].freq << DX7_LG_N));
    }
}

/* ------------------------------------------------------------------ a note (dx7note.cc) */

typedef struct {
    dx7_env_t env[6];
    dx7_op_t op[6];
    dx7_penv_t penv;
    int32_t base[6];                       /* each operator's frequency, log2 Hz in Q24 */
    int32_t fb[2];
    int32_t key;                           /* the key's frequency, log2 Hz in Q24 (FM-1: the pitch input's) */
    uint8_t mode[6], ams[6];
    uint8_t alg, opsw, pmd, pms_i, amd, init;
    int8_t shift;
} dx7_note_t;

/* the modulation the controllers give (msfa Controllers, refreshed from the module's mod parameter) */
typedef struct {
    int32_t pitch_mod, amp_mod, eg_mod;
    int32_t bend;                          /* FM-1: the pitch input's move since the note started plus the tune, Q24 */
} dx7_ctl_t;

/* FM-1: 0.396 / ln 2 in Q24 and 0.0209 / 7 in Q32: Dexed's detune, 0.0209 * exp(-0.396 * octaves) / 7 */
#define DX7_DETUNE_K 9584945
#define DX7_DETUNE_C 12823545
/* FM-1: log2(e) * 12.2 in Q24, and log2(e) * 0.07 / 2^18 in Q24.16: Dexed's exp(sensamp / 262144 * 0.07 + 12.2) */
#define DX7_AMS_A 295293757
#define DX7_AMS_B 423577
#define DX7_LOGFREQ_C0 50857777            /* (1 << 24) * (log2(440) - 69 / 12): MIDI note 0 */
#define DX7_SEMI 1398101                   /* (1 << 24) / 12 */

static int32_t dx7_osc_freq(int32_t key, int mode, int coarse, int fine, int detune)
{
    int32_t lf;
    if (mode == 0) {
        int32_t e = dx7_exp2(-(int32_t)(((int64_t)key * DX7_DETUNE_K) >> 24));   /* Q24 */
        int64_t d = (((int64_t)key * (detune - 7) * e) >> 24) * DX7_DETUNE_C;
        lf = key + (int32_t)(d >> 32);
        lf += DX7_COARSE[coarse & 31];
        if (fine)
            lf += DX7_FINE[fine];
    } else {
        lf = (4458616 * ((coarse & 3) * 100 + fine)) >> 3;   /* ((1 << 24) log2(10) / 100) << 3 */
        lf += detune > 7 ? 13457 * (detune - 7) : 0;
    }
    return lf;
}

static int dx7_scale_vel(int velocity, int sens)
{
    int v = DX7_VELOCITY[dx7_max(0, dx7_min(127, velocity)) >> 1] - 239;
    return ((sens * v + 7) >> 3) * 16;
}

static int dx7_scale_rate(int note, int sens)
{
    return (sens * dx7_min(31, dx7_max(0, note / 3 - 7))) >> 3;
}

static int dx7_scale_curve(int group, int depth, int curve)
{
    int scale = curve == 0 || curve == 3 ? (group * depth * 329) >> 12
                                         : (DX7_EXP_SCALE[dx7_min(group, 32)] * depth * 329) >> 15;
    return curve < 2 ? -scale : scale;
}

static int dx7_scale_level(int note, int bp, int ld, int rd, int lc, int rc)
{
    int off = note - bp - 17;
    return off >= 0 ? dx7_scale_curve((off + 1) / 3, rd, rc) : dx7_scale_curve(-(off - 1) / 3, ld, lc);
}

/* operator o's envelope level and frequency for this note (shared by dx7_note_init and dx7_note_update) */
static int dx7_outlevel(const uint8_t *v, int o, int note, int velocity)
{
    const uint8_t *q = v + o * 21;
    int lv = dx7_scaleout(q[16]) + dx7_scale_level(note, q[8], q[9], q[10], q[11], q[12]);
    lv = dx7_min(127, lv) * 32;
    lv += dx7_scale_vel(velocity, q[15]);
    return dx7_max(0, lv);
}

static void dx7_note_common(dx7_note_t *n, const uint8_t *v)
{
    int fbl = v[135];
    n->alg = v[134];
    n->shift = (int8_t)(fbl != 0 ? 8 - fbl : 16);
    n->pmd = (uint8_t)((v[139] * 165) >> 6);
    n->pms_i = v[143] & 7;
    n->amd = (uint8_t)((v[140] * 165) >> 6);
    n->opsw = v[155];
}

/* v: the unpacked voice; key: the key's frequency (log2 Hz, Q24); note: the key (0..127) for the scaling */
static void dx7_note_init(dx7_note_t *n, const uint8_t *v, int32_t key, int note, int velocity)
{
    int op;
    n->init = 1;
    n->key = key;
    for (op = 0; op < 6; op++) {
        const uint8_t *q = v + op * 21;
        dx7_env_init(&n->env[op], q, dx7_outlevel(v, op, note, velocity), dx7_scale_rate(note, q[13]));
        n->mode[op] = q[17];
        n->base[op] = dx7_osc_freq(key, q[17], q[18], q[19], q[20]);
        n->ams[op] = q[14] & 3;
    }
    dx7_penv_set(&n->penv, v + 126);
    dx7_note_common(n, v);
}

/* msfa Dx7Note::update: the voice changed while the note sounds */
static void dx7_note_update(dx7_note_t *n, const uint8_t *v, int note, int velocity)
{
    int op;
    for (op = 0; op < 6; op++) {
        const uint8_t *q = v + op * 21;
        n->base[op] = dx7_osc_freq(n->key, q[17], q[18], q[19], q[20]);
        n->ams[op] = q[14] & 3;
        n->mode[op] = q[17];
        dx7_env_update(&n->env[op], q, dx7_outlevel(v, op, note, velocity), dx7_scale_rate(note, q[13]));
    }
    dx7_note_common(n, v);
}

static void dx7_note_keyup(dx7_note_t *n)
{
    int op;
    for (op = 0; op < 6; op++)
        dx7_env_keydown(&n->env[op], 0);
    dx7_penv_keydown(&n->penv, 0);
}

static void dx7_note_sync(dx7_note_t *n)             /* oscillator key sync */
{
    int i;
    for (i = 0; i < 6; i++) {
        n->op[i].gain_out = 0;
        n->op[i].phase = 0;
    }
}

static int dx7_note_playing(const dx7_note_t *n)     /* any carrier's envelope still active */
{
    int i;
    if (!n->init)
        return 0;
    for (i = 0; i < 6; i++)
        if ((DX7_ALG[n->alg][i] & DX7_OUT_ADD) && dx7_env_active(&n->env[i]))
            return 1;
    return 0;
}

/* one 64-sample block of the note, added to buf (Q24) */
static void dx7_note_compute(dx7_note_t *n, int32_t *buf, int32_t lfo_val, int32_t lfo_delay, const dx7_ctl_t *c,
                             int32_t *bus, const int32_t *const *x, unsigned xn)
{
    uint32_t pmd = (uint32_t)n->pmd * (uint32_t)lfo_delay;          /* Q32 */
    int32_t senslfo = DX7_PMS[n->pms_i] * (lfo_val - (1 << 23));
    int32_t pm1 = (int32_t)(((int64_t)pmd * (int64_t)senslfo) >> 39), pm2, pitch_mod;
    uint32_t am1, am2, amd, am3;
    int op;
    pm1 = pm1 < 0 ? -pm1 : pm1;
    pm2 = (int32_t)(((int64_t)c->pitch_mod * (int64_t)senslfo) >> 14);
    pm2 = pm2 < 0 ? -pm2 : pm2;
    pitch_mod = dx7_max(pm1, pm2);
    pitch_mod = dx7_penv_sample(&n->penv) + (pitch_mod * (senslfo < 0 ? -1 : 1));
    pitch_mod += c->bend;                              /* FM-1: msfa's pitch bend and master tune */

    lfo_val = (1 << 24) - lfo_val;
    am1 = (uint32_t)(((int64_t)n->amd * (int64_t)lfo_delay) >> 8);
    am1 = (uint32_t)(((int64_t)am1 * (int64_t)lfo_val) >> 24);
    am2 = (uint32_t)(((int64_t)c->amp_mod * (int64_t)lfo_val) >> 7);
    amd = am1 > am2 ? am1 : am2;
    am3 = (uint32_t)(c->eg_mod + 1) << 17;
    amd = (1u << 24) - am3 > amd ? (1u << 24) - am3 : amd;

    for (op = 0; op < 6; op++) {
        if (!(n->opsw & (1u << op))) {
            dx7_env_sample(&n->env[op]);               /* the envelope runs on while the operator is off */
            n->op[op].level_in = 0;
        } else {
            int32_t level;
            n->op[op].freq = dx7_freq(n->base[op] + (n->mode[op] ? c->bend : pitch_mod));
            level = dx7_env_sample(&n->env[op]);
            if (n->ams[op]) {
                uint32_t sensamp = (uint32_t)(((uint64_t)amd * (uint64_t)DX7_AMS[n->ams[op]]) >> 24);
                int32_t xx = DX7_AMS_A + (int32_t)(((int64_t)sensamp * DX7_AMS_B) >> 16);   /* log2, Q24 */
                uint32_t pt = (uint32_t)dx7_exp2(xx & 0xFFFFFF) >> (24 - (xx >> 24));
                uint32_t ldiff = (uint32_t)(((uint64_t)level * ((uint64_t)pt << 4)) >> 28);
                level -= (int32_t)ldiff;
            }
            n->op[op].level_in = level;
        }
    }
    dx7_core(buf, n->op, n->alg, n->fb, n->shift, bus, x, xn);
}

/* ------------------------------------------------------------------ the voice (patch.cc UnpackPatch) */

/* a packed voice (128 bytes) into msfa's form (156: the operator switches, byte 155, all on) */
static void dx7_unpack(const uint8_t *b, uint8_t *o)
{
    int op, i;
    for (op = 0; op < 6; op++) {
        const uint8_t *s = b + op * 17;
        uint8_t *d = o + op * 21;
        for (i = 0; i < 11; i++)
            d[i] = s[i] & 0x7f;
        d[11] = s[11] & 3;
        d[12] = (s[11] >> 2) & 3;
        d[13] = s[12] & 7;
        d[20] = (s[12] >> 3) & 15;
        d[14] = s[13] & 3;
        d[15] = (s[13] >> 2) & 7;
        d[16] = s[14] & 0x7f;
        d[17] = s[15] & 1;
        d[18] = (s[15] >> 1) & 31;
        d[19] = s[16] & 0x7f;
    }
    for (i = 0; i < 9; i++)
        o[126 + i] = b[102 + i] & 0x7f;
    o[135] = b[111] & 7;
    o[136] = (b[111] >> 3) & 1;
    for (i = 0; i < 4; i++)
        o[137 + i] = b[112 + i] & 0x7f;
    o[141] = b[116] & 1;
    o[142] = (b[116] >> 1) & 7;
    o[143] = (b[116] >> 4) & 7;
    for (i = 0; i < 11; i++)
        o[144 + i] = b[117 + i] & 0x7f;
    o[155] = 0x3f;
}

/* FM-1: every value into the DX7's range, so a voice from anywhere indexes no table past its end */
static const uint8_t DX7_RANGE[21] = {99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14};
static const uint8_t DX7_RANGE_G[12] = {99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99};   /* 126..137 */
static void dx7_clamp(uint8_t *o)
{
    int op, i;
    for (op = 0; op < 6; op++)
        for (i = 0; i < 21; i++)
            if (o[op * 21 + i] > DX7_RANGE[i])
                o[op * 21 + i] = DX7_RANGE[i];
    for (i = 0; i < 12; i++)
        if (o[126 + i] > DX7_RANGE_G[i])
            o[126 + i] = DX7_RANGE_G[i];
    for (i = 138; i < 141; i++)                      /* LFO delay, PMD, AMD */
        if (o[i] > 99)
            o[i] = 99;
    if (o[142] > 5)                                  /* the LFO wave */
        o[142] = 5;
    if (o[144] > 48)                                 /* transpose */
        o[144] = 48;
}

/* ------------------------------------------------------------------ one copy of the module (engine.c m_dx7) */

/* everything a copy keeps (its line in the engine's arena) */
typedef struct {
    dx7_note_t note;
    dx7_lfo_t lfo;
    int32_t bus[2 * DX7_N];
    int32_t ob[DX7_N];                     /* the block being played, Q16 before the level */
    int32_t pitch0;                        /* the pitch input when the note started, Q16 */
    uint8_t v[DX7_UNPACKED];               /* the unpacked voice */
    uint8_t pos;                           /* samples of ob played (DX7_N: none left) */
    uint8_t seen;                          /* samples of ob whose gate was read when it was made */
    uint8_t gate, live, note_key, vel;
} dx7_t;

/* what one call reads: Q16 signals (0 = not cabled) and the module's effective parameters */
typedef struct {
    const int32_t *pitch, *gate, *vel, *x[6];
    int32_t level, tune, mod, range, dest, ops;   /* Q16 (range, dest, ops: whole numbers in Q16; ops bit k: operator k + 1) */
    uint32_t t;                            /* the engine's samples since the patch loaded, at this call's sample 0 */
} dx7_io_t;

/* a new or edited voice (packed, 128 bytes); the operator switches (byte 155) stay as they are */
static void dx7_set_voice(dx7_t *s, const uint8_t *packed)
{
    uint8_t sw = s->v[155];
    dx7_unpack(packed, s->v);
    dx7_clamp(s->v);
    s->v[155] = sw;
    dx7_lfo_reset(&s->lfo, s->v + 137);
    if (s->live)
        dx7_note_update(&s->note, s->v, s->note_key, s->vel);
}

static void dx7_init(dx7_t *s, const uint8_t *packed)   /* s zeroed */
{
    s->pos = DX7_N;
    s->seen = DX7_N;
    s->v[155] = 0x3f;
    dx7_set_voice(s, packed);
}

static inline int32_t dx7_whole(int32_t q16) { return (q16 + 32768) >> 16; }

/* a gate edge at input sample i */
static void dx7_edge(dx7_t *s, const dx7_io_t *io, unsigned i, int up)
{
    if (up) {
        int32_t p = io->pitch ? io->pitch[i] : 0, key;
        int note, vel;
        p = p < -(5 << 16) ? -(5 << 16) : p > 365909 ? 365909 : p;   /* MIDI notes 0 .. 127 (C4 = 60) */
        note = (int)((p * 12 + 32768) >> 16) + 60 + s->v[144] - 24;
        key = DX7_LOGFREQ_C0 + 60 * DX7_SEMI + p * 256 + (s->v[144] - 24) * DX7_SEMI;
        vel = io->vel ? dx7_whole(dx7_max(0, dx7_min(65536, io->vel[i])) * 127) : DX7_VEL_NONE;
        s->pitch0 = p;
        s->note_key = (uint8_t)dx7_max(0, dx7_min(127, note));
        s->vel = (uint8_t)dx7_max(0, dx7_min(127, vel));
        dx7_note_init(&s->note, s->v, key, s->note_key, s->vel);
        if (s->v[136])
            dx7_note_sync(&s->note);
        dx7_lfo_keydown(&s->lfo, s->lfo.delta * ((io->t + i) >> DX7_LG_N));
        s->live = 1;
    } else if (s->note.init)
        dx7_note_keyup(&s->note);
    s->gate = (uint8_t)up;
}

static void dx7_scan(dx7_t *s, const dx7_io_t *io, unsigned from, unsigned to)   /* gate edges in [from, to) */
{
    unsigned i;
    if (!io->gate) {
        if (s->gate)
            dx7_edge(s, io, from, 0);
        return;
    }
    for (i = from; i < to; i++) {
        int g = io->gate[i] > 32768;
        if (g != s->gate)
            dx7_edge(s, io, i, g);
    }
}

/* the next block into ob (Q16), from input sample i on; avail: the samples of the block this call has (1..64) */
static void dx7_block(dx7_t *s, const dx7_io_t *io, unsigned i, unsigned avail)
{
    unsigned j;
    dx7_scan(s, io, i, i + avail);
    for (j = 0; j < DX7_N; j++)
        s->ob[j] = 0;
    if (s->live) {
        int32_t lv, ld, p = io->pitch ? io->pitch[i] : 0, d;
        const int32_t *x[6];
        dx7_ctl_t c;
        int cc = dx7_whole(dx7_max(0, dx7_min(65536, io->mod)) * 127), dest = dx7_whole(io->dest) + 1;
        int total = cc * dx7_max(0, dx7_min(99, dx7_whole(io->range))) / 100;   /* FM-1: whole numbers (Dexed: float) */
        c.pitch_mod = dest & 1 ? total : 0;
        c.amp_mod = dest & 2 ? total : 0;
        c.eg_mod = dest & 4 ? total : 127;
        d = p - s->pitch0;
        d = d < -(8 << 16) ? -(8 << 16) : d > (8 << 16) ? (8 << 16) : d;
        c.bend = d * 256 + (int32_t)(((int64_t)io->tune * 13981) >> 16);   /* cents: (1 << 24) / 1200 */
        for (j = 0; j < 6; j++)
            x[j] = io->x[j] ? io->x[j] + i : 0;
        lv = dx7_lfo_sample(&s->lfo);
        ld = dx7_lfo_delay(&s->lfo);
        dx7_note_compute(&s->note, s->ob, lv, ld, &c, s->bus, x, avail);
        for (j = 0; j < DX7_N; j++) {                 /* Dexed's clip to 16 bits; FM-1: then x 4 in Q16, so one carrier */
            int32_t val = s->ob[j] >> 4;              /* at 99 peaks at 0.5 (Dexed: 0.125), all six at 3.0 */
            s->ob[j] = (val < -(1 << 24) ? -0x8000 : val >= (1 << 24) ? 0x7fff : val >> 9) * 8;
        }
        if (!s->gate && !dx7_note_playing(&s->note))
            s->live = 0;
    }
    s->pos = 0;
    s->seen = (uint8_t)avail;
}

/* n samples (any count) into out, Q16. A block cut short by the end of a call is played on in the next; the gate
 * samples it had no input for are read as they come (their edges start the next block) */
static void dx7_run(dx7_t *s, const dx7_io_t *io, int32_t *out, unsigned n)
{
    unsigned i;
    int u = dx7_whole(io->ops), ops = 0, k;
    for (k = 0; k < 6; k++)                           /* (msfa's byte 155: bit 0 is operator 6) */
        ops |= ((u >> k) & 1) << (5 - k);
    if (s->v[155] != ops)
        s->v[155] = s->note.opsw = (uint8_t)ops;
    for (i = 0; i < n; i++) {
        if (s->pos == DX7_N)
            dx7_block(s, io, i, n - i < DX7_N ? n - i : DX7_N);
        else if (s->pos >= s->seen)
            dx7_scan(s, io, i, i + 1);
        out[i] = (int32_t)(((int64_t)s->ob[s->pos++] * io->level) >> 16);
    }
}

/* for the idle-part rule: a copy whose gate is low and whose carriers have all finished */
static int dx7_quiet(const dx7_t *s) { return !s->gate && !s->live; }
