/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The palette on the panel (#1196, palette.h): HOME + a black key 1..8 tapped switches to that position, held 1 s saves
 * the running sound there; HOME held alone shows the overview of the eight positions. panel.c takes the keys while HOME
 * is held (panel_key: state only, a key edge never draws, D-228) and acts on them from the loop (panel_status: pal_poll);
 * the switch and the save are palette.c's (pal_request, pal_save; the FM-1 tab's copy: its imports, fm1_ui.c). The
 * overview is a card over the dimmed page as the controls sheet is (help_ui.c: its geometry, lcd_ovl.h); its last line
 * shows the bar's message meanwhile, which the card covers. Needs ui.c and help_ui.c before it, panel.c after it. */

#define PAL_KEY_NONE 0xFFu
#define PAL_NUDGE_MS 1500u                          /* (panel.c NUDGE_MS: a nudge's time, D-249) */
#define PAL_ROW_W (HC_IW - (HC_X0 - HC_IX) - 2u)   /* an overview row's text: 196 px */
static uint8_t pal_view;                            /* the overview shows */
static uint8_t pal_due;                             /* the overview to draw: 1 its rows and last line, 2 all of it */
static uint8_t pal_shut;                            /* no overview until HOME's next press (another combo used this hold) */
static uint32_t pal_home_ms;                        /* fm1_ms of HOME's press */
static uint8_t pal_key = PAL_KEY_NONE;              /* the palette key held (its key number), whose release taps */
static uint32_t pal_key_t0;                         /* fm1_ms of its press */
static uint8_t pal_timing;                          /* its hold is timed (HOME still down since the press) */
static uint8_t pal_fired;                           /* its hold saved: its release does nothing */
static uint32_t pal_taken;                          /* bit n: key n went down while HOME was held: its release plays nothing */
static uint8_t pal_tap_due;                         /* a tap for the loop: the position + 1, 0 none */
static uint8_t pal_sb_due;                          /* sandbox mode: HOME + a black key, the refusal for the loop */
static uint8_t pal_bar_due;                         /* the bar again (NEXT: came, went or changed) */
static uint32_t pal_msg_shown;                      /* the message (msg_until) the overview's last line shows */

/* position pos tapped (HOME + its black key let go within 1 s): an empty or MISSING position says so in the bar and a
 * switch already waiting stays; else palette.c switches (now, or at the next bar line; the waiting position again
 * cancels) */
static void pal_tap(uint32_t pos)
{
    char m[32], *q;
    if (pos >= PAL_N)
        return;
    if (pal_ix[pos].state == PAL_OK) {
        (void)pal_request(pos, 0);
        return;
    }
    q = put(m, MSG_PAL);                            /* PALETTE 3 EMPTY: HOLD KEY, PALETTE 3: MISSING (25, 18 characters) */
    *q++ = (char)('1' + pos);
    put(q, pal_ix[pos].state == PAL_MISSING ? MSG_PAL_MISSING : MSG_PAL_EMPTY)[0] = 0;
    ui_msg(m, PAL_NUDGE_MS);
}

/* the palette's state changed (palette.c after a switch, a cancel, a save, a check of the bank; fm1_ui.c from the
 * editor): the overview's rows and the bar's NEXT: again, by the loop's drawing (nothing drawn here) */
static void pal_ui_changed(void)
{
    if (pal_view)
        pal_due = pal_due ? pal_due : 1u;
    pal_bar_due = 1;
}

/* the overview opens over the page (the page is drawn again as the dim frame around it) / closes (the page whole) */
static void pal_open(void)
{
    pal_view = 1;
    pal_due = 2;
    lcd_ovl = 1;
    ovl_changed();
}
static void pal_close(void)
{
    if (!pal_view)
        return;
    pal_view = 0;
    pal_due = 0;
    if (!help_on)
        lcd_ovl = 0;
    ovl_changed();
}

/* the first edge of another combo while HOME is held (a button, a knob): the overview closes, and stays shut until
 * HOME's next press; the combo then does its own job */
static void pal_combo(void)
{
    pal_shut = 1;
    pal_close();
}

/* HOME pressed: the overview may show again after PAL_VIEW_MS */
static void pal_home_down(void)
{
    pal_home_ms = fm1_ms;
    pal_shut = 0;
}

/* HOME let go (panel_edges; panel_align: the FM-1 the copy follows let it go): the overview closes, a palette key's hold
 * is no longer timed (its release is a tap) */
static void pal_home_up(void)
{
    pal_timing = 0;
    pal_shut = 1;
    pal_close();
}

/* a key pressed while HOME is held (panel_key: taken, nothing sounds): a black key 1..8 (seq_black 0..7) is a palette
 * key, its hold timed; in sandbox mode only the refusal (the editor's patch stays). Returns 1 for a palette key (HOME's
 * release then goes nowhere) */
static int pal_key_down(uint32_t n)
{
    int b = seq_black(n);
    pal_taken |= 1u << n;
    if (b < 0 || b >= (int)PAL_N)
        return 0;
    if (sb_on) {
        pal_sb_due = 1;
        return 1;
    }
    pal_key = (uint8_t)n;
    pal_key_t0 = fm1_ms;
    pal_timing = 1;
    pal_fired = 0;
    return 1;
}

/* a key taken while HOME was held let go: 1 (it plays nothing). The palette key's release is the tap, unless its hold
 * saved; 0: not a taken key */
