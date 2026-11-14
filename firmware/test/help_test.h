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

/* row k of tab t as help_rows gives it (controls.h's table, in the state now): its description's first 12 characters */
static const char *help_desc(uint32_t t, uint32_t k, char *buf)
{
    const char *r[HC_ROWS], *d;
    uint32_t n = help_rows(t, r), i = 0;
    if (k < n) {
        for (d = r[k]; *d && *d != '~'; d++)
            ;
        for (d += *d != 0; i < 12u && d[i]; i++)
            buf[i] = d[i];
    }
    buf[i] = 0;
    return buf;
}

/* the rows of tab t that fit from help_top: each one's description on the screen, but one the scroll bar cuts (SCREEN
 * loses a text a fill crosses), and at least one */
static int help_rows_shown(uint32_t t)
{
    const char *r[HC_ROWS], *d;
    uint32_t n = help_rows(t, r), k, shown = 0, bar = n > HC_VIS ? HC_M + HC_W - 6u : 240u, dx;
    char b[16];
    for (k = help_top; k < n && k < help_top + HC_VIS; k++) {
        if (!*help_desc(t, k, b))
            continue;
        if (on_screen(b)) {
            shown++;
            continue;
        }
        help_rows(t, r);
        for (d = r[k]; *d != '~'; d++)
            ;
        dx = help_row(HC_X0, 0, r[k], 0, 0);
        dx = dx > HC_AC ? dx + 2u : HC_AC;
        if (dx + text_w(&FONT_S, d + 1, -1) < bar) {
            printf("      (row %u, \"%s\", not on the screen)\n", (unsigned)k, b);
            return 0;
        }
    }
    return shown > 0u;
}

