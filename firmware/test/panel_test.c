/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The panel core (firmware/src/panel.c) on the host, with no HAL: SELECT, ALGO, K1, HOME (the trail back, held = menu),
 * PLAY / tempo, a key and the MIDI out of every control (#115), checked on the core's state and on the LCD's framebuffer (ui_preview.c's stand-ins).
 *   tools/panel_test.sh */
#define UI_PREVIEW_LIB
#define FB_WATCH
#include "ui_preview.c"

/* what panel.c asks of proto.c and audio.c */
static volatile uint32_t eng_shed_count;
static int focus_dev = -1, focus_pg = -1, param_now = 0;
static void m1_focus_now(uint32_t d, uint32_t g) { focus_dev = (int)d; focus_pg = (int)g; }
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v) { (void)mod; (void)par; (void)v; param_now++; }
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v) { (void)mod; (void)par; (void)v; }
static void m1_panel_on(uint32_t mask) { (void)mask; }
static void m1_patch_bypass(uint32_t mod, int on) { (void)mod; (void)on; }
#include "../src/panel.c"
/* the hooks */
static int presets_stepped, saved, midi_out;
static void leds_play(void) {}
static void leds_panel(void) {}
/* MIDI out: the messages in order (status, d1, d2; a real-time byte with d1 = d2 = 0xFF) */
static uint8_t mlog[256][3];
static int mlen;
static void mlog_add(uint32_t s, uint32_t a, uint32_t b)
{
    if (mlen < 256) {
        mlog[mlen][0] = (uint8_t)s;
        mlog[mlen][1] = (uint8_t)a;
        mlog[mlen][2] = (uint8_t)b;
        mlen++;
    }
    midi_out++;
}
static void midi_send(uint32_t status, uint32_t d1, uint32_t d2) { mlog_add(status, d1, d2); }
static void midi_send_rt(uint32_t b) { mlog_add(b, 0xFFu, 0xFFu); }
/* the log since `from` holds this message */
static int sent(int from, uint32_t s, uint32_t a, uint32_t b)
{
    int i;
    for (i = from; i < mlen; i++)
        if (mlog[i][0] == s && mlog[i][1] == a && mlog[i][2] == b)
            return 1;
    return 0;
}
/* PRESET: counted; with preset_loads the next factory patch runs, as main.c preset_load does with the bank's */
static int preset_loads;
static int load(const char *name);
static void preset_step(int32_t d)
{
    presets_stepped += d;
    if (preset_loads) {
        uint32_t n = (uint32_t)(((int32_t)cur_preset + d % (int32_t)N_PRESETS + (int32_t)N_PRESETS) % (int32_t)N_PRESETS);
        (void)load(PRESET_LIST[n].name);
        cur_preset = n;
        pv_gen++;
        screen_patch();
    }
}
static void save_state(void) { saved++; }
static void poly_row_set(uint32_t mod, uint32_t field, int32_t v) { (void)mod; (void)field; (void)v; }

static int failed;
static void check(const char *what, int ok)
{
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    failed += !ok;
}

/* one turn of the device's main loop: the bookkeeping, the inputs, the drawing (as fm1_main) */
static void loop(void)
{
    panel_status();
    panel_edges(0, 0);
    seq_poll();
    panel_draw();
}
static void enc(uint32_t n, int32_t clicks)
{
    int32_t st[7] = {0};
    st[n] = clicks;
    panel_encoders(st);
    loop();
}
static void tap(uint32_t id)
{
    panel_held |= 1u << id;
    panel_edges(1u << id, 0);
    fm1_ms += 50;
    panel_held &= ~(1u << id);
    panel_edges(0, 1u << id);
    loop();
}
static void later(uint32_t ms)
{
    fm1_ms += ms;
    loop();
}
static uint16_t px(uint32_t x, uint32_t y) { return fb[y * 240u + x]; }
/* the pixels that blinked since fb_watch_reset(): changed value twice or more (cleared, then drawn again) */
static void fb_watch_reset(void) { memset(fb_changes, 0, sizeof fb_changes); }
static uint32_t fb_blinked(void)
{
    uint32_t i, n = 0;
    for (i = 0; i < 240u * 240u; i++)
        n += fb_changes[i] >= 2u;
    return n;
}
/* fb_blinked from row y0 down (the top bar's messages repaint the bar: a cleared bar, then the text) */
static uint32_t fb_blinked_below(uint32_t y0)
{
    uint32_t i, n = 0;
    for (i = y0 * 240u; i < 240u * 240u; i++)
        n += fb_changes[i] >= 2u;
    return n;
}
/* the pixels that changed since fb_watch_reset() inside x0..x1-1, y0..y1-1 */
static uint32_t fb_changed_in(uint32_t x0, uint32_t y0, uint32_t x1, uint32_t y1)
{
    uint32_t x, y, n = 0;
    for (y = y0; y < y1; y++)
        for (x = x0; x < x1; x++)
            n += fb_changes[y * 240u + x] != 0u;
    return n;
}
/* button btn held, key n pressed and let go, btn let go (a loop between each) */
static void held_key(uint32_t btn, uint32_t n)
{
    panel_held |= 1u << btn;
    panel_edges(1u << btn, 0);
    loop();
    panel_keys(1u << n);
    loop();
    panel_keys(0);
    panel_held &= ~(1u << btn);
    panel_edges(0, 1u << btn);
    loop();
}
/* the top bar shows what bar_text(s, bg) draws */
static int bar_shows(const char *s, uint16_t bg)
{
    static uint16_t was[240 * BAR_H];
    int same;
    memcpy(was, fb, sizeof was);
    bar_text(s, bg);
    same = !memcmp(was, fb, sizeof was);
    memcpy(fb, was, sizeof was);
    return same;
}
/* PANEL_SNAP=file.ppm: the LCD at the page-list step, to look at (tools/ui_preview.sh converts PPM to PNG) */
static void snap_to(const char *path)
{
    FILE *f;
    uint32_t i;
    if (!path || !(f = fopen(path, "wb")))
        return;
    fprintf(f, "P6\n240 240\n255\n");
    for (i = 0; i < 240u * 240u; i++) {
        fputc(((fb[i] >> 11) & 31u) * 255u / 31u, f);
        fputc(((fb[i] >> 5) & 63u) * 255u / 63u, f);
        fputc((fb[i] & 31u) * 255u / 31u, f);
    }
    fclose(f);
}
static void snap(void) { snap_to(getenv("PANEL_SNAP")); }

