/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Sandbox mode (docs/ARCHITECTURE.md "Sandbox mode"): the editor's patch is over the FM-1's budget, so the browser plays it
 * and the FM-1 is its controller. While the editor's LIVE says paused (live.c) the FM-1's own sound is muted (audio.c
 * snd_muted: its patch runs on, unheard), its controls go out over MIDI as always (MENU > MIDI OUT, panel.c), and the
 * device page shows the editor's page (SANDBOX, proto.c, sandbox_msg.h) as a device page (D-232, D-234):
 *   the header: the editor's device, its page group and the group's pages, with their dashes (pages_ui.c head_row, sb_head)
 *   K1..K4: the page's four rows, as the device page's bars
 *   the footer, on gold: SANDBOX where the patch's name goes (" *" with unsaved edits, KEYS WIRED with nothing armed), the
 *   editor's tempo, the octave and the battery (pages_ui.c foot_row, sb_foot)
 * An older editor sends no device, group or tempo fields (sandbox_msg.h sb_guess): no dashes for them, the group's pages
 * from the title's "1/2", and "--" for the tempo. Before the editor's first page, a card says what is going on, and K1..K4
 * change nothing (the FM-1's own patch is muted, not edited: panel.c). K1..K4 turn the editor's rows from the positions it
 * sent (panel.c: CC 16..19, which the editor takes as positions), and the bars follow at once; the editor's page then
 * brings the values. PLAY held + PRESET turns the editor's tempo (sandbox_tempo: PRESET's CC goes out, the editor adds the
 * clicks), never the FM-1's own. Only the FM-1's own controls act here (OCT, HOME, PLAY, GLO, the menu); the other buttons
 * go to the editor. Sandbox mode beginning brings the sandbox page up from any screen but the menu and GLO (the FM-1's own
 * settings): the SEQ page, say, would otherwise stay up, its steps running on unheard, and SEQ goes to the editor here.
 * Sandbox mode ends with a LIVE not paused, or 5 s without LIVE (a closed tab, a pulled cable), and the FM-1 sounds again. */
#define SB_HOLD_MS 5000u                                /* (live.c LIVE_HOLD_MS) */
#define SB_ECHO_MS 400u                                 /* a knob turned here: the editor's position for it waits this long */
#define SB_DIRTY_HEAD 16u
#define SB_TEMPO_MIN 20
#define SB_TEMPO_MAX 300                                /* (panel.c's PLAY held + PRESET range, the editor's sandbox-mode.ts) */
static sb_page_t sb;                                    /* the editor's page */
static uint8_t sb_have;                                 /* a page arrived since sandbox mode began */
static uint8_t sb_dirty;                                /* bit k: row k needs a redraw; SB_DIRTY_HEAD: the header */
static uint32_t sb_until;                               /* sandbox mode lapses at this fm1_ms */
static uint8_t sb_cc[SB_ROWS];                          /* K1..K4's positions as CC 16..19 carry them, 0..127 */
static uint32_t sb_turned[SB_ROWS];                     /* fm1_ms | 1 of the last turn here, 0 none */
static uint32_t sb_tempo_turned;                        /* fm1_ms | 1 of PLAY held + PRESET here, 0 none */
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
    sb_tempo_turned = 0;
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

/* the turn here (fm1_ms | 1, 0 none) was within SB_ECHO_MS */
static int sb_fresh(uint32_t t) { return t && fm1_ms - (t & ~1u) < SB_ECHO_MS; }
/* K(k + 1) was turned here within SB_ECHO_MS */
static int sb_recent(uint32_t k) { return sb_fresh(sb_turned[k]); }

static int sb_same(const char *a, const char *b)
{
    while (*a && *a == *b)
        a++, b++;
    return *a == *b;
}

