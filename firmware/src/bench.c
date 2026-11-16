/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut
 * Modified for Matryoshka (glvno). */
/* CPU benchmark (#950): what one 128-frame block costs per kernel, fixed point against float, so the FPU question
 * (D-352) is ruled on measured numbers. Built only with M1_BENCH=1 (tools/build.py). FM1_FPU=1 builds the same kernels
 * for the AC791N's FPU (-mcpu=r3 -mfprev1, the toolchain's r3 libm); without it float is the toolchain's software float.
 * DIAG page BENCH_PAGE (main.c m1_diag) runs every kernel BENCH_RUNS times, each run one block with the interrupts off,
 * and answers the build and the clock probe; page BENCH_PAGE + 1 + k answers kernel k: its fastest and slowest run in
 * 24 MHz ticks, its result's bits, the operations it chains per sample and its name (tools/m1_link.py fpubench prints
 * cycles per sample). The audio interrupt waits while a run lasts (under 2 ms): the overload guard may drop a voice.
 * Every input comes from a volatile or a buffer, so the compiler cannot fold a kernel away; every buffer is in NOINIT
 * (RAM has no room for them) and is set by bench_prepare before the runs. */
#define BENCH_N 128u
#define BENCH_RUNS 8u
#define BENCH_PAGE 178u
#define BENCH_VERSION 1u
#define BENCH_MAGIC 1178748482u
#ifndef M1_FPU
#define M1_FPU 0
#endif

float sinf(float);
float cosf(float);
float expf(float);
float log2f(float);
float exp2f(float);

static volatile float bench_vf[8] ENG_NOINIT;
static volatile int32_t bench_vi[4] ENG_NOINIT;
static esig_t bench_in[BENCH_N] ENG_NOINIT, bench_out[BENCH_N] ENG_NOINIT;       /* Q16 */
static float bench_inf[BENCH_N] ENG_NOINIT, bench_outf[BENCH_N] ENG_NOINIT, bench_zero[BENCH_N] ENG_NOINIT;
static float bench_arg[4][64] ENG_NOINIT;      /* arguments: sin / cos, exp, log2, exp2 */
static int32_t bench_pitch[64] ENG_NOINIT;     /* bench_arg[3] as Q16 octaves */
static float bench_bq[6] ENG_NOINIT;           /* DELAY_AA[0] as float */
static int32_t bench_rq[3][6] ENG_NOINIT;      /* six modes: g, c1, c2 (Q30) */
static float bench_rf[3][6] ENG_NOINIT;
static uint32_t bench_res[48][3] ENG_NOINIT;   /* per kernel: fastest run, slowest run (ticks), the result's bits */
static uint32_t bench_done ENG_NOINIT;

HOT uint32_t bf2u(float f) { union { float f; uint32_t u; } x; x.f = f; return x.u; }
HOT float bu2f(uint32_t u) { union { float f; uint32_t u; } x; x.u = u; return x.f; }

/* ---- the loop and the float operations, each a dependent chain (ops per sample in BENCH[]) */

static uint32_t k_loop(void)                              /* a block loop: one load and one add a sample */
{
    uint32_t i, s = (uint32_t)bench_vi[0];
    for (i = 0; i < BENCH_N; i++)
        s += (uint32_t)bench_in[i];
    return s;
}

static uint32_t k_fadd8(void)
{
    float a = bench_vf[7], b = bench_vf[3];
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        a = a + b; a = a + b; a = a + b; a = a + b;
        a = a - b; a = a - b; a = a - b; a = a - b;
    }
    return bf2u(a);
}

static uint32_t k_fmul8(void)
{
    float a = bench_vf[0], b = bench_vf[1], c = bench_vf[2];
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        a = a * b; a = a * b; a = a * b; a = a * b;
        a = a * c; a = a * c; a = a * c; a = a * c;
    }
    return bf2u(a);
}

static uint32_t k_fdiv4(void)
{
    float a = bench_vf[7], b = bench_vf[1];
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        a = b / a; a = b / a; a = b / a; a = b / a;
    }
    return bf2u(a);
}

