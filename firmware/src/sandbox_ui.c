/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Sandbox mode (docs/ARCHITECTURE.md "Sandbox mode"): the editor's patch is over the FM-1's budget, so the browser plays it
 * and the FM-1 is its controller. While the editor's LIVE says paused (live.c) the FM-1's own sound is muted (audio.c
 * snd_muted: its patch runs on, unheard), its controls go out over MIDI as always (MENU > MIDI OUT, panel.c), and the
 * device page shows the editor's page (SANDBOX, proto.c, sandbox_msg.h) in the device page's look:
 *   y   0  the header: SANDBOX and the editor's patch, on gold
 *   y  39  the device's name, the page's title and "3/7" of its pages
 *   y  58  K1..K4: the page's four rows, as the device page's bars
 *   y 218  the page rail, the page in gold
 *   y 225  the footer: BROWSER PLAYS . FM-1 MUTED (or how to turn MIDI OUT on), the battery
 * Before the editor's first page, a card says what is going on. K1..K4 turn the editor's rows from the positions it sent
 * (panel.c: CC 16..19, which the editor takes as positions), and the bars follow at once; the editor's page then brings
 * the values. Only the FM-1's own controls act here (OCT, HOME, PLAY, GLO, the menu); the other buttons go to the editor.
 * Sandbox mode beginning brings the sandbox page up from any screen but the menu and GLO (the FM-1's own settings): the
 * SEQ page, say, would otherwise stay up, its steps running on unheard, and SEQ goes to the editor here.
 * Sandbox mode ends with a LIVE not paused, or 5 s without LIVE (a closed tab, a pulled cable), and the FM-1 sounds again. */
#define SB_HOLD_MS 5000u                                /* (live.c LIVE_HOLD_MS) */
#define SB_ECHO_MS 400u                                 /* a knob turned here: the editor's position for it waits this long */
#define SB_DIRTY_HEAD 16u
static sb_page_t sb;                                    /* the editor's page */
static uint8_t sb_have;                                 /* a page arrived since sandbox mode began */
static uint8_t sb_dirty;                                /* bit k: row k needs a redraw; SB_DIRTY_HEAD: the bar, the header, the rail */
static uint32_t sb_until;                               /* sandbox mode lapses at this fm1_ms */
static uint8_t sb_cc[SB_ROWS];                          /* K1..K4's positions as CC 16..19 carry them, 0..127 */
static uint32_t sb_turned[SB_ROWS];                     /* fm1_ms | 1 of the last turn here, 0 none */
static uint8_t sb_home_due;                             /* sandbox mode began: panel_status brings the sandbox page up */

/* sandbox mode on or off: the sound, and the whole screen at the next panel_draw */
static void sandbox_set(int on)
{
    if (!on == !sb_on)
        return;
    sb_on = (uint8_t)(on != 0);
    sb_home_due = sb_on;
    snd_muted = sb_on;
    sb_have = 0;
    sb_dirty = 0;
    pg_strip_dirty = 1;
    ui_full = 1;
}

/* a LIVE (live.c): paused = the editor's patch is a sandbox patch, held until `until` */
static void sandbox_live(int paused, uint32_t until)
{
    if (paused)
        sb_until = until;
    sandbox_set(paused);
}

/* the loop (panel_status): no LIVE for SB_HOLD_MS ends it */
static void sandbox_poll(void)
{
    if (sb_on && (int32_t)(sb_until - fm1_ms) <= 0)
        sandbox_set(0);
}

/* K(k + 1) was turned here within SB_ECHO_MS */
static int sb_recent(uint32_t k) { return sb_turned[k] && fm1_ms - (sb_turned[k] & ~1u) < SB_ECHO_MS; }

static int sb_same(const char *a, const char *b)
{
    while (*a && *a == *b)
        a++, b++;
    return *a == *b;
}

/* the editor's page (proto.c SANDBOX): only what changed is drawn again */
static void m1_sandbox(const sb_page_t *s)
{
    uint32_t k;
    if (!sb_on)
        return;                                         /* (a page after sandbox mode ended) */
    if (!sb_have || s->index != sb.index || s->count != sb.count || !sb_same(s->patch, sb.patch) || !sb_same(s->dev, sb.dev)
        || !sb_same(s->page, sb.page))
        sb_dirty |= SB_DIRTY_HEAD;
    for (k = 0; k < SB_ROWS; k++) {
        int recent = sb_recent(k);
        uint8_t pos = recent ? sb.pos[k] : s->pos[k];
        if (!sb_have || ((s->rows ^ sb.rows) >> k & 1u) || pos != sb.pos[k] || s->steps[k] != sb.steps[k]
            || !sb_same(s->label[k], sb.label[k]) || !sb_same(s->value[k], sb.value[k]) || !sb_same(s->unit[k], sb.unit[k]))
            sb_dirty |= (uint8_t)(1u << k);
        if (!recent)
            sb_cc[k] = (uint8_t)(((uint32_t)s->pos[k] * 127u + 127u) / 255u);
    }
    {
        uint8_t keep[SB_ROWS];
        for (k = 0; k < SB_ROWS; k++)
            keep[k] = sb_recent(k) ? sb.pos[k] : s->pos[k];
        sb = *s;
        for (k = 0; k < SB_ROWS; k++)
            sb.pos[k] = keep[k];
    }
    if (!sb_have) {
        sb_have = 1;
        ui_dirty = 2;                                   /* the card goes: the page, whole */
    } else if (sb_dirty && !ui_dirty)
        ui_dirty = 1;
}

/* K(k + 1) turned `c` clicks (fast: quickly) on the sandbox page: the row's next position, as CC 16..19 carry it, or -1
 * when it does not move (no row, at its end). A row of n choices moves a choice a click; others 1/127 (5/127 fast). The bar
 * follows here at once; panel.c sends the CC */
static int32_t sandbox_knob(uint32_t k, int32_t c, int fast)
{
    int32_t v, n;
    if (!sb_have || k >= SB_ROWS || !(sb.rows >> k & 1u) || !c)
        return -1;
    n = sb.steps[k];
    if (n >= 2) {
        int32_t i = ((int32_t)sb_cc[k] * (n - 1) + 63) / 127 + c;
        i = i < 0 ? 0 : i > n - 1 ? n - 1 : i;
        v = (i * 127 + (n - 1) / 2) / (n - 1);
    } else {
        v = (int32_t)sb_cc[k] + c * (fast ? 5 : 1);
        v = v < 0 ? 0 : v > 127 ? 127 : v;
    }
    if (v == (int32_t)sb_cc[k])
        return -1;
    sb_cc[k] = (uint8_t)v;
    sb_turned[k] = fm1_ms | 1u;
    sb.pos[k] = (uint8_t)(((uint32_t)v * 255u + 63u) / 127u);
    sb_dirty |= (uint8_t)(1u << k);
    return v;
}

/* the editor's patch's name, for the header (pages_ui.c head_layout) */
static const char *sb_patch_name(void) { return sb_have ? sb.patch : ""; }

/* the header: SANDBOX and the editor's patch, on gold (pages_ui.c head_row, HM_SANDBOX) */
static void sandbox_bar(void)
{
    head_draw(1);
}

#define SB_HEAD_Y (LK_HH + 3u)                          /* the line under the header */
#define SB_RAIL_Y (FOOT_Y - 7u)                         /* the page rail, 3 px, 4 above the footer */
static void sandbox_geo(void) { geo_set(LK_HH + 22u, SB_RAIL_Y - 4u); }

/* the line under it: the device, the page's title in a chip, "3/7" of the device's pages */
static void sandbox_head(void)
{
    char dev[SB_DEV + 1u], pg[SB_PAGE + 1u], kn[12], num[8], *q;
    uint32_t wk, wp, xp;
    lcd_fill(0, SB_HEAD_Y - 1u, 240, 16, P_NIGHT);
    q = put(kn, "");
    if (sb.count) {
        fmt_int(num, (int32_t)sb.index + 1);
        q = put(q, num);
        *q++ = '/';
        fmt_int(num, (int32_t)sb.count);
        q = put(q, num);
    }
    *q = 0;
    wk = kn[0] ? text_w(&FONT_S, kn, -1) : 0u;
    caps(pg, sb.page, str_len(sb.page), SB_PAGE);
    fit(pg, &FONT_S, 120u);
    wp = pg[0] ? text_w(&FONT_S, pg, -1) + 8u : 0u;
    xp = 234u - wk - (wk ? 6u : 0u) - wp;
    caps(dev, sb.dev, str_len(sb.dev), SB_DEV);
    fit(dev, &FONT_S, xp > 16u ? xp - 12u : 0u);
    text_bc(&FONT_S, 6, SB_HEAD_Y, dev, P_INK, P_NIGHT, 0, TA_LEFT);
    if (wp)
        text_bc(&FONT_S, xp, SB_HEAD_Y, pg, P_NIGHT, P_SEA, wp, TA_CENTER);
    if (wk)
        text_bc(&FONT_S, 234u - wk, SB_HEAD_Y, kn, P_DIM, P_NIGHT, wk, TA_LEFT);
}

/* the page rail: a segment per page of the device, the one shown in gold */
static void sandbox_rail(void)
{
    uint32_t i, n = sb.count;
    lcd_fill(0, SB_RAIL_Y, 240, 3, P_NIGHT);
    if (n > BAR_W / 3u)
        n = BAR_W / 3u;
    for (i = 0; i < n; i++) {
        uint32_t a = BAR_X + i * BAR_W / n, b = BAR_X + (i + 1u) * BAR_W / n;
        lcd_fill(a, SB_RAIL_Y, b - a > 2u ? b - a - 2u : 1u, 3, i == sb.index ? P_GOLD : P_TRACK);
    }
}

/* before the editor's first page: what sandbox mode is */
static void sandbox_card(void)
{
    char t[40];
    text_bc(&FONT_L, 0, 74, "SANDBOX", P_GOLD, P_NIGHT, 240, TA_CENTER);
    put(t, "THE BROWSER PLAYS THIS PATCH")[0] = 0;
    fit(t, &FONT_S, 232u);
    text_bc(&FONT_S, 0, 112, t, P_INK, P_NIGHT, 240, TA_CENTER);
    put(t, "KEYS AND KNOBS DRIVE IT FROM HERE")[0] = 0;
    fit(t, &FONT_S, 232u);
    text_bc(&FONT_S, 0, 132, t, P_DIM, P_NIGHT, 240, TA_CENTER);
}

/* the sandbox page (page 0 in sandbox mode): full, or what changed. Its footer (pages_ui.c foot_draw): who plays, or how
 * to turn MIDI OUT on (without it the keys and knobs reach nothing), and the battery */
static void sandbox_draw(int full)
{
    uint32_t k;
    sandbox_geo();
    if (full) {
        if (!msg_until)
            sandbox_bar();
        lcd_fill(0, LK_HH, 240, FOOT_Y - LK_HH, P_NIGHT);
        foot_draw(1);
        sb_dirty = 0xFFu;
    } else
        foot_draw(0);                                   /* (MIDI OUT turned on or off) */
    if (!sb_have) {
        if (full)
            sandbox_card();
        sb_dirty = 0;
        return;
    }
    if (sb_dirty & SB_DIRTY_HEAD) {
        if (!full && !msg_until)
            head_draw(0);                               /* (another patch name) */
        sandbox_head();
        sandbox_rail();
    }
    for (k = 0; k < SB_ROWS; k++)
        if (sb_dirty >> k & 1u) {
            bar_t b;
            b.used = (uint8_t)(sb.rows >> k & 1u);
            caps(b.name, sb.label[k], b.used ? str_len(sb.label[k]) : 0u, SB_LABEL);
            put(b.num, b.used ? sb.value[k] : "")[0] = 0;
            put(b.unit, b.used ? sb.unit[k] : "")[0] = 0;
            b.base = b.live = (uint32_t)sb.pos[k] * BAR_W / 255u;
            bar_layout(&b);
            row_bar(k, &b);
        }
    sb_dirty = 0;
}
