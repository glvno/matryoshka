/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* #450, part of panel_test.c (its helpers): the nudges (D-249). A control that cannot act where it is pressed says why in
 * the header, in at most 26 characters: a patch button with no job, PRESET with an empty bank, OCT on a SEQ page of 16
 * steps or fewer, SEL on a device whose keys input no cable reaches (#215), SAVE / REC / SEQ / ENV / SEL in sandbox mode,
 * and MIDI OUT off in sandbox mode. ENV in the settings menu opens the environment. Each nudge ends with the screen as a
 * whole redraw leaves it, and a key edge never draws one (D-228). NUDGE_SNAP=dir writes the screens as PPMs. */

/* the header shows nudge s now, whole, in at most 26 characters */
static int nudged(const char *s)
{
    return !strcmp(msg_text, s) && strlen(s) <= 26u && msg_until > fm1_ms && on_screen(s);
}

/* the nudge ends; the screen then = the same drawn whole */
static int nudge_ends_whole(void)
{
    static uint16_t was[240 * 240];
    uint32_t i, n = 0, f = 0;
    later(NUDGE_MS + 100u);
    loop();
    memcpy(was, fb, sizeof was);
    ui_full = 1;
    loop();
    for (i = 0; i < 240u * 240u; i++)
        if (was[i] != fb[i] && !n++)
            f = i;
    if (n)
        printf("      (%u pixels differ, the first at x %u y %u)\n", (unsigned)n, (unsigned)(f % 240u), (unsigned)(f / 240u));
    return !n && !msg_until;
}

/* NUDGE_SNAP=dir: the screen now as dir/2026-11-01-nudge-<name>.ppm */
static void nudge_snap(const char *name)
{
    char path[512];
    const char *d = getenv("NUDGE_SNAP");
    if (!d)
        return;
    snprintf(path, sizeof path, "%s/2026-11-01-nudge-%s.ppm", d, name);
    snap_to(path);
}

static void nudge_suite(void)
{
    uint32_t p, b = 0, d, found = 0;
    int stepped, sv;
    uint64_t bank0 = bank_mask, arm0;
    char want[96];
    static const uint8_t B[4] = {0, 3, 4, 6};          /* FX, LFO, EDIT, ARP */

    for (p = 0; p < N_PRESETS && !found; p++) {        /* a factory patch with a patch button that has no job */
        uint32_t i;
        if (load_at(p))
            continue;
        for (i = 0; i < 4u && !found; i++)
            if (!panel_btn_job(B[i])) {
                b = B[i];
                found = 1;
            }
    }
    check("(a factory patch with a patch button that has no job)", found);
    p--;
    patch_label = PRESET_LIST[p].name;
    cur_preset = p;
    pv_gen++;
    trail_n = 0;
    page_show(0);
    screen_patch();
    later(2000);
    if (eng_transport_running())
        tap(BTN_PLAY);
    put(put(want, PANEL_BTN_NAME[b]), ": NOT USED IN PATCH")[0] = 0;
    tap(PANEL_BTN_ID[b]);
    printf("      (%s: %s)\n", PRESET_LIST[p].name, want);
    check("a patch button with no job: it names itself, NOT USED IN PATCH (D-249)", nudged(want));
    nudge_snap("button");
    check("  the nudge ends: the screen as a whole redraw", nudge_ends_whole());
    {                                                   /* a button with a job says what it did, as before */
        uint32_t i, j = 4u;
        for (i = 0; i < 4u; i++)
            if (panel_btn_job(B[i]))
                j = i;
        if (j < 4u) {
            tap(PANEL_BTN_ID[B[j]]);
            check("  a patch button with a job: no nudge, its state", strstr(msg_text, "NOT USED") == 0
                  && (strstr(msg_text, " ON") || strstr(msg_text, " OFF")));
            tap(PANEL_BTN_ID[B[j]]);
            later(1500);
        }
    }

    stepped = presets_stepped;                          /* PRESET with an empty bank (#212) */
    bank_mask = 0;
    patch_enc(1);
    loop();
    check("HOME + PRESET, the bank empty: BANK EMPTY, no patch stepped", presets_stepped == stepped && nudged("BANK EMPTY"));
    nudge_snap("bank-empty");
    check("  the nudge ends: the screen as a whole redraw", nudge_ends_whole());
    tap(BTN_GLO);
    enc(6, 1);
    check("  PRESET in the menu, the bank empty: BANK EMPTY", page == PAGE_MENU && presets_stepped == stepped && nudged("BANK EMPTY"));
    later(NUDGE_MS + 100u);
    bank_mask = bank0;

    enc(1, -1);                                         /* (MIDI back round to GUIDE) */
    check("(the menu's GUIDE tab)", page == PAGE_MENU && menu_tab == MT_GUIDE);
    nudge_snap("guide-env-before");
    tap(BTN_ENV);                                       /* ENV in the settings menu: the environment (D-249) */
    check("ENV in the settings menu opens the environment", page == PAGE_ENV && trail_n == 2);
    tap(BTN_HOME);
    check("  HOME: back to the menu, on the tab it was on", page == PAGE_MENU && menu_tab == MT_GUIDE && on_screen("PRESS OCT- + OCT+"));
    tap(BTN_HOME);
    check("  HOME: the device page", page == 0u);

    check("(808 KIT for the SEQ page)", load("808 KIT") == 0);
    pv_gen++;
    trail_n = 0;
    page_show(0);
    screen_patch();
    later(2000);
    if (eng_transport_running())
        tap(BTN_PLAY);
    tap(BTN_SEQ);
    later(300);
    {
        int oct = octave, pg = seq_pg;
        check("(the SEQ page on a track of 16 steps or fewer)", page == PAGE_SEQ && seq_module() >= 0 && seq_len(seq_module()) <= 16);
        tap(BTN_OCT_UP);
        check("OCT+ on a SEQ page of 16 steps: ALL 16 STEPS SHOWN, no page, no octave", nudged("ALL 16 STEPS SHOWN")
              && seq_pg == pg && octave == oct);
        nudge_snap("seq-16");
        tap(BTN_OCT_DOWN);
        check("  OCT- the same", nudged("ALL 16 STEPS SHOWN") && seq_pg == pg && octave == oct);
        check("  the nudge ends: the screen as a whole redraw", nudge_ends_whole());
    }
    tap(BTN_SEQ);

    check("(the arm-unreached fixture: two Voicings, one on Main's keys, a Drum map with no keys cable)",
          load_fixture("build/panel-fixtures/arm-unreached.m1p") == 0);
    patch_label = "ARM UNREACHED";
    pv_gen++;
    trail_n = 0;
    page_show(0);
    screen_patch();
    later(2000);
    pages_ensure();
    {
        uint32_t reach = 0, none = 0;
        for (d = 0; d < pg_ndev; d++) {
            int m = pg_dev[d].module, t = m >= 0 ? eng_type((uint32_t)m) : -1;
            if (t != T_DRUMMAP && t != T_MIXER)
                continue;
            pages_focus(d, 0);
            loop();
            later(1500);
            arm0 = eng_arm_mask_get();
            tap(BTN_SEL);
            if (t == T_MIXER) {
                check("SEL on a device with no keys input: NOTHING HERE TAKES KEYS (D-235), the armed set kept",
                      nudged("NOTHING HERE TAKES KEYS") && eng_arm_mask_get() == arm0);
                none++;
            } else {
                check("SEL on a Drum map no keys cable reaches: NO KEYS REACH THIS DEVICE (#215), the armed set kept",
                      !env_listeners(d) && nudged("NO KEYS REACH THIS DEVICE") && eng_arm_mask_get() == arm0);
                nudge_snap("no-keys");
                check("  the nudge ends: the screen as a whole redraw", nudge_ends_whole());
                reach++;
            }
        }
        check("  (each kind seen: the Drum map, the Mixer)", reach == 1u && none == 1u);
        tap(BTN_ENV);                                   /* the same on an environment row */
        for (d = 0; d < pg_ndev; d++)
            if (pg_dev[d].module >= 0 && eng_type((uint32_t)pg_dev[d].module) == T_DRUMMAP)
                break;
        while (pg_cur_dev != d && pg_cur_dev < pg_ndev) {
            uint32_t was = pg_cur_dev;
            enc(0, pg_cur_dev < d ? 1 : -1);
            if (pg_cur_dev == was)
                break;
        }
        tap(BTN_SEL);
        check("  on its environment row too", page == PAGE_ENV && pg_cur_dev == d && nudged("NO KEYS REACH THIS DEVICE"));
        tap(BTN_HOME);
    }

    check("(ORACLE V for sandbox mode)", load("ORACLE V") == 0);   /* sandbox mode's nudges (D-232) */
    patch_label = "ORACLE V";
    pv_gen++;
    trail_n = 0;
    page_show(0);
    screen_patch();
    later(2000);
    cfg.midi_out = 1;
    m1_live(1);
    loop();
    check("(sandbox mode)", sb_on && page == 0u);
    {
        static const struct { uint32_t id; const char *say; } SBN[5] = {
            {BTN_SEQ, "SANDBOX: SEQ IN EDITOR"}, {BTN_ENV, "SANDBOX: ENV IN EDITOR"}, {BTN_REC, "SANDBOX: REC IN EDITOR"},
            {BTN_SAVE, "SANDBOX: SAVE IN EDITOR"}, {BTN_SEL, "SANDBOX: ARM IN EDITOR"}};
        uint32_t i;
        for (i = 0; i < 5u; i++) {
            int from = mlen;
            sv = saved;
            m1_live(1);
            tap(SBN[i].id);
            snprintf(want, sizeof want, "%s in sandbox mode: %s, its CC out, nothing here", i == 3u ? "SAVE" : i == 4u ? "SEL"
                     : i == 2u ? "REC" : i == 1u ? "ENV" : "SEQ", SBN[i].say);
            check(want, nudged(SBN[i].say) && sent(from, 0xB0u, BTN_CC[SBN[i].id], 127u) && page == 0u && saved == sv
                  && !seq_rec && sb_on);
            if (i == 0u)
                nudge_snap("sandbox-seq");
        }
        m1_live(1);
        check("  the nudge ends: the screen as a whole redraw", nudge_ends_whole());
        m1_live(1);
        tap(BTN_GLO);                                   /* the menu in sandbox mode: ENV nudges, SAVE keeps its job */
        tap(BTN_ENV);
        check("  ENV in the menu in sandbox mode: the nudge, the environment does not open (D-232)", page == PAGE_MENU
              && nudged("SANDBOX: ENV IN EDITOR"));
        sv = saved;
        tap(BTN_SAVE);
        check("  SAVE in the menu in sandbox mode: saves and closes it", saved == sv + 1 && page == 0u);
    }
    later(NUDGE_MS + 100u);
    m1_live(1);
    cfg.midi_out = 0;                                   /* MIDI OUT off: nothing reaches the editor */
    tap(BTN_SEQ);
    check("SEQ in sandbox mode, MIDI OUT off: TURN ON MIDI OUT: GLO, K3", nudged("TURN ON MIDI OUT: GLO, K3"));
    nudge_snap("midi-out");
    later(NUDGE_MS + 100u);
    m1_live(1);
    msg_text[0] = 0;
    msg_until = 0;
    panel_keys(1u);                                     /* a key: the nudge waits for the loop (D-228) */
    check("  a key: no nudge drawn by the key edge", msg_text[0] == 0);
    panel_keys(0u);
    loop();
    check("  ... the loop shows it", nudged("TURN ON MIDI OUT: GLO, K3"));
    later(NUDGE_MS + 100u);
    m1_live(1);
    enc(2, 1);
    check("  K1: the nudge", nudged("TURN ON MIDI OUT: GLO, K3"));
    m1_live(1);
    check("  the nudge ends: the screen as a whole redraw", nudge_ends_whole());
    m1_live(0);
    loop();
    check("(sandbox mode ends)", !sb_on);
    m1_live(1);                                         /* sandbox mode begins with MIDI OUT off: the nudge at once */
    loop();
    check("sandbox mode begins, MIDI OUT off: the nudge at once", sb_on && nudged("TURN ON MIDI OUT: GLO, K3"));
    m1_live(0);
    loop();
    cfg.midi_out = 1;
    later(NUDGE_MS + 100u);
}
