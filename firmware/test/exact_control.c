/* SPDX-License-Identifier: GPL-3.0-only */
/* Compile against old/new engine.c via -I; compare stdout. Real quantizer outputs and Steps
 * gate/pitch/velocity, clock state, held notes and emitted key events; no padding or pointers. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "engine.c"

static void emit(const void *p, size_t n)
{
    if (fwrite(p, 1, n, stdout) != n) exit(2);
}

static void quantizer(void)
{
    static const uint32_t lengths[] = {0, 1, 7, 65, 127, 128};
    static const int32_t edges[] = {INT32_MIN, -(1 << 27), -65537, -65536, -32769, -32768, -1,
                                    0, 1, 32767, 32768, 65535, 65536, (1 << 27), INT32_MAX};
    node_t node = {0};
    inst_t it = {0};
    esig_t input[ENG_BLOCK], output[ENG_BLOCK];
    int32_t params[QUANT_NPAR] = {0};
    uint32_t b, i, seed = 0x81274315u;
    it.in[QUANT_I_IN] = input; it.out[0] = output; it.eff = params;
    for (b = 0; b < N_SCALES * 12u * 64u; b++) {
        uint32_t n = lengths[b % 6u];
        params[QUANT_P_SCALE] = (int32_t)(b % N_SCALES) << 16;
        params[QUANT_P_ROOT] = (int32_t)((b / N_SCALES) % 12u) << 16;
        for (i = 0; i < ENG_BLOCK; i++) {
            seed = lcg(seed);
            input[i] = b % 3u == 0 ? edges[(b / 3u) % 15u] : b % 3u == 1 && i % 7u ? input[i - 1u]
                : b % 2u ? edges[(b + i) % 15u] : (int32_t)seed;
        }
        m_quant(&node, &it, n);
        emit(output, n * sizeof output[0]);
    }
}

static void sequencer(uint32_t trial)
{
    static const uint32_t lengths[] = {0, 1, 7, 65, 127, 128};
    static uint8_t events[4096][3];
    esig_t clock[ENG_BLOCK], reset[ENG_BLOCK], transpose[ENG_BLOCK], output[4][ENG_BLOCK];
    int32_t params[STEPS_NPAR];
    inst_t it = {0};
    node_t node = {0};
    uint32_t b, i, j;
    memset(&E, 0, sizeof E);
    E.node = &node; E.nmod = 1; E.ntrk = 1; E.kev = events;
    E.blk_thru = E.blk_legacy; E.rin = E.rin_legacy; E.tick_len = 8 + (int32_t)trial * 3;
    E.trk_q[0] = 0xFFu; E.pat_has[0] = 1;
    E.pat_n[0][0] = trial & 1u ? 4 : 0;
    E.trk_note[0] = NW(0, 1, 60, 100, 0);
    E.trk_note[1] = NW(1, 2, 64, 110, 0);
    E.trk_note[2] = NW(4, 1, 67, 80, 0);
    E.trk_note[3] = NW(15, 4, 72, 100, 0) | ENG_NOTE_WRAP;
    node.type = T_STEPS; node.trk = 0;
    it.eff = params; it.s.stp.pos = it.s.stp.skip = -1; it.s.stp.since = -1;
    it.s.stp.seed = 0x71625431u;
    memcpy(params, STEPS_DEF, sizeof params);
    for (i = 0; i < STEPS_NOUT; i++) it.out[i] = output[i];
    it.in[STEPS_I_TRANSPOSE] = transpose;
    for (b = 0; b < 256; b++) {
        uint32_t n = lengths[b % 6u];
        int external = (trial + b / 32u) & 1u;
        node.conn = external ? 1u << STEPS_I_CLK : 0;
        if (b % 13u == 0) node.conn |= 1u << STEPS_I_RESET;
        it.in[STEPS_I_CLK] = external ? clock : zero_buf;
        it.in[STEPS_I_RESET] = node.conn & (1u << STEPS_I_RESET) ? reset : zero_buf;
        E.running = b % 19u != 0;
        E.tick_off = b % 4u == 0 ? -1 : b % 4u == 1 ? 0 : b % 4u == 2 ? (int32_t)n - 1 : (int32_t)n;
        E.tick_n = 1 + (b % 17u == 0); E.nkev = 0;
        params[STEPS_P_DIR] = (int32_t)((b / 64u) % 4u) << 16;
        params[STEPS_P_SWING] = (b & 8u ? 70 : 50) << 16;
        if (b % 17u == 0) {
            E.trk_nsnd[0] = TRACK_POLY;
            for (j = 0; j < TRACK_POLY; j++) {
                snd_t *s = &E.trk_snd[0][j];
                s->key = (uint8_t)(48u + j); s->left = 0; s->dr = 0;
                s->thru = b & 16u ? (uint8_t)(49u + j) : j & 1u ? (uint8_t)(49u + j) : 0;
                s->cnt = j % 4u == 0 ? 0 : (int32_t)(1u + j * 8u);
            }
        }
        E.nthru = b % 11u == 0 ? 1 : 0;
        if (E.nthru) {
            E.blk_thru[0][0] = 0; E.blk_thru[0][1] = (uint8_t)(60u | (b & 1u ? 0x80u : 0));
            E.blk_thru[0][2] = 100;
        }
        if (b % 23u == 0) it.s.stp.hit = (uint8_t)(1u + (b & 1u));
        if (b % 29u == 0) { it.s.stp.pend = 3; it.s.stp.pstep = 1; }
        for (i = 0; i < ENG_BLOCK; i++) {
            clock[i] = i % 8u < 4u ? ENG_ONE : 0;
            reset[i] = i == 3u ? ENG_ONE : 0;
            transpose[i] = (int32_t)((i + b) % 13u) * 5461 - 32768;
        }
        m_steps(&node, &it, n);
        for (i = 0; i < STEPS_NOUT; i++) emit(output[i], n * sizeof output[i][0]);
        {
            int32_t state[] = {it.s.stp.c1, it.s.stp.r1, it.s.stp.since, it.s.stp.period, it.s.stp.half,
                it.s.stp.pend, it.s.stp.slen, it.s.stp.sst, it.s.stp.pitch, it.s.stp.vel, it.s.stp.count,
                it.s.stp.pos, it.s.stp.pstep, it.s.stp.skip, it.s.stp.run, it.s.stp.gap, it.s.stp.mute,
                it.s.stp.hit, it.s.stp.skipn, it.s.stp.visit, (int32_t)it.s.stp.loop, E.trk_nsnd[0], E.nkev};
            emit(state, sizeof state);
        }
        for (j = 0; j < E.trk_nsnd[0]; j++) {
            snd_t *s = &E.trk_snd[0][j];
            int32_t state[] = {s->key, s->left, s->thru, s->dr, s->cnt};
            emit(state, sizeof state);
        }
        emit(E.kev, E.nkev * sizeof E.kev[0]);
    }
}

int main(void)
{
    uint32_t i;
    quantizer();
    for (i = 0; i < 24; i++) sequencer(i);
    return ferror(stdout) ? 2 : 0;
}
