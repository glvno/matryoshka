/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* The master EQ (GLO > EQ, #1107): a setting of the FM-1, not of a patch. Three bands on what every patch plays, on the
 * analog output only (the speaker and the headphone jack; USB audio takes the half before it, as with the count-in's
 * click, D-820): LOW, a low shelf at MEQ_LOW_HZ; MID, a bell at MID FREQ; HIGH, a high shelf at MEQ_HIGH_HZ. A band at
 * 0 dB does no work, so with all three at 0 dB the output is what it was, bit for bit. Its filters are the EQ module's
 * (engine.c eq_design, D-1252): the analog curves matched up to the top of the band, worked out only when a setting
 * changes. Included by audio.c after engine.c. */

#define MEQ_STEP_DB 0.5f                   /* a gain is held in half decibels */
#define MEQ_GAIN_MAX 24                    /* +-12 dB */
#define MEQ_LOW_HZ 120.0f                  /* the factory assembly EQ's low shelf and high shelf (D-1252) */
#define MEQ_HIGH_HZ 8000.0f
#define MEQ_SHELF_Q 0.707f
#define MEQ_MID_Q 0.707f                   /* a wide bell: a room's colour, not a resonance */
#define MEQ_FREQS 39u                      /* MID FREQ: 100 Hz .. 8 kHz in sixths of an octave */
#define MEQ_FREQ_DEFAULT 20u               /* 1 kHz */

/* the settings (main.c saves them in their own record; the menu and the editor's link set them): gains in half decibels
 * (two's complement), MID FREQ as an index into the sixths of an octave from 100 Hz */
static volatile uint8_t meq_low, meq_mid, meq_high, meq_freq = MEQ_FREQ_DEFAULT;
static volatile uint8_t meq_kern;          /* (measurement only: 0 the state variable filter, 1 the transposed direct form) */
static volatile uint8_t meq_fade;          /* a band still runs (it fades to 0 dB this block): the audio interrupt calls in */

/* MID FREQ in Hz: 100 x 2^(index / 6) */
static float meq_hz(uint32_t f)
{
    return 100.0f * exp2_f((float)(f < MEQ_FREQS ? f : MEQ_FREQS - 1u) * (1.0f / 6.0f));
}

/* the settings as bytes (main.c's settings extension): LOW, MID, HIGH (half decibels, two's complement), MID FREQ */
#define MEQ_BYTES 4u
static void meq_pack(uint8_t *d)
{
    d[0] = meq_low;
    d[1] = meq_mid;
    d[2] = meq_high;
    d[3] = meq_freq;
}
/* a gain byte held to +-MEQ_GAIN_MAX */
static uint8_t meq_gain_of(int32_t g)
{
    return (uint8_t)(int8_t)(g > MEQ_GAIN_MAX ? MEQ_GAIN_MAX : g < -MEQ_GAIN_MAX ? -MEQ_GAIN_MAX : g);
}
static void meq_unpack(const uint8_t *d)
{
    meq_low = meq_gain_of((int8_t)d[0]);
    meq_mid = meq_gain_of((int8_t)d[1]);
    meq_high = meq_gain_of((int8_t)d[2]);
    meq_freq = (uint8_t)(d[3] < MEQ_FREQS ? d[3] : MEQ_FREQ_DEFAULT);
}
/* flat, MID FREQ at 1 kHz: as made, FACTORY RESET, a settings record without the EQ */
static void meq_defaults(void)
{
    meq_low = meq_mid = meq_high = 0;
    meq_freq = MEQ_FREQ_DEFAULT;
}

typedef struct {
    float c[6];                            /* eq_design's six numbers (the filter as it runs) */
    float s[2][2];                         /* per side its two states */
    int16_t key[2];                        /* the gain (half decibels) and MID FREQ they are for */
    uint8_t on;                            /* the band runs: its gain is not 0, or it fades to 0 dB this block */
} meq_band_t;
static meq_band_t meq_b[3];
#define MEQ_LIM 524287.0f                  /* a band's output, Q16, held to +-8.0: MASTER's multiply stays in 32 bits */

/* one band over the block, both sides (io: the engine's half, Q16, in place): the EQ module's state variable filter
 * (engine.c m_eq), its six numbers going from c to t in straight lines when they changed (ramp) */
static void meq_svf(meq_band_t *b, const float *t, int ramp, int32_t *const *io, uint32_t n)
{
    uint32_t i, ch;
    float d[6], rn = 1.0f / (float)n;
    for (i = 0; i < 6u; i++)
        d[i] = ramp ? (t[i] - b->c[i]) * rn : 0.0f;
    for (ch = 0; ch < 2u; ch++) {
        float a1 = b->c[0], a2 = b->c[1], a3 = b->c[2], c0 = b->c[3], c1 = b->c[4], c2 = b->c[5];
        float s1 = b->s[ch][0], s2 = b->s[ch][1];
        int32_t *x = io[ch];
        if (ramp)
            for (i = 0; i < n; i++) {
                float v0 = (float)x[i], v3, v1, v2;
                a1 += d[0]; a2 += d[1]; a3 += d[2]; c0 += d[3]; c1 += d[4]; c2 += d[5];
                v3 = v0 - s2;
                v1 = a1 * s1 + a2 * v3;
                v2 = s2 + a2 * s1 + a3 * v3;
                s1 = 2.0f * v1 - s1;
                s2 = 2.0f * v2 - s2;
                x[i] = (int32_t)clampf(c0 * v0 + c1 * v1 + c2 * v2, MEQ_LIM);
            }
        else
            for (i = 0; i < n; i++) {
                float v0 = (float)x[i], v3 = v0 - s2;
                float v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
                s1 = 2.0f * v1 - s1;
                s2 = 2.0f * v2 - s2;
                x[i] = (int32_t)clampf(c0 * v0 + c1 * v1 + c2 * v2, MEQ_LIM);
            }
        b->s[ch][0] = s1;
        b->s[ch][1] = s2;
    }
    for (i = 0; i < 6u; i++)
        b->c[i] = t[i];
}

/* (measurement only) the same filter in the transposed direct form II: five multiplies a sample instead of seven */
static void meq_df2(meq_band_t *b, const float *t, int32_t *const *io, uint32_t n)
{
    uint32_t i, ch;
    float g = t[1] / t[0], k = (1.0f / t[0] - 1.0f) / g - g, mh = t[3], mb = t[4] + k * mh, ml = t[5] + mh, gg = g * g;
    float b0 = (mh + mb * g + ml * gg) * t[0], b1 = 2.0f * (ml * gg - mh) * t[0], b2 = (mh - mb * g + ml * gg) * t[0];
    float a1 = 2.0f * (gg - 1.0f) * t[0], a2 = (1.0f - k * g + gg) * t[0];
    for (ch = 0; ch < 2u; ch++) {
        float z1 = b->s[ch][0], z2 = b->s[ch][1];
        int32_t *x = io[ch];
        for (i = 0; i < n; i++) {
            float v = (float)x[i], y = b0 * v + z1;
            z1 = b1 * v - a1 * y + z2;
            z2 = b2 * v - a2 * y;
            x[i] = (int32_t)clampf(y, MEQ_LIM);
        }
        b->s[ch][0] = z1;
        b->s[ch][1] = z2;
    }
    for (i = 0; i < 6u; i++)
        b->c[i] = t[i];
}

/* (measurement only) the biquad of t (eq_design's six numbers) in the transposed direct form II: b0, b1, b2, a1, a2 */
static void meq_bq_of(const float *t, float *q)
{
    float g = t[1] / t[0], k = (1.0f / t[0] - 1.0f) / g - g, mh = t[3], mb = t[4] + k * mh, ml = t[5] + mh, gg = g * g;
    q[0] = (mh + mb * g + ml * gg) * t[0];
    q[1] = 2.0f * (ml * gg - mh) * t[0];
    q[2] = (mh - mb * g + ml * gg) * t[0];
    q[3] = 2.0f * (gg - 1.0f) * t[0];
    q[4] = (1.0f - k * g + gg) * t[0];
}
/* (measurement only) all three bands in one pass a side, a band at 0 dB as the identity (q = 1, 0, 0, 0, 0) */
static void meq_fused(float q[3][5], int32_t *const *io, uint32_t n)
{
    uint32_t i, ch;
    for (ch = 0; ch < 2u; ch++) {
        float z10 = meq_b[0].s[ch][0], z20 = meq_b[0].s[ch][1], z11 = meq_b[1].s[ch][0], z21 = meq_b[1].s[ch][1];
        float z12 = meq_b[2].s[ch][0], z22 = meq_b[2].s[ch][1];
        int32_t *x = io[ch];
        for (i = 0; i < n; i++) {
            float v = (float)x[i], y;
            y = q[0][0] * v + z10; z10 = q[0][1] * v - q[0][3] * y + z20; z20 = q[0][2] * v - q[0][4] * y; v = y;
            y = q[1][0] * v + z11; z11 = q[1][1] * v - q[1][3] * y + z21; z21 = q[1][2] * v - q[1][4] * y; v = y;
            y = q[2][0] * v + z12; z12 = q[2][1] * v - q[2][3] * y + z22; z22 = q[2][2] * v - q[2][4] * y;
            x[i] = (int32_t)clampf(y, MEQ_LIM);
        }
        meq_b[0].s[ch][0] = z10; meq_b[0].s[ch][1] = z20; meq_b[1].s[ch][0] = z11; meq_b[1].s[ch][1] = z21;
        meq_b[2].s[ch][0] = z12; meq_b[2].s[ch][1] = z22;
    }
}

/* the EQ over the engine's half (Q16, in place); 0 when every band is at 0 dB and none fades: the half is untouched */
static __attribute__((noinline)) int meq_run(int32_t *l, int32_t *r, uint32_t n)
{
    static const float HZ_SHAPE[3][2] = {{MEQ_LOW_HZ, 0.0f}, {0.0f, 1.0f}, {MEQ_HIGH_HZ, 2.0f}};
    int16_t gain[3] = {(int8_t)meq_low, (int8_t)meq_mid, (int8_t)meq_high}, f = meq_freq;
    uint32_t i, k, any = 0, ql = 0, qr = 0;
    int32_t *const io[2] = {l, r};
    for (k = 0; k < 3u; k++) {
        if (gain[k] > MEQ_GAIN_MAX) gain[k] = MEQ_GAIN_MAX;
        if (gain[k] < -MEQ_GAIN_MAX) gain[k] = -MEQ_GAIN_MAX;
        any |= gain[k] != 0 || meq_b[k].on;
    }
    if (!any)
        return 0;
    for (i = 0; i < n; i++) {
        ql |= (uint32_t)l[i];
        qr |= (uint32_t)r[i];
    }
    float q[3][5] = {{1.0f, 0.0f, 0.0f, 0.0f, 0.0f}, {1.0f, 0.0f, 0.0f, 0.0f, 0.0f}, {1.0f, 0.0f, 0.0f, 0.0f, 0.0f}};
    for (k = 0; k < 3u; k++) {
        meq_band_t *b = &meq_b[k];
        int16_t fk = k == 1u ? f : 0;
        float t[6];
        int ramp;
        if (!gain[k] && !b->on)
            continue;
        if (!b->on) {                      /* (on from the dry signal: from the 0 dB filter, which is the dry signal, to the gain) */
            eq_design((int)HZ_SHAPE[k][1], k == 1u ? meq_hz((uint32_t)fk) : HZ_SHAPE[k][0], 0.0f, k == 1u ? MEQ_MID_Q : MEQ_SHELF_Q, b->c);
            b->s[0][0] = b->s[0][1] = b->s[1][0] = b->s[1][1] = 0.0f;
        }
        ramp = !b->on || gain[k] != b->key[0] || fk != b->key[1];
        if (ramp) {
            eq_design((int)HZ_SHAPE[k][1], k == 1u ? meq_hz((uint32_t)fk) : HZ_SHAPE[k][0], (float)gain[k] * MEQ_STEP_DB,
                      k == 1u ? MEQ_MID_Q : MEQ_SHELF_Q, t);
            b->key[0] = gain[k];
            b->key[1] = fk;
        } else {
            for (i = 0; i < 6u; i++)
                t[i] = b->c[i];
        }
        if (meq_kern == 2u) {
            meq_bq_of(t, q[k]);
            for (i = 0; i < 6u; i++)
                b->c[i] = t[i];
        } else if (meq_kern)
            meq_df2(b, t, io, n);
        else
            meq_svf(b, t, ramp, io, n);
        b->on = gain[k] != 0;             /* (a band at 0 dB is the dry signal: its last block faded to it) */
        if (!ql && ring_endf(b->s[0], 2))  /* (D-1109: a ring past -144 dBFS on a silent side ends at exactly zero) */
            b->s[0][0] = b->s[0][1] = 0.0f;
        if (!qr && ring_endf(b->s[1], 2))
            b->s[1][0] = b->s[1][1] = 0.0f;
    }
    if (meq_kern == 2u)
        meq_fused(q, io, n);
    meq_fade = (uint8_t)(meq_b[0].on | meq_b[1].on | meq_b[2].on);
    return 1;
}
