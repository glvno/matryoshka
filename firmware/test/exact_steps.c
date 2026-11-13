/* SPDX-License-Identifier: GPL-3.0-only */
/* tools/engine_exact.sh: the Steps module's stopped pass (m_steps skips its per-sample loop while a stopped, internally
 * clocked track has nothing to do) against the engine it replaces. Compile against old/new engine.c via -I; compare
 * stdout: every output that is cabled, the whole track state and the key events after every block.
 *   1. m_steps alone: mostly stopped blocks, with the ways out of them mixed in (the transport starting, keys played
 *      through, panel hits, a swung step pending, a cabled reset, an external clock, ticks landing, parameter and tempo
 *      changes, notes still counting down, partial blocks, unconnected outputs and transpose).
 *   2. every factory patch of presets.h through eng_render: stopped idle, keys, hits, a pattern played with swing and
 *      stopped mid-step, tempo and parameter changes, the external clock, partial renders and a reload.
 * stderr counts the blocks of part 1 that could take the stopped pass (coverage; not compared). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "engine.c"
#include "../src/presets.h"                  /* (the working tree's, for both engines, as exact_factory.c) */

static void emit(const void *p, size_t n)
{
    if (fwrite(p, 1, n, stdout) != n) exit(2);
}

static void emit_track(const inst_t *it, uint32_t t)
{
    uint32_t j;
    int32_t state[] = {it->s.stp.c1, it->s.stp.r1, it->s.stp.since, it->s.stp.period, it->s.stp.half,
        it->s.stp.pend, it->s.stp.slen, it->s.stp.sst, it->s.stp.pitch, it->s.stp.vel, it->s.stp.count,
        it->s.stp.pos, it->s.stp.pstep, it->s.stp.skip, it->s.stp.run, it->s.stp.gap, it->s.stp.mute,
        it->s.stp.hit, it->s.stp.skipn, it->s.stp.visit, (int32_t)it->s.stp.loop, (int32_t)it->s.stp.seed,
        E.trk_nsnd[t], E.trk_pat[t], E.trk_q[t], E.trk_spos[t], E.trk_last[t], E.trk_once[t], E.nkev, E.nrin};
    emit(state, sizeof state);
    for (j = 0; j < E.trk_nsnd[t]; j++) {
        const snd_t *s = &E.trk_snd[t][j];
        int32_t x[] = {s->key, s->left, s->thru, s->dr, s->cnt};
        emit(x, sizeof x);
    }
    for (j = 0; j < E.nrin; j++) {
        int32_t x[] = {E.rin[j].trk, E.rin[j].t};
        emit(x, sizeof x);
    }
    emit(E.kev, E.nkev * sizeof E.kev[0]);
}

static uint32_t eligible, blocks;

