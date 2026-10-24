/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The settings menu, after ui.c and before main.c:
 *
 *
 * MENU (HOME held 0.7 s, HOME again closes it): the settings, in tabs like Felucca's menu (its layout, its rows are ours).
 * ALGORITHM steps between the tabs, PRESET and SELECT between the rows, K1..K4 and OCT- / OCT+ change the value of the
 * selected row. The values are applied at once and saved with the state (SAVE: main.c save bits).
 *
 * The state is plain bytes the main loop writes. */

#ifndef FELUCCA_VERSION
#define FELUCCA_VERSION "v?"
#endif
static void leds_avail(void);
static void leds_octave(void);
static void update_only(const char *why);
static void defaults_now(void);

/* ---- settings menu */

enum { MT_PANEL, MT_MIDI, MT_SYSTEM, MT_MANUAL, MT_COUNT };   /* (MANUAL has no rows: a text) */
static const char *const ROW_NAME[MR_COUNT] = {"LEDS", "KNOB ACCEL", "MIDI CHANNEL", "CLOCK IN", "MIDI OUT",
                                              "VERSION", "CPU", "CPU PEAK", "BANK SLOTS", "BATTERY", "UPDATE MODE", "FACTORY RESET"};
static const uint8_t ROW_TAB[MR_COUNT] = {MT_PANEL, MT_PANEL, MT_MIDI, MT_MIDI, MT_MIDI, MT_SYSTEM, MT_SYSTEM, MT_SYSTEM, MT_SYSTEM, MT_SYSTEM, MT_SYSTEM,
                                          MT_SYSTEM};
static const char *const TAB_NAME[MT_COUNT] = {"PANEL", "MIDI", "SYSTEM", "MANUAL"};

static uint8_t menu_tab, menu_sel = MR_LEDS;     /* the tab and the selected row (a row number) */
static uint32_t cpu_peak;                       /* the highest CPU % since boot */
static uint32_t diag_us_peak;                   /* the longest audio ISR in us since the DIAG CPU page was last read (main.c m1_diag) */
static uint32_t update_arm;                     /* UPDATE MODE / DEFAULTS: fm1_ms | 1 of the first OCT+ (the row is menu_sel) */

static uint32_t menu_first(uint32_t tab)
{
    uint32_t r = 0;
    while (r < MR_COUNT && ROW_TAB[r] != tab)
        r++;
    return r < MR_COUNT ? r : 0u;                 /* (the manual has no rows) */
}

static uint32_t menu_count(uint32_t tab)
{
    uint32_t r, n = 0;
    for (r = 0; r < MR_COUNT; r++)
        n += ROW_TAB[r] == tab;
    return n;
}

static uint32_t menu_row_at(uint32_t tab, uint32_t k)   /* the k-th row of the tab (its rows need not be contiguous: CH_TAB) */
{
    uint32_t r;
    for (r = 0; r < MR_COUNT; r++)
        if (ROW_TAB[r] == tab && k-- == 0u)
            return r;
    return menu_first(tab);
}

static uint32_t menu_pos(uint32_t row)                  /* the position of a row within its tab */
{
    uint32_t r, k = 0;
    for (r = 0; r < row; r++)
        k += ROW_TAB[r] == ROW_TAB[row];
    return k;
}

