/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Device pages: the FM-1 as a player of the patch's devices (web/src/pages.ts). Every top-level module or assembly of the
 * editor's canvas is a device; its card's rows, four to a page, are what K1..K4 turn. SELECT steps the devices, ALGO the
 * pages of one; the patch binary lists them (patchbin.ts, the device pages section: proto.c m1_devices_at). A plain
 * module's pages are made here: its parameters in order, four to a page, named as in defs.h.
 *
 * The screen, layout "A+" (the brand look: night paper, ivory ink, the K1..K4 hues of the editor; Barlow Condensed,
 * font_bc.c):
 *   y   0  the devices, a strip of tabs (the one in focus in ivory)
 *   y  20  the pages of the device in focus, by heading (the current one in seafoam, "FILTER 1/2")
 *   y  41  K1..K4: four full-width bars, each tinted in its knob's hue: the row's name left, value and unit right, the
 *          fill to the base value, an ivory tick where modulation has it; an empty slot where the page has no row. A knob
 *          just turned shows at full size over them (the toast)
 *   y 206  the page rail: a segment per page of the device, the one in focus lit, its section's others dimmer
 *   y 214  the patch (slot, name, * when edited) and the transport, the parts, the octave
 * While SELECT or ALGO turns, a card fills the screen instead (#221): the device's name on red (SELECT) or the page's on
 * blue (ALGO); the page above is drawn once, PG_CARD_MS after the last click (or at once when K1..K4 turn). */

/* ---- colours (RGB565): web/src/style.css's dark theme */
#define P_NIGHT 0x10E4u
#define P_STRIP 0x08A2u
#define P_PANEL 0x2145u
#define P_TRACK 0x31E7u
#define P_INK 0xFFBDu
#define P_DIM 0x9CF2u
#define P_FAINT 0x6B6Du
#define P_CORAL 0xE3ABu
#define P_GOLD 0xEDABu
#define P_SEA 0x7E38u
#define P_SAND 0xCE36u
#define P_LILAC 0xC55Bu
#define P_SKY 0x9DFCu
#define P_REDC 0xE249u
#define P_CARD_DEV 0xB186u                              /* SELECT's device card: --ref-red #b33135 (ivory on it 5.8:1) */
#define P_CARD_PAGE 0x4B52u                             /* ALGO's page card: --ref-blue #486b96 (ivory on it 5.3:1) */
static const uint16_t KNOB_HUE[4] = {P_CORAL, P_GOLD, P_SEA, P_SAND};   /* K1..K4: the logo's colours (style.css --k1..--k4) */

/* ---- the model, read from the running patch's binary (in the pool on the device: modular.c UI_POOL) */
#ifndef UI_POOL
#define UI_POOL
#endif
#define PG_DEVS 32u
#define PG_PAGES 160u
#define PG_ROWS 4u
typedef struct {
    const char *name;
    uint8_t nlen, pg0, npg;
    int16_t module;                                     /* >= 0: a plain module */
    uint8_t bin, track;                                 /* its index in the binary's device list; the device that drives it (0xFF none) */
    uint32_t structure;                                 /* format 34's extras: an assembly's structure (0 none) */
    const uint8_t *rows;                                /* its card rows in canonical order (module, parameter byte) pairs */
    uint8_t nrows, nmem;
    const uint8_t *mem;                                 /* the modules it is made of (#191: arming it arms them) */
} pdev_t;
typedef struct {
    const char *name;
    uint8_t nlen, part, parts, display, nrows;          /* display: 1 + the envelope module drawn above, 0 none */
    uint8_t mod[PG_ROWS], par[PG_ROWS], llen[PG_ROWS];
    const char *lab[PG_ROWS];
} ppage_t;
static pdev_t pg_dev[PG_DEVS] UI_POOL;
static char pg_tname[PG_DEVS][9] UI_POOL;              /* a Steps track's name, for its device (m1_track_name: 8 characters) */
static char pg_pname[PG_DEVS][17] UI_POOL;             /* the preset each device was set to (#194; read from the extras for a new patch) */
static ppage_t pg_page[PG_PAGES] UI_POOL;
static uint32_t pg_ndev, pg_npage, pg_built_gen = 0xFFFFFFFFu, pg_built_at;
static uint32_t pg_cur_dev, pg_cur_page;                /* the focus: the device and its page K1..K4 turn */
static uint8_t pg_strip_dirty = 1;                      /* the tabs and chips need a redraw (the focus moved) */
static uint32_t pg_toast_until;                         /* a knob just turned: its toast shown until fm1_ms */
static uint8_t pg_toast_k;
/* SELECT / ALGO turning (#221): their card (PG_CARD_DEV, PG_CARD_PAGE) alone on the screen until pg_card_until; the page
 * once they stop */
#define PG_CARD_MS 400u
#define PG_CARD_DEV 1u
#define PG_CARD_PAGE 2u
static uint32_t pg_card_until;
static uint8_t pg_card;
/* PRESET turned (#170): the next patch's name, big, until pg_patch_until; asked before the load (pg_patch_ask, at
 * pg_patch_ask_ms), started when the new patch's pages are built */
static uint32_t pg_patch_until, pg_patch_ask_ms;
static uint8_t pg_patch_ask;
/* a Page button's list on K1..K4 (#117): its button (-1: none), the step showing, whether a hold peeks at its first page */
static int8_t pg_list_btn = -1;
static uint8_t pg_list_step, pg_list_peek;

static void m1_track_name(uint32_t mod, char *out);     /* proto.c: a Steps track's name ("" none) */
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v);   /* proto.c: a row turned here (the editor follows) */
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v); /* proto.c: the running binary follows */
static void poly_row_set(uint32_t mod, uint32_t field, int32_t v); /* main.c: a poly group's setting */
static void m1_preset_stored(uint32_t structure, const char *name);   /* proto.c: a preset stored here (#195) */
static void m1_arms_now(uint32_t lo, uint32_t hi);              /* proto.c: the armed modules changed here (#191) */
static const uint8_t *pages_src(uint32_t *len);         /* the running patch's binary (proto.c m1_cur; the preview's) */
static uint32_t pages_gen(void);                        /* changes when another patch becomes current */

/* where the device pages section starts in (p, len), 0 if there is none (proto.c m1_devices_at, on any binary) */
static uint32_t pages_at(const uint8_t *p, uint32_t len)
{
    uint32_t at = eng_records_at(p, len), i, nmod, ncab, npar = 0;
    if (!at || !(p[6] & 32u))
        return 0;
    nmod = p[2];
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    for (i = 0; i < nmod; i++) {
        const def_t *d;
        if (at >= len || (p[at] & 0x7Fu) >= N_TYPES)
            return 0;
        d = &DEFS[p[at] & 0x7Fu];
        at += 1u + 4u * d->npar + (d->cvbase >= 0 ? 20u : 0u) + d->ndata;
        npar += d->npar;
    }
    at += 4u * ncab + ((p[6] & 1u) ? 4u * npar : 0u);
    if (p[6] & 4u) at += nmod;
    if (p[6] & 8u) {
        if (at >= len) return 0;
        at += 1u + 4u * p[at];
    }
    if ((p[6] & 16u) && !(at = eng_notes_end(p, len, at)))
        return 0;
    return at < len ? at : 0;
}

/* bit 7 of a row's parameter byte: a setting of the poly group of that Part (patchbin.ts POLY_ROW_PARAMS): the voices,
 * assign, legato, priority, unison */
#define POLY_ROW 0x80u
#define POLY_FIELDS 5u
static int row_ok(uint32_t m, uint32_t par)
{
    if (par & POLY_ROW)
        return eng_type(m) == T_PART && (par & 0x7Fu) < POLY_FIELDS && eng_module_group(m) > 0;
    return eng_type(m) >= 0 && par < DEFS[eng_type(m)].npar;
}

/* a poly row's value (an integer) and its largest */
static int32_t poly_value(uint32_t m, uint32_t f)
{
    uint32_t g = (uint32_t)eng_module_group(m) - 1u;
    return f == 4u ? eng_poly_unison(g) : eng_poly_get(g, f);
}
static int32_t poly_max(uint32_t f) { return f == 0u ? ENG_MAX_PARTS : f == 4u ? 1 : 2; }

/* a plain module's pages: its parameters, four to a page, the module's name; an envelope draws its shape on the first */
static void pages_plain(uint32_t m)
{
    int t = eng_type(m);
    const def_t *d;
    uint32_t j, n;
    if (t < 0 || pg_ndev >= PG_DEVS)
        return;
    d = &DEFS[t];
    n = (d->npar + PG_ROWS - 1u) / PG_ROWS;
    if (!n || pg_npage + n > PG_PAGES)
        return;
    pg_dev[pg_ndev].name = d->name;
    if (t == T_STEPS) {                                 /* a Steps track: its name if it has one, else STEPS (#196) */
        m1_track_name(m, pg_tname[pg_ndev]);
        if (pg_tname[pg_ndev][0])
            pg_dev[pg_ndev].name = pg_tname[pg_ndev];
    }
    pg_dev[pg_ndev].nlen = (uint8_t)str_len(pg_dev[pg_ndev].name);
    pg_dev[pg_ndev].pg0 = (uint8_t)pg_npage;
    pg_dev[pg_ndev].npg = (uint8_t)n;
    pg_dev[pg_ndev].module = (int16_t)m;
    for (j = 0; j < n; j++) {
        ppage_t *pg = &pg_page[pg_npage + j];
        uint32_t r;
        pg->name = pg_dev[pg_ndev].name;
        pg->nlen = pg_dev[pg_ndev].nlen;
        pg->part = (uint8_t)j;
        pg->parts = (uint8_t)n;
        pg->display = (uint8_t)(j == 0 && (t == T_ADSR || t == T_ENV) ? m + 1u : 0u);
        pg->nrows = 0;
        for (r = 0; r < PG_ROWS && j * PG_ROWS + r < d->npar; r++) {
            pg->mod[r] = (uint8_t)m;
            pg->par[r] = (uint8_t)(j * PG_ROWS + r);
            pg->lab[r] = d->pname[j * PG_ROWS + r];
            pg->llen[r] = (uint8_t)str_len(pg->lab[r]);
            pg->nrows++;
        }
    }
    pg_npage += n;
    pg_ndev++;
}

/* the device extras of format 34 (#194, #197) into pg_dev: the driving track (as a pg_dev index), the structure, the rows
 * in canonical order; with fresh != 0 (another patch) also the preset names into pg_pname */
