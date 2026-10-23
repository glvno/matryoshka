/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Fixed-point patch engine, see engine.h. The reference is web/src/engine.ts / modules.ts; formulas are kept
 * line by line where possible. Polyphony as in engine.ts: a module in a poly group (a poly assembly of the editor) has one
 * instance (inst_t) per part of its group, everything else has one; an input reading another group's per-part output sums
 * its parts. Each group hands the notes to its parts with its own allocator, the rest plays the shared keyboard (one note).
 * Number formats: signals, parameters Q16.16; oscillator phase u32 (2^32 = 1 cycle);
 * filter coefficients Q24; envelope level and rates Q30. Build: -DENG_POOL=... places the big buffers (device:
 * the .pool section). Needs 64-bit multiply (hardware) and, at block rate and on waveform edges, 64/32 division. */
#include "engine.h"
#include "defs.h"
#include "dsp_tables.h"
#include "wt_tables.h"

#ifndef ENG_POOL
#define ENG_POOL
#endif

/* The patch: modules, cables, summed inputs; below them the memories (pools of slots with an owner, slot_take; a load
 * frees them and takes what it needs). A patch that finds no free slot does not load (-4 lines, -6 buffers, -7
 * instances): NO ROOM on the panel. Keep DEVICE in web/src/patchbin.ts, the HELLO reply (proto.c) and the MEMORY lines
 * of manual.c in step. */
#define ENG_MAX_MODULES 64          /* (the module list, `order`, `outputs` are uint8 indices; the binary header byte 2) */
#define ENG_MAX_RANGES 48           /* macro ranges (patch.ts ModuleInst.range) */
#define ENG_MAX_CABLES 255           /* (the HELLO reply carries it in a byte) */
#define MAX_SUM 160                 /* summed inputs (an input of an instance with two or more sources) */
#define MAX_SRC 320                 /* their sources: a shared input reading a per-note output has one per note */
#define ENG_MAX_INST 128            /* module instances: a shared module has one, a per-note module one per note */
#define ENG_NBUF 255u               /* signal buffers of ENG_BLOCK samples (a connected output, a summed input) */
#define ENG_NDELAY 1                /* delay lines */
#define ENG_NREV 1                  /* reverb memories */
#define ENG_NSTRING 8               /* string lines (a per-note module: one per note) */
#define ENG_NCHORUS 1               /* chorus lines (a shared module, like the delay) */
#define ENG_NGRAIN 1                /* granular lines (a shared module): 1 s of int16 plus the grain records, 88 KB */
#define GRAIN_LEN 44118u            /* GRAIN_SECONDS x ENG_SR */
#define GRAIN_MAX 8
#define GRAIN_SPRAY (ENG_SR / 4u)   /* spray scatters a grain's start by up to this many samples (0.25 s) */
#define RV_LEN 8074u                /* the eight FDN lines (5740), two input allpasses (570) and the 40 ms pre-delay (1764), int16 Q13 */
#define DELAY_LEN 23000u            /* 521 ms at ENG_SR (the reference engine, web/src/modules.ts, has the same length; ping-pong halves it) */
#define STR_LEN 1104u               /* ceil(ENG_SR / 40) + 1: the lowest string is 40 Hz, as the reference */
#define CH_LEN 927u                 /* ceil(ENG_SR * 0.021): 12 ms +- 8 ms of sweep */
#define MAX_HELD 16
#define ENG_MAX_ARPS 2               /* Arpeggiator modules of a patch (a third does not load) */
#define ENG_MAX_TRACKS 16            /* Steps modules of a patch (their notes live in E.trk_note) */
#define ENG_MAX_NOTES 512            /* the notes of all Steps tracks of a patch (patchbin.ts DEVICE.notes) */
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
/* blocks between a walk's targets at `rate` Hz (Q16): round(ENG_SR / (128 rate)), 1..65535 */
static uint32_t walk_hold(int32_t rate)
{
    uint64_t r = rate < 655 ? 655u : (uint64_t)rate, h = ((((uint64_t)ENG_SR << 17) / (128u * r)) + 1u) >> 1;
    return h < 1u ? 1u : h > 65535u ? 65535u : (uint32_t)h;
}

/* blocks between a part drift's targets: walk_hold(0.5 Hz) (engine.ts DRIFT_RATE) */
#define DRIFT_HOLD ((uint32_t)(((((uint64_t)ENG_SR << 17) / (128u * 32768u)) + 1u) >> 1))

/* base * 2^(x / 65536), saturating at 2^32 - 1. base: a phase increment, x: octaves Q16.16 */
static uint32_t exp2_scale(uint32_t base, int32_t x)
{
    int32_t n = x >> 16;
    uint32_t fr = (uint32_t)x & 0xFFFFu, i = fr >> 8, r = fr & 255u;
    uint32_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1u] - EXP2_T[i]) * r) >> 8);   /* Q28, 1..2 */
    uint64_t v = ((uint64_t)base * m) >> 28;
    if (n >= 0) {
        if (n >= 32 || v >= (1ull << (32 - n)))
            return 0xFFFFFFFFu;
        return (uint32_t)(v << n);
    }
    return -n >= 64 ? 0u : (uint32_t)(v >> -n);
}

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
    v -= poly_blep(ph - pw, dt, rc + 2);
    return v;
}
/* rc: four words of blep_pos cache for this phase */
static int32_t wave(int32_t kind, uint32_t ph, uint32_t dt, uint32_t pw, uint32_t *rc)
{
    switch (kind) {
    case 0:
        return sin_turn(ph);
    case 1:
        return wave_tri(ph);
    case 2:
        return wave_saw(ph, dt, rc);
    default:
        return wave_square(ph, dt, pw, rc);
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
        return d->plog[j] == 2 ? (int32_t)isqrt32((uint32_t)t << 16) : t;
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
    int32_t eff[MAX_PAR];
    const esig_t *in[MAX_IN];
    esig_t *out[MAX_OUT];
    union {
        struct { uint32_t phase; int32_t s1, y1, y2, pm1, xb, ap[8]; uint32_t ph[4]; } osc;   /* s1: last sync sample; FM mode: feedback history, pm interpolation, decimator; ph: unison voices 2..5 (plain path) */
        struct { uint32_t seed; walk_t w; } rnd;   /* seed: engine.ts instSeed */
        struct { uint32_t phase, seed; int32_t held; uint32_t since; int32_t interval; uint16_t ticks; uint8_t clk_hi, rst_hi; } lfo;   /* interval: clock edge distance in samples, Q8 */
        struct { int32_t y; } gld;         /* Q24 */
        struct { uint32_t seed; int32_t y; } noise;   /* y: the colour one-pole, Q24 */
        struct { int32_t ic1[3], ic2[3]; } vow;       /* three band passes, Q20 */
        struct { uint32_t phase; int32_t ap[8], fbv; } phs;   /* the sweep LFO, x1 / y1 of the four allpasses, the feedback sample */
        struct { int32_t held, cnt, xb, ap[16]; } crush;   /* xb, ap: the 2x oversampling (os_up / os_down) */
        struct { int32_t xb, ap[16]; } shp;
        struct { int32_t v; uint8_t stage, prev; } adsr;
        struct { int32_t ic1, ic2, jc1, jc2; } flt;   /* stage 1 and stage 2 integrators */
        struct { int32_t s[4]; } lad;                 /* the four one-pole states, Q20 */
        struct { int32_t env; } dyn;                  /* the peak follower, Q24 */
        struct { int32_t y1[6], y2[6]; } mod;         /* the modal resonators, Q20 */
        struct { int32_t a[8], b[8], ia; uint32_t phase; } fs;   /* the Hilbert chains (w1 w2 per section), chain A's delayed sample, the quadrature oscillator */
        struct { struct grain_line *ln; uint32_t w, acc, seed; uint8_t prev; } gr;   /* acc: grains per sample, Q24 */
        struct { int16_t *buf; uint32_t w, t, seen, beat; uint32_t ring[DELAY_CLK_PPQN]; uint8_t prev; } dly;   /* t, ring, seen, beat: the clock tempo */
        struct { int16_t *buf; uint16_t li[8], ai[2], pi; int32_t lp[8]; uint32_t ph[2]; } rev;   /* the FDN lines' write indices, the diffusers', the pre-delay's; damping states; modulation phases */
        struct { int32_t v; uint32_t t; uint8_t stage, prev; } env;  /* Q30, like the ADSR; t: samples in the segment */
        struct { int16_t *buf; uint32_t w, seed; int32_t lp, s1, err, burst, blen; } str;   /* Q13 line with error feedback */
        struct { uint32_t phase; int32_t s1; } wt;
        struct { int16_t *buf; uint32_t w, phase; } ch;
        struct { uint32_t seed; int32_t c1, r1, y, period, since, gleft; int8_t pos, down; } seq;
        /* Steps (modules.ts StepsState): ticks since the step, the step (-1: the next is the first), times round the pattern,
         * a swung step waiting (samples, which), clk mode's edge distance; slen / sst: the step's length and samples since
         * it began (live recording rounds to the nearest step); skip: a step recorded ahead, its notes not played again
         * when reached; hit: 1 / 2 (accented) = sound now (eng_steps_hit); pitch / vel: the outputs' held values (Q16, the
         * last note that started); the notes sounding are the track's (E.trk_snd) */
        struct { uint32_t seed, loop; int32_t c1, r1, since, period, pend, slen, sst, pitch, vel; uint16_t count; int8_t pos, pstep, skip; uint8_t run, gap, mute, hit, skipn; } stp;   /* y: the glide one-pole, Q24; period / since: clock edge distance in samples (since -1 before the first edge) */
        /* Drum map (modules.ts DrumMapState): its rows' velocities (Q16), the rows whose gate is up, the rows that restart
         * this block (a low first sample) */
        struct { int32_t vel[DRUMMAP_NOUT / 2]; uint8_t gate, gap, fell; } dm;   /* fell: let go since the last block */
        struct { int32_t count, c1, r1; } cdv;
        struct { int32_t v, c1; } sh;
        struct { int32_t rem, t1; } pls;
    } s;
} inst_t;

typedef struct {
    uint8_t type, conn, disabled_inputs;
    uint8_t bypass;                  /* 1: process() is skipped, the outputs copy the through input (DEFS[].thru) or are silent */
    uint8_t inst0, ninst;            /* its instances in inst_pool[]: one per part of its poly group, else one */
    uint8_t grp;                     /* its poly group (E.grp[]): 0 = it runs once and plays the shared keyboard */
    uint16_t map[6];                 /* the matrix: bit j of map[s] = source s controls parameter j. s: p1 p2 k1 k2 k3 k4 */
    uint16_t input_map[MAX_IN];      /* additional side-input destinations, independent of fixed links */
    int32_t att[2];                  /* attenuverters of p1, p2: Q16, -1..1 */
    int32_t par[MAX_PAR];
    uint16_t parb[MAX_PAR];          /* the morph B side as unit positions (0..65535 of the range, octaves for a log parameter), when E.has_b */
    uint16_t ranged[2];              /* bit j: input p1 / p2 has a macro range on parameter j (the entry is in E.ranges) */
    uint8_t trk;                     /* a Steps module: its track (E.trk_first / trk_n / trk_snd) */
    uint8_t ksrc;                    /* a Drum map: where its keys come from (0 none, 1 the keys, 2 + a Steps module's index);
                                      * a Steps module: 1 = a cable from Main's keys into its keys in (engine.ts fed) */
} node_t;

/* a macro range: input `pin` (0 p1, 1 p2) of module `mod` moves parameter `par` between lo and hi (0..255 of the range,
 * octaves for a log parameter, morph_unit space) instead of adding to its base */
typedef struct { uint8_t mod, pin, par, lo, hi; } range_t;

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
    uint8_t legato;                  /* the note began over a held one (the Part module's legato output) */
    uint32_t on_stamp, off_stamp;
    walk_t dw;                       /* the drift's random walk (modules.ts driftSeed), stepped every block */
    int32_t flaw;                    /* the pitch flaw, octaves Q16: detune + drift (modules.ts flawQ16); the Part module adds it */
    uint8_t idle, skip;              /* idle: released and silent, its modules are skipped (part_idle); skip: this block */
    uint16_t idle_n;                 /* blocks since it went idle: every IDLE_CHECK-th one runs and checks again */
} pv_t;

/* an allocator and its parts (engine.ts Group): grp[0] is the shared keyboard (one part, legato auto, last note), grp[1..]
 * the poly groups of the patch binary. One part: the held keys, the sounding one chosen among them. */
