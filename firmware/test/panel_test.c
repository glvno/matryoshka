/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The panel core (firmware/src/panel.c) on the host, with no HAL: SELECT, ALGO, K1, HOME (the trail back, held = menu),
 * PLAY / tempo, a key and the MIDI out of every control (#115), checked on the core's state and on the LCD's framebuffer (ui_preview.c's stand-ins).
 *   tools/panel_test.sh */
#define UI_PREVIEW_LIB
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
static void preset_step(int32_t d) { presets_stepped += d; }
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
/* PANEL_SNAP=file.ppm: the LCD at the page-list step, to look at (tools/ui_preview.sh converts PPM to PNG) */
static void snap(void)
{
    const char *path = getenv("PANEL_SNAP");
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
    if (load("808 KIT")) {
        printf("FAIL  the 808 Kit loads\n");
        return 1;
    }
    booting = 0;
    page = 0;
    screen_idle();
    check("the device page: the first device in focus", page == 0 && pg_cur_dev == 0 && pg_cur_page == 0 && pg_ndev > 2);
    check("the LCD: the tab in focus is ivory, K1's bar shows its hue", px(2, 1) == P_INK && px(12, ROWS_Y + 15) == KNOB_HUE[0]);

    enc(0, 1);                                              /* SELECT */
    check("SELECT: the next device, the editor told", pg_cur_dev == 1 && pg_cur_page == 0 && focus_dev == 1 && focus_pg == 0);
    check("SELECT: the device's name over the bars", px(12, ROWS_Y + 15) == P_NIGHT);
    later(1000);
    check("the device toast ends: the bars come back", px(12, ROWS_Y + 15) == KNOB_HUE[0]);

    memcpy(before, fb, sizeof before);
    enc(1, 1);                                              /* ALGO */
    check("ALGO: the device's next page", pg_cur_dev == 1 && pg_cur_page == 1 && focus_pg == 1);
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
    later(1100);
    check("the toast ends", px(12, ROWS_Y + 15) == KNOB_HUE[0]);

    memcpy(before, fb, sizeof before);
    tap(BTN_HOME);
    check("HOME on the device pages, nothing to go back to: nothing", page == 0 && pg_cur_dev == 1 && pg_cur_page == 1
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
    tap(BTN_SEQ);
    check("SEQ from the menu: the step page, a second step", page == PAGE_SEQ && trail_n == 2);
    tap(BTN_HOME);
    check("HOME: back to the menu", page == PAGE_MENU && trail_n == 1);
    tap(BTN_HOME);
    check("HOME tapped: the menu closes, back on the page it was opened from", page == 0 && trail_n == 0 && pg_cur_dev == 1 && pg_cur_page == 1);
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
        /* SCL (button 1) a Page button: device 1 page 0, then device 1 page 1 */
        static const uint8_t sec[] = {0, 3, 0, 0, 0, 0, 0, 2, 1, 0, 1, 1};
        memcpy(pv_bin + pv_len, sec, sizeof sec);
        pv_len += sizeof sec;
        pv_bin[6] |= 64u;
        pv_gen++;
        check("a patch with a Page button loads", eng_load(pv_bin, pv_len) == 0 && eng_button_kind(1) == ENG_BTN_PAGE);
        page_show(0);
        trail_n = 0;
        pages_focus(2, 0);
        loop();
        tap(3);
        check("SCL tapped: its list's first page, a step on the trail, lit", pg_list_btn == 1 && pg_cur_dev == 1 && pg_cur_page == 0
              && trail_n == 1 && (eng_buttons_get() >> 1 & 1u) && focus_dev == 1);
        later(2000);                                        /* (a message from before ends) */
        check("the top bar names the list", px(120, 2) == P_SEA);
        snap();
        tap(3);
        check("SCL again: the next page", pg_list_step == 1 && pg_cur_dev == 1 && pg_cur_page == 1 && trail_n == 1);
        tap(3);
        check("... round the list", pg_list_step == 0 && pg_cur_dev == 1 && pg_cur_page == 0);
        enc(1, 1);
        check("ALGO inside the list: its next step", pg_list_step == 1 && pg_cur_dev == 1 && pg_cur_page == 1);
        panel_held |= 1u << 3;                              /* held: the first page while it is down */
        panel_edges(1u << 3, 0);
        later(500);
        check("SCL held: the list's first page", pg_list_peek && pg_cur_dev == 1 && pg_cur_page == 0);
        panel_held &= ~(1u << 3);
        panel_edges(0, 1u << 3);
        loop();
        check("let go: back to the step it was on", !pg_list_peek && pg_list_step == 1 && pg_cur_dev == 1 && pg_cur_page == 1);
        tap(BTN_HOME);
        check("HOME: back to where it was before the list, unlit", pg_list_btn < 0 && pg_cur_dev == 2 && pg_cur_page == 0
              && trail_n == 0 && !(eng_buttons_get() >> 1 & 1u));
        tap(3);
        enc(0, 1);
        check("SELECT inside the list leaves it", pg_list_btn < 0 && !(eng_buttons_get() >> 1 & 1u));
        trail_n = 0;
    }

    panel_keys(1u << 7);                                    /* a key: a note, sent out */
    check("a key plays a note (MIDI out asked)", (key_sounding & (1u << 7)) && midi_out > 0);
    panel_keys(0);
    check("its release ends it", !(key_sounding & (1u << 7)));

    printf("%s\n", failed ? "panel test FAILED" : "panel test passed");
    return failed != 0;
}
