/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* #1213, part of panel_test.c (its helpers and controls_test.h's): P-lock paging with a step held on a drum grid, the
 * owner's rulings of 2026-11-25. P1: the note's stop (K2 velocity, SELECT chance) stays ALGO's first stop. P2: ALGO, the
 * button that pages a device, pages the device the track plays, and each stop shows that device's real page (its
 * layout, pixel for pixel, its rows at the held step's values), K1..K4 locking its rows on the step. P3: letting go
 * returns to the grid at the steps, row and track it showed, the device page in focus as it was. Every other held-step
 * combination of the controls table (web/src/controls.ts: held-velocity, held-chance-select, held-cond, held-ratchet,
 * held-micro, lock-pages, lock-rows) and the step's own tap, the accent (FX held + a step) and the tie (LFO held + a
 * step) still do exactly what they did, on the note's stop and, where they are not the page's knobs, on a lock page */

static int pk_mod;                                      /* the track the suite edits */
static uint32_t pk_step, pk_key, pk_note;               /* the held step (the second 16), its white key, its row's note */

static uint32_t pk_word(void) { return eng_steps_note((uint32_t)pk_mod, pk_step, pk_note); }
static uint32_t pk_vel(void) { return (pk_word() >> 19) & 127u; }
static uint32_t pk_chance(void) { return (pk_word() >> 26) & 31u; }
static uint32_t pk_time(void)                          /* (no word: ratchet 1, micro 0, as the bar names it) */
{
    uint32_t x = eng_steps_time((uint32_t)pk_mod, pk_step, pk_note);
    return x ? x : 32u << 6;
}
static void pk_hold(void) { ct_key(pk_key, 1); }
static void pk_let_go(void) { ct_key(pk_key, 0); }
/* the track's notes as one number */
static uint32_t pk_notes(void)
{
    const uint32_t *w;
    int i, nn = eng_steps_notes((uint32_t)pk_mod, &w);
    uint32_t h = 0x811c9dc5u;
    for (i = 0; i < nn; i++)
        h = ct_fnv(h, w[i]);
    return ct_fnv(h, (uint32_t)nn);
}

/* the 808 Kit's drum track at 32 steps, its second 16 shown, row 3 picked, a note on the held step */
static int pk_setup(void)
{
    int map;
    if (ct_load("808 KIT"))
        return 0;
    ct_seq(0, 1, 0);
    pk_mod = seq_module();
    map = seq_map();
    if (pk_mod < 0 || map < 0)
        return 0;
    tap(BTN_OCT_UP);
    enc(0, 3);
    later(1500);
    pk_step = 16u + (uint32_t)CT_STEP;
    pk_key = ct_white(CT_STEP);
    pk_note = seq_grid_note(map, seq_row);
    if (!eng_steps_note((uint32_t)pk_mod, pk_step, pk_note))
        eng_steps_toggle((uint32_t)pk_mod, pk_step, pk_note, STEP_VEL);
    seq_sync(pk_mod);
    ui_dirty = 2;
    later(200);
    return seq_pg == 1u && seq_row == 3u;
}

/* the first row of page pg a lock can take, -1 none */
static int pk_lock_row(const ppage_t *pg)
{
    uint32_t k;
    int32_t v;
    for (k = 0; k < pg->nrows; k++)
        if (pages_lock_turn(pg, k, 0, 1, 0, &v) >= 0)
            return (int)k;
    return -1;
}