static int load(const char *name)
{
    uint32_t p;
    for (p = 0; p < N_PRESETS && strcmp(PRESET_LIST[p].name, name); p++)
        ;
    if (p >= N_PRESETS)
        return -1;
    memcpy(pv_bin, PRESET_LIST[p].data, PRESET_LIST[p].len);
    pv_len = PRESET_LIST[p].len;
    if (eng_load(pv_bin, pv_len))
        return -1;
    patch_label = PRESET_LIST[p].name;
    {
        static int32_t l[128], r[128];
        eng_render(l, r, 128);
    }
    return 0;
}

int main(void)
{
    static uint16_t before[240 * 240];
    uint32_t mod, par;
    int32_t v0;
    fm1_ms = 10000;
    host_ps_init();
    if (load("808 KIT")) {
        printf("FAIL  the 808 Kit loads\n");
        return 1;
    }
    booting = 0;
    page = 0;
    screen_idle();
    /* the 808 Kit's devices (#196): Main, DRUMS (the track), the Drum map it drives (2 pages), boom kick, snare ... Output */
    check("the device page: the home device in focus (not Main or the track)", page == 0 && pg_cur_dev == 2 && pg_cur_page == 0 && pg_ndev > 4);
    {
        uint32_t x, ink = 0;                                /* (the third tab now: somewhere along the strip) */
        for (x = 0; x < 240u; x++)
            ink += px(x, 1) == P_INK;
        check("the LCD: the tab in focus is ivory, K1's bar shows its hue", ink > 10u && px(12, ROWS_Y + 15) == KNOB_HUE[0]);
    }

    enc(0, 1);                                              /* SELECT: the boom kick, and back to the Drum map */
    check("SELECT: the next device, the editor told", pg_cur_dev == 3 && pg_cur_page == 0 && focus_dev == 3 && focus_pg == 0);
    enc(0, -1);
    check("SELECT back: the device before", pg_cur_dev == 2 && focus_dev == 2);
    check("SELECT: the device's name over the bars", px(12, ROWS_Y + 15) == P_NIGHT);
    fb_watch_reset();
    ui_dirty = 1;                                           /* a redraw while it shows (the beat's, a Live edit) */
    later(100);
    check("SELECT: a redraw under the device's name does not blink it", fb_blinked() == 0 && px(12, ROWS_Y + 15) == P_NIGHT);
    later(1000);
    check("the device toast ends: the bars come back", px(12, ROWS_Y + 15) == KNOB_HUE[0]);

    memcpy(before, fb, sizeof before);
    enc(1, 1);                                              /* ALGO */
    check("ALGO: the device's next page", pg_cur_dev == 2 && pg_cur_page == 1 && focus_pg == 1);
    check("ALGO: the chips and bars are redrawn", memcmp(before, fb, sizeof before) != 0);

    {
        const ppage_t *pg = pages_now();
        mod = pg->mod[0];
        par = pg->par[0];
        v0 = eng_get_param(mod, par);
    }
    enc(2, 5);                                              /* K1 */
    check("K1: its row's parameter moved, the editor told", eng_get_param(mod, par) != v0 && param_now == 1);
    check("K1: the toast shows the row's range bar in K1's hue", px(14, TOAST_Y + 66u) == KNOB_HUE[0]);
    fb_watch_reset();
    enc(2, 1);                                              /* K1 again: the value and the bar, nothing cleared first */
    check("K1 turned again: no pixel of the toast blinks", fb_blinked() == 0);
    fb_watch_reset();
    enc(2, -3);
    check("K1 turned back: no pixel blinks", fb_blinked() == 0);
    later(1100);
    check("the toast ends", px(12, ROWS_Y + 15) == KNOB_HUE[0]);

    memcpy(before, fb, sizeof before);
    tap(BTN_HOME);
    check("HOME on the device pages, nothing to go back to: nothing", page == 0 && pg_cur_dev == 2 && pg_cur_page == 1
          && trail_n == 0 && memcmp(before, fb, sizeof before) == 0);

    panel_held |= 1u << BTN_HOME;                           /* HOME held: the menu after 0.7 s */
    panel_edges(1u << BTN_HOME, 0);
    later(400);
    check("HOME held 0.4 s: not yet", page == 0);
    later(400);
    check("HOME held 0.8 s: the settings menu", page == PAGE_MENU);
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);
    loop();
    check("its release does not close it", page == PAGE_MENU);
    {
        uint8_t tab = menu_tab, row;
        int stepped = presets_stepped;
        enc(1, 1);                                          /* ALGO: the next tab */
        check("ALGO in the menu: the next tab", menu_tab != tab);
        row = menu_sel;
        enc(0, 1);
        check("SELECT in the menu: the next row", menu_sel != row);
        row = menu_sel;
        enc(6, 1);
        check("PRESET in the menu: the next patch, not a row", menu_sel == row && presets_stepped == stepped + 1);
        presets_stepped = stepped;
    }
    {                                                       /* #146: an idle SYSTEM tab redraws only the CPU values */
        uint8_t tab = menu_tab, row = menu_sel;
        uint32_t i, n = 0, outside = 0, y0 = 68u + menu_pos(MR_CPU) * 26u, y1 = 68u + menu_pos(MR_PEAK) * 26u;
        menu_tab = MT_SYSTEM;
        menu_sel = MR_VERSION;
        ui_dirty = 2;
        loop();
        fb_watch_reset();
        eng_us_max = (cpu_pct + 7u) * 2902u / 100u + 1u;   /* another %, above the peak */
        fm1_ms += 500;
        cpu_poll();
        loop();
        for (i = 0; i < 240u * 240u; i++) {
            uint32_t x = i % 240u, y = i / 240u;
            int in = x >= 150u && x < 228u && ((y >= y0 + 3u && y < y0 + 21u) || (y >= y1 + 3u && y < y1 + 21u));
            n += fb_changes[i] != 0u;
            outside += fb_changes[i] != 0u && !in;
        }
        check("SYSTEM idle, the CPU changed: only the CPU and CPU PEAK values redrawn, no blink",
              n > 0u && outside == 0u && fb_blinked() == 0);
        menu_tab = MT_PANEL;
        menu_sel = MR_LEDS;
        ui_dirty = 2;
        loop();
        fb_watch_reset();
        eng_us_max = (cpu_pct + 11u) * 2902u / 100u + 1u;
        fm1_ms += 500;
        cpu_poll();
        loop();
        n = 0;
        for (i = 0; i < 240u * 240u; i++)
            n += fb_changes[i] != 0u;
        check("PANEL idle, the CPU changed: nothing redrawn", n == 0u);
        menu_tab = tab;
        menu_sel = row;
        ui_dirty = 2;
        loop();
    }
    tap(BTN_SEQ);
    check("SEQ from the menu: the step page, a second step", page == PAGE_SEQ && trail_n == 2);
    tap(BTN_HOME);
    check("HOME: back to the menu", page == PAGE_MENU && trail_n == 1);
    tap(BTN_HOME);
    check("HOME tapped: the menu closes, back on the page it was opened from", page == 0 && trail_n == 0 && pg_cur_dev == 2 && pg_cur_page == 1);
    panel_held |= 1u << BTN_HOME;                           /* the menu again, then SAVE */
    panel_edges(1u << BTN_HOME, 0);
    later(800);
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);
    tap(BTN_SAVE);
    check("SAVE in the menu: saved, the menu closes", page == 0 && saved == 1);
    saved = 0;
    {
        uint32_t i;
        for (i = 0; i < TRAIL_MAX + 3u; i++)                /* SEQ, then the menu, ... on and on: the trail keeps the latest */
            page_set(i & 1u ? PAGE_MENU : PAGE_SEQ);
        check("a full trail drops its oldest step", trail_n == TRAIL_MAX);
        for (i = 0; i < TRAIL_MAX + 2u; i++)
            tap(BTN_HOME);
        check("... and HOME still walks it back", trail_n == 0);
        if (page != 0) {
            page_show(0);
        }
    }

    tap(BTN_PLAY);
    check("PLAY: the transport runs", eng_transport_running() == 1);
    {
        int panel = eng_find(T_FM1);
        int32_t bpm = panel >= 0 ? eng_get_param((uint32_t)panel, FM1_P_TEMPO) >> 16 : 0;
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 3);                                          /* PLAY held + PRESET: the tempo */
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("PLAY held + PRESET: the tempo, the release does not stop", panel >= 0 && (eng_get_param((uint32_t)panel, FM1_P_TEMPO) >> 16) == bpm + 3 && eng_transport_running() == 1);
    }
    enc(6, 1);
    check("PRESET alone: the next patch", presets_stepped == 1);
    tap(BTN_SAVE);
    check("SAVE", saved == 1);

    {                                                       /* MIDI out (#115): every control, raw */
        static const struct { uint8_t id, cc; } B[] = {{0, 92}, {1, 93}, {2, 80}, {3, 81}, {4, 82}, {5, 83}, {6, 84}, {7, 85},
                                                       {8, 87}, {9, 88}, {10, 86}, {11, 89}, {12, 91}, {13, 90}};
        uint32_t i;
        int at, all = 1;
        for (i = 0; i < sizeof B / sizeof B[0]; i++) {
            at = mlen;
            tap(B[i].id);
            all &= sent(at, 0xB0u, B[i].cc, 127u) && sent(at, 0xB0u, B[i].cc, 0u);
            if (page == PAGE_SEQ)                           /* (SEQ and REC opened the step page: back) */
                tap(BTN_HOME);
            loop();
        }
        check("every button: CC 127 on the press, 0 on the release", all);
        at = mlen;
        enc(0, 1);
        enc(1, -1);
        enc(6, 2);
        check("SELECT / ALGO / PRESET: relative CC 20 / 21 / 23", sent(at, 0xB0u, 20u, 1u) && sent(at, 0xB0u, 21u, 127u) && sent(at, 0xB0u, 23u, 2u));
        at = mlen;
        enc(2, 3);
        check("K1 on a device page: CC 16", mlen > at && mlog[mlen - 1][0] == 0xB0u && mlog[mlen - 1][1] == 16u);
        at = mlen;
        panel_master(1023);
        panel_master(1020);
        panel_master(512);
        check("MASTER: CC 7, jitter dropped", sent(at, 0xB0u, 7u, 127u) && sent(at, 0xB0u, 7u, 64u) && mlen - at == 2);
        at = mlen;
        tap(BTN_PLAY);
        {
            int run = eng_transport_running();
            tap(BTN_PLAY);
            check("PLAY: Start / Stop with the transport", sent(at, run ? 0xFAu : 0xFCu, 0xFFu, 0xFFu) && sent(at, run ? 0xFCu : 0xFAu, 0xFFu, 0xFFu));
        }
        {
            uint32_t was = eng_buttons_get();
            at = mlen;
            panel_button_set(0, 1);                         /* CC 80 coming in: not echoed */
            panel_button_set(0, 0);
            check("a patch button from MIDI in: not sent back", mlen == at);
            if (eng_buttons_get() != was) {
                panel_button_set(0, 1);
                panel_button_set(0, 0);
            }
        }
    }

    if (pv_bin[6] & 2u) {                                   /* Page buttons (#117), spliced into the 808 Kit's binary */
        check("(the 808 Kit has no macro ranges: the button kinds section goes last)", 0);
    } else {
        /* LFO (button 3) a Page button: device 2 (the Drum map) page 0, then its page 1 (SEL is fixed since #197) */
        static const uint8_t sec[] = {0, 0, 0, 3, 0, 0, 0, 2, 2, 0, 2, 1};
        uint32_t at = pv_len, n;
        if (pv_bin[6] & 128u)                               /* before the Drum maps' row names, last here (format 33): */
            for (n = 1; n < 16u; n++)                       /* u8 count, count x (1 + 64) bytes */
                if (pv_len >= 1u + n * 65u && pv_bin[pv_len - 1u - n * 65u] == n) {
                    at = pv_len - 1u - n * 65u;
                    break;
                }
        memmove(pv_bin + at + sizeof sec, pv_bin + at, pv_len - at);
        memcpy(pv_bin + at, sec, sizeof sec);
        pv_len += sizeof sec;
        pv_bin[6] |= 64u;
        pv_gen++;
        check("a patch with a Page button loads", eng_load(pv_bin, pv_len) == 0 && eng_button_kind(3) == ENG_BTN_PAGE);
        page_show(0);
        trail_n = 0;
        pages_focus(4, 0);                                  /* (the snare) */
        loop();
        tap(5);
        check("LFO tapped: its list's first page, a step on the trail, lit", pg_list_btn == 3 && pg_cur_dev == 2 && pg_cur_page == 0
              && trail_n == 1 && (eng_buttons_get() >> 3 & 1u) && focus_dev == 2);
        later(2000);                                        /* (a message from before ends) */
        check("the top bar names the list", px(120, 2) == P_SEA);
        snap();
        tap(5);
        check("LFO again: the next page", pg_list_step == 1 && pg_cur_dev == 2 && pg_cur_page == 1 && trail_n == 1);
        tap(5);
        check("... round the list", pg_list_step == 0 && pg_cur_dev == 2 && pg_cur_page == 0);
        enc(1, 1);
        check("ALGO inside the list: its next step", pg_list_step == 1 && pg_cur_dev == 2 && pg_cur_page == 1);
        panel_held |= 1u << 5;                              /* held: the first page while it is down */
        panel_edges(1u << 5, 0);
        later(500);
        check("LFO held: the list's first page", pg_list_peek && pg_cur_dev == 2 && pg_cur_page == 0);
        panel_held &= ~(1u << 5);
        panel_edges(0, 1u << 5);
        loop();
        check("let go: back to the step it was on", !pg_list_peek && pg_list_step == 1 && pg_cur_dev == 2 && pg_cur_page == 1);
        tap(BTN_HOME);
        check("HOME: back to where it was before the list, unlit", pg_list_btn < 0 && pg_cur_dev == 4 && pg_cur_page == 0
              && trail_n == 0 && !(eng_buttons_get() >> 3 & 1u));
        tap(5);
        enc(0, 1);
        check("SELECT inside the list leaves it", pg_list_btn < 0 && !(eng_buttons_get() >> 3 & 1u));
        trail_n = 0;
    }

    {                                                       /* SEL on a Steps track's device page (#196): its steps */
        pages_focus(1, 0);                                  /* DRUMS */
        loop();
        check("the track's device page: LEN RATE SWING GATE", pages_now()->nrows == 4u && pages_focus_track() == 0);
        tap(3);
        check("SEL there: the SEQ page on that track", page == PAGE_SEQ && seq_trk == 0);
        tap(BTN_HOME);
        check("HOME: back to the track's page", page == 0 && pg_cur_dev == 1);
        tap(BTN_SEQ);
        check("SEQ there: the same", page == PAGE_SEQ && seq_trk == 0);
        tap(BTN_HOME);
        pages_focus(2, 0);
        loop();
        trail_n = 0;
    }

    {                                                       /* ENV (#197): the environment */
        uint32_t d0, n0 = trail_n;
        pages_focus(2, 1);                                  /* the Drum map, its second page */
        loop();
        d0 = pg_cur_dev;
        tap(4);
        check("ENV: the environment, on the device you were on, its first page on the knobs", page == PAGE_ENV && pg_cur_dev == d0 && pg_cur_page == 0 && trail_n == n0 + 1u);
        check("its bar: ENVIRONMENT on lilac", px(2, 2) == P_LILAC);
        if (getenv("PANEL_SNAP_ENV")) {
            const char *keep = getenv("PANEL_SNAP");
            setenv("PANEL_SNAP", getenv("PANEL_SNAP_ENV"), 1);
            snap();
            if (keep) setenv("PANEL_SNAP", keep, 1);
        }
        enc(0, 1);
        check("SELECT: the next row", page == PAGE_ENV && pg_cur_dev == d0 + 1u && pg_cur_page == 0);
        {
            const ppage_t *pg = pages_now();
            int32_t v = eng_get_param(pg->mod[0], pg->par[0]);
            enc(2, 3);
            check("K1 there: the row's first page", eng_get_param(pg->mod[0], pg->par[0]) != v && page == PAGE_ENV);
            enc(2, -3);
        }
        tap(3);
        check("SEL: the row's device pages", page == 0 && pg_cur_dev == d0 + 1u);
        tap(BTN_HOME);
        check("HOME: back to the environment", page == PAGE_ENV);
        tap(4);
        check("ENV again: back where it came from", page == 0 && trail_n == n0);
        panel_held |= 1u << 4;                              /* ENV held + SAVE: no environment on the release */
        panel_edges(1u << 4, 0);
        panel_edges(1u << BTN_SAVE, 0);
        panel_edges(0, 1u << BTN_SAVE);
        panel_held &= ~(1u << 4);
        panel_edges(0, 1u << 4);
        loop();
        check("ENV held + SAVE: the release opens nothing", page == 0);
        later(1500);
        pages_focus(2, 0);
        loop();
    }

    {                                                       /* presets (#194): Oracle V's, SEL's list, ENV held + SAVE */
        uint32_t d, n0;
        char was[17];
        int r = -1;
        if (load("ORACLE V") == 0) {
            pv_gen++;
            page = 0;
            trail_n = 0;
            loop();
            pages_ensure();
            for (d = 0; d < pg_ndev && !pg_dev[d].structure; d++)
                ;
            check("Oracle V: an assembly device with a structure and its rows (format 34's extras)", d < pg_ndev && pg_dev[d].nrows > 0);
            pages_focus(d, 0);
            loop();
            n0 = preset_list(d);
            check("its factory presets in ROM", n0 >= 2u);
            tap(3);
            check("SEL on it: the preset list", page == PAGE_PRESETS);
            if (getenv("PANEL_SNAP_PRESETS")) {
                const char *keep = getenv("PANEL_SNAP");
                setenv("PANEL_SNAP", getenv("PANEL_SNAP_PRESETS"), 1);
                snap();
                if (keep) setenv("PANEL_SNAP", keep, 1);
            }
            {
                uint32_t i, mod = 0, par = 0;
                for (i = 0; i < pg_dev[d].nrows; i++)
                    if (pg_dev[d].rows[2u * i] != 0xFFu && !(pg_dev[d].rows[2u * i + 1u] & POLY_ROW)) {
                        mod = pg_dev[d].rows[2u * i];
                        par = pg_dev[d].rows[2u * i + 1u];
                        break;
                    }
                (void)mod; (void)par;
                param_now = 0;
                enc(0, 1);                                  /* SELECT: the next preset, loaded */
                check("SELECT on the list: the next preset loaded, the editor told", pg_pname[d][0] && param_now > 0);
            }
            for (r = 0; r < 17; r++)
                was[r] = pg_pname[d][r];
            panel_held |= 1u << 4;                          /* ENV held + SAVE: stored as a new user preset */
            panel_edges(1u << 4, 0);
            panel_edges(1u << BTN_SAVE, 0);
            panel_edges(0, 1u << BTN_SAVE);
            panel_held &= ~(1u << 4);
            panel_edges(0, 1u << 4);
            loop();
            check("ENV held + SAVE on a factory preset: a new user preset (its name and a number), the editor told",
                  ps_list(pg_dev[d].structure, 0, 0) == 1u && host_preset_stored == 1u && ps_name_cmp(pg_pname[d], was) != 0 && preset_list(d) == n0 + 1u);
            panel_held |= 1u << 4;                          /* again: over it */
            panel_edges(1u << 4, 0);
            panel_edges(1u << BTN_SAVE, 0);
            panel_edges(0, 1u << BTN_SAVE);
            panel_held &= ~(1u << 4);
            panel_edges(0, 1u << 4);
            loop();
            check("again: stored over it, still one", ps_list(pg_dev[d].structure, 0, 0) == 1u && host_preset_stored == 2u);
            tap(3);
            check("SEL on the list: back", page == 0);
            later(2000);
        } else {
            check("(the Oracle V factory patch loads)", 0);
        }
        load("808 KIT");
        pv_gen++;
        page = 0;
        trail_n = 0;
        loop();
        pages_focus(2, 0);
        loop();
    }

    {                                                       /* GLO (#199): the FM-1's own settings */
        int main = eng_find(T_FM1);
        int32_t bpm = eng_get_param((uint32_t)main, FM1_P_TEMPO);
        uint32_t d = pg_cur_dev, g = pg_cur_page, ch = cfg.ch;
        tap(7);
        check("GLO: the global page, a step on the trail, GLO's jack was high while held", page == PAGE_GLO && trail_n == 1);
        check("its bar: GLOBAL on coral", px(2, 2) == P_CORAL);
        enc(2, 4);
        check("K1 on GLO: the MIDI channel one step a turn, not the patch's tempo", cfg.ch == (ch < 16u ? ch + 1u : 16u) && eng_get_param((uint32_t)main, FM1_P_TEMPO) == bpm);
        enc(2, -4);
        later(1500);
        check("the rows: MIDI channel, clock in, MIDI out, LEDs", pages_now()->nrows == 4u && pages_now()->mod[0] == SETTING_ROW && cfg.ch == ch);
        if (getenv("PANEL_SNAP_GLO")) {
            const char *keep = getenv("PANEL_SNAP");
            setenv("PANEL_SNAP", getenv("PANEL_SNAP_GLO"), 1);
            snap();
            if (keep) setenv("PANEL_SNAP", keep, 1);
        }
        tap(BTN_HOME);
        check("HOME: back to the device page it came from", page == 0 && pg_cur_dev == d && pg_cur_page == g && trail_n == 0);
        tap(7);
        tap(7);
        check("GLO again on its page: back", page == 0);
        eng_set_param((uint32_t)main, FM1_P_TEMPO, bpm);
    }

    panel_keys(1u << 7);                                    /* a key: a note, sent out */
    check("a key plays a note (MIDI out asked)", (key_sounding & (1u << 7)) && midi_out > 0);
    panel_keys(0);
    check("its release ends it", !(key_sounding & (1u << 7)));

    {                                                       /* a drum track on the SEQ page (the #139 follow-up): the 808 Kit's DRUMS into its Drum map */
        int drums = eng_steps_module(0), map = eng_steps_drummap((uint32_t)eng_steps_module(0));
        char nm[12];
        uint32_t w;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        tap(BTN_SEQ);
        check("the SEQ page on DRUMS shows its Drum map's rows (row 1 first)", page == PAGE_SEQ && map >= 0 && seq_map() == map && seq_row == 0);
        check("the row names come with the patch (format 33)", m1_drum_name((uint32_t)map, 1, nm) && !strcmp(nm, "SNARE"));
        panel_keys(1u << 3);                                /* G#3: the second black key = row 2 (the snare) */
        panel_keys(0);
        check("a black key picks a row", seq_row == 1);
        w = eng_steps_note((uint32_t)drums, 1, 55);
        panel_keys(1u << 2);                                /* G3: the second white key, step 2 (index 1) */
        panel_keys(0);
        check("a white key switches the row's hit on the step", (eng_steps_note((uint32_t)drums, 1, 55) != 0) != (w != 0));
        panel_keys(1u << 2);
        panel_keys(0);
        check("again: back", (eng_steps_note((uint32_t)drums, 1, 55) != 0) == (w != 0));
        panel_held |= 1u << BTN_ACC;
        panel_keys(1u << 4);                                /* FX + A3: step 3 (index 2), accented (#197: FX, was ENV) */
        panel_keys(0);
        panel_held &= ~(1u << BTN_ACC);
        w = eng_steps_note((uint32_t)drums, 2, 55);
        check("FX + a white key: an accented hit (velocity 127)", w && ((w >> 19) & 127u) == ACCENT_VEL);
        ui_dirty = 2;
        loop();
        snap_to(getenv("PANEL_SNAP_DRUMS"));
        panel_keys(1u << 4);
        panel_keys(0);
        tap(BTN_SEQ);
    }

    {                                                       /* arming and recording from the keys (#139), on the 808 Kit's DRUMS */
        static int32_t l[128], r[128];
        int drums = eng_steps_module(0), i;
        const uint32_t *w;
        uint32_t before;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        panel_held |= 1u << BTN_REC;                        /* REC held + black key 1 (F#3): DRUMS armed, no recording */
        panel_edges(1u << BTN_REC, 0);
        panel_keys(1u << 1);
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("REC held + a black key: the track armed, REC's release records nothing", drums >= 0 && eng_armed() == drums && seq_rec == 0 && page == 0u);
        tap(BTN_REC);
        check("REC with a track armed, stopped: step entry on the SEQ page at step 1", page == PAGE_SEQ && seq_rec == 2u && seq_entry() && seq_cur == 0);
        before = (uint32_t)eng_steps_notes((uint32_t)drums, &w);
        panel_keys(1u << 7);                                /* C4 and E4 held, C4 let go: the chord into step 1 */
        panel_keys(1u << 7 | 1u << 11);
        panel_keys(1u << 11);
        {
            int n = eng_steps_notes((uint32_t)drums, &w), on1 = 0;
            for (i = 0; i < n; i++)
                on1 += (w[i] & 63u) == 0u && (((w[i] >> 12) & 127u) == 60u || ((w[i] >> 12) & 127u) == 64u) && ((w[i] >> 19) & 127u) == STEP_VEL;
            check("step entry: the keys held at the first release fill the step, the cursor moves on", on1 == 2 && seq_cur == 1);
        }
        panel_keys(0);
        check("the last key let go writes nothing more", seq_cur == 1);
        panel_keys(1u << 14);                               /* (G4 held, for the picture: the chord being played) */
        loop();
        snap_to(getenv("PANEL_SNAP_ENTRY"));
        panel_keys(0);
        loop();
        seq_cur_move(-1);                                   /* (its chord written into step 2, the cursor back) */
        panel_held |= 1u << BTN_ACC;                        /* FX + OCT+: a rest */
        tap(BTN_OCT_UP);
        panel_held &= ~(1u << BTN_ACC);
        check("FX + OCT: a rest, the cursor on (the octave stays)", seq_cur == 2 && !(eng_steps_get((uint32_t)drums, 1u) & 1) && octave == 0);
        enc(0, -2);
        check("SELECT moves the cursor", seq_cur == 0);
        tap(BTN_REC);
        check("REC again: off", seq_rec == 0 && !seq_kbd());
        tap(BTN_HOME);
        tap(BTN_PLAY);
        tap(BTN_REC);
        check("REC with a track armed, running: a live take, the page stays", page == 0u && seq_rec == 2u);
        for (i = 0; i < 40; i++)
            eng_render(l, r, 128);
        before = (uint32_t)eng_steps_notes((uint32_t)drums, &w);
        panel_keys(1u << 3);                                /* G#3 (56): a note the track did not have */
        for (i = 0; i < 10; i++)
            eng_render(l, r, 128);
        panel_keys(0);
        eng_render(l, r, 128);
        loop();
        {
            int n = eng_steps_notes((uint32_t)drums, &w), got = 0;
            for (i = 0; i < n; i++)
                got |= ((w[i] >> 12) & 127u) == 56u;
            check("the live take: the played note in the track", got && (uint32_t)n == before + 1u);
        }
        check("REC's LED lit on the device page while the take goes on", host_led_mask(fm1_led, 0) >> BTN_REC & 1u);
        ui_dirty = 2;
        loop();
        snap_to(getenv("PANEL_SNAP_TAKE"));
        panel_held |= 1u << BTN_REC;                        /* REC held + the same black key: disarmed, the take ends */
        panel_edges(1u << BTN_REC, 0);
        panel_keys(1u << 1);
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("REC held + the armed track's key: disarmed, REC off", eng_armed() < 0 && seq_rec == 0);
        tap(BTN_PLAY);
    }

    {                                                       /* #179: arming shows on the SEQ page; a mute or an arm redraws in place */
        static uint16_t base[240 * 240];
        char want[40], row[16];
        int drums = eng_steps_module(0), map = eng_steps_drummap((uint32_t)eng_steps_module(0));
        uint32_t all, bar, line, r0;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        tap(BTN_SEQ);
        later(1500);
        check("(the 808 Kit's DRUMS on the SEQ page, nothing armed)", page == PAGE_SEQ && seq_map() == map && eng_armed() < 0);
        memcpy(base, fb, sizeof base);
        seq_row_name(map, seq_row, row);
        fb_watch_reset();
        held_key(BTN_REC, 1);                               /* REC held + F#3 on a drum track's page: track 1, not a row */
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, 172, 240, 186);
        check("drum track's SEQ page: REC held + black key 1 arms DRUMS, REC's release records nothing",
              eng_armed() == drums && seq_rec == 0 && page == PAGE_SEQ);
        check("the arm: DRUMS ARMED in the bar, the track's line redrawn in place, nothing else, no blink",
              bar_shows("DRUMS ARMED", C_FG) && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        later(1500);
        put(put(put(want, "DRUMS: "), row), " ARM")[0] = 0;
        check("after the message the bar says ARM", bar_shows(want, C_ACC));
        snap_to(getenv("PANEL_SNAP_ARM"));
        fb_watch_reset();
        held_key(BTN_SEQ, 1);                               /* SEQ held + F#3: DRUMS muted */
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, 172, 240, 186);
        check("SEQ held + black key 1: muted, only the bar's message and the track's line drawn, no blink",
              eng_steps_muted((uint32_t)drums) && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        held_key(BTN_SEQ, 1);
        later(1500);
        held_key(BTN_REC, 1);                               /* again: disarmed */
        later(1500);
        check("unmuted and disarmed: the page as it was", !eng_steps_muted((uint32_t)drums) && eng_armed() < 0
              && !memcmp(base, fb, sizeof base));
        r0 = seq_row;
        held_key(BTN_REC, 3);                               /* G#3: black key 2, no track 2 */
        check("REC held + a black key past the tracks: NO TRACK 2, nothing armed, REC off, the row stays",
              eng_armed() < 0 && seq_rec == 0 && bar_shows("NO TRACK 2", C_FG) && seq_row == r0);
        later(1500);
        panel_held |= 1u << BTN_REC;                        /* REC's press and the key in the same pass (the key read first) */
        panel_keys(1u << 1);
        panel_edges(1u << BTN_REC, 0);
        loop();
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("REC pressed in the same pass as the key: armed, its release still records nothing", eng_armed() == drums && seq_rec == 0
              && page == PAGE_SEQ);
        held_key(BTN_REC, 1);
        later(1500);

        tap(BTN_SEQ);                                       /* the device page */
        later(1500);
        memcpy(base, fb, sizeof base);
        fb_watch_reset();
        held_key(BTN_REC, 1);
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, FOOT_Y, 240, FOOT_Y + FONT_S.h);
        check("device page: the arm redraws the bar's message and the info line (ARM DRUMS) only, no blink",
              eng_armed() == drums && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        fb_watch_reset();
        held_key(BTN_SEQ, 1);
        check("device page: a mute draws only the bar's message", eng_steps_muted((uint32_t)drums)
              && fb_changed_in(0, 0, 240, 240) == fb_changed_in(0, 0, 240, BAR_H) && fb_blinked_below(BAR_H) == 0);
        held_key(BTN_SEQ, 1);
        held_key(BTN_REC, 1);
        later(1500);
        check("device page, unmuted and disarmed: as it was", eng_armed() < 0 && !memcmp(base, fb, sizeof base));

        E.node[map].ksrc = 0;                               /* the Drum map off DRUMS: a plain track, its row in the track list */
        tap(BTN_SEQ);
        later(1500);
        check("(DRUMS a plain track now)", page == PAGE_SEQ && seq_map() < 0);
        memcpy(base, fb, sizeof base);
        fb_watch_reset();
        held_key(BTN_REC, 1);
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(12, 100, 120, 114);
        check("plain track: REC held + black key 1 arms it, the bar's message and its row (1 DRUMS ARM) only, no blink",
              eng_armed() == drums && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        later(1500);
        check("plain track: the bar says ARM", bar_shows("DRUMS 1/1 ARM", C_ACC));
        snap_to(getenv("PANEL_SNAP_ARM_TRACK"));
        fb_watch_reset();
        held_key(BTN_SEQ, 1);
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(12, 100, 120, 114);
        check("plain track: a mute redraws the bar's message and its row only, no blink", eng_steps_muted((uint32_t)drums)
              && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        held_key(BTN_SEQ, 1);
        held_key(BTN_REC, 1);
        later(1500);
        check("plain track, unmuted and disarmed: the page as it was", eng_armed() < 0 && !memcmp(base, fb, sizeof base));
        tap(BTN_SEQ);
        E.node[map].ksrc = 2u + (uint32_t)drums;
    }

    {                                                       /* #170: PRESET shows the patch's name over the bars */
        uint32_t i, ink = 0, band = 0, blink = 0, y0 = TOAST_Y + 24u, y1 = y0 + FONT_L.h;
        static uint16_t name1[240 * 240];
        int main;
        bank_mask = ((uint64_t)1 << N_PRESETS) - 1u;
        (void)load("808 KIT");
        cur_preset = N_PRESETS - 2u;                        /* the kits are the last two factory patches */
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        later(2000);
        preset_loads = 1;
        enc(6, 1);
        for (i = y0 * 240u; i < y1 * 240u; i++)
            ink += fb[i] == P_INK;
        check("PRESET: the next patch, its name over the bars", cur_preset == N_PRESETS - 1u && !strcmp(patch_label, "909 KIT")
              && ink > 50u && px(12, ROWS_Y + 15) == P_NIGHT);
        snap_to(getenv("PANEL_SNAP_PATCH"));
        memcpy(name1, fb, sizeof name1);
        fb_watch_reset();
        later(300);
        check("a beat's redraw under it leaves it be", fb_blinked() == 0);
        fb_watch_reset();
        enc(6, 1);                                          /* again while it shows: the next name in place */
        for (i = ROWS_Y * 240u; i < ROWS_END * 240u; i++) {
            band += fb_changes[i] != 0u && i >= y0 * 240u && i < y1 * 240u;
            blink += fb_changes[i] >= 2u;
        }
        check("PRESET again within it: the next name, nothing in the toast cleared first", cur_preset == 0
              && !strcmp(patch_label, "ORACLE V") && band > 0u && blink == 0u && memcmp(name1, fb, sizeof name1) != 0);
        later(1100);
        check("the toast ends: the device page's bars come back", px(12, ROWS_Y + 15) != P_NIGHT);
        main = eng_find(T_FM1);
        panel_held |= 1u << BTN_PLAY;                       /* PLAY held + PRESET: the tempo, no patch, no toast */
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 1);
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("PLAY held + PRESET: the tempo, the patch and the bars stay", main >= 0 && cur_preset == 0
              && px(12, ROWS_Y + 15) != P_NIGHT && fm1_ms >= pg_patch_until);
        enc(6, -1);
        enc(0, 1);                                          /* SELECT while it shows: the device's name instead */
        check("SELECT during it: the device toast takes over", fm1_ms >= pg_patch_until && fm1_ms < pg_dev_toast_until);
        later(1100);
        preset_loads = 0;
    }

    printf("%s\n", failed ? "panel test FAILED" : "panel test passed");
    return failed != 0;
}
