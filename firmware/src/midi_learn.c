/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI learn on the FM-1 (#1067; web/src/midi-learn.ts is the editor's), after pages_ui.c, before menu.c. A MIDI
 * controller's CC or pitch bend moves one row of the running patch, on any page, in focus or not. The patch keeps its
 * mappings in its binary (engine.h eng_maps: the source, the row's module and parameter bytes, its low and high end), so
 * the FM-1 plays them without the editor. A learned control does only that: its fixed job (midi_input.h: Main's mod
 * wheel, breath, sustain, foot, K1..K4, morph, pitch bend) waits until its mapping is cleared. CC 80..86 (the patch
 * buttons) and 120..127 (the channel mode messages) are never learned. Mappings follow MENU > MIDI CHANNEL.
 *
 * Learning: GLO > MIDI 3/3, LEARN turned right, closes the menu. The next knob turned on a page picks its row (the row
 * does not move then), and the first control to send three different values (two for a switch row) moves it from then
 * on. LEARN turned left, another patch, or LEARN_MS without a step end the wait. The same page lists the mappings
 * (MAPPING) and clears the one it shows (CLEAR). A linked editor hears each change (MAP_NOW) and every move (PARAM_NOW,
 * at most every MAP_REPORT_MS for a mapping). */

#define LEARN_MS 30000u
#define LEARN_CANDS 2u                                  /* controls a learn tells apart at once (an X-Y pad sends two) */
#define MAP_REPORT_MS 25u

static struct {
    uint8_t on;                                         /* 0 no, 1 a knob picks the row, 2 the row waits for a control */
    uint8_t mod, par, need;                             /* the row (a page row's module and parameter bytes), values to see */
    uint8_t nc;
    uint32_t gen, at;                                   /* the patch it learns for (pages_gen), its last step (fm1_ms) */
    struct { uint8_t src, n; uint16_t v[2]; } c[LEARN_CANDS];   /* the controls heard: their different values so far */
} ml ENG_LOWRAM;                                        /* (.lowram, zeroed at boot: the RAM region has no room left) */
static uint8_t map_sel;                                 /* the mapping GLO > MIDI 3/3 shows (MAPPING, CLEAR) */
typedef struct { uint8_t due, mod, par; int32_t v; uint32_t at; } map_rep_t;
static map_rep_t map_rep[ENG_MAP_RAMPS];               /* the moves told to the editor (PARAM_NOW), per ramp slot */
static void screen_back(void);                         /* (panel.c) */

/* the running patch's mappings: their count, *e at the first one's bytes */
static uint32_t map_list(const uint8_t **e)
{
    uint32_t len;
    const uint8_t *p = pages_src(&len);
    return p ? eng_maps(p, len, e) : 0u;
}

/* a learnable CC (0..119 but 80..86), or pitch bend (ENG_MAP_BEND) */
static int map_learnable(uint32_t src)
{
    return src == ENG_MAP_BEND || (src < 120u && !(src >= 80u && src < 80u + ENG_PANEL_BUTTONS));
}

/* a source's name: CC 1, BEND */
static char *map_src_name(char *p, uint32_t src)
{
    if (src == ENG_MAP_BEND)
        return put(p, "BEND");
    p = put(p, "CC ");
    fmt_int(p, (int32_t)src);
    return p + str_len(p);
}

/* module m's row byte j by its row's name in capitals (at most 12 characters), "?" when no page has it */
static char *map_row_name(char *p, uint32_t m, uint32_t j)
{
    uint32_t k;
    const ppage_t *pg = row_find(m, j, &k);
    if (!pg) {
        p = put(p, "?");
        *p = 0;
        return p;
    }
    caps(p, pg->lab[k], pg->llen[k], 12u);
    return p + str_len(p);
}

/* is a learn under way? It ends with another patch or LEARN_MS after its last step */
static int learn_live(void)
{
    if (ml.on && (ml.gen != pages_gen() || fm1_ms - ml.at > LEARN_MS))
        ml.on = 0;
    return ml.on;
}

/* LEARN turned right (GLO > MIDI 3/3): the menu closes, the next knob turned picks its row */
static void learn_start(void)
{
    ml.on = 1;
    ml.gen = pages_gen();
    ml.at = fm1_ms;
    screen_back();
    ui_msg(MSG_LEARN_TURN, LEARN_MS);
}

/* LEARN turned left: the wait ends */
static void learn_cancel(void)
{
    if (!learn_live())
        return;
    ml.on = 0;
    ui_msg(MSG_LEARN_OFF, 1500);
}

/* a knob turned on a page while a learn waits for its row (panel.c): row k of the page in focus is picked and does not
 * move. 0: no learn waits for a row (the knob turns it as usual) */
static int learn_pick(uint32_t k)
{
    const ppage_t *pg = pages_now();
    uint32_t m, j;
    int t;
    char text[40], *p;
    if (learn_live() != 1)
        return 0;
    ml.at = fm1_ms;
    if (!pg || k >= pg->nrows || (m = pg->mod[k]) == SETTING_ROW || ((j = pg->par[k]) & POLY_ROW) || (t = eng_type(m)) < 0 ||
        DEF_FIXED((uint32_t)t, j)) {
        ui_msg(MSG_LEARN_NO_ROW, 1500);
        return 1;
    }
    {
        const def_t *d = &DEFS[t];
        uint32_t n = 0;
        while (d->pchoice && d->pchoice[j] && d->pchoice[j][n])
            n++;
        ml.need = (uint8_t)(n == 2u || (!n && d->pmin[j] == 0 && d->pmax[j] == 65536 && d->pinc[j] == 65536) ? 2u : 3u);
    }
    ml.mod = (uint8_t)m;
    ml.par = (uint8_t)j;
    ml.nc = 0;
    ml.on = 2;
    p = put(text, MSG_LEARN);
    caps(p, pg->lab[k], pg->llen[k], 12u);
    put(p + str_len(p), MSG_LEARN_MOVE)[0] = 0;
    ui_msg(text, LEARN_MS);
    return 1;
}

/* the learn found its control: it moves the row from now on */
static void learn_bind(uint32_t src)
{
    char text[40], *p;
    ml.on = 0;
    if (!m1_patch_map(src, ml.mod, ml.par, 0u, 255u, 1)) {
        ui_msg(MSG_LEARN_FULL, 2000);
        return;
    }
    m1_map_now();
    p = map_src_name(text, src);
    p = put(p, MSG_LEARN_MOVES);
    map_row_name(p, ml.mod, ml.par);
    ui_msg(text, 2500);
}

/* a learnable control's value (a CC's 0..127, pitch bend's 0..16383) while a row waits for one: 1, taken (it does
 * nothing else); the control that sends the row's count of different values first is learned */
static int learn_take(uint32_t src, uint32_t raw)
{
    uint32_t i, k;
    if (learn_live() != 2)
        return 0;
    for (i = 0; i < ml.nc && ml.c[i].src != src; i++)
        ;
    if (i == ml.nc) {                                   /* a new control: a place of its own, else the last one's */
        if (ml.nc < LEARN_CANDS)
            ml.nc++;
        else
            i = LEARN_CANDS - 1u;
        ml.c[i].src = (uint8_t)src;
        ml.c[i].n = 0;
    }
    for (k = 0; k < ml.c[i].n && ml.c[i].v[k] != raw; k++)
        ;
    if (k == ml.c[i].n) {
        if (k + 1u >= ml.need) {
            learn_bind(src);
            return 1;
        }
        ml.c[i].v[k] = (uint16_t)raw;
        ml.c[i].n++;
    }
    return 1;
}

/* mapping i's move to the linked editor: at once, else after MAP_REPORT_MS (map_poll), the latest value */
static void map_report(uint32_t i, uint32_t mod, uint32_t par, int32_t v)
{
    map_rep_t *r = &map_rep[i % ENG_MAP_RAMPS];
    if (r->due && (r->mod != mod || r->par != par))     /* (another mapping took the slot: the row before gets its last value) */
        m1_param_now(r->mod, r->par, r->v);
    r->mod = (uint8_t)mod;
    r->par = (uint8_t)par;
    r->v = v;
    r->due = 1;
    if (fm1_ms - r->at >= MAP_REPORT_MS) {
        r->at = fm1_ms;
        r->due = 0;
        m1_param_now(mod, par, v);
    }
}

/* the moves map_report held back, once their MAP_REPORT_MS are over (midi_input.h, after each drain) */
static void map_poll(void)
{
    uint32_t i;
    for (i = 0; i < ENG_MAP_RAMPS; i++)
        if (map_rep[i].due && fm1_ms - map_rep[i].at >= MAP_REPORT_MS) {
            map_rep[i].at = fm1_ms;
            map_rep[i].due = 0;
            m1_param_now(map_rep[i].mod, map_rep[i].par, map_rep[i].v);
        }
}

/* does control src move a row of the running patch, or does a learn wait for a control (midi_input.h: the message then
 * waits for the main loop, as CC 16..19 do) */
static int map_has(uint32_t src)
{
    const uint8_t *e = 0;
    uint32_t n, i;
    if (!map_learnable(src))
        return 0;
    if (learn_live() == 2)
        return 1;
    n = map_list(&e);
    for (i = 0; i < n; i++, e += ENG_MAP_BYTES)
        if (e[0] == src)
            return 1;
    return 0;
}

/* a CC (src 0..119, raw 0..127) or pitch bend (ENG_MAP_BEND, raw 0..16383) on the MIDI channel: 1 when a learn or a mapping
 * took it, so it does nothing else (midi_input.h); 0, it does its fixed job */
static int map_midi(uint32_t src, uint32_t raw)
{
    const uint8_t *e = 0;
    uint32_t n, i, m, j, lo, hi, mod, par;
    int32_t u, v;
    if (!map_learnable(src))
        return 0;
    if (learn_take(src, raw))
        return 1;
    n = map_list(&e);
    for (i = 0; i < n && e[0] != src; i++, e += ENG_MAP_BYTES)
        ;
    if (i == n)
        return 0;
    m = e[1];                                           /* (copied: the move may grow the binary, which moves the section) */
    j = e[2];
    lo = e[3];
    hi = e[4];
    if (src == ENG_MAP_BEND)                            /* (its centre, 8192, is the middle; its ends the ends) */
        u = raw < 8192u ? (int32_t)(raw * 4u) : 32768 + (int32_t)((raw - 8192u) * 32768u / 8191u);
    else
        u = (int32_t)(raw * 65536u / 127u);
    u = (int32_t)(((int64_t)lo * 65536 + (int64_t)((int32_t)hi - (int32_t)lo) * u) / 255);
    if (!pages_map_move(m, j, u, i, &mod, &par, &v))
        return 0;
    map_report(i, mod, par, v);
    return 1;
}

/* ---- GLO > MIDI 3/3 (menu.c): LEARN, MAPPING, CLEAR */

/* MAPPING's label: the mapping shown, "CC 1  1/2", or MAPPINGS when there are none */
static const char *map_label(void)
{
    static char t[16];
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    char *p;
    if (!n)
        return "MAPPINGS";
    if (map_sel >= n)
        map_sel = (uint8_t)(n - 1u);
    p = map_src_name(t, e[ENG_MAP_BYTES * map_sel]);
    p = put(p, "  ");
    fmt_int(p, map_sel + 1);
    p = put(p + str_len(p), "/");
    fmt_int(p, (int32_t)n);
    return t;
}

/* a row's value as menu.c menu_value writes it */
static void map_value(uint32_t row, char *out)
{
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    char *p = out;
    if (row == MR_LEARN)
        p = put(p, learn_live() ? "WAITING" : "TURN >");
    else if (row == MR_MAP_CLEAR)
        p = put(p, n ? "TURN >" : "-");
    else if (!n)
        p = put(p, "NONE");
    else {
        char name[16];
        if (map_sel >= n)
            map_sel = (uint8_t)(n - 1u);
        e += ENG_MAP_BYTES * map_sel;
        map_row_name(name, e[1], e[2]);
        name[10] = 0;                                   /* (a value takes 10 characters) */
        p = put(p, name);
    }
    *p = 0;
}

/* a row's place in its range over width px (menu.c setting_bar) */
static uint32_t map_bar(uint32_t row, uint32_t width)
{
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    if (row == MR_LEARN)
        return learn_live() ? width : 0u;
    if (row == MR_MAPS)
        return n > 1u ? (map_sel < n ? map_sel : n - 1u) * width / (n - 1u) : n ? width : 0u;
    return 0u;
}

/* a row turned (menu.c setting_step): 1 when the menu closed (a learn started) */
static int map_step(uint32_t row, int32_t s)
{
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    if (row == MR_LEARN) {
        if (s > 0) {
            learn_start();
            return 1;
        }
        learn_cancel();
    } else if (row == MR_MAPS) {
        int32_t v = (int32_t)map_sel + (s > 0 ? 1 : -1);
        map_sel = (uint8_t)(n ? (v < 0 ? 0 : v >= (int32_t)n ? (int32_t)n - 1 : v) : 0);
    } else if (row == MR_MAP_CLEAR && s > 0 && n) {
        char text[24];
        uint32_t src;
        if (map_sel >= n)
            map_sel = (uint8_t)(n - 1u);
        src = e[ENG_MAP_BYTES * map_sel];
        if (m1_patch_map(src, 0, 0, 0, 0, 0)) {
            m1_map_now();
            put(map_src_name(text, src), MSG_MAP_CLEARED)[0] = 0;
            ui_msg(text, 1500);
        }
    }
    return 0;
}