static void menu_value(uint32_t row, char *out)
{
    static const char *const ONOFF[2] = {"OFF", "ON"};
    char *p = out;
    switch (row) {
    case MR_LEDS: p = put(p, cfg.leds == 0 ? "OFF" : cfg.leds == 1 ? "DIM LOW" : "DIM HIGH"); break;
    case MR_ACCEL: p = put(p, ONOFF[cfg.accel]); break;
    case MR_CPU:
        fmt_int(p, (int32_t)cpu_pct);
        p += str_len(p);
        *p++ = '%';
        break;
    case MR_SLOTS: {                             /* the occupied slots of the bank */
        uint64_t b = bank_mask;
        uint32_t n = 0;
        for (; b; b &= b - 1u)
            n++;
        fmt_int(p, (int32_t)n);
        p += str_len(p);
        p = put(p, " OF 64");
        break;
    }
    case MR_CH: {
        uint32_t c = cfg.ch;
        if (!c) {
            p = put(p, "OMNI");
        } else {
            fmt_int(p, (int32_t)c);
            p += str_len(p);
        }
        break;
    }
    case MR_CLOCK: p = put(p, ONOFF[cfg.clock_in]); break;
    case MR_MOUT: p = put(p, ONOFF[cfg.midi_out]); break;
    case MR_VERSION: p = put(p, FELUCCA_VERSION); break;
    case MR_BATT: {                              /* the smoothed reading (0..1023) and the bars it gives (ui.c ui_battery) */
        uint8_t s = batt_shown();
        if (s == BATT_NONE) {
            p = put(p, "-");
            break;
        }
        fmt_int(p, batt_raw());
        p += str_len(p);
        p = put(p, "  ");
        if (s == BATT_USB) {
            p = put(p, "USB");
        } else {
            *p++ = (char)('0' + s);
            p = put(p, "/3");
        }
        break;
    }
    case MR_PEAK:
        fmt_int(p, (int32_t)cpu_peak);
        p += str_len(p);
        *p++ = '%';
        break;
    default: p = put(p, update_arm && row == menu_sel ? "OCT+ AGAIN" : "OCT+ TWICE"); break;
    }
    *p = 0;
}

#define MENU_Y 68u                                      /* the first row's top, the rows' pitch (SYSTEM's 7 rows end at 214) */
#define MENU_PITCH 21u
#define MENU_ROW_H 20u
#define MENU_TXT 1u                                     /* a row's text below its top */

/* a row's value alone, over the old one (text_bc paints its field's background with each scanline: no blink) */
static void menu_value_draw(uint32_t row)
{
    char val[24];
    uint32_t y = MENU_Y + menu_pos(row) * MENU_PITCH;
    int hot = row == menu_sel;
    if (ROW_TAB[row] != menu_tab)
        return;
    menu_value(row, val);
    text_bc(&FONT_M, 150, y + MENU_TXT, val, hot ? C_ACC : C_FG, hot ? C_TRACK : C_BG, 78, TA_RIGHT);
}

static void menu_row_draw(uint32_t row)
{
    int hot = row == menu_sel;
    uint32_t y = MENU_Y + menu_pos(row) * MENU_PITCH;
    uint16_t bg = hot ? C_TRACK : C_BG;
    lcd_fill(6, y, 228, MENU_ROW_H, bg);
    if (hot)
        lcd_fill(6, y, 3, MENU_ROW_H, C_ACC);
    text_bc(&FONT_M, 14, y + MENU_TXT, ROW_NAME[row], hot ? C_FG : C_DIM, bg, 136, TA_LEFT);
    menu_value_draw(row);
}

/* the MANUAL tab (manual.c): MAN_VIS lines from man_top, SELECT scrolls */
#include "manual.c"
#define MAN_Y 70u
#define MAN_VIS 10u
#define MAN_PITCH 14u
static uint32_t man_top;

static void manual_draw(void)
{
    uint32_t i, h = MAN_VIS * MAN_PITCH, thumb, ty;
    for (i = 0; i < MAN_VIS; i++) {
        uint32_t k = man_top + i, y = MAN_Y + i * MAN_PITCH, c = 0, nm = 0, w;
        uint16_t col = C_FG;
        const char *s = k < MAN_N ? MANUAL[k] : "";
        if (s[0] == '#')
            col = C_ACC;
        else if (s[0] == '~')
            col = C_DIM;
        else if (s[0] == ' ' && s[1] != ' ')         /* "NAME: text": the name (up to a colon in the first 18) in the accent colour */
            while (s[1u + c] && c < 18u && s[1u + c] != ':')
                c++;
        if (s[0] == ' ' && s[1] != ' ' && s[1u + c] == ':')
            nm = c + 1u;
        if (!s[0]) {
            lcd_fill(10, y, 220, MAN_PITCH, C_BG);
            continue;
        }
        w = nm ? text_bcn(&FONT_S, 10, y, s + 1, (int32_t)nm, C_ACC, C_BG, 0, TA_LEFT) : 0u;
        text_bc(&FONT_S, 10u + w, y, s + 1 + nm, col, C_BG, 218u - w, TA_LEFT);
    }
    thumb = h * MAN_VIS / MAN_N;                    /* the scroll bar at the right */
    thumb = thumb < 8u ? 8u : thumb;
    ty = MAN_N > MAN_VIS ? (h - thumb) * man_top / (MAN_N - MAN_VIS) : 0u;
    lcd_fill(232, MAN_Y, 3, h, C_TRACK);
    lcd_fill(232, MAN_Y + ty, 3, thumb, C_ACC);
}