static int pal_key_up(uint32_t n)
{
    if (!(pal_taken >> n & 1u))
        return 0;
    pal_taken &= ~(1u << n);
    if (n == pal_key) {
        if (!pal_fired)
            pal_tap_due = (uint8_t)(seq_black(n) + 1);
        pal_key = PAL_KEY_NONE;
        pal_timing = 0;
    }
    return 1;
}

/* from panel_status, every pass: a tap or a refusal the keys asked for, the palette key's hold (PAL_HOLD_MS: save, once),
 * HOME held alone (home_alone: no other button) PAL_VIEW_MS: the overview (not in sandbox mode, not under a card).
 * Returns 1 as the overview opens (HOME's release then only closes it) */
static int pal_poll(int home_alone)
{
    if (pal_sb_due) {
        pal_sb_due = 0;
        if (sb_on && !help_on)
            ui_msg(MSG_SANDBOX_PATCH_STAYS, PAL_NUDGE_MS);
    }
    if (pal_tap_due) {
        uint32_t pos = pal_tap_due - 1u;
        pal_tap_due = 0;
        pal_tap(pos);
    }
    if (pal_key != PAL_KEY_NONE && pal_timing && !pal_fired && fm1_ms - pal_key_t0 >= PAL_HOLD_MS) {
        pal_fired = 1;
        pal_save((uint32_t)seq_black(pal_key));
    }
    if (pal_view && (help_on || sb_on))
        pal_close();
    if (pal_view || pal_shut || !home_alone || sb_on || help_on || fm1_ms - pal_home_ms < PAL_VIEW_MS)
        return 0;
    pal_open();
    return 1;
}

/* the overview: the title, the eight positions (1 BRIGHT PAD | MONOLITH D, pal_label: the row's whole width for the
 * names, D-942; the one playing inverse and marked >, the waiting one NEXT, an empty one EMPTY, a missing one its name and
 * MISSING), or one line for an empty palette; the last line the bar's message while one shows */
static void pal_draw(void)
{
    uint32_t full = pal_due > 1u, i, y, any = 0;
    pal_due = 0;
    if (!pal_view)
        return;
    lcd_ovl_self = 1;
    if (full) {
        help_ground();
        lcd_fill(HC_IX, HC_M + 2u, HC_IW, 20, P_SKY);
        text_bc(&FONT_M, HC_IX, HC_M + 3u, MSG_PAL_TITLE, P_NIGHT, P_SKY, HC_IW, TA_CENTER);
    }
    for (i = 0; i < PAL_N; i++)
        any |= pal_ix[i].state != PAL_EMPTY;
    lcd_fill(HC_IX, HC_TOP, HC_IW, HC_M + HC_W - 2u - HC_TOP, P_PANEL);
    if (!any)
        text_bc(&FONT_S, HC_IX, HC_TOP + 3u * HC_ROW, MSG_PAL_HOLD_TO_SAVE, P_DIM, P_PANEL, HC_IW, TA_CENTER);
    for (i = 0, y = HC_TOP; any && i < PAL_N; i++, y += HC_ROW) {
        char r[2u + PAL_LABEL + sizeof MSG_PAL_ROW_MISSING + sizeof MSG_PAL_ROW_NEXT], s[sizeof MSG_PAL_ROW_MISSING + sizeof MSG_PAL_ROW_NEXT];
        char *q = r, *t = s;
        int cur = i == pal_cur;
        uint16_t bg = cur ? help_pct(P_SKY, 75u) : P_PANEL;
        uint16_t ink = cur ? P_NIGHT : pal_ix[i].state == PAL_EMPTY ? P_FAINT : pal_ix[i].state == PAL_MISSING ? P_DIM : P_INK;
        if (pal_ix[i].state == PAL_MISSING)
            t = put(t, MSG_PAL_ROW_MISSING);
        if (i == pal_next)
            t = put(t, MSG_PAL_ROW_NEXT);
        *t = 0;
        *q++ = (char)('1' + i);
        *q++ = ' ';
        *q = 0;
        if (pal_ix[i].state == PAL_EMPTY)
            q = put(q, MSG_PAL_ROW_EMPTY);
        else
            q = pal_label(q, i, PAL_ROW_W - text_w(&FONT_S, r, -1) - text_w(&FONT_S, s, -1));
        put(q, s)[0] = 0;
        if (cur) {
            lcd_fill(HC_IX, y, HC_IW, HC_ROW - 2u, bg);
            text_bc(&FONT_S, HC_IX + 2u, y + 2u, ">", ink, bg, HC_X0 - HC_IX - 2u, TA_LEFT);
        }
        text_bc(&FONT_S, HC_X0, y + 2u, r, ink, bg, PAL_ROW_W, TA_LEFT);
    }
    pal_msg_shown = msg_until;
    if (msg_until && fm1_ms < msg_until)            /* (the bar's message, under the card's edge: here) */
        text_bc(&FONT_S, HC_IX, HC_M + HC_W - 20u, msg_text, P_INK, P_PANEL, HC_IW, TA_CENTER);
    lcd_ovl_self = 0;
}

/* from panel_draw_now, first: the overview as pal_due asks, its last line again when the bar's message changed; the bar
 * again when NEXT: came or went */
static void pal_follow(void)
{
    if (pal_view && msg_until != pal_msg_shown)
        pal_due = pal_due ? pal_due : 1u;
    if (pal_due)
        pal_draw();
    if (pal_bar_due && !booting) {                  /* (the loading screen: the first redraw draws the bar) */
        pal_bar_due = 0;
        if (!msg_until || fm1_ms >= msg_until)      /* (a message on show keeps the bar: its end draws it) */
            header_draw();
    }
}
