/* SPDX-License-Identifier: GPL-3.0-only */
/* The DX7 module's voice (firmware/src/dx7.h, #1338) on the host:
 * 1. The algorithms against the DX7's own: the OPS chip's algorithm ROM as Ken Shirriff read it from die photos
 *    ("Yamaha DX7 chip reverse-engineering, part 4", footnote 5), run as the chip runs it (every operator in turn, every
 *    sample, its selector, memory register and feedback register), must give dx7_core's output sample for sample, for
 *    all 32 algorithms and every feedback level. That checks algorithms 4 and 6's loops too, which msfa lacks.
 * 2. Unpacking: a packed voice made from msfa's form by the DX7's own packing unpacks to it again.
 * 3. A corpus (voices, notes, glides, cut renders, outside signals into operators) rendered through dx7_run, one hash per
 *    case, against firmware/test/dx7_hashes.h. web/src/dx7.test.ts renders the same corpus with the TypeScript port and
 *    checks the same hashes, so the two engines agree sample for sample. DX7_WRITE=1 rewrites the file.
 *   tools/dx7_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/dsp_tables.h"
#include "../src/dx7.h"
#include "dx7_hashes.h"

static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

/* ------------------------------------------------------------------ 1. the OPS chip's algorithm ROM */

/* "SEL / FREN MREN / COM", operators 6 .. 1 (the COM output scaling is not msfa's and is not checked) */
static const char *const ROM[32] = {
    "1/100/0 1/000/0 1/000/1 0/001/0 1/010/1 5/011/0", "1/000/0 1/000/0 1/000/1 5/001/0 1/110/1 0/011/0",
    "1/100/0 1/000/1 0/001/0 1/010/0 1/010/1 5/011/0", "1/000/0 1/000/1 0/101/0 1/010/0 1/010/1 5/011/0",
    "1/100/2 0/001/0 1/010/2 0/011/0 1/010/2 5/011/0", "1/000/2 0/101/0 1/010/2 0/011/0 1/010/2 5/011/0",
    "1/100/0 0/001/0 2/011/1 0/001/0 1/010/1 5/011/0", "1/000/0 5/001/0 2/111/1 0/001/0 1/010/1 0/011/0",
    "1/000/0 0/001/0 2/011/1 5/001/0 1/110/1 0/011/0", "0/001/0 2/011/1 5/001/0 1/110/0 1/010/1 0/011/0",
    "0/101/0 2/011/1 0/001/0 1/010/0 1/010/1 5/011/0", "0/001/0 0/011/0 2/011/1 5/001/0 1/110/1 0/011/0",
    "0/101/0 0/011/0 2/011/1 0/001/0 1/010/1 5/011/0", "0/101/0 2/011/0 1/000/1 0/001/0 1/010/1 5/011/0",
    "0/001/0 2/011/0 1/000/1 5/001/0 1/110/1 0/011/0", "1/100/0 0/001/0 1/010/0 0/011/0 2/011/0 5/001/0",
    "1/000/0 0/001/0 1/010/0 5/011/0 2/111/0 0/001/0", "1/000/0 1/000/0 5/001/0 0/111/0 2/011/0 0/001/0",
    "1/100/2 4/001/2 0/011/0 1/010/0 1/010/2 5/011/0", "0/001/0 2/011/2 5/001/0 1/110/2 4/011/2 0/011/0",
    "1/001/3 3/001/3 5/011/0 1/110/3 4/011/3 0/011/0", "1/100/3 4/001/3 4/011/3 0/011/0 1/010/3 5/011/0",
    "1/100/3 4/001/3 0/011/0 1/010/3 0/011/3 5/011/0", "1/100/4 4/001/4 4/011/4 0/011/4 0/011/4 5/011/0",
    "1/100/4 4/001/4 0/011/4 0/011/4 0/011/4 5/011/0", "0/101/0 2/011/2 0/001/0 1/010/2 0/011/2 5/011/0",
    "0/001/0 2/011/2 5/001/0 1/110/2 0/011/2 0/011/0", "5/001/0 1/110/0 1/010/2 0/011/0 1/010/2 0/011/2",
    "1/100/3 0/001/0 1/010/3 0/011/3 0/011/3 5/011/0", "5/001/0 1/110/0 1/010/3 0/011/3 0/011/3 0/011/3",
    "1/100/4 0/001/4 0/011/4 0/011/4 0/011/4 5/011/0", "0/101/5 0/011/5 0/011/5 0/011/5 0/011/5 5/011/5",
};

