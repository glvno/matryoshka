/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Device pages: the FM-1 as a player of the patch's devices (web/src/pages.ts). Every top-level module or assembly of the
 * editor's canvas is a device; its card's rows, four to a page, are what K1..K4 turn. SELECT steps the devices, ALGO the
 * pages of one; the patch binary lists them (patchbin.ts, the device pages section: proto.c m1_devices_at). A plain
 * module's pages are made here: its parameters in order, four to a page, named as in defs.h.
 *
 * The screen (the owner's design of 2026-10-24; the numbers are the look constants, LK_*, below "drawing"; Barlow
 * Condensed, font_bc.c):
 *   y   0  the header (LK_HH): three sections, the device | its page group | the group's pages, each of the first two
 *          ending in a point; the names with a dash per device (the current gold) and per group (the current sky), the
 *          third a stack of bars, one per page of the group (the current mist)
 *   y  40  K1..K4: four full-width bars, each tinted in its knob's hue: an accent tab, the row's name, its value and unit
 *          right, the fill to the base value edged in the hue, an ivory tick where modulation has it; an empty slot where
 *          the page has no row. A knob turned moves its own bar in place: the slider and the number (#298)
 *   y 225  the footer (LK_FH, sand): the patch, the tempo, the octave, the battery
 * SELECT and ALGO redraw the header's sections that changed and the bars; PRESET grows the footer into a toast for a
 * second (the slot's number, the patch's name, a dash per filled slot), drawn first, the page around it; when it goes,
 * only its band is drawn again. A newer click stops a draw, so turning fast redraws only what is needed. */

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
    uint16_t xo[PG_ROWS];                               /* where the row's extras start in the binary (ENG_ROW_MORE: the further
                                                         * parameters it sets, its positions' names; #357, #358), 0 none */
} ppage_t;
static pdev_t pg_dev[PG_DEVS] UI_POOL;
static char pg_tname[PG_DEVS][9] UI_POOL;              /* a Steps track's name, for its device (m1_track_name: 8 characters) */
static char pg_pname[PG_DEVS][17] UI_POOL;             /* the preset each device was set to (#194; read from the extras for a new patch) */
static ppage_t pg_page[PG_PAGES] UI_POOL;
static uint32_t pg_ndev, pg_npage, pg_built_gen = 0xFFFFFFFFu, pg_built_at;
static uint32_t pg_cur_dev, pg_cur_page;                /* the focus: the device and its page K1..K4 turn */
static uint8_t pg_strip_dirty = 1;                      /* the header needs a redraw (the focus moved) */
static uint8_t pg_row_dirty;                            /* K1..K4 turned these rows: redrawn where they changed (#298) */
static struct {
    uint16_t base, live, vx;                            /* as the bar was drawn: its fill's end, live tick, value's x */
    uint32_t txt, name;                                 /* its value and unit, its name and whether the page has the row (text_hash) */
    uint8_t h, ok;                                      /* its height; ok: known */
} pg_drawn[4];
static uint8_t pg_algo_due;                             /* SELECT, ALGO or PRESET moved: the page they reached is still to be
                                                         * drawn (pages_staged), in passes a newer click stops */
static int (*pages_waiting)(void);                      /* main.c: an encoder's step waits (a draw gives way to it) */
/* PRESET turned (#170): the next patch's name in its toast; asked before the load (pg_patch_ask, at pg_patch_ask_ms),
 * started when the new patch's pages are built */
static uint32_t pg_patch_ask_ms;
static uint8_t pg_patch_ask;
static void toast_start(void);
static void toast_end(void);
/* a Page button's list on K1..K4 (#117): its button (-1: none), the step showing, whether a hold peeks at its first page */
static int8_t pg_list_btn = -1;
static uint8_t pg_list_step, pg_list_peek;

static void m1_track_name(uint32_t mod, char *out);     /* proto.c: a Steps track's name ("" none) */
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v);   /* proto.c: a row turned here (the editor follows) */
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v); /* proto.c: the running binary follows */
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v); /* main.c: a poly group's setting */
static void m1_preset_stored(uint32_t structure, const char *name);   /* proto.c: a preset stored here (#195) */
static void m1_arms_now(uint32_t lo, uint32_t hi);              /* proto.c: the armed modules changed here (#191) */
static const uint8_t *pages_src(uint32_t *len);         /* the running patch's binary (proto.c m1_cur; the preview's) */
static uint32_t pages_gen(void);                        /* changes when another patch becomes current */

/* where the device pages section starts in (p, len), 0 if there is none (proto.c m1_devices_at, on any binary) */
static uint32_t pages_at(const uint8_t *p, uint32_t len)
{
    uint32_t at;
    if (len < 8u || !(p[6] & 32u) || !(at = eng_cables_end(p, len)))
        return 0;
    if (p[6] & 4u) at += p[2];
    if ((p[6] & 8u) && !(at = eng_routes_end(p, len, at)))
        return 0;
    if (!(at = eng_steps_end(p, len, at)))
        return 0;
    return at < len ? at : 0;
}

/* bit 7 of a row's parameter byte: a setting of the poly group of that Part (patchbin.ts POLY_ROW_PARAMS): the voices,
 * assign, legato, priority, unison, steal, stack */
#define POLY_ROW 0x80u
#define POLY_FIELDS ENG_NPOLY
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
    return eng_poly_get(g, f);
}
static int32_t poly_max(uint32_t f) { return f == 0u || f == ENG_POLY_STACK ? ENG_MAX_PARTS : f == ENG_POLY_STEAL ? 1 : f == 1u ? 3 : 2; }

static const ppage_t *pages_now(void);
static void caps(char *out, const char *s, uint32_t n, uint32_t max);

/* a Selector's position row spans the positions in use, 1..count (#358: it never offers one that plays nothing): the
 * top of row j of module m, Q16 (else the parameter's own, DEF_TOP) */
static int32_t row_top(uint32_t m, uint32_t j, const def_t *d)
{
    if (eng_type(m) == T_SELECT && j == SELECT_P_POS)
        return clampi((eng_get_param(m, SELECT_P_COUNT) + 32768) >> 16, 2, (int32_t)(d->pmax[j] >> 16)) << 16;
    return DEF_TOP(d, j);
}

/* row k's extras in the running binary (ENG_ROW_MORE), 0 when it has none: u8 n, n (module, parameter), u8 k, k texts */
static const uint8_t *row_more(const ppage_t *pg, uint32_t k)
{
    uint32_t len;
    const uint8_t *p = pages_src(&len);
    return p && k < pg->nrows && pg->xo[k] && pg->xo[k] < len ? p + pg->xo[k] : 0;
}

/* a row's further parameters take its value (#357): the engine and the running binary; the editor follows the first and
 * sets the others itself */
static void more_set(const uint8_t *x, int32_t v)
{
    uint32_t i;
    for (i = 0; x && i < x[0]; i++) {
        uint32_t m = x[1u + 2u * i], j = x[2u + 2u * i];
        const def_t *d;
        if (m >= (uint32_t)eng_nmodules() || eng_type(m) < 0 || j >= DEFS[eng_type(m)].npar)
            continue;
        d = &DEFS[eng_type(m)];
        eng_set_param(m, j, clampi(v, d->pmin[j], DEF_TOP(d, j)));
        m1_patch_param(m, j, clampi(v, d->pmin[j], DEF_TOP(d, j)));
    }
}

/* knob k's row was set to v (pages_turn / pages_set_unit returned 0): the parameters it also sets follow */
static void pages_also(uint32_t k, int32_t v)
{
    const ppage_t *pg = pages_now();
    if (pg)
        more_set(row_more(pg, k), v);
}

