/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The panel core (firmware/src/panel.c) on the host, with no HAL: SELECT, ALGO, K1, HOME (tap, legend, held = menu),
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

    tap(BTN_HOME);
    check("HOME: back to the first device", page == 0 && pg_cur_dev == 0 && pg_cur_page == 0 && focus_dev == 0);
    memcpy(before, fb, sizeof before);
    tap(BTN_HOME);
    check("HOME again: the legend", page == PAGE_LEGEND && memcmp(before, fb, sizeof before) != 0);
    tap(BTN_HOME);
    later(1000);                                            /* (the first tap changed device: its toast ends) */
    check("HOME on the legend: the device page", page == 0 && px(12, ROWS_Y + 15) == KNOB_HUE[0]);

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
        uint8_t tab = menu_tab;
        enc(1, 1);                                          /* ALGO: the next tab */
        check("ALGO in the menu: the next tab", menu_tab != tab);
    }
    tap(BTN_HOME);
    check("HOME tapped: the menu closes", page == 0);

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
            if (page == PAGE_MENU || page == PAGE_SEQ || page == PAGE_LEGEND)   /* (SEQ opened its page, HOME the legend: back) */
                tap(B[i].id == 13u ? 11u : B[i].id);
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

    panel_keys(1u << 7);                                    /* a key: a note, sent out */
    check("a key plays a note (MIDI out asked)", (key_sounding & (1u << 7)) && midi_out > 0);
    panel_keys(0);
    check("its release ends it", !(key_sounding & (1u << 7)));

    printf("%s\n", failed ? "panel test FAILED" : "panel test passed");
    return failed != 0;
}