/* n samples of one voice as the chip computes them. Column k holds operator 6 - k's output y and sets up the next
 * operator's modulation (column 5: operator 6's, at the next sample). SEL 0 none, 1 y, 2 the memory register plus y,
 * 3 the memory register, 4 the feedback register's newest value, 5 the average of its two values scaled by the
 * feedback level (msfa's scale). FREN loads y into the feedback register; MREN (C D) 01 loads y into the memory
 * register, 11 adds y to it, else it holds. After operator 1 the memory register is the voice's output. g: the gains,
 * fixed. st: the modulation, the memory register and the feedback register's two values, kept across calls */
static void chip(int alg, int shift, const int32_t *freq, int32_t *phase, const int32_t *g, int32_t *st, int32_t *out,
                 int n)
{
    int i, k;
    for (i = 0; i < n; i++) {
        for (k = 0; k < 6; k++) {
            const char *e = ROM[alg] + 8 * k;
            int sel = e[0] - '0', a = e[2] - '0', c = e[3] - '0', d = e[4] - '0';
            int32_t y = (int32_t)(((int64_t)dx7_sin(phase[k] + st[0]) * g[k]) >> 24), m = st[1];
            phase[k] += freq[k];
            if (a) {
                st[2] = st[3];
                st[3] = y;
            }
            st[0] = sel == 1 ? y : sel == 2 ? m + y : sel == 3 ? m : sel == 4 ? st[3]
                  : sel == 5 && shift < 16 ? (st[2] + st[3]) >> (shift + 1) : 0;
            if (d)
                st[1] = c ? m + y : y;
        }
        out[i] = st[1];
    }
}

static uint32_t rs;
static int R(int n) { rs = rs * 1664525u + 1013904223u; return (int)((rs >> 8) % (uint32_t)(n + 1)); }

static void check_rom(void)
{
    int alg, fbl, t;
    for (alg = 0; alg < 32; alg++)
        for (fbl = 0; fbl < 8; fbl++)
            for (t = 0; t < 3; t++) {
                dx7_op_t p[6];
                int32_t freq[6], ph[6], g[6], st[4] = {0, 0, 0, 0}, fb[2] = {0, 0}, a[256], b[256], bus[2 * DX7_N];
                const int32_t *x[6] = {0, 0, 0, 0, 0, 0};
                int shift = fbl ? 8 - fbl : 16, k, i, bad = -1;
                rs = (uint32_t)(alg * 977 + fbl * 31 + t);
                for (k = 0; k < 6; k++) {
                    p[k].level_in = (13 << 24) + R(1 << 20) * 16;   /* gains well above the threshold */
                    g[k] = dx7_exp2(p[k].level_in - (14 << 24));
                    p[k].gain_out = g[k];
                    p[k].freq = freq[k] = 20000 + R(400000);
                    p[k].phase = ph[k] = R(1 << 23) * 2;
                }
                for (i = 0; i < 256; i += DX7_N) {
                    for (k = 0; k < DX7_N; k++)
                        a[i + k] = 0;
                    dx7_core(a + i, p, alg, fb, shift, bus, x, DX7_N);
                }
                chip(alg, shift, freq, ph, g, st, b, 256);
                for (i = 0; i < 256 && bad < 0; i++)
                    if (a[i] != b[i])
                        bad = i;
                CHECK(bad < 0, "algorithm %d feedback %d: sample %d dx7_core %d, the chip's ROM %d", alg + 1, fbl, bad,
                      bad < 0 ? 0 : a[bad], bad < 0 ? 0 : b[bad]);
            }
}

/* ------------------------------------------------------------------ 2. unpacking */

static void pack(const uint8_t *u, uint8_t *b)       /* msfa's form to the packed voice (the DX7's bulk format) */
{
    int op, i;
    for (op = 0; op < 6; op++) {
        const uint8_t *s = u + op * 21;
        uint8_t *d = b + op * 17;
        for (i = 0; i < 11; i++)
            d[i] = s[i];
        d[11] = (uint8_t)(s[11] | s[12] << 2);
        d[12] = (uint8_t)(s[13] | s[20] << 3);
        d[13] = (uint8_t)(s[14] | s[15] << 2);
        d[14] = s[16];
        d[15] = (uint8_t)(s[17] | s[18] << 1);
        d[16] = s[19];
    }
    for (i = 0; i < 9; i++)
        b[102 + i] = u[126 + i];
    b[111] = (uint8_t)(u[135] | u[136] << 3);
    for (i = 0; i < 4; i++)
        b[112 + i] = u[137 + i];
    b[116] = (uint8_t)(u[141] | u[142] << 1 | u[143] << 4);
    for (i = 0; i < 11; i++)
        b[117 + i] = u[144 + i];
}

