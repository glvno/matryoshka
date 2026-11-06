/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* #532, part of panel_test.c (its helpers): step record on the SEQ page (D-804..D-808; the owner's REC gestures of
 * 2026-11-02). REC held + a white key starts it on that step, REC tapped while stopped on the first step of the page shown
 * (never where the cursor last was); on the roll SEL held + any key is the pen (nothing written); the
 * keys play and write chords, LFO a rest or a tie, FX the accent, K4 the cursor, black key 10 back, the cursor wraps and
 * pages the view; stopped and running; REC, HOME, SEQ, ALGO end it; PLAY makes it a live take. On <7PH's PATTERN (the
 * roll) and the 808 Kit's DRUMS (a drum grid). PANEL_SNAP_STEPREC / PANEL_SNAP_STEPREC_DRUM write the screens. */

#define K_C4 7u                                         /* note keys (0 = F3): C4 E4 G4 D4 F4 B3 */
#define K_E4 11u
#define K_G4 14u
#define K_D4 9u
#define K_F4 12u
#define K_B3 6u

static uint32_t sr_held;                                /* the keys held, as panel_keys takes them */
static void sr_down(uint32_t n) { sr_held |= 1u << n; panel_keys(sr_held); loop(); }
static void sr_up(uint32_t n) { sr_held &= ~(1u << n); panel_keys(sr_held); loop(); }
static void sr_tap_key(uint32_t n) { sr_down(n); sr_up(n); }
/* REC held, the white key of step k (on the page shown) pressed, REC let go, then the key */
static void sr_begin(int k)
{
    uint32_t n;
    for (n = 0; seq_white(n) != k % 16; n++)
        ;
    panel_held |= 1u << BTN_REC;
    panel_edges(1u << BTN_REC, 0);
    sr_down(n);
    panel_held &= ~(1u << BTN_REC);
    panel_edges(0, 1u << BTN_REC);
    loop();
    sr_up(n);
}
/* the controls sheet's rows of the state now each fit the card (the description from x 124, or after parts that pass
 * it, to 222) */
static const char *sr_rows[HC_ROWS];
static int sheet_fits(void)
{
    uint32_t n = help_rows(0, sr_rows), i, ok = 1;
    for (i = 0; i < n; i++) {
        uint32_t x = help_row(HC_X0, 0, sr_rows[i], HC_AC, 0), dx = x > HC_AC ? x + 2u : HC_AC;
        ok &= dx + text_w(&FONT_S, strchr(sr_rows[i], '~') + 1, -1) <= 222u;
    }
    return (int)ok;
}
/* the track's note of this pitch starting on step k: its length (0 none) and velocity */
static uint32_t sr_len_at(int mod, uint32_t k, uint32_t note)
{
    uint32_t w = eng_steps_note((uint32_t)mod, k, note);
    return w ? ((w >> 6) & 63u) + 1u : 0u;
}
static uint32_t sr_vel_at(int mod, uint32_t k, uint32_t note) { return (eng_steps_note((uint32_t)mod, k, note) >> 19) & 127u; }
static int sr_notes(int mod)
{
    const uint32_t *w;
    return eng_steps_notes((uint32_t)mod, &w);
}
static void sr_empty(int mod)
{
    static const uint32_t none[1];
    (void)eng_steps_set_notes((uint32_t)mod, none, 0);
    seq_sync(mod);
}
/* the grid below the bar = the same drawn whole */
static int sr_whole_same(void)
{
    static uint16_t was[240 * 240];
    uint32_t i, n = 0;
    memcpy(was, fb, sizeof was);
    ui_dirty = 2;
    loop();
    for (i = 240u * BAR_H; i < 240u * 240u; i++)
        n += was[i] != fb[i];
    if (n)
        printf("      (%u pixels differ from a whole draw)\n", (unsigned)n);
    return !n;
}