static void manual_scroll(int32_t s)
{
    int32_t t = (int32_t)man_top + s, max = (int32_t)MAN_N - (int32_t)MAN_VIS;
    t = t > max ? max : t < 0 ? 0 : t;
    if ((uint32_t)t != man_top) {
        man_top = (uint32_t)t;
        ui_dirty = 1;
    }
}

static void menu_draw(int full)
{
    static uint8_t shown = 255;
    uint32_t t, r, n = menu_count(menu_tab), y = MENU_Y + n * MENU_PITCH, x = 6;   /* (y: below the last row) */
    if (full || shown != menu_tab) {                /* (a new tab: the page is cleared, the hint changes) */
        lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
        text_bc(&FONT_S, 8, 222, menu_tab == MT_MANUAL ? "SELECT  scroll      ALGO  tab" : "ALGO  tab    SELECT  row    K1-K4  value", C_HINT, C_BG, 226, TA_LEFT);
        shown = menu_tab;
    }
    for (t = 0; t < MT_COUNT; t++) {     /* the tabs: chips, the open one in seafoam (as a device's pages) */
        uint32_t w = text_w(&FONT_S, TAB_NAME[t], -1) + 12u;
        text_bc(&FONT_S, x, 24, TAB_NAME[t], t == menu_tab ? C_BG : C_DIM, t == menu_tab ? 0x7E38u : C_TRACK, w, TA_CENTER);
        x += w + 3u;
    }
    text_bc(&FONT_L, 8, 42, menu_tab == MT_MANUAL ? "Manual" : TAB_NAME[menu_tab], C_ACC, C_BG, 200, TA_LEFT);
    if (menu_tab == MT_MANUAL) {
        manual_draw();
        return;
    }
    for (r = 0; r < n; r++)
        menu_row_draw(menu_row_at(menu_tab, r));
    if (y < 218u)
        lcd_fill(0, y, 240, 218u - y, C_BG);       /* (the rows a longer tab had) */
}

static void menu_open(void)             /* via page_show (panel.c): the tab and row it was left at */
{
    if (ROW_TAB[menu_sel] != menu_tab)
        menu_sel = (uint8_t)menu_first(menu_tab);
    update_arm = 0;
}

static void menu_set_row(uint32_t row, int32_t s)       /* s > 0: the next value, s < 0: the previous (stopping at the ends) */
{
    if (menu_tab == MT_MANUAL)
        return;                                     /* (no row: the buttons do nothing on the manual) */
    setting_step(row, s);
}

static void setting_step(uint32_t row, int32_t s)       /* a setting's next / previous value (the menu's and GLO's rows) */
{
    int up = s > 0;
    int32_t d = s > 0 ? 1 : -1;
    switch (row) {
    case MR_LEDS: {
        int32_t v = (int32_t)cfg.leds + d;
        cfg.leds = (uint8_t)(v < 0 ? 0 : v > 2 ? 2 : v);
        leds_avail();
        break;
    }
    case MR_ACCEL: cfg.accel = (uint8_t)up; break;
    case MR_CH: {
        int32_t v = (int32_t)cfg.ch + d;
        cfg.ch = (uint8_t)(v < 0 ? 0 : v > 16 ? 16 : v);
        break;
    }
    case MR_CLOCK: cfg.clock_in = (uint8_t)up; break;
    case MR_MOUT: cfg.midi_out = (uint8_t)up; break;
    case MR_UPDATE:
    case MR_DEFAULTS:
        if (!up)
            break;
        if (test_input_recent()) {                  /* the device test mode (#291): a script never wipes or leaves the FM-1 */
            update_arm = 0;
            ui_msg("TEST INPUT: REFUSED", 2000);
            break;
        }
        if (update_arm && fm1_ms - (update_arm & ~1u) < 3000u) {
            update_arm = 0;
            if (row == MR_UPDATE)
                update_only("FROM THE MENU");
            else
                defaults_now();
        } else {
            update_arm = fm1_ms | 1u;
        }
        break;
    default: break;
    }
    ui_dirty = 1;
}