/* a random voice in the DX7's ranges, msfa's form; alg -1: any */
static void random_voice(uint8_t *u, int alg)
{
    static const uint8_t top[21] = {99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14};
    int op, i;
    for (op = 0; op < 6; op++)
        for (i = 0; i < 21; i++)
            u[op * 21 + i] = (uint8_t)R(top[i]);
    for (op = 0; op < 6; op++) {                      /* voices that sound: envelopes that open, mild scaling */
        uint8_t *q = u + op * 21;
        for (i = 0; i < 4; i++)
            q[i] = (uint8_t)(30 + R(69));
        for (i = 4; i < 7; i++)
            q[i] = (uint8_t)(60 + R(39));
        q[7] = (uint8_t)(R(3) ? 0 : R(99));
        q[9] = (uint8_t)R(40);
        q[10] = (uint8_t)R(40);
        q[15] = (uint8_t)R(3);
        q[16] = (uint8_t)(75 + R(24));
        if (R(4))
            q[17] = 0;                                /* mostly ratios */
        q[18] = (uint8_t)R(op < 2 ? 3 : 8);
    }
    for (i = 126; i < 134; i++)
        u[i] = (uint8_t)R(99);
    for (i = 130; i < 134; i++)
        u[i] = (uint8_t)(40 + R(20));                 /* pitch levels near 50 */
    u[134] = (uint8_t)(alg < 0 ? R(31) : alg);
    u[135] = (uint8_t)R(7);
    u[136] = (uint8_t)R(1);
    for (i = 137; i < 141; i++)
        u[i] = (uint8_t)R(99);
    u[141] = (uint8_t)R(1);
    u[142] = (uint8_t)R(5);
    u[143] = (uint8_t)R(7);
    u[144] = (uint8_t)(12 + R(24));
    for (i = 145; i < 155; i++)
        u[i] = (uint8_t)('A' + R(25));
    u[155] = 0x3f;
}

static void check_unpack(void)
{
    int t, i;
    for (t = 0; t < 200; t++) {
        uint8_t u[DX7_UNPACKED], b[DX7_VOICE], v[DX7_UNPACKED];
        rs = (uint32_t)(5000 + t);
        random_voice(u, -1);
        pack(u, b);
        dx7_unpack(b, v);
        for (i = 0; i < DX7_UNPACKED && u[i] == v[i]; i++)
            ;
        CHECK(i == DX7_UNPACKED, "voice %d: byte %d unpacks to %d, not %d", t, i, v[i], u[i]);
    }
}

/* ------------------------------------------------------------------ 3. the corpus (web/src/dx7.test.ts: the same) */

/* the DX7's init voice, packed: algorithm 1, operator 1 at 99, the others at 0, every envelope 99 99 99 99 / 99 99 99 0 */
static void init_voice(uint8_t *b)
{
    int op, i;
    memset(b, 0, DX7_VOICE);
    for (op = 0; op < 6; op++) {
        uint8_t *d = b + op * 17;
        for (i = 0; i < 4; i++)
            d[i] = 99;
        d[4] = d[5] = d[6] = 99;
        d[8] = 39;                                    /* break point C3 */
        d[14] = op == 5 ? 99 : 0;                     /* operator 1 (the last) at 99 */
        d[15] = 1 << 1;                               /* coarse 1 */
        d[12] = 7 << 3;                               /* detune 0 */
    }
    for (i = 102; i < 106; i++)
        b[i] = 99;
    for (i = 106; i < 110; i++)
        b[i] = 50;
    b[111] = 1 << 3;                                  /* oscillator key sync */
    b[112] = 35;
    b[116] = 3 << 4 | 0 << 1 | 1;                     /* PMS 3, triangle, LFO sync */
    b[117] = 24;
    memcpy(b + 118, "INIT VOICE", 10);
}

#define CORPUS_CASES 48
#define CORPUS_LEN 26470                              /* 0.6 s */

/* an outside signal at the engine's sample g */
static int32_t ext_sig(int kind, uint32_t g)
{
    return kind ? (((g >> 5) & 1u) ? 40000 : -40000) : (int32_t)((g * 1500u) & 0x1FFFFu) - 65536;
}

