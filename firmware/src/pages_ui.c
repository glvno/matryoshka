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
 *          turned moves its own bar in place: the slider and the number (#298)
 *   y 206  the page rail: a segment per page of the device, the one in focus lit, its section's others dimmer
 *   y 214  the patch (slot, name, * when edited) and the transport, the parts, the octave
 * SELECT, ALGO and PRESET (#298) draw what they reached at once: its name first in a small toast, always the same
 * rectangle between the type of K2 and K3 (the device on red, the page on blue, the patch on ivory), then the page
 * around it: the bands of the bars that hold their type, then the rest; a newer click stops a draw, so turning fast
 * redraws only the toast. When it goes, only its rectangle is drawn again. */

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
#define P_CARD_DEV 0xB186u                              /* SELECT's title toast: --ref-red #b33135 (ivory on it 5.8:1) */
#define P_CARD_PAGE 0x4B52u                             /* ALGO's: --ref-blue #486b96 (ivory on it 5.3:1) */
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
static uint8_t pg_row_dirty;                            /* K1..K4 turned these rows: redrawn where they changed (#298) */
static struct {
    uint16_t base, live, vx;                            /* as the bar was drawn: its fill's end, live tick, value's x */
    uint32_t txt;                                       /* its value and unit (text_hash) */
    uint8_t nlen, used, ok;                             /* its name's length as cut, whether the page has the row; ok: known */
} pg_drawn[4];
/* SELECT, ALGO and PRESET turning (#298): what they reached named in a small toast until pg_ttl_until, always in the
 * same rectangle TTL_X, TTL_Y, TTL_W x TTL_H of the screen, whatever the page has there: centred in the bars' area, from
 * just below the type of K2's bar to just above K3's (so on most pages it covers only the bars' fill); the page itself
 * drawn at once (pg_algo_due), in passes a newer click stops (pages_waiting) */
#define TT_DEV 1u                                       /* SELECT: the device, on red */
#define TT_PAGE 2u                                      /* ALGO: the page, on blue */
#define TT_PATCH 3u                                     /* PRESET: the patch, on ivory (#170) */
#define PG_TTL_MS 600u
#define TTL_X 20u
#define TTL_Y 108u
#define TTL_W 200u
#define TTL_H 22u
static uint32_t pg_ttl_until;
static uint8_t pg_ttl_kind, pg_ttl_scr;                 /* which; whether it is on the screen (the page draws around it) */
static uint8_t pg_ttl_compose;                          /* (ttl_first: the bars' scanlines carry the toast) */
static char pg_ttl_t[28], pg_ttl_i[8];                  /* "FILTER 1/2", "3/7" */
static uint8_t pg_algo_due;                             /* the page they reached is still to be drawn (pages_staged) */
static uint8_t pg_stage_strip;                          /* the staged draw redraws the strip (another device or patch) */
static int (*pages_waiting)(void);                      /* main.c: an encoder's step waits (a draw gives way to it) */
/* PRESET turned (#170): the next patch's name in the title toast; asked before the load (pg_patch_ask, at
 * pg_patch_ask_ms), started when the new patch's pages are built */
static uint32_t pg_patch_ask_ms;
static uint8_t pg_patch_ask;
static void pages_title(uint32_t kind);
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

static void lag_clear(void);
/* read the device pages of the running patch again (another patch, or its binary moved: a step value added) */
static void pages_build(void)
{
    uint32_t len, at, n, d;
    const uint8_t *p = pages_src(&len);
    pg_ndev = pg_npage = 0;
    pg_built_gen = pages_gen();
    pg_built_at = at = p ? pages_at(p, len) : 0;
    pg_strip_dirty = 1;
    lag_clear();
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

/* Main, a Steps track, an Arpeggiator or the Output: the environment's frame, not where a patch opens (pages.ts
 * homeDevice, #196) */
static int pages_frame(uint32_t d)
{
    int t = pg_dev[d].module >= 0 ? eng_type((uint32_t)pg_dev[d].module) : -1;
    return t == T_FM1 || t == T_STEPS || t == T_ARP || t == T_OUTPUT;
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

/* the title toast is no longer wanted (another focus, a knob, another patch): the next draw puts its rectangle back */
static void ttl_end(void)
{
    pg_ttl_until = 0;
}

/* a knob's value the engine has not run with yet (#298 follow-up). eng_get_eff is the value of the last audio block, so
 * right after a turn it still holds the old value (plus what modulates it), and a bar drawn then showed a live tick at the
 * old place that no later redraw knew of: the thin ivory stripes. A turn notes the value and the effective value it
 * started from; until the engine's next block changes the effective value, the live tick is that value moved by the
 * turn, the same for a bar drawn whole or in part */
static struct {
    uint8_t mod, par, on;
    int32_t eff, was;
} pg_lag[PG_ROWS];
static void lag_note(uint32_t k, uint32_t m, uint32_t j)
{
    int32_t e = eng_get_eff(m, j);
    if (k >= PG_ROWS)
        return;
    if (!pg_lag[k].on || pg_lag[k].mod != m || pg_lag[k].par != j || pg_lag[k].eff != e) {
        pg_lag[k].on = 1;
        pg_lag[k].mod = (uint8_t)m;
        pg_lag[k].par = (uint8_t)j;
        pg_lag[k].eff = e;
        pg_lag[k].was = eng_get_param(m, j);
    }
}
static void lag_clear(void)
{
    uint32_t k;
    for (k = 0; k < PG_ROWS; k++)
        pg_lag[k].on = 0;
}
/* the effective value of module m's parameter j (of def d) whose value is v now */
static int32_t eff_now(uint32_t m, uint32_t j, const def_t *d, int32_t v)
{
    int32_t e = eng_get_eff(m, j);
    uint32_t k;
    for (k = 0; k < PG_ROWS; k++)
        if (pg_lag[k].on && pg_lag[k].mod == m && pg_lag[k].par == j) {
            if (pg_lag[k].eff != e) {                   /* the engine ran since: its value is current */
                pg_lag[k].on = 0;
                return e;
            }
            return clampi(e + (v - pg_lag[k].was), d->pmin[j], d->pmax[j]);
        }
    return e;
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
            ttl_end();
            if (pg_patch_ask && fm1_ms - pg_patch_ask_ms < 2000u) {   /* PRESET loaded it: its name in the title toast */
                pg_patch_ask = 0;
                pages_title(TT_PATCH);
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
 * (the editor, a Page button, HOME's trail): a title toast ends (SELECT and ALGO put theirs up after) */
static int pages_focus(uint32_t d, uint32_t g)
{
    pages_ensure();
    if (!pg_ndev)
        return 0;
    d = d < pg_ndev ? d : pg_ndev - 1u;
    g = g < pg_dev[d].npg ? g : pg_dev[d].npg - 1u;
    if (d == pg_cur_dev && g == pg_cur_page)
        return 0;
    pg_cur_dev = d;
    pg_cur_page = g;
    pg_strip_dirty = 1;
    ttl_end();
    return 1;
}

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
    pg_row_dirty |= (uint8_t)(1u << k);                 /* (the row moves where it is, #298) */
    ttl_end();
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
    lag_note(k, m, j);                                  /* (the engine runs with it from its next block) */
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
    pg_row_dirty |= (uint8_t)(1u << k);                 /* (the row moves where it is, #298) */
    ttl_end();
    *mod = m;
    *par = j;
    if (j & POLY_ROW) {
        int32_t lo = (j & 0x7Fu) == 0u ? 1 : 0, hi = poly_max(j & 0x7Fu);
        *v = lo + (int32_t)((((int64_t)u * (hi - lo)) + 32768) >> 16);
        return 1;
    }
    d = &DEFS[eng_type(m)];
    lag_note(k, m, j);
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
        int32_t v = eng_get_param(m, j), e = eff_now(m, j, d, v);
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
    bar_fill(P_STRIP);                                  /* (x BATT_X on: the battery's cell, ui.c) */
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
        bar_fill(bg);
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
        bar_fill(P_SEA);
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
    if (r == 0u)
        scr_pend(x, text_w(f, s, -1), f->h, s, -1);
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

/* where a bar's type goes: name and num cut to fit, the x of the name, the value and the unit */
static void row_layout(int used, char *name, char *num, const char *unit, uint32_t *nx, uint32_t *vx, uint32_t *ux)
{
    *nx = 22u;
    *vx = *ux = 0;
    if (used) {
        uint32_t uw, vw;
        uw = unit[0] ? text_w(&FONT_S, unit, -1) + 2u : 0u;
        fit(num, &FONT_M, 110u);
        vw = text_w(&FONT_M, num, -1);
        *ux = BAR_W - 7u - uw + 2u;
        *vx = BAR_W - 7u - uw - vw;
        fit(name, &FONT_M, *vx > *nx + 6u ? *vx - *nx - 6u : 0u);
    }
}

static int ttl_wanted(void);
static void ttl_onto(uint16_t *row, uint32_t x0, uint32_t tr);

/* the title toast is on the screen and stays there: the page draws around its rectangle */
static int ttl_up(void) { return pg_ttl_scr && ttl_wanted(); }
static int ttl_row(uint32_t y) { return y >= TTL_Y && y < TTL_Y + TTL_H; }

/* lcd_line holds a scanline of the page at y, its pixel 0 at screen x x0 and w px wide: its pixels s0..s1 out, and while
 * the toast stays on the screen not those in its columns (the part left of it, then the part right of it) */
static void line_out(uint32_t x0, uint32_t y, uint32_t w, uint32_t s0, uint32_t s1)
{
    uint16_t *row = lcd_line;
    uint32_t seg[2][2], n = 0, t, i;
    if (ttl_row(y) && ttl_up() && !pg_ttl_compose) {
        uint32_t a = TTL_X - x0, b = TTL_X + TTL_W - x0;
        if (s0 < a) {
            seg[n][0] = s0;
            seg[n++][1] = s1 < a ? s1 : a;
        }
        if (s1 > b) {
            seg[n][0] = s0 > b ? s0 : b;
            seg[n++][1] = s1;
        }
    } else {
        seg[0][0] = s0;
        seg[0][1] = s1;
        n = 1;
    }
    for (t = 0; t < n; t++) {
        uint32_t a = seg[t][0], b = seg[t][1];
        if (t)
            lcd_sync();                                 /* (the part before still going out of lcd_line's front) */
        if (a || b < w) {                               /* a part of the scanline: its pixels to the front (the texts */
            for (i = a; i < b; i++)                     /* announced still count from the whole one's x: scr_ox) */
                row[i - a] = row[i];
            scr_ox = x0;
        }
        lcd_line_out(x0 + a, y, b - a);
        scr_ox = 0xFFFFu;
    }
}

/* the night between the bars, rows y..y+h of it, pixels x0..x1 of the screen: around the toast while it stays, with it
 * while ttl_first draws it */
static void night_rows(uint32_t y, uint32_t h, uint32_t x0, uint32_t x1)
{
    uint16_t *row = lcd_line;
    uint32_t r, i;
    if (!(y < TTL_Y + TTL_H && TTL_Y < y + h) || !(ttl_up() || pg_ttl_compose)) {
        lcd_fill(x0, y, x1 - x0, h, P_NIGHT);
        return;
    }
    for (r = y; r < y + h; r++) {
        lcd_sync();
        for (i = 0; i < 240u; i++)
            row[i] = P_NIGHT;
        if (pg_ttl_compose && ttl_row(r))
            ttl_onto(row, 0, r - TTL_Y);
        line_out(0, r, 240, x0, x1);
    }
}

/* knob k's bar: drawn a scanline at a time (fill, ticks, then the type blended onto them), so the text reads across the
 * fill's edge. used: the page has a row for it (its name, value and unit; the fill to base, the live tick at live, of
 * BAR_W px); name and num are cut to fit here. Its rows r0..r1 (of ROW_H), and of each only the pixels s0..s1 of the bar
 * (0, BAR_W: all); the title toast's columns left alone while it stays on the screen, drawn with the bar by ttl_first
 * (#298). The device page's (pages_bar) and the sandbox page's (sandbox_ui.c, all of it: row_bar) */
static void row_bar_part(uint32_t k, int used, char *name, char *num, const char *unit, uint32_t base, uint32_t live,
                         uint32_t r0, uint32_t r1, uint32_t s0, uint32_t s1)
{
    uint16_t *row = lcd_line;                           /* (lcd.c's; BAR_W <= 240) */
    char kn[2];
    uint32_t y0 = ROWS_Y + k * (ROW_H + ROW_GAP), r, i, vx, ux, nx;
    uint16_t hue = KNOB_HUE[k], track = used ? P_PANEL : P_STRIP, fill = mix565(hue, P_PANEL, 6u);
    kn[0] = (char)('1' + k);
    kn[1] = 0;
    if (base > BAR_W)
        base = BAR_W;
    if (live > BAR_W)
        live = BAR_W;
    row_layout(used, name, num, unit, &nx, &vx, &ux);
    for (r = r0; r < r1; r++) {
        lcd_sync();                                     /* the last row may still be on its way out of lcd_line */
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
        if (pg_ttl_compose && ttl_row(y0 + r))
            ttl_onto(row, BAR_X, y0 + r - TTL_Y);
        line_out(BAR_X, y0 + r, BAR_W, s0, s1);
    }
}
static void row_bar(uint32_t k, int used, char *name, char *num, const char *unit, uint32_t base, uint32_t live)
{
    row_bar_part(k, used, name, num, unit, base, live, 0, ROW_H, 0, BAR_W);
}

/* knob k's row of page pg (or an empty slot): its type and where its fill and live tick end (at most BAR_W); returns
 * whether it is used */
static int pages_row(const ppage_t *pg, uint32_t k, char *name, char *num, char *unit, uint32_t *base, uint32_t *live)
{
    int used = pg && k < pg->nrows;
    name[0] = num[0] = unit[0] = 0;
    *base = *live = 0;
    if (used) {
        row_show(pg, k, num, unit, BAR_W, base, live);
        caps(name, pg->lab[k], pg->llen[k], 16);
    }
    if (*base > BAR_W)
        *base = BAR_W;
    if (*live > BAR_W)
        *live = BAR_W;
    return used;
}

/* a short hash of a value's text and unit: whether the bar's number changed */
static uint32_t text_hash(const char *a, const char *b)
{
    uint32_t h = 2166136261u;
    while (*a)
        h = (h ^ (uint8_t)*a++) * 16777619u;
    h = (h ^ 0xFFu) * 16777619u;
    while (*b)
        h = (h ^ (uint8_t)*b++) * 16777619u;
    return h;
}

/* what knob k's bar shows now (pg_drawn): drawn whole with these */
static void drawn_note(uint32_t k, int used, const char *name, const char *num, const char *unit, uint32_t base, uint32_t live,
                       uint32_t vx)
{
    if (k >= PG_ROWS)
        return;
    pg_drawn[k].base = (uint16_t)base;
    pg_drawn[k].live = (uint16_t)live;
    pg_drawn[k].vx = (uint16_t)vx;
    pg_drawn[k].txt = text_hash(num, unit);
    pg_drawn[k].nlen = (uint8_t)str_len(name);
    pg_drawn[k].used = (uint8_t)used;
    pg_drawn[k].ok = 1;
}

/* knob k's bar on the device page, rows r0..r1 of it, pixels s0..s1 */
static void pages_bar_part(const ppage_t *pg, uint32_t k, uint32_t r0, uint32_t r1, uint32_t s0, uint32_t s1)
{
    char name[24], num[20], unit[8];
    uint32_t base, live;
    int used = pages_row(pg, k, name, num, unit, &base, &live);
    row_bar_part(k, used, name, num, unit, base, live, r0, r1, s0, s1);
    if (!s0 && s1 == BAR_W && r0 == 0u && r1 == ROW_H) {   /* (the whole bar: what it now shows) */
        uint32_t nx, vx, ux;
        row_layout(used, name, num, unit, &nx, &vx, &ux);
        drawn_note(k, used, name, num, unit, base, live, vx);
    }
}
static void pages_bar(const ppage_t *pg, uint32_t k) { pages_bar_part(pg, k, 0, ROW_H, 0, BAR_W); }

/* the page in the screen's rectangle x0..x1, y0..y1 inside the bars' area (the toast's: ttl_first, ttl_restore) */
static void page_rect(const ppage_t *pg, uint32_t x0, uint32_t y0, uint32_t x1, uint32_t y1)
{
    uint32_t k, by, a, b;
    for (k = 0; k < PG_ROWS; k++) {
        by = ROWS_Y + k * (ROW_H + ROW_GAP);
        a = y0 > by ? y0 : by;
        b = y1 < by + ROW_H ? y1 : by + ROW_H;
        if (a < b)
            pages_bar_part(pg, k, a - by, b - by, x0 - BAR_X, x1 - BAR_X);
        by += ROW_H;                                    /* the gap below it */
        a = y0 > by ? y0 : by;
        b = y1 < by + ROW_GAP ? y1 : by + ROW_GAP;
        if (k < 3u && a < b)
            night_rows(a, b - a, x0, x1);
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

/* the patch and the transport, the foot line; with full 0 only when its text changed since it was drawn (a knob turned
 * Main's tempo or a poly group's voices) */
static int seq_arm_label(char *out, int *rec);   /* (seq_ui.c) */
static uint32_t pg_info_drawn;                          /* (the hash of the foot line as drawn) */
static void pages_info(int full)
{
    char a[40], b[32], num[12], *p = a;
    int panel = eng_find(T_FM1), run = eng_transport_running(), rec = 0, arm = seq_arm_label(a, &rec);
    uint32_t h;
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
    h = text_hash(a, b) ^ (uint32_t)(arm | rec << 1 | run << 2);
    if (!full && h == pg_info_drawn)
        return;
    pg_info_drawn = h;
    {
        uint32_t wb = text_w(&FONT_S, b, -1);
        text_bc(&FONT_S, 0, FOOT_Y, "", P_DIM, P_NIGHT, BAR_X, TA_LEFT);
        text_bc(&FONT_S, BAR_X, FOOT_Y, a, arm ? (rec ? P_REDC : P_SEA) : P_DIM, P_NIGHT, 228u - wb, TA_LEFT);
        text_bc(&FONT_S, 234u - wb, FOOT_Y, b, run ? P_SEA : P_FAINT, P_NIGHT, wb + 6u, TA_LEFT);
    }
}

/* K1..K4 turned (#298), or a live tick moved: the row moves where it is, the slider and the number: only the columns its
 * fill's end and live tick moved across (the whole height) and its value and unit when they changed (their band), from
 * what the bar showed (pg_drawn); a row whose name or kind changed is drawn whole. Every part is drawn from the same
 * values the bar is noted with, so the bar is then the bar drawn whole, pixel for pixel (panel_test.c) */
static void pages_row_update(const ppage_t *pg, uint32_t k)
{
    char name[24], num[20], unit[8];
    uint32_t base, live, nx, vx, ux, n = 0, i, j, sp[4][4];
    int used = pages_row(pg, k, name, num, unit, &base, &live);
    row_layout(used, name, num, unit, &nx, &vx, &ux);
    if (!pg_drawn[k].ok || pg_drawn[k].used != (uint8_t)used || pg_drawn[k].nlen != str_len(name)) {
        row_bar_part(k, used, name, num, unit, base, live, 0, ROW_H, 0, BAR_W);
        drawn_note(k, used, name, num, unit, base, live, vx);
        return;
    }
#define SPAN(a, b, r0, r1) do { uint32_t a_ = (a), b_ = (b) > BAR_W ? BAR_W : (b); if (b_ > a_) { sp[n][0] = a_; \
        sp[n][1] = b_; sp[n][2] = (r0); sp[n][3] = (r1); n++; } } while (0)
    {
        uint32_t lo = pg_drawn[k].base < base ? pg_drawn[k].base : base, hi = pg_drawn[k].base < base ? base : pg_drawn[k].base;
        if (lo != hi)                                   /* the fill's end (and its 2 px edge in the hue) */
            SPAN(lo >= 2u ? lo - 2u : 0u, hi, 0u, ROW_H);
    }
    {                                                   /* the live ticks, the old and the new, where they moved */
        int was = pg_drawn[k].live != pg_drawn[k].base, now = live != base, same = was && now && live == pg_drawn[k].live;
        if (was && !same)
            SPAN(pg_drawn[k].live >= 1u ? pg_drawn[k].live - 1u : 0u, pg_drawn[k].live + 2u, 4u, ROW_H - 4u);
        if (now && !same)
            SPAN(live >= 1u ? live - 1u : 0u, live + 2u, 4u, ROW_H - 4u);
    }
    if (used && (pg_drawn[k].vx != vx || pg_drawn[k].txt != text_hash(num, unit))) {   /* the value and unit */
        uint32_t x = pg_drawn[k].vx < vx ? pg_drawn[k].vx : vx;
        SPAN(x >= 1u ? x - 1u : 0u, BAR_W - 4u, 9u, 27u);
    }
#undef SPAN
    for (i = 0; i < n; i++)                             /* overlapping spans merge (their rows too) */
        for (j = i + 1u; j < n; j++)
            if (sp[j][0] < sp[i][1] && sp[i][0] < sp[j][1]) {
                sp[i][0] = sp[i][0] < sp[j][0] ? sp[i][0] : sp[j][0];
                sp[i][1] = sp[i][1] > sp[j][1] ? sp[i][1] : sp[j][1];
                sp[i][2] = sp[i][2] < sp[j][2] ? sp[i][2] : sp[j][2];
                sp[i][3] = sp[i][3] > sp[j][3] ? sp[i][3] : sp[j][3];
                sp[j][0] = sp[j][1] = 0;
                j = i;                                  /* (again from the start: the bigger span may meet another) */
            }
    for (i = 0; i < n; i++)
        if (sp[i][1] > sp[i][0])
            row_bar_part(k, used, name, num, unit, base, live, sp[i][2], sp[i][3], sp[i][0], sp[i][1]);
    drawn_note(k, used, name, num, unit, base, live, vx);
}

/* a patch loaded (main.c preset_load): PRESET's (its title toast, then the page drawn in passes by panel_draw, #298), or
 * the whole screen */
static void screen_patch(void)
{
    pages_ensure();
    if (!booting && page == 0 && !sb_on && pg_plain && ttl_wanted() && pg_ttl_kind == TT_PATCH) {
        ui_full = 0;
        if (!ui_dirty)
            ui_dirty = 1;
        return;
    }
    screen_idle();
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

/* ---- the title toast (#298): SELECT, ALGO and PRESET name what they reached in a small toast drawn first, always in the
 * same rectangle (TTL_X, TTL_Y, TTL_W x TTL_H), whatever it covers; the page under it is drawn at once around it, a newer
 * click stopping the draw */

static int ttl_wanted(void) { return pg_ttl_until && fm1_ms < pg_ttl_until && !sb_on && page == 0; }   /* (not on GLO's page) */

/* its words: the device's name and "2/5" of the devices (SELECT), the page's as the chips name it and "3/7" of the
 * device's pages (ALGO), the patch's name and its slot of the bank's (PRESET); the name cut to what the toast holds */
static void ttl_words(void)
{
    char num[8], *p;
    const pdev_t *dv = &pg_dev[pg_cur_dev];
    const ppage_t *pg = &pg_page[dv->pg0 + pg_cur_page];
    uint32_t i = pg_cur_page, n = dv->npg, room;
    if (pg_ttl_kind == TT_PATCH) {
        const char *nm = patch_label && patch_label[0] ? patch_label : "EMPTY";
        uint64_t b = bank_mask;
        caps(pg_ttl_t, nm, str_len(nm), 24);
        for (n = 0; b; b &= b - 1u)
            n++;
        i = cur_preset;
        if (cur_preset >= M1_SLOTS)
            n = 0;
    } else if (pg_ttl_kind == TT_DEV) {
        caps(pg_ttl_t, dv->name, dv->nlen, 16);
        i = pg_cur_dev;
        n = pg_ndev;
    } else {
        if (pages_unheaded(pg, dv))
            caps(pg_ttl_t, "PAGE", 4u, 4u);
        else
            caps(pg_ttl_t, pg->name, pg->nlen, 16);
        p = pg_ttl_t + str_len(pg_ttl_t);
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
    pg_ttl_i[0] = 0;
    if (n) {
        fmt_int(num, (int32_t)i + 1);
        p = put(pg_ttl_i, num);
        *p++ = '/';
        fmt_int(num, (int32_t)n);
        put(p, num)[0] = 0;
    }
    room = TTL_W - 20u - (pg_ttl_i[0] ? 8u + text_w(&FONT_S, pg_ttl_i, -1) : 0u);
    fit(pg_ttl_t, &FONT_M, room);
}

/* SELECT (TT_DEV), ALGO (TT_PAGE) or PRESET (TT_PATCH) reached what is in focus now: its title toast, and the page to
 * draw in passes (pages_staged) */
static void pages_title(uint32_t kind)
{
    const ppage_t *pg = pages_now();
    if (!pg)
        return;
    pg_ttl_kind = (uint8_t)kind;
    pg_ttl_until = fm1_ms + (kind == TT_PATCH ? 1000u : PG_TTL_MS);
    ttl_words();
    pg_algo_due = 1;
    if (kind != TT_PAGE)
        pg_stage_strip = 1;
}

/* its colours */
static uint16_t ttl_bg(void) { return pg_ttl_kind == TT_DEV ? P_CARD_DEV : pg_ttl_kind == TT_PATCH ? P_INK : P_CARD_PAGE; }
static uint16_t ttl_fg(void) { return pg_ttl_kind == TT_PATCH ? P_NIGHT : P_INK; }

/* its row tr (0..TTL_H) onto a scanline whose pixel 0 is at screen x x0: the box, its corners rounded (the page shows
 * there), the title left and the count right on one baseline */
static void ttl_onto(uint16_t *row, uint32_t x0, uint32_t tr)
{
    uint32_t i, a = TTL_X - x0, b = a + TTL_W, edge = tr == 0u || tr == TTL_H - 1u;
    uint16_t bg = ttl_bg(), fg = ttl_fg();
    for (i = a + edge; i < b - edge; i++)
        row[i] = bg;
    if (tr >= 2u)
        text_onto(row, 240u, &FONT_M, tr - 2u, pg_ttl_t, a + 10u, fg);
    if (tr >= 5u && pg_ttl_i[0])
        text_onto(row, 240u, &FONT_S, tr - 5u, pg_ttl_i, b - 10u - text_w(&FONT_S, pg_ttl_i, -1), fg);
}

/* the toast, first: its rectangle alone, with the page's pixels at its corners; from then on the page draws around it */
static void ttl_first(const ppage_t *pg)
{
    pg_ttl_compose = 1;
    page_rect(pg, TTL_X, TTL_Y, TTL_X + TTL_W, TTL_Y + TTL_H);
    pg_ttl_compose = 0;
    pg_ttl_scr = 1;
}

/* its time is up: the page in its rectangle, alone */
static void ttl_restore(const ppage_t *pg)
{
    uint32_t k;
    pg_ttl_scr = 0;
    if (!pg)
        return;
    page_rect(pg, TTL_X, TTL_Y, TTL_X + TTL_W, TTL_Y + TTL_H);
    for (k = 0; k < PG_ROWS && pg_plain; k++)           /* (a bar it met drawn there as it is now: the rest of it too) */
        if (ROWS_Y + k * (ROW_H + ROW_GAP) < TTL_Y + TTL_H && TTL_Y < ROWS_Y + k * (ROW_H + ROW_GAP) + ROW_H)
            pages_row_update(pg, k);
}

/* a newer click waits: the draw gives way (and comes back through ui_dirty) */
static int pages_stop(void)
{
    if (!pages_waiting || !pages_waiting())
        return 0;
    if (!ui_dirty)
        ui_dirty = 1;
    return 1;
}

/* the page SELECT, ALGO or PRESET reached, over the page that was there (pg_plain): the toast, then the strip (another
 * device or patch) and the chips with the band of each bar that holds its type, then the rest of the bars, the rail and
 * the foot line, all around the toast; each pixel once, nothing cleared first. A click waiting stops it between bands
 * (pages_stop) */
static void pages_staged(const ppage_t *pg, int glo)
{
    uint32_t k;
    if (pg_ttl_scr && !ttl_wanted())
        ttl_restore(pg);                                /* (its time ran out before the draw came round) */
    if (ttl_wanted())
        ttl_first(pg);
    if (pages_stop())
        return;
    if (pg_stage_strip && !msg_until)
        header_draw();                                  /* (page 0: the strip; or OVERLOAD, LOAD ERR) */
    pg_stage_strip = 0;
    if (glo)
        lcd_fill(0, 20, 240, 18, P_NIGHT);
    else
        pages_chips();
    if (pages_stop())
        return;
    for (k = 0; k < PG_ROWS; k++) {                     /* the name, value and unit of each */
        pages_bar_part(pg, k, 9u, 27u, 0, BAR_W);
        if (pages_stop())
            return;
    }
    for (k = 0; k < PG_ROWS; k++) {                     /* the rest: above and below the type */
        pages_bar_part(pg, k, 0, 9u, 0, BAR_W);
        pages_bar_part(pg, k, 27u, ROW_H, 0, BAR_W);
        if (k < 3u && pages_stop())
            return;
    }
    for (k = 0; k < PG_ROWS; k++) {                     /* (the bars as now drawn, whole: their parts above) */
        char name[24], num[20], unit[8];
        uint32_t base, live, nx, vx, ux;
        int used = pages_row(pg, k, name, num, unit, &base, &live);
        row_layout(used, name, num, unit, &nx, &vx, &ux);
        drawn_note(k, used, name, num, unit, base, live, vx);
    }
    if (glo)
        glo_footer();
    else {
        pages_rail();
        pages_info(1);
    }
    pg_strip_dirty = 0;
    pg_algo_due = 0;
    pg_row_dirty = 0;
    pg_plain = 1;
}

/* the device page (page 0) and GLO's (PAGE_GLO); full: everything, else what moves (the bars, the toast's rectangle, the
 * rail, the foot line) */
static void pages_draw(int full)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    int glo = page == PAGE_GLO, railed;
    if (!full && pg && pg_algo_due && pg_plain) {
        pages_staged(pg, glo);                          /* SELECT, ALGO or PRESET reached it (#298) */
        return;
    }
    if (!full && pg_ttl_scr && !ttl_wanted() && !pg_strip_dirty) {
        ttl_restore(pg);                                /* the title toast's time is up: its rectangle, alone */
        if (!pg_row_dirty)
            return;
    }
    if (!full && pg && pg_row_dirty && pg_plain && !pg_strip_dirty) {
        for (k = 0; k < PG_ROWS; k++)                   /* K1..K4 turned: their rows where they changed */
            if (pg_row_dirty & (1u << k))
                pages_row_update(pg, k);
        pg_row_dirty = 0;
        if (!glo)
            pages_info(0);                              /* (Main's tempo, a poly group's voices) */
        return;
    }
    pg_algo_due = 0;
    pg_row_dirty = 0;
    pg_stage_strip = 0;
    if (full) {
        lcd_fill(0, 20, 240, 220, P_NIGHT);
        pg_ttl_scr = 0;
    }
    if (!ttl_wanted())
        pg_ttl_scr = 0;                                 /* (the bars and the night between them drawn over it below) */
    else if (pg && !glo && !pg_ttl_scr)
        ttl_first(pg);                                  /* the toast first, the page around it */
    railed = full || pg_strip_dirty;
    if (railed) {
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
        pages_info(1);
    lcd_fill(0, ROWS_Y - 3u, 240, 3, P_NIGHT);
    for (k = 0; k < PG_ROWS; k++) {
        pages_bar(pg, k);
        if (k < 3u)
            night_rows(ROWS_Y + k * (ROW_H + ROW_GAP) + ROW_H, ROW_GAP, 0, 240);
    }
    pg_plain = 1;
}

/* a title toast ends: what it covered comes back (main loop) */
static int pages_expired(void)
{
    static uint8_t was;
    uint8_t now = (uint8_t)(ttl_wanted() ? 1u : 0u);
    int out = now != was;
    was = now;
    return out;
}

/* the live ticks ten times a second (a cable or pin moves a row's parameter; a turn's value reaching the engine): each
 * bar whose fill or tick is not where the bar shows it moves in place (pages_row_update) */
static void pages_ticks(void)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    if (!pg || sb_on || pg_algo_due || !pg_plain)
        return;
    for (k = 0; k < PG_ROWS; k++) {
        char name[24], num[20], unit[8];
        uint32_t base, live;
        (void)pages_row(pg, k, name, num, unit, &base, &live);
        if (!pg_drawn[k].ok || base != pg_drawn[k].base || live != pg_drawn[k].live)
            pages_row_update(pg, k);
    }
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

/* a list row's look as a number (FNV-1a over what it shows), so a redraw paints only the rows whose look changed (#229) */
static uint32_t row_sig(uint32_t h, const char *s, uint32_t n)
{
    uint32_t i;
    for (i = 0; i < n; i++)
        h = (h ^ (uint8_t)s[i]) * 16777619u;
    return h;
}
static uint32_t row_sig_word(uint32_t h, uint32_t v)
{
    uint32_t i;
    for (i = 0; i < 4u; i++, v >>= 8)
        h = (h ^ (v & 0xFFu)) * 16777619u;
    return h;
}

/* a row of the environment or the preset list (#229), drawn a scanline at a time into lcd.c's line (the frame, the
 * square or stripe, the type blended onto them), so every pixel goes out once and a row that changes does not blink.
 * frame 0: none, 1: ivory lines over and under, 2: and at the sides. mark_w 8: a track's square, 3: a stripe, 0 none.
 * a in afg, then b (0 none) in coral; c (0 none) in the small type, 3 px lower */
static void list_row(uint32_t y, int frame, uint16_t bg, uint32_t mark_x, uint32_t mark_w, uint16_t mark, const char *a,
                     uint32_t ax, uint16_t afg, const char *b, uint32_t bx, const char *c, uint32_t cx, uint16_t cfg)
{
    uint16_t *row = lcd_line;
    uint32_t r, i;
    for (r = 0; r < ENV_ROW_H; r++) {
        lcd_sync();                                     /* the last row may still be on its way out of lcd_line */
        for (i = 0; i < 240u; i++)
            row[i] = P_NIGHT;
        if (r >= 1u && r < ENV_ROW_H - 1u) {
            int edge = frame && (r < 3u || r >= ENV_ROW_H - 3u);
            for (i = 2; i < 238u; i++)
                row[i] = edge || (frame > 1 && (i < 4u || i >= 236u)) ? P_INK : bg;
            if (mark_w == 8u && r >= 9u && r < 17u)
                for (i = mark_x; i < mark_x + 8u; i++)
                    row[i] = mark;
            else if (mark_w == 3u && r >= 4u && r < ENV_ROW_H - 4u)
                for (i = mark_x; i < mark_x + 3u; i++)
                    row[i] = mark;
        }
        if (r >= 4u) {
            text_onto(row, 240, &FONT_M, r - 4u, a, ax, afg);
            if (b)
                text_onto(row, 240, &FONT_M, r - 4u, b, bx, P_CORAL);
        }
        if (c && r >= 7u)
            text_onto(row, 240, &FONT_S, r - 7u, c, cx, cfg);
        lcd_line_out(0, y + r, 240);
    }
}

/* the environment's or the preset list's rows as on the LCD: their looks (row_sig), 0 not drawn, 1 an empty row */
static uint32_t list_shown[ENV_ROWS];

/* screen row i of the environment: device d (none past pg_ndev), drawn only when its look changed */
static void env_row(uint32_t d, uint32_t i)
{
    char name[24], pre[24], st[16];
    const char *pn;
    uint32_t pl, tr, x = 6u, right, w, mark_x = 0, mark_w = 0, h, y = ENV_Y0 + i * ENV_ROW_H;
    int on, tn, hue = 0;
    if (d >= pg_ndev) {
        if (list_shown[i] != 1u)
            lcd_fill(0, y, 240, ENV_ROW_H, P_NIGHT);
        list_shown[i] = 1u;
        return;
    }
    tr = env_extras(d, &pn, &pl);
    on = d == pg_cur_dev;
    tn = env_track_no(d);
    if (tn >= 0)                                        /* a track: a square in its hue */
        mark_x = x + 2u, mark_w = 8u, hue = tn, x += 14u;
    else if (tr != ENG_NO_TRACK && tr < pg_ndev) {      /* driven by a track: indented, a stripe in the track's hue */
        int t = env_track_no(tr);
        mark_x = x + 2u, mark_w = 3u, hue = t < 0 ? 0 : t, x += 12u;
    }
    caps(name, pg_dev[d].name, pg_dev[d].nlen, 16);
    env_status(d, st);
    right = st[0] ? text_w(&FONT_S, st, -1) + 10u : 6u;
    fit(name, &FONT_M, 236u - right - x);
    w = text_w(&FONT_M, name, -1);
    pre[0] = 0;
    if (pn && x + w + 8u + 20u < 236u - right) {        /* the preset's name: what room is left (cut first) */
        caps(pre, pn, pl, 16);
        fit(pre, &FONT_M, 236u - right - x - w - 8u);
    }
    h = row_sig_word(row_sig_word(2166136261u, d), (uint32_t)on << 16 | mark_w << 8 | (uint32_t)hue);
    h = row_sig(row_sig(row_sig(h, name, str_len(name) + 1u), pre, str_len(pre) + 1u), st, str_len(st) + 1u);
    h = row_sig_word(h, (uint32_t)env_armed(d)) | 2u;   /* (never 0 or 1) */
    if (list_shown[i] == h)
        return;
    list_shown[i] = h;
    list_row(y, on ? 2 : 0, on ? P_TRACK : P_PANEL, mark_x, mark_w, TRACK_HUE[hue & 3], name, x, P_INK,
             pre[0] ? pre : 0, x + w + 8u, st[0] ? st : 0, 242u - right, env_armed(d) ? P_SEA : P_DIM);
}

/* the environment: whole, or the rows whose look changed (SELECT: the old and the new row; past the window: the list,
 * not the bar; #229) */
static void env_draw(int full)
{
    uint32_t i;
    pages_ensure();
    if (full) {
        if (!msg_until)
            pages_strip();
        for (i = 0; i < ENV_ROWS; i++)
            list_shown[i] = 0;
    }
    pg_strip_dirty = 0;                                 /* (the bar here does not show the focus) */
    if (pg_cur_dev < env_first)
        env_first = pg_cur_dev;
    if (pg_cur_dev >= env_first + ENV_ROWS)
        env_first = pg_cur_dev + 1u - ENV_ROWS;
    for (i = 0; i < ENV_ROWS; i++)
        env_row(env_first + i, i);
    if (!pg_ndev && full)
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

/* the preset list's bar: PRESETS and the device, on gold (ui.c header_draw: a message's end puts it back) */
static void presets_bar(void)
{
    char t[20];
    pages_ensure();
    caps(t, pg_cur_dev < pg_ndev ? pg_dev[pg_cur_dev].name : "", pg_cur_dev < pg_ndev ? pg_dev[pg_cur_dev].nlen : 0, 16);
    bar_fill(P_GOLD);
    text_bc(&FONT_S, 8, 3, "PRESETS", P_NIGHT, P_GOLD, 80, TA_LEFT);
    text_bc(&FONT_S, 88, 3, t, P_NIGHT, P_GOLD, 126, TA_RIGHT);
}

/* the list: whole, or the rows whose look changed (SELECT: the old and the new row, the one named coral; past the
 * window: the list; #229). The bar is header_draw's */
static void presets_draw(int full)
{
    uint32_t n, i, first;
    pages_ensure();
    if (full)
        for (i = 0; i < ENV_ROWS; i++)
            list_shown[i] = 0;
    n = dp_list(pg_cur_dev);
    if (pr_sel >= n)
        pr_sel = 0;
    first = pr_sel >= ENV_ROWS ? pr_sel + 1u - ENV_ROWS : 0u;
    for (i = 0; i < ENV_ROWS; i++) {
        uint32_t y = ENV_Y0 + i * ENV_ROW_H, k = first + i, h;
        char nm[17], t[20];
        int on = k == pr_sel, named;
        if (k >= n) {
            if (list_shown[i] != 1u)
                lcd_fill(0, y, 240, ENV_ROW_H, P_NIGHT);
            list_shown[i] = 1u;
            continue;
        }
        if (dp_entry(pr_list[k], nm) < 0)
            put(nm, "?")[0] = 0;
        caps(t, nm, str_len(nm), 16);
        fit(t, &FONT_M, 160);
        named = !ps_name_cmp(nm, pg_pname[pg_cur_dev]);
        h = row_sig_word(row_sig_word(2166136261u, k), (uint32_t)on | (uint32_t)named << 1 | (pr_list[k] & PR_USER));
        h = row_sig(h, t, str_len(t) + 1u) | 2u;
        if (list_shown[i] == h)
            continue;
        list_shown[i] = h;
        {
            const char *src = (pr_list[k] & PR_USER) ? "YOURS" : "FACTORY";
            list_row(y, on, on ? P_TRACK : P_PANEL, 0, 0, 0, t, 10, named ? P_CORAL : P_INK, 0, 0, src, 230u - text_w(&FONT_S, src, -1), P_DIM);
        }
    }
    if (!n && full)
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