static uint32_t k_fmac4(void)                             /* c * a + b: a multiply, then an add (never fused) */
{
    float a = bench_vf[0], b = bench_vf[4], c = 0.0f;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        c = c * a + b; c = c * a + b; c = c * a + b; c = c * a + b;
    }
    return bf2u(c);
}

static uint32_t k_i2f4(void)                              /* int -> float; the bits xored (one integer op each) */
{
    int32_t n = bench_vi[0], d = bench_vi[1];
    uint32_t i, s = 0;
    for (i = 0; i < BENCH_N; i++) {
        s ^= bf2u((float)n); n += d;
        s ^= bf2u((float)n); n += d;
        s ^= bf2u((float)n); n += d;
        s ^= bf2u((float)n); n += d;
    }
    return s;
}

static uint32_t k_f2i4(void)                              /* float -> int (truncating); the float stepped by its bits */
{
    uint32_t i, b = bf2u(bench_vf[7] * 4096.0f), s = 0;
    for (i = 0; i < BENCH_N; i++) {
        s += (uint32_t)(int32_t)bu2f(b); b += 4099u;
        s += (uint32_t)(int32_t)bu2f(b); b += 4099u;
        s += (uint32_t)(int32_t)bu2f(b); b += 4099u;
        s += (uint32_t)(int32_t)bu2f(b); b += 4099u;
    }
    return s;
}

static uint32_t k_fadd8_sub(void)                         /* k_fadd8 on subnormal numbers (in and out) */
{
    float a = bench_vf[5], b = bench_vf[6];
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        a = a + b; a = a + b; a = a + b; a = a + b;
        a = a - b; a = a - b; a = a - b; a = a - b;
    }
    return bf2u(a);
}

static uint32_t k_fmul8_sub(void)                         /* k_fmul8 on a subnormal number (the result stays subnormal) */
{
    float a = bench_vf[5], b = bench_vf[1], c = bench_vf[2];
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        a = a * b; a = a * b; a = a * b; a = a * b;
        a = a * c; a = a * c; a = a * c; a = a * c;
    }
    return bf2u(a);
}

static uint32_t k_imul8(void)                             /* 32-bit integer multiplies, for scale */
{
    uint32_t i, x = (uint32_t)bench_vi[0] | 1u, m = (uint32_t)bench_vi[2];
    for (i = 0; i < BENCH_N; i++) {
        x *= m; x *= m; x *= m; x *= m;
        x *= m; x *= m; x *= m; x *= m;
    }
    return x;
}

static uint32_t k_mulq4(void)                             /* the engine's Q multiply: 32 x 32 -> 64 bits, shifted */
{
    int32_t x = bench_vi[3], k = bench_vi[1] * 2 + 65535 - 2 * 23456;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        x = mulq(x, k, 16); x = mulq(x, k, 16); x = mulq(x, k, 16); x = mulq(x, k, 16);
    }
    return (uint32_t)x;
}

/* ---- the toolchain's libm, one call a sample */

static uint32_t k_sinf(void)
{
    float s = 0.0f;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        s += sinf(bench_arg[0][i & 63u]);
    return bf2u(s);
}

static uint32_t k_cosf(void)
{
    float s = 0.0f;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        s += cosf(bench_arg[0][i & 63u]);
    return bf2u(s);
}

static uint32_t k_expf(void)
{
    float s = 0.0f;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        s += expf(bench_arg[1][i & 63u]);
    return bf2u(s);
}

static uint32_t k_log2f(void)
{
    float s = 0.0f;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        s += log2f(bench_arg[2][i & 63u]);
    return bf2u(s);
}

/* ---- exp2 for a phase increment (INC_C4 2^octaves), as the oscillators need it every sample */

static uint32_t k_exp2_q(void)                            /* the engine's exp2_scale */
{
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        bench_out[i] = (int32_t)exp2_scale(INC_C4, bench_pitch[i & 63u]);
    return (uint32_t)bench_out[BENCH_N - 1u];
}

static uint32_t k_exp2f(void)                             /* libm's exp2f (newlib: powf) */
{
    const float c4 = (float)INC_C4;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        bench_outf[i] = c4 * exp2f(bench_arg[3][i & 63u]);
    return bf2u(bench_outf[BENCH_N - 1u]);
}