static uint8_t pg_names_fresh = 1;
static void pages_extras(const uint8_t *p, uint32_t len)
{
    uint32_t at, cnt, k, i, j;
    for (i = 0; i < pg_ndev; i++) {
        pg_dev[i].track = 0xFFu;
        pg_dev[i].structure = 0;
        pg_dev[i].rows = 0;
        pg_dev[i].nrows = 0;
        pg_dev[i].mem = 0;
        pg_dev[i].nmem = 0;
        if (pg_names_fresh)
            pg_pname[i][0] = 0;
    }
    if (!p || !(p[7] & ENG_FLAG_EXTRAS) || !(at = pages_at(p, len)) || !(at = eng_devices_end(p, len, at)) || !eng_extras_end(p, len, at)) {
        pg_names_fresh = 0;
        return;
    }
    cnt = p[at++];
    for (k = 0; k < cnt; k++) {
        uint32_t nl = p[at + 5u], tr = p[at];
        for (i = 0; i < pg_ndev && pg_dev[i].bin != k; i++)
            ;
        if (i < pg_ndev) {
            for (j = 0; j < pg_ndev && (tr == 0xFFu || pg_dev[j].bin != tr); j++)
                ;
            pg_dev[i].track = (uint8_t)(j < pg_ndev ? j : 0xFFu);
            pg_dev[i].structure = (uint32_t)p[at + 1u] | (uint32_t)p[at + 2u] << 8 | (uint32_t)p[at + 3u] << 16 | (uint32_t)p[at + 4u] << 24;
            if (pg_names_fresh) {
                for (j = 0; j < nl && j < 16u; j++)
                    pg_pname[i][j] = (char)p[at + 6u + j];
                pg_pname[i][j] = 0;
            }
        }
        at += 6u + nl;
        if (i < pg_ndev) {
            pg_dev[i].nrows = p[at];
            pg_dev[i].rows = p + at + 1u;
        }
        at += 1u + 2u * p[at];
        if (i < pg_ndev) {
            pg_dev[i].nmem = p[at];
            pg_dev[i].mem = p + at + 1u;
        }
        at += 1u + p[at];
    }
    pg_names_fresh = 0;
}

/* read the device pages of the running patch again (another patch, or its binary moved: a step value added) */
static void pages_build(void)
{
    uint32_t len, at, n, d;
    const uint8_t *p = pages_src(&len);
    pg_ndev = pg_npage = 0;
    pg_built_gen = pages_gen();
    pg_built_at = at = p ? pages_at(p, len) : 0;
    pg_strip_dirty = 1;
    if (!at || !eng_devices_end(p, len, at))
        return;
    n = p[at++];
    for (d = 0; d < n && pg_ndev < PG_DEVS; d++) {
        uint32_t np, g;
        if (p[at] == 0u) {
            uint32_t was = pg_ndev;
            pages_plain(p[at + 1u]);
            if (pg_ndev > was)
                pg_dev[was].bin = (uint8_t)d;
            at += 2u;
            continue;
        }
        at++;
        pg_dev[pg_ndev].name = (const char *)p + at + 1u;
        pg_dev[pg_ndev].nlen = p[at];
        at += 1u + p[at];
        np = p[at++];
        pg_dev[pg_ndev].pg0 = (uint8_t)pg_npage;
        pg_dev[pg_ndev].module = -1;
        for (g = 0; g < np; g++) {
            ppage_t *pg = pg_npage < PG_PAGES ? &pg_page[pg_npage] : 0;
            uint32_t r, nr;
            if (pg) {
                pg->name = (const char *)p + at + 1u;
                pg->nlen = p[at];
            }
            at += 1u + p[at];
            nr = p[at + 3u];
            if (pg) {
                pg->part = p[at];
                pg->parts = p[at + 1u];
                pg->display = p[at + 2u];
                pg->nrows = 0;
            }
            at += 4u;
            for (r = 0; r < nr; r++) {
                if (pg && pg->nrows < PG_ROWS && p[at] < (uint32_t)eng_nmodules() && eng_type(p[at]) >= 0 && row_ok(p[at], p[at + 1u])) {
                    pg->mod[pg->nrows] = p[at];
                    pg->par[pg->nrows] = p[at + 1u];
                    pg->lab[pg->nrows] = (const char *)p + at + 3u;
                    pg->llen[pg->nrows] = p[at + 2u];
                    pg->nrows++;
                }
                at += 2u;
                at += 1u + p[at];
            }
            if (pg && pg->nrows)
                pg_npage++;
        }
        pg_dev[pg_ndev].npg = (uint8_t)(pg_npage - pg_dev[pg_ndev].pg0);
        pg_dev[pg_ndev].bin = (uint8_t)d;
        if (pg_dev[pg_ndev].npg)
            pg_ndev++;
    }
    pages_extras(p, len);
    if (pg_cur_dev >= pg_ndev)
        pg_cur_dev = 0;
    if (pg_ndev && pg_cur_page >= pg_dev[pg_cur_dev].npg)
        pg_cur_page = 0;
}

/* Main, a Steps track or the Output: the environment's frame, not where a patch opens (pages.ts homeDevice, #196) */
static int pages_frame(uint32_t d)
{
    int t = pg_dev[d].module >= 0 ? eng_type((uint32_t)pg_dev[d].module) : -1;
    return t == T_FM1 || t == T_STEPS || t == T_OUTPUT;
}

/* where a fresh patch's focus goes: the first device that is no frame, else the first */
static uint32_t pages_home(void)
{
    uint32_t d;
    for (d = 0; d < pg_ndev; d++)
        if (!pages_frame(d))
            return d;
    return 0;
}

/* the Steps track (its index among the patch's tracks) the device in focus is, -1 when it is none (#196) */
static int pages_focus_track(void)
{
    int m, t;
    if (pg_cur_dev >= pg_ndev || pg_dev[pg_cur_dev].module < 0)
        return -1;
    m = pg_dev[pg_cur_dev].module;
    if (eng_type((uint32_t)m) != T_STEPS)
        return -1;
    for (t = 0; t < eng_steps_count(); t++)
        if (eng_steps_module((uint32_t)t) == m)
            return t;
    return -1;
}

/* the model, current with the running patch */
static void pages_ensure(void)
{
    uint32_t len;
    const uint8_t *p = pages_src(&len);
    int fresh = pg_built_gen != pages_gen();
    if (fresh || (p && pages_at(p, len) != pg_built_at)) {
        if (fresh)
            pg_names_fresh = 1;
        pages_build();
        if (fresh) {                                    /* another patch: its home device's first page, no list */
            pg_cur_dev = pages_home();
            pg_cur_page = 0;
            pg_list_btn = -1;
            pg_list_peek = 0;
            pg_card_until = 0;
            if (pg_patch_ask && fm1_ms - pg_patch_ask_ms < 2000u) {   /* PRESET loaded it: its name over the bars */
                pg_patch_until = fm1_ms + 1000u;
                pg_toast_until = 0;
            }
            pg_patch_ask = 0;
        }
    }
}

/* PRESET or a program change is about to load another patch: show its name once it runs (panel.c, main.c) */
static void pages_patch_ask(void)
{
    pg_patch_ask = 1;
    pg_patch_ask_ms = fm1_ms;
}

/* GLO (#199): the FM-1's own quick page, never a patch's (the patch's tempo and morph are on Main's device page, #196).
 * K1 the MIDI channel, K2 MIDI clock in, K3 MIDI out, K4 the LEDs: the menu's settings (menu.c setting_step), saved with
 * the state (SAVE). A row of it is a setting, not a module's parameter: SETTING_ROW in its module byte. */
#define SETTING_ROW 0xFFu
static void setting_step(uint32_t row, int32_t s);      /* menu.c */
static void menu_value(uint32_t row, char *out);
static ppage_t pg_glo;
static const ppage_t *glo_page(void)
{
    static const char *const LAB[4] = {"MIDI CHANNEL", "CLOCK IN", "MIDI OUT", "LEDS"};
    static const uint8_t ROW[4] = {MR_CH, MR_CLOCK, MR_MOUT, MR_LEDS};
    uint32_t k;
    pg_glo.name = "GLOBAL";
    pg_glo.nlen = 6;
    pg_glo.part = 0;
    pg_glo.parts = 1;
    pg_glo.display = 0;
    pg_glo.nrows = PG_ROWS;
    for (k = 0; k < PG_ROWS; k++) {
        pg_glo.mod[k] = SETTING_ROW;
        pg_glo.par[k] = ROW[k];
        pg_glo.lab[k] = LAB[k];
        pg_glo.llen[k] = (uint8_t)str_len(LAB[k]);
    }
    return &pg_glo;
}

/* a setting's place in its range, 0..width (its bar) */
static uint32_t setting_bar(uint32_t row, uint32_t width)
{
    return row == MR_CH ? cfg.ch * width / 16u : row == MR_LEDS ? cfg.leds * width / 2u
         : (row == MR_CLOCK ? cfg.clock_in : row == MR_MOUT ? cfg.midi_out : cfg.accel) ? width : 0u;
}

static const ppage_t *pages_now(void)
{
    pages_ensure();
    if (page == PAGE_GLO)
        return glo_page();
    return pg_ndev ? &pg_page[pg_dev[pg_cur_dev].pg0 + pg_cur_page] : 0;
}

/* ---- the focus */

/* the page list of button b in the running patch (the button kinds section, flag bit 6): its length, *l = its (device,
 * page) pairs; 0 if b is no Page button */
static uint32_t pages_list(uint32_t b, const uint8_t **l)
{
    uint32_t len, at, k;
    const uint8_t *p = pages_src(&len), *kind;
    if (!p || !(p[6] & 64u) || b >= ENG_PANEL_BUTTONS || !(at = pages_at(p, len)) || !(at = eng_devices_end(p, len, at))
        || ((p[7] & ENG_FLAG_EXTRAS) && !(at = eng_extras_end(p, len, at))) || !eng_buttons_end(p, len, at))
        return 0;
    kind = p + at;
    at += ENG_PANEL_BUTTONS;
    for (k = 0; k < b; k++)
        if (kind[k] == ENG_BTN_TOGGLE || kind[k] == ENG_BTN_PAGE)
            at += 1u + (kind[k] == ENG_BTN_PAGE ? 2u : 1u) * p[at];
    if (kind[b] != ENG_BTN_PAGE)
        return 0;
    *l = p + at + 1u;
    return p[at];
}