static void alone(uint32_t trial)
{
    static const uint32_t lengths[] = {128, 128, 128, 1, 7, 65, 127, 0};
    static uint8_t events[4096][3];
    esig_t clock[ENG_BLOCK], reset[ENG_BLOCK], transpose[ENG_BLOCK], output[STEPS_NOUT][ENG_BLOCK];
    int32_t params[STEPS_NPAR];
    inst_t it = {0};
    node_t node = {0};
    uint32_t b, i, j, seed = 0x5eed0000u + trial * 7919u;
    int running = 0, ext = 0;
    memset(&E, 0, sizeof E);
    E.node = &node; E.nmod = 1; E.ntrk = 1; E.kev = events;
    E.blk_thru = E.blk_legacy; E.rin = E.rin_legacy; E.tick_len = 8 + (int32_t)trial * 5;
    E.trk_q[0] = 0xFFu; E.pat_has[0] = 1;
    E.pat_n[0][0] = trial % 3u ? 5 : 0;              /* (an empty track too, as the factory patches' PATTERN) */
    E.trk_note[0] = NW(0, 1, 60, 100, 0);
    E.trk_note[1] = NW(1, 2, 64, 110, 0);
    E.trk_note[2] = NW(4, 1, 67, 80, 0);
    E.trk_note[3] = NW(6, 3, 71, 90, 0);
    E.trk_note[4] = NW(15, 4, 72, 100, 0) | ENG_NOTE_WRAP;
    node.type = T_STEPS; node.trk = 0;
    it.eff = params; it.s.stp.pos = it.s.stp.skip = -1; it.s.stp.since = -1;
    it.s.stp.seed = 0x71625431u ^ trial;
    memcpy(params, STEPS_DEF, sizeof params);
    for (i = 0; i < STEPS_NOUT; i++)                 /* some trials leave outputs unconnected (dummy_out: not compared) */
        it.out[i] = (trial >> i) & 1u && trial >= 8u ? dummy_out : output[i];
    for (b = 0; b < 1200; b++) {
        uint32_t n = lengths[(seed >> 8) % 8u], ev;
        seed = lcg(seed);
        ev = (seed >> 16) % 40u;                     /* most blocks change nothing: the track stays as it is */
        if (running ? ev < 5 : ev == 0) running = !running;   /* the transport starts / stops (a start steps at once) */
        if (ext ? ev < 4 || ev == 39 : ev == 1 && seed % 3u == 0) ext = !ext;   /* an external clock cabled / taken away */
        node.conn = ext ? 1u << STEPS_I_CLK : 0;
        if (ev == 2 || ev == 3) node.conn |= 1u << STEPS_I_RESET;   /* a cabled reset: an edge (2), held low (3) */
        it.in[STEPS_I_CLK] = ext ? clock : zero_buf;
        it.in[STEPS_I_RESET] = node.conn & (1u << STEPS_I_RESET) ? reset : zero_buf;
        it.in[STEPS_I_TRANSPOSE] = (trial + b / 50u) & 1u ? transpose : zero_buf;
        E.running = (uint8_t)running;
        /* where the block's tick falls: none while stopped (render_voice), else anywhere; now and then one while stopped */
        E.tick_off = !running && ev != 4 ? -1 : (int32_t)((seed >> 4) % (n + 2u)) - 1;
        E.tick_n = 1 + (ev == 5);
        E.nkev = 0;
        if (ev == 6) params[STEPS_P_DIR] = (int32_t)((seed >> 3) % 4u) << 16;
        if (ev == 7) params[STEPS_P_SWING] = (int32_t)(50u + (seed >> 5) % 30u) << 16;
        if (ev == 8) params[STEPS_P_GATE] = (int32_t)((seed >> 6) % 65536u);
        if (ev == 9) params[STEPS_P_RATE] = (int32_t)((seed >> 7) % 9u) << 16;
        if (ev == 10) params[STEPS_P_LEN] = (int32_t)(1u + (seed >> 9) % 16u) << 16;
        if (ev == 11) E.tick_len = 5 + (int32_t)((seed >> 10) % 40u);   /* the tempo moved */
        if (ev == 12 && E.trk_nsnd[0] == 0) {        /* notes left counting down (thru and timed) */
            E.trk_nsnd[0] = 1u + (seed >> 11) % TRACK_POLY;
            for (j = 0; j < E.trk_nsnd[0]; j++) {
                snd_t *s = &E.trk_snd[0][j];
                s->key = (uint8_t)(48u + j); s->left = (int32_t)(j & 1u); s->dr = 0;
                s->thru = 0;
                s->cnt = j % 4u == 0 ? 0 : (int32_t)(1u + j * 37u + (seed >> 20) % 300u);
            }
        }
        E.nthru = ev == 13 || ev == 14 ? 1 : 0;      /* a key played through: on (13) / off (14) */
        if (E.nthru) {
            E.blk_thru[0][0] = 0; E.blk_thru[0][1] = (uint8_t)(60u | (ev == 13 ? 0x80u : 0));
            E.blk_thru[0][2] = 100;
        }
        if (ev == 15) it.s.stp.hit = (uint8_t)(1u + (seed & 1u));   /* a panel hit */
        if (ev == 16) { it.s.stp.pend = 1 + (int32_t)((seed >> 12) % 300u); it.s.stp.pstep = 1; }   /* a swung step due */
        if (ev == 17) it.s.stp.gap = 1;
        if (ev == 18) it.s.stp.mute = !it.s.stp.mute;
        if (ev == 20 || ev == 21) E.trk_nsnd[0] = 0;   /* every note let go (a thru key's off, an all-notes-off) */
        if (ev == 19 && E.nrin < 4u) { E.rin[E.nrin].trk = 0; E.rin[E.nrin].t = 3; E.nrin++; }
        for (i = 0; i < ENG_BLOCK; i++) {
            clock[i] = (i + b) % 8u < 4u ? ENG_ONE : 0;
            reset[i] = ev == 2 && i == (b % 5u) * 20u ? ENG_ONE : 0;
            transpose[i] = (int32_t)((i + b) % 13u) * 5461 - 32768;
        }
        blocks++;
        eligible += !ext && !E.running && (E.tick_off < 0 || (uint32_t)E.tick_off >= n) && !it.s.stp.hit &&
                    it.s.stp.pend <= 0 && !E.trk_nsnd[0] && it.in[STEPS_I_RESET] == zero_buf;
        m_steps(&node, &it, n);
        for (i = 0; i < STEPS_NOUT; i++)
            if (!IS_DUMMY(it.out[i])) emit(output[i], n * sizeof output[i][0]);
        emit_track(&it, 0);
    }
}