/* the name row k gives position v (a Selector's, Q16 1..; #358) into out in capitals, 0 when it names none */
static int row_name(const ppage_t *pg, uint32_t k, int32_t v, char *out)
{
    const uint8_t *x = row_more(pg, k), *t;
    uint32_t n, i, want;
    if (!x)
        return 0;
    t = x + 1u + 2u * x[0];
    n = *t++;
    want = (uint32_t)(((v + 32768) >> 16) - 1);
    for (i = 0; i < n; i++) {
        if (i == want) {
            if (!t[0])
                return 0;
            caps(out, (const char *)t + 1, t[0], 12u);
            return 1;
        }
        t += 1u + t[0];
    }
    return 0;
}

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
        pg->display = (uint8_t)(j == 0 && (t == T_ADSR || t == T_ENV || t == T_ENV8) ? m + 1u : 0u);
        pg->nrows = 0;
        for (r = 0; r < PG_ROWS && j * PG_ROWS + r < d->npar; r++) {
            pg->mod[r] = (uint8_t)m;
            pg->par[r] = (uint8_t)(j * PG_ROWS + r);
            pg->lab[r] = d->pname[j * PG_ROWS + r];
            pg->llen[r] = (uint8_t)str_len(pg->lab[r]);
            pg->xo[r] = 0;
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
                uint32_t par = p[at + 1u], more = !(par & POLY_ROW) && (par & ENG_ROW_MORE);
                if (more)
                    par &= ~ENG_ROW_MORE;
                if (pg && pg->nrows < PG_ROWS && p[at] < (uint32_t)eng_nmodules() && eng_type(p[at]) >= 0 && row_ok(p[at], par)) {
                    pg->mod[pg->nrows] = p[at];
                    pg->par[pg->nrows] = (uint8_t)par;
                    pg->lab[pg->nrows] = (const char *)p + at + 3u;
                    pg->llen[pg->nrows] = p[at + 2u];
                    pg->xo[pg->nrows] = (uint16_t)(more ? at + 3u + p[at + 2u] : 0u);
                    pg->nrows++;
                }
                at += 2u;
                at += 1u + p[at];
                if (more)
                    at = eng_row_more_end(p, len, at);   /* (eng_devices_end checked it) */
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
            return clampi(e + (v - pg_lag[k].was), d->pmin[j], DEF_TOP(d, j));
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
            toast_end();
            if (pg_patch_ask && fm1_ms - pg_patch_ask_ms < 2000u) {   /* PRESET loaded it: its toast */
                pg_patch_ask = 0;
                toast_start();
                pg_algo_due = 1;
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

/* put a device page on K1..K4 (indices into the section, clamped); returns whether it moved. PRESET's toast ends */
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
    toast_end();
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
    toast_end();
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
        *v = clampi(eng_get_param(m, j) + clicks * (fast ? 5 : 1) * d->pinc[j], d->pmin[j], row_top(m, j, d));   /* (past pmax: a stretch) */
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
    toast_end();
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
    } else if (row_top(m, j, d) != DEF_TOP(d, j)) {      /* a Selector's position: over the positions in use */
        int32_t lo = d->pmin[j] >> 16, hi = row_top(m, j, d) >> 16;
        *v = (lo + (int32_t)((((int64_t)u * (hi - lo)) + 32768) >> 16)) << 16;
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
    {
        const def_t *d = &DEFS[eng_type(pg->mod[k])];
        uint32_t j = pg->par[k];
        int32_t v = eng_get_param(pg->mod[k], j), lo = d->pmin[j], u;
        if (d->ptop && d->pchoice && d->pchoice[j])     /* a choice list past pmax (a stretch): over every choice, as pages_set_unit */
            u = (int32_t)(((int64_t)(clampi(v, lo, d->ptop[j]) - lo) << 16) / (d->ptop[j] - lo));
        else if (row_top(pg->mod[k], j, d) != DEF_TOP(d, j))   /* a Selector's position: over the positions in use */
            u = (int32_t)(((int64_t)(clampi(v, lo, row_top(pg->mod[k], j, d)) - lo) << 16) / (row_top(pg->mod[k], j, d) - lo));
        else
            u = unit_of(d, j, v);
        return (uint32_t)((u * 127 + 32768) >> 16);
    }
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
    if (str_eq(u, "HZ") && q16 > 0 && q16 < 655) {      /* below 0.01 Hz: millihertz, so a slow LFO never displays zero */
        *put_num(num, q16 * 1000) = 0;
        put(unit, "mHz")[0] = 0;
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

/* the value a row plays, where a switch of its module stretches it (the editor's card shows the same): the ADSR's long
 * (decay and release x 2.4), the Delay's swell (feedback x 198 / 95) and the LFO's free rate in its slow / fast range
 * (/ 25, x 2: modules.ts lfoRateText); the bar keeps the knob's range */
static int32_t stretched(uint32_t m, uint32_t j, int32_t v)
{
    int t = eng_type(m);
    if (t == T_LFO && j == LFO_P_RATE) {
        int32_t r = (eng_get_param(m, LFO_P_RANGE) + 32768) >> 16;
        return r == 1 ? v / 25 : r == 2 ? v * 2 : v;
    }
    if (t == T_ADSR && (j == ADSR_P_D || j == ADSR_P_R) && eng_get_param(m, ADSR_P_LONG) >= 32768)
        return (int32_t)(((int64_t)v * ADSR_LONG_Q16) >> 16);
    if (t == T_DELAY && j == DELAY_P_FB && eng_get_param(m, DELAY_P_SWELL) >= 32768)
        return (int32_t)((int64_t)v * DELAY_SWELL_NUM / DELAY_SWELL_DEN);
    return v;
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
        static const char *const UNI[3] = {"OFF", "ON", "SHARE"};
        unit[0] = 0;
        if (f == ENG_POLY_STACK && !v)
            put(num, "ALL")[0] = 0;
        else if (f == 0u || f == ENG_POLY_STACK)
            fmt_int(num, v);
        else
            put(num, f == 1u ? POLY_ASSIGN_NAME[clampi(v, 0, 3)] : f == 2u ? POLY_LEGATO_NAME[clampi(v, 0, 2)] : f == 3u ? POLY_PRIORITY_NAME[clampi(v, 0, 2)] : UNI[clampi(v, 0, 2)])[0] = 0;
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
        int32_t v = eng_get_param(m, j), e = eff_now(m, j, d, v), top = row_top(m, j, d);
        if (row_name(pg, k, v, num))                    /* a Selector's position by the name its card row gives it (#358) */
            unit[0] = 0;
        else
            value_parts(d, j, stretched(m, j, v), num, unit);
        if (top != DEF_TOP(d, j)) {                     /* a Selector's position: the bar spans the positions in use */
            *base = (uint32_t)(((int64_t)(clampi(v, d->pmin[j], top) - d->pmin[j]) * width) / (top - d->pmin[j]));
            *live = (uint32_t)(((int64_t)(clampi(e, d->pmin[j], top) - d->pmin[j]) * width) / (top - d->pmin[j]));
        } else {
            *base = param_bar(d, j, v, width);
            *live = param_bar(d, j, e, width);
        }
    }
}

/* ---- the look: the owner's mock of 2026-10-24 ("gold device dashes, sky page dashes"), with the values he set on its
 * sliders; every number of it is here, so a change is one edit. The type sizes are tools/gen_font.py's: another size needs
 * the font made again there (lk_fonts checks that they agree) */
#define LK_AD 18u                                       /* the point of a header section: how deep, px */
#define LK_HH 36u                                       /* the header's height */
#define LK_FH 15u                                       /* the footer's height (its type FONT_F: LK_FH - 1 px per em) */
#define LK_VP 2u                                        /* a bar's accent tab: px from the bar's left */
#define LK_TN 15u                                       /* the header's strength, %: at 45 the sections are lilac at 26, 17
                                                         * and 10 % over night, the mock's design */
#define LK_ET 2u                                        /* the fill's edge in the knob's hue, px */
#define LK_SG 3u                                        /* the subpages' stack: the gap between its bars */
#define LK_SI 3u                                        /* .. its inset above and below */
#define LK_VS 26u                                       /* a bar's value, px per em (FONT_V) */
#define LK_NS 20u                                       /* a bar's name (FONT_N) */
#define LK_US 14u                                       /* a bar's unit (FONT_F) */
#define LK_HS 16u                                       /* the header's names (FONT_H) */
#define LK_TOH 60u                                      /* PRESET's toast: its height (4 px more with two rows of dashes) */
#define LK_TSP 6u                                       /* .. its side margins */
#define LK_TTS 32u                                      /* .. its type, px per em (FONT_T) */
#define LK_TNY (-5)                                     /* .. its type's nudge, px down */
#define LK_TDH 6u                                       /* .. its slot dashes: their height */
#define LK_TDG 1u                                       /* .. the gap between two */
#define LK_TDB 5u                                       /* .. how far above the bottom */
#define LK_TMS 1000u                                    /* .. how long it shows, ms */
typedef char lk_fonts[(FONT_V_PX == LK_VS && FONT_N_PX == LK_NS && FONT_F_PX == LK_US && FONT_F_PX == LK_FH - 1u
                       && FONT_H_PX == LK_HS && FONT_T_PX == LK_TTS) ? 1 : -1];

/* the mock's colours (RGB 8:8:8) and its mixes: mix(a, b, t) = a t + b (1 - t) per channel, t in thousandths */
#define RGB565(c) ((uint16_t)(((((c) >> 19) & 31u) << 11) | ((((c) >> 10) & 63u) << 5) | (((c) >> 3) & 31u)))
#define MIXC(a, b, t, s) (((((a) >> (s)) & 255u) * (t) + (((b) >> (s)) & 255u) * (1000u - (t))) / 1000u)
#define MIX24(a, b, t) (MIXC(a, b, t, 16) << 16 | MIXC(a, b, t, 8) << 8 | MIXC(a, b, t, 0))
#define LK_KS(t) ((t) * LK_TN / 45u > 1000u ? 1000u : (t) * LK_TN / 45u)   /* a section's strength at the header's */
#define LK_OFF(t) (LK_KS(t) + 140u > 1000u ? 1000u : LK_KS(t) + 140u)     /* .. and its dashes that are not current */
#define C24_LILAC 0xC6ABDFu
#define C24_NIGHT 0x171F21u
#define C24_PANEL 0x232C2Eu
#define C24_SAND 0xCFC6B5u
#define P_SEC1 RGB565(MIX24(C24_LILAC, C24_NIGHT, LK_KS(260u)))
#define P_SEC2 RGB565(MIX24(C24_LILAC, C24_NIGHT, LK_KS(170u)))
#define P_SEC3 RGB565(MIX24(C24_LILAC, C24_NIGHT, LK_KS(100u)))
#define P_SEC1_OFF RGB565(MIX24(C24_LILAC, C24_NIGHT, LK_OFF(260u)))
#define P_SEC2_OFF RGB565(MIX24(C24_LILAC, C24_NIGHT, LK_OFF(170u)))
#define P_MIST RGB565(0xB4B8ADu)                        /* the current subpage, a bar's unit */
#define P_DARK RGB565(0x2C3638u)                        /* the other subpages */
#define P_INK2 RGB565(0x202A2Cu)                        /* the footer's second ink */
#define P_WARN RGB565(0xB33135u)                        /* REC and an empty battery on the footer's sand */
#define P_SLOT_OFF RGB565(MIX24(C24_NIGHT, C24_SAND, 220u))   /* PRESET's toast: a filled slot not current */
static const uint16_t KNOB_FILL[4] = {RGB565(MIX24(0xE7775Du, C24_PANEL, 400u)), RGB565(MIX24(0xE8B65Au, C24_PANEL, 400u)),
                                      RGB565(MIX24(0x79C7C1u, C24_PANEL, 400u)), RGB565(MIX24(0xCFC6B5u, C24_PANEL, 400u))};

/* where text sits: the mock's canvas puts a text's middle (textBaseline middle) at y, its baseline a third of its size
 * below. BASE6(y2, px): the baseline row for a middle at y2 / 2 */
#define BASE6(y2, px) ((3u * (y2) + 2u * (px) + 3u) / 6u)
#define HEAD_BASE BASE6(LK_HH - 8u, LK_HS)              /* the header's names: middle at LK_HH / 2 - 4 */
#define BAND_BASE BASE6(LK_HH, LK_HS)                   /* a plain band's text (GLO, sandbox, a list): in the middle */
#define FOOT_Y (240u - LK_FH)
#define FOOT_MID ((2u * FOOT_Y + LK_FH + 1u) / 2u)     /* the footer's middle row (the mock: its centre + 0.5) */
#define FOOT_BASE BASE6(2u * FOOT_Y + LK_FH + 1u, LK_FH - 1u)   /* its type's baseline */
#define BAR_X 6u
#define BAR_W 228u
#define ROW_GAP 4u

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
/* s in font f with its baseline at row `base` of the screen, onto the scanline of row y */
static void text_at(uint16_t *row, uint32_t w, const font_t *f, uint32_t y, uint32_t base, const char *s, uint32_t x, uint16_t fg)
{
    if (y + f->base >= base && y + f->base < base + f->h)
        text_onto(row, w, f, y + f->base - base, s, x, fg);
}

/* the text of s cut to fit `max` px (the rest dropped at a character) */
static void fit(char *s, const font_t *f, uint32_t max)
{
    uint32_t n = str_len(s);
    while (n && text_w(f, s, (int32_t)n) > max)
        n--;
    s[n] = 0;
}

/* n dashes onto a scanline between x0 and x1 (exclusive), `gap` apart, every one as wide as the others in whole pixels and
 * the row centred in what is left; dash `on` in c_on, the rest c_off (the mock's dashes(); a row too long for its gap
 * closes it up, then is cut at x1) */
static void dashes_onto(uint16_t *row, int32_t x0, int32_t x1, uint32_t gap, uint32_t n, int32_t on, uint16_t c_on, uint16_t c_off)
{
    int32_t w, used, s0, i, a, b;
    if (!n || x1 <= x0)
        return;
    while (gap && (int32_t)(n + gap * (n - 1u)) > x1 - x0)
        gap--;
    w = (x1 - x0 - (int32_t)(gap * (n - 1u))) / (int32_t)n;
    w = w < 1 ? 1 : w;
    used = (int32_t)n * w + (int32_t)(gap * (n - 1u));
    s0 = x0 + (used <= x1 - x0 ? (x1 - x0 - used) / 2 : 0);
    for (i = 0; i < (int32_t)n; i++) {
        uint16_t c = i == on ? c_on : c_off;
        a = s0 + i * (w + (int32_t)gap);
        for (b = a; b < a + w && b < x1 && b < 240; b++)
            row[b] = c;
    }
}

/* ---- the header (LK_HH high): three sections, the device | its page group | the group's pages. The first two end in a
 * point LK_AD deep, the next one notched to match, a 2.5 px band of the strip's colour between; the names in ivory with
 * a dash per device (the current gold) and per page group (the current sky) under them; the third section a stack of
 * bars, one per page of the group (the current mist). Widths 2 : 3 : 1 of the screen; a section whose name needs more
 * grows, the others give the rest up evenly, never below their own need. Other headers on the same band: a Page button's
 * list (seafoam), GLO (coral), sandbox mode (gold, sandbox_ui.c), no devices */
#define HM_DEV 0u
#define HM_LIST 1u
#define HM_GLO 2u
#define HM_NONE 3u
#define HM_SANDBOX 4u
typedef struct {
    uint8_t mode, nd, cd, ng, cg, ns, cs;               /* devices, the one in focus; its page groups, the current; the group's
                                                         * pages, the current */
    char a[40], b[24];                                  /* the device's and the group's names (the bands: their texts) */
    int32_t xd, xs;                                     /* where the second and the third section start, 1/16 px */
} head_t;
static head_t hd_drawn;                                 /* what the header shows (hd_ok: known) */
static uint8_t hd_ok;
static uint32_t page_bar_h(void) { return LK_HH; }

static int pages_unheaded(const ppage_t *pg, const pdev_t *d);
static const char *sb_patch_name(void);                 /* sandbox_ui.c: the editor's patch */

/* the header as it is now */
static void head_layout(head_t *h)
{
    uint32_t i, n0, n1, n2, w[3], need[3], j;
    char num[8], *q;
    memset(h, 0, sizeof *h);
    if (sb_on && page == 0u) {
        h->mode = HM_SANDBOX;
        put(h->a, "SANDBOX")[0] = 0;
        caps(h->b, sb_patch_name(), str_len(sb_patch_name()), 22);
        fit(h->b, &FONT_H, 232u - 8u - text_w(&FONT_H, h->a, -1) - 12u);
        return;
    }
    if (page == PAGE_GLO) {                             /* GLO: GLOBAL and the patch, on coral */
        h->mode = HM_GLO;
        put(h->a, "GLOBAL")[0] = 0;
        q = h->b;
        if (cur_preset < M1_SLOTS) {
            fmt_int(num, (int32_t)cur_preset + 1);
            if (cur_preset < 9u)
                *q++ = '0';
            q = put(q, num);
            *q++ = ' ';
        }
        caps(q, patch_label ? patch_label : "", patch_label ? str_len(patch_label) : 0u, 20);
        fit(h->b, &FONT_H, 232u - 8u - text_w(&FONT_H, h->a, -1) - 12u);
        return;
    }
    if (!pg_ndev) {
        h->mode = HM_NONE;
        put(h->a, "NO DEVICES ON THIS PATCH")[0] = 0;
        return;
    }
    if (pg_list_btn >= 0) {                             /* a Page button's list: "SEL 2/3 - AMP ENV" */
        const uint8_t *l;
        uint32_t cnt = pages_list((uint32_t)pg_list_btn, &l);
        const ppage_t *pg = &pg_page[pg_dev[pg_cur_dev].pg0 + pg_cur_page];
        char t[12];
        h->mode = HM_LIST;
        if (!panel_label((uint32_t)pg_list_btn, t))
            put(t, PANEL_BTN_NAME[pg_list_btn])[0] = 0;
        q = put(h->a, t);
        *q++ = ' ';
        fmt_int(num, (int32_t)(pg_list_peek ? 1u : pg_list_step + 1u));
        q = put(q, num);
        *q++ = '/';
        fmt_int(num, (int32_t)cnt);
        q = put(q, num);
        q = put(q, " - ");
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
        fit(h->a, &FONT_H, 228u);
        return;
    }
    {                                                   /* the device page: its groups, the current one and its pages */
        uint32_t g0 = pg_dev[pg_cur_dev].pg0, np = pg_dev[pg_cur_dev].npg, gs = 0;
        const ppage_t *pg;
        h->mode = HM_DEV;
        h->nd = (uint8_t)pg_ndev;
        h->cd = (uint8_t)pg_cur_dev;
        for (i = 0; i < np; i++) {
            if (i == 0u || pg_page[g0 + i].part == 0u) {
                h->ng++;
                if (i <= pg_cur_page)
                    gs = i;
            }
        }
        for (i = 0; i <= pg_cur_page && i < np; i++)
            if (i && pg_page[g0 + i].part == 0u)
                h->cg++;
        for (i = gs; i < np && (i == gs || pg_page[g0 + i].part != 0u); i++)
            h->ns++;
        h->cs = (uint8_t)(pg_cur_page - gs);
        pg = &pg_page[g0 + gs];
        caps(h->a, pg_dev[pg_cur_dev].name, pg_dev[pg_cur_dev].nlen, 16);
        if (pages_unheaded(pg, &pg_dev[pg_cur_dev]))
            put(h->b, "PAGE")[0] = 0;
        else
            caps(h->b, pg->name, pg->nlen, 16);
    }
    n2 = (12u + LK_AD) * 16u;                           /* what each section needs (1/16 px); long names cut to fit together */
    for (;;) {
        n0 = (text_w(&FONT_H, h->a, -1) + 14u) * 16u;
        n1 = (text_w(&FONT_H, h->b, -1) + 14u + LK_AD) * 16u;
        if (n0 + n1 + n2 <= 240u * 16u)
            break;
        if (str_len(h->a) >= str_len(h->b))
            h->a[str_len(h->a) - 1u] = 0;
        else
            h->b[str_len(h->b) - 1u] = 0;
    }
    need[0] = n0;
    need[1] = n1;
    need[2] = n2;
    w[0] = 240u * 16u * 2u / 6u;
    w[1] = 240u * 16u * 3u / 6u;
    w[2] = 240u * 16u / 6u;
    for (i = 0; i < 3u; i++)                            /* (the mock's splitW) */
        if (need[i] > w[i]) {
            uint32_t d = need[i] - w[i];
            w[i] = need[i];
            for (j = 0; j < 3u; j++)
                if (j != i)
                    w[j] -= d / 2u;
        }
    for (i = 0; i < 3u; i++)                            /* never below its own need: from the one with the most to spare */
        if (w[i] < need[i]) {
            uint32_t d = need[i] - w[i], m = i == 0u ? 1u : 0u;
            for (j = 0; j < 3u; j++)
                if (j != i && w[j] - need[j] > w[m] - need[m])
                    m = j;
            w[i] += d;
            w[m] -= d;
        }
    h->xd = (int32_t)w[0];
    h->xs = (int32_t)(w[0] + w[1]);
}

/* the point's depth at row y (its middle), 1/16 px */
static int32_t head_tri(uint32_t y)
{
    int32_t d = (int32_t)(2u * y + 1u) - (int32_t)LK_HH;
    return (int32_t)(LK_AD * 16u) * ((int32_t)LK_HH - (d < 0 ? -d : d)) / (int32_t)LK_HH;
}

/* the header's scanline y */
static void head_row(const head_t *h, uint32_t y, uint16_t *row)
{
    uint32_t x = 0, i;
    if (h->mode != HM_DEV) {
        uint16_t bg = h->mode == HM_LIST ? P_SEA : h->mode == HM_GLO ? P_CORAL : h->mode == HM_SANDBOX ? P_GOLD : P_STRIP;
        for (i = 0; i < 240u; i++)
            row[i] = bg;
        if (h->mode == HM_LIST)
            text_at(row, 240, &FONT_H, y, BAND_BASE, h->a, (240u - text_w(&FONT_H, h->a, -1)) / 2u, P_NIGHT);
        else if (h->mode == HM_NONE)
            text_at(row, 240, &FONT_H, y, BAND_BASE, h->a, 8u, P_FAINT);
        else {
            text_at(row, 240, &FONT_H, y, BAND_BASE, h->a, 8u, P_NIGHT);
            text_at(row, 240, &FONT_H, y, BAND_BASE, h->b, 232u - text_w(&FONT_H, h->b, -1), P_NIGHT);
        }
        return;
    }
    {                                                   /* the sections and the bands between them, their edges blended */
        int32_t t = head_tri(y), e[4], hi;
        static const uint16_t SEC[5] = {P_SEC1, P_STRIP, P_SEC2, P_STRIP, P_SEC3};
        e[0] = h->xd + t;
        e[1] = e[0] + 40;
        e[2] = h->xs + t;
        e[3] = e[2] + 40;
        for (i = 0; i < 5u; i++) {
            hi = i < 4u ? e[i] : 240 * 16;
            for (; (int32_t)(x + 1u) * 16 <= hi && x < 240u; x++)
                row[x] = SEC[i];
            if (i < 4u && x < 240u && (int32_t)x * 16 < hi) {   /* (the pixel the edge crosses: by how much of it) */
                row[x] = mix565(SEC[i], SEC[i + 1u], (uint32_t)(hi - (int32_t)x * 16));
                x++;
            }
        }
    }
    {
        uint32_t px = ((uint32_t)h->xd + (LK_AD + 6u) * 16u + 8u) >> 4;   /* the group's name: the second section + A + 6 */
        text_at(row, 240, &FONT_H, y, HEAD_BASE, h->a, 6u, P_INK);
        text_at(row, 240, &FONT_H, y, HEAD_BASE, h->b, px, P_INK);
        if (y >= LK_HH - 7u && y < LK_HH - 4u) {        /* the dashes: 3 px, their bottom 4 above the header's */
            dashes_onto(row, 6, (h->xd - 64) >> 4, 2u, h->nd, h->cd, P_GOLD, P_SEC1_OFF);
            dashes_onto(row, (int32_t)px, (h->xs - 64) >> 4, 2u, h->ng, h->cg, P_SKY, P_SEC2_OFF);
        }
    }
    if (y >= LK_SI && y < LK_HH - LK_SI) {              /* the stack: a bar per page of the group, the left edge along the notch */
        uint32_t n = h->ns ? h->ns : 1u, span = LK_HH - 2u * LK_SI, k, l;
        for (k = 0; k < n; k++) {
            uint32_t y0 = (2u * (LK_SI * n + k * (span + LK_SG)) + n) / (2u * n),
                     y1 = (2u * (LK_SI * n + k * (span + LK_SG) + span - LK_SG * (n - 1u)) + n) / (2u * n);
            if (y >= y0 && y < (y1 > y0 ? y1 : y0 + 1u)) {
                l = ((uint32_t)h->xs + (uint32_t)head_tri(y) + (LK_SG + 1u) * 16u + 8u) >> 4;
                for (x = l; x < 236u; x++)
                    row[x] = n == 1u || k == h->cs ? P_MIST : P_DARK;
                break;
            }
        }
    }
}

/* the header, its columns x0..x1 (every row) */
static void line_out(uint32_t x0, uint32_t y, uint32_t w, uint32_t s0, uint32_t s1);
static void head_out(const head_t *h, uint32_t x0, uint32_t x1)
{
    uint32_t y;
    for (y = 0; y < LK_HH; y++) {
        lcd_sync();
        head_row(h, y, lcd_line);
        line_out(0, y, 240, x0, x1);
    }
    hd_drawn = *h;
    hd_ok = 1;
}

/* the header, whole (header_draw: the page's own; a message's end) or only the sections that changed since it was drawn:
 * the stack for another page of the group, the second section for another group, the first for another device; all of
 * it when a boundary moves */
static void head_draw(int whole)
{
    head_t h;
    int32_t a = 240, b = 0;
    head_layout(&h);
    if (whole || !hd_ok || h.mode != hd_drawn.mode || h.xd != hd_drawn.xd || h.xs != hd_drawn.xs || h.mode != HM_DEV) {
        if (whole || !hd_ok || memcmp(&h, &hd_drawn, sizeof h))
            head_out(&h, 0, 240);
        return;
    }
    if (h.nd != hd_drawn.nd || h.cd != hd_drawn.cd || !str_eq(h.a, hd_drawn.a)) {
        a = 0;
        b = (h.xd + (int32_t)LK_AD * 16 + 40 + 15) >> 4;
    }
    if (h.ng != hd_drawn.ng || h.cg != hd_drawn.cg || !str_eq(h.b, hd_drawn.b)) {
        a = a < (h.xd >> 4) - 1 ? a : (h.xd >> 4) - 1;
        b = b > (h.xs + (int32_t)LK_AD * 16 + 40 + 15) >> 4 ? b : (h.xs + (int32_t)LK_AD * 16 + 40 + 15) >> 4;
    }
    if (h.ns != hd_drawn.ns || h.cs != hd_drawn.cs) {
        a = a < (h.xs >> 4) ? a : (h.xs >> 4);
        b = 240;
    }
    if (a < b)
        head_out(&h, (uint32_t)(a < 0 ? 0 : a), (uint32_t)(b > 240 ? 240 : b));
}

/* the header's band is the page's (no message, no OVERLOAD or LOAD ERR in it) */
static int head_free(void) { return !msg_until && !eng_overload && !load_err; }

/* the top bar of page 0, GLO and ENV (ui.c header_draw): the device page's header; ENV's bar */
static void pages_strip(void)
{
    if (page == PAGE_ENV) {                             /* the environment: ENVIRONMENT and the patch, on lilac */
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
        bar_fill(P_LILAC);
        text_bc(&FONT_S, 8, 3, "ENVIRONMENT", P_NIGHT, P_LILAC, 100, TA_LEFT);
        text_bc(&FONT_S, 108, 3, nm, P_NIGHT, P_LILAC, 124, TA_RIGHT);
        return;
    }
    head_draw(1);
}

/* a page before its device's first heading: its section carries the device's name, which the header already shows */
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

/* ---- the bars: K1..K4's rows, four full-width bars in the knob's hue. The area they share (g_y0..g_y1: the device page's
 * between the header and the footer, 4 px from each; GLO's and the sandbox page's smaller) gives four equal heights,
 * ROW_GAP apart. A bar: the panel colour, filled to its value in the hue mixed 40 % with it and edged LK_ET px in the
 * hue, an ivory tick where modulation has the parameter now; an accent tab in the hue at LK_VP, 45 % of the bar high;
 * the name after it, the value and its unit right. A row the page lacks: the strip's colour */
static uint32_t g_y0 = LK_HH + 4u, g_y1 = FOOT_Y - 4u;
static void geo_set(uint32_t y0, uint32_t y1)
{
    g_y0 = y0;
    g_y1 = y1;
}
static uint32_t row_y(uint32_t k) { return (4u * g_y0 + k * (g_y1 - g_y0 + ROW_GAP) + 2u) / 4u; }
static uint32_t row_h(void) { return (g_y1 - g_y0 - 3u * ROW_GAP + 2u) / 4u; }
/* the device page's and GLO's areas (GLO keeps its button list under the bars) */
#define GLO_LIST_H 36u
static void geo_page(int glo) { geo_set(LK_HH + 4u, FOOT_Y - 4u - (glo ? GLO_LIST_H : 0u)); }

/* what a bar shows */
typedef struct {
    uint8_t used;
    char name[24], num[20], unit[8];
    uint32_t base, live, nx, vx, ux;
} bar_t;
static uint32_t bar_nb(void) { return BASE6(row_h() + 2u, LK_NS); }   /* the name's baseline in the bar */
static uint32_t bar_vb(void) { return BASE6(row_h() + 2u, LK_VS); }   /* the value's */
static uint32_t bar_ub(void) { return BASE6(row_h() + 6u, LK_US); }   /* the unit's */
/* the band of rows that holds the value and the unit */
static uint32_t bar_vr0(void)
{
    uint32_t a = bar_vb() - FONT_V.base, b = bar_ub() - FONT_F.base;
    return a < b ? a : b;
}
static uint32_t bar_vr1(void)
{
    uint32_t a = bar_vb() - FONT_V.base + FONT_V.h, b = bar_ub() - FONT_F.base + FONT_F.h, r = a > b ? a : b;
    return r > row_h() ? row_h() : r;
}

/* where its type goes: name and num cut to fit, the x of each */
static void bar_layout(bar_t *b)
{
    uint32_t uw, vw, vr;
    b->nx = LK_VP + 10u;
    b->vx = b->ux = 0;
    if (!b->used)
        return;
    uw = b->unit[0] ? text_w(&FONT_F, b->unit, -1) : 0u;
    b->ux = BAR_W - 6u - uw;
    vr = b->unit[0] ? b->ux - 3u : BAR_W - 6u;
    fit(b->num, &FONT_V, 110u);
    vw = text_w(&FONT_V, b->num, -1);
    b->vx = vr - vw;
    fit(b->name, &FONT_N, b->vx > b->nx + 6u ? b->vx - b->nx - 6u : 0u);
}

/* bar k's scanline r into row[], the bar from row[ox] on (row[] is ox + BAR_W wide at least) */
static void bar_row(const bar_t *b, uint32_t k, uint32_t r, uint16_t *row, uint32_t ox)
{
    uint32_t i, h = row_h(), base = b->base > BAR_W ? BAR_W : b->base, live = b->live > BAR_W ? BAR_W : b->live, w = ox + BAR_W;
    uint16_t hue = KNOB_HUE[k], *p = row + ox;
    if (!b->used) {
        for (i = 0; i < BAR_W; i++)
            p[i] = P_STRIP;
        text_at(row, w, &FONT_N, r, bar_nb(), "-", ox + b->nx, P_FAINT);
        return;
    }
    for (i = 0; i < BAR_W; i++)
        p[i] = i < base ? KNOB_FILL[k] : P_PANEL;
    for (i = base > LK_ET ? base - LK_ET : 0u; i < base; i++)   /* the fill's edge */
        p[i] = hue;
    if (live != base && r >= 4u && r + 4u < h) {        /* modulated: where the parameter is now (2 px, inside the bar) */
        uint32_t t = live < 1u ? 1u : live > BAR_W - 1u ? BAR_W - 1u : live;
        p[t - 1u] = p[t] = P_INK;
    }
    {
        uint32_t ah = (h * 45u + 50u) / 100u, ty = (h - ah + 1u) / 2u;
        if (r >= ty && r < ty + ah)
            for (i = LK_VP; i < LK_VP + 4u; i++)
                p[i] = hue;
    }
    text_at(row, w, &FONT_N, r, bar_nb(), b->name, ox + b->nx, P_INK);
    text_at(row, w, &FONT_V, r, bar_vb(), b->num, ox + b->vx, P_INK);
    if (b->unit[0])
        text_at(row, w, &FONT_F, r, bar_ub(), b->unit, ox + b->ux, P_MIST);
}

/* ---- PRESET's toast (#170): the footer grows to LK_TOH px of sand for LK_TMS: the slot's number ("07.") left, the
 * patch's name right, and a dash per filled slot of the bank along its bottom (the current one night): up to 32 in a row,
 * more in two (4 px taller). It is drawn first, the page around it; when it goes, only its band is drawn again */
static uint32_t toast_until;
static uint8_t toast_scr;                               /* it is on the screen (the page leaves its rows alone) */
static uint32_t toast_top = 240u;                       /* its first row while it shows */
static int toast_wanted(void) { return toast_until && fm1_ms < toast_until && !sb_on && page == 0u; }
static int toast_up(void) { return toast_scr && toast_wanted(); }
static void toast_end(void) { toast_until = 0; }

/* the bank's filled slots, and where the current one is among them (-1 none) */
static uint32_t bank_filled(int32_t *at)
{
    uint64_t b = bank_mask;
    uint32_t n = 0, i;
    *at = -1;
    for (i = 0; i < 64u && b >> i; i++)
        if (b >> i & 1u) {
            if (i == cur_preset)
                *at = (int32_t)n;
            n++;
        }
    return n;
}

/* the toast's scanline y (>= toast_top) */
static void toast_row(uint32_t y, uint16_t *row)
{
    int32_t at;
    uint32_t i, f = bank_filled(&at), h = 240u - toast_top,
             y2 = (uint32_t)((int32_t)(480u - h - 2u) + 2 * LK_TNY), base, by = 240u - LK_TDB - LK_TDH;
    const font_t *ft = &FONT_T;
    char num[8], nm[32], *q = num;
    for (i = 0; i < 240u; i++)
        row[i] = P_SAND;
    if (cur_preset < M1_SLOTS) {
        char d[8];
        fmt_int(d, (int32_t)cur_preset + 1);
        if (cur_preset < 9u)
            *q++ = '0';
        q = put(q, d);
        *q++ = '.';
    }
    *q = 0;
    caps(nm, patch_label && patch_label[0] ? patch_label : "EMPTY", patch_label && patch_label[0] ? str_len(patch_label) : 5u, 24);
    if (text_w(ft, num, -1) + 10u + text_w(ft, nm, -1) > 240u - 2u * LK_TSP)
        ft = &FONT_V;                                   /* a long name: the bars' value size, so it is whole (PLUCKED STRING) */
    base = BASE6(y2, ft == &FONT_T ? LK_TTS : LK_VS);
    fit(nm, ft, 240u - 2u * LK_TSP - text_w(ft, num, -1) - 10u);
    text_at(row, 240, ft, y, base, num, LK_TSP, P_NIGHT);
    text_at(row, 240, ft, y, base, nm, 240u - LK_TSP - text_w(ft, nm, -1), P_NIGHT);
    if (f <= 32u) {
        if (y >= by && y < by + LK_TDH)
            dashes_onto(row, LK_TSP, 240 - (int32_t)LK_TSP, LK_TDG, f, at, P_NIGHT, P_SLOT_OFF);
    } else {                                            /* two rows, balanced: ceil(f / 2) on top */
        uint32_t r1 = (f + 1u) / 2u, ty = by - LK_TDH - 2u;
        if (y >= ty && y < ty + LK_TDH)
            dashes_onto(row, LK_TSP, 240 - (int32_t)LK_TSP, LK_TDG, r1, at < (int32_t)r1 ? at : -1, P_NIGHT, P_SLOT_OFF);
        if (y >= by && y < by + LK_TDH)
            dashes_onto(row, LK_TSP, 240 - (int32_t)LK_TSP, LK_TDG, f - r1, at >= (int32_t)r1 ? at - (int32_t)r1 : -1, P_NIGHT, P_SLOT_OFF);
    }
}

/* PRESET loaded a patch: its toast from now on (drawn by the next pass, first) */
static void toast_start(void)
{
    int32_t at;
    toast_until = fm1_ms + LK_TMS;
    toast_scr = 0;                                      /* (another patch's over the last one: drawn again) */
    toast_top = 240u - LK_TOH - (bank_filled(&at) > 32u ? 4u : 0u);
}

/* the toast, first: its band, whole; from then on the page draws around it */
static void toast_first(void)
{
    uint32_t y;
    ut_begin(UT_TOAST);
    for (y = toast_top; y < 240u; y++) {
        lcd_sync();
        toast_row(y, lcd_line);
        lcd_line_out(0, y, 240);
    }
    toast_scr = 1;
    ut_end(UT_TOAST);
}

/* ---- the footer (LK_FH high, sand): the patch's name (ARM / REC and the track while one is armed; " *" when edited), the
 * tempo and a quarter note ("MIDI" on MIDI clock), the octave as = OCT = / OCT + / -- OCT and the battery, spread from margin to
 * margin; in sandbox mode who plays instead. The battery: 0..3 bars, a bolt on USB power, red when empty */
typedef struct {
    uint8_t mode, rec;                                  /* 1: sandbox mode's line; REC (the name in red) */
    char a[40], t[8], o[8];                             /* the name, the tempo, the octave (sandbox: a = its line) */
    uint32_t xa, xt, xo;                                /* where each goes */
} foot_t;
static uint32_t ft_drawn;                               /* the hash of the footer as drawn (0: not on the screen) */
#define BATT_FX (240u - 6u - 13u)                       /* the battery's x: 11 x 6 and its nub 2 px */
#define FOOT_OCT_W 40u                                  /* the octave's slot: its widest state in FONT_F, "OCT +++" (the
                                                         * octave runs -3..3: panel.c), the text centred in it, so the
                                                         * tempo stays put when the octave changes (panel_test.c checks) */
#define BATT_FY (FOOT_MID - 3u)
static int seq_arm_label(char *out, int *rec);          /* (seq_ui.c) */
static const uint8_t NOTE_A[9][6] = {                   /* the quarter note as the mock draws it (4-bit coverage), x - 1 .. x + 4 */
    {0, 0, 0, 0, 6, 9}, {0, 0, 0, 0, 6, 9}, {0, 0, 0, 0, 6, 9}, {0, 0, 0, 0, 6, 9}, {0, 0, 0, 0, 6, 9},
    {0, 3, 11, 14, 12, 9}, {2, 15, 15, 15, 15, 10}, {3, 15, 15, 15, 14, 2}, {0, 11, 15, 12, 2, 0}};

static uint32_t foot_layout(foot_t *f)
{
    uint32_t h = 2166136261u, wa, wt, wo, gap16, i;
    int panel = eng_find(T_FM1), rec = 0;
    const char *s;
    char *q;
    memset(f, 0, sizeof *f);
    if (sb_on && page == 0u) {
        f->mode = 1;
        put(f->a, cfg.midi_out ? "BROWSER PLAYS     FM-1 MUTED" : "TURN ON MIDI OUT: GLO, K3")[0] = 0;
        f->rec = (uint8_t)!cfg.midi_out;
        f->xa = (BATT_FX - text_w(&FONT_F, f->a, -1)) / 2u;
    } else {
        if (seq_arm_label(f->a, &rec)) {                /* a track armed (#139): ARM / REC and its name */
            f->rec = (uint8_t)rec;
            caps(f->a, f->a, str_len(f->a), 30);
        } else {
            caps(f->a, patch_label ? patch_label : "", patch_label ? str_len(patch_label) : 0u, 30);
            if (m1_edited)
                put(f->a + str_len(f->a), " *")[0] = 0;
        }
        if (eng_clock_is_external())
            put(f->t, "MIDI")[0] = 0;
        else
            fmt_int(f->t, panel >= 0 ? (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16 : 120);
        q = f->o;                                       /* = OCT =, OCT +, OCT ++, - OCT, -- OCT (the owner, 2026-10-24) */
        for (i = 0; i < (uint32_t)(octave < 0 ? -octave : 0); i++)
            *q++ = '-';
        q = put(q, octave > 0 ? "OCT " : octave < 0 ? " OCT" : "= OCT =");
        for (i = 0; i < (uint32_t)(octave > 0 ? octave : 0); i++)
            *q++ = '+';
        *q = 0;
        wt = text_w(&FONT_F, f->t, -1) + 8u;
        wo = FOOT_OCT_W;
        fit(f->a, &FONT_F, 240u - 12u - 13u - wt - wo - 3u * 6u);
        wa = text_w(&FONT_F, f->a, -1);
        gap16 = (228u - wa - wt - wo - 13u) * 16u / 3u;  /* (space between: the battery ends at the right margin) */
        f->xa = 6u;
        f->xt = 6u + ((wa * 16u + gap16 + 8u) >> 4);
        f->xo = 6u + (((wa + wt) * 16u + 2u * gap16 + 8u) >> 4) + (FOOT_OCT_W - text_w(&FONT_F, f->o, -1)) / 2u;
    }
    for (s = (const char *)f; s < (const char *)(f + 1); s++)   /* (what it shows, the battery apart: foot_batt) */
        h = (h ^ (uint8_t)*s) * 16777619u;
    return h | 1u;
}

/* the battery's pixel x, y of the footer (0: sand) */
static uint16_t batt_px(uint32_t x, uint32_t y, uint8_t lvl)
{
    static const char BOLT[4][10] = {"....##...", "..####...", "...####..", "...##...."};
    uint16_t ink = lvl == 0u ? P_WARN : P_NIGHT;
    if (lvl == BATT_NONE || x > 12u || y > 5u)
        return 0;
    if (x >= 11u)                                       /* the nub */
        return y >= 2u && y <= 3u ? ink : 0;
    if (x == 0u || x == 10u || y == 0u || y == 5u)
        return ink;                                     /* the outline */
    if (lvl == BATT_USB)
        return BOLT[y - 1u][x - 1u] == '#' ? ink : 0;
    return y >= 2u && y <= 3u && x >= 2u && (x - 2u) % 3u != 2u && (x - 2u) / 3u < lvl ? ink : 0;   /* bar k: x 2 + 3k */
}

/* the footer's scanline y */
static void foot_row(const foot_t *f, uint32_t y, uint16_t *row)
{
    uint32_t i;
    uint8_t lvl = batt_shown();
    for (i = 0; i < 240u; i++)
        row[i] = P_SAND;
    text_at(row, 240, &FONT_F, y, FOOT_BASE, f->a, f->xa, f->rec ? P_WARN : P_NIGHT);
    if (f->mode) {
        if (!f->rec && y >= FOOT_BASE - 5u && y < FOOT_BASE - 3u) {   /* (the font has no middle dot) */
            uint32_t x = f->xa + text_w(&FONT_F, "BROWSER PLAYS  ", -1) + 1u;
            row[x] = row[x + 1u] = P_NIGHT;
        }
    } else {
        uint32_t nx = f->xt + text_w(&FONT_F, f->t, -1) + 2u;
        text_at(row, 240, &FONT_F, y, FOOT_BASE, f->t, f->xt, P_INK2);
        text_at(row, 240, &FONT_F, y, FOOT_BASE, f->o, f->xo, P_INK2);
        if (y + 5u >= FOOT_MID && y <= FOOT_MID + 3u)   /* the quarter note: rows -5..3 around the middle */
            for (i = 0; i < 6u; i++) {
                uint32_t a = NOTE_A[y + 5u - FOOT_MID][i];
                if (a && nx + i >= 1u)
                    row[nx + i - 1u] = mix565(P_INK2, row[nx + i - 1u], a + (a > 7u ? 1u : 0u));
            }
    }
    if (y >= BATT_FY && y < BATT_FY + 6u)
        for (i = 0; i < 13u; i++) {
            uint16_t c = batt_px(i, y - BATT_FY, lvl);
            if (c)
                row[BATT_FX + i] = c;
        }
}

/* the footer, whole (or when what it shows changed: whole 0) */
static void foot_draw(int whole)
{
    foot_t f;
    uint32_t h = foot_layout(&f), y;
    if (!whole && h == ft_drawn && batt_drawn == batt_shown())
        return;
    for (y = FOOT_Y; y < 240u; y++) {
        lcd_sync();
        foot_row(&f, y, lcd_line);
        line_out(0, y, 240, 0, 240);
    }
    if (!toast_up()) {
        ft_drawn = h;
        batt_drawn = batt_shown();
    }
}

/* the battery's level changed (ui.c batt_mark_sync): its cell alone */
static void foot_batt_sync(void)
{
    foot_t f;
    uint32_t y;
    if (!ft_drawn || toast_up())
        return;                                         /* (not on the screen: drawn with the footer) */
    (void)foot_layout(&f);
    for (y = BATT_FY; y < BATT_FY + 6u; y++) {
        lcd_sync();
        foot_row(&f, y, lcd_line);
        line_out(0, y, 240, BATT_FX, BATT_FX + 13u);
    }
    batt_drawn = batt_shown();
}

/* lcd_line holds a scanline of the page at y, its pixel 0 at screen x x0 and w px wide: its pixels s0..s1 out, none while
 * PRESET's toast stays on the screen over that row */
static void line_out(uint32_t x0, uint32_t y, uint32_t w, uint32_t s0, uint32_t s1)
{
    uint16_t *row = lcd_line;
    uint32_t i;
    if (y >= toast_top && toast_up())
        return;
    if (s0 || s1 < w) {                                 /* a part of the scanline: its pixels to the front (the texts */
        for (i = s0; i < s1; i++)                       /* announced still count from the whole one's x: scr_ox) */
            row[i - s0] = row[i];
        scr_ox = x0;
    }
    if (s1 > s0)
        lcd_line_out(x0 + s0, y, s1 - s0);
    scr_ox = 0xFFFFu;
}

/* knob k's bar, its rows r0..r1 and of each the pixels s0..s1 of the bar (0, BAR_W: all), a scanline at a time (the
 * fill, the tick, the tab, then the type blended onto them). The device page's (pages_bar_part), GLO's and the sandbox
 * page's (sandbox_ui.c: row_bar) */
static void row_bar_part(uint32_t k, const bar_t *b, uint32_t r0, uint32_t r1, uint32_t s0, uint32_t s1)
{
    uint32_t r, y0 = row_y(k);
    for (r = r0; r < r1; r++) {
        lcd_sync();                                     /* the last row may still be on its way out of lcd_line */
        bar_row(b, k, r, lcd_line, 0);
        line_out(BAR_X, y0 + r, BAR_W, s0, s1);
    }
}
static void row_bar(uint32_t k, const bar_t *b) { row_bar_part(k, b, 0, row_h(), 0, BAR_W); }

/* knob k's row of page pg (or an empty slot) as its bar shows it */
static void pages_row(const ppage_t *pg, uint32_t k, bar_t *b)
{
    b->used = (uint8_t)(pg && k < pg->nrows);
    b->name[0] = b->num[0] = b->unit[0] = 0;
    b->base = b->live = 0;
    if (b->used) {
        row_show(pg, k, b->num, b->unit, BAR_W, &b->base, &b->live);
        caps(b->name, pg->lab[k], pg->llen[k], 16);
    }
    if (b->base > BAR_W)
        b->base = BAR_W;
    if (b->live > BAR_W)
        b->live = BAR_W;
    bar_layout(b);
}

/* a short hash of two texts: whether a bar's number (or name) changed */
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
static void drawn_note(uint32_t k, const bar_t *b)
{
    if (k >= PG_ROWS)
        return;
    pg_drawn[k].base = (uint16_t)b->base;
    pg_drawn[k].live = (uint16_t)b->live;
    pg_drawn[k].vx = (uint16_t)b->vx;
    pg_drawn[k].txt = text_hash(b->num, b->unit);
    pg_drawn[k].name = text_hash(b->name, "") ^ b->used;
    pg_drawn[k].h = (uint8_t)row_h();
    pg_drawn[k].ok = 1;
}

/* the page's bars as they are now (pages_now), for a draw */
static bar_t pg_bar[PG_ROWS];
static void bars_get(const ppage_t *pg)
{
    uint32_t k;
    for (k = 0; k < PG_ROWS; k++)
        pages_row(pg, k, &pg_bar[k]);
}

/* the device page's (or GLO's) scanline y, whole: the header, the bars and the night around them, the footer */
static head_t hd_now;
static foot_t ft_now;
static void page_row(uint32_t y, uint16_t *row)
{
    uint32_t i, k;
    if (y < LK_HH) {
        head_row(&hd_now, y, row);
        return;
    }
    if (y >= FOOT_Y) {
        foot_row(&ft_now, y, row);
        return;
    }
    for (i = 0; i < 240u; i++)
        row[i] = P_NIGHT;
    for (k = 0; k < PG_ROWS; k++)
        if (y >= row_y(k) && y < row_y(k) + row_h()) {
            bar_row(&pg_bar[k], k, y - row_y(k), row, BAR_X);
            return;
        }
}

/* rows y0..y1 of the page, columns x0..x1 */
static void page_out(uint32_t y0, uint32_t y1, uint32_t x0, uint32_t x1)
{
    uint32_t y;
    for (y = y0; y < y1; y++) {
        lcd_sync();
        page_row(y, lcd_line);
        line_out(0, y, 240, x0, x1);
    }
}

/* K1..K4 turned (#298), or a live tick moved: the bar moves where it is, the slider and the number: only the columns its
 * fill's end and live tick moved across (the whole height) and its value and unit when they changed (their band), from
 * what the bar showed (pg_drawn); a bar whose name or kind changed is drawn whole. Every part is drawn from the same
 * values the bar is then noted with, so the bar is then the bar drawn whole, pixel for pixel (panel_test.c) */
static void pages_row_update(const ppage_t *pg, uint32_t k)
{
    bar_t b;
    uint32_t n = 0, i, j, sp[4][4], h = row_h();
    pages_row(pg, k, &b);
    if (!pg_drawn[k].ok || pg_drawn[k].h != h || pg_drawn[k].name != (text_hash(b.name, "") ^ b.used)) {
        row_bar(k, &b);
        drawn_note(k, &b);
        return;
    }
#define SPAN(a, b_, r0, r1) do { uint32_t a_ = (a), e_ = (b_) > BAR_W ? BAR_W : (b_); if (e_ > a_) { sp[n][0] = a_; \
        sp[n][1] = e_; sp[n][2] = (r0); sp[n][3] = (r1); n++; } } while (0)
    {
        uint32_t lo = pg_drawn[k].base < b.base ? pg_drawn[k].base : b.base, hi = pg_drawn[k].base < b.base ? b.base : pg_drawn[k].base;
        if (lo != hi)                                   /* the fill's end (and its edge in the hue) */
            SPAN(lo >= LK_ET ? lo - LK_ET : 0u, hi, 0u, h);
    }
    {                                                   /* the live ticks, the old and the new, where they moved */
        int was = pg_drawn[k].live != pg_drawn[k].base, now = b.live != b.base, same = was && now && b.live == pg_drawn[k].live;
        if (was && !same)
            SPAN(pg_drawn[k].live >= 2u ? pg_drawn[k].live - 2u : 0u, pg_drawn[k].live + 2u, 4u, h - 4u);
        if (now && !same)
            SPAN(b.live >= 2u ? b.live - 2u : 0u, b.live + 2u, 4u, h - 4u);
    }
    if (b.used && (pg_drawn[k].vx != b.vx || pg_drawn[k].txt != text_hash(b.num, b.unit))) {   /* the value and unit */
        uint32_t x = pg_drawn[k].vx < b.vx ? pg_drawn[k].vx : b.vx;
        SPAN(x >= 1u ? x - 1u : 0u, BAR_W - 5u, bar_vr0(), bar_vr1());
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
            row_bar_part(k, &b, sp[i][2], sp[i][3], sp[i][0], sp[i][1]);
    drawn_note(k, &b);
}

/* a patch loaded (main.c preset_load): PRESET's (its toast, then the page drawn in passes by panel_draw), or the whole
 * screen */
static void screen_patch(void)
{
    pages_ensure();
    if (!booting && page == 0 && !sb_on && pg_plain && toast_wanted()) {
        ui_full = 0;
        if (!ui_dirty)
            ui_dirty = 1;
        return;
    }
    screen_idle();
}

/* GLO's list under its bars: what each patch button does in this patch (its label; else its kind; "-" for Nothing) */
static void glo_footer(void)
{
    static const char *const KIND[4] = {"GATE", "-", "TOGGLE", "PAGE"};
    char t[16], line[40], *q;
    uint32_t b, i = 0, y0 = g_y1 + 4u;
    for (b = 0; b < ENG_PANEL_BUTTONS; b++, i++) {
        uint32_t x, y, kind = eng_button_kind(b);
        if (b == 5u) {                                  /* (GLO is this page) */
            i--;
            continue;
        }
        x = BAR_X + (i % 3u) * 76u;
        y = y0 + (i / 3u) * 16u;
        q = put(line, PANEL_BTN_NAME[b]);
        *q = 0;
        text_bc(&FONT_S, x, y, line, P_FAINT, P_NIGHT, 30, TA_LEFT);
        if (!panel_label(b, t))
            put(t, KIND[kind <= 3u ? kind : 1u])[0] = 0;
        text_bc(&FONT_S, x + 28u, y, t, kind == ENG_BTN_NOTHING && !t[1] ? P_FAINT : P_INK, P_NIGHT, 46, TA_LEFT);
    }
}

/* SELECT or ALGO moved the focus (panel.c): the page it reached, drawn in passes (pages_staged) */
static void pages_moved(void)
{
    pg_algo_due = 1;
}

/* its time is up: the page in its band, alone */
static void toast_restore(const ppage_t *pg)
{
    uint32_t k, top = toast_top;
    toast_scr = 0;
    if (!pg)
        return;
    ut_begin(UT_TOAST_END);
    bars_get(pg);
    head_layout(&hd_now);
    ft_drawn = foot_layout(&ft_now);
    page_out(top, 240, 0, 240);
    batt_drawn = batt_shown();
    for (k = 0; k < PG_ROWS && pg_plain; k++)           /* (a bar it met: noted as it is now, the rest of it too) */
        if (row_y(k) + row_h() > top)
            pages_row_update(pg, k);
    ut_end(UT_TOAST_END);
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

/* the page SELECT, ALGO or PRESET reached, over the page that was there (pg_plain): PRESET's toast first, then the
 * header's sections that changed, the band of each bar that holds its type, then the rest of the bars and the footer;
 * each pixel once, nothing cleared first. A click waiting stops it between bands (pages_stop) */
static void pages_staged(const ppage_t *pg, int glo)
{
    uint32_t k, v0 = bar_vr0(), v1 = bar_vr1(), r0 = bar_nb() - FONT_N.base;
    if (toast_scr && !toast_wanted())
        toast_restore(pg);                              /* (its time ran out before the draw came round) */
    if (toast_wanted() && !toast_scr) {
        toast_first();
        if (pages_stop())
            return;
    }
    if (head_free())
        head_draw(0);
    if (pages_stop())
        return;
    v0 = r0 < v0 ? r0 : v0;                             /* (the band from the name's top: every text's first row in it) */
    for (k = 0; k < PG_ROWS; k++) {                     /* the name, value and unit of each */
        bar_t b;
        pages_row(pg, k, &b);
        row_bar_part(k, &b, v0, v1, 0, BAR_W);
        if (pages_stop())
            return;
    }
    for (k = 0; k < PG_ROWS; k++) {                     /* the rest: above and below the type */
        bar_t b;
        pages_row(pg, k, &b);
        row_bar_part(k, &b, 0, v0, 0, BAR_W);
        row_bar_part(k, &b, v1, row_h(), 0, BAR_W);
        drawn_note(k, &b);
        if (k < 3u && pages_stop())
            return;
    }
    if (!glo)
        foot_draw(0);                                   /* (PRESET: another patch's name) */
    pg_strip_dirty = 0;
    pg_algo_due = 0;
    pg_row_dirty = 0;
    pg_plain = 1;
}

/* the device page (page 0) and GLO's (PAGE_GLO); full: everything, else what changed (the header's sections, the bars
 * in place, the footer, PRESET's toast going) */
static void pages_draw(int full)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    int glo = page == PAGE_GLO;
    geo_page(glo);
    if (!full && pg && pg_algo_due && pg_plain && !glo) {
        ut_begin(UT_PAGE);
        pages_staged(pg, glo);                          /* SELECT, ALGO or PRESET reached it */
        ut_end(UT_PAGE);
        return;
    }
    if (!full && toast_scr && !toast_wanted())
        toast_restore(pg);                              /* PRESET's toast's time is up: its band, alone */
    if (!full && pg_plain) {                            /* in place: what changed */
        int knob = pg_row_dirty != 0;
        if (knob)
            ut_begin(UT_KNOB);
        if (head_free())
            head_draw(0);
        for (k = 0; k < PG_ROWS; k++)
            pages_row_update(pg, k);
        foot_draw(0);
        pg_row_dirty = 0;
        pg_strip_dirty = 0;
        pg_algo_due = 0;
        if (knob)
            ut_end(UT_KNOB);
        return;
    }
    ut_begin(UT_FULL);                                  /* whole: every row of the screen once, nothing cleared first */
    pg_algo_due = 0;
    pg_row_dirty = 0;
    pg_strip_dirty = 0;
    if (!toast_wanted())
        toast_scr = 0;
    else if (!toast_scr && !glo)
        toast_first();                                  /* the toast first, the page around it */
    bars_get(pg);
    head_layout(&hd_now);
    ft_drawn = foot_layout(&ft_now);
    page_out(head_free() ? 0u : LK_HH, 240, 0, 240);
    if (head_free()) {
        hd_drawn = hd_now;
        hd_ok = 1;
    } else
        hd_ok = 0;
    if (toast_up())
        ft_drawn = 0;                                   /* (under the toast: drawn when it goes) */
    else
        batt_drawn = batt_shown();
    for (k = 0; k < PG_ROWS; k++)
        drawn_note(k, &pg_bar[k]);
    if (glo)
        glo_footer();
    pg_plain = 1;
    ut_end(UT_FULL);
}

/* PRESET's toast ends: what it covered comes back (main loop) */
static int pages_expired(void)
{
    static uint8_t was;
    uint8_t now = (uint8_t)(toast_wanted() ? 1u : 0u);
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
    geo_page(page == PAGE_GLO);
    for (k = 0; k < PG_ROWS; k++) {
        bar_t b;
        pages_row(pg, k, &b);
        if (!pg_drawn[k].ok || b.base != pg_drawn[k].base || b.live != pg_drawn[k].live)
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

/* the extras (row_more) of device d's page row on module mod's parameter par, 0 none */
static const uint8_t *dev_row_more(uint32_t d, uint32_t mod, uint32_t par)
{
    uint32_t g, k;
    for (g = pg_dev[d].pg0; g < (uint32_t)pg_dev[d].pg0 + pg_dev[d].npg && g < PG_PAGES; g++)
        for (k = 0; k < pg_page[g].nrows; k++)
            if (pg_page[g].mod[k] == mod && pg_page[g].par[k] == par)
                return row_more(&pg_page[g], k);
    return 0;
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
            if (poly_row_set(mod, par & 0x7Fu, (v + 32768) >> 16))
                return -1;
            m1_param_now(mod, par, v);
        } else {
            if (eng_type(mod) < 0 || par >= DEFS[eng_type(mod)].npar)
                continue;
            eng_set_param(mod, par, v);
            m1_patch_param(mod, par, v);
            m1_param_now(mod, par, v);
            more_set(dev_row_more(d, mod, par), v);     /* (the parameters the row also sets, #357) */
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