/* put a device page on K1..K4 (indices into the section, clamped); returns whether it moved. The page shows at once
 * (the editor, a Page button, HOME's trail): a card of SELECT / ALGO ends */
static int pages_focus(uint32_t d, uint32_t g)
{
    pages_ensure();
    if (!pg_ndev)
        return 0;
    d = d < pg_ndev ? d : pg_ndev - 1u;
    g = g < pg_dev[d].npg ? g : pg_dev[d].npg - 1u;
    if (d == pg_cur_dev && g == pg_cur_page)
        return 0;
    pg_patch_until = 0;
    pg_card_until = 0;
    pg_cur_dev = d;
    pg_cur_page = g;
    pg_strip_dirty = 1;
    pg_toast_until = 0;
    return 1;
}

/* SELECT (PG_CARD_DEV) or ALGO (PG_CARD_PAGE) just moved the focus on the device page: its card until they stop (#221) */
static void pages_card(uint32_t kind)
{
    pg_card = (uint8_t)kind;
    pg_card_until = fm1_ms + PG_CARD_MS;
    pg_patch_until = 0;
    pg_toast_until = 0;
}
static int pages_carding(void) { return page == 0 && pg_card && fm1_ms < pg_card_until; }

/* SELECT: the next / previous device (wrapping), on its first page */
static int pages_select(int32_t s)
{
    pages_ensure();
    if (!pg_ndev || !s)
        return 0;
    return pages_focus((uint32_t)(((int32_t)pg_cur_dev + s % (int32_t)pg_ndev + (int32_t)pg_ndev) % (int32_t)pg_ndev), 0);
}

/* ALGO: the next / previous page of the device (wrapping) */
static int pages_page(int32_t s)
{
    uint32_t n;
    pages_ensure();
    if (!pg_ndev || !s)
        return 0;
    n = pg_dev[pg_cur_dev].npg;
    return pages_focus(pg_cur_dev, (uint32_t)(((int32_t)pg_cur_page + s % (int32_t)n + (int32_t)n) % (int32_t)n));
}

/* knob k turned by `clicks` (fast: five times as far): its row's new value; *mod / *par say which parameter. -1: no row */
static int pages_turn(uint32_t k, int32_t clicks, int fast, uint32_t *mod, uint32_t *par, int32_t *v)
{
    const ppage_t *pg = pages_now();
    const def_t *d;
    uint32_t m, j;
    if (!pg || k >= pg->nrows || !clicks)
        return -1;
    m = pg->mod[k];
    j = pg->par[k];
    pg_toast_k = (uint8_t)k;
    pg_toast_until = fm1_ms + 1000u;
    pg_patch_until = 0;
    pg_card_until = 0;                                  /* (turning SELECT / ALGO: the page they reached, whole, at once) */
    *mod = m;
    *par = j;
    if (m == SETTING_ROW) {                             /* GLO: an FM-1 setting, one step a click, applied here */
        setting_step(j, clicks);
        *v = 0;
        return 2;
    }
    if (j & POLY_ROW) {                                 /* a poly group's setting: one step a click (main.c applies it) */
        *v = clampi(poly_value(m, j & 0x7Fu) + (clicks > 0 ? 1 : -1), (j & 0x7Fu) == 0u ? 1 : 0, poly_max(j & 0x7Fu));
        return 1;
    }
    d = &DEFS[eng_type(m)];
    if (d->pchoice && d->pchoice[j]) {                  /* a choice steps one name a click */
        int32_t n = 0, i = (eng_get_param(m, j) + 32768) >> 16;
        while (d->pchoice[j][n])
            n++;
        i = clampi(i + (clicks > 0 ? 1 : -1), 0, n - 1);
        *v = i << 16;
    } else if (eng_param_is_log(m, j)) {
        *v = eng_step_param(m, j, clicks * (fast ? 5 : 1), 655);   /* 1/100 of the octaves a click */
    } else {
        *v = clampi(eng_get_param(m, j) + clicks * (fast ? 5 : 1) * d->pinc[j], d->pmin[j], d->pmax[j]);
    }
    return 0;
}

/* knob k set to a position u (Q16 0..1) of its row's range (MIDI CC 16..19): as pages_turn */
static int pages_set_unit(uint32_t k, int32_t u, uint32_t *mod, uint32_t *par, int32_t *v)
{
    const ppage_t *pg = pages_now();
    const def_t *d;
    uint32_t m, j;
    if (!pg || k >= pg->nrows)
        return -1;
    m = pg->mod[k];
    j = pg->par[k];
    if (m == SETTING_ROW)                               /* (an FM-1 setting: not from MIDI) */
        return -1;
    pg_toast_k = (uint8_t)k;
    pg_toast_until = fm1_ms + 1000u;
    pg_patch_until = 0;
    pg_card_until = 0;                                  /* (turning SELECT / ALGO: the page they reached, whole, at once) */
    *mod = m;
    *par = j;
    if (j & POLY_ROW) {
        int32_t lo = (j & 0x7Fu) == 0u ? 1 : 0, hi = poly_max(j & 0x7Fu);
        *v = lo + (int32_t)((((int64_t)u * (hi - lo)) + 32768) >> 16);
        return 1;
    }
    d = &DEFS[eng_type(m)];
    if (d->pchoice && d->pchoice[j]) {
        int32_t n = 0;
        while (d->pchoice[j][n])
            n++;
        *v = (int32_t)((((int64_t)u * (n - 1)) + 32768) >> 16) << 16;
    } else {
        *v = value_of(d, j, u);
    }
    return 0;
}

/* where knob k's row stands in its range, 0..127 (MIDI out) */
static uint32_t pages_cc(uint32_t k)
{
    const ppage_t *pg = pages_now();
    if (!pg || k >= pg->nrows)
        return 0;
    if (pg->mod[k] == SETTING_ROW)
        return setting_bar(pg->par[k], 127u);
    if (pg->par[k] & POLY_ROW)
        return (uint32_t)(poly_value(pg->mod[k], pg->par[k] & 0x7Fu) * 127 / poly_max(pg->par[k] & 0x7Fu));
    return (uint32_t)((unit_of(&DEFS[eng_type(pg->mod[k])], pg->par[k], eng_get_param(pg->mod[k], pg->par[k])) * 127 + 32768) >> 16);
}

/* ---- drawing */

/* a name from the binary or defs.h in capitals, cut to max characters */
static void caps(char *out, const char *s, uint32_t n, uint32_t max)
{
    uint32_t i;
    n = n > max ? max : n;
    for (i = 0; i < n; i++)
        out[i] = s[i] >= 'a' && s[i] <= 'z' ? (char)(s[i] - 32) : s[i];
    out[n] = 0;
}

/* a parameter's value and its unit apart: "2.40" "kHz", "420" "ms", a choice by name */
static void value_parts(const def_t *d, uint32_t j, int32_t q16, char *num, char *unit)
{
    const char *u = d->punit ? d->punit[j] : "";
    unit[0] = 0;
    if (d->pchoice && d->pchoice[j]) {
        put_param(num, d, j, q16);
        return;
    }
    if (str_eq(u, "HZ") && q16 >= (1000 << 16)) {        /* kilohertz */
        *put_num(num, (int32_t)(((int64_t)q16 + 500) / 1000)) = 0;
        put(unit, "kHz")[0] = 0;
        return;
    }
    if (str_eq(u, "S") && q16 < 65536) {                 /* below a second: milliseconds (to a tenth below 100) */
        int32_t t = (int32_t)(((int64_t)q16 * 10000 + 32768) >> 16);
        char *e;
        if (t >= 1000)
            fmt_int(num, (t + 5) / 10);
        else {
            fmt_int(num, t / 10);
            e = num + str_len(num);
            *e++ = '.';
            *e++ = (char)('0' + t % 10);
            *e = 0;
        }
        put(unit, "ms")[0] = 0;
        return;
    }
    *put_num(num, q16) = 0;
    put(unit, str_eq(u, "HZ") ? "Hz" : str_eq(u, "S") ? "s" : str_eq(u, "MS") ? "ms" : str_eq(u, "DB") ? "dB" : str_eq(u, "BPM") ? "bpm" : str_eq(u, "CT") ? "ct" : str_eq(u, "ST") ? "st" : str_eq(u, "OCT") ? "oct" : u)[0] = 0;
}

/* a row's value as text and its bar positions (base, live) over `width` px: a parameter, or a poly group's setting */
static void row_show(const ppage_t *pg, uint32_t k, char *num, char *unit, uint32_t width, uint32_t *base, uint32_t *live)
{
    uint32_t m = pg->mod[k], j = pg->par[k];
    if (m == SETTING_ROW) {                             /* GLO: one of the FM-1's settings */
        menu_value(j, num);
        unit[0] = 0;
        *base = *live = setting_bar(j, width);
        return;
    }
    if (j & POLY_ROW) {
        uint32_t f = j & 0x7Fu;
        int32_t v = poly_value(m, f);
        static const char *const UNI[2] = {"OFF", "ON"};
        unit[0] = 0;
        if (f == 0u)
            fmt_int(num, v);
        else
            put(num, f == 1u ? POLY_ASSIGN_NAME[clampi(v, 0, 2)] : f == 2u ? POLY_LEGATO_NAME[clampi(v, 0, 2)] : f == 3u ? POLY_PRIORITY_NAME[clampi(v, 0, 2)] : UNI[v ? 1 : 0])[0] = 0;
        *base = *live = (uint32_t)(v * (int32_t)width / poly_max(f));
        return;
    }
    if (eng_type(m) < 0 || j >= DEFS[eng_type(m)].npar) {   /* a row that is not the running patch's: nothing to show */
        put(num, "-")[0] = 0;
        unit[0] = 0;
        *base = *live = 0;
        return;
    }
    {
        const def_t *d = &DEFS[eng_type(m)];
        int32_t v = eng_get_param(m, j), e = eng_get_eff(m, j);
        value_parts(d, j, v, num, unit);
        *base = param_bar(d, j, v, width);
        *live = param_bar(d, j, e, width);
    }
}