static uint32_t k_exp2_e(void)                            /* exp2 as libm's expf(x ln 2) */
{
    const float c4 = (float)INC_C4;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        bench_outf[i] = c4 * expf(bench_arg[3][i & 63u] * 0.693147181f);
    return bf2u(bench_outf[BENCH_N - 1u]);
}

/* 2^x: the integer part into the exponent, the fraction by a degree-5 polynomial (relative error under 1e-7 in exact
 * arithmetic); what a float engine would write instead of a libm call */
HOT float bench_exp2p(float x)
{
    int32_t n = (int32_t)x;
    float f;
    if ((float)n > x)
        n--;
    f = x - (float)n;
    f = 1.0f + f * (0.693151363f + f * (0.240164154f + f * (0.0558004468f + f * (0.00901668796f + f * 0.00186718273f))));
    return bu2f(bf2u(f) + ((uint32_t)n << 23));
}

static uint32_t k_exp2_p(void)
{
    const float c4 = (float)INC_C4;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++)
        bench_outf[i] = c4 * bench_exp2p(bench_arg[3][i & 63u]);
    return bf2u(bench_outf[BENCH_N - 1u]);
}

/* ---- the engine's kernels against the same job in float, a block from a buffer to a buffer */

static uint32_t k_bq_q(void)                              /* two biquad sections: the engine's dly_aa, every 2nd sample out */
{
    int32_t lp[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    dly_aa(lp, DELAY_AA[0], bench_in, BENCH_N, 0u, 2u, bench_out);
    return (uint32_t)lp[6];
}

static uint32_t k_bq_f(void)                              /* dly_aa in float: the same coefficients, clamp and output */
{
    const float c0 = bench_bq[0], c1 = bench_bq[1], c2 = bench_bq[2], c3 = bench_bq[3], c4 = bench_bq[4], c5 = bench_bq[5];
    float x1 = 0.0f, x2 = 0.0f, u1 = 0.0f, u2 = 0.0f, y1 = 0.0f, y2 = 0.0f, *ys = bench_outf;
    uint32_t i, ph = 0, k = 2;
    for (i = 0; i < BENCH_N; i++) {
        float x = bench_inf[i], u, y;
        x = x > 4.0f ? 4.0f : x < -4.0f ? -4.0f : x;
        u = c0 * (x + 2.0f * x1 + x2) - c1 * u1 - c2 * u2;
        y = c3 * (u + 2.0f * u1 + u2) - c4 * y1 - c5 * y2;
        x2 = x1; x1 = x; u2 = u1; u1 = u; y2 = y1; y1 = y;
        if (ph == k - 1u) {
            *ys++ = y;
            ph = 0;
        } else
            ph++;
    }
    return bf2u(y1);
}

static uint32_t k_res_q(void)                             /* six two-pole modes a sample: m_modal's MODE, word for word */
{
    const int32_t *g = bench_rq[0], *c1 = bench_rq[1], *c2 = bench_rq[2];
    int32_t a1[6] = {0, 0, 0, 0, 0, 0}, a2[6] = {0, 0, 0, 0, 0, 0};
    uint32_t k;
    for (k = 0; k < BENCH_N; k++) {
        int32_t x20 = bench_in[k] << 4, y = 0, v;
#define MODE(i)                                                                                             \
        v = clampi(mulr(g[i], x20, 30) + mulr(c1[i], a1[i], 30) - mulr(c2[i], a2[i], 30), -(8 << 20), 8 << 20); \
        a2[i] = a1[i];                                                                                      \
        a1[i] = v;                                                                                          \
        y += v;
        MODE(0) MODE(1) MODE(2) MODE(3) MODE(4) MODE(5)
#undef MODE
        bench_out[k] = (y + 8) >> 4;
    }
    return (uint32_t)a1[0];
}

/* the six modes in float (no clamp: float does not wrap) from in, the states starting at s0; off: the input plus a
 * constant offset (OpenPocket's way to keep a decaying filter out of the subnormal range) */
HOT uint32_t bench_res_f(const float *in, float s0, int off)
{
    const float *g = bench_rf[0], *c1 = bench_rf[1], *c2 = bench_rf[2];
    float a1[6], a2[6], o = bench_vf[6] * 1.0e25f;    /* 1e-15 */
    uint32_t i, k;
    for (i = 0; i < 6u; i++)
        a1[i] = a2[i] = s0;
    for (k = 0; k < BENCH_N; k++) {
        float x = off ? in[k] + o : in[k], y = 0.0f, v;
#define MODE(i)                                                                                             \
        v = g[i] * x + c1[i] * a1[i] - c2[i] * a2[i];                                                       \
        a2[i] = a1[i];                                                                                      \
        a1[i] = v;                                                                                          \
        y += v;
        MODE(0) MODE(1) MODE(2) MODE(3) MODE(4) MODE(5)
#undef MODE
        bench_outf[k] = y;
    }
    return bf2u(a1[0]);
}

static uint32_t k_res_f(void) { return bench_res_f(bench_inf, 0.0f, 0); }
static uint32_t k_res_f_sub(void) { return bench_res_f(bench_zero, bench_vf[5], 0); }     /* a silent tail, subnormal */
static uint32_t k_res_f_off(void) { return bench_res_f(bench_zero, bench_vf[5], 1); }     /* the same with the offset */

static uint32_t k_op_q(void)                              /* a one-pole, m_noise's: Q16 coefficient, Q24 state */
{
    int32_t y = 0, k = bench_vi[1] - 23456 + 2048;
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        y += mulq(k, (bench_in[i] << 8) - y, 16);
        bench_out[i] = (y + 128) >> 8;
    }
    return (uint32_t)y;
}

