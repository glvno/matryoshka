/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* #450, part of panel_test.c (its helpers): OCT- and OCT+ act on release, both together open the controls sheet
 * (D-245, D-246), the sheet takes ALGO / SELECT / HOME and lets the note keys and PLAY through, follows the state, keeps
 * its partial redraws equal to a whole one and the page around it dimmed; the quick start (D-247): HOME closes it,
 * HOME + SAVE turns it off for good, the OCT pair opens the sheet in its place; MENU > SYSTEM > QUICK START (D-240) */

/* OCT- held, then OCT+ pressed, then both let go (a loop after each) */
static void oct_pair(void)
{
    panel_held |= 1u << BTN_OCT_DOWN;
    panel_edges(1u << BTN_OCT_DOWN, 0);
    loop();
    panel_held |= 1u << BTN_OCT_UP;
    panel_edges(1u << BTN_OCT_UP, 0);
    loop();
    panel_held &= ~(1u << BTN_OCT_DOWN);
    panel_edges(0, 1u << BTN_OCT_DOWN);
    loop();
    panel_held &= ~(1u << BTN_OCT_UP);
    panel_edges(0, 1u << BTN_OCT_UP);
    loop();
}

/* the screen now = the same drawn whole (the card and the page under it) */
static int help_whole_same(void)
{
    static uint16_t was[240 * 240];
    uint32_t i, n = 0, f = 0;
    memcpy(was, fb, sizeof was);
    ui_full = 1;
    help_due = 2;
    loop();
    for (i = 0; i < 240u * 240u; i++)
        if (was[i] != fb[i] && !n++)
            f = i;
    if (n)
        printf("      (%u pixels differ, the first at x %u y %u)\n", (unsigned)n, (unsigned)(f % 240u), (unsigned)(f / 240u));
    return !n;
}