/* the device strip: tabs from the left, scrolled so the one in focus shows; the patch's message replaces it (ui_msg) */
static void pages_strip(void)
{
    char t[20];
    uint32_t first = 0, x, i, w[PG_DEVS];
    if (pages_carding()) {                              /* (a message ended over the card: the card's colour back) */
        lcd_fill(0, 0, BATT_X, 20, pg_card == PG_CARD_PAGE ? P_CARD_PAGE : P_CARD_DEV);
        return;
    }
    lcd_fill(0, 0, BATT_X, 20, P_STRIP);                /* (x BATT_X on: the battery's cell, ui.c) */
    if (page == PAGE_GLO || page == PAGE_ENV) {         /* GLO: GLOBAL and the patch, on coral; the environment's on lilac */
        uint16_t bg = page == PAGE_ENV ? P_LILAC : P_CORAL;
        char nm[32], num[8], *q = nm;
        if (cur_preset < M1_SLOTS) {
            fmt_int(num, (int32_t)cur_preset + 1);
            if (cur_preset < 9u)
                *q++ = '0';
            q = put(q, num);
            *q++ = ' ';
        }
        put(q, patch_label ? patch_label : "")[0] = 0;
        nm[22] = 0;
        lcd_fill(0, 0, BATT_X, 20, bg);
        text_bc(&FONT_S, 8, 3, page == PAGE_ENV ? "ENVIRONMENT" : "GLOBAL", P_NIGHT, bg, 100, TA_LEFT);
        text_bc(&FONT_S, 108, 3, nm, P_NIGHT, bg, 106, TA_RIGHT);
        return;
    }
    if (pg_list_btn >= 0 && pg_ndev) {                  /* a Page button's list: "SEL 2/3 · AMP ENV" */
        char bar[48], num[8], *q = bar;
        const uint8_t *l;
        uint32_t n = pages_list((uint32_t)pg_list_btn, &l);
        const ppage_t *pg = &pg_page[pg_dev[pg_cur_dev].pg0 + pg_cur_page];
        if (!panel_label((uint32_t)pg_list_btn, t))
            put(t, PANEL_BTN_NAME[pg_list_btn])[0] = 0;
        q = put(q, t);
        *q++ = ' ';
        fmt_int(num, (int32_t)(pg_list_peek ? 1u : pg_list_step + 1u));
        q = put(q, num);
        *q++ = '/';
        fmt_int(num, (int32_t)n);
        q = put(q, num);
        q = put(q, "  -  ");
        caps(q, pg->name, pg->nlen, 14);
        q += str_len(q);
        if (pg->parts > 1u) {
            *q++ = ' ';
            fmt_int(num, pg->part + 1);
            q = put(q, num);
            *q++ = '/';
            fmt_int(num, pg->parts);
            q = put(q, num);
        }
        *q = 0;
        lcd_fill(0, 0, BATT_X, 20, P_SEA);
        text_bc(&FONT_S, 0, 3, bar, P_NIGHT, P_SEA, BATT_X, TA_CENTER);
        return;
    }
    if (!pg_ndev) {
        text_bc(&FONT_S, 8, 3, "NO DEVICES ON THIS PATCH", P_FAINT, P_STRIP, 0, TA_LEFT);
        return;
    }
    for (i = 0; i < pg_ndev; i++) {
        caps(t, pg_dev[i].name, pg_dev[i].nlen, 14);
        w[i] = text_w(&FONT_S, t, -1) + 14u;
    }
    for (;;) {                                          /* scroll: the tab in focus ends inside the strip */
        uint32_t end = 0;
        for (i = first; i <= pg_cur_dev; i++)
            end += w[i];
        if (end <= BATT_X - 12u || first >= pg_cur_dev)
            break;
        first++;
    }
    x = first ? 10u : 0u;
    if (first)
        text_bc(&FONT_S, 1, 3, "<", P_FAINT, P_STRIP, 8, TA_LEFT);
    for (i = first; i < pg_ndev && x < BATT_X; i++) {
        int on = i == pg_cur_dev;
        uint16_t bg = on ? P_INK : P_STRIP, fg = on ? P_NIGHT : pg_dev[i].module >= 0 ? P_SKY : P_DIM;
        caps(t, pg_dev[i].name, pg_dev[i].nlen, 14);
        text_bc(&FONT_S, x, 3, t, fg, bg, w[i] > BATT_X - x ? BATT_X - x : w[i], TA_CENTER);
        if (on) {
            lcd_fill(x, 0, w[i] > BATT_X - x ? BATT_X - x : w[i], 3, bg);
            lcd_fill(x, 17, w[i] > BATT_X - x ? BATT_X - x : w[i], 3, bg);
        }
        x += w[i];
    }
}

/* a page before its device's first heading: its section carries the device's name, which the tab above already shows */
static int pages_unheaded(const ppage_t *pg, const pdev_t *d)
{
    uint32_t i;
    if (pg->nlen != d->nlen)
        return 0;
    for (i = 0; i < pg->nlen; i++)
        if (pg->name[i] != d->name[i])
            return 0;
    return 1;
}

/* the pages of the device in focus, by heading: the current group "FILTER 1/2" in seafoam, its neighbours by name, the
 * rest by their first letter; the pages before the first heading are "PAGE 1/2", not the device's name again (#154) */
static void pages_chips(void)
{
    char t[24], num[8];
    uint32_t x = 4, i, g0 = pg_dev[pg_cur_dev].pg0, n = pg_dev[pg_cur_dev].npg, cur = pg_cur_page, grp = 0, cur_grp = 0;
    lcd_fill(0, 20, 240, 18, P_NIGHT);
    for (i = 0; i < n; i++) {                           /* which heading group the current page is in */
        if (i && pg_page[g0 + i].part == 0u)
            grp++;
        if (i == cur)
            cur_grp = grp;
    }
    for (i = 0, grp = 0; i < n && x < 236u; i++) {
        const ppage_t *pg = &pg_page[g0 + i];
        uint32_t w, gap;
        char *p;
        if (i && pg->part == 0u)
            grp++;
        if (pg->part != 0u && grp != cur_grp)
            continue;                                   /* another heading's further pages: one chip per heading */
        if (grp == cur_grp && pg->part != (cur < n ? pg_page[g0 + cur].part : 0u))
            continue;                                   /* the current heading: one chip, the page in focus */
        gap = grp > cur_grp ? grp - cur_grp : cur_grp - grp;
        if (pages_unheaded(pg, &pg_dev[pg_cur_dev]))
            caps(t, "PAGE", 4u, gap <= 1u ? 12u : 1u);
        else
            caps(t, pg->name, pg->nlen, gap <= 1u ? 12u : 1u);
        p = t + str_len(t);
        if (grp == cur_grp && pg->parts > 1u) {
            *p++ = ' ';
            fmt_int(num, pg->part + 1);
            p = put(p, num);
            *p++ = '/';
            fmt_int(num, pg->parts);
            p = put(p, num);
            *p = 0;
        }
        w = text_w(&FONT_S, t, -1) + 8u;
        if (x + w > 238u)
            w = 238u - x;
        text_bc(&FONT_S, x, 22, t, grp == cur_grp ? P_NIGHT : P_DIM, grp == cur_grp ? P_SEA : P_PANEL, w, TA_CENTER);
        x += w + 2u;
    }
}

#define ROWS_Y 41u
#define ROW_H 36u
#define ROW_GAP 4u
#define ROWS_END (ROWS_Y + 4u * ROW_H + 3u * ROW_GAP)
#define BAR_X 6u
#define BAR_W 228u
#define RAIL_Y 206u
#define FOOT_Y 214u

/* a mixed with b: a by 0..16 sixteenths (RGB565) */
static uint16_t mix565(uint16_t a, uint16_t b, uint32_t k)
{
    uint32_t r = ((a >> 11) * k + (b >> 11) * (16u - k) + 8u) >> 4, g = (((a >> 5) & 63u) * k + ((b >> 5) & 63u) * (16u - k) + 8u) >> 4,
             bl = ((a & 31u) * k + (b & 31u) * (16u - k) + 8u) >> 4;
    return (uint16_t)(r << 11 | g << 5 | bl);
}

/* glyph row r of s (font f) blended in fg onto whatever row[] already holds, from x (row[] is w px wide) */
static void text_onto(uint16_t *row, uint32_t w, const font_t *f, uint32_t r, const char *s, uint32_t x, uint16_t fg)
{
    uint32_t px = x;
    int32_t k;
    if (r >= f->h)
        return;
    for (k = 0; s[k]; k++) {
        uint32_t c = (uint8_t)s[k], gw, rb, j;
        const fglyph_t *g;
        const uint8_t *bits;
        uint8_t gi = c >= 0x20u && c < 0x7Fu ? f->map[c - 0x20u] : 255u;
        if (gi == 255u)
            continue;
        g = &f->g[gi];
        gw = g->w;
        rb = (gw + 1u) / 2u;
        bits = f->bits + g->off + r * rb;
        for (j = 0; j < gw; j++) {
            uint32_t a = (j & 1u) ? bits[j >> 1] & 15u : bits[j >> 1] >> 4, at = px + (uint32_t)((int32_t)j + g->x);
            if (a && at < w)
                row[at] = mix565(fg, row[at], a + (a > 7u ? 1u : 0u));
        }
        px += g->adv;
        if (px >= w)
            break;
    }
}

/* the text of s cut to fit `max` px (the rest dropped at a character) */
static void fit(char *s, const font_t *f, uint32_t max)
{
    uint32_t n = str_len(s);
    while (n && text_w(f, s, (int32_t)n) > max)
        n--;
    s[n] = 0;
}

/* knob k's bar: drawn a scanline at a time (fill, ticks, then the type blended onto them), so the text reads across the
 * fill's edge */
