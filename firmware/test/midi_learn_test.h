/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* #1067, part of midi_redraw_test.c: MIDI learn on the FM-1 (firmware/src/midi_learn.c) through the real MIDI queue and
 * dispatcher. A mapping in the running patch's binary moves a row on a page that is not in focus, over its ramp slot,
 * between its ends, and takes its CC from its fixed job; the editor hears the move at once, then at most every 25 ms; the
 * MIDI channel holds for it; pitch bend's centre is the row's middle; SEL + a knob picks a row and the first control to
 * send three different values is learned, a fixed-job CC heard meanwhile named (D-939); a learned note moves its row by
 * velocity, never sounds, waits in a redraw's drain and follows the MIDI channel (D-496). Needs a patch with at least two
 * pages and a poly group loaded (pv_bin). */

static void ml_note(uint32_t ch, uint32_t n, uint32_t vel)
{
    midi_enqueue(0x09u | (0x90u | (ch - 1u)) << 8 | n << 16 | vel << 24, 1);
    midi_drain();
}

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
        uint32_t heard = host_map_told, n36 = ENG_MAP_NOTE + 36u;
        const uint8_t *e = 0;
        const ppage_t *pg = target;
        uint32_t fk = k;
        int32_t vel64;
        pages_focus(fd, fg);                            /* (the row's page in focus: SEL + its knob picks it) */
        check("  its page in focus again", pages_now() == pg);
        learn_row(fk);
        check("MIDI learn on the FM-1: SEL + a knob picks its row, which waits for a control", learn_live() == 1 && ml.mod == m && ml.par == j);
        ml_cc(1, 16, 127);                              /* (a pad's touch: CC 16, a fixed job, two values only) */
        ml_cc(1, 7, 10);
        ml_cc(1, 7, 10);
        ml_cc(1, 7, 20);
        ml_cc(1, 16, 0);
        check("  two different values of CC 7 and a touch CC 16: still waiting, the row unmoved", learn_live() == 1);
        ml_cc(1, 7, 30);
        check("  the third: CC 7 moves the row, in the patch, the editor told (MAP_NOW)", !learn_live()
              && eng_maps(pv_bin, pv_len, &e) == 1u && e[0] == 7u && e[1] == m && e[2] == j && host_map_told == heard + 1u);
        check("  the bar names CC 16, heard meanwhile, and its job; MAP_NOW's tail too",
              strstr(msg_text, "CC 16 ALSO SENT: TURNS K1") && host_map_na == 1u && host_map_also[0] == 16u);
        ml_cc(1, 7, 127);
        check("  and moves it", eng_get_param(m, j) == top);
        (void)m1_patch_map(7, 0, 0, 0, 0, 0);
        learn_row(fk);
        eng_all_notes_off();
        ml_note(1, 36, 100);
        check("MIDI learn: a note learns at once, and does not sound", !learn_live() && eng_maps(pv_bin, pv_len, &e) == 1u
              && e[0] == n36 && !E.grp[0].nheld);
        ml_note(1, 36, 0);
        ml_note(1, 36, 127);
        check("  a learned note at velocity 127 puts the row at its top, and does not sound", eng_get_param(m, j) == top && !E.grp[0].nheld);
        (void)row_set_unit(target, k, (int32_t)(64u * 65536u / 127u), &mod, &par, &vel64);
        ml_note(1, 36, 64);
        check("  at velocity 64 the row's place 64/127", eng_get_param(m, j) == vel64);
        ml_note(1, 36, 0);
        check("  its note-off does nothing", eng_get_param(m, j) == vel64 && !E.grp[0].nheld);
        midi_enqueue(0x09u | 0x90u << 8 | 36u << 16 | 127u << 24, 1);
        midi_drain_mode(1);
        check("  in a redraw's drain it waits for the main loop", mi_r != mi_w);
        midi_drain();
        check("  which moves the row", mi_r == mi_w && eng_get_param(m, j) == top && !E.grp[0].nheld);
        cfg.ch = 2;
        ml_note(1, 36, 64);
        check("  on another MIDI channel than MENU > MIDI CHANNEL's the mapping takes nothing, the row stays", eng_get_param(m, j) == top);
        ml_note(1, 36, 0);
        cfg.ch = 0;
        eng_all_notes_off();
        (void)m1_patch_map(n36, 0, 0, 0, 0, 0);
        ml_note(1, 36, 100);
        check("  cleared, the note sounds again", E.grp[0].nheld == 1);
        ml_note(1, 36, 0);
        eng_all_notes_off();
    }
    {                                                   /* a switch row (two choices) toggles at each note-on */
        uint32_t sm = 0, sj = 0, found = 0;
        for (d = 0; d < pg_npage && !found; d++)
            for (g = 0; g < pg_page[d].nrows && !found; g++) {
                const ppage_t *pg = &pg_page[d];
                if (pg->mod[g] != SETTING_ROW && !(pg->par[g] & POLY_ROW) && eng_type(pg->mod[g]) >= 0
                    && !DEF_FIXED((uint32_t)eng_type(pg->mod[g]), pg->par[g]) && map_switch(pg->mod[g], pg->par[g]))
                    sm = pg->mod[g], sj = pg->par[g], found = 1;
            }
        if (found) {
            int32_t a, b;
            (void)m1_patch_map(ENG_MAP_NOTE + 40u, sm, sj, 0, 255, 1);
            ml_note(1, 40, 90);
            a = eng_get_param(sm, sj);
            ml_note(1, 40, 0);
            ml_note(1, 40, 10);
            b = eng_get_param(sm, sj);
            ml_note(1, 40, 0);
            ml_note(1, 40, 90);
            check("MIDI learn: a note toggles a switch row at each note-on, whatever its velocity", a != b && eng_get_param(sm, sj) == a);
            (void)m1_patch_map(ENG_MAP_NOTE + 40u, 0, 0, 0, 0, 0);
        } else
            check("MIDI learn: (no switch row in this patch to toggle)", 1);
    }
}
