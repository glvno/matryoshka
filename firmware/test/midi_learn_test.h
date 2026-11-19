/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* #1067, part of midi_redraw_test.c: MIDI learn on the FM-1 (firmware/src/midi_learn.c) through the real MIDI queue and
 * dispatcher. A mapping in the running patch's binary moves a row on a page that is not in focus, over its ramp slot,
 * between its ends, and takes its CC from its fixed job; the editor hears the move at once, then at most every 25 ms; the
 * MIDI channel holds for it; pitch bend's centre is the row's middle; a learn picks a row with a knob and takes the first
 * control to send three different values. Needs a patch with at least two pages loaded (pv_bin). */

static void ml_cc(uint32_t ch, uint32_t n, uint32_t v)
{
    midi_enqueue(0x0Bu | (0xB0u | (ch - 1u)) << 8 | n << 16 | v << 24, 1);
    midi_drain();
}

static void midi_learn_tests(void)
{
    uint32_t d, g, k = 0, m = 0, j = 0, mod, par, fd = 0, fg = 0;
    const ppage_t *target = 0;
    int32_t top, bottom, mid, v, told;
    cfg.ch = 0;
    pv_gen++;
    screen_idle();
    pages_ensure();
    for (d = 0; d < pg_ndev && !target; d++)            /* a plain parameter row on a page; focus goes to another page */
        for (g = 0; g < pg_dev[d].npg && !target; g++) {
            const ppage_t *pg = &pg_page[pg_dev[d].pg0 + g];
            for (k = 0; k < pg->nrows; k++) {
                const def_t *df;
                int t = eng_type(pg->mod[k]);
                if (pg->mod[k] == SETTING_ROW || (pg->par[k] & POLY_ROW) || t < 0 || DEF_FIXED((uint32_t)t, pg->par[k]))
                    continue;
                df = &DEFS[t];
                if (df->pchoice && df->pchoice[pg->par[k]])
                    continue;
                target = pg, m = pg->mod[k], j = pg->par[k], fd = d, fg = g;
                break;
            }
        }
    check("MIDI learn: the patch has a plain parameter row", target != 0);
    if (!target)
        return;
    if (pg_ndev > 1u)                                   /* (another device's first page, else this device's other page) */
        pages_focus(fd ? 0u : 1u, 0u);
    else
        pages_focus(fd, fg ? 0u : 1u);
    check("  the row's page is not in focus", pages_now() != target);
    (void)row_set_unit(target, k, 65536, &mod, &par, &top);
    (void)row_set_unit(target, k, 0, &mod, &par, &bottom);
    (void)row_set_unit(target, k, 32768, &mod, &par, &mid);
    check("MIDI learn: a mapping goes into the running patch, last", m1_patch_map(1, m, j, 0, 255, 1) && eng_maps(pv_bin, pv_len, &(const uint8_t *){0}) == 1u);
    told = param_now;
    ml_cc(1, 1, 127);
    v = eng_get_param(m, j);
    check("  CC 1 at 127 moves the row to its top, off screen, and the editor hears it at once", v == top && param_now == told + 1);
    check("  over its ramp slot after the knobs' (23 ms)", ramp_any && ramp[ENG_KNOBS].left == ENG_RAMP_BLOCKS && ramp[ENG_KNOBS].mod == (int32_t)m);
    ml_cc(1, 1, 0);
    check("  a move within 25 ms: set, the editor not told yet", eng_get_param(m, j) == bottom && param_now == told + 1);
    fm1_ms += 30u;
    midi_drain();
    check("  25 ms later the drain tells it the latest value", param_now == told + 2);
    cfg.ch = 2;
    ml_cc(1, 1, 127);
    check("  another MIDI channel than MENU > MIDI CHANNEL's: nothing", eng_get_param(m, j) == bottom);
    cfg.ch = 0;
    check("MIDI learn: the row's ends turned round", m1_patch_map(1, m, j, 255, 0, 1));
    ml_cc(1, 1, 0);
    check("  CC 1 at 0 now moves it to its top", eng_get_param(m, j) == top);
    check("MIDI learn: pitch bend learned instead (the row's mapping moves to it)", m1_patch_map(ENG_MAP_BEND, m, j, 0, 255, 1)
          && eng_maps(pv_bin, pv_len, &(const uint8_t *){0}) == 1u);
    midi_enqueue(0x0Eu | 0xE0u << 8 | 0u << 16 | 64u << 24, 1);   /* (8192: the centre) */
    midi_drain();
    check("  its centre puts the row in the middle of its range", eng_get_param(m, j) == mid);
    ml_cc(1, 1, 127);
    check("  and CC 1, no longer learned, moves the mod wheel, not the row", eng_get_param(m, j) == mid);
    check("MIDI learn: CLEAR drops it", m1_patch_map(ENG_MAP_BEND, 0, 0, 0, 0, 0) && !eng_maps(pv_bin, pv_len, &(const uint8_t *){0}));
    {
        uint32_t heard = host_map_told;
        const uint8_t *e = 0;
        const ppage_t *pg = target;
        uint32_t fk = k;
        pages_focus(fd, fg);                            /* (the row's page in focus: a knob there picks it) */
        check("  its page in focus again", pages_now() == pg);
        learn_start();
        check("MIDI learn on the FM-1: LEARN waits for a knob", learn_live() == 1);
        check("  that knob picks its row", learn_pick(fk) && learn_live() == 2 && ml.mod == m && ml.par == j);
        ml_cc(1, 7, 10);
        ml_cc(1, 7, 10);
        ml_cc(1, 7, 20);
        check("  two different values of CC 7: still waiting, the row unmoved", learn_live() == 2);
        ml_cc(1, 7, 30);
        check("  the third: CC 7 moves the row, in the patch, the editor told (MAP_NOW)", !learn_live()
              && eng_maps(pv_bin, pv_len, &e) == 1u && e[0] == 7u && e[1] == m && e[2] == j && host_map_told == heard + 1u);
        ml_cc(1, 7, 127);
        check("  and moves it", eng_get_param(m, j) == top);
        (void)m1_patch_map(7, 0, 0, 0, 0, 0);
    }
}
