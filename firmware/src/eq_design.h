/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* The EQ's filter design (modules.ts eqDesign, #1107, D-1252), shared by the EQ module (engine.c m_eq) and the master EQ
 * (master_eq.h). Needs exp2_f (engine.c), ENG_SR (engine.h), EQ_SHELF_Q and EQ_SHELF_TOP (defs.h). */
#define EQ_PI 3.14159265f

/* sin x for 0 <= x <= pi: the series to x^13 on 0..pi/2 (within 1e-9), the other half mirrored */
static float eq_sin(float x)
{
    float x2;
    if (x > 0.5f * EQ_PI)
        x = EQ_PI - x;
    x2 = x * x;
    return x * (1.0f - x2 * (1.0f / 6.0f) * (1.0f - x2 * (1.0f / 20.0f) * (1.0f - x2 * (1.0f / 42.0f) * (1.0f - x2 * (1.0f / 72.0f)
           * (1.0f - x2 * (1.0f / 110.0f) * (1.0f - x2 * (1.0f / 156.0f)))))));
}

/* e^x - 1 for x <= 0, without exp2_f(x) - 1's cancellation near 0: the series to x^9 above -0.5 (within 3e-10) */
static float eq_expm1(float x)
{
    if (x < -0.5f)
        return exp2_f(x * 1.44269504f) - 1.0f;
    return x * (1.0f + x * (1.0f / 2.0f) * (1.0f + x * (1.0f / 3.0f) * (1.0f + x * (1.0f / 4.0f) * (1.0f + x * (1.0f / 5.0f)
           * (1.0f + x * (1.0f / 6.0f) * (1.0f + x * (1.0f / 7.0f) * (1.0f + x * (1.0f / 8.0f) * (1.0f + x * (1.0f / 9.0f)))))))));
}

/* the square root of x (0 for x <= 0): a first guess from the exponent's bits (within 6 %), then three Newton steps */
static float eq_sqrt(float x)
{
    union { float f; int32_t i; } u;
    float y;
    if (x <= 0.0f)
        return 0.0f;
    u.f = x;
    u.i = 0x1FBD1DF5 + (u.i >> 1);
    y = u.f;
    y = 0.5f * (y + x / y);
    y = 0.5f * (y + x / y);
    return 0.5f * (y + x / y);
}

/* modules.ts eqPoles: the poles of a two-pole filter at wp (radians a sample) with damping z, mapped exactly (impulse
 * invariance), as the state variable filter's cutoff g and damping k that have them */
static void eq_poles(float wp, float z, float *g, float *k)
{
    if (z < 1.0f) {
        float e = eq_expm1(-z * wp), r = 1.0f + e, omr2 = -e * (1.0f + r);   /* r = e^(-z wp), omr2 = 1 - r^2 */
        float th = wp * eq_sqrt(1.0f - z * z), s = eq_sin(th), h = eq_sin(0.5f * th);
        float nn = eq_sqrt(omr2 * omr2 + 4.0f * r * r * s * s);
        *g = nn / ((1.0f + r) * (1.0f + r) - 4.0f * r * h * h);
        *k = 2.0f * omr2 / nn;
    } else {
        float sq = eq_sqrt(z * z - 1.0f), e1 = eq_expm1(-wp / (z + sq)), e2 = eq_expm1(-wp * (z + sq));
        float w1 = -e1 / (2.0f + e1), w2 = -e2 / (2.0f + e2);
        *g = eq_sqrt(w1 * w2);
        *k = (w1 + w2) / *g;
    }
}

/* |a shelf's analog curve|^2 at W x its frequency (modules.ts eqDesign's level): shape 0 low, 2 high, a = 10^(gain / 40) */
static float eq_shelf(int shape, float a, float q, float W)
{
    float W2 = W * W, a2 = a * a, bw = a * W2 / (q * q), u, v;
    if (shape == 0) {
        u = a2 - a * W2;
        v = 1.0f - a * W2;
    } else {
        u = a - a2 * W2;
        v = a - W2;
    }
    return (u * u + a2 * bw) / (v * v + bw);
}