static void pages_bar(const ppage_t *pg, uint32_t k)
{
    static uint16_t row[BAR_W], sw[BAR_W];
    char name[24], num[20], unit[8], kn[2];
    uint32_t y0 = ROWS_Y + k * (ROW_H + ROW_GAP), base = 0, live = 0, r, i, vx = 0, ux = 0, nx = 22u;
    int used = pg && k < pg->nrows;
    uint16_t hue = KNOB_HUE[k], track = used ? P_PANEL : P_STRIP, fill = mix565(hue, P_PANEL, 6u);
    kn[0] = (char)('1' + k);
    kn[1] = 0;
    name[0] = num[0] = unit[0] = 0;
    if (used) {
        uint32_t uw, vw;
        row_show(pg, k, num, unit, BAR_W, &base, &live);
        caps(name, pg->lab[k], pg->llen[k], 16);
        uw = unit[0] ? text_w(&FONT_S, unit, -1) + 2u : 0u;
        fit(num, &FONT_M, 110u);
        vw = text_w(&FONT_M, num, -1);
        ux = BAR_W - 7u - uw + 2u;
        vx = BAR_W - 7u - uw - vw;
        fit(name, &FONT_M, vx > nx + 6u ? vx - nx - 6u : 0u);
    }
    for (r = 0; r < ROW_H; r++) {
        for (i = 0; i < BAR_W; i++)
            row[i] = used && i < base ? fill : track;
        if (used) {
            if (base >= 2u)                             /* the fill's edge in the knob's own hue */
                row[base - 2u] = row[base - 1u] = hue;
            if (live != base && r >= 4u && r < ROW_H - 4u) /* modulated: where the parameter is now */
                row[live > 1u ? live - 1u : 0u] = row[live > 1u ? live : 1u] = P_INK;
        }
        if (r >= 11u && r < 25u)                        /* the knob's square with its number */
            for (i = 6; i < 18u; i++)
                row[i] = used ? hue : P_PANEL;
        if (r >= 11u)
            text_onto(row, BAR_W, &FONT_S, r - 11u, kn, 9u, used ? P_NIGHT : P_FAINT);
        if (used) {
            if (r >= 9u) {
                text_onto(row, BAR_W, &FONT_M, r - 9u, name, nx, P_INK);
                text_onto(row, BAR_W, &FONT_M, r - 9u, num, vx, P_INK);
            }
            if (r >= 12u)
                text_onto(row, BAR_W, &FONT_S, r - 12u, unit, ux, P_DIM);
        } else if (r >= 9u)
            text_onto(row, BAR_W, &FONT_M, r - 9u, "-", nx, P_FAINT);
        if (r == 0u || r == ROW_H - 1u) {               /* rounded corners: the night shows at the four corner pixels */
            row[0] = row[BAR_W - 1u] = P_NIGHT;
        }
        for (i = 0; i < BAR_W; i++)
            sw[i] = (uint16_t)((row[i] >> 8) | (row[i] << 8));
        lcd_blit(BAR_X, y0 + r, BAR_W, 1, sw);
        lcd_sync();                                     /* sw is reused by the next row */
    }
}

/* the page rail: one segment per page of the device, the one in focus in coral, the others of its heading dimmer */
static void pages_rail(void)
{
    uint32_t g0, n, i, cur, head = 0, cur_head = 0;
    lcd_fill(0, RAIL_Y - 2u, 240, 7, P_NIGHT);
    if (!pg_ndev)
        return;
    g0 = pg_dev[pg_cur_dev].pg0;
    n = pg_dev[pg_cur_dev].npg;
    cur = pg_cur_page;
    for (i = 0; i <= cur && i < n; i++)
        if (i && pg_page[g0 + i].part == 0u)
            cur_head++;
    for (i = 0; i < n; i++) {
        uint32_t a = BAR_X + i * BAR_W / n, b = BAR_X + (i + 1u) * BAR_W / n;
        if (i && pg_page[g0 + i].part == 0u)
            head++;
        lcd_fill(a, RAIL_Y, b - a > 2u ? b - a - 2u : 1u, 3, i == cur ? P_CORAL : head == cur_head ? 0x6A06u : P_TRACK);
    }
}

