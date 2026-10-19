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
 *          just turned, or a device just picked, shows at full size over them (the toast)
 *   y 206  the page rail: a segment per page of the device, the one in focus lit, its section's others dimmer
 *   y 214  the patch (slot, name, * when edited) and the transport, the parts, the octave */

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
typedef struct { const char *name; uint8_t nlen, pg0, npg; int16_t module; } pdev_t;   /* module >= 0: a plain module */
typedef struct {
    const char *name;
    uint8_t nlen, part, parts, display, nrows;          /* display: 1 + the envelope module drawn above, 0 none */
    uint8_t mod[PG_ROWS], par[PG_ROWS], llen[PG_ROWS];
    const char *lab[PG_ROWS];
} ppage_t;
static pdev_t pg_dev[PG_DEVS] UI_POOL;
static ppage_t pg_page[PG_PAGES] UI_POOL;
static uint32_t pg_ndev, pg_npage, pg_built_gen = 0xFFFFFFFFu, pg_built_at;
static uint32_t pg_cur_dev, pg_cur_page;                /* the focus: the device and its page K1..K4 turn */
static uint8_t pg_strip_dirty = 1;                      /* the tabs and chips need a redraw (the focus moved) */
static uint32_t pg_toast_until, pg_dev_toast_until;     /* a knob just turned / a device just picked: shown until fm1_ms */
static uint8_t pg_toast_k;
/* a Page button's list on K1..K4 (#117): its button (-1: none), the step showing, whether a hold peeks at its first page */
static int8_t pg_list_btn = -1;
static uint8_t pg_list_step, pg_list_peek;

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
    if (p[6] & 16u) {
        if (at >= len) return 0;
        at += 1u + (1u + 2u * TRACK_STEPS) * p[at];
    }
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
    return par < DEFS[eng_type(m)].npar;
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
    pg_dev[pg_ndev].nlen = (uint8_t)str_len(d->name);
    pg_dev[pg_ndev].pg0 = (uint8_t)pg_npage;
    pg_dev[pg_ndev].npg = (uint8_t)n;
    pg_dev[pg_ndev].module = (int16_t)m;
    for (j = 0; j < n; j++) {
        ppage_t *pg = &pg_page[pg_npage + j];
        uint32_t r;
        pg->name = d->name;
        pg->nlen = (uint8_t)str_len(d->name);
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
            pages_plain(p[at + 1u]);
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
        if (pg_dev[pg_ndev].npg)
            pg_ndev++;
    }
    if (pg_cur_dev >= pg_ndev)
        pg_cur_dev = 0;
    if (pg_ndev && pg_cur_page >= pg_dev[pg_cur_dev].npg)
        pg_cur_page = 0;
}

/* the model, current with the running patch */
static void pages_ensure(void)
{
    uint32_t len;
    const uint8_t *p = pages_src(&len);
    int fresh = pg_built_gen != pages_gen();
    if (fresh || (p && pages_at(p, len) != pg_built_at)) {
        pages_build();
        if (fresh) {                                    /* another patch: its first device's first page, no list */
            pg_cur_dev = pg_cur_page = 0;
            pg_list_btn = -1;
            pg_list_peek = 0;
        }
    }
}

static const ppage_t *pages_now(void)
{
    pages_ensure();
    return pg_ndev ? &pg_page[pg_dev[pg_cur_dev].pg0 + pg_cur_page] : 0;
}

/* ---- the focus */

/* the page list of button b in the running patch (the button kinds section, flag bit 6): its length, *l = its (device,
 * page) pairs; 0 if b is no Page button */