static void dump_tracks(void)
{
    uint32_t m;
    for (m = 0; m < E.nmod; m++)
        if (E.node[m].type == T_STEPS) emit_track(&inst_pool[E.node[m].inst0], E.node[m].trk);
}

static void render(uint32_t total)
{
    static int32_t l[3 * ENG_BLOCK], r[3 * ENG_BLOCK];
    eng_render(l, r, total);
    emit(l, total * sizeof l[0]);
    emit(r, total * sizeof r[0]);
    dump_tracks();
}

static void patches(void)
{
    static const uint32_t partial[] = {128, 128, 77, 128, 200, 1, 128, 256};
    uint32_t t, b, m;
    for (t = 0; t < N_PRESETS; t++) {
        int trk = -1;
        if (eng_load(PRESET_LIST[t].data, PRESET_LIST[t].len)) { printf("%2u load failed\n", t); continue; }
        for (m = 0; m < (uint32_t)eng_nmodules(); m++)
            if (eng_type(m) == T_STEPS) { trk = (int)m; break; }
        eng_transport(0);
        eng_clock_external(0);
        eng_tempo_global(0);
        for (b = 0; b < 420; b++) {
            if (b == 30) eng_note_on(60, 52000, 1);          /* keys through the track while stopped */
            if (b == 34) eng_note_on(64, 40000, 1);
            if (b == 50) eng_note_off(60, 1);
            if (b == 51) eng_note_off(64, 1);
            if (trk >= 0) {
                if (b == 70) eng_steps_hit((uint32_t)trk, 0, 0);           /* panel hits while stopped */
                if (b == 75) eng_steps_hit((uint32_t)trk, 1, 1);
                if (b == 90) {                                             /* a pattern with swing */
                    eng_steps_set((uint32_t)trk, 0, 1); eng_steps_set((uint32_t)trk, 3, 3); eng_steps_set((uint32_t)trk, 5, 1);
                    eng_set_param((uint32_t)trk, STEPS_P_SWING, 72 << 16);
                    eng_set_param((uint32_t)trk, STEPS_P_RATE, 6 << 16);
                }
                if (b == 160) eng_set_param((uint32_t)trk, STEPS_P_GATE, 50000);
                if (b == 170) eng_set_param((uint32_t)trk, STEPS_P_DIR, 3 << 16);
                if (b == 240) eng_set_param((uint32_t)trk, STEPS_P_LEN, 5 << 16);
            }
            if (b == 100) eng_transport(1);
            if (b == 133) eng_transport(0);                  /* stopped mid-step, a swung step may be pending */
            if (b == 150) eng_transport(1);
            if (b == 151) eng_transport(0);
            if (b == 180) eng_tempo_global(137);             /* tempo while stopped */
            if (b == 200) eng_clock_external(1);             /* an external clock: ticks with the transport off, then on */
            if (b >= 200 && b < 260 && b % 3u == 0) eng_clock_tick();
            if (b == 215) eng_transport(1);
            if (b == 245) eng_transport(0);
            if (b == 260) eng_clock_external(0);
            if (b == 280) eng_note_on(67, 60000, 1);
            if (b == 281) eng_transport(1);
            if (b == 300) eng_note_off(67, 1);
            if (b == 301) eng_transport(0);
            if (b == 330) {                                  /* the patch loaded again, stopped */
                if (eng_load(PRESET_LIST[t].data, PRESET_LIST[t].len)) { printf("%2u reload failed\n", t); break; }
            }
            render(partial[b % 8u]);
        }
    }
}

int main(void)
{
    uint32_t i;
    for (i = 0; i < 40; i++) alone(i);
    fprintf(stderr, "exact_steps: %u of %u m_steps blocks could take the stopped pass\n", eligible, blocks);
    patches();
    return ferror(stdout) ? 2 : 0;
}