static uint32_t corpus_case(int c, int32_t *peak)
{
    static dx7_t s;
    uint8_t u[DX7_UNPACKED], pk[DX7_VOICE];
    int32_t gate[128], pitch[128], vel[128], xs[6][128], out[128];
    int xk[6], j, on, off, re, p0, vl;
    uint32_t h = 2166136261u, t = 0;
    dx7_io_t io;
    rs = 0x9E3779B9u ^ (uint32_t)(c * 7919);
    if (c == 0)
        init_voice(pk);
    else {
        random_voice(u, c % 32);
        pack(u, pk);
    }
    memset(&s, 0, sizeof s);
    dx7_init(&s, pk);
    memset(&io, 0, sizeof io);
    io.level = 32768 + R(32768);
    io.tune = (R(200) - 100) * 65536;
    io.mod = R(65536);
    io.range = R(99) * 65536;
    io.dest = R(6) * 65536;
    io.ops = (R(3) == 0 ? R(63) | 1 : 63) * 65536;   /* (operator 1, a carrier in every algorithm, stays on) */
    for (j = 0; j < 6; j++)
        xk[j] = c >= 32 && R(3) == 0 ? R(1) : -1;
    on = R(500);
    off = on + 8000 + R(4000);
    re = off + 3000 + R(2000);                        /* a second note */
    p0 = ((R(48) - 24) * 65536) / 12;
    vl = R(65536);
    io.gate = gate;
    io.pitch = pitch;
    io.vel = c % 5 == 4 ? 0 : vel;
    while (t < CORPUS_LEN) {
        unsigned n = c & 1 ? 1u + (unsigned)R(127) : 128u, i;
        if (t + n > CORPUS_LEN)
            n = CORPUS_LEN - t;
        for (i = 0; i < n; i++) {
            int32_t g = (int32_t)(t + i);
            gate[i] = (g >= on && g < off) || g >= re ? 65536 : 0;
            pitch[i] = p0 + (g >= on + 3000 ? 2 * 65536 / 12 : 0) + (g >= re ? 7 * 65536 / 12 : 0);
            vel[i] = g >= re ? 65536 - vl : vl;
            for (j = 0; j < 6; j++)
                xs[j][i] = xk[j] >= 0 ? ext_sig(xk[j], (uint32_t)g) : 0;
        }
        for (j = 0; j < 6; j++)
            io.x[j] = xk[j] >= 0 ? xs[j] : 0;
        io.t = t;
        dx7_run(&s, &io, out, n);
        for (i = 0; i < n; i++) {
            h = (h ^ (uint32_t)out[i]) * 16777619u;
            if (out[i] > *peak)
                *peak = out[i];
        }
        t += n;
    }
    return h;
}

int main(void)
{
    uint32_t got[CORPUS_CASES];
    int c, write = getenv("DX7_WRITE") != 0;
    check_rom();
    check_unpack();
    for (c = 0; c < CORPUS_CASES; c++) {
        int32_t peak = 0;
        got[c] = corpus_case(c, &peak);
        CHECK(peak > 300, "corpus case %d is silent (peak %d)", c, peak);
    }
    if (write) {
        FILE *f = fopen("firmware/test/dx7_hashes.h", "w");
        if (!f)
            return 2;
        fprintf(f, "/* SPDX-License-Identifier: GPL-3.0-only */\n/* Generated by DX7_WRITE=1 tools/dx7_test.sh: the DX7 corpus's"
                   " hash per case (dx7_test.c, web/src/dx7.test.ts). */\n#define DX7_HASHES {");
        for (c = 0; c < CORPUS_CASES; c++)
            fprintf(f, "%s0x%08xu", c ? ", " : "", got[c]);
        fprintf(f, "}\n");
        fclose(f);
        printf("wrote firmware/test/dx7_hashes.h\n");
    } else {
        static const uint32_t want[] = DX7_HASHES;
        CHECK(sizeof want / sizeof want[0] == CORPUS_CASES, "dx7_hashes.h has %d cases", (int)(sizeof want / sizeof want[0]));
        for (c = 0; c < CORPUS_CASES; c++)
            CHECK(got[c] == want[c], "corpus case %d: hash 0x%08x, dx7_hashes.h 0x%08x", c, got[c], want[c]);
    }
    printf("dx7_test: %s\n", fails ? "FAILED" : "ok");
    return fails != 0;
}