static void steprec_suite(void)
{
    int pat, drums, map;
    uint32_t told, y, cx, cy;
    uint8_t th0;
    while (page != 0u && trail_n)
        tap(BTN_HOME);
    if (eng_transport_running())
        tap(BTN_PLAY);
    check("(step record: <7PH loads, PATTERN is its melodic track)", !load("<7PH") && eng_steps_count() == 2
          && eng_steps_drummap((uint32_t)eng_steps_module(1)) < 0);
    pv_gen++;
    page = 0;
    trail_n = 0;
    screen_idle();
    octave = 0;
    pat = eng_steps_module(1);
    sr_empty(pat);
    seq_select(1);
    page_set(PAGE_SEQ);
    later(1500);
    sr_held = 0;

    /* REC tapped, stopped: step record on step 1, REC again ends it, the transport stays stopped */
    th0 = thru_head;
    tap(BTN_REC);
    check("REC, stopped, on the SEQ page: step record on step 1, the transport stays stopped, nothing recorded live",
          sr_on && sr_k == 0u && !eng_transport_running() && !seq_rec && thru_head == th0);
    check("  REC's LED lit", host_led_mask(fm1_led, 0) >> BTN_REC & 1u);
    tap(BTN_REC);
    check("REC again: step record ends, the page stays, still stopped", !sr_on && page == PAGE_SEQ && !eng_transport_running()
          && !seq_rec && !(host_led_mask(fm1_led, 0) >> BTN_REC & 1u));

    /* start: REC held + the white key of step 3 */
    told = host_track_told;
    th0 = thru_head;
    sr_begin(2);
    later(1100);
    check("REC held + the white key of step 3: step record on step 3, nothing written or heard, the step not switched",
          sr_on && sr_k == 2u && sr_notes(pat) == 0 && host_track_told == told && seq_held < 0 && thru_head == th0
          && !eng_transport_running() && !seq_rec);
    check("  the bar says STEP 3 first, then the roll's pitches", bar_shows("STEP 3/16  PATTERN ARM G#3-D#4 P01", C_ACC));
    cx = seq_grid_x(2) + 5u;
    cy = GRID_Y + GRID_RH * 1u + GRID_CH - 1u;
    check("  the cursor's column: its empty cells tinted, a sky tick under it; the next column plain",
          px(cx, cy) == C_CUR && px(cx, GRID_CUR_Y) == P_SKY && px(seq_grid_x(3) + 5u, cy) != C_CUR && px(seq_grid_x(3) + 5u, GRID_CUR_Y) == C_BG);
    check("  the hint line: the keys, LFO, K4, REC; the track line black key 10", !strcmp(seq_grid_text[2], HINT_STEP_RECORD)
          && text_w(&FONT_S, seq_grid_text[2], -1) <= 228u && strstr(seq_grid_text[1], "BLACK 10 del"));
    check("  drawn in place = drawn whole", sr_whole_same());

    /* a chord, a tie of only the key still held, a key added after the tie (the issue's example) */
    th0 = thru_head;
    sr_down(K_C4);
    sr_down(K_E4);
    sr_down(K_G4);
    check("C4 E4 G4 held: each sounds through the track, nothing written yet", thru_heard(th0, (uint32_t)pat, 60u)
          && thru_heard(th0, (uint32_t)pat, 64u) && thru_heard(th0, (uint32_t)pat, 67u) && sr_notes(pat) == 0 && sr_k == 2u);
    check("  their LEDs bright", (host_led_mask(fm1_led, 14) & (1u << K_C4 | 1u << K_E4 | 1u << K_G4)) == (1u << K_C4 | 1u << K_E4 | 1u << K_G4));
    sr_up(K_E4);
    sr_up(K_G4);
    check("E4 and G4 let go, C4 held: nothing written, the cursor stays", sr_notes(pat) == 0 && sr_k == 2u);
    tap(BTN_LFO);
    check("LFO with C4 held: the cursor on step 4, C4 goes on through it, E4 and G4 one step", sr_k == 3u
          && sr_len_at(pat, 2, 60) == 2u && sr_len_at(pat, 2, 64) == 1u && sr_len_at(pat, 2, 67) == 1u);
    check("  LFO's patch job not touched (no NOT USED message)", !strstr(msg_text, "NOT USED"));
    sr_tap_key(K_D4);
    check("D4 pressed and let go while C4 is held: added on the cursor's step (4), the cursor stays", sr_k == 3u
          && sr_len_at(pat, 3, 62) == 0u);
    told = host_track_told;
    sr_up(K_C4);
    check("C4 let go: the chord written (C4 2 steps, E4 G4 on step 3, D4 on step 4), the cursor on step 5, the editor told",
          sr_k == 4u && sr_notes(pat) == 4 && sr_len_at(pat, 2, 60) == 2u && sr_len_at(pat, 2, 64) == 1u && sr_len_at(pat, 2, 67) == 1u
          && sr_len_at(pat, 3, 62) == 1u && sr_vel_at(pat, 2, 60) == STEP_VEL && host_track_told > told);
    check("  the cursor's tick moved to step 5", px(seq_grid_x(4) + 5u, GRID_CUR_Y) == P_SKY && px(seq_grid_x(2) + 5u, GRID_CUR_Y) == C_BG);

    /* a rest, an accent */
    tap(BTN_LFO);
    check("LFO with no key held: a rest, the cursor on step 6", sr_k == 5u && sr_notes(pat) == 4);
    panel_held |= 1u << BTN_ACC;
    sr_tap_key(K_F4);
    panel_held &= ~(1u << BTN_ACC);
    check("FX held + F4: an accented note (127) on step 6, the cursor on step 7", sr_vel_at(pat, 5, 65) == ACCENT_VEL && sr_k == 6u);

    /* K4: the cursor, nothing written; a step replaced */
    told = host_track_told;
    enc(5, -3);
    check("K4 three clicks left: the cursor on step 4, nothing written", sr_k == 3u && host_track_told == told && sr_notes(pat) == 5);
    sr_tap_key(K_B3);
    check("B3 on step 4: the step replaced (D4 gone), C4's tie through it cut, the cursor on step 5",
          sr_len_at(pat, 3, 59) == 1u && !sr_len_at(pat, 3, 62) && sr_len_at(pat, 2, 60) == 1u && sr_k == 4u);

    /* black key 10: back one, that step cleared */
    th0 = thru_head;
    sr_tap_key(SR_BACK);
    check("black key 10: back to step 4, its B3 cleared, the rest kept; it sounds nothing", sr_k == 3u && !sr_len_at(pat, 3, 59)
          && sr_notes(pat) == 4 && thru_head == th0);
    sr_tap_key(SR_BACK);
    check("black key 10 again: back to step 3, its chord cleared", sr_k == 2u && sr_notes(pat) == 1 && sr_len_at(pat, 5, 65) == 1u);

    /* the octave */
    tap(BTN_OCT_UP);
    check("OCT+ in step record: the keys' octave (the page stays)", octave == 1 && seq_pg == 0u && sr_on);
    sr_tap_key(K_C4);
    check("  C4's key at octave +1 writes C5 on step 3", sr_len_at(pat, 2, 72) == 1u && sr_k == 3u);
    tap(BTN_OCT_DOWN);

    /* the pen in step record (the owner on the rig, 2026-11-02): SEL held + any key, white or black, jumps the roll to
     * that key's pitch (its fixed page when off screen, D-809) and sounds it; nothing is written, the cursor stays, and
     * SEL's release opens no SONG page. Before: the key wrote its note off screen and SEL's release opened the SONG page */
    {
        int before = sr_notes(pat);
        uint32_t k0 = sr_k;
        later(1100);
        panel_held |= 1u << BTN_SEL;
        panel_edges(1u << BTN_SEL, 0);
        loop();
        steps_inst((uint32_t)pat)->s.stp.hit = 0;
        sr_tap_key(K_G4);
        later(1100);
        check("SEL held + G4's white key in step record: the pen, the view on G4's page (E4-B4), the row G4, heard, nothing written, the cursor stays",
              sr_on && seq_roll_lo == 64u && seq_grid_note(-1, seq_row) == 67u && steps_inst((uint32_t)pat)->s.stp.hit
              && sr_notes(pat) == before && sr_k == k0 && bar_shows("STEP 4/16  PATTERN ARM E4-B4 P01", C_ACC));
        sr_tap_key(1u);                                 /* black key 1: F#3 */
        check("  SEL + black key 1: its own pitch (F#3), not a row; the view on C3-G3, nothing written", seq_roll_lo == 48u
              && seq_grid_note(-1, seq_row) == 54u && sr_notes(pat) == before && sr_k == k0);
        sr_tap_key(3u);                                 /* G#3: back on G#3-D#4 */
        panel_held &= ~(1u << BTN_SEL);
        panel_edges(0, 1u << BTN_SEL);
        loop();
        check("  SEL let go: no SONG page, step record goes on (G#3-D#4 again)", page == PAGE_SEQ && sr_on && seq_roll_lo == 56u
              && sr_notes(pat) == before && sr_k == k0);
        check("  drawn in place = drawn whole", sr_whole_same());
        oct_pair();
        check("  the step record sheet on the roll: SEL + any key jumps to a pitch; every row fits", help_on && help_state() == HS_STEP
              && on_screen("jump to pitch") && sheet_fits());
        tap(BTN_HOME);
    }

    /* the wrap at the pattern's end, a tie there, then a longer pattern: the view pages with the cursor */
    {
        int32_t len = seq_len(pat);
        enc(5, (int32_t)(len - 1) - (int32_t)sr_k);
        check("K4 to the last step", (int32_t)sr_k == len - 1);
        sr_tap_key(K_E4);
        later(1100);
        check("a note on the last step: the cursor wraps to step 1, the bar says STEP 1; E4 was off the view, which moved to its page (#582)",
              sr_len_at(pat, (uint32_t)len - 1u, 64) == 1u && sr_k == 0u && seq_roll_lo == 64u
              && bar_shows("STEP 1/16  PATTERN ARM E4-B4 P01", C_ACC));
        enc(5, -1);
        sr_down(K_G4);
        tap(BTN_LFO);
        check("keys held + LFO on the last step: no tie past the end, the note one step, the cursor on step 1",
              sr_len_at(pat, (uint32_t)len - 1u, 67) == 1u && sr_k == 0u && !strcmp(msg_text, "NO TIE PAST THE END"));
        sr_up(K_G4);
        check("  G4 let go then: nothing more (the cursor stays on step 1)", sr_k == 0u && sr_len_at(pat, (uint32_t)len - 1u, 67) == 1u);
        eng_set_param((uint32_t)pat, STEPS_P_LEN, 32 << 16);
        loop();
        enc(5, 17);
        later(1100);
        check("a 32-step track: K4 to step 18, the view shows steps 17-32", seq_len(pat) == 32 && sr_k == 17u && seq_pg == 1u
              && px(seq_grid_x(1) + 5u, GRID_CUR_Y) == P_SKY && bar_shows("STEP 18/32  PATTERN ARM E4-B4 P01", C_ACC));
        enc(5, -2);
        check("  K4 back to step 16: the view shows steps 1-16", sr_k == 15u && seq_pg == 0u && px(seq_grid_x(15) + 5u, GRID_CUR_Y) == P_SKY);
        check("  drawn in place = drawn whole", sr_whole_same());
        eng_set_param((uint32_t)pat, STEPS_P_LEN, len << 16);
        enc(5, 1);
        loop();
        check("  the 16-step track again: the cursor wrapped to step 1", sr_k == 0u && seq_pg == 0u);
    }

    /* while the transport plays (PLAY first, then REC held + a white key): the cursor is not the playhead */
    tap(BTN_HOME);
    tap(BTN_PLAY);
    blocks(200);
    loop();
    sr_begin(0);
    sr_tap_key(K_D4);
    check("running: D4 written on the cursor's step (1), wherever the playhead is", eng_transport_running() && sr_on
          && sr_len_at(pat, 0, 62) == 1u && sr_k == 1u);
    ui_dirty = 2;
    loop();
    snap_to(getenv("PANEL_SNAP_STEPREC"));
    tap(BTN_PLAY);
    check("  PLAY then stops the transport, step record goes on", sr_on && !eng_transport_running() && !seq_rec);

    /* the controls sheet follows */
    oct_pair();
    check("OCT- + OCT+: the controls sheet says STEP RECORD", help_on && help_state() == HS_STEP && on_screen("STEP RECORD")
          && on_screen("one chord"));
    check("  every row fits the card", sheet_fits() && help_rows(0, (const char **)sr_rows) <= HC_VIS + 2u);
    tap(BTN_HOME);
    check("  HOME closes the sheet; step record goes on", !help_on && sr_on && page == PAGE_SEQ);

    /* leaving: HOME, SEQ, ALGO, REC; REC on refuses it */
    tap(BTN_HOME);
    check("HOME: step record ends, the page stays", !sr_on && page == PAGE_SEQ);
    check("  the piano roll's sheet: REC and REC + a white key, SELECT's pages, SEL + SELECT; every row fits", help_state() == HS_ROLL
          && sheet_fits() && help_rows(0, sr_rows) > 0u);
    later(1100);
    check("  the bar without STEP, the cursor's tick gone", bar_shows("PATTERN ARM G#3-D#4 P01", C_ACC) && px(seq_grid_x(1) + 5u, GRID_CUR_Y) == C_BG
          && strstr(seq_grid_text[1], "ALGO track"));
    tap(BTN_REC);
    check("REC, stopped: step record on the page's first step (1), not the cursor's last step (2)", sr_on && sr_k == 0u
          && !eng_transport_running());
    tap(BTN_HOME);
    {                                                   /* steps 17-32 shown: REC starts on step 17 */
        int32_t len = seq_len(pat);
        eng_set_param((uint32_t)pat, STEPS_P_LEN, 32 << 16);
        loop();
        tap(BTN_OCT_UP);
        tap(BTN_REC);
        check("REC with steps 17-32 shown: step record on step 17", seq_pg == 1u && sr_on && sr_k == 16u && !eng_transport_running());
        enc(5, 20);
        tap(BTN_HOME);
        check("  (K4 to step 5 (wrapped), HOME: step record ends; the view on steps 1-16)", !sr_on && sr_k == 4u && seq_pg == 0u);
        tap(BTN_OCT_UP);
        tap(BTN_REC);
        check("  REC again on steps 17-32: step 17, not the cursor's last step (5)", sr_on && sr_k == 16u && seq_pg == 1u);
        tap(BTN_HOME);
        tap(BTN_OCT_DOWN);
        eng_set_param((uint32_t)pat, STEPS_P_LEN, len << 16);
        loop();
    }
    sr_begin(0);
    tap(BTN_SEQ);
    check("SEQ: step record ends, the page stays", !sr_on && page == PAGE_SEQ);
    sr_begin(0);
    enc(1, 1);
    check("ALGO: another track, step record ends", !sr_on && seq_trk == 0u);
    enc(1, 1);
    sr_begin(0);
    tap(BTN_REC);
    check("REC: step record ends, nothing else (stopped, no recording)", !sr_on && !seq_rec && !eng_transport_running());
    tap(BTN_REC);
    check("  (REC: step record again, on step 1)", sr_on && sr_k == 0u && !eng_transport_running());
    {
        int at = mlen;
        tap(BTN_PLAY);
        check("PLAY in step record: the transport starts (MIDI Start out), step record becomes a live take (the roll's keys its keyboard)",
              !sr_on && seq_rec && eng_transport_running() && sent(at, 0xFAu, 0xFFu, 0xFFu) && seq_kbd()
              && (E.trk_rec >> E.node[pat].trk & 1u) && !strcmp(msg_text, "REC PATTERN"));
    }
    tap(BTN_REC);
    check("  REC then, running: the live take ends, the transport goes on (as on every page)", !sr_on && !seq_rec && eng_transport_running());
    sr_begin(4);
    check("REC held + a white key while running: step record on that step (5), the transport goes on", sr_on && sr_k == 4u
          && eng_transport_running() && !seq_rec);
    tap(BTN_REC);
    check("  REC: step record ends; running, nothing records", !sr_on && !seq_rec && eng_transport_running());
    tap(BTN_REC);
    check("REC, running, not in step record: a live take as on every page", seq_rec && !sr_on && seq_kbd());
    sr_begin(5);
    loop();
    check("REC held + a white key while a live take records: the take ends, step record on that step (6)", sr_on && sr_k == 5u
          && !seq_rec && !E.trk_rec && eng_transport_running() && !strcmp(msg_text, "REC OFF: STEP RECORD"));
    tap(BTN_PLAY);
    check("  PLAY while running in step record: the transport stops, step record goes on", sr_on && !eng_transport_running() && !seq_rec);
    tap(BTN_HOME);
    sr_held = 0;
    sr_begin(0);
    tap(BTN_ENV);
    check("another page: step record ends", !sr_on && page == PAGE_ENV);
    tap(BTN_ENV);

    /* a drum grid: the live take's rule (D-805) */
    while (page != 0u && trail_n)
        tap(BTN_HOME);
    check("(the 808 Kit loads: DRUMS into its Drum map)", !load("808 KIT"));
    pv_gen++;
    page = 0;
    trail_n = 0;
    screen_idle();
    drums = eng_steps_module(0);
    map = eng_steps_drummap((uint32_t)drums);
    sr_empty(drums);
    seq_select(0);
    page_set(PAGE_SEQ);
    later(1500);
    sr_begin(0);
    check("the drum grid: REC held + step 1's white key starts step record", sr_on && sr_k == 0u && seq_map() == map);
    sr_stop();
    check("  the drum grid's sheet: every row fits", help_state() == HS_DRUM && sheet_fits());
    sr_begin(0);
    later(1100);
    check("  the drum grid's bar: no pitches", bar_shows("STEP 1/16  DRUMS ARM P01", C_ACC));
    th0 = thru_head;
    sr_down(1);                                         /* black key 1: row 1 (the kick) */
    sr_down(5);                                         /* black key 3: row 3 */
    sr_up(1);
    sr_up(5);
    y = (uint32_t)eng_drummap_note((uint32_t)map, 0);
    check("black keys 1 and 3 together: rows 1 and 3 on step 1, heard, the cursor on step 2", sr_len_at(drums, 0, y) == 1u
          && sr_len_at(drums, 0, (uint32_t)eng_drummap_note((uint32_t)map, 2)) == 1u && sr_notes(drums) == 2 && sr_k == 1u
          && thru_heard(th0, (uint32_t)drums, y));
    sr_tap_key(2);                                      /* a white key: no row (the map does not repeat) */
    sr_tap_key(20);                                     /* black key 9: no row */
    check("a white key and black key 9: silent, nothing written, the cursor stays", !eng_drummap_repeat((uint32_t)map)
          && sr_notes(drums) == 2 && sr_k == 1u);
    panel_held |= 1u << BTN_ACC;
    sr_tap_key(3);                                      /* FX + black key 2: row 2 accented */
    panel_held &= ~(1u << BTN_ACC);
    check("FX + black key 2: row 2 accented on step 2", sr_vel_at(drums, 1, (uint32_t)eng_drummap_note((uint32_t)map, 1)) == ACCENT_VEL
          && sr_k == 2u);
    ui_dirty = 2;
    loop();
    snap_to(getenv("PANEL_SNAP_STEPREC_DRUM"));
    tap(BTN_SEQ);
    check("SEQ: the drum grid's step record ends", !sr_on && page == PAGE_SEQ);
    tap(BTN_REC);
    check("REC, stopped, on the drum grid: step record on the page's first step (1), not the cursor's last (3)", sr_on && sr_k == 0u
          && !eng_transport_running());
    tap(BTN_PLAY);
    check("  PLAY: a live take of the drum track", !sr_on && seq_rec && eng_transport_running() && (E.trk_rec >> E.node[drums].trk & 1u));
    tap(BTN_PLAY);
    {                                                   /* REC held + a black key on the SEQ page: arms as ever, no step record */
        uint64_t was = eng_arm_mask_get();
        panel_held |= 1u << BTN_REC;
        panel_edges(1u << BTN_REC, 0);
        sr_tap_key(1);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("REC held + a black key on the drum grid: the track disarmed, no step record, REC's release does nothing",
              eng_arm_mask_get() != was && !sr_on && !seq_rec && !eng_transport_running() && sr_notes(drums) == 3);
        eng_arm_mask(was);
    }
    tap(BTN_SEQ);
    later(1500);
    sr_held = 0;
}