/* the patch and the transport, the foot line */
static int seq_arm_label(char *out, int *rec);   /* (seq_ui.c) */
static void pages_info(void)
{
    char a[40], b[32], num[12], *p = a;
    int panel = eng_find(T_FM1), run = eng_transport_running(), rec = 0, arm = seq_arm_label(a, &rec);
    if (arm) {                                          /* a track armed (#139): ARM / REC and its name instead of the patch */
        p = a + str_len(a);
    } else if (cur_preset < M1_SLOTS) {
        fmt_int(num, (int32_t)cur_preset + 1);
        if (cur_preset < 9u)
            *p++ = '0';
        p = put(p, num);
        *p++ = ' ';
    }
    if (!arm) {
        p = put(p, patch_label ? patch_label : "");
        if (m1_edited)
            p = put(p, " *");
    }
    *p = 0;
    p = put(b, run ? "PLAY " : "STOP ");
    if (eng_clock_is_external())
        p = put(p, "MIDI");
    else {
        fmt_int(num, panel >= 0 ? (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16 : 120);
        p = put(p, num);
    }
    p = put(p, "  ");
    if (eng_groups()) {
        fmt_int(num, eng_parts());
        p = put(put(p, num), " V  ");
    }
    p = put(p, "OCT ");
    if (octave > 0)
        *p++ = '+';
    fmt_int(num, octave);
    put(p, num)[0] = 0;
    {
        uint32_t wb = text_w(&FONT_S, b, -1);
        text_bc(&FONT_S, 0, FOOT_Y, "", P_DIM, P_NIGHT, BAR_X, TA_LEFT);
        text_bc(&FONT_S, BAR_X, FOOT_Y, a, arm ? (rec ? P_REDC : P_SEA) : P_DIM, P_NIGHT, 228u - wb, TA_LEFT);
        text_bc(&FONT_S, 234u - wb, FOOT_Y, b, run ? P_SEA : P_FAINT, P_NIGHT, wb + 6u, TA_LEFT);
    }
}

/* the toasts: over the bars, centred in their height */
#define TOAST_Y (ROWS_Y + 26u)

/* one scanline of row[] (w px) out to the LCD at x, y (big endian) */
static void row_out(const uint16_t *row, uint32_t x, uint32_t y, uint32_t w)
{
    static uint16_t sw[240];
    uint32_t i;
    for (i = 0; i < w; i++)
        sw[i] = (uint16_t)((row[i] >> 8) | (row[i] << 8));
    lcd_blit(x, y, w, 1, sw);
    lcd_sync();                                         /* sw is reused by the next row */
}

/* the toast on screen (k, page) or 0xFF: a turn of the same knob redraws only the value and the bar, a scanline at a
 * time, so what does not change does not blink */
static uint8_t pg_toast_shown = 0xFFu;
static const ppage_t *pg_toast_pg;
static uint8_t pg_card_shown, pg_card_dev, pg_card_pg;  /* the card on screen (its kind, 0 none) and what it names */
static uint32_t pg_patch_shown;                         /* the patch whose name is on show: pages_gen() + 1, 0 none */

/* knob k's row at full size: its name, the value in the big type, the range bar with the live tick */
static void pages_toast(const ppage_t *pg, uint32_t k, int full)
{
    static uint16_t row[240];
    char t[24], num[20], unit[8], lo_n[20], lo_u[8], hi_n[20], hi_u[8];
    uint32_t m = pg->mod[k], j = pg->par[k], xw, i, r, ok = 1, bw = 216, base, live, nx, ny, ux, uy;
    const font_t *nf;
    row_show(pg, k, num, unit, bw, &base, &live);
    if (full || pg_toast_shown != k || pg_toast_pg != pg) {
        pg_toast_shown = (uint8_t)k;
        pg_toast_pg = pg;
        lcd_fill(0, ROWS_Y, 240, ROWS_END - ROWS_Y, P_NIGHT);
        t[0] = 'K';
        t[1] = (char)('1' + k);
        t[2] = ' ';
        caps(t + 3, pg->lab[k], pg->llen[k], 16);
        text_bc(&FONT_S, 12, TOAST_Y + 2u, t, KNOB_HUE[k], P_NIGHT, 0, TA_LEFT);
        if (!(j & POLY_ROW) && eng_type(m) >= 0 && j < DEFS[eng_type(m)].npar) {
            const def_t *d = &DEFS[eng_type(m)];
            value_parts(d, j, d->pmin[j], lo_n, lo_u);
            value_parts(d, j, d->pmax[j], hi_n, hi_u);
            put(put(put(t, lo_n), " "), lo_u)[0] = 0;
            text_bc(&FONT_S, 12, TOAST_Y + 75u, t, P_FAINT, P_NIGHT, 100, TA_LEFT);
            put(put(put(t, hi_n), " "), hi_u)[0] = 0;
            text_bc(&FONT_S, 128, TOAST_Y + 75u, t, P_FAINT, P_NIGHT, 100, TA_RIGHT);
        }
    }
    for (i = 0; num[i]; i++)                            /* the big type has digits and a few letters: else the large one */
        if (num[i] < 0x20 || num[i] > 0x7E || FONT_XL.map[num[i] - 0x20] == 255u)
            ok = 0;
    nf = ok ? &FONT_XL : &FONT_L;                       /* the value line's band: 42 rows from TOAST_Y + 16 */
    xw = text_w(nf, num, -1);
    nx = ok ? 10u : 12u;
    ny = ok ? 0u : 10u;
    ux = nx + xw + 6u;
    uy = ok ? 20u : 14u;
    for (r = 0; r < FONT_XL.h; r++) {
        for (i = 0; i < 240u; i++)
            row[i] = P_NIGHT;
        if (r >= ny)
            text_onto(row, 240, nf, r - ny, num, nx, P_INK);
        if (r >= uy)
            text_onto(row, 240, &FONT_M, r - uy, unit, ux, P_DIM);
        row_out(row, 0, TOAST_Y + 16u + r, 240);
    }
    for (r = 0; r < 14u; r++) {                         /* the bar (rows 3..10) and the live tick across it */
        for (i = 0; i < bw; i++)
            row[i] = r >= 3u && r < 11u ? (i < base ? KNOB_HUE[k] : P_TRACK) : P_NIGHT;
        if (live != base)
            row[live > 1u ? live - 1u : 0u] = row[live > 1u ? live : 1u] = P_INK;
        row_out(row, 12, TOAST_Y + 61u + r, bw);
    }
}

/* SELECT / ALGO turning (#221): the card alone on the whole screen, fill and type only. SELECT's: the device's name big
 * and "2/5" small, on red; ALGO's: the device's name small, the page's big ("FILTER 1/2" as the chips name it), "3/7"
 * of the device's pages small, on blue. Three bands of type (CARD_Y0, CARD_Y1, CARD_Y2), each painting the full width in
 * the card's colour. full: the rest of the screen filled too (the first click, another kind of card); else only the
 * bands (the next click: no blink) */
#define CARD_Y0 84u
#define CARD_Y1 104u
#define CARD_Y2 134u
static void pages_card_draw(int full)
{
    char t[40], num[8], *p;
    const pdev_t *dv = &pg_dev[pg_cur_dev];
    const ppage_t *pg = &pg_page[dv->pg0 + pg_cur_page];
    int pgc = pg_card == PG_CARD_PAGE;
    uint16_t bg = pgc ? P_CARD_PAGE : P_CARD_DEV;
    if (full) {                                         /* around the bands (they paint their own rows) */
        lcd_fill(0, 0, BATT_X, BAR_H, bg);           /* (not the battery's cell, ui.c) */
        lcd_fill(0, BAR_H, 240, CARD_Y0 - BAR_H, bg);
        lcd_fill(0, CARD_Y0 + FONT_S.h, 240, CARD_Y1 - CARD_Y0 - FONT_S.h, bg);
        lcd_fill(0, CARD_Y1 + FONT_L.h, 240, CARD_Y2 - CARD_Y1 - FONT_L.h, bg);
        lcd_fill(0, CARD_Y2 + FONT_S.h, 240, 240u - CARD_Y2 - FONT_S.h, bg);
    }
    caps(t, dv->name, dv->nlen, 16);
    if (pgc)
        text_bc(&FONT_S, 0, CARD_Y0, t, P_INK, bg, 240, TA_CENTER);
    else if (full)
        text_bc(&FONT_S, 0, CARD_Y0, "", P_INK, bg, 240, TA_CENTER);
    if (pgc) {                                          /* the page as the chips name it */
        if (pages_unheaded(pg, dv))
            caps(t, "PAGE", 4u, 4u);
        else
            caps(t, pg->name, pg->nlen, 16);
        p = t + str_len(t);
        if (pg->parts > 1u) {
            *p++ = ' ';
            fmt_int(num, pg->part + 1);
            p = put(p, num);
            *p++ = '/';
            fmt_int(num, pg->parts);
            p = put(p, num);
            *p = 0;
        }
    }
    fit(t, &FONT_L, 228);
    text_bc(&FONT_L, 0, CARD_Y1, t, P_INK, bg, 240, TA_CENTER);
    fmt_int(num, (int32_t)(pgc ? pg_cur_page : pg_cur_dev) + 1);
    p = put(t, num);
    *p++ = '/';
    fmt_int(num, (int32_t)(pgc ? dv->npg : pg_ndev));
    put(p, num)[0] = 0;
    text_bc(&FONT_S, 0, CARD_Y2, t, P_INK, bg, 240, TA_CENTER);
}

/* the patch PRESET just loaded, big: its name, under it the slot and how many the bank holds. full: the band cleared
 * first; else only the two lines, each painting its own field (a turn while it shows: no blink) */
static void pages_patch_toast(int full)
{
    char t[40], num[8], *p;
    const char *nm = patch_label && patch_label[0] ? patch_label : "EMPTY";
    if (full)
        lcd_fill(0, ROWS_Y, 240, ROWS_END - ROWS_Y, P_NIGHT);
    caps(t, nm, str_len(nm), 24);
    fit(t, &FONT_L, 228);
    text_bc(&FONT_L, 0, TOAST_Y + 24u, t, P_INK, P_NIGHT, 240, TA_CENTER);
    p = t;
    if (cur_preset < M1_SLOTS) {
        uint64_t b = bank_mask;
        uint32_t n = 0;
        for (; b; b &= b - 1u)
            n++;
        fmt_int(num, (int32_t)cur_preset + 1);
        p = put(p, num);
        p = put(p, " / ");
        fmt_int(num, (int32_t)n);
        p = put(p, num);
    }
    *p = 0;
    text_bc(&FONT_S, 0, TOAST_Y + 54u, t, P_DIM, P_NIGHT, 240, TA_CENTER);
}

/* a patch loaded (main.c preset_load): the whole screen, or, while the last one's name shows, the strip, the chips, the
 * rail, the foot line and the new name in place */
static void screen_patch(void)
{
    pages_ensure();
    if (booting || (page != 0 && page != PAGE_GLO) || !pg_patch_shown || fm1_ms >= pg_patch_until) {
        screen_idle();
        return;
    }
    ui_full = 0;
    pg_strip_dirty = 1;
    pages_draw(0);
}

/* GLO's footer: what each patch button does in this patch (its label; else its kind; "-" for Nothing) */
static void glo_footer(void)
{
    static const char *const KIND[4] = {"GATE", "-", "TOGGLE", "PAGE"};
    char t[16], line[40], *q;
    uint32_t b, i = 0;
    lcd_fill(0, ROWS_END + 2u, 240, 240u - ROWS_END - 2u, P_NIGHT);
    lcd_fill(BAR_X, ROWS_END + 4u, BAR_W, 1, P_TRACK);
    for (b = 0; b < ENG_PANEL_BUTTONS; b++, i++) {
        uint32_t x, y, kind = eng_button_kind(b);
        if (b == 5u) {                                  /* (GLO is this page) */
            i--;
            continue;
        }
        x = BAR_X + (i % 3u) * 76u;
        y = ROWS_END + 8u + (i / 3u) * 16u;
        q = put(line, PANEL_BTN_NAME[b]);
        *q = 0;
        text_bc(&FONT_S, x, y, line, P_FAINT, P_NIGHT, 30, TA_LEFT);
        if (!panel_label(b, t))
            put(t, KIND[kind <= 3u ? kind : 1u])[0] = 0;
        text_bc(&FONT_S, x + 28u, y, t, kind == ENG_BTN_NOTHING && !t[1] ? P_FAINT : P_INK, P_NIGHT, 46, TA_LEFT);
    }
}

/* the device page (page 0) and GLO's (PAGE_GLO); full: everything, else what moves (the bars or a toast, the rail, the
 * foot line) */
static void pages_draw(int full)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    int glo = page == PAGE_GLO;
    if (pg && pages_carding()) {                        /* SELECT / ALGO turning: the card alone (a beat's redraw leaves it be) */
        if (full || pg_card_shown != pg_card)
            pages_card_draw(1);
        else if (pg_card_dev != pg_cur_dev || pg_card_pg != pg_cur_page)
            pages_card_draw(0);
        pg_card_shown = pg_card;
        pg_card_dev = (uint8_t)pg_cur_dev;
        pg_card_pg = (uint8_t)pg_cur_page;
        return;
    }
    if (pg_card_shown) {                                /* they stopped (or a knob turned): the page, whole, once */
        pg_card_shown = 0;
        full = 1;
    }
    if (full)
        lcd_fill(0, 20, 240, 220, P_NIGHT);
    if (full || pg_strip_dirty) {
        if (!msg_until)
            pages_strip();
        if (pg && !glo)
            pages_chips();
        else
            lcd_fill(0, 20, 240, 18, P_NIGHT);
        if (glo)
            glo_footer();
        else
            pages_rail();
        pg_strip_dirty = 0;
    }
    if (!glo)
        pages_info();
    if (pg && fm1_ms < pg_toast_until && pg_toast_k < pg->nrows) {
        pg_patch_shown = 0;
        pages_toast(pg, pg_toast_k, full);
        return;
    }
    pg_toast_shown = 0xFFu;
    if (fm1_ms < pg_patch_until) {                      /* (a beat's redraw leaves it be) */
        if (full || !pg_patch_shown)
            pages_patch_toast(1);
        else if (pg_patch_shown != pages_gen() + 1u)
            pages_patch_toast(0);
        pg_patch_shown = pages_gen() + 1u;
        return;
    }
    pg_patch_shown = 0;
    lcd_fill(0, ROWS_Y - 3u, 240, 3, P_NIGHT);
    for (k = 0; k < PG_ROWS; k++) {
        pages_bar(pg, k);
        if (k < 3u)
            lcd_fill(0, ROWS_Y + k * (ROW_H + ROW_GAP) + ROW_H, 240, ROW_GAP, P_NIGHT);
    }
}

/* the toasts or a card end: the bars come back (main loop) */
static int pages_expired(void)
{
    static uint8_t was;
    uint8_t now = (uint8_t)((fm1_ms < pg_toast_until ? 1u : 0u) | (pages_carding() ? 2u : 0u)
                            | (fm1_ms < pg_patch_until ? 4u : 0u));
    int out = now != was;
    was = now;
    return out;
}

/* the bars whose rows a cable or pin moves (their live tick), redrawn alone ten times a second */
static void pages_ticks(void)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    if (!pg || fm1_ms < pg_toast_until || pages_carding() || pg_card_shown || fm1_ms < pg_patch_until)
        return;
    static uint8_t was;                                 /* bars that had a tick last time: redrawn once more to clear it */
    uint8_t now = 0;
    for (k = 0; k < pg->nrows; k++) {
        uint32_t m = pg->mod[k], j = pg->par[k];
        if (!(j & POLY_ROW) && eng_get_param(m, j) != eng_get_eff(m, j))
            now |= (uint8_t)(1u << k);
        if ((now | was) & (1u << k))
            pages_bar(pg, k);
    }
    was = now;
}

/* ---- the environment (#197, docs/ledger/vocabulary.md "Environment"): every device of the patch as a rack of equipment, Main first, the
 * Output last, in the device pages' grouped order (pages.ts devicesOf). ENV opens it from any page, on the device you were
 * on; ENV or HOME goes back. SELECT moves the row (the device in focus: K1..K4 turn its first page), SEL opens its device
 * pages. A Steps track's row reads its name; the devices it drives follow it, indented, with a stripe in the track's hue
 * (Decision 5D, from the device extras of format 34). A row: the name, the preset it was set to (coral), and on the right
 * what it is doing (Main's tempo, a track's length, ARMED); a long row cuts the preset name first. */
#define ENV_Y0 24u
#define ENV_ROW_H 26u
#define ENV_ROWS 8u
static const uint16_t TRACK_HUE[4] = {P_LILAC, P_SKY, P_GOLD, P_SEA};
static uint32_t env_first;                              /* the first row shown */

/* device d's extras (format 34): the device that drives it (ENG_NO_TRACK none) and the preset it was set to */
static uint32_t env_extras(uint32_t d, const char **name, uint32_t *n)
{
    *name = pg_pname[d][0] ? pg_pname[d] : 0;
    *n = str_len(pg_pname[d]);
    return pg_dev[d].track;
}

/* which Steps track (0.. among the device rows that are tracks) device d is, -1 none: its hue */
static int env_track_no(uint32_t d)
{
    uint32_t i;
    int n = 0;
    for (i = 0; i < pg_ndev; i++) {
        int m = pg_dev[i].module;
        if (m >= 0 && eng_type((uint32_t)m) == T_STEPS) {
            if (i == d)
                return n;
            n++;
        }
    }
    return -1;
}