#define ENG_MAX_GROUPS POLY_MAX_GROUPS
#define ENG_NPV (1 + ENG_MAX_GROUPS * ENG_MAX_PARTS)
typedef struct {
    uint8_t parts, assign, legato, priority;   /* patch.ts PolyCfg */
    uint8_t unison;                  /* every part plays the one note the priority picks (patch.ts PolyCfg.unison) */
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
 * thru: a key played into the track (#134, #139: the note played + 1, 0 = one of its own), sounding until it is let go */
typedef struct { uint8_t key, left, thru; int32_t cnt; } snd_t;

/* keys in (#139; engine.ts arm / thru): the keys played into a track (the armed one, or one a cable from Main's keys
 * feeds) wait in a ring the main loop fills and the audio side empties at the start of a block (eng_note_on runs
 * outside the interrupt): module index, the note (bit 7: on), velocity */
#define ENG_THRU 32u
static uint8_t thru_ring[ENG_THRU][3];
static volatile uint8_t thru_head, thru_tail;
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
    uint32_t pos, since, interval, next, seed;
} arp_t;

typedef struct {
    uint8_t loaded, nmod, nsum, norder, nout, ngrp, ninst;   /* ngrp: the poly groups, E.grp[1..ngrp] */
    uint16_t nsrc;
    uint8_t order[ENG_MAX_MODULES], outputs[ENG_MAX_MODULES];
    uint8_t from_m[ENG_MAX_CABLES], from_p[ENG_MAX_CABLES], to_m[ENG_MAX_CABLES], to_p[ENG_MAX_CABLES];
    uint16_t ncab, nbuf, ndly, nrev, nstr, nch, ngr;
    node_t node[ENG_MAX_MODULES];
    sum_t sum[MAX_SUM];
    const esig_t *sum_src[MAX_SRC];
    uint16_t sum_w[MAX_SRC];                 /* 0: the source adds as it is, else its Q16 weight (para_w) */
    grp_t grp[1 + ENG_MAX_GROUPS];
    pv_t pv[ENG_NPV];
    uint32_t stamp;
    uint32_t clk_seen, clk_pulse;    /* MIDI clock ticks counted so far; the Main module's clock pulse length in this block */
    uint32_t ticks, tick_acc;        /* the clock: ticks so far, the tempo's remainder (1 / (60 ENG_SR) of a tick) */
    int32_t tick_off, tick_n, tick_len;   /* this block's ticks while running: the sample they fall on (-1 none), how many, samples per tick */
    uint32_t ext_since, ext_len;     /* MIDI clock: samples since its last tick, samples per tick as measured (0: not yet) */
    uint8_t ntrk;
    uint16_t nnotes;                 /* the Steps tracks' notes (#133): track t's are trk_note[trk_first[t] .. + trk_n[t]), */
    uint16_t trk_first[ENG_MAX_TRACKS];   /* sorted by step, then note (track.ts), the tracks in order */
    uint8_t trk_n[ENG_MAX_TRACKS];
    uint32_t trk_note[ENG_MAX_NOTES];
    snd_t trk_snd[ENG_MAX_TRACKS][TRACK_POLY];   /* the notes each track sounds, oldest first */
    uint8_t trk_nsnd[ENG_MAX_TRACKS];
    uint8_t trk_last[ENG_MAX_TRACKS];    /* the last note a track started (a hit from the panel plays it) */
    uint8_t nkev;                    /* keys out of the Steps tracks this block: node index, key (bit 7: on), velocity */
    uint8_t kev[ENG_KEV][3];
    uint8_t arm;                     /* the armed Steps module + 1 (#139; engine.ts arm), 0 none */
    uint16_t trk_rec;                /* bit t: track t records what is played through it (eng_steps_rec) */
    volatile uint16_t thru_kill;     /* bit t: track t lets go of the keys played through it (at its next block) */
    uint8_t nthru;                   /* keys in taken from the ring for this block (m_steps reads its own) */
    uint8_t blk_thru[ENG_THRU][3];
    uint8_t nrin;
    rin_t rin[ENG_RIN];
    uint8_t running;                 /* the transport as this block saw it */
    uint8_t narp;
    arp_t arp[ENG_MAX_ARPS];
    int32_t ctl[ENG_NCTL];           /* pitch bend, mod wheel, aftertouch (engine.h ENG_CTL_*), Q16 */
    uint8_t has_b;                   /* the patch carries a morph B set (node_t.parb) */
    uint8_t nranges;
    range_t ranges[ENG_MAX_RANGES];
    uint8_t btn_kind[ENG_PANEL_BUTTONS];   /* the button kinds (ENG_BTN_*, flag bit 6; without it every one is a Gate) */
    uint8_t btn_first[ENG_PANEL_BUTTONS], btn_n[ENG_PANEL_BUTTONS];   /* a Toggle's modules: btn_list[first .. first + n) */
    uint8_t btn_list[ENG_BTN_TARGETS];
    uint16_t btn_sw;                 /* the buttons that switch (the panel's mask) */
    int8_t main;                     /* the Main module, -1 without one */
    int32_t morph;                   /* the morph position of this block, Q16 0..1: the Main's MORPH parameter plus the mean of its morph input */
} eng_t;

/* the engine. The clock ticks (24 ppqn) come from the arpeggiator or MIDI in (eng_clock_tick). */
static eng_t eng_one ENG_POOL;
#define E eng_one
static void toggles_sync(void);
static volatile uint32_t clk_ticks;   /* MIDI clock ticks (eng_clock_tick, the main loop) */
static volatile uint8_t clk_ext;      /* MIDI clock drives the clock */
static volatile uint8_t transport_on; /* the transport (eng_transport) */
static volatile uint16_t panel_buttons; /* the patch buttons held / switched on (eng_buttons) */

/* the memories: slot i of a pool is taken while own[i] is 1 */
static inst_t inst_pool[ENG_MAX_INST] ENG_POOL;
static uint8_t inst_own[ENG_MAX_INST];
static uint32_t cur_v;               /* the part whose instance is being rendered (0 for a module that runs once) */
static const grp_t *cur_g;           /* its group (E.grp[0], the shared keyboard, for a module that runs once) */
static pv_t *cur_pv;                 /* the part it plays */
static esig_t buf_pool[ENG_NBUF][ENG_BLOCK] ENG_POOL;
static uint8_t buf_own[ENG_NBUF];
static int16_t dly_pool[ENG_NDELAY][DELAY_LEN] ENG_POOL;
static uint8_t dly_own[ENG_NDELAY];
static int16_t rev_pool[ENG_NREV][RV_LEN] ENG_POOL;
static uint8_t rev_own[ENG_NREV];
static int16_t str_pool[ENG_NSTRING][STR_LEN] ENG_POOL;
static uint8_t str_own[ENG_NSTRING];
static int16_t ch_pool[ENG_NCHORUS][CH_LEN] ENG_POOL;
static uint8_t ch_own[ENG_NCHORUS];
/* a granular line: the recording (Q13 like the delay) and the grains reading it (start, read phase from it Q16, rate Q16,
 * window phase and increment (u32 turns, half a turn over the grain), samples left) */
typedef struct { uint32_t start, rp, rate, wph, winc, left; } grain_t;
typedef struct grain_line { int16_t buf[GRAIN_LEN]; grain_t g[GRAIN_MAX]; } grain_line_t;
#if ENG_NGRAIN > 0
static grain_line_t gr_pool[ENG_NGRAIN] ENG_POOL;
static uint8_t gr_own[ENG_NGRAIN];
#endif
static const esig_t zero_buf[ENG_BLOCK];
static esig_t dummy_out[ENG_BLOCK];

static void pool_free(uint8_t *own, uint32_t n)          /* every slot back to the pool */
{
    uint32_t i;
    for (i = 0; i < n; i++)
        own[i] = 0;
}

static int slots_take(uint8_t *own, uint32_t n, uint32_t count)   /* `count` free slots in a row, -1 if none */
{
    uint32_t i, run = 0;
    for (i = 0; i < n; i++) {
        run = own[i] ? 0 : run + 1;
        if (run == count) {
            uint32_t k;
            for (k = i + 1 - count; k <= i; k++)
                own[k] = 1;
            return (int)(i + 1 - count);
        }
    }
    return -1;
}

static int slot_take(uint8_t *own, uint32_t n) { return slots_take(own, n, 1); }

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

static esig_t *buf_alloc(void)
{
    esig_t *b;
    uint32_t i;
    int k = slot_take(buf_own, ENG_NBUF);
    if (k < 0)
        return 0;
    E.nbuf++;
    b = buf_pool[k];
    for (i = 0; i < ENG_BLOCK; i++)
        b[i] = 0;
    return b;
}

static void init_state(const node_t *nd, inst_t *it, uint32_t mod, uint32_t v)
{
    switch (nd->type) {
    case T_RANDOM:                       /* modules.ts random.seed with engine.ts instSeed(module index, part) */
        it->s.rnd.seed = (mod * 8u + v + 1u) * 0x9e3779b9u;
        walk_init(&it->s.rnd.w, it->s.rnd.seed ^ 0x2545f491u);
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

/* bytes a module record has beyond its type byte and parameters: the attenuverters and the matrix */
static inline uint32_t eng_record_extra(const def_t *d) { return (d->cvbase >= 0 ? 20u : 0u) + d->ndata; }

static int32_t morph_unit(const def_t *d, uint32_t j, int32_t v);

/* the shared keyboard and the poly groups as the binary describes them, all parts silent */
static void groups_reset(void)
{
    uint32_t g, v, j, pv0 = 0;
    for (g = 0; g <= E.ngrp; g++) {
        E.grp[g].rot = 0;
        E.grp[g].nheld = 0;
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

int eng_load(const uint8_t *p, uint32_t len)
{
    uint32_t i, j, c, k, v, at, ncab;
    uint8_t st[ENG_MAX_MODULES], member[ENG_MAX_MODULES];
    E.loaded = 0;
    E.stamp = 0;
    E.clk_seen = clk_ticks;
    E.clk_pulse = 0;
    E.narp = 0;
    E.ntrk = 0;
    E.nnotes = 0;
    E.nkev = 0;
    E.arm = 0;
    E.trk_rec = E.thru_kill = 0;
    E.nthru = E.nrin = 0;
    thru_tail = thru_head;                       /* (keys still waiting were for the last patch) */
    took_tail = took_head;
    E.ngrp = 0;
    E.grp[0].parts = 1;                          /* the shared keyboard: one part, legato auto, last note */
    E.grp[0].assign = E.grp[0].legato = E.grp[0].priority = 0;
    E.grp[0].src = E.grp[0].ch = E.grp[0].lo = 0;
    E.grp[0].hi = 127u;
    groups_reset();
    pool_free(inst_own, ENG_MAX_INST);           /* what this voice's old patch held */
    pool_free(buf_own, ENG_NBUF);
    pool_free(dly_own, ENG_NDELAY);
    pool_free(rev_own, ENG_NREV);
    pool_free(str_own, ENG_NSTRING);
    pool_free(ch_own, ENG_NCHORUS);
#if ENG_NGRAIN > 0
    pool_free(gr_own, ENG_NGRAIN);
#endif
    if (len < 8u || p[0] != 0xA1 || (p[1] > ENG_PATCH_VERSION || p[1] < ENG_PATCH_COMPAT_VERSION))
        return -1;
    if ((p[7] & ~ENG_FLAG_EXTRAS) || (p[1] < 34u && p[7]) || (p[1] < 33u && (p[6] & 128u)) || (p[1] < 17u && (p[6] & 4u)) || (p[1] < 18u && (p[6] & 8u)) || (p[1] < 27u && (p[6] & 16u)) || (p[1] < 30u && (p[6] & 64u)))
        return -1;
    for (i = 0; i < ENG_PANEL_BUTTONS; i++)      /* (before eng_buttons below: no Toggle of the last patch acts on this one) */
        E.btn_kind[i] = (uint8_t)ENG_BTN_GATE, E.btn_n[i] = 0;
    E.nmod = p[2];
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    if (E.nmod > ENG_MAX_MODULES || ncab > ENG_MAX_CABLES)
        return -2;
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
        if (q[0] < 1u || q[0] > ENG_MAX_PARTS || q[1] > 2u || (q[2] & 0x7Fu) > 2u || q[3] > 2u)
            return -3;
        g->parts = q[0];
        g->assign = q[1];
        g->legato = q[2] & 0x7Fu;
        g->unison = (q[2] >> 7) && q[0] > 1u;
        g->priority = q[3];
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
    E.ndly = 0;
    E.nrev = 0;
    E.nstr = 0;
    E.nch = 0;
    E.ninst = 0;
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        const def_t *d;
        uint8_t *z = (uint8_t *)nd;
        for (j = 0; j < sizeof *nd; j++)
            z[j] = 0;
        if (at >= len || (p[at] & 0x7Fu) >= N_TYPES)
            return -3;
        nd->type = p[at] & 0x7Fu;
        nd->bypass = (uint8_t)(p[at] >> 7 && nd->type != T_FM1 && nd->type != T_OUTPUT);   /* bit 7: bypassed (never the panel or the output) */
        at++;
        d = &DEFS[nd->type];
        if (at + eng_record_extra(d) + 4u * d->npar > len)
            return -3;
        for (j = 0; j < d->npar; j++, at += 4)
            nd->par[j] = rd32(p + at);
        if (d->cvbase >= 0) {
            nd->att[0] = rd32(p + at);
            nd->att[1] = rd32(p + at + 4);
            at += 8;
            for (j = 0; j < 6u; j++, at += 2)
                nd->map[j] = (uint16_t)((uint32_t)p[at] | (uint32_t)p[at + 1] << 8);
        }
        if (nd->type == T_STEPS) {               /* its name (the panel reads it from the binary); its notes come after the cables */
            if (E.ntrk >= ENG_MAX_TRACKS)
                return -2;
            nd->trk = E.ntrk++;
            E.trk_first[nd->trk] = 0;
            E.trk_n[nd->trk] = E.trk_nsnd[nd->trk] = 0;
            E.trk_last[nd->trk] = STEP_NOTE;
        }
        nd->ksrc = nd->type == T_DRUMMAP ? p[at] : 0u;   /* (checked once every module is read) */
        at += d->ndata;
        /* the memories of delay, reverb, chorus, granular and the output exist once (patch.ts SHARED_TYPES) */
        nd->grp = nd->type == T_DELAY || nd->type == T_REVERB || nd->type == T_CHORUS || nd->type == T_GRAIN || nd->type == T_OUTPUT || nd->type == T_ARP || nd->type == T_STEPS || nd->type == T_DRUMMAP ? 0u : member[i];
        nd->ninst = E.grp[nd->grp].parts;
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
    }
    for (i = 1; i <= E.ngrp; i++)                /* a group's note source must be an arpeggiator or a Steps module of the patch */
        if (E.grp[i].src && (E.grp[i].src > E.nmod || (E.node[E.grp[i].src - 1u].type != T_ARP && E.node[E.grp[i].src - 1u].type != T_STEPS)))
            return -3;
    for (i = 0; i < E.nmod; i++)                 /* a Drum map's keys: the keys, or a Steps module of the patch */
        if (E.node[i].ksrc >= 2u && (E.node[i].ksrc - 2u >= E.nmod || E.node[E.node[i].ksrc - 2u].type != T_STEPS))
            return -3;
    if (at + 4u * ncab > len)
        return -3;
    for (c = 0; c < ncab; c++, at += 4) {
        uint8_t fm = p[at], fp = p[at + 1], tm = p[at + 2], tp = p[at + 3];
        if (fm >= E.nmod || tm >= E.nmod || fm == tm)
            return -5;
        if (fp >= DEFS[E.node[fm].type].nout || tp >= DEFS[E.node[tm].type].nin)
            return -5;
        E.from_m[c] = fm;
        E.from_p[c] = fp;
        E.to_m[c] = tm;
        E.to_p[c] = tp;
        E.node[tm].conn |= (uint8_t)(1u << tp);
        if (E.node[fm].type == T_FM1 && fp == FM1_O_KEYS && E.node[tm].type == T_STEPS && tp == STEPS_I_KEYS)
            E.node[tm].ksrc = 1u;                /* Main's keys pass through the track while none is armed (#138) */
    }
    if (p[6] & 1u) {                             /* the morph B set: one Q16 value per parameter of every module, kept as unit positions */
        for (i = 0; i < E.nmod; i++) {
            node_t *nd = &E.node[i];
            const def_t *d = &DEFS[nd->type];
            if (at + 4u * d->npar > len)
                return -3;
            for (j = 0; j < d->npar; j++, at += 4)
                nd->parb[j] = (uint16_t)clampi(morph_unit(d, j, rd32(p + at)), 0, 65535);
        }
        E.has_b = 1;
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
            nd->conn &= (uint8_t)~mask;
        }
    }
    if (p[6] & 8u) {                             /* additional side-input routes: module, input, u16 parameter mask */
        uint32_t count;
        if (at >= len) return -3;
        count = p[at++];
        if (at + 4u * count > len) return -3;
        for (i = 0; i < count; i++, at += 4) {
            uint32_t mod = p[at], input = p[at + 1];
            uint16_t mask = (uint16_t)((uint32_t)p[at + 2] | (uint32_t)p[at + 3] << 8);
            const def_t *d;
            if (mod >= E.nmod) return -3;
            d = &DEFS[E.node[mod].type];
            if (input >= d->nin || (d->cvbase >= 0 && input >= (uint32_t)d->cvbase) || !mask || (mask >> d->npar)) return -3;
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
                if (NW_AT(w) + NW_LEN(w) > TRACK_STEPS || !NW_VEL(w)) return -3;
                E.trk_note[E.nnotes + j] = w;
            }
            E.trk_first[t] = E.nnotes;
            E.trk_n[t] = (uint8_t)n;
            E.nnotes = (uint16_t)(E.nnotes + n);
        }
        for (t = 0, n = 0; t < E.ntrk; t++) {    /* (a track without notes starts where the next would) */
            E.trk_first[t] = (uint16_t)n;
            n += E.trk_n[t];
        }
    }
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
        toggles_sync();
    }
    if (p[6] & 128u) {                           /* the Drum maps' row names (the SEQ page's, eng_drum_name): not the engine's */
        uint32_t end = eng_names_end(p, len, at);
        if (!end)
            return -3;
        at = end;
    }
    if (p[6] & 2u) {                             /* the macro ranges: u8 count, then module / pin / parameter / lo / hi each */
        uint32_t nr;
        if (at >= len)
            return -3;
        nr = p[at++];
        if (at + 5u * nr > len)
            return -3;
        for (i = 0; i < nr; i++, at += 5) {
            uint32_t mod = p[at], pin = p[at + 1], par = p[at + 2];
            if (mod >= E.nmod || pin > 1u || par >= DEFS[E.node[mod].type].npar || !(E.node[mod].map[pin] >> par & 1u))
                continue;                        /* not a destination of that pin: ignored */
            if (E.nranges >= ENG_MAX_RANGES)
                return -3;
            E.ranges[E.nranges].mod = (uint8_t)mod;
            E.ranges[E.nranges].pin = (uint8_t)pin;
            E.ranges[E.nranges].par = (uint8_t)par;
            E.ranges[E.nranges].lo = p[at + 3];
            E.ranges[E.nranges].hi = p[at + 4];
            E.nranges++;
            E.node[mod].ranged[pin] |= (uint16_t)(1u << par);
        }
    }
    /* the instances: state, the delay / reverb / string / chorus memories from the shared pools */
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        int i0 = slots_take(inst_own, ENG_MAX_INST, nd->ninst);
        if (i0 < 0)
            return -7;
        nd->inst0 = (uint8_t)i0;
        E.ninst = (uint8_t)(E.ninst + nd->ninst);
        for (k = 0; k < nd->ninst; k++) {
            inst_t *it = &inst_pool[nd->inst0 + k];
            uint8_t *z = (uint8_t *)it;
            for (j = 0; j < sizeof *it; j++)
                z[j] = 0;
            init_state(nd, it, i, k);
            if (nd->type == T_REVERB) {
                int s = slot_take(rev_own, ENG_NREV);
                if (s < 0)
                    return -4;
                E.nrev++;
                it->s.rev.buf = rev_pool[s];
                for (j = 0; j < RV_LEN; j++)
                    it->s.rev.buf[j] = 0;
            }
            if (nd->type == T_DELAY) {
                int s = slot_take(dly_own, ENG_NDELAY);
                if (s < 0)
                    return -4;
                E.ndly++;
                it->s.dly.buf = dly_pool[s];
                it->s.dly.beat = ENG_SR / 2u;             /* 120 bpm until a clock has come in */
                for (j = 0; j < DELAY_LEN; j++)
                    it->s.dly.buf[j] = 0;
            }
            if (nd->type == T_STRING || nd->type == T_COMB) {         /* (the comb uses a string line, it->s.str) */
                int s = slot_take(str_own, ENG_NSTRING);
                if (s < 0)
                    return -4;
                E.nstr++;
                it->s.str.buf = str_pool[s];
                for (j = 0; j < STR_LEN; j++)
                    it->s.str.buf[j] = 0;
            }
            if (nd->type == T_CHORUS) {
                int s = slot_take(ch_own, ENG_NCHORUS);
                if (s < 0)
                    return -4;
                E.nch++;
                it->s.ch.buf = ch_pool[s];
                for (j = 0; j < CH_LEN; j++)
                    it->s.ch.buf[j] = 0;
            }
            if (nd->type == T_GRAIN) {
#if ENG_NGRAIN > 0
                int s = slot_take(gr_own, ENG_NGRAIN);
                uint8_t *z;
                if (s < 0)
                    return -4;
                E.ngr++;
                it->s.gr.ln = &gr_pool[s];
                for (z = (uint8_t *)it->s.gr.ln, j = 0; j < sizeof(grain_line_t); j++)
                    z[j] = 0;
#else
                return -4;
#endif
            }
        }
    }
    /* output buffers: one per connected output port and instance, the dummy for the unconnected ports */
    for (i = 0; i < E.nmod; i++)
        for (k = 0; k < E.node[i].ninst; k++)
            for (j = 0; j < DEFS[E.node[i].type].nout; j++)
                inst_pool[E.node[i].inst0 + k].out[j] = dummy_out;
    for (c = 0; c < ncab; c++) {
        node_t *nd = &E.node[E.from_m[c]];
        uint32_t fp = E.from_p[c];
        if (inst_pool[nd->inst0].out[fp] != dummy_out)
            continue;
        for (k = 0; k < nd->ninst; k++)
            if (!(inst_pool[nd->inst0 + k].out[fp] = buf_alloc()))
                return -6;
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
                    esig_t *b = buf_alloc();
                    if (!b || E.nsum >= MAX_SUM)
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
    for (i = 0; i < E.nmod; i++)
        st[i] = 0;
    E.norder = 0;
    for (i = 0; i < E.nmod; i++)
        if (st[i] == 0)
            visit(i, st);
    E.nout = 0;
    for (i = 0; i < E.norder; i++)
        if (E.node[E.order[i]].type == T_OUTPUT)
            E.outputs[E.nout++] = E.order[i];
    E.loaded = 1;
    return 0;
}

int eng_parts(void) { return !E.loaded ? 0 : E.ngrp ? E.grp[1].parts : 1; }
int eng_groups(void) { return E.loaded ? E.ngrp : 0; }

int eng_poly_get(uint32_t g, uint32_t field)
{
    const grp_t *x;
    if (!E.loaded || g >= E.ngrp || field >= ENG_NPOLY)
        return -1;
    x = &E.grp[1u + g];
    return field == ENG_POLY_PARTS ? x->parts : field == ENG_POLY_ASSIGN ? x->assign : field == ENG_POLY_LEGATO ? x->legato : x->priority;
}

int eng_module_group(uint32_t module) { return E.loaded && module < E.nmod ? E.node[module].grp : 0; }
int eng_poly_unison(uint32_t g) { return E.loaded && g < E.ngrp ? E.grp[1u + g].unison : 0; }
int eng_poly_set(uint32_t g, uint32_t field, uint32_t v)
{
    grp_t *x;
    if (!E.loaded || g >= E.ngrp || field == ENG_POLY_PARTS || field >= ENG_NPOLY || v > 2u)
        return 0;
    x = &E.grp[1u + g];
    if (field == ENG_POLY_ASSIGN) x->assign = (uint8_t)v;
    else if (field == ENG_POLY_LEGATO) x->legato = (uint8_t)v;
    else x->priority = (uint8_t)v;
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

void eng_set_bypass(uint32_t module, int on)
{
    if (module < E.nmod && E.node[module].type != T_FM1 && E.node[module].type != T_OUTPUT)
        E.node[module].bypass = (uint8_t)(on != 0);
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

/* what turning knob k (0..3) changes on a module: the matrix column of k1..k4, and on the modules that have no matrix
 * (fm1, output) the n-th parameter */
uint32_t eng_knob_mask(uint32_t module, uint32_t knob)
{
    const def_t *d;
    if (module >= E.nmod || knob >= 4u)
        return 0;
    d = &DEFS[E.node[module].type];
    if (d->cvbase >= 0)
        return E.node[module].map[2u + knob];
    return knob < d->npar ? 1u << knob : 0u;
}

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
uint32_t eng_map(uint32_t module, uint32_t source)
{
    return module < E.nmod && source < 6u && DEFS[E.node[module].type].cvbase >= 0 ? E.node[module].map[source] : 0u;
}
int32_t eng_att(uint32_t module, uint32_t input)
{
    return module < E.nmod && input < 2u ? E.node[module].att[input] : 0;
}

void eng_set_param(uint32_t module, uint32_t param, int32_t q16)
{
    if (module < E.nmod && param < DEFS[E.node[module].type].npar)
        E.node[module].par[param] = q16;
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
    range_t *r;
    if (module >= E.nmod || input > 1u || param >= DEFS[E.node[module].type].npar)
        return 0;
    r = range_find(module, input, param);
    if (!on) {
        if (r) {
            *r = E.ranges[--E.nranges];
            E.node[module].ranged[input] &= (uint16_t)~(1u << param);
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
    E.node[module].ranged[input] |= (uint16_t)(1u << param);
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
 * 0.5, the rest moves in morph_unit space */
static int32_t morph_of(const def_t *d, uint32_t j, int32_t a, uint32_t ub, int32_t t)
{
    int32_t ua;
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

static void mono_update(grp_t *g)
{
    int k = -1;
    uint32_t i, n = g->unison ? g->parts : 1u, s0 = E.stamp, s1 = s0;
    if (g->nheld) {
        k = (int)g->nheld - 1;
        if (g->priority)
            for (i = 0; i < g->nheld; i++)
                if (g->priority == 1 ? g->held_note[i] < g->held_note[k] : g->held_note[i] > g->held_note[k])
                    k = (int)i;
    }
    for (i = 0; i < n; i++) {
        E.stamp = s0;
        mono_part(g, &E.pv[g->pv0 + i], k);
        s1 = E.stamp;
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
        if (g->assign == 0) {
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

/* its note into the groups it plays; a part it lands on restarts its envelopes */
static void arp_emit_on(const arp_t *a, uint32_t note, int32_t vel)
{
    uint32_t g, v;
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
    for (g = 1; g <= E.ngrp; g++)
        if (E.grp[g].src == a->node + 1u)
            group_off(&E.grp[g], note);
}

/* a note on (key | 0x80, velocity 1..127) or off (key, 0) into the Drum maps whose keys come from `src` (1 the keys, 2 + a
 * Steps module's index; engine.ts mapKeys): a row on that note raises its gate (restarting it if it is up or fell since
 * the last block) and takes the velocity, or lets it fall */
static void dm_keys(uint32_t src, uint32_t kv, uint32_t vel)
{
    uint32_t i, r, key = kv & 0x7Fu;
    for (i = 0; i < E.nmod; i++) {
        const node_t *nd = &E.node[i];
        inst_t *it;
        if (nd->type != T_DRUMMAP || nd->ksrc != src)
            continue;
        it = &inst_pool[nd->inst0];
        for (r = 0; r < DRUMMAP_NOUT / 2u; r++) {
            if ((uint32_t)clampi(round_q16(nd->par[r]), 0, 127) != key)
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
        for (g = 1; g <= E.ngrp; g++) {
            grp_t *gr = &E.grp[g];
            if (gr->src != node + 1u)
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

/* one block (arpeggiator.ts arpBlock): steps on the clock at its rate, or one per block with a rising edge on clk (the
 * input as the last block left it); the gate a share of the last step's length */
static void arp_block(arp_t *a, uint32_t n, uint32_t bpm)
{
    static const uint8_t RATE_TICKS[7] = {24, 16, 12, 8, 6, 4, 3};
    const node_t *nd = &E.node[a->node];
    const inst_t *it = &inst_pool[nd->inst0];
    uint32_t rate = RATE_TICKS[clampi((nd->par[ARP_P_RATE] + 32768) >> 16, 0, 6)], i;
    int clk = (nd->conn >> ARP_I_CLK) & 1u, edge = 0, step = 0;
    if (!arp_latched(a)) {                       /* latch turned off: the keys let go meanwhile go */
        uint32_t k = 0;
        for (i = 0; i < a->n; i++)
            if (a->held[i].down)
                a->held[k++] = a->held[i];
        a->n = (uint8_t)k;
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
        a->interval = (uint32_t)((uint64_t)rate * 60u * ENG_SR / (24u * bpm));
        a->since = 0;
    } else if (clk ? edge : (int32_t)(E.ticks - a->next) >= 0) {
        step = 1;
        if (!clk) {
            a->next += rate;
            if ((int32_t)(E.ticks - a->next) >= 0)
                a->next = E.ticks + rate;        /* fell behind (a tempo jump): from now */
        }
        if (a->since > 0)
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

/* the keys (engine.ts noteOn / noteOff): with a track armed they go into it and through to what it plays, and nowhere
 * else; otherwise to the groups that take them, the shared keyboard, the Arpeggiators, the Drum maps and the tracks a
 * cable from Main's keys feeds */
void eng_note_on(uint32_t note, int32_t vel_q16, uint32_t ch)
{
    uint32_t g, v = (uint32_t)clampi((int32_t)(((int64_t)vel_q16 * 127 + 32768) >> 16), 1, 127);
    if (E.arm) {
        if (!dev_ch || dev_ch == ch)
            thru_put(E.arm - 1u, note | 0x80u, v);
        return;
    }
    for (g = 0; g <= E.ngrp; g++)
        if (!E.grp[g].src && takes_key(&E.grp[g], note, ch))
            group_on(&E.grp[g], note, vel_q16);
    if (!dev_ch || dev_ch == ch) {
        for (g = 0; g < E.narp; g++)
            arp_note_on(&E.arp[g], note, vel_q16);
        dm_keys(1u, note | 0x80u, v);
        for (g = 0; g < E.nmod; g++)
            if (E.node[g].type == T_STEPS && E.node[g].ksrc)
                thru_put(g, note | 0x80u, v);
    }
}

void eng_note_off(uint32_t note, uint32_t ch)
{
    uint32_t g;
    if (E.arm) {
        if (!dev_ch || dev_ch == ch)
            thru_put(E.arm - 1u, note, 0u);
        return;
    }
    for (g = 0; g <= E.ngrp; g++)
        if (!E.grp[g].src && takes_key(&E.grp[g], note, ch))
            group_off(&E.grp[g], note);
    if (!dev_ch || dev_ch == ch) {
        for (g = 0; g < E.narp; g++)
            arp_note_off(&E.arp[g], note);
        dm_keys(1u, note, 0u);
        for (g = 0; g < E.nmod; g++)
            if (E.node[g].type == T_STEPS && E.node[g].ksrc)
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
    for (g = 0; g <= E.ngrp; g++) {
        if (E.grp[g].src)
            continue;
        E.grp[g].nheld = 0;
        for (v = 0; v < E.grp[g].parts; v++) {
            E.pv[E.grp[g].pv0 + v].on = 0;
            E.pv[E.grp[g].pv0 + v].gate = 0;
            E.pv[E.grp[g].pv0 + v].retrig = 0;
        }
    }
    for (g = 0; g < E.nmod; g++)
        if (E.node[g].type == T_DRUMMAP && E.node[g].ksrc == 1u)
            inst_pool[E.node[g].inst0].s.dm.gate = 0;
        else if (E.node[g].type == T_STEPS && E.node[g].ksrc)
            E.thru_kill |= (uint16_t)(1u << E.node[g].trk);
}

/* Arm a Steps module (#139; engine.ts arm; -1 none): while one is armed the keys go into its keys in and through it to
 * what it plays, instead of where they go otherwise. The keys held when the routing changes go quiet. Not saved; another
 * patch disarms. */
void eng_arm(int module)
{
    uint32_t a = module >= 0 && (uint32_t)module < E.nmod && E.node[module].type == T_STEPS ? (uint32_t)module + 1u : 0u;
    if (!E.loaded || a == E.arm)
        return;
    if (E.arm)
        E.thru_kill |= (uint16_t)(1u << E.node[E.arm - 1u].trk);
    keys_off();
    E.arm = (uint8_t)a;
}
int eng_armed(void) { return E.loaded && E.arm ? (int)E.arm - 1 : -1; }

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
                if (E.node[m].type != T_FM1 && E.node[m].type != T_OUTPUT)
                    E.node[m].bypass = (uint8_t)(panel_buttons >> b & 1u);
            }
    toggles_sync();
}
uint32_t eng_buttons_get(void) { return panel_buttons; }
uint32_t eng_ticks(void) { return E.ticks; }
int eng_clock_is_external(void) { return clk_ext; }
void eng_transport(int on) { transport_on = (uint8_t)(on != 0); }
int eng_transport_running(void) { return transport_on; }

/* ------------------------------------------------------------------ Steps modules (the SEQ page) */
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
/* A track's notes as a working copy and back (track.ts fixNotes): sorted by step, then note (stable: of two notes on the same
 * step and key the first stays), at most TRACK_NOTES_MAX, into the pool (the tracks after it move) */
static uint32_t trk_copy(uint32_t t, uint32_t *w)
{
    uint32_t i;
    for (i = 0; i < E.trk_n[t]; i++)
        w[i] = E.trk_note[E.trk_first[t] + i];
    return E.trk_n[t];
}
static int trk_put(uint32_t t, uint32_t *w, uint32_t n)
{
    uint32_t i, j, k, old = E.trk_n[t], first = E.trk_first[t];
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
    if ((uint32_t)E.nnotes - old + n > ENG_MAX_NOTES)
        return 0;
    if (n > old)                                  /* the tracks after it move up or down */
        for (i = E.nnotes; i-- > first + old;)
            E.trk_note[i + n - old] = E.trk_note[i];
    else if (n < old)
        for (i = first + old; i < E.nnotes; i++)
            E.trk_note[i - (old - n)] = E.trk_note[i];
    for (i = 0; i < n; i++)
        E.trk_note[first + i] = w[i];
    E.nnotes = (uint16_t)(E.nnotes - old + n);
    E.trk_n[t] = (uint8_t)n;
    for (i = t + 1u; i < E.ntrk; i++)
        E.trk_first[i] = (uint16_t)(E.trk_first[i] + n - old);
    return 1;
}

/* the step view (track.ts stepView, setStep, setStepValue): the SEQ page edits a track's notes as steps. A step is on
 * when notes start there (its accent, chance, note and velocity are its lowest note's), tied when a note started before
 * goes on through it. get: the step as a byte (bit 0 on, bit 1 accent = full velocity, bits 2..6 the chance code, bit 7
 * tie), -1 if `module` is not a Steps module */
static int steps_first(uint32_t t, uint32_t k)    /* the pool index of the first note on step k, -1 none */
{
    uint32_t i;
    for (i = 0; i < E.trk_n[t]; i++)
        if (NW_AT(E.trk_note[E.trk_first[t] + i]) == k)
            return (int)(E.trk_first[t] + i);
    return -1;
}
static int steps_tied(uint32_t t, uint32_t k)     /* no note starts on k and one started before goes on through it */
{
    uint32_t i;
    if (steps_first(t, k) >= 0)
        return 0;
    for (i = 0; i < E.trk_n[t]; i++) {
        uint32_t w = E.trk_note[E.trk_first[t] + i];
        if (NW_AT(w) < k && k < NW_AT(w) + NW_LEN(w))
            return 1;
    }
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
        return steps_tied(t, k) ? 0x80 : 0;
    w = E.trk_note[f];
    return (int)(1u | (NW_VEL(w) == ACCENT_VEL ? 2u : 0u) | (NW_CODE(w) > 19u ? 19u : NW_CODE(w)) << 2);
}
/* step k set as a byte: tie = the notes sounding on the step before go on through it (its own notes give way; nothing
 * sounding: no change); else a tied step is untied (the notes through it end before it), on = a note there if it has none
 * (C4, the default velocity), its notes get the chance and the accent (full velocity; the accent taken away: the default
 * velocity); off = its notes go */
void eng_steps_set(uint32_t module, uint32_t k, uint32_t b)
{
    uint32_t w[TRACK_NOTES_MAX + 1u], n, i, m, t, code = (b >> 2) & 31u, mine = 0;
    if (!steps_inst(module) || k >= TRACK_STEPS)
        return;
    t = E.node[module].trk;
    n = trk_copy(t, w);
    if (code > 19u)
        code = 19u;
    if (b & 0x80u) {
        int any = 0;
        for (i = 0; i < n; i++)
            any |= NW_AT(w[i]) < k && NW_AT(w[i]) + NW_LEN(w[i]) >= k;
        if (!any)
            return;
        for (i = m = 0; i < n; i++)
            if (NW_AT(w[i]) != k) {
                if (NW_AT(w[i]) < k && NW_AT(w[i]) + NW_LEN(w[i]) < k + 1u && NW_AT(w[i]) + NW_LEN(w[i]) >= k)
                    w[i] = (w[i] & ~(63u << 6)) | (k - NW_AT(w[i])) << 6;   /* length k - at + 1 */
                w[m++] = w[i];
            }
        (void)trk_put(t, w, m);
        return;
    }
    if (steps_tied(t, k))
        for (i = 0; i < n; i++)
            if (NW_AT(w[i]) < k && k < NW_AT(w[i]) + NW_LEN(w[i]))
                w[i] = (w[i] & ~(63u << 6)) | (k - NW_AT(w[i]) - 1u) << 6;    /* length k - at */
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
    *w = &E.trk_note[E.trk_first[E.node[module].trk]];
    return E.trk_n[E.node[module].trk];
}
/* a track's notes replaced (the editor's TRACK): checked, sorted; 0 when they do not fit the pool */
int eng_steps_set_notes(uint32_t module, const uint32_t *notes, uint32_t n)
{
    uint32_t w[TRACK_NOTES_MAX], i, m = 0;
    if (!steps_inst(module) || n > TRACK_NOTES_MAX)
        return 0;
    for (i = 0; i < n; i++)
        if (NW_AT(notes[i]) + NW_LEN(notes[i]) <= TRACK_STEPS && NW_VEL(notes[i]))
            w[m++] = notes[i] & 0x7FFFFFFFu;
    return trk_put(E.node[module].trk, w, m);
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
    len = clampi(round_q16(it->eff[STEPS_P_LEN]), 1, TRACK_STEPS);
    k = it->s.stp.pos < 0 ? 0 : it->s.stp.pos;
    if (it->s.stp.pos >= 0 && it->s.stp.slen > 0 && 2 * it->s.stp.sst >= it->s.stp.slen) {
        k = k + 1 >= len ? 0 : k + 1;
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
    uint32_t at = eng_records_at(p, len), i, nmod, ncab, npar = 0;
    if (!at || len < 8u || p[1] < 33u || !(p[6] & 128u))
        return 0;
    nmod = p[2];
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    for (i = 0; i < nmod; i++) {
        const def_t *d;
        if (at >= len || (p[at] & 0x7Fu) >= N_TYPES)
            return 0;
        d = &DEFS[p[at] & 0x7Fu];
        at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u) + d->ndata;
        npar += d->npar;
    }
    at += 4u * ncab + ((p[6] & 1u) ? 4u * npar : 0u);
    if (p[6] & 4u)
        at += nmod;
    if (p[6] & 8u) {
        if (at >= len)
            return 0;
        at += 1u + 4u * p[at];
    }
    if ((p[6] & 16u) && !(at = eng_notes_end(p, len, at)))
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
        if (E.node[i].type == T_DRUMMAP && E.node[i].ksrc == 2u + module)
            return (int)i;
    return -1;
}
int eng_drummap_note(uint32_t map, uint32_t r)
{
    if (!E.loaded || map >= E.nmod || E.node[map].type != T_DRUMMAP || r >= ENG_DRUM_ROWS)
        return -1;
    return clampi(round_q16(E.node[map].par[r]), 0, 127);
}
uint32_t eng_steps_note(uint32_t module, uint32_t k, uint32_t note)
{
    uint32_t i, t;
    if (!steps_inst(module))
        return 0;
    t = E.node[module].trk;
    for (i = 0; i < E.trk_n[t]; i++) {
        uint32_t w = E.trk_note[E.trk_first[t] + i];
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
    len = clampi(round_q16(it->eff[STEPS_P_LEN]), 1, TRACK_STEPS);
    k = it->s.stp.pos < 0 ? 0 : it->s.stp.pos;
    if (it->s.stp.pos >= 0 && it->s.stp.slen > 0 && 2 * it->s.stp.sst >= it->s.stp.slen) {
        k = k + 1 >= len ? 0 : k + 1;
        it->s.stp.skip = (int8_t)k;
        it->s.stp.skipn = (uint8_t)(note + 1u);
    }
    eng_steps_overdub(module, NW((uint32_t)k, 1u, note, accent ? ACCENT_VEL : STEP_VEL, 0u));
    return k;
}

/* step entry (#139; track.ts setChord): step k's notes replaced by `n` notes one step long at `vel` (its chance kept, a tie
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
    if (!steps_inst(module) || NW_AT(word) + NW_LEN(word) > TRACK_STEPS)
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
    for (i = 0; i <= E.ngrp; i++)
        E.grp[i].nheld = 0;
    for (i = 0; i < ENG_NPV; i++) {
        E.pv[i].on = 0;
        E.pv[i].gate = 0;
        E.pv[i].retrig = 0;
    }
    for (i = 0; i < E.nmod; i++)
        if (E.node[i].type == T_DRUMMAP)
            inst_pool[E.node[i].inst0].s.dm.gate = 0;
    E.thru_kill = 0xFFFFu;                       /* the keys played through the tracks end too */
}

/* ------------------------------------------------------------------ modules */

#define EF(it, name) ((it)->eff[name])

/* a constant block into an output; nothing for an unconnected one (they all share dummy_out, which nobody reads) */
static void fill(esig_t *o, int32_t v, uint32_t n)
{
    uint32_t i = 0;
    if (o == dummy_out)
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
    const pv_t *x = cur_pv;
    fill(it->out[FM1_O_PITCH], x->pitch + mulq(E.ctl[ENG_CTL_BEND], 10923, 16), n);   /* + bend x 2 semitones */
    fill(it->out[FM1_O_BEND], E.ctl[ENG_CTL_BEND], n);
    fill(it->out[FM1_O_MOD], E.ctl[ENG_CTL_MOD], n);
    fill(it->out[FM1_O_AT], E.ctl[ENG_CTL_AT], n);
    fill(it->out[FM1_O_KEYS], x->gate, n);   /* the keys for Voice allocators (modules.ts): never patched in the binary, 1 while a key is down */
    fill(it->out[FM1_O_GATE], x->gate, n);
    fill(it->out[FM1_O_VEL], x->vel, n);
    if (x->retrig)
        it->out[FM1_O_GATE][0] = 0;              /* one low sample: the envelopes of a taken-over part see a new gate */
    {
        esig_t *ck = it->out[FM1_O_CLOCK];
        uint32_t i, p = E.clk_pulse < n ? E.clk_pulse : n;
        if (ck != dummy_out) {
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
    (void)nd;
    fill(it->out[ARP_O_KEYS], cur_pv->gate, n);
}

/* the Part module (modules.ts part): its part's note (with its detune / drift flaw), the part's place among the parts (index -1 .. 1, 0 with one part),
 * legato (the note began over a held one) and jump (the pitch step in octaves) */
static void m_part(const node_t *nd, inst_t *it, uint32_t n)
{
    const pv_t *x = cur_pv;
    int32_t np = cur_g->parts;
    fill(it->out[PART_O_PITCH], x->pitch + mulq(E.ctl[ENG_CTL_BEND], 10923, 16) + x->flaw, n);
    fill(it->out[PART_O_GATE], x->gate, n);
    if (x->retrig)
        it->out[PART_O_GATE][0] = 0;
    fill(it->out[PART_O_VEL], x->vel, n);
    fill(it->out[PART_O_INDEX], np > 1 ? (int32_t)((((int64_t)2 * (int32_t)cur_v - (np - 1)) << 16) / (np - 1)) : 0, n);
    fill(it->out[PART_O_LEGATO], x->legato ? ENG_ONE : 0, n);
    fill(it->out[PART_O_JUMP], x->jump, n);
}

/* the Random module (modules.ts random): fixed (a hash of its seed) or a walk, Q15 -> Q16 */
static void m_random(const node_t *nd, inst_t *it, uint32_t n)
{
    int32_t q;
    walk_step(&it->s.rnd.w, walk_hold(EF(it, RANDOM_P_RATE)));   /* every block, so the wander does not depend on the mode */
    q = round_q16(EF(it, RANDOM_P_MODE)) ? it->s.rnd.w.y : q15(hash32(it->s.rnd.seed));
    fill(it->out[RANDOM_O_OUT], 2 * q, n);
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

static void m_osc(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[OSC_I_PITCH], *pm = it->in[OSC_I_PM], *sync = it->in[OSC_I_SYNC];
    esig_t *out = it->out[OSC_O_OUT];
    int32_t pw_q = clampi(EF(it, OSC_P_PW), 3277, 62259);                  /* 0.05 .. 0.95 */
    uint32_t pw = (uint32_t)pw_q << 16, phase = it->s.osc.phase, i;
    int32_t base = EF(it, OSC_P_COARSE) / 12 + EF(it, OSC_P_FINE) / 1200;
    int32_t kind = round_q16(EF(it, OSC_P_WAVE)), lvl = EF(it, OSC_P_LEVEL), fb = EF(it, OSC_P_FB);
    int32_t idx = nd->conn & (1u << OSC_I_PM) ? EF(it, OSC_P_PM) : 0;
    int32_t y1, y2, pm1, xb, *ap = it->s.osc.ap, s1 = it->s.osc.s1;
    uint32_t dt_fm = 0;
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
        uint32_t dts[5], rc[5][4] = {{0}};
        int32_t lastp = 0;
        if (nu == 1) {                                                      /* one phase: the wave picked once a block */
            uint32_t dt = 0, *r = rc[0];
            int32_t d0 = base + doct[0];
#define OSC_PITCH                                                                       \
                if (i == 0 || pitch[i] != lastp) {                                      \
                    lastp = pitch[i];                                                   \
                    dt = exp2_scale(INC_C4, lastp + d0);                                \
                    if (dt > DT_MAX)                                                    \
                        dt = DT_MAX;                                                    \
                }
#define OSC_PLAIN(Y)                                                                    \
            for (i = 0; i < n; i++) {                                                   \
                OSC_PITCH                                                               \
                phase += dt;                                                            \
                out[i] = mul16((Y), lvl);                                               \
            }
#define OSC_SYNC(Y)                                                                     \
            for (i = 0; i < n; i++) {                                                   \
                int rst = sync[i] >= 32768 && s1 < 32768;                               \
                OSC_PITCH                                                               \
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
                default: OSC_PLAIN(wave_square(phase, dt, pw, r)) break;
                }
                s1 = n ? sync[n - 1] : s1;                                  /* (the unconnected sync input reads 0) */
            } else {
                switch (kind) {
                case 0: OSC_SYNC(sin_turn(phase)) break;
                case 1: OSC_SYNC(wave_tri(phase)) break;
                case 2: OSC_SYNC(wave_saw(phase, dt, r)) break;
                default: OSC_SYNC(wave_square(phase, dt, pw, r)) break;
                }
            }
#undef OSC_PLAIN
#undef OSC_SYNC
#undef OSC_PITCH
            n = 0;                                                          /* skips the general loop below */
        }
        if (n) {                                                            /* unison / stack: the wave picked once a block, phases in locals */
            uint32_t lph[4];
            for (j = 0; j < 4; j++)
                lph[j] = ph[j];
#define OSC_SIN(p, d, r) sin_turn(p)
#define OSC_TRI(p, d, r) wave_tri(p)
#define OSC_SAW(p, d, r) wave_saw(p, d, r)
#define OSC_SQR(p, d, r) wave_square(p, d, pw, r)
#define OSC_UNI(W)                                                                      \
            for (i = 0; i < n; i++) {                                                   \
                int rst = sync[i] >= 32768 && s1 < 32768;   /* a rising edge on sync restarts the phases */ \
                int32_t y;                                                              \
                if (i == 0 || pitch[i] != lastp) {          /* the increments only when the pitch moves */ \
                    lastp = pitch[i];                                                   \
                    for (j = 0; j < nu; j++) {                                          \
                        dts[j] = exp2_scale(INC_C4, lastp + base + doct[j]);            \
                        if (dts[j] > DT_MAX)                                            \
                            dts[j] = DT_MAX;                                            \
                    }                                                                   \
                }                                                                       \
                s1 = sync[i];                                                           \
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
            }
            switch (kind) {
            case 0: OSC_UNI(OSC_SIN) break;
            case 1: OSC_UNI(OSC_TRI) break;
            case 2: OSC_UNI(OSC_SAW) break;
            default: OSC_UNI(OSC_SQR) break;
            }
#undef OSC_UNI
#undef OSC_SIN
#undef OSC_TRI
#undef OSC_SAW
#undef OSC_SQR
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
    uint32_t frc[4] = {0};
    for (i = 0; i < n; i++) {
        uint32_t dt, sub;
        int32_t pm_now = idx > 0 ? pm[i] : 0, pm_mid = (pm1 + pm_now) >> 1, ya = 0;
        if (i == 0 || pitch[i] != pitch[i - 1]) {                        /* the increment only when the pitch moves */
            dt_fm = exp2_scale(INC_C4, pitch[i] + base);
            if (dt_fm > DT_MAX)
                dt_fm = DT_MAX;
            dt_fm >>= 1;
        }
        dt = dt_fm;
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
    it->s.lfo.seed = it->s.lfo.seed * 1664525u + 1013904223u;
    it->s.lfo.held = (int32_t)(it->s.lfo.seed >> 15) - ENG_ONE;
}

/* the free-running LFO (no sync, nothing in clk / reset): the wave picked once a block. A function of its own: inside
 * m_lfo the branch around it came out longer than 16 KB in the JieLi build, a form of `if ((R & #h) == #i) goto` that
 * fm1-emu (7ca5b96) does not decode yet (docs/ARCHITECTURE.md "Estimated CPU load") */
static void __attribute__((noinline)) lfo_free(inst_t *it, esig_t *out, uint32_t dt, int32_t kind, int32_t depth, uint32_t n)
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
    case 0: LFO_FREE(sin_turn(phase)) break;
    case 1: LFO_FREE(wave_tri(phase)) break;
    case 2: LFO_FREE(wave_saw(phase, dt, lrc)) break;
    case 4: LFO_FREE(it->s.lfo.held) break;
    default: LFO_FREE(wave_square(phase, dt, 0x80000000u, lrc)) break;
    }
#undef LFO_FREE
    it->s.lfo.since = since < ENG_SR ? since : ENG_SR;   /* as m_lfo's loop counts it, the clock and reset inputs low */
    it->s.lfo.clk_hi = 0;
    it->s.lfo.rst_hi = 0;
    it->s.lfo.phase = phase;
}

/* free: rate in Hz. sync: one cycle per note length (DELAY_DIV_NUM / DELAY_DIV_DEN, as the delay) that snaps to every n-th edge of clk
 * (24 ppqn, n = ticks per cycle), runs at the measured clock speed in between and at bpm when there is no clock. */
static void m_lfo(const node_t *nd, inst_t *it, uint32_t n)
{
    esig_t *out = it->out[0];
    const esig_t *clk = it->in[LFO_I_CLK], *rst = it->in[LFO_I_RESET];
    uint32_t dtfree = hz_turns((uint32_t)EF(it, LFO_P_RATE)), phase = it->s.lfo.phase, i, dt;
    int32_t kind = round_q16(EF(it, LFO_P_WAVE)), depth = EF(it, LFO_P_DEPTH);
    int sync = EF(it, LFO_P_SYNC) >= 32768;
    int32_t div = clampi((EF(it, LFO_P_DIV) + 32768) >> 16, 0, DELAY_NDIV - 1), bpm = EF(it, LFO_P_BPM);
    uint32_t per = 24u * DELAY_DIV_NUM[div] / DELAY_DIV_DEN[div], dtbpm, lrc[4] = {0};
    if (bpm < 65536)
        bpm = 65536;
    dtbpm = (uint32_t)(((uint64_t)(uint32_t)bpm * DELAY_DIV_DEN[div] << 16) / (60u * DELAY_DIV_NUM[div] * ENG_SR));
    if (!sync && !(nd->conn & ((1u << LFO_I_CLK) | (1u << LFO_I_RESET)))) {   /* free running, nothing patched in */
        lfo_free(it, out, dtfree, kind, depth, n);
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
            if (sync && ++it->s.lfo.ticks >= per) {
                it->s.lfo.ticks = 0;
                phase = prev = 0;
                lfo_cycle(it);
            }
        }
        it->s.lfo.clk_hi = (uint8_t)c;
        if (r && !it->s.lfo.rst_hi) {
            phase = prev = 0;
            it->s.lfo.ticks = 0;
            lfo_cycle(it);
        }
        it->s.lfo.rst_hi = (uint8_t)r;
        live = sync && it->s.lfo.interval > 0 && it->s.lfo.since < ENG_SR / 2;
        dt = !sync ? dtfree : live ? (uint32_t)((1ull << 40) / ((uint64_t)per * (uint32_t)it->s.lfo.interval)) : dtbpm;
        phase += dt;
        if (phase < prev) {
            if (live)
                phase = 0xFFFFFFFFu;        /* wait for the clock's next cycle start */
            else
                lfo_cycle(it);              /* a new cycle: sample & hold takes a new random value */
        }
        w = kind == 4 ? it->s.lfo.held : wave(kind, phase, dt, 0x80000000u, lrc);
        out[i] = mul16(w, depth);
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

static void m_const(const node_t *nd, inst_t *it, uint32_t n) { fill(it->out[0], EF(it, 0), n); }

static void m_scale(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SCALE_I_IN];
    esig_t *out = it->out[0];
    int32_t g = EF(it, SCALE_P_GAIN), o = EF(it, SCALE_P_OFFSET);
    uint32_t i;
    for (i = 0; i < n; i++)
        out[i] = mul16(in[i], g) + o;
}

static int32_t env_rate(int32_t t_q16);
static int32_t env_rate_n(uint32_t n);

/* a one-pole glide: 99 % of a step in `time` (the envelope's rate curve, Q30 per sample). The state is Q24 (+-128):
 * in Q16 the step k * (in - y) would round to nothing while still 1 % short of the target, which a pitch can hear. */
static void m_glide(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[GLIDE_I_IN];
    esig_t *out = it->out[0];
    int32_t k = env_rate(EF(it, GLIDE_P_TIME)), y = it->s.gld.y;
    uint32_t i;
    if (round_q16(EF(it, GLIDE_P_CURVE)) == 1) {   /* lin: one unit per `time`, Q24 per sample (modules.ts glide) */
        int64_t den = (int64_t)EF(it, GLIDE_P_TIME) * ENG_SR;             /* samples, Q16 */
        int32_t step = den > ((int64_t)1 << 16) ? (int32_t)(((int64_t)1 << 40) / den) : 1 << 24;
        for (i = 0; i < n; i++) {
            int32_t d = (clampi(in[i], -(1 << 23), (1 << 23) - 1) << 8) - y;
            y += d > step ? step : d < -step ? -step : d;
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
        int64_t y2 = (int64_t)((y * y) >> 30), y3 = (y2 * (int64_t)y) >> 30, y4 = (y3 * (int64_t)y) >> 30;
        return (int32_t)((int64_t)y - y2 / 2 + y3 / 6 - y4 / 24);
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
    const esig_t *gate = it->in[ADSR_I_GATE];
    esig_t *out = it->out[0];
    int32_t ad = env_rate(EF(it, ADSR_P_D)), ar = env_rate(EF(it, ADSR_P_R));
    uint64_t asr = ((uint64_t)(uint32_t)EF(it, ADSR_P_A) * ENG_SR) >> 8;
    int32_t ainc, sus = EF(it, ADSR_P_S) << 14, v = it->s.adsr.v;
    uint8_t stage = it->s.adsr.stage, prev = it->s.adsr.prev;
    uint32_t i;
    if (asr < 256u)
        asr = 256u;
    ainc = (int32_t)((1ull << 38) / asr);
    for (i = 0; i < n; i++) {
        uint8_t g = gate[i] > 32768 ? 1 : 0;
        if (g && !prev)
            stage = 1;
        else if (!g && prev)
            stage = 4;
        prev = g;
        switch (stage) {
        case 1:
            v += ainc;
            if (v >= (1 << 30)) {
                v = 1 << 30;
                stage = 2;
            }
            break;
        case 2: {
            int32_t d = sus - v;
            v += mulq(d, ad, 30);
            d = sus - v;
            if ((d < 0 ? -d : d) < 107374)
                stage = 3;
            break;
        }
        case 3:
            v = sus;
            break;
        case 4:
            v -= mulq(v, ar, 30);
            if (v < 107374) {
                v = 0;
                stage = 0;
            }
            break;
        }
        out[i] = v >> 14;
    }
    it->s.adsr.v = v;
    it->s.adsr.stage = stage;
    it->s.adsr.prev = prev;
}

static void m_vca(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[VCA_I_IN], *cv = it->in[VCA_I_CV];
    esig_t *out = it->out[0];
    int32_t g = EF(it, VCA_P_GAIN);
    uint32_t i;
    (void)nd; /* an unplugged cv reads the zero buffer: a VCA with no control is closed */
    for (i = 0; i < n; i++)
        out[i] = mul16(mul16(in[i], cv[i]), g);
}

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

/* Two stages: stage 1 (12 dB) gives lp12, bp, hp (and notch, peak, allpass from the same values, only when a cable
 * leaves them); stage 2 filters lp12 again (lp24); mix fades lp24 -> hp by morph.
 * The integrator states are Q20 (+-2048: room for the resonance peak), the signals Q16; products are rounded.
 * Key tracking moves the cutoff by the voice pitch (octaves, C4 = as set), like the host engine, once per block. */
static void m_filter(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[FILTER_I_IN], *cv = it->in[FILTER_I_CV], *mo = it->in[FILTER_I_MORPH];
    esig_t *lp = it->out[FILTER_O_LP12], *bp = it->out[FILTER_O_BP], *hp = it->out[FILTER_O_HP];
    esig_t *lp24 = it->out[FILTER_O_LP24], *mix = it->out[FILTER_O_MIX];
    esig_t *notch = it->out[FILTER_O_NOTCH], *peak = it->out[FILTER_O_PEAK], *apo = it->out[FILTER_O_AP];
    int32_t k24 = (2 << 24) - mulq(EF(it, FILTER_P_RES), 33218888, 16);   /* 2 - 1.98 res */
    int32_t cvamt = EF(it, FILTER_P_CVAMT), ic1 = it->s.flt.ic1, ic2 = it->s.flt.ic2, jc1 = it->s.flt.jc1, jc2 = it->s.flt.jc2;
    int32_t morph = EF(it, FILTER_P_MORPH), tr = EF(it, FILTER_P_TRACK) >= 32768 ? cur_pv->pitch : 0;
    uint32_t base = hz_turns((uint32_t)EF(it, FILTER_P_CUTOFF)), i;
    svf_coef_t c, d;
    int fixed = !(nd->conn & (1u << FILTER_I_CV));
    int msig = nd->conn & (1u << FILTER_I_MORPH);
    int ext = notch != dummy_out || peak != dummy_out || apo != dummy_out;   /* the notch / peak / allpass outputs are in use */
    int st2 = lp24 != dummy_out || mix != dummy_out;     /* the second stage only feeds lp24 and mix: skipped when neither is */
    int32_t lcv = 0;
    if (tr)
        base = exp2_scale(base, tr);
    if (fixed) {
        int32_t g = svf_g(base);
        svf_stage(&c, g, k24);
        svf_stage(&d, g, SQRT2_24);
    }
    for (i = 0; i < n; i++) {
        int32_t v0 = in[i] << 4, v3, v1, v2, w3, w1, w2, h, m, kv1;          /* Q20 */
        if (!fixed && (i == 0 || cv[i] != lcv)) {      /* the coefficients only when the cv moves (exactly the same values) */
            int32_t g;
            lcv = cv[i];
            g = svf_g(exp2_scale(base, mul16(lcv, cvamt)));
            svf_stage(&c, g, k24);
            if (st2)
                svf_stage(&d, g, SQRT2_24);
        }
        v3 = v0 - ic2;
        v1 = mulr(c.a1, ic1, 24) + mulr(c.a2, v3, 24);
        v2 = ic2 + mulr(c.a2, ic1, 24) + mulr(c.a3, v3, 24);
        ic1 = clampi(2 * v1 - ic1, -(1 << 30), 1 << 30);
        ic2 = clampi(2 * v2 - ic2, -(1 << 30), 1 << 30);
        kv1 = mulr(v1, k24, 24);
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
        if (ext) {                                                        /* from the same states: notch = in - k bp, peak = lp12 - hp, allpass = in - 2 k bp */
            notch[i] = (v0 - kv1 + 8) >> 4;
            peak[i] = (v2 - h + 8) >> 4;
            apo[i] = (v0 - 2 * kv1 + 8) >> 4;
        }
    }
    it->s.flt.ic1 = ic1;
    it->s.flt.ic2 = ic2;
    it->s.flt.jc1 = jc1;
    it->s.flt.jc2 = jc2;
}

#define LAD_SAT_KNEE (3 << 19)      /* 1.5 in Q20: the saturator's knee */
#define LAD_SAT_CUBE 2485513        /* 1 / 6.75 in Q24 */

/* Ladder filter with drive (modules.ts `ladder`): four TPT one-poles (G = g / (1 + g), Q24) in a loop with k = 4 res.
 * The loop is solved linearly per sample (y4 = F (G^4 x + S), S the states' share, F = 1 / (1 + k G^4)), the loop input
 * u = sat(drive x - k y4) then runs through the stages; sat is v - v^3 / 6.75 up to |v| = 1.5, +-1 beyond. The
 * coefficients come once per block from the block mean of cv, cvamt and key tracking (no per-sample recip24: the SVF
 * keeps that for audio-rate cutoff). States Q20, products rounded; the saturator bounds the states, so no clamps. */
static void m_ladder(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[LADDER_I_IN], *cv = it->in[LADDER_I_CV];
    esig_t *lp24 = it->out[LADDER_O_LP24], *lp12 = it->out[LADDER_O_LP12];
    int32_t *s = it->s.lad.s;
    int32_t drive = EF(it, LADDER_P_DRIVE), cvamt = EF(it, LADDER_P_CVAMT);
    int32_t k24 = EF(it, LADDER_P_RES) << 10;                                     /* 4 res, Q24 */
    int32_t tr = EF(it, LADDER_P_TRACK) >= 32768 ? cur_pv->pitch : 0, x = tr;
    uint32_t base = hz_turns((uint32_t)EF(it, LADDER_P_CUTOFF)), i;
    int32_t g, G, G2, G3, G4, hG, F;
    if (nd->conn & (1u << LADDER_I_CV)) {
        int64_t sum = 0;
        for (i = 0; i < n; i++)
            sum += cv[i];
        x += mul16(block_mean(sum, n), cvamt);
    }
    if (x)
        base = exp2_scale(base, x);
    g = svf_g(base);
    G = mulq(g, recip24((1 << 24) + g), 24);
    G2 = mulq(G, G, 24);
    G3 = mulq(G2, G, 24);
    G4 = mulq(G3, G, 24);
    hG = (1 << 24) - G;
    F = recip24((1 << 24) + mulq(k24, G4, 24));
    {
        int32_t s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3];     /* the states in registers, the four stages written out */
        for (i = 0; i < n; i++) {
            int32_t x20 = in[i] << 4, S, y4, u, v, y2;
            S = mulr(G3, s0, 24) + mulr(G2, s1, 24) + mulr(G, s2, 24) + s3;
            S = mulr(S, hG, 24);
            y4 = mulr(F, mulr(G4, x20, 24) + S, 24);
            u = mulq(x20, drive, 16) - mulq(k24, y4, 24);
            if (u >= LAD_SAT_KNEE)
                u = 1 << 20;
            else if (u <= -LAD_SAT_KNEE)
                u = -(1 << 20);
            else
                u -= mulq(mulq(mulq(u, u, 20), u, 20), LAD_SAT_CUBE, 24);
            v = mulr(G, u - s0, 24); u = v + s0; s0 = u + v;
            v = mulr(G, u - s1, 24); u = v + s1; s1 = u + v;
            y2 = u;
            v = mulr(G, u - s2, 24); u = v + s2; s2 = u + v;
            v = mulr(G, u - s3, 24); u = v + s3; s3 = u + v;
            lp24[i] = (u + 8) >> 4;
            lp12[i] = (y2 + 8) >> 4;
        }
        s[0] = s0;
        s[1] = s1;
        s[2] = s2;
        s[3] = s3;
    }
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

static void m_math(const node_t *nd, inst_t *it, uint32_t n)      /* modules.ts `math`: a' = a ka + off, b' = b kb */
{
    const esig_t *ia = it->in[MATH_I_A], *ib = it->in[MATH_I_B];
    esig_t **o = it->out;
    int32_t ka = EF(it, MATH_P_KA), kb = EF(it, MATH_P_KB), off = EF(it, MATH_P_OFF);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t a = mul16(ia[i], ka) + off, b = mul16(ib[i], kb);
        o[MATH_O_ADD][i] = a + b;
        o[MATH_O_SUB][i] = a - b;
        o[MATH_O_MUL][i] = mul16(a, b);
        o[MATH_O_MIN][i] = a < b ? a : b;
        o[MATH_O_MAX][i] = a > b ? a : b;
        o[MATH_O_ABS][i] = a < 0 ? -a : a;
        o[MATH_O_CMP][i] = a > b ? ENG_ONE : 0;
    }
    (void)nd;
}

static void m_logic(const node_t *nd, inst_t *it, uint32_t n)     /* modules.ts `logic`: gates high at or above thresh */
{
    const esig_t *ia = it->in[LOGIC_I_A], *ib = it->in[LOGIC_I_B];
    esig_t **o = it->out;
    int32_t t = EF(it, LOGIC_P_THRESH);
    uint32_t i;
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
 * from the write head plus a random spray, and reads `size` seconds at 2^(pitch / 12), linearly interpolated. The window
 * is sin^2 of half a turn over the grain (sin_turn). The line is int16 Q13 like the delay's. */
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
    uint32_t rate = exp2_q16(EF(it, GRAIN_P_PITCH) / 12 + (16 << 16));
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
    uint32_t i;
    for (i = 0; i < n; i++)
        out[i] = mul16(a[i], la) + mul16(b[i], lb) + mul16(c[i], lc) + mul16(d[i], ld);
}

#define DELAY_HALF (DELAY_LEN / 2u)

/* the note length the time knob selects while the delay is synced: its range split into DELAY_NDIV steps (also used by the LCD) */
uint32_t delay_div(int32_t time_q16)
{
    int64_t lo = DEFS[T_DELAY].pmin[DELAY_P_TIME], range = DEFS[T_DELAY].pmax[DELAY_P_TIME] - lo;
    int64_t i = (((int64_t)time_q16 - lo) * (DELAY_NDIV - 1) * 2 + range) / (range * 2);
    return (uint32_t)(i < 0 ? 0 : i > DELAY_NDIV - 1 ? DELAY_NDIV - 1 : i);
}

/* free or synced time (see modules.ts); ping-pong splits the buffer in two halves, A (input, left) and B (right), see modules.ts */
static void m_delay(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[DELAY_I_IN];
    esig_t *out = it->out[DELAY_O_OUT], *outr = it->out[DELAY_O_R];
    int16_t *buf = it->s.dly.buf;
    uint32_t w = it->s.dly.w, i, d;
    int32_t fb = EF(it, DELAY_P_FB), mix = EF(it, DELAY_P_MIX), dry = ENG_ONE - mix;
    int pp = EF(it, DELAY_P_PINGPONG) >= 32768;
    int64_t smp, top = pp ? (int64_t)DELAY_HALF - 1 : (int64_t)DELAY_LEN - 1;
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
    if (EF(it, DELAY_P_SYNC) >= 32768) {
        uint32_t div = delay_div(EF(it, DELAY_P_TIME));
        smp = ((int64_t)DELAY_DIV_NUM[div] * it->s.dly.beat * 2 + DELAY_DIV_DEN[div]) / ((int64_t)DELAY_DIV_DEN[div] * 2);
    } else
        smp = ((int64_t)EF(it, DELAY_P_TIME) * ENG_SR + (int64_t)500 * 65536) / (1000 * 65536);   /* round(t_ms / 1000 * sr) */
    d = (uint32_t)(smp < 1 ? 1 : smp > top ? top : smp);
    if (!pp) {
        for (i = 0; i < n; i++) {
            uint32_t rp = w >= d ? w - d : w + DELAY_LEN - d;
            int32_t r = (int32_t)buf[rp] * 8;
            buf[w] = dly_pack(in[i] + mul16(r, fb));
            if (++w == DELAY_LEN)
                w = 0;
            out[i] = mul16(in[i], dry) + mul16(r, mix);
            outr[i] = out[i];
        }
    } else {
        int16_t *bb = buf + DELAY_HALF;
        if (w >= DELAY_HALF)
            w = 0;
        for (i = 0; i < n; i++) {
            uint32_t rp = w >= d ? w - d : w + DELAY_HALF - d;
            int32_t ea = (int32_t)buf[rp] * 8, eb = (int32_t)bb[rp] * 8, dr = mul16(in[i], dry);
            bb[w] = dly_pack(mul16(ea, fb));
            buf[w] = dly_pack(in[i] + mul16(eb, fb));
            if (++w == DELAY_HALF)
                w = 0;
            out[i] = dr + mul16(ea, mix);
            outr[i] = dr + mul16(eb, mix);
        }
    }
    it->s.dly.w = w;
}

/* ---- reverb: the same Freeverb-style network as modules.ts, in Q16 with int16 (Q13) delay memory */

/* Reverb (modules.ts `reverb`): an eight-line FDN with a Householder feedback matrix (f_k = t_k - sum(t) / 4), a one-pole
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
    if (tq < 1)
        tq = 1;
    if (dpre > RV_PRE - 1u)
        dpre = RV_PRE - 1u;
    for (k = 0; k < 8u; k++) {
        int64_t e = -(((int64_t)RV_LINE[k] * RV_DB60) << 16) / ((int64_t)tq * ENG_SR);
        g[k] = (int32_t)exp2_q16((int32_t)(e < -(16 << 16) ? -(16 << 16) : e) + (16 << 16));
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
            u = mulr(u, RV_GIN, 16);
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
    for (st = 0; st < 6u; st++) {
        uint64_t tsr;
        lv[st] = EF(it, LP[st]) << 14;
        if (st == 0 || st == 4) {
            inc[st] = k[st] = 0;
            len[st] = 1;
            continue;
        }
        tsr = ((uint64_t)(uint32_t)EF(it, RP[st]) * ENG_SR + 32768u) >> 16;   /* round(r * sr) samples */
        if (tsr < 1u)
            tsr = 1u;
        len[st] = (uint32_t)tsr;
        inc[st] = (int32_t)((1ull << 30) / tsr);
        k[st] = env_rate_n((uint32_t)tsr);
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
    int32_t bw = 19661 + mul16(EF(it, MODAL_P_BRIGHT), 45875), amp[MODAL_N], g[MODAL_N], c1[MODAL_N], c2[MODAL_N], sum = 0, a = ENG_ONE;
    int32_t base = pitch[0] + EF(it, MODAL_P_COARSE) / 12;
    uint32_t i, k;
    for (i = 0; i < MODAL_N; i++) {
        amp[i] = a;
        sum += a;
        a = mul16(a, bw);
    }
    for (i = 0; i < MODAL_N; i++) {
        int32_t ratio = ((int32_t)(i + 1u) << 16) + mul16(st, MODAL_BAR_Q16[i] - ((int32_t)(i + 1u) << 16));
        uint32_t dt = exp2_scale(INC_C4, base + log2_q16((uint32_t)ratio) - (16 << 16));   /* f0 x ratio as a phase increment */
        int32_t r30, s30, sh, co30, dec_i;
        int64_t e;
        g[i] = c1[i] = c2[i] = 0;
        if (dt >= DT_MAX)
            continue;
        dec_i = (int32_t)(((int64_t)decay << 16) / (ENG_ONE + 2 * (int32_t)i * damp));      /* decay / (1 + 2 damp i) */
        e = -(((int64_t)LOG2_1000_Q16 << 16) / ((int64_t)dec_i * ENG_SR));                   /* octaves per sample, Q16 */
        r30 = (int32_t)exp2_scale(1u << 30, (int32_t)(e < -(47 << 16) ? -(47 << 16) : e));
        s30 = sin_turn30(dt);
        sh = sin_turn30(dt >> 1);                                                            /* cos th = 1 - 2 sin^2(th / 2): the pole's */
        co30 = (1 << 30) - mulq(sh, sh, 29);                                                 /* frequency needs cos accurate near 1 */
        g[i] = mulq((int32_t)(((int64_t)amp[i] << 16) / sum), s30, 16);
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
    for (i = 0; i < n; i++) {
        uint32_t dt = exp2_scale(INC_C4, pitch[i] + base), ph, xi, xf;
        int32_t ya, yb;
        if (dt > DT_MAX)
            dt = DT_MAX;
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
            len = clampi(len, 1, TRACK_STEPS - x.at);
            for (; j + 1u < E.nrin; j++)
                E.rin[j] = E.rin[j + 1u];
            E.nrin--;
            if ((uint8_t)(h - took_tail) < ENG_TOOK) {
                took_ring[h % ENG_TOOK][0] = node;
                took_ring[h % ENG_TOOK][1] = NW(x.at, (uint32_t)len, note, x.vel, 0u);
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
    for (e = 0; e < E.nthru; e++) {
        uint32_t note = E.blk_thru[e][1] & 0x7Fu, vel = E.blk_thru[e][2];
        int was;
        if (E.blk_thru[e][0] != node)
            continue;
        steps_thru_off(t, node, it, note);
        if (!(E.blk_thru[e][1] & 0x80u))
            continue;
        if (live && E.nrin < ENG_RIN) {
            int32_t ago = it->s.stp.sst, sl = it->s.stp.slen, pos = it->s.stp.pos;
            int next = ago * 2 >= sl, wrap = next && pos + 1 >= len;
            rin_t *x = &E.rin[E.nrin++];
            x->trk = (uint8_t)t;
            x->note = (uint8_t)note;
            x->at = (uint8_t)(wrap ? 0 : next ? pos + 1 : pos);
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
    if (E.thru_kill >> t & 1u) {                 /* the routing changed: the keys played through it go quiet */
        uint32_t j;
        E.thru_kill &= (uint16_t)~(1u << t);
        for (j = 0; j < E.trk_nsnd[t];)
            if (E.trk_snd[t][j].thru)
                steps_thru_off(t, node, it, E.trk_snd[t][j].thru - 1u);
            else
                j++;
    }
}

/* step k of a Steps module comes up: the notes sounding go on to their next step, then the notes starting on it sound
 * (unless their chance says no, it was recorded ahead (skip) or the track is muted); tr: the transpose input (Q16 octaves,
 * whole semitones for the keys) */
static void steps_fire(const node_t *nd, inst_t *it, int32_t k, int32_t len, int32_t gate, int32_t sl, int32_t tr)
{
    uint32_t t = nd->trk, node = (uint32_t)(nd - E.node), i, j = 0, end;
    int32_t semis = (int32_t)(((int64_t)tr * 12 + 32768) >> 16);
    int was, any = 0;
    for (i = 0; i < E.trk_nsnd[t]; i++) {
        snd_t *x = &E.trk_snd[t][i];
        if (x->left > 0 && x->cnt > 0 && !it->s.stp.mute) {
            x->left--;
            x->cnt = steps_hold(x->left, gate, sl);
        }
    }
    if (it->s.stp.mute)
        return;
    if (it->s.stp.skip == k && !it->s.stp.skipn) {
        it->s.stp.skip = -1;
        return;
    }
    was = steps_sounding(t);
    end = (uint32_t)E.trk_first[t] + E.trk_n[t];
    for (i = E.trk_first[t]; i < end && i < ENG_MAX_NOTES; i++) {
        uint32_t w = E.trk_note[i], left;
        int32_t key;
        if (NW_AT(w) != (uint32_t)k)
            continue;
        if (it->s.stp.skip == k && it->s.stp.skipn == NW_NOTE(w) + 1u) {   /* (a drum hit recorded ahead: only its note) */
            j++;
            continue;
        }
        if (!steps_plays(it->s.stp.seed, it->s.stp.loop, (uint32_t)k, j++, NW_CODE(w)))
            continue;
        key = clampi((int32_t)NW_NOTE(w) + semis, 0, 127);
        left = (NW_LEN(w) < (uint32_t)(len - k) ? NW_LEN(w) : (uint32_t)(len - k)) - 1u;
        steps_start(t, node, (uint32_t)key, NW_VEL(w), left, steps_hold(left, gate, sl));
        it->s.stp.pitch = steps_pitch(NW_NOTE(w));
        it->s.stp.vel = (int32_t)((NW_VEL(w) << 16) / 127u);
        E.trk_last[t] = (uint8_t)NW_NOTE(w);
        any = 1;
    }
    if (it->s.stp.skip == k)
        it->s.stp.skip = -1;
    if (any)
        it->s.stp.gap = (uint8_t)was;
}

/* the Steps module (modules.ts steps): one step per `rate` of the clock while the transport runs (the first when it starts),
 * or per rising edge in clk; every second step late by the swing; its notes sound for their length (gate x their last
 * step); trig is up while any sounds, pitch / vel hold the last that started, keys out every note on / off */
/* Drum map (modules.ts drummap): each row's gate while its note is held (one low first sample when it restarts) and its
 * velocity; the notes come in through dm_keys */
static void m_drummap(const node_t *nd, inst_t *it, uint32_t n)
{
    uint32_t r;
    (void)nd;
    for (r = 0; r < DRUMMAP_NOUT / 2u; r++) {
        esig_t *g = it->out[2u * r];
        fill(g, (it->s.dm.gate >> r & 1u) ? ENG_ONE : 0, n);
        if (g != dummy_out && (it->s.dm.gap >> r & 1u))
            g[0] = 0;
        fill(it->out[2u * r + 1u], it->s.dm.vel[r], n);
    }
    it->s.dm.gap = it->s.dm.fell = 0;
}

static void m_steps(const node_t *nd, inst_t *it, uint32_t n)
{
    static const uint8_t RATE_TICKS[7] = {24, 16, 12, 8, 6, 4, 3};   /* arpeggiator.ts ARP_RATE_TICKS */
    const esig_t *clk = it->in[STEPS_I_CLK], *reset = it->in[STEPS_I_RESET], *tr = it->in[STEPS_I_TRANSPOSE];
    esig_t *trig = it->out[STEPS_O_TRIG], *keys = it->out[STEPS_O_KEYS], *pitch = it->out[STEPS_O_PITCH], *vel = it->out[STEPS_O_VEL];
    uint32_t t = nd->trk, node = (uint32_t)(nd - E.node);
    int32_t len = clampi(round_q16(EF(it, STEPS_P_LEN)), 1, TRACK_STEPS);
    int32_t div = RATE_TICKS[clampi(round_q16(EF(it, STEPS_P_RATE)), 0, 6)];
    int32_t swing = EF(it, STEPS_P_SWING) - 50 * ENG_ONE, gate = EF(it, STEPS_P_GATE);
    int ext = (nd->conn >> STEPS_I_CLK) & 1u;
    uint32_t i;
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
                it->s.stp.pos = -1;
                adv++;
            }
            if ((int32_t)i == E.tick_off) {
                int32_t q;
                for (q = 0; q < E.tick_n; q++)
                    if (++it->s.stp.count >= div) {
                        it->s.stp.count = 0;
                        adv++;
                    }
            }
        }
        sl = ext && it->s.stp.period > 0 ? it->s.stp.period : (ext ? 6 : div) * E.tick_len;   /* the gate's step length */
        if (i == 0 && it->s.stp.hit) {           /* a hit from the panel (eng_steps_hit): the last note sounds now, whatever the pattern */
            int was = steps_sounding(t);
            steps_start(t, node, (uint32_t)clampi((int32_t)E.trk_last[t] + (int32_t)(((int64_t)tr[i] * 12 + 32768) >> 16), 0, 127), it->s.stp.hit == 2u ? ACCENT_VEL : STEP_VEL, 0, steps_hold(0, gate, sl));
            it->s.stp.gap = (uint8_t)was;
            it->s.stp.hit = 0;
        }
        it->s.stp.sst++;
        if (it->s.stp.pend > 0 && --it->s.stp.pend == 0)
            steps_fire(nd, it, it->s.stp.pstep, len, gate, sl, tr[i]);
        for (; adv > 0; adv--) {
            int32_t sw = ext ? it->s.stp.period : div * E.tick_len, d = 0;
            it->s.stp.pos = (int8_t)(it->s.stp.pos + 1 >= len ? 0 : it->s.stp.pos + 1);
            if (it->s.stp.pos == 0)
                it->s.stp.loop++;
            it->s.stp.sst = 0;
            it->s.stp.slen = sw;
            if ((it->s.stp.pos & 1) && swing > 0 && sw > 0)
                d = (int32_t)(((int64_t)swing * sw) / (50 * ENG_ONE));
            if (d > 0) {
                it->s.stp.pend = d;
                it->s.stp.pstep = it->s.stp.pos;
            } else
                steps_fire(nd, it, it->s.stp.pos, len, gate, sl, tr[i]);
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

/* The step sequencer (modules.ts seq): out is the current step all the time, gate follows the clock unless the step is a
 * rest (fully down, -1). A rising clock edge advances (fwd, back, pendulum, random), a rising reset edge goes to step 1. */
static void m_seq(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clock = it->in[SEQ_I_CLOCK], *reset = it->in[SEQ_I_RESET];
    esig_t *out = it->out[SEQ_O_OUT], *gate = it->out[SEQ_O_GATE];
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
        v = EF(it, SEQ_P_S1 + (pos < len ? pos : len - 1));
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
static void apply_cv(const node_t *nd, inst_t *it, uint32_t n)
{
    const def_t *d = &DEFS[nd->type];
    int32_t mean[2] = {0, 0}, extra[MAX_IN] = {0};
    uint32_t j, i, s, have = 0;
    if (d->cvbase >= 0)
        for (s = 0; s < 2u; s++) {
            const esig_t *cv;
            int64_t sum = 0;
            if (!(nd->conn & (1u << (d->cvbase + s))))
                continue;
            cv = it->in[d->cvbase + s];
            for (i = 0; i < n; i++)
                sum += cv[i];
            mean[s] = mul16(block_mean(sum, n), nd->att[s]);
            have |= 1u << s;
        }
    for (s = 0; s < d->nin; s++) if (nd->input_map[s]) {
        int64_t sum = 0;
        for (i = 0; i < n; i++) sum += it->in[s][i];
        extra[s] = block_mean(sum, n);
    }
    for (j = 0; j < d->npar; j++) {
        int32_t v = E.has_b && E.morph > 0 && nd->type != T_FM1 ? morph_of(d, j, nd->par[j], nd->parb[j], E.morph) : nd->par[j];
        uint32_t touched = 0;
        int32_t mod = 0, rv = 0;
        const range_t *rg = 0;
        for (s = 0; s < 2u; s++)
            if ((have >> s & 1u) && (nd->map[s] >> j & 1u)) {
                if (nd->ranged[s] >> j & 1u) {   /* a macro range: the input's value lands between its ends (replacing the base) */
                    const range_t *r = range_find((uint32_t)(nd - E.node), s, j);
                    if (r) {
                        rg = r;
                        rv += mean[s];
                        continue;
                    }
                }
                mod += mean[s];
                touched = 1;
            }
        for (s = 0; s < d->nin; s++) if (nd->input_map[s] >> j & 1u) {
            mod += extra[s];
            touched = 1;
        }
        if (rg) {
            int32_t lo = (int32_t)rg->lo * 257, hi = (int32_t)rg->hi * 257;   /* 0..255 -> Q16 0..1 */
            v = morph_value(d, j, lo + mul16(clampi(rv, 0, ENG_ONE), hi - lo));
        }
        if (!touched)
            it->eff[j] = v;
        else if (d->plog && d->plog[j])
            it->eff[j] = value_of(d, j, unit_of(d, j, v) + mod);            /* in octaves */
        else
            it->eff[j] = clampi(v + mul16(mod, d->pmax[j] - d->pmin[j]), d->pmin[j], d->pmax[j]);
    }
}

/* a part's flaws on its copy's effective parameters (engine.ts applyFlaws): bright x 2^(st / 12) on the filter / ladder
 * cutoff, env x (100 + %) / 100 on the ADSR / envelope times, level x % / 100 on the VCA gain; clamped to the range */
static void flaw_scale(const def_t *d, inst_t *it, uint32_t j, int64_t k_q16)
{
    if (k_q16 != ENG_ONE)
        it->eff[j] = clampi((int32_t)(((int64_t)it->eff[j] * k_q16) >> 16), d->pmin[j], d->pmax[j]);
}
static void apply_flaws(const node_t *nd, inst_t *it)
{
    const def_t *d = &DEFS[nd->type];
    int32_t b = cur_g->bright[cur_v], e = cur_g->env[cur_v], l = cur_g->level[cur_v];
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
        if (o == dummy_out)
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
    case T_RANDOM: m_random(nd, it, n); break;
    case T_OSC: m_osc(nd, it, n); break;
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
    case T_STRING: m_string(nd, it, n); break;
    case T_WAVETABLE: m_wavetable(nd, it, n); break;
    case T_CHORUS: m_chorus(nd, it, n); break;
    case T_SEQ: m_seq(nd, it, n); break;
    case T_STEPS: m_steps(nd, it, n); break;
    case T_DRUMMAP: m_drummap(nd, it, n); break;
    case T_CLKDIV: m_clkdiv(nd, it, n); break;
    case T_SH: m_sh(nd, it, n); break;
    case T_QUANT: m_quant(nd, it, n); break;
    case T_PULSE: m_pulse(nd, it, n); break;
    case T_PAN: m_pan(nd, it, n); break;
    case T_XFADE: m_xfade(nd, it, n); break;
    case T_VOWEL: m_vowel(nd, it, n); break;
    case T_PHASER: m_phaser(nd, it, n); break;
    case T_LADDER: m_ladder(nd, it, n); break;
    case T_DYN: m_dyn(nd, it, n); break;
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

#define cur_g_parts(nd) ((uint32_t)E.grp[(nd)->grp].parts)

/* Idle parts (engine.ts partIdle, the same rule): a part of a poly group whose gate is low, whose envelopes (ADSR / level
 * envelope, at least one) have all finished, and whose outputs that leave the group stayed within IDLE_Q16 for a whole block
 * is idle: those outputs are set to 0 and its modules are skipped until a note reaches it, except every IDLE_CHECK-th block,
 * which runs it and checks again (a part that sounds without its envelopes, a knob opening a drone, comes back). */
#define IDLE_Q16 6
#define IDLE_CHECK 32u
static int part_quiet(uint32_t k, uint32_t v)
{
    uint32_t i, c, envs = 0;
    for (i = 0; i < E.nmod; i++) {
        const node_t *nd = &E.node[i];
        const inst_t *it;
        if (nd->grp != k || (nd->type != T_ADSR && nd->type != T_ENV))
            continue;
        it = &inst_pool[nd->inst0 + v];
        if (nd->type == T_ADSR ? it->s.adsr.stage != 0 : it->s.env.stage != 0)
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


static void render_voice(int32_t *left, int32_t *right, uint32_t total)   /* the patch, clamped */
{
    uint32_t off, i, k, s, v;
    for (i = 0; i < total; i++)
        left[i] = right[i] = 0;
    if (!E.loaded)
        return;
    for (off = 0; off < total; off += ENG_BLOCK) {
        uint32_t n = total - off < ENG_BLOCK ? total - off : ENG_BLOCK;
        ENG_PROF(4, 0, 0);
        E.morph = E.has_b ? morph_position(n) : 0;
        {   /* the clock: MIDI ticks while external, else the Main module's tempo (whole bpm x 24 ticks a minute) */
            uint32_t bpm = E.main >= 0 ? (uint32_t)clampi((E.node[E.main].par[FM1_P_TEMPO] + 32768) >> 16, 20, 300) : TEMPO_DEFAULT, seen = 0, t;
            uint8_t run = transport_on;
            if (run && !E.running)
                E.tick_acc = 0;                  /* the transport starts: the tempo's ticks from here */
            E.running = run;
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
                    E.tick_n++;
                    seen = 1;
                }
            }
            if (!run)
                E.tick_off = -1;
            E.clk_seen = t;
            E.clk_pulse = seen && run ? (n + 1u) / 2u : 0u;   /* the Main clock: half a block per block that saw a tick while running */
            steps_keys();
            {                                    /* the keys played into tracks since the last block (eng_note_on) */
                uint8_t q = thru_tail;
                for (E.nthru = 0; q != thru_head && E.nthru < ENG_THRU; q++, E.nthru++) {
                    E.blk_thru[E.nthru][0] = thru_ring[q % ENG_THRU][0];
                    E.blk_thru[E.nthru][1] = thru_ring[q % ENG_THRU][1];
                    E.blk_thru[E.nthru][2] = thru_ring[q % ENG_THRU][2];
                }
                thru_tail = q;
            }
            for (k = 0; k < E.narp; k++)
                arp_block(&E.arp[k], n, bpm);
        }
        for (k = 1; k <= E.ngrp; k++) {                 /* the parts' pitch flaws: detune + drift (engine.ts render) */
            const grp_t *g = &E.grp[k];
            for (v = 0; v < g->parts; v++) {
                pv_t *x = &E.pv[g->pv0 + v];
                walk_step(&x->dw, DRIFT_HOLD);           /* every block, so the wander does not depend on the amount */
                x->flaw = (int32_t)g->detune[v] * 65536 / 1200 + (int32_t)(((int64_t)x->dw.y * g->drift[v] * 1092) / 3276800);
            }
        }
        for (k = 1; k <= E.ngrp; k++) {                 /* idle parts: woken by a note, else run every IDLE_CHECK-th block */
            const grp_t *g = &E.grp[k];
            for (v = 0; v < g->parts; v++) {
                pv_t *x = &E.pv[g->pv0 + v];
                if (x->idle && (x->gate || x->retrig))
                    x->idle = 0;
                x->skip = x->idle && ++x->idle_n % IDLE_CHECK != 0u;
            }
        }
        for (k = 0; k < E.norder; k++) {
            const node_t *nd = &E.node[E.order[k]];
            uint32_t ninst = nd->grp && cur_g_parts(nd) < nd->ninst ? cur_g_parts(nd) : nd->ninst;   /* (fewer after an overload: eng_shed) */
            cur_g = &E.grp[nd->grp];
            for (v = 0; v < ninst; v++) {               /* every part of a module in a poly group, once for the rest */
                inst_t *it = &inst_pool[nd->inst0 + v];
                cur_v = v;
                cur_pv = &E.pv[cur_g->pv0 + v];
                if (nd->grp && cur_pv->skip)
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
                    {
                        const esig_t *a = E.sum_src[sm->first];   /* the first source copied, the rest added: one pass less */
                        const int32_t w = E.sum_w[sm->first];
                        if (w)
                            for (i = 0; i < n; i++)
                                dst[i] = mul16(a[i], w);
                        else
                            for (i = 0; i < n; i++)
                                dst[i] = a[i];
                    }
                    for (q = 1; q < sm->n; q++) {
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
                apply_cv(nd, it, n);
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
        }
        if (n == ENG_BLOCK)
            for (k = 1; k <= E.ngrp; k++) {             /* a released part that has gone quiet goes idle (part_quiet) */
                const grp_t *g = &E.grp[k];
                for (v = 0; v < g->parts; v++) {
                    pv_t *x = &E.pv[g->pv0 + v];
                    if (x->skip)
                        continue;
                    if (!x->gate && !x->retrig && part_quiet(k, v)) {
                        if (!x->idle)
                            x->idle_n = 0;
                        x->idle = 1;
                        part_silence(k, v);
                    } else
                        x->idle = 0;
                }
            }
        for (k = 0; k < ENG_NPV; k++)                   /* a retrig lasts one block (every Main / Part module saw it) */
            E.pv[k].retrig = 0;
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