static void menu_move(int32_t s)                        /* SELECT: the next / previous row of the tab */
{
    uint32_t n = menu_count(menu_tab), k = menu_pos(menu_sel);
    if (!n)
        return;
    k = (k + (s > 0 ? 1u : n - 1u)) % n;
    menu_sel = (uint8_t)menu_row_at(menu_tab, k);
    update_arm = 0;
    ui_dirty = 1;
}

static void menu_tab_go(int32_t s)                      /* ALGORITHM: the next / previous tab */
{
    uint32_t t = (menu_tab + (s > 0 ? 1u : MT_COUNT - 1u)) % MT_COUNT;
    menu_tab = (uint8_t)t;
    menu_sel = (uint8_t)menu_first(t);
    update_arm = 0;
    ui_dirty = 1;
}

/* the knobs while the menu is open: st[] as in knobs_poll */
static void menu_knobs(const int32_t *st)
{
    uint32_t k;
    if (st[1])
        menu_tab_go(st[1]);
    if (menu_tab == MT_MANUAL) {                    /* the manual: SELECT scrolls */
        manual_scroll(st[0]);
        return;
    }
    if (st[0])                                      /* SELECT: the rows (PRESET steps the patches, panel.c) */
        menu_move(st[0]);
    for (k = 0; k < 4u; k++)
        if (st[2u + k])
            menu_set_row(menu_sel, st[2u + k]);
}

/* the CPU load (SYSTEM's CPU and CPU PEAK rows): the peak ISR time of the last half second, in % of the 128 frame half
 * buffer (2.9 ms). On an idle SYSTEM tab only the two values are redrawn, not the page (#146). */
static void cpu_poll(void)
{
    static uint32_t t0;
    uint32_t pct, peak = cpu_peak;
    int shown;
    if (fm1_ms - t0 < 500u)
        return;
    t0 = fm1_ms;
    pct = eng_us_max * 100u / 2902u;
    if (eng_us_max > diag_us_peak)
        diag_us_peak = eng_us_max;
    eng_us_max = 0;
    if (pct > 999u)
        pct = 999u;
    if (pct > cpu_peak)
        cpu_peak = pct;
    shown = page == PAGE_MENU && menu_tab == MT_SYSTEM && !ui_dirty;   /* (a pending redraw shows them anyway) */
    if (pct != cpu_pct) {
        cpu_pct = pct;
        if (shown)
            menu_value_draw(MR_CPU);
    }
    if (cpu_peak != peak && shown)
        menu_value_draw(MR_PEAK);
}

/* the battery on screen (ui.c ui_battery set it): by the loop's drawing (panel_draw), never by a key. LOW BATTERY in the
 * bar once, the cell in the top bar when its level changed, MENU > SYSTEM > BATTERY's value when the reading changed */
static void batt_draw(void)
{
    static int32_t raw_shown = -1;
    static uint8_t lvl_shown = BATT_NONE - 1u;
    if (booting)
        return;
    if (batt_low_due) {
        batt_low_due = 0;
        ui_msg("LOW BATTERY", 3000);
    }
    batt_mark_sync();
    if (batt_raw() != raw_shown || batt_shown() != lvl_shown) {
        raw_shown = batt_raw();
        lvl_shown = batt_shown();
        if (page == PAGE_MENU && menu_tab == MT_SYSTEM && !ui_dirty)   /* (a pending redraw shows it anyway) */
            menu_value_draw(MR_BATT);
    }
}
