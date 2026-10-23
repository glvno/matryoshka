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
#include "../src/live.c"                            /* the editor's Live (#185, #200): main.c's, as on the device */
/* PRESET: counted; with preset_loads the next factory patch runs, as main.c preset_load does with the bank's; under the
 * editor's Live it waits, as main.c preset_step */
static int preset_loads;
static int load(const char *name);
static void preset_step(int32_t d)
{
    if (live_holds_preset())
        return;
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

/* the HAL's key edge queue (fm1_input.h fm1_input_key_peek / pop, #230): edges latched by the scan, in order */
static uint8_t kq[64];
static uint32_t kq_r, kq_w;
static int kq_peek(void) { return kq_r == kq_w ? -1 : (int)kq[kq_r % 64u]; }
static void kq_pop(void) { if (kq_r != kq_w) kq_r++; }
static void kq_edge(uint32_t n, int down) { kq[kq_w++ % 64u] = (uint8_t)(n | (down ? 0x80u : 0u)); }
/* main.c keys_poll: the latched edges, then the keys as they are now */
static void keys_poll_q(uint32_t now)
{
    panel_key_queue(kq_peek, kq_pop, 0);
    panel_keys(now);
}
/* main.c keys_yield, the yield panel_draw hands the LCD; counts the LCD transfers made from inside it (must be none) */
static uint32_t yield_calls, yield_xfers;
static void keys_yield_q(void)
{
    uint32_t x = lcd_xfers;
    yield_calls++;
    panel_key_queue(kq_peek, kq_pop, 1);
    yield_xfers += lcd_xfers - x;
}
/* the index of this message in the MIDI log from `from`, -1 none */
static int sent_at(int from, uint32_t s, uint32_t a, uint32_t b)
{
    int i;
    for (i = from; i < mlen; i++)
        if (mlog[i][0] == s && mlog[i][1] == a && mlog[i][2] == b)
            return i;
    return -1;
}

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

    {   /* #221: while SELECT / ALGO turn, a card alone (red / blue), the page once they stop; lcd_px: the pixels sent */
        uint32_t page_px, card1_px, card2_px, card3_px, settle_px;
        lcd_px = lcd_xfers = 0;
        ui_dirty = 2;                                       /* (today's cost of a click: the whole page) */
        loop();
        page_px = lcd_px;
        lcd_px = lcd_xfers = 0;
        enc(0, 1);                                          /* SELECT: the boom kick, and back to the Drum map */
        card1_px = lcd_px;
        check("SELECT: the next device, the editor told", pg_cur_dev == 3 && pg_cur_page == 0 && focus_dev == 3 && focus_pg == 0);
        check("SELECT: the device card, red, from the top bar down", px(4, 4) == P_CARD_DEV && px(12, ROWS_Y + 15) == P_CARD_DEV
              && px(4, 236) == P_CARD_DEV);
        snap_to(getenv("PANEL_SNAP_DEVCARD"));
        fb_watch_reset();
        lcd_px = 0;
        later(100);
        enc(0, -1);
        card2_px = lcd_px;
        check("SELECT back: the device before, in place (no fill, no blink)", pg_cur_dev == 2 && focus_dev == 2
              && fb_blinked() == 0 && fb_changed_in(0, 0, 240, CARD_Y0) == 0 && fb_changed_in(0, CARD_Y1, 240, CARD_Y1 + FONT_L.h) > 0);
        fb_watch_reset();
        ui_dirty = 1;                                       /* a redraw while it shows (the beat's, a Live edit) */
        later(100);
        check("SELECT: a redraw under the card leaves it be", fb_blinked() == 0 && fb_changed_in(0, 0, 240, 240) == 0);
        later(200);
        check("SELECT: 300 ms after the last click, still the card", px(12, ROWS_Y + 15) == P_CARD_DEV);
        lcd_px = 0;
        later(200);
        settle_px = lcd_px;
        check("SELECT stopped 400 ms: the page, whole (strip, bars, foot line)", px(12, ROWS_Y + 15) == KNOB_HUE[0]
              && px(4, 236) == P_NIGHT && px(0, 0) != P_CARD_DEV);
        enc(1, 1);                                          /* ALGO */
        check("ALGO: the device's next page, its card blue", pg_cur_dev == 2 && pg_cur_page == 1 && focus_pg == 1
              && px(4, 4) == P_CARD_PAGE);
        snap_to(getenv("PANEL_SNAP_PAGECARD"));
        lcd_px = 0;
        enc(1, -1);
        card3_px = lcd_px;
        enc(1, 1);
        printf("      LCD pixels: a whole page %u, the first card %u, the next click %u (ALGO %u), the settle %u\n", page_px,
               card1_px, card2_px, card3_px, settle_px);
        check("a card costs under 60 % of a page, the next click under a fourth of the first", card1_px * 10u < page_px * 6u
              && card2_px * 4u < card1_px && card3_px * 4u < card1_px);
        memcpy(before, fb, sizeof before);
        enc(4, 1);                                          /* K3 while the card shows: the page at once */
        check("K3 during the card: the page it named, whole, at once", pg_cur_page == 1 && px(4, 4) != P_CARD_PAGE
              && px(0, ROWS_END + 10u) == P_NIGHT);
        enc(4, -1);
        later(1100);
        check("the knob's toast ends: the bars", px(12, ROWS_Y + 15) == KNOB_HUE[0]);
        param_now = 0;
    }

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
            {
                char want[40];
                uint32_t dn = pg_dev[pg_cur_dev].nlen < 8u ? pg_dev[pg_cur_dev].nlen : 8u;
                caps(want, pg_dev[pg_cur_dev].name, dn, dn);
                printf("      (the bar: \"%s\")\n", msg_text);
                check("its bar: the device, \": \", the row's name, the value (26 characters at most)",
                      !strncmp(msg_text, want, dn) && strstr(msg_text, ": ") && str_len(msg_text) <= 26u);
            }
            enc(2, -3);
        }
        tap(3);
        check("SEL: the row's device pages", page == 0 && pg_cur_dev == d0 + 1u);
        tap(BTN_HOME);
        check("HOME: back to the environment", page == PAGE_ENV);
        tap(4);
        check("ENV again: back where it came from", page == 0 && trail_n == n0);
        pages_focus(1, 0);                                  /* REC on a row (#191): DRUMS armed, then disarmed */
        loop();
        tap(4);
        tap(BTN_REC);
        check("REC on the environment's track row: armed (the set), no recording", eng_armed() == eng_steps_module(0) && seq_rec == 0 && page == PAGE_ENV);
        pages_focus(2, 0);                                  /* the Drum map: its keys come from the track, not Main */
        tap(BTN_REC);
        check("REC on a row with nothing on Main's keys: nothing armed there", eng_arm_mask_get() == (uint64_t)1 << eng_steps_module(0));
        pages_focus(1, 0);
        tap(BTN_REC);
        check("REC again on the track: disarmed", eng_arm_mask_get() == 0u && eng_armed() < 0);
        tap(4);
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
            n0 = dp_list(d);
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
                  ps_list(pg_dev[d].structure, 0, 0) == 1u && host_preset_stored == 1u && ps_name_cmp(pg_pname[d], was) != 0 && dp_list(d) == n0 + 1u);
            {                                           /* its name: the preset it was based on and 2; its values: the device's */
                char want[24], got[17];
                uint32_t st, nv, i, nd = dp_values(d);
                int32_t now[PS_MAXV];
                int same = 1, at = ps_find(pg_dev[d].structure, pg_pname[d]);
                for (i = 0; i < nd; i++)
                    now[i] = pr_vals[i];
                put(put(want, was), " 2")[0] = 0;
                printf("      (based on \"%s\": stored as \"%s\")\n", was, pg_pname[d]);
                if (at < 0 || ps_read((uint32_t)at, &st, got, &nv) || nv != nd)
                    same = 0;
                for (i = 0; same && i < nd; i++)
                    same = ps_vbuf[i] == now[i];
                check("the new preset: named after the one it was based on with 2, holding the device's own values",
                      !ps_name_cmp(pg_pname[d], want) && same);
            }
            panel_held |= 1u << 4;                          /* again: over it */
            panel_edges(1u << 4, 0);
            panel_edges(1u << BTN_SAVE, 0);
            panel_edges(0, 1u << BTN_SAVE);
            panel_held &= ~(1u << 4);
            panel_edges(0, 1u << 4);
            loop();
            check("again: stored over it, still one", ps_list(pg_dev[d].structure, 0, 0) == 1u && host_preset_stored == 2u);
            {                                           /* a device with no preset remembered (a factory patch as it ships) */
                char first[17], want[24];
                (void)dp_list(d);
                (void)dp_entry(pr_list[0], first);
                put(put(want, first), " 2")[0] = 0;
                pg_pname[d][0] = 0;
                panel_held |= 1u << 4;
                panel_edges(1u << 4, 0);
                panel_edges(1u << BTN_SAVE, 0);
                panel_edges(0, 1u << BTN_SAVE);
                panel_held &= ~(1u << 4);
                panel_edges(0, 1u << 4);
                loop();
                printf("      (no preset remembered: stored as \"%s\")\n", pg_pname[d]);
                check("no preset remembered: named after the first of its list (Init) with 2, not the device's name",
                      !ps_name_cmp(pg_pname[d], want) && ps_list(pg_dev[d].structure, 0, 0) == 2u);
            }
            {                                           /* the editor deletes the preset the device is set to (main.c m1_preset_del) */
                int32_t before = eng_get_param(pg_dev[d].rows[0], pg_dev[d].rows[1]);
                char gone[17];
                strcpy(gone, pg_pname[d]);
                check("the editor deletes the preset in use: deleted", ps_del(pg_dev[d].structure, gone) == 0);
                dp_deleted(pg_dev[d].structure, gone);
                check("  the device keeps its sound, no longer names it, the message says so",
                      !pg_pname[d][0] && eng_get_param(pg_dev[d].rows[0], pg_dev[d].rows[1]) == before &&
                      !strcmp(msg_text, "PRESET DELETED: SOUND KEPT") && ps_list(pg_dev[d].structure, 0, 0) == 1u);
                msg_text[0] = 0;
                dp_deleted(pg_dev[d].structure, "NOT IN USE");
                check("  one no device is set to: no message", !msg_text[0]);
            }
            tap(3);
            check("SEL on the list: back", page == 0);
            {                                               /* a patch stored before format 34 (the bank keeps it): no structure */
                uint32_t keep = pg_dev[d].structure;
                pg_dev[d].structure = 0;
                tap(3);
                loop();
                printf("      (the bar: \"%s\")\n", msg_text);
                check("SEL on an assembly of an old patch: no list, the bar says why (not \"SEL ON\")",
                      page == 0 && !strcmp(msg_text, "OLD PATCH: SEND + SAVE IT"));
                pg_dev[d].structure = keep;
            }
            tap(4);                                         /* the environment (#198): ALGO and PRESET step the row's presets */
            {
                char before[17];
                memcpy(before, pg_pname[d], sizeof before);
                enc(1, 1);
                check("ALGO on the environment's row: its next preset", page == PAGE_ENV && strcmp(before, pg_pname[d]) != 0);
                memcpy(before, pg_pname[d], sizeof before);
                enc(6, -1);
                check("PRESET there: its previous one, not another patch", page == PAGE_ENV && strcmp(before, pg_pname[d]) != 0 && !strcmp(patch_label, "ORACLE V"));
            }
            tap(4);
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
        {                                                   /* every white key is one step, in order; no black key is a step (A# was step 4, B none) */
            int next = 0, ok = 1;
            for (uint32_t k = 0; k < 27u; k++) {
                if (seq_white(k) >= 0) ok &= seq_white(k) == next++ && seq_black(k) < 0;
                else ok &= seq_black(k) >= 0;
            }
            check("the 16 white keys are steps 1..16 in order, the black keys none", ok && next == 16);
        }
        w = eng_steps_note((uint32_t)drums, 3, 55);
        panel_keys(1u << 6);                                /* B3: the fourth white key, step 4 (index 3) */
        panel_keys(0);
        check("B switches its step (it did nothing)", (eng_steps_note((uint32_t)drums, 3, 55) != 0) != (w != 0));
        panel_keys(1u << 6);
        panel_keys(0);
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

    {                                                       /* #230: no key lost or late while the screen redraws */
        static int32_t l[128], r[128];
        int drums = eng_steps_module(0), map = eng_steps_drummap((uint32_t)eng_steps_module(0)), m0, i, n, got;
        int32_t base = 53 + 12 * octave;
        uint32_t keep[TRACK_NOTES_MAX], keep_n, wk[TRACK_NOTES_MAX], rn;
        const uint32_t *w;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        later(1500);
        m0 = mlen;
        kq_edge(9, 1);                                      /* D4 pressed and let go within one pass */
        kq_edge(9, 0);
        keys_poll_q(0);
        check("a press and its release in one pass: the note on, then off",
              sent_at(m0, 0x90u, (uint32_t)base + 9u, 100u) >= 0
              && sent_at(m0, 0x80u, (uint32_t)base + 9u, 0u) > sent_at(m0, 0x90u, (uint32_t)base + 9u, 100u) && !key_sounding);
        m0 = mlen;
        kq_edge(4, 1);                                      /* A3 before G3, A3 let go before G3: in that order (key order: G3 first) */
        kq_edge(2, 1);
        kq_edge(4, 0);
        kq_edge(2, 0);
        keys_poll_q(0);
        {
            int a = sent_at(m0, 0x90u, (uint32_t)base + 4u, 100u), b = sent_at(m0, 0x90u, (uint32_t)base + 2u, 100u);
            int c = sent_at(m0, 0x80u, (uint32_t)base + 4u, 0u), d = sent_at(m0, 0x80u, (uint32_t)base + 2u, 0u);
            check("edges of two keys in one pass: in the order played", a >= 0 && a < b && b < c && c < d && mlen - m0 == 4);
        }
        m0 = mlen;
        kq_edge(7, 1);                                      /* the queue and the keys now agree: nothing twice */
        keys_poll_q(1u << 7);
        keys_poll_q(1u << 7);
        kq_edge(7, 0);
        keys_poll_q(0);
        check("an edge the keys' state already gave: once", mlen - m0 == 2 && !key_sounding);

        panel_yield = keys_yield_q;                         /* main.c: from inside panel_draw */
        m0 = mlen;
        yield_calls = yield_xfers = 0;
        kq_edge(9, 1);
        ui_dirty = 2;
        panel_draw();
        check("a key pressed during a full redraw plays during it, the redraw drawing on",
              sent_at(m0, 0x90u, (uint32_t)base + 9u, 100u) >= 0 && (key_sounding >> 9 & 1u) && kq_r == kq_w && yield_calls > 0u
              && yield_xfers == 0u);
        kq_edge(9, 0);
        ui_dirty = 2;
        panel_draw();
        check("its release too", sent_at(m0, 0x80u, (uint32_t)base + 9u, 0u) >= 0 && !key_sounding && yield_xfers == 0u);
        panel_held |= 1u << BTN_SEQ;                        /* SEQ held + black key 1 during a redraw: a mute draws, it waits */
        panel_edges(1u << BTN_SEQ, 0);
        loop();
        kq_edge(1, 1);
        kq_edge(9, 1);                                      /* (and a key after it waits behind it: the order kept) */
        m0 = mlen;
        ui_dirty = 2;
        panel_draw();
        check("SEQ held + a black key in a redraw: left for the pass, the key after it too",
              !eng_steps_muted((uint32_t)drums) && kq_w - kq_r == 2u && mlen == m0 && yield_xfers == 0u);
        keys_poll_q(1u << 1 | 1u << 9);
        check("the next pass: muted, then the note", eng_steps_muted((uint32_t)drums) && (key_sounding >> 9 & 1u) && kq_r == kq_w);
        kq_edge(1, 0);
        kq_edge(9, 0);
        keys_poll_q(0);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        held_key(BTN_SEQ, 1);                               /* (unmuted) */
        later(1500);
        check("(unmuted, the device page)", !eng_steps_muted((uint32_t)drums) && page == 0u);

        tap(BTN_SEQ);                                       /* the SEQ page, DRUMS' Drum map, REC on, running: hits */
        tap(BTN_PLAY);
        tap(BTN_REC);
        for (i = 0; i < 20; i++)
            eng_render(l, r, 128);
        loop();
        rn = seq_row_note(map, 3);                          /* row 4 (C#4, black key 4): its hits off the track first */
        n = eng_steps_notes((uint32_t)drums, &w);
        keep_n = (uint32_t)n;
        for (i = 0; i < n; i++)
            keep[i] = w[i];
        for (i = 0, got = 0; i < n; i++)
            if (((w[i] >> 12) & 127u) != rn)
                wk[got++] = w[i];
        (void)eng_steps_set_notes((uint32_t)drums, wk, (uint32_t)got);
        check("(the SEQ page, a Drum map, REC on, running)", page == PAGE_SEQ && seq_map() == map && seq_rec == 1u
              && eng_transport_running() && eng_steps_pos((uint32_t)drums) >= 0);
        steps_inst((uint32_t)drums)->s.stp.hit = 0;
        yield_xfers = 0;
        kq_edge(8, 1);                                      /* C#4 hit and let go during a full redraw */
        kq_edge(8, 0);
        ui_dirty = 2;
        panel_draw();
        n = eng_steps_notes((uint32_t)drums, &w);
        for (i = 0, got = 0; i < n; i++)
            got += ((w[i] >> 12) & 127u) == rn;
        check("a black key's hit during a redraw: heard and recorded on its row, nothing drawn from inside",
              seq_row == 3u && steps_inst((uint32_t)drums)->s.stp.hit && got == 1 && kq_r == kq_w && yield_xfers == 0u);
        check("its header_draw waited for the redraw's end", !ui_yielding && !ui_header_due);
        steps_inst((uint32_t)drums)->s.stp.hit = 0;
        kq_edge(3, 1);                                      /* G#3 (row 2) hit and let go within one pass */
        kq_edge(3, 0);
        keys_poll_q(0);
        check("a hit pressed and let go within one pass: heard, its row picked", seq_row == 1u && steps_inst((uint32_t)drums)->s.stp.hit);
        panel_yield = 0;
        tap(BTN_REC);
        tap(BTN_PLAY);
        (void)eng_steps_set_notes((uint32_t)drums, keep, keep_n);
        seq_sync(drums);
        tap(BTN_SEQ);
        later(1500);
        check("(REC off, stopped, the device page)", seq_rec == 0u && !eng_transport_running() && page == 0u);
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
        (void)load("909 KIT");
        cur_preset = N_PRESETS - 2u;                        /* the 909 Kit, then the Groove Box, the last factory patch */
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        later(2000);
        preset_loads = 1;
        enc(6, 1);
        for (i = y0 * 240u; i < y1 * 240u; i++)
            ink += fb[i] == P_INK;
        check("PRESET: the next patch, its name over the bars", cur_preset == N_PRESETS - 1u && !strcmp(patch_label, "GROOVE BOX")
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
        enc(0, 1);                                          /* SELECT while it shows: the device card instead */
        check("SELECT during it: the device card takes over", fm1_ms >= pg_patch_until && pages_carding()
              && px(4, 4) == P_CARD_DEV);
        later(1100);
        preset_loads = 0;
    }

    {                                                       /* #200: the editor's Live, its patch over the FM-1's budget (paused) */
        uint32_t slot = cur_preset;
        int stepped = presets_stepped;
        page = 0;
        trail_n = 0;
        screen_idle();
        later(2000);
        preset_loads = 1;
        msg_text[0] = 0;                                    /* (a marker: a new message fills it) */
        m1_live(1);                                         /* LIVE paused: the FM-1 says so at once */
        check("LIVE paused: EDITOR PATCH TOO BIG at once", !strcmp(msg_text, "EDITOR PATCH TOO BIG"));
        later(3000);
        msg_text[0] = 0;                                    /* (a marker: a new message fills it) */
        m1_live(1);                                         /* every 2 s again: no new toast */
        check("LIVE paused again: no new message", msg_text[0] == 0);
        enc(6, 1);
        check("PRESET under a paused Live: no slot change, EDITOR PATCH TOO BIG", cur_preset == slot
              && presets_stepped == stepped && !strcmp(msg_text, "EDITOR PATCH TOO BIG"));
        later(1600);
        msg_text[0] = 0;                                    /* (a marker: a new message fills it) */
        m1_live(0);                                         /* the patch fits again: Live resumes */
        check("LIVE resumed: no message of its own", msg_text[0] == 0);
        enc(6, -1);
        check("PRESET under Live (resumed): still held, EDITOR LIVE: NO PRESET", cur_preset == slot
              && presets_stepped == stepped && !strcmp(msg_text, "EDITOR LIVE: NO PRESET"));
        later(1600);
        m1_live(1);                                         /* over the budget once more: says so again */
        check("LIVE paused after a resume: the message again", !strcmp(msg_text, "EDITOR PATCH TOO BIG"));
        later(LIVE_HOLD_MS + 100u);                          /* no LIVE for 5 s (a closed tab): PRESET is free */
        enc(6, 1);
        check("Live lapsed: PRESET steps again", presets_stepped == stepped + 1 && cur_preset != slot);
        preset_loads = 0;
    }

    printf("%s\n", failed ? "panel test FAILED" : "panel test passed");
    return failed != 0;
}