static void plock_suite(void)
{
    uint16_t l[PG_PAGES];
    uint32_t n, dev0, pg0, trk0, row0, spg0, locks0, d, g;
    static uint16_t lv_fb[240 * 240];
    printf("p-lock paging (#1213)\n");
    if (!pk_setup()) {
        check("p-lock paging: the 808 Kit's drum grid at its second 16 steps, row 3", 0);
        return;
    }
    n = seq_lock_pages(l, PG_PAGES);
    check("the drum track drives a device with pages to lock", n >= 2u);
    if (n < 2u)
        return;
    trk0 = seq_trk;
    row0 = seq_row;
    spg0 = seq_pg;
    pages_ensure();
    dev0 = pg_cur_dev;
    pg0 = pg_cur_page;

    /* P1: the hold starts on the note's stop, the grid; its combinations as before */
    pk_hold();
    check("P1: a step held: the note's stop, the grid shown with the held hint", seq_held == (int)pk_step && seq_lpg == 0u
          && !seq_lv && page == PAGE_SEQ && !dev_like() && !strcmp(seq_grid_text[2], HINT_HELD_DRUM));
    {
        uint32_t v = pk_vel(), c = pk_chance(), t = pk_time();
        int cond = eng_steps_cond((uint32_t)pk_mod, pk_step, pk_note);
        enc(3, 1);
        check("  held step + K2 (held-velocity): its velocity, one up", pk_vel() == v + 1u && !seq_lv);
        enc(0, -1);
        check("  held step + SELECT (held-chance-select): its chance", pk_chance() != c && seq_row == row0 && !seq_lv);
        enc(0, 1);
        enc(5, 1);
        check("  held step + K4 (held-cond): its trig condition", eng_steps_cond((uint32_t)pk_mod, pk_step, pk_note) != cond && !seq_lv);
        enc(5, -1);
        enc(6, 1);
        check("  held step + PRESET (held-ratchet, D-833): its ratchet X2, the pattern as it was",
              ENG_TIME_RATCHET(pk_time()) == ENG_TIME_RATCHET(t) + 1u && eng_pattern() == 0 && !seq_lv);
        enc(6, -1);
        tap(BTN_OCT_UP);
        check("  held step + OCT+ (held-micro, D-833): its micro timing +1/24, the steps shown as they were",
              ENG_TIME_MICRO(pk_time()) == ENG_TIME_MICRO(t) + 1 && seq_pg == spg0 && octave == 0 && !seq_lv);
        tap(BTN_OCT_DOWN);
        check("  held step + OCT-: back, the steps shown as they were", ENG_TIME_MICRO(pk_time()) == ENG_TIME_MICRO(t) && seq_pg == spg0);
    }

    /* P2: ALGO, the device's page button, to its first page: the real page, the focus moved there */
    enc(1, 1);
    later(1500);                                        /* (LOCK name's message over: the header back) */
    {
        const ppage_t *pg = seq_lock_page();
        bar_t b;
        int k;
        int32_t normal, lv;
        check("P2: held step + ALGO (lock-pages): its first lock page, after the note's stop", seq_lpg == 1u && pg == &pg_page[l[0]]);
        check("  the SEQ page shows that device page: its header and footer, the focus on it", page == PAGE_SEQ && seq_lv && dev_like()
              && pg_plain && pages_now() == pg && seq_held == (int)pk_step);
        pages_row(pg, 0, &b);
        check("  its first row on screen as the device page draws it", b.used && ct_shows(b.name));
        k = pk_lock_row(pg);
        check("  a row a lock can take", k >= 0);
        if (k < 0)
            return;
        normal = eng_get_param(pg->mod[k], pg->par[k]);
        locks0 = (uint32_t)eng_locks_count();
        enc(2u + (uint32_t)k, 1);
        check("  K on that row (lock-rows): locked on the held step, the row's normal value as it was",
              (uint32_t)eng_locks_count() == locks0 + 1u
              && eng_lock_get((uint32_t)pk_mod, seq_lock_pat(pk_mod), pk_step, pg->mod[k], pg->par[k], &lv) && lv != normal
              && eng_get_param(pg->mod[k], pg->par[k]) == normal);
        later(1500);
        {
            char num[16], unit[8];
            uint32_t base, live;
            int32_t v = 0;
            pages_row(pg, (uint32_t)k, &b);
            row_show(pg, (uint32_t)k, num, unit, BAR_W, &base, &live);
            check("  its bar shows the lock's value, drawn on the page", seq_lock_value(pg->mod[k], pg->par[k], &v) && v == lv
                  && !strcmp(b.num, num) && ct_shows(b.num));
        }
        {                                               /* the held step's other combinations on a lock page */
            uint32_t c = pk_chance(), t = pk_time();
            enc(0, -1);
            check("  on the lock page SELECT is still its chance", pk_chance() != c && seq_lv);
            enc(0, 1);
            enc(6, 1);
            check("  PRESET still its ratchet", ENG_TIME_RATCHET(pk_time()) == ENG_TIME_RATCHET(t) + 1u && seq_lv);
            enc(6, -1);
            tap(BTN_OCT_UP);
            check("  OCT+ still its micro timing, the view stays", ENG_TIME_MICRO(pk_time()) == ENG_TIME_MICRO(t) + 1 && seq_pg == spg0 && seq_lv);
            tap(BTN_OCT_DOWN);
        }
        enc(1, 1);
        later(1500);
        for (d = 0; d + 1u < pg_ndev && (uint32_t)l[1] >= (uint32_t)pg_dev[d].pg0 + pg_dev[d].npg; d++)
            ;
        g = (uint32_t)l[1] - pg_dev[d].pg0;
        check("  ALGO again: the next page, shown and in focus", seq_lpg == 2u && seq_lv && pages_now() == &pg_page[l[1]]
              && pg_cur_dev == d && pg_cur_page == g);
        enc(1, -1);
        enc(1, -1);
        later(1500);
        check("  ALGO back to the note's stop: the grid again, the focus as it was", seq_lpg == 0u && !seq_lv && !dev_like()
              && seq_grid_ok && pg_cur_dev == dev0 && pg_cur_page == pg0 && seq_held == (int)pk_step);
        {
            uint32_t v = pk_vel();
            enc(3, 1);
            check("  there K2 is the velocity again, not a lock", pk_vel() == v + 1u && (uint32_t)eng_locks_count() == locks0 + 1u);
        }
        enc(3, -1);
        enc(1, 1);
        later(1500);
    }

    /* P3: let go on a lock page: the grid as it was */
    {
        uint32_t w = pk_word();
        pk_let_go();
        later(200);
        check("P3: let go on a lock page: the SEQ grid, drawn whole", page == PAGE_SEQ && seq_held < 0 && !seq_lv && !dev_like()
              && seq_grid_ok && !strcmp(seq_grid_text[2], HINT_DRUM_LONG));
        check("  at the same steps, row and track", seq_pg == spg0 && seq_row == row0 && seq_trk == trk0);
        check("  the device page in focus as before the hold", pg_cur_dev == dev0 && pg_cur_page == pg0);
        check("  the step not switched by the release (it was used), its lock kept", pk_word() == w
              && (uint32_t)eng_locks_count() == locks0 + 1u && eng_locks_step((uint32_t)pk_mod, seq_lock_pat(pk_mod), pk_step));
    }
    {
        uint32_t w = pk_word();
        pk_hold();
        check("  the next hold starts on the note's stop (P1), the grid", seq_lpg == 0u && !seq_lv && seq_held == (int)pk_step);
        pk_let_go();
        check("  let go with nothing turned (a tap): the step switched off as ever", !pk_word() && w);
        pk_hold();
        pk_let_go();
        check("  tapped again: on again", pk_word() != 0u);
    }
    {
        uint32_t acc = pk_vel();
        ct_down(BTN_ACC);
        pk_hold();
        pk_let_go();
        ct_up(BTN_ACC);
        check("FX held + the step (accent): its accent switched, no lock view", pk_vel() != acc && !seq_lv && seq_held < 0);
        ct_down(BTN_ACC);
        pk_hold();
        pk_let_go();
        ct_up(BTN_ACC);
    }
    {
        uint32_t sum = pk_notes();
        ct_down(BTN_LFO);
        pk_hold();
        pk_let_go();
        ct_up(BTN_LFO);
        check("LFO held + the step (tie): the notes changed, no held step, no lock view", seq_held < 0 && !seq_lv && pk_notes() != sum);
        ct_down(BTN_LFO);
        pk_hold();
        pk_let_go();
        ct_up(BTN_LFO);
    }

    /* P2's "exactly like": the lock view of a step without locks is the device page drawn on its own, pixel for pixel */
    {
        const ppage_t *pg;
        uint32_t k, same = 1, at;
        pk_step = 16u + (uint32_t)CT_STEP + 1u;     /* (a step with no locks) */
        pk_key = ct_white(CT_STEP + 1);
        pk_hold();
        enc(1, 1);
        later(1500);
        pg = seq_lock_page();
        memcpy(lv_fb, fb, sizeof lv_fb);
        at = (uint32_t)(pg - pg_page);
        pk_let_go();
        later(200);
        for (d = 0; d + 1u < pg_ndev && at >= (uint32_t)pg_dev[d].pg0 + pg_dev[d].npg; d++)
            ;
        page_show(0);
        (void)pages_focus(d, at - pg_dev[d].pg0);
        ui_full = 1;
        later(1500);
        later(3000);                                    /* (page 0's own message over, its header back) */
        for (k = 0; k < 240u * 240u; k++)
            same &= lv_fb[k] == fb[k];
        check("  the lock view of a step without locks is that device page as page 0 draws it, pixel for pixel", pg && same);
        page_show(PAGE_SEQ);
    }
    ct_reset();
}