static uint32_t k_op_f(void)
{
    float y = 0.0f, k = bench_vf[3] * 31.25f;             /* 1 / 32 */
    uint32_t i;
    for (i = 0; i < BENCH_N; i++) {
        y += k * (bench_inf[i] - y);
        bench_outf[i] = y;
    }
    return bf2u(y);
}

/* ---- the kernels of the first benchmark (docs/ARCHITECTURE.md "Measured CPU budget"), the same jobs */

static uint32_t k_osc_q(void)                             /* phase accumulator + parabolic sine, Q15 */
{
    uint32_t i, ph = 12345u, inc = 1787529u;
    int32_t s = 0;
    for (i = 0; i < BENCH_N; i++) {
        int32_t x, a;
        ph += inc;
        x = (int32_t)ph >> 16;                            /* -1..1, Q15 */
        a = x < 0 ? -x : x;
        s += (x * (32768 - a)) >> 13;                     /* 4 x (1 - |x|) */
    }
    return (uint32_t)s;
}

static uint32_t k_mul_q(void)                             /* 4 Q15 multiply-adds per frame (gain, mix, ...) */
{
    uint32_t i;
    int32_t a = bench_vi[0], b = bench_vi[1], c = 0;
    for (i = 0; i < BENCH_N; i++) {
        c = (c * a >> 15) + b;
        c = (c * a >> 15) + b;
        c = (c * a >> 15) + b;
        c = (c * a >> 15) + b;
        c &= 32767;
    }
    return (uint32_t)c;
}

static uint32_t k_svf_q(void)                             /* state variable filter, Q15 */
{
    uint32_t i;
    int32_t low = 0, band = 0, f = 6000, q = 20000, in = bench_vi[0] - 2345;
    for (i = 0; i < BENCH_N; i++) {
        int32_t high;
        low += (f * band) >> 15;
        high = in - low - ((q * band) >> 15);
        band += (f * high) >> 15;
        in = -in;
    }
    return (uint32_t)(low + band);
}

static uint32_t k_osc_f(void)                             /* the same oscillator in float */
{
    uint32_t i;
    float ph = bench_vf[0] - 0.27f, inc = 0.0123f, s = 0.0f;
    for (i = 0; i < BENCH_N; i++) {
        float x, a;
        ph += inc;
        if (ph >= 1.0f)
            ph -= 1.0f;
        x = ph * 2.0f - 1.0f;
        a = x < 0.0f ? -x : x;
        s += 4.0f * x * (1.0f - a);
    }
    return bf2u(s);
}

