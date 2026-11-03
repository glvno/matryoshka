/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* #549, part of panel_test.c (its helpers): what the FM-1 reports to the editor so its copy of the panel logic stays in
 * step. Every key edge panel_key takes goes to the KEYS_NOW hook with the keys and buttons held; guide_state (GUIDE_NOW)
 * says the state, page, step record and its cursor, the sheet; panel_align puts a copy that missed inputs back where
 * the FM-1 is, from those bytes alone, without playing an edge. On <7PH (its PATTERN: the roll). */

static void report_suite(void)
{
    uint8_t a[GUIDE_BYTES], b[GUIDE_BYTES];
    int pat, n0, same, i;
    uint32_t told;
    while (page != 0u && trail_n)
        tap(BTN_HOME);
    if (eng_transport_running())
        tap(BTN_PLAY);
    if (help_on)
        help_close();
    check("(reports: <7PH loads)", !load("<7PH") && eng_steps_count() == 2);
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

    /* KEYS_NOW: a step's white key on the SEQ page, then REC held + a white key: each edge with the keys and buttons */
    n0 = kr_n = 0;
    sr_tap_key(0);
    check("a white key on the SEQ page: its press and release reported (KEYS_NOW), keys held then and after",
          kr_n == n0 + 2 && kr_key[n0] == 0u && kr_down[n0] && kr_keys[n0] == 1u && !kr_down[n0 + 1] && kr_keys[n0 + 1] == 0u);
    sr_empty(pat);
    n0 = kr_n = 0;
    sr_begin(2);
    check("REC held + step 3's white key: the edge reported with REC held", kr_n >= n0 + 1 && kr_down[n0]
          && (kr_held[n0] >> BTN_REC & 1u) && sr_on && sr_k == 2u);

    /* GUIDE_NOW's bytes in step record */
    guide_state(a, 1);
    check("guide_state in step record: STEP RECORD, the SEQ page, step record on, its cursor, the track",
          a[0] == HS_STEP && a[1] == PAGE_SEQ && (a[2] & 1u) && a[13] == 2u && a[5] == 1u && !(a[2] & 16u));
    check("  the conditions: a melodic track (the roll), the patch has tracks", ((a[9] | a[10] << 8) >> HC_ROLL & 1)
          && ((a[9] | a[10] << 8) >> HC_TRACKS & 1));

    /* a copy that missed it all (on the device page, step record off) put back in line: the same bytes again */
    told = host_track_told;
    sr_stop();
    while (page != 0u && trail_n)
        tap(BTN_HOME);
    check("(the copy on the device page, step record off)", page == 0u && !sr_on);
    panel_align(a);
    loop();
    guide_state(b, 1);
    for (same = 1, i = 0; i < (int)GUIDE_BYTES; i++)
        same &= a[i] == b[i];
    check("panel_align: back on the SEQ page in step record on step 3, its state the FM-1's byte for byte, nothing told",
          same && page == PAGE_SEQ && sr_on && sr_k == 2u && host_track_told == told);
    tap(BTN_HOME);
    check("  HOME then ends step record, the page stays (as on the FM-1)", !sr_on && page == PAGE_SEQ);

    /* the sheet and a button held: the FM-1 opened the sheet and holds SEL */
    guide_state(a, 1);
    a[2] |= 16u;
    a[7] = (uint8_t)(1u << BTN_SEL);
    panel_align(a);
    loop();
    check("panel_align: the sheet opens, SEL taken as held (no edge played: no SONG page)", help_on == HELP_SHEET
          && (panel_held >> BTN_SEL & 1u) && page == PAGE_SEQ && !sr_on);
    a[2] &= (uint8_t)~16u;
    a[7] = 0;
    panel_align(a);
    loop();
    check("  and closes, SEL let go without its release's job (still the SEQ page)", !help_on && !(panel_held >> BTN_SEL & 1u)
          && page == PAGE_SEQ);
    tap(BTN_SEQ);
    later(300);
}
