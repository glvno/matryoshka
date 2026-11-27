/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* #1196, part of panel_test.c (its helpers): the palette's gestures (pal_ui.c, panel.c). HOME held + black key n tapped
 * asks palette.c for position n (pal_request, on the release, from the loop), held 1 s saves there (pal_save, once);
 * every key is silent while HOME is held, a key already down plays on; HOME held alone 300 ms shows the overview, which
 * HOME's other combos close; HOME + PRESET over the overview or a card leaves nothing of it on the next patch's page
 * (#1222); sandbox mode refuses; the empty and missing texts, the bar's NEXT:, the copy's KEYS_NOW and panel_align.
 * palette.c is stood in for (panel_test.c pal_request / pal_save). */

static uint32_t pt_black(int b)
{
    uint32_t n;
    for (n = 0; n < 27u && seq_black(n) != b; n++)
        ;
    return n;
}
static void pt_home(int down)
{
    if (down) {
        panel_held |= 1u << BTN_HOME;
        panel_edges(1u << BTN_HOME, 0);
    } else {
        panel_held &= ~(1u << BTN_HOME);
        panel_edges(0, 1u << BTN_HOME);
    }
    loop();
}
static void pt_key(uint32_t n, int down)
{
    panel_keys(down ? 1u << n : 0u);
    loop();
}
/* a note on or off went out since `from` */
static int pt_noted(int from)
{
    int i, n = 0;
    for (i = from; i < mlen; i++)
        n |= (mlog[i][0] & 0xE0u) == 0x80u;
    return n;
}
static void pt_name(uint32_t pos, const char *s)
{
    memset(pal_ix[pos].name, 0, sizeof pal_ix[pos].name);
    memcpy(pal_ix[pos].name, s, strlen(s) < PAL_NAME ? strlen(s) : PAL_NAME);
}
/* position pos's first preset name (panel_test.c pal_preset's stand-in; "" none) */
static void pt_pname(uint32_t pos, const char *s)
{
    snprintf(pal_pnames[pos], sizeof pal_pnames[pos], "%s", s);
}
/* the palette: 1 MONOLITH D, 2 808 KIT, 3 SILVER BOX, 4 CANVAS missing, the rest empty; 1 playing */
static void pt_palette(void)
{
    memset(pal_ix, 0, sizeof pal_ix);
    memset(pal_pnames, 0, sizeof pal_pnames);
    pal_ix[0].state = pal_ix[1].state = pal_ix[2].state = PAL_OK;
    pal_ix[3].state = PAL_MISSING;
    pt_name(0, "MONOLITH D");
    pt_name(1, "808 KIT");
    pt_name(2, "SILVER BOX");
    pt_name(3, "CANVAS");
    pal_cur = 0;
    pal_next = PAL_NONE;
    pal_ui_changed();
}
/* PRESET turned one click (HOME held: the next patch), the patch loaded as main.c preset_load does, with PRESET's toast:
 * 1 it stepped */
static int pt_preset(void)
{
    int sv = presets_stepped;
    preset_loads = 1;
    enc(6, 1);
    preset_loads = 0;
    return presets_stepped == sv + 1;
}
/* the device page's second page (a device that has one), so a HOME tap would move */
static int pt_second_page(void)
{
    uint32_t d;
    pages_ensure();
    for (d = 0; d < pg_ndev; d++)
        if (pages_focus(d, 1) && pg_cur_page == 1u)
            break;
    ui_dirty = 2;
    loop();
    return pg_cur_page == 1u;
}

static void palette_panel_suite(void)
{
    uint32_t k3 = pt_black(2), dev, i, n;
    int from, req;
    char want[64];
    while (page != 0u && trail_n)
        tap(BTN_HOME);
    if (eng_transport_running())
        tap(BTN_PLAY);
    if (help_on)
        help_close();
    check("(palette: ORACLE V loads)", load("ORACLE V") == 0);
    patch_label = "ORACLE V";
    pv_gen++;
    page = 0;
    trail_n = 0;
    octave = 0;
    eng_arm_mask(s64(0));
    screen_idle();
    later(2000);
    pt_palette();
    loop();
    mlen = 0;
    from = mlen;
    pt_key(k3, 1);
    pt_key(k3, 0);
    check("(black key 3 alone plays a note: on and off out)", pt_noted(from));

    /* HOME held + black key 3 tapped: taken on the press, the switch asked on the release by the loop */
    check("(a second page to leave)", pt_second_page());
    dev = pg_cur_dev;
    pal_requests = pal_saves = 0;
    kr_n = 0;
    pt_home(1);
    from = mlen;
    panel_keys(1u << k3);
    check("HOME held + black key 3: taken, no note in the engine, nothing asked yet", !(key_sounding >> k3 & 1u)
          && pal_requests == 0 && (pal_taken >> k3 & 1u));
    check("  its edge reported to the editor's copy with HOME held (KEYS_NOW)", kr_n == 1 && kr_key[0] == k3 && kr_down[0]
          && (kr_held[0] >> BTN_HOME & 1u));
    loop();
    later(200);
    msg_text[0] = 0;
    panel_keys(0);
    check("  its release: the key edge draws and asks nothing itself (D-228)", pal_requests == 0 && !msg_text[0]);
    loop();
    check("  ... the loop asks palette.c for position 3 (pal_request(2)), once", pal_requests == 1 && pal_req_pos == 2u
          && !pal_saves);
    check("  no note on or off out, nothing played", !pt_noted(from) && !(key_sounding >> k3 & 1u));
    pt_home(0);
    check("HOME's release after a palette key: no home_tap (the second page stays)", page == 0u && pg_cur_dev == dev
          && pg_cur_page == 1u);

    /* held 1 s: the save, once, while held; the release then nothing */
    pal_requests = pal_saves = 0;
    pt_home(1);
    pt_key(k3, 1);
    later(PAL_HOLD_MS - 10u);
    check("HOME + black key 3 held 0.99 s: nothing saved yet", !pal_saves);
    later(20);
    check("  held 1 s: pal_save(2), while still held", pal_saves == 1 && pal_save_pos == 2u && !pal_requests);
    later(1500);
    check("  held on: saved once only", pal_saves == 1);
    pt_key(k3, 0);
    check("  its release: no tap, no second save", !pal_requests && pal_saves == 1);
    pt_home(0);

    /* HOME let go first: the hold is no longer timed, the key's release is still a tap */
    pal_requests = pal_saves = 0;
    pt_home(1);
    pt_key(k3, 1);
    later(300);
    pt_home(0);
    later(1500);
    check("HOME let go before 1 s, the key held on: no save", !pal_saves && !pal_requests);
    from = mlen;
    pt_key(k3, 0);
    check("  the key's release: a tap (pal_request(2)), no note off", pal_requests == 1 && pal_req_pos == 2u && !pt_noted(from));

    /* every other key is silent while HOME is held; a key down before HOME plays on */
    pal_requests = pal_saves = 0;
    pt_home(1);
    from = mlen;
    {
        static const uint32_t K[4] = {0u, 20u, 22u, 25u};   /* a white key (F3), black keys 9, 10, 11 */
        int quiet = 1;
        for (i = 0; i < 4u; i++) {
            pt_key(K[i], 1);
            quiet &= !(key_sounding >> K[i] & 1u);
            pt_key(K[i], 0);
        }
        check("HOME held: a white key and black keys 9..11 sound nothing, ask nothing", quiet && !pt_noted(from)
              && !pal_requests && !pal_saves);
    }
    pt_home(0);
    later(100);
    from = mlen;
    pt_key(k3, 1);
    check("(black key 3 alone: sounding)", (key_sounding >> k3 & 1u) && pt_noted(from));
    pt_home(1);
    from = mlen;
    pt_key(k3, 0);
    check("a key down before HOME: its release with HOME held ends its note (note off out), no tap", !(key_sounding >> k3 & 1u)
          && pt_noted(from) && !pal_requests);
    pt_home(0);
    later(100);

    /* the quick path (#230): inside a redraw the edge waits for the loop's pass */
    pal_requests = 0;
    pt_home(1);
    kq_r = kq_w = 0;
    kq_edge(k3, 1);
    panel_key_queue(kq_peek, kq_pop, 1);
    check("HOME held + a black key inside a redraw: held back (the quick path's guard)", kq_r != kq_w && !(keys_now >> k3 & 1u));
    panel_key_queue(kq_peek, kq_pop, 0);
    check("  the loop's pass takes it", kq_r == kq_w && (keys_now >> k3 & 1u) && (pal_taken >> k3 & 1u));
    kq_edge(k3, 0);
    panel_key_queue(kq_peek, kq_pop, 0);
    loop();
    check("  and its release taps", pal_requests == 1 && pal_req_pos == 2u);
    pt_home(0);

    /* HOME alone: a tap still goes back (D-243), no overview flashes */
    check("(a second page)", pt_second_page());
    panel_held |= 1u << BTN_HOME;
    panel_edges(1u << BTN_HOME, 0);
    fm1_ms += 50;
    loop();
    n = pal_view;
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);
    loop();
    check("a HOME tap alone: back to the device's first page, no overview on the way (D-243)", !n && !pal_view
          && page == 0u && pg_cur_page == 0u);

    /* the overview: after 300 ms, not before */
    pal_next = PAL_NONE;
    pt_home(1);
    later(PAL_VIEW_MS - 50u);
    check("HOME held 250 ms: no overview yet", !pal_view && !on_screen("1 MONOLITH D"));
    later(60);
    check("HOME held 310 ms: the overview: its title, the rows (1 MONOLITH D, 4 CANVAS MISSING, 5 EMPTY), the current one marked",
          pal_view && lcd_ovl && on_screen(MSG_PAL_TITLE) && on_screen("1 MONOLITH D") && on_screen("2 808 KIT")
          && on_screen("3 SILVER BOX") && on_screen("4 CANVAS" MSG_PAL_ROW_MISSING) && on_screen(">")
          && on_screen("5 " MSG_PAL_ROW_EMPTY) && on_screen("8 " MSG_PAL_ROW_EMPTY));
    snap_to(getenv("PAL_SNAP"));
    pal_next = 2;
    pal_ui_changed();
    loop();
    check("  a switch waiting (palette.c pal_ui_changed): its row says NEXT", on_screen("3 SILVER BOX" MSG_PAL_ROW_NEXT));
    pal_requests = 0;
    pt_key(pt_black(4), 1);
    pt_key(pt_black(4), 0);
    check("  a palette key meanwhile: the overview stays (choosing), the empty position's text on its last line",
          pal_view && !pal_requests && nudged(MSG_PAL "5" MSG_PAL_EMPTY) && pal_next == 2u);
    pt_key(pt_black(1), 1);
    pt_key(pt_black(1), 0);
    check("  black key 2: pal_request(1), the overview stays", pal_view && pal_requests == 1 && pal_req_pos == 1u);
    pt_home(0);
    check("  HOME let go: the overview closes, the page whole again", !pal_view && !lcd_ovl && !on_screen("1 MONOLITH D"));
    pal_next = PAL_NONE;
    pal_ui_changed();
    later(NUDGE_MS + 100u);
    memset(pal_ix, 0, sizeof pal_ix);
    pal_cur = PAL_NONE;
    pt_home(1);
    later(400);
    check("an empty palette's overview: one line, HOLD A BLACK KEY TO SAVE", pal_view && on_screen(MSG_PAL_HOLD_TO_SAVE)
          && !on_screen("1 " MSG_PAL_ROW_EMPTY));
    pt_home(0);
    pt_palette();
    loop();

    /* HOME's other combos close it, then do their own job; it opens again only on a new HOME press */
    pt_home(1);
    later(400);
    {
        uint32_t p0 = ct_params();
        enc(2, 1);
        check("HOME + K1 (fine): the overview closes, K1 turns fine", !pal_view && ct_params() != p0 && home_turned);
    }
    later(500);
    check("  HOME still held: it stays closed", !pal_view);
    pt_home(0);
    pt_home(1);
    later(400);
    check("HOME + PRESET: the overview closes, the patch steps, its toast", pt_preset() && !pal_view && !lcd_ovl
          && toast_wanted());
    check("  nothing of the overview left on the next patch's page and toast (#1222: a full redraw changes nothing)",
          fb_stale() == 0u);
    pt_home(0);
    later(NUDGE_MS + 100u);

    /* #1222, the cards: on the quick start HOME + PRESET closes it and steps (a knob closes it and does its job, #582);
     * under the controls sheet it does nothing (D-245). Either way nothing of the card is left on the page */
    help_open(HELP_QUICK);
    loop();
    pt_home(1);
    check("on the quick start HOME + PRESET: the card closes, the patch steps, its toast", pt_preset() && !help_on
          && !lcd_ovl && toast_wanted());
    check("  nothing of the card left on the next patch's page and toast", fb_stale() == 0u);
    pt_home(0);
    later(NUDGE_MS + 100u);
    help_open(HELP_SHEET);
    loop();
    pt_home(1);
    check("under the controls sheet HOME + PRESET: no patch, the card and the page around it as a whole redraw",
          !pt_preset() && help_on == HELP_SHEET && lcd_ovl && fb_stale() == 0u);
    pt_home(0);
    check("  HOME let go: the sheet closes, the page as a whole redraw", !help_on && !lcd_ovl && fb_stale() == 0u);
    later(NUDGE_MS + 100u);
    if (page != 0u)
        tap(BTN_HOME);
    pt_home(1);
    later(400);
    n = (uint32_t)learn_live();
    tap(BTN_SEL);
    check("HOME + SEL: the overview closes, MIDI learn mode turns over", !pal_view && (uint32_t)learn_live() != n);
    tap(BTN_SEL);
    pt_home(0);
    check("  (learn mode as it was)", (uint32_t)learn_live() == n);
    later(NUDGE_MS + 100u);
    pt_home(1);
    later(400);
    n = out_off;
    panel_held |= 1u << BTN_OCT_DOWN;
    panel_edges(1u << BTN_OCT_DOWN, 0);
    loop();
    check("HOME + OCT-: the overview closes (the 3.5MM OUT combo's first edge)", !pal_view);
    panel_held |= 1u << BTN_OCT_UP;
    panel_edges(1u << BTN_OCT_UP, 0);
    later(2100);
    check("  + OCT+ held 2 s: 3.5MM OUT turns over, no controls sheet", out_off != n && !help_on && !pal_view);
    panel_held &= ~(OCT_BTNS | 1u << BTN_HOME);
    panel_edges(0, OCT_BTNS | 1u << BTN_HOME);
    loop();
    out_off = (uint8_t)n;
    later(2100);

    /* the quick start: HOME + SAVE turns it off, no overview there */
    {
        uint8_t q = cfg.quick;
        int st = settings_stored;
        help_open(HELP_QUICK);
        loop();
        pt_home(1);
        later(400);
        check("on the quick start HOME held: no overview", help_on == HELP_QUICK && !pal_view);
        panel_held |= 1u << BTN_SAVE;
        panel_edges(1u << BTN_SAVE, 0);
        loop();
        later(400);
        check("  HOME + SAVE: the quick start off for good, no overview after it", !help_on && !cfg.quick
              && settings_stored == st + 1 && !pal_view);
        panel_held &= ~(1u << BTN_SAVE);
        panel_edges(0, 1u << BTN_SAVE);
        later(400);
        check("  SAVE let go, HOME held on: still no overview", !pal_view);
        pt_home(0);
        cfg.quick = q;
        later(2600);
    }

    /* sandbox mode: the refusal, no request, no overview, no note */
    cfg.midi_out = 1;
    m1_live(1);
    loop();
    check("(sandbox mode)", sb_on);
    pal_requests = pal_saves = 0;
    pt_home(1);
    from = mlen;
    msg_text[0] = 0;
    panel_keys(1u << k3);
    check("sandbox mode, HOME + black key 3: no nudge drawn by the key edge (D-228)", !msg_text[0]);
    loop();
    check("  the loop: SANDBOX: PATCH STAYS, nothing asked of palette.c, no note out", nudged(MSG_SANDBOX_PATCH_STAYS)
          && !pal_requests && !pt_noted(from));
    later(1100);
    check("  held 1 s: nothing saved, no overview", !pal_saves && !pal_view);
    pt_key(k3, 0);
    check("  its release: no request", !pal_requests && !pt_noted(from));
    pt_home(0);
    m1_live(0);
    loop();
    check("(sandbox mode ends)", !sb_on);
    later(NUDGE_MS + 100u);
    while (page != 0u && trail_n)
        tap(BTN_HOME);

    /* the empty and missing texts, a waiting switch kept; the bar's NEXT: */
    pt_palette();
    pal_next = 1;
    pal_ui_changed();
    loop();
    check("a switch waiting: the bar says NEXT: 2 808 KIT", on_screen(MSG_PAL_NEXT "2 808 KIT") && bar_shows(MSG_PAL_NEXT "2 808 KIT", C_ACC));
    pal_requests = 0;
    pt_home(1);
    pt_key(pt_black(4), 1);
    pt_key(pt_black(4), 0);
    check("HOME + black key 5 (empty): PALETTE 5 EMPTY: HOLD KEY, the waiting switch stays", nudged(MSG_PAL "5" MSG_PAL_EMPTY)
          && !pal_requests && pal_next == 1u);
    pt_key(pt_black(3), 1);
    pt_key(pt_black(3), 0);
    check("  black key 4 (missing): PALETTE 4: MISSING, the waiting switch stays", nudged(MSG_PAL "4" MSG_PAL_MISSING)
          && !pal_requests && pal_next == 1u);
    pt_home(0);
    later(NUDGE_MS + 100u);
    check("  the nudge over: NEXT: again in the bar", on_screen(MSG_PAL_NEXT "2 808 KIT"));
    ui_full = 1;
    loop();
    check("  a whole redraw keeps it", on_screen(MSG_PAL_NEXT "2 808 KIT") && bar_shows(MSG_PAL_NEXT "2 808 KIT", C_ACC));
    pt_name(1, "ABCDEFGHIJKLMNOPQRST");
    pal_ui_changed();
    loop();
    snprintf(want, sizeof want, "%s2 %s", MSG_PAL_NEXT, "ABCDEFGHIJKLMNOPQRST");
    check("  a 20-character name and no preset: whole (it fits the bar, D-942)", bar_shows(want, C_ACC));
    page_set(PAGE_SEQ);
    loop();
    check("  on the SEQ page too", page == PAGE_SEQ && on_screen(want));
    tap(BTN_HOME);
    tap(BTN_ENV);
    ui_full = 1;
    loop();
    check("  on the environment too, a whole redraw keeping it", page == PAGE_ENV && on_screen(want) && !on_screen("ENVIRONMENT"));
    tap(BTN_HOME);
    pal_next = PAL_NONE;
    pal_ui_changed();
    loop();
    check("the switch done: the bar's NEXT: gone, the page's header back", page == 0u && !on_screen(MSG_PAL_NEXT));

    /* D-942 (the owner 2026-11-27): an entry with a preset is named by its first device preset, then its patch, in the
     * overview (the row's whole width) and in the bar's NEXT: (fitted to the bar); the patch's name shortens first */
    later(NUDGE_MS + 100u);
    pt_palette();
    pt_pname(1, "BRIGHT PAD");
    pt_pname(2, "SHIMMERING GLASS");
    pt_pname(3, "Warm");                            /* (as the editor names a preset: in capitals on the FM-1) */
    pt_name(2, "ABCDEFGHIJKLMNOPQRST");
    pal_ui_changed();
    loop();
    pt_home(1);
    later(400);
    check("the overview: 2 BRIGHT PAD | 808 KIT, 4 WARM | CANVAS MISSING (in capitals); with no preset the patch alone, EMPTY as before",
          pal_view && on_screen("2 BRIGHT PAD" MSG_PAL_SEP "808 KIT") && on_screen("4 WARM" MSG_PAL_SEP "CANVAS" MSG_PAL_ROW_MISSING)
          && on_screen("1 MONOLITH D") && !on_screen("1 MONOLITH D" MSG_PAL_SEP) && on_screen("5 " MSG_PAL_ROW_EMPTY));
    snap_to(getenv("PAL_SNAP_PRESET"));
    {
        char lb[PAL_LABEL], *e;
        uint32_t pn;
        e = pal_label(lb, 2, PAL_ROW_W - text_w(&FONT_S, "3 ", -1));
        pn = (uint32_t)(e - lb) - (uint32_t)strlen("SHIMMERING GLASS" MSG_PAL_SEP);
        check("  a 16-character preset and a 20-character patch: the preset whole, the patch shortened, filling the row",
              !strncmp(lb, "SHIMMERING GLASS" MSG_PAL_SEP, strlen("SHIMMERING GLASS" MSG_PAL_SEP)) && pn >= PAL_FIT_MIN
              && pn < PAL_NAME && !strncmp(lb + (e - lb) - pn, "ABCDEFGHIJKLMNOPQRST", pn)
              && text_w(&FONT_S, lb, -1) <= PAL_ROW_W - text_w(&FONT_S, "3 ", -1)
              && on_screen("3 SHIMMERING GLASS" MSG_PAL_SEP "ABCDEFGH"));
        pt_name(2, "SILVER BOX");
        e = pal_label(lb, 2, PAL_ROW_W - text_w(&FONT_S, "3 " MSG_PAL_ROW_NEXT, -1));
        check("  with a 10-character patch both whole, NEXT too", !strcmp(lb, "SHIMMERING GLASS" MSG_PAL_SEP "SILVER BOX"));
        e = pal_label(lb, 2, 1);
        check("  never below 8 characters of each", !strcmp(lb, "SHIMMERI" MSG_PAL_SEP "SILVER B") && *e == 0);
    }
    pt_home(0);
    pal_next = 1;
    pal_ui_changed();
    loop();
    check("a switch waiting: the bar says NEXT: 2 BRIGHT PAD | 808 KIT", bar_shows(MSG_PAL_NEXT "2 BRIGHT PAD" MSG_PAL_SEP "808 KIT", C_ACC));
    pt_pname(1, "SHIMMERING GLASS");
    pt_name(1, "ABCDEFGHIJKLMNOPQRST");
    pal_ui_changed();
    loop();
    {
        char lb[PAL_LABEL];
        (void)pal_label(lb, 1, 236u - text_w(&FONT_S, MSG_PAL_NEXT "2 ", -1));
        snprintf(want, sizeof want, "%s2 %s", MSG_PAL_NEXT, lb);
        check("  the longest names: the preset whole, the patch shortened to the bar", bar_shows(want, C_ACC)
              && !strncmp(lb, "SHIMMERING GLASS" MSG_PAL_SEP "ABCDEFGH", strlen("SHIMMERING GLASS" MSG_PAL_SEP "ABCDEFGH"))
              && strlen(lb) < strlen("SHIMMERING GLASS" MSG_PAL_SEP "ABCDEFGHIJKLMNOPQRST"));
    }
    pal_next = PAL_NONE;
    pal_ui_changed();
    loop();

    /* the editor's copy put in line (panel_align): HOME held there, then let go there */
    {
        uint8_t g[GUIDE_BYTES];
        check("(a second page)", pt_second_page());
        dev = pg_cur_dev;
        guide_state(g, 1);
        g[8] |= 1u << (BTN_HOME - 8u);
        panel_align(g);
        loop();
        later(400);
        check("panel_align: HOME held on the FM-1: the copy's overview after 300 ms", (panel_held >> BTN_HOME & 1u) && pal_view);
        pal_requests = pal_saves = 0;
        pt_key(k3, 1);
        later(300);
        g[8] &= (uint8_t)~(1u << (BTN_HOME - 8u));
        panel_align(g);
        loop();
        check("  HOME let go there: the overview closes, no home_tap (the page stays)", !pal_view && !lcd_ovl
              && !(panel_held >> BTN_HOME & 1u) && page == 0u && pg_cur_dev == dev && pg_cur_page == 1u);
        later(1000);
        req = pal_requests;
        pt_key(k3, 0);
        check("  the palette key held on: no save, its release a tap", !pal_saves && req == 0 && pal_requests == 1);
    }
    memset(pal_ix, 0, sizeof pal_ix);
    pal_cur = pal_next = PAL_NONE;
    pal_ui_changed();
    later(NUDGE_MS + 100u);
}