static uint32_t pages_list(uint32_t b, const uint8_t **l)
{
    uint32_t len, at, k;
    const uint8_t *p = pages_src(&len), *kind;
    if (!p || !(p[6] & 64u) || b >= ENG_PANEL_BUTTONS || !(at = pages_at(p, len)) || !(at = eng_devices_end(p, len, at)) || !eng_buttons_end(p, len, at))
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

/* put a device page on K1..K4 (indices into the section, clamped); returns whether it moved */
static int pages_focus(uint32_t d, uint32_t g)
{
    pages_ensure();
    if (!pg_ndev)
        return 0;
    d = d < pg_ndev ? d : pg_ndev - 1u;
    g = g < pg_dev[d].npg ? g : pg_dev[d].npg - 1u;
    if (d == pg_cur_dev && g == pg_cur_page)
        return 0;
    if (d != pg_cur_dev)
        pg_dev_toast_until = fm1_ms + 900u;
    pg_cur_dev = d;
    pg_cur_page = g;
    pg_strip_dirty = 1;
    pg_toast_until = 0;
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
    pg_toast_k = (uint8_t)k;
    pg_toast_until = fm1_ms + 1000u;
    *mod = m;
    *par = j;
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
    pg_toast_k = (uint8_t)k;
    pg_toast_until = fm1_ms + 1000u;
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
    lcd_fill(0, 0, 240, 20, P_STRIP);
    if (pg_list_btn >= 0 && pg_ndev) {                  /* a Page button's list: "SCL 2/3 · AMP ENV" */
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
        lcd_fill(0, 0, 240, 20, P_SEA);
        text_bc(&FONT_S, 0, 3, bar, P_NIGHT, P_SEA, 240, TA_CENTER);
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
        if (end <= 228u || first >= pg_cur_dev)
            break;
        first++;
    }
    x = first ? 10u : 0u;
    if (first)
        text_bc(&FONT_S, 1, 3, "<", P_FAINT, P_STRIP, 8, TA_LEFT);
    for (i = first; i < pg_ndev && x < 240u; i++) {
        int on = i == pg_cur_dev;
        uint16_t bg = on ? P_INK : P_STRIP, fg = on ? P_NIGHT : pg_dev[i].module >= 0 ? P_SKY : P_DIM;
        caps(t, pg_dev[i].name, pg_dev[i].nlen, 14);
        text_bc(&FONT_S, x, 3, t, fg, bg, w[i] > 240u - x ? 240u - x : w[i], TA_CENTER);
        if (on) {
            lcd_fill(x, 0, w[i] > 240u - x ? 240u - x : w[i], 3, bg);
            lcd_fill(x, 17, w[i] > 240u - x ? 240u - x : w[i], 3, bg);
        }
        x += w[i];
    }
}

/* the pages of the device in focus, by heading: the current group "FILTER 1/2" in seafoam, its neighbours by name, the
 * rest by their first letter */
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
static void pages_info(void)
{
    char a[40], b[32], num[12], *p = a;
    int panel = eng_find(T_FM1), run = eng_transport_running();
    if (cur_preset < M1_SLOTS) {
        fmt_int(num, (int32_t)cur_preset + 1);
        if (cur_preset < 9u)
            *p++ = '0';
        p = put(p, num);
        *p++ = ' ';
    }
    p = put(p, patch_label ? patch_label : "");
    if (m1_edited)
        p = put(p, " *");
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
        text_bc(&FONT_S, BAR_X, FOOT_Y, a, P_DIM, P_NIGHT, 228u - wb, TA_LEFT);
        text_bc(&FONT_S, 234u - wb, FOOT_Y, b, run ? P_SEA : P_FAINT, P_NIGHT, wb + 6u, TA_LEFT);
    }
}

/* the toasts: over the bars, centred in their height */
#define TOAST_Y (ROWS_Y + 26u)

