/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Fixed-point patch engine, see engine.h. The reference is web/src/engine.ts / modules.ts; formulas are kept
 * line by line where possible. Polyphony as in engine.ts: a module in a poly group (a poly assembly of the editor) has one
 * instance (inst_t) per part of its group, everything else has one; an input reading another group's per-part output sums
 * its parts. Each group hands the notes to its parts with its own allocator, the rest plays the shared keyboard (one note).
 * Number formats: signals, parameters Q16.16; oscillator phase u32 (2^32 = 1 cycle);
 * filter coefficients Q24; envelope level and rates Q30. Build: -DENG_POOL=... places the big buffers (device:
 * the .pool section), ENG_LOWRAM the second line area, line_low (device: .lowram, below the RAM region, #273). Needs 64-bit multiply (hardware) and, at block rate and on waveform edges, 64/32 division. */
#include "engine.h"
#include "defs.h"
#include "dsp_tables.h"
#include "wt_tables.h"
#include "rate_envelope.h"

#ifndef ENG_POOL
#define ENG_POOL
#endif
#ifndef ENG_LOWRAM
#define ENG_LOWRAM
#endif
#ifndef ENG_AOT_PAIR
#define ENG_AOT_PAIR 0
#endif

/* The patch: modules, cables, summed inputs; below them the memory: one arena a load divides as the patch needs it
 * (#649, eng_arena: the module copies, the parameter values, the signal buffers and the lines). A patch that does not
 * fit does not load (-4 lines, -6 buffers, -7 instances, -8 parameter values): NO ROOM on the panel. The counts below are
 * sanity caps. Keep DEVICE and ARENA in web/src/patchbin.ts, the HELLO reply (proto.c) and the MEMORY lines of manual.c
 * in step. */
/* ENG_MAX_MODULES (engine.h): the module list, `order`, `outputs` are uint8 indices; the binary header byte 2 */
#define ENG_MAX_RANGES 48           /* macro ranges (patch.ts ModuleInst.range) */
#define ENG_MAX_CABLES 255           /* (the HELLO reply carries it in a byte) */
#define MAX_SUM 160                 /* summed inputs (an input of an instance with two or more sources) */
#define MAX_SRC 320                 /* their sources: a shared input reading a per-note output has one per note */
#define ENG_MAX_INST 254u           /* module instances (copies): a shared module has one, a per-note module one per note
                                     * (node_t inst0 is a byte, and copy 0 of the arena is the spare: inst_pool) */
#define ENG_NBUF 1023u              /* signal buffers of ENG_BLOCK samples (a connected output, a summed input) */
#define ENG_MAX_LINES 128u          /* lines (eng_load's lists of them are on the main loop's stack) */
/* the lines of the Delays, reverbs, choruses, strings, combs and granulars: as many as the two line areas hold (line_place) */
#define GRAIN_LEN 44118u            /* GRAIN_SECONDS x ENG_SR */
#define GRAIN_MAX 8
#define GRAIN_OCT 4                 /* the grains' pitch (in + slider) is clamped to +-4 octaves (modules.ts GRAIN_OCT) */
#define GRAIN_SPRAY (ENG_SR / 4u)   /* spray scatters a grain's start by up to this many samples (0.25 s) */
#define RV_LEN 8074u                /* the eight FDN lines (5740), two input allpasses (570) and the 40 ms pre-delay (1764), int16 Q13 */
#define DELAY_LEN 30944u            /* the line of a 700 ms length (dly_samples), every Delay's before the length row (D-375) */
#define DELAY_TIME_TOP (DELAY_REACH_MAX * ENG_ONE)   /* ms: what a Delay's time reaches past the knob's 700 (modules.ts browserMax: the longest length at the lowest rate), kept under modulation; its line limits it as it plays */
#define STR_LEN 1104u               /* ceil(ENG_SR / 40) + 1: the lowest string is 40 Hz, as the reference */
#define CH_LEN 927u                 /* ceil(ENG_SR * 0.021): 12 ms +- 8 ms of sweep */
#define MAX_HELD 128
#define ENG_MAX_ARPS 2               /* Arpeggiator modules of a patch (a third does not load) */
#define ENG_MAX_HARMS 2              /* Harmonizer modules of a patch (#598; a third does not load) */
#define HARM_ZONE 7                  /* the keys under a Harmonizer's split that are its chord buttons (harmonizer.ts HARM_ZONE) */
#define HARM_ROOTS 10                /* roots a Harmonizer holds at once (a further one is not played) */
#define HARM_TONES 8                 /* notes of one chord at most (root, 2nd, 3rd, 4th, 5th, 7th, 9th) */
#define HARM_VOICING 8               /* the voicing's reach, inversions up or down */
#define ENG_MAX_TRACKS 16            /* Steps modules of a patch (their notes live in E.trk_note) */
#define ENG_MAX_NOTES 1536           /* the notes of all Steps tracks of a patch, every pattern (patchbin.ts DEVICE.notes) */
#define ENG_KEV 64                   /* Steps keys out (note on / off) one block holds; more are dropped */
#define ARP_HELD 16                  /* keys an arpeggiator holds (arpeggiator.ts ARP_HELD) */
#define ARP_LIST (ARP_HELD * 4u)     /* its notes over four octaves */
#define TEMPO_DEFAULT 120u           /* without a Main module */

#define INC_C4 25469723u            /* 261.6255653 Hz at ENG_SR, u32 phase per sample */
#define DT_MAX 1932735283u          /* 0.45 of a cycle per sample (the reference limits osc to 0.45, cutoff to 0.45 sr) */
#define TURN_PER_RAD 683565276u     /* 2^32 / 2 pi */

typedef int32_t esig_t;

/* the per-sample helpers are forced inline: -Os left mulq / mulr as calls, a sixth of a busy patch's cycles went to the
 * call and return (tools/cpu, npm run cpu-hot) */
#define HOT static inline __attribute__((always_inline))

HOT int32_t mulq(int32_t a, int32_t b, unsigned s) { return (int32_t)(((int64_t)a * b) >> s); }
HOT int32_t mul16(int32_t a, int32_t b) { return mulq(a, b, 16); }
/* rounded to nearest: no bias, which the filter's integrators would turn into a DC offset at low cutoffs */
HOT int32_t mulr(int32_t a, int32_t b, unsigned s) { return (int32_t)(((int64_t)a * b + ((int64_t)1 << (s - 1))) >> s); }
HOT int32_t clampi(int32_t v, int32_t lo, int32_t hi) { return v < lo ? lo : v > hi ? hi : v; }

/* (x << 16) / ENG_SR truncated to 32 bits (a Q16 frequency in Hz -> u32 turns per sample) with two 32-bit divisions
 * instead of a 64-bit one: x = q sr + r, then q 2^16 + floor(r 2^16 / sr) (r < sr < 2^16), equal modulo 2^32 */
HOT uint32_t hz_turns(uint32_t x)
{
    uint32_t q = x / ENG_SR, r = x - q * ENG_SR;
    return (q << 16) + (r << 16) / ENG_SR;
}

/* sum / n as C divides (toward zero), without the 64-bit division (a library call on this core) for a whole block */
HOT int32_t block_mean(int64_t sum, uint32_t n)
{
    if (n == ENG_BLOCK)
        return (int32_t)(sum < 0 ? -((-sum) >> 7) : sum >> 7);
    return (int32_t)(sum / (int64_t)n);
}

/* ------------------------------------------------------------------ number helpers */

/* the Random module's values (modules.ts hash32, walkInit, walkStep, walkHold): integer, bit for bit the reference. A walk:
 * every `hold` blocks it picks a new random target (Q15), each block it moves 2 / hold of the way there. */
typedef struct { uint32_t seed; int32_t count, y, t; } walk_t;
static uint32_t hash32(uint32_t x)
{
    x = (x ^ (x >> 16)) * 0x7feb352du;
    x = (x ^ (x >> 15)) * 0x846ca68bu;
    return x ^ (x >> 16);
}
static inline int32_t q15(uint32_t h) { return (int32_t)(h >> 16) - 32768; }
static inline uint32_t lcg(uint32_t s) { return s * 1664525u + 1013904223u; }
static void walk_init(walk_t *w, uint32_t seed)
{
    w->seed = lcg(seed);
    w->count = 0;
    w->t = w->y = q15(w->seed);
}
static void walk_step(walk_t *w, uint32_t hold)          /* one block; hold 1..65535 */
{
    int32_t k = (int32_t)(65536u / hold);
    if (--w->count <= 0) {
        w->count = (int32_t)hold;
        w->seed = lcg(w->seed);
        w->t = q15(w->seed);
    }
    w->y += ((w->t - w->y) * (k > 32768 ? 32768 : k)) >> 15;
}
/* a part's drift in Q16 octaves (engine.ts render: y drift 1092 / 3276800, truncated). |y| <= 32768 and drift <= 255, so
 * y drift fits 32 bits; 1092 / 3276800 = 273 / 819200 gives the same quotient, in 32 bits while y drift 273 does */
static int32_t flaw_drift(int32_t y, uint32_t drift)
{
    int32_t p = y * (int32_t)drift;
    if (p >= -7866000 && p <= 7866000)
        return p * 273 / 819200;
    return (int32_t)(((int64_t)p * 1092) / 3276800);
}

/* blocks between a walk's targets at `rate` Hz (Q16): round(ENG_SR / (128 rate)), 1..65535 */
static uint32_t walk_hold(int32_t rate)
{
    uint64_t r = rate < 655 ? 655u : (uint64_t)rate, h = ((((uint64_t)ENG_SR << 17) / (128u * r)) + 1u) >> 1;
    return h < 1u ? 1u : h > 65535u ? 65535u : (uint32_t)h;
}

/* blocks between a part drift's targets: walk_hold(0.5 Hz) (engine.ts DRIFT_RATE) */
#define DRIFT_HOLD ((uint32_t)(((((uint64_t)ENG_SR << 17) / (128u * 32768u)) + 1u) >> 1))

/* base * 2^(x / 65536), saturating at 2^32 - 1. base: a phase increment, x: octaves Q16.16. The mantissa m (Q28, 1..2) is
 * interpolated in 32 bits (a step of EXP2_T is under 2^21, times r < 2^8). v = base m / 2^28 is shifted in 32 bits when it
 * fits them (base under about 2^31: every phase increment), the 64-bit shifts only otherwise: a modulated pitch works this
 * out every sample (#453). The same results as the 64-bit form (firmware/test/exact_test.c checks them). */
HOT uint32_t exp2_scale_in(uint32_t base, int32_t x)
{
    int32_t n = x >> 16;
    uint32_t i = ((uint32_t)x >> 8) & 255u, r = (uint32_t)x & 255u;
    uint32_t m = EXP2_T[i] + (((EXP2_T[i + 1u] - EXP2_T[i]) * r) >> 8);
    uint64_t p = (uint64_t)base * m;
    uint32_t hi = (uint32_t)(p >> 32), v;
    if (hi >> 28) {                                     /* v >= 2^32 */
        if (n >= 0)
            return 0xFFFFFFFFu;
        return -n >= 64 ? 0u : (uint32_t)((p >> 28) >> -n);
    }
    v = (hi << 4) | ((uint32_t)p >> 28);
    if (n >= 0) {
        if (n >= 32 || (n && v >> (32 - n)))
            return 0xFFFFFFFFu;
        return v << n;
    }
    return n <= -32 ? 0u : v >> -n;
}

static uint32_t exp2_scale(uint32_t base, int32_t x) { return exp2_scale_in(base, x); }

/* An oscillator's phase increment along a block (#461): exact at every INC_SPAN-th sample, a straight line in between, so
 * a moving pitch (vibrato) costs one exp2_scale per INC_SPAN samples instead of one per sample. A span's line runs from
 * the increment at its first sample toward the one at the next span's first sample (the block's last sample for the last
 * span). A pitch that does not move gives the exact increment at every sample. modules.ts incRamp does the same.
 * inc_start at the block's start, then inc_span for each span in turn, e the sample its line runs toward: the span's first
 * increment, r->d the step per sample. off: the octaves added to the pitch (Q16). INC_LOOP runs a loop over the block's
 * samples i with the increment in dt_. */
#define INC_SHIFT 3
#define INC_SPAN (1u << INC_SHIFT)
typedef struct {
    uint32_t b;                                         /* the increment at the last span's end */
    int32_t d, p;                                       /* the step per sample, the pitch at the last span's end */
} inc_ramp_t;

static inline uint32_t inc_at(int32_t x)
{
    uint32_t dt = exp2_scale(INC_C4, x);
    return dt > DT_MAX ? DT_MAX : dt;
}

static inline void inc_start(inc_ramp_t *r, const esig_t *pitch, int32_t off)
{
    r->p = pitch[0];
    r->b = inc_at(r->p + off);
}

static inline uint32_t inc_span(inc_ramp_t *r, const esig_t *pitch, int32_t off, uint32_t e)
{
    uint32_t a = r->b;
    if (pitch[e] != r->p) {
        r->p = pitch[e];
        r->b = inc_at(r->p + off);
        r->d = ((int32_t)r->b - (int32_t)a) >> INC_SHIFT;   /* (both at most DT_MAX < 2^31) */
    } else
        r->d = 0;
    return a;
}

#define INC_END(i) ((i) + INC_SPAN < n ? (i) + INC_SPAN : n)         /* the span's end */
#define INC_TO(e) ((e) < n ? (e) : n - 1u)                           /* the sample its line runs toward */
#define INC_LOOP(r, off)                                                                \
    for (i = 0, inc_start(&(r), pitch, (off)); i < n;)                                  \
        for (uint32_t e_ = INC_END(i), dt_ = inc_span(&(r), pitch, (off), INC_TO(e_)); i < e_; i++, dt_ += (uint32_t)(r).d)

/* sin(2 pi phase), phase u32 turns -> Q16 */
static int32_t sin_turn(uint32_t ph)
{
    uint32_t i = ph >> 22, fr = (ph >> 6) & 0xFFFFu;
    int32_t s0 = SIN_T[i], s1 = SIN_T[i + 1u];
    return (s0 + (int32_t)(((int64_t)(s1 - s0) * fr) >> 16)) >> 14;
}

/* the same in Q30 (the modal resonator needs cos near 1 to better than Q16) */
static int32_t sin_turn30(uint32_t ph)
{
    uint32_t i = ph >> 22, fr = (ph >> 6) & 0xFFFFu;
    int32_t s0 = SIN_T[i], s1 = SIN_T[i + 1u];
    return s0 + (int32_t)(((int64_t)(s1 - s0) * fr) >> 16);
}

/* 1 / (d / 2^24) in Q24 for d (Q24) in [2^24, 2^30): 32-bit divide for a first estimate, one Newton step */
static int32_t recip24(int32_t d)
{
    int32_t x = (int32_t)(0xFFFFFFFFu / ((uint32_t)d >> 8)) << 8;
    int32_t t = (int32_t)(((int64_t)d * x) >> 24);
    return (int32_t)(((int64_t)x * ((2 << 24) - t)) >> 24);
}

static inline int32_t round_q16(int32_t v) { return (v + 32768) >> 16; }   /* Math.round for the integer params */

/* floor(t * 2^16 / dt) for t < dt, the poly-BLEP's position inside the step, without a 64-bit division per edge: the
 * reciprocal R = floor(2^48 / dt) is worked out once per increment (`rc` caches it: rc[0] the dt, rc[1] R), then
 * q = floor(t R / 2^32) is at most one short of the quotient (t R / 2^32 <= t 2^16 / dt < t R / 2^32 + 1) and one compare
 * fixes it. Increments up to 2^16 (under 0.7 Hz) take the 32-bit division, where t << 16 still fits (R would not). Exact. */
HOT uint32_t blep_pos(uint32_t t, uint32_t dt, uint32_t *rc)
{
    uint32_t q;
    if (dt <= 65536u)
        return (t << 16) / dt;
    if (rc[0] != dt) {
        rc[0] = dt;
        rc[1] = (uint32_t)((1ull << 48) / dt);
    }
    q = (uint32_t)(((uint64_t)t * rc[1]) >> 32);
    if ((uint64_t)(q + 1u) * dt <= (uint64_t)t << 16)
        q++;
    return q;
}

/* poly-BLEP residual, phase t and increment dt in u32 turns -> Q16 (rc: blep_pos's cache, one per phase) */
HOT int32_t poly_blep(uint32_t t, uint32_t dt, uint32_t *rc)
{
    if (dt == 0u)
        return 0;
    if (t < dt) {
        int32_t u = (int32_t)blep_pos(t, dt, rc);
        return 2 * u - (int32_t)(((int64_t)u * u) >> 16) - ENG_ONE;
    }
    if (t > 0u - dt) {
        int32_t u = (int32_t)blep_pos(0u - t, dt, rc);      /* -(t - 1) / dt */
        return (int32_t)(((int64_t)u * u) >> 16) - 2 * u + ENG_ONE;
    }
    return 0;
}

/* the waveforms of modules.ts wave(): 0 sine, 1 triangle, 2 saw, 3 square. phase and pw in u32 turns */
HOT int32_t wave_tri(uint32_t ph)
{
    int32_t s = (int32_t)ph;
    uint32_t a = s < 0 ? 0u - (uint32_t)s : (uint32_t)s;     /* |phase - round(phase)| in 2^32 */
    return (int32_t)(a >> 14) - ENG_ONE;
}
HOT int32_t wave_saw(uint32_t ph, uint32_t dt, uint32_t *rc) { return (int32_t)(ph >> 15) - ENG_ONE - poly_blep(ph, dt, rc); }
HOT int32_t wave_square(uint32_t ph, uint32_t dt, uint32_t pw, uint32_t *rc)
{
    int32_t v = ph < pw ? ENG_ONE : -ENG_ONE;
    v += poly_blep(ph, dt, rc);
    v -= poly_blep(ph - pw, dt, rc);                      /* the same increment: one cache serves both edges */
    return v;
}
HOT int32_t wave_shark(uint32_t ph, uint32_t dt, uint32_t *rc)
{
    return (wave_tri(ph) + wave_saw(ph, dt, rc)) >> 1;
}

/* rc: two words of blep_pos cache for this phase */
static int32_t wave(int32_t kind, uint32_t ph, uint32_t dt, uint32_t pw, uint32_t *rc)
{
    switch (kind) {
    case 0:
        return sin_turn(ph);
    case 1:
        return wave_tri(ph);
    case 2:
        return wave_saw(ph, dt, rc);
    case 4:
        return wave_shark(ph, dt, rc);
    case 5:
        return -wave_saw(ph, dt, rc);
    default:
        return wave_square(ph, dt, pw, rc);
    }
}


/* The Oscillator's analog shape (#673, modules.ts analogShape / waveAnalog) for one block: the saw's curve
 * r = p T(c p) / T(c) with T(x) = (1 - e^-x) / x from ANALOG_SAWC_T, 1 / T(c) and the mean of 2 r - 1 from their series
 * (c / 2 + c^2 / 12 - c^4 / 720, c / 6 - c^3 / 360: under 1e-6 off at c = 0.455); the reset's dip; the triangle's peak and
 * slopes; the pulse width. */
typedef struct {
    uint32_t cs;                 /* c in table steps per turn: x / (1 / 256) = c p 256, u32 of 128 table steps */
    uint32_t inv2;               /* 2 / T(c), Q30 (so mulhu(2 T, inv2) = T / T(c) in Q30) */
    int32_t c, off;              /* c Q16, 1 + the mean of 2 r - 1 (Q16) */
    int32_t h, hb;               /* the dip, 1 + h / 2 (the reset's step with the dip's first half), Q16 */
    uint32_t dwi, dwf, ek;       /* the dip's length in samples: dwi + dwf / 2^32; ek > 2 + that: the edge test's span */
    uint32_t pk, kup, kdn;       /* the triangle's peak (u32 turns), its rising and falling slopes (2^49 / turns) */
    uint32_t pw;                 /* the pulse width, u32 turns */
} ana_t;

#define Q30(x) ((int64_t)((x) * 1073741824.0 + 0.5))
/* the pulse width with its offset (#673), Q16 -> u32 turns */
static uint32_t ana_pw(int32_t amt, const int16_t *tol, int32_t pw_q)
{
    return (uint32_t)clampi(pw_q + ((mul16(ANALOG_PWO_Q16, amt) * tol[3]) >> 15), 3277, 62259) << 16;
}

/* dw: the dip's length in samples, Q16 (twice the plain path's at the FM path's doubled rate) */
static void ana_init(ana_t *a, int32_t amt, const int16_t *tol, uint32_t dw, int32_t pw_q)
{
    int32_t c = mul16(mul16(ANALOG_CURVE_Q16, amt), ENG_ONE + ((ANALOG_TOL_Q16 * tol[0]) >> 15)), sk;
    int32_t c30, c2, c3;
    if (c < 7)                                           /* (1e-4, as modules.ts) */
        c = 7;
    c30 = c << 14;                                       /* c <= 0.46: c^n in Q30 fit */
    c2 = mulq(c30, c30, 30);
    c3 = mulq(c2, c30, 30);
    a->c = c;
    a->cs = (uint32_t)c << 17;
    a->inv2 = (uint32_t)((1 << 30) + (c30 >> 1) + mulq(c2, (int32_t)Q30(1.0 / 12), 30) - mulq(mulq(c2, c2, 30), (int32_t)Q30(1.0 / 720), 30)) << 1;
    a->off = ENG_ONE + ((mulq(c30, (int32_t)Q30(1.0 / 6), 30) - mulq(c3, (int32_t)Q30(1.0 / 360), 30)) >> 14);
    a->h = mul16(mul16(ANALOG_DIP_Q16, amt), ENG_ONE + ((ANALOG_TOL_Q16 * tol[1]) >> 15));
    a->hb = ENG_ONE + (a->h >> 1);
    a->dwi = dw >> 16;
    a->dwf = dw << 16;
    a->ek = a->dwi + 3u;
    sk = (mul16(ANALOG_SKEW_Q16, amt) * tol[2]) >> 15;
    a->pk = 0x80000000u + (uint32_t)(sk * 65536);
    a->kup = (0xFFFFFFFFu / (a->pk >> 15)) << 2;           /* 2^49 / pk (to 1 / 2^16) */
    a->kdn = (0xFFFFFFFFu / ((0u - a->pk) >> 15)) << 2;
    a->pw = ana_pw(amt, tol, pw_q);
}
#undef Q30

static inline uint32_t mulhu(uint32_t a, uint32_t b) { return (uint32_t)(((uint64_t)a * b) >> 32); }

/* the curved saw: band-limited reset (polyBLEP, the dip's first half with it), corner (polyBLAMP) and dip's end (polyBLEP).
 * `a` by value: an inlined copy the compiler keeps in registers (a pointer's fields would be loaded again after each store
 * to the output, which may alias them) */
HOT int32_t ana_saw(uint32_t ph, uint32_t dt, const ana_t a, uint32_t *rc)
{
    uint32_t x = mulhu(ph, a.cs), i = x >> 25;
    int32_t t = ANALOG_SAWC_T[i] + (((ANALOG_SAWC_T[i + 1u] - ANALOG_SAWC_T[i]) * (int32_t)((x >> 16) & 511u)) >> 9);
    int32_t v = (int32_t)(mulhu(ph, mulhu((uint32_t)t << 1, a.inv2)) >> 13) - a.off;
    if (ph + dt < dt * a.ek || dt > 0x30000000u) {        /* -dt <= ph < (ek - 1) dt, more than the dip and its end:
                                                           * (ek dt wraps above a quarter of a turn a sample) */
        uint32_t w = dt * a.dwi + mulhu(dt, a.dwf);
        if (w > 0x40000000u)
            w = 0x40000000u;
        if (ph < dt || ph > 0u - dt) {                    /* the reset */
            int32_t u, b, y;
            if (ph < dt) {
                u = (int32_t)blep_pos(ph, dt, rc);
                b = 2 * u - (int32_t)(((int64_t)u * u) >> 16) - ENG_ONE;
            } else {
                u = (int32_t)blep_pos(0u - ph, dt, rc);
                b = (int32_t)(((int64_t)u * u) >> 16) - 2 * u + ENG_ONE;
            }
            y = ENG_ONE - u;
            y = mul16(mul16(y, y), y);                    /* x^3; the corner: 2 c dt x^3 / 6 */
            v += mul16((int32_t)(((int64_t)a.c * dt) >> 31), mul16(y, 10923)) - mul16(a.hb, b);
        }
        if (ph < w)                                       /* the dip, and its end */
            v -= a.h;
        v += mul16(a.h >> 1, poly_blep(ph - w, dt, rc));
    }
    return v;
}

HOT int32_t ana_tri(uint32_t ph, const ana_t a)
{
    return ph < a.pk ? (int32_t)(mulhu(ph, a.kup)) - ENG_ONE : ENG_ONE - (int32_t)(mulhu(ph - a.pk, a.kdn));
}

/* modules.ts waveAnalog: the kinds of wave() */
HOT int32_t ana_wave(int32_t kind, uint32_t ph, uint32_t dt, const ana_t a, uint32_t *rc)
{
    switch (kind) {
    case 0:
        return sin_turn(ph);
    case 1:
        return ana_tri(ph, a);
    case 2:
        return ana_saw(ph, dt, a, rc);
    case 4:
        return (ana_tri(ph, a) + ana_saw(ph, dt, a, rc)) >> 1;
    case 5:
        return -ana_saw(ph, dt, a, rc);
    default:
        return wave_square(ph, dt, a.pw, rc);
    }
}

/* log2 of a Q16 value (or of any positive integer: the offset cancels in ratios), Q16 */
static int32_t log2_q16(uint32_t x)
{
    uint32_t n, m, i, r;
    if (!x)
        return -(32 << 16);
    n = 31u - (uint32_t)__builtin_clz(x);
    m = (x << (31u - n)) & 0x7FFFFFFFu;                  /* the mantissa's fraction, 31 bits */
    i = m >> 23;
    r = (m >> 7) & 0xFFFFu;
    return (int32_t)(n << 16) + (int32_t)(LOG2_T[i] + (uint32_t)(((uint64_t)(LOG2_T[i + 1u] - LOG2_T[i]) * r) >> 16));
}

/* 2^(e / 65536) as an integer (a Q16 value), saturating */
static uint32_t exp2_q16(int32_t e)
{
    int32_t n = e >> 16;
    uint32_t fr = (uint32_t)e & 0xFFFFu, i = fr >> 8, r = fr & 255u;
    uint64_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1u] - EXP2_T[i]) * r) >> 8);   /* Q28 */
    if (n < 0)
        return 0;
    if (n > 31)
        return 0x7FFFFFFFu;
    m = (m << n) >> 28;
    return m > 0x7FFFFFFFu ? 0x7FFFFFFFu : (uint32_t)m;
}

static uint32_t isqrt32(uint32_t x)
{
    uint32_t r = 0, b = 1u << 30;
    while (b > x)
        b >>= 2;
    for (; b; b >>= 2) {
        if (x >= r + b) {
            x -= r + b;
            r = (r >> 1) + b;
        } else
            r >>= 1;
    }
    return r;
}

/* a parameter's position in its range as Q16 0..1: linear, or logarithmic for the cutoff (plog 2: bent, the position is
 * the square root of the octave fraction, so the low end gets more of the knob) */
static int32_t unit_of(const def_t *d, uint32_t j, int32_t v)
{
    int32_t lo = d->pmin[j], hi = d->pmax[j];
    v = clampi(v, lo, hi);
    if (d->plog && d->plog[j]) {
        int32_t l0 = log2_q16((uint32_t)lo);
        int32_t t = (int32_t)(((int64_t)(log2_q16((uint32_t)v) - l0) << 16) / (log2_q16((uint32_t)hi) - l0));
        return d->plog[j] != 2 ? t : t >= ENG_ONE ? ENG_ONE : (int32_t)isqrt32((uint32_t)t << 16);   /* (at the top t << 16 is 2^32: 0 in 32 bits, which read a cutoff at its maximum as at its minimum, #396) */
    }
    return (int32_t)(((int64_t)(v - lo) << 16) / (hi - lo));
}

static int32_t value_of(const def_t *d, uint32_t j, int32_t u)
{
    int32_t lo = d->pmin[j], hi = d->pmax[j];
    u = clampi(u, 0, ENG_ONE);
    if (d->plog && d->plog[j]) {
        int32_t l0 = log2_q16((uint32_t)lo), t = d->plog[j] == 2 ? (int32_t)(((int64_t)u * u) >> 16) : u;
        return clampi((int32_t)exp2_q16(l0 + (int32_t)(((int64_t)t * (log2_q16((uint32_t)hi) - l0)) >> 16)), lo, hi);
    }
    return lo + (int32_t)(((int64_t)u * (hi - lo)) >> 16);
}

/* ------------------------------------------------------------------ engine state */

/* one running copy of a module: its buffers, effective parameters and DSP state. A shared module has one, a per-voice
 * module one per voice (engine.ts: Inst) */
typedef struct {
    uint8_t sum0, nsum;              /* its summed inputs in E.sum[] */
    int32_t *eff;                    /* its type's npar effective values, in par_pool (par_spare until it loads) */
    const esig_t *in[MAX_IN];
    esig_t *out[MAX_OUT];
    union {
        struct { uint32_t phase; int32_t s1, y1, y2, pm1, xb, ap[8]; uint32_t ph[4], rc[5][2]; int16_t tol[4]; } osc;   /* s1: last sync sample; FM mode: feedback history, pm interpolation, decimator; ph: unison voices 2..5 (plain path); rc: their blep_pos caches, kept across blocks; tol: the part's analog tolerances, Q15 (modules.ts analogTol) */
        struct { uint32_t seed; walk_t w; uint32_t held_seed; int32_t held, clock; } rnd;   /* seed: engine.ts instSeed */
        struct { uint32_t phase, seed; int32_t held; uint32_t since; int32_t interval; uint16_t ticks; uint8_t clk_hi, rst_hi, wraps; int32_t from, last; } lfo;   /* interval: clock edge distance in samples, Q8; wraps: cycles ended since the last snap; from, last: the random wave's start and its last value */
        struct { int32_t y; } gld;         /* Q24 */
        struct { uint32_t seed; int32_t y; } noise;   /* y: the colour one-pole, Q24 */
        struct { int32_t ic1[3], ic2[3]; } vow;       /* three band passes, Q20 */
        struct { uint32_t phase; int32_t ap[8], fbv; } phs;   /* the sweep LFO, x1 / y1 of the four allpasses, the feedback sample */
        struct { int32_t held, cnt, xb, ap[16]; } crush;   /* xb, ap: the 2x oversampling (os_up / os_down) */
        struct { int32_t xb, ap[16]; } shp;
        struct { int32_t v, ka, kd, kr, ainc, ad, ar; uint8_t stage, prev, ok; } adsr;   /* k*: the A D R the rates (ainc, ad, ar) were
                                                                                       * worked out for, ok: which are (the divisions run only on a change) */
        struct { int32_t ic1, ic2, jc1, jc2; } flt;   /* stage 1 and stage 2 integrators */
        struct { int32_t s[4]; } lad;                 /* the four one-pole states, Q20 */
        struct { int32_t env; } dyn;                  /* the peak follower, Q24 */
        struct { int32_t env, lc, hc, pk, prev, y; uint32_t cnt; int32_t frac, t; uint8_t trig, arm, valid; } esp;   /* Q24: the envelope, the band pass's one-poles, its peak hold, its previous sample, the glided pitch; samples since the last crossing, that crossing's fraction (Q16), the measured pitch (Q16 octaves) */
        struct { int32_t y1[6], y2[6], r30[6], gn[6], kdec, kdamp, kbr; uint8_t ok; } mod;   /* the modal resonators, Q20; r30, gn: the
                                                    * modes' radii and normalised gains for kdec kdamp / kbr, ok: which are worked out */
        struct { int32_t a[8], b[8], ia; uint32_t phase; } fs;   /* the Hilbert chains (w1 w2 per section), chain A's delayed sample, the quadrature oscillator */
        struct { struct grain_line *ln; uint32_t w, acc, seed; uint8_t prev; } gr;   /* acc: grains per sample, Q24 */
        struct { int16_t *buf; int64_t cur; uint32_t len, w, t, seen, beat; int32_t rate; uint32_t ring[DELAY_CLK_PPQN]; uint8_t prev, rk, ph, tp; } dly;   /* len: its line's samples, from its length (dly_samples); cur 64 bits (a long line is more samples than Q16 holds in 32) */   /* t, ring, seen, beat: the clock tempo; cur, rate: the read position's distance behind w (samples Q16, 0 = not yet set) and its glide (dly_glide); rk, ph: a lower rate (#659, dly_slow): the rate step's k the line holds (0 none yet), the sample within a line sample; tp: Tape on (#660, dly_tape) */
        struct { int16_t *buf; uint16_t li[8], ai[2], pi; int32_t lp[8]; uint32_t ph[2]; } rev;   /* the FDN lines' write indices, the diffusers', the pre-delay's; damping states; modulation phases */
        struct { int32_t v; uint32_t t; int32_t rk[4], inc[4], k[4]; uint32_t len[4]; uint8_t stage, prev, ok; } env;  /* Q30, like the ADSR; t: samples
                                                    * in the segment; rk, inc, k, len, ok: segments 1 2 3 and release, as m_adsr */
        rate_env_t rateenv;
        struct { int32_t v, rk, inc, k; uint32_t t, len; uint8_t stage, prev, cst; } env8;   /* Q30, as env; one step's rates
                                                    * cached (cst: its step, 0 none; rk: the rate they are for): worked out
                                                    * again when the step changes or its rate moves */
        struct { int16_t *buf; uint32_t w, seed; int32_t lp, s1, err, burst, blen; } str;   /* Q13 line with error feedback */
        struct { uint32_t phase; int32_t s1; } wt;
        struct { uint32_t phase, r; int32_t s1; uint8_t odd; } pd;   /* r: the resonance sine's phase, restarted every cycle; odd: the second waveform's cycle */
        struct { int16_t *buf; uint32_t w, phase; } ch;
        struct { uint32_t seed; int32_t c1, r1, y, period, since, gleft; int8_t pos, down; } seq;
        /* Steps (modules.ts StepsState): half ticks since the step (-1: the step came half a tick after a tick), the step
         * (-1: the next is the first), times round the pattern, visit: ordinal within the traversal, half: samples to a step half a tick after a tick (1/64),
         * a swung step waiting (samples, which), clk mode's edge distance; slen / sst: the step's length and samples since
         * it began (live recording rounds to the nearest step); skip: a step recorded ahead, its notes not played again
         * when reached; hit: 1 / 2 (accented) = sound now (eng_steps_hit); pitch / vel: the outputs' held values (Q16, the
         * last note that started); the notes sounding are the track's (E.trk_snd) */
        struct { uint32_t seed, loop; int32_t c1, r1, since, period, half, pend, slen, sst, pitch, vel; int16_t count; int8_t pos, pstep, skip; uint8_t run, gap, mute, hit, skipn, visit; } stp;   /* y: the glide one-pole, Q24; period / since: clock edge distance in samples (since -1 before the first edge) */
        /* Drum map (modules.ts DrumMapState): its rows' velocities (Q16), the rows whose gate is up, the rows that restart
         * this block (a low first sample) */
        struct { int32_t vel[DRUMMAP_NOUT / 2]; uint32_t held[4]; uint8_t gate, gap, fell; } dm;   /* fell: let go since the last
                                                    * block; held: with repeat on (#184), the keys down (bit k & 31 of held[k >> 5]) */
        struct { int32_t count, c1, r1; } cdv;
        struct { int32_t v, c1; } sh;
        struct { uint32_t rnd, rnd0; uint8_t reg, pat, c1, r1; } shr;   /* Shift register: the flip stream and where a reset restarts it; the stages (s1 in bit 7), the pattern a reset restores, clock / reset high at the previous sample */
        struct { uint8_t hi; } cmp;   /* Comparator: gt is high */
        struct { int32_t rem, t1; } pls;
        struct { int32_t w[SELECT_NOUT - 1]; int8_t k; uint8_t fading; } sel;   /* Selector: each input's weight (Q16), the position (-1: none yet) */
    } s;
} inst_t;

typedef struct {
    uint8_t type, disabled_inputs;
    uint16_t conn;                   /* bit i: input i has a cable (the Selector has 11 inputs) */
    uint8_t morph;                   /* this module has a B side; legacy binaries morph every module */
    uint8_t bypass;                  /* 1: process() is skipped, the outputs copy the through input (DEFS[].thru) or are silent */
    uint8_t inst0, ninst;            /* its instances in inst_pool[]: one per part of its poly group, else one */
    uint8_t grp;                     /* its poly group (E.grp[]): 0 = it runs once and plays the shared keyboard */
    uint32_t map[2];                 /* the matrix: bit j of map[s] = source s (p1, p2) controls parameter j */
    uint32_t input_map[MAX_IN];      /* additional side-input destinations, independent of fixed links */
    int32_t att[2];                  /* attenuverters of p1, p2: Q16, -2..2 (patch.ts DEPTH_MAX, #526) */
    int32_t *par;                    /* its type's npar values in par_pool, then, when E.has_b, the morph B side (PARB): npar unit
                                      * positions (0..65535 of the range, octaves for a log parameter); par_spare until it loads */
    uint32_t over;                   /* bit j: parameter j's B side is past pmax (a stretch, DEF_TOP): PARB(nd)[j] is B - pmin in 1/2048 */
    uint32_t ranged[2];              /* bit j: input p1 / p2 has a macro range on parameter j (the entry is in E.ranges) */
    uint8_t trk;                     /* a Steps module: its track (E.trk_first / trk_n / trk_snd) */
    uint8_t locked;                  /* a P-lock (#524) can set one of its parameters (apply_cv: lock_base) */
    uint8_t ksrc;                    /* a Drum map: where its keys come from (0 none, 1 the keys, 2 + a Steps module's or an
                                      * Arpeggiator's index); a Steps module: 1 = a cable from Main's keys into its keys in
                                      * (engine.ts fed); an Arpeggiator: 0 Main's keys, 2 + the Steps module cabled into its
                                      * keys in (engine.ts ArpRun.feed: it plays that track's notes) */
} node_t;

/* a node's morph B side: right after its parameters (eng_load gives it twice its type's npar when the patch has one) */
#define PARB(nd) ((nd)->par + DEFS[(nd)->type].npar)

/* a macro range: input `pin` (0 p1, 1 p2) of module `mod` moves parameter `par` between lo and hi (0..255 of the range,
 * octaves for a log parameter, morph_unit space) instead of adding to its base; `bi` (format 49, #526: bit 7 of the pin
 * byte, patchbin.ts RANGE_BIPOLAR): the input's -1..1 spans the ends, not 0..1 */
typedef struct { uint8_t mod, pin, par, lo, hi, bi; } range_t;
#define RANGE_BIPOLAR 0x80u

typedef struct {
    esig_t *dst;
    uint16_t first, n;       /* sources in sum_src[] */
} sum_t;

/* a part: the note it plays (what the Part module, or the Main module for the shared keyboard, outputs) plus what the
 * allocator needs (engine.ts VoiceState). (A "voice" in the panel's words is a whole patch, eng_t.) */
typedef struct {
    int32_t pitch, gate, vel;
    int32_t jump;                    /* the last pitch step, octaves Q16 (the Part module's jump output) */
    uint8_t note, on, retrig;        /* note: the last key it played (255: none yet); on: a key holds it; retrig: taken over
                                        while sounding, this block's gate starts with one low sample */
    uint8_t key_trig;                /* a key press reached the allocator in this block */
    uint8_t legato;                  /* the note began over a held one (the Part module's legato output) */
    uint32_t on_stamp, off_stamp;
    walk_t dw;                       /* the drift's random walk (modules.ts driftSeed), stepped every block */
    int32_t flaw;                    /* the pitch flaw, octaves Q16: detune + drift (modules.ts flawQ16); the Part module adds it */
    uint8_t idle, skip;              /* idle: released and silent, its modules are skipped (part_idle); skip: this block */
} pv_t;

/* an allocator and its parts (engine.ts Group): grp[0] is the shared keyboard (one part, legato auto, last note), grp[1..]
 * the poly groups of the patch binary. One part: the held keys, the sounding one chosen among them. */
#define ENG_MAX_GROUPS POLY_MAX_GROUPS
#define ENG_NPV (1 + ENG_MAX_GROUPS * ENG_MAX_PARTS)
typedef struct {
    uint8_t parts, assign, legato, priority;   /* patch.ts PolyCfg */
    uint8_t no_steal;               /* format 37: refuse extra polyphonic notes instead of taking a held voice */
    uint32_t down[4];               /* all 128 held input keys, even if stolen or refused */
    uint8_t unison, stack;           /* unison mode and its voice count (0: all parts) */
    uint8_t assign0, unison0;        /* assign and unison as the record sets them; assign and unison are as they play: a
                                      * cable into the Part's assign / unison input moves them (#681, group_cables) */
    uint8_t mode;                    /* that Part's node, 0xFF: no such cable */
    int32_t cv[2];                   /* what those cables carried at the end of the last block (Q16) */
    int8_t detune[ENG_MAX_PARTS];    /* each part's flaws (patch.ts PartFlaw): cents, */
    uint8_t drift[ENG_MAX_PARTS];    /* % of +-20 cents of wander, */
    int8_t bright[ENG_MAX_PARTS];    /* semitones on the filter cutoffs, */
    int8_t env[ENG_MAX_PARTS];       /* % on the envelope times, */
    uint8_t level[ENG_MAX_PARTS];    /* % of the VCA gains */
    uint8_t rot;                     /* rotate: the part the next note tries first */
    uint8_t src;                     /* where its notes come from: 0 the keys, else 1 + the node index of an Arpeggiator */
    uint8_t ch, lo, hi;              /* the keys it takes: MIDI channel (0: the device's), lowest and highest (patch.ts takesKey) */
    uint8_t pv0;                     /* its first part in E.pv[] */
    uint8_t nheld;
    uint8_t held_note[MAX_HELD];
    int32_t held_vel[MAX_HELD];
} grp_t;

/* a note a Steps track sounds (modules.ts StepsSound): the key it sent, steps to go after the one it is on, samples left;
 * thru: a key played into the track (#134, #139: the note played + 1, 0 = one of its own), sounding until it is let go;
 * dr (modules.ts SND_WRAP, #384): bit 7 a note tied across the loop point (the end of a pass does not cut it), bits 0..6 a
 * drone's step + 1 */
#define SND_WRAP 0x80u
typedef struct { uint8_t key, left, thru, dr; int32_t cnt; } snd_t;
/* a locked row (#524): its track, its parameters (module, parameter; its own first), a lock on it now and its value */
typedef struct { uint8_t trk, n, on, mod[ENG_LOCK_PAIRS], par[ENG_LOCK_PAIRS]; int32_t v; } lrow_t;
/* a lock: its track, pattern, step, row (E.lt index) and value (Q16, the row's parameter's units) */
typedef struct { uint8_t trk, pat, at, row; int32_t v; } lock_t;

/* keys in (#139; engine.ts arm / thru): the keys played into a track (the armed one, or one a cable from Main's keys
 * feeds) wait in a ring the main loop fills and the audio side empties at the start of a block (eng_note_on runs
 * outside the interrupt): module index, the note (bit 7: on), velocity */
#define ENG_THRU 32u
static uint8_t thru_ring[ENG_THRU][3];
static volatile uint8_t thru_head, thru_tail;
/* where in the ring track t's thru_kill came (thru_head then, #748): the keys put in before it go quiet with the ones
 * sounding, the keys put in after it play (engine.ts thruOff: its note-offs join the track's keys in order). A key pressed
 * right after SEL armed its device, before the next block, was cut with the old set's keys */
static volatile uint8_t thru_kill_at[ENG_MAX_TRACKS];
/* live recording (#135, #139): the notes being recorded (track, note, the step they landed on, velocity, samples since
 * that step began, negative before it) and the recorded ones for the main loop (eng_steps_take: module, note word) */
#define ENG_RIN 16u
typedef struct { uint8_t trk, note, at, vel; int32_t t; } rin_t;
#define ENG_TOOK 32u
static uint32_t took_ring[ENG_TOOK][2];
static volatile uint8_t took_head, took_tail;

/* a Steps note (track.ts noteWord): bits 0..5 the start step, 6..11 the length - 1, 12..18 the note, 19..25 the velocity,
 * 26..30 the chance code (100 - chance) / 5 */
#define NW_AT(w) ((w) & 63u)
#define NW_LEN(w) ((((w) >> 6) & 63u) + 1u)
#define NW_NOTE(w) (((w) >> 12) & 127u)
#define NW_VEL(w) (((w) >> 19) & 127u)
#define NW_CODE(w) (((w) >> 26) & 31u)
#define NW(at, len, note, vel, code) ((uint32_t)(at) | ((uint32_t)(len) - 1u) << 6 | (uint32_t)(note) << 12 | (uint32_t)(vel) << 19 | (uint32_t)(code) << 26)

/* an Arpeggiator module as it runs (web/src/arpeggiator.ts, the same steps): its keys in press order, the step counter, the
 * note it plays, samples since the last step and between the last two, the clock tick of its next step, the random mode's
 * generator, the clk input's last state */
typedef struct { uint8_t note, down; int32_t vel; } arp_key_t;
typedef struct {
    uint8_t node, n, running, clk_hi;
    int16_t cur;
    arp_key_t held[ARP_HELD];
    uint32_t pos, since, interval, next, seed, rate_phase;
} arp_t;

/* a Harmonizer module as it runs (web/src/harmonizer.ts, the same steps, #598): the chord buttons down, Lock's press under
 * way, latched set and toggle, the buttons' press order (the quality pressed last wins), the roots held (oldest first)
 * with the notes each started, and per note how many held roots sound it */
typedef struct {
    uint8_t node, down, gesture, locked, toggle, nroots;
    uint8_t root[HARM_ROOTS], nnote[HARM_ROOTS], note[HARM_ROOTS][HARM_TONES];
    uint8_t count[128], button_key[128];          /* MIDI note -> press-time button + 1; zero is not a button */
    uint32_t stamp[HARM_ZONE], clock;
} harm_t;

typedef struct {
    uint8_t loaded, nmod, nsum, norder, nout, ngrp, ninst;   /* ngrp: the poly groups, E.grp[1..ngrp] */
    uint16_t nsrc;
    uint8_t order[ENG_MAX_MODULES], outputs[ENG_MAX_MODULES];
    uint8_t from_m[ENG_MAX_CABLES], from_p[ENG_MAX_CABLES], to_m[ENG_MAX_CABLES], to_p[ENG_MAX_CABLES];
    uint16_t ncab, nbuf, nphys;      /* nbuf: values given a buffer (what the arena counts), nphys: the buffers (#800) */
    node_t *node;                    /* the modules, nmod of them in the arena's top (#721, arena_nodes); node_none until a load */
    sum_t sum[MAX_SUM];
    const esig_t *sum_src[MAX_SRC];
    uint16_t sum_w[MAX_SRC];                 /* 0: the source adds as it is, else its Q16 weight (para_w) */
    grp_t grp[1 + ENG_MAX_GROUPS];
    pv_t pv[ENG_NPV];
    uint32_t stamp;
    uint32_t clk_seen, clk_pulse;    /* MIDI clock ticks counted so far; the Main module's clock pulse length in this block */
    uint32_t ticks, tick_acc;        /* the clock: ticks so far, the tempo's remainder (1 / (60 ENG_SR) of a tick) */
    uint32_t run_ticks;              /* ticks when the transport last started (the tracks' bars count from there: eng_run_ticks) */
    int32_t tick_off, tick_n, tick_len;   /* this block's ticks while running: the sample they fall on (-1 none), how many, samples per tick */
    uint32_t ext_since, ext_len;     /* MIDI clock: samples since its last tick, samples per tick as measured (0: not yet) */
    uint8_t ntrk;
    uint16_t nnotes;                 /* the Steps tracks' notes (#133): track t's pattern p are trk_note[pat_first[t][p] .. +
                                      * pat_n[t][p]), sorted by step, then note (track.ts); the slices lie in the order of
                                      * pat_layout: every track's pattern 0, then track by track its patterns 1.. */
    uint16_t pat_first[ENG_MAX_TRACKS][ENG_PATTERNS];
    uint8_t pat_n[ENG_MAX_TRACKS][ENG_PATTERNS];
    uint8_t pat_len[ENG_MAX_TRACKS][ENG_PATTERNS];    /* its own length, 0 the track's */
    uint8_t pat_rate[ENG_MAX_TRACKS][ENG_PATTERNS];   /* its own rate, 0xFF the track's */
    uint64_t pat_has[ENG_MAX_TRACKS];    /* bit p: the track has pattern p (bit 0 always); one it has not got plays pattern 0 */
    uint8_t trk_pat[ENG_MAX_TRACKS];     /* the pattern each track plays (TRK_P: the slice), the one it plays from the end */
    uint8_t trk_q[ENG_MAX_TRACKS];       /* of its pass (0xFF none; stopped: from its next block), the song entry it plays */
    int8_t trk_spos[ENG_MAX_TRACKS];     /* (-1: the next pass plays the first), the entry's shift (semitones; 0 on a track */
    int8_t trk_shift[ENG_MAX_TRACKS];    /* that plays a Drum map: trk_drum) */
    uint8_t trk_drum[ENG_MAX_TRACKS];
    uint8_t pat_sel, song;               /* the patch's pattern (0-based), the song playing (0 none, 1..ENG_SONGS) */
    uint8_t song_n[ENG_SONGS];           /* the songs: entries, each a pattern and a shift */
    uint8_t song_pat[ENG_SONGS][ENG_SONG_LEN];
    int8_t song_shift[ENG_SONGS][ENG_SONG_LEN];
    uint32_t trk_note[ENG_MAX_NOTES];
    snd_t trk_snd[ENG_MAX_TRACKS][TRACK_POLY];   /* the notes each track sounds, oldest first */
    uint8_t trk_nsnd[ENG_MAX_TRACKS];
    uint8_t trk_last[ENG_MAX_TRACKS];    /* the last note a track started (a hit from the panel plays it) */
    uint8_t nkev;                    /* keys out of the Steps tracks this block: node index, key (bit 7: on), velocity */
    uint8_t kev[ENG_KEV][3];
    uint8_t arm;                     /* the armed Steps module + 1 (#139; engine.ts arm), 0 none: the first armed track (REC's) */
    eng_mset_t armm;                 /* the armed modules (#191, eng_arm_mask): while any is (armany) only they hear Main's keys */
    uint8_t armany;
    uint32_t armg;                   /* bit g: poly group g hears Main's keys while a module is armed */
    uint16_t trk_rec;                /* bit t: track t records what is played through it (eng_steps_rec) */
    volatile uint16_t thru_kill;     /* bit t: track t lets go of the keys played through it (at its next block) */
    uint8_t nthru;                   /* keys in taken from the ring for this block (m_steps reads its own) */
    uint8_t blk_q0;                  /* the ring position of blk_thru[0] (for thru_kill_at) */
    uint8_t blk_thru[ENG_THRU][3];
    uint8_t nrin;
    rin_t rin[ENG_RIN];
    uint8_t running;                 /* the transport as this block saw it */
    uint8_t narp;
    arp_t arp[ENG_MAX_ARPS];
    uint8_t nharm;
    harm_t harm[ENG_MAX_HARMS];
    int32_t ctl[ENG_NCTL];           /* pitch bend, mod wheel, aftertouch (engine.h ENG_CTL_*), Q16 */
    uint8_t has_b;                   /* the patch carries a morph B set (PARB) */
    uint8_t nranges;
    range_t ranges[ENG_MAX_RANGES];
    uint8_t btn_kind[ENG_PANEL_BUTTONS];   /* the button kinds (ENG_BTN_*, flag bit 6; without it every one is a Gate) */
    uint8_t btn_first[ENG_PANEL_BUTTONS], btn_n[ENG_PANEL_BUTTONS];   /* a Toggle's modules: btn_list[first .. first + n) */
    uint8_t btn_list[ENG_BTN_TARGETS];
    uint16_t btn_sw;                 /* the buttons that switch (the panel's mask) */
    int8_t main;                     /* the Main module, -1 without one */
    int32_t morph;                   /* the morph position of this block, Q16 0..1: the Main's MORPH parameter plus the mean of its morph input */
    uint8_t idle_blk;                /* blocks mod IDLE_CHECK (never reset): which idle parts run their check (part_quiet) */
    uint8_t nlt;                     /* the locked rows (#524, locks.ts lockPlan): each a track's, its parameters, whether a */
    lrow_t lt[ENG_LOCK_TARGETS];     /* lock sets them now and to what */
    uint16_t nlk;                    /* the locks, by track, then pattern (as the binary lists them) */
    lock_t lk[ENG_MAX_LOCKS];
    int16_t trk_lkey[ENG_MAX_TRACKS];   /* the pattern and step a track's locks were applied for (locks_step; -1 none, -2 again) */
    uint8_t trk_once[ENG_MAX_TRACKS];   /* play once (#632, modules.ts StepsState.once): 0 not, 1 its passes played (it
                                         * loops on until the last ends: steps_fire), n >= 2: n - 1 pass ends to go (the start counts as
                                         * one; steps_turn counts) */
} eng_t;

/* the slice of the pattern track t plays (one it has not got: pattern 0), its first note and count */
#define TRK_P(t) ((E.pat_has[t] >> E.trk_pat[t] & 1u) ? (uint32_t)E.trk_pat[t] : 0u)
#define TRK_FIRST(t) E.pat_first[t][TRK_P(t)]
#define TRK_N(t) E.pat_n[t][TRK_P(t)]

/* the engine. The clock ticks (24 ppqn) come from the arpeggiator or MIDI in (eng_clock_tick). */
static eng_t eng_one ENG_POOL;
#define E eng_one
/* the knobs' pending ramps (#405, eng_knob_param): the module and parameter, blocks left, the offset still to go, its step */
typedef struct { int32_t mod, par, left, off, step; } ramp_t;
static ramp_t ramp[ENG_KNOBS];
static int32_t ramp_buf[2][MAX_PAR];       /* (one per lane, #271) */
static void toggles_sync(void);
static volatile uint32_t clk_ticks;   /* MIDI clock ticks (eng_clock_tick, the main loop) */
static volatile uint8_t clk_ext;      /* MIDI clock drives the clock */
static volatile uint8_t transport_on; /* the transport (eng_transport) */
/* play once (#632, eng_play_once; engine.ts playOnce, the same): the main loop's last word (once_cmd: 1 play once, 2 end
 * it) counts once_gen up and the next block takes it (once_seen); the engine's state (once_st: 0 not, 1 counting in, 2
 * playing), the transport while it plays (once_run: eng_transport_running adds it), the count-in's ticks, its first
 * block to come, the transport's edge in this render made by play once (eng_clock_out: 2 / -2); the click sounding:
 * its sample (-1 none) and half period */
static volatile uint8_t once_cmd, once_gen, once_st, once_run;
static uint8_t once_seen, once_first, once_edge;
static uint32_t once_cin;
/* play once: the sample of this block where the last Steps track still playing its passes ends them (steps_once_at; -1
 * not in this block). From there no track plays a note more: a shorter track loops until then (D-820) */
static int32_t once_end_at = -1;
/* REC's count-in click (D-803, eng_count_in): the main loop's request (the ticks then, the bars; 0 none) counts cin_gen
 * up and a block while the transport runs takes it (cin_seen); then the bar it starts on and the one it ends on, in
 * ticks from the transport's start (eng_run_ticks), as seq_ui.c seq_cin_poll counts them */
static volatile uint8_t cin_gen, cin_req_bars;
static volatile uint32_t cin_req_at;
static uint8_t cin_seen, cin_on;
static uint32_t cin_from, cin_end;
/* the click (both count-ins): its sample (-1 none) and half period as the block goes. It is not in eng_render's output:
 * eng_click_mix adds it to the analog output only (D-820), from where it stood as the render began (click_k0, click_h0)
 * and the clicks the render started (click_ev: the sample, the half period) */
#define CLICK_EV 4u
static int32_t click_k = -1, click_half = 1, click_k0 = -1, click_h0 = 1;
static uint32_t click_nev;
static struct { uint32_t at; int32_t half; } click_ev[CLICK_EV];
/* MIDI clock out (#473, eng_clock_out): the last eng_render's tempo ticks, their samples in it, the transport's edge in it */
#define CKO_MAX 4u
static struct { uint8_t n, run; int8_t edge; uint16_t off[CKO_MAX]; } cko;
static volatile uint16_t tempo_glo;   /* the global tempo (eng_tempo_global): bpm, 0 none, ENG_TEMPO_ADOPT the next patch's */
static uint8_t tempo_moved;           /* eng_set_param or a load moved it (eng_tempo_moved) */
static int32_t tempo_own;             /* the running patch's own tempo (Q16) while the global one plays */
static void tempo_apply(void);
static volatile uint16_t panel_buttons; /* the patch buttons held / switched on (eng_buttons) */

/* the arena's module copies (inst_pool, at the start of eng_arena below): inst_pool[0] is the spare every node points at
 * until its own copies are taken (eff = par_spare, eng_get_param after a failed load); a load takes the rest in module
 * order (arena_inst) */
/* the part an instance renders (0 for a module that runs once), its group (E.grp[0], the shared keyboard, for a module that
 * runs once) and the part it plays: from the instance itself, so two cores can render two parts at once (#271) */
#define IT_V(nd, it) ((uint32_t)((it) - &inst_pool[(nd)->inst0]))
#define IT_G(nd) (&E.grp[(nd)->grp])
#define IT_PV(nd, it) (&E.pv[E.grp[(nd)->grp].pv0 + IT_V(nd, it)])
/* the lane an instance renders in (#271): the odd parts of a poly group are lane 1, which the second core may render while
 * core 0 renders lane 0; each lane has its own scratch (lane_scr) and its own dummy output */
#if ENG_AOT && ENG_AOT_PAIR
static const uint8_t *aot_worker_nodes;
#define IT_LANE(nd, it) ((nd)->grp ? IT_V(nd, it) & 1u : aot_worker_nodes ? aot_worker_nodes[(nd) - E.node] : 0u)
#else
#define IT_LANE(nd, it) ((nd)->grp ? IT_V(nd, it) & 1u : 0u)
#endif
/* a granular line: the recording (Q13 like the delay) and the grains reading it (start, read phase from it Q16, rate Q16,
 * window phase and increment (u32 turns, half a turn over the grain), samples left) */
typedef struct { uint32_t start, rp, rate, wph, winc, left; } grain_t;
typedef struct grain_line { int16_t buf[GRAIN_LEN]; grain_t g[GRAIN_MAX]; } grain_line_t;
/* The memory a patch takes (#649): one arena in the pool, divided when the patch loads. From its bottom, the spare copy
 * and the module copies (inst_t, ENG_INST_BYTES each on the FM-1), then the signal buffers (ENG_BUF_BYTES); from its top
 * the parameter values (4 bytes each: a node's, twice that with a morph B side, and each copy's effective ones); the lines
 * of the line-type modules go last, into what is left between them or into line_low. The arena is as big as the fixed
 * pools it replaces were (128 copies, 255 buffers, 1536 values, the line area of a 700 ms delay line, 8 string lines and
 * a granular line) and the spare copy, so every patch that loaded before still loads. The editor's budget models the same (web/src/patchbin.ts ARENA, memoryBudget). A build whose inst_t
 * is bigger (a 64-bit host) gets the difference for every copy it can take, so it loads what the FM-1 loads; the fit is
 * counted in the FM-1's bytes (arena_free). */
#define ENG_INST_BYTES 264u
#define ENG_BUF_BYTES (ENG_BLOCK * 4u)
#if defined(M1_FW_MAJOR) && !defined(__wasm__)              /* (the FM-1 build, tools/build.py: its compiler's size) */
typedef char eng_inst_bytes_check[sizeof(inst_t) == ENG_INST_BYTES ? 1 : -1];   /* (patchbin.ts INST_BYTES follows it) */
#endif
/* The lines of the line-type modules: the Delays (their length, dly_samples), the strings and combs (a line per copy),
 * the granulars, the reverbs and the choruses (D-375). They share two areas, divided when a patch loads (line_place):
 * what the arena has left, and line_low in .lowram (D-373), as big as the reverb and chorus lines were there and 8 KiB
 * more. The editor's budget models the same (web/src/patchbin.ts linePlace, memoryBudget): a patch fits when every line
 * does. A new line-type module only needs its bytes in line_bytes. */
#define LINE_BYTES(n) (((uint32_t)(n) + 3u) & ~3u)
#define LINE_ARENA (LINE_BYTES(2u * DELAY_LEN) + 8u * LINE_BYTES(2u * STR_LEN) + LINE_BYTES(sizeof(grain_line_t)))   /* 167,980 B */
#define LINE_LOW (LINE_BYTES(2u * RV_LEN) + LINE_BYTES(2u * CH_LEN) + 8192u)                                        /* 26,196 B */
/* the modules (node_t, ENG_NODE_BYTES each on the FM-1) come from the arena's top too (#721): it is bigger by the 64
 * nodes the fixed table held before, so a patch of up to 64 modules has at least the room it had */
#define ENG_NODE_BYTES 92u
#if defined(M1_FW_MAJOR) && !defined(__wasm__)
typedef char eng_node_bytes_check[sizeof(node_t) == ENG_NODE_BYTES ? 1 : -1];   /* (patchbin.ts NODE_BYTES follows it) */
#endif
#define ENG_ARENA (LINE_ARENA + 255u * ENG_BUF_BYTES + 129u * ENG_INST_BYTES + 1536u * 4u + 64u * ENG_NODE_BYTES)   /* 344,628 B */
#define ENG_ARENA_HOST (ENG_ARENA + (ENG_MAX_INST + 1u) * (sizeof(inst_t) > ENG_INST_BYTES ? (uint32_t)sizeof(inst_t) - ENG_INST_BYTES : 0u) \
                        + (sizeof(node_t) > ENG_NODE_BYTES ? ENG_MAX_MODULES * ((uint32_t)sizeof(node_t) - ENG_NODE_BYTES) + 8u : 0u))
static uint32_t eng_arena[ENG_ARENA_HOST / 4u] ENG_POOL __attribute__((aligned(8)));
#define inst_pool ((inst_t *)eng_arena)           /* (the copies start the arena: a fixed address, as the old array's) */
static uint32_t ar_lo, ar_hi, ar_ninst, ar_nnode, ar_npad;   /* bytes taken from the bottom and from the top; copies taken (the
                                                              * spare too); nodes taken, and the bytes their alignment took */
static uint32_t line_low[LINE_LOW / 4u] ENG_LOWRAM;
static uint32_t arena_size = ENG_ARENA;     /* (a test may make it smaller, to reach a patch that does not fit) */
/* the arena's bytes still free, counted as on the FM-1 (a copy as ENG_INST_BYTES) */
static uint32_t arena_free(void)
{
    uint32_t used = ar_lo - ar_ninst * (uint32_t)sizeof(inst_t) + ar_ninst * ENG_INST_BYTES
                  + ar_hi - ar_nnode * (uint32_t)sizeof(node_t) - ar_npad + ar_nnode * ENG_NODE_BYTES;
    return used < arena_size ? arena_size - used : 0u;
}
/* n bytes from the bottom (a multiple of 4), 0 if they do not fit */
static void *arena_lo(uint32_t n)
{
    uint8_t *q = (uint8_t *)eng_arena + ar_lo;
    if (n > arena_free())
        return 0;
    ar_lo += n;
    return q;
}
/* `count` zeroed module copies in a row, their first index, -1 if they do not fit (or past ENG_MAX_INST) */
static int arena_inst(uint32_t count)
{
    uint32_t i0 = ar_ninst, j;
    uint8_t *z;
    if (ar_ninst + count > ENG_MAX_INST + 1u || (count && arena_free() < count * ENG_INST_BYTES))
        return -1;
    z = (uint8_t *)&inst_pool[i0];
    ar_lo += count * (uint32_t)sizeof(inst_t);
    ar_ninst += count;
    for (j = 0; j < count * sizeof(inst_t); j++)
        z[j] = 0;
    return (int)i0;
}
/* n zeroed nodes from the arena's top, before anything else is taken from there (eng_load); 0 if they do not fit */
static node_t *arena_nodes(uint32_t n)
{
    uintptr_t top = (uintptr_t)eng_arena + ENG_ARENA_HOST, q;
    uint32_t j;
    uint8_t *z;
    if (ar_hi || n * ENG_NODE_BYTES > arena_free())
        return 0;
    q = (top - n * (uint32_t)sizeof(node_t)) & ~(uintptr_t)(__alignof__(node_t) - 1u);
    ar_npad = (uint32_t)(top - q) - n * (uint32_t)sizeof(node_t);   /* (0 on the FM-1: the arena's size is a multiple of 4) */
    ar_hi = (uint32_t)(top - q);
    ar_nnode = n;
    z = (uint8_t *)q;
    for (j = 0; j < n * sizeof(node_t); j++)
        z[j] = 0;
    return (node_t *)q;
}
/* a Delay's line, samples, from its length (Q16 ms, rounded to whole ms, 10..1900): the length's samples rounded up to an
 * even count (ping-pong halves it) and 60 more, so a time of the whole length fits; 700 ms: DELAY_LEN (modules.ts
 * delayLine) */
static uint32_t dly_samples(int32_t length_q16)
{
    uint32_t ms = (uint32_t)clampi((length_q16 + 32768) >> 16, DELAY_LENGTH_MIN, DELAY_LENGTH_MAX);
    return 2u * ((ms * ENG_SR + 1999u) / 2000u) + 60u;
}
/* the bytes of one copy's line for a module of type t with parameters par (0: not a line-type module) */
static uint32_t line_bytes(uint32_t t, const int32_t *par)
{
    switch (t) {
    case T_DELAY: return LINE_BYTES(2u * dly_samples(par[DELAY_P_LENGTH]));
    case T_STRING: case T_COMB: return LINE_BYTES(2u * STR_LEN);   /* (the comb uses a string line, it->s.str) */
    case T_GRAIN: return LINE_BYTES(sizeof(grain_line_t));
    case T_REVERB: return LINE_BYTES(2u * RV_LEN);
    case T_CHORUS: return LINE_BYTES(2u * CH_LEN);
    default: return 0;
    }
}
/* Where n lines of these sizes go (patchbin.ts linePlace): the largest first (of equal ones the first), each into the
 * area with the least room that holds it (line_low when both have the same); reg[i] its area (0 line_low, 1 what the
 * arena has left, from ar_lo), at[i] its byte offset there. 0 = every line placed, -1 one does not fit. */
static int line_place(const uint32_t *bytes, uint32_t n, uint8_t *reg, uint32_t *at)
{
    uint32_t used[2] = {0, 0}, i, k;
    for (i = 0; i < n; i++)
        reg[i] = 0xFFu;
    for (k = 0; k < n; k++) {
        uint32_t best = n, f0, f1;
        int ok0, ok1, r;
        for (i = 0; i < n; i++)
            if (reg[i] == 0xFFu && (best == n || bytes[i] > bytes[best]))
                best = i;
        f0 = LINE_LOW - used[0];
        f1 = arena_free() - used[1];
        ok0 = bytes[best] <= f0;
        ok1 = bytes[best] <= f1;
        if (!ok0 && !ok1)
            return -1;
        r = ok0 && (!ok1 || f0 <= f1) ? 0 : 1;
        reg[best] = (uint8_t)r;
        at[best] = used[r];
        used[r] += bytes[best];
    }
    return 0;
}
static void *line_at(uint8_t reg, uint32_t at, uint32_t bytes)   /* zeroed */
{
    uint8_t *z = (uint8_t *)(reg ? (uint32_t *)((uint8_t *)eng_arena + ar_lo) : line_low) + at;
    uint32_t j;
    for (j = 0; j < bytes; j++)
        z[j] = 0;
    return z;
}
/* the parameter values (#351): each node gets its type's npar values (twice that with a morph B side), each instance its
 * type's npar effective values, taken from the arena's top at eng_load; a patch that does not fit does not load (-8).
 * Not MAX_PAR per node and instance: most types have far fewer (patchbin.ts, the editor's budget, counts the same). */
static uint32_t par_used;                   /* values taken (host_test checks the editor's count) */
static int32_t par_spare[2u * MAX_PAR];     /* what a node or instance points at before it is loaded (eng_get_param after a failed load) */
static node_t node_none ENG_POOL;           /* E.node before a load has taken the patch's (its nmod is 0 then; in the pool, not the RAM region) */

static int32_t *par_take(uint32_t n)        /* n zeroed values, 0 if they do not fit */
{
    int32_t *q;
    uint32_t i;
    if (4u * n > arena_free())
        return 0;
    ar_hi += 4u * n;
    par_used += n;
    q = (int32_t *)((uint8_t *)eng_arena + ENG_ARENA_HOST - ar_hi);
    for (i = 0; i < n; i++)
        q[i] = 0;
    return q;
}

static const esig_t zero_buf[ENG_BLOCK];
static esig_t dummy_out[ENG_BLOCK], dummy_out1[ENG_BLOCK];   /* every unconnected output (lane 1's, dummy_out1: #271) */
#define IS_DUMMY(p) ((p) == dummy_out || (p) == dummy_out1)


/* ------------------------------------------------------------------ patch loading */

static void visit(uint32_t id, uint8_t *st)
{
    uint32_t c;
    st[id] = 1;
    for (c = 0; c < E.ncab; c++) {
        if (E.to_m[c] != id)
            continue;
        if (st[E.from_m[c]] == 0)
            visit(E.from_m[c], st);
    }
    st[id] = 2;
    E.order[E.norder++] = (uint8_t)id;
}

/* Signal buffers by lifetime (#800). A value (a connected output of one copy, or a summed input of one copy) lives from
 * its writer's place in E.order to its last reader's; a buffer whose value has ended takes a value written later, so a
 * patch needs far fewer buffers than values. The output is the same, bit for bit: every module writes each of its
 * connected outputs whole before anything reads them in that block. A value keeps its own buffer (BUF_FOREVER) when it is
 * read in the next block (a feedback cable; a cable out of its poly group: an idle part's outputs stay silent, part_quiet
 * reads them after the render) or outside the render (buf_late). The second core (#271): lane 1 of a split segment runs
 * at the same time as lane 0, so a buffer serves one lane only (the odd parts of a group that may split, else lane 0),
 * and a value one lane writes and the other reads lives to the end of the segment that reads it. The arena still counts a
 * buffer per value, as the editor's budget does (patchbin.ts memoryBudget): the same patches load. */
#ifndef ENG_BUF_REUSE
#define ENG_BUF_REUSE 1
#endif
#define BUF_FOREVER 0x7FFFFFFF
typedef struct { esig_t *base; uint32_t n, values; int keep; } bufs_t;   /* the buffers (in a row from base), the values given one */
/* may this module's run be split across the cores (lane_splits, before the parts are known: as many as its copies)? */
static int buf_split(const node_t *nd) { return nd->grp && nd->ninst >= 2u && nd->type != T_STEPS; }
static uint32_t buf_lane(const node_t *nd, uint32_t v) { return buf_split(nd) ? v & 1u : 0u; }
/* inputs read outside the module's turn: the Output's after the render, Main's morph and an Arpeggiator's before it, the
 * Part's assign and unison after it (group_cables) */
static int buf_late(const node_t *nd) { return nd->type == T_OUTPUT || nd->type == T_FM1 || nd->type == T_ARP || nd->type == T_PART; }
/* the sources summed into input j of module m (as eng_load wires them: every part of another group's output) */
static uint32_t buf_nsrc(uint32_t m, uint32_t j)
{
    const node_t *nd = &E.node[m];
    uint32_t c, n = 0;
    if ((nd->disabled_inputs & (1u << j)) && !nd->input_map[j])
        return 0;
    for (c = 0; c < E.ncab; c++)
        if (E.to_m[c] == m && E.to_p[c] == j)
            n += E.node[E.from_m[c]].grp && E.node[E.from_m[c]].grp != nd->grp ? E.node[E.from_m[c]].ninst : 1u;
    return n;
}
/* the last place output p of copy s of module m (written at place d, by lane `lane`) is read at; BUF_FOREVER (above) */
static int32_t buf_end(uint32_t m, uint32_t p, uint32_t s, int32_t d, uint32_t lane, const uint8_t *pos, const uint8_t *seg_end)
{
    const node_t *f = &E.node[m];
    int32_t end = d;
    uint32_t c, w;
    for (c = 0; c < E.ncab; c++) {
        uint32_t t = E.to_m[c];
        const node_t *r = &E.node[t];
        if (E.from_m[c] != m || E.from_p[c] != p || ((r->disabled_inputs & (1u << E.to_p[c])) && !r->input_map[E.to_p[c]]))
            continue;                                /* (a disabled input reads zeros) */
        if ((int32_t)pos[t] <= d || (f->grp && r->grp != f->grp) || buf_late(r))
            return BUF_FOREVER;
        for (w = 0; w < r->ninst; w++) {             /* the copies of the reader that read copy s (buf_of) */
            int32_t at = pos[t];
            if ((f->ninst > 1u ? w : 0u) != s)
                continue;
            if (buf_lane(r, w) != lane && buf_split(r))
                at = seg_end[at];
            if (at > end)
                end = at;
        }
    }
    return end;
}
#ifdef ENG_POISON
/* (host tests, tools/engine_exact.sh: every value's buffer is overwritten with noise at each block's start and after its
 * last reader has run, so a read outside its life changes the output) */
static esig_t *poi_buf[ENG_NBUF];
static int32_t poi_end[ENG_NBUF];
static uint32_t poi_n, poi_seed = 1u;
static void poi_fill(esig_t *b)
{
    uint32_t i;
    for (i = 0; i < ENG_BLOCK; i++)
        b[i] = (esig_t)(poi_seed = poi_seed * 1664525u + 1013904223u);
}
static void poi_after(int32_t k)                     /* k = -1: the block's start, every value */
{
    uint32_t i;
    for (i = 0; i < poi_n; i++)
        if (poi_end[i] != BUF_FOREVER && (k < 0 || poi_end[i] == k))
            poi_fill(poi_buf[i]);
}
#endif
/* a buffer for a value written at place def and read up to place end, by lane `lane`; 0 when there is no room */
static esig_t *buf_take(bufs_t *bs, int32_t def, int32_t end, uint32_t lane)
{
    uint32_t b;
    esig_t *q = 0;
    if (bs->keep)
        end = BUF_FOREVER;
    if (++bs->values > ENG_NBUF)
        return 0;
    if (end != BUF_FOREVER)                          /* (a buffer's first two samples hold its value's end and lane until
                                                      * eng_load zeroes them) */
        for (b = 0; b < bs->n && !q; b++)
            if (bs->base[b * ENG_BLOCK + 1u] == (esig_t)lane && bs->base[b * ENG_BLOCK] < def)
                q = bs->base + b * ENG_BLOCK;
    if (!q) {
        if (!(q = (esig_t *)arena_lo(ENG_BUF_BYTES)))
            return 0;
        bs->n++;
    }
    q[0] = end;
    q[1] = (esig_t)lane;
#ifdef ENG_POISON
    poi_buf[poi_n] = q;
    poi_end[poi_n++] = end;
#endif
    return q;
}

static void init_state(const node_t *nd, inst_t *it, uint32_t mod, uint32_t v)
{
    switch (nd->type) {
    case T_OSC: {                        /* modules.ts analogTol with engine.ts instSeed(module index, part) */
        uint32_t seed = (mod * 8u + v + 1u) * 0x9e3779b9u, j;
        for (j = 0; j < 4; j++)
            it->s.osc.tol[j] = (int16_t)q15(hash32(seed ^ ((j + 1u) * 0x85ebca6bu)));
        break;
    }
    case T_RANDOM:                       /* modules.ts random.seed with engine.ts instSeed(module index, part) */
        it->s.rnd.seed = (mod * 8u + v + 1u) * 0x9e3779b9u;
        walk_init(&it->s.rnd.w, it->s.rnd.seed ^ 0x2545f491u);
        it->s.rnd.held_seed = hash32(it->s.rnd.seed ^ 0xa511e9b3u);
        break;
    case T_LFO:
        it->s.lfo.seed = 0x2545f491u;
        it->s.lfo.since = ENG_SR;
        break;
    case T_NOISE:
        it->s.noise.seed = 0x1234567u;
        break;
    case T_STRING:
        it->s.str.seed = 0x3779b97fu;
        it->s.str.blen = 1;
        break;
    case T_STEPS:                        /* modules.ts steps.seed with engine.ts instSeed(module index, part) */
        it->s.stp.seed = (mod * 8u + v + 1u) * 0x9e3779b9u;
        it->s.stp.pos = it->s.stp.skip = -1;
        it->s.stp.since = -1;
        it->s.stp.vel = (int32_t)(((uint32_t)STEP_VEL << 16) / 127u);
        break;
    case T_SEQ:
        it->s.seq.seed = 0x9e3779b9u;
        it->s.seq.since = -1;
        break;
    case T_GRAIN:
        it->s.gr.seed = 0x7f4a7c15u;
        break;
    case T_CLKDIV:
        it->s.cdv.count = -1;
        break;
    case T_SHREG: {                      /* modules.ts shreg.seed with engine.ts instSeed(module index, part) */
        uint32_t seed = (mod * 8u + v + 1u) * 0x9e3779b9u;
        uint8_t pat = (uint8_t)(hash32(seed ^ SHREG_PAT_SEED) >> 24);
        it->s.shr.pat = it->s.shr.reg = pat ? pat : (uint8_t)SHREG_PAT_ZERO;
        it->s.shr.rnd = it->s.shr.rnd0 = hash32(seed ^ SHREG_FLIP_SEED);
        break;
    }
    case T_SELECT:
        it->s.sel.k = -1;
        break;
    default:
        break;
    }
}

/* the buffer of output p of module m as part v sees it (a module that runs once has one) */
static esig_t *buf_of(uint32_t m, uint32_t p, uint32_t v)
{
    const node_t *nd = &E.node[m];
    return inst_pool[nd->inst0 + (nd->ninst > 1 ? v : 0)].out[p];
}

/* A paraphonic group's mix (engine.ts paraMix, #125): output p of module m, a poly group's, summed into a module outside
 * the group weighs each part by 1 / parts (Q16) when it is audio and the group does not gate its parts (no cable from its
 * Part's gate or legato output to a module inside the group): such parts sound played or not. 0: added as it is. */
static uint16_t para_w(uint32_t m, uint32_t p)
{
    const node_t *f = &E.node[m];
    uint32_t c;
    if (f->ninst < 2 || !(DEFS[f->type].aout & (1u << p)))
        return 0;
    for (c = 0; c < E.ncab; c++) {
        const node_t *a = &E.node[E.from_m[c]];
        if (a->type == T_PART && a->grp == f->grp && E.node[E.to_m[c]].grp == f->grp && (E.from_p[c] == PART_O_GATE || E.from_p[c] == PART_O_LEGATO))
            return 0;
    }
    return (uint16_t)((65536u + f->ninst / 2u) / f->ninst);
}

static inline int32_t rd32(const uint8_t *p)
{
    return (int32_t)((uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24);
}

/* Every walk over a patch binary's records goes through these: the layout depends on the binary's format (p[1], `ver`).
 * A parameter appended to a type in a later format (ParamDef.since, defs.h psince) is not in an older binary: such a
 * record holds the parameters of its own format, and the reader gives the rest their defaults. */
/* the parameters a record of this type holds in a binary of format `ver` (the first ones of the type: they are appended) */
static inline uint32_t eng_npar(const def_t *d, uint32_t ver)
{
    uint32_t n = d->npar;
    if (d->psince)
        while (n && d->psince[n - 1u] > ver)
            n--;
    return n;
}
/* bytes of a parameter mask of this type (the matrix, an input route): u16, u32 for a type with more than 16 parameters
 * in that format (patchbin.ts maskBytes) */
static inline uint32_t eng_mask_bytes(const def_t *d, uint32_t ver) { return eng_npar(d, ver) > 16u ? 4u : 2u; }
static inline uint32_t eng_rdmask(const uint8_t *p, uint32_t bytes) { return bytes == 4u ? (uint32_t)rd32(p) : ((uint32_t)p[0] | (uint32_t)p[1] << 8); }
/* the p1 (s 0) / p2 (s 1) mask a type with parameter inputs has at its template (patchbin.ts matrixTemplate, defaultMap):
 * its first / second parameter, unless that one was appended later */
static inline uint32_t eng_mask_template(const def_t *d, uint32_t s)
{
    return s < d->npar && (!d->psince || !d->psince[s]) ? 1u << s : 0u;
}
/* the bytes of the items a format 51 presence byte marks (ENG_PRES_*) */
static inline uint32_t eng_pres_bytes(const def_t *d, uint32_t ver, uint32_t pres)
{
    return ((pres & ENG_PRES_ATT1) ? 4u : 0u) + ((pres & ENG_PRES_ATT2) ? 4u : 0u)
        + (((pres & ENG_PRES_P1) ? 1u : 0u) + ((pres & ENG_PRES_P2) ? 1u : 0u)) * eng_mask_bytes(d, ver);
}
/* bytes a record of a format before ENG_COUNTED has beyond its type byte and parameters: the attenuverters and the six
 * masks (p1, p2, k1..k4), then its data */
static inline uint32_t eng_old_extra(const def_t *d, uint32_t ver) { return (d->cvbase >= 0 ? 8u + 6u * eng_mask_bytes(d, ver) : 0u) + d->ndata; }
/* bytes before a record's parameters: its type byte, and since ENG_COUNTED (#667) its parameter count */
static inline uint32_t eng_rec_head(uint32_t ver) { return ver >= ENG_COUNTED ? 2u : 1u; }
/* the parameters the record at p[at] holds (its type byte valid; since ENG_COUNTED p[at + 1] must be in the binary): its
 * count since ENG_COUNTED (the ones after it are at their defaults, patchbin.ts storedParams), else its format's
 * (eng_npar). A count past its format's is malformed: eng_rec_ok */
static inline uint32_t eng_rec_npar(const uint8_t *p, uint32_t at)
{
    return p[1] >= ENG_COUNTED ? p[at + 1u] & ENG_REC_COUNT : eng_npar(&DEFS[p[at] & 0x7Fu], p[1]);
}
/* where the attenuverters and masks of the record at p[at] start (a type with parameter inputs; format 51: its presence
 * byte, unless ENG_REC_TEMPLATE) */
static inline uint32_t eng_rec_block(const uint8_t *p, uint32_t at)
{
    return at + eng_rec_head(p[1]) + 4u * eng_rec_npar(p, at);
}
/* the record at p[at] (at < len) is whole enough to size: its type is known and, since ENG_COUNTED, its count byte (and a
 * presence byte it has) is in the binary, the count at most its format's, its flag bits ones its type can have */
static inline int eng_rec_ok(const uint8_t *p, uint32_t len, uint32_t at)
{
    const def_t *d;
    uint32_t c, b;
    if (at >= len || (p[at] & 0x7Fu) >= N_TYPES)
        return 0;
    if (p[1] < ENG_COUNTED)
        return 1;
    d = &DEFS[p[at] & 0x7Fu];
    if (at + 1u >= len)
        return 0;
    c = p[at + 1u];
    if ((c & ENG_REC_COUNT) > eng_npar(d, p[1]) || (c & 0x40u) || ((c & ENG_REC_TEMPLATE) && d->cvbase < 0))
        return 0;
    if (d->cvbase < 0 || (c & ENG_REC_TEMPLATE))
        return 1;
    b = eng_rec_block(p, at);
    return b < len && !(p[b] & ~ENG_PRES_ALL);
}
/* the size of the record at p[at] (eng_rec_ok), its type byte included */
static inline uint32_t eng_rec_size(const uint8_t *p, uint32_t at)
{
    const def_t *d = &DEFS[p[at] & 0x7Fu];
    uint32_t n = eng_rec_head(p[1]) + 4u * eng_rec_npar(p, at) + d->ndata;
    if (p[1] < ENG_COUNTED)
        return n + eng_old_extra(d, p[1]) - d->ndata;
    if (d->cvbase >= 0 && !(p[at + 1u] & ENG_REC_TEMPLATE))
        n += 1u + eng_pres_bytes(d, p[1], p[eng_rec_block(p, at)]);
    return n;
}
/* bytes of a cable (ENG_FLAG_CABLES3) */
static inline uint32_t eng_cable_bytes(const uint8_t *p) { return (p[7] & ENG_FLAG_CABLES3) ? 3u : 4u; }
/* the set bits among the first n bits at b (a format 51 B bitmap: how many B values follow it, or come before the n-th) */
static uint32_t eng_bits(const uint8_t *b, uint32_t n)
{
    uint32_t k, c = 0;
    for (k = 0; k < n; k++)
        c += b[k >> 3] >> (k & 7u) & 1u;
    return c;
}
/* a bitmap of n bits (ceil(n / 8) bytes) with a bit set past n: malformed */
static inline int eng_bits_past(const uint8_t *b, uint32_t n) { return (n & 7u) && (b[n >> 3] >> (n & 7u)); }

/* the type of module `mod` in a patch binary, -1 if the binary is malformed (a route's mask width depends on it) */
static int eng_type_at(const uint8_t *p, uint32_t len, uint32_t mod)
{
    uint32_t at = eng_records_at(p, len), i;
    if (!at || mod >= p[2])
        return -1;
    for (i = 0; i <= mod; i++) {
        if (!eng_rec_ok(p, len, at))
            return -1;
        if (i == mod)
            return p[at] & 0x7Fu;
        at += eng_rec_size(p, at);
    }
    return -1;
}
/* the end of the side-input routes section (flag bit 3) that starts at `at`: u8 count, then per route u8 module, u8 input
 * and its mask (eng_mask_bytes of the module's type); 0 if malformed */
static uint32_t eng_routes_end(const uint8_t *p, uint32_t len, uint32_t at)
{
    uint32_t n, i;
    if (at >= len)
        return 0;
    n = p[at++];
    for (i = 0; i < n; i++) {
        int t;
        if (at + 2u > len || (t = eng_type_at(p, len, p[at])) < 0)
            return 0;
        at += 2u + eng_mask_bytes(&DEFS[t], p[1]);
    }
    return at <= len ? at : 0;
}
/* the end of the module records and the parameters they hold in all (`npar`, for the morph B set's size), 0 if malformed */
static uint32_t eng_records_end(const uint8_t *p, uint32_t len, uint32_t *npar)
{
    uint32_t at = eng_records_at(p, len), i, n = 0;
    if (!at)
        return 0;
    for (i = 0; i < p[2]; i++) {
        if (!eng_rec_ok(p, len, at))
            return 0;
        n += eng_rec_npar(p, at);
        at += eng_rec_size(p, at);
    }
    if (npar)
        *npar = n;
    return at <= len ? at : 0;
}
/* Format 51's morph B set (flag bit 0, D-1004) from `at` (right after the cables): the module mask (ceil(modules / 8)
 * bytes, bit i: module i has a B side), then per module with one, in module order, a bitmap of the parameters its record
 * holds (ceil(n / 8) bytes, bit j: parameter j's B value follows; the others' B is their A) and those B values. With
 * `mod` < p[2]: the offset of that module's bitmap (0 when it has no B side); else the end of the set. 0 if malformed. */
static uint32_t eng_bset_walk(const uint8_t *p, uint32_t len, uint32_t at, uint32_t mod)
{
    uint32_t r = eng_records_at(p, len), mk = at, i, n, c;
    at += (p[2] + 7u) / 8u;
    if (!r || at > len)
        return 0;
    for (i = 0; i < p[2]; i++) {
        if (!eng_rec_ok(p, len, r))
            return 0;
        n = eng_rec_npar(p, r);
        r += eng_rec_size(p, r);
        if (!(p[mk + (i >> 3)] >> (i & 7u) & 1u)) {
            if (i == mod)
                return 0;
            continue;
        }
        if (i == mod)
            return at;
        if (at + (n + 7u) / 8u > len || eng_bits_past(p + at, n))
            return 0;
        c = eng_bits(p + at, n);
        at += (n + 7u) / 8u + 4u * c;
    }
    return at <= len ? at : 0;
}
/* where the sections after the cables start (the fixed links, flag bit 2, first): past the records, the cables and the
 * morph B set (flag bit 0: before ENG_COUNTED one value per parameter the records hold, eng_rec_npar, then the module mask
 * with flag bit 9; format 51: eng_bset_walk); 0 if malformed */
static uint32_t eng_cables_end(const uint8_t *p, uint32_t len)
{
    uint32_t npar, at = eng_records_end(p, len, &npar);
    if (!at)
        return 0;
    at += eng_cable_bytes(p) * ((uint32_t)p[4] | (uint32_t)p[5] << 8);
    if (at > len)
        return 0;
    if ((p[6] & 1u) && p[1] >= ENG_COUNTED)
        return eng_bset_walk(p, len, at, 0xFFu);
    at += (p[6] & 1u) ? 4u * npar : 0u;
    if (p[7] & ENG_FLAG_MORPH_MODULES)
        at += (p[2] + 7u) / 8u;
    return at <= len ? at : 0;
}

static void eng_put32(uint8_t *p, int32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)((uint32_t)v >> 8);
    p[2] = (uint8_t)((uint32_t)v >> 16);
    p[3] = (uint8_t)((uint32_t)v >> 24);
}
static void eng_putmask(uint8_t *p, uint32_t v, uint32_t bytes)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    if (bytes == 4u) {
        p[2] = (uint8_t)(v >> 16);
        p[3] = (uint8_t)(v >> 24);
    }
}
static void eng_open_gap(uint8_t *p, uint32_t len, uint32_t at, uint32_t n)   /* bytes at..len move up by n */
{
    uint32_t k;
    for (k = len; k > at; k--)
        p[k - 1u + n] = p[k - 1u];
}
static void eng_close_gap(uint8_t *p, uint32_t len, uint32_t at, uint32_t n)  /* bytes at + n..len move down by n */
{
    uint32_t k;
    for (k = at; k + n < len; k++)
        p[k] = p[k + n];
}
static void eng_cut(uint8_t *p, uint32_t *len, uint32_t at, uint32_t n)
{
    eng_close_gap(p, *len, at, n);
    *len -= n;
}
static void eng_gap(uint8_t *p, uint32_t *len, uint32_t at, uint32_t n)
{
    eng_open_gap(p, *len, at, n);
    *len += n;
}

/* Rewrite a binary of an older format in place into a counted one (ENG_COUNTED, engine.h eng_upgrade). The edits go from
 * the binary's end to its start, so the offsets worked out first stay valid: the morph B set, then the records, last
 * to first. */
int eng_upgrade(uint8_t *p, uint32_t *len, uint32_t cap)
{
    uint32_t ver, at, b, e, i, j, n0, morph, ncab, grow, nmod, mb, mbytes;
    uint8_t keep[ENG_MAX_MODULES], pres[ENG_MAX_MODULES], mask[(ENG_MAX_MODULES + 7u) / 8u];
    uint16_t rec[ENG_MAX_MODULES], bat[ENG_MAX_MODULES];   /* each record and its B values, in the older layout */
    if (*len < 8u || p[0] != 0xA1u || p[1] >= ENG_COUNTED)
        return *len >= 8u && p[0] == 0xA1u ? 0 : -1;
    ver = p[1];
    nmod = p[2];
    morph = p[6] & 1u;
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    mbytes = (nmod + 7u) / 8u;
    if (nmod > ENG_MAX_MODULES || !(b = eng_records_end(p, *len, 0)) || b + 4u * ncab > *len)
        return -1;
    b += 4u * ncab;                              /* the morph B set (in the old layout) */
    at = eng_records_at(p, *len);
    e = b;
    grow = nmod;                                 /* (the count bytes) */
    for (i = 0; i < nmod; i++) {                 /* what each record keeps */
        const def_t *d = &DEFS[p[at] & 0x7Fu];
        if (eng_mask_bytes(d, ver) != eng_mask_bytes(d, ENG_PATCH_VERSION))
            return -1;                           /* (a type whose masks widened: none so far) */
        n0 = eng_npar(d, ver);
        rec[i] = (uint16_t)at;
        bat[i] = (uint16_t)e;
        if (morph && e + 4u * n0 > *len)
            return -1;
        e += morph ? 4u * n0 : 0u;
        at += 1u + 4u * n0 + eng_old_extra(d, ver);
    }
    for (i = 0; i < mbytes; i++)                 /* which modules have a B side: the mask after the B values, else every one */
        mask[i] = 0xFFu;
    if (morph && (p[7] & ENG_FLAG_MORPH_MODULES)) {
        if (e + mbytes > *len)
            return -1;
        for (i = 0; i < mbytes; i++)
            mask[i] = p[e + i];
    }
    if (morph && !(p[7] & ENG_FLAG_MORPH_MODULES))
        grow += mbytes;
    for (i = 0; i < nmod; i++) {
        const def_t *d = &DEFS[p[rec[i]] & 0x7Fu];
        uint32_t n, bi = morph && (mask[i >> 3] >> (i & 7u) & 1u), blk;
        n = n0 = eng_npar(d, ver);
        while (n && rd32(p + rec[i] + 1u + 4u * (n - 1u)) == d->pdef[n - 1u] && (!bi || rd32(p + bat[i] + 4u * (n - 1u)) == d->pdef[n - 1u]))
            n--;
        keep[i] = (uint8_t)n;
        pres[i] = 0;
        if (d->cvbase >= 0) {
            mb = eng_mask_bytes(d, ver);
            blk = rec[i] + 1u + 4u * n0;
            pres[i] = (uint8_t)((rd32(p + blk) != ENG_ONE ? ENG_PRES_ATT1 : 0u) | (rd32(p + blk + 4u) != ENG_ONE ? ENG_PRES_ATT2 : 0u)
                | (eng_rdmask(p + blk + 8u, mb) != eng_mask_template(d, 0) ? ENG_PRES_P1 : 0u)
                | (eng_rdmask(p + blk + 8u + mb, mb) != eng_mask_template(d, 1) ? ENG_PRES_P2 : 0u));
            grow += pres[i] ? 1u : 0u;
        }
        if (bi)
            grow += (n + 7u) / 8u;
    }
    if (*len + grow > cap)                       /* (as if every byte it gains came before any it loses) */
        return -1;
    if (morph) {                                 /* the B set, last module first: only the values off A, after a bitmap */
        if (p[7] & ENG_FLAG_MORPH_MODULES)
            eng_cut(p, len, e, mbytes);          /* (the mask moves to the set's start) */
        for (i = nmod; i-- > 0;) {
            const def_t *d = &DEFS[p[rec[i]] & 0x7Fu];
            uint8_t bits[8] = {0, 0, 0, 0, 0, 0, 0, 0};
            n0 = eng_npar(d, ver);
            if (!(mask[i >> 3] >> (i & 7u) & 1u)) {
                eng_cut(p, len, bat[i], 4u * n0);
                continue;
            }
            for (j = n0; j-- > 0;) {
                if (j < keep[i] && rd32(p + bat[i] + 4u * j) != rd32(p + rec[i] + 1u + 4u * j))
                    bits[j >> 3] |= (uint8_t)(1u << (j & 7u));
                else
                    eng_cut(p, len, bat[i] + 4u * j, 4u);
            }
            eng_gap(p, len, bat[i], (keep[i] + 7u) / 8u);
            for (j = 0; j < (keep[i] + 7u) / 8u; j++)
                p[bat[i] + j] = bits[j];
        }
        eng_gap(p, len, b, mbytes);
        for (i = 0; i < mbytes; i++)
            p[b + i] = (uint8_t)(i + 1u < mbytes || !(nmod & 7u) ? mask[i] : mask[i] & ((1u << (nmod & 7u)) - 1u));
        p[7] |= ENG_FLAG_MORPH_MODULES;
    }
    for (i = nmod; i-- > 0;) {                   /* the records, last first */
        const def_t *d = &DEFS[p[rec[i]] & 0x7Fu];
        n0 = eng_npar(d, ver);
        at = rec[i] + 1u + 4u * n0;              /* (the attenuverters and masks) */
        if (d->cvbase >= 0) {
            mb = eng_mask_bytes(d, ver);
            eng_cut(p, len, at + 8u + 2u * mb, 4u * mb);   /* (the knob masks k1..k4) */
            if (!pres[i])
                eng_cut(p, len, at, 8u + 2u * mb);
            else {
                if (!(pres[i] & ENG_PRES_P2))
                    eng_cut(p, len, at + 8u + mb, mb);
                if (!(pres[i] & ENG_PRES_P1))
                    eng_cut(p, len, at + 8u, mb);
                if (!(pres[i] & ENG_PRES_ATT2))
                    eng_cut(p, len, at + 4u, 4u);
                if (!(pres[i] & ENG_PRES_ATT1))
                    eng_cut(p, len, at, 4u);
                eng_gap(p, len, at, 1u);
                p[at] = pres[i];
            }
        }
        eng_cut(p, len, rec[i] + 1u + 4u * keep[i], 4u * (n0 - keep[i]));
        eng_gap(p, len, rec[i] + 1u, 1u);
        p[rec[i] + 1u] = (uint8_t)(keep[i] | (d->cvbase >= 0 && !pres[i] ? ENG_REC_TEMPLATE : 0u));
    }
    p[1] = ENG_PATCH_VERSION;
    return 0;
}

/* the offset of module `mod`'s record in a counted binary, 0 if malformed */
static uint32_t eng_rec_at(const uint8_t *p, uint32_t len, uint32_t mod)
{
    uint32_t at = eng_records_at(p, len), i;
    if (!at || mod >= p[2])
        return 0;
    for (i = 0; i < mod; i++) {
        if (!eng_rec_ok(p, len, at))
            return 0;
        at += eng_rec_size(p, at);
    }
    return eng_rec_ok(p, len, at) ? at : 0;
}
/* the offset of module `mod`'s B bitmap in a counted binary (eng_bset_walk), 0 when it has no B side or no B set; *bad
 * set when the binary is malformed */
static uint32_t eng_b_at(const uint8_t *p, uint32_t len, uint32_t mod, int *bad)
{
    uint32_t at;
    *bad = 0;
    if (!(p[6] & 1u))
        return 0;
    if (!(at = eng_records_end(p, len, 0))) {
        *bad = 1;
        return 0;
    }
    at += eng_cable_bytes(p) * ((uint32_t)p[4] | (uint32_t)p[5] << 8);
    if (at + (p[2] + 7u) / 8u > len) {
        *bad = 1;
        return 0;
    }
    if (!(p[at + (mod >> 3)] >> (mod & 7u) & 1u))
        return 0;
    if (!(at = eng_bset_walk(p, len, at, mod)))
        *bad = 1;
    return at;
}

int eng_rec_grow(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t mod, uint32_t npar)
{
    uint32_t at, bm, j, n, k, gb;
    int bad;
    const def_t *d;
    if (*len < 8u || p[0] != 0xA1u || p[1] < ENG_COUNTED || mod >= p[2] || !eng_records_end(p, *len, 0) || !(at = eng_rec_at(p, *len, mod)))
        return -1;
    d = &DEFS[p[at] & 0x7Fu];
    n = p[at + 1u] & ENG_REC_COUNT;
    if (npar > eng_npar(d, p[1]))
        return -1;
    if (npar <= n)
        return 0;
    k = npar - n;
    bm = eng_b_at(p, *len, mod, &bad);
    if (bad)
        return -1;
    gb = bm ? (npar + 7u) / 8u - (n + 7u) / 8u : 0u;   /* (its B bitmap's bytes: the new parameters' B is their A) */
    if (*len + 4u * k + gb > cap)
        return -1;
    if (gb) {                                    /* the B set first: it comes after the record */
        eng_gap(p, len, bm + (n + 7u) / 8u, gb);
        for (j = 0; j < gb; j++)
            p[bm + (n + 7u) / 8u + j] = 0;
    }
    eng_gap(p, len, at + 2u + 4u * n, 4u * k);
    for (j = n; j < npar; j++)
        eng_put32(p + at + 2u + 4u * j, d->pdef[j]);
    p[at + 1u] = (uint8_t)((p[at + 1u] & ~ENG_REC_COUNT) | npar);
    return 0;
}

int eng_b_keep(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t mod, uint32_t par)
{
    uint32_t at, bm, n, v;
    int bad;
    if (*len < 8u || p[0] != 0xA1u || p[1] < ENG_COUNTED || !(p[6] & 1u))
        return *len >= 8u && p[0] == 0xA1u ? 0 : -1;
    if (mod >= p[2] || !(at = eng_rec_at(p, *len, mod)))
        return -1;
    n = p[at + 1u] & ENG_REC_COUNT;
    bm = eng_b_at(p, *len, mod, &bad);
    if (bad || (bm && par >= n))
        return -1;
    if (!bm || (p[bm + (par >> 3)] >> (par & 7u) & 1u))
        return 0;                                /* (no B side, or its B value is there) */
    if (*len + 4u > cap)
        return -1;
    v = bm + (n + 7u) / 8u + 4u * eng_bits(p + bm, par);   /* (after the B values of the parameters before it) */
    eng_gap(p, len, v, 4u);
    eng_put32(p + v, rd32(p + at + 2u + 4u * par));
    p[bm + (par >> 3)] |= (uint8_t)(1u << (par & 7u));
    return 0;
}

uint32_t eng_rec_matrix(uint8_t *p, uint32_t *len, uint32_t cap, uint32_t mod)
{
    uint32_t at, blk, pres, need, q, k, mb;
    const def_t *d;
    if (*len < 8u || p[0] != 0xA1u || p[1] < ENG_COUNTED || mod >= p[2] || !eng_records_end(p, *len, 0) || !(at = eng_rec_at(p, *len, mod)))
        return 0;
    d = &DEFS[p[at] & 0x7Fu];
    if (d->cvbase < 0)
        return 0;
    mb = eng_mask_bytes(d, p[1]);
    blk = eng_rec_block(p, at);
    pres = (p[at + 1u] & ENG_REC_TEMPLATE) ? 0u : p[blk];
    if (pres == ENG_PRES_ALL)
        return blk + 1u;
    need = ((p[at + 1u] & ENG_REC_TEMPLATE) ? 1u : 0u) + eng_pres_bytes(d, p[1], ENG_PRES_ALL & ~pres);
    if (*len + need > cap)
        return 0;
    if (p[at + 1u] & ENG_REC_TEMPLATE) {         /* (the presence byte goes in) */
        eng_gap(p, len, blk, 1u);
        p[at + 1u] &= (uint8_t)~ENG_REC_TEMPLATE;
    }
    p[blk] = ENG_PRES_ALL;
    for (q = blk + 1u, k = 0; k < 4u; k++) {     /* att1, att2, p1, p2: the missing ones at their template */
        uint32_t sz = k < 2u ? 4u : mb;
        if (!(pres & (1u << k))) {
            eng_gap(p, len, q, sz);
            if (k < 2u)
                eng_put32(p + q, ENG_ONE);
            else
                eng_putmask(p + q, eng_mask_template(d, k - 2u), mb);
        }
        q += sz;
    }
    return blk + 1u;
}

static int32_t morph_unit(const def_t *d, uint32_t j, int32_t v);

/* the shared keyboard and the poly groups as the binary describes them, all parts silent */
static void groups_reset(void)
{
    uint32_t g, v, j, pv0 = 0;
    for (g = 0; g <= E.ngrp; g++) {
        E.grp[g].rot = 0;
        E.grp[g].nheld = 0;
        E.grp[g].down[0] = E.grp[g].down[1] = E.grp[g].down[2] = E.grp[g].down[3] = 0;
        E.grp[g].pv0 = (uint8_t)pv0;
        pv0 += E.grp[g].parts;
    }
    for (v = 0; v < ENG_NPV; v++) {
        uint8_t *z = (uint8_t *)&E.pv[v];
        for (j = 0; j < sizeof E.pv[v]; j++)
            z[j] = 0;
        E.pv[v].note = 255u;
    }
    for (g = 1; g <= E.ngrp; g++)                /* the drift walks: modules.ts driftSeed(g, part) */
        for (v = 0; v < E.grp[g].parts; v++)
            walk_init(&E.pv[E.grp[g].pv0 + v].dw, (0x51edu + g * 16u + v) * 0x9e3779b9u);
}

/* the note slices' firsts from their counts, in their order (E.nnotes): every track's pattern 0, then track by track its
 * patterns 1.. (eng_load reads them in that order; trk_put keeps it) */
static void pat_layout(void)
{
    uint32_t t, k, n = 0;
    for (t = 0; t < E.ntrk; t++) {
        E.pat_first[t][0] = (uint16_t)n;
        n += E.pat_n[t][0];
    }
    for (t = 0; t < E.ntrk; t++)
        for (k = 1; k < ENG_PATTERNS; k++) {
            E.pat_first[t][k] = (uint16_t)n;
            n += E.pat_n[t][k];
        }
}

static int aot_buffer_guard(const uint8_t *p, uint32_t len);
static void aot_bind(const uint8_t *p, uint32_t len, uint32_t lines);   /* aot.c (#808) */
int eng_load(const uint8_t *p, uint32_t len)
{
    uint32_t i, j, c, k, v, at, ncab, n0, nl;
    uint8_t st[ENG_MAX_MODULES], member[ENG_MAX_MODULES], held[ENG_MAX_MODULES];   /* held: the parameters each record holds */
    uint32_t line_sz[ENG_MAX_LINES], line_off[ENG_MAX_LINES];   /* the lines: their bytes and places (on the main loop's
                                                                 * stack, 1 KB: not the RAM region's, which the interrupts need) */
    uint8_t line_reg[ENG_MAX_LINES];
    E.loaded = 0;
    E.stamp = 0;
    for (i = 0; i < ENG_KNOBS; i++)              /* (a knob ramp of the patch before: gone) */
        ramp[i].left = 0;
    E.clk_seen = clk_ticks;
    E.clk_pulse = 0;
    E.narp = 0;
    E.nharm = 0;
    E.ntrk = 0;
    E.nnotes = 0;
    E.pat_sel = E.song = 0;
    for (i = 0; i < ENG_SONGS; i++)
        E.song_n[i] = 0;
    E.nkev = 0;
    E.arm = 0;
    E.armm = mset_none();                        /* (another patch disarms: #191) */
    E.armany = 0;
    E.armg = 0;
    E.trk_rec = E.thru_kill = 0;
    E.nthru = E.nrin = 0;
    thru_tail = thru_head;                       /* (keys still waiting were for the last patch) */
    took_tail = took_head;
    E.ngrp = 0;
    E.grp[0].parts = 1;                          /* the shared keyboard: one part, legato auto, last note */
    E.grp[0].assign = E.grp[0].legato = E.grp[0].priority = 0;
    E.grp[0].src = E.grp[0].ch = E.grp[0].lo = 0;
    E.grp[0].hi = 127u;
    E.grp[0].mode = 0xFFu;
    groups_reset();
    ar_lo = ar_hi = ar_ninst = ar_nnode = ar_npad = 0;   /* the arena: the old patch's memory is free again */
    par_used = 0;
    (void)arena_inst(1u);                        /* the spare (inst_pool[0]): every node's until it has its own */
    inst_pool[0].eff = par_spare;
    E.nmod = 0;                                  /* (no modules until this patch's are taken, below) */
    node_none.par = par_spare;
    node_none.ninst = 1;
    E.node = &node_none;
    if (len < 8u || p[0] != 0xA1 || (p[1] > ENG_PATCH_VERSION || p[1] < ENG_PATCH_COMPAT_VERSION))
        return -1;
    if (!eng_flags_ok(p))
        return -1;
    for (i = 0; i < ENG_PANEL_BUTTONS; i++)      /* (before eng_buttons below: no Toggle of the last patch acts on this one) */
        E.btn_kind[i] = (uint8_t)ENG_BTN_GATE, E.btn_n[i] = 0;
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    if (p[2] > ENG_MAX_MODULES || ncab > ENG_MAX_CABLES)
        return -2;
    if (p[2]) {                                  /* the modules, from the arena's top (#721): each the spare's until it loads */
        node_t *nd = arena_nodes(p[2]);
        if (!nd)
            return -7;
        E.node = nd;
        for (i = 0; i < p[2]; i++) {
            nd[i].par = par_spare;
            nd[i].ninst = 1;
        }
    }
    E.nmod = p[2];
    if (p[3] > ENG_MAX_GROUPS)
        return -1;
    at = eng_records_at(p, len);                 /* the poly groups: their settings, then each module's group */
    if (!at)
        return -3;
    {                                             /* the panel: the switched-on buttons the patch was saved with */
        const uint8_t *q = p + eng_panel_at(p, len);
        uint32_t tog = (uint32_t)q[0] | (uint32_t)q[1] << 8, on = (uint32_t)q[2] | (uint32_t)q[3] << 8;
        eng_buttons(on & tog);
        E.btn_sw = (uint16_t)tog;
    }
    for (i = 0; i < p[3]; i++) {
        const uint8_t *q = p + 8u + ENG_GROUP_REC * i;
        grp_t *g = &E.grp[1u + i];
        if (!eng_group_valid(q, p[1]))
            return -3;
        g->parts = q[0] & 15u;
        g->stack = q[0] >> 4;
        g->assign = q[1];
        g->legato = q[2] & 0x3Fu;
        g->unison = q[2] & 0x80u ? (q[2] & 0x40u ? 2u : 1u) : 0u;
        g->assign0 = g->assign;
        g->unison0 = g->unison;
        g->mode = 0xFFu;
        g->cv[0] = g->cv[1] = 0;
        g->priority = q[3] & 0x7Fu;
        g->no_steal = q[3] >> 7;
        for (v = 0; v < ENG_MAX_PARTS; v++) {
            const uint8_t *f = q + 4u + 5u * v;
            int32_t det = (int8_t)f[0], bri = (int8_t)f[2], env = (int8_t)f[3];
            if (det < -POLY_FLAW_DETUNE || det > POLY_FLAW_DETUNE || f[1] > 100u || bri < -POLY_FLAW_BRIGHT || bri > POLY_FLAW_BRIGHT
                || env < -POLY_FLAW_ENV || env > POLY_FLAW_ENV || f[4] > 100u)
                return -3;
            g->detune[v] = (int8_t)det;
            g->drift[v] = f[1];
            g->bright[v] = (int8_t)bri;
            g->env[v] = (int8_t)env;
            g->level[v] = f[4];
        }
        g->src = q[4u + 5u * ENG_MAX_PARTS];     /* checked against the modules below */
        g->ch = q[5u + 5u * ENG_MAX_PARTS];
        g->lo = q[6u + 5u * ENG_MAX_PARTS];
        g->hi = q[7u + 5u * ENG_MAX_PARTS];
        if (g->ch > 16u || g->lo > 127u || g->hi > 127u)
            return -3;
    }
    for (i = 0; i < E.nmod; i++) {
        member[i] = p[3] ? p[8u + ENG_GROUP_REC * p[3] + i] : 0u;
        if (member[i] > p[3])
            return -3;
    }
    E.ngrp = p[3];
    groups_reset();
    E.ncab = (uint16_t)ncab;
    E.has_b = 0;
    E.nranges = 0;
    E.main = -1;
    E.morph = 0;
    E.nbuf = 0;
    E.ninst = 0;
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        const def_t *d;
        uint8_t *z = (uint8_t *)nd;
        uint32_t cnt;
        for (j = 0; j < sizeof *nd; j++)
            z[j] = 0;
        nd->par = par_spare;
        if (!eng_rec_ok(p, len, at))
            return -3;
        nd->type = p[at] & 0x7Fu;
        nd->bypass = (uint8_t)(p[at] >> 7 && nd->type != T_FM1 && nd->type != T_OUTPUT);   /* bit 7: bypassed (never the panel or the output) */
        d = &DEFS[nd->type];
        n0 = eng_rec_npar(p, at);                /* (an older format's record: the parameters it had then; a counted one: its count) */
        cnt = p[1] >= ENG_COUNTED ? p[at + 1u] : 0u;   /* (format 51: its count byte, ENG_REC_TEMPLATE) */
        held[i] = (uint8_t)n0;
        if (at + eng_rec_size(p, at) > len)
            return -3;
        at += eng_rec_head(p[1]);
        nd->par = par_take((p[6] & 1u) ? 2u * d->npar : d->npar);   /* (with the morph B side, flag bit 0) */
        if (!nd->par) {
            nd->par = par_spare;
            return -8;
        }
        for (j = 0; j < d->npar; j++)
            if (j < n0) {
                nd->par[j] = rd32(p + at);
                at += 4;
            } else
                nd->par[j] = d->pdef[j];          /* added since the binary's format, or after a counted record's count */
        if (d->cvbase >= 0) {
            uint32_t mb = eng_mask_bytes(d, p[1]), pres = ENG_PRES_ALL;
            nd->att[0] = nd->att[1] = ENG_ONE;   /* (format 51: what the record leaves out is at its template) */
            nd->map[0] = eng_mask_template(d, 0);
            nd->map[1] = eng_mask_template(d, 1);
            if (p[1] >= ENG_COUNTED)
                pres = (cnt & ENG_REC_TEMPLATE) ? 0u : p[at++];
            if (pres & ENG_PRES_ATT1)
                nd->att[0] = rd32(p + at), at += 4;
            if (pres & ENG_PRES_ATT2)
                nd->att[1] = rd32(p + at), at += 4;
            if (pres & ENG_PRES_P1)
                nd->map[0] = eng_rdmask(p + at, mb), at += mb;
            if (pres & ENG_PRES_P2)
                nd->map[1] = eng_rdmask(p + at, mb), at += mb;
            if (p[1] < ENG_COUNTED)
                at += 4u * mb;                   /* (the knob masks k1..k4 of the older formats: nothing reads them) */
        }
        if (nd->type == T_STEPS) {               /* its name (the panel reads it from the binary); its notes come after the cables */
            if (E.ntrk >= ENG_MAX_TRACKS)
                return -2;
            nd->trk = E.ntrk++;
            for (j = 0; j < ENG_PATTERNS; j++) {
                E.pat_first[nd->trk][j] = 0;
                E.pat_n[nd->trk][j] = E.pat_len[nd->trk][j] = 0;
                E.pat_rate[nd->trk][j] = 0xFFu;
            }
            E.pat_has[nd->trk] = 1u;
            E.trk_pat[nd->trk] = 0;
            E.trk_q[nd->trk] = 0xFFu;
            E.trk_spos[nd->trk] = -1;
            E.trk_shift[nd->trk] = 0;
            E.trk_nsnd[nd->trk] = 0;
            E.trk_last[nd->trk] = STEP_NOTE;
            E.trk_once[nd->trk] = 0;
        }
        nd->ksrc = nd->type == T_DRUMMAP ? p[at] : 0u;   /* (checked once every module is read) */
        at += d->ndata;
        /* the memories of delay, reverb, chorus, granular and the output exist once (patch.ts SHARED_TYPES) */
        nd->grp = nd->type == T_DELAY || nd->type == T_REVERB || nd->type == T_CHORUS || nd->type == T_GRAIN || nd->type == T_OUTPUT || nd->type == T_ARP || nd->type == T_STEPS || nd->type == T_DRUMMAP || nd->type == T_HARM ? 0u : member[i];
        {                                        /* its copies, from the arena's bottom (the spare until then) */
            int i0 = arena_inst(E.grp[nd->grp].parts);
            if (i0 < 0) {
                nd->ninst = 1;
                return -7;
            }
            for (k = 0; k < E.grp[nd->grp].parts; k++)
                inst_pool[i0 + (int)k].eff = par_spare;
            nd->inst0 = (uint8_t)i0;
            nd->ninst = E.grp[nd->grp].parts;
            E.ninst = (uint8_t)(E.ninst + nd->ninst);
        }
        if (nd->type == T_FM1 && E.main < 0)
            E.main = (int8_t)i;
        if (nd->type == T_ARP) {                 /* an arpeggiator: its note logic runs before the modules (arp_block) */
            arp_t *a = &E.arp[E.narp];
            uint8_t *az = (uint8_t *)a;
            if (E.narp >= ENG_MAX_ARPS)
                return -2;
            for (j = 0; j < sizeof *a; j++)
                az[j] = 0;
            a->node = (uint8_t)i;
            a->cur = -1;
            a->seed = 0x2545F491u;
            E.narp++;
        }
        if (nd->type == T_HARM) {                /* a Harmonizer: its notes go out as the keys come (harm_key) */
            harm_t *h = &E.harm[E.nharm];
            uint8_t *hz = (uint8_t *)h;
            if (E.nharm >= ENG_MAX_HARMS)
                return -2;
            for (j = 0; j < sizeof *h; j++)
                hz[j] = 0;
            h->node = (uint8_t)i;
            E.nharm++;
        }
    }
    for (i = 1; i <= E.ngrp; i++)                /* a group's note source must be an arpeggiator, a Steps module or a Harmonizer of the patch */
        if (E.grp[i].src && (E.grp[i].src > E.nmod || (E.node[E.grp[i].src - 1u].type != T_ARP && E.node[E.grp[i].src - 1u].type != T_STEPS
                                                       && E.node[E.grp[i].src - 1u].type != T_HARM)))
            return -3;
    for (i = 0; i < E.nmod; i++)                 /* a Drum map's keys: the keys, or a Steps module or an Arpeggiator of the patch */
        if (E.node[i].ksrc >= 2u && (E.node[i].ksrc - 2u >= E.nmod || (E.node[E.node[i].ksrc - 2u].type != T_STEPS && E.node[E.node[i].ksrc - 2u].type != T_ARP)))
            return -3;
    k = eng_cable_bytes(p);
    if (at + k * ncab > len)
        return -3;
    for (c = 0; c < ncab; c++, at += k) {
        uint8_t fm = p[at], fp = p[at + 1], tm = p[at + 2], tp = p[at + 3];
        if (k == 3u) {                           /* (ENG_FLAG_CABLES3: from module, to module, the ports in one byte) */
            tm = p[at + 1];
            fp = p[at + 2] >> 4;
            tp = p[at + 2] & 15u;
        }
        if (fm >= E.nmod || tm >= E.nmod || fm == tm)
            return -5;
        if (fp >= DEFS[E.node[fm].type].nout || tp >= DEFS[E.node[tm].type].nin)
            return -5;
        E.from_m[c] = fm;
        E.from_p[c] = fp;
        E.to_m[c] = tm;
        E.to_p[c] = tp;
        E.node[tm].conn |= (uint16_t)(1u << tp);
        if (E.node[fm].type == T_FM1 && fp == FM1_O_KEYS && E.node[tm].type == T_STEPS && tp == STEPS_I_KEYS)
            E.node[tm].ksrc = 1u;                /* Main's keys pass through the track while none is armed (#138) */
        if (E.node[fm].type == T_STEPS && fp == STEPS_O_KEYS && E.node[tm].type == T_ARP && tp == ARP_I_KEYS)
            E.node[tm].ksrc = (uint8_t)(2u + fm);   /* the arpeggiator plays the track's notes, not Main's keys */
        if (E.node[tm].type == T_PART && E.node[tm].grp)  /* a cable into a Part's assign or unison input (#681) */
            E.grp[E.node[tm].grp].mode = tm;
    }
    if (p[6] & 1u) {                             /* the morph B set: one Q16 value per parameter of every module, kept as unit positions */
        uint32_t mk = at;                        /* (format 51: the module mask first, then per module with a B side a bitmap and
                                                  * the B values it marks; the others' B is their A, D-1004) */
        if (p[1] >= ENG_COUNTED && (at += (E.nmod + 7u) / 8u) > len)
            return -3;
        for (i = 0; i < E.nmod; i++) {
            node_t *nd = &E.node[i];
            const def_t *d = &DEFS[nd->type];
            int32_t *pb = PARB(nd);
            uint32_t n0 = held[i];               /* (as many as its record holds; the rest at their defaults) */
            const uint8_t *bits = 0;
            if (p[1] >= ENG_COUNTED) {
                nd->morph = p[mk + (i >> 3)] >> (i & 7u) & 1u;
                if (nd->morph) {
                    bits = p + at;
                    if (at + (n0 + 7u) / 8u > len || eng_bits_past(bits, n0) || (at += (n0 + 7u) / 8u) + 4u * eng_bits(bits, n0) > len)
                        return -3;
                }
            } else if (at + 4u * n0 > len)
                return -3;
            else
                nd->morph = 1;
            nd->over = 0;
            for (j = 0; j < d->npar; j++) {
                int32_t b = j < n0 ? rd32(p + at) : d->pdef[j];
                if (p[1] >= ENG_COUNTED && !(bits && j < n0 && (bits[j >> 3] >> (j & 7u) & 1u)))
                    b = nd->par[j];              /* (its A value) */
                else if (j < n0)
                    at += 4;
                if (d->ptop && b > d->pmax[j]) {          /* past the range (a stretch, under 32 wide: export-defs): B - pmin in 1/2048 */
                    nd->over |= 1u << j;
                    pb[j] = (clampi(b, d->pmin[j], d->ptop[j]) - d->pmin[j]) >> 5;
                } else
                    pb[j] = clampi(morph_unit(d, j, b), 0, 65535);
            }
        }
        E.has_b = 1;
    }
    if ((p[7] & ENG_FLAG_MORPH_MODULES) && p[1] < ENG_COUNTED) {
        uint32_t bytes = (E.nmod + 7u) / 8u;
        if (at + bytes > len)
            return -3;
        for (i = 0; i < E.nmod; i++)
            E.node[i].morph = (p[at + (i >> 3)] >> (i & 7u)) & 1u;
        at += bytes;
    }
    if (p[6] & 4u) {                             /* fixed input links: one disabled-input mask per module */
        if (at + E.nmod > len)
            return -3;
        for (i = 0; i < E.nmod; i++) {
            node_t *nd = &E.node[i];
            uint8_t mask = p[at++];
            if (mask & ~DEFS[nd->type].fixed_inputs)
                return -3;
            nd->disabled_inputs = mask;
            nd->conn &= (uint16_t)~mask;
        }
    }
    if (p[6] & 8u) {                             /* additional side-input routes: module, input, parameter mask (u16, u32 past
                                                  * 16 parameters: eng_mask_bytes) */
        uint32_t count;
        if (at >= len) return -3;
        count = p[at++];
        for (i = 0; i < count; i++) {
            uint32_t mod, input, mask, mb;
            const def_t *d;
            if (at + 2u > len) return -3;
            mod = p[at];
            input = p[at + 1];
            if (mod >= E.nmod) return -3;
            d = &DEFS[E.node[mod].type];
            mb = eng_mask_bytes(d, p[1]);
            if (at + 2u + mb > len) return -3;
            mask = eng_rdmask(p + at + 2u, mb);
            at += 2u + mb;
            if (input >= d->nin || (d->cvbase >= 0 && input >= (uint32_t)d->cvbase) || !mask || (eng_npar(d, p[1]) < 32u && (mask >> eng_npar(d, p[1])))) return -3;
            E.node[mod].input_map[input] |= mask;
        }
    }
    if (p[6] & 16u) {                            /* the tracks' notes: u8 count, then per track u8 module, u8 n, n u32 notes */
        uint32_t count, last = 0, t, n;
        if (at >= len) return -3;
        count = p[at++];
        for (i = 0; i < count; i++) {
            uint32_t mod;
            if (at + 2u > len) return -3;
            mod = p[at];
            n = p[at + 1u];
            at += 2u;
            if (mod >= E.nmod || E.node[mod].type != T_STEPS || !n || n > TRACK_NOTES_MAX || at + 4u * n > len) return -3;
            t = E.node[mod].trk;
            if ((i && t <= last) || E.nnotes + n > ENG_MAX_NOTES) return -3;   /* in track order, within the pool */
            last = t;
            for (j = 0; j < n; j++, at += 4u) {
                uint32_t w = (uint32_t)rd32(p + at);
                if ((p[1] < 44u && NW_AT(w) + NW_LEN(w) > TRACK_STEPS) || !NW_VEL(w)) return -3;
                if (p[1] < 50u)                  /* (bit 31, a tie across the loop point, is format 50's) */
                    w &= ~ENG_NOTE_WRAP;
                E.trk_note[E.nnotes + j] = w;
            }
            E.pat_n[t][0] = (uint8_t)n;
            E.nnotes = (uint16_t)(E.nnotes + n);
        }
    }
    if (p[7] & ENG_FLAG_PATTERNS) {              /* the patterns and songs (format 48, patchbin.ts patternRecord) */
        uint32_t count, last = 0, t, n, np, k, ns;
        if (at + 3u > len || p[at] >= ENG_PATTERNS || p[at + 1u] > ENG_SONGS) return -3;
        E.pat_sel = p[at];
        E.song = p[at + 1u];
        count = p[at + 2u];
        at += 3u;
        for (i = 0; i < count; i++) {
            uint32_t mod;
            if (at + 2u > len) return -3;
            mod = p[at];
            np = p[at + 1u];
            at += 2u;
            if (mod >= E.nmod || E.node[mod].type != T_STEPS || !np || np >= ENG_PATTERNS) return -3;
            t = E.node[mod].trk;
            if (i && t <= last) return -3;       /* in track order */
            last = t;
            for (k = 1; k <= np; k++) {
                uint32_t sh, ln, rt;
                if (at >= len) return -3;
                n = p[at++];
                if (n == 0xFFu)
                    continue;
                if (at + 2u > len) return -3;
                sh = p[at] >> 7;
                ln = p[at] & 0x7Fu;
                rt = p[at + 1u];
                at += 2u;
                if (n > TRACK_NOTES_MAX || ln > TRACK_STEPS || (rt != 0xFFu && rt > 8u) || at + (sh ? 2u : 4u) * n > len || E.nnotes + n > ENG_MAX_NOTES) return -3;
                for (j = 0; j < n; j++) {
                    uint32_t w;
                    if (sh) {
                        w = (uint32_t)p[at] | (uint32_t)p[at + 1u] << 8;
                        w = NW(w & 15u, ((w >> 4) & 15u) + 1u, (w >> 8) & 127u, (w & 0x8000u) ? ACCENT_VEL : STEP_VEL, 0u);
                        at += 2u;
                    } else {
                        w = (uint32_t)rd32(p + at);
                        at += 4u;
                        if (!NW_VEL(w)) return -3;
                        if (p[1] < 50u)
                            w &= ~ENG_NOTE_WRAP;
                    }
                    E.trk_note[E.nnotes + j] = w;
                }
                E.pat_n[t][k] = (uint8_t)n;
                E.pat_len[t][k] = (uint8_t)ln;
                E.pat_rate[t][k] = (uint8_t)rt;
                E.pat_has[t] |= (uint64_t)1u << k;
                E.nnotes = (uint16_t)(E.nnotes + n);
            }
        }
        if (at >= len) return -3;
        ns = p[at++];
        if (ns > ENG_SONGS) return -3;
        for (i = 0; i < ns; i++) {
            if (at >= len || p[at] > ENG_SONG_LEN || at + 1u + 2u * p[at] > len) return -3;
            E.song_n[i] = p[at++];
            for (k = 0; k < E.song_n[i]; k++, at += 2u) {
                if (p[at] >= ENG_PATTERNS || (int8_t)p[at + 1u] < -ENG_SHIFT_MAX || (int8_t)p[at + 1u] > ENG_SHIFT_MAX) return -3;
                E.song_pat[i][k] = p[at];
                E.song_shift[i][k] = (int8_t)p[at + 1u];
            }
        }
    }
    E.nlt = 0;
    E.nlk = 0;
    for (i = 0; i < ENG_MAX_TRACKS; i++)
        E.trk_lkey[i] = -2;
    if (p[7] & ENG_FLAG_LOCKS) {                 /* the P-locks (format 49, #524, patchbin.ts lockRecord) */
        uint32_t count, t, nr, r, np, k, n, pat, row0;
        if (at >= len) return -3;
        count = p[at++];
        for (i = 0; i < count; i++) {
            uint32_t mod;
            if (at + 2u > len) return -3;
            mod = p[at];
            nr = p[at + 1u];
            at += 2u;
            if (mod >= E.nmod || E.node[mod].type != T_STEPS || !nr || E.nlt + nr > ENG_LOCK_TARGETS) return -3;
            t = E.node[mod].trk;
            row0 = E.nlt;
            for (r = 0; r < nr; r++) {
                lrow_t *x = &E.lt[E.nlt++];
                if (at >= len || !p[at] || p[at] > ENG_LOCK_PAIRS || at + 1u + 2u * p[at] > len) return -3;
                x->trk = (uint8_t)t;
                x->n = p[at];
                x->on = 0;
                x->v = 0;
                for (k = 0; k < x->n; k++) {
                    uint32_t m = p[at + 1u + 2u * k], j = p[at + 2u + 2u * k];
                    if (m >= E.nmod || j >= DEFS[E.node[m].type].npar || E.node[m].type == T_PART) return -3;
                    x->mod[k] = (uint8_t)m;
                    x->par[k] = (uint8_t)j;
                    E.node[m].locked = 1;
                }
                at += 1u + 2u * x->n;
            }
            if (at >= len) return -3;
            np = p[at++];
            for (k = 0; k < np; k++) {
                if (at + 2u > len) return -3;
                pat = p[at];
                n = p[at + 1u];
                at += 2u;
                if (pat >= ENG_PATTERNS || n > ENG_PAT_LOCKS || E.nlk + n > ENG_MAX_LOCKS || at + 6u * n > len) return -3;
                for (r = 0; r < n; r++, at += 6u) {
                    lock_t *l = &E.lk[E.nlk++];
                    if (p[at] >= TRACK_STEPS || p[at + 1u] >= nr) return -3;
                    l->trk = (uint8_t)t;
                    l->pat = (uint8_t)pat;
                    l->at = p[at];
                    l->row = (uint8_t)(row0 + p[at + 1u]);
                    l->v = rd32(p + at + 2u);
                }
            }
        }
    }
    pat_layout();                                /* (the slices in their order: every track's first, then the rest) */
    for (i = 0; i < E.ntrk; i++)                 /* every track plays the patch's pattern */
        E.trk_pat[i] = E.pat_sel;
    if (p[6] & 32u) {                            /* the device pages (the LCD's, proto.c / pages_ui.c): not the engine's */
        uint32_t end = eng_devices_end(p, len, at);
        if (!end)
            return -3;
        at = end;
    }
    if (p[7] & ENG_FLAG_EXTRAS) {                /* the device extras (the environment's, pages_ui.c): not the engine's */
        uint32_t end = eng_extras_end(p, len, at);
        if (!end)
            return -3;
        at = end;
    }
    if (p[6] & 64u) {                            /* the button kinds, a Toggle's modules (#116) */
        uint32_t end = eng_buttons_end(p, len, at), used = 0, b;
        if (!end)
            return -3;
        for (b = 0; b < ENG_PANEL_BUTTONS; b++)
            E.btn_kind[b] = (uint8_t)(p[at + b] <= ENG_BTN_PAGE ? p[at + b] : ENG_BTN_NOTHING);
        at += ENG_PANEL_BUTTONS;
        for (b = 0; b < ENG_PANEL_BUTTONS; b++) {
            uint32_t n, k;
            if (E.btn_kind[b] == ENG_BTN_PAGE) {     /* a page list: the panel's (pages_ui.c pages_list) */
                at += 1u + 2u * p[at];
                continue;
            }
            if (E.btn_kind[b] != ENG_BTN_TOGGLE)
                continue;
            n = p[at++];
            if (used + n > ENG_BTN_TARGETS)
                return -3;
            E.btn_first[b] = (uint8_t)used;
            E.btn_n[b] = (uint8_t)n;
            for (k = 0; k < n; k++, at++) {
                if (p[at] >= E.nmod)
                    return -3;
                E.btn_list[used++] = p[at];
            }
        }
        for (b = 0; b < ENG_PANEL_BUTTONS; b++)  /* SEL, ENV, GLO are fixed on the FM-1 (#197, #199): an old patch's role for them goes */
            if (b == 1u || b == 2u || b == 5u) {
                E.btn_kind[b] = ENG_BTN_GATE;
                E.btn_n[b] = 0;
            }
        toggles_sync();
    }
    if (p[6] & 128u) {                           /* the Drum maps' row names (the SEQ page's, eng_drum_name): not the engine's */
        uint32_t end = eng_names_end(p, len, at);
        if (!end)
            return -3;
        at = end;
    }
    if (p[6] & 2u) {                             /* the macro ranges: u8 count, then module / pin (bit 7 bipolar) / parameter / lo / hi each */
        uint32_t nr;
        if (at >= len)
            return -3;
        nr = p[at++];
        if (at + 5u * nr > len)
            return -3;
        for (i = 0; i < nr; i++, at += 5) {
            uint32_t mod = p[at], pin = p[at + 1] & ~RANGE_BIPOLAR, par = p[at + 2];
            if (mod >= E.nmod || pin > 1u || par >= DEFS[E.node[mod].type].npar || !(E.node[mod].map[pin] >> par & 1u))
                continue;                        /* not a destination of that pin: ignored */
            if (E.nranges >= ENG_MAX_RANGES)
                return -3;
            E.ranges[E.nranges].mod = (uint8_t)mod;
            E.ranges[E.nranges].pin = (uint8_t)pin;
            E.ranges[E.nranges].par = (uint8_t)par;
            E.ranges[E.nranges].lo = p[at + 3];
            E.ranges[E.nranges].hi = p[at + 4];
            E.ranges[E.nranges].bi = (p[at + 1] & RANGE_BIPOLAR) != 0;
            E.nranges++;
            E.node[mod].ranged[pin] |= 1u << par;
        }
    }
    /* the instances (their copies were taken with their records): state and effective values */
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        for (k = 0; k < nd->ninst; k++) {
            inst_t *it = &inst_pool[nd->inst0 + k];
            it->eff = par_take(DEFS[nd->type].npar);
            if (!it->eff) {
                it->eff = par_spare;
                return -8;
            }
            init_state(nd, it, i, k);
        }
    }
    /* the order the modules run in: each after its sources (a feedback cable reads the block before) */
    for (i = 0; i < E.nmod; i++)
        st[i] = 0;
    E.norder = 0;
    for (i = 0; i < E.nmod; i++)
        if (st[i] == 0)
            visit(i, st);
    /* the dummy for the unconnected output ports; a buffer for each value, the connected outputs and the summed inputs of
     * every copy, in the order they are written: a buffer whose value has ended takes the next (buf_take, #800) */
    for (i = 0; i < E.nmod; i++)
        for (k = 0; k < E.node[i].ninst; k++)
            for (j = 0; j < DEFS[E.node[i].type].nout; j++)
                inst_pool[E.node[i].inst0 + k].out[j] = E.node[i].grp && (k & 1u) ? dummy_out1 : dummy_out;
    {
        uint8_t *pos = member, *seg_end = held;      /* (member and held are not needed past here) */
        bufs_t bs;
        bs.base = (esig_t *)((uint8_t *)eng_arena + ar_lo);
        bs.n = bs.values = 0;
        bs.keep = !ENG_BUF_REUSE || aot_buffer_guard(p, len);
#ifdef ENG_POISON
        poi_n = 0;
#endif
        for (k = 0; k < E.norder; k++)
            pos[E.order[k]] = (uint8_t)k;
        for (k = E.norder; k-- > 0;) {               /* the last place of the run of split-able modules of one group that
                                                      * place k is in (render_split's segment), k itself outside one */
            const node_t *nd = &E.node[E.order[k]], *nx = k + 1u < E.norder ? &E.node[E.order[k + 1u]] : 0;
            seg_end[k] = (uint8_t)(nx && buf_split(nd) && buf_split(nx) && nx->grp == nd->grp ? seg_end[k + 1u] : k);
        }
        for (k = 0; k < E.norder; k++) {
            uint32_t m = E.order[k];
            node_t *nd = &E.node[m];
            for (j = 0; j < DEFS[nd->type].nin; j++) {   /* its summed inputs (it->in holds the buffer until they are wired) */
                int sum = buf_nsrc(m, j) >= 2u;
                for (v = 0; v < nd->ninst; v++)
                    if (!(inst_pool[nd->inst0 + v].in[j] = sum ? buf_take(&bs, (int32_t)k, buf_late(nd) ? BUF_FOREVER : (int32_t)k, buf_lane(nd, v)) : zero_buf))
                        return -6;
            }
            for (j = 0; j < DEFS[nd->type].nout; j++) {  /* its connected outputs */
                for (c = 0; c < ncab && !(E.from_m[c] == m && E.from_p[c] == j); c++)
                    ;
                for (v = 0; c < ncab && v < nd->ninst; v++)
                    if (!(inst_pool[nd->inst0 + v].out[j] = buf_take(&bs, (int32_t)k, buf_end(m, j, v, (int32_t)k, buf_lane(nd, v), pos, seg_end), buf_lane(nd, v))))
                        return -6;
            }
        }
        if (bs.values > bs.n && !arena_lo((bs.values - bs.n) * ENG_BUF_BYTES))   /* the arena counts every value's buffer */
            return -6;
        E.nbuf = (uint16_t)bs.values;
        E.nphys = (uint16_t)bs.n;
        for (i = 0; i < bs.n * ENG_BLOCK; i++)
            bs.base[i] = 0;
    }
    /* inputs of every instance: none -> zeros, one source -> that buffer itself, several -> a summing buffer. An instance
     * reads its own part of an output of its group, the one buffer of a module that runs once, and every part (summed)
     * of another group's output (engine.ts gather) */
    E.nsum = 0;
    E.nsrc = 0;
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        for (k = 0; k < nd->ninst; k++) {
            inst_t *it = &inst_pool[nd->inst0 + k];
            it->sum0 = E.nsum;
            for (j = 0; j < DEFS[nd->type].nin; j++) {
                uint32_t n = 0, first = E.nsrc;
                const esig_t *one = 0;
                if ((nd->disabled_inputs & (1u << j)) && !nd->input_map[j]) {
                    it->in[j] = zero_buf;
                    continue;
                }
                for (c = 0; c < ncab; c++) {
                    if (E.to_m[c] != i || E.to_p[c] != j)
                        continue;
                    if (E.node[E.from_m[c]].grp && E.node[E.from_m[c]].grp != nd->grp) {
                        for (v = 0; v < E.node[E.from_m[c]].ninst; v++, n++) {
                            if (E.nsrc >= MAX_SRC)
                                return -6;
                            E.sum_w[E.nsrc] = para_w(E.from_m[c], E.from_p[c]);
                            one = E.sum_src[E.nsrc++] = buf_of(E.from_m[c], E.from_p[c], v);
                        }
                    } else {
                        if (E.nsrc >= MAX_SRC)
                            return -6;
                        E.sum_w[E.nsrc] = 0;
                        one = E.sum_src[E.nsrc++] = buf_of(E.from_m[c], E.from_p[c], k);
                        n++;
                    }
                }
                if (n == 0) {
                    it->in[j] = zero_buf;
                } else if (n == 1) {
                    it->in[j] = one;
                    E.nsrc = (uint16_t)first;                /* not summed: the entry is not needed */
                } else {
                    esig_t *b = (esig_t *)it->in[j];     /* (its buffer, from above) */
                    if (E.nsum >= MAX_SUM)
                        return -6;
                    it->in[j] = b;
                    E.sum[E.nsum].dst = b;
                    E.sum[E.nsum].first = (uint16_t)first;
                    E.sum[E.nsum].n = (uint16_t)n;
                    E.nsum++;
                }
            }
            it->nsum = (uint8_t)(E.nsum - it->sum0);
        }
    }
    /* the lines of the line-type modules, last: into what the arena has left and line_low (line_place) */
    nl = 0;
    for (i = 0; i < E.nmod; i++) {
        uint32_t b = line_bytes(E.node[i].type, E.node[i].par);
        for (k = 0; b && k < E.node[i].ninst; k++) {
            if (nl >= ENG_MAX_LINES)
                return -4;
            line_sz[nl++] = b;
        }
    }
    if (line_place(line_sz, nl, line_reg, line_off))
        return -4;
    nl = 0;
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        uint32_t b = line_bytes(nd->type, nd->par);
        for (k = 0; b && k < nd->ninst; k++) {
            inst_t *it = &inst_pool[nd->inst0 + k];
            void *ln = line_at(line_reg[nl], line_off[nl], b);
            nl++;
            if (nd->type == T_REVERB)
                it->s.rev.buf = (int16_t *)ln;
            else if (nd->type == T_DELAY) {
                it->s.dly.buf = (int16_t *)ln;
                it->s.dly.len = dly_samples(nd->par[DELAY_P_LENGTH]);
                it->s.dly.beat = ENG_SR / 2u;             /* 120 bpm until a clock has come in */
            } else if (nd->type == T_STRING || nd->type == T_COMB)
                it->s.str.buf = (int16_t *)ln;
            else if (nd->type == T_CHORUS)
                it->s.ch.buf = (int16_t *)ln;
            else if (nd->type == T_GRAIN)
                it->s.gr.ln = (grain_line_t *)ln;
        }
    }
    E.nout = 0;
    for (i = 0; i < E.norder; i++)
        if (E.node[E.order[i]].type == T_OUTPUT)
            E.outputs[E.nout++] = E.order[i];
    E.loaded = 1;
    for (i = 0; i < E.nmod; i++)                 /* a track that plays a Drum map is never shifted by a song (engine.ts) */
        if (E.node[i].type == T_STEPS)
            E.trk_drum[E.node[i].trk] = (uint8_t)(eng_steps_drummap(i) >= 0);
    tempo_own = E.main >= 0 ? E.node[E.main].par[FM1_P_TEMPO] : (int32_t)(TEMPO_DEFAULT << 16);
    if (tempo_glo)                               /* the global tempo (D-907): the patch plays at it, its own value kept */
        tempo_apply();
    for (k = 0, c = 0; k < nl; k++)              /* (#808: the compiled assemblies' state goes after the lines) */
        if (line_reg[k])
            c += line_sz[k];
    aot_bind(p, len, c);
    return 0;
}

/* the global tempo onto the running patch: Main's tempo shows it; ENG_TEMPO_ADOPT takes the patch's own first */
static void tempo_apply(void)
{
    if (tempo_glo == ENG_TEMPO_ADOPT) {
        tempo_glo = (uint16_t)clampi((tempo_own + 32768) >> 16, 20, 300);
        tempo_moved = 1;
    }
    if (tempo_glo && E.main >= 0)
        E.node[E.main].par[FM1_P_TEMPO] = (int32_t)((uint32_t)tempo_glo << 16);
}

void eng_tempo_global(uint32_t bpm)
{
    uint32_t was = tempo_glo;
    tempo_glo = (uint16_t)(bpm == 0u || bpm == ENG_TEMPO_ADOPT ? bpm : (uint32_t)clampi((int32_t)bpm, 20, 300));
    if (!E.loaded)
        return;
    if (!was && E.main >= 0)                     /* from each patch its own: Main's tempo as it stands is the patch's */
        tempo_own = E.node[E.main].par[FM1_P_TEMPO];
    if (tempo_glo)
        tempo_apply();
    else if (was && E.main >= 0)                 /* back to the patch's own */
        E.node[E.main].par[FM1_P_TEMPO] = tempo_own;
}
uint32_t eng_tempo_global_get(void) { return tempo_glo == ENG_TEMPO_ADOPT ? 0u : tempo_glo; }
int eng_tempo_moved(void)
{
    int m = tempo_moved;
    tempo_moved = 0;
    return m;
}
int eng_tempo_row(uint32_t module, uint32_t param)
{
    return tempo_glo && E.loaded && E.main >= 0 && module == (uint32_t)E.main && param == FM1_P_TEMPO;
}

int eng_parts(void) { return !E.loaded ? 0 : E.ngrp ? E.grp[1].parts : 1; }
int eng_groups(void) { return E.loaded ? E.ngrp : 0; }

static void mono_update(grp_t *g);

/* a Voicing's assign or unison with a cable into its input (modules.ts voicingSetting, #681): moved by whole choices, one
 * a unit (cv Q16, rounded to the nearest), within 0..top */
static int32_t vsetting(int32_t base, int32_t cv, int32_t top)
{
    int32_t v = base + (int32_t)(((int64_t)cv + 32768) >> 16);
    return v < 0 ? 0 : v > top ? top : v;
}

int eng_poly_get(uint32_t g, uint32_t field)
{
    const grp_t *x;
    if (!E.loaded || g >= E.ngrp || field >= ENG_NPOLY)
        return -1;
    x = &E.grp[1u + g];
    return field == ENG_POLY_PARTS ? x->parts : field == ENG_POLY_ASSIGN ? x->assign0 : field == ENG_POLY_LEGATO ? x->legato : field == ENG_POLY_PRIORITY ? x->priority : field == ENG_POLY_UNISON ? x->unison0 : field == ENG_POLY_STACK ? x->stack : !x->no_steal;
}

int eng_module_group(uint32_t module) { return E.loaded && module < E.nmod ? E.node[module].grp : 0; }
int eng_poly_unison(uint32_t g) { return E.loaded && g < E.ngrp ? E.grp[1u + g].unison : 0; }
int eng_poly_set(uint32_t g, uint32_t field, uint32_t v)
{
    grp_t *x;
    if (!E.loaded || g >= E.ngrp || field == ENG_POLY_PARTS || field == ENG_POLY_UNISON || field >= ENG_NPOLY
        || v > (field == ENG_POLY_STACK ? ENG_MAX_PARTS : field == ENG_POLY_ASSIGN ? 3u : field == ENG_POLY_STEAL ? 1u : 2u))
        return 0;
    x = &E.grp[1u + g];
    if (field == ENG_POLY_ASSIGN) {
        x->assign0 = (uint8_t)v;
        x->assign = (uint8_t)vsetting(v, x->cv[0], 3);   /* (with a cable: moved by what it carries) */
    } else if (field == ENG_POLY_LEGATO) x->legato = (uint8_t)v;
    else if (field == ENG_POLY_PRIORITY) x->priority = (uint8_t)v;
    else if (field == ENG_POLY_STACK) {
        uint32_t i;
        x->stack = (uint8_t)v;
        if (x->unison) mono_update(x);
        for (i = 0; i < x->parts; i++) E.pv[x->pv0 + i].idle = 0;
    } else x->no_steal = !v;
    return 1;
}

void eng_set_att(uint32_t module, uint32_t input, int32_t q16)
{
    if (module < E.nmod && input < 2u)
        E.node[module].att[input] = q16;
}

/* a switching Toggle is on while every module it bypasses is bypassed (a bypass from the editor moves it too); one that
 * acts while held is on while held */
static void toggles_sync(void)
{
    uint32_t b, k, mask = panel_buttons;
    for (b = 0; b < ENG_PANEL_BUTTONS; b++) {
        uint32_t on = E.btn_n[b] != 0u;
        if (E.btn_kind[b] != ENG_BTN_TOGGLE || !(E.btn_sw >> b & 1u))
            continue;
        for (k = 0; k < E.btn_n[b]; k++)
            on &= E.node[E.btn_list[E.btn_first[b] + k]].bypass;
        mask = on ? mask | 1u << b : mask & ~(1u << b);
    }
    panel_buttons = (uint16_t)mask;
}

static void arp_switched(uint32_t m);
static void harm_switched(uint32_t m);
void eng_set_bypass(uint32_t module, int on)
{
    if (module < E.nmod && E.node[module].type != T_FM1 && E.node[module].type != T_OUTPUT) {
        uint8_t was = E.node[module].bypass;
        E.node[module].bypass = (uint8_t)(on != 0);
        if (E.node[module].type == T_ARP && was != E.node[module].bypass)
            arp_switched(module);
        if (E.node[module].type == T_HARM && was != E.node[module].bypass)
            harm_switched(module);
    }
    toggles_sync();
}

uint32_t eng_button_kind(uint32_t b) { return b < ENG_PANEL_BUTTONS ? E.btn_kind[b] : ENG_BTN_NOTHING; }
uint32_t eng_button_targets(uint32_t b, const uint8_t **list)
{
    if (b >= ENG_PANEL_BUTTONS || E.btn_kind[b] != ENG_BTN_TOGGLE)
        return 0;
    *list = E.btn_list + E.btn_first[b];
    return E.btn_n[b];
}

int eng_bypass(uint32_t module) { return module < E.nmod ? E.node[module].bypass : 0; }

int eng_ncables(void) { return E.loaded ? E.ncab : 0; }
void eng_cable(uint32_t i, uint32_t *from, uint32_t *from_port, uint32_t *to, uint32_t *to_port)
{
    if (i >= E.ncab)
        return;
    *from = E.from_m[i];
    *from_port = E.from_p[i];
    *to = E.to_m[i];
    *to_port = E.to_p[i];
}

int eng_nmodules(void) { return E.loaded ? E.nmod : 0; }
int eng_type(uint32_t module) { return module < E.nmod ? E.node[module].type : -1; }
int32_t eng_att(uint32_t module, uint32_t input)
{
    return module < E.nmod && input < 2u ? E.node[module].att[input] : 0;
}

/* Main's tempo set while the tempo is global: the global tempo moves (D-907) */
static void tempo_follow(uint32_t module, uint32_t param, int32_t q16)
{
    if (eng_tempo_row(module, param)) {
        uint16_t b = (uint16_t)clampi((q16 + 32768) >> 16, 20, 300);
        tempo_moved |= b != tempo_glo;
        tempo_glo = b;
    }
}

void eng_set_param(uint32_t module, uint32_t param, int32_t q16)
{
    if (module < E.nmod && param < DEFS[E.node[module].type].npar && !DEF_FIXED(E.node[module].type, param)) {   /* (a row set
                                                     * when the patch loads, a Delay's length: only a load changes it) */
        E.node[module].par[param] = q16;
        tempo_follow(module, param, q16);
    }
}

/* Knob ramps (#405). On the FM-1 a knob's click reaches the module over ENG_RAMP_BLOCKS blocks (23 ms) instead of at once,
 * so a stepped level, offset, tuning or cutoff neither clicks nor zippers. The parameter itself (par[]) takes the new
 * value at once: eng_get_param, the editor's mirror, MIDI out and a save all see it. Only the base apply_cv derives the
 * effective value from lags: knob k's ramp holds the difference between where the module stood and the new value, and
 * render_voice shrinks it by one step a block to zero. A new click on the same row starts from where its ramp stands
 * (no jump back); a click on another row takes the knob's slot over. With no ramp pending the engine is bit for bit what
 * it was without them (tools/engine_exact.sh). The browser engine does not ramp: its sliders are continuous. The main
 * loop starts a ramp while the audio interrupt renders: a start that lands inside apply_cv of that module can make one
 * block use the step as a jump, which is what every click did before. */
static void ramp_start(uint32_t k, int32_t m, int32_t j, int32_t from, int32_t to)
{
    ramp_t *r = &ramp[k];
    if (r->left && r->mod == m && r->par == j)
        from += r->off;
    r->left = 0;
    r->mod = m;
    r->par = j;
    r->off = from - to;
    r->step = r->off / ENG_RAMP_BLOCKS;
    r->left = ENG_RAMP_BLOCKS;
}
/* once a block: every pending ramp one step nearer to zero */
static void ramp_tick(void)
{
    uint32_t k;
    for (k = 0; k < ENG_KNOBS; k++) {
        ramp_t *r = &ramp[k];
        if (!r->left)
            continue;
        if (--r->left)
            r->off -= r->step;
        else
            r->off = 0;
    }
}
/* the base values with the P-locks on node nd (#524, engine.ts applyCv: a lock in place of the normal value): a copy of
 * par with each locked parameter at its lock, clamped to its range (to its top: a stretch), or par when none locks it */
static int32_t lock_buf[2][MAX_PAR];                  /* (one per lane, #271) */
HOT const int32_t *lock_base(const node_t *nd, const int32_t *par, uint32_t npar, uint32_t lane)
{
    const def_t *d = &DEFS[nd->type];
    uint32_t r, k, j, any = 0, m = (uint32_t)(nd - E.node);
    for (r = 0; r < E.nlt; r++) {
        const lrow_t *x = &E.lt[r];
        if (!x->on)
            continue;
        for (k = 0; k < x->n; k++) {
            if (x->mod[k] != m || x->par[k] >= npar)
                continue;
            if (!any) {
                for (j = 0; j < npar; j++)
                    lock_buf[lane][j] = par[j];
                any = 1;
            }
            lock_buf[lane][x->par[k]] = clampi(x->v, d->pmin[x->par[k]], DEF_TOP(d, x->par[k]));
        }
    }
    return any ? lock_buf[lane] : par;
}

/* track t's P-locks after its block (#524; engine.ts locksStep, the same rule): while it plays (the transport runs, or a
 * clock is in clk; not bypassed) and its playhead moved to another step or pattern, its locked rows go back to their normal
 * values and the locks of the step it is on (of the pattern it plays, TRK_P) set theirs. The modules after it in the
 * processing order play them from this block, the others from the next. */
static void locks_step(const node_t *nd, const inst_t *it)
{
    uint32_t t = nd->trk, r, i, p = TRK_P(t);
    int32_t key = !nd->bypass && it->s.stp.pos >= 0 && (E.running || ((nd->conn >> STEPS_I_CLK) & 1u)) ? (int32_t)(p * 64u) + it->s.stp.pos : -1;
    if (key == E.trk_lkey[t])
        return;
    E.trk_lkey[t] = (int16_t)key;
    for (r = 0; r < E.nlt; r++)
        if (E.lt[r].trk == t)
            E.lt[r].on = 0;
    if (key < 0)
        return;
    for (i = 0; i < E.nlk; i++) {
        const lock_t *l = &E.lk[i];
        if (l->trk == t && l->pat == p && l->at == (uint32_t)it->s.stp.pos) {
            E.lt[l->row].on = 1;
            E.lt[l->row].v = l->v;
        }
    }
}
int eng_locks_count(void) { return E.loaded ? E.nlk : 0; }

/* the base values apply_cv works from: the node's, or a copy with its pending ramps added */
HOT const int32_t *ramp_base(const node_t *nd, const int32_t *par, uint32_t npar, uint32_t lane)
{
    uint32_t k, j, any = 0;
    int32_t m = (int32_t)(nd - E.node);
    for (k = 0; k < ENG_KNOBS; k++)
        if (ramp[k].left && ramp[k].mod == m && (uint32_t)ramp[k].par < npar) {
            if (!any) {
                for (j = 0; j < npar; j++)
                    ramp_buf[lane][j] = par[j];
                any = 1;
            }
            ramp_buf[lane][ramp[k].par] += ramp[k].off;
        }
    return any ? ramp_buf[lane] : par;
}

void eng_knob_param(uint32_t knob, uint32_t module, uint32_t param, int32_t q16)
{
    const def_t *d;
    int32_t was;
    if (module >= E.nmod || param >= DEFS[E.node[module].type].npar)
        return;
    d = &DEFS[E.node[module].type];
    was = E.node[module].par[param];
    E.node[module].par[param] = q16;                /* (as eng_set_param: the parameter at once) */
    tempo_follow(module, param, q16);
    if (knob < ENG_KNOBS && was != q16 && !(d->pchoice && d->pchoice[param]))
        ramp_start(knob, (int32_t)module, (int32_t)param, was, q16);
}

int eng_has_morph(void) { return E.loaded && E.has_b; }

static range_t *range_find(uint32_t module, uint32_t input, uint32_t param)
{
    uint32_t i;
    for (i = 0; i < E.nranges; i++)
        if (E.ranges[i].mod == module && E.ranges[i].pin == input && E.ranges[i].par == param)
            return &E.ranges[i];
    return 0;
}

int eng_range(uint32_t module, uint32_t input, uint32_t param, uint32_t *lo, uint32_t *hi)
{
    const range_t *r;
    if (module >= E.nmod || input > 1u || !(E.node[module].ranged[input] >> param & 1u))
        return 0;
    r = range_find(module, input, param);
    if (!r)
        return 0;
    *lo = r->lo;
    *hi = r->hi;
    return 1;
}

int eng_set_range(uint32_t module, uint32_t input, uint32_t param, int on, uint32_t lo, uint32_t hi)
{
    int bi = (on & 2) != 0;                       /* (bit 1: bipolar, #526) */
    range_t *r;
    if (module >= E.nmod || input > 1u || param >= DEFS[E.node[module].type].npar)
        return 0;
    r = range_find(module, input, param);
    if (!on) {
        if (r) {
            *r = E.ranges[--E.nranges];
            E.node[module].ranged[input] &= ~(1u << param);
        }
        return 1;
    }
    if (!r) {
        if (E.nranges >= ENG_MAX_RANGES)
            return 0;
        r = &E.ranges[E.nranges++];
        r->mod = (uint8_t)module;
        r->pin = (uint8_t)input;
        r->par = (uint8_t)param;
    }
    r->lo = (uint8_t)(lo > 255u ? 255u : lo);
    r->hi = (uint8_t)(hi > 255u ? 255u : hi);
    r->bi = (uint8_t)bi;
    E.node[module].ranged[input] |= 1u << param;
    return 1;
}

/* the morph position of the coming block (engine.ts morphPosition): the Main module's MORPH parameter plus the block mean
 * of its morph input, which holds what the input summed in the previous block (one block late), clamped to 0..1 */
static int32_t morph_position(uint32_t n)
{
    const node_t *nd;
    int32_t t;
    if (E.main < 0)
        return 0;
    nd = &E.node[E.main];
    t = nd->par[FM1_P_MORPH];
    if (nd->conn & (1u << FM1_I_MORPH)) {
        const esig_t *b = inst_pool[nd->inst0].in[FM1_I_MORPH];
        int64_t s = 0;
        uint32_t i;
        for (i = 0; i < n; i++)
            s += b[i];
        t += block_mean(s, n);
    }
    return clampi(t, 0, ENG_ONE);
}

/* the space the morph moves in: a parameter's position in its range as Q16 0..1, octaves for a log parameter but without
 * the knob bend of unit_of (the midpoint of 200 and 3200 Hz is 800 Hz), and back */
static int32_t morph_unit(const def_t *d, uint32_t j, int32_t v)
{
    int32_t lo = d->pmin[j], hi = d->pmax[j];
    v = clampi(v, lo, hi);
    if (d->plog && d->plog[j]) {
        int32_t l0 = log2_q16((uint32_t)lo);
        return (int32_t)(((int64_t)(log2_q16((uint32_t)v) - l0) << 16) / (log2_q16((uint32_t)hi) - l0));
    }
    return (int32_t)(((int64_t)(v - lo) << 16) / (hi - lo));
}

static int32_t morph_value(const def_t *d, uint32_t j, int32_t u)
{
    int32_t lo = d->pmin[j], hi = d->pmax[j];
    u = clampi(u, 0, ENG_ONE);
    if (d->plog && d->plog[j]) {
        int32_t l0 = log2_q16((uint32_t)lo);
        return clampi((int32_t)exp2_q16(l0 + (int32_t)(((int64_t)u * (log2_q16((uint32_t)hi) - l0)) >> 16)), lo, hi);
    }
    return lo + (int32_t)(((int64_t)u * (hi - lo)) >> 16);
}

/* a parameter at morph position t between its value and its B side (patch.ts morphValue): a choice or switch snaps at
 * 0.5, the rest moves in morph_unit space; with either side past pmax (a stretch: `over`, the B side (PARB) is B - pmin
 * in 1/2048) linearly between the values */
HOT int32_t morph_of(const def_t *d, uint32_t j, int32_t a, uint32_t ub, int32_t t, int over)
{
    int32_t ua;
    if (over || (d->ptop && a > d->pmax[j])) {
        int32_t b = over ? d->pmin[j] + (int32_t)(ub << 5) : morph_value(d, j, (int32_t)ub);
        if (d->pchoice && d->pchoice[j])
            return t < 32768 ? a : b;
        return a + (int32_t)(((int64_t)(b - a) * t) >> 16);
    }
    if (d->pchoice && d->pchoice[j])
        return t < 32768 ? a : morph_value(d, j, (int32_t)ub);
    ua = morph_unit(d, j, a);
    return morph_value(d, j, ua + (int32_t)(((int64_t)((int32_t)ub - ua) * t) >> 16));
}

/* for the knobs: a parameter moved by `clicks` steps of 1/100 of its range (octaves for the cutoff) */
int32_t eng_step_param(uint32_t module, uint32_t j, int32_t clicks, int32_t unit_per_click)
{
    const def_t *d;
    if (module >= E.nmod || j >= DEFS[E.node[module].type].npar)
        return 0;
    d = &DEFS[E.node[module].type];
    return value_of(d, j, unit_of(d, j, E.node[module].par[j]) + clicks * unit_per_click);
}

int32_t eng_step_value(uint32_t module, uint32_t j, int32_t v, int32_t clicks, int32_t unit_per_click)
{
    const def_t *d;
    if (module >= E.nmod || j >= DEFS[E.node[module].type].npar)
        return 0;
    d = &DEFS[E.node[module].type];
    return value_of(d, j, unit_of(d, j, v) + clicks * unit_per_click);
}

int eng_param_is_log(uint32_t module, uint32_t j)
{
    return module < E.nmod && j < DEFS[E.node[module].type].npar && DEFS[E.node[module].type].plog && DEFS[E.node[module].type].plog[j];
}

/* the value the module used in the last block: the base plus what the parameter inputs added */
int32_t eng_get_eff(uint32_t module, uint32_t param)
{
    return module < E.nmod && param < DEFS[E.node[module].type].npar ? inst_pool[E.node[module].inst0].eff[param] : 0;
}

int32_t eng_get_param(uint32_t module, uint32_t param)
{
    return module < E.nmod && param < DEFS[E.node[module].type].npar ? E.node[module].par[param] : 0;
}

int eng_find(uint32_t type)
{
    uint32_t i;
    if (!E.loaded)
        return -1;
    for (i = 0; i < E.nmod; i++)
        if (E.node[i].type == type)
            return (int)i;
    return -1;
}

/* ------------------------------------------------------------------ voices (engine.ts noteOn / noteOff) */

static int32_t note_pitch(uint32_t note)
{
    int32_t v = ((int32_t)note - 60) * 32768;      /* (note - 60) / 12 octaves = k * 65536 / 12 */
    return (v >= 0 ? v + 3 : v - 3) / 6;
}

/* one part: the gate stays up while any key is down; the sounding key is the last, lowest or highest held (priority). A
 * change of key while the gate is up is a legato transition: the legato output goes high and, with legato off (1), the
 * envelopes restart (one low gate sample); auto (0) and on (2) keep them running. Unison: every part the same way, with the
 * same stamps. (engine.ts monoUpdate / monoPart) */
static void mono_part(const grp_t *g, pv_t *x, int k);

/* Select by priority, then put the selected notes in keyboard order. Only the small voice pool is sorted. */
static void shared_unison(grp_t *g)
{
    uint8_t keys[ENG_MAX_PARTS];
    uint32_t i, j, at, nk = 0, slots = g->stack && g->stack < g->parts ? g->stack : g->parts;
    uint32_t copies, s0 = E.stamp, s1 = s0;
    for (i = 0; i < g->nheld; i++) {
        for (at = 0; at < nk; at++) {
            uint32_t prev = keys[at];
            if (!g->priority || (g->priority == 1 ? g->held_note[i] < g->held_note[prev] : g->held_note[i] > g->held_note[prev])) break;
        }
        if (at >= slots) continue;
        if (nk < slots) nk++;
        for (j = nk - 1u; j > at; j--) keys[j] = keys[j - 1u];
        keys[at] = (uint8_t)i;
    }
    for (i = 1; i < nk; i++) {
        uint8_t k = keys[i];
        for (j = i; j && g->held_note[keys[j - 1u]] > g->held_note[k]; j--) keys[j] = keys[j - 1u];
        keys[j] = k;
    }
    copies = nk ? slots / nk : 0;
    for (i = 0; i < g->parts; i++) {
        E.stamp = s0;
        mono_part(g, &E.pv[g->pv0 + i], copies && i < copies * nk ? keys[i / copies] : -1);
        if (E.stamp > s1) s1 = E.stamp;
    }
    E.stamp = s1;
}

static void mono_update(grp_t *g)
{
    int k = -1;
    if (g->unison == 2u) { shared_unison(g); return; }
    uint32_t i, n = g->unison ? (g->stack && g->stack < g->parts ? g->stack : g->parts) : 1u, s0 = E.stamp, s1 = s0;
    if (g->nheld) {
        k = (int)g->nheld - 1;
        if (g->priority)
            for (i = 0; i < g->nheld; i++)
                if (g->priority == 1 ? g->held_note[i] < g->held_note[k] : g->held_note[i] > g->held_note[k])
                    k = (int)i;
    }
    for (i = 0; i < g->parts; i++) {
        E.stamp = s0;
        mono_part(g, &E.pv[g->pv0 + i], i < n ? k : -1);
        if (E.stamp > s1) s1 = E.stamp;
    }
    E.stamp = s1;
}

static void mono_part(const grp_t *g, pv_t *x, int k)
{
    if (k >= 0) {
        int32_t p = note_pitch(g->held_note[k]);
        if (!x->on || g->held_note[k] != x->note) {
            x->jump = p - x->pitch;
            x->legato = x->on;
            if (x->on && g->legato == 1)
                x->retrig = 1;
            x->on_stamp = ++E.stamp;
        }
        x->pitch = p;
        x->vel = g->held_vel[k];
        x->gate = ENG_ONE;
        x->note = g->held_note[k];
        x->on = 1;
    } else {
        if (x->on)
            x->off_stamp = ++E.stamp;
        x->gate = 0;
        x->on = 0;
    }
}

/* a group's unison mode changes to u (engine.ts unisonSwitch). Into unison from off: the notes its parts play, oldest
 * first, become the held keys and the parts take them as unison does. Out of it: the parts keep their notes until their
 * keys are let go. Between on and share: the held keys again. One part: nothing changes. */
static void __attribute__((noinline)) unison_switch(grp_t *g, uint32_t u)
{
    uint32_t was = g->unison, i, j, n = 0;
    uint8_t ord[ENG_MAX_PARTS];
    g->unison = (uint8_t)u;
    if (g->parts == 1)
        return;
    if (!was) {
        for (i = 0; i < g->parts; i++) {         /* the sounding parts by their notes' age (equal ages: part order) */
            const pv_t *x = &E.pv[g->pv0 + i];
            if (!x->on)
                continue;
            for (j = n; j && E.pv[g->pv0 + ord[j - 1u]].on_stamp > x->on_stamp; j--)
                ord[j] = ord[j - 1u];
            ord[j] = (uint8_t)i;
            n++;
        }
        g->nheld = 0;
        for (i = 0; i < n; i++) {
            const pv_t *x = &E.pv[g->pv0 + ord[i]];
            for (j = 0; j < g->nheld && g->held_note[j] != x->note; j++)
                ;
            if (j < g->nheld)
                continue;
            g->held_note[g->nheld] = x->note;
            g->held_vel[g->nheld++] = x->vel;
        }
        mono_update(g);
    } else if (!u)
        g->nheld = 0;
    else
        mono_update(g);
}

/* the end of a block (engine.ts voicingCables, #681): what the cables into each group's Part's assign and unison inputs
 * carry, their first sample (summed as the Part's input is), sets the group's assign and unison for the next block's keys */
static void __attribute__((noinline)) group_cables(void)
{
    uint32_t k, c, v;
    for (k = 1; k <= E.ngrp; k++) {
        grp_t *g = &E.grp[k];
        int32_t cv[2] = {0, 0}, u;
        if (g->mode == 0xFFu)
            continue;
        for (c = 0; c < E.ncab; c++) {
            uint32_t fm = E.from_m[c], fp = E.from_p[c], tp = E.to_p[c];
            const node_t *f = &E.node[fm];
            if (E.to_m[c] != g->mode || tp > PART_I_UNISON)
                continue;
            if (f->grp && f->grp != k) {
                int32_t w = para_w(fm, fp);
                for (v = 0; v < f->ninst; v++) {
                    int32_t a = buf_of(fm, fp, v)[0];
                    cv[tp] += w ? mul16(a, w) : a;
                }
            } else
                cv[tp] += buf_of(fm, fp, 0)[0];
        }
        g->cv[0] = cv[0];
        g->cv[1] = cv[1];
        g->assign = (uint8_t)vsetting(g->assign0, cv[0], 3);
        u = vsetting(g->unison0, cv[1], 2);
        if (u != (int32_t)g->unison)
            unison_switch(g, (uint32_t)u);
    }
}

static void held_drop(grp_t *g, uint32_t note)
{
    uint32_t i, k = 0;
    for (i = 0; i < g->nheld; i++)
        if (g->held_note[i] != note) {
            g->held_note[k] = g->held_note[i];
            g->held_vel[k++] = g->held_vel[i];
        }
    g->nheld = (uint8_t)k;
}

static void group_off(grp_t *g, uint32_t note)
{
    uint32_t i;
    g->down[note >> 5] &= ~(1u << (note & 31u));
    if (g->parts == 1 || g->unison) {
        held_drop(g, note);
        mono_update(g);
        return;
    }
    for (i = 0; i < g->parts; i++) {
        pv_t *x = &E.pv[g->pv0 + i];
        if (x->on && x->note == note) {
            x->on = 0;
            x->gate = 0;
            x->off_stamp = ++E.stamp;
        }
    }
}

/* a note for one group (engine.ts groupOn). Several parts: the key already down on a part keeps it; else a free part by
 * the assign mode (rotate: the next in turn; lowest: the lowest-numbered; reuse: a free part whose last note was the key,
 * else the one free the longest); with none free one is taken over by priority (last: the oldest note; low / high: the
 * highest / lowest note, only for a lower / higher key; otherwise the key does not sound). A taken-over part restarts its
 * envelopes unless legato is on. */
static void group_on(grp_t *g, uint32_t note, int32_t vel_q16)
{
    pv_t *vs = &E.pv[g->pv0], *x;
    uint32_t n = g->parts, i;
    if (g->assign == 3u && !(g->down[0] | g->down[1] | g->down[2] | g->down[3])) g->rot = 0;
    g->down[note >> 5] |= 1u << (note & 31u);
    for (i = 0; i < n; i++) vs[i].key_trig = 1;
    int v = -1, nfree = 0;
    uint8_t over = 0;                            /* another key is down: this note overlaps it */
    if (n == 1 || g->unison) {                   /* the key again: to the top (no update in between) */
        held_drop(g, note);
        if (g->nheld == MAX_HELD) {
            for (i = 1; i < MAX_HELD; i++) {
                g->held_note[i - 1] = g->held_note[i];
                g->held_vel[i - 1] = g->held_vel[i];
            }
            g->nheld--;
        }
        g->held_note[g->nheld] = (uint8_t)note;
        g->held_vel[g->nheld] = vel_q16;
        g->nheld++;
        mono_update(g);
        return;
    }
    for (i = 0; i < n; i++) {
        if (vs[i].on && vs[i].note != note)
            over = 1;
        if (!vs[i].on)
            nfree++;
    }
    for (i = 0; i < n && v < 0; i++)
        if (vs[i].on && vs[i].note == note)
            v = (int)i;
    if (v < 0 && nfree) {
        if (g->assign == 0 || g->assign == 3) {
            for (i = 0; i < n && v < 0; i++)
                if (!vs[(g->rot + i) % n].on)
                    v = (int)((g->rot + i) % n);
            g->rot = (uint8_t)(((uint32_t)v + 1u) % n);
        } else if (g->assign == 1) {
            for (i = 0; i < n && v < 0; i++)
                if (!vs[i].on)
                    v = (int)i;
        } else {
            for (i = 0; i < n && v < 0; i++)
                if (!vs[i].on && vs[i].note == note)
                    v = (int)i;
            if (v < 0)
                for (i = 0; i < n; i++)
                    if (!vs[i].on && (v < 0 || vs[i].off_stamp < vs[v].off_stamp))
                        v = (int)i;
        }
    } else if (v < 0) {
        if (g->no_steal) return;
        v = 0;
        for (i = 1; i < n; i++)
            if (g->priority == 1 ? vs[i].note > vs[v].note : g->priority == 2 ? vs[i].note < vs[v].note : vs[i].on_stamp < vs[v].on_stamp)
                v = (int)i;
        if ((g->priority == 1 && note > vs[v].note) || (g->priority == 2 && note < vs[v].note))
            return;
    }
    x = &vs[v];
    if (x->on && g->legato != 2)
        x->retrig = 1;
    x->legato = over;
    x->jump = note_pitch(note) - x->pitch;
    x->note = (uint8_t)note;
    x->pitch = note_pitch(note);
    x->vel = vel_q16;
    x->gate = ENG_ONE;
    x->on = 1;
    x->on_stamp = ++E.stamp;
}

/* ------------------------------------------------------------------ arpeggiator (web/src/arpeggiator.ts) */

static int arp_latched(const arp_t *a) { return E.node[a->node].par[ARP_P_LATCH] >= 32768; }

/* A bypassed Arpeggiator hands the keys it hears straight on (engine.ts effSrc / passesMain): its groups and Drum maps
 * play them as its own source's (Main's keys, or the track cabled into it). arp_hears_main: it takes Main's keys now */
static int arp_hears_main(uint32_t m) { return !E.node[m].ksrc && (!E.armany || mset_has(E.armm, m)); }
static int arp_thru(uint32_t m) { return m < E.nmod && E.node[m].type == T_ARP && E.node[m].bypass; }
/* a Harmonizer hears Main's keys (engine.ts keyHarms): always while nothing is armed, else when armed; bypassed it hands
 * them straight on (harmPasses) */
static int harm_hears_main(uint32_t m) { return !E.armany || mset_has(E.armm, m); }
static int harm_thru(uint32_t m) { return m < E.nmod && E.node[m].type == T_HARM && E.node[m].bypass; }
/* where group g's notes come from now (grp_t src coding: 0 the keys, 1 + a node); 0xFF nothing */
static uint32_t grp_src(uint32_t g)
{
    uint32_t s = E.grp[g].src, a;
    if (s && harm_thru(s - 1u))
        return harm_hears_main(s - 1u) ? 0u : 0xFFu;
    if (!s || !arp_thru(s - 1u))
        return s;
    a = s - 1u;
    if (E.node[a].ksrc >= 2u)
        return E.node[a].ksrc - 1u;
    return arp_hears_main(a) ? 0u : 0xFFu;
}
/* where a Drum map's keys come from now (ksrc coding: 1 the keys, 2 + a node); 0xFF nothing */
static uint32_t dm_src(const node_t *nd)
{
    uint32_t k = nd->ksrc, a;
    if (k < 2u || !arp_thru(k - 2u))
        return k;
    a = k - 2u;
    if (E.node[a].ksrc >= 2u)
        return E.node[a].ksrc;
    return arp_hears_main(a) ? 1u : 0xFFu;
}
static void dm_keys(uint32_t src, uint32_t kv, uint32_t vel);

static void arp_key_drop(arp_t *a, uint32_t note)
{
    uint32_t i, k = 0;
    for (i = 0; i < a->n; i++)
        if (a->held[i].note != note)
            a->held[k++] = a->held[i];
    a->n = (uint8_t)k;
}

static void arp_note_on(arp_t *a, uint32_t note, int32_t vel)
{
    uint32_t i;
    int down = 0;
    for (i = 0; i < a->n; i++)
        down |= a->held[i].down;
    if (arp_latched(a) && !down)
        a->n = 0;                                /* a new chord after all keys were let go replaces the latched one */
    arp_key_drop(a, note);
    if (a->n >= ARP_HELD) {
        for (i = 1; i < a->n; i++)
            a->held[i - 1] = a->held[i];
        a->n--;
    }
    a->held[a->n].note = (uint8_t)note;
    a->held[a->n].vel = vel;
    a->held[a->n].down = 1;
    a->n++;
}

static void arp_note_off(arp_t *a, uint32_t note)
{
    uint32_t i;
    for (i = 0; i < a->n; i++)
        if (a->held[i].note == note)
            a->held[i].down = 0;
    if (!arp_latched(a))
        arp_key_drop(a, note);
}

/* the note of step pos (arpeggiator.ts arpNote): the keys sorted (or as played), over the octaves, picked by the mode */
static int arp_pick(arp_t *a, int32_t *vel)
{
    const node_t *nd = &E.node[a->node];
    uint8_t base[ARP_HELD], note[ARP_LIST];
    int32_t bvel[ARP_HELD], nvel[ARP_LIST];
    int32_t mode = clampi((nd->par[ARP_P_MODE] + 32768) >> 16, 0, 4), oct = clampi((nd->par[ARP_P_OCTAVES] + 32768) >> 16, 1, 4);
    uint32_t i, j, o, len = 0, idx;
    for (i = 0; i < a->n; i++) {
        base[i] = a->held[i].note;
        bvel[i] = a->held[i].vel;
    }
    if (mode != 4)                               /* sorted by note (insertion sort: stable, as Array.sort) */
        for (i = 1; i < a->n; i++)
            for (j = i; j > 0 && base[j - 1] > base[j]; j--) {
                uint8_t t = base[j];
                int32_t tv = bvel[j];
                base[j] = base[j - 1];
                bvel[j] = bvel[j - 1];
                base[j - 1] = t;
                bvel[j - 1] = tv;
            }
    for (o = 0; o < (uint32_t)oct; o++)
        for (i = 0; i < a->n; i++)
            if (base[i] + 12u * o <= 127u) {
                note[len] = (uint8_t)(base[i] + 12u * o);
                nvel[len++] = bvel[i];
            }
    if (!len)
        return -1;
    if (mode == 1) {
        idx = len - 1u - a->pos % len;
    } else if (mode == 2 && len > 2u) {
        uint32_t cycle = 2u * len - 2u, k = a->pos % cycle;
        idx = k < len ? k : cycle - k;
    } else if (mode == 3) {
        a->seed = a->seed * 1664525u + 1013904223u;
        idx = (a->seed >> 16) % len;
    } else {
        idx = a->pos % len;
    }
    *vel = nvel[idx];
    return note[idx];
}

/* its note into the groups and Drum maps it plays; a part it lands on restarts its envelopes */
static void arp_emit_on(const arp_t *a, uint32_t note, int32_t vel)
{
    uint32_t g, v;
    dm_keys(2u + a->node, note | 0x80u, (uint32_t)clampi((int32_t)(((int64_t)vel * 127 + 32768) >> 16), 1, 127));
    for (g = 1; g <= E.ngrp; g++)
        if (E.grp[g].src == a->node + 1u && note >= E.grp[g].lo && note <= E.grp[g].hi) {   /* the range judges the arpeggiator's notes */
            group_on(&E.grp[g], note, vel);
            for (v = 0; v < E.grp[g].parts; v++) {
                pv_t *x = &E.pv[E.grp[g].pv0 + v];
                if (x->on && x->note == note && x->on_stamp == E.stamp)
                    x->retrig = 1;
            }
        }
}

static void arp_emit_off(const arp_t *a, uint32_t note)
{
    uint32_t g;
    dm_keys(2u + a->node, note, 0u);
    for (g = 1; g <= E.ngrp; g++)
        if (E.grp[g].src == a->node + 1u)
            group_off(&E.grp[g], note);
}

/* ------------------------------------------------------------------ harmonizer (web/src/harmonizer.ts, #598) */

static uint8_t harm_raw;                         /* the keys come as roots whatever their note (the FM-1's keys: eng_harm_zone) */

static int32_t harm_par(const harm_t *h, uint32_t p, int32_t lo, int32_t hi) { return clampi(round_q16(E.node[h->node].par[p]), lo, hi); }
static int harm_locks(const harm_t *h) { return harm_par(h, HARM_P_LOCK, 0, 1) == 1; }
/* the buttons in effect: those held (Lock: of the press under way), else the latched ones (Lock on) */
static uint32_t harm_buttons(const harm_t *h) { return harm_locks(h) ? (h->down ? h->gesture : h->locked) : h->down; }

/* a chord button pressed or let go (harmonizer.ts harmButton) */
static void harm_button(harm_t *h, uint32_t b, int down)
{
    uint8_t bit = (uint8_t)(1u << b);
    if (b >= HARM_ZONE)
        return;
    if (down) {
        if (h->down & bit)
            return;
        h->stamp[b] = ++h->clock;
        if (!h->down) {
            h->gesture = bit;
            h->toggle = h->locked == bit;
        } else {
            h->gesture |= bit;
            h->toggle = 0;
        }
        h->down |= bit;
    } else {
        if (!(h->down & bit))
            return;
        h->down &= (uint8_t)~bit;
        if (!h->down && harm_locks(h))
            h->locked = h->toggle ? 0u : h->gesture;
        if (!h->down) {
            h->gesture = 0;
            h->toggle = 0;
        }
    }
}

/* the chord as intervals over the root, low to high, before the voicing (harmonizer.ts harmIntervals): from the buttons in
 * effect (bit 0 sus2, 1 maj, 2 sus4, 3 min, 4 7, 5 dim, 6 9; the quality pressed last wins), else the card's. Its count */
static uint32_t harm_intervals(const harm_t *h, int32_t *t)
{
    uint32_t bits = harm_buttons(h), n = 0, i, j, at = 0;
    int32_t type = 0, sus2, sus4, sev, nine, x;
    if (bits) {
        for (i = 0; i < 3u; i++)
            if ((bits >> (2u * i + 1u) & 1u) && h->stamp[2u * i + 1u] > at) {
                at = h->stamp[2u * i + 1u];
                type = (int32_t)i + 1;
            }
        sus2 = (int32_t)(bits & 1u);
        sus4 = (int32_t)(bits >> 2 & 1u);
        sev = (int32_t)(bits >> 4 & 1u);
        nine = (int32_t)(bits >> 6 & 1u);
    } else {
        int32_t su = harm_par(h, HARM_P_SUS, 0, 3), ex = harm_par(h, HARM_P_EXT, 0, 3);
        type = harm_par(h, HARM_P_TYPE, 0, 3);
        sus2 = su & 1;
        sus4 = su >> 1 & 1;
        sev = ex & 1;
        nine = ex >> 1 & 1;
    }
    t[n++] = 0;
    if (!type && !sus2 && !sus4 && !sev && !nine)
        return n;
    if (type == 2 || type == 3) {                /* the quality's third and fifth; without one a sus chord (no third), else */
        t[n++] = 3;                              /* a major one under the 7th / 9th */
        t[n++] = type == 3 ? 6 : 7;
    } else if (type == 1 || !(sus2 || sus4)) {
        t[n++] = 4;
        t[n++] = 7;
    } else {
        t[n++] = 7;
    }
    if (sus2)
        t[n++] = 2;
    if (sus4)
        t[n++] = 5;
    if (sev)
        t[n++] = 10;
    if (nine)
        t[n++] = 14;
    for (i = 1; i < n; i++)                      /* (insertion sort, low to high) */
        for (j = i; j > 0 && t[j - 1] > t[j]; j--) {
            x = t[j];
            t[j] = t[j - 1];
            t[j - 1] = x;
        }
    return n;
}

/* the notes root plays now, low to high, inside 0..127 (harmonizer.ts harmChord): the voicing's steps up take the lowest
 * note an octave up, its steps down the highest an octave down (a chord only, not the root alone). Their count */
static uint32_t harm_chord(const harm_t *h, uint32_t root, uint8_t *out)
{
    int32_t t[HARM_TONES], v = harm_par(h, HARM_P_VOICING, -HARM_VOICING, HARM_VOICING), x;
    uint32_t n = harm_intervals(h, t), i, k = 0;
    for (; n > 1u && v > 0; v--) {
        x = t[0] + 12;
        for (i = 1; i < n && t[i] < x; i++)
            t[i - 1u] = t[i];
        t[i - 1u] = x;
    }
    for (; n > 1u && v < 0; v++) {
        x = t[n - 1u] - 12;
        for (i = n - 1u; i > 0 && t[i - 1u] > x; i--)
            t[i] = t[i - 1u];
        t[i] = x;
    }
    for (i = 1; i < n; i++)                      /* (low to high again: a 9th taken down lands over the root) */
        for (k = i; k > 0 && t[k - 1u] > t[k]; k--) {
            x = t[k];
            t[k] = t[k - 1u];
            t[k - 1u] = x;
        }
    k = 0;
    for (i = 0; i < n; i++)
        if ((x = (int32_t)root + t[i]) >= 0 && x <= 127)
            out[k++] = (uint8_t)x;
    return k;
}

/* a note of its into the groups it plays (an arpeggiator's way: their key range judges it) */
static void harm_emit_on(const harm_t *h, uint32_t note, int32_t vel)
{
    uint32_t g;
    for (g = 1; g <= E.ngrp; g++)
        if (E.grp[g].src == h->node + 1u && note >= E.grp[g].lo && note <= E.grp[g].hi)
            group_on(&E.grp[g], note, vel);
}
static void harm_emit_off(const harm_t *h, uint32_t note)
{
    uint32_t g;
    for (g = 1; g <= E.ngrp; g++)
        if (E.grp[g].src == h->node + 1u)
            group_off(&E.grp[g], note);
}

/* a root let go: the notes no other held root sounds end */
static void harm_root_off(harm_t *h, uint32_t key)
{
    uint32_t i, j;
    for (i = 0; i < h->nroots && h->root[i] != key; i++)
        ;
    if (i >= h->nroots)
        return;
    for (j = 0; j < h->nnote[i]; j++)
        if (h->count[h->note[i][j]] && --h->count[h->note[i][j]] == 0u)
            harm_emit_off(h, h->note[i][j]);
    for (h->nroots--; i < h->nroots; i++) {
        h->root[i] = h->root[i + 1u];
        h->nnote[i] = h->nnote[i + 1u];
        for (j = 0; j < HARM_TONES; j++)
            h->note[i][j] = h->note[i + 1u][j];
    }
}

/* a root pressed: its chord's notes no held root sounds yet start; one already held plays again */
static void harm_root_on(harm_t *h, uint32_t key, int32_t vel)
{
    uint32_t i, j;
    harm_root_off(h, key);
    if (h->nroots >= HARM_ROOTS)
        return;
    i = h->nroots++;
    h->root[i] = (uint8_t)key;
    h->nnote[i] = (uint8_t)harm_chord(h, key, h->note[i]);
    for (j = 0; j < h->nnote[i]; j++)
        if (h->count[h->note[i][j]]++ == 0u)
            harm_emit_on(h, h->note[i][j], vel);
}

/* a key from Main: one of the seven under the split a button (not from the FM-1's keys: harm_raw), else a root */
static void harm_key(harm_t *h, uint32_t note, int32_t vel, int down)
{
    int32_t b;
    uint32_t i, held;
    if (note >= 128u)
        return;
    if (!harm_raw && (held = h->button_key[note]) != 0u) {
        if (!down) {
            h->button_key[note] = 0;
            for (i = 0; i < 128u && h->button_key[i] != held; i++)
                ;
            if (i == 128u)
                harm_button(h, held - 1u, 0);
        }
        return;
    }
    if (!down) {
        harm_root_off(h, note);
        return;
    }
    b = (int32_t)note - (harm_par(h, HARM_P_SPLIT, 0, 127) - HARM_ZONE);
    if (!harm_raw && b >= 0 && b < HARM_ZONE) {
        harm_root_off(h, note);
        h->button_key[note] = (uint8_t)(b + 1);
        harm_button(h, (uint32_t)b, 1);
    } else
        harm_root_on(h, note, vel);
}

/* its groups let go of every note, its roots too (the buttons and the latch stay; engine.ts harmDrop) */
static void harm_drop(harm_t *h)
{
    uint32_t g, v;
    h->nroots = 0;
    for (v = 0; v < 128u; v++)
        h->count[v] = 0;
    for (g = 1; g <= E.ngrp; g++) {
        if (E.grp[g].src != h->node + 1u)
            continue;
        E.grp[g].nheld = 0;
        E.grp[g].down[0] = E.grp[g].down[1] = E.grp[g].down[2] = E.grp[g].down[3] = 0;
        for (v = 0; v < E.grp[g].parts; v++) {
            E.pv[E.grp[g].pv0 + v].on = 0;
            E.pv[E.grp[g].pv0 + v].gate = 0;
            E.pv[E.grp[g].pv0 + v].retrig = 0;
            E.pv[E.grp[g].pv0 + v].key_trig = 0;
        }
    }
}
/* everything let go, the latch too (harmonizer.ts harmClear) */
static void harm_clear(harm_t *h)
{
    uint8_t node = h->node, *hz = (uint8_t *)h;
    uint32_t j;
    for (j = 0; j < sizeof *h; j++)
        hz[j] = 0;
    h->node = node;
}
static void harm_switched(uint32_t m)
{
    uint32_t k;
    for (k = 0; k < E.nharm; k++)
        if (E.harm[k].node == m)
            harm_drop(&E.harm[k]);
}

void eng_harm_zone(int on) { harm_raw = (uint8_t)!on; }

void eng_chord_button(uint32_t b, int down)
{
    uint32_t k;
    if (!E.loaded)
        return;
    for (k = 0; k < E.nharm; k++)
        if (harm_hears_main(E.harm[k].node) && !E.node[E.harm[k].node].bypass)
            harm_button(&E.harm[k], b, down);
}

/* the Harmonizer the keys reach (engine.h): one that hears Main's keys, is not bypassed and plays a group; -1 none */
int eng_keys_harm(void)
{
    uint32_t k, g;
    if (!E.loaded)
        return -1;
    for (k = 0; k < E.nharm; k++) {
        uint32_t m = E.harm[k].node;
        if (!harm_hears_main(m) || E.node[m].bypass)
            continue;
        for (g = 1; g <= E.ngrp; g++)
            if (E.grp[g].src == m + 1u)
                return (int)m;
    }
    return -1;
}

/* the chord harmonizer m plays now, by name (harmonizer.ts harmName: MIN7, MAJ ADD2, 7 SUS4..., "" the root alone). The 7
 * button's seventh is the minor one: beside maj it reads 7 (a dominant seventh), beside dim MIN7B5; 9 with 7 is a ninth
 * chord, without it ADD9; a 2nd or 4th beside a third is ADD2 / ADD4, without one SUS2 / SUS4 */
static char *harm_put(char *q, const char *out, const char *w)
{
    if (q != out)
        *q++ = ' ';
    while (*w)
        *q++ = *w++;
    return q;
}
void eng_harm_name(uint32_t m, char *out)
{
    static const char *const Q[4] = {"", "MAJ", "MIN", "DIM"};
    int32_t t[HARM_TONES];
    uint32_t k, n, i, has = 0, q3;
    char *q = out, ext[8];
    *out = 0;
    for (k = 0; k < E.nharm && E.harm[k].node != m; k++)
        ;
    if (!E.loaded || k >= E.nharm || (n = harm_intervals(&E.harm[k], t)) < 2u)
        return;
    for (i = 0; i < n; i++)
        has |= 1u << t[i];
    q3 = (has >> 3 & 1u) && (has >> 6 & 1u) ? 3u : has >> 3 & 1u ? 2u : has >> 4 & 1u ? 1u : 0u;
    if (has >> 10 & 1u) {
        char *e = ext;
        if (q3 >= 2u) {
            *e++ = 'M';
            *e++ = 'I';
            *e++ = 'N';
        }
        *e++ = has >> 14 & 1u ? '9' : '7';
        if (q3 == 3u) {
            *e++ = 'B';
            *e++ = '5';
        }
        *e = 0;
        q = harm_put(q, out, ext);
    } else if (q3) {
        q = harm_put(q, out, Q[q3]);
    }
    if (has >> 2 & 1u)
        q = harm_put(q, out, q3 ? "ADD2" : "SUS2");
    if (has >> 5 & 1u)
        q = harm_put(q, out, q3 ? "ADD4" : "SUS4");
    if ((has >> 14 & 1u) && !(has >> 10 & 1u))
        q = harm_put(q, out, "ADD9");
    *q = 0;
}

/* a Drum map lets go of every row at once (engine.ts dropRows): the keys it held too */
static void dm_drop(inst_t *it)
{
    it->s.dm.gate = 0;
    it->s.dm.held[0] = it->s.dm.held[1] = it->s.dm.held[2] = it->s.dm.held[3] = 0;
}

/* the rows key k plays on a Drum map with repeat on (#184; modules.ts drumRowsOf), bit r = row r. at[]: the rows' places
 * (dm_places), lo / period: their block. A row's place is its white key's count when every row is on a white key (a
 * black key counts as the white key below it), else its note */
static const uint8_t WHITE_AT[12] = {0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6};
static int32_t dm_place(uint32_t k, int white) { return white ? (int32_t)(k / 12u * 7u + WHITE_AT[k % 12u]) : (int32_t)k; }
static uint32_t dm_rows(const int32_t *at, int32_t lo, int32_t period, uint32_t k, int white)
{
    uint32_t r, rows = 0;
    int32_t x = (dm_place(k, white) - lo) % period;
    if (x < 0)
        x += period;
    for (r = 0; r < DRUMMAP_NOUT / 2u; r++)
        if (at[r] - lo == x)
            rows |= 1u << r;
    return rows;
}

/* a note on (key | 0x80, velocity 1..127) or off (key, 0) into the Drum maps whose keys come from `src` (1 the keys, 2 + a
 * Steps module's index; engine.ts mapKeys): a row on that note raises its gate (restarting it if it is up or fell since
 * the last block) and takes the velocity, or lets it fall. With repeat on (#184) the rows' keys repeat over the keybed
 * (dm_rows), and a row another key still holds up is left as it is */
static void dm_keys(uint32_t src, uint32_t kv, uint32_t vel)
{
    uint32_t i, r, key = kv & 0x7Fu;
    for (i = 0; i < E.nmod; i++) {
        const node_t *nd = &E.node[i];
        inst_t *it;
        uint32_t rows = 0, other = 0;
        int rep;
        if (nd->type != T_DRUMMAP || dm_src(nd) != src || (src == 1u && nd->ksrc == 1u && E.armany && !mset_has(E.armm, i)))   /* (#191: armed ones only) */
            continue;
        it = &inst_pool[nd->inst0];
        rep = round_q16(nd->par[DRUMMAP_P_REPEAT]) >= 1;
        if (rep) {
            int32_t at[DRUMMAP_NOUT / 2u], lo = 127, hi = 0;
            uint32_t k, w, white = 1;
            for (r = 0; r < DRUMMAP_NOUT / 2u; r++)
                white &= 0xAB5u >> (uint32_t)clampi(round_q16(nd->par[r]), 0, 127) % 12u;   /* (C D E F G A B) */
            for (r = 0; r < DRUMMAP_NOUT / 2u; r++) {
                at[r] = dm_place((uint32_t)clampi(round_q16(nd->par[r]), 0, 127), (int)(white & 1u));
                lo = at[r] < lo ? at[r] : lo;
                hi = at[r] > hi ? at[r] : hi;
            }
            rows = dm_rows(at, lo, hi - lo + 1, key, (int)(white & 1u));
            if (kv & 0x80u)
                it->s.dm.held[key >> 5] |= 1u << (key & 31u);
            else
                it->s.dm.held[key >> 5] &= ~(1u << (key & 31u));
            for (w = 0; w < 4u; w++)
                for (k = 0; k < 32u; k++)
                    if ((it->s.dm.held[w] >> k & 1u) && 32u * w + k != key)
                        other |= dm_rows(at, lo, hi - lo + 1, 32u * w + k, (int)(white & 1u));
        }
        for (r = 0; r < DRUMMAP_NOUT / 2u; r++) {
            if (rep ? !(rows >> r & 1u) : (uint32_t)clampi(round_q16(nd->par[r]), 0, 127) != key)
                continue;
            if (other >> r & 1u)
                continue;
            if (!(kv & 0x80u)) {
                it->s.dm.fell |= (uint8_t)(it->s.dm.gate & (1u << r));
                it->s.dm.gate &= (uint8_t)~(1u << r);
            } else {
                if ((it->s.dm.gate | it->s.dm.fell) >> r & 1u)
                    it->s.dm.gap |= (uint8_t)(1u << r);
                it->s.dm.gate |= (uint8_t)(1u << r);
                it->s.dm.vel[r] = (int32_t)((vel << 16) / 127u);
            }
        }
    }
}

/* the notes the Steps tracks started and ended in the last block, into the groups they play, in order (engine.ts
 * trackKeys); a group's key range judges them. A part that a track's note let go and one of its notes took again in the
 * same delivery restarts its envelopes (its gate had no low sample); a note over one still sounding is legato as the
 * allocator says */
static void steps_keys(void)
{
    uint16_t freed[1 + ENG_MAX_GROUPS];
    uint32_t e, g, v;
    for (e = 0; e < E.nkev; e++) {
        uint32_t node = E.kev[e][0], key = E.kev[e][1] & 0x7Fu;
        dm_keys(2u + node, E.kev[e][1], E.kev[e][2]);
        if (!e || node != E.kev[e - 1u][0])
            for (g = 0; g <= E.ngrp; g++)
                freed[g] = 0;
        for (g = 0; g < E.narp; g++)             /* the arpeggiators the track plays */
            if (E.node[E.arp[g].node].ksrc == 2u + node) {
                if (E.kev[e][1] & 0x80u)
                    arp_note_on(&E.arp[g], key, (int32_t)(((uint32_t)E.kev[e][2] << 16) / 127u));
                else
                    arp_note_off(&E.arp[g], key);
            }
        for (g = 1; g <= E.ngrp; g++) {
            grp_t *gr = &E.grp[g];
            if (grp_src(g) != node + 1u)
                continue;
            if (!(E.kev[e][1] & 0x80u)) {
                uint32_t was = 0;
                for (v = 0; v < gr->parts; v++)
                    was |= (uint32_t)E.pv[gr->pv0 + v].on << v;
                group_off(gr, key);
                for (v = 0; v < gr->parts; v++)
                    if ((was >> v & 1u) && !E.pv[gr->pv0 + v].on)
                        freed[g] |= (uint16_t)(1u << v);
            } else if (key >= gr->lo && key <= gr->hi) {
                group_on(gr, key, (int32_t)(((uint32_t)E.kev[e][2] << 16) / 127u));
                for (v = 0; v < gr->parts; v++) {
                    pv_t *x = &E.pv[gr->pv0 + v];
                    if (x->on && x->note == key && x->on_stamp == E.stamp && (freed[g] >> v & 1u))
                        x->retrig = 1;
                }
            }
        }
    }
    E.nkev = 0;
}

/* One block (arpeggiator.ts arpBlock): clk edges take precedence, then continuous rate in Hz, then tempo.
 * Inputs are read as the last block left them. Gate length follows the continuous period or last clock interval. */
static void arp_block(arp_t *a, uint32_t n, uint32_t bpm)
{
    static const uint8_t RATE_TICKS[7] = {24, 16, 12, 8, 6, 4, 3};
    const node_t *nd = &E.node[a->node];
    const inst_t *it = &inst_pool[nd->inst0];
    uint32_t rate = RATE_TICKS[clampi((nd->par[ARP_P_RATE] + 32768) >> 16, 0, 6)], i;
    int clk = (nd->conn >> ARP_I_CLK) & 1u, edge = 0, step = 0;
    int continuous = !clk && ((nd->conn >> ARP_I_RATE) & 1u), rate_edge = 0;
    uint32_t period = 0;
    if (!arp_latched(a)) {                       /* latch turned off: the keys let go meanwhile go */
        uint32_t k = 0;
        for (i = 0; i < a->n; i++)
            if (a->held[i].down)
                a->held[k++] = a->held[i];
        a->n = (uint8_t)k;
    }
    if (continuous) {
        int64_t sum = 0;
        int32_t hz;
        for (i = 0; i < n; i++) sum += it->in[ARP_I_RATE][i];
        hz = block_mean(sum, n);
        if (hz <= 0) {
            if (a->cur >= 0) arp_emit_off(a, (uint32_t)a->cur);
            a->cur = -1; a->running = 0; a->rate_phase = 0;
            return;
        }
        hz = clampi(hz, 1311, 80 * ENG_ONE);
        period = (uint32_t)(((uint64_t)ENG_SR << 16) / (uint32_t)hz);
        if (a->running) {
            uint32_t before = a->rate_phase;
            a->rate_phase += hz_turns((uint32_t)hz) * n;
            rate_edge = a->rate_phase < before;
        }
        a->interval = period;
    }
    if (clk) {
        const esig_t *c = it->in[ARP_I_CLK];
        for (i = 0; i < n; i++) {
            uint8_t hi = c[i] > 32768;
            if (hi && !a->clk_hi)
                edge = 1;
            a->clk_hi = hi;
        }
    }
    if (!a->n) {
        if (a->cur >= 0)
            arp_emit_off(a, (uint32_t)a->cur);
        a->cur = -1;
        a->running = 0;
        return;
    }
    if (!a->running) {
        a->running = 1;
        step = 1;
        a->pos = 0;
        a->next = E.ticks + rate;
        a->interval = continuous ? period : (uint32_t)((uint64_t)rate * 60u * ENG_SR / (24u * bpm));
        a->rate_phase = 0;
        a->since = 0;
    } else if (clk ? edge : continuous ? rate_edge : (int32_t)(E.ticks - a->next) >= 0) {
        step = 1;
        if (!clk && !continuous) {
            a->next += rate;
            if ((int32_t)(E.ticks - a->next) >= 0)
                a->next = E.ticks + rate;        /* fell behind (a tempo jump): from now */
        }
        if (!continuous && a->since > 0)
            a->interval = a->since;
        a->since = 0;
    }
    if (step) {
        int32_t vel = 0;
        int note = arp_pick(a, &vel);
        a->pos++;
        if (a->cur >= 0)
            arp_emit_off(a, (uint32_t)a->cur);
        arp_emit_on(a, (uint32_t)note, vel);
        a->cur = (int16_t)note;
    } else if (a->cur >= 0 && a->since >= (uint32_t)(((uint64_t)a->interval * (uint32_t)nd->par[ARP_P_GATE]) >> 16)) {
        arp_emit_off(a, (uint32_t)a->cur);
        a->cur = -1;
    }
    a->since += n;
}

static uint8_t dev_ch;               /* the device's MIDI channel, 0 = every channel (engine.ts Engine.channel) */

void eng_midi_channel(uint32_t ch) { dev_ch = (uint8_t)(ch <= 16u ? ch : 0u); }

/* patch.ts takesKey: in the group's range, on its channel or, with none, on the device's */
static int takes_key(const grp_t *g, uint32_t note, uint32_t ch)
{
    if (note < g->lo || note > g->hi)
        return 0;
    return g->ch ? g->ch == ch : !dev_ch || dev_ch == ch;
}

/* a key into a track's keys in (module index, note | 0x80 with velocity 1..127, or note and 0), taken at the next block */
static void thru_put(uint32_t module, uint32_t kv, uint32_t vel)
{
    uint8_t h = thru_head;
    if ((uint8_t)(h - thru_tail) >= ENG_THRU)
        return;
    thru_ring[h % ENG_THRU][0] = (uint8_t)module;
    thru_ring[h % ENG_THRU][1] = (uint8_t)kv;
    thru_ring[h % ENG_THRU][2] = (uint8_t)vel;
    thru_head = (uint8_t)(h + 1u);
}

/* the keys (engine.ts noteOn / noteOff, arm.ts armView): with modules armed (#191) only the armed listeners take them (a
 * track armed plays them through, cabled from Main or not); otherwise the groups that take them, the shared keyboard,
 * the Arpeggiators, the Drum maps and the tracks a cable from Main's keys feeds */
#define ARMED(m) mset_has(E.armm, (m))
static int hears_grp(uint32_t g) { return !E.armany || (g && (E.armg >> g & 1u)); }
static int hears_trk(uint32_t m) { return E.armany ? ARMED(m) : E.node[m].ksrc != 0u; }
/* module m hears Main's keys now, armed or by its cables (engine.h; the environment's WIRED, #582): a Steps track, an
 * Arpeggiator or a Drum map on the keys, a member of a group the keys play */
int eng_hears_keys(uint32_t m)
{
    const node_t *nd;
    if (!E.loaded || m >= E.nmod)
        return 0;
    nd = &E.node[m];
    switch (nd->type) {
    case T_STEPS: return hears_trk(m);
    case T_ARP: return arp_hears_main(m);
    case T_HARM: return harm_hears_main(m);
    case T_DRUMMAP: return nd->ksrc == 1u && (!E.armany || ARMED(m));
    default: return nd->grp && !E.grp[nd->grp].src && hears_grp(nd->grp);
    }
}
void eng_note_on(uint32_t note, int32_t vel_q16, uint32_t ch)
{
    uint32_t g, v = (uint32_t)clampi((int32_t)(((int64_t)vel_q16 * 127 + 32768) >> 16), 1, 127);
    for (g = 0; g <= E.ngrp; g++)
        if ((E.grp[g].src ? grp_src(g) == 0u : hears_grp(g)) && takes_key(&E.grp[g], note, ch))
            group_on(&E.grp[g], note, vel_q16);
    if (!dev_ch || dev_ch == ch) {
        for (g = 0; g < E.nharm; g++)            /* (the Harmonizers' chords at once, before the arpeggiators: engine.ts noteOn) */
            if (harm_hears_main(E.harm[g].node) && !E.node[E.harm[g].node].bypass)
                harm_key(&E.harm[g], note, vel_q16, 1);
        for (g = 0; g < E.narp; g++)
            if (arp_hears_main(E.arp[g].node))
                arp_note_on(&E.arp[g], note, vel_q16);
        dm_keys(1u, note | 0x80u, v);
        for (g = 0; g < E.nmod; g++)
            if (E.node[g].type == T_STEPS && hears_trk(g))
                thru_put(g, note | 0x80u, v);
    }
}

void eng_note_off(uint32_t note, uint32_t ch)
{
    uint32_t g;
    for (g = 0; g <= E.ngrp; g++)
        if ((E.grp[g].src ? grp_src(g) == 0u : hears_grp(g)) && takes_key(&E.grp[g], note, ch))
            group_off(&E.grp[g], note);
    if (!dev_ch || dev_ch == ch) {
        for (g = 0; g < E.nharm; g++)
            if (harm_hears_main(E.harm[g].node) && !E.node[E.harm[g].node].bypass)
                harm_key(&E.harm[g], note, 0, 0);
        for (g = 0; g < E.narp; g++)
            if (arp_hears_main(E.arp[g].node))
                arp_note_off(&E.arp[g], note);
        dm_keys(1u, note, 0u);
        for (g = 0; g < E.nmod; g++)
            if (E.node[g].type == T_STEPS && hears_trk(g))
                thru_put(g, note, 0u);
    }
}

/* the keys' own listeners let go of every key (engine.ts keysOff): the groups that play the keys, the shared keyboard,
 * the Arpeggiators, the Drum maps on the keys, the tracks Main's keys feed */
static void keys_off(void)
{
    uint32_t g, v;
    for (g = 0; g < E.narp; g++) {
        E.arp[g].n = 0;
        E.arp[g].cur = -1;
        E.arp[g].running = 0;
    }
    for (g = 0; g < E.nharm; g++) {              /* (the Harmonizers' groups, their buttons and latch too) */
        harm_drop(&E.harm[g]);
        harm_clear(&E.harm[g]);
    }
    for (g = 0; g <= E.ngrp; g++) {
        if (E.grp[g].src && grp_src(g) != 0u)
            continue;
        E.grp[g].nheld = 0;
        E.grp[g].down[0] = E.grp[g].down[1] = E.grp[g].down[2] = E.grp[g].down[3] = 0;
        for (v = 0; v < E.grp[g].parts; v++) {
            E.pv[E.grp[g].pv0 + v].on = 0;
            E.pv[E.grp[g].pv0 + v].gate = 0;
            E.pv[E.grp[g].pv0 + v].retrig = 0;
            E.pv[E.grp[g].pv0 + v].key_trig = 0;
        }
    }
    for (g = 0; g < E.nmod; g++)
        if (E.node[g].type == T_DRUMMAP && dm_src(&E.node[g]) == 1u)
            dm_drop(&inst_pool[E.node[g].inst0]);
        else if (E.node[g].type == T_STEPS && (E.node[g].ksrc || ARMED(g))) {
            thru_kill_at[E.node[g].trk] = thru_head;   /* (the place first, then the bit: the interrupt reads them so) */
            E.thru_kill |= (uint16_t)(1u << E.node[g].trk);
        }
}

/* an Arpeggiator was switched (bypassed, or back; engine.ts arpSwitched): what it played lets go, its groups' parts and its
 * Drum maps' rows (the keys held stay with it: switched on it plays them) */
static void arp_switched(uint32_t m)
{
    uint32_t g, v;
    for (g = 0; g < E.narp; g++)
        if (E.arp[g].node == m) {
            E.arp[g].cur = -1;
            E.arp[g].running = 0;
        }
    for (g = 1; g <= E.ngrp; g++) {
        if (E.grp[g].src != m + 1u)
            continue;
        E.grp[g].nheld = 0;
        E.grp[g].down[0] = E.grp[g].down[1] = E.grp[g].down[2] = E.grp[g].down[3] = 0;
        for (v = 0; v < E.grp[g].parts; v++) {
            E.pv[E.grp[g].pv0 + v].on = 0;
            E.pv[E.grp[g].pv0 + v].gate = 0;
            E.pv[E.grp[g].pv0 + v].retrig = 0;
            E.pv[E.grp[g].pv0 + v].key_trig = 0;
        }
    }
    for (g = 0; g < E.nmod; g++)
        if (E.node[g].type == T_DRUMMAP && E.node[g].ksrc == 2u + m)
            dm_drop(&inst_pool[E.node[g].inst0]);
}

/* Arm a set of modules (#191, engine.h). The keys held when the routing changes go quiet. Not saved; another patch disarms. */
void eng_arm_mask(eng_mset_t mask)
{
    uint32_t m;
    if (!E.loaded)
        return;
    for (m = 0; m < ENG_MAX_MODULES; m++)        /* (only the patch's modules) */
        if (m >= E.nmod && mset_has(mask, m))
            mask = mset_flip(mask, m);
    if (mset_eq(mask, E.armm))
        return;
    keys_off();                                  /* (the old set's listeners let go, its tracks' notes played through too) */
    E.armm = mask;
    E.armany = (uint8_t)mset_any(mask);
    E.armg = 0;
    E.arm = 0;
    for (m = 0; m < E.nmod; m++) {
        if (!ARMED(m))
            continue;
        if (E.node[m].grp)
            E.armg |= 1u << E.node[m].grp;
        if (E.node[m].type == T_STEPS && !E.arm)
            E.arm = (uint8_t)(m + 1u);
    }
}
eng_mset_t eng_arm_mask_get(void) { return E.loaded ? E.armm : mset_none(); }

/* the one-track form (#139; engine.ts arm(number); -1 none) */
void eng_arm(int module)
{
    eng_arm_mask(module >= 0 && (uint32_t)module < E.nmod && E.node[module].type == T_STEPS ? mset_one((uint32_t)module) : mset_none());
}

/* a key source n (an Arpeggiator or a Steps track) and the track an Arpeggiator plays, as a mask */
static eng_mset_t key_chain(uint32_t n)
{
    eng_mset_t b;
    if (n >= E.nmod)
        return mset_none();
    b = mset_one(n);
    if (E.node[n].type == T_ARP && E.node[n].ksrc >= 2u && E.node[n].ksrc - 2u < E.nmod)
        b = mset_flip(b, E.node[n].ksrc - 2u);
    return b;
}

eng_mset_t eng_arms(uint32_t m)
{
    const node_t *nd;
    if (!E.loaded || m >= E.nmod)
        return mset_none();
    nd = &E.node[m];
    switch (nd->type) {
    case T_STEPS: return mset_one(m);
    case T_ARP: return key_chain(m);
    case T_HARM: return mset_one(m);
    case T_DRUMMAP: return nd->ksrc == 1u ? mset_one(m) : nd->ksrc >= 2u ? key_chain(nd->ksrc - 2u) : mset_none();
    default: return !nd->grp ? mset_none() : E.grp[nd->grp].src ? key_chain(E.grp[nd->grp].src - 1u) : mset_one(m);
    }
}
int eng_armed(void) { return E.loaded && E.arm ? (int)E.arm - 1 : -1; }   /* (the first armed track: REC records into it) */

/* the Drum map the keys reach (engine.h; the panel's black keys play its rows): of what hears Main's keys now (the armed
 * set, else what is cabled to them) at least one Drum map, on the keys or behind a track (through its Arpeggiator too), and
 * nothing that plays them as notes: a group taking the keys, the shared keyboard with Main's pitch / gate / velocity
 * cabled, an Arpeggiator on Main's keys, a track into no Drum map. The first such map, -1 none */
int eng_keys_drummap(void)
{
    uint32_t m, g;
    int map = -1;
    if (!E.loaded)
        return -1;
    if (!E.armany && E.main >= 0) {
        esig_t *const *o = inst_pool[E.node[E.main].inst0].out;
        if (!IS_DUMMY(o[FM1_O_PITCH]) || !IS_DUMMY(o[FM1_O_GATE]) || !IS_DUMMY(o[FM1_O_VEL]))
            return -1;
    }
    for (g = 1; g <= E.ngrp; g++)
        if (!E.grp[g].src && hears_grp(g))
            return -1;
    for (g = 0; g < E.narp; g++)
        if (arp_hears_main(E.arp[g].node))   /* (one a track feeds hears the track: the track decides, below) */
            return -1;
    for (g = 0; g < E.nharm; g++)            /* (a Harmonizer plays the keys as notes) */
        if (harm_hears_main(E.harm[g].node))
            return -1;
    for (m = 0; m < E.nmod; m++) {
        int d = -1;
        if (E.node[m].type == T_DRUMMAP && E.node[m].ksrc == 1u && (!E.armany || ARMED(m)))
            d = (int)m;
        else if (E.node[m].type == T_STEPS && hears_trk(m) && (d = eng_steps_drummap(m)) < 0)
            return -1;
        if (map < 0)
            map = d;
    }
    return map;
}

/* live recording on a track (#135, #139; engine.ts setRec): while it runs, the notes played through it land on the
 * nearest step and last the whole steps they were held (at least one); eng_steps_take hands them out. Off: the notes still
 * held are recorded when let go. */
void eng_steps_rec(uint32_t module, int on)
{
    if (!E.loaded || module >= E.nmod || E.node[module].type != T_STEPS)
        return;
    if (on)
        E.trk_rec |= (uint16_t)(1u << E.node[module].trk);
    else
        E.trk_rec &= (uint16_t)~(1u << E.node[module].trk);
}
void eng_steps_thru(uint32_t module, uint32_t note, uint32_t vel)
{
    if (!E.loaded || module >= E.nmod || E.node[module].type != T_STEPS || note > 127u)
        return;
    thru_put(module, vel ? note | 0x80u : note, vel ? (vel > 127u ? 127u : vel) : 0u);
}
/* a recorded note (module index, note word: one step at least, chance 100 %), 0 when none is waiting */
int eng_steps_take(uint32_t *module, uint32_t *word)
{
    uint8_t t = took_tail;
    if (t == took_head)
        return 0;
    *module = took_ring[t % ENG_TOOK][0];
    *word = took_ring[t % ENG_TOOK][1];
    took_tail = (uint8_t)(t + 1u);
    return 1;
}

void eng_clock_tick(void)
{
    clk_ticks++;
}

void eng_clock_external(int on) { clk_ext = (uint8_t)(on != 0); }
/* the buttons held / switched on: a Toggle whose state changes bypasses its modules (or brings them back) */
void eng_buttons(uint32_t mask)
{
    uint32_t b, k, was = panel_buttons;
    panel_buttons = (uint16_t)(mask & ((1u << ENG_PANEL_BUTTONS) - 1u));
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        if (E.btn_kind[b] == ENG_BTN_TOGGLE && ((was ^ panel_buttons) >> b & 1u))
            for (k = 0; k < E.btn_n[b]; k++) {
                uint32_t m = E.btn_list[E.btn_first[b] + k];
                if (E.node[m].type != T_FM1 && E.node[m].type != T_OUTPUT) {
                    uint8_t was = E.node[m].bypass;
                    E.node[m].bypass = (uint8_t)(panel_buttons >> b & 1u);
                    if (E.node[m].type == T_ARP && was != E.node[m].bypass)
                        arp_switched(m);
                    if (E.node[m].type == T_HARM && was != E.node[m].bypass)
                        harm_switched(m);
                }
            }
    toggles_sync();
}
uint32_t eng_buttons_get(void) { return panel_buttons; }
uint32_t eng_buttons_lit(void)
{
    const uint32_t b = ENG_PANEL_BUTTONS - 1u;  /* ARP */
    uint32_t k, arps = E.loaded && E.btn_kind[b] == ENG_BTN_TOGGLE && E.btn_n[b];
    for (k = 0; arps && k < E.btn_n[b]; k++)
        arps = E.node[E.btn_list[E.btn_first[b] + k]].type == T_ARP;
    return arps ? panel_buttons ^ (1u << b) : panel_buttons;
}
uint32_t eng_ticks(void) { return E.ticks; }
int32_t eng_run_ticks(void) { return E.running ? (int32_t)(E.ticks - E.run_ticks) : -1; }
int eng_clock_is_external(void) { return clk_ext; }
uint32_t eng_clock_out(uint32_t *off, uint32_t max, int32_t *edge)
{
    uint32_t k, n = cko.n < max ? cko.n : max;
    for (k = 0; k < n; k++)
        off[k] = cko.off[k];
    *edge = cko.edge;
    return n;
}
/* the transport also ends play once where it is (on: it runs on as if PLAY had started it) */
void eng_transport(int on)
{
    transport_on = (uint8_t)(on != 0);
    if (once_st || (once_gen != once_seen && once_cmd == 1u)) {
        once_cmd = 2;
        once_gen++;
    }
    if (!on)                                     /* (a stop ends REC's count-in click, asked for or counting) */
        eng_count_in(0u, 0u);
}
/* REC's count-in click (D-803; engine.ts countIn, the same): `bars` bars of clicks from the transport's start, or, running
 * already at `at` (eng_ticks then), from the next bar line; 0 bars: none (REC off) */
void eng_count_in(uint32_t at, uint32_t bars)
{
    cin_req_at = at;
    cin_req_bars = (uint8_t)bars;
    cin_gen++;
}
int eng_transport_running(void) { return transport_on || (once_run && once_gen == once_seen); }
void eng_play_once(void)
{
    transport_on = 0;
    once_cmd = 1;
    once_gen++;
}
int eng_once_state(void) { return once_gen != once_seen ? (once_cmd == 1u ? 1 : 0) : once_st; }
uint32_t eng_once_beat(void) { return once_gen != once_seen || once_st != 1u ? 0u : once_cin / 24u; }
/* the click's sample k of len, half a period `half` samples (modules.ts clickSample: exact in both engines) */
static int32_t click_sample(int32_t k, int32_t len, int32_t half)
{
    int32_t a = (int32_t)((int64_t)CLICK_LEVEL_Q16 * (len - k) / len);
    return (k / half) & 1 ? -a : a;
}
/* the count-in's click of the last eng_render added to (left, right) of the same length, each side then held to full
 * scale: the analog output's (audio.c, after USB audio took the half without it, D-820); nonzero when any sounded */
int eng_click_mix(int32_t *left, int32_t *right, uint32_t total)
{
    const int32_t len = (int32_t)(ENG_SR * CLICK_MS / 1000u);
    int32_t k = click_k0, half = click_h0;
    uint32_t e = 0, i;
    int any = 0;
    if (k < 0 && !click_nev)
        return 0;
    for (i = 0; i < total; i++) {
        int32_t c;
        if (e < click_nev && click_ev[e].at == i) {
            k = 0;
            half = click_ev[e++].half;
        }
        if (k < 0)
            continue;
        c = click_sample(k, len, half);
        left[i] = clampi(left[i] + c, -ENG_ONE, ENG_ONE);
        right[i] = clampi(right[i] + c, -ENG_ONE, ENG_ONE);
        any = 1;
        if (++k >= len)
            k = -1;
    }
    return any;
}
static void once_end(void)
{
    uint32_t t;
    once_st = 0;
    once_run = 0;
    for (t = 0; t < ENG_MAX_TRACKS; t++)
        E.trk_once[t] = 0;
}

/* ------------------------------------------------------------------ Steps modules (the SEQ page) */
/* A traversal's visit number is independent of its chosen step: swing and note lengths follow time order. */
static int32_t steps_cycle(int32_t len, int32_t dir)
{
    return dir == 2 && len > 1 ? 2 * (len - 1) : len;
}
typedef struct { int32_t visit, pos; uint32_t loop; } step_visit_t;
/* Preview only: recording and playback must choose the same next step, including random mode. */
static step_visit_t steps_next(const inst_t *it, int32_t len, int32_t dir)
{
    step_visit_t next;
    next.visit = it->s.stp.pos < 0 || it->s.stp.visit + 1 >= steps_cycle(len, dir) ? 0 : it->s.stp.visit + 1;
    next.loop = it->s.stp.loop + (next.visit == 0 ? 1u : 0u);
    next.pos = dir == 3 ? (int32_t)(hash32(it->s.stp.seed ^ (next.loop * 0x9e3779b9u) ^ ((uint32_t)(next.visit + 1) * 0x85ebca6bu)) % (uint32_t)len)
        : dir == 1 ? len - 1 - next.visit : dir == 2 && next.visit >= len ? 2 * (len - 1) - next.visit : next.visit;
    return next;
}

static inst_t *steps_inst(uint32_t module)
{
    return E.loaded && module < E.nmod && E.node[module].type == T_STEPS ? &inst_pool[E.node[module].inst0] : 0;
}
int eng_steps_count(void) { return E.loaded ? E.ntrk : 0; }
int eng_steps_module(uint32_t t)
{
    uint32_t i;
    for (i = 0; E.loaded && i < E.nmod; i++)
        if (E.node[i].type == T_STEPS && E.node[i].trk == t)
            return (int)i;
    return -1;
}
/* A track's notes (those of the pattern it plays) as a working copy and back (track.ts fixNotes): sorted by step, then note
 * (stable: of two notes on the same step and key the first stays), at most TRACK_NOTES_MAX, into the pool (the slices after
 * it move) */
static uint32_t trk_copy(uint32_t t, uint32_t *w)
{
    uint32_t i;
    for (i = 0; i < TRK_N(t); i++)
        w[i] = E.trk_note[TRK_FIRST(t) + i];
    return TRK_N(t);
}
/* pattern p of track t becomes these notes (the track gets that pattern if it had none); the slices after it move */
static int trk_put_at(uint32_t t, uint32_t p, uint32_t *w, uint32_t n)
{
    uint32_t i, j, k, old = E.pat_n[t][p], first = E.pat_first[t][p];
    for (i = 1; i < n; i++)                       /* insertion sort by (step, note) */
        for (j = i; j > 0 && ((NW_AT(w[j - 1]) << 7 | NW_NOTE(w[j - 1])) > (NW_AT(w[j]) << 7 | NW_NOTE(w[j]))); j--) {
            uint32_t x = w[j];
            w[j] = w[j - 1];
            w[j - 1] = x;
        }
    for (i = k = 0; i < n; i++)                   /* one note per step and key */
        if (!k || NW_AT(w[i]) != NW_AT(w[k - 1]) || NW_NOTE(w[i]) != NW_NOTE(w[k - 1]))
            w[k++] = w[i];
    n = k < TRACK_NOTES_MAX ? k : TRACK_NOTES_MAX;
    if (p >= ENG_PATTERNS || (uint32_t)E.nnotes - old + n > ENG_MAX_NOTES)
        return 0;
    if (n > old)                                  /* the slices after it move up or down */
        for (i = E.nnotes; i-- > first + old;)
            E.trk_note[i + n - old] = E.trk_note[i];
    else if (n < old)
        for (i = first + old; i < E.nnotes; i++)
            E.trk_note[i - (old - n)] = E.trk_note[i];
    for (i = 0; i < n; i++)
        E.trk_note[first + i] = w[i];
    E.nnotes = (uint16_t)(E.nnotes - old + n);
    E.pat_n[t][p] = (uint8_t)n;
    E.pat_has[t] |= (uint64_t)1u << p;
    pat_layout();
    return 1;
}
/* the notes of the pattern track t plays (an edit on the SEQ page): a pattern it had not got is made, from its pattern 0
 * (trk_copy read that) */
static int trk_put(uint32_t t, uint32_t *w, uint32_t n) { return trk_put_at(t, E.trk_pat[t], w, n); }

/* the step view (track.ts stepView, setStep, setStepValue): the SEQ page edits a track's notes as steps. A step is on
 * when notes start there (its accent, chance, note and velocity are its lowest note's), tied when a note started before
 * goes on through it. get: the step as a byte (bit 0 on, bit 1 accent = full velocity, bits 2..6 the chance code, bit 7
 * tie), -1 if `module` is not a Steps module */
static int steps_first(uint32_t t, uint32_t k)    /* the pool index of the first note on step k, -1 none */
{
    uint32_t i;
    for (i = 0; i < TRK_N(t); i++)
        if (NW_AT(E.trk_note[TRK_FIRST(t) + i]) == k)
            return (int)(TRK_FIRST(t) + i);
    return -1;
}
static int steps_tied(uint32_t t, uint32_t k, uint32_t len)   /* no note starts on k and one goes on through it */
{
    uint32_t i;
    if (steps_first(t, k) >= 0)
        return 0;
    for (i = 0; i < TRK_N(t); i++)
        if (eng_note_through(E.trk_note[TRK_FIRST(t) + i], k, len))
            return 1;
    return 0;
}
int eng_steps_get(uint32_t module, uint32_t k)
{
    uint32_t t, w;
    int f;
    if (!steps_inst(module) || k >= TRACK_STEPS)
        return -1;
    t = E.node[module].trk;
    if ((f = steps_first(t, k)) < 0)
        return steps_tied(t, k, (uint32_t)eng_steps_len(module)) ? 0x80 : 0;
    w = E.trk_note[f];
    return (int)(1u | (NW_VEL(w) == ACCENT_VEL ? 2u : 0u) | (NW_CODE(w) > 19u ? 19u : NW_CODE(w)) << 2);
}
/* step k set as a byte: tie = the notes sounding on the step before (the first step: on the last, across the loop point,
 * #384) go on through it, its own notes give way, a note tied onto its own start is a drone, a drone tied there again
 * one step (nothing sounding: no change; track.ts setStep); else a tied step is untied (the notes through it end before
 * it), on = a note there if it has none
 * (C4, the default velocity), its notes get the chance and the accent (full velocity; the accent taken away: the default
 * velocity); off = its notes go */
void eng_steps_set(uint32_t module, uint32_t k, uint32_t b)
{
    uint32_t w[TRACK_NOTES_MAX + 1u], n, i, m, t, code = (b >> 2) & 31u, mine = 0, len;
    if (!steps_inst(module) || k >= TRACK_STEPS)
        return;
    t = E.node[module].trk;
    n = trk_copy(t, w);
    len = (uint32_t)eng_steps_len(module);
    if (code > 19u)
        code = 19u;
    if (b & 0x80u) {
        uint32_t j = k ? k - 1u : len - 1u, any = 0, drone = 1;
        uint8_t prev[TRACK_NOTES_MAX + 1u];       /* note i sounds on j, the step before, and not through k */
        for (i = 0; i < n; i++)
            if ((prev[i] = (uint8_t)((NW_AT(w[i]) == j || eng_note_through(w[i], j, len)) && !eng_note_through(w[i], k, len)))) {
                any = 1;
                drone &= NW_AT(w[i]) == k && eng_note_drone(w[i]);
            }
        if (!any)
            return;
        for (i = m = 0; i < n; i++) {
            if (!prev[i]) {
                if (NW_AT(w[i]) != k)
                    w[m++] = w[i];
                continue;
            }
            if (NW_AT(w[i]) == k)                /* (tied onto its own start: a drone, or one step again) */
                w[i] = drone ? (w[i] & ~(ENG_NOTE_WRAP | 63u << 6)) : (w[i] | ENG_NOTE_WRAP | 63u << 6);
            else if (k > NW_AT(w[i])) {
                if (NW_AT(w[i]) + NW_LEN(w[i]) < k + 1u)
                    w[i] = (w[i] & ~(63u << 6)) | (k - NW_AT(w[i])) << 6;   /* length k - at + 1 */
            } else
                w[i] = eng_note_end_on(w[i], k, len);
            w[m++] = w[i];
        }
        (void)trk_put(t, w, m);
        return;
    }
    if (steps_tied(t, k, len))
        for (i = 0; i < n; i++)
            if (eng_note_through(w[i], k, len))
                w[i] = eng_note_cut_before(w[i], k, len);
    for (i = m = 0; i < n; i++) {
        if (NW_AT(w[i]) == k) {
            uint32_t vel = NW_VEL(w[i]);
            if (!(b & 1u))
                continue;
            mine = 1;
            vel = (b & 2u) ? ACCENT_VEL : vel == ACCENT_VEL ? STEP_VEL : vel;
            w[i] = (w[i] & ~((127u << 19) | (31u << 26))) | vel << 19 | code << 26;
        }
        w[m++] = w[i];
    }
    if ((b & 1u) && !mine && m < TRACK_NOTES_MAX)
        w[m++] = NW(k, 1u, STEP_NOTE, (b & 2u) ? ACCENT_VEL : STEP_VEL, code);
    (void)trk_put(t, w, m);
}
/* a step's note / velocity: note | vel << 8 of its lowest note (an off step: STEP_NOTE / STEP_VEL), -1 if `module` is not a
 * Steps module */
int eng_steps_value(uint32_t module, uint32_t k)
{
    int f;
    if (!steps_inst(module) || k >= TRACK_STEPS)
        return -1;
    f = steps_first(E.node[module].trk, k);
    return f < 0 ? STEP_NOTE | STEP_VEL << 8 : (int)(NW_NOTE(E.trk_note[f]) | NW_VEL(E.trk_note[f]) << 8);
}
/* step k's notes move together so the lowest is `note` (a chord keeps its shape), all get `vel`; an empty step gets one */
void eng_steps_value_set(uint32_t module, uint32_t k, uint32_t note, uint32_t vel)
{
    uint32_t w[TRACK_NOTES_MAX + 1u], n, i, t;
    int f;
    int32_t d;
    if (!steps_inst(module) || k >= TRACK_STEPS)
        return;
    t = E.node[module].trk;
    note = note > 127u ? 127u : note;
    vel = vel < 1u ? 1u : vel > 127u ? 127u : vel;
    n = trk_copy(t, w);
    if ((f = steps_first(t, k)) < 0) {
        if (n < TRACK_NOTES_MAX)
            w[n++] = NW(k, 1u, note, vel, 0u);
    } else {
        d = (int32_t)note - (int32_t)NW_NOTE(E.trk_note[f]);
        for (i = 0; i < n; i++)
            if (NW_AT(w[i]) == k)
                w[i] = (w[i] & ~((127u << 12) | (127u << 19))) | (uint32_t)clampi((int32_t)NW_NOTE(w[i]) + d, 0, 127) << 12 | vel << 19;
    }
    (void)trk_put(t, w, n);
}
/* a track's notes (track.ts noteWord, sorted): how many, *w where they are; -1 if `module` is not a Steps module */
int eng_steps_notes(uint32_t module, const uint32_t **w)
{
    if (!steps_inst(module))
        return -1;
    *w = &E.trk_note[TRK_FIRST(E.node[module].trk)];
    return TRK_N(E.node[module].trk);
}
/* a track's notes replaced (the editor's TRACK): checked, sorted; 0 when they do not fit the pool */
int eng_steps_set_notes(uint32_t module, const uint32_t *notes, uint32_t n)
{
    uint32_t w[TRACK_NOTES_MAX], i, m = 0;
    if (!steps_inst(module) || n > TRACK_NOTES_MAX)
        return 0;
    for (i = 0; i < n; i++)
        if (NW_VEL(notes[i]))
            w[m++] = notes[i];
    return trk_put(E.node[module].trk, w, m);
}
/* ------------------------------------------------------------------ patterns and songs (format 48) */
void eng_pattern_set(uint32_t p)
{
    uint32_t t;
    if (!E.loaded || p >= ENG_PATTERNS)
        return;
    E.pat_sel = (uint8_t)p;
    for (t = 0; t < E.ntrk; t++)                  /* (m_steps: at the end of the pass, at once while stopped) */
        E.trk_q[t] = (uint8_t)p;
}
int eng_pattern(void) { return E.loaded ? E.pat_sel : -1; }
int eng_pattern_playing(uint32_t module) { return steps_inst(module) ? E.trk_pat[E.node[module].trk] : -1; }
int eng_pattern_queued(uint32_t module)
{
    return steps_inst(module) && E.trk_q[E.node[module].trk] != 0xFFu ? E.trk_q[E.node[module].trk] : -1;
}
int eng_pattern_has(uint32_t module, uint32_t p)
{
    return steps_inst(module) && p < ENG_PATTERNS && (E.pat_has[E.node[module].trk] >> p & 1u);
}
int eng_pattern_len(uint32_t module, uint32_t p) { return eng_pattern_has(module, p) ? E.pat_len[E.node[module].trk][p] : 0; }
int eng_pattern_rate(uint32_t module, uint32_t p)
{
    return eng_pattern_has(module, p) && E.pat_rate[E.node[module].trk][p] != 0xFFu ? E.pat_rate[E.node[module].trk][p] : -1;
}
/* the length of the pattern track t plays: its own, else the track's (modules.ts steps: shape) */
static int32_t steps_len(const inst_t *it, uint32_t t)
{
    uint32_t p = TRK_P(t);
    return p && E.pat_len[t][p] ? E.pat_len[t][p] : clampi(round_q16(it->eff[STEPS_P_LEN]), 1, TRACK_STEPS);
}
int eng_steps_len(uint32_t module)   /* (the SEQ page's: the track's length as set, not as modulated this block) */
{
    uint32_t t, p;
    if (!steps_inst(module))
        return -1;
    t = E.node[module].trk;
    p = TRK_P(t);
    return p && E.pat_len[t][p] ? E.pat_len[t][p] : clampi(round_q16(eng_get_param(module, STEPS_P_LEN)), 1, TRACK_STEPS);
}
int eng_pattern_notes(uint32_t module, uint32_t p, const uint32_t **w)
{
    uint32_t t;
    if (!steps_inst(module) || p >= ENG_PATTERNS)
        return -1;
    t = E.node[module].trk;
    *w = &E.trk_note[E.pat_first[t][p]];
    return E.pat_n[t][p];
}
int eng_pattern_set_notes(uint32_t module, uint32_t p, const uint32_t *notes, uint32_t n)
{
    uint32_t w[TRACK_NOTES_MAX], i, m = 0;
    if (!steps_inst(module) || n > TRACK_NOTES_MAX || p >= ENG_PATTERNS)
        return 0;
    for (i = 0; i < n; i++)
        if (NW_VEL(notes[i]))
            w[m++] = notes[i];
    return trk_put_at(E.node[module].trk, p, w, m);
}
void eng_song_set(uint32_t n)
{
    uint32_t t;
    if (!E.loaded || n > ENG_SONGS)
        return;
    E.song = (uint8_t)n;
    for (t = 0; t < E.ntrk; t++) {                /* from the end of each pass: the first entry, or the patch's pattern */
        E.trk_spos[t] = -1;
        E.trk_q[t] = n ? 0xFFu : E.pat_sel;
    }
}
int eng_song(void) { return E.loaded ? E.song : 0; }
int eng_song_entry(uint32_t module) { return steps_inst(module) && E.song ? E.trk_spos[E.node[module].trk] : -1; }
int eng_song_len(uint32_t s) { return E.loaded && s < ENG_SONGS ? E.song_n[s] : 0; }
int eng_song_get(uint32_t s, uint32_t k)
{
    return E.loaded && s < ENG_SONGS && k < E.song_n[s] ? (int)(E.song_pat[s][k] | (uint32_t)(uint8_t)E.song_shift[s][k] << 8) : -1;
}
int eng_song_put(uint32_t s, uint32_t k, uint32_t pat, int32_t shift)
{
    if (!E.loaded || s >= ENG_SONGS || k > E.song_n[s] || k >= ENG_SONG_LEN || pat >= ENG_PATTERNS)
        return -1;
    E.song_pat[s][k] = (uint8_t)pat;
    E.song_shift[s][k] = (int8_t)clampi(shift, -ENG_SHIFT_MAX, ENG_SHIFT_MAX);
    if (k == E.song_n[s])
        E.song_n[s]++;
    return 0;
}
int eng_song_insert(uint32_t s, uint32_t k)
{
    uint32_t i;
    if (!E.loaded || s >= ENG_SONGS || k >= E.song_n[s] || E.song_n[s] >= ENG_SONG_LEN)
        return -1;
    for (i = E.song_n[s]; i > k; i--) {
        E.song_pat[s][i] = E.song_pat[s][i - 1u];
        E.song_shift[s][i] = E.song_shift[s][i - 1u];
    }
    E.song_n[s]++;
    return 0;
}
int eng_song_delete(uint32_t s, uint32_t k)
{
    uint32_t i;
    if (!E.loaded || s >= ENG_SONGS || k >= E.song_n[s])
        return -1;
    for (i = k; i + 1u < E.song_n[s]; i++) {
        E.song_pat[s][i] = E.song_pat[s][i + 1u];
        E.song_shift[s][i] = E.song_shift[s][i + 1u];
    }
    E.song_n[s]--;
    return 0;
}
/* the patterns and songs section (patchbin.ts patternRecord: byte for byte what the editor writes for the same patterns) */
int eng_patterns_record(uint8_t *out, uint32_t cap)
{
    uint32_t t, k, j, n = 0, ns = 0, nt = 0, np;
#define PUT(b) do { if (out && n < cap) out[n] = (uint8_t)(b); n++; } while (0)
    if (!E.loaded)
        return 0;
    for (k = 0; k < ENG_SONGS; k++)
        if (E.song_n[k])
            ns = k + 1u;
    for (t = 0; t < E.ntrk; t++)
        nt += E.pat_has[t] > 1u;
    if (!nt && !ns && !E.pat_sel && !E.song)
        return 0;
    PUT(E.pat_sel);
    PUT(E.song);
    PUT(nt);
    for (t = 0; t < E.ntrk; t++) {
        if (E.pat_has[t] <= 1u)
            continue;
        for (np = ENG_PATTERNS - 1u; !(E.pat_has[t] >> np & 1u); np--)
            ;
        PUT(eng_steps_module(t));
        PUT(np);
        for (k = 1; k <= np; k++) {
            uint32_t sh = 1, first = E.pat_first[t][k];
            if (!(E.pat_has[t] >> k & 1u)) {
                PUT(0xFFu);
                continue;
            }
            for (j = 0; j < E.pat_n[t][k]; j++) {   /* short words when every note fits one (track.ts isShortNote) */
                uint32_t w = E.trk_note[first + j];
                sh &= !(w & ENG_NOTE_WRAP) && NW_AT(w) < 16u && NW_LEN(w) <= 16u && (NW_VEL(w) == STEP_VEL || NW_VEL(w) == ACCENT_VEL) && !NW_CODE(w);
            }
            PUT(E.pat_n[t][k]);
            PUT(E.pat_len[t][k] | (sh ? 0x80u : 0u));
            PUT(E.pat_rate[t][k]);
            for (j = 0; j < E.pat_n[t][k]; j++) {
                uint32_t w = E.trk_note[first + j];
                if (sh) {
                    w = NW_AT(w) | (NW_LEN(w) - 1u) << 4 | NW_NOTE(w) << 8 | (NW_VEL(w) == ACCENT_VEL ? 0x8000u : 0u);
                    PUT(w);
                    PUT(w >> 8);
                } else {
                    PUT(w);
                    PUT(w >> 8);
                    PUT(w >> 16);
                    PUT(w >> 24);
                }
            }
        }
    }
    PUT(ns);
    for (k = 0; k < ns; k++) {
        PUT(E.song_n[k]);
        for (j = 0; j < E.song_n[k]; j++) {
            PUT(E.song_pat[k][j]);
            PUT((uint8_t)E.song_shift[k][j]);
        }
    }
#undef PUT
    return n <= cap || !out ? (int)n : -1;
}

/* ---- P-locks edited on the FM-1 (#524, #519 Q2; seq_ui.c): a held step's locks on the rows of the track's device */

/* track t's locked row that sets parameter j of module m first (E.lt), ENG_LOCK_TARGETS none */
static uint32_t lock_row(uint32_t t, uint32_t m, uint32_t j)
{
    uint32_t r;
    for (r = 0; r < E.nlt; r++)
        if (E.lt[r].trk == t && E.lt[r].mod[0] == m && E.lt[r].par[0] == j)
            return r;
    return ENG_LOCK_TARGETS;
}
/* track t's lock on step k of pattern p on row r (E.lk), E.nlk none */
static uint32_t lock_at(uint32_t t, uint32_t p, uint32_t k, uint32_t r)
{
    uint32_t i;
    for (i = 0; i < E.nlk; i++)
        if (E.lk[i].trk == t && E.lk[i].pat == p && E.lk[i].at == k && E.lk[i].row == r)
            return i;
    return E.nlk;
}
/* a lock on module m's parameter j may be set: a plain parameter of a module of the patch (not a Part's settings) */
static int lock_ok(uint32_t m, uint32_t j) { return m < E.nmod && E.node[m].type != T_PART && j < DEFS[E.node[m].type].npar; }

int eng_lock_get(uint32_t module, uint32_t p, uint32_t k, uint32_t m, uint32_t j, int32_t *v)
{
    uint32_t t, r, i;
    if (!steps_inst(module) || !lock_ok(m, j))
        return 0;
    t = E.node[module].trk;
    if ((r = lock_row(t, m, j)) == ENG_LOCK_TARGETS || (i = lock_at(t, p, k, r)) == E.nlk)
        return 0;
    if (v)
        *v = E.lk[i].v;
    return 1;
}
int eng_locks_step(uint32_t module, uint32_t p, uint32_t k)
{
    uint32_t t, i, n = 0;
    if (!steps_inst(module))
        return 0;
    t = E.node[module].trk;
    for (i = 0; i < E.nlk; i++)
        n += E.lk[i].trk == t && E.lk[i].pat == p && E.lk[i].at == k;
    return (int)n;
}
int eng_lock_set(uint32_t module, uint32_t p, uint32_t k, uint32_t m, uint32_t j, const uint8_t *also, int32_t v, int on)
{
    uint32_t t, r, i, n = 0;
    if (!steps_inst(module) || !lock_ok(m, j) || p >= ENG_PATTERNS || k >= TRACK_STEPS)
        return -1;
    t = E.node[module].trk;
    r = lock_row(t, m, j);
    i = r == ENG_LOCK_TARGETS ? E.nlk : lock_at(t, p, k, r);
    E.trk_lkey[t] = -2;                          /* (applied again after the track's next block) */
    if (!on) {
        if (i == E.nlk)
            return 0;
        for (; i + 1u < E.nlk; i++)
            E.lk[i] = E.lk[i + 1u];
        E.nlk--;
        for (i = 0; i < E.nlk && E.lk[i].row != r; i++)
            ;
        if (i == E.nlk) {                        /* no lock on the row is left: it goes, the rows after it move down */
            for (i = r; i + 1u < E.nlt; i++)
                E.lt[i] = E.lt[i + 1u];
            E.nlt--;
            for (i = 0; i < E.nlk; i++)
                if (E.lk[i].row > r)
                    E.lk[i].row--;
        }
        return 0;
    }
    if (i < E.nlk) {
        E.lk[i].v = v;
        return 0;
    }
    for (i = 0; i < E.nlk; i++)
        n += E.lk[i].trk == t && E.lk[i].pat == p;
    if (n >= ENG_PAT_LOCKS || E.nlk >= ENG_MAX_LOCKS || (r == ENG_LOCK_TARGETS && E.nlt >= ENG_LOCK_TARGETS))
        return -1;
    if (r == ENG_LOCK_TARGETS) {                 /* a new row: its parameter, then the further ones its page row sets */
        lrow_t *x = &E.lt[r = E.nlt++];
        x->trk = (uint8_t)t;
        x->n = 1;
        x->on = 0;
        x->v = 0;
        x->mod[0] = (uint8_t)m;
        x->par[0] = (uint8_t)j;
        E.node[m].locked = 1;
        for (i = 0; also && i < also[0] && x->n < ENG_LOCK_PAIRS; i++) {
            uint32_t am = also[1u + 2u * i], aj = also[2u + 2u * i], q;
            if (!lock_ok(am, aj))
                continue;
            for (q = 0; q < x->n && !(x->mod[q] == am && x->par[q] == aj); q++)
                ;
            if (q < x->n)
                continue;
            x->mod[x->n] = (uint8_t)am;
            x->par[x->n++] = (uint8_t)aj;
            E.node[am].locked = 1;
        }
    }
    E.lk[E.nlk].trk = (uint8_t)t;
    E.lk[E.nlk].pat = (uint8_t)p;
    E.lk[E.nlk].at = (uint8_t)k;
    E.lk[E.nlk].row = (uint8_t)r;
    E.lk[E.nlk].v = v;
    E.nlk++;
    return 0;
}
int eng_locks_pattern(uint32_t module)
{
    uint32_t t, p, i, n;
    const uint32_t *w;
    if (!steps_inst(module))
        return -1;
    t = E.node[module].trk;
    p = E.trk_pat[t];
    if (E.pat_has[t] >> p & 1u)
        return (int)p;
    n = (uint32_t)eng_pattern_notes(module, 0, &w);   /* the pattern made from pattern 1: its notes, then its locks */
    {
        uint32_t copy[TRACK_NOTES_MAX];
        for (i = 0; i < n; i++)
            copy[i] = w[i];
        if (!trk_put_at(t, p, copy, n))
            return -1;
    }
    n = E.nlk;
    for (i = 0; i < n && E.nlk < ENG_MAX_LOCKS; i++)
        if (E.lk[i].trk == t && E.lk[i].pat == 0u) {
            E.lk[E.nlk] = E.lk[i];
            E.lk[E.nlk++].pat = (uint8_t)p;
        }
    E.trk_lkey[t] = -2;
    return (int)p;
}
int eng_locks_list(uint32_t module, uint32_t p, uint8_t *out, uint32_t cap)
{
    uint32_t t, i, n = 0;
    if (!steps_inst(module))
        return -1;
    t = E.node[module].trk;
    for (i = 0; i < E.nlk; i++) {
        const lock_t *l = &E.lk[i];
        if (l->trk != t || l->pat != p)
            continue;
        if (out && 7u * (n + 1u) <= cap) {
            uint8_t *o = out + 7u * n;
            o[0] = l->at;
            o[1] = E.lt[l->row].mod[0];
            o[2] = E.lt[l->row].par[0];
            o[3] = (uint8_t)l->v;
            o[4] = (uint8_t)((uint32_t)l->v >> 8);
            o[5] = (uint8_t)((uint32_t)l->v >> 16);
            o[6] = (uint8_t)((uint32_t)l->v >> 24);
        }
        n++;
    }
    return (int)n;
}
int eng_locks_record(uint8_t *out, uint32_t cap)
{
    uint32_t t, r, i, k, p, n = 0, nt = 0, at, nr, np;
    uint8_t idx[ENG_LOCK_TARGETS];
#define PUT(b) do { if (out && n < cap) out[n] = (uint8_t)(b); n++; } while (0)
    if (!E.loaded || !E.nlk)
        return 0;
    for (t = 0; t < E.ntrk; t++) {
        for (i = 0; i < E.nlk && E.lk[i].trk != t; i++)
            ;
        nt += i < E.nlk;
    }
    PUT(nt);
    for (t = 0; t < E.ntrk; t++) {
        for (i = 0; i < E.nlk && E.lk[i].trk != t; i++)
            ;
        if (i == E.nlk)
            continue;
        PUT(eng_steps_module(t));
        at = n;
        PUT(0);                                  /* (the row count, below) */
        for (r = nr = 0; r < E.nlt; r++) {       /* the track's rows that hold a lock, in order */
            idx[r] = 0xFFu;
            if (E.lt[r].trk != t)
                continue;
            for (i = 0; i < E.nlk && E.lk[i].row != r; i++)
                ;
            if (i == E.nlk)
                continue;
            idx[r] = (uint8_t)nr++;
            PUT(E.lt[r].n);
            for (k = 0; k < E.lt[r].n; k++) {
                PUT(E.lt[r].mod[k]);
                PUT(E.lt[r].par[k]);
            }
        }
        if (out && at < cap)
            out[at] = (uint8_t)nr;
        for (p = np = 0; p < ENG_PATTERNS; p++) {
            for (i = 0; i < E.nlk && !(E.lk[i].trk == t && E.lk[i].pat == p); i++)
                ;
            np += i < E.nlk;
        }
        PUT(np);
        for (p = 0; p < ENG_PATTERNS; p++) {
            uint32_t c = 0;
            for (i = 0; i < E.nlk; i++)
                c += E.lk[i].trk == t && E.lk[i].pat == p;
            if (!c)
                continue;
            PUT(p);
            PUT(c);
            for (i = 0; i < E.nlk; i++) {
                const lock_t *l = &E.lk[i];
                if (l->trk != t || l->pat != p)
                    continue;
                PUT(l->at);
                PUT(idx[l->row]);
                PUT(l->v);
                PUT((uint32_t)l->v >> 8);
                PUT((uint32_t)l->v >> 16);
                PUT((uint32_t)l->v >> 24);
            }
        }
    }
#undef PUT
    return n <= cap || !out ? (int)n : -1;
}

int eng_steps_pos(uint32_t module)
{
    inst_t *it = steps_inst(module);
    return it && (E.running || ((E.node[module].conn >> STEPS_I_CLK) & 1u)) ? it->s.stp.pos : -1;
}
void eng_steps_mute(uint32_t module, int on)
{
    inst_t *it = steps_inst(module);
    if (it)
        it->s.stp.mute = (uint8_t)(on != 0);
}
int eng_steps_muted(uint32_t module)
{
    inst_t *it = steps_inst(module);
    return it ? it->s.stp.mute : 0;
}
/* A hit from the panel (live recording, REC on): the track's last note sounds at once. While the track plays it also goes into the pattern
 * at the nearest step: the one playing, or the next when more than half of this one has passed (that step is then not
 * played again when it comes up, it has just sounded). Returns the step it went into, -1 when only heard. */
int eng_steps_hit(uint32_t module, int accent, int record)
{
    inst_t *it = steps_inst(module);
    int32_t k, len;
    if (!it)
        return -1;
    it->s.stp.hit = accent ? 2u : 1u;
    if (!record || eng_steps_pos(module) < 0)
        return -1;
    len = steps_len(it, E.node[module].trk);
    k = it->s.stp.pos < 0 ? 0 : it->s.stp.pos;
    if (it->s.stp.pos >= 0 && it->s.stp.slen > 0 && 2 * it->s.stp.sst >= it->s.stp.slen) {
        k = steps_next(it, len, clampi(round_q16(it->eff[STEPS_P_DIR]), 0, 3)).pos;
        it->s.stp.skip = (int8_t)k;
        it->s.stp.skipn = 0;                     /* (the whole step) */
    }
    {                                            /* into the step: on (C4 if it had no note), accented when ENV is held */
        int b = eng_steps_get(module, (uint32_t)k);
        if (!(b & 0x80))
            eng_steps_set(module, (uint32_t)k, (uint32_t)b | (accent ? 3u : 1u));
    }
    return k;
}

/* where the Drum maps' row names section of a patch binary starts (flag bit 7), 0 none or malformed */
static uint32_t names_at(const uint8_t *p, uint32_t len)
{
    uint32_t at;
    if (len < 8u || p[1] < 33u || !(p[6] & 128u) || !(at = eng_cables_end(p, len)))
        return 0;
    if (p[6] & 4u)
        at += p[2];
    if ((p[6] & 8u) && !(at = eng_routes_end(p, len, at)))
        return 0;
    if (!(at = eng_steps_end(p, len, at)))
        return 0;
    if ((p[6] & 32u) && !(at = eng_devices_end(p, len, at)))
        return 0;
    if ((p[7] & ENG_FLAG_EXTRAS) && !(at = eng_extras_end(p, len, at)))
        return 0;
    if ((p[6] & 64u) && !(at = eng_buttons_end(p, len, at)))
        return 0;
    return eng_names_end(p, len, at) ? at : 0;
}
int eng_drum_name(const uint8_t *p, uint32_t len, uint32_t module, uint32_t r, char *out)
{
    uint32_t at = names_at(p, len), n, i, c;
    out[0] = 0;
    if (!at || r >= ENG_DRUM_ROWS)
        return 0;
    n = p[at++];
    for (i = 0; i < n; i++, at += 1u + ENG_DRUM_ROWS * ENG_DRUM_NAME)
        if (p[at] == module) {
            const uint8_t *s = p + at + 1u + r * ENG_DRUM_NAME;
            for (c = 0; c < ENG_DRUM_NAME && s[c]; c++)
                out[c] = (char)s[c];
            out[c] = 0;
            return c > 0;
        }
    return 0;
}
int eng_steps_drummap(uint32_t module)
{
    uint32_t i;
    if (!steps_inst(module))
        return -1;
    for (i = 0; i < E.nmod; i++)
        if (E.node[i].type == T_DRUMMAP && (E.node[i].ksrc == 2u + module || (E.node[i].ksrc >= 2u && E.node[E.node[i].ksrc - 2u].type == T_ARP && E.node[E.node[i].ksrc - 2u].ksrc == 2u + module)))
            return (int)i;                       /* (directly, or through the Arpeggiator the track plays) */
    return -1;
}
int eng_drummap_note(uint32_t map, uint32_t r)
{
    if (!E.loaded || map >= E.nmod || E.node[map].type != T_DRUMMAP || r >= ENG_DRUM_ROWS)
        return -1;
    return clampi(round_q16(E.node[map].par[r]), 0, 127);
}
int eng_drummap_repeat(uint32_t map)
{
    return E.loaded && map < E.nmod && E.node[map].type == T_DRUMMAP && round_q16(E.node[map].par[DRUMMAP_P_REPEAT]) >= 1;
}
uint32_t eng_steps_note(uint32_t module, uint32_t k, uint32_t note)
{
    uint32_t i, t;
    if (!steps_inst(module))
        return 0;
    t = E.node[module].trk;
    for (i = 0; i < TRK_N(t); i++) {
        uint32_t w = E.trk_note[TRK_FIRST(t) + i];
        if (NW_AT(w) == k && NW_NOTE(w) == note)
            return w;
    }
    return 0;
}
void eng_steps_toggle(uint32_t module, uint32_t k, uint32_t note, uint32_t vel)
{
    uint32_t w[TRACK_NOTES_MAX + 1u], n, i, m, t;
    if (!steps_inst(module) || k >= TRACK_STEPS || note > 127u)
        return;
    if (!eng_steps_note(module, k, note)) {
        eng_steps_overdub(module, NW(k, 1u, note, vel < 1u ? 1u : vel > 127u ? 127u : vel, 0u));
        return;
    }
    t = E.node[module].trk;
    n = trk_copy(t, w);
    for (i = m = 0; i < n; i++)
        if (NW_AT(w[i]) != k || NW_NOTE(w[i]) != note)
            w[m++] = w[i];
    (void)trk_put(t, w, m);
}
int eng_steps_hit_note(uint32_t module, uint32_t note, int accent, int record)
{
    inst_t *it = steps_inst(module);
    int32_t k, len;
    if (!it || note > 127u)
        return -1;
    E.trk_last[E.node[module].trk] = (uint8_t)note;  /* (the hit plays the track's last note: this one) */
    it->s.stp.hit = accent ? 2u : 1u;
    if (!record || eng_steps_pos(module) < 0)
        return -1;
    len = steps_len(it, E.node[module].trk);
    k = it->s.stp.pos < 0 ? 0 : it->s.stp.pos;
    if (it->s.stp.pos >= 0 && it->s.stp.slen > 0 && 2 * it->s.stp.sst >= it->s.stp.slen) {
        k = steps_next(it, len, clampi(round_q16(it->eff[STEPS_P_DIR]), 0, 3)).pos;
        it->s.stp.skip = (int8_t)k;
        it->s.stp.skipn = (uint8_t)(note + 1u);
    }
    eng_steps_overdub(module, NW((uint32_t)k, 1u, note, accent ? ACCENT_VEL : STEP_VEL, 0u));
    return k;
}

/* cursor entry (#139; track.ts setChord): step k's notes replaced by `n` notes one step long at `vel` (its chance kept, a tie
 * through it cut) */
void eng_steps_chord(uint32_t module, uint32_t k, const uint8_t *notes, uint32_t n, uint32_t vel)
{
    uint32_t w[TRACK_NOTES_MAX + 1u], m, i, t;
    int b;
    if (!steps_inst(module) || k >= TRACK_STEPS)
        return;
    b = eng_steps_get(module, k);
    eng_steps_set(module, k, 0u);
    t = E.node[module].trk;
    m = trk_copy(t, w);
    vel = vel < 1u ? 1u : vel > 127u ? 127u : vel;
    for (i = 0; i < n && m < TRACK_NOTES_MAX; i++)
        w[m++] = NW(k, 1u, notes[i] & 127u, vel, (b & 1) ? ((uint32_t)b >> 2) & 31u : 0u);
    (void)trk_put(t, w, m);
}
/* a live-recorded note laid over the track (#135 overdub): it replaces a note on the same step and key */
void eng_steps_overdub(uint32_t module, uint32_t word)
{
    uint32_t w[TRACK_NOTES_MAX + 1u], n, i, m, t;
    if (!steps_inst(module) || !NW_VEL(word))
        return;
    t = E.node[module].trk;
    n = trk_copy(t, w + 1);
    w[0] = word;                                  /* (a full track keeps its first notes by step: trk_put) */
    for (i = 0, m = 1; i < n; i++)
        if (NW_AT(w[1u + i]) != NW_AT(word) || NW_NOTE(w[1u + i]) != NW_NOTE(word))
            w[m++] = w[1u + i];
    (void)trk_put(t, w, m);
}

/* Overload (audio.c): one part fewer in the poly group that has the most (the part with the highest number:
 * its key is let go, its instances are no longer rendered and their outputs fall silent). 0 when no group has more than
 * one part left. The count comes back with the next eng_load. Called by the audio ISR before it renders. */
int eng_shed(void)
{
    uint32_t k, best = 0, o;
    grp_t *g;
    pv_t *x;
    if (!E.loaded)
        return 0;
    for (k = 1; k <= E.ngrp; k++)
        if (E.grp[k].parts > 1u && (!best || E.grp[k].parts > E.grp[best].parts))
            best = k;
    if (!best)
        return 0;
    g = &E.grp[best];
    g->parts--;
    x = &E.pv[g->pv0 + g->parts];
    x->on = 0;
    x->gate = 0;
    if (g->rot >= g->parts)
        g->rot = 0;
    for (k = 0; k < E.nmod; k++) {              /* its copies' outputs: silence (cables out of the group sum them) */
        const node_t *nd = &E.node[k];
        if (nd->grp == best && g->parts < nd->ninst)
            for (o = 0; o < MAX_OUT; o++) {
                esig_t *b = inst_pool[nd->inst0 + g->parts].out[o];
                uint32_t i;
                if (b)
                    for (i = 0; i < ENG_BLOCK; i++)
                        b[i] = 0;
            }
    }
    return 1;
}

void eng_all_notes_off(void)
{
    uint32_t i;
    for (i = 0; i < E.narp; i++) {
        E.arp[i].n = 0;
        E.arp[i].cur = -1;
        E.arp[i].running = 0;
    }
    for (i = 0; i < E.nharm; i++)
        harm_clear(&E.harm[i]);
    for (i = 0; i <= E.ngrp; i++) {
        E.grp[i].nheld = 0;
        E.grp[i].down[0] = E.grp[i].down[1] = E.grp[i].down[2] = E.grp[i].down[3] = 0;
    }
    for (i = 0; i < ENG_NPV; i++) {
        E.pv[i].on = 0;
        E.pv[i].gate = 0;
        E.pv[i].retrig = 0;
        E.pv[i].key_trig = 0;
    }
    for (i = 0; i < E.nmod; i++)
        if (E.node[i].type == T_DRUMMAP)
            dm_drop(&inst_pool[E.node[i].inst0]);
    for (i = 0; i < ENG_MAX_TRACKS; i++)
        thru_kill_at[i] = thru_head;
    E.thru_kill = 0xFFFFu;                       /* the keys played through the tracks end too */
}

/* ------------------------------------------------------------------ modules */

#define EF(it, name) ((it)->eff[name])

/* a constant block into an output; nothing for an unconnected one (they all share dummy_out, which nobody reads) */
static void fill(esig_t *o, int32_t v, uint32_t n)
{
    uint32_t i = 0;
    if (IS_DUMMY(o))
        return;
    for (; i + 4u <= n; i += 4u) {
        o[i] = v;
        o[i + 1u] = v;
        o[i + 2u] = v;
        o[i + 3u] = v;
    }
    for (; i < n; i++)
        o[i] = v;
}

/* the Main module: the shared keyboard's note (pitch with the bend, gate, velocity), the knobs, the clock and the controls */
static void m_fm1(const node_t *nd, inst_t *it, uint32_t n)
{
    const pv_t *x = IT_PV(nd, it);
    fill(it->out[FM1_O_PITCH], x->pitch + mulq(E.ctl[ENG_CTL_BEND], 10923, 16), n);   /* + bend x 2 semitones */
    fill(it->out[FM1_O_BEND], E.ctl[ENG_CTL_BEND], n);
    fill(it->out[FM1_O_MOD], E.ctl[ENG_CTL_MOD], n);
    fill(it->out[FM1_O_AT], E.ctl[ENG_CTL_AT], n);
    fill(it->out[FM1_O_BREATH], E.ctl[ENG_CTL_BREATH], n);
    fill(it->out[FM1_O_SUSTAIN], E.ctl[ENG_CTL_SUSTAIN], n);
    fill(it->out[FM1_O_FOOT], E.ctl[ENG_CTL_FOOT], n);
    fill(it->out[FM1_O_KEYS], x->gate, n);   /* the keys for Voice allocators (modules.ts): never patched in the binary, 1 while a key is down */
    fill(it->out[FM1_O_GATE], x->gate, n);
    fill(it->out[FM1_O_VEL], x->vel, n);
    if (x->retrig)
        it->out[FM1_O_GATE][0] = 0;              /* one low sample: the envelopes of a taken-over part see a new gate */
    {
        esig_t *ck = it->out[FM1_O_CLOCK];
        uint32_t i, p = E.clk_pulse < n ? E.clk_pulse : n;
        if (!IS_DUMMY(ck)) {
            for (i = 0; i < p; i++)
                ck[i] = ENG_ONE;
            for (; i < n; i++)
                ck[i] = 0;
        }
    }
    fill(it->out[FM1_O_RUN], E.running ? ENG_ONE : 0, n);
    {
        uint32_t b, mask = panel_buttons;
        for (b = 0; b < ENG_PANEL_BUTTONS; b++)
            fill(it->out[FM1_O_FX + b], (mask >> b & 1u) ? ENG_ONE : 0, n);
    }
}

/* the Arpeggiator: its notes are run by arp_block; the keys output shows the shared keyboard's gate (modules.ts arp) */
static void m_arp(const node_t *nd, inst_t *it, uint32_t n)
{
    fill(it->out[ARP_O_KEYS], IT_PV(nd, it)->gate, n);
}

/* the Part module (modules.ts part): its part's note (with its detune / drift flaw), the part's place among the parts (index -1 .. 1, 0 with one part),
 * legato (the note began over a held one) and jump (the pitch step in octaves) */
static void m_part(const node_t *nd, inst_t *it, uint32_t n)
{
    const pv_t *x = IT_PV(nd, it);
    const grp_t *g = IT_G(nd);
    int32_t np = g->parts;
    fill(it->out[PART_O_PITCH], x->pitch + mulq(E.ctl[ENG_CTL_BEND], 10923, 16) + x->flaw, n);
    fill(it->out[PART_O_GATE], x->gate, n);
    if (x->retrig)
        it->out[PART_O_GATE][0] = 0;
    fill(it->out[PART_O_VEL], x->vel, n);
    fill(it->out[PART_O_INDEX], np > 1 ? (2 * (int32_t)IT_V(nd, it) - (np - 1)) * 65536 / (np - 1) : 0, n);   /* |.| < 2^24: 32 bits */
    fill(it->out[PART_O_LEGATO], x->legato ? ENG_ONE : 0, n);
    fill(it->out[PART_O_JUMP], x->jump, n);
    if (!IS_DUMMY(it->out[PART_O_UNISON])) fill(it->out[PART_O_UNISON], g->unison ? ENG_ONE : 0, n);
    if (!IS_DUMMY(it->out[PART_O_TRIG])) {
        fill(it->out[PART_O_TRIG], 0, n);
        if (x->key_trig) it->out[PART_O_TRIG][0] = ENG_ONE;
    }
    if (!IS_DUMMY(it->out[PART_O_LOW]) || !IS_DUMMY(it->out[PART_O_HIGH])) {
        uint32_t i;
        int low = x->on, high = x->on;
        for (i = 0; i < g->parts && (low || high); i++) {
            const pv_t *other = &E.pv[g->pv0 + i];
            if (!other->on) continue;
            if (other->note < x->note) low = 0;
            if (other->note > x->note) high = 0;
        }
        if (!IS_DUMMY(it->out[PART_O_LOW])) fill(it->out[PART_O_LOW], low ? ENG_ONE : 0, n);
        if (!IS_DUMMY(it->out[PART_O_HIGH])) fill(it->out[PART_O_HIGH], high ? ENG_ONE : 0, n);
    }
}

/* Random: fixed or a walk on out, an independent draw on each rising clock edge on held. Q15 -> Q16. */
static void m_random(const node_t *nd, inst_t *it, uint32_t n)
{
    int32_t q;
    uint32_t i;
    walk_step(&it->s.rnd.w, walk_hold(EF(it, RANDOM_P_RATE)));   /* every block, so the wander does not depend on the mode */
    q = round_q16(EF(it, RANDOM_P_MODE)) ? it->s.rnd.w.y : q15(hash32(it->s.rnd.seed));
    fill(it->out[RANDOM_O_OUT], 2 * q, n);
    if (IS_DUMMY(it->out[RANDOM_O_HELD]))
        return;
    for (i = 0; i < n; i++) {
        int32_t clock = it->in[RANDOM_I_CLOCK][i];
        if (clock >= 32768 && it->s.rnd.clock < 32768) {
            it->s.rnd.held_seed = lcg(it->s.rnd.held_seed);
            it->s.rnd.held = 2 * q15(it->s.rnd.held_seed);
        }
        it->s.rnd.clock = clock;
        it->out[RANDOM_O_HELD][i] = it->s.rnd.held;
    }
}

/* The FM oscillator (pm connected with pm > 0, or feedback) runs at twice the rate: two waves per frame, the pm input
 * interpolated between frames, then a polyphase half-band decimator of four first-order allpass sections (two per path),
 * flat to 19.4 kHz, 41 dB down above 24.7 kHz (what would fold onto the passband). The same Q16 coefficients as modules.ts.
 * Feedback: fb = 1 moves the phase by pi per unit of the two-sample average of the raw wave (the DX7's level 7). */
static const int32_t HB_A[4] = {5376, 17567, 35764, 55599};

static inline int32_t allpass16(int32_t *s, int32_t a, int32_t x)      /* y = a (x - y1) + x1; s[0] = x1, s[1] = y1 */
{
    int32_t y = mulr(a, x - s[1], 16) + s[0];
    s[0] = x;
    s[1] = y;
    return y;
}

/* the stack choices (modules.ts STACKS): the intervals the copies cycle through, octaves Q16 */
static const int32_t STACK_OCT[5][3] = {{0}, {0, 65536}, {0, 38229}, {0, 65536, 103765}, {0, -65536}};
static const uint8_t STACK_N[5] = {1, 2, 2, 3, 2};

/* the oscillator's summed phase modulation (osc_pm), radians Q16, one block */
static esig_t osc_pmc[2][ENG_BLOCK];    /* (one per lane, #271) */
/* The oscillator's phase modulation as one signal and its index (#518, modules.ts oscPm): with only pm patched (or
 * nothing), that input and the pm index, as before; with pm2, pm3 or index patched, pm x in + pm2 x in2 + pm3 x in3 in
 * radians (osc_pmc), times the index input when it is patched, and index 1. *idx 0: no phase modulation. */
HOT const esig_t *osc_pm(const node_t *nd, inst_t *it, uint32_t n, int32_t *idx)
{
    esig_t *pm_c = osc_pmc[IT_LANE(nd, it)];
    const esig_t *pm = it->in[OSC_I_PM], *pm2 = it->in[OSC_I_PM2], *pm3 = it->in[OSC_I_PM3], *ix = it->in[OSC_I_INDEX];
    int32_t i1 = nd->conn & (1u << OSC_I_PM) ? EF(it, OSC_P_PM) : 0, i2, i3;
    uint32_t i;
    *idx = i1;
    if (!(nd->conn & ((1u << OSC_I_PM2) | (1u << OSC_I_PM3) | (1u << OSC_I_INDEX))))
        return pm;
    i2 = nd->conn & (1u << OSC_I_PM2) ? EF(it, OSC_P_PM2) : 0;
    i3 = nd->conn & (1u << OSC_I_PM3) ? EF(it, OSC_P_PM3) : 0;
    if (i1 <= 0 && i2 <= 0 && i3 <= 0) {
        *idx = 0;
        return pm;
    }
    for (i = 0; i < n; i++)
        pm_c[i] = mul16(i1, pm[i]) + mul16(i2, pm2[i]) + mul16(i3, pm3[i]);
    if (nd->conn & (1u << OSC_I_INDEX))
        for (i = 0; i < n; i++)
            pm_c[i] = mul16(pm_c[i], ix[i]);
    *idx = ENG_ONE;
    return pm_c;
}

/* The plain oscillator with the analog shape (#673): any copy count, the sync input, a loop per wave. */
static __attribute__((noinline)) void osc_ana(const node_t *nd, inst_t *it, uint32_t n, int32_t kind, int32_t base, int32_t lvl,
                                              int32_t nu, const int32_t *doct, const int32_t *wq, const ana_t *a)
{
    const esig_t *pitch = it->in[OSC_I_PITCH], *sync = it->in[OSC_I_SYNC];
    esig_t *out = it->out[OSC_O_OUT];
    uint32_t ph[5], dts[5], (*rc)[2] = it->s.osc.rc, i;
    inc_ramp_t rp[5];
    int32_t s1 = it->s.osc.s1, j, synced = (nd->conn & (1u << OSC_I_SYNC)) != 0;
    ph[0] = it->s.osc.phase;
    for (j = 1; j < nu; j++)
        ph[j] = it->s.osc.ph[j - 1];
    const ana_t A = *a;
#define ANA_SAW(p, d, r) ana_saw(p, d, A, r)
#define ANA_TRI(p, d, r) ((void)(r), ana_tri(p, A))
#define ANA_SHARK(p, d, r) ((ana_tri(p, A) + ana_saw(p, d, A, r)) >> 1)
#define ANA_REV(p, d, r) (-ana_saw(p, d, A, r))
#define ANA_SQR(p, d, r) wave_square(p, d, A.pw, r)
#define ANA_SYNC                                                                        \
            if (synced) {                       /* a rising edge on sync restarts the phases */ \
                int rst = sync[i] >= 32768 && s1 < 32768;                               \
                s1 = sync[i];                                                           \
                if (rst)                                                                \
                    for (j = 0; j < nu; j++)                                            \
                        ph[j] = 0;                                                      \
            }
#define ANA_ONE(W)                                                                      \
        {                                                                               \
            uint32_t p0 = ph[0], *r0 = rc[0];                                           \
            inc_ramp_t r1;                                                              \
            if (synced) {                                                               \
                INC_LOOP(r1, base + doct[0]) {                                          \
                    int rst = sync[i] >= 32768 && s1 < 32768;                           \
                    s1 = sync[i];                                                       \
                    if (rst)                                                            \
                        p0 = 0;                                                         \
                    p0 += dt_;                                                          \
                    out[i] = mul16(W(p0, dt_, r0), lvl);                                \
                }                                                                       \
            } else {                                                                    \
                INC_LOOP(r1, base + doct[0]) {                                          \
                    p0 += dt_;                                                          \
                    out[i] = mul16(W(p0, dt_, r0), lvl);                                \
                }                                                                       \
            }                                                                           \
            ph[0] = p0;                                                                 \
        }
#define ANA_UNI(W)                                                                      \
        for (j = 0; j < nu; j++)                                                        \
            inc_start(rp + j, pitch, base + doct[j]);                                   \
        for (i = 0; i < n;) {                                                           \
            uint32_t e = INC_END(i);                                                    \
            for (j = 0; j < nu; j++)                                                    \
                dts[j] = inc_span(rp + j, pitch, base + doct[j], INC_TO(e));            \
            for (; i < e; i++) {                                                        \
                int32_t y = 0;                                                          \
                ANA_SYNC                                                                \
                for (j = 0; j < nu; j++) {                                              \
                    ph[j] += dts[j];                                                    \
                    y += mul16(W(ph[j], dts[j], rc[j]), wq[j]);                         \
                    dts[j] += (uint32_t)rp[j].d;                                        \
                }                                                                       \
                out[i] = mul16(y, lvl);                                                 \
            }                                                                           \
        }
    if (nu == 1) {
        switch (kind) {
        case 1: ANA_ONE(ANA_TRI) break;
        case 2: ANA_ONE(ANA_SAW) break;
        case 4: ANA_ONE(ANA_SHARK) break;
        case 5: ANA_ONE(ANA_REV) break;
        default: ANA_ONE(ANA_SQR) break;
        }
    } else {
        switch (kind) {
        case 1: ANA_UNI(ANA_TRI) break;
        case 4: ANA_UNI(ANA_SHARK) break;
        case 2: ANA_UNI(ANA_SAW) break;
        case 5: ANA_UNI(ANA_REV) break;
        default: ANA_UNI(ANA_SQR) break;
        }
    }
#undef ANA_SAW
#undef ANA_TRI
#undef ANA_SHARK
#undef ANA_REV
#undef ANA_SQR
#undef ANA_SYNC
#undef ANA_ONE
#undef ANA_UNI
    if (!synced)
        s1 = n ? sync[n - 1] : s1;                          /* (the unconnected sync input reads 0) */
    it->s.osc.phase = ph[0];
    for (j = 1; j < nu; j++)
        it->s.osc.ph[j - 1] = ph[j];
    it->s.osc.s1 = s1;
}

/* m_osc with the analog shape (#673): the same setup (copies, blend, stack; the FM path's interpolation and decimator),
 * then osc_ana, or the FM path with ana_wave. Apart from m_osc so that analog 0 runs m_osc's loops as they were. */
static void m_osc(const node_t *nd, inst_t *it, uint32_t n);
static __attribute__((noinline)) void m_osc_ana(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[OSC_I_PITCH], *pm, *sync = it->in[OSC_I_SYNC];
    esig_t *out = it->out[OSC_O_OUT];
    int32_t pw_q = clampi(EF(it, OSC_P_PW), 3277, 62259), amt = EF(it, OSC_P_ANALOG);
    int32_t base = EF(it, OSC_P_COARSE) / 12 + EF(it, OSC_P_FINE) / 1200;
    int32_t kind = round_q16(EF(it, OSC_P_WAVE)), lvl = EF(it, OSC_P_LEVEL), fb = EF(it, OSC_P_FB);
    int32_t idx, y1, y2, pm1, xb, *ap = it->s.osc.ap, s1, j;
    uint32_t phase, i, *frc = it->s.osc.rc[0];
    inc_ramp_t rpf;
    ana_t a;
    if (kind == 0) {                                                       /* the sine has no analog shape */
        m_osc(nd, it, n);
        return;
    }
    if (amt > ENG_ONE)
        amt = ENG_ONE;
    pm = osc_pm(nd, it, n, &idx);
    if (idx <= 0 && fb <= 0) {                                             /* the plain oscillator (m_osc's setup) */
        int32_t ks = clampi(round_q16(EF(it, OSC_P_STACK)), 0, 4), nst = STACK_N[ks];
        int32_t nu = clampi(round_q16(EF(it, OSC_P_UNISON)), 1, 5), det = EF(it, OSC_P_DETUNE), doct[5], wq[5];
        if (nu < nst)
            nu = nst;
        for (j = 0; j < nu; j++)
            doct[j] = (nu > 1 ? (int32_t)(((int64_t)det * (2 * j - (nu - 1))) / ((int64_t)(nu - 1) * 1200)) : 0)
                      + STACK_OCT[ks][j % nst];
        if (nu <= 2) {
            wq[0] = wq[1] = ENG_ONE / nu;
        } else {
            int32_t b = clampi(EF(it, OSC_P_BLEND), 0, ENG_ONE), w[5], sum = 0;
            for (j = 0; j < nu; j++) {
                int centre = nu & 1 ? j == (nu - 1) / 2 : (j == nu / 2 - 1 || j == nu / 2);
                w[j] = centre ? ENG_ONE - b : b;
                sum += w[j];
            }
            for (j = 0; j < nu; j++)
                wq[j] = (int32_t)(((int64_t)w[j] << 16) / sum);
        }
        ana_init(&a, amt, it->s.osc.tol, ANALOG_DIP_SAMPLES_Q16, pw_q);
        osc_ana(nd, it, n, kind, base, lvl, nu, doct, wq, &a);
        it->s.osc.y1 = it->s.osc.y2 = it->s.osc.pm1 = it->s.osc.xb = 0;
        for (i = 0; i < 8; i++)
            ap[i] = 0;
        return;
    }
    ana_init(&a, amt, it->s.osc.tol, 2u * ANALOG_DIP_SAMPLES_Q16, pw_q);   /* at the doubled rate: the dip twice the samples */
    phase = it->s.osc.phase;
    s1 = it->s.osc.s1;
    y1 = it->s.osc.y1;
    y2 = it->s.osc.y2;
    pm1 = it->s.osc.pm1;
    xb = it->s.osc.xb;
    INC_LOOP(rpf, base) {                                                  /* m_osc's FM path, ana_wave for wave */
        uint32_t dt = dt_ >> 1, sub;
        int32_t pm_now = idx > 0 ? pm[i] : 0, pm_mid = (pm1 + pm_now) >> 1, ya = 0;
        if (sync[i] >= 32768 && s1 < 32768)
            phase = 0;
        s1 = sync[i];
        pm1 = pm_now;
        for (sub = 0; sub < 2; sub++) {
            uint32_t ph;
            int32_t y;
            phase += dt;
            ph = phase + (uint32_t)(((int64_t)mul16(idx, sub ? pm_now : pm_mid) * TURN_PER_RAD) >> 16)
                       + (uint32_t)((int64_t)mul16(fb, (y1 + y2) >> 1) << 15);
            y = ana_wave(kind, ph, dt, a, frc);
            y2 = y1;
            y1 = y;
            if (sub) {
                int32_t p0 = allpass16(ap + 4, HB_A[2], allpass16(ap, HB_A[0], ya));
                int32_t p1 = allpass16(ap + 6, HB_A[3], allpass16(ap + 2, HB_A[1], xb));
                xb = y;
                out[i] = mul16((p0 + p1) >> 1, lvl);
            } else
                ya = y;
        }
    }
    it->s.osc.phase = phase;
    it->s.osc.s1 = s1;
    it->s.osc.y1 = y1;
    it->s.osc.y2 = y2;
    it->s.osc.pm1 = pm1;
    it->s.osc.xb = xb;
}

static void m_osc(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[OSC_I_PITCH], *pm, *sync = it->in[OSC_I_SYNC];
    esig_t *out = it->out[OSC_O_OUT];
    int32_t pw_q = clampi(EF(it, OSC_P_PW), 3277, 62259);                  /* 0.05 .. 0.95 */
    uint32_t pw = (uint32_t)pw_q << 16, phase = it->s.osc.phase, i;
    int32_t base = EF(it, OSC_P_COARSE) / 12 + EF(it, OSC_P_FINE) / 1200;
    int32_t kind = round_q16(EF(it, OSC_P_WAVE)), lvl = EF(it, OSC_P_LEVEL), fb = EF(it, OSC_P_FB);
    int32_t idx;
    int32_t y1, y2, pm1, xb, *ap = it->s.osc.ap, s1 = it->s.osc.s1;
    uint32_t dt_fm = 0;
    inc_ramp_t rpf;
    pm = osc_pm(nd, it, n, &idx);
    if (idx <= 0 && fb <= 0) {                                             /* the plain oscillator: one wave per frame */
        int32_t ks = clampi(round_q16(EF(it, OSC_P_STACK)), 0, 4), nst = STACK_N[ks];
        int32_t nu = clampi(round_q16(EF(it, OSC_P_UNISON)), 1, 5), det = EF(it, OSC_P_DETUNE), doct[5], wq[5], j;
        uint32_t *ph = it->s.osc.ph;
        if (nu < nst)                                                      /* stack: at least one copy per interval */
            nu = nst;
        for (j = 0; j < nu; j++)                                           /* unison voice j: -detune .. +detune cents, in octaves, + its stack interval */
            doct[j] = (nu > 1 ? (int32_t)(((int64_t)det * (2 * j - (nu - 1))) / ((int64_t)(nu - 1) * 1200)) : 0)
                      + STACK_OCT[ks][j % nst];
        if (nu <= 2) {                                                     /* blend (modules.ts blendWeights): centre 1 - b, sides b, normalised */
            wq[0] = wq[1] = ENG_ONE / nu;
        } else {
            int32_t b = clampi(EF(it, OSC_P_BLEND), 0, ENG_ONE), w[5], sum = 0;
            for (j = 0; j < nu; j++) {
                int centre = nu & 1 ? j == (nu - 1) / 2 : (j == nu / 2 - 1 || j == nu / 2);
                w[j] = centre ? ENG_ONE - b : b;
                sum += w[j];
            }
            for (j = 0; j < nu; j++)
                wq[j] = (int32_t)(((int64_t)w[j] << 16) / sum);
        }
        uint32_t dts[5], (*rc)[2] = it->s.osc.rc;
        if (nu == 1) {                                                      /* one phase: the wave picked once a block */
            uint32_t *r = rc[0];
            int32_t d0 = base + doct[0];
            inc_ramp_t r1;
#define OSC_PLAIN(Y)                                                                    \
            INC_LOOP(r1, d0) {                                                          \
                uint32_t dt = dt_;                                                      \
                phase += dt;                                                            \
                out[i] = mul16((Y), lvl);                                               \
            }
#define OSC_SYNC(Y)                                                                     \
            INC_LOOP(r1, d0) {                                                          \
                uint32_t dt = dt_;                                                      \
                int rst = sync[i] >= 32768 && s1 < 32768;                               \
                s1 = sync[i];                                                           \
                if (rst)                                                                \
                    phase = 0;                                                          \
                phase += dt;                                                            \
                out[i] = mul16((Y), lvl);                                               \
            }
            if (!(nd->conn & (1u << OSC_I_SYNC))) {
                switch (kind) {
                case 0: OSC_PLAIN(sin_turn(phase)) break;
                case 1: OSC_PLAIN(wave_tri(phase)) break;
                case 2: OSC_PLAIN(wave_saw(phase, dt, r)) break;
                case 4: OSC_PLAIN(wave_shark(phase, dt, r)) break;
                case 5: OSC_PLAIN(-wave_saw(phase, dt, r)) break;
                default: OSC_PLAIN(wave_square(phase, dt, pw, r)) break;
                }
                s1 = n ? sync[n - 1] : s1;                                  /* (the unconnected sync input reads 0) */
            } else {
                switch (kind) {
                case 0: OSC_SYNC(sin_turn(phase)) break;
                case 1: OSC_SYNC(wave_tri(phase)) break;
                case 2: OSC_SYNC(wave_saw(phase, dt, r)) break;
                case 4: OSC_SYNC(wave_shark(phase, dt, r)) break;
                case 5: OSC_SYNC(-wave_saw(phase, dt, r)) break;
                default: OSC_SYNC(wave_square(phase, dt, pw, r)) break;
                }
            }
#undef OSC_PLAIN
#undef OSC_SYNC
            n = 0;                                                          /* skips the general loop below */
        }
        if (n) {                                                            /* unison / stack: the wave picked once a block, phases in locals */
            uint32_t lph[4];
            inc_ramp_t rp[5];
            int32_t lastp, mv;
            for (j = 0; j < nu; j++)
                inc_start(rp + j, pitch, base + doct[j]);
            for (j = 0; j < 4; j++)
                lph[j] = ph[j];
#define OSC_SIN(p, d, r) sin_turn(p)
#define OSC_TRI(p, d, r) wave_tri(p)
#define OSC_SAW(p, d, r) wave_saw(p, d, r)
#define OSC_SQR(p, d, r) wave_square(p, d, pw, r)
#define OSC_SHARK(p, d, r) wave_shark(p, d, r)
#define OSC_REVERSE(p, d, r) (-wave_saw(p, d, r))
#define OSC_UNI(W)                                                                      \
            for (i = 0, lastp = pitch[0], mv = 1; i < n;) {                             \
                uint32_t e_ = INC_END(i);                                               \
                int32_t moved = pitch[INC_TO(e_)] != lastp;                             \
                if (mv | moved) {       /* each copy's span (as INC_LOOP); a still pitch keeps them */ \
                    for (j = 0; j < nu; j++)                                            \
                        dts[j] = inc_span(rp + j, pitch, base + doct[j], INC_TO(e_));   \
                    lastp = pitch[INC_TO(e_)];                                          \
                }                                                                       \
                mv = moved;                                                             \
              for (; i < e_; i++) {                                                     \
                int rst = sync[i] >= 32768 && s1 < 32768;   /* a rising edge on sync restarts the phases */ \
                int32_t y;                                                              \
                s1 = sync[i];                                                         \
                if (rst) {                                                              \
                    phase = 0;                                                          \
                    for (j = 1; j < nu; j++)                                            \
                        lph[j - 1] = 0;                                                 \
                }                                                                       \
                phase += dts[0];                                                        \
                y = mul16(W(phase, dts[0], rc[0]), wq[0]);                              \
                for (j = 1; j < nu; j++) {                                              \
                    lph[j - 1] += dts[j];                                               \
                    y += mul16(W(lph[j - 1], dts[j], rc[j]), wq[j]);                    \
                }                                                                       \
                out[i] = mul16(y, lvl);                                                 \
                if (mv)                                     /* (a pitch that moves) */  \
                    for (j = 0; j < nu; j++)                                            \
                        dts[j] += (uint32_t)rp[j].d;                                    \
              }                                                                         \
            }
            switch (kind) {
            case 0: OSC_UNI(OSC_SIN) break;
            case 1: OSC_UNI(OSC_TRI) break;
            case 2: OSC_UNI(OSC_SAW) break;
            case 4: OSC_UNI(OSC_SHARK) break;
            case 5: OSC_UNI(OSC_REVERSE) break;
            default: OSC_UNI(OSC_SQR) break;
            }
#undef OSC_UNI
#undef OSC_SIN
#undef OSC_TRI
#undef OSC_SAW
#undef OSC_SQR
#undef OSC_SHARK
#undef OSC_REVERSE
            for (j = 0; j < 4; j++)
                ph[j] = lph[j];
        }
        it->s.osc.phase = phase;
        it->s.osc.s1 = s1;
        it->s.osc.y1 = it->s.osc.y2 = it->s.osc.pm1 = it->s.osc.xb = 0;
        for (i = 0; i < 8; i++)
            ap[i] = 0;
        return;
    }
    y1 = it->s.osc.y1;
    y2 = it->s.osc.y2;
    pm1 = it->s.osc.pm1;
    xb = it->s.osc.xb;
    /* The common FM operator is a sine with no feedback or sync. Its two sub-samples need no waveform dispatch,
     * feedback multiplies or sub-sample loop. Keep the same phase, interpolation and decimator state as the general path. */
    if (kind == 0 && fb == 0 && !(nd->conn & (1u << OSC_I_SYNC))) {
        INC_LOOP(rpf, base) {
            int32_t pm_now = pm[i], pm_mid = (pm1 + pm_now) >> 1, p0, p1;
            dt_fm = dt_ >> 1;
            pm1 = pm_now;
            phase += dt_fm;
            y2 = sin_turn(phase + (uint32_t)(((int64_t)mul16(idx, pm_mid) * TURN_PER_RAD) >> 16));
            phase += dt_fm;
            y1 = sin_turn(phase + (uint32_t)(((int64_t)mul16(idx, pm_now) * TURN_PER_RAD) >> 16));
            p0 = allpass16(ap + 4, HB_A[2], allpass16(ap, HB_A[0], y2));
            p1 = allpass16(ap + 6, HB_A[3], allpass16(ap + 2, HB_A[1], xb));
            xb = y1;
            out[i] = mul16((p0 + p1) >> 1, lvl);
        }
        s1 = n ? sync[n - 1] : s1;
        n = 0;
    }
    uint32_t *frc = it->s.osc.rc[0];                  /* blep_pos's cache, kept across blocks */
    INC_LOOP(rpf, base) {
        uint32_t dt = dt_ >> 1, sub;
        int32_t pm_now = idx > 0 ? pm[i] : 0, pm_mid = (pm1 + pm_now) >> 1, ya = 0;
        if (sync[i] >= 32768 && s1 < 32768)
            phase = 0;
        s1 = sync[i];
        pm1 = pm_now;
        for (sub = 0; sub < 2; sub++) {
            uint32_t ph;
            int32_t y;
            phase += dt;
            ph = phase + (uint32_t)(((int64_t)mul16(idx, sub ? pm_now : pm_mid) * TURN_PER_RAD) >> 16)
                       + (uint32_t)((int64_t)mul16(fb, (y1 + y2) >> 1) << 15);   /* fb: Q16 of pi = half a turn */
            y = wave(kind, ph, dt, pw, frc);
            y2 = y1;
            y1 = y;
            if (sub) {        /* path 0 takes the even sub-sample, path 1 the odd one of the previous frame (the z^-1) */
                int32_t p0 = allpass16(ap + 4, HB_A[2], allpass16(ap, HB_A[0], ya));
                int32_t p1 = allpass16(ap + 6, HB_A[3], allpass16(ap + 2, HB_A[1], xb));
                xb = y;
                out[i] = mul16((p0 + p1) >> 1, lvl);
            } else
                ya = y;
        }
    }
    it->s.osc.phase = phase;
    it->s.osc.s1 = s1;
    it->s.osc.y1 = y1;
    it->s.osc.y2 = y2;
    it->s.osc.pm1 = pm1;
    it->s.osc.xb = xb;
}

static void lfo_cycle(inst_t *it)
{
    it->s.lfo.from = it->s.lfo.last;             /* the random wave glides on from where it is */
    it->s.lfo.seed = it->s.lfo.seed * 1664525u + 1013904223u;
    it->s.lfo.held = (int32_t)(it->s.lfo.seed >> 15) - ENG_ONE;
}

/* the random wave (LFO_RANDOM, #518): from its start to the new value along 3x^2 - 2x^3 over the cycle (modules.ts
 * lfoSmooth), x the phase's top 16 bits; it notes the value in `last` */
#define LFO_RANDOM 5
static inline int32_t lfo_smooth(inst_t *it, uint32_t phase)
{
    uint32_t x = phase >> 16, x2 = (uint32_t)(((uint64_t)x * x) >> 16);
    int32_t s = (int32_t)(((uint64_t)x2 * (196608u - 2u * x)) >> 16);
    return it->s.lfo.last = it->s.lfo.from + mul16(it->s.lfo.held - it->s.lfo.from, s);
}

/* the free-running LFO (no sync, nothing in clk / reset): the wave picked once a block. A function of its own: inside
 * m_lfo the branch around it came out longer than 16 KB in the JieLi build, a form of `if ((R & #h) == #i) goto` that
 * fm1-emu (7ca5b96) does not decode yet (docs/ARCHITECTURE.md "Estimated CPU load"). off: the start phase, added where
 * the wave is read (u32 turns); depth comes negated for a backward wave. */
static void __attribute__((noinline)) lfo_free(inst_t *it, esig_t *out, uint32_t dt, int32_t kind, int32_t depth, uint32_t off, uint32_t n)
{
    uint32_t phase = it->s.lfo.phase, since = it->s.lfo.since + n, i, lrc[4] = {0};
#define LFO_FREE(Y)                                                                     \
    for (i = 0; i < n; i++) {                                                           \
        uint32_t prev = phase;                                                          \
        phase += dt;                                                                    \
        if (phase < prev)                                                               \
            lfo_cycle(it);                                                              \
        out[i] = mul16((Y), depth);                                                     \
    }
    switch (kind) {
    case 0: LFO_FREE(sin_turn(phase + off)) break;
    case 1: LFO_FREE(wave_tri(phase + off)) break;
    case 2: LFO_FREE(wave_saw(phase + off, dt, lrc)) break;
    case 4: LFO_FREE(it->s.lfo.held) break;
    case LFO_RANDOM: LFO_FREE(lfo_smooth(it, phase)) break;
    default: LFO_FREE(wave_square(phase + off, dt, 0x80000000u, lrc)) break;
    }
#undef LFO_FREE
    it->s.lfo.since = since < ENG_SR ? since : ENG_SR;   /* as m_lfo's loop counts it, the clock and reset inputs low */
    it->s.lfo.clk_hi = 0;
    it->s.lfo.rst_hi = 0;
    it->s.lfo.phase = phase;
}

/* free: rate in Hz times the range (slow / 25, fast x 2). sync: one cycle per note length (DELAY_DIV_NUM / DELAY_DIV_DEN,
 * as the delay) times the speed (LFO_MULT_NUM / LFO_MULT_DEN) that snaps to clk (24 ppqn) every `snap` ticks, where a
 * whole number (`cycles`) of cycles ends on a tick; it runs at the measured clock speed in between and at bpm when there
 * is no clock (modules.ts lfoSyncCycle). per8 = 8 x ticks per cycle, a whole number. phase: where a cycle starts on the
 * wave; dir back: the wave backward, read as -w(phase - off) (the triangle as it is). */
static int32_t lfo_wave(int32_t kind, uint32_t phase, uint32_t dt, uint32_t duty, uint32_t rise, uint32_t fall, uint32_t *rc)
{
    if (kind == 3 && (!duty || duty == 65536u))
        return duty ? ENG_ONE : -ENG_ONE;
    if (kind != 1 || duty == 32768u)
        return wave(kind, phase, dt, duty == 65536u ? 0xFFFFFFFFu : duty << 16, rc);
    if (!duty)
        return -wave_saw(phase, dt, rc);
    if (duty == 65536u)
        return wave_saw(phase, dt, rc);
    if (phase < duty << 16)
        return (int32_t)(((uint64_t)phase * rise) >> 31) - ENG_ONE;
    return ENG_ONE - (int32_t)(((uint64_t)(phase - (duty << 16)) * fall) >> 31);
}

static void m_lfo(const node_t *nd, inst_t *it, uint32_t n)
{
    esig_t *out = it->out[0];
    esig_t *pulse = it->out[LFO_O_PULSE];
    const esig_t *clk = it->in[LFO_I_CLK], *rst = it->in[LFO_I_RESET];
    uint32_t rate = (uint32_t)EF(it, LFO_P_RATE), dtfree, phase = it->s.lfo.phase, i, dt;
    int32_t kind = round_q16(EF(it, LFO_P_WAVE)), depth = EF(it, LFO_P_DEPTH);
    int sync = EF(it, LFO_P_SYNC) >= 32768, back = EF(it, LFO_P_DIR) >= 32768;
    int32_t div = clampi((EF(it, LFO_P_DIV) + 32768) >> 16, 0, DELAY_NDIV - 1), bpm = EF(it, LFO_P_BPM);
    int32_t mi = clampi((EF(it, LFO_P_MULT) + 32768) >> 16, 0, LFO_NMULT - 1), range = clampi((EF(it, LFO_P_RANGE) + 32768) >> 16, 0, LFO_NRANGE - 1);
    uint32_t num = (uint32_t)DELAY_DIV_NUM[div] * LFO_MULT_NUM[mi], den = (uint32_t)DELAY_DIV_DEN[div] * LFO_MULT_DEN[mi];
    uint32_t per8 = 192u * num / den, g = per8 & 7u ? (per8 & 3u ? (per8 & 1u ? 1u : 2u) : 4u) : 8u;   /* g = gcd(per8, 8) */
    uint32_t snap = per8 / g, cycles = 8u / g, dtbpm = 0, lrc[4] = {0}, off = 0;
    uint32_t duty = 32768u;
    if (nd->conn & (1u << LFO_I_SHAPE)) {
        int64_t sum = 0;
        for (i = 0; i < n; i++) sum += it->in[LFO_I_SHAPE][i];
        duty = (uint32_t)clampi(block_mean(sum, n), 0, ENG_ONE);
    }
    if (EF(it, LFO_P_PHASE))                     /* degrees Q16 -> u32 turns (x 2^16 / 360) */
        off = (uint32_t)(((uint64_t)(uint32_t)EF(it, LFO_P_PHASE) * 11930465u) >> 16);
    if (back) {
        off = 0u - off;
        duty = 65536u - duty;
        if (kind != 1)
            depth = -depth;
    }
    /* Reciprocal slopes once per block, within two Q16 steps of the exact per-sample division. */
    uint32_t rise = duty && duty != 32768u ? 0xFFFFFFFFu / duty : 0;
    uint32_t fall = duty != 65536u && duty != 32768u ? 0xFFFFFFFFu / (65536u - duty) : 0;
    if (range == 3)
        rate = (uint32_t)EF(it, LFO_P_WIDE);
    dtfree = range == 1 ? (uint32_t)(((uint64_t)rate << 16) / (25u * ENG_SR)) : range == 2 ? hz_turns(rate) << 1 : hz_turns(rate);
    if (bpm < 65536)
        bpm = 65536;
    if (sync)                                    /* (a 64-bit division: only when it is used) */
        dtbpm = (uint32_t)(((uint64_t)(uint32_t)bpm * den << 16) / ((uint64_t)60u * num * ENG_SR));
    if (!sync && duty == 32768u && IS_DUMMY(pulse) && !(nd->conn & ((1u << LFO_I_CLK) | (1u << LFO_I_RESET)))) {
        lfo_free(it, out, dtfree, kind, depth, off, n);
        return;
    }
    for (i = 0; i < n; i++) {
        uint32_t prev = phase;
        int32_t w;
        int c = clk[i] >= 32768, r = rst[i] >= 32768, live;
        if (it->s.lfo.since < ENG_SR)
            it->s.lfo.since++;
        if (c && !it->s.lfo.clk_hi) {
            int32_t d8 = (int32_t)(it->s.lfo.since << 8);
            if (it->s.lfo.since >= ENG_SR / 2)
                it->s.lfo.interval = 0;
            else
                it->s.lfo.interval = it->s.lfo.interval > 0 ? it->s.lfo.interval + (d8 - it->s.lfo.interval) / 8 : d8;
            it->s.lfo.since = 0;
            if (sync && ++it->s.lfo.ticks >= snap) {
                it->s.lfo.ticks = 0;
                it->s.lfo.wraps = 0;
                phase = prev = 0;
                lfo_cycle(it);
            }
        }
        it->s.lfo.clk_hi = (uint8_t)c;
        if (r && !it->s.lfo.rst_hi) {
            phase = prev = 0;
            it->s.lfo.ticks = 0;
            it->s.lfo.wraps = 0;
            lfo_cycle(it);
        }
        it->s.lfo.rst_hi = (uint8_t)r;
        live = sync && it->s.lfo.interval > 0 && it->s.lfo.since < ENG_SR / 2;
        dt = !sync ? dtfree : live ? (uint32_t)((1ull << 43) / ((uint64_t)per8 * (uint32_t)it->s.lfo.interval)) : dtbpm;
        phase += dt;
        if (phase < prev) {
            if (live && it->s.lfo.wraps + 1u >= cycles)
                phase = 0xFFFFFFFFu;        /* wait for the clock's next snap */
            else {
                if (live)
                    it->s.lfo.wraps++;
                lfo_cycle(it);              /* a new cycle: sample & hold takes a new random value */
            }
        }
        w = kind == 4 ? it->s.lfo.held : kind == LFO_RANDOM ? lfo_smooth(it, phase) : lfo_wave(kind, phase + off, dt, duty, rise, fall, lrc);
        out[i] = mul16(w, depth);
        if (!IS_DUMMY(pulse)) {
            int32_t pw = !duty ? -ENG_ONE : duty == 65536u ? ENG_ONE : wave_square(phase + off, dt, duty << 16, lrc);
            pulse[i] = mul16(pw, back ? -EF(it, LFO_P_DEPTH) : EF(it, LFO_P_DEPTH));
        }
    }
    it->s.lfo.phase = phase;
    (void)nd;
}

/* white noise through a one-pole with c = 2^(-5 color): color 0 is c = 1, the plain noise bit for bit. y is Q24. */
static void m_noise(const node_t *nd, inst_t *it, uint32_t n)
{
    esig_t *out = it->out[0];
    uint32_t seed = it->s.noise.seed, i;
    int32_t lvl = EF(it, NOISE_P_LEVEL), y = it->s.noise.y;
    int32_t k = (int32_t)exp2_q16((16 << 16) - 5 * EF(it, NOISE_P_COLOR));
    for (i = 0; i < n; i++) {
        seed = seed * 1664525u + 1013904223u;
        y += mulq(k, (((int32_t)(seed >> 15) - ENG_ONE) << 8) - y, 16);
        out[i] = mul16((y + 128) >> 8, lvl);
    }
    it->s.noise.seed = seed;
    it->s.noise.y = y;
}

static void m_ratio(const node_t *nd, inst_t *it, uint32_t n)
{
    (void)nd;
    int32_t ratio = clampi(round_q16(EF(it, RATIO_P_RATIO)), 0, 63);
    int32_t detune = clampi(round_q16(EF(it, RATIO_P_DETUNE)), 0, 6);
    fill(it->out[0], RATIO_OCT[ratio] + RATIO_DETUNE_OCT[detune], n);
}

static void m_const(const node_t *nd, inst_t *it, uint32_t n) { fill(it->out[0], EF(it, 0), n); }

static void m_scale(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SCALE_I_IN];
    esig_t *out = it->out[0];
    int32_t g = EF(it, SCALE_P_GAIN), o = EF(it, SCALE_P_OFFSET);
    uint32_t i;
    if (!g || in == zero_buf)
        fill(out, o, n);
    else if (g == ENG_ONE)
        for (i = 0; i < n; i++)
            out[i] = in[i] + o;
    else
        for (i = 0; i < n; i++)
            out[i] = mul16(in[i], g) + o;
}

static int32_t env_rate(int32_t t_q16);
static int32_t env_rate_n(uint32_t n);

/* lin glide's step for a time (Q16 s): one unit per that time, Q24 per sample */
static int32_t glide_step(int32_t t)
{
    int64_t den = (int64_t)t * ENG_SR;                                    /* samples, Q16 */
    return den > ((int64_t)1 << 16) ? (int32_t)(((int64_t)1 << 40) / den) : 1 << 24;
}

/* a one-pole glide: 99 % of a step in `time` (the envelope's rate curve, Q30 per sample). The state is Q24 (+-128):
 * in Q16 the step k * (in - y) would round to nothing while still 1 % short of the target, which a pitch can hear.
 * `fall` above 0 (#669): a falling input moves at that time instead (modules.ts glide). */
static void m_glide(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[GLIDE_I_IN];
    esig_t *out = it->out[0];
    int32_t k = env_rate(EF(it, GLIDE_P_TIME)), y = it->s.gld.y, fall = EF(it, GLIDE_P_FALL);
    uint32_t i;
    if (round_q16(EF(it, GLIDE_P_CURVE)) == 1) {   /* lin: one unit per `time`, Q24 per sample (modules.ts glide) */
        int32_t step = glide_step(EF(it, GLIDE_P_TIME)), down = fall > 0 ? glide_step(fall) : step;
        for (i = 0; i < n; i++) {
            int32_t d = (clampi(in[i], -(1 << 23), (1 << 23) - 1) << 8) - y;
            y += d > step ? step : d < -down ? -down : d;
            out[i] = (y + 128) >> 8;
        }
        it->s.gld.y = y;
        return;
    }
    if (fall > 0) {                                /* rising at `time`, falling at `fall` */
        int32_t kd = env_rate(fall);
        for (i = 0; i < n; i++) {
            int32_t d = (clampi(in[i], -(1 << 23), (1 << 23) - 1) << 8) - y;
            y += mulq(d >= 0 ? k : kd, d, 30);
            out[i] = (y + 128) >> 8;
        }
        it->s.gld.y = y;
        return;
    }
    for (i = 0; i < n; i++) {
        y += mulq(k, (clampi(in[i], -(1 << 23), (1 << 23) - 1) << 8) - y, 30);
        out[i] = (y + 128) >> 8;
    }
    it->s.gld.y = y;
}

/* waveshaper: drive, then a cubic soft clip (1.5 x - x^3 / 2 up to the knee at 1), a hard clip or a triangle fold */
/* 2x oversampling around a nonlinearity (modules.ts os2): the oscillator's half-band as an interpolator (os_up0 = the
 * even sub-sample, os_up1 = the odd one; ap[0..7]) and as the decimator (os_down; ap[8..15], *xb = the odd sub-sample of
 * the previous frame, as in m_osc) */
static inline int32_t os_up0(int32_t *ap, int32_t x) { return allpass16(ap + 4, HB_A[2], allpass16(ap, HB_A[0], x)); }
static inline int32_t os_up1(int32_t *ap, int32_t x) { return allpass16(ap + 6, HB_A[3], allpass16(ap + 2, HB_A[1], x)); }
static inline int32_t os_down(int32_t *ap, int32_t *xb, int32_t y0, int32_t y1)
{
    int32_t p0 = os_up0(ap, y0), p1 = os_up1(ap, *xb);
    *xb = y1;
    return (p0 + p1) >> 1;
}

/* the shaper's curve of a driven sample x (up to +-32): a cubic soft clip, a hard clip or a triangle fold, the peak at 1 */
static inline int32_t shape_curve(int32_t x, int32_t mode)
{
    int32_t y;
    if (mode == 1)
        y = clampi(x, -ENG_ONE, ENG_ONE);
    else if (mode == 2) {
        int32_t t = (x + ENG_ONE) & (4 * ENG_ONE - 1);                      /* 0 .. 4: a triangle of period 4 */
        y = t < 2 * ENG_ONE ? t - ENG_ONE : 3 * ENG_ONE - t;
    } else if (x >= ENG_ONE)
        y = ENG_ONE;
    else if (x <= -ENG_ONE)
        y = -ENG_ONE;
    else {
        int32_t x3 = mul16(mul16(x, x), x);
        y = x + (x >> 1) - (x3 >> 1);
    }
    return y;
}

/* the whole transfer: sym offsets the driven sample, then the curve runs stages (1..4) times with a gain of 2 between them */
static inline int32_t shape_chain(int32_t x, int32_t mode, int32_t sym, int32_t stages)
{
    int32_t y = shape_curve(x + sym, mode), k;
    for (k = 1; k < stages; k++)
        y = shape_curve(y << 1, mode);
    return y;
}

static void m_shape(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SHAPE_I_IN];
    esig_t *out = it->out[0];
    int32_t drive = EF(it, SHAPE_P_DRIVE), mode = round_q16(EF(it, SHAPE_P_MODE)), lvl = EF(it, SHAPE_P_LEVEL);
    int32_t sym = EF(it, SHAPE_P_SYM), stages = clampi(round_q16(EF(it, SHAPE_P_STAGES)), 1, 4);
    int os = EF(it, SHAPE_P_OS) >= 32768, *ap = it->s.shp.ap;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t x = mul16(in[i], drive), y;
        if (os)
            y = os_down(ap + 8, &it->s.shp.xb, shape_chain(os_up0(ap, x), mode, sym, stages),
                        shape_chain(os_up1(ap, x), mode, sym, stages));
        else
            y = shape_chain(x, mode, sym, stages);
        out[i] = mul16(y, lvl);
    }
}

/* 1 - exp(-4.6 / samples) in Q30, samples in Q8 (at least 1) */
static int32_t env_rate_q8(uint64_t tsr)
{
    uint64_t y;
    if (tsr < 256u)
        tsr = 256u;
    y = 1264438371942ull / tsr;                                       /* 4.6 in Q30 / samples */
    if (y < (1ull << 26)) {                                           /* series: y - y^2/2 + y^3/6 - y^4/24 */
        /* y < 2^26, so y2 < 2^22, y3 < 2^18, y4 < 2^14, all >= 0: 32-bit divisions, the same quotients as 64-bit ones */
        uint32_t y2 = (uint32_t)((y * y) >> 30), y3 = (uint32_t)(((uint64_t)y2 * y) >> 30), y4 = (uint32_t)(((uint64_t)y3 * y) >> 30);
        return (int32_t)((uint32_t)y - y2 / 2u + y3 / 6u - y4 / 24u);
    } else {                                                          /* exp(-y) = 2^(-y log2 e) */
        uint64_t z = (y * 1549082005ull) >> 30;                       /* Q30 */
        uint32_t n = (uint32_t)(z >> 30), f = (uint32_t)z & 0x3FFFFFFFu, i = f >> 22, r = (f >> 14) & 255u;
        uint32_t e31 = EXPN_T[i] - (uint32_t)(((uint64_t)(EXPN_T[i] - EXPN_T[i + 1u]) * r) >> 8);
        uint32_t e30 = n >= 31u ? 0u : e31 >> (n + 1u);
        return (int32_t)(1u << 30) - (int32_t)e30;
    }
}

/* 1 - exp(-4.6 / max(t * sr, 1)) in Q30, t in seconds Q16 */
static int32_t env_rate(int32_t t_q16) { return env_rate_q8(((uint64_t)(uint32_t)t_q16 * ENG_SR) >> 8); }
/* the same for a segment of n whole samples */
static int32_t env_rate_n(uint32_t n) { return env_rate_q8((uint64_t)n << 8); }

static void m_adsr(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *gate = it->in[ADSR_I_GATE], *hold = it->in[ADSR_I_HOLD];
    esig_t *out = it->out[0];
    int32_t pa = EF(it, ADSR_P_A), pd = EF(it, ADSR_P_D), pr = EF(it, ADSR_P_R);
    int32_t ainc, ad, ar, sus = EF(it, ADSR_P_S) << 14, v = it->s.adsr.v;
    if (EF(it, ADSR_P_LONG) >= 32768) {          /* long: decay and release x 2.4 (modules.ts ADSR_LONG) */
        pd = (int32_t)(((int64_t)pd * ADSR_LONG_Q16) >> 16);
        pr = (int32_t)(((int64_t)pr * ADSR_LONG_Q16) >> 16);
    }
    uint8_t stage = it->s.adsr.stage, prev = it->s.adsr.prev;
    uint32_t i;
    if (!(it->s.adsr.ok & 1u) || it->s.adsr.ka != pa) {
        uint64_t asr = ((uint64_t)(uint32_t)pa * ENG_SR) >> 8;
        if (asr < 256u)
            asr = 256u;
        it->s.adsr.ainc = (int32_t)((1ull << 38) / asr);
        it->s.adsr.ka = pa;
    }
    if (!(it->s.adsr.ok & 2u) || it->s.adsr.kd != pd) {
        it->s.adsr.ad = env_rate(pd);
        it->s.adsr.kd = pd;
    }
    if (!(it->s.adsr.ok & 4u) || it->s.adsr.kr != pr) {
        it->s.adsr.ar = env_rate(pr);
        it->s.adsr.kr = pr;
    }
    it->s.adsr.ok = 7u;
    ainc = it->s.adsr.ainc;
    ad = it->s.adsr.ad;
    ar = it->s.adsr.ar;
    for (i = 0; i < n; i++) {
        uint8_t g = gate[i] > 32768 ? 1 : 0;
        if (g && !prev)
            stage = 1;
        /* Hold defers release but preserves gate edges for a reused voice's next attack. */
        else if (!g && stage && stage != 4 && hold[i] <= 32768)
            stage = 4;
        prev = g;
        /* Each stage runs on until it ends or the next sample's gate (or hold) would change it, without the per-sample
         * edge checks (#781). ADSR_KEEP(j): sample j changes nothing in an attack, decay or sustain. */
#define ADSR_KEEP(j) ((gate[j] > 32768) == g && (g || hold[j] > 32768))
        switch (stage) {
        case 0: {                                 /* resting: until the gate rises */
            const int32_t o = v >> 14;
            out[i] = o;
            while (i + 1u < n && (gate[i + 1u] > 32768) == g)
                out[++i] = o;
            break;
        }
        case 1:
            for (;;) {
                v += ainc;
                if (v >= (1 << 30)) {
                    v = 1 << 30;
                    stage = 2;
                    out[i] = v >> 14;
                    break;
                }
                out[i] = v >> 14;
                if (i + 1u >= n || !ADSR_KEEP(i + 1u))
                    break;
                i++;
            }
            break;
        case 2:
            for (;;) {
                int32_t d;
                v += mulq(sus - v, ad, 30);
                d = sus - v;
                out[i] = v >> 14;
                if ((d < 0 ? -d : d) < 107374) {
                    stage = 3;
                    break;
                }
                if (i + 1u >= n || !ADSR_KEEP(i + 1u))
                    break;
                i++;
            }
            break;
        case 3: {                                 /* sustaining */
            const int32_t o = sus >> 14;
            v = sus;
            out[i] = o;
            while (i + 1u < n && ADSR_KEEP(i + 1u))
                out[++i] = o;
            break;
        }
        case 4:                                   /* (at least one step: past about 11 s the product rounds to 0 above the end level) */
            for (;;) {
                int32_t dv = mulq(v, ar, 30);
                v -= dv > 0 ? dv : 1;
                if (v < 107374) {
                    v = 0;
                    stage = 0;
                    out[i] = 0;
                    break;
                }
                out[i] = v >> 14;
                if (i + 1u >= n || (gate[i + 1u] > 32768) != g)
                    break;
                i++;
            }
            break;
        }
#undef ADSR_KEEP
    }
    it->s.adsr.v = v;
    it->s.adsr.stage = stage;
    it->s.adsr.prev = prev;
}

/* Original rate controls, with native pedal hold and unbent key pitch for key-rate scaling. */
static void m_rateenv(const node_t *nd, inst_t *it, uint32_t n)
{
    rate_env_t *s = &it->s.rateenv;
    uint32_t ar = (uint32_t)((EF(it, RATEENV_P_AR) + 32768) >> 16) * 2u;
    uint32_t d1r = (uint32_t)((EF(it, RATEENV_P_D1R) + 32768) >> 16) * 2u;
    uint32_t d2r = (uint32_t)((EF(it, RATEENV_P_D2R) + 32768) >> 16) * 2u;
    uint32_t rr = (uint32_t)((EF(it, RATEENV_P_RR) + 32768) >> 16) * 4u + 2u;
    uint32_t scaling = (uint32_t)((EF(it, RATEENV_P_KRS) + 32768) >> 16);
    uint32_t level = 15u - (uint32_t)((EF(it, RATEENV_P_D1L) + 32768) >> 16);
    uint32_t target = (level == 15u ? 31u : level) * 32u, i;
    for (i = 0; i < n; i++) {
        int32_t note = (int32_t)(((int64_t)it->in[RATEENV_I_PITCH][i] * 12 + 60 * 65536 + 32768) >> 16);
        uint32_t key = (uint32_t)clampi(note < 13 ? 0 : (note - 13) / 3, 0, 31);
        rate_env_sample(s, ENG_SR * 192u, it->in[RATEENV_I_GATE][i] > 32768,
                        it->in[RATEENV_I_HOLD][i] > 32768, ar, d1r, target, d2r, rr, key >> (3u - scaling));
        it->out[0][i] = s->stage && s->att < 1023 ? (esig_t)((EXPN_T[(s->att & 63) * 4] >> 15) >> (s->att >> 6)) : 0;
    }
}

static void m_vca(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[VCA_I_IN], *cv = it->in[VCA_I_CV];
    esig_t *out = it->out[0];
    int32_t g = EF(it, VCA_P_GAIN);
    uint32_t i;
    (void)nd; /* an unplugged cv reads the zero buffer: a VCA with no control is closed */
    if (!g || in == zero_buf || cv == zero_buf)
        fill(out, 0, n);
    else if (g == ENG_ONE)
        for (i = 0; i < n; i++)
            out[i] = mul16(in[i], cv[i]);
    else
        for (i = 0; i < n; i++)
            out[i] = mul16(mul16(in[i], cv[i]), g);
}

#define LAD_SAT_KNEE (3 << 19)      /* 1.5 in Q20: the saturator's knee */
#define LAD_SAT_CUBE 2485513        /* 1 / 6.75 in Q24 */

typedef struct {
    int32_t g, a1, a2, a3;
} svf_coef_t;

/* the coefficients of one stage for the tan() warped cutoff g */
static void svf_stage(svf_coef_t *c, int32_t g, int32_t k24)
{
    int32_t den = (1 << 24) + mulq(g, g + k24, 24);
    c->g = g;
    c->a1 = recip24(den);
    c->a2 = mulq(g, c->a1, 24);
    c->a3 = mulq(g, c->a2, 24);
}

/* the warped cutoff g = tan(pi fc / sr) for a cutoff given as a phase increment (cutoff / sr in u32 turns) */
static int32_t svf_g(uint32_t rinc)
{
    uint32_t i, fr;
    int32_t t0, t1;
    if (rinc > DT_MAX)
        rinc = DT_MAX;
    i = rinc >> 22;
    fr = (rinc >> 6) & 0xFFFFu;
    t0 = TAN_T[i];
    t1 = TAN_T[i + 1u];
    return t0 + (int32_t)(((int64_t)(t1 - t0) * fr) >> 16);
}

#define SQRT2_24 23726566   /* stage 2's k: sqrt(2) in Q24 (Q 0.7), the resonance comes from stage 1 only */

/* Two stages: stage 1 (12 dB) gives lp12, bp, hp (and notch, peak, allpass, and hp6 = hp + 2 bp, a resonant 6 dB high
 * pass, from the same values, only when a cable leaves them); stage 2 filters lp12 again (lp24); mix fades lp24 -> hp by morph.
 * The integrator states are Q20 (+-2048: room for the resonance peak), the signals Q16; products are rounded.
 * Key tracking moves the cutoff by the voice pitch (octaves, C4 = as set), like the host engine, once per block. */
static int32_t filter_over(const inst_t *it)   /* how far res is past FILTER_OSC_FROM with osc on, Q16 (0: off) */
{
    int32_t res = EF(it, FILTER_P_RES);
    return EF(it, FILTER_P_OSC) >= 32768 && res > FILTER_OSC_FROM_Q16 ? res - FILTER_OSC_FROM_Q16 : 0;
}

/* the damping the drive adds (#670, modules.ts filterDriveLoss), Q24, for a = drive r |bp| (Q20, held to
 * FILTER_DRIVE_TOP): 1 - sat(a) / a, that is a^2 / 6.75 below the knee and 1 - 1 / a above it */
HOT int32_t filter_drive_loss(int32_t a)
{
    if (a >= FILTER_DRIVE_KNEE_Q20)
        return (1 << 24) - recip24(a << 4);
    return mulq(mulq(a, a, 20), LAD_SAT_CUBE, 20);
}

/* osc, drv: constants at each call (m_filter), so the ordinary filter carries none of the self-oscillation's or the
 * drive's work. drv (#670, drive above 0 and res above 0): the damping grows by r (1 - sat(a) / a), a = drive r |bp|,
 * so stage 1 is solved per sample, as with osc. */
HOT void filter_run(const node_t *nd, inst_t *it, uint32_t n, int osc, int drv)
{
    const esig_t *in = it->in[FILTER_I_IN], *cv = it->in[FILTER_I_CV], *mo = it->in[FILTER_I_MORPH];
    esig_t *lp = it->out[FILTER_O_LP12], *bp = it->out[FILTER_O_BP], *hp = it->out[FILTER_O_HP];
    esig_t *lp24 = it->out[FILTER_O_LP24], *mix = it->out[FILTER_O_MIX];
    esig_t *notch = it->out[FILTER_O_NOTCH], *peak = it->out[FILTER_O_PEAK], *apo = it->out[FILTER_O_AP];
    int32_t res = EF(it, FILTER_P_RES);
    /* self-oscillation (osc on, res past FILTER_OSC_FROM; modules.ts): the damping falls below 0 near the top and grows
     * with the band-pass state squared (held to +-FILTER_OSC_CLIP), so stage 1 is solved per sample there */
    int32_t over = osc ? filter_over(it) : 0;   /* Q16 */
    int32_t k24 = (2 << 24) - mulq(res, 33218888, 16) - mulq(over, FILTER_OSC_K_Q24, 16);   /* 2 - 1.98 res (- the fall) */
    int32_t gam = mulq(over, FILTER_OSC_GAIN_Q24, 16), gc = 0, ke = k24;                    /* Q24; gc: the current g, ke: the damping */
    int32_t r24 = mulq(res, 33218888, 16), dr = drv ? mulq(EF(it, FILTER_P_DRIVE), r24, 24) : 0;   /* 1.98 res Q24; drive r Q16 */
    int32_t cvamt = EF(it, FILTER_P_CVAMT), ic1 = it->s.flt.ic1, ic2 = it->s.flt.ic2, jc1 = it->s.flt.jc1, jc2 = it->s.flt.jc2;
    int32_t morph = EF(it, FILTER_P_MORPH), tr = EF(it, FILTER_P_TRACK) >= 32768 ? IT_PV(nd, it)->pitch : 0;
    uint32_t base = hz_turns((uint32_t)EF(it, FILTER_P_CUTOFF)), i;
    svf_coef_t c, d;
    int fixed = !(nd->conn & (1u << FILTER_I_CV));
    int msig = nd->conn & (1u << FILTER_I_MORPH);
    int ext = !IS_DUMMY(notch) || !IS_DUMMY(peak) || !IS_DUMMY(apo) || !IS_DUMMY(it->out[FILTER_O_HP6]);   /* the notch / peak / allpass / hp6 outputs are in use */
    int st2 = !IS_DUMMY(lp24) || !IS_DUMMY(mix);     /* the second stage only feeds lp24 and mix: skipped when neither is */
    int32_t lcv = 0;
    if (tr)
        base = exp2_scale(base, tr);
    if (osc && !ic1 && !ic2)
        ic1 = FILTER_OSC_SEED_Q20;               /* a filter at rest: a small kick starts the oscillation */
    if (fixed) {
        int32_t g = svf_g(base);
        gc = g;
        svf_stage(&c, g, k24);
        svf_stage(&d, g, SQRT2_24);
    }
    for (i = 0; i < n; i++) {
        int32_t v0 = in[i] << 4, v3, v1, v2, w3, w1, w2, h, m, kv1;          /* Q20 */
        if (!fixed && (i == 0 || cv[i] != lcv)) {      /* the coefficients only when the cv moves (exactly the same values) */
            int32_t g;
            lcv = cv[i];
            g = svf_g(exp2_scale(base, mul16(lcv, cvamt)));
            gc = g;
            if (!osc && !drv)                        /* (with osc or drive stage 1 is solved again below, every sample) */
                svf_stage(&c, g, k24);
            if (st2)
                svf_stage(&d, g, SQRT2_24);
        }
        if (osc) {                                   /* the damping k + gam b^2 */
            int32_t b = clampi(ic1, -FILTER_OSC_CLIP_Q20, FILTER_OSC_CLIP_Q20);
            ke = k24 + mulr(gam, mulr(b, b, 20), 20);
        }
        if (drv) {                                   /* plus r (1 - sat(a) / a), a = drive r |bp| */
            int64_t a = ((int64_t)(ic1 < 0 ? -ic1 : ic1) * dr) >> 16;
            ke = (osc ? ke : k24) + mulr(r24, filter_drive_loss(a > FILTER_DRIVE_TOP_Q20 ? FILTER_DRIVE_TOP_Q20 : (int32_t)a), 24);
        }
        if (osc || drv)
            svf_stage(&c, gc, ke);
        v3 = v0 - ic2;
        v1 = mulr(c.a1, ic1, 24) + mulr(c.a2, v3, 24);
        v2 = ic2 + mulr(c.a2, ic1, 24) + mulr(c.a3, v3, 24);
        ic1 = clampi(2 * v1 - ic1, -(1 << 30), 1 << 30);
        ic2 = clampi(2 * v2 - ic2, -(1 << 30), 1 << 30);
        kv1 = mulr(v1, osc || drv ? ke : k24, 24);
        h = v0 - kv1 - v2;
        lp[i] = (v2 + 8) >> 4;
        bp[i] = (v1 + 8) >> 4;
        hp[i] = (h + 8) >> 4;
        if (st2) {
            w3 = v2 - jc2;
            w1 = mulr(d.a1, jc1, 24) + mulr(d.a2, w3, 24);
            w2 = jc2 + mulr(d.a2, jc1, 24) + mulr(d.a3, w3, 24);
            jc1 = clampi(2 * w1 - jc1, -(1 << 30), 1 << 30);
            jc2 = clampi(2 * w2 - jc2, -(1 << 30), 1 << 30);
            m = clampi(msig ? morph + mo[i] : morph, 0, 65536);
            lp24[i] = (w2 + 8) >> 4;
            mix[i] = (w2 + mul16(h - w2, m) + 8) >> 4;
        }
        if (ext) {                                                        /* from the same states: notch = in - k bp, peak = lp12 - hp, allpass = in - 2 k bp, hp6 */
            notch[i] = (v0 - kv1 + 8) >> 4;
            peak[i] = (v2 - h + 8) >> 4;
            apo[i] = (v0 - 2 * kv1 + 8) >> 4;
            /* hp + 2 bp: the MS-20 filter's 6 dB high pass (modules.ts). Read through it->out here, not a local: a ninth
             * live pointer made every filter dearer (npm run cpu-costs: filter run 29567 -> 31116 cycles; this way 25987) */
            it->out[FILTER_O_HP6][i] = (h + 2 * v1 + 8) >> 4;
        }
    }
    it->s.flt.ic1 = ic1;
    it->s.flt.ic2 = ic2;
    it->s.flt.jc1 = jc1;
    it->s.flt.jc2 = jc2;
}

static void m_filter(const node_t *nd, inst_t *it, uint32_t n)
{
    int drv = EF(it, FILTER_P_DRIVE) > 0 && EF(it, FILTER_P_RES) > 0;   /* without resonance the drive has nothing to clip */
    if (filter_over(it)) {
        if (drv)
            filter_run(nd, it, n, 1, 1);
        else
            filter_run(nd, it, n, 1, 0);
    } else if (drv)
        filter_run(nd, it, n, 0, 1);
    else
        filter_run(nd, it, n, 0, 0);
}

/* Ladder filter with drive (modules.ts `ladder`): four TPT one-poles (G = g / (1 + g), Q24) in a loop with k = 4 res.
 * The loop is solved linearly per sample (y4 = F (G^4 x + S), S the states' share, F = 1 / (1 + k G^4)), the loop input
 * u = sat(drive x - k y4) then runs through the stages; sat is v - v^3 / 6.75 up to |v| = 1.5, +-1 beyond. The
 * ordinary cutoff comes once per block from the mean of cv, cvamt and key tracking. With fm connected the coefficients
 * also follow each change in its samples. States Q20, products rounded; the saturator bounds the states, so no clamps. */
HOT int32_t lad_sat(int32_t u)   /* the saturator: v - v^3 / 6.75 up to |v| = 1.5, +-1 beyond (Q20) */
{
    if (u >= LAD_SAT_KNEE)
        return 1 << 20;
    if (u <= -LAD_SAT_KNEE)
        return -(1 << 20);
    return u - mulq(mulq(mulq(u, u, 20), u, 20), LAD_SAT_CUBE, 24);
}

/* the same saturator at a stage's input (stsat), in 32-bit products: the cubic from u in Q14 (|u| < 1.5 there, so u^2
 * Q28 and the rest fit), within 2^-14 of lad_sat and about half its cycles (three per sample) */
HOT int32_t lad_sat_st(int32_t u)
{
    int32_t q, c;
    if (u >= LAD_SAT_KNEE)
        return 1 << 20;
    if (u <= -LAD_SAT_KNEE)
        return -(1 << 20);
    q = u >> 6;                                 /* Q14 */
    c = (((q * q) >> 14) * (LAD_SAT_CUBE >> 8)) >> 16;   /* u^2 / 6.75, Q14 */
    return u - ((c * q) >> 8);
}

/* stsat (#672, a constant at each call): the saturator at the input of stages 2, 3 and 4 too */
HOT void ladder_run(const node_t *nd, inst_t *it, uint32_t n, int audio, int stsat)
{
    const esig_t *in = it->in[LADDER_I_IN], *cv = it->in[LADDER_I_CV], *fm = it->in[LADDER_I_FM];
    esig_t *lp24 = it->out[LADDER_O_LP24], *lp12 = it->out[LADDER_O_LP12];
    int32_t *s = it->s.lad.s;
    int32_t drive = EF(it, LADDER_P_DRIVE), cvamt = EF(it, LADDER_P_CVAMT);
    int32_t k24 = EF(it, LADDER_P_RES) << 10;                                     /* 4 res, Q24 */
    int32_t tr = EF(it, LADDER_P_TRACK) >= 32768 ? IT_PV(nd, it)->pitch : 0, x = tr;
    uint32_t base = hz_turns((uint32_t)EF(it, LADDER_P_CUTOFF)), i;
    int32_t G = 0, G2 = 0, G3 = 0, G4 = 0, hG = 0, F = 0;
    if (nd->conn & (1u << LADDER_I_CV)) {
        int64_t sum = 0;
        for (i = 0; i < n; i++)
            sum += cv[i];
        x += mul16(block_mean(sum, n), cvamt);
    }
#define LADDER_COEFF(octave) do {                             \
        int32_t oct = (octave);                              \
        int32_t g = svf_g(oct ? exp2_scale(base, oct) : base); \
        G = mulq(g, recip24((1 << 24) + g), 24);              \
        G2 = mulq(G, G, 24);                                 \
        G3 = mulq(G2, G, 24);                                \
        G4 = mulq(G3, G, 24);                                \
        hG = (1 << 24) - G;                                  \
        F = recip24((1 << 24) + mulq(k24, G4, 24));           \
    } while (0)
    LADDER_COEFF(x + (audio && n ? mul16(fm[0], cvamt) : 0));
    {
        int32_t s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3];     /* the states in registers, the four stages written out */
        for (i = 0; i < n; i++) {
            int32_t x20 = in[i] << 4, S, y4, u, v, y2;
            if (audio && i && fm[i] != fm[i - 1])
                LADDER_COEFF(x + mul16(fm[i], cvamt));
            S = mulr(G3, s0, 24) + mulr(G2, s1, 24) + mulr(G, s2, 24) + s3;
            S = mulr(S, hG, 24);
            y4 = mulr(F, mulr(G4, x20, 24) + S, 24);
            u = lad_sat(mulq(x20, drive, 16) - mulq(k24, y4, 24));
            v = mulr(G, u - s0, 24); u = v + s0; s0 = u + v;
            if (stsat)
                u = lad_sat_st(u);
            v = mulr(G, u - s1, 24); u = v + s1; s1 = u + v;
            y2 = u;
            if (stsat)
                u = lad_sat_st(u);
            v = mulr(G, u - s2, 24); u = v + s2; s2 = u + v;
            if (stsat)
                u = lad_sat_st(u);
            v = mulr(G, u - s3, 24); u = v + s3; s3 = u + v;
            lp24[i] = (u + 8) >> 4;
            lp12[i] = (y2 + 8) >> 4;
        }
        s[0] = s0;
        s[1] = s1;
        s[2] = s2;
        s[3] = s3;
    }
#undef LADDER_COEFF
}

#define DIODE_RINC_MAX 1288490189u   /* 0.3 of a cycle per sample: the diode mode's cutoff is held under it */

/* The Ladder's diode mode (#671, modules.ts diodeLadder): the linearised diode ladder, four coupled stages
 * (I + g M) y = z + g e1 u with M tri-diagonal [2 -1; -1 2 -1; -1 2 -1; -1 1], g = tan(pi fc / sr) / DIODE_W180,
 * trapezoidal. The tri-diagonal elimination's factors (pivot reciprocals iu0..iu3, multipliers m1..m3, Q24) come once
 * per block, or at each change of fm when it is connected, as in the Moog mode; the loop is solved linearly (y4 =
 * p3 + b3 u), then u = sat((drive x - k p3) F), F = 1 / (1 + k b3), k = DIODE_KCRIT res. The outputs times the makeup
 * mk = (1 + k) / (1 + 4 res) (Q24, once per block): the Moog mode's passband. States Q20 (the Moog mode's s). */
static void diode_run(const node_t *nd, inst_t *it, uint32_t n, int audio)
{
    const esig_t *in = it->in[LADDER_I_IN], *cv = it->in[LADDER_I_CV], *fm = it->in[LADDER_I_FM];
    esig_t *lp24 = it->out[LADDER_O_LP24], *lp12 = it->out[LADDER_O_LP12];
    int32_t *s = it->s.lad.s;
    int32_t drive = EF(it, LADDER_P_DRIVE), cvamt = EF(it, LADDER_P_CVAMT);
    int32_t k24 = mulq(EF(it, LADDER_P_RES), DIODE_KCRIT_Q24, 16);
    int32_t mk = mulq((1 << 24) + k24, recip24((1 << 24) + (EF(it, LADDER_P_RES) << 10)), 24);   /* Q24 */
    int32_t x = EF(it, LADDER_P_TRACK) >= 32768 ? IT_PV(nd, it)->pitch : 0;
    uint32_t base = hz_turns((uint32_t)EF(it, LADDER_P_CUTOFF)), i;
    int32_t g = 0, m1 = 0, m2 = 0, m3 = 0, iu0 = 0, iu1 = 0, iu2 = 0, iu3 = 0, F = 0;
    int32_t s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3];
    if (nd->conn & (1u << LADDER_I_CV)) {
        int64_t sum = 0;
        for (i = 0; i < n; i++)
            sum += cv[i];
        x += mul16(block_mean(sum, n), cvamt);
    }
    for (i = 0; i < n; i++) {
        int32_t x20 = in[i] << 4, p3, u, e0, e1, e2, e3, y0, y1, y2, y3;
        if (i == 0 || (audio && fm[i] != fm[i - 1])) {
            int32_t oct = x + (audio ? mul16(fm[i], cvamt) : 0), b3;
            uint32_t r = oct ? exp2_scale(base, oct) : base;
            g = mulq(svf_g(r > DIODE_RINC_MAX ? DIODE_RINC_MAX : r), DIODE_IW180_Q24, 24);
            iu0 = recip24((1 << 24) + 2 * g);
            m1 = mulq(g, iu0, 24);
            iu1 = recip24((1 << 24) + 2 * g - mulq(g, m1, 24));
            m2 = mulq(g, iu1, 24);
            iu2 = recip24((1 << 24) + 2 * g - mulq(g, m2, 24));
            m3 = mulq(g, iu2, 24);
            iu3 = recip24((1 << 24) + g - mulq(g, m3, 24));
            b3 = mulq(mulq(mulq(mulq(g, m1, 24), m2, 24), m3, 24), iu3, 24);
            F = recip24((1 << 24) + mulq(k24, b3, 24));
        }
        p3 = mulr(s3 + mulr(m3, s2 + mulr(m2, s1 + mulr(m1, s0, 24), 24), 24), iu3, 24);
        u = lad_sat(mulq(mulq(x20, drive, 16) - mulq(k24, p3, 24), F, 24));
        e0 = s0 + mulr(g, u, 24);
        e1 = s1 + mulr(m1, e0, 24);
        e2 = s2 + mulr(m2, e1, 24);
        e3 = s3 + mulr(m3, e2, 24);
        y3 = mulr(e3, iu3, 24);
        y2 = mulr(e2 + mulr(g, y3, 24), iu2, 24);
        y1 = mulr(e1 + mulr(g, y2, 24), iu1, 24);
        y0 = mulr(e0 + mulr(g, y1, 24), iu0, 24);
        s0 = 2 * y0 - s0;
        s1 = 2 * y1 - s1;
        s2 = 2 * y2 - s2;
        s3 = 2 * y3 - s3;
        lp24[i] = mulr(y3, mk, 28);
        lp12[i] = mulr(y1, mk, 28);
    }
    s[0] = s0;
    s[1] = s1;
    s[2] = s2;
    s[3] = s3;
}

static void m_ladder(const node_t *nd, inst_t *it, uint32_t n)
{
    /* Constant arguments remove all audio-rate checks (and the stages' saturators) from the ordinary filter loop. */
    int audio = (nd->conn & (1u << LADDER_I_FM)) != 0;
    if (EF(it, LADDER_P_DIODE) >= 32768)
        diode_run(nd, it, n, audio);
    else if (EF(it, LADDER_P_STSAT) >= 32768) {
        if (audio)
            ladder_run(nd, it, n, 1, 1);
        else
            ladder_run(nd, it, n, 0, 1);
    } else if (audio)
        ladder_run(nd, it, n, 1, 0);
    else
        ladder_run(nd, it, n, 0, 0);
}

#define DB_TO_LOG2 10885            /* 1 / 6.0206 in Q16: dB -> octaves (log2) */

/* Envelope follower and compressor (modules.ts `dyn`): a peak follower (Q24, attack / release rates Q30 as the glide) of
 * |side| (or |in|), out = in x gain with gain = 2^(makeup - slope (log2 env - log2 thresh)) above the threshold, the
 * makeup alone below it; env output Q16. One log2_q16 + exp2_q16 per sample while above the threshold. */
static void m_dyn(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[DYN_I_IN], *det = nd->conn & (1u << DYN_I_SIDE) ? it->in[DYN_I_SIDE] : in;
    esig_t *out = it->out[DYN_O_OUT], *eo = it->out[DYN_O_ENV];
    int32_t ka = env_rate(EF(it, DYN_P_ATTACK)), kr = env_rate(EF(it, DYN_P_RELEASE)), env = it->s.dyn.env;
    int32_t thr_log = mul16(EF(it, DYN_P_THRESH), DB_TO_LOG2), makeup_log = mul16(EF(it, DYN_P_GAIN), DB_TO_LOG2);
    int32_t ratio = EF(it, DYN_P_RATIO) < ENG_ONE ? ENG_ONE : EF(it, DYN_P_RATIO);
    int32_t slope = ENG_ONE - (int32_t)((1ull << 32) / (uint32_t)ratio);                 /* 1 - 1 / ratio */
    int32_t thr24 = (int32_t)exp2_q16(thr_log + (24 << 16)), makeup = (int32_t)exp2_q16(makeup_log + (16 << 16));   /* (exp2_q16 gives a plain integer: + 16 octaves for Q16, + 24 for Q24) */
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t a = det[i] < 0 ? -det[i] : det[i], g;
        a = (a > (1 << 23) - 1 ? (1 << 23) - 1 : a) << 8;
        env += mulq(a > env ? ka : kr, a - env, 30);
        if (env > thr24)
            g = (int32_t)exp2_q16((16 << 16) + makeup_log - mul16(slope, log2_q16((uint32_t)env) - (24 << 16) - thr_log));
        else
            g = makeup;
        out[i] = mul16(in[i], g);
        eo[i] = (env + 128) >> 8;
    }
    it->s.dyn.env = env;
}

#define LOG2_C4_Q16 526343            /* log2(261.6255653 Hz): pitch 0 */
#define ESP_K_HZ 12282814ull          /* 4.6 / (2 pi) in Q24: a one-pole at f Hz is env_rate's curve over 4.6 / (2 pi f) s */

/* a one-pole's coefficient for a corner at hz (Q16 Hz): 1 - exp(-2 pi f / sr), Q30 */
static int32_t esp_k(int32_t hz)
{
    return env_rate_q8((ESP_K_HZ * ENG_SR) / (uint32_t)(hz < ENG_ONE ? ENG_ONE : hz));
}

/* Follower (modules.ts esp), after the Korg MS-20's External Signal Processor: amp = in x level; an envelope follower on
 * |amp| (env) with a trigger (up above thresh, down below 3/4 of it); a band pass, a one-pole high pass at lowcut then a
 * one-pole low pass at highcut (bp); a pitch to voltage converter: bp's period between rising crossings of +h after it went
 * below -h (h = a quarter of bp's peak hold), each crossing placed between its samples, as log2(f / C4) + cvadj, through a
 * short glide. One division per crossing (32-bit) and one log2_q16 per measured period. Nothing on `in`: it rests. */
static void m_esp(const node_t *nd, inst_t *it, uint32_t n)
{
    esig_t *amp = it->out[ESP_O_AMP], *bp = it->out[ESP_O_BP], *po = it->out[ESP_O_PITCH], *eo = it->out[ESP_O_ENV], *to = it->out[ESP_O_TRIG];
    int32_t adj = EF(it, ESP_P_CVADJ) / 12;                                    /* semitones -> octaves */
    int32_t env = it->s.esp.env, lc = it->s.esp.lc, hc = it->s.esp.hc, pk = it->s.esp.pk, prev = it->s.esp.prev;
    int32_t y = it->s.esp.y, frac = it->s.esp.frac, t = it->s.esp.t;
    uint32_t cnt = it->s.esp.cnt, i;
    uint8_t trig = it->s.esp.trig, arm = it->s.esp.arm, valid = it->s.esp.valid;
    if (!(nd->conn & (1u << ESP_I_IN))) {                                      /* at rest, the pitch held (modules.ts espRest) */
        it->s.esp.env = it->s.esp.lc = it->s.esp.hc = it->s.esp.pk = it->s.esp.prev = it->s.esp.frac = 0;
        it->s.esp.cnt = 0;
        it->s.esp.trig = it->s.esp.arm = it->s.esp.valid = 0;
        fill(amp, 0, n);
        fill(bp, 0, n);
        fill(eo, 0, n);
        fill(to, 0, n);
        fill(po, ((y + 128) >> 8) + adj, n);
        return;
    }
    {
        const esig_t *in = it->in[ESP_I_IN];
        int32_t level = EF(it, ESP_P_LEVEL), th = clampi(EF(it, ESP_P_THRESH), 0, ENG_ONE) << 8, off = th - (th >> 2);
        int32_t ka = env_rate(ESP_ATTACK_Q16), kr = env_rate(ESP_RELEASE_Q16);
        int32_t kl = esp_k(EF(it, ESP_P_LOWCUT)), kh = esp_k(EF(it, ESP_P_HIGHCUT));
        int32_t base = log2_q16(ENG_SR) + (16 << 16) - LOG2_C4_Q16;            /* log2(sr / C4) + 16: per is Q16 */
        for (i = 0; i < n; i++) {
            int32_t x = clampi(mul16(in[i], level), -ESP_CLIP_Q16, ESP_CLIP_Q16), a, b, ab, h;
            amp[i] = x;
            x <<= 8;                                                           /* Q24, +-2^28 */
            a = x < 0 ? -x : x;
            env += mulq(a > env ? ka : kr, a - env, 30);
            if (trig ? env < off : env > th)
                trig ^= 1u;
            lc += mulq(kl, x - lc, 30);
            hc += mulq(kh, x - lc - hc, 30);
            b = hc;
            ab = b < 0 ? -b : b;
            pk = ab > pk ? ab : pk - (pk >> ESP_PEAK_SHIFT);
            h = pk >> 2;
            if (++cnt > ESP_MAX_PERIOD) {
                cnt = ESP_MAX_PERIOD;
                valid = 0;
            }
            if (pk >= ESP_FLOOR_Q24) {
                if (b < -h)
                    arm = 1;
                else if (arm && b >= h) {
                    int32_t f = 0, per;
                    if (b > prev) {                                            /* (b - h) / (b - prev), Q16, at most 1 */
                        uint32_t num = (uint32_t)(b - h), den = (uint32_t)(b - prev);
                        if (num >= den)
                            f = ENG_ONE;
                        else {
                            while (den >= 1u << 15) {
                                num >>= 1;
                                den >>= 1;
                            }
                            f = (int32_t)((num << 16) / den);
                        }
                    }
                    per = (int32_t)(cnt << 16) - f + frac;
                    if (valid && per >= (ESP_MIN_PERIOD << 16))
                        t = base - log2_q16((uint32_t)per);
                    arm = 0;
                    valid = 1;
                    cnt = 0;
                    frac = f;
                }
            }
            prev = b;
            y += ((t << 8) - y) >> ESP_GLIDE_SHIFT;
            bp[i] = (b + 128) >> 8;
            po[i] = ((y + 128) >> 8) + adj;
            eo[i] = (env + 128) >> 8;
            to[i] = trig ? ENG_ONE : 0;
        }
    }
    it->s.esp.env = env;
    it->s.esp.lc = lc;
    it->s.esp.hc = hc;
    it->s.esp.pk = pk;
    it->s.esp.prev = prev;
    it->s.esp.y = y;
    it->s.esp.cnt = cnt;
    it->s.esp.frac = frac;
    it->s.esp.t = t;
    it->s.esp.trig = trig;
    it->s.esp.arm = arm;
    it->s.esp.valid = valid;
}

/* Most utility modules feed one output. Pick that operation once per block instead of calculating every unused one. */
static int only_output(const inst_t *it, uint32_t count)
{
    uint32_t i;
    int found = -1;
    for (i = 0; i < count; i++) if (!IS_DUMMY(it->out[i])) {
        if (found >= 0)
            return -1;
        found = (int)i;
    }
    return found;
}

HOT int32_t bit_xor(int32_t a, int32_t b)
{
    return (clampi(a >> 1, -32768, 32767) ^ clampi(b >> 1, -32768, 32767)) * 2;
}

static void m_math(const node_t *nd, inst_t *it, uint32_t n)      /* modules.ts `math`: a' = a ka + off, b' = b kb */
{
    const esig_t *ia = it->in[MATH_I_A], *ib = it->in[MATH_I_B];
    esig_t **o = it->out;
    int32_t ka = EF(it, MATH_P_KA), kb = EF(it, MATH_P_KB), off = EF(it, MATH_P_OFF);
    uint32_t i, k, used = 0;
    for (k = 0; k < MATH_NOUT; k++)
        if (!IS_DUMMY(o[k]))
            used += o[k] == ia || o[k] == ib ? 8u : 1u;   /* (an output fed back into an input: one pass, as below) */
    if (used <= 3u) {                            /* up to three outputs in use: a pass for each, the rest write nothing (#781) */
        for (k = 0; k < MATH_NOUT; k++) {
            esig_t *dst = o[k];
            if (IS_DUMMY(dst))
                continue;
#define MATH_ONE(Y) for (i = 0; i < n; i++) { int32_t a = mul16(ia[i], ka) + off, b = mul16(ib[i], kb); (void)b; dst[i] = (Y); }
            switch (k) {
            case MATH_O_ADD: MATH_ONE(a + b) break;
            case MATH_O_SUB: MATH_ONE(a - b) break;
            case MATH_O_MUL: MATH_ONE(mul16(a, b)) break;
            case MATH_O_MIN: MATH_ONE(a < b ? a : b) break;
            case MATH_O_MAX: MATH_ONE(a > b ? a : b) break;
            case MATH_O_ABS: MATH_ONE(a < 0 ? -a : a) break;
            case MATH_O_CMP: MATH_ONE(a > b ? ENG_ONE : 0) break;
            case MATH_O_XOR: MATH_ONE(bit_xor(a, b)) break;
            }
#undef MATH_ONE
        }
        return;
    }
    for (i = 0; i < n; i++) {
        int32_t a = mul16(ia[i], ka) + off, b = mul16(ib[i], kb);
        o[MATH_O_ADD][i] = a + b;
        o[MATH_O_SUB][i] = a - b;
        o[MATH_O_MUL][i] = mul16(a, b);
        o[MATH_O_MIN][i] = a < b ? a : b;
        o[MATH_O_MAX][i] = a > b ? a : b;
        o[MATH_O_ABS][i] = a < 0 ? -a : a;
        o[MATH_O_CMP][i] = a > b ? ENG_ONE : 0;
        if (!IS_DUMMY(o[MATH_O_XOR]))
            o[MATH_O_XOR][i] = bit_xor(a, b);
    }
    (void)nd;
}

static void m_logic(const node_t *nd, inst_t *it, uint32_t n)     /* modules.ts `logic`: gates high at or above thresh */
{
    const esig_t *ia = it->in[LOGIC_I_A], *ib = it->in[LOGIC_I_B];
    esig_t **o = it->out;
    int32_t t = EF(it, LOGIC_P_THRESH);
    uint32_t i;
    int only = only_output(it, LOGIC_NOUT);
    if (only >= 0) {
        esig_t *dst = o[only];
#define LOGIC_ONE(Y) for (i = 0; i < n; i++) { int a = ia[i] >= t, b = ib[i] >= t; (void)b; dst[i] = (Y) ? ENG_ONE : 0; }
        switch (only) {
        case LOGIC_O_AND: LOGIC_ONE(a && b) break;
        case LOGIC_O_OR: LOGIC_ONE(a || b) break;
        case LOGIC_O_XOR: LOGIC_ONE(a != b) break;
        case LOGIC_O_NOT: LOGIC_ONE(!a) break;
        }
#undef LOGIC_ONE
        return;
    }
    for (i = 0; i < n; i++) {
        int a = ia[i] >= t, b = ib[i] >= t;
        o[LOGIC_O_AND][i] = a && b ? ENG_ONE : 0;
        o[LOGIC_O_OR][i] = a || b ? ENG_ONE : 0;
        o[LOGIC_O_XOR][i] = a != b ? ENG_ONE : 0;
        o[LOGIC_O_NOT][i] = a ? 0 : ENG_ONE;
    }
    (void)nd;
}

/* the delay and granular lines hold Q13 (+-4.0) in int16: half the memory of Q16 in int32, 1.2e-4 resolution */
static inline int16_t dly_pack(int32_t v)
{
    int32_t q = (v + 4) >> 3;
    return (int16_t)clampi(q, -32768, 32767);
}

/* Granular (modules.ts `grain`): records in into a 1 s line (Q13), plays up to GRAIN_MAX Hann-windowed grains from it.
 * A grain starts `density` times a second (Q24 accumulator) or on a rising edge of trig, at `position` of the span back
 * from the write head plus a random spray, and reads `size` seconds at 2^(pitch in + pitch / 12) (clamped to +-GRAIN_OCT
 * octaves), linearly interpolated. The window is sin^2 of half a turn over the grain (sin_turn). The line is int16 Q13 like the delay's. */
static void grain_spawn(inst_t *it, uint32_t len, uint32_t span, uint32_t rate, uint32_t avail, int32_t position, uint32_t sprayS)
{
    grain_line_t *ln = it->s.gr.ln;
    grain_t *g = 0;
    uint32_t k, rnd, off, back;
    for (k = 0; k < GRAIN_MAX; k++)
        if (ln->g[k].left == 0u) {
            g = &ln->g[k];
            break;
        }
    it->s.gr.seed = it->s.gr.seed * 1664525u + 1013904223u;
    if (!g)
        return;
    rnd = it->s.gr.seed >> 8;                                            /* Q24, 0 .. 1 */
    off = (uint32_t)mul16(position, (int32_t)avail) + (uint32_t)(((uint64_t)rnd * sprayS) >> 24);
    if (off > avail)
        off = avail;
    back = span + off;
    g->start = it->s.gr.w >= back ? it->s.gr.w - back : it->s.gr.w + GRAIN_LEN - back;
    g->rp = 0;
    g->rate = rate;
    g->wph = 0;
    g->winc = 0x80000000u / len;
    g->left = len;
}

static void m_grain(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[GRAIN_I_IN], *trig = it->in[GRAIN_I_TRIG];
    esig_t *out = it->out[0];
    grain_line_t *ln = it->s.gr.ln;
    int16_t *buf = ln->buf;
    uint32_t w = it->s.gr.w, acc = it->s.gr.acc, i, k;
    uint32_t dinc = (uint32_t)(((uint64_t)(uint32_t)EF(it, GRAIN_P_DENSITY) << 8) / ENG_SR);     /* grains per sample, Q24 */
    int32_t oct = clampi(it->in[GRAIN_I_PITCH][0] + EF(it, GRAIN_P_PITCH) / 12, -(GRAIN_OCT << 16), GRAIN_OCT << 16);
    uint32_t rate = exp2_q16(oct + (16 << 16));                         /* Q16 */
    uint32_t len = (uint32_t)(((int64_t)EF(it, GRAIN_P_SIZE) * ENG_SR + 32768) >> 16), span, avail;
    uint32_t sprayS = (uint32_t)mul16(EF(it, GRAIN_P_SPRAY), GRAIN_SPRAY);
    int32_t position = EF(it, GRAIN_P_POSITION), mix = EF(it, GRAIN_P_MIX), dry = ENG_ONE - mix;
    int freeze = EF(it, GRAIN_P_FREEZE) >= 32768, prev = it->s.gr.prev;
    if (len < 1u)
        len = 1u;
    span = (uint32_t)(((uint64_t)len * rate) >> 16) + 1u;
    if (span > GRAIN_LEN - 2u) {
        len = (uint32_t)(((uint64_t)(GRAIN_LEN - 2u) << 16) / rate);
        span = (uint32_t)(((uint64_t)len * rate) >> 16) + 1u;
    }
    avail = GRAIN_LEN - 1u - span;
    for (i = 0; i < n; i++) {
        int32_t x = in[i], sum = 0;
        int tr = trig[i] >= 32768;
        acc += dinc;
        it->s.gr.w = w;                                                  /* (a grain starts from the write head of this sample) */
        if (acc >= (1u << 24)) {
            acc -= 1u << 24;
            grain_spawn(it, len, span, rate, avail, position, sprayS);
        }
        if (tr && !prev)
            grain_spawn(it, len, span, rate, avail, position, sprayS);
        prev = tr;
        for (k = 0; k < GRAIN_MAX; k++) {
            grain_t *g = &ln->g[k];
            uint32_t i0, i1;
            int32_t s0, s1, v, sn;
            if (!g->left)
                continue;
            i0 = g->start + (g->rp >> 16);
            if (i0 >= GRAIN_LEN)
                i0 -= GRAIN_LEN;
            i1 = i0 + 1u == GRAIN_LEN ? 0u : i0 + 1u;
            s0 = (int32_t)buf[i0] * 8;
            s1 = (int32_t)buf[i1] * 8;
            v = s0 + mulq(s1 - s0, (int32_t)(g->rp & 0xFFFFu), 16);
            sn = sin_turn(g->wph);
            sum += mul16(v, mulq(sn, sn, 16));
            g->rp += g->rate;
            g->wph += g->winc;
            g->left--;
        }
        if (!freeze) {
            buf[w] = dly_pack(x);
            if (++w == GRAIN_LEN)
                w = 0;
        }
        out[i] = mul16(x, dry) + mul16(sum, mix);
    }
    it->s.gr.w = w;
    it->s.gr.acc = acc;
    it->s.gr.prev = (uint8_t)prev;
    (void)nd;
}

/* the Hilbert pair's a^2 in Q30 (modules.ts HILBERT_A / HILBERT_B) */
static const int32_t HILB_A2[4] = {514754545, 940817629, 1048585287, 1071056860};
static const int32_t HILB_B2[4] = {173707895, 787158236, 1015003234, 1063657107};

static inline int32_t hilbert16(int32_t *s, const int32_t *a2, int32_t x)      /* one chain: w = x + a^2 w2, y = a^2 w - w2; s = w1 w2 per section */
{
    uint32_t k;
    for (k = 0; k < 4u; k++) {
        int32_t *o = s + 2 * k;
        int32_t w = x + mulr(a2[k], o[1], 30);
        x = mulr(a2[k], w, 30) - o[1];
        o[1] = o[0];
        o[0] = w;
    }
    return x;
}

/* Frequency shifter (modules.ts shift): I = chain A one sample late, Q = chain B; up = I cos + Q sin, down = I cos - Q sin
 * at shift + cv x cvamt Hz (per block). Signals Q16, allpass coefficients Q30, the oscillator sin_turn. */
static void m_shift(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SHIFT_I_IN], *cv = it->in[SHIFT_I_CV];
    esig_t *up = it->out[SHIFT_O_UP], *down = it->out[SHIFT_O_DOWN];
    int32_t hz = EF(it, SHIFT_P_SHIFT), mix = EF(it, SHIFT_P_MIX), dry = ENG_ONE - mix, ia = it->s.fs.ia;
    uint32_t phase = it->s.fs.phase, inc, i;
    if (nd->conn & (1u << SHIFT_I_CV)) {
        int64_t sum = 0;
        for (i = 0; i < n; i++)
            sum += cv[i];
        hz += mul16(block_mean(sum, n), EF(it, SHIFT_P_CVAMT));
    }
    inc = (uint32_t)(((int64_t)hz << 16) / (int32_t)ENG_SR);                 /* Hz Q16 -> turns per sample in u32 (negative wraps) */
    for (i = 0; i < n; i++) {
        int32_t x = in[i], I = ia, Q, co, si;
        ia = hilbert16(it->s.fs.a, HILB_A2, x);
        Q = hilbert16(it->s.fs.b, HILB_B2, x);
        co = sin_turn(phase + 0x40000000u);
        si = sin_turn(phase);
        phase += inc;
        up[i] = mul16(x, dry) + mul16(mul16(I, co) + mul16(Q, si), mix);
        down[i] = mul16(x, dry) + mul16(mul16(I, co) - mul16(Q, si), mix);
    }
    it->s.fs.ia = ia;
    it->s.fs.phase = phase;
}

static void m_mixer(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *a = it->in[MIXER_I_IN1], *b = it->in[MIXER_I_IN2], *c = it->in[MIXER_I_IN3], *d = it->in[MIXER_I_IN4];
    esig_t *out = it->out[0];
    int32_t la = EF(it, MIXER_P_L1), lb = EF(it, MIXER_P_L2), lc = EF(it, MIXER_P_L3), ld = EF(it, MIXER_P_L4);
    const esig_t *x[4];
    int32_t l[4];
    uint32_t i, k = 0;
    /* only the inputs that add something: an unplugged one reads the zero buffer, a level of 0 adds 0 (#781) */
#define MIXER_TAKE(p, lv) if ((p) != zero_buf && (lv)) { x[k] = (p); l[k] = (lv); k++; }
    MIXER_TAKE(a, la)
    MIXER_TAKE(b, lb)
    MIXER_TAKE(c, lc)
    MIXER_TAKE(d, ld)
#undef MIXER_TAKE
    (void)nd;
    switch (k) {
    case 0:
        fill(out, 0, n);
        break;
    case 1:
        for (i = 0; i < n; i++)
            out[i] = mul16(x[0][i], l[0]);
        break;
    case 2: {
        const esig_t *x0 = x[0], *x1 = x[1];
        const int32_t l0 = l[0], l1 = l[1];
        for (i = 0; i < n; i++)
            out[i] = mul16(x0[i], l0) + mul16(x1[i], l1);
        break;
    }
    case 3: {
        const esig_t *x0 = x[0], *x1 = x[1], *x2 = x[2];
        const int32_t l0 = l[0], l1 = l[1], l2 = l[2];
        for (i = 0; i < n; i++)
            out[i] = mul16(x0[i], l0) + mul16(x1[i], l1) + mul16(x2[i], l2);
        break;
    }
    default:
        for (i = 0; i < n; i++)
            out[i] = mul16(a[i], la) + mul16(b[i], lb) + mul16(c[i], lc) + mul16(d[i], ld);
    }
}


/* the note length the time knob selects while the delay is synced: 1..DELAY_SYNC_TOP ms split into DELAY_NDIV steps, a time
 * past it the longest (modules.ts delayDivIndex; also used by the LCD) */
uint32_t delay_div(int32_t time_q16)
{
    int64_t lo = DEFS[T_DELAY].pmin[DELAY_P_TIME], range = (int64_t)DELAY_SYNC_TOP * 65536 - lo;
    int64_t i = (((int64_t)time_q16 - lo) * (DELAY_NDIV - 1) * 2 + range) / (range * 2);
    return (uint32_t)(i < 0 ? 0 : i > DELAY_NDIV - 1 ? DELAY_NDIV - 1 : i);
}

/* (a b) >> 32: one multiply-high. mul16(a, b) is mulh32(a << 8, b << 8) exactly while a and b fit 24 bits, and
 * mulh32(e << 13, g << 3) while e fits 19 bits (a line sample read between two: |e| <= 2^18) */
HOT int32_t mulh32(int32_t a, int32_t b) { return (int32_t)(((int64_t)a * b) >> 32); }
#define MUL_E(e, g) mulh32((e) * 8192, (g) * 8)   /* mul16(e, g), e a line read (|e| <= 2^18), |g| < 2^28 */

/* the swelling delay's soft clip (modules.ts delayClip): x - 4/27 x^3, flat at +-1 from |x| = 1.5. Under 1.5 (2^17 Q16)
 * the products are multiply-highs (mul16 exactly: x x >> 16 < 2^18, s x >> 16 < 221,182, whose 9709 times fits 32 bits) */
static inline int32_t dly_soft(int32_t x)
{
    int32_t s, t;
    if (x >= 98304)
        return ENG_ONE;
    if (x <= -98304)
        return -ENG_ONE;
    s = mulh32(x * 256, x * 256);
    t = mulh32(s * 256, x * 256);
    return x - ((t * 9709) >> 16);                       /* 4/27 Q16 */
}

/* the delay's glide (modules.ts delayGlide, #484): while the read position's distance behind the write head (cur, samples
 * Q16) is not the time's (tq), it moves at a rate (samples a sample, Q16) that heads for 1 / 2^DELAY_GLIDE_SHIFT of the
 * distance, at most DELAY_GLIDE_MAX (half a sample: the echo plays between an octave down and a fifth up while it moves,
 * never backwards); the rate itself changes by at most DELAY_GLIDE_ACC a sample (the pitch bends in, no kink in the wave).
 * It lands once less than 1/64 sample away at a rate under DELAY_GLIDE_ACC. The line is read between its two samples
 * (linear). The plain, swelling and ping-pong loops in one: it runs only while the time moves. */
#define DELAY_GLIDE_SHIFT 10             /* 1024 samples: 23 ms */
#define DELAY_GLIDE_MAX 32768            /* half a sample a sample, Q16 */
#define DELAY_GLIDE_ACC 128              /* the rate's change a sample: 0 to DELAY_GLIDE_MAX in 256 samples (6 ms) */
#define DLY_HOLD 0x40000000             /* rate past it: a new rate's hold, the samples left past it (dly_change) */
static void __attribute__((noinline)) dly_glide(inst_t *it, const esig_t *in, esig_t *out, esig_t *outr, uint32_t n, int64_t tq, int32_t fb, int32_t mix, int pp, int swell)
{
    int16_t *buf = it->s.dly.buf, *bb = buf + it->s.dly.len / 2u;
    uint32_t len = pp ? it->s.dly.len / 2u : it->s.dly.len, w = it->s.dly.w, i;
    int32_t dry = ENG_ONE - mix, rate = it->s.dly.rate;
    int64_t cur = it->s.dly.cur, hi = (int64_t)(len - 1u) << 16;  /* (64 bits: a 1.6 s line is more samples than Q16 holds in 32) */
    if (swell)
        fb = (int32_t)((int64_t)fb * DELAY_SWELL_NUM / DELAY_SWELL_DEN);
    if (w >= len)
        w = 0;
    for (i = 0; i < n; i++) {
        int64_t diff = tq - cur, rpos, c;
        int32_t fr, ea, x, step = (int32_t)(diff >> DELAY_GLIDE_SHIFT);
        uint32_t i0, i1;
        rate += clampi(clampi(step, -DELAY_GLIDE_MAX, DELAY_GLIDE_MAX) - rate, -DELAY_GLIDE_ACC, DELAY_GLIDE_ACC);
        if (diff > -(1 << DELAY_GLIDE_SHIFT) && diff < 1 << DELAY_GLIDE_SHIFT && rate > -DELAY_GLIDE_ACC && rate < DELAY_GLIDE_ACC) {
            cur = tq;
            rate = 0;
        } else {
            c = cur + rate;            /* (past the target only when it turned while moving: kept within the line) */
            cur = c < 65536 ? 65536 : c > hi ? hi : c;
        }
        rpos = ((int64_t)w << 16) - cur;
        if (rpos < 0)
            rpos += (int64_t)len << 16;
        i0 = (uint32_t)(rpos >> 16);
        i1 = i0 + 1u == len ? 0u : i0 + 1u;
        fr = (int32_t)(rpos & 0xffff) >> 1;           /* Q15: (b - a) x fr fits 32 bits */
        ea = (int32_t)buf[i0] * 8 + ((((int32_t)buf[i1] - buf[i0]) * fr) >> 12);
        if (pp) {
            int32_t eb = (int32_t)bb[i0] * 8 + ((((int32_t)bb[i1] - bb[i0]) * fr) >> 12), dr = mul16(in[i], dry);
            x = MUL_E(ea, fb);
            bb[w] = dly_pack(swell ? dly_soft(x) : x);
            x = in[i] + MUL_E(eb, fb);
            buf[w] = dly_pack(swell ? dly_soft(x) : x);
            out[i] = dr + MUL_E(ea, mix);
            outr[i] = dr + MUL_E(eb, mix);
        } else {
            x = in[i] + MUL_E(ea, fb);
            buf[w] = dly_pack(swell ? dly_soft(x) : x);
            out[i] = mul16(in[i], dry) + MUL_E(ea, mix);
            outr[i] = out[i];
        }
        if (++w == len)
            w = 0;
    }
    it->s.dly.w = w;
    it->s.dly.cur = cur;
    it->s.dly.rate = rate;
}

/* a lower rate's low pass over a block (modules.ts delaySlow): two sections in direct form I, lp their state (x1 x2 u1 u2
 * v1 v2 y1 y2, Q26; the second section's input is the first's output, so v1 v2 are always u1 u2 and only stored), c their
 * coefficients (DELAY_AA, Q30). Each product is one multiply-high (Q24), so a section loses the lowest two bits of Q26 to
 * its three roundings: about -140 dB. The input is clamped to +-4, what the line holds. ys gets the filtered input (Q16)
 * at each sample the line is written (ph = k - 1, counting from ph). A pass of its own, so the line's loop keeps its
 * registers. */
static void dly_aa(int32_t *lp, const int32_t *c, const esig_t *in, uint32_t n, uint32_t ph, uint32_t k, int32_t *ys)
{
    const int32_t c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3], c4 = c[4], c5 = c[5];
    int32_t x1 = lp[0], x2 = lp[1], u1 = lp[2], u2 = lp[3], y1 = lp[6], y2 = lp[7];
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t x = clampi(in[i], -4 * ENG_ONE, 4 * ENG_ONE) * 1024, u, y;   /* Q26 */
        u = (mulh32(c0, x + 2 * x1 + x2) - mulh32(c1, u1) - mulh32(c2, u2)) * 4;
        y = (mulh32(c3, u + 2 * u1 + u2) - mulh32(c4, y1) - mulh32(c5, y2)) * 4;
        x2 = x1; x1 = x; u2 = u1; u1 = u; y2 = y1; y1 = y;
        if (ph == k - 1u) {
            *ys++ = (y + 512) >> 10;
            ph = 0;
        } else
            ph++;
    }
    lp[0] = x1; lp[1] = x2; lp[2] = lp[4] = u1; lp[3] = lp[5] = u2; lp[6] = y1; lp[7] = y2;
}

/* dly_pack of dly_soft: within +-1, so the clamp never acts */
#define DLY_PACK_SOFT(x) ((int16_t)((dly_soft(x) + 4) >> 3))

/* dly_slow's loop while the time stands (rdi, rdf: its distance in line samples, Q16, rounded up), for pp and swell known
 * at the call, so that each case keeps its state in registers */
HOT void slow_fast(const int pp, const int swell, int16_t *buf, uint32_t nl, uint32_t sh, uint32_t *wp, uint32_t *php,
                   int32_t rdi, int32_t rdf, const esig_t *in, const int32_t *yp, esig_t *out, esig_t *outr, uint32_t n,
                   int32_t fb, int32_t mix)
{
    int16_t *bb = buf + nl;
    const uint32_t k1 = (1u << sh) - 1u;
    const int32_t sub = (int32_t)(65536u >> sh), dry = ENG_ONE - mix;
    uint32_t w = *wp, ph = *php, i;
    for (i = 0; i < n; i++) {
        int32_t t = ((int32_t)ph - (int32_t)k1) * sub - rdf, i0 = (int32_t)w - rdi + (t >> 16), i1, fr, ea, eb = 0;
        if (i0 < 0)
            i0 += (int32_t)nl;
        i1 = i0 + 1 == (int32_t)nl ? 0 : i0 + 1;
        fr = (t & 0xffff) >> 1;                       /* Q15 */
        ea = (int32_t)buf[i0] * 8 + ((((int32_t)buf[i1] - buf[i0]) * fr) >> 12);
        if (pp)
            eb = (int32_t)bb[i0] * 8 + ((((int32_t)bb[i1] - bb[i0]) * fr) >> 12);
        if (ph == k1) {
            int32_t v;
            if (pp) {
                v = MUL_E(ea, fb);
                bb[w] = swell ? DLY_PACK_SOFT(v) : dly_pack(v);
                v = *yp++ + MUL_E(eb, fb);
            } else
                v = *yp++ + MUL_E(ea, fb);
            buf[w] = swell ? DLY_PACK_SOFT(v) : dly_pack(v);
            ph = 0;
            if (++w == nl)
                w = 0;
        } else
            ph++;
        {
            int32_t dr = mul16(in[i], dry);
            out[i] = dr + MUL_E(ea, mix);
            outr[i] = pp ? dr + MUL_E(eb, mix) : out[i];
        }
    }
    *wp = w;
    *php = ph;
}

/* the Delay at a lower rate (modules.ts delaySlow, #659: RATE 22k / 11k, k = 1 << sh samples a line sample): the input
 * through a 4-pole low pass (dly_aa, its state in the DELAY_TAIL samples after the line, which is `len` samples), every
 * k-th sample of it with the feedback written to the line; every sample reads the line between two of its samples
 * (linear) at the time's distance behind the write head (cur, samples Q16), so the time keeps its sample resolution. A
 * moving time glides as in dly_glide. Plain, swelling and ping-pong in one loop. */
static void __attribute__((noinline)) dly_slow(inst_t *it, const esig_t *in, esig_t *out, esig_t *outr, uint32_t n, int64_t tq, int32_t fb, int32_t mix, int pp, int swell, uint32_t sh, uint32_t len)
{
    const uint32_t k = 1u << sh, H = len / 2u, nl = pp ? H : len;
    const int32_t sub = (int32_t)(65536u >> sh);      /* a sample in line samples, Q16 */
    int16_t *buf = it->s.dly.buf, *bb = buf + H;
    int32_t ys[ENG_BLOCK / 2u], *yp = ys;           /* the filtered input at the line's writes (k >= 2: at most n / 2) */
    int moving = it->s.dly.cur != tq || it->s.dly.rate;   /* (a flag: the 64-bit compare every sample cost more) */
    uint32_t w = it->s.dly.w, ph = it->s.dly.ph, i;
    int32_t dry = ENG_ONE - mix, rate = it->s.dly.rate, rdi, rdf;
    int64_t cur = it->s.dly.cur, lo = (int64_t)k << 16, hi = ((int64_t)(nl - 1u) << sh) << 16, rd;
    dly_aa((int32_t *)(void *)(buf + len), DELAY_AA[sh - 1u], in, n, ph, k, ys);   /* (len is even: 4-byte aligned) */
    if (swell)
        fb = (int32_t)((int64_t)fb * DELAY_SWELL_NUM / DELAY_SWELL_DEN);
    if (w >= nl)
        w = 0;
    rd = (cur + (int64_t)k - 1) >> sh;              /* the distance in line samples, rounded up (Q16) */
    rdi = (int32_t)(rd >> 16);
    rdf = (int32_t)(rd & 0xffff);
    if (!moving) {
        if (pp) {
            if (swell) slow_fast(1, 1, buf, nl, sh, &w, &ph, rdi, rdf, in, ys, out, outr, n, fb, mix);
            else slow_fast(1, 0, buf, nl, sh, &w, &ph, rdi, rdf, in, ys, out, outr, n, fb, mix);
        } else {
            if (swell) slow_fast(0, 1, buf, nl, sh, &w, &ph, rdi, rdf, in, ys, out, outr, n, fb, mix);
            else slow_fast(0, 0, buf, nl, sh, &w, &ph, rdi, rdf, in, ys, out, outr, n, fb, mix);
        }
        n = 0;
    }
    for (i = 0; i < n; i++) {
        int32_t fr, ea, eb = 0, t, i0, i1;
        if (moving) {
            int64_t diff = tq - cur, cc;
            int32_t step = (int32_t)(diff >> DELAY_GLIDE_SHIFT);
            rate += clampi(clampi(step, -DELAY_GLIDE_MAX, DELAY_GLIDE_MAX) - rate, -DELAY_GLIDE_ACC, DELAY_GLIDE_ACC);
            if (diff > -(1 << DELAY_GLIDE_SHIFT) && diff < 1 << DELAY_GLIDE_SHIFT && rate > -DELAY_GLIDE_ACC && rate < DELAY_GLIDE_ACC) {
                cur = tq;
                rate = 0;
                moving = 0;
            } else {
                cc = cur + rate;
                cur = cc < lo ? lo : cc > hi ? hi : cc;
            }
            rd = (cur + (int64_t)k - 1) >> sh;
            rdi = (int32_t)(rd >> 16);
            rdf = (int32_t)(rd & 0xffff);
        }
        /* line sample w is written at its last sample (ph = k - 1) and stands for that sample's time: the read is at
         * w + ((ph - k + 1) - cur) / k line samples (floor), split into a whole part and a fraction */
        t = ((int32_t)ph - (int32_t)k + 1) * sub - rdf;
        i0 = (int32_t)w - rdi + (t >> 16);
        if (i0 < 0)
            i0 += (int32_t)nl;
        i1 = i0 + 1 == (int32_t)nl ? 0 : i0 + 1;
        fr = (t & 0xffff) >> 1;                       /* Q15 */
        ea = (int32_t)buf[i0] * 8 + ((((int32_t)buf[i1] - buf[i0]) * fr) >> 12);
        if (pp)
            eb = (int32_t)bb[i0] * 8 + ((((int32_t)bb[i1] - bb[i0]) * fr) >> 12);
        if (ph == k - 1u) {
            int32_t v;
            if (pp) {
                v = MUL_E(ea, fb);
                bb[w] = dly_pack(swell ? dly_soft(v) : v);
                v = *yp++ + MUL_E(eb, fb);
            } else
                v = *yp++ + MUL_E(ea, fb);
            buf[w] = dly_pack(swell ? dly_soft(v) : v);
            ph = 0;
            if (++w == nl)
                w = 0;
        } else
            ph++;
        {
            int32_t dr = mul16(in[i], dry);
            out[i] = dr + MUL_E(ea, mix);
            outr[i] = pp ? dr + MUL_E(eb, mix) : out[i];
        }
    }
    it->s.dly.w = w;
    it->s.dly.ph = (uint8_t)ph;
    it->s.dly.cur = cur;
    it->s.dly.rate = rate;
}

/* Tape's loop (modules.ts delayTape): the echo e times fb through a one-pole low pass (*l) and a high pass (the low
 * pass's output less a slower low pass of it, *h); Q24 states, Q16 in and out */
static inline int32_t tape_loop(int32_t *l, int32_t *h, int32_t e, int32_t fb, uint32_t pl, uint32_t phq)
{
    int32_t v = clampi(MUL_E(e, fb), -32 * ENG_ONE, 32 * ENG_ONE) << 8;
    *l += (int32_t)(((int64_t)(v - *l) * (int64_t)pl) >> 32);       /* (pl, phq: the Q24 poles x 256, unsigned: a */
    *h += (int32_t)(((int64_t)(*l - *h) * (int64_t)phq) >> 32);      /* multiply-high, (x pole) >> 24 exactly) */
    return (*l - *h + 128) >> 8;
}

/* the Delay with Tape on (modules.ts delayTape, #660), at any rate (k = 1 << sh): the heads (bit j of mask: head j + 1 at
 * j + 1 times the time, clamped to the line) read the line between two samples at their distance plus the wow and flutter
 * offset (two sines, worked out per block and ramped across it in whole steps), and sound together at 1 / n each. The
 * feedback runs through a one-pole low pass and high pass (DELAY_TAPE_LPQ / HPQ, Q24) and, with the input (through the
 * rate's low pass, dly_aa, at a lower rate), through dly_soft into the line. Distances in 1/256 samples (32 bits). The
 * state in the line's tail: the rate's low pass in words 0..7, Tape's loop filters (A low, A high, B low, B high), the wow
 * and flutter phases and the last offset in 8..14.
 * While the time stands and every head stays inside the line for the whole block (the usual case), each head's read point
 * moves by the same amount every sample: q, the distance of the write head's time ahead of the head's in 1/256 samples
 * (modulo the line), steps by 256 less the offset's step, and the read is at q / k. That is the same sample and fraction
 * the general loop works out (floor((W - d) / k) = W / k - ceil(d / k), W a multiple of k), without its multiply and clamp
 * per head. */

/* dly_tape's loop while the time stands and its heads stay inside the line (see there), for pp and nh known at the call,
 * so that each case keeps its state in registers: q the heads' points (1/256 samples, modulo M) and their steps, st the loop
 * filters (A low, A high, B low, B high), ys the input to write */
HOT void tape_fast(const int pp, const int nh, int16_t *buf, uint32_t nl, uint32_t sh, uint32_t *wp, uint32_t *php,
                   int32_t *q, int32_t M, int32_t g, const esig_t *in, const int32_t *yp, esig_t *out,
                   esig_t *outr, uint32_t n, int32_t fb, int32_t mix, uint32_t pl, uint32_t phq, int32_t *st)
{
    int16_t *bb = buf + nl;
    const uint32_t k1 = (1u << sh) - 1u;
    const int32_t dry = ENG_ONE - mix;
    uint32_t w = *wp, ph = *php, i;
    int32_t q0 = q[0], q1 = nh > 1 ? q[1] : 0, q2 = nh > 2 ? q[2] : 0, lA = st[0], hA = st[1], lB = st[2], hB = st[3];
    const int32_t inc0 = q[3], inc1 = nh > 1 ? q[4] : 0, inc2 = nh > 2 ? q[5] : 0;
    for (i = 0; i < n; i++) {
        int32_t ea, eb = 0, pos, i0, i1, fr;
#define TAPE_HEAD(qj, incj, first)                                                                          \
        pos = (qj) >> sh;                                                                                   \
        i0 = pos >> 8;                                                                                      \
        i1 = i0 + 1 == (int32_t)nl ? 0 : i0 + 1;                                                            \
        fr = pos & 255;                                                                                     \
        ea = (first ? 0 : ea) + (int32_t)buf[i0] * 8 + ((((int32_t)buf[i1] - buf[i0]) * fr) >> 5);           \
        if (pp)                                                                                             \
            eb = (first ? 0 : eb) + (int32_t)bb[i0] * 8 + ((((int32_t)bb[i1] - bb[i0]) * fr) >> 5);         \
        qj += incj;                                                                                         \
        if (qj >= M)                                                                                        \
            qj -= M;
        TAPE_HEAD(q0, inc0, 1)
        if (nh > 1) {
            TAPE_HEAD(q1, inc1, 0)
        }
        if (nh > 2) {
            TAPE_HEAD(q2, inc2, 0)
        }
#undef TAPE_HEAD
        if (nh > 1) {
            ea = mul16(ea, g);
            if (pp)
                eb = mul16(eb, g);
        }
        if (ph == k1) {
            if (pp) {
                bb[w] = DLY_PACK_SOFT(tape_loop(&lB, &hB, ea, fb, pl, phq));
                buf[w] = DLY_PACK_SOFT(*yp + tape_loop(&lA, &hA, eb, fb, pl, phq));
            } else
                buf[w] = DLY_PACK_SOFT(*yp + tape_loop(&lA, &hA, ea, fb, pl, phq));
            yp++;
            ph = 0;
            if (++w == nl)
                w = 0;
        } else
            ph++;
        {
            int32_t dr = mul16(in[i], dry);
            out[i] = dr + MUL_E(ea, mix);
            outr[i] = pp ? dr + MUL_E(eb, mix) : out[i];
        }
    }
    st[0] = lA; st[1] = hA; st[2] = lB; st[3] = hB;
    *wp = w;
    *php = ph;
}

static void __attribute__((noinline)) dly_tape(inst_t *it, const esig_t *in, esig_t *out, esig_t *outr, uint32_t n, int64_t tq, int32_t fb, int32_t mix, int pp, int swell, uint32_t sh, uint32_t len, int32_t wow, uint32_t mask)
{
    const uint32_t k = 1u << sh, H = len / 2u, nl = pp ? H : len;
    const int32_t sub = (int32_t)(256u >> sh), lo8 = (int32_t)k << 8, hi8 = (int32_t)(((nl - 1u) << sh) << 8);
    int16_t *buf = it->s.dly.buf, *bb = buf + H;
    int32_t *tl = (int32_t *)(void *)(buf + len);
    const uint32_t pl = (uint32_t)DELAY_TAPE_LPQ[sh] << 8, phq = (uint32_t)DELAY_TAPE_HPQ[sh] << 8;
    int32_t hj[3], nh = 0, g, lA = tl[8], hA = tl[9], lB = tl[10], hB = tl[11];
    int32_t ys[ENG_BLOCK / 2u], *yp = ys;           /* the input at the line's writes (through the rate's low pass) */
    int moving = it->s.dly.cur != tq || it->s.dly.rate;
    uint32_t w = it->s.dly.w, ph = it->s.dly.ph, i, wph, fph;
    int32_t dry = ENG_ONE - mix, rate = it->s.dly.rate, m0 = tl[14], m1, step, cur8;
    int64_t cur = it->s.dly.cur, lo = (int64_t)k << 16, hi = ((int64_t)(nl - 1u) << sh) << 16;
    if (sh)
        dly_aa(tl, DELAY_AA[sh - 1u], in, n, ph, k, ys);
    else
        yp = (int32_t *)in;                         /* (read only) */
    if (swell)
        fb = (int32_t)((int64_t)fb * DELAY_SWELL_NUM / DELAY_SWELL_DEN);
    if (w >= nl)
        w = 0;
    wph = (uint32_t)tl[12] + DELAY_WOW_INC * n;
    fph = (uint32_t)tl[13] + DELAY_FLUTTER_INC * n;
    tl[12] = (int32_t)wph;
    tl[13] = (int32_t)fph;
    m1 = (int32_t)((((int64_t)DELAY_WOW_D8 * sin_turn(wph) + (int64_t)DELAY_FLUTTER_D8 * sin_turn(fph)) >> 16) * clampi(wow, 0, ENG_ONE) >> 16);
    step = (m1 - m0) / (int32_t)n;
    cur8 = (int32_t)(cur >> 8);
    for (i = 1; i <= 3u; i++)                       /* the heads that sound: their multiples of the time */
        if (mask & (1u << (i - 1u)))
            hj[nh++] = (int32_t)i;
    g = DELAY_HEAD_GAIN[nh];
    if (!moving && step > -256 && step < 256) {
        int32_t q[6], j;                            /* q[j]: head j's point, q[3 + j] its step */
        const int32_t M = (int32_t)((nl << sh) << 8);
        const int32_t W = ((int32_t)(w << sh) + (int32_t)ph - (int32_t)k + 1) << 8;   /* the write head's time, 1/256 samples */
        for (j = 0; j < nh; j++) {
            int32_t d0 = hj[j] * cur8 + m0 + step, d1 = hj[j] * cur8 + m0 + step * (int32_t)n;
            q[3 + j] = 256 - step;
            if (d0 > hi8 && d1 > hi8) {             /* past the line's end the whole block: it plays at the end */
                d0 = hi8;
                q[3 + j] = 256;
            } else if (d0 < lo8 && d1 < lo8) {
                d0 = lo8;
                q[3 + j] = 256;
            } else if (d0 < lo8 || d0 > hi8 || d1 < lo8 || d1 > hi8)
                break;
            q[j] = W - d0;
            if (q[j] < 0)
                q[j] += M;
        }
        if (j == nh) {
            int32_t st[4] = {lA, hA, lB, hB};
            if (pp) {
                if (nh == 1) tape_fast(1, 1, buf, nl, sh, &w, &ph, q, M, g, in, yp, out, outr, n, fb, mix, pl, phq, st);
                else if (nh == 2) tape_fast(1, 2, buf, nl, sh, &w, &ph, q, M, g, in, yp, out, outr, n, fb, mix, pl, phq, st);
                else tape_fast(1, 3, buf, nl, sh, &w, &ph, q, M, g, in, yp, out, outr, n, fb, mix, pl, phq, st);
            } else {
                if (nh == 1) tape_fast(0, 1, buf, nl, sh, &w, &ph, q, M, g, in, yp, out, outr, n, fb, mix, pl, phq, st);
                else if (nh == 2) tape_fast(0, 2, buf, nl, sh, &w, &ph, q, M, g, in, yp, out, outr, n, fb, mix, pl, phq, st);
                else tape_fast(0, 3, buf, nl, sh, &w, &ph, q, M, g, in, yp, out, outr, n, fb, mix, pl, phq, st);
            }
            lA = st[0]; hA = st[1]; lB = st[2]; hB = st[3];
            goto done;
        }
    }
    for (i = 0; i < n; i++) {
        int32_t ea = 0, eb = 0, m = m0 + step * (int32_t)(i + 1u), base = ((int32_t)ph - (int32_t)k + 1) * sub, j;
        if (moving) {
            int64_t diff = tq - cur, cc;
            int32_t st = (int32_t)(diff >> DELAY_GLIDE_SHIFT);
            rate += clampi(clampi(st, -DELAY_GLIDE_MAX, DELAY_GLIDE_MAX) - rate, -DELAY_GLIDE_ACC, DELAY_GLIDE_ACC);
            if (diff > -(1 << DELAY_GLIDE_SHIFT) && diff < 1 << DELAY_GLIDE_SHIFT && rate > -DELAY_GLIDE_ACC && rate < DELAY_GLIDE_ACC) {
                cur = tq;
                rate = 0;
                moving = 0;
            } else {
                cc = cur + rate;
                cur = cc < lo ? lo : cc > hi ? hi : cc;
            }
            cur8 = (int32_t)(cur >> 8);
        }
        for (j = 0; j < nh; j++) {
            int32_t d8, pos, i0, i1, fr;
            d8 = clampi(hj[j] * cur8 + m, lo8, hi8);
            pos = (int32_t)(w << 8) + base - ((d8 + (int32_t)k - 1) >> sh);
            if (pos < 0)
                pos += (int32_t)(nl << 8);
            i0 = pos >> 8;
            i1 = i0 + 1 == (int32_t)nl ? 0 : i0 + 1;
            fr = pos & 255;
            ea += (int32_t)buf[i0] * 8 + ((((int32_t)buf[i1] - buf[i0]) * fr) >> 5);
            if (pp)
                eb += (int32_t)bb[i0] * 8 + ((((int32_t)bb[i1] - bb[i0]) * fr) >> 5);
        }
        if (nh > 1) {
            ea = mul16(ea, g);
            eb = mul16(eb, g);
        }
        if (ph == k - 1u) {
            if (pp) {
                bb[w] = DLY_PACK_SOFT((tape_loop(&lB, &hB, ea, fb, pl, phq)));
                buf[w] = DLY_PACK_SOFT((*yp + tape_loop(&lA, &hA, eb, fb, pl, phq)));
            } else
                buf[w] = DLY_PACK_SOFT((*yp + tape_loop(&lA, &hA, ea, fb, pl, phq)));
            yp++;
            ph = 0;
            if (++w == nl)
                w = 0;
        } else
            ph++;
        {
            int32_t dr = mul16(in[i], dry);
            out[i] = dr + MUL_E(ea, mix);
            outr[i] = pp ? dr + MUL_E(eb, mix) : out[i];
        }
    }
done:
    tl[8] = lA; tl[9] = hA; tl[10] = lB; tl[11] = hB;
    tl[14] = m0 + step * (int32_t)n;
    it->s.dly.w = w;
    it->s.dly.ph = (uint8_t)ph;
    it->s.dly.cur = cur;
    it->s.dly.rate = rate;
}

/* a ring of lo samples at b (w its next write) as a ring of ln (dly_change): every sample keeps its distance behind the
 * write head; a shorter ring drops its oldest samples, a longer one gets silence older than all of them. The new w. */
static uint32_t dly_ring(int16_t *b, uint32_t lo, uint32_t ln, uint32_t w)
{
    uint32_t i;
    if (ln < lo) {
        if (w > ln) {                               /* the oldest are w..lo-1 and 0..w-ln-1: the rest moves down to 0 */
            for (i = 0; i < ln; i++)
                b[i] = b[i + w - ln];
            return 0;
        }
        for (i = w; i < ln; i++)                    /* the oldest are w..w+lo-ln-1 */
            b[i] = b[i + lo - ln];
        return w == ln ? 0 : w;
    }
    if (ln > lo) {
        for (i = lo; i-- > w;)
            b[i + ln - lo] = b[i];
        for (i = w; i < w + ln - lo; i++)
            b[i] = 0;
    }
    return w;
}

/* a new rate or Tape on / off (#659, #660; modules.ts delayChange): the line keeps what it holds. When the line gives its
 * last DELAY_TAIL samples to the filters' state (a lower rate or Tape) or takes them back, its ring (each ping-pong side
 * its half) drops its oldest samples or gets that much silence older than them, so every echo keeps its place (dly_ring),
 * and a new tail starts from silence. A lower rate's low pass coming from 44k starts settled on the input x0 (no step
 * into the line); Tape's state starts from silence. A new rate is a tape changing speed: the read point stays on the same
 * line sample, the line now moving past it at the new rate, so the echoes in it play on pitched by the ratio of the rates,
 * and the read point glides from there to the time (dly_glide: cur in samples, now k_new / k_old times as many). */
static void __attribute__((noinline)) dly_change(inst_t *it, uint32_t sh, int tape, int pp, int32_t x0)
{
    int16_t *buf = it->s.dly.buf;
    const uint32_t len = it->s.dly.len, ko = it->s.dly.rk, kn = 1u << sh;
    const uint32_t lo = ko > 1u || it->s.dly.tp ? len - DELAY_TAIL : len, ln = sh || tape ? len - DELAY_TAIL : len;
    int32_t *tl = (int32_t *)(void *)(buf + len - DELAY_TAIL);
    uint32_t w = it->s.dly.w, w2, i;
    if (lo != ln) {
        if (!pp)
            w = dly_ring(buf, lo, ln, w < lo ? w : 0u);
        else {
            const uint32_t ho = lo / 2u, hn = ln / 2u;
            if (w >= ho)
                w = 0;
            if (hn < ho) {                         /* A shorter first (it reads up to ho), B shorter, B down to hn */
                w2 = dly_ring(buf, ho, hn, w);
                dly_ring(buf + ho, ho, hn, w);
                for (i = 0; i < hn; i++)
                    buf[hn + i] = buf[ho + i];
            } else {                               /* B up to hn first, B longer, A longer (it writes up to hn) */
                for (i = ho; i-- > 0;)
                    buf[hn + i] = buf[ho + i];
                dly_ring(buf + hn, ho, hn, w);
                w2 = dly_ring(buf, ho, hn, w);
            }
            w = w2;
        }
        it->s.dly.w = w;
    }
    if (ln < lo)
        for (i = 0; i < DELAY_TAIL / 2u; i++)
            tl[i] = 0;
    else if (tape && !it->s.dly.tp)
        for (i = 8; i < DELAY_TAIL / 2u; i++)
            tl[i] = 0;
    if (ko == kn)
        return;
    if (ko == 1u) {
        int32_t x = clampi(x0, -4 * ENG_ONE, 4 * ENG_ONE) * 1024;   /* (dly_aa: Q26) */
        for (i = 0; i < 8u; i++)
            tl[i] = x;
    }
    {   /* the read point w - (k - 1 - ph + cur) / k line samples stays, with ph 0 from here */
        int64_t a = ((int64_t)(ko - 1u - it->s.dly.ph) << 16) + it->s.dly.cur, c;
        uint32_t so = ko == 4u ? 2u : ko == 2u ? 1u : 0u;
        c = ((a << sh) >> so) - ((int64_t)(kn - 1u) << 16);
        it->s.dly.cur = c < (int64_t)kn << 16 ? (int64_t)kn << 16 : c;
        it->s.dly.ph = 0;
        /* the line samples behind the read point are the old rate's: they play at the new speed until the read point
         * reaches where the change was, kn - 1 + cur samples (counted in whole blocks), then the glide starts */
        it->s.dly.rate = DLY_HOLD + (int32_t)((it->s.dly.cur >> 16) + kn - 1u);
    }
}

/* free or synced time (see modules.ts); ping-pong splits the buffer in two halves, A (input, left) and B (right), see
 * modules.ts. note: a synced length of its own (DELAY_NOTE_NUM / DEN) in place of the time knob's; swell: the feedback
 * x 198 / 95 and the loop through dly_soft (the loops below, apart, so the plain one stays as it was) */
static void m_delay(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[DELAY_I_IN];
    esig_t *out = it->out[DELAY_O_OUT], *outr = it->out[DELAY_O_R];
    int16_t *buf = it->s.dly.buf;
    uint32_t w, i, d;
    int32_t fb = EF(it, DELAY_P_FB), mix = EF(it, DELAY_P_MIX), dry = ENG_ONE - mix;
    int pp = EF(it, DELAY_P_PINGPONG) >= 32768, swell = EF(it, DELAY_P_SWELL) >= 32768;
    int32_t note = clampi((EF(it, DELAY_P_NOTE) + 32768) >> 16, 0, DELAY_NNOTE - 1);
    /* its rate (#659): step sh keeps every (1 << sh)-th sample (dly_slow); Tape (#660): dly_tape. Either takes the line's
     * last DELAY_TAIL samples for the filters' state; a new rate or Tape on / off keeps the echoes (dly_change) */
    const uint32_t sh = (uint32_t)clampi((EF(it, DELAY_P_RATE) + 32768) >> 16, 0, DELAY_NRATE - 1);
    const int tape = EF(it, DELAY_P_TAPE) >= 32768;
    /* its line (L samples, from its length; ping-pong two halves of H): the time, free or synced, plays up to it (times k) */
    const uint32_t L = sh || tape ? it->s.dly.len - DELAY_TAIL : it->s.dly.len, H = L / 2u;
    int64_t smp, top = ((pp ? (int64_t)H : (int64_t)L) - 1) << sh, tq;
    uint32_t hold = 0;
    if (it->s.dly.rk != 1u << sh || it->s.dly.tp != (uint8_t)tape) {
        if (it->s.dly.rk)
            dly_change(it, sh, tape, pp, in[0]);
        it->s.dly.rk = (uint8_t)(1u << sh);
        it->s.dly.tp = (uint8_t)tape;
    }
    if (it->s.dly.rate >= DLY_HOLD) {   /* a new rate's echoes still play at its speed (dly_change): the read point stands */
        hold = (uint32_t)(it->s.dly.rate - DLY_HOLD);
        it->s.dly.rate = 0;
    }
    w = it->s.dly.w;
    if (nd->conn & (1u << DELAY_I_CLK)) {   /* tempo: the time of the last 24 clock pulses, smoothed */
        const esig_t *clk = it->in[DELAY_I_CLK];
        for (i = 0; i < n; i++) {
            int hi = clk[i] >= 32768;
            it->s.dly.t++;
            if (hi && !it->s.dly.prev) {
                uint32_t k = it->s.dly.seen % DELAY_CLK_PPQN;
                if (it->s.dly.seen >= DELAY_CLK_PPQN) {
                    uint32_t m = it->s.dly.t - it->s.dly.ring[k];
                    if (m >= ENG_SR / 5u && m <= ENG_SR * 3u / 2u)
                        it->s.dly.beat = it->s.dly.seen == DELAY_CLK_PPQN ? m : (uint32_t)((int32_t)it->s.dly.beat + ((int32_t)m - (int32_t)it->s.dly.beat) / 4);
                }
                it->s.dly.ring[k] = it->s.dly.t;
                it->s.dly.seen++;
            }
            it->s.dly.prev = (uint8_t)hi;
        }
    }
    if (EF(it, DELAY_P_SYNC) >= 32768 && note > 0)
        smp = ((int64_t)DELAY_NOTE_NUM[note] * it->s.dly.beat * 2 + DELAY_NOTE_DEN[note]) / ((int64_t)DELAY_NOTE_DEN[note] * 2);
    else if (EF(it, DELAY_P_SYNC) >= 32768) {
        uint32_t div = delay_div(EF(it, DELAY_P_TIME));
        smp = ((int64_t)DELAY_DIV_NUM[div] * it->s.dly.beat * 2 + DELAY_DIV_DEN[div]) / ((int64_t)DELAY_DIV_DEN[div] * 2);
    } else
        smp = ((int64_t)EF(it, DELAY_P_TIME) * ENG_SR + (int64_t)500 * 65536) / (1000 * 65536);   /* round(t_ms / 1000 * sr) */
    d = (uint32_t)(smp < (1 << sh) ? (1 << sh) : smp > top ? top : smp);
    if (it->s.dly.cur == 0 || it->s.dly.cur > top << 16)
        it->s.dly.cur = it->s.dly.cur == 0 ? (int64_t)d << 16 : top << 16;
    tq = hold ? it->s.dly.cur : (int64_t)d << 16;
    if (tape) {
        it->s.dly.w = w;
        dly_tape(it, in, out, outr, n, tq, fb, mix, pp, swell, sh, L, EF(it, DELAY_P_WOW),
                 DELAY_HEAD_MASK[clampi((EF(it, DELAY_P_HEADS) + 32768) >> 16, 0, DELAY_NHEADS - 1)]);
        goto held;
    }
    if (sh) {
        it->s.dly.w = w;
        dly_slow(it, in, out, outr, n, tq, fb, mix, pp, swell, sh, L);
        goto held;
    }
    if (hold || it->s.dly.cur != tq || it->s.dly.rate) {     /* the time moved: glide there (#484), the plain loops below once it has arrived */
        dly_glide(it, in, out, outr, n, tq, fb, mix, pp, swell);
        goto held;
    }
    if (swell) {
        fb = (int32_t)((int64_t)fb * DELAY_SWELL_NUM / DELAY_SWELL_DEN);
        if (w >= (pp ? H : L))
            w = 0;
        for (i = 0; i < n; i++) {
            uint32_t len = pp ? H : L, rp = w >= d ? w - d : w + len - d;
            int32_t ea = (int32_t)buf[rp] * 8, dr = mul16(in[i], dry);
            if (pp) {
                int32_t eb = (int32_t)buf[H + rp] * 8;
                buf[H + w] = dly_pack(dly_soft(MUL_E(ea, fb)));
                buf[w] = dly_pack(dly_soft(in[i] + MUL_E(eb, fb)));
                out[i] = dr + MUL_E(ea, mix);
                outr[i] = dr + MUL_E(eb, mix);
            } else {
                buf[w] = dly_pack(dly_soft(in[i] + MUL_E(ea, fb)));
                out[i] = dr + MUL_E(ea, mix);
                outr[i] = out[i];
            }
            if (++w == len)
                w = 0;
        }
    } else if (!pp) {
        for (i = 0; i < n; i++) {
            uint32_t rp = w >= d ? w - d : w + L - d;
            int32_t r = (int32_t)buf[rp] * 8;
            buf[w] = dly_pack(in[i] + MUL_E(r, fb));
            if (++w == L)
                w = 0;
            out[i] = mul16(in[i], dry) + MUL_E(r, mix);
            outr[i] = out[i];
        }
    } else {
        int16_t *bb = buf + H;
        if (w >= H)
            w = 0;
        for (i = 0; i < n; i++) {
            uint32_t rp = w >= d ? w - d : w + H - d;
            int32_t ea = (int32_t)buf[rp] * 8, eb = (int32_t)bb[rp] * 8, dr = mul16(in[i], dry);
            bb[w] = dly_pack(MUL_E(ea, fb));
            buf[w] = dly_pack(in[i] + MUL_E(eb, fb));
            if (++w == H)
                w = 0;
            out[i] = dr + MUL_E(ea, mix);
            outr[i] = dr + MUL_E(eb, mix);
        }
    }
    it->s.dly.w = w;
held:
    if (hold)
        it->s.dly.rate = hold > n ? DLY_HOLD + (int32_t)(hold - n) : 0;
}

/* ---- reverb: the same Freeverb-style network as modules.ts, in Q16 with int16 (Q13) delay memory */

/* Reverb (modules.ts `reverb`; freeze holds the tail): an eight-line FDN with a Householder feedback matrix (f_k = t_k - sum(t) / 4), a one-pole
 * damping filter and a decay gain in every line (g_k = 2^(-9.966 L_k / (T sr)): 60 dB in T = 0.2 x 2^(5 size) s), two
 * input diffusion allpasses (g 0.5), a pre-delay of up to 40 ms, and a sine modulation of the read position of lines 0
 * and 1 (mod x 6 samples at 0.5 / 0.83 Hz, linear interpolation). All lines int16 Q13 in one block (RV_LEN). */
static const uint16_t RV_LINE[8] = {331, 439, 547, 661, 773, 881, 991, 1117};
static const uint16_t RV_DIFF[2] = {223, 347};
#define RV_PRE 1764u                 /* 40 ms */
#define RV_GIN 8192                  /* the input into every line: 0.125 */
#define RV_GOUT 32768                /* the sum of the line outputs: 0.5 */
#define RV_MOD (6 << 16)             /* the modulation depth at mod 1: samples, Q16 */
static const uint32_t RV_MOD_INC[2] = {48696u, 80836u};   /* 0.5 and 0.83 Hz in u32 turns per sample */
#define RV_LOG2_T0 (-152169)         /* log2(0.2) Q16 */
#define RV_DB60 653118               /* 3 / log10(2) = 9.966 Q16: the octaves of gain lost per T */

static void m_reverb(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[REVERB_I_IN];
    esig_t *out = it->out[0];
    int16_t *base = it->s.rev.buf, *line[8], *ap[2], *pre;
    int32_t d = mul16(EF(it, REVERB_P_DAMP), 52429), mix = EF(it, REVERB_P_MIX), dry = ENG_ONE - mix;   /* damp x 0.8 */
    int32_t depth = mul16(EF(it, REVERB_P_MOD), RV_MOD), g[8], t[8];
    int32_t tq = (int32_t)exp2_q16(mul16(EF(it, REVERB_P_SIZE), 5 << 16) + RV_LOG2_T0 + (16 << 16));   /* T, seconds Q16 */
    uint32_t dpre = (uint32_t)((mulq(EF(it, REVERB_P_PRE), ENG_SR, 16) + 500) / 1000), i, k, off = 0;
    int frz = EF(it, REVERB_P_FREEZE) >= 32768;   /* freeze: every gain 1, no damping, nothing new into the lines */
    int32_t gin = frz ? 0 : RV_GIN;
    if (frz)
        d = 0;
    if (tq < 1)
        tq = 1;
    if (dpre > RV_PRE - 1u)
        dpre = RV_PRE - 1u;
    for (k = 0; k < 8u; k++) {
        int64_t e = -(((int64_t)RV_LINE[k] * RV_DB60) << 16) / ((int64_t)tq * ENG_SR);
        g[k] = frz ? ENG_ONE : (int32_t)exp2_q16((int32_t)(e < -(16 << 16) ? -(16 << 16) : e) + (16 << 16));
        line[k] = base + off;
        off += RV_LINE[k];
    }
    for (k = 0; k < 2u; k++) {
        ap[k] = base + off;
        off += RV_DIFF[k];
    }
    pre = base + off;
    {
        /* the indices and states in locals (the int16 line writes could alias them in it->s), the lines written out */
        uint32_t li[8], ai0 = it->s.rev.ai[0], ai1 = it->s.rev.ai[1], pi = it->s.rev.pi, ph0 = it->s.rev.ph[0], ph1 = it->s.rev.ph[1];
        int32_t lp[8], od = ENG_ONE - d;
        for (k = 0; k < 8u; k++) {
            li[k] = it->s.rev.li[k];
            lp[k] = it->s.rev.lp[k];
        }
        for (i = 0; i < n; i++) {
            int32_t x = in[i], u = x, wet = 0, sum = 0, bo, y, o;
            if (dpre) {
                uint32_t rp = pi + RV_PRE - dpre;
                if (rp >= RV_PRE)
                    rp -= RV_PRE;
                u = (int32_t)pre[rp] * 8;
            }
            pre[pi] = dly_pack(x);
            if (++pi == RV_PRE)
                pi = 0;
            bo = (int32_t)ap[0][ai0] * 8;                                   /* input diffusion */
            y = bo - u;
            ap[0][ai0] = dly_pack(u + (bo >> 1));
            if (++ai0 == 223u)
                ai0 = 0;
            u = y;
            bo = (int32_t)ap[1][ai1] * 8;
            y = bo - u;
            ap[1][ai1] = dly_pack(u + (bo >> 1));
            if (++ai1 == 347u)
                ai1 = 0;
            u = y;
            u = mulr(u, gin, 16);
#define RV_DAMP(k)                                                                      \
            wet += o;                                                                   \
            lp[k] = mulr(o, od, 16) + mulr(lp[k], d, 16);                               \
            t[k] = mulr(lp[k], g[k], 16);                                               \
            sum += t[k];
#define RV_MODTAP(k, ph)                                                                \
            if (depth > 0) {                                                            \
                const uint32_t L = RV_LINE[k], w = li[k];                               \
                int32_t sn = sin_turn(ph);                                              \
                int32_t dl = (int32_t)((L - 2u) << 16) - mulq(depth, 32768 + (sn >> 1), 16);   /* the delay, samples Q16 */ \
                uint32_t di = (uint32_t)dl >> 16, fr = (uint32_t)dl & 0xFFFFu, ra = w + L - di, rb;   \
                int32_t a, b;                                                           \
                if (ra >= L)                                                            \
                    ra -= L;                                                            \
                rb = ra ? ra - 1u : L - 1u;                                             \
                a = (int32_t)line[k][ra] * 8;                                           \
                b = (int32_t)line[k][rb] * 8;                                           \
                o = a + (int32_t)(((int64_t)(b - a) * fr) >> 16);                       \
            } else                                                                      \
                o = (int32_t)line[k][li[k]] * 8;                                        \
            RV_DAMP(k)
#define RV_TAP(k)                                                                       \
            o = (int32_t)line[k][li[k]] * 8;                                            \
            RV_DAMP(k)
            RV_MODTAP(0, ph0)
            RV_MODTAP(1, ph1)
            RV_TAP(2) RV_TAP(3) RV_TAP(4) RV_TAP(5) RV_TAP(6) RV_TAP(7)
#undef RV_TAP
#undef RV_MODTAP
#undef RV_DAMP
            sum >>= 2;
            for (k = 0; k < 8u; k++) {                                      /* Householder feedback, write */
                uint32_t w = li[k];
                line[k][w] = dly_pack(u + t[k] - sum);
                if (++w == RV_LINE[k])
                    w = 0;
                li[k] = w;
            }
            ph0 += RV_MOD_INC[0];
            ph1 += RV_MOD_INC[1];
            out[i] = mulr(x, dry, 16) + mulr(mulr(wet, RV_GOUT, 16), mix, 16);
        }
        for (k = 0; k < 8u; k++) {
            it->s.rev.li[k] = (uint16_t)li[k];
            it->s.rev.lp[k] = lp[k];
        }
        it->s.rev.ai[0] = (uint16_t)ai0;
        it->s.rev.ai[1] = (uint16_t)ai1;
        it->s.rev.pi = (uint16_t)pi;
        it->s.rev.ph[0] = ph0;
        it->s.rev.ph[1] = ph1;
    }
}

/* The level / rate envelope (modules.ts env): three segments to l1 l2 l3 in r1 r2 r3 on the gate, hold l3, release to l4
 * in r4. Rising: linear at the rate that covers 0..1 in r (the ADSR attack); falling: 99 % in r (the ADSR decay), then the
 * segment ends (the last 1 % is stepped). Q30. */
static void m_env(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *gate = it->in[ENV_I_GATE];
    esig_t *out = it->out[0];
    int32_t lv[6], inc[6], k[6], v = it->s.env.v;
    uint32_t len[6], tt = it->s.env.t;
    uint8_t stage = it->s.env.stage, prev = it->s.env.prev;
    uint32_t i, st;
    int shot = EF(it, ENV_P_SHOT) >= 32768;   /* one-shot: the gate only starts it, the segments run through, then the release */
    static const uint8_t LP[6] = {ENV_P_L4, ENV_P_L1, ENV_P_L2, ENV_P_L3, ENV_P_L3, ENV_P_L4};
    static const uint8_t RP[6] = {0, ENV_P_R1, ENV_P_R2, ENV_P_R3, 0, ENV_P_R4};
    static const uint8_t SL[6] = {0, 0, 1, 2, 0, 3};   /* the segment's cache slot */
    for (st = 0; st < 6u; st++) {
        uint32_t sl = SL[st];
        int32_t r;
        lv[st] = EF(it, LP[st]) << 14;
        if (st == 0 || st == 4) {
            inc[st] = k[st] = 0;
            len[st] = 1;
            continue;
        }
        r = EF(it, RP[st]);
        if (!(it->s.env.ok >> sl & 1u) || it->s.env.rk[sl] != r) {   /* the divisions only when the rate changed */
            uint64_t tsr = ((uint64_t)(uint32_t)r * ENG_SR + 32768u) >> 16;   /* round(r * sr) samples */
            if (tsr < 1u)
                tsr = 1u;
            it->s.env.len[sl] = (uint32_t)tsr;
            it->s.env.inc[sl] = (int32_t)((1ull << 30) / tsr);
            it->s.env.k[sl] = env_rate_n((uint32_t)tsr);
            it->s.env.rk[sl] = r;
            it->s.env.ok |= (uint8_t)(1u << sl);
        }
        len[st] = it->s.env.len[sl];
        inc[st] = it->s.env.inc[sl];
        k[st] = it->s.env.k[sl];
    }
    for (i = 0; i < n; i++) {
        uint8_t g = gate[i] > 32768 ? 1 : 0;
        uint32_t guard;
        if (g && !prev) {
            stage = 1;
            tt = 0;
        } else if (!g && prev && !shot) {
            stage = 5;
            tt = 0;
        }
        prev = g;
        if (stage == 0 || stage == 4) {           /* resting or holding: one level until the gate changes (#781) */
            int32_t o;
            v = lv[stage];
            o = v >> 14;
            out[i] = o;
            while (i + 1u < n && (gate[i + 1u] > 32768) == g)
                out[++i] = o;
            continue;
        } else {                                  /* inside a segment: run it until the gate changes or the sample that
                                                   * ends it, which takes the steps below */
            const int32_t t = lv[stage], d = inc[stage], kk = k[stage];
            const uint32_t ln = len[stage];
            int ran = 0;
            while (v < t ? v + d < t : tt + 1u < ln) {
                tt++;
                v += v < t ? d : mulq(t - v, kk, 30);
                out[i] = v >> 14;
                if (i + 1u >= n || (gate[i + 1u] > 32768) != g) {
                    ran = 1;
                    break;
                }
                i++;
            }
            if (ran)
                continue;
        }
        for (guard = 0; guard < 4u; guard++) {
            int32_t t;
            if (stage == 0 || stage == 4) {
                v = lv[stage];
                break;
            }
            t = lv[stage];
            tt++;
            if (v < t) {
                v += inc[stage];
                if (v < t)
                    break;
            } else if (tt < len[stage]) {
                v += mulq(t - v, k[stage], 30);
                break;
            }
            v = t;
            stage = stage == 5 ? 0 : stage == 3 && shot ? 5 : (uint8_t)(stage + 1);
            tt = 0;
        }
        out[i] = v >> 14;
    }
    it->s.env.t = tt;
    it->s.env.v = v;
    it->s.env.stage = stage;
    it->s.env.prev = prev;
}

/* The eight-step envelope (modules.ts env8): step k runs to lk in rk by m_env's segment rules; the gate starts step 1, the
 * sustain step's level holds while it stays up, its fall jumps to the step after the sustain (sus = end: rest), the end
 * step's level is where it rests. Sus off or past the end: every step runs through, the gate's fall does nothing. Stage
 * 0 resting, 1..8 the steps, ENV8_HOLD holding. Q30. */
#define ENV8_HOLD 9u
static void env8_rates(inst_t *it, uint32_t st)
{
    int32_t r = EF(it, ENV8_P_R1 + 2u * (st - 1u));
    uint64_t tsr = ((uint64_t)(uint32_t)r * ENG_SR + 32768u) >> 16;   /* round(r * sr) samples */
    if (tsr < 1u)
        tsr = 1u;
    it->s.env8.len = (uint32_t)tsr;
    it->s.env8.inc = (int32_t)((1ull << 30) / tsr);
    it->s.env8.k = env_rate_n((uint32_t)tsr);
    it->s.env8.rk = r;
    it->s.env8.cst = (uint8_t)st;
}
static void m_env8(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *gate = it->in[ENV8_I_GATE];
    esig_t *out = it->out[0];
    const int32_t *eff = it->eff;
    int32_t v = it->s.env8.v;
    uint32_t tt = it->s.env8.t, i;
    uint32_t end = (uint32_t)clampi((eff[ENV8_P_END] + 32768) >> 16, 1, 8);
    uint32_t hs = (uint32_t)clampi((eff[ENV8_P_SUS] + 32768) >> 16, 0, 8);
    uint8_t stage = it->s.env8.stage, prev = it->s.env8.prev;
    int32_t inc, k, lrest, lhold;
    uint32_t len, cst;
    (void)nd;
    if (hs > end)
        hs = 0;
    if (it->s.env8.cst && it->s.env8.rk != eff[ENV8_P_R1 + 2u * (it->s.env8.cst - 1u)])
        it->s.env8.cst = 0;                       /* the cached step's rate moved */
    /* the cached step's rates and the resting / holding levels in locals: out[] might alias it->s, so the compiler would
     * read them again every sample (#781) */
    cst = it->s.env8.cst;
    inc = it->s.env8.inc;
    k = it->s.env8.k;
    len = it->s.env8.len;
    lrest = eff[ENV8_P_L1 + 2u * (end - 1u)] << 14;
    lhold = hs ? eff[ENV8_P_L1 + 2u * (hs - 1u)] << 14 : 0;
    for (i = 0; i < n; i++) {
        uint8_t g = gate[i] > 32768 ? 1 : 0;
        uint32_t guard;
        if (g && !prev) {
            stage = 1;
            tt = 0;
        } else if (!g && prev && hs && (stage == ENV8_HOLD || (stage >= 1u && stage <= hs))) {
            stage = (uint8_t)(hs < end ? hs + 1u : 0u);
            tt = 0;
        }
        prev = g;
        if (stage == ENV8_HOLD && !hs)
            stage = 0;                            /* the sustain was switched off while holding: rest */
        if (stage == 0 || stage == ENV8_HOLD) {   /* resting or holding: one level until the gate changes */
            int32_t o;
            v = stage ? lhold : lrest;
            o = v >> 14;
            out[i] = o;
            while (i + 1u < n && (gate[i + 1u] > 32768) == g)
                out[++i] = o;
            continue;
        }
        if (stage <= end && stage == cst) {       /* inside a step with its rates cached: run it until the gate changes or
                                                   * the sample that ends it, which takes the steps below */
            const int32_t t = eff[ENV8_P_L1 + 2u * (stage - 1u)] << 14;
            int ran = 0;
            while (v < t ? v + inc < t : tt + 1u < len) {
                tt++;
                v += v < t ? inc : mulq(t - v, k, 30);
                out[i] = v >> 14;
                if (i + 1u >= n || (gate[i + 1u] > 32768) != g) {
                    ran = 1;
                    break;
                }
                i++;
            }
            if (ran)
                continue;
        }
        for (guard = 0; guard < 10u; guard++) {
            int32_t t;
            uint32_t st = stage;
            if (st == 0) {
                v = lrest;
                break;
            }
            if (st == ENV8_HOLD) {
                if (hs) {
                    v = lhold;
                    break;
                }
                stage = 0;
                continue;
            }
            if (st > end) {
                stage = 0;                        /* the end was moved before this step */
                continue;
            }
            if (cst != st) {
                env8_rates(it, st);
                cst = st;
                inc = it->s.env8.inc;
                k = it->s.env8.k;
                len = it->s.env8.len;
            }
            t = eff[ENV8_P_L1 + 2u * (st - 1u)] << 14;
            tt++;
            if (v < t) {
                v += inc;
                if (v < t)
                    break;
            } else if (tt < len) {
                v += mulq(t - v, k, 30);
                break;
            }
            v = t;
            stage = (uint8_t)(st == hs && g ? ENV8_HOLD : st == end ? 0u : st + 1u);
            tt = 0;
        }
        out[i] = v >> 14;
    }
    it->s.env8.t = tt;
    it->s.env8.v = v;
    it->s.env8.stage = stage;
    it->s.env8.prev = prev;
}

#define LOG2_1000_Q16 653124        /* log2(1000): decay is the time to -60 dB */

/* The plucked string (modules.ts string): a Q13 delay line of one period with a one-pole in the loop, written with
 * first-order error feedback so the int16 rounding does not pile up in the loop. Period, loop gain and the damping's
 * delay compensation are set once per block from the block's first pitch. */
static void m_string(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[STRING_I_PITCH], *gate = it->in[STRING_I_GATE], *exc = it->in[STRING_I_EXC];
    esig_t *out = it->out[0];
    int16_t *buf = it->s.str.buf;
    uint32_t dt = exp2_scale(INC_C4, pitch[0] + EF(it, STRING_P_COARSE) / 12), w = it->s.str.w, seed = it->s.str.seed, i, di;
    int32_t per, cl, dl, d, fr, g, bl, lvl = EF(it, STRING_P_LEVEL), kind = round_q16(EF(it, STRING_P_BURST));
    int32_t lp = it->s.str.lp, s1 = it->s.str.s1, err = it->s.str.err, burst = it->s.str.burst, blen = it->s.str.blen;
    int64_t e;
    if (dt == 0u)
        dt = 1u;
    per = (int32_t)clampi((int64_t)((1ull << 48) / dt) > 0x7FFFFFFF ? 0x7FFFFFFF : (int32_t)((1ull << 48) / dt), 2 << 16, (int32_t)(STR_LEN - 2u) << 16);   /* period, Q16 samples */
    cl = ENG_ONE - mul16(EF(it, STRING_P_DAMP), 58982);                    /* 1 - 0.9 damp */
    dl = (int32_t)(((int64_t)(ENG_ONE - cl) << 16) / cl);                 /* the one-pole's low-frequency delay */
    d = per - dl;
    if (d < ENG_ONE)
        d = ENG_ONE;
    di = (uint32_t)d >> 16;
    fr = d & 0xFFFF;
    e = -(((int64_t)LOG2_1000_Q16 * per) >> 16);                           /* -log2(1000) * period, Q16 */
    e = (e << 16) / ((int64_t)EF(it, STRING_P_DECAY) * ENG_SR);           /* / (decay * sr): octaves, Q16 */
    g = (int32_t)exp2_scale(ENG_ONE, (int32_t)(e < -(47 << 16) ? -(47 << 16) : e));
    bl = (per + 32768) >> 16;
    for (i = 0; i < n; i++) {
        int32_t x = exc[i], r0, r1, r, y, wq;
        int16_t q;
        uint32_t p0 = w >= di ? w - di : w + STR_LEN - di, p1 = p0 ? p0 - 1u : STR_LEN - 1u;
        if (gate[i] >= 32768 && s1 < 32768) {
            burst = bl;
            blen = bl;
        }
        s1 = gate[i];
        if (burst > 0) {
            if (kind == 0) {
                seed = seed * 1664525u + 1013904223u;
                x += (int32_t)(seed >> 15) - ENG_ONE;
            } else
                x += blen - burst < (blen >> 1) ? ENG_ONE : -ENG_ONE;
            burst--;
        }
        r0 = (int32_t)buf[p0] * 8;
        r1 = (int32_t)buf[p1] * 8;
        r = r0 + mulr(r1 - r0, fr, 16);
        lp += mulr(r - lp, cl, 16);
        y = clampi(x + mulr(lp, g, 16), -2 * ENG_ONE, 2 * ENG_ONE);
        wq = y + err;
        q = dly_pack(wq);
        err = wq - (int32_t)q * 8;
        buf[w] = q;
        if (++w == STR_LEN)
            w = 0;
        out[i] = mul16(y, lvl);
    }
    it->s.str.w = w;
    it->s.str.seed = seed;
    it->s.str.lp = lp;
    it->s.str.s1 = s1;
    it->s.str.err = err;
    it->s.str.burst = burst;
    it->s.str.blen = blen;
}

/* The comb filter (modules.ts comb): the string's line and loop (it->s.str: buf, w, lp, err) with signed feedback and
 * no burst; out = in (1 - mix) + y mix. */
static void m_comb(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[COMB_I_IN], *pitch = it->in[COMB_I_PITCH];
    esig_t *out = it->out[0];
    int16_t *buf = it->s.str.buf;
    uint32_t dt = exp2_scale(INC_C4, pitch[0] + EF(it, COMB_P_COARSE) / 12), w = it->s.str.w, i, di;
    int32_t per, cl, dl, d, fr, fb = EF(it, COMB_P_FB), mix = EF(it, COMB_P_MIX), dry = ENG_ONE - mix;
    int32_t lp = it->s.str.lp, err = it->s.str.err;
    if (dt == 0u)
        dt = 1u;
    per = (int32_t)clampi((int64_t)((1ull << 48) / dt) > 0x7FFFFFFF ? 0x7FFFFFFF : (int32_t)((1ull << 48) / dt), 2 << 16, (int32_t)(STR_LEN - 2u) << 16);
    cl = ENG_ONE - mul16(EF(it, COMB_P_DAMP), 58982);
    dl = (int32_t)(((int64_t)(ENG_ONE - cl) << 16) / cl);
    d = per - dl;
    if (d < ENG_ONE)
        d = ENG_ONE;
    di = (uint32_t)d >> 16;
    fr = d & 0xFFFF;
    for (i = 0; i < n; i++) {
        int32_t x = in[i], r0, r1, y, wq;
        int16_t q;
        uint32_t p0 = w >= di ? w - di : w + STR_LEN - di, p1 = p0 ? p0 - 1u : STR_LEN - 1u;
        r0 = (int32_t)buf[p0] * 8;
        r1 = (int32_t)buf[p1] * 8;
        lp += mulr(r0 + mulr(r1 - r0, fr, 16) - lp, cl, 16);
        y = clampi(x + mulr(lp, fb, 16), -2 * ENG_ONE, 2 * ENG_ONE);
        wq = y + err;
        q = dly_pack(wq);
        err = wq - (int32_t)q * 8;
        buf[w] = q;
        if (++w == STR_LEN)
            w = 0;
        out[i] = mul16(x, dry) + mul16(y, mix);
    }
    it->s.str.w = w;
    it->s.str.lp = lp;
    it->s.str.err = err;
    (void)nd;
}

#define MODAL_N 6
static const int32_t MODAL_BAR_Q16[MODAL_N] = {65536, 180617, 354157, 585433, 874250, 1221591};   /* a free bar's partial ratios */

/* The modal resonator (modules.ts modal): six two-pole resonators y = g x + c1 y1 - c2 y2 with g = a sin(th) (Q30),
 * c1 = 2 r cos(th), c2 = r^2 (Q30), states Q20 held to +-8; coefficients once per block from the block's first pitch. */
static void m_modal(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[MODAL_I_IN], *pitch = it->in[MODAL_I_PITCH];
    esig_t *out = it->out[0];
    int32_t *y1 = it->s.mod.y1, *y2 = it->s.mod.y2;
    int32_t st = EF(it, MODAL_P_STRUCT), damp = EF(it, MODAL_P_DAMP), decay = EF(it, MODAL_P_DECAY);
    int32_t br = EF(it, MODAL_P_BRIGHT), g[MODAL_N], c1[MODAL_N], c2[MODAL_N];
    int32_t base = pitch[0] + EF(it, MODAL_P_COARSE) / 12;
    int32_t *r30c = it->s.mod.r30, *gn = it->s.mod.gn;
    uint32_t i, k;
    if (!(it->s.mod.ok & 1u) || it->s.mod.kdec != decay || it->s.mod.kdamp != damp) {   /* the divisions only on a change */
        for (i = 0; i < MODAL_N; i++) {
            int32_t dec_i = (int32_t)(((int64_t)decay << 16) / (ENG_ONE + 2 * (int32_t)i * damp));   /* decay / (1 + 2 damp i) */
            int64_t e = -(((int64_t)LOG2_1000_Q16 << 16) / ((int64_t)dec_i * ENG_SR));              /* octaves per sample, Q16 */
            r30c[i] = (int32_t)exp2_scale(1u << 30, (int32_t)(e < -(47 << 16) ? -(47 << 16) : e));
        }
        it->s.mod.kdec = decay;
        it->s.mod.kdamp = damp;
        it->s.mod.ok |= 1u;
    }
    if (!(it->s.mod.ok & 2u) || it->s.mod.kbr != br) {
        int32_t bw = 19661 + mul16(br, 45875), amp[MODAL_N], sum = 0, a = ENG_ONE;
        for (i = 0; i < MODAL_N; i++) {
            amp[i] = a;
            sum += a;
            a = mul16(a, bw);
        }
        for (i = 0; i < MODAL_N; i++)
            gn[i] = (int32_t)(((int64_t)amp[i] << 16) / sum);
        it->s.mod.kbr = br;
        it->s.mod.ok |= 2u;
    }
    for (i = 0; i < MODAL_N; i++) {
        int32_t ratio = ((int32_t)(i + 1u) << 16) + mul16(st, MODAL_BAR_Q16[i] - ((int32_t)(i + 1u) << 16));
        uint32_t dt = exp2_scale(INC_C4, base + log2_q16((uint32_t)ratio) - (16 << 16));   /* f0 x ratio as a phase increment */
        int32_t r30 = r30c[i], s30, sh, co30;
        g[i] = c1[i] = c2[i] = 0;
        if (dt >= DT_MAX)
            continue;
        s30 = sin_turn30(dt);
        sh = sin_turn30(dt >> 1);                                                            /* cos th = 1 - 2 sin^2(th / 2): the pole's */
        co30 = (1 << 30) - mulq(sh, sh, 29);                                                 /* frequency needs cos accurate near 1 */
        g[i] = mulq(gn[i], s30, 16);
        c1[i] = 2 * mulq(r30, co30, 30);
        c2[i] = mulq(r30, r30, 30);
    }
    {
        /* the states in locals (out[] is int32 too and could alias them in it->s), the six modes written out */
        int32_t a1[MODAL_N], a2[MODAL_N];
        for (i = 0; i < MODAL_N; i++) {
            a1[i] = y1[i];
            a2[i] = y2[i];
        }
        for (k = 0; k < n; k++) {
            int32_t x20 = in[k] << 4, y = 0, v;
#define MODE(i)                                                                                             \
            v = clampi(mulr(g[i], x20, 30) + mulr(c1[i], a1[i], 30) - mulr(c2[i], a2[i], 30), -(8 << 20), 8 << 20); \
            a2[i] = a1[i];                                                                                  \
            a1[i] = v;                                                                                      \
            y += v;
            MODE(0) MODE(1) MODE(2) MODE(3) MODE(4) MODE(5)
#undef MODE
            out[k] = (y + 8) >> 4;
        }
        for (i = 0; i < MODAL_N; i++) {
            y1[i] = a1[i];
            y2[i] = a2[i];
        }
    }
    (void)nd;
}

/* The wavetable oscillator (modules.ts wavetable): two neighbouring frames of a bank read with linear interpolation and
 * crossfaded by pos; the mip level (32 / 16 / 8 harmonics) from the block's first pitch. Phase modulation as the plain
 * oscillator's (no oversampling). */
static void m_wavetable(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[WAVETABLE_I_PITCH], *pm = it->in[WAVETABLE_I_PM], *sync = it->in[WAVETABLE_I_SYNC];
    esig_t *out = it->out[0];
    int32_t base = EF(it, WAVETABLE_P_COARSE) / 12 + EF(it, WAVETABLE_P_FINE) / 1200;
    int32_t bank = clampi(round_q16(EF(it, WAVETABLE_P_BANK)), 0, WT_FRAMES / 8 - 1), lvl = EF(it, WAVETABLE_P_LEVEL);
    int32_t pos7 = clampi(EF(it, WAVETABLE_P_POS), 0, ENG_ONE) * 7, f0 = pos7 >> 16, f1 = f0 < 7 ? f0 + 1 : 7, fm = pos7 & 0xFFFF;
    int32_t idx = nd->conn & (1u << WAVETABLE_I_PM) ? EF(it, WAVETABLE_P_PM) : 0, s1 = it->s.wt.s1;
    uint32_t dt0 = exp2_scale(INC_C4, pitch[0] + base), phase = it->s.wt.phase, i;
    uint32_t mip = dt0 < 67108864u ? 0u : dt0 < 134217728u ? 1u : 2u;
    const int16_t *ta = WT_T[mip][bank * 8 + f0], *tb = WT_T[mip][bank * 8 + f1];
    inc_ramp_t rp;
    INC_LOOP(rp, base) {
        uint32_t dt = dt_, ph, xi, xf;
        int32_t ya, yb;
        if (sync[i] >= 32768 && s1 < 32768)
            phase = 0;
        s1 = sync[i];
        phase += dt;
        ph = phase + (uint32_t)(((int64_t)mul16(idx, pm[i]) * TURN_PER_RAD) >> 16);
        xi = ph >> 24;
        xf = (ph >> 8) & 0xFFFFu;
        ya = ta[xi] * 2 + (int32_t)(((int64_t)(ta[xi + 1] - ta[xi]) * 2 * (int32_t)xf) >> 16);
        yb = tb[xi] * 2 + (int32_t)(((int64_t)(tb[xi + 1] - tb[xi]) * 2 * (int32_t)xf) >> 16);
        out[i] = mul16(ya + mul16(yb - ya, fm), lvl);
    }
    it->s.wt.phase = phase;
    it->s.wt.s1 = s1;
}

/* The phase distortion oscillator (modules.ts pd, after the Casio CZ): a sine read with its phase bent, dcw (Q16 0..1)
 * scaling the bend; the resonance waveforms a sine restarted every cycle, raised by dcw x range octaves, faded by a
 * window; wave2 on every other cycle. The bends at full DCW (modules.ts PD_SEGS: the bent phase minus the ramp u) are
 * straight between sixteenths of the cycle, so interval k = u >> 28 holds one line: PD_T its start (Q16 cycles), PD_S its
 * slope (Q16), b = PD_T + PD_S x (u & 2^28 - 1) / 2^32, no search. The band limit (PD_FMAX, a quarter of the rate) once a
 * block from the first pitch: room = 2^30 / increment, a bend's dcw at most (room - 1) / PD_STEEP, a resonance's rise at
 * most log2(room) octaves. */
#define PD_RESO 5
static const int32_t PD_T[PD_RESO][16] = {
    {0, -1755, -3511, -5266, -7022, -8777, -10533, -12288, -14043, -15799, -17554, -19310, -21065, -22821, -24576, -12288},
    {0, 4096, 8192, 4096, 0, -4096, -8192, -4096, 0, 4096, 8192, 4096, 0, -4096, -8192, -4096},
    {0, 28672, 57344, 53248, 49152, 45056, 40960, 36864, 32768, 28672, 24576, 20480, 16384, 12288, 8192, 4096},
    {0, -1755, -3511, -5266, -7022, -8777, -10533, -12288, 0, -1755, -3511, -5266, -7022, -8777, -10533, -12288},
    {0, 585, 1170, 1755, 2341, 2926, 3511, 4096, 32768, 28672, 24576, 20480, 16384, 12288, 8192, 4096}};
#define PD_A (-28087)                /* -3/7 */
#define PD_N (-65536)
static const int32_t PD_S[PD_RESO][16] = {
    {PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, 196608, 196608},
    {65536, 65536, PD_N, PD_N, PD_N, PD_N, 65536, 65536, 65536, 65536, PD_N, PD_N, PD_N, PD_N, 65536, 65536},
    {458752, 458752, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N},
    {PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, 196608, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, PD_A, 196608},
    {9362, 9362, 9362, 9362, 9362, 9362, 9362, 458752, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N, PD_N}};
#undef PD_A
#undef PD_N
static const int32_t PD_STEEP[PD_RESO] = {3, 1, 7, 3, 7};

/* the bent phase of a bend wave: dcw (already limited) x the bend, Q32 cycles modulo a cycle */
HOT uint32_t pd_bent(const int32_t *t, const int32_t *s, uint32_t ph, int32_t d)
{
    uint32_t k = ph >> 28;
    int32_t b = t[k] + mulq(s[k], (int32_t)(ph & 0x0FFFFFFFu), 32);
    return ph + (uint32_t)d * (uint32_t)b;
}

static void m_pd(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[PD_I_PITCH], *dcw = it->in[PD_I_DCW], *pm = it->in[PD_I_PM], *sync = it->in[PD_I_SYNC];
    esig_t *out = it->out[PD_O_OUT];
    int32_t base = EF(it, PD_P_COARSE) / 12 + EF(it, PD_P_FINE) / 1200, lvl = EF(it, PD_P_LEVEL);
    int32_t w1 = clampi(round_q16(EF(it, PD_P_WAVE)), 0, 7), w2 = clampi(round_q16(EF(it, PD_P_WAVE2)), 0, 8);
    int32_t alt = w2 > 0, d0 = EF(it, PD_P_DCW), range = clampi(EF(it, PD_P_RANGE), 0, 5 * ENG_ONE);
    int32_t idx = nd->conn & (1u << PD_I_PM) ? EF(it, PD_P_PM) : 0, s1 = it->s.pd.s1, room, oct, cap[2], k, m0, dm;
    int32_t has_sync = (nd->conn >> PD_I_SYNC) & 1u, w = 0, c = 0;
    uint32_t phase = it->s.pd.phase, r = it->s.pd.r, odd = it->s.pd.odd, dt = 0, inc0, i;
    const int32_t *ts = PD_T[0], *ss = PD_S[0];
    inc_ramp_t rp;
    w2 = alt ? w2 - 1 : w1;
    inc0 = exp2_scale(INC_C4, pitch[0] + base);
    if (inc0 > DT_MAX)
        inc0 = DT_MAX;
    oct = (30 << 16) - log2_q16(inc0);                                     /* log2(room), Q16 */
    room = (int32_t)exp2_q16(oct + (16 << 16));                            /* room, Q16 */
    for (k = 0; k < 2; k++) {
        w = k ? w2 : w1;
        cap[k] = w < PD_RESO ? clampi((room - ENG_ONE) / PD_STEEP[w], 0, ENG_ONE) : 0;   /* (a resonance: the ratio below) */
    }
    {   /* the resonance's ratio 2^(dcw x range), Q16: at the block's first and last sample, a straight line between */
        int32_t lim = oct > 0 ? oct : 0, x0 = mul16(clampi(d0 + dcw[0], 0, ENG_ONE), range), x1 = n ? mul16(clampi(d0 + dcw[n - 1], 0, ENG_ONE), range) : x0;
        m0 = (int32_t)exp2_q16((x0 < lim ? x0 : lim) + (16 << 16));
        dm = n ? ((int32_t)exp2_q16((x1 < lim ? x1 : lim) + (16 << 16)) - m0) / (int32_t)n : 0;
    }
    if (!alt && !has_sync && !idx && w1 < PD_RESO) {                       /* one bend wave, nothing at sync or pm */
        c = cap[0];
        ts = PD_T[w1];
        ss = PD_S[w1];
        INC_LOOP(rp, base) {
            uint32_t old = phase;
            int32_t d = clampi(d0 + dcw[i], 0, c);
            phase += dt_;
            odd ^= phase < old;                                            /* (the cycles still counted: a wave2 set later) */
            out[i] = mul16(sin_turn(pd_bent(ts, ss, phase, d)), lvl);
        }
        n = 0;
        s1 = 0;
    }
    /* the waveform of this cycle (the second one on odd cycles): picked when a cycle starts */
#define PD_PICK()                                                                       \
    do {                                                                                \
        int32_t s_ = (int32_t)odd & alt;                                                \
        w = s_ ? w2 : w1;                                                               \
        c = cap[s_];                                                                    \
        if (w < PD_RESO) {                                                              \
            ts = PD_T[w];                                                               \
            ss = PD_S[w];                                                               \
        }                                                                               \
    } while (0)
    PD_PICK();
    INC_LOOP(rp, base) {
        uint32_t old, pmo = 0, fresh = 0;   /* fresh: a new cycle (or a sync): the resonance sine restarts */
        int32_t d, y;
        dt = dt_;
        if (has_sync) {
            if (sync[i] >= 32768 && s1 < 32768) {
                phase = odd = 0;
                fresh = 1;
            }
            s1 = sync[i];
        }
        old = phase;
        phase += dt;
        if (phase < old) {                                                 /* a new cycle */
            odd ^= 1u;
            fresh = 1;
        }
        if (fresh)
            PD_PICK();
        d = clampi(d0 + dcw[i], 0, ENG_ONE);
        if (idx)
            pmo = (uint32_t)(((int64_t)mul16(idx, pm[i]) * TURN_PER_RAD) >> 16);
        if (w < PD_RESO) {
            y = sin_turn(pd_bent(ts, ss, phase, d < c ? d : c) + pmo);
        } else {
            int32_t win, u = (int32_t)(phase >> 16);
            uint32_t m = (uint32_t)(m0 + dm * (int32_t)i), rinc = (uint32_t)(((uint64_t)dt * m) >> 16);   /* the ratio, Q16 */
            if (rinc > DT_MAX)
                rinc = DT_MAX;
            r = fresh ? (uint32_t)(((uint64_t)phase * m) >> 16) : r + rinc;   /* restarted at the ramp's phase times the ratio */
            win = w == PD_RESO ? ENG_ONE - u : w == PD_RESO + 1 ? (u < 32768 ? 2 * u : 2 * (ENG_ONE - u))
                : (4 * u < 2 * (ENG_ONE - u) ? (4 * u < ENG_ONE ? 4 * u : ENG_ONE) : (2 * (ENG_ONE - u) < ENG_ONE ? 2 * (ENG_ONE - u) : ENG_ONE));
            y = mul16(sin_turn(r + pmo), win);
        }
        out[i] = mul16(y, lvl);
    }
#undef PD_PICK
    it->s.pd.phase = phase;
    it->s.pd.r = r;
    it->s.pd.odd = (uint8_t)odd;
    it->s.pd.s1 = has_sync ? s1 : 0;                                       /* (the unconnected sync input reads 0) */
}

#define CH_BASE_Q16 34695807u       /* 0.012 * ENG_SR samples, Q16 */
#define CH_SWING_Q16 23130538u      /* 0.008 * ENG_SR samples, Q16 */

/* The stereo chorus (modules.ts chorus): a Q13 line, two taps swept in quadrature by a sine around 12 ms by up to 8 ms. */
static void m_chorus(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[CHORUS_I_IN];
    esig_t *l = it->out[CHORUS_O_L], *r = it->out[CHORUS_O_R];
    int16_t *buf = it->s.ch.buf;
    uint32_t w = it->s.ch.w, phase = it->s.ch.phase, i;
    uint32_t dphi = hz_turns((uint32_t)EF(it, CHORUS_P_RATE));
    int32_t swing = mul16((int32_t)CH_SWING_Q16, EF(it, CHORUS_P_DEPTH)), mix = EF(it, CHORUS_P_MIX), dry = ENG_ONE - mix;
    for (i = 0; i < n; i++) {
        int32_t x = in[i], tap[2], k;
        uint32_t dd[2];
        buf[w] = dly_pack(x);
        dd[0] = CH_BASE_Q16 + (uint32_t)mul16(swing, sin_turn(phase));
        dd[1] = CH_BASE_Q16 + (uint32_t)mul16(swing, sin_turn(phase + 0x40000000u));
        for (k = 0; k < 2; k++) {
            uint32_t di = dd[k] >> 16, p0 = w >= di ? w - di : w + CH_LEN - di, p1 = p0 ? p0 - 1u : CH_LEN - 1u;
            int32_t a = (int32_t)buf[p0] * 8, b = (int32_t)buf[p1] * 8;
            tap[k] = a + mulr(b - a, (int32_t)(dd[k] & 0xFFFFu), 16);
        }
        l[i] = mul16(x, dry) + mul16(tap[0], mix);
        r[i] = mul16(x, dry) + mul16(tap[1], mix);
        if (++w == CH_LEN)
            w = 0;
        phase += dphi;
    }
    it->s.ch.w = w;
    it->s.ch.phase = phase;
}

/* does note j of step k (in stored order, chance code `code`) play on time `loop` round the pattern (modules.ts notePlays);
 * note 0 hashes as the step did before #133 */
static int steps_plays(uint32_t seed, uint32_t loop, uint32_t k, uint32_t j, uint32_t code)
{
    if (code > 19u)
        code = 19u;
    return !code || hash32(seed ^ (loop * 0x9e3779b9u) ^ ((k + 1u) * 0x85ebca6bu) ^ (j * 0xc2b2ae35u)) % 100u < 100u - 5u * code;
}

/* keys out: a note on (key | 0x80, velocity) or off of the Steps module `node`, handed to its groups at the start of the next
 * block (steps_keys) */
static void steps_key(uint32_t node, uint32_t key, uint32_t vel)
{
    if (E.nkev >= ENG_KEV)
        return;
    E.kev[E.nkev][0] = (uint8_t)node;
    E.kev[E.nkev][1] = (uint8_t)key;
    E.kev[E.nkev][2] = (uint8_t)vel;
    E.nkev++;
}

/* sounding note j of track t ends (its key off) */
static void steps_end(uint32_t t, uint32_t node, uint32_t j)
{
    snd_t *s = E.trk_snd[t];
    uint32_t i;
    steps_key(node, s[j].key, 0);
    for (i = j; i + 1u < E.trk_nsnd[t]; i++)
        s[i] = s[i + 1u];
    E.trk_nsnd[t]--;
}

/* a note starts on track t (a new sound; a note on the same key ends first, the oldest when TRACK_POLY sound) */
static void steps_start(uint32_t t, uint32_t node, uint32_t key, uint32_t vel, uint32_t left, int32_t cnt)
{
    uint32_t j;
    for (j = 0; j < E.trk_nsnd[t]; j++)
        if (E.trk_snd[t][j].key == key) {
            steps_end(t, node, j);
            break;
        }
    if (E.trk_nsnd[t] >= TRACK_POLY)
        steps_end(t, node, 0);
    j = E.trk_nsnd[t]++;
    E.trk_snd[t][j].key = (uint8_t)key;
    E.trk_snd[t][j].left = (uint8_t)left;
    E.trk_snd[t][j].thru = 0;
    E.trk_snd[t][j].dr = 0;
    E.trk_snd[t][j].cnt = cnt;
    steps_key(node, key | 0x80u, vel);
}

/* a note's samples from now (modules.ts steps hold): through to the next step while more steps follow (two steps at most,
 * so a stopped clock lets it end), else gate x the step length sl */
static int32_t steps_hold(uint32_t left, int32_t gate, int32_t sl)
{
    int32_t g;
    if (left)
        return 2 * sl;
    g = (int32_t)(((int64_t)gate * sl) >> 16);
    return g > 1 ? g : 1;
}

static int steps_sounding(uint32_t t)
{
    uint32_t j;
    for (j = 0; j < E.trk_nsnd[t]; j++)
        if (E.trk_snd[t][j].cnt > 0)
            return 1;
    return 0;
}

/* a note as the pitch output gives it: octaves from C4, rounded to Q16 (modules.ts stepPitch) = (d +- 6) / 12 with d =
 * n * ENG_ONE, split as ENG_ONE = 12 * 5461 + 4: written plainly the compiler folds -STEP_NOTE * ENG_ONE + 6 into
 * 0xFFC40006, which build.py rejects as a chip ROM address */
static int32_t steps_pitch(uint32_t note)
{
    int32_t n = (int32_t)note - STEP_NOTE;
    return n * 5461 + (n >= 0 ? 4 * n + 6 : 4 * n - 6) / 12;
}

/* a key played into track t let go (engine.ts / modules.ts steps, keys in): the note it sounds ends; recording, the note
 * goes into the track's took ring, its length the whole steps it was held (at least one, to the end of the steps) */
static void steps_thru_off(uint32_t t, uint32_t node, const inst_t *it, uint32_t note)
{
    uint32_t j;
    for (j = 0; j < E.trk_nsnd[t]; j++)
        if (E.trk_snd[t][j].thru == note + 1u) {
            steps_end(t, node, j);
            break;
        }
    for (j = 0; j < E.nrin; j++)
        if (E.rin[j].trk == t && E.rin[j].note == note) {
            rin_t x = E.rin[j];
            int32_t sl = it->s.stp.slen, len = x.t > 0 && sl > 0 ? (int32_t)((x.t + sl / 2) / sl) : 1;
            uint8_t h = took_head;
            /* held round the loop back to where it started, or beyond: a drone (#384, D-819; modules.ts) */
            int drone = len >= steps_cycle(steps_len(it, t), clampi(round_q16(EF(it, STEPS_P_DIR)), 0, 3));
            len = clampi(len, 1, TRACK_STEPS);
            for (; j + 1u < E.nrin; j++)
                E.rin[j] = E.rin[j + 1u];
            E.nrin--;
            if ((uint8_t)(h - took_tail) < ENG_TOOK) {
                took_ring[h % ENG_TOOK][0] = node;
                took_ring[h % ENG_TOOK][1] = drone ? NW(x.at, TRACK_STEPS, note, x.vel, 0u) | ENG_NOTE_WRAP : NW(x.at, (uint32_t)len, note, x.vel, 0u);
                took_head = (uint8_t)(h + 1u);
            }
            break;
        }
}

/* the keys played into a Steps module this block (modules.ts steps, keys in), before its samples: each one straight
 * through, as the track's own note (transposed, into keys out and the mono outputs), held until let go (muted too);
 * recording live, a played note lands on the nearest step (the next one when more than half of this one has passed) */
static void steps_thru(const node_t *nd, inst_t *it, int32_t len, int ext, int32_t tr)
{
    uint32_t t = nd->trk, node = (uint32_t)(nd - E.node), e;
    int32_t semis = (int32_t)(((int64_t)tr * 12 + 32768) >> 16);
    int live = (E.trk_rec >> t & 1u) && it->s.stp.pos >= 0 && it->s.stp.slen > 0 && (ext || E.running);
    uint32_t kill = E.nthru + 1u;                /* (none) */
    if (E.thru_kill >> t & 1u) {                 /* the routing changed: at its place among this block's keys (#748); one
                                                  * before this block (a track that did not run then) at the start */
        int32_t at = (int8_t)(uint8_t)(thru_kill_at[t] - E.blk_q0);
        kill = at < 0 ? 0u : (uint32_t)at > E.nthru ? E.nthru : (uint32_t)at;
    }
    for (e = 0; e <= E.nthru; e++) {
        uint32_t note, vel;
        int was;
        if (e == kill) {                         /* the keys played through it so far go quiet */
            uint32_t j;
            E.thru_kill &= (uint16_t)~(1u << t);
            for (j = 0; j < E.trk_nsnd[t];)
                if (E.trk_snd[t][j].thru)
                    steps_thru_off(t, node, it, E.trk_snd[t][j].thru - 1u);
                else
                    j++;
        }
        if (e == E.nthru)
            break;
        note = E.blk_thru[e][1] & 0x7Fu;
        vel = E.blk_thru[e][2];
        if (E.blk_thru[e][0] != node)
            continue;
        steps_thru_off(t, node, it, note);
        if (!(E.blk_thru[e][1] & 0x80u))
            continue;
        if (live && E.nrin < ENG_RIN) {
            int32_t ago = it->s.stp.sst, sl = it->s.stp.slen, pos = it->s.stp.pos;
            int next = ago * 2 >= sl;
            int32_t target = next ? steps_next(it, len, clampi(round_q16(EF(it, STEPS_P_DIR)), 0, 3)).pos : pos;
            rin_t *x = &E.rin[E.nrin++];
            x->trk = (uint8_t)t;
            x->note = (uint8_t)note;
            x->at = (uint8_t)target;
            x->vel = (uint8_t)vel;
            x->t = next ? ago - sl : ago;
        }
        was = steps_sounding(t);
        steps_start(t, node, (uint32_t)clampi((int32_t)note + semis, 0, 127), vel, 0, 1);
        E.trk_snd[t][E.trk_nsnd[t] - 1u].thru = (uint8_t)(note + 1u);
        it->s.stp.pitch = steps_pitch(note);
        it->s.stp.vel = (int32_t)((vel << 16) / 127u);
        E.trk_last[t] = (uint8_t)note;
        it->s.stp.gap = (uint8_t)was;
    }
}

/* step k of a Steps module comes up: the notes sounding go on to their next step, then the notes starting on it sound
 * (unless their chance says no, it was recorded ahead (skip) or the track is muted); tr: the transpose input (Q16 octaves,
 * whole semitones for the keys) */
/* the key note word w sounds on track t (its note, a song entry's shift, the transpose's semitones) */
static uint32_t steps_key_of(uint32_t t, uint32_t w, int32_t semis)
{
    return (uint32_t)clampi(clampi((int32_t)NW_NOTE(w) + E.trk_shift[t], 0, 127) + semis, 0, 127);
}
/* a drone (#384) holds while its note is still a drone of the pattern playing, at the key it sounds (modules.ts lives) */
static int steps_drone_lives(uint32_t t, const snd_t *x, int32_t semis)
{
    uint32_t i, end = (uint32_t)TRK_FIRST(t) + TRK_N(t);
    for (i = TRK_FIRST(t); i < end && i < ENG_MAX_NOTES; i++) {
        uint32_t w = E.trk_note[i];
        if (NW_AT(w) + 1u == (x->dr & 0x7Fu) && eng_note_drone(w) && steps_key_of(t, w, semis) == x->key)
            return 1;
    }
    return 0;
}

static void steps_fire(const node_t *nd, inst_t *it, int32_t k, int32_t len, int32_t gate, int32_t sl, int32_t tr, int32_t at)
{
    uint32_t t = nd->trk, node = (uint32_t)(nd - E.node), i, j = 0, end;
    int32_t semis = (int32_t)(((int64_t)tr * 12 + 32768) >> 16);
    int was, any = 0;
    for (i = 0; i < E.trk_nsnd[t]; i++) {
        snd_t *x = &E.trk_snd[t][i];
        if (x->left > 0 && x->cnt > 0 && !it->s.stp.mute) {
            if (!(x->dr & 0x7Fu))
                x->left--;
            else if (!steps_drone_lives(t, x, semis))
                x->left = 0;
            x->cnt = steps_hold(x->left, gate, sl);
        }
    }
    if (it->s.stp.mute || (E.trk_once[t] == 1u && once_end_at >= 0 && at >= once_end_at))
        return;                                  /* (play once: its passes played, it loops on until the last track's end,
                                                  * then no note more: D-820) */
    if (it->s.stp.skip == k && !it->s.stp.skipn) {
        it->s.stp.skip = -1;
        return;
    }
    was = steps_sounding(t);
    end = (uint32_t)TRK_FIRST(t) + TRK_N(t);
    for (i = TRK_FIRST(t); i < end && i < ENG_MAX_NOTES; i++) {
        uint32_t w = E.trk_note[i], left;
        int32_t key, note;
        if (NW_AT(w) != (uint32_t)k)
            continue;
        if (it->s.stp.skip == k && it->s.stp.skipn == NW_NOTE(w) + 1u) {   /* (a drum hit recorded ahead: only its note) */
            j++;
            continue;
        }
        if (!steps_plays(it->s.stp.seed, it->s.stp.loop, (uint32_t)k, j++, NW_CODE(w)))
            continue;
        note = clampi((int32_t)NW_NOTE(w) + E.trk_shift[t], 0, 127);   /* (a song entry's shift) */
        key = clampi(note + semis, 0, 127);
        if (eng_note_drone(w)) {                 /* (a drone tied onto itself: it goes on, nothing starts) */
            uint32_t q;
            for (q = 0; q < E.trk_nsnd[t]; q++)
                if (E.trk_snd[t][q].dr == (SND_WRAP | (uint32_t)(k + 1)) && E.trk_snd[t][q].key == (uint32_t)key && E.trk_snd[t][q].cnt > 0)
                    break;
            if (q < E.trk_nsnd[t])
                continue;
            left = 1u;
        } else if (w & ENG_NOTE_WRAP)            /* (tied across the loop point: its length counts on into the next pass) */
            left = NW_LEN(w) - 1u;
        else {
            int32_t dir = clampi(round_q16(EF(it, STEPS_P_DIR)), 0, 3);
            uint32_t remaining = (uint32_t)clampi(steps_cycle(len, dir) - it->s.stp.visit, 1, 126);
            left = (NW_LEN(w) < remaining ? NW_LEN(w) : remaining) - 1u;
        }
        steps_start(t, node, (uint32_t)key, NW_VEL(w), left, steps_hold(left, gate, sl));
        if (w & ENG_NOTE_WRAP)
            E.trk_snd[t][E.trk_nsnd[t] - 1u].dr = (uint8_t)(eng_note_drone(w) ? SND_WRAP | (uint32_t)(k + 1) : SND_WRAP);
        it->s.stp.pitch = steps_pitch((uint32_t)note);
        it->s.stp.vel = (int32_t)((NW_VEL(w) << 16) / 127u);
        E.trk_last[t] = (uint8_t)NW_NOTE(w);
        any = 1;
    }
    if (it->s.stp.skip == k)
        it->s.stp.skip = -1;
    if (any)
        it->s.stp.gap = (uint8_t)was;
}

/* the Steps module (modules.ts steps): one step per `rate` of the clock while the transport runs (the first when it starts;
 * 1/64 is a tick and a half, every second step half a tick after a tick), or per rising edge in clk; every second step
 * late by the swing; its notes sound for their length (gate x their last step); trig is up while any sounds, pitch / vel
 * hold the last that started, keys out every note on / off */
/* Drum map (modules.ts drummap): each row's gate while its note is held (one low first sample when it restarts) and its
 * velocity; the notes come in through dm_keys */
static void m_drummap(const node_t *nd, inst_t *it, uint32_t n)
{
    uint32_t r;
    (void)nd;
    for (r = 0; r < DRUMMAP_NOUT / 2u; r++) {
        esig_t *g = it->out[2u * r];
        fill(g, (it->s.dm.gate >> r & 1u) ? ENG_ONE : 0, n);
        if (!IS_DUMMY(g) && (it->s.dm.gap >> r & 1u))
            g[0] = 0;
        fill(it->out[2u * r + 1u], it->s.dm.vel[r], n);
    }
    it->s.dm.gap = it->s.dm.fell = 0;
}

/* the end of a pass of track t (modules.ts stepsTurn): in a song, the next entry's pattern and shift (after the last, the
 * first again); else a queued pattern */
static void steps_turn(uint32_t t)
{
    uint32_t s = E.song;
    if (E.trk_once[t] > 1u)                      /* (play once, #632: at 1 its passes are played, it loops on: steps_fire) */
        E.trk_once[t]--;
    if (s && E.song_n[s - 1u]) {
        int32_t k = E.trk_spos[t] + 1 >= (int32_t)E.song_n[s - 1u] ? 0 : E.trk_spos[t] + 1;
        E.trk_spos[t] = (int8_t)k;
        E.trk_pat[t] = E.song_pat[s - 1u][k];
        E.trk_shift[t] = E.trk_drum[t] ? 0 : E.song_shift[s - 1u][k];
        E.trk_q[t] = 0xFFu;
        return;
    }
    E.trk_shift[t] = 0;
    if (E.trk_q[t] != 0xFFu)
        E.trk_pat[t] = E.trk_q[t];
    E.trk_q[t] = 0xFFu;
}

static const uint8_t RATE_HT[9] = {48, 32, 24, 16, 12, 8, 6, 96, 3};   /* half ticks a step: track.ts STEPS_RATE_HT */
static void m_steps(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clk = it->in[STEPS_I_CLK], *reset = it->in[STEPS_I_RESET], *tr = it->in[STEPS_I_TRANSPOSE];
    esig_t *trig = it->out[STEPS_O_TRIG], *keys = it->out[STEPS_O_KEYS], *pitch = it->out[STEPS_O_PITCH], *vel = it->out[STEPS_O_VEL];
    uint32_t t = nd->trk, node = (uint32_t)(nd - E.node);
    int32_t len, dir = clampi(round_q16(EF(it, STEPS_P_DIR)), 0, 3), ht, step;
    int32_t swing = EF(it, STEPS_P_SWING) - 50 * ENG_ONE, gate = EF(it, STEPS_P_GATE);
    int ext = (nd->conn >> STEPS_I_CLK) & 1u;
    uint32_t i;
    if (E.trk_q[t] != 0xFFu && !E.running) {     /* stopped: a chosen pattern plays at once */
        E.trk_pat[t] = E.trk_q[t];
        E.trk_q[t] = 0xFFu;
    }
    len = steps_len(it, t);                      /* the pattern's own length and rate, else the track's (modules.ts shape) */
    ht = RATE_HT[TRK_P(t) && E.pat_rate[t][TRK_P(t)] != 0xFFu ? E.pat_rate[t][TRK_P(t)] : clampi(round_q16(EF(it, STEPS_P_RATE)), 0, 8)];
    step = (ht * E.tick_len) >> 1;               /* a step's samples */
    if (E.nthru || E.thru_kill)
        steps_thru(nd, it, len, ext, tr[0]);
    for (i = 0; i < n; i++) {
        int32_t adv = 0, sl;
        if (reset[i] >= 32768 && it->s.stp.r1 < 32768)
            it->s.stp.pos = -1;
        it->s.stp.r1 = reset[i];
        if (ext) {
            if (it->s.stp.since >= 0 && it->s.stp.since < (1 << 23))
                it->s.stp.since++;
            if (clk[i] >= 32768 && it->s.stp.c1 < 32768) {
                if (it->s.stp.since > 0)
                    it->s.stp.period = it->s.stp.since;
                it->s.stp.since = 0;
                adv++;
            }
            it->s.stp.c1 = clk[i];
        } else {
            if (i == 0 && E.running && !it->s.stp.run) {
                it->s.stp.count = 0;
                it->s.stp.half = 0;
                it->s.stp.pos = -1;
                E.trk_spos[t] = -1;              /* (a song starts again from its first entry) */
                adv++;
            }
            if (it->s.stp.half > 0 && E.running && --it->s.stp.half == 0)
                adv++;
            if ((int32_t)i == E.tick_off) {
                int32_t q;
                if (it->s.stp.half > 0) {        /* (the clock came early: the step half a tick on is now) */
                    it->s.stp.half = 0;
                    adv++;
                }
                for (q = 0; q < E.tick_n; q++)
                    if ((it->s.stp.count += 2) >= ht) {
                        it->s.stp.count = 0;
                        adv++;
                    }
                if ((ht & 1) && it->s.stp.count + 1 == ht) {   /* the next step falls half a tick from now (1/64) */
                    it->s.stp.half = E.tick_len >> 1 > 0 ? E.tick_len >> 1 : 1;
                    it->s.stp.count = -1;
                }
            }
        }
        sl = ext && it->s.stp.period > 0 ? it->s.stp.period : ext ? 6 * E.tick_len : step;   /* the gate's step length */
        if (i == 0 && it->s.stp.hit) {           /* a hit from the panel (eng_steps_hit): the last note sounds now, whatever the pattern */
            int was = steps_sounding(t);
            steps_start(t, node, (uint32_t)clampi((int32_t)E.trk_last[t] + (int32_t)(((int64_t)tr[i] * 12 + 32768) >> 16), 0, 127), it->s.stp.hit == 2u ? ACCENT_VEL : STEP_VEL, 0, steps_hold(0, gate, sl));
            it->s.stp.gap = (uint8_t)was;
            it->s.stp.hit = 0;
        }
        it->s.stp.sst++;
        if (it->s.stp.pend > 0 && --it->s.stp.pend == 0 && (dir == 0 || it->s.stp.pstep < len))
            steps_fire(nd, it, it->s.stp.pstep, len, gate, sl, tr[i], (int32_t)i);
        for (; adv > 0; adv--) {
            int32_t sw, d = 0;
            step_visit_t next = steps_next(it, len, dir);
            if (next.visit == 0) {               /* the end of a pass: a song's next entry, a queued pattern */
                steps_turn(t);
                len = steps_len(it, t);
                ht = RATE_HT[TRK_P(t) && E.pat_rate[t][TRK_P(t)] != 0xFFu ? E.pat_rate[t][TRK_P(t)] : clampi(round_q16(EF(it, STEPS_P_RATE)), 0, 8)];
                step = (ht * E.tick_len) >> 1;
                sl = ext && it->s.stp.period > 0 ? it->s.stp.period : ext ? 6 * E.tick_len : step;
                next = steps_next(it, len, dir);
            }
            sw = ext ? it->s.stp.period : step;
            /* In the new play modes a live length edit may end the pass before an old note's countdown: such a
             * note ends after this sample, so a note starting now still gets its low trig sample. A note whose
             * countdown ran out keeps its gate tail. Forward keeps its older behaviour (D-538). */
            if (next.visit == 0 && dir != 0) {
                uint32_t j;
                for (j = 0; j < E.trk_nsnd[t]; j++) {
                    snd_t *x = &E.trk_snd[t][j];
                    if (!x->thru && !x->dr && x->left > 0 && x->cnt > 0) {
                        x->left = 0;
                        x->cnt = 1;
                    }
                }
            }
            it->s.stp.pos = (int8_t)next.pos;
            it->s.stp.visit = (uint8_t)next.visit;
            it->s.stp.loop = next.loop;
            it->s.stp.sst = 0;
            it->s.stp.slen = sw;
            if ((it->s.stp.visit & 1) && swing > 0 && sw > 0)
                d = (int32_t)(((int64_t)swing * sw) / (50 * ENG_ONE));
            if (d > 0) {
                it->s.stp.pend = d;
                it->s.stp.pstep = it->s.stp.pos;
            } else
                steps_fire(nd, it, it->s.stp.pos, len, gate, sl, tr[i], (int32_t)i);
        }
        {
            int up = E.trk_nsnd[t] && !it->s.stp.gap && steps_sounding(t);
            trig[i] = keys[i] = up ? ENG_ONE : 0;
            pitch[i] = it->s.stp.pitch + tr[i];
            vel[i] = it->s.stp.vel;
            if (it->s.stp.gap)
                it->s.stp.gap = 0;
            else if (E.trk_nsnd[t]) {
                int32_t j;
                for (j = (int32_t)E.trk_nsnd[t] - 1; j >= 0; j--)
                    if (E.trk_snd[t][j].cnt > 0 && !E.trk_snd[t][j].thru && --E.trk_snd[t][j].cnt == 0)
                        steps_end(t, node, (uint32_t)j);
            }
        }
    }
    for (i = 0; i < E.nrin; i++)
        if (E.rin[i].trk == t)
            E.rin[i].t += (int32_t)n;
    it->s.stp.run = E.running;
}

/* play once (D-820): the sample of this block on which the pass of the Steps track nd ends (steps_turn), -1 none; from
 * where it stands before the block, its clock's steps counted as m_steps will count them (the start, a step half a tick
 * on, the block's ticks); a reset edge is not foreseen (modules.ts stepsTurnAt, the same) */
static int32_t steps_turn_at(const node_t *nd, uint32_t n)
{
    const inst_t *it = &inst_pool[nd->inst0];
    uint32_t t = nd->trk;
    int32_t len = steps_len(it, t), dir = clampi(round_q16(EF(it, STEPS_P_DIR)), 0, 3), need, q;
    int32_t ht = RATE_HT[TRK_P(t) && E.pat_rate[t][TRK_P(t)] != 0xFFu ? E.pat_rate[t][TRK_P(t)] : clampi(round_q16(EF(it, STEPS_P_RATE)), 0, 8)];
    int32_t count = it->s.stp.count, half = it->s.stp.half;
    if (!E.running)
        return -1;
    if (!it->s.stp.run)                          /* (the start: its first step, a pass's start, on sample 0) */
        return 0;
    need = it->s.stp.pos < 0 ? 1 : steps_cycle(len, dir) - it->s.stp.visit;   /* steps to the pass's end */
    if (half > 0 && half - 1 < (int32_t)n && (E.tick_off < 0 || half - 1 <= E.tick_off)) {
        if (--need == 0)
            return half - 1;
        half = 0;
    }
    if (E.tick_off >= 0) {
        if (half > 0 && --need == 0)
            return E.tick_off;
        for (q = 0; q < E.tick_n; q++)
            if ((count += 2) >= ht) {
                count = 0;
                if (--need == 0)
                    return E.tick_off;
            }
    }
    return -1;
}
/* play once (D-820): the sample of this block on which the last track still playing its passes ends them (every such
 * track on its last pass and ending it in this block, the latest of them), -1 none (engine.ts the same) */
static int32_t steps_once_at(uint32_t n)
{
    uint32_t k;
    int32_t end = -1;
    if (once_st != 2u)
        return -1;
    for (k = 0; k < E.norder; k++) {
        const node_t *nd = &E.node[E.order[k]];
        int32_t a;
        if (nd->type != T_STEPS || E.trk_once[nd->trk] < 2u)
            continue;
        a = E.trk_once[nd->trk] == 2u ? steps_turn_at(nd, n) : -1;
        if (a < 0)
            return -1;
        end = a > end ? a : end;
    }
    return end;
}

/* The step sequencer (modules.ts seq): out is the current step all the time, gate follows the clock unless the step is a
 * rest (fully down, -1). A rising clock edge advances (fwd, back, pendulum, random), a rising reset edge goes to step 1. */
static void m_seq(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clock = it->in[SEQ_I_CLOCK], *reset = it->in[SEQ_I_RESET];
    esig_t *out = it->out[SEQ_O_OUT], *gate = it->out[SEQ_O_GATE];
    const int32_t *steps = it->eff + SEQ_P_S1;   /* (read per sample: the pointer kept in a register) */
    int32_t len = clampi(round_q16(EF(it, SEQ_P_LEN)), 1, 8), dir = round_q16(EF(it, SEQ_P_DIR));
    int32_t pos = it->s.seq.pos, down = it->s.seq.down, c1 = it->s.seq.c1, r1 = it->s.seq.r1;
    int32_t y = it->s.seq.y, period = it->s.seq.period, since = it->s.seq.since, gleft = it->s.seq.gleft;
    int32_t gl = EF(it, SEQ_P_GLIDE), glen = EF(it, SEQ_P_GATE), k = 0;
    uint32_t seed = it->s.seq.seed, i;
    /* glide and gate length are fractions of the clock period (the last two edges): a one-pole on out reaching 99 % in
     * glide x period; the gate stays up gate x period after the edge (1 = legato). 0: out is the step, the gate the clock */
    if (gl > 0 && period > 0)
        k = env_rate_q8((uint64_t)(uint32_t)mul16(gl, period << 8));
    for (i = 0; i < n; i++) {
        int rst = reset[i] >= 32768 && r1 < 32768, clk = clock[i] >= 32768 && c1 < 32768;
        int32_t v;
        r1 = reset[i];
        c1 = clock[i];
        if (since >= 0 && since < (1 << 23))
            since++;
        if (clk) {
            if (since > 0)
                period = since;
            since = 0;
        }
        if (rst) {
            pos = 0;
            down = 0;
        } else if (clk) {
            if (pos >= len)
                pos = len - 1;
            if (dir == 1)
                pos = (pos + len - 1) % len;
            else if (dir == 2) {
                if (!down) {
                    if (pos + 1 < len)
                        pos++;
                    else {
                        pos = len - 2 > 0 ? len - 2 : 0;
                        down = 1;
                    }
                } else if (pos > 0)
                    pos--;
                else {
                    pos = len - 1 < 1 ? len - 1 : 1;
                    down = 0;
                }
            } else if (dir == 3) {
                seed = seed * 1664525u + 1013904223u;
                pos = (int32_t)((seed >> 16) % (uint32_t)len);
            } else
                pos = (pos + 1) % len;
        }
        v = steps[pos < len ? pos : len - 1];
        if (k > 0) {
            y += mulq(k, (v << 8) - y, 30);
            out[i] = (y + 128) >> 8;
        } else
            out[i] = v, y = v << 8;
        if (glen > 0 && period > 0) {
            if (clk)
                gleft = v > -ENG_ONE ? (int32_t)(((int64_t)glen * period + 32768) >> 16) : 0;
            gate[i] = gleft > 0 ? ENG_ONE : 0;
            if (gleft > 0)
                gleft--;
        } else
            gate[i] = clock[i] >= 32768 && v > -ENG_ONE ? ENG_ONE : 0;
    }
    it->s.seq.pos = (int8_t)pos;
    it->s.seq.down = (int8_t)down;
    it->s.seq.c1 = c1;
    it->s.seq.r1 = r1;
    it->s.seq.seed = seed;
    it->s.seq.y = y;
    it->s.seq.period = period;
    it->s.seq.since = since;
    it->s.seq.gleft = gleft;
}

static void m_clkdiv(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clock = it->in[CLKDIV_I_CLOCK], *reset = it->in[CLKDIV_I_RESET];
    int32_t div = clampi(round_q16(EF(it, CLKDIV_P_DIV)), 1, 16), count = it->s.cdv.count, c1 = it->s.cdv.c1, r1 = it->s.cdv.r1;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int hi;
        if (reset[i] >= 32768 && r1 < 32768)
            count = -1;
        else if (clock[i] >= 32768 && c1 < 32768)
            count = (count + 1) % (16 * div);
        r1 = reset[i];
        c1 = clock[i];
        hi = clock[i] >= 32768 && count >= 0;
        it->out[CLKDIV_O_OUT][i] = hi && count % div == 0 ? ENG_ONE : 0;
        it->out[CLKDIV_O_D2][i] = hi && (count & 1) == 0 ? ENG_ONE : 0;
        it->out[CLKDIV_O_D4][i] = hi && (count & 3) == 0 ? ENG_ONE : 0;
        it->out[CLKDIV_O_D8][i] = hi && (count & 7) == 0 ? ENG_ONE : 0;
    }
    it->s.cdv.count = count;
    it->s.cdv.c1 = c1;
    it->s.cdv.r1 = r1;
}

static void m_sh(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SH_I_IN], *clock = it->in[SH_I_CLOCK];
    esig_t *out = it->out[0];
    int track = round_q16(EF(it, SH_P_MODE)) == 1;
    int32_t v = it->s.sh.v, c1 = it->s.sh.c1;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int up = clock[i] >= 32768;
        if (track ? up : up && c1 < 32768)
            v = in[i];
        c1 = clock[i];
        out[i] = v;
    }
    it->s.sh.v = v;
    it->s.sh.c1 = c1;
}

/* the Shift register's dac: the first `bits` stages as a binary number (s1 the highest bit), 0..1 in Q16, rounded
 * (modules.ts shregDac) */
static int32_t shreg_dac(uint32_t reg, int32_t bits)
{
    uint32_t d = (1u << bits) - 1u;
    return (int32_t)(((reg >> (SHREG_STAGES - bits)) * 65536u + (d >> 1)) / d);
}

/* Shift register (modules.ts shreg, #438): on a rising clock every stage takes the one before it and s1 takes a new bit,
 * `in` when patched, else stage `len` comes round; the bit flips when the flip stream's next value is under `flip`. A
 * rising reset restores the starting pattern and restarts the stream (it wins over a clock on the same sample). The
 * stages, dac and gate are written only where something reads them; between edges the stages hold. */
static void m_shreg(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clock = it->in[SHREG_I_CLOCK], *in = it->in[SHREG_I_IN], *reset = it->in[SHREG_I_RESET];
    esig_t *dac = it->out[SHREG_O_DAC], *go = it->out[SHREG_O_GATE];
    int32_t len = clampi(round_q16(EF(it, SHREG_P_LEN)), 1, SHREG_STAGES), bits = clampi(round_q16(EF(it, SHREG_P_BITS)), 1, SHREG_STAGES);
    uint32_t flip = (uint32_t)clampi(EF(it, SHREG_P_FLIP), 0, ENG_ONE), rnd = it->s.shr.rnd, reg = it->s.shr.reg, i, j, from = 0;
    int data = (nd->conn >> SHREG_I_IN) & 1, c1 = it->s.shr.c1, r1 = it->s.shr.r1;
    int32_t dv = shreg_dac(reg, bits);
    if (!(nd->conn & ((1u << SHREG_I_CLOCK) | (1u << SHREG_I_RESET)))) {   /* no edges can come: everything holds */
        for (j = 0; j < SHREG_STAGES; j++)
            if (!IS_DUMMY(it->out[SHREG_O_S1 + j]))
                fill(it->out[SHREG_O_S1 + j], (reg >> (7 - j)) & 1u ? ENG_ONE : 0, n);
        if (!IS_DUMMY(dac))
            fill(dac, dv, n);
        if (!IS_DUMMY(go))
            fill(go, 0, n);
        it->s.shr.c1 = it->s.shr.r1 = 0;
        return;
    }
    for (i = 0; i <= n; i++) {
        int k = 0, r = 0, edge = 0;
        if (i < n) {
            k = clock[i] >= 32768;
            r = reset[i] >= 32768;
            edge = (r && !r1) || (k && !c1);
        }
        if (edge || i == n) {                /* the stages and dac held over from..i-1 */
            for (j = 0; j < SHREG_STAGES; j++) {
                esig_t *o = it->out[SHREG_O_S1 + j];
                if (!IS_DUMMY(o))
                    fill(o + from, (reg >> (7 - j)) & 1u ? ENG_ONE : 0, i - from);
            }
            if (!IS_DUMMY(dac))
                fill(dac + from, dv, i - from);
            from = i;
            if (i == n)
                break;
            if (r && !r1) {
                reg = it->s.shr.pat;
                rnd = it->s.shr.rnd0;
            } else {
                uint32_t src = data ? in[i] >= 32768 : (reg >> (SHREG_STAGES - len)) & 1u;
                rnd = lcg(rnd);
                reg = (reg >> 1) | ((src ^ ((rnd >> 16) < flip)) << 7);
            }
            dv = shreg_dac(reg, bits);
        }
        c1 = k;
        r1 = r;
        if (!IS_DUMMY(go))
            go[i] = k && (reg & 0x80u) ? ENG_ONE : 0;
    }
    it->s.shr.rnd = rnd;
    it->s.shr.reg = (uint8_t)reg;
    it->s.shr.c1 = (uint8_t)c1;
    it->s.shr.r1 = (uint8_t)r1;
}

/* Comparator (modules.ts comp, #438): gt while a - b - thresh is above hyst, until it falls below -hyst; lt its inverse;
 * trig the sample gt rises on */
static void m_comp(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *a = it->in[COMP_I_A], *b = it->in[COMP_I_B];
    esig_t *gt = it->out[COMP_O_GT], *lt = it->out[COMP_O_LT], *tr = it->out[COMP_O_TRIG];
    int32_t t = EF(it, COMP_P_THRESH), h = EF(it, COMP_P_HYST);
    int hi = it->s.cmp.hi;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t d = a[i] - b[i] - t;
        int was = hi;
        if (was ? d < -h : d > h)
            hi = !was;
        gt[i] = hi ? ENG_ONE : 0;
        lt[i] = hi ? 0 : ENG_ONE;
        tr[i] = hi && !was ? ENG_ONE : 0;
    }
    it->s.cmp.hi = (uint8_t)hi;
    (void)nd;
}

/* the Range module's curve on t (Q16; modules.ts rangeCurve): t + c t (t - 1) inside 0..1, straight on with the end's
 * slope outside it (1 - c below, 1 + c above) */
static int32_t range_curve(int32_t t, int32_t c)
{
    if (t < 0)
        return t - mul16(t, c);
    if (t > ENG_ONE)
        return ENG_ONE + mul16(t - ENG_ONE, ENG_ONE + c);
    return t + mul16(c, mul16(t, t - ENG_ONE));
}

/* Range (#526; modules.ts range): in from in low..in high to out low..out high along the curve; clamp holds t to 0..1,
 * else t stays within +-RANGE_T_MAX. 1 / (in high - in low) is worked out once a block (Q16), so a sample costs three
 * 64-bit multiplies, two fewer with the curve at 0. */
static void m_range(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *x = it->in[RANGE_I_IN];
    esig_t *o = it->out[RANGE_O_OUT];
    int32_t lo = EF(it, RANGE_P_INLO), span = EF(it, RANGE_P_INHI) - lo;
    int32_t olo = EF(it, RANGE_P_OUTLO), ospan = EF(it, RANGE_P_OUTHI) - olo;
    int32_t c = clampi(EF(it, RANGE_P_CURVE), -ENG_ONE, ENG_ONE);
    const int32_t clamp = EF(it, RANGE_P_CLAMP) >= ENG_ONE / 2;
    /* tlo 0 or -RANGE_T_MAX Q16 as a shift of clamp - 1: written as a constant it is 0xFFC00000, which build.py rejects as
     * a chip ROM address */
    const int32_t thi = clamp ? ENG_ONE : RANGE_T_MAX * ENG_ONE, tlo = (clamp - 1) * (RANGE_T_MAX * ENG_ONE);
    int64_t inv = span ? ((int64_t)1 << 32) / span : 0;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int64_t t = ((int64_t)(x[i] - lo) * inv) >> 16;
        int32_t u = t < tlo ? tlo : t > thi ? thi : (int32_t)t;
        if (c)
            u = range_curve(u, c);
        o[i] = olo + (int32_t)(((int64_t)u * ospan) >> 16);
    }
    (void)nd;
}

/* Matrix (#525; modules.ts matrix): out o = the sum of in i x pin (i, o) (Q16, -1..1), the pins at block rate as a Mixer's
 * levels. Only outputs something reads are written, and of each only the inputs patched with a pin off 0 are read, so a
 * sparse matrix costs what its pins in use cost. */
#define MATRIX_N MATRIX_NOUT
static void m_matrix(const node_t *nd, inst_t *it, uint32_t n)
{
    uint32_t i, o, k, m;
    for (o = 0; o < MATRIX_N; o++) {
        esig_t *out = it->out[MATRIX_O_OUT1 + o];
        const esig_t *src[MATRIX_N];
        int32_t g[MATRIX_N];
        if (IS_DUMMY(out))
            continue;
        for (m = 0, k = 0; k < MATRIX_N; k++) {
            int32_t a = EF(it, MATRIX_P_I1O1 + o * MATRIX_N + k);
            if (a && (nd->conn >> (MATRIX_I_IN1 + k)) & 1u) {
                src[m] = it->in[MATRIX_I_IN1 + k];
                g[m++] = a;
            }
        }
        switch (m) {
        case 0:
            fill(out, 0, n);
            break;
        case 1:
            for (i = 0; i < n; i++)
                out[i] = mul16(src[0][i], g[0]);
            break;
        case 2:
            for (i = 0; i < n; i++)
                out[i] = mul16(src[0][i], g[0]) + mul16(src[1][i], g[1]);
            break;
        default:
            for (i = 0; i < n; i++) {
                int32_t v = mul16(src[0][i], g[0]) + mul16(src[1][i], g[1]) + mul16(src[2][i], g[2]);
                if (m > 3u)
                    v += mul16(src[3][i], g[3]);
                out[i] = v;
            }
            break;
        }
    }
}

/* the quantizer's scales (modules.ts SCALES), semitones above the root */
static const uint8_t SC_CHROM[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}, SC_MAJ[] = {0, 2, 4, 5, 7, 9, 11}, SC_MIN[] = {0, 2, 3, 5, 7, 8, 10};
static const uint8_t SC_PMAJ[] = {0, 2, 4, 7, 9}, SC_PMIN[] = {0, 3, 5, 7, 10}, SC_DOR[] = {0, 2, 3, 5, 7, 9, 10}, SC_MIX[] = {0, 2, 4, 5, 7, 9, 10};
static const uint8_t SC_BLUES[] = {0, 3, 5, 6, 7, 10}, SC_WHOLE[] = {0, 2, 4, 6, 8, 10}, SC_FIFTH[] = {0, 7}, SC_OCT[] = {0};
static const struct { const uint8_t *st; uint8_t n; } SCALES[] = {
    {SC_CHROM, 12}, {SC_MAJ, 7}, {SC_MIN, 7}, {SC_PMAJ, 5}, {SC_PMIN, 5}, {SC_DOR, 7}, {SC_MIX, 7}, {SC_BLUES, 6}, {SC_WHOLE, 6}, {SC_FIFTH, 2}, {SC_OCT, 1},
};
#define N_SCALES ((int32_t)(sizeof SCALES / sizeof SCALES[0]))
#define OCT_Q16 (12 * ENG_ONE)

static void m_quant(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[QUANT_I_IN];
    esig_t *out = it->out[0];
    int32_t si = clampi(round_q16(EF(it, QUANT_P_SCALE)), 0, N_SCALES - 1), root = round_q16(EF(it, QUANT_P_ROOT));
    const uint8_t *sc = SCALES[si].st;
    uint32_t ns = SCALES[si].n, i, k;
    for (i = 0; i < n; i++) {
        int32_t semis = clampi(in[i], -(1 << 27), 1 << 27) * 12 - root * ENG_ONE, oct, w, best, bd;
        oct = semis >= 0 ? semis / OCT_Q16 : -((-semis + OCT_Q16 - 1) / OCT_Q16);     /* floor */
        w = semis - oct * OCT_Q16;
        best = sc[0] * ENG_ONE;
        bd = w - best < 0 ? best - w : w - best;
        for (k = 1; k <= ns; k++) {
            int32_t d = (k < ns ? sc[k] : sc[0] + 12) * ENG_ONE, dd = w - d < 0 ? d - w : w - d;
            if (dd < bd) {
                bd = dd;
                best = d;
            }
        }
        out[i] = (oct * OCT_Q16 + best + root * ENG_ONE) / 12;
    }
}

static void m_pulse(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *trig = it->in[PULSE_I_TRIG];
    esig_t *out = it->out[0];
    int32_t len = (int32_t)((((uint64_t)(uint32_t)EF(it, PULSE_P_TIME) * ENG_SR) + 32768u) >> 16), rem = it->s.pls.rem, t1 = it->s.pls.t1;
    uint32_t i;
    if (len < 1)
        len = 1;
    if (EF(it, PULSE_P_INF) >= 32768) {          /* inf: the window does not count down */
        for (i = 0; i < n; i++) {
            if (trig[i] >= 32768 && t1 < 32768)
                rem = len;
            t1 = trig[i];
            out[i] = rem > 0 ? ENG_ONE : 0;
        }
    } else
        for (i = 0; i < n; i++) {
            if (trig[i] >= 32768 && t1 < 32768)
                rem = len;
            t1 = trig[i];
            out[i] = rem > 0 ? ENG_ONE : 0;
            if (rem > 0)
                rem--;
        }
    it->s.pls.rem = rem;
    it->s.pls.t1 = t1;
}

/* equal-power pan: (p + 1) / 8 of a turn, r = sin, l = cos */
static void m_pan(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[PAN_I_IN], *pos = it->in[PAN_I_POS];
    esig_t *l = it->out[PAN_O_L], *r = it->out[PAN_O_R];
    int32_t base = EF(it, PAN_P_PAN);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t p = clampi(base + pos[i], -ENG_ONE, ENG_ONE);
        uint32_t turn = (uint32_t)(p + ENG_ONE) << 13;
        l[i] = mul16(in[i], sin_turn(turn + 0x40000000u));
        r[i] = mul16(in[i], sin_turn(turn));
    }
}

static void m_xfade(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *a = it->in[XFADE_I_A], *b = it->in[XFADE_I_B], *pos = it->in[XFADE_I_POS];
    esig_t *out = it->out[0];
    int32_t base = EF(it, XFADE_P_MIX);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t m = clampi(base + pos[i], 0, ENG_ONE);
        out[i] = mul16(a[i], ENG_ONE - m) + mul16(b[i], m);
    }
}

/* Selector (modules.ts select): `pos` plus the `pos` input (read once per block; 0..1 spans 1..count), rounded, chooses
 * one of in1..in8; out = that input + its value v1..v8, its gate high, the others low. `fade` (ms) moves every input's
 * weight towards 1 (chosen) or 0 by a fixed Q16 increment per sample (modules.ts selectFadeInc) */
#define SEL_N (SELECT_NOUT - 1)   /* its positions: the outputs less out */
static void m_select(inst_t *it, uint32_t n)
{
    esig_t *out = it->out[SELECT_O_OUT];
    int32_t cnt = clampi(round_q16(EF(it, SELECT_P_COUNT)), 2, SEL_N);
    int32_t pos = EF(it, SELECT_P_POS) + it->in[SELECT_I_POS][0] * (cnt - 1);
    int32_t k = clampi((pos + 32768) >> 16, 1, cnt) - 1;
    /* samples of the fade: fade (Q16 ms) x ENG_SR / 1000, as (ENG_SR << 16) / 1000 = 2891317 in Q16 */
    uint32_t fs = (uint32_t)(((int64_t)clampi(EF(it, SELECT_P_FADE), 0, 100 << 16) * 2891317) >> 32);
    int32_t inc = fs ? (int32_t)(65536u / fs) : ENG_ONE;
    uint32_t i, j;
    if (it->s.sel.k < 0 || (k != it->s.sel.k && inc >= ENG_ONE)) {
        for (j = 0; j < SEL_N; j++)
            it->s.sel.w[j] = 0;
        it->s.sel.w[k] = ENG_ONE;
        it->s.sel.fading = 0;
    } else if (k != it->s.sel.k) {
        it->s.sel.fading = 1;
    }
    it->s.sel.k = (int8_t)k;
    if (!it->s.sel.fading) {
        const esig_t *x = it->in[SELECT_I_IN1 + k];
        int32_t v = EF(it, SELECT_P_V1 + k);
        if (x == zero_buf)
            fill(out, v, n);
        else if (!IS_DUMMY(out))
            for (i = 0; i < n; i++)
                out[i] = x[i] + v;
    } else {
        int32_t *w = it->s.sel.w;
        uint32_t busy = 0;
        for (i = 0; i < n; i++) {
            int32_t y = 0;
            for (j = 0; j < SEL_N; j++) {
                int32_t t = (int32_t)j == k ? ENG_ONE : 0, wj = w[j];
                if (wj == 0 && t == 0)
                    continue;
                wj = wj < t ? (wj + inc < t ? wj + inc : t) : (wj - inc > t ? wj - inc : t);
                w[j] = wj;
                y += mul16(it->in[SELECT_I_IN1 + j][i] + EF(it, SELECT_P_V1 + j), wj);
            }
            out[i] = y;
        }
        for (j = 0; j < SEL_N; j++)
            busy |= (uint32_t)(w[j] != ((int32_t)j == k ? ENG_ONE : 0));
        it->s.sel.fading = (uint8_t)busy;
    }
    for (j = 0; j < SEL_N; j++) {
        esig_t *g = it->out[SELECT_O_G1 + j], v = (int32_t)j == k ? ENG_ONE : 0;
        if (IS_DUMMY(g))
            continue;
        for (i = 0; i < n; i++)
            g[i] = v;
    }
}

/* the formants (Hz) of A E I O U; gains 1, 1/2, 1/4 */
static const int16_t FORMANT_HZ[5][3] = {{730, 1090, 2440}, {530, 1840, 2480}, {390, 1990, 2550}, {570, 840, 2410}, {440, 1020, 2240}};

/* three parallel SVF band passes (normalized band k v1, peak 1) at the formants of vowel + input, set once per block */
static void m_vowel(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[VOWEL_I_IN], *vin = it->in[VOWEL_I_VOWEL];
    esig_t *out = it->out[0];
    int32_t v = clampi(EF(it, VOWEL_P_VOWEL) + vin[0], 0, 4 << 16), vi = v >> 16, t, lvl = EF(it, VOWEL_P_LEVEL);
    int32_t q16 = (2 << 16) + 18 * EF(it, VOWEL_P_RES), k24 = (int32_t)(((int64_t)1 << 40) / q16);
    svf_coef_t c[3];
    uint32_t i, f;
    if (vi > 3)
        vi = 3;
    t = v - (vi << 16);
    for (f = 0; f < 3u; f++) {
        int32_t hz = ((int32_t)FORMANT_HZ[vi][f] << 16) + (int32_t)((int64_t)(FORMANT_HZ[vi + 1][f] - FORMANT_HZ[vi][f]) * t);
        svf_stage(&c[f], svf_g(hz_turns((uint32_t)hz)), k24);
    }
    for (i = 0; i < n; i++) {
        int32_t v0 = in[i] << 4, sum = 0;
        for (f = 0; f < 3u; f++) {
            int32_t ic1 = it->s.vow.ic1[f], ic2 = it->s.vow.ic2[f];
            int32_t v3 = v0 - ic2;
            int32_t v1 = mulr(c[f].a1, ic1, 24) + mulr(c[f].a2, v3, 24);
            int32_t v2 = ic2 + mulr(c[f].a2, ic1, 24) + mulr(c[f].a3, v3, 24);
            it->s.vow.ic1[f] = clampi(2 * v1 - ic1, -(1 << 30), 1 << 30);
            it->s.vow.ic2[f] = clampi(2 * v2 - ic2, -(1 << 30), 1 << 30);
            sum += mulr(v1, k24, 24) >> f;
        }
        out[i] = mul16((sum + 8) >> 4, lvl);
    }
}

#define INC_20HZ ((uint32_t)((20ull << 32) / ENG_SR))   /* 20 Hz as a phase increment */

/* four first-order allpasses in series with one coefficient a = (g - 1) / (g + 1), g = tan(pi f / sr), f = center *
 * 2^(2 depth tri) from a triangle sweep, once per block; feedback from stage 4 into stage 1 */
static void m_phaser(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[PHASER_I_IN];
    esig_t *out = it->out[0];
    uint32_t dt = hz_turns((uint32_t)EF(it, PHASER_P_RATE)), phase = it->s.phs.phase, i, k;
    int32_t tri = wave_tri(phase), oct = mul16(2 * EF(it, PHASER_P_DEPTH), tri);
    uint32_t rinc = exp2_scale(hz_turns((uint32_t)EF(it, PHASER_P_CENTER)), oct);
    int32_t g, a, fb = EF(it, PHASER_P_FB), mix = EF(it, PHASER_P_MIX), dry = ENG_ONE - mix, fbv = it->s.phs.fbv, *ap = it->s.phs.ap;
    if (rinc < INC_20HZ)
        rinc = INC_20HZ;
    g = svf_g(rinc);
    a = (int32_t)(((int64_t)(g - (1 << 24)) << 24) / (g + (1 << 24)));
    for (i = 0; i < n; i++) {
        int32_t x0 = in[i], x = clampi(x0 + mul16(fb, fbv), -(8 << 16), 8 << 16);
        for (k = 0; k < 4u; k++) {
            int32_t y = mulq(a, x - ap[2 * k + 1], 24) + ap[2 * k];
            ap[2 * k] = x;
            ap[2 * k + 1] = y;
            x = y;
        }
        fbv = x;
        out[i] = mul16(x0, dry) + mul16(x, mix);
    }
    it->s.phs.fbv = fbv;
    it->s.phs.phase = phase + n * dt;
}

/* 2^bits levels over -1..1 (a step of 2^(17 - bits) in Q16), every taken sample held for `rate` samples */
/* bits / rate reduction; os: 2x oversampled (the rate counts input samples either way: the counter runs at 2 rate) */
static void m_crush(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[CRUSH_I_IN];
    esig_t *out = it->out[0];
    int32_t bits = clampi(round_q16(EF(it, CRUSH_P_BITS)), 1, 16), rate = clampi(round_q16(EF(it, CRUSH_P_RATE)), 1, 64);
    int32_t held = it->s.crush.held, cnt = it->s.crush.cnt, *ap = it->s.crush.ap;
    int os = EF(it, CRUSH_P_OS) >= 32768;
    unsigned sh = (unsigned)(17 - bits);
    uint32_t i;
    if (os)
        rate *= 2;
    for (i = 0; i < n; i++) {
        if (os) {
            int32_t u0 = os_up0(ap, in[i]), u1 = os_up1(ap, in[i]), y0, y1;
            if (cnt <= 0) {
                held = ((u0 + (1 << (sh - 1))) >> sh) << sh;
                cnt = rate;
            }
            cnt--;
            y0 = held;
            if (cnt <= 0) {
                held = ((u1 + (1 << (sh - 1))) >> sh) << sh;
                cnt = rate;
            }
            cnt--;
            y1 = held;
            out[i] = os_down(ap + 8, &it->s.crush.xb, y0, y1);
            continue;
        }
        if (cnt <= 0) {
            held = ((in[i] + (1 << (sh - 1))) >> sh) << sh;
            cnt = rate;
        }
        cnt--;
        out[i] = held;
    }
    it->s.crush.held = held;
    it->s.crush.cnt = cnt;
}

/* ------------------------------------------------------------------ rendering */

/* Block-rate parameter modulation (engine.ts applyCv): the mean of p1 / p2 over the block, times the attenuverter, is
 * added (times the range) to the parameters the matrix assigns that input to; clamped when something was added. */
/* Instances of one module run consecutively. A shared input buffer cannot change between them; a summed input or
 * per-part output has its own buffer. Reuse only the previous rendered instance's means, including after idle skips. */
static int32_t signal_mean(const esig_t *src, uint32_t n)
{
    int64_t sum = 0;
    uint32_t i;
    for (i = 0; i < n; i++)
        sum += src[i];
    return block_mean(sum, n);
}

HOT void apply_cv(const node_t *nd, inst_t *it, uint32_t n, const inst_t *prev, int32_t *means)   /* (inlined: render_mods and aot.c aot_cv call it) */
{
    const def_t *d = &DEFS[nd->type];
    int32_t mean[2] = {0, 0}, extra[MAX_IN];   /* extra[s] is read only where input_map[s] set it (no memset per call) */
    uint32_t j, s, have = 0, side = 0, mapped = 0;   /* side: some input has side routes (input_map) */
    const int32_t *par = nd->par, *parb = par + d->npar;   /* (the node's and the instance's slots, kept in registers; PARB) */
    int32_t *eff = it->eff;
    if (ramp[0].left | ramp[1].left | ramp[2].left | ramp[3].left)   /* a knob's click still on its way (#405) */
        par = ramp_base(nd, par, d->npar, IT_LANE(nd, it));
    if (nd->locked)                              /* P-locks (#524) */
        par = lock_base(nd, par, d->npar, IT_LANE(nd, it));
    if (d->cvbase >= 0)
        for (s = 0; s < 2u; s++) {
            const esig_t *cv;
            uint32_t pin = d->cvbase + s;
            if (!nd->map[s] || !(nd->conn & (1u << pin)))
                continue;
            cv = it->in[pin];
            if (!prev || cv != prev->in[pin])
                means[pin] = signal_mean(cv, n);
            mean[s] = mul16(means[pin], nd->att[s]);
            have |= 1u << s;
            mapped |= nd->map[s];
        }
    for (s = 0; s < d->nin; s++) if (nd->input_map[s]) {
        if (!prev || it->in[s] != prev->in[s])
            means[s] = signal_mean(it->in[s], n);
        extra[s] = means[s];
        side = 1;
        mapped |= nd->input_map[s];
    }
    /* Most modules have no parameter modulation. Copy their base values without visiting each parameter's routes. */
    if (!have && !side && !(nd->morph && E.morph > 0 && nd->type != T_FM1)) {
        for (j = 0; j < d->npar; j++)
            eff[j] = par[j];
        return;
    }
    for (j = 0; j < d->npar; j++) {
        int32_t v = nd->morph && E.morph > 0 && nd->type != T_FM1 ? morph_of(d, j, par[j], (uint32_t)parb[j], E.morph, nd->over >> j & 1u) : par[j];
        uint32_t touched = 0;
        int32_t mod = 0, rv = 0;
        const range_t *rg = 0;
        if (!(mapped >> j & 1u)) {
            eff[j] = v;
            continue;
        }
        for (s = 0; s < 2u; s++)
            if ((have >> s & 1u) && (nd->map[s] >> j & 1u)) {
                if (nd->ranged[s] >> j & 1u) {   /* a macro range: the input's value lands between its ends (replacing the base) */
                    const range_t *r = range_find((uint32_t)(nd - E.node), s, j);
                    if (r) {
                        rg = r;
                        rv += r->bi ? (mean[s] + ENG_ONE) >> 1 : mean[s];   /* (bipolar: -1..1 across the ends, #526) */
                        continue;
                    }
                }
                mod += mean[s];
                touched = 1;
            }
        if (side) for (s = 0; s < d->nin; s++) if (nd->input_map[s] >> j & 1u) {
            mod += extra[s];
            touched = 1;
        }
        if (rg) {
            int32_t lo = (int32_t)rg->lo * 257, hi = (int32_t)rg->hi * 257;   /* 0..255 -> Q16 0..1 */
            v = morph_value(d, j, lo + mul16(clampi(rv, 0, ENG_ONE), hi - lo));
        }
        if (!touched)
            eff[j] = v;
        else if (d->plog && d->plog[j])
            eff[j] = value_of(d, j, unit_of(d, j, v) + mod);            /* in octaves */
        else
            eff[j] = clampi(v + mul16(mod, d->pmax[j] - d->pmin[j]), d->pmin[j], v <= d->pmax[j] ? d->pmax[j]
                            : d == &DEFS[T_DELAY] && j == DELAY_P_TIME ? DELAY_TIME_TOP : DEF_TOP(d, j));   /* (a base past pmax: a stretch; the Delay's time: up to the longest length) */
    }
}

/* a part's flaws on its copy's effective parameters (engine.ts applyFlaws): bright x 2^(st / 12) on the filter / ladder
 * cutoff, env x (100 + %) / 100 on the ADSR / envelope times, level x % / 100 on the VCA gain; clamped to the range */
static void flaw_scale(const def_t *d, inst_t *it, uint32_t j, int64_t k_q16)
{
    if (k_q16 != ENG_ONE)
        it->eff[j] = clampi((int32_t)(((int64_t)it->eff[j] * k_q16) >> 16), d->pmin[j], d->pmax[j]);
}
HOT void apply_flaws(const node_t *nd, inst_t *it)
{
    const def_t *d = &DEFS[nd->type];
    const grp_t *g = IT_G(nd);
    uint32_t v = IT_V(nd, it);
    int32_t b = g->bright[v], e = g->env[v], l = g->level[v];
    int64_t ke = ((int64_t)(100 + e) << 16) / 100, kl = ((int64_t)l << 16) / 100;
    switch (nd->type) {
    case T_FILTER:
    case T_LADDER:
        if (b)
            flaw_scale(d, it, nd->type == T_FILTER ? FILTER_P_CUTOFF : LADDER_P_CUTOFF, (int64_t)exp2_q16(b * 65536 / 12 + (16 << 16)));
        break;
    case T_ADSR:
        flaw_scale(d, it, ADSR_P_A, ke);
        flaw_scale(d, it, ADSR_P_D, ke);
        flaw_scale(d, it, ADSR_P_R, ke);
        break;
    case T_ENV:
        flaw_scale(d, it, ENV_P_R1, ke);
        flaw_scale(d, it, ENV_P_R2, ke);
        flaw_scale(d, it, ENV_P_R3, ke);
        flaw_scale(d, it, ENV_P_R4, ke);
        break;
    case T_ENV8: {
        uint32_t s;
        for (s = 0; s < 8u; s++)
            flaw_scale(d, it, ENV8_P_R1 + 2u * s, ke);
        break;
    }
    case T_VCA:
        flaw_scale(d, it, VCA_P_GAIN, kl);
        break;
    default:
        break;
    }
}

/* a bypassed module: every output carries the through input (the definition's `thru`, e.g. the filter's `in`), or silence
 * for a module without one (an oscillator or envelope is muted). Its state is untouched, so it resumes where it stopped. */
static void m_bypass(const node_t *nd, inst_t *it, uint32_t n)
{
    const def_t *d = &DEFS[nd->type];
    const esig_t *src = d->thru >= 0 ? it->in[d->thru] : zero_buf;
    uint32_t j, i;
    for (j = 0; j < d->nout; j++) {
        esig_t *o = it->out[j];
        if (IS_DUMMY(o))
            continue;
        for (i = 0; i < n; i++)
            o[i] = src[i];
    }
}

static void process(const node_t *nd, inst_t *it, uint32_t n)
{
    switch (nd->type) {
    case T_FM1: m_fm1(nd, it, n); break;
    case T_PART: m_part(nd, it, n); break;
    case T_ARP: m_arp(nd, it, n); break;
    case T_HARM: fill(it->out[HARM_O_KEYS], 0, n); break;
    case T_RANDOM: m_random(nd, it, n); break;
    case T_OSC: if (EF(it, OSC_P_ANALOG) > 0) m_osc_ana(nd, it, n); else m_osc(nd, it, n); break;   /* (#673) */
    case T_LFO: m_lfo(nd, it, n); break;
    case T_NOISE: m_noise(nd, it, n); break;
    case T_CONST: m_const(nd, it, n); break;
    case T_MACRO: m_const(nd, it, n); break;   /* a Macro is a Constant with the knobs' range 0..1 */
    case T_SCALE: m_scale(nd, it, n); break;
    case T_ADSR: m_adsr(nd, it, n); break;
    case T_VCA: m_vca(nd, it, n); break;
    case T_FILTER: m_filter(nd, it, n); break;
    case T_MIXER: m_mixer(nd, it, n); break;
    case T_DELAY: m_delay(nd, it, n); break;
    case T_REVERB: m_reverb(nd, it, n); break;
    case T_GLIDE: m_glide(nd, it, n); break;
    case T_SHAPE: m_shape(nd, it, n); break;
    case T_ENV: m_env(nd, it, n); break;
    case T_ENV8: m_env8(nd, it, n); break;
    case T_RATEENV: m_rateenv(nd, it, n); break;
    case T_RATIO: m_ratio(nd, it, n); break;
    case T_STRING: m_string(nd, it, n); break;
    case T_WAVETABLE: m_wavetable(nd, it, n); break;
    case T_PD: m_pd(nd, it, n); break;
    case T_CHORUS: m_chorus(nd, it, n); break;
    case T_SEQ: m_seq(nd, it, n); break;
    case T_STEPS: m_steps(nd, it, n); break;
    case T_DRUMMAP: m_drummap(nd, it, n); break;
    case T_CLKDIV: m_clkdiv(nd, it, n); break;
    case T_SH: m_sh(nd, it, n); break;
    case T_SHREG: m_shreg(nd, it, n); break;
    case T_COMP: m_comp(nd, it, n); break;
    case T_RANGE: m_range(nd, it, n); break;
    case T_MATRIX: m_matrix(nd, it, n); break;
    case T_QUANT: m_quant(nd, it, n); break;
    case T_PULSE: m_pulse(nd, it, n); break;
    case T_PAN: m_pan(nd, it, n); break;
    case T_XFADE: m_xfade(nd, it, n); break;
    case T_SELECT: m_select(it, n); break;
    case T_VOWEL: m_vowel(nd, it, n); break;
    case T_PHASER: m_phaser(nd, it, n); break;
    case T_LADDER: m_ladder(nd, it, n); break;
    case T_DYN: m_dyn(nd, it, n); break;
    case T_ESP: m_esp(nd, it, n); break;
    case T_MATH: m_math(nd, it, n); break;
    case T_LOGIC: m_logic(nd, it, n); break;
    case T_GRAIN: m_grain(nd, it, n); break;
    case T_COMB: m_comb(nd, it, n); break;
    case T_MODAL: m_modal(nd, it, n); break;
    case T_SHIFT: m_shift(nd, it, n); break;
    case T_CRUSH: m_crush(nd, it, n); break;
    default: break;                      /* output: read by eng_render */
    }
}

/* Profiling hooks for the CPU estimate (tools/cpu): stage 0 before a module's input sums, 1 before its parameter
 * inputs, 2 before it runs, 3 after; 4 at the start of a block, 5 at its end. Compiled out unless ENG_PROF is defined. */
#ifndef ENG_PROF
#define ENG_PROF(stage, node, part) ((void)0)
#endif
/* The device's block timing (#802, #803; modular.c, blk_time.h): a timestamp before the voices (0), after them (1) and
 * before the Output modules' sum (2). Compiled out unless ENG_TMARK is defined. */
#ifndef ENG_TMARK
#define ENG_TMARK(at) ((void)0)
#endif

#define cur_g_parts(nd) ((uint32_t)E.grp[(nd)->grp].parts)

/* Idle parts (engine.ts partIdle, the same rule): a part of a poly group whose gate is low, whose envelopes (ADSR / level
 * envelope, eight-step envelope, at least one) have all finished, and whose outputs that leave the group stayed within IDLE_Q16 for a whole block
 * is idle: those outputs are set to 0 and its modules are skipped until a note reaches it, except every IDLE_CHECK-th block,
 * which runs it and checks again (a part that sounds without its envelopes, a knob opening a drone, comes back). The checks
 * are staggered (#434): part v of group k runs in the blocks where (idle_blk + (k - 1) ENG_MAX_PARTS + v) % IDLE_CHECK is 0,
 * so parts that went idle together (every part after a load) do not all run in one block. */
#define IDLE_Q16 6
#define IDLE_CHECK 32u
static int part_quiet(uint32_t k, uint32_t v)
{
    uint32_t i, c, envs = 0;
    for (i = 0; i < E.nmod; i++) {
        const node_t *nd = &E.node[i];
        const inst_t *it;
        if (nd->grp != k || (nd->type != T_ADSR && nd->type != T_ENV && nd->type != T_ENV8 && nd->type != T_RATEENV))
            continue;
        it = &inst_pool[nd->inst0 + v];
        if (nd->type == T_ADSR ? it->s.adsr.stage != 0 : nd->type == T_ENV ? it->s.env.stage != 0 : nd->type == T_ENV8 ? it->s.env8.stage != 0 : it->s.rateenv.stage != 0)
            return 0;
        envs++;
    }
    if (!envs)
        return 0;
    for (c = 0; c < E.ncab; c++) {
        const node_t *f = &E.node[E.from_m[c]];
        const esig_t *o;
        if (f->grp != k || E.node[E.to_m[c]].grp == k)
            continue;
        o = inst_pool[f->inst0 + v].out[E.from_p[c]];
        for (i = 0; i < ENG_BLOCK; i++)
            if (o[i] > IDLE_Q16 || o[i] < -IDLE_Q16)
                return 0;
    }
    return 1;
}
static void part_silence(uint32_t k, uint32_t v)
{
    uint32_t c, i;
    for (c = 0; c < E.ncab; c++) {
        const node_t *f = &E.node[E.from_m[c]];
        esig_t *o;
        if (f->grp != k || E.node[E.to_m[c]].grp == k)
            continue;
        o = inst_pool[f->inst0 + v].out[E.from_p[c]];
        for (i = 0; i < ENG_BLOCK; i++)
            o[i] = 0;
    }
}


/* no source of the sum is weighted */
static int sum_plain(const sum_t *sm)
{
    uint32_t q;
    for (q = 0; q < sm->n; q++)
        if (E.sum_w[sm->first + q])
            return 0;
    return 1;
}

/* the modules E.order[k0..k1) for one block of n frames: every part v = first, first + step, .. of a module in a poly group,
 * once for a module that runs once (#271: step 2 renders one lane of a split segment, first 0 or 1; step 1 renders all) */
static void render_mods(uint32_t k0, uint32_t k1, uint32_t n, uint32_t first, uint32_t step)
{
    uint32_t k, v, s, i;
    for (k = k0; k < k1; k++) {
        const node_t *nd = &E.node[E.order[k]];
        const inst_t *prev = 0;
        int32_t means[MAX_IN];
        uint32_t ninst = nd->grp && cur_g_parts(nd) < nd->ninst ? cur_g_parts(nd) : nd->ninst;   /* (fewer after an overload: eng_shed) */
        for (v = nd->grp ? first : 0; v < ninst; v += nd->grp ? step : 1) {   /* every part (of a lane) of a module in a
                                                                             * poly group, once for the rest */
            inst_t *it = &inst_pool[nd->inst0 + v];
            if (nd->grp && E.pv[E.grp[nd->grp].pv0 + v].skip)
                continue;
            ENG_PROF(0, E.order[k], v);
            for (s = it->sum0; s < (uint32_t)it->sum0 + it->nsum; s++) {
                const sum_t *sm = &E.sum[s];
                esig_t *dst = sm->dst;
                uint32_t q;
                if (!sm->n) {
                    for (i = 0; i < n; i++)
                        dst[i] = 0;
                    continue;
                }
                if (sm->n >= 3u && sum_plain(sm)) {         /* unweighted (every sum of the factory patches): three or
                                                             * four sources a pass, dst read and written once a pass (#781) */
                    const esig_t *const *p = &E.sum_src[sm->first];
                    const esig_t *a = p[0], *b = p[1], *c = p[2];
                    if (sm->n >= 4u) {
                        const esig_t *d = p[3];
                        for (i = 0; i < n; i++)
                            dst[i] = a[i] + b[i] + c[i] + d[i];
                        q = 4;
                    } else {
                        for (i = 0; i < n; i++)
                            dst[i] = a[i] + b[i] + c[i];
                        q = 3;
                    }
                    for (; q + 3u <= sm->n; q += 3u) {
                        a = p[q], b = p[q + 1u], c = p[q + 2u];
                        for (i = 0; i < n; i++)
                            dst[i] += a[i] + b[i] + c[i];
                    }
                    for (; q < sm->n; q++) {
                        a = p[q];
                        for (i = 0; i < n; i++)
                            dst[i] += a[i];
                    }
                    continue;
                }
                if (sm->n >= 2) {                           /* the first two sources in one pass, the rest added */
                    const esig_t *a = E.sum_src[sm->first], *b = E.sum_src[sm->first + 1u];
                    const int32_t wa = E.sum_w[sm->first], wb = E.sum_w[sm->first + 1u];
                    if (!wa && !wb)
                        for (i = 0; i < n; i++)
                            dst[i] = a[i] + b[i];
                    else if (wa && wb)
                        for (i = 0; i < n; i++)
                            dst[i] = mul16(a[i], wa) + mul16(b[i], wb);
                    else
                        for (i = 0; i < n; i++)
                            dst[i] = (wa ? mul16(a[i], wa) : a[i]) + (wb ? mul16(b[i], wb) : b[i]);
                    q = 2;
                } else {
                    const esig_t *a = E.sum_src[sm->first];
                    const int32_t w = E.sum_w[sm->first];
                    if (w)
                        for (i = 0; i < n; i++)
                            dst[i] = mul16(a[i], w);
                    else
                        for (i = 0; i < n; i++)
                            dst[i] = a[i];
                    q = 1;
                }
                for (; q < sm->n; q++) {
                    const esig_t *src = E.sum_src[sm->first + q];
                    const int32_t w = E.sum_w[sm->first + q];
                    if (w)
                        for (i = 0; i < n; i++)
                            dst[i] += mul16(src[i], w);
                    else
                        for (i = 0; i < n; i++)
                            dst[i] += src[i];
                }
            }
            ENG_PROF(1, E.order[k], v);
            apply_cv(nd, it, n, prev, means);
            prev = it;
            if (nd->grp)
                apply_flaws(nd, it);
            ENG_PROF(2, E.order[k], v);
            if (nd->bypass)
                m_bypass(nd, it, n);
            else if (nd->disabled_inputs) {
                const esig_t *raw[MAX_IN];
                uint32_t input;
                for (input = 0; input < DEFS[nd->type].nin; input++) {
                    raw[input] = it->in[input];
                    if (nd->disabled_inputs & (1u << input)) it->in[input] = zero_buf;
                }
                process(nd, it, n);
                for (input = 0; input < DEFS[nd->type].nin; input++) it->in[input] = raw[input];
            } else
                process(nd, it, n);
            ENG_PROF(3, E.order[k], v);
        }
        if (nd->type == T_STEPS && E.nlt && first == 0u)   /* its P-locks for the step it is on (#524) */
            locks_step(nd, &inst_pool[nd->inst0]);
#ifdef ENG_POISON
        if (step == 1u)                                    /* (one core: the values whose last reader this was) */
            poi_after((int32_t)k);
#endif
    }
}

/* #271: the second core. A run of modules in one poly group with two or more parts (a segment of E.order) is split in two
 * lanes: the even parts on core 0, the odd parts on the second core at the same time; then core 0 goes on with the next
 * module. A part reads only its own part of its group, and modules that ran before the segment, so the lanes share
 * nothing but their inputs, and each lane renders exactly as one core would (the same arithmetic, each part's modules in
 * the same order). A Steps module (it writes the engine's track state) is never split. The hooks are the device's
 * (modular.c: the second core) or a test's (host_test.c: inline or a thread); without them core 0 renders both lanes. */
#ifndef ENG_LANE_HOOKS
static int eng_lane_run(void (*fn)(uint32_t), uint32_t arg) { (void)fn; (void)arg; return 0; }   /* 1: it took the job */
static int eng_lane_wait(void) { return 0; }                    /* 0: done; else given up (core 0 renders the lane) */
#endif
static struct { uint32_t k0, k1, n; } lane_job;
static void lane1_job(uint32_t arg)                 /* (on the second core) */
{
    (void)arg;
    render_mods(lane_job.k0, lane_job.k1, lane_job.n, 1u, 2u);
}

static int lane_splits(const node_t *nd)
{
    return nd->grp && cur_g_parts(nd) >= 2u && nd->ninst >= 2u && nd->type != T_STEPS;
}
/* does each lane of a segment of group `nd->grp` have a part that runs this block (not skipped as idle)? Else core 0
 * renders the segment alone: one lane awake (an idle part's check, a single note) gains nothing from the second core.
 * Handed to it anyway, Cassia 1's idle-check blocks took 3 to 4.6 ms in the emulator with two to four parts, against
 * 0.85 ms on one core: halves came out late and the overload guard shed three of its four voices right after a load,
 * with no key held (the 1.11 batch run). The lanes render exactly as one core would, so the sound is the same */
static int lanes_awake(const node_t *nd)
{
    const grp_t *g = &E.grp[nd->grp];
    uint32_t v, m = 0;
    for (v = 0; v < g->parts && m != 3u; v++)
        if (!E.pv[g->pv0 + v].skip)
            m |= 1u << (v & 1u);
    return m == 3u;
}

#include "aot.c"                                 /* factory assemblies compiled ahead of time (#808): AOT_OWNS, aot_bind */

static void render_split(uint32_t n)
{
    uint32_t k = 0, e;
    AOT_BLOCK_BEGIN();
    while (k < E.norder) {
        const node_t *nd = &E.node[E.order[k]];
        if (AOT_OWNS(k, n)) {                    /* a compiled assembly's member: its first renders them all */
            k++;
            continue;
        }
        if (!lane_splits(nd)) {
            render_mods(k, k + 1u, n, 0u, 1u);
            k++;
            continue;
        }
        for (e = k + 1u; e < E.norder && E.node[E.order[e]].grp == nd->grp && lane_splits(&E.node[E.order[e]]); e++)
            ;
        lane_job.k0 = k;
        lane_job.k1 = e;
        lane_job.n = n;
        if (lanes_awake(nd) && eng_lane_run(lane1_job, nd->grp)) {
            render_mods(k, e, n, 0u, 2u);
            if (eng_lane_wait() != 0)
                render_mods(k, e, n, 1u, 2u);           /* the second core was given up: lane 1 here */
        } else
            render_mods(k, e, n, 0u, 1u);
        k = e;
    }
}
static void render_voice(int32_t *left, int32_t *right, uint32_t total)   /* the patch, clamped */
{
    uint32_t off, i, k, v;
    for (i = 0; i < total; i++)
        left[i] = right[i] = 0;
    cko.n = 0;
    cko.edge = 0;
    click_k0 = click_k;                          /* (eng_click_mix: the click from here) */
    click_h0 = click_half;
    click_nev = 0;
    if (once_gen != once_seen) {                 /* play once asked for or ended (#632): from this render */
        uint8_t c = once_cmd;
        once_seen = once_gen;
        once_end();
        if (c == 1u && E.loaded) {
            once_st = 1;
            once_cin = 0;
            once_first = 1;
            E.tick_acc = 0;
        }
    }
    if (!E.loaded) {
        if (transport_on != cko.run) {           /* (no patch: no ticks, but Start / Stop still go out) */
            cko.run = transport_on;
            cko.edge = transport_on ? 1 : -1;
        }
        return;
    }
    for (off = 0; off < total; off += ENG_BLOCK) {
        uint32_t n = total - off < ENG_BLOCK ? total - off : ENG_BLOCK;
        int32_t click_at = -1, accent = 0;
        ENG_PROF(4, 0, 0);
#ifdef ENG_POISON
        poi_after(-1);
#endif
        if (once_st == 1u && once_cin >= ONCE_BAR) {   /* play once's count-in is over: the transport starts, each track */
            uint32_t s = E.song && E.song_n[E.song - 1u] ? E.song_n[E.song - 1u] : 1u;   /* the clock steps counts */
            once_st = 2;                                                                       /* its passes */
            once_run = 1;
            once_edge = 1;
            for (k = 0; k < E.norder; k++) {
                const node_t *nd = &E.node[E.order[k]];
                if (nd->type == T_STEPS)
                    E.trk_once[nd->trk] = ((nd->conn >> STEPS_I_CLK) & 1u) ? 0u : (uint8_t)(s + 2u);
            }
        }
        if (ramp[0].left | ramp[1].left | ramp[2].left | ramp[3].left)
            ramp_tick();
        E.morph = E.has_b ? morph_position(n) : 0;
        {   /* the clock: MIDI ticks while external, else the global tempo (D-907) or the Main module's (whole bpm x 24 ticks a
             * minute) */
            uint32_t bpm = tempo_glo > ENG_TEMPO_ADOPT ? tempo_glo
                         : E.main >= 0 ? (uint32_t)clampi((E.node[E.main].par[FM1_P_TEMPO] + 32768) >> 16, 20, 300) : TEMPO_DEFAULT, seen = 0, t;
            uint8_t run = transport_on | once_run;
            uint32_t was = E.ticks;              /* (the ticks before this block's: REC's count-in) */
            int start = run && !E.running;
            if (start) {
                E.tick_acc = 0;                  /* the transport starts: the tempo's ticks from here */
                E.run_ticks = E.ticks;
            }
            if (run != cko.run) {                /* MIDI clock out: the transport's edge, and tick 0 on a start's first sample */
                cko.run = run;
                cko.edge = (int8_t)((run ? 1 : -1) * (once_edge ? 2 : 1));
                if (run && !clk_ext && cko.n < CKO_MAX)
                    cko.off[cko.n++] = (uint16_t)off;
            }
            E.running = run;
            once_edge = 0;
            t = clk_ticks;
            /* where this block's ticks fall (Steps modules start their steps there, engine.ts render): MIDI clock ticks on the
             * first sample, the tempo's on the sample that completes the tick; samples per tick (measured from MIDI clock) */
            E.tick_off = -1;
            E.tick_n = 0;
            E.tick_len = (int32_t)(60u * ENG_SR / (bpm * 24u));
            if (clk_ext) {
                seen = t != E.clk_seen;
                if (seen) {
                    E.tick_off = 0;
                    E.tick_n = (int32_t)(t - E.clk_seen);
                    if (E.ext_since > 0u)
                        E.ext_len = E.ext_since / (uint32_t)E.tick_n;
                    E.ext_since = 0;
                }
                if (E.ext_len > 0u)
                    E.tick_len = (int32_t)E.ext_len;
                E.ext_since = E.ext_since + n < (1u << 23) ? E.ext_since + n : 1u << 23;
                E.ticks += t - E.clk_seen;
            } else {
                uint32_t whole = 60u * ENG_SR, inc = bpm * 24u;
                E.ext_since = E.ext_len = 0;
                if (E.tick_acc + n * inc >= whole)
                    E.tick_off = (int32_t)((whole - E.tick_acc + inc - 1u) / inc) - 1;
                E.tick_acc += n * inc;
                while (E.tick_acc >= whole) {
                    E.tick_acc -= whole;
                    E.ticks++;
                    if (cko.n < CKO_MAX)         /* (MIDI clock out: one a block up to 300 bpm) */
                        cko.off[cko.n++] = (uint16_t)(off + (uint32_t)E.tick_off + (uint32_t)E.tick_n * (uint32_t)E.tick_len);
                    E.tick_n++;
                    seen = 1;
                }
            }
            if (once_st == 1u) {                 /* play once's count-in (#632): beat 1's click on this block's first sample,
                                                  * then one on each 24th tick */
                if (once_first) {
                    click_at = 0;
                    accent = 1;
                    once_first = 0;
                } else if (seen) {
                    uint32_t before = once_cin;
                    once_cin += (uint32_t)E.tick_n;
                    if (once_cin < ONCE_BAR && once_cin / 24u > before / 24u)
                        click_at = E.tick_off > 0 ? E.tick_off : 0;
                }
            }
            if (!run)                            /* REC's count-in (D-803, seq_ui.c seq_cin_poll counts the same bars): */
                cin_on = 0;                      /* a click on each beat from the bar it starts on (beat 1 higher) */
            else {
                uint32_t r0 = was - E.run_ticks, r1 = E.ticks - E.run_ticks, r;
                if (cin_gen != cin_seen) {       /* (asked for: taken once the transport runs) */
                    int32_t at = (int32_t)(cin_req_at - E.run_ticks);
                    cin_seen = cin_gen;
                    cin_on = cin_req_bars != 0u;
                    cin_from = at > 0 ? ((uint32_t)at + ONCE_BAR - 1u) / ONCE_BAR * ONCE_BAR : 0u;
                    cin_end = cin_from + cin_req_bars * ONCE_BAR;
                }
                if (cin_on) {
                    if (start && cin_from == 0u) {   /* beat 1 on the start's first sample */
                        click_at = 0;
                        accent = 1;
                    }
                    for (r = r0 + 1u; r - r0 <= r1 - r0; r++)   /* each tick of this block */
                        if (r >= cin_from && r < cin_end && r % 24u == 0u) {
                            click_at = E.tick_off > 0 ? E.tick_off : 0;
                            accent = (r - cin_from) % ONCE_BAR == 0u;
                        }
                    if (r1 >= cin_end)
                        cin_on = 0;
                }
            }
            if (!run)
                E.tick_off = -1;
            E.clk_seen = t;
            E.clk_pulse = seen && run ? (n + 1u) / 2u : 0u;   /* the Main clock: half a block per block that saw a tick while running */
            steps_keys();
            {                                    /* the keys played into tracks since the last block (eng_note_on) */
                uint8_t q = thru_tail;
                E.blk_q0 = q;
                for (E.nthru = 0; q != thru_head && E.nthru < ENG_THRU; q++, E.nthru++) {
                    E.blk_thru[E.nthru][0] = thru_ring[q % ENG_THRU][0];
                    E.blk_thru[E.nthru][1] = thru_ring[q % ENG_THRU][1];
                    E.blk_thru[E.nthru][2] = thru_ring[q % ENG_THRU][2];
                }
                thru_tail = q;
            }
            for (k = 0; k < E.narp; k++)
                if (!E.node[E.arp[k].node].bypass) { /* bypassed: its keys already went straight through */
                    ENG_PROF(0, E.arp[k].node, 0);
                    arp_block(&E.arp[k], n, bpm);
                    ENG_PROF(3, E.arp[k].node, 0);     /* include note scheduling in this module's CPU cost */
                }
        }
        once_end_at = steps_once_at(n);                 /* (play once: where a shorter track's looping ends, D-820) */
        for (k = 1; k <= E.ngrp; k++) {                 /* the parts' pitch flaws: detune + drift (engine.ts render) */
            const grp_t *g = &E.grp[k];
            for (v = 0; v < g->parts; v++) {
                pv_t *x = &E.pv[g->pv0 + v];
                walk_step(&x->dw, DRIFT_HOLD);           /* every block, so the wander does not depend on the amount */
                x->flaw = (int32_t)g->detune[v] * 65536 / 1200 + flaw_drift(x->dw.y, g->drift[v]);
            }
        }
        for (k = 1; k <= E.ngrp; k++) {                 /* idle parts: woken by a note, else run every IDLE_CHECK-th block, */
            const grp_t *g = &E.grp[k];                 /* each part in its own block of the IDLE_CHECK (staggered, #434) */
            for (v = 0; v < g->parts; v++) {
                pv_t *x = &E.pv[g->pv0 + v];
                if (x->idle && (x->gate || x->retrig))
                    x->idle = 0;
                x->skip = x->idle && (E.idle_blk + (k - 1u) * ENG_MAX_PARTS + v) % IDLE_CHECK != 0u;
            }
        }
        E.idle_blk = (uint8_t)((E.idle_blk + 1u) % IDLE_CHECK);
        ENG_TMARK(0);
        render_split(n);
        ENG_TMARK(1);
        if (n == ENG_BLOCK)
            for (k = 1; k <= E.ngrp; k++) {             /* a released part that has gone quiet goes idle (part_quiet) */
                const grp_t *g = &E.grp[k];
                for (v = 0; v < g->parts; v++) {
                    pv_t *x = &E.pv[g->pv0 + v];
                    if (x->skip)
                        continue;
                    if (!x->gate && !x->retrig && part_quiet(k, v)) {
                        x->idle = 1;
                        part_silence(k, v);
                    } else
                        x->idle = 0;
                }
            }
        for (k = 0; k < ENG_NPV; k++) {                 /* both triggers last one block */
            E.pv[k].retrig = 0;
            E.pv[k].key_trig = 0;
        }
        group_cables();                                 /* (#681: after the triggers, so a regroup's restart is the next block's) */
        ENG_TMARK(2);
        for (k = 0; k < E.nout; k++) {
            const node_t *o = &E.node[E.outputs[k]];
            const inst_t *it = &inst_pool[o->inst0];
            int32_t lvl = it->eff[OUTPUT_P_LEVEL];
            const esig_t *l = it->in[OUTPUT_I_L], *r = (o->conn & (1u << OUTPUT_I_R)) ? it->in[OUTPUT_I_R] : it->in[OUTPUT_I_L];
            for (i = 0; i < n; i++) {
                left[off + i] += mul16(l[i], lvl);
                right[off + i] += mul16(r[i], lvl);
            }
        }
        if (once_st == 2u) {                            /* every track played its passes: the transport stops (next block) */
            for (k = 0; k < E.ntrk && E.trk_once[k] < 2u; k++)
                ;
            if (k == E.ntrk) {
                once_end();
                once_edge = 1;
            }
        }
        if (click_at >= 0 || click_k >= 0) {           /* the count-in's click: not in this output, eng_click_mix adds it
                                                         * to the analog one (D-820); here only where it stands */
            const int32_t len = (int32_t)(ENG_SR * CLICK_MS / 1000u);
            if (click_at >= 0) {
                click_half = (int32_t)(ENG_SR / (2u * (accent ? CLICK_ACCENT_HZ : CLICK_HZ)));
                click_half = click_half > 0 ? click_half : 1;
                click_k = (int32_t)n - click_at;
                if (click_nev < CLICK_EV) {
                    click_ev[click_nev].at = off + (uint32_t)click_at;
                    click_ev[click_nev++].half = click_half;
                }
            } else
                click_k += (int32_t)n;
            if (click_k >= len)
                click_k = -1;
        }
        ENG_PROF(5, 0, 0);
    }
    for (i = 0; i < total; i++) {
        left[i] = clampi(left[i], -ENG_ONE, ENG_ONE);
        right[i] = clampi(right[i], -ENG_ONE, ENG_ONE);
    }
}

void eng_render(int32_t *left, int32_t *right, uint32_t total)
{
    render_voice(left, right, total);
}

void eng_ctl(uint32_t which, int32_t q16)
{
    if (which < ENG_NCTL)
        E.ctl[which] = clampi(q16, which == ENG_CTL_BEND ? -ENG_ONE : 0, ENG_ONE);
}
