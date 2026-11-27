/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* #1339, part of panel_test.c (its helpers, controls_test.h's): a button or key held while another patch loads (a
 * palette switch at the bar line, the editor's upload, PRESET, a program change: each sets the patch current, pages_gen)
 * lets go of what it did in the patch before, and its release does nothing in the new one. The owner's report: LFO
 * pressed as a Page button, a patch where LFO is a Toggle loaded before LFO was let go; later, on a patch where LFO is a
 * Page button again, LFO on the SEQ page in step record showed a device page instead of entering a rest, and REC then
 * started the transport. Also: a Page button tapped or held across a load, a trail step's page list, a held step and
 * its lock view (#1213). */

/* the 808 Kit with LFO (button 3) a Page button, its list the kit card's two pages (as the #117 block splices it), set
 * current as a load does */
static int hl_page_kit(void)
{
    static const uint8_t sec[] = {0, 0, 0, 3, 0, 0, 0, 2, 1, 0, 1, 1};
    uint32_t at;
    if (load("808 KIT"))
        return -1;
    at = panel_buttons_at();
    memmove(pv_bin + at + sizeof sec, pv_bin + at, pv_len - at);
    memcpy(pv_bin + at, sec, sizeof sec);
    pv_len += sizeof sec;
    pv_bin[6] |= 64u;
    pv_gen++;
    if (eng_load(pv_bin, pv_len))
        return -1;
    m1_pat_load();
    return eng_button_kind(3) != ENG_BTN_PAGE;
}
/* a patch set current as a palette switch, PRESET or the editor's upload sets one: factory patch `name` as the FM-1 has
 * it (factory.c; the factory Algo Four's LFO is a Toggle, the Harmonizer's bypass), or the panel's fixture graph */
static int hl_load(const char *name, int factory)
{
    char n[M1_NAME + 1u];
    uint32_t i;
    int32_t len;
    if (!factory) {
        if (load(name))
            return -1;
        pv_gen++;
        return 0;
    }
    for (i = 0; i < fc_npatches(); i++) {
        if (fc_patch_info(i, n, 0, 0) || strcmp(n, name) || (len = fc_patch(i, pv_bin, sizeof pv_bin)) <= 0)
            continue;
        pv_len = (uint32_t)len;
        pv_gen++;
        if (eng_load(pv_bin, pv_len))
            return -1;
        m1_pat_load();
        return 0;
    }
    return -1;
}
static int lfo_lit(void) { return (int)(eng_buttons_get() >> 3 & 1u); }
/* from rest: the 808 Kit with LFO a Page button on device dev's first page, nothing on the trail */
static int hl_start(uint32_t dev)
{
    ct_reset();
    if (hl_page_kit())
        return 0;
    page_show(0);
    pages_focus(dev, 0);
    later(2000);
    return page == 0u && pg_list_btn < 0 && !lfo_lit();
}
/* LFO pressed as a Page button, a palette switch to the factory Algo Four (LFO a Toggle there), LFO let go */
static int hl_page_then_toggle(void)
{
    uint32_t bt;
    int ok;
    ct_down(BTN_LFO);
    ok = lfo_lit() && !hl_load("ALGO FOUR", 1) && eng_button_kind(3) == ENG_BTN_TOGGLE;
    loop();
    bt = eng_buttons_get();
    ct_up(BTN_LFO);
    return ok && eng_buttons_get() == bt;               /* (the release: no Toggle's job) */
}

static void held_load_suite(void)
{
    uint32_t bt, sum;
    int mod, map;
    printf("held through a patch load (#1339)\n");

    /* the report: LFO pressed as a Page button and let go after a load where it is a Toggle; on the SEQ page a palette
     * switch back to a patch where LFO is a Page button; step record, LFO, REC */
    check("(the 808 Kit with LFO a Page button)", hl_start(pages_home()));
    check("(LFO pressed, a palette switch to Algo Four, LFO a Toggle there, LFO let go: the Toggle as the load left it)",
          hl_page_then_toggle());
    tap(BTN_SEQ);
    check("(the SEQ page)", page == PAGE_SEQ);
    check("(a palette switch back to the 808 Kit with LFO a Page button)", !hl_page_kit());
    later(1500);
    tap(BTN_REC);
    check("(REC: step record on step 1)", page == PAGE_SEQ && sr_on && sr_k == 0u);
    tap(BTN_LFO);
    check("LFO in step record: a rest, the cursor on step 2, the SEQ page stays (it showed LFO's list)", page == PAGE_SEQ
          && sr_on && sr_k == 1u && pg_list_btn < 0);
    tap(BTN_REC);
    check("  REC: step record ends, the transport stays stopped (it started)", page == PAGE_SEQ && !sr_on
          && !eng_transport_running() && !seq_rec);

    /* the same, the switch back on a device page: no list shows by itself, LFO stays unlit */
    check("(the 808 Kit with LFO a Page button)", hl_start(pages_home()));
    check("(LFO pressed, Algo Four loaded, LFO let go)", hl_page_then_toggle());
    check("(a palette switch back to the 808 Kit with LFO a Page button)", !hl_page_kit());
    later(1000);
    check("  the device page: no list (LFO's first page showed, as if held)", page == 0u && !pg_list_peek && pg_list_btn < 0
          && pg_cur_dev == pages_home());
    tap(BTN_ENV);
    tap(BTN_HOME);
    check("  ENV, HOME: no list, LFO unlit (it lit)", page == 0u && pg_list_btn < 0 && !lfo_lit());

    /* a Page button tapped across a load, where it is a Page button too: nothing */
    check("(the 808 Kit with LFO a Page button, the Output in focus)", hl_start(2));
    ct_down(BTN_LFO);
    check("(a palette switch while LFO is down, LFO a Page button there too)", !hl_page_kit());
    loop();
    ct_up(BTN_LFO);
    check("LFO pressed before a load, let go after it: nothing (no list, no step on the trail, unlit, the home device)",
          page == 0u && pg_list_btn < 0 && trail_n == 0u && !lfo_lit() && pg_cur_dev == pages_home());

    /* held long enough to show its list's first page, then a load: the hold ends there */
    check("(the 808 Kit with LFO a Page button, the Output in focus)", hl_start(2));
    ct_down(BTN_LFO);
    later(500);
    check("(LFO held: its list's first page, lit)", pg_list_peek && pg_list_btn == 3 && pg_cur_dev == 1u && lfo_lit());
    check("(a palette switch while it is held)", !hl_page_kit());
    later(500);
    check("LFO held through a load: its hold ends there (no list, unlit, the home device; it showed the list again)",
          !pg_list_peek && pg_list_btn < 0 && !lfo_lit() && pg_cur_dev == pages_home());
    ct_up(BTN_LFO);
    check("  LFO let go: nothing", page == 0u && pg_list_btn < 0 && trail_n == 0u && !lfo_lit());

    /* a list on the trail (LFO's list, SEQ, ENV), then a load where LFO is a Toggle, on the environment, and K1 turned
     * there (the new patch's devices read): HOME, HOME bring no list back */
    check("(the 808 Kit with LFO a Page button, the Output in focus)", hl_start(2));
    tap(BTN_LFO);
    check("(LFO tapped: its list)", pg_list_btn == 3 && trail_n == 1u);
    tap(BTN_SEQ);
    later(1500);
    tap(BTN_ENV);
    check("(SEQ, ENV: the environment, the list two steps back on the trail)", page == PAGE_ENV && trail_n == 3u);
    check("(a palette switch there: Algo Four, LFO a Toggle)", !hl_load("ALGO FOUR", 1) && eng_button_kind(3) == ENG_BTN_TOGGLE);
    later(200);
    enc(2, 1);
    enc(2, -1);
    bt = eng_buttons_get();
    tap(BTN_HOME);
    check("(HOME: the SEQ page)", page == PAGE_SEQ);
    tap(BTN_HOME);
    check("  HOME again: the device page, no list (LFO's list of the patch before), LFO's Toggle as it was",
          page == 0u && pg_list_btn < 0 && eng_buttons_get() == bt);

    /* a step held on the 808 Kit's drum grid through a load (a palette variant with the same track) */
    ct_load("808 KIT");
    ct_seq(0, 0, 0);
    mod = seq_module();
    map = seq_map();
    check("(the 808 Kit's drum grid)", page == PAGE_SEQ && mod >= 0 && map >= 0);
    ct_key(ct_white(CT_STEP), 1);
    check("(a step held)", seq_held == CT_STEP);
    check("(a palette switch while it is held)", !hl_load("808 KIT", 0));
    loop();
    mod = seq_module();
    sum = (uint32_t)sr_notes(mod);
    check("a step held through a load: the hold ends there", seq_held < 0);
    ct_key(ct_white(CT_STEP), 0);
    check("  its key let go: the new patch's step not switched (it was)", (uint32_t)sr_notes(mod) == sum && seq_held < 0);
    ct_key(ct_white(CT_STEP), 1);
    enc(1, 1);
    check("(a step held, ALGO: the lock view on the track's device)", seq_held == CT_STEP && seq_lv);
    check("(a palette switch while it is held)", !hl_load("808 KIT", 0));
    later(200);
    check("  in the lock view: the hold ends at the load, the grid, the home device in focus (the lock view stayed)",
          seq_held < 0 && !seq_lv && page == PAGE_SEQ && pg_cur_dev == pages_home() && pg_cur_page == 0u);
    ct_key(ct_white(CT_STEP), 0);
    check("  its key let go: nothing", seq_held < 0 && !seq_lv && page == PAGE_SEQ);
    ct_reset();
}