/* knob k's row at full size: its name, the value in the big type, the range bar with the live tick */
static void pages_toast(const ppage_t *pg, uint32_t k)
{
    char t[24], num[20], unit[8], lo_n[20], lo_u[8], hi_n[20], hi_u[8];
    uint32_t m = pg->mod[k], j = pg->par[k], xw, i, ok = 1, bw = 216, base, live;
    lcd_fill(0, ROWS_Y, 240, ROWS_END - ROWS_Y, P_NIGHT);
    t[0] = 'K';
    t[1] = (char)('1' + k);
    t[2] = ' ';
    caps(t + 3, pg->lab[k], pg->llen[k], 16);
    text_bc(&FONT_S, 12, TOAST_Y + 2u, t, KNOB_HUE[k], P_NIGHT, 0, TA_LEFT);
    row_show(pg, k, num, unit, bw, &base, &live);
    for (i = 0; num[i]; i++)                            /* the big type has digits and a few letters: else the large one */
        if (num[i] < 0x20 || num[i] > 0x7E || FONT_XL.map[num[i] - 0x20] == 255u)
            ok = 0;
    if (ok) {
        xw = text_bc(&FONT_XL, 10, TOAST_Y + 16u, num, P_INK, P_NIGHT, 0, TA_LEFT);
        text_bc(&FONT_M, 16u + xw, TOAST_Y + 16u + 42u - 22u, unit, P_DIM, P_NIGHT, 0, TA_LEFT);
    } else {
        xw = text_bc(&FONT_L, 12, TOAST_Y + 26u, num, P_INK, P_NIGHT, 0, TA_LEFT);
        text_bc(&FONT_M, 18u + xw, TOAST_Y + 30u, unit, P_DIM, P_NIGHT, 0, TA_LEFT);
    }
    lcd_fill(12, TOAST_Y + 64u, bw, 8, P_TRACK);
    lcd_fill(12, TOAST_Y + 64u, base, 8, KNOB_HUE[k]);
    if (live != base)
        lcd_fill(12u + (live > 1u ? live - 1u : 0u), TOAST_Y + 61u, 2, 14, P_INK);
    if (j & POLY_ROW)
        return;
    {
        const def_t *d = &DEFS[eng_type(m)];
        value_parts(d, j, d->pmin[j], lo_n, lo_u);
        value_parts(d, j, d->pmax[j], hi_n, hi_u);
    }
    put(put(put(t, lo_n), " "), lo_u)[0] = 0;
    text_bc(&FONT_S, 12, TOAST_Y + 75u, t, P_FAINT, P_NIGHT, 100, TA_LEFT);
    put(put(put(t, hi_n), " "), hi_u)[0] = 0;
    text_bc(&FONT_S, 128, TOAST_Y + 75u, t, P_FAINT, P_NIGHT, 100, TA_RIGHT);
}

/* the device just picked with SELECT, big */
static void pages_dev_toast(void)
{
    char t[20], num[8], *p;
    lcd_fill(0, ROWS_Y, 240, ROWS_END - ROWS_Y, P_NIGHT);
    caps(t, pg_dev[pg_cur_dev].name, pg_dev[pg_cur_dev].nlen, 14);
    text_bc(&FONT_L, 0, TOAST_Y + 24u, t, P_INK, P_NIGHT, 240, TA_CENTER);
    fmt_int(num, (int32_t)pg_cur_dev + 1);
    p = put(t, num);
    *p++ = '/';
    fmt_int(num, (int32_t)pg_ndev);
    p = put(p, num);
    p = put(p, pg_dev[pg_cur_dev].module >= 0 ? "  MODULE" : "  ASSEMBLY");
    *p = 0;
    text_bc(&FONT_S, 0, TOAST_Y + 54u, t, P_DIM, P_NIGHT, 240, TA_CENTER);
}

/* the device page (page 0); full: everything, else what moves (the bars or a toast, the rail, the foot line) */
static void pages_draw(int full)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    if (full)
        lcd_fill(0, 20, 240, 220, P_NIGHT);
    if (full || pg_strip_dirty) {
        if (!msg_until)
            pages_strip();
        if (pg)
            pages_chips();
        else
            lcd_fill(0, 20, 240, 18, P_NIGHT);
        pages_rail();
        pg_strip_dirty = 0;
    }
    pages_info();
    if (pg && fm1_ms < pg_dev_toast_until)
        pages_dev_toast();
    else if (pg && fm1_ms < pg_toast_until && pg_toast_k < pg->nrows)
        pages_toast(pg, pg_toast_k);
    else {
        lcd_fill(0, ROWS_Y - 3u, 240, 3, P_NIGHT);
        for (k = 0; k < PG_ROWS; k++) {
            pages_bar(pg, k);
            if (k < 3u)
                lcd_fill(0, ROWS_Y + k * (ROW_H + ROW_GAP) + ROW_H, 240, ROW_GAP, P_NIGHT);
        }
    }
}

/* the toasts end: the bars come back (main loop) */
static int pages_expired(void)
{
    static uint8_t was;
    uint8_t now = (uint8_t)((fm1_ms < pg_toast_until ? 1u : 0u) | (fm1_ms < pg_dev_toast_until ? 2u : 0u));
    int out = now != was;
    was = now;
    return out;
}

/* the bars whose rows a cable or pin moves (their live tick), redrawn alone ten times a second */
static void pages_ticks(void)
{
    const ppage_t *pg = pages_now();
    uint32_t k;
    if (!pg || fm1_ms < pg_toast_until || fm1_ms < pg_dev_toast_until)
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