static uint32_t k_mul_f(void)
{
    uint32_t i;
    float a = bench_vf[0], b = bench_vf[4], c = 0.0f;
    for (i = 0; i < BENCH_N; i++) {
        c = c * a + b;
        c = c * a + b;
        c = c * a + b;
        c = c * a + b;
        if (c > 1.0f)
            c -= 1.0f;
    }
    return bf2u(c);
}

static uint32_t k_svf_f(void)
{
    uint32_t i;
    float low = 0.0f, band = 0.0f, f = 0.18f, q = 0.6f, in = bench_vf[7] - 0.2f;
    for (i = 0; i < BENCH_N; i++) {
        float high;
        low += f * band;
        high = in - low - q * band;
        band += f * high;
        in = -in;
    }
    return bf2u(low + band);
}

static uint32_t k_f2i(void)                               /* float -> int16 at the output, per frame */
{
    uint32_t i;
    float x = bench_vf[7] - 1.4f;
    int32_t s = 0;
    for (i = 0; i < BENCH_N; i++) {
        s += (int32_t)(x * 32767.0f);
        x += 0.0141f;
    }
    return (uint32_t)s;
}

typedef struct {
    const char *name;                                     /* at most 19 characters (the DIAG page) */
    uint32_t (*fn)(void);
    uint8_t ops;                                          /* operations chained per sample (per-op cost = time / ops) */
} bench_t;
static const bench_t BENCH[] = {
    {"loop ld+add", k_loop, 1},
    {"f add x8", k_fadd8, 8}, {"f mul x8", k_fmul8, 8}, {"f div x4", k_fdiv4, 4}, {"f mul+add x4", k_fmac4, 4},
    {"i2f x4", k_i2f4, 4}, {"f2i x4", k_f2i4, 4},
    {"f add x8 subnormal", k_fadd8_sub, 8}, {"f mul x8 subnormal", k_fmul8_sub, 8},
    {"i mul x8", k_imul8, 8}, {"q mul64 x4", k_mulq4, 4},
    {"sinf", k_sinf, 1}, {"cosf", k_cosf, 1}, {"expf", k_expf, 1}, {"log2f", k_log2f, 1},
    {"exp2 q exp2_scale", k_exp2_q, 1}, {"exp2 f exp2f", k_exp2f, 1}, {"exp2 f expf", k_exp2_e, 1},
    {"exp2 f poly5", k_exp2_p, 1},
    {"biquad x2 q dly_aa", k_bq_q, 2}, {"biquad x2 f", k_bq_f, 2},
    {"res x6 q modal", k_res_q, 6}, {"res x6 f", k_res_f, 6},
    {"res x6 f subnormal", k_res_f_sub, 6}, {"res x6 f sub+offset", k_res_f_off, 6},
    {"onepole q", k_op_q, 1}, {"onepole f", k_op_f, 1},
    {"osc q15 (2026-10)", k_osc_q, 1}, {"osc f (2026-10)", k_osc_f, 1},
    {"mac4 q15 (2026-10)", k_mul_q, 4}, {"mac4 f (2026-10)", k_mul_f, 4},
    {"svf q15 (2026-10)", k_svf_q, 1}, {"svf f (2026-10)", k_svf_f, 1},
    {"f2i out (2026-10)", k_f2i, 1},
};
#define BENCH_K (sizeof BENCH / sizeof BENCH[0])
typedef char bench_fits[BENCH_K <= sizeof bench_res / sizeof bench_res[0] && BENCH_PAGE + BENCH_K < 256u ? 1 : -1];