/* the right-hand text of device d's row: Main's tempo, a track's length, ARMED */
/* device d's key listeners (#191: what arming it arms), as a module mask */
static uint64_t env_listeners(uint32_t d)
{
    uint64_t mask = 0;
    uint32_t k;
    if (pg_dev[d].mem) {
        for (k = 0; k < pg_dev[d].nmem; k++)
            if (pg_dev[d].mem[k] < 64u && eng_listens(pg_dev[d].mem[k]))
                mask |= (uint64_t)1 << pg_dev[d].mem[k];
    } else if (pg_dev[d].module >= 0 && eng_listens((uint32_t)pg_dev[d].module)) {
        mask = (uint64_t)1 << pg_dev[d].module;
    }
    return mask;
}

static int env_armed(uint32_t d) { return (eng_arm_mask_get() & env_listeners(d)) != 0; }

/* REC on the environment (#191, #198): the row's device armed or disarmed, the others as they are */
static void env_arm_toggle(void)
{
    uint64_t l, mask;
    char m[32], t[20];
    pages_ensure();
    if (pg_cur_dev >= pg_ndev)
        return;
    if (!(l = env_listeners(pg_cur_dev))) {
        ui_msg("NOTHING HERE TAKES KEYS", 1200);
        return;
    }
    mask = env_armed(pg_cur_dev) ? eng_arm_mask_get() & ~l : eng_arm_mask_get() | l;
    eng_arm_mask(mask);
    m1_arms_now((uint32_t)mask, (uint32_t)(mask >> 32));
    caps(t, pg_dev[pg_cur_dev].name, pg_dev[pg_cur_dev].nlen, 14);
    put(put(m, t), env_armed(pg_cur_dev) ? " ARMED" : " DISARMED")[0] = 0;
    ui_msg(m, 1200);
}

static void env_status(uint32_t d, char *out)
{
    int m = pg_dev[d].module, t = m >= 0 ? eng_type((uint32_t)m) : -1;
    char num[12];
    out[0] = 0;
    if (env_armed(d)) {
        put(out, "ARMED")[0] = 0;
    } else if (t == T_FM1) {
        fmt_int(num, (eng_get_param((uint32_t)m, FM1_P_TEMPO) + 32768) >> 16);
        put(put(out, num), " BPM")[0] = 0;
    } else if (t == T_STEPS) {
        fmt_int(num, (eng_get_param((uint32_t)m, STEPS_P_LEN) + 32768) >> 16);
        put(put(out, num), " STEPS")[0] = 0;
    }
}

static void env_row(uint32_t d, uint32_t y)
{
    char name[24], pre[24], st[16];
    const char *pn;
    uint32_t pl, tr = env_extras(d, &pn, &pl), x = 6u, right, w;
    int on = d == pg_cur_dev, tn = env_track_no(d);
    uint16_t bg = on ? P_TRACK : P_PANEL;
    lcd_fill(0, y, 240, ENV_ROW_H, P_NIGHT);
    lcd_fill(2, y + 1u, 236, ENV_ROW_H - 2u, bg);
    if (on) {                                           /* the row in focus: an ivory frame */
        lcd_fill(2, y + 1u, 236, 2, P_INK);
        lcd_fill(2, y + ENV_ROW_H - 3u, 236, 2, P_INK);
        lcd_fill(2, y + 1u, 2, ENV_ROW_H - 2u, P_INK);
        lcd_fill(236, y + 1u, 2, ENV_ROW_H - 2u, P_INK);
    }
    if (tn >= 0)                                        /* a track: a square in its hue */
        lcd_fill(x + 2u, y + 9u, 8, 8, TRACK_HUE[tn & 3]), x += 14u;
    else if (tr != ENG_NO_TRACK && tr < pg_ndev) {      /* driven by a track: indented, a stripe in the track's hue */
        int h = env_track_no(tr);
        lcd_fill(x + 2u, y + 4u, 3, ENV_ROW_H - 8u, TRACK_HUE[(h < 0 ? 0 : h) & 3]);
        x += 12u;
    }
    caps(name, pg_dev[d].name, pg_dev[d].nlen, 16);
    env_status(d, st);
    right = st[0] ? text_w(&FONT_S, st, -1) + 10u : 6u;
    fit(name, &FONT_M, 236u - right - x);
    w = text_w(&FONT_M, name, -1);
    text_bc(&FONT_M, x, y + 4u, name, P_INK, bg, w, TA_LEFT);
    x += w + 8u;
    if (pn && x + 20u < 236u - right) {                 /* the preset's name: what room is left (cut first) */
        caps(pre, pn, pl, 16);
        fit(pre, &FONT_M, 236u - right - x);
        text_bc(&FONT_M, x, y + 4u, pre, P_CORAL, bg, text_w(&FONT_M, pre, -1), TA_LEFT);
    }
    if (st[0])
        text_bc(&FONT_S, 236u - right + 4u, y + 7u, st, env_armed(d) ? P_SEA : P_DIM, bg, right - 8u, TA_RIGHT);
}

static void env_draw(int full)
{
    uint32_t i;
    pages_ensure();
    if (full || pg_strip_dirty) {
        if (!msg_until)
            pages_strip();
        pg_strip_dirty = 0;
    }
    if (pg_cur_dev < env_first)
        env_first = pg_cur_dev;
    if (pg_cur_dev >= env_first + ENV_ROWS)
        env_first = pg_cur_dev + 1u - ENV_ROWS;
    for (i = 0; i < ENV_ROWS; i++) {
        uint32_t y = ENV_Y0 + i * ENV_ROW_H;
        if (env_first + i < pg_ndev)
            env_row(env_first + i, y);
        else
            lcd_fill(0, y, 240, ENV_ROW_H, P_NIGHT);
    }
    if (!pg_ndev)
        text_bc(&FONT_S, 8, ENV_Y0 + 4u, "NO DEVICES ON THIS PATCH", P_FAINT, P_NIGHT, 0, TA_LEFT);
}

/* the environment opens: the first page of the device in focus is what K1..K4 turn there */
static void env_open(void)
{
    pages_ensure();
    pg_cur_page = 0;
    env_first = pg_cur_dev >= ENV_ROWS ? pg_cur_dev + 1u - ENV_ROWS : 0u;
}

/* K turned on the environment: "DEVICE: ROW VALUE" in the top bar for a second. The bar takes 26 characters: the value
 * whole (up to 14), the device's name cut to 8 when both names do not fit, the row's name to what is left, and a short
 * row name leaves the device more */
static void env_knob_msg(uint32_t k)
{
    const ppage_t *pg = pages_now();
    const pdev_t *dv = &pg_dev[pg_cur_dev];
    char m[40], num[20], unit[8], val[30], *q;
    uint32_t base, live, room, d, r;
    if (!pg || k >= pg->nrows)
        return;
    row_show(pg, k, num, unit, 100, &base, &live);
    q = put(val, num);
    if (unit[0])
        q = put(put(q, " "), unit);
    *q = 0;
    if (str_len(val) > 14u)
        val[14] = 0;
    room = 26u - 3u - str_len(val);                    /* (": " and " ") */
    d = dv->nlen < 8u ? dv->nlen : 8u;
    r = pg->llen[k] < room - d ? pg->llen[k] : room - d;
    d = dv->nlen < room - r ? dv->nlen : room - r;
    caps(m, dv->name, d, d);
    q = put(m + str_len(m), ": ");
    caps(q, pg->lab[k], r, r);
    q = put(q + str_len(q), " ");
    q = put(q, val);
    *q = 0;
    ui_msg(m, 1000);
}

/* ---- presets on the FM-1 (#194, docs/ledger/vocabulary.md "Preset"): an assembly device's card row values under a name, for its
 * structure. The factory engines' come in ROM (presets.h FPRESET_LIST, read-only), the user's from the preset store
 * (presetstore.c). A device's list: the factory ones in their order, then the user's by name. Loading sets the device's
 * rows (format 34's extras say which, in canonical order) as K1..K4 would, the editor told; ENV held + SAVE stores the
 * device's values (over the user preset it was set to, else under a new name). */
#define PR_USER 0x8000u                                 /* a list entry: a store slot | PR_USER, else a FPRESET_LIST index */
#define PR_MAX (N_FPRESETS + PS_SLOTS)
static uint16_t pr_list[PR_MAX < 256u ? 256u : PR_MAX];
static int32_t pr_vals[PS_MAXV];
static uint8_t pr_sel;                                  /* the preset list page's row */

/* device d's presets into pr_list: how many */
static uint32_t dp_list(uint32_t d)
{
    uint8_t slots[PS_SLOTS];
    uint32_t n = 0, k, m;
    if (d >= pg_ndev || !pg_dev[d].structure)
        return 0;
    for (k = 0; k < N_FPRESETS; k++)
        if (FPRESET_LIST[k].structure == pg_dev[d].structure)
            pr_list[n++] = (uint16_t)k;
    m = ps_list(pg_dev[d].structure, slots, PS_SLOTS);
    for (k = 0; k < m && k < PS_SLOTS; k++)
        pr_list[n++] = (uint16_t)(PR_USER | slots[k]);
    return n;
}

/* entry e's name (17 bytes) and values (pr_vals): how many values, -1 unreadable */
static int dp_entry(uint16_t e, char *name)
{
    uint32_t k, n, st;
    if (e & PR_USER) {
        if (ps_read(e & 0xFFu, &st, name, &n))
            return -1;
        for (k = 0; k < n; k++)
            pr_vals[k] = ps_vbuf[k];
        return (int)n;
    }
    for (k = 0; k < 16u && FPRESET_LIST[e].name[k]; k++)
        name[k] = FPRESET_LIST[e].name[k];
    name[k] = 0;
    n = FPRESET_LIST[e].n < PS_MAXV ? FPRESET_LIST[e].n : PS_MAXV;
    for (k = 0; k < n; k++)
        pr_vals[k] = FPRESET_LIST[e].v[k];
    return (int)n;
}

/* where device d's list stands: the entry named as the device's preset, -1 none */
static int dp_current(uint32_t d, uint32_t n)
{
    char nm[17];
    uint32_t k;
    for (k = 0; k < n; k++)
        if (dp_entry(pr_list[k], nm) >= 0 && !ps_name_cmp(nm, pg_pname[d]) && pg_pname[d][0])
            return (int)k;
    return -1;
}