/* the editor's page (proto.c SANDBOX): only what changed is drawn again (the footer: foot_draw compares) */
static void m1_sandbox(const sb_page_t *s)
{
    uint32_t k;
    uint16_t tempo = sb_fresh(sb_tempo_turned) ? sb.tempo : s->tempo;   /* (the tempo turned here wins for a moment) */
    if (!sb_on)
        return;                                         /* (a page after sandbox mode ended) */
    if (!sb_have || !sb_same(s->dev, sb.dev) || !sb_same(s->page, sb.page) || s->ndev != sb.ndev || s->dev_at != sb.dev_at
        || s->ngroup != sb.ngroup || s->group_at != sb.group_at || s->npage != sb.npage || s->page_at != sb.page_at)
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
        int foot = sb_have && (tempo != sb.tempo || s->flags != sb.flags || !s->armed != !sb.armed || s->ext != sb.ext);
        for (k = 0; k < SB_ROWS; k++)
            keep[k] = sb_recent(k) ? sb.pos[k] : s->pos[k];
        sb = *s;
        sb.tempo = tempo;
        for (k = 0; k < SB_ROWS; k++)
            sb.pos[k] = keep[k];
        if (foot && !ui_dirty)
            ui_dirty = 1;                               /* (the footer: the tempo, unsaved edits, KEYS WIRED) */
    }
    if (!sb_have) {
        sb_have = 1;
        ui_dirty = 2;                                   /* the card goes: the page, whole */
    } else if (sb_dirty && !ui_dirty)
        ui_dirty = 1;
}

/* K(k + 1) turned `c` clicks (fast: quickly) on the sandbox page: the row's next position, as CC 16..19 carry it, or -1
 * when it does not move (no page yet, no row, at its end). A row of n choices moves a choice a click; others 1/127 (5/127
 * fast). The bar follows here at once; panel.c sends the CC */
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

/* PLAY held + PRESET turned `c` clicks in sandbox mode: the editor's tempo as it will be (it adds PRESET's clicks from its
 * CC, 1 bpm a click, within 20..300), shown here at once; 0 when the editor sent no tempo (an older editor, a patch with
 * no Main, no page yet), and the editor does not take the turn */
static int32_t sandbox_tempo(int32_t c)
{
    int32_t bpm;
    if (!sb_have || !sb.tempo)
        return 0;
    bpm = (int32_t)sb.tempo + c;
    bpm = bpm < SB_TEMPO_MIN ? SB_TEMPO_MIN : bpm > SB_TEMPO_MAX ? SB_TEMPO_MAX : bpm;
    sb.tempo = (uint16_t)bpm;
    sb_tempo_turned = fm1_ms | 1u;
    return bpm;
}

/* the header (pages_ui.c head_layout): the editor's device and the page's group, with a dash per device and per group,
 * and a bar per page of the group. The group's name is the page's title without its "1/2". Before the first page: empty */
static void sb_head(head_t *h)
{
    uint32_t n;
    uint8_t at, cnt;
    h->mode = HM_DEV;
    if (!sb_have) {
        h->ns = 1;
        return;
    }
    caps(h->a, sb.dev, str_len(sb.dev), 16);
    n = sb_part(sb.page, &at, &cnt);
    caps(h->b, sb.page, n ? n : str_len(sb.page), 16);
    h->nd = sb.ndev;
    h->cd = sb.dev_at;
    h->ng = sb.ngroup;
    h->cg = sb.group_at;
    h->ns = sb.npage ? sb.npage : 1u;
    h->cs = sb.page_at;
}

/* the footer (pages_ui.c foot_layout): SANDBOX where the patch's name goes (" *" with unsaved edits) and the editor's
 * tempo ("--" when it sent none); 1 when nothing is armed in the editor (KEYS WIRED: only from an editor that says) */
static int sb_foot(char *name, char *tempo)
{
    put(name, sb_have && (sb.flags & SB_UNSAVED) ? "SANDBOX *" : "SANDBOX")[0] = 0;
    if (sb_have && sb.tempo)
        fmt_int(tempo, (int32_t)sb.tempo);
    else
        put(tempo, "--")[0] = 0;
    return sb_have && sb.ext && !sb.armed;
}

/* the header, whole (ui.c header_draw: a message's end) */
static void sandbox_bar(void)
{
    head_draw(1);
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

/* the sandbox page (page 0 in sandbox mode): full, or what changed (the header's sections, the bars, the footer) */
static void sandbox_draw(int full)
{
    uint32_t k;
    geo_page(0);
    if (full) {
        if (head_free())
            head_draw(1);
        lcd_fill(0, LK_HH, 240, FOOT_Y - LK_HH, P_NIGHT);
        foot_draw(1);
        sb_dirty = 0xFFu;
    } else
        foot_draw(0);                                   /* (the tempo, the octave, unsaved edits, KEYS WIRED) */
    if (!sb_have) {
        if (full)
            sandbox_card();
        sb_dirty = 0;
        return;
    }
    if ((sb_dirty & SB_DIRTY_HEAD) && !full && head_free())
        head_draw(0);                                   /* (only its sections that changed) */
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