/* modules.ts eqDesign then eqCoefs: the six numbers a sample uses (a1, a2, a3 and the weights of the input, the band
 * pass and the low pass) for shape (EQ_SHAPES), f0 (Hz), gain (dB) and q. f0 is at most 22 kHz, under modules.ts EQ_TOP
 * of ENG_SR: no cap here. */
static void eq_design(int shape, float f0, float gain, float q, float *c)
{
    int inv = (shape == 0 && gain < 0.0f) || (shape == 2 && gain > 0.0f);
    float w0 = f0 * (2.0f * EQ_PI / (float)ENG_SR), a = exp2_f((inv ? -gain : gain) * 0.0830482024f);   /* 10^(gain / 40) */
    float sa = eq_sqrt(a), a2 = a * a, g, k, x, X, d0, mh, mb, ml, a1;
    if ((shape == 0 || shape == 2) && q > EQ_SHELF_Q)
        q = EQ_SHELF_Q;
    eq_poles(shape == 0 ? w0 / sa : shape == 2 ? w0 * sa : w0, shape == 1 ? 0.5f / (a * q) : 0.5f / q, &g, &k);
    x = eq_sin(0.5f * w0) / (eq_sin(0.5f * EQ_PI - 0.5f * w0) * g);   /* tan(w0 / 2) / g */
    X = x * x;
    d0 = (1.0f - X) * (1.0f - X) + k * k * X;
    if (shape == 1) {                    /* bell: 1 at 0 Hz, the gain (a2) and flat at f0 */
        float G2 = a2 * a2, t;
        ml = 1.0f;
        mh = eq_sqrt(G2 + (1.0f - G2) / (X * X));
        t = G2 * (k * k - 2.0f * (1.0f - X)) + 2.0f * mh * (1.0f - mh * X);
        mb = eq_sqrt(t);
    } else if (shape == 3) {             /* low pass: 1 at 0 Hz, q at f0, no zero at Nyquist */
        ml = 1.0f;
        mh = eq_sqrt((q * q * d0 - 1.0f - g * g * X) / (X * X + X / (g * g)));
        mb = g + mh / g;
    } else if (shape == 4) {             /* high pass: both zeros at 0 Hz, q at f0 */
        ml = mb = 0.0f;
        mh = q * eq_sqrt(d0) / X;
    } else if (shape == 5) {             /* notch: both zeros at f0, 1 at 0 Hz */
        ml = 1.0f;
        mb = 0.0f;
        mh = 1.0f / X;
    } else {                             /* shelves: the analog levels at 0 Hz, at Nyquist and where the zeros are */
        float wm = shape == 0 ? w0 * sa : w0 / sa, xm, Xm, t;
        if (wm > EQ_SHELF_TOP)
            wm = EQ_SHELF_TOP;
        xm = eq_sin(0.5f * wm) / (eq_sin(0.5f * EQ_PI - 0.5f * wm) * g);   /* tan(wm / 2) / g */
        Xm = xm * xm;
        ml = shape == 0 ? a2 : 1.0f;
        mh = eq_sqrt(eq_shelf(shape, a, q, (float)ENG_SR / (2.0f * f0)));
        t = ml - mh * Xm;
        mb = eq_sqrt((eq_shelf(shape, a, q, wm / w0) * ((1.0f - Xm) * (1.0f - Xm) + k * k * Xm) - t * t) / Xm);
    }
    if (inv) {                           /* turned over: the zeros become the poles */
        float s = eq_sqrt(ml / mh), nk = mb / eq_sqrt(ml * mh), nb = k * s / ml;
        g *= s;
        k = nk;
        mb = nb;
        mh = 1.0f / mh;
        ml = 1.0f / ml;
    }
    a1 = 1.0f / (1.0f + g * (g + k));
    c[0] = a1;
    c[1] = g * a1;
    c[2] = g * c[1];
    c[3] = mh;
    c[4] = mb - k * mh;
    c[5] = ml - mh;
}