static void help_suite(void)
{
    static uint16_t ref[240 * 240], was[240 * 240];
    uint32_t bad, x, y, s0, k1m, k1p, st0;
    int from, oct0, steps0, sv0;
    int32_t k1v;
    check("(ORACLE V for the sheet)", load("ORACLE V") == 0);
    pv_gen++;
    trail_n = 0;
    page_show(0);
    screen_patch();
    later(2000);
    if (eng_transport_running())
        tap(BTN_PLAY);
    pages_ensure();
    pages_focus(pages_home(), 0);                       /* (the voice: an assembly with presets, keys and a long sheet) */
    octave = 0;
    leds_octave();
    mlen = 0;                                           /* (the MIDI log: room for this suite) */
    ui_full = 1;
    later(1500);
    panel_held |= 1u << BTN_OCT_UP;                     /* OCT acts on its release (D-245) */
    panel_edges(1u << BTN_OCT_UP, 0);
    loop();
    check("OCT+ pressed: the octave not yet", octave == 0 && !help_on);
    panel_held &= ~(1u << BTN_OCT_UP);
    panel_edges(0, 1u << BTN_OCT_UP);
    loop();
    check("  let go: octave +1", octave == 1 && !help_on && on_screen("OCTAVE +1"));
    tap(BTN_OCT_DOWN);
    check("OCT- tapped: octave 0", octave == 0);
    later(1500);                                        /* (the OCTAVE message ends) */
    ui_full = 1;
    loop();
    memcpy(ref, fb, sizeof ref);
    from = mlen;
    panel_held |= 1u << BTN_OCT_DOWN;                   /* the pair: OCT- held, OCT+ pressed */
    panel_edges(1u << BTN_OCT_DOWN, 0);
    panel_held |= 1u << BTN_OCT_UP;
    panel_edges(1u << BTN_OCT_UP, 0);
    loop();
    check("OCT- held + OCT+: the controls sheet opens on the DEVICE tab", help_on == HELP_SHEET && help_tab == 0u && on_screen("DEVICE")
          && on_screen("EVERYWHERE") && on_screen("adjust values"));
    panel_held &= ~(1u << BTN_OCT_DOWN);
    panel_edges(0, 1u << BTN_OCT_DOWN);
    panel_held &= ~(1u << BTN_OCT_UP);
    panel_edges(0, 1u << BTN_OCT_UP);
    loop();
    check("  both let go: the octave unchanged, no OCTAVE message", octave == 0 && !on_screen("OCTAVE"));
    check("  the pair's CCs went out (a mirror of the panel opens its sheet too)", sent(from, 0xB0u, 92u, 127u) && sent(from, 0xB0u, 93u, 127u)
          && sent(from, 0xB0u, 92u, 0u) && sent(from, 0xB0u, 93u, 0u));
    for (bad = 0, y = 0; y < 240u; y++)                 /* the page around the card: dimmed to 40 % */
        for (x = 0; x < 240u; x++)
            if ((x < 16u || x >= 224u || y < 16u || y >= 224u) && fb[y * 240u + x] != lcd_dim40(ref[y * 240u + x]))
                bad++;
    check("  the page around the card is the page dimmed to 40 %", bad == 0u);
    check("  the card: a 2 px sky edge, the shown tab sky at 75 %", px(16, 120) == P_SKY && px(17, 120) == P_SKY && px(18, 120) == P_PANEL
          && px(20, 20) == help_pct(P_SKY, 75u));
    check("  a whole redraw gives the same pixels", help_whole_same());
    /* the controls it takes */
    from = mlen;
    enc(1, 1);
    check("ALGO right: EVERYWHERE", help_tab == 1u && on_screen("tempo") && on_screen("patches") && !on_screen("adjust values"));
    check("  the tab drawn in part = drawn whole", help_whole_same());
    enc(1, -1);
    check("ALGO left: the DEVICE tab again", help_tab == 0u && on_screen("adjust values"));
    {
        const char *r[HC_ROWS];
        uint32_t n = help_rows(0, r);
        enc(0, 1);
        check("SELECT on a sheet whose rows fit: it stays", n <= HC_VIS && help_top == 0u && px(218, HC_TOP) == P_PANEL);
    }
    check("  SELECT and ALGO sent no MIDI", !sent(from, 0xB0u, CC_SELECT, 1u) && !sent(from, 0xB0u, CC_ALGO, 1u));
    k1m = pages_now()->mod[0];
    k1p = pages_now()->par[0];
    k1v = eng_get_param(k1m, k1p);
    steps0 = presets_stepped;
    sv0 = saved;
    oct0 = (int)octave;
    s0 = pg_cur_dev;
    st0 = eng_buttons_get();
    from = mlen;
    enc(2, 3);
    enc(6, 1);
    panel_held |= 1u << BTN_HOME;                       /* (HOME held + PRESET: no patch either) */
    panel_edges(1u << BTN_HOME, 0);
    enc(6, 1);
    check("K1, PRESET, HOME + PRESET under the sheet: nothing", eng_get_param(k1m, k1p) == k1v && presets_stepped == steps0
          && help_on == HELP_SHEET && pg_cur_dev == s0);
    panel_held &= ~(1u << BTN_HOME);                    /* (HOME's release: the sheet closes, as a tap) */
    panel_edges(0, 1u << BTN_HOME);
    loop();
    check("  HOME let go: the sheet closes", !help_on && page == 0u && pg_cur_dev == s0);
    oct_pair();
    check("  (the sheet again)", help_on == HELP_SHEET);
    tap(BTN_SEQ);
    tap(BTN_GLO);
    tap(BTN_ENV);
    tap(BTN_SAVE);
    tap(BTN_REC);
    tap(BTN_SEL);
    tap(BTN_OCT_UP);
    tap(PANEL_BTN_ID[6]);                               /* ARP */
    check("SEQ, GLO, ENV, SAVE, REC, SEL, OCT+, ARP under the sheet: nothing", page == 0u && help_on == HELP_SHEET && saved == sv0
          && !seq_rec && !eng_transport_running() && (int)octave == oct0 && eng_buttons_get() == st0);
    check("  none of them went out as MIDI", !sent(from, 0xB0u, BTN_CC[BTN_SEQ], 127u) && !sent(from, 0xB0u, BTN_CC[BTN_GLO], 127u)
          && !sent(from, 0xB0u, BTN_CC[10], 127u) && !sent(from, 0xB0u, BTN_CC[BTN_SAVE], 0u) && !sent(from, 0xB0u, CC_PRESET, 1u));
    tap(BTN_PLAY);
    check("PLAY under the sheet: starts", eng_transport_running() && help_on == HELP_SHEET && sent(from, 0xFAu, 0xFFu, 0xFFu)
          && sent(from, 0xB0u, BTN_CC[BTN_PLAY], 127u));
    tap(BTN_PLAY);
    check("  and stops", !eng_transport_running());
    panel_keys(1u << 12);
    check("a note key under the sheet plays", (key_sounding >> 12 & 1u) != 0u);
    panel_keys(0);
    loop();
    memcpy(was, fb, sizeof was);
    ui_msg("A MESSAGE", 1000);                          /* the page draws under the card: never over it */
    ui_dirty = 2;
    loop();
    for (bad = 0, y = 16; y < 224u; y++)
        for (x = 16; x < 224u; x++)
            bad += fb[y * 240u + x] != was[y * 240u + x];
    check("  a message and a page redraw under the sheet leave the card as it was", bad == 0u);
    later(1500);
    page_show(PAGE_ENV);                                /* the state changes (as the editor or a dive would): the sheet follows */
    loop();
    check("the sheet follows the state: ENVIRONMENT", help_on && on_screen("ENVIRONMENT") && on_screen("device rows"));
    seq_select(0);
    page_show(PAGE_SEQ);
    loop();
    check("  the SEQ page of a melodic track: PIANO ROLL", help_on && help_state() == HS_ROLL && on_screen("PIANO ROLL") && on_screen("jump to pitch"));
    {
        const char *r[HC_ROWS];
        uint32_t n = help_rows(0, r);
        check("  more rows than fit: a scroll bar", n > HC_VIS && px(218, HC_TOP) != P_PANEL);
        enc(0, 1);
        check("SELECT: one row down", help_top == 1u && !on_screen("step on / off") && on_screen("pick a row"));
        enc(0, 50);
        check("  SELECT far: stops with the last row at the bottom", help_top == n - HC_VIS && on_screen("clear track"));
        check("  scrolled in part = drawn whole", help_whole_same());
        enc(0, -50);
        check("  and back to the top", help_top == 0u);
    }
    tap(BTN_HOME);                                      /* closed on the SEQ page: the page whole again, as a whole draw */
    memcpy(was, fb, sizeof was);
    ui_full = 1;
    loop();
    check("HOME on the SEQ page: closed, the page as a whole draw of it", !help_on && page == PAGE_SEQ && !memcmp(was, fb, sizeof fb));
    oct_pair();
    page_show(0);
    loop();
    check("  and back: DEVICE", on_screen("DEVICE") && on_screen("adjust values"));
    from = mlen;
    tap(BTN_HOME);
    check("HOME: the sheet closes, the device page as it was", !help_on && !lcd_ovl && page == 0u && pg_cur_dev == s0
          && sent(from, 0xB0u, BTN_CC[BTN_HOME], 0u));
    memcpy(was, fb, sizeof was);
    screen_idle();
    check("  the same as a whole draw of the page", !memcmp(was, fb, sizeof fb));
    tap(BTN_OCT_UP);
    check("  OCT works again", octave == oct0 + 1);
    tap(BTN_OCT_DOWN);
    later(1500);
    /* the quick start */
    cfg.quick = 1;
    help_open(HELP_QUICK);
    loop();
    check("the quick start: its title, rows, PRESS OCT- + OCT+, its bottom line", help_on == HELP_QUICK && on_screen("QUICK START")
          && on_screen("device presets") && on_screen("TO SEE CONTROLS FOR CURRENT") && on_screen("forever"));
    enc(0, 1);
    enc(1, 1);
    check("  SELECT and ALGO: nothing", help_on == HELP_QUICK && help_tab == 0u && help_top == 0u);
    check("  a whole redraw gives the same pixels", help_whole_same());
    from = mlen;
    tap(BTN_HOME);
    check("  HOME: closed, still on for the next power-on; HOME sent nothing (no mirror shows the quick start)", !help_on && cfg.quick == 1u
          && !sent(from, 0xB0u, BTN_CC[BTN_HOME], 127u) && !sent(from, 0xB0u, BTN_CC[BTN_HOME], 0u) && page == 0u && pg_cur_dev == s0);
    help_open(HELP_QUICK);
    loop();
    oct_pair();
    check("the quick start, OCT- + OCT+: the sheet in its place, the octave unchanged", help_on == HELP_SHEET && on_screen("EVERYWHERE")
          && !on_screen("QUICK START") && octave == oct0);
    tap(BTN_HOME);
    help_open(HELP_QUICK);
    loop();
    sv0 = saved;
    steps0 = settings_stored;
    panel_held |= 1u << BTN_HOME;                       /* HOME + SAVE: off for good */
    panel_edges(1u << BTN_HOME, 0);
    panel_held |= 1u << BTN_SAVE;
    panel_edges(1u << BTN_SAVE, 0);
    loop();
    check("HOME + SAVE: the quick start closes and is off, the setting stored at once (no SAVE of the patch)",
          !help_on && cfg.quick == 0u && settings_stored == steps0 + 1 && saved == sv0);
    check("  the header says QUICK START OFF: GLO>SYSTEM (in the bar's width)", on_screen("QUICK START OFF: GLO>SYSTEM")
          && text_w(&FONT_S, "QUICK START OFF: GLO>SYSTEM", -1) < 232u);
    panel_held &= ~(1u << BTN_SAVE);
    panel_edges(0, 1u << BTN_SAVE);
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);
    loop();
    check("  HOME's and SAVE's releases then: nothing", page == 0u && pg_cur_dev == s0 && saved == sv0);
    later(3000);
    tap(BTN_GLO);                                       /* MENU > SYSTEM > QUICK START (D-240) */
    enc(1, 1);
    enc(1, 1);
    check("the menu's SYSTEM tab: QUICK START on K3, OFF", menu_tab == MT_SYSTEM && pages_now()->par[2] == MR_QUICK && on_screen("QUICK START")
          && on_screen("OFF"));
    enc(4, 1);
    check("  K3 right: on", cfg.quick == 1u);
    oct_pair();
    check("  OCT- + OCT+ in the menu: the SETTINGS sheet, K1..K4 and GLO's hold listed on SYSTEM", help_on == HELP_SHEET && on_screen("SETTINGS")
          && on_screen("run armed row") && on_screen("set"));
    tap(BTN_HOME);
    check("  HOME closes the sheet, the menu stays", !help_on && page == PAGE_MENU);
    memcpy(was, fb, sizeof was);
    ui_full = 1;
    loop();
    check("  the menu as a whole draw of it", !memcmp(was, fb, sizeof fb));
    later(200);
    enc(4, -1);
    check("  K3 left: off", cfg.quick == 0u);
    cfg_defaults();
    check("FACTORY RESET's defaults: the quick start on again", cfg.quick == 1u);
    tap(BTN_HOME);
}