/* a row of tab t that tab u does not list, one of tab t's first view, is off the screen (tab u shows in its place) */
static int help_tab_gone(uint32_t t, uint32_t u)
{
    const char *r[HC_ROWS];
    uint32_t nt = help_rows(t, r), nu = help_rows(u, r), i, j;
    char a[16], b[16];
    for (i = 0; i < nt && i < HC_VIS; i++) {
        int listed = 0;
        if (!*help_desc(t, i, a))
            continue;
        for (j = 0; j < nu && !listed; j++)
            listed = !strcmp(a, help_desc(u, j, b));
        if (!listed)
            return !on_screen(a);
    }
    return 0;
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
          && on_screen("EVERYWHERE") && help_rows_shown(0));
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
    check("ALGO right: EVERYWHERE, the single buttons first", help_tab == 1u && help_rows_shown(1) && help_tab_gone(0, 1));
    check("  the tab drawn in part = drawn whole", help_whole_same());
    {
        const char *r[HC_ROWS];
        uint32_t n = help_rows(1, r), i, singles = 0, combos = 0, late = 0;
        for (i = 0; i < n; i++) {
            int combo = strstr(r[i], "|t:+|") != 0;
            combos += combo;
            singles += !combo && !combos;
            late += !combo && combos;
        }
        check("  then the combinations", singles > 0u && combos >= 2u && late == 0u);
        check("  more rows than fit: the bottom line names SELECT scroll", n > HC_VIS && on_screen("scroll"));
    }
    enc(1, -1);
    check("ALGO left: the DEVICE tab again", help_tab == 0u && help_rows_shown(0));
    check("  the bottom line names SELECT scroll only when the tab's rows do not fit (D-917: a busy DEVICE tab scrolls)",
          (help_rows(0, (const char *[HC_ROWS]){0}) > HC_VIS) == on_screen("scroll") && on_screen("close"));
    {                                                   /* a tab whose rows fit: OUTPUT's (no presets, no keys), then back */
        const char *r[HC_ROWS];
        uint32_t d0 = pg_cur_dev, g0 = pg_cur_page, n;
        pages_focus(pg_ndev - 1u, 0);
        loop();
        n = help_rows(0, r);
        check("  a tab whose rows fit: the bottom line leaves SELECT out", n <= HC_VIS && !on_screen("scroll") && on_screen("close"));
        enc(0, 1);
        check("SELECT on a sheet whose rows fit: it stays", n <= HC_VIS && help_top == 0u && px(218, HC_TOP) == P_PANEL);
        pages_focus(d0, g0);
        loop();
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
    check("the sheet follows the state: ENVIRONMENT", help_on && help_state() == HS_ENV && on_screen("ENVIRONMENT") && help_rows_shown(0));
    seq_select(0);
    page_show(PAGE_SEQ);
    loop();
    check("  the SEQ page of a melodic track: PIANO ROLL", help_on && help_state() == HS_ROLL && on_screen("PIANO ROLL") && help_rows_shown(0));
    {
        const char *r[HC_ROWS];
        char first[16];
        uint32_t n = help_rows(0, r);
        help_desc(0, 0, first);
        check("  more rows than fit: a scroll bar", n > HC_VIS && px(218, HC_TOP) != P_PANEL);
        enc(0, 1);
        check("SELECT: one row down", help_top == 1u && !on_screen(first) && help_rows_shown(0));
        enc(0, 50);
        check("  SELECT far: stops with the last row at the bottom", help_top == n - HC_VIS && help_rows_shown(0));
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
    check("  and back: DEVICE", on_screen("DEVICE") && help_state() == HS_DEVICE && help_rows_shown(0));
    later(1600);                                        /* (leaving the SEQ page said PATTERN STAYS ARMED, #582: gone first) */
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
    check("the quick start: its title, PRESS OCT- + OCT+", help_on == HELP_QUICK && on_screen("QUICK START")
          && on_screen("TO SEE CONTROLS FOR CURRENT"));
    check("  a whole redraw gives the same pixels", help_whole_same());
    sv0 = saved;
    tap(BTN_SAVE);
    check("  SAVE alone: nothing, the card stays", help_on == HELP_QUICK && saved == sv0);
    enc(0, 1);                                          /* (#582: any other control closes it and then does its job) */
    check("  SELECT: the card closes, then SELECT moves the device", !help_on && (pg_cur_dev != s0 || pg_ndev < 2u));
    enc(0, -1);
    help_open(HELP_QUICK);
    loop();
    {
        int panel = eng_find(T_FM1), was_run = eng_transport_running();
        int32_t bpm = panel >= 0 ? (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16 : 0;
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        check("  PLAY pressed: the card closes", !help_on);
        enc(6, 1);
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("  PLAY held + PRESET then: the tempo a click up, PLAY's release starts nothing", panel < 0
              || (((eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16) == bpm + 1 && eng_transport_running() == was_run));
        if (panel >= 0) {
            eng_set_param((uint32_t)panel, FM1_P_TEMPO, bpm << 16);
            m1_patch_param((uint32_t)panel, FM1_P_TEMPO, bpm << 16);
        }
    }
    later(1100);
    help_open(HELP_QUICK);
    loop();
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
          && help_state() == HS_MENU && help_rows_shown(0));
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

/* HOME + OCT- + OCT+ held 2 s (#631, D-925): GLO > SYSTEM > 3.5MM OUT on / off from any page, never the sheet's pair */
static void b_down(uint32_t id) { panel_held |= 1u << id; panel_edges(1u << id, 0); loop(); }
static void b_up(uint32_t id) { panel_held &= ~(1u << id); panel_edges(0, 1u << id); loop(); }
static void out35_suite(void)
{
    uint32_t pg0, dev0;
    int oct0;
    check("(ORACLE V for 3.5MM OUT's hold)", load("ORACLE V") == 0);
    pv_gen++;
    trail_n = 0;
    page_show(0);
    screen_patch();
    pages_ensure();
    pages_focus(pages_home(), 0);
    pages_page(1);                                      /* (HOME's release would go to the first page) */
    out_off = 0;
    later(2000);
    pg0 = pg_cur_page;
    dev0 = pg_cur_dev;
    oct0 = octave;
    b_down(BTN_HOME);
    b_down(BTN_OCT_DOWN);
    b_down(BTN_OCT_UP);
    check("HOME held, then OCT- + OCT+: no controls sheet", !help_on && !out_off);
    later(1500);
    check("  1.5 s: nothing yet", !out_off);
    b_up(BTN_OCT_UP);
    b_up(BTN_OCT_DOWN);
    b_up(BTN_HOME);
    check("  let go before 2 s: still ON; HOME's release went nowhere, the octave unchanged", !out_off && pg_cur_page == pg0
          && pg_cur_dev == dev0 && octave == oct0 && page == 0u);
    later(2000);
    b_down(BTN_HOME);
    b_down(BTN_OCT_DOWN);
    b_down(BTN_OCT_UP);
    later(1000);
    later(1100);
    check("  held 2 s: 3.5MM OUT OFF, said in the top bar, the mark in the footer", out_off == 1u && !strcmp(msg_text, "3.5MM OUT OFF")
          && px(OFF_FX + 2u, BATT_FY + 2u) == P_WARN && on_screen("3.5MM OFF"));
    later(3000);
    check("  held on: no second turn", out_off == 1u);
    b_up(BTN_HOME);
    b_up(BTN_OCT_DOWN);
    b_up(BTN_OCT_UP);
    check("  let go: HOME's release went nowhere, the octave unchanged", pg_cur_page == pg0 && octave == oct0 && !help_on);
    later(2500);
    b_down(BTN_OCT_DOWN);                               /* the pair first: the sheet, then HOME */
    b_down(BTN_OCT_UP);
    check("OCT- + OCT+ first: the controls sheet, as always", help_on == HELP_SHEET);
    b_down(BTN_HOME);
    later(2100);
    check("  then HOME held with them 2 s: 3.5MM OUT ON, the sheet closes for the top bar's message", out_off == 0u && !help_on
          && !strcmp(msg_text, "3.5MM OUT ON") && px(OFF_FX + 2u, BATT_FY + 2u) != P_WARN);
    b_up(BTN_HOME);
    b_up(BTN_OCT_DOWN);
    b_up(BTN_OCT_UP);
    check("  let go: nothing more (no sheet, the same page)", !help_on && out_off == 0u && pg_cur_page == pg0 && octave == oct0);
    b_down(BTN_HOME);                                   /* HOME and one OCT: not the hold */
    b_down(BTN_OCT_UP);
    later(2100);
    b_up(BTN_OCT_UP);
    b_up(BTN_HOME);
    check("HOME + OCT+ alone held 2 s: nothing", out_off == 0u);
    octave = oct0;
    leds_octave();
    tap(BTN_GLO);                                       /* the menu too: the hold works there, HOME does not close it */
    b_down(BTN_HOME);
    b_down(BTN_OCT_DOWN);
    b_down(BTN_OCT_UP);
    later(2100);
    b_up(BTN_OCT_UP);
    b_up(BTN_OCT_DOWN);
    b_up(BTN_HOME);
    check("in the menu: OFF, and the menu stays", out_off == 1u && page == PAGE_MENU);
    out_off = 0;
    tap(BTN_HOME);
    later(2500);
    mlen = 0;                                           /* (the MIDI log: room for what follows) */
}