static void bench_prepare(void)
{
    uint32_t i, j;
    bench_vf[0] = 0.37f;
    bench_vf[1] = 1.0001f;
    bench_vf[2] = 0.9999f;
    bench_vf[3] = 0.001f;
    bench_vf[4] = 0.71f;
    bench_vf[5] = 1.0e-39f;                               /* subnormal (below 1.18e-38) */
    bench_vf[6] = 1.0e-40f;
    bench_vf[7] = 0.5f;
    bench_vi[0] = 12345;
    bench_vi[1] = 23456;
    bench_vi[2] = 65537;
    bench_vi[3] = 1 << 28;
    for (i = 0; i < BENCH_N; i++) {
        bench_in[i] = (int32_t)((i * 2053u) & 65535u) - 32768;   /* a saw-like signal within +-0.5 */
        bench_inf[i] = (float)bench_in[i] * (1.0f / 65536.0f);
        bench_zero[i] = 0.0f;
    }
    for (j = 0; j < 64u; j++) {
        float t = (float)j * (1.0f / 64.0f);
        bench_arg[0][j] = -3.1f + 6.2f * t;
        bench_arg[1][j] = -10.0f + 20.0f * t;
        bench_arg[2][j] = 0.001f + 1000.0f * t * t;
        bench_arg[3][j] = -4.0f + 8.0f * t;
        bench_pitch[j] = (int32_t)(bench_arg[3][j] * 65536.0f);
    }
    for (i = 0; i < 6u; i++)
        bench_bq[i] = (float)DELAY_AA[0][i] * (1.0f / 1073741824.0f);
    for (i = 0; i < 6u; i++) {                            /* modes at 220 Hz x (i + 1), r = 0.9995 */
        float th = 6.28318531f * 220.0f * (float)(i + 1u) / (float)ENG_SR, r = 0.9995f;
        bench_rf[0][i] = 0.2f * sinf(th);
        bench_rf[1][i] = 2.0f * r * cosf(th);
        bench_rf[2][i] = r * r;
        for (j = 0; j < 3u; j++)
            bench_rq[j][i] = (int32_t)(bench_rf[j][i] * 1073741824.0f);
    }
}

static void bench_run(uint32_t k)
{
    uint32_t r, t, lo = 0xFFFFFFFFu, hi = 0, res = 0;
    for (r = 0; r < BENCH_RUNS; r++) {
        fm1_wdt_feed();
        fm1_irq_off();
        t = fm1_ticks();
        res = BENCH[k].fn();
        t = fm1_ticks() - t;
        fm1_irq_on();
        lo = t < lo ? t : lo;
        hi = t > hi ? t : hi;
    }
    bench_res[k][0] = lo;
    bench_res[k][1] = hi;
    bench_res[k][2] = res;
}

/* main.c m1_diag: page BENCH_PAGE runs the benchmark and answers v[0] BENCH_VERSION, v[1] the kernel count, v[2] M1_FPU,
 * v[3] BENCH_N, v[4] BENCH_RUNS, v[5] / v[6] the clock probe's 16384 / 49152 dependent adds in ticks (hal/fm1_clock.h:
 * their difference gives the CPU cycles a tick), v[7] PLL2_CON1; page BENCH_PAGE + 1 + k: kernel k's fastest and slowest
 * run and result bits (three words), its ops (a byte) and name (19 bytes, zero padded); past the last kernel nothing */
static uint32_t bench_diag(uint32_t page, uint8_t *out)
{
    uint32_t v[8], i, k;
    if (page == BENCH_PAGE) {
        uint32_t c[8];
        bench_prepare();
        for (k = 0; k < BENCH_K; k++)
            bench_run(k);
        bench_done = BENCH_MAGIC;
        fm1_clock_probe(c);
        v[0] = BENCH_VERSION;
        v[1] = BENCH_K;
        v[2] = M1_FPU;
        v[3] = BENCH_N;
        v[4] = BENCH_RUNS;
        v[5] = c[3];
        v[6] = c[4];
        v[7] = c[0];
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    k = page - BENCH_PAGE - 1u;
    if (k >= BENCH_K || bench_done != BENCH_MAGIC)
        return 0;
    for (i = 0; i < 12u; i++)
        out[i] = (uint8_t)(bench_res[k][i / 4u] >> (8u * (i % 4u)));
    out[12] = BENCH[k].ops;
    for (i = 0; i < 19u; i++)
        out[13u + i] = 0;
    for (i = 0; i < 19u && BENCH[k].name[i]; i++)
        out[13u + i] = (uint8_t)BENCH[k].name[i];
    return 32;
}