static void dp_name_set(uint32_t d, const char *name)
{
    uint32_t k;
    for (k = 0; k < 16u && name[k]; k++)
        pg_pname[d][k] = name[k];
    pg_pname[d][k] = 0;
    if (!m1_preset_name(pg_dev[d].bin, pg_pname[d]))
        pg_built_at = 0xFFFFFFFFu;                      /* (the binary moved after it: the pages are read again, the names kept) */
}

/* load list entry k of device d: its rows take the values (the running binary and the editor too) */
static int dp_load(uint32_t d, uint32_t k)
{
    char nm[17];
    int n;
    uint32_t i;
    if (d >= pg_ndev || k >= dp_list(d) || (n = dp_entry(pr_list[k], nm)) < 0)
        return -1;
    for (i = 0; i < (uint32_t)n && i < pg_dev[d].nrows; i++) {
        uint32_t mod = pg_dev[d].rows[2u * i], par = pg_dev[d].rows[2u * i + 1u];
        int32_t v = pr_vals[i];
        if (mod == 0xFFu)
            continue;
        if (par & POLY_ROW) {
            if (!row_ok(mod, par))
                continue;
            poly_row_set(mod, par & 0x7Fu, (v + 32768) >> 16);
            m1_param_now(mod, par, v);
        } else {
            if (eng_type(mod) < 0 || par >= DEFS[eng_type(mod)].npar)
                continue;
            eng_set_param(mod, par, v);
            m1_patch_param(mod, par, v);
            m1_param_now(mod, par, v);
        }
    }
    dp_name_set(d, nm);
    return 0;
}

/* device d's row values now, in canonical order, into pr_vals: how many */
static uint32_t dp_values(uint32_t d)
{
    uint32_t i, n = pg_dev[d].nrows < PS_MAXV ? pg_dev[d].nrows : PS_MAXV;
    for (i = 0; i < n; i++) {
        uint32_t mod = pg_dev[d].rows[2u * i], par = pg_dev[d].rows[2u * i + 1u];
        pr_vals[i] = mod == 0xFFu ? 0 : (par & POLY_ROW) ? (row_ok(mod, par) ? poly_value(mod, par & 0x7Fu) << 16 : 0) : eng_get_param(mod, par);
    }
    return n;
}

/* ENV held + SAVE: the device in focus's values as a preset: over the user preset it was set to, else under a new name:
 * the preset it was based on (the one it was set to; none: the first of its list, a factory engine's Init; none either:
 * the device's name) with the next free number ("BRIGHT 2", from "BRIGHT 2": "BRIGHT 3"). The message says what happened. */
static void dp_store(uint32_t d)
{
    char nm[17], base[17], num[8];
    uint32_t k, n, len;
    int rc;
    pages_ensure();
    if (d >= pg_ndev || !pg_dev[d].structure) {
        ui_msg("PRESETS: ASSEMBLIES ONLY", 1200);
        return;
    }
    for (k = 0; k < 16u && pg_pname[d][k]; k++)
        nm[k] = pg_pname[d][k];
    nm[k] = 0;
    if (!nm[0] || ps_find(pg_dev[d].structure, nm) < 0) {   /* no user preset of that name: a new one */
        int taken;
        uint32_t m = dp_list(d);
        if (!nm[0] && (!m || dp_entry(pr_list[0], nm) < 0))
            nm[0] = 0;
        caps(base, nm[0] ? nm : pg_dev[d].name, nm[0] ? str_len(nm) : pg_dev[d].nlen, 12);
        len = str_len(base);                            /* (a number at its end goes: BRIGHT 2 -> BRIGHT 3) */
        for (k = len; k > 0u && base[k - 1u] >= '0' && base[k - 1u] <= '9'; k--)
            ;
        if (k < len && k >= 2u && base[k - 1u] == ' ')
            base[k - 1u] = 0;
        for (k = 2; k < 100u; k++) {
            uint32_t i;
            fmt_int(num, (int32_t)k);
            put(put(put(nm, base), " "), num)[0] = 0;
            taken = 0;
            for (i = 0; i < m && !taken; i++) {
                char other[17];
                taken = dp_entry(pr_list[i], other) >= 0 && !ps_name_cmp(other, nm);
            }
            if (!taken)
                break;
        }
    }
    n = dp_values(d);                                   /* (after the names: dp_entry reads each one's values into pr_vals) */
    rc = ps_put(pg_dev[d].structure, nm, pr_vals, n);
    if (rc) {
        ui_msg(rc == -2 ? "PRESETS FULL" : "PRESET NOT STORED", 1500);
        return;
    }
    dp_name_set(d, nm);
    {
        char m[40];
        put(put(m, "STORED "), nm)[0] = 0;
        ui_msg(m, 1500);
    }
    m1_preset_stored(pg_dev[d].structure, nm);          /* (the editor hears of it: #195) */
}

/* the editor deleted a preset on the FM-1: a device set to it keeps its sound but no longer names it (ENV shows no preset,
 * SEL's list marks none, ENV+SAVE names a new one), and the message says so */
static void dp_deleted(uint32_t structure, const char *name)
{
    uint32_t d, hit = 0;
    pages_ensure();
    for (d = 0; d < pg_ndev; d++)
        if (pg_dev[d].structure == structure && pg_pname[d][0] && !ps_name_cmp(pg_pname[d], name)) {
            dp_name_set(d, "");
            hit = 1;
        }
    if (!hit)
        return;
    ui_msg("PRESET DELETED: SOUND KEPT", 2500);        /* (the bar's 26 characters) */
    ui_dirty = 2;                                       /* (ENV's rows lose the name) */
}

/* the preset list page (SEL on an assembly device's page): its presets, the one it was set to marked; SELECT / ALGO /
 * PRESET move and load as they turn; SEL or HOME goes back */
static void presets_open(void)
{
    uint32_t n = dp_list(pg_cur_dev);
    int c = dp_current(pg_cur_dev, n);
    pr_sel = (uint8_t)(c < 0 ? 0 : c);
}

static int presets_turn(int32_t s)
{
    uint32_t n = dp_list(pg_cur_dev);
    if (!n || !s)
        return 0;
    pr_sel = (uint8_t)(((int32_t)pr_sel + s % (int32_t)n + (int32_t)n) % (int32_t)n);
    return dp_load(pg_cur_dev, pr_sel) == 0;
}

static void presets_draw(int full)
{
    uint32_t n, i, first;
    (void)full;
    pages_ensure();
    lcd_fill(0, 0, BATT_X, 20, P_GOLD);
    {
        char t[20];
        caps(t, pg_cur_dev < pg_ndev ? pg_dev[pg_cur_dev].name : "", pg_cur_dev < pg_ndev ? pg_dev[pg_cur_dev].nlen : 0, 16);
        text_bc(&FONT_S, 8, 3, "PRESETS", P_NIGHT, P_GOLD, 80, TA_LEFT);
        text_bc(&FONT_S, 88, 3, t, P_NIGHT, P_GOLD, 126, TA_RIGHT);
    }
    n = dp_list(pg_cur_dev);
    if (pr_sel >= n)
        pr_sel = 0;
    first = pr_sel >= ENV_ROWS ? pr_sel + 1u - ENV_ROWS : 0u;
    for (i = 0; i < ENV_ROWS; i++) {
        uint32_t y = ENV_Y0 + i * ENV_ROW_H, k = first + i;
        char nm[17], t[20];
        if (k >= n) {
            lcd_fill(0, y, 240, ENV_ROW_H, P_NIGHT);
            continue;
        }
        lcd_fill(0, y, 240, ENV_ROW_H, P_NIGHT);
        lcd_fill(2, y + 1u, 236, ENV_ROW_H - 2u, k == pr_sel ? P_TRACK : P_PANEL);
        if (k == pr_sel) {
            lcd_fill(2, y + 1u, 236, 2, P_INK);
            lcd_fill(2, y + ENV_ROW_H - 3u, 236, 2, P_INK);
        }
        if (dp_entry(pr_list[k], nm) < 0)
            put(nm, "?")[0] = 0;
        caps(t, nm, str_len(nm), 16);
        text_bc(&FONT_M, 10, y + 4u, t, ps_name_cmp(nm, pg_pname[pg_cur_dev]) ? P_INK : P_CORAL, k == pr_sel ? P_TRACK : P_PANEL, 160, TA_LEFT);
        text_bc(&FONT_S, 170, y + 7u, (pr_list[k] & PR_USER) ? "YOURS" : "FACTORY", P_DIM, k == pr_sel ? P_TRACK : P_PANEL, 60, TA_RIGHT);
    }
    if (!n)
        text_bc(&FONT_S, 8, ENV_Y0 + 4u, "NO PRESETS: ENV HELD + SAVE STORES ONE", P_FAINT, P_NIGHT, 0, TA_LEFT);
}

/* why a device has no presets to show, in the bar (26 characters): a plain module never has any; an assembly in a patch
 * stored before format 34 has no structure to match them by (the bank's slots keep the format they were saved in: the
 * editor's Send or Live, then SAVE, rewrites it); else none stored yet */
static void dp_none_msg(uint32_t d)
{
    ui_msg(d >= pg_ndev || pg_dev[d].module >= 0 ? "NO PRESETS ON A MODULE"
           : !pg_dev[d].structure ? "OLD PATCH: SEND + SAVE IT" : "NONE YET: ENV+SAVE STORES", 1500);
}

/* PRESET or ALGO on the environment (#198): the row's next / previous preset, loaded as you turn; a row without presets:
 * nothing (a short message) */
static int env_preset_step(int32_t st)
{
    uint32_t n;
    int c;
    char m[32], t[20];
    pages_ensure();
    if (!st || pg_cur_dev >= pg_ndev)
        return 0;
    n = dp_list(pg_cur_dev);
    if (!n) {
        dp_none_msg(pg_cur_dev);
        return 0;
    }
    c = dp_current(pg_cur_dev, n);
    c = c < 0 ? (st > 0 ? 0 : (int)n - 1) : (int)(((int32_t)c + st % (int32_t)n + (int32_t)n) % (int32_t)n);
    if (dp_load(pg_cur_dev, (uint32_t)c))
        return 0;
    caps(t, pg_pname[pg_cur_dev], str_len(pg_pname[pg_cur_dev]), 16);
    put(put(m, "PRESET "), t)[0] = 0;
    ui_msg(m, 1000);
    return 1;
}
