/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The panel core (firmware/src/panel.c) on the host, with no HAL: SELECT, ALGO, K1, HOME (the trail back), GLO (the menu),
 * PLAY / tempo, a key and the MIDI out of every control (#115), checked on the core's state and on the LCD's framebuffer (ui_preview.c's stand-ins).
 *   tools/panel_test.sh */
#define UI_PREVIEW_LIB
#define CTL_GESTURES                                        /* (controls.h: the rows' gestures, controls_test.h) */
#define FB_WATCH
#define HOST_PANEL_FIXTURES
#include "ui_preview.c"

/* what panel.c asks of proto.c and audio.c */
static volatile uint32_t eng_shed_count;
static int focus_dev = -1, focus_pg = -1, param_now = 0;
static void m1_focus_now(uint32_t d, uint32_t g) { focus_dev = (int)d; focus_pg = (int)g; }
static uint32_t preset_events, preset_record;
static struct { uint32_t mod, par; int32_t value; } preset_event[512];
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v)
{
    param_now++;
    if (preset_record && preset_events < 512u) {
        preset_event[preset_events].mod = mod;
        preset_event[preset_events].par = par;
        preset_event[preset_events++].value = v;
    }
}
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v);   /* (below: into pv_bin, as proto.c's into m1_cur) */
static void m1_panel_on(uint32_t mask) { (void)mask; }
static void m1_patch_bypass(uint32_t mod, int on);
/* KEYS_NOW (#549): each key edge panel_key took, with the keys and buttons held then (report_test.h) */
#define M1_KEYS_NOW
#define PANEL_ALIGN
static uint32_t kr_key[64], kr_keys[64], kr_held[64];
static int kr_down[64], kr_n;
static uint32_t keys_now;
static void m1_keys_now(uint32_t n, int down)
{
    if (kr_n >= 64)
        kr_n = 0;
    kr_key[kr_n] = n;
    kr_down[kr_n] = down;
    kr_keys[kr_n] = keys_now;
    kr_held[kr_n] = panel_held;
    kr_n++;
}
#include "../src/pal_ui.c"                          /* the palette's keys and overview (#1196): pal_request, pal_save below */
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
static void midi_send_play(uint32_t b, uint32_t spp)   /* (Song Position before a Continue: F2, its two bytes) */
{
    if (b == 0xFBu)
        mlog_add(0xF2u, spp & 127u, spp >> 7 & 127u);
    mlog_add(b, 0xFFu, 0xFFu);
}
/* the log since `from` holds this message */
static int sent(int from, uint32_t s, uint32_t a, uint32_t b)
{
    int i;
    for (i = from; i < mlen; i++)
        if (mlog[i][0] == s && mlog[i][1] == a && mlog[i][2] == b)
            return 1;
    return 0;
}
static int info_told;                               /* proto.c's INFO, unasked (live.c: MIDI OUT changed) */
static void m1_info(void) { info_told++; }
#include "../src/live.c"                            /* the editor's Live (#185) and sandbox mode: main.c's, as on the device */
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
static int settings_stored;                         /* the settings record written alone (HOME + SAVE on the quick start) */
static void settings_store(void) { settings_stored++; }
/* palette.c's switch and save (#1196): counted, the position kept (pal_panel_test.h) */
static int pal_requests, pal_saves;
static uint32_t pal_req_pos = PAL_NONE, pal_save_pos = PAL_NONE;
static uint32_t pal_request(uint32_t pos, uint32_t *aux)
{
    pal_requests++;
    pal_req_pos = pos;
    if (aux)
        *aux = 1u;
    return 0;
}
static void pal_save(uint32_t pos)
{
    pal_saves++;
    pal_save_pos = pos;
}
#include "../src/poly_edit.h"
/* a set of modules as one number, its first 64, and back (#721: most patches here have fewer; the ones past 63: mset_*) */
static uint64_t m64(eng_mset_t s) { return (uint64_t)s.w[1] << 32 | s.w[0]; }
static eng_mset_t s64(uint64_t v) { eng_mset_t s = mset_none(); s.w[0] = (uint32_t)v; s.w[1] = (uint32_t)(v >> 32); return s; }
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v)
{
    return poly_patch_set(pv_bin, pv_len, mod, field, v, eng_load);
}
/* a row's value into the running binary, as proto.c's m1_patch_param does on the FM-1: a poly row's reload (above) then
 * keeps the rows a preset set before it (#448: Cassia 1's voices row comes after some of its rows) */
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v)
{
    uint32_t at = eng_records_at(pv_bin, pv_len), i;
    if (!at || mod >= pv_bin[2])
        return;
    for (i = 0; i < mod; i++) {
        if (!eng_rec_ok(pv_bin, pv_len, at))
            return;
        at += eng_rec_size(pv_bin, at);
    }
    if (!eng_rec_ok(pv_bin, pv_len, at) || DEF_FIXED(pv_bin[at] & 0x7Fu, par))   /* (a parameter appended after the binary's
                                                     * format: eng_rec_grow raises the binary, or refuses) */
        return;
    if (par >= eng_rec_npar(pv_bin, at)) {
        if (pv_bin[1] < ENG_COUNTED || eng_rec_grow(pv_bin, &pv_len, sizeof pv_bin, mod, par + 1u))
            return;
        for (at = eng_records_at(pv_bin, pv_len), i = 0; i < mod; i++)   /* (a raise to SLIM's layout moved the record) */
            at += eng_rec_size(pv_bin, at);
    }
    if (eng_b_keep(pv_bin, &pv_len, sizeof pv_bin, mod, par))
        return;
    at += eng_rec_head(pv_bin[1]) + 4u * par;
    pv_bin[at] = (uint8_t)v;
    pv_bin[at + 1u] = (uint8_t)(v >> 8);
    pv_bin[at + 2u] = (uint8_t)(v >> 16);
    pv_bin[at + 3u] = (uint8_t)((uint32_t)v >> 24);
}
static void m1_patch_bypass(uint32_t mod, int on)
{
    uint32_t at = eng_records_at(pv_bin, pv_len), i;
    if (!at || mod >= pv_bin[2])
        return;
    for (i = 0; i < mod; i++) {
        if (!eng_rec_ok(pv_bin, pv_len, at))
            return;
        at += eng_rec_size(pv_bin, at);
    }
    if (!eng_rec_ok(pv_bin, pv_len, at))
        return;
    pv_bin[at] = (uint8_t)(on ? pv_bin[at] | 0x80u : pv_bin[at] & 0x7Fu);
    m1_edited = 1;
}

#define ROWS_Y (LK_HH + 4u)                            /* the device page's first bar */
#define K1_TAB px(BAR_X + LK_VP + 1u, row_y(0) + row_h() / 2u)   /* K1's accent tab (the page drawn last: its bars) */
#define BPX(x, y) px(BATT_FX + (x), BATT_FY + (y))      /* the footer's battery */
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
/* HOME held + PRESET (#395): the next / previous patch; HOME's release then goes nowhere */
static void patch_enc(int32_t clicks)
{
    panel_held |= 1u << BTN_HOME;
    panel_edges(1u << BTN_HOME, 0);
    enc(6, clicks);
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);                     /* (no loop after it: the release draws nothing) */
}
static void later(uint32_t ms)
{
    fm1_ms += ms;
    loop();
}
static uint16_t px(uint32_t x, uint32_t y) { return fb[y * 240u + x]; }
/* #368: a black key on a drum track's page sounds through the track (eng_steps_thru): its note into the track's keys
 * since the thru ring stood at `from` (thru_head) */
static int thru_heard(uint16_t from, uint32_t mod, uint32_t note)
{
    uint16_t h;
    for (h = from; h != thru_head; h++)
        if (thru_ring[h % ENG_THRU][0] == mod && thru_ring[h % ENG_THRU][1] == (note | 0x80u))
            return 1;
    return 0;
}
static uint16_t th;                          /* (where the thru ring stood before a key) */
static void blocks(uint32_t n)
{
    static int32_t bl[128], br[128];
    while (n--)
        eng_render(bl, br, 128);
}
/* the screen as text (screen_text.h, the device test mode's SCREEN, #291) holds a text containing s */
static int on_screen(const char *s)
{
    uint32_t i;
    for (i = 0; i < SCR_N; i++)
        if (scr_text[i].w && strstr(scr_text[i].s, s))
            return 1;
    return 0;
}
/* a pixel of colour c in the text line from row y (14 rows) */
static int fb_has_hue(uint32_t y, uint16_t c)
{
    uint32_t i;
    for (i = y * 240u; i < (y + 14u) * 240u && i < 240u * 240u; i++)
        if (fb[i] == c)
            return 1;
    return 0;
}
/* a pixel of colour c anywhere on the screen */
static int fb_has(uint16_t c)
{
    uint32_t i;
    for (i = 0; i < 240u * 240u; i++)
        if (fb[i] == c)
            return 1;
    return 0;
}
/* pages_waiting's stand-in (#298): lcd_px at each place a staged draw may give way, and its answer */
static uint32_t stop_px[16], stop_n;
static int stop_answer;
static int stop_probe(void)
{
    if (stop_n < 16u)
        stop_px[stop_n] = lcd_px;
    stop_n++;
    return stop_answer;
}
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
/* the pixels a full redraw now changes (0: the screen is what it would draw whole; else something stale was left on it,
 * #1222); the screen is then the full redraw's */
static uint32_t fb_stale(void)
{
    static uint16_t was[240 * 240];
    uint32_t i, n = 0;
    memcpy(was, fb, sizeof was);
    ui_full = 1;
    panel_draw();
    for (i = 0; i < 240u * 240u; i++)
        n += was[i] != fb[i];
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
    static uint16_t was[240 * LK_HH];
    int same;
    memcpy(was, fb, sizeof was);
    bar_text(s, bg);
    same = !memcmp(was, fb, sizeof was);
    memcpy(fb, was, sizeof was);
    return same;
}
/* the SEQ bar of a piano roll: pre, the pitches it shows (C3-G3, D-809), post */
static int bar_roll(const char *pre, const char *post, uint16_t bg)
{
    char b[48], *q;
    q = seq_note_name(put(seq_note_name(put(put(b, pre), " "), seq_roll_lo), "-"), seq_roll_lo + 7u);
    put(put(q, " "), post)[0] = 0;
    return bar_shows(b, bg);
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

static int load_at(uint32_t p);
/* the slot of the factory patch of this name (N_PRESETS: none) */
static uint32_t preset_at(const char *name)
{
    uint32_t p;
    for (p = 0; p < N_PRESETS && strcmp(PRESET_LIST[p].name, name); p++)
        ;
    return p;
}
static int load(const char *name)
{
    return load_at(preset_at(name));
}
/* An encoded test patch in the same buffer used by the panel reload path. */
static int load_fixture(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    pv_len = (uint32_t)fread(pv_bin, 1, sizeof pv_bin, f);
    fclose(f);
    return eng_load(pv_bin, pv_len);
}

/* the factory patch p (0..N_PRESETS-1) running */
static int load_at(uint32_t p)
{
    if (p >= N_PRESETS)
        return -1;
    if (lz_unpack(PRESET_LIST[p].lz, PRESET_LIST[p].lz_len, pv_bin, sizeof pv_bin) != (int32_t)PRESET_LIST[p].len)
        return -1;
    pv_len = PRESET_LIST[p].len;
    if (eng_load(pv_bin, pv_len))
        return -1;
    m1_pat_load();                                      /* (no links: the last patch's are gone, #901) */
    patch_label = PRESET_LIST[p].name;
    {
        static int32_t l[128], r[128];
        eng_render(l, r, 128);
    }
    return 0;
}

/* the roll (#241) on the LCD as the track holds it: a note's first step ivory (an accent coral), the steps it goes on
 * through dim, the rest empty (a C row tinted, a beat's first lighter, the step playing grey), past the length nothing */
static int roll_shows(int mod)
{
    const uint32_t *w;
    int nn = eng_steps_notes((uint32_t)mod, &w), i, pos = eng_steps_pos((uint32_t)mod), ok = 1;
    uint32_t row, st;
    for (row = 0; row < 8u; row++)
        for (st = 0; st < 16u; st++) {
            uint32_t k = seq_pg * 16u + st, p = seq_grid_note(-1, row), hw = eng_steps_note((uint32_t)mod, k, p), tie = 0;
            uint16_t want;
            for (i = 0; i < nn; i++)
                tie |= ((w[i] >> 12) & 127u) == p && eng_note_through(w[i], k, (uint32_t)seq_len(mod));
            if ((int32_t)k >= seq_len(mod))
                want = C_BG;
            else if (hw)
                want = ((hw >> 19) & 127u) == ACCENT_VEL ? C_ACC : C_FG;
            else if (tie)
                want = C_DIM;
            else if ((int)k == pos)
                want = C_HINT;
            else
                want = p % 12u ? ((st & 3u) ? C_TRACK : C_BEAT) : ((st & 3u) ? C_CROW : C_CBEAT);
            if (px(seq_grid_x(st) + 5u, GRID_Y + GRID_RH * row + GRID_CH - 1u) != want) {
                printf("      (roll: row %u (%u) step %u: %#06x, not %#06x)\n", (unsigned)row, (unsigned)p, (unsigned)k,
                       px(seq_grid_x(st) + 5u, GRID_Y + GRID_RH * row + GRID_CH - 1u), want);
                ok = 0;
            }
        }
    return ok;
}

/* the roll's markers on the LCD (#241): a dim triangle over a step with a note sounding above the window, under one with
 * a note below, else the background */
static int marks_ok(int mod)
{
    const uint32_t *w;
    int nn = eng_steps_notes((uint32_t)mod, &w), i, ok = 1;
    uint32_t st, lo = seq_roll_lo;
    for (st = 0; st < 16u; st++) {
        uint32_t k = seq_pg * 16u + st, up = 0, dn = 0;
        for (i = 0; i < nn && (int32_t)k < seq_len(mod); i++)
            if ((w[i] & 63u) <= k && k <= (w[i] & 63u) + ((w[i] >> 6) & 63u)) {
                up |= ((w[i] >> 12) & 127u) > lo + 7u;
                dn |= ((w[i] >> 12) & 127u) < lo;
            }
        if (px(seq_grid_x(st) + 5u, MARK_UP_Y + 2u) != (up ? C_DIM : C_BG) || px(seq_grid_x(st) + 5u, MARK_DN_Y) != (dn ? C_DIM : C_BG)) {
            printf("      (markers: step %u: up %u down %u not drawn so)\n", (unsigned)k, (unsigned)up, (unsigned)dn);
            ok = 0;
        }
    }
    return ok;
}

#include "help_test.h"                              /* #450: OCT on release, the controls sheet, the quick start */
#include "nudge_test.h"                             /* #450: the nudges (D-249), ENV in the menu */
#include "steprec_test.h"                           /* #532: step record on the SEQ page */
/* Page-button fixture insertion walks forward, like the format readers: later optional sections stay intact. */
static uint32_t panel_buttons_at(void)
{
    uint32_t at = eng_cables_end(pv_bin, pv_len);
    if (pv_bin[6] & 4u) at += pv_bin[2];
    if (pv_bin[6] & 8u) at = eng_routes_end(pv_bin, pv_len, at);
    at = eng_steps_end(pv_bin, pv_len, at);
    if (pv_bin[6] & 32u) at = eng_devices_end(pv_bin, pv_len, at);
    if (pv_bin[7] & ENG_FLAG_EXTRAS) at = eng_extras_end(pv_bin, pv_len, at);
    return at;
}
#include "controls_test.h"                          /* #553: every row of the controls table driven, its effect checked */
#include "plock_test.h"                             /* #1213: P-lock paging shows the device's real pages until release */
#include "report_test.h"                            /* #549: KEYS_NOW, GUIDE_NOW, panel_align */
#include "pal_panel_test.h"                         /* #1196: the palette's keys, its overview, the bar's NEXT: */
#include "held_load_test.h"                         /* #1339: a button or key held through a patch load lets go of it there */

/* the notes the groups a Harmonizer plays sound now, low to high (#598) */
static const char *harm_notes(int h)
{
    static char out[64];
    uint8_t on[128] = {0};
    uint32_t g, v, k;
    char *q = out;
    for (g = 1; g <= E.ngrp; g++)
        if (E.grp[g].src == (uint32_t)h + 1u)
            for (v = 0; v < E.grp[g].parts; v++)
                if (E.pv[E.grp[g].pv0 + v].on)
                    on[E.pv[E.grp[g].pv0 + v].note & 127u] = 1;
    for (k = 0; k < 128u; k++)
        if (on[k])
            q += sprintf(q, q == out ? "%u" : " %u", (unsigned)k);
    *q = 0;
    return out;
}

/* a format-55..65 master FX bus patch frozen in legacy_fx_fixtures.h (D-1010; no encoder writes one any more) */
#include "legacy_fx_fixtures.h"
static int load_legacy(const char *name)
{
    uint32_t i;
    for (i = 0; i < sizeof LEGACY_FX / sizeof LEGACY_FX[0]; i++)
        if (!strcmp(LEGACY_FX[i].name, name)) {
            memcpy(pv_bin, LEGACY_FX[i].bin, LEGACY_FX[i].len);
            pv_len = LEGACY_FX[i].len;
            return eng_load(pv_bin, pv_len);
        }
    return -1;
}
/* a fixture running (load_fixture, else load_legacy for a name without a path), on its home page */
static int fx_fixture(const char *name)
{
    ct_reset();
    if (strchr(name, '/') ? load_fixture(name) : load_legacy(name))
        return 0;
    pv_gen++;
    page_show(0);
    screen_patch();
    pages_ensure();
    pages_focus(pages_home(), 0);
    eng_arm_mask(mset_none());
    later(2000);
    return 1;
}
/* the pg device of rack effect e */
static uint32_t fx_dev(uint32_t e) { return pages_dev_of(eng_fx_device(e)); }

/* The FX drawer on the FM-1 (1.26.3, #1214): its effects are devices right after their instrument, FX goes to the first
 * page of the first effect of the drawer of the instrument on show (else of the armed one, else of the Output drawer),
 * else NO FX IN THE RACK; a Toggle on a drawer switches its effects as eng_fx_set does (tails, engine.c) */
static void fx_suite(void)
{
    uint32_t home, first, i, e, flags, at, ok;
    check("FX drawer fixture: an instrument with three effects in its drawer", ct_fx_load() && eng_rack_owner(0) != ENG_RACK_OUTPUT
          && eng_rack_len(0) == 3u);
    if (eng_fx_count() != 3u)
        return;
    home = pg_cur_dev;
    first = eng_rack_first(0);
    check("FX drawer: the drawer is the instrument's on show", eng_rack_owner(0) == pg_dev[home].bin);
    for (ok = 1, i = 0; i < 3u; i++)
        ok = ok && fx_dev(first + i) == home + 1u + i;
    check("FX drawer: its effects are the devices right after the instrument, in chain order", ok);
    check("FX drawer: FX glows, unlit off the effects", (panel_used() & 1u) && !(panel_lights() & 1u));
    tap(2);
    check("FX goes to the first effect's first page, lit", page == 0u && pg_cur_dev == fx_dev(first) && pg_cur_page == 0u
          && (panel_lights() & 1u) && help_state() == HS_DEVICE);
    {
        uint32_t sum = ct_params();
        enc(2, 1);
        later(50);
        if (ct_params() == sum) {
            enc(2, -1);
            later(50);
        }
        check("FX: K1 edits the effect's page", ct_params() != sum);
    }
    for (ok = 1, i = 1; i < 3u; i++) {
        enc(0, 1);
        ok = ok && pg_cur_dev == fx_dev(first + i) && pg_cur_page == 0u && (panel_lights() & 1u);
    }
    check("SELECT walks the effects in chain order", ok);
    tap(2);
    check("FX on an effect: the first effect of its drawer", page == 0u && pg_cur_dev == fx_dev(first));
    tap(2);
    check("FX again goes back where FX came from", page == 0u && pg_cur_dev == fx_dev(first + 2u));
    pages_focus(home, 0);
    trail_n = 0;
    tap(2);
    tap(BTN_HOME);
    check("HOME leaves the effect for the instrument", page == 0u && pg_cur_dev == home && !(panel_lights() & 1u));
    tap(BTN_ENV);
    tap(2);
    check("FX from the environment: the effect's device page", page == 0u && pg_cur_dev == fx_dev(first));
    tap(2);
    check("  FX again: back to the environment", page == PAGE_ENV && pg_cur_dev == home);
    tap(BTN_HOME);
    check("  HOME leaves the environment", page == 0u);
    {   /* the drawer's on/off: a Toggle on the drawer (LFO in the fixture) switches every effect through eng_fx_set */
        const uint8_t *t;
        uint32_t k, n;
        check("the fixture's LFO is a Toggle on the drawer", eng_button_kind(3u) == ENG_BTN_TOGGLE);
        for (ok = 1, e = first; e < first + 3u; e++)
            ok = ok && eng_fx_on(e);
        check("  every effect on at load", ok);
        tap(5);
        for (ok = 1, e = first; e < first + 3u; e++) {
            ok = ok && !eng_fx_on(e);
            for (n = eng_fx_targets(e, &t), k = 0; k < n; k++)
                ok = ok && eng_bypass(t[k]);
        }
        check("  the Toggle turns every effect off (its targets bypassed: eng_fx_set's tails)", ok);
        tap(5);
        for (ok = 1, e = first; e < first + 3u; e++)
            ok = ok && eng_fx_on(e);
        check("  and on again", ok);
    }
    page_set(PAGE_SEQ);
    tap(2);
    check("SEQ: FX keeps its job there", page == PAGE_SEQ);
    song_prep();
    page_set(PAGE_SONG);
    tap(2);
    check("SONG: FX keeps its job there", page == PAGE_SONG);

    /* the instrument on show has no drawer: the armed one's, else the Output drawer's */
    check("FX layers fixture: two instruments, the second with a drawer, and an Output drawer",
          fx_fixture("build/panel-fixtures/fx-layers.m1p") && eng_rack_count() == 2u);
    if (eng_rack_count() == 2u) {
        uint32_t out = eng_rack_owner(0) == ENG_RACK_OUTPUT ? 0u : 1u, mine = 1u - out, other;
        home = pg_cur_dev;
        other = pages_dev_of(eng_rack_owner(mine));
        check("  the first instrument owns no drawer", eng_rack_owner(0) != pg_dev[home].bin && eng_rack_owner(1) != pg_dev[home].bin);
        tap(2);
        check("  nothing armed: FX goes to the Output drawer's first effect", page == 0u && pg_cur_dev == fx_dev(eng_rack_first(out)));
        tap(2);
        check("  FX again: back", pg_cur_dev == home);
        pages_focus(other, 0);
        dev_arm(0);
        pages_focus(home, 0);
        trail_n = 0;
        tap(2);
        check("  the second instrument armed: its drawer's first effect", pg_cur_dev == fx_dev(eng_rack_first(mine)));
        eng_arm_mask(mset_none());
    }
    check("FX empty fixture: an instrument with an empty drawer", fx_fixture("build/panel-fixtures/fx-empty.m1p")
          && eng_rack_count() == 1u && !eng_rack_len(0));
    home = pg_cur_dev;
    tap(2);
    check("  FX: NO FX IN THE RACK, the page as it was", page == 0u && pg_cur_dev == home && !strcmp(msg_text, MSG_NO_FX)
          && (panel_used() & 1u));
    later(2000);
    check("a patch with no rack and FX set to Nothing", fx_fixture("build/panel-fixtures/fx-none.m1p")
          && !eng_fx_count() && !eng_rack_count() && eng_button_kind(0) == ENG_BTN_NOTHING && !panel_btn_job(0));
    home = pg_cur_dev;
    tap(2);
    check("  FX: NO FX IN THE RACK (no nudge), the light as the patch has it", page == 0u && pg_cur_dev == home
          && !strcmp(msg_text, MSG_NO_FX) && panel_lights() == eng_buttons_lit());
    later(2000);
    check("a patch with no rack and FX a Toggle", fx_fixture("build/panel-fixtures/fx-own.m1p") && !eng_fx_count()
          && eng_button_kind(0) == ENG_BTN_TOGGLE);
    {
        uint32_t was = eng_buttons_get() & 1u;
        tap(2);
        check("  FX keeps its own job (its Toggle switched), no FX message", (eng_buttons_get() & 1u) != was
              && strcmp(msg_text, MSG_NO_FX));
    }

    /* formats 55..65: the master FX bus loads as one Output drawer on the bus device; FX goes to its first stage's page */
    check("legacy bus: four stages in one Output drawer", fx_fixture("fx-bus") && eng_fx_count() == 4u && eng_rack_count() == 1u
          && eng_rack_owner(0) == ENG_RACK_OUTPUT);
    check("legacy bus: Harmony starts disabled with LFO dark", !(panel_lights() & 8u));
    tap(5);
    check("legacy bus: LFO enables Harmony and lights enabled state", (panel_lights() & 8u) && !(eng_buttons_get() & 8u));
    tap(5);
    check("legacy bus: LFO disables Harmony without changing its legacy Toggle state", !(panel_lights() & 8u) && (eng_buttons_get() & 8u));
    if (eng_fx_count() == 4u) {
        const uint8_t *t;
        uint32_t d = fx_dev(0), k, g, n = eng_fx_targets(0, &t);
        tap(2);
        g = pg_cur_page;
        for (ok = 0, k = 0; pg_cur_dev == d && k < pages_now()->nrows; k++)
            for (i = 0; i < n; i++)
                ok |= pages_now()->mod[k] == t[i];
        check("  FX: the bus device, on the page that shows the first stage", page == 0u && pg_cur_dev == d && ok
              && (panel_lights() & 1u));
        enc(1, 1);
        check("  its other pages stay ordinary device pages", pg_cur_dev == d && pg_cur_page != g);
        tap(BTN_HOME);
        tap(BTN_HOME);
    }
    {   /* the shipped factory patches with a master bus: every stage off at load, FX on the bus device */
        static const struct { const char *name; uint32_t n; uint8_t kind[4]; } RACK[] = {
            {"factory-rack-hera-6", 3u, {ENG_FX_DRIVE, ENG_FX_DELAY, ENG_FX_REVERB}},
            {"factory-rack-808-kit", 2u, {ENG_FX_DRIVE, ENG_FX_REVERB}},
        };
        for (i = 0; i < sizeof RACK / sizeof RACK[0]; i++) {
            uint32_t k;
            check("legacy factory rack patch loads", fx_fixture(RACK[i].name));
            ok = eng_fx_count() == RACK[i].n;
            for (k = 0; ok && k < RACK[i].n; k++)
                ok = eng_fx_kind(k) == RACK[i].kind[k] && !eng_fx_on(k) && eng_fx_device(k) == eng_fx_device(0);
            check("  its stages in order on the bus device, every one off at load", ok);
            tap(2);
            check("  FX goes to the bus device", page == 0u && pg_cur_dev == fx_dev(0));
        }
    }

    /* The legacy bus reader (engine.c eng_skip_fx, eng_rack_end) on the real record: every truncation and an overlap */
    check("legacy bus fixture reloads", fx_fixture("fx-bus"));
    flags = (uint32_t)pv_bin[6] | (uint32_t)pv_bin[7] << 8;
    at = panel_buttons_at();
    if (pv_bin[6] & 64u) at = eng_buttons_end(pv_bin, pv_len, at);
    if (pv_bin[6] & 128u) at = eng_names_end(pv_bin, pv_len, at);
    if (pv_bin[7] & ENG_FLAG_ORIGINS) at = eng_origins_end(pv_bin, pv_len, at);
    {
        const uint8_t *end = eng_skip_fx(pv_bin + at, pv_bin + pv_len, (uint16_t)flags);
        check("legacy reader locates the full optional record", at && end && pv_bin[at] == 4u
              && eng_rack_end(pv_bin, pv_len, at) == (uint32_t)(end - pv_bin));
        if (at && end) {
            for (i = at; pv_bin + i < end; i++)
                check("legacy reader rejects truncated metadata", !eng_skip_fx(pv_bin + at, pv_bin + i, (uint16_t)flags));
            {
                uint32_t target = at + 5u;
                uint8_t saved_target = pv_bin[target + 1u];
                pv_bin[target + 1u] = pv_bin[target];
                check("legacy reader rejects duplicate targets", !eng_skip_fx(pv_bin + at, pv_bin + pv_len, (uint16_t)flags));
                pv_bin[target + 1u] = saved_target;
            }
            {   /* a sparse bus (Chorus and Reverb only): FX goes to the Chorus stage's page */
                uint8_t sparse[1u + ENG_FX_STAGE_COUNT * (4u + ENG_FX_TARGETS_MAX)];
                uint32_t src = at + 1u, dst = 1u, bytes = (uint32_t)(end - pv_bin - at);
                sparse[0] = 0;
                while (src < at + bytes) {
                    uint32_t n = 4u + pv_bin[src + 3u];
                    if (pv_bin[src] == ENG_FX_CHORUS || pv_bin[src] == ENG_FX_REVERB) {
                        memcpy(sparse + dst, pv_bin + src, n);
                        dst += n;
                        sparse[0]++;
                    }
                    src += n;
                }
                memmove(pv_bin + at + dst, pv_bin + at + bytes, pv_len - at - bytes);
                memcpy(pv_bin + at, sparse, dst);
                pv_len -= bytes - dst;
                check("sparse bus loads actual kinds rather than row-index types", !eng_load(pv_bin, pv_len) && eng_fx_count() == 2u &&
                      eng_fx_kind(0) == ENG_FX_CHORUS && eng_fx_kind(1) == ENG_FX_REVERB);
                pv_gen++;
                page_show(0);
                pages_ensure();
                pages_focus(pages_home(), 0);
                trail_n = 0;
                tap(2);
                check("sparse bus: FX goes to the Chorus stage's page", page == 0u && pg_cur_dev == fx_dev(0)
                      && pg_cur_page == fx_first_page(fx_dev(0), 0));
                tap(BTN_HOME);
            }
        }
    }
    /* Optional FX bindings are not authority for a separately verified Harmony Toggle. */
    check("Harmony-only indicator fixture resets", fx_fixture("fx-bus"));
    {
        const uint8_t *end = eng_skip_fx(pv_bin + at, pv_bin + pv_len, (uint16_t)((uint32_t)pv_bin[6] | (uint32_t)pv_bin[7] << 8));
        check("Harmony-only fixture has a bounded optional FX record", end != 0);
        if (end) {
            uint32_t bytes = (uint32_t)(end - pv_bin - at);
            memmove(pv_bin + at, end, pv_len - (uint32_t)(end - pv_bin));
            pv_len -= bytes;
            pv_bin[7] &= (uint8_t)~64u;
            check("format55 loads without an FX record", !eng_load(pv_bin, pv_len) && !eng_fx_count() && !eng_rack_count());
            pv_gen++;
            page_show(0);
            check("rackless Harmony starts off with LFO dark", !(panel_lights() & 8u));
            tap(5);
            check("rackless LFO enables Harmony and its light", (panel_lights() & 8u) && !(eng_buttons_get() & 8u));
            pv_bin[1] = 54u;
            check("older format keeps the same valid Toggle graph", !eng_load(pv_bin, pv_len));
            pv_gen++;
            page_show(0);
            check("older Harmony Toggle retains its generic light state", panel_lights() == eng_buttons_lit());
            tap(5);
            check("older Harmony Toggle light follows bypass after switching", panel_lights() == eng_buttons_lit() && !((panel_lights() ^ eng_buttons_get()) & 8u));
        }
    }
    ct_reset();
}

/* #1323: what the device page's header shows of the effect in focus: 1 off (NAME OFF, dim: no ivory in the device's
 * section), 0 on (the name alone, in ivory), -1 neither */
static int head_fx_shown(void)
{
    uint32_t x, y, x1 = (uint32_t)hd_drawn.xd >> 4, ink = 0, dim = 0, n = str_len(hd_drawn.a);
    int off = n > 4u && !strcmp(hd_drawn.a + n - 4u, MSG_OFF);
    for (y = 0; y < LK_HH; y++)
        for (x = 0; x < x1; x++) {
            ink += px(x, y) == P_INK;
            dim += px(x, y) == P_DIM;
        }
    return ink && !dim && !off ? 0 : !ink && dim && off ? 1 : -1;
}
#include "fx_preset_panel_test.h"

/* D-947 (the owner, 2026-11-25: "should be SEL, shouldn't it?", "1. yes"): SEL on an FX drawer effect's device page
 * switches that effect as the editor's on/off button does (eng_fx_set's tails, the running binary's bypass bits, PARAM_NOW
 * 0xFF), the bar says NAME ON / NAME OFF; Toggles follow; SEL on an instrument still arms it */
static uint32_t fx_sel_render(uint32_t n, uint64_t *energy)   /* (n blocks: a hash of the output, its energy added) */
{
    static int32_t l[128], r[128];
    uint32_t h = 0x811c9dc5u, i;
    while (n--) {
        eng_render(l, r, 128);
        for (i = 0; i < 128u; i++) {
            h = ct_fnv(ct_fnv(h, (uint32_t)l[i]), (uint32_t)r[i]);
            *energy += (uint64_t)((int64_t)l[i] * l[i] >> 16) + (uint64_t)((int64_t)r[i] * r[i] >> 16);
        }
    }
    return h;
}
/* the fx-drawer fixture's effect e of its drawer playing a held note, then switched off by SEL (sel) or as the editor's
 * BYPASS command does it (eng_set_bypass on its targets): the output after the switch (hash), its energy then and later */
static uint32_t fx_sel_tail(uint32_t e, int sel, uint64_t *soon, uint64_t *late)
{
    const uint8_t *t;
    uint32_t k, n, h;
    *soon = *late = 0;
    if (!ct_fx_load())
        return 0;
    e += eng_rack_first(0);
    pages_focus(fx_dev(e), 0);
    later(100);
    eng_note_on(60, ENG_ONE, 1);
    blocks(60);
    eng_note_off(60, 1);
    if (sel)
        tap(BTN_SEL);
    else
        for (n = eng_fx_targets(e, &t), k = 0; k < n; k++)
            eng_set_bypass(t[k], 1);
    h = fx_sel_render(40, soon);
    (void)fx_sel_render(1200, late);
    return eng_fx_on(e) ? 0 : h;
}
static void fx_sel_suite(void)
{
    const uint8_t *t;
    uint32_t home, first, e, k, n, ok, d, i;
    char want[40];
    check("SEL on effects: the FX drawer fixture", ct_fx_load() && eng_fx_count() == 3u);
    if (eng_fx_count() != 3u)
        return;
    home = pg_cur_dev;
    first = eng_rack_first(0);
    for (ok = 1, e = first; e < first + 3u; e++)
        ok = ok && eng_fx_on(e);
    check("  every effect on at load", ok);
    pages_focus(fx_dev(first), 0);
    later(100);
    d = pg_cur_dev;
    check("  an effect's page: the sheet lists SEL as its switch, not as arming", hc_fx_effect() && !hc_dev_keys());
    check("  #1323: its header shows it on (the name in ivory)", head_fx_shown() == 0);
    param_now = 0;
    preset_record = 1;
    preset_events = 0;
    m1_edited = 0;
    tap(BTN_SEL);
    preset_record = 0;
    caps(want, pg_dev[d].name, pg_dev[d].nlen, 16);
    strcat(want, MSG_OFF);
    for (ok = !eng_fx_on(first), n = eng_fx_targets(first, &t), k = 0; k < n; k++)
        ok = ok && eng_bypass(t[k]) && fx_preset_event(t[k], 0xFFu, 65536);
    check("  SEL switches the effect off: its targets bypassed, the editor told (PARAM_NOW 0xFF)", ok && n > 0u);
    check("  the others stay on", eng_fx_on(first + 1u) && eng_fx_on(first + 2u));
    check("  the bar says NAME OFF (the page header's name)", !strcmp(msg_text, want) && str_len(want) <= 26u);
    check("  the page stays, nothing armed", page == 0u && pg_cur_dev == d && !m64(eng_arm_mask_get()));
    check("  the running patch is edited (SAVE keeps it)", m1_edited != 0);
    later(2000);
    check("  #1323: the header shows it off once the bar's message goes (NAME OFF, dim)", head_fx_shown() == 1);
    {   /* #1323: names too long for the header together: the effect's name gives up letters, OFF stays */
        head_t h;
        const char *nm = pg_dev[d].name;
        uint8_t nl = pg_dev[d].nlen;
        pg_dev[d].name = "WIDEST WOMBAT MW";
        pg_dev[d].nlen = 16;
        head_layout(&h);
        n = str_len(h.a);
        check("  #1323: a name too long for the header loses letters, OFF stays",
              n > 4u && n < 20u && !strcmp(h.a + n - 4u, MSG_OFF) && !strncmp(h.a, "WIDEST", 6));
        pg_dev[d].name = nm;
        pg_dev[d].nlen = nl;
    }
    tap(BTN_SEL);
    caps(want, pg_dev[d].name, pg_dev[d].nlen, 16);
    strcat(want, MSG_ON);
    for (ok = eng_fx_on(first), n = eng_fx_targets(first, &t), k = 0; k < n; k++)
        ok = ok && !eng_bypass(t[k]);
    check("  SEL again: on, NAME ON", ok && !strcmp(msg_text, want));
    later(2000);
    check("  #1323: the header shows it on again", head_fx_shown() == 0);
    tap(BTN_SEL);
    {   /* SAVE keeps it: the running binary (pv_bin, proto.c's m1_cur) loads with the effect off, the others on */
        check("  the running binary reloads with it off", !eng_load(pv_bin, pv_len) && !eng_fx_on(first)
              && eng_fx_on(first + 1u) && eng_fx_on(first + 2u));
        pv_gen++;
        pages_ensure();
        pages_focus(d, 0);
        later(100);
        later(2000);
        check("  #1323: reloaded off, its page's header says so", head_fx_shown() == 1);
    }
    /* the drawer's Toggle (LFO) follows: on while every effect is off */
    check("  the drawer's Toggle stays off while an effect plays", !(eng_buttons_get() & 8u));
    for (e = first + 1u; e < first + 3u; e++) {
        pages_focus(fx_dev(e), 0);
        tap(BTN_SEL);
    }
    check("  every effect off by SEL: the drawer's Toggle on and lit", !eng_fx_on(first + 1u) && !eng_fx_on(first + 2u)
          && (eng_buttons_get() & 8u) && (panel_lights() & 8u));
    tap(BTN_SEL);
    check("  one back on by SEL: the Toggle off", eng_fx_on(first + 2u) && !(eng_buttons_get() & 8u) && !(panel_lights() & 8u));
    tap(5);
    check("  the Toggle switches them all off, SEL's effect too", !eng_fx_on(first + 2u) && (eng_buttons_get() & 8u));
    later(2000);
    check("  #1323: the page's header follows the Toggle: off", head_fx_shown() == 1);
    tap(5);
    for (ok = 1, e = first; e < first + 3u; e++)
        ok = ok && eng_fx_on(e);
    check("  and on again: SEL's state follows", ok);
    later(2000);
    check("  #1323: and the header: on", head_fx_shown() == 0);
    for (n = eng_fx_targets(first + 2u, &t), k = 0; k < n; k++)   /* (the editor's on/off button: C_BYPASS, nothing else told) */
        eng_set_bypass(t[k], 1);
    later(100);
    check("  #1323: the editor's on/off button switches it off: the header follows", !eng_fx_on(first + 2u) && head_fx_shown() == 1);
    for (k = 0; k < n; k++)
        eng_set_bypass(t[k], 0);
    later(100);
    check("  #1323: and on: the header follows", eng_fx_on(first + 2u) && head_fx_shown() == 0);
    later(2000);
    pages_focus(home, 0);
    eng_arm_mask(mset_none());
    later(100);
    tap(BTN_SEL);
    check("SEL on the instrument still arms it", env_armed(home) && eng_fx_on(first));
    eng_arm_mask(mset_none());
    tap(BTN_ENV);
    for (i = 0; i < 8u && pg_cur_dev != fx_dev(first); i++)
        enc(0, 1);
    tap(BTN_SEL);
    check("SEL on the environment's effect row: as before, no switch", page == PAGE_ENV && eng_fx_on(first));
    tap(BTN_HOME);
    later(2000);
    {   /* the tail: SEL rings out exactly as the editor's bypass does (the same output), sound after the switch */
        uint64_t s1, l1, s2, l2;
        uint32_t a, b;
        for (ok = 1, e = 0; e < 3u; e++) {
            a = fx_sel_tail(e, 1, &s1, &l1);
            b = fx_sel_tail(e, 0, &s2, &l2);
            ok = ok && a && a == b && s1 == s2 && l1 == l2 && s1 > 0u;
        }
        check("  SEL off rings out as the editor's bypass does (each effect: the same output, sound after it)", ok);
    }
    /* formats 55..65: the bus device's page of a stage switches that stage */
    if (fx_fixture("fx-bus") && eng_fx_count() == 4u) {
        uint32_t was = eng_fx_on(0);
        tap(2);
        tap(BTN_SEL);
        check("legacy bus: SEL on the first stage's page switches that stage", eng_fx_on(0) != was);
        tap(BTN_SEL);
        check("  and back", eng_fx_on(0) == was);
    } else
        check("legacy bus fixture loads", 0);
    /* the factory 909 Kit (the owner's check): its drawer's Drive and Reverb each switch by SEL and back */
    if (ct_load_factory("909 KIT") == 0 && eng_rack_count()) {
        for (ok = 1, e = 0; e < eng_fx_count(); e++) {
            uint32_t was = eng_fx_on(e);
            if (pages_dev_of(eng_fx_device(e)) >= pg_ndev || fx_drawer_at(eng_fx_device(e)) == UINT32_MAX)
                continue;
            pages_focus(pages_dev_of(eng_fx_device(e)), 0);
            later(100);
            tap(BTN_SEL);
            ok = ok && eng_fx_on(e) != was && page == 0u;
            tap(BTN_SEL);
            ok = ok && eng_fx_on(e) == was;
            later(2000);
        }
        check("the factory 909 Kit: SEL switches each drawer effect and back", ok && eng_fx_count() >= 2u);
    } else
        check("the factory 909 Kit loads with an FX rack", 0);
    ct_reset();
}

/* #1312 (the owner, 2026-11-25: "S2: SEL switches canvas effects"), D-947 amended: SEL on the page of an effect on the
 * canvas that takes no keys switches it. A single effect module by its bypass (the bar DELAY OFF, the editor told,
 * SAVE keeps it), an effect card from a drawer as a drawer effect; a card of effect modules the rack lists not says
 * SWITCH IT WITH A TOGGLE and switches nothing; a card with another module among its own is an ordinary device */
static uint32_t fxc_dev(int type, int single)     /* (the pg device of a module of that type: its own, else a member) */
{
    uint32_t d, k;
    for (d = 0; d < pg_ndev; d++) {
        if (single && pg_dev[d].module >= 0 && eng_type((uint32_t)pg_dev[d].module) == type)
            return d;
        for (k = 0; !single && pg_dev[d].module < 0 && k < pg_dev[d].nmem; k++)
            if (eng_type(pg_mem(d, k)) == type)
                return d;
    }
    return pg_ndev;
}
static uint32_t fxc_bypassed(void)                /* (a hash of every module's bypass) */
{
    uint32_t h = 0x811c9dc5u, m;
    for (m = 0; m < ENG_MAX_MODULES; m++)
        h = ct_fnv(h, (uint32_t)eng_bypass(m));
    return h;
}
static void fx_canvas_suite(void)
{
    const uint8_t *t;
    uint32_t home, d, k, n, ok, was, h;
    int m;
    char want[40];
    if (!fx_fixture("build/panel-fixtures/fx-canvas.m1p")) {
        check("SEL on canvas effects: the fx-canvas fixture loads", 0);
        return;
    }
    home = pg_cur_dev;
    d = fxc_dev(T_DELAY, 1);
    check("SEL on canvas effects: the fixture's Delay module, Reverb card (the rack's one effect, in no drawer), Overdrive and Auto pan",
          d < pg_ndev && fxc_dev(T_REVERB, 0) < pg_ndev && fxc_dev(T_DYN, 0) < pg_ndev && fxc_dev(T_PAN, 0) < pg_ndev
          && eng_fx_count() == 1u && fx_drawer_at(eng_fx_device(0)) == UINT32_MAX);
    if (d >= pg_ndev || eng_fx_count() != 1u)
        return;
    m = pg_dev[d].module;
    pages_focus(d, 0);
    later(100);
    check("  a Delay module's page: the sheet lists SEL as its switch, not as arming", hc_fx_effect() && !hc_dev_keys());
    param_now = 0;
    preset_record = 1;
    preset_events = 0;
    m1_edited = 0;
    tap(BTN_SEL);
    preset_record = 0;
    caps(want, pg_dev[d].name, pg_dev[d].nlen, 16);
    strcat(want, MSG_OFF);
    check("  SEL bypasses it, the editor told (PARAM_NOW 0xFF), the bar says DELAY OFF",
          eng_bypass((uint32_t)m) && fx_preset_event((uint32_t)m, 0xFFu, 65536) && !strcmp(msg_text, want));
    check("  the page stays, nothing armed, the running patch edited (SAVE keeps it)",
          page == 0u && pg_cur_dev == d && !m64(eng_arm_mask_get()) && m1_edited != 0);
    check("  the running binary reloads with it bypassed", !eng_load(pv_bin, pv_len) && eng_bypass((uint32_t)m));
    pv_gen++;
    pages_ensure();
    pages_focus(d, 0);
    later(2000);
    check("  #1323: reloaded bypassed, the Delay's header shows it off", head_fx_shown() == 1);
    tap(BTN_SEL);
    caps(want, pg_dev[d].name, pg_dev[d].nlen, 16);
    strcat(want, MSG_ON);
    check("  SEL again: it plays, DELAY ON", !eng_bypass((uint32_t)m) && !strcmp(msg_text, want));
    later(2000);
    check("  #1323: SEL on: the header shows it on", head_fx_shown() == 0);
    d = fxc_dev(T_REVERB, 0);
    pages_focus(d, 0);
    later(100);
    was = (uint32_t)eng_fx_on(0);
    check("  the Reverb card's page (a rack effect on the canvas): SEL is its switch", hc_fx_effect() && !hc_dev_keys());
    tap(BTN_SEL);
    for (ok = (uint32_t)eng_fx_on(0) != was, n = eng_fx_targets(0, &t), k = 0; k < n; k++)
        ok = ok && (uint32_t)eng_bypass(t[k]) == was;
    caps(want, pg_dev[d].name, pg_dev[d].nlen, 16);
    strcat(want, was ? MSG_OFF : MSG_ON);
    check("  SEL switches it as a drawer effect: its targets follow, the bar says REVERB OFF", ok && n > 0u && !strcmp(msg_text, want));
    later(2000);
    check("  #1323: the Reverb card's header follows SEL", head_fx_shown() == (int)was);
    tap(BTN_SEL);
    check("  and back", (uint32_t)eng_fx_on(0) == was);
    later(2000);
    pages_focus(fxc_dev(T_DYN, 0), 0);
    later(100);
    h = fxc_bypassed();
    tap(BTN_SEL);
    check("  Overdrive (effect modules, no rack targets): SWITCH IT WITH A TOGGLE, nothing switched, nothing armed",
          !strcmp(msg_text, MSG_FX_TOGGLE_ONLY) && fxc_bypassed() == h && !m64(eng_arm_mask_get()) && page == 0u);
    later(2000);
    {   /* #1323: a card of effect modules (a Toggle switches it) shows off while every one of them is bypassed */
        uint32_t od = fxc_dev(T_DYN, 0);
        check("  #1323: Overdrive's header shows it on", head_fx_shown() == 0);
        for (k = 0; k < pg_dev[od].nmem; k++)
            eng_set_bypass(pg_mem(od, k), 1);
        later(100);
        check("  #1323: its modules bypassed (its Toggle): the header shows it off", head_fx_shown() == 1);
        for (k = 0; k < pg_dev[od].nmem; k++)
            eng_set_bypass(pg_mem(od, k), 0);
        later(100);
        check("  #1323: and on", head_fx_shown() == 0);
    }
    pages_focus(fxc_dev(T_PAN, 0), 0);
    later(100);
    tap(BTN_SEL);
    check("  Auto pan (an LFO among its modules): an ordinary device, NOTHING HERE TAKES KEYS",
          !hc_fx_effect() && !strcmp(msg_text, MSG_NOTHING_TAKES_KEYS) && fxc_bypassed() == h);
    later(2000);
    pages_focus(home, 0);
    later(100);
    tap(BTN_SEL);
    check("SEL on the canvas effects' instrument still arms it", env_armed(home));
    ct_reset();
}

/* D-520, the banks (the owner, 2026-11-19; 11 keys 2026-11-27): a drum track's rows are one list, the rows of every Drum
 * map it plays; black keys 1..11 play 11 of them from the bank's first (rows 8b + 1 ..), OCT picks the bank on a device
 * page when the keys reach more than 11 (the footer ROWS 1-11 .. in the octave's place, a nudge naming the rows). The SEQ
 * page's grid shows 8 (D-521): SEL + OCT picks them, a black key or SELECT past them shows the bank holding the row */
static const uint32_t BLACK_N[11] = {1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25};   /* black keys 1..11 at octave 0 (F#3 G#3 A#3 C#4 ...) */
/* black key b (0..10) pressed and let go: the note it sent on MIDI out, -1 none */
static int black_sends(uint32_t b)
{
    int from = mlen, i, got = -1;
    panel_keys(1u << BLACK_N[b]);
    panel_keys(0);
    for (i = from; i < mlen && got < 0; i++)
        if (mlog[i][0] == 0x90u)
            got = mlog[i][1];
    return got;
}
static int blacks_send(const int *want)
{
    uint32_t b;
    int ok = 1;
    for (b = 0; b < 11u; b++)
        ok &= black_sends(b) == want[b];
    return ok;
}
static void drum_open(const char *name)
{
    page = 0;
    trail_n = 0;
    octave = 0;
    mlen = 0;                                               /* (the MIDI log from here: it holds 256) */
    drum_bank = seq_view = 0;
    (void)load(name);
    pv_gen++;
    page_show(0);
    screen_patch();
    pages_ensure();
    pages_focus(pages_home(), 0);
    later(2000);
}
static int foot_reads(const char *s)
{
    foot_t f;
    (void)foot_layout(&f);
    return !strcmp(f.o, s);
}
static void sel_oct(uint32_t oct)                       /* SEL held + OCT- / OCT+ */
{
    panel_held |= 1u << BTN_SEL;
    panel_edges(1u << BTN_SEL, 0);
    loop();
    tap(oct);
    panel_held &= ~(1u << BTN_SEL);
    panel_edges(0, 1u << BTN_SEL);
    loop();
}
/* the first track into a Drum map, -1 none */
static int drum_track(void)
{
    int t;
    for (t = 0; t < eng_steps_count(); t++)
        if (eng_steps_drummap((uint32_t)eng_steps_module((uint32_t)t)) >= 0)
            return t;
    return -1;
}
/* a patch loaded as every load path does it (a program change, a palette switch, the editor's upload or Live commit, a
 * borrowed slot's return, the factory reset: each one is proto.c m1_set_current, which counts it in pages_gen) */
static void load_as_device(const char *name)
{
    (void)load(name);
    pv_gen++;
    page_show(0);
    screen_patch();
    later(500);
}
static void drum_bank_suite(void)
{
    static const int K909[3][11] = {{53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71}, {67, 69, 71, 72, 54, 56, 63, 68, 66, -1, -1},
                                    {66, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1}};
    static const int K808[2][11] = {{53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71}, {67, 69, 71, 72, -1, -1, -1, -1, -1, -1, -1}};
    uint8_t rm[ENG_DRUM_LIST], rr[ENG_DRUM_LIST];
    char nm[16];
    int drums, map, t;
    uint32_t w, n;
    cfg.midi_out = 1;
    drum_open("909 KIT");
    check("909 Kit (D-520 banks): its keys reach 17 drum rows, its three Drum maps' as one list", eng_keys_rows(rm, rr) == 17u);
    check("  black keys 1..11 play KICK .. RIDE (rows 1-11), the footer reads ROWS 1-11", blacks_send(K909[0]) && foot_reads(MSG_ROWS "1-11"));
    tap(BTN_OCT_UP);
    check("  OCT+: ROWS 9-17, the nudge names its first rows, the octave stays", drum_bank == 1u && octave == 0
          && !strcmp(msg_text, MSG_ROWS "9-17: MID TOM CRASH..") && str_len(msg_text) <= 26u && foot_reads(MSG_ROWS "9-17"));
    check("  black keys 1..9 play MID TOM .. HT FLAM (rows 9-17, MIDI out: each row's own note), 10 and 11 nothing", blacks_send(K909[1]));
    loop();                                                 /* (black keys 10 and 11 silent: DRUMS: BLACK KEYS 1-9 first) */
    tap(BTN_OCT_UP);
    check("  OCT+ again: ROWS 17, HT FLAM on black key 1, the others silent", drum_bank == 2u && !strcmp(msg_text, MSG_ROWS "17: HT FLAM")
          && foot_reads(MSG_ROWS "17") && blacks_send(K909[2]));
    tap(BTN_OCT_UP);
    check("  OCT+ at the last bank: it stays", drum_bank == 2u && octave == 0);
    tap(BTN_OCT_DOWN);
    tap(BTN_OCT_DOWN);
    check("  OCT- twice: ROWS 1-11 again", drum_bank == 0u && foot_reads(MSG_ROWS "1-11") && blacks_send(K909[0]));

    seq_select(0);                                          /* the SEQ page on DRUMS: the grid shows 8 rows */
    tap(BTN_SEQ);
    drums = eng_steps_module(0);
    map = seq_map();
    seq_row_name(map, 1, nm);
    check("909 Kit's SEQ page: the grid's rows 1-8 (SNARE second), the footer ROWS 1-8", page == PAGE_SEQ && map >= 0 && !strcmp(nm, "SNARE")
          && foot_reads(MSG_ROWS "1-8"));
    tap(BTN_OCT_UP);
    check("  OCT+ alone pages the steps as before (one page: ALL STEPS SHOWN), the bank stays", drum_bank == 0u && page == PAGE_SEQ);
    panel_keys(1u << BLACK_N[9]);                           /* black key 10: row 10, CRASH, past the rows shown */
    w = seq_thru_note[BLACK_N[9]];
    panel_keys(0);
    loop();
    seq_row_name(seq_map(), seq_row, nm);
    check("  black key 10: CRASH picked and heard, the grid jumps to ROWS 9-16 (D-521), the keys' bank stays", seq_rl_first() == 8u
          && seq_row == 1 && !strcmp(nm, "CRASH") && on_screen("CRASH") && foot_reads(MSG_ROWS "9-16") && drum_bank == 0u
          && seq_row_note(seq_map(), seq_row) == 69u && w == 69u + 1u);
    w = eng_steps_note((uint32_t)drums, 1, 69);
    panel_keys(1u << 2);                                    /* G3: step 2 */
    panel_keys(0);
    loop();
    check("  a white key switches CRASH's hit on the step", (eng_steps_note((uint32_t)drums, 1, 69) != 0) != (w != 0));
    panel_keys(1u << 2);
    panel_keys(0);
    loop();
    panel_keys(1u << BLACK_N[1]);                           /* black key 2: SNARE, back on the first rows */
    panel_keys(0);
    loop();
    check("  black key 2: SNARE, the grid back on ROWS 1-8", seq_rl_first() == 0u && seq_row == 1 && foot_reads(MSG_ROWS "1-8"));
    enc(0, 6);                                              /* SELECT: row 8 */
    check("  SELECT to row 8: the grid stays", seq_rl_first() == 0u && seq_row == 7);
    th = thru_head;
    enc(0, 1);                                              /* past it: row 9 (option a, the owner 2026-11-27) */
    seq_row_name(seq_map(), seq_row, nm);
    check("  SELECT past row 8: row 9, MID TOM, the grid on ROWS 9-16, nothing sounds", seq_rl_first() == 8u && seq_row == 0
          && !strcmp(nm, "MID TOM") && on_screen("MID TOM") && foot_reads(MSG_ROWS "9-16") && thru_head == th);
    enc(0, 20);
    check("  SELECT on: row 17, the last (clamped), ROWS 17", seq_rl_first() == 16u && seq_row == 0 && foot_reads(MSG_ROWS "17"));
    enc(0, -9);
    check("  SELECT back past row 9: row 8, the grid on ROWS 1-8", seq_rl_first() == 0u && seq_row == 7);
    enc(0, -7);
    sel_oct(BTN_OCT_UP);
    seq_row_name(seq_map(), 1, nm);
    check("  SEL + OCT+: the grid shows ROWS 9-16 by name, the keys from row 9, SEL's release does not open SONG", drum_bank == 1u
          && page == PAGE_SEQ && !strcmp(nm, "CRASH") && on_screen("CRASH") && foot_reads(MSG_ROWS "9-16"));
    panel_keys(1u << BLACK_N[1]);                           /* black key 2: CRASH */
    panel_keys(0);
    check("  black key 2 picks CRASH (note 69), the row the white keys write", seq_row == 1 && seq_row_note(seq_map(), seq_row) == 69u);
    panel_keys(1u << BLACK_N[8]);                           /* black key 9: row 17, HT FLAM */
    panel_keys(0);
    loop();
    seq_row_name(seq_map(), seq_row, nm);
    check("  black key 9: HT FLAM, row 17, the grid on its bank", seq_rl_first() == 16u && seq_row == 0 && !strcmp(nm, "HT FLAM"));
    sel_oct(BTN_OCT_UP);
    check("  SEL + OCT+ from there: the last bank stays, the keys' bank 2", drum_bank == 2u && seq_rl_first() == 16u
          && (seq_row_name(seq_map(), 1, nm), nm[0] == 0));
    panel_keys(1u << BLACK_N[3]);                           /* black key 4: no row in this bank */
    panel_keys(0);
    check("  a black key past the list's rows picks nothing", seq_row == 0 && seq_rl_first() == 16u);
    sel_oct(BTN_OCT_DOWN);
    sel_oct(BTN_OCT_DOWN);
    check("  SEL + OCT- twice: ROWS 1-8", drum_bank == 0u && seq_rl_first() == 0u);
    tap(BTN_HOME);

    drum_open("VERONA DRUM 1");
    n = eng_keys_rows(rm, rr);
    check("Verona Drum 1: its keys reach 10 rows, no banks (the octave footer)", n == 10u && foot_reads(MSG_FOOT_OCT));
    check("  black keys 9 and 10 play rows 9 and 10 (HH1, HH2), black key 11 nothing",
          black_sends(8) == eng_drummap_note(rm[8], rr[8]) && black_sends(9) == eng_drummap_note(rm[9], rr[9])
          && black_sends(10) == (eng_drummap_repeat((uint32_t)eng_keys_drummap()) ? 53 + 25 : -1));
    tap(BTN_OCT_UP);
    check("  OCT+ shifts the octave (11 keys reach every row: no bank to pick)", octave == 1 && drum_bank == 0u
          && black_sends(9) == eng_drummap_note(rm[9], rr[9]));
    tap(BTN_OCT_DOWN);
    t = drum_track();
    check("  (Verona Drum 1 has a drum track)", t >= 0);
    if (t >= 0) {
        seq_select((uint32_t)t);
        tap(BTN_SEQ);
        drums = eng_steps_module((uint32_t)t);
        panel_keys(1u << BLACK_N[9]);                       /* black key 10: row 10 */
        w = seq_thru_note[BLACK_N[9]];
        panel_keys(0);
        loop();
        check("  its SEQ page: black key 10 picks and sounds row 10, the grid on ROWS 9-10", page == PAGE_SEQ && seq_rl_first() == 8u
              && seq_row == 1 && foot_reads(MSG_ROWS "9-10") && drums >= 0 && w == (uint32_t)eng_drummap_note(rm[9], rr[9]) + 1u);
        sel_oct(BTN_OCT_DOWN);
        check("  SEL + OCT-: ROWS 1-8, black key 10 still row 10", seq_rl_first() == 0u && drum_key_row(seq_rl_n, 9) == 9);
        tap(BTN_HOME);
    }

    drum_open("808 KIT");
    check("808 Kit: 12 rows, BD .. HT/HC on black keys 1..11", eng_keys_rows(rm, rr) == 12u && blacks_send(K808[0]) && foot_reads(MSG_ROWS "1-11"));
    {                                                       /* (1.23 qualification: a condition past bit 15 holds here, OCT picks
                                                             * the bank; main.c guide_poll compared GUIDE_NOW byte 14, which a
                                                             * pass without the conditions reads as 0, so it sent one on every
                                                             * pass and the link to the editor filled) */
        uint8_t told[GUIDE_BYTES], now[GUIDE_BYTES];
        guide_state(told, 1);
        guide_state(now, 0);
        check("  GUIDE_NOW: OCT picks the bank (condition 16, byte 14), and a pass with nothing new sees no change",
              (told[14] >> (HC_OCT_BANKS - 16) & 1u) && !guide_changed(now, told));
        now[12] ^= 1u;
        check("  a change outside the conditions (the octave byte) is still seen", guide_changed(now, told));
    }
    tap(BTN_OCT_UP);
    check("  OCT+: MT/MC HT/HC CY AC on black keys 1..4, the rest silent", drum_bank == 1u && blacks_send(K808[1])
          && !strcmp(msg_text, MSG_ROWS "9-12: MT/MC HT/HC..") && foot_reads(MSG_ROWS "9-12"));
    {                                                       /* the global pad map (#1067): learn mode, a drum key, a pad */
        uint32_t told = host_pads_told;
        int bd, ac;
        tap(BTN_OCT_DOWN);
        (void)eng_keys_rows(rm, rr);
        bd = eng_drummap_note(rm[0], rr[0]);
        ac = eng_drummap_note(rm[11], rr[11]);
        pad_defaults();
        gt_due = 0;
        learn_mode(1);
        check("pad map: learn mode on a kit says LEARN: KNOB OR DRUM KEY", learn_live() == 1 && !strcmp(msg_text, MSG_LEARN_KIT));
        panel_keys(1u << BLACK_N[0]);
        panel_keys(0);
        check("  black key 1 picks row 1 for a pad (and still plays): 1 BD: HIT A PAD", learn_live() == 3 && ml.mod == 0u
              && !strcmp(msg_text, "1 BD" MSG_PAD_HIT) && black_sends(0) == bd);
        check("  a pad's note 36: row 1's pad, it plays BD, NOTE C2 > 1 BD, row 2 waits, the editor told, kept without SAVE",
              pad_learn(36, 100, 1) && pad_note[0] == 36u && pad_sound[0] == bd + 1 && !strcmp(msg_text, "NOTE C2 > 1 BD") && learn_live() == 3
              && ml.mod == 1u && host_pads_told == told + 1u && gt_due);
        check("  its note-off ends what it started", pad_midi(36, 0, 1) && !pad_sound[0]);
        later(PAD_SHOW_MS + 100u);
        map_poll();
        check("  a second later the bar asks for row 2: 2 SD: HIT A PAD", !strcmp(msg_text, "2 SD" MSG_PAD_HIT));
        check("  the same pad again moves to row 2 (one row per pad)", pad_learn(36, 90, 1) && pad_note[1] == 36u && pad_note[0] == PAD_NONE);
        pad_midi(36, 0, 1);
        tap(BTN_OCT_UP);
        panel_keys(1u << BLACK_N[3]);
        panel_keys(0);
        check("  OCT+ and black key 4: row 12, AC", learn_live() == 3 && ml.mod == 11u && !strcmp(msg_text, "12 AC" MSG_PAD_HIT));
        check("  the last row learned: learn mode ends, PADS: 2 LEARNED", pad_learn(49, 100, 1) && pad_note[11] == 49u && !learn_live()
              && !strcmp(msg_text, MSG_PADS "2" MSG_PADS_LEARNED));
        pad_midi(49, 0, 1);
        check("pad map: a pad plays its row's note in any learn state, an unmapped note plays as itself", pad_midi(49, 100, 1)
              && pad_sound[11] == ac + 1 && !pad_midi(50, 100, 1));
        pad_midi(49, 0, 1);
        pad_on = 0;
        check("  PAD MAP OFF: the pad's note plays as itself", !pad_midi(49, 100, 1));
        pad_on = 1;
        sb_on = 1;
        check("  sandbox mode: the pads play their own notes", !pad_midi(49, 100, 1));
        sb_on = 0;
        learn_mode(1);
        panel_keys(1u << BLACK_N[0]);
        panel_keys(0);
        tap(BTN_HOME);
        check("  a HOME tap while a row waits, nothing hit: LEARN OFF", !learn_live() && !strcmp(msg_text, MSG_LEARN_OFF));
        pad_defaults();
        tap(BTN_OCT_UP);
    }

    drum_open("MERIDIAN 8");                                /* (drum_bank 0 again: drum_open) */
    check("a kit of 8 rows (Meridian 8): no banks, the footer = OCT =", eng_keys_rows(rm, rr) == 8u && foot_reads(MSG_FOOT_OCT));
    {                                                       /* the octave's own slot: the tempo stays put whatever the octave */
        foot_t f;
        uint32_t xt = 0, widest = 0, moved = 0;
        int32_t o;
        for (o = -3; o <= 3; o++) {
            octave = o;
            (void)foot_layout(&f);
            if (o == -3)
                xt = f.xt;
            moved += f.xt != xt;
            widest = text_w(&FONT_F, f.o, -1) > widest ? text_w(&FONT_F, f.o, -1) : widest;
        }
        octave = 0;
        check("  the footer: the tempo at the same x in every octave state, the octave's slot its widest", moved == 0u && widest == FOOT_OCT_W);
    }
    {                                                       /* a load sets the octave and the drum bank back (the owner,
                                                             * 2026-11-27, D-1456): PRESET, any other load, never an edit */
        uint32_t leds;
        drum_open("909 KIT");
        tap(BTN_OCT_UP);
        tap(BTN_OCT_UP);
        check("a load resets: the 909 Kit on ROWS 17", drum_bank == 2u && foot_reads(MSG_ROWS "17"));
        load_as_device("808 KIT");
        check("  the 808 Kit loaded: the first bank, ROWS 1-11, BD on black key 1", drum_bank == 0u && foot_reads(MSG_ROWS "1-11")
              && black_sends(0) == 53);
        load_as_device("MERIDIAN 8");
        tap(BTN_OCT_UP);
        tap(BTN_OCT_UP);
        check("  Meridian 8 (8 rows): OCT+ twice, octave +2", octave == 2 && foot_reads(MSG_FOOT_OCT_UP "++"));
        enc(3, 4);                                          /* K1: a parameter edit, as the FM-1's knob */
        {
            uint32_t mod = (uint32_t)eng_keys_drummap();
            m1_patch_param(mod, 0, eng_get_param(mod, 0));  /* and as the editor's Live sends one (PARAM: no load) */
        }
        loop();
        check("  a knob turn, a Live parameter edit: the octave stays", octave == 2);
        leds = host_oct_leds;
        load_as_device("909 KIT");
        check("  the 909 Kit loaded: octave 0, the OCT LEDs set again, ROWS 1-11", octave == 0 && host_oct_leds > leds
              && foot_reads(MSG_ROWS "1-11"));
        load_as_device("MERIDIAN 8");
        tap(BTN_OCT_DOWN);
        preset_loads = 1;
        cur_preset = preset_at("MERIDIAN 8");
        patch_enc(1);                                       /* PRESET: the next patch */
        later(500);
        preset_loads = 0;
        check("  PRESET from octave -1: the next patch at octave 0", octave == 0 && cur_preset != preset_at("MERIDIAN 8"));
        load_as_device("MERIDIAN 8");
    }
    tap(BTN_OCT_UP);
    check("  OCT+ shifts the octave as before, black key 1 still plays row 1", octave == 1 && foot_reads(MSG_FOOT_OCT_UP "+")
          && black_sends(0) == eng_drummap_note((uint32_t)eng_keys_drummap(), 0));
    octave = 0;
    drum_bank = seq_view = 0;
    mlen = 0;
    page_show(0);
}

int main(void)
{
    static uint16_t before[240 * 240];
    uint32_t mod, par;
    int32_t v0;
    {
        char num[24], unit[8];
        value_parts(&DEFS[T_LFO], LFO_P_WIDE, DEFS[T_LFO].pmin[LFO_P_WIDE], num, unit);
        check("slow LFO endpoint displays millihertz instead of zero", !strcmp(num, "0.79") && !strcmp(unit, "mHz"));
        value_parts(&DEFS[T_LFO], LFO_P_WIDE, 55 << 16, num, unit);
        check("fast LFO endpoint displays hertz", !strcmp(num, "55.0") && !strcmp(unit, "Hz"));
        /* a row of whole steps shows a whole number without decimals, as the editor's card does (2, not 2.00) */
        value_parts(&DEFS[T_OSC], OSC_P_COARSE, 2 << 16, num, unit);
        check("whole-step row: 2 st, not 2.00", !strcmp(num, "2") && !strcmp(unit, "st"));
        value_parts(&DEFS[T_OSC], OSC_P_COARSE, -12 * 65536, num, unit);
        check("whole-step row: -12 st, not -12.0", !strcmp(num, "-12"));
        value_parts(&DEFS[T_OSC], OSC_P_COARSE, 5 << 15, num, unit);
        check("whole-step row: a value typed between its steps keeps its decimals (2.50)", !strcmp(num, "2.50"));
        value_parts(&DEFS[T_LFO], LFO_P_DEPTH, 65536, num, unit);
        check("a row of fractional steps keeps its decimals (1.00)", !strcmp(num, "1.00"));
    }
    {                                                       /* #396: a bent (plog 2) cutoff at its top read as at its bottom, so the
                                                             * bar went empty at 20 kHz and the next click up landed near 20 Hz */
        uint32_t t, j, n = 0, ok = 1;
        for (t = 0; t < N_TYPES; t++) {
            const def_t *d = &DEFS[t];
            for (j = 0; j < d->npar; j++) {
                int32_t hi, u;
                if (!d->plog || d->plog[j] != 2)
                    continue;
                hi = d->pmax[j];
                u = unit_of(d, j, hi);
                n++;
                ok &= u == ENG_ONE && value_of(d, j, u) == hi && value_of(d, j, u + 655) == hi && unit_of(d, j, value_of(d, j, ENG_ONE - 655)) < ENG_ONE;
            }
        }
        printf("      (%u bent cutoff parameters)\n", (unsigned)n);
        check("a bent cutoff at its top: the knob's position is the top, a click up stays there, a click below is below", n > 0u && ok);
    }
    /* The real reload path: adding voices past the pools must leave a playable patch. */
    check("Cassia loads for voice edit", load("CASSIA 1") == 0);
    for (mod = 0; mod < (uint32_t)eng_nmodules() && !eng_module_group(mod); mod++)
        ;
    poly_row_set(mod, 0, 4);
    check("Cassia accepts four voices in memory", eng_poly_get(0, 0) == 4);
    arena_size = ENG_ARENA - arena_free();   /* (#649: the arena holds Cassia's eight voices; made as small as four take) */
    poly_row_set(mod, 0, 5);
    check("a rejected fifth voice restores the engine and patch", eng_poly_get(0, 0) == 4 && pv_bin[8] == 4);
    poly_row_set(mod, 0, 2);
    check("voices can be reduced after a rejected edit", eng_poly_get(0, 0) == 2 && pv_bin[8] == 2);
    check("no-steal row changes the engine and saved flag", poly_row_set(mod, ENG_POLY_STEAL, 0) == 0 && eng_poly_get(0, ENG_POLY_STEAL) == 0 && (pv_bin[11] & 0x80u));
    check("priority row preserves no-steal", poly_row_set(mod, ENG_POLY_PRIORITY, 2) == 0 && pv_bin[11] == 0x82u && eng_poly_get(0, ENG_POLY_PRIORITY) == 2);
    check("reset assignment reaches the engine and saved patch", poly_row_set(mod, ENG_POLY_ASSIGN, 3) == 0 && eng_poly_get(0, ENG_POLY_ASSIGN) == 3 && pv_bin[9] == 3);
    check("reload retains no-steal and reset assignment", eng_load(pv_bin, pv_len) == 0 && eng_poly_get(0, ENG_POLY_STEAL) == 0 && eng_poly_get(0, ENG_POLY_ASSIGN) == 3);
    check("turning stealing back on preserves priority", poly_row_set(mod, ENG_POLY_STEAL, 1) == 0 && pv_bin[11] == 2 && eng_poly_get(0, ENG_POLY_STEAL) == 1);
    check("unison count edits preserve poly voices", poly_row_set(mod, ENG_POLY_STACK, 1) == 0 && eng_poly_get(0, ENG_POLY_STACK) == 1 && eng_poly_get(0, ENG_POLY_PARTS) == 2 && pv_bin[8] == 0x12u);
    check("poly count edits preserve the unison count", poly_row_set(mod, ENG_POLY_PARTS, 4) == 0 && pv_bin[8] == 0x14u);
    check("rejected poly edit restores both counts", poly_row_set(mod, ENG_POLY_PARTS, 5) != 0 && pv_bin[8] == 0x14u && eng_poly_get(0, ENG_POLY_STACK) == 1 && eng_poly_get(0, ENG_POLY_PARTS) == 4);
    arena_size = ENG_ARENA;
    check("unison count survives reloading", eng_load(pv_bin, pv_len) == 0 && eng_poly_get(0, ENG_POLY_STACK) == 1);
    check("unison can use one of four voices", poly_row_set(mod, ENG_POLY_UNISON, 1) == 0 && eng_poly_get(0, ENG_POLY_UNISON) == 1);
    group_on(&E.grp[1], 60, ENG_ONE); /* Cassia receives keys through its Arpeggiator. */
    check("one unison voice sounds", E.pv[E.grp[1].pv0].on && !E.pv[E.grp[1].pv0 + 1].on);
    check("increasing unison count wakes held voices", poly_row_set(mod, ENG_POLY_STACK, 3) == 0 && E.pv[E.grp[1].pv0 + 2].on && !E.pv[E.grp[1].pv0 + 3].on);
    check("zero unison count means all", poly_row_set(mod, ENG_POLY_STACK, 0) == 0 && E.pv[E.grp[1].pv0 + 3].on);
    check("reducing unison count releases excess voices", poly_row_set(mod, ENG_POLY_STACK, 1) == 0 && !E.pv[E.grp[1].pv0 + 1].on);
    check("shared unison mode saves both flags", poly_row_set(mod, ENG_POLY_UNISON, 2) == 0 && eng_poly_get(0, ENG_POLY_UNISON) == 2 && (pv_bin[10] & 0xC0u) == 0xC0u);
    check("legato edit preserves shared unison", poly_row_set(mod, ENG_POLY_LEGATO, 2) == 0 && pv_bin[10] == 0xC2u);
    check("normal unison keeps legato and clears share", poly_row_set(mod, ENG_POLY_UNISON, 1) == 0 && pv_bin[10] == 0x82u);
    /* Group-format guards use only stable Main/Part/VCA/Output records, independent of factory players.
     * Real older records and upgrades are checked by tools/old_format.sh. */
    check("group compatibility fixture loads", load_fixture("build/panel-fixtures/unison-count-0-0.m1p") == 0);
    for (mod = 0; mod < (uint32_t)eng_nmodules() && !eng_module_group(mod); mod++)
        ;
    check("group compatibility fixture keeps the edited settings",
          poly_row_set(mod, ENG_POLY_STACK, 1) == 0 && poly_row_set(mod, ENG_POLY_ASSIGN, 3) == 0
          && poly_row_set(mod, ENG_POLY_LEGATO, 2) == 0 && poly_row_set(mod, ENG_POLY_UNISON, 1) == 0);
    pv_bin[1] = 38;
    check("format 38 cannot add shared unison", poly_row_set(mod, ENG_POLY_UNISON, 2) == -1 && pv_bin[10] == 0x82u);
    pv_bin[10] |= 0x40u;
    check("format 38 rejects shared unison flag", eng_load(pv_bin, pv_len) != 0);
    pv_bin[1] = ENG_PATCH_VERSION; pv_bin[10] = 0x42u;
    check("share flag without unison is invalid", eng_load(pv_bin, pv_len) != 0);
    pv_bin[10] = 0x82u;
    pv_bin[1] = 37;
    check("format 37 rejects the new count flag", eng_load(pv_bin, pv_len) != 0);
    pv_bin[8] &= 15u;
    check("format 37 still loads ordinary unison", eng_load(pv_bin, pv_len) == 0 && eng_poly_get(0, ENG_POLY_STACK) == 0);
    check("old-format edit cannot add unison count", poly_row_set(mod, ENG_POLY_STACK, 2) == -1 && pv_bin[8] == 4u);
    pv_bin[1] = ENG_PATCH_VERSION; pv_bin[8] = 0x94u;
    check("invalid unison count is rejected", eng_load(pv_bin, pv_len) != 0);
    pv_bin[8] = 2; pv_bin[10] = 0;
    pv_bin[1] = 36;
    check("old formats reject reset assignment", eng_load(pv_bin, pv_len) != 0);
    pv_bin[9] = 0; pv_bin[11] = 0x80u;
    check("old formats reject no-steal", eng_load(pv_bin, pv_len) != 0);
    pv_bin[11] = 0;
    check("format 36 keeps ordinary allocation", eng_load(pv_bin, pv_len) == 0 && eng_poly_get(0, ENG_POLY_STEAL) == 1);
    check("old-format edits cannot add new allocation settings", poly_row_set(mod, ENG_POLY_STEAL, 0) == -1 && poly_row_set(mod, ENG_POLY_ASSIGN, 3) == -1 && pv_bin[9] == 0 && pv_bin[11] == 0);
    {                                                   /* a VOICES row stops at what the CPU holds (format 51: the
                                                         * row's top, gen-presets voiceTops); one without a top offers 8 */
        static const char *const NAME[3] = {"CASSIA 1", "ORACLE V", "BASIC POLY"};
        static const int32_t WANT[3] = {5, 5, ENG_MAX_PARTS};
        static const char *const SAYS[3] = {"Cassia 1's VOICES row stops at five voices, a turn up there stays",
                                            "Oracle V's VOICES row stops at five voices, a turn up there stays",
                                            "Basic Poly's VOICES row (no top) reaches all eight voices"};
        uint32_t t, d, g, k;
        for (t = 0; t < 3u; t++) {
            int found = 0, ok = 0;
            check(NAME[t], load(NAME[t]) == 0);
            pages_ensure();
            for (d = 0; d < pg_ndev && !found; d++)
                for (g = pg_dev[d].pg0; g < (uint32_t)pg_dev[d].pg0 + pg_dev[d].npg && !found; g++)
                    for (k = 0; k < pg_page[g].nrows && !found; k++)
                        if (pg_page[g].par[k] == POLY_ROW) {
                            uint32_t m, par;
                            int32_t v = 0;
                            found = 1;
                            pg_cur_dev = d;
                            pg_cur_page = g - pg_dev[d].pg0;
                            ok = poly_top(&pg_page[g], k) == WANT[t] && poly_row_set(pg_page[g].mod[k], 0, WANT[t]) == 0
                                 && pages_turn(k, 1, 0, 0, &m, &par, &v) == 1 && v == WANT[t]
                                 && pages_turn(k, -1, 0, 0, &m, &par, &v) == 1 && v == WANT[t] - 1;
                        }
            printf("      (%s: VOICES top %d)\n", NAME[t], (int)WANT[t]);
            check(SAYS[t], found && ok);
        }
    }
    {                                                   /* #1202 K1: a row a cable's macro range sets does not turn; the bar
                                                         * says SET BY and the source (D-944). A factory patch whose row has
                                                         * a ranged pin, else one with a pin mapped there and a range added */
        uint32_t p, d, g, k, s, pass, rm = 0, rj = 0, rs = 0;
        int found = 0, added = 0;
        for (pass = 0; pass < 2u && !found; pass++)
            for (p = 0; p < N_PRESETS && !found; p++) {
                if (load_at(p))
                    continue;
                pages_ensure();
                for (d = 0; d < pg_ndev && !found; d++)
                    for (g = pg_dev[d].pg0; g < (uint32_t)pg_dev[d].pg0 + pg_dev[d].npg && !found; g++)
                        for (k = 0; k < pg_page[g].nrows && !found; k++) {
                            uint32_t m = pg_page[g].mod[k], j = pg_page[g].par[k], lo, hi;
                            if (m == SETTING_ROW || (j & POLY_ROW) || !row_ok(m, j) || DEF_FIXED((uint32_t)eng_type(m), j))
                                continue;
                            for (s = 0; s < 2u && !found && pass; s++)
                                if (!eng_range(m, s, j, &lo, &hi) && eng_set_range(m, s, j, 1, 40, 200)) {
                                    if (eng_set_by(m, j) >= 0)
                                        found = added = 1, rs = s;
                                    else
                                        eng_set_range(m, s, j, 0, 0, 0);
                                }
                            if (!pass && eng_set_by(m, j) >= 0)
                                found = 1;
                            if (found) {
                                pg_cur_dev = d;
                                pg_cur_page = g - pg_dev[d].pg0;
                                rm = k;
                                rj = j;
                            }
                        }
            }
        check("a factory patch has a row a ranged p1 / p2 sets (or one a range is added to)", found);
        if (found) {
            const ppage_t *pg = pages_now();
            uint32_t m = pg->mod[rm], mo, par;
            int32_t was = eng_get_param(m, rj), v = was;
            msg_text[0] = 0;
            check("  turning it: no change, the bar says SET BY and the source (26 characters at most)",
                  pages_turn(rm, 3, 0, 0, &mo, &par, &v) == -1 && eng_get_param(m, rj) == was
                  && !strncmp(msg_text, "SET BY ", 7) && msg_text[7] && str_len(msg_text) <= 26u);
            printf("      (%s, row %u%s; the bar: %s)\n", patch_label, (unsigned)rm, added ? ", a range added" : "", msg_text);
            if (added) {
                eng_set_range(m, rs, rj, 0, 0, 0);
                check("  without the range the row turns again", eng_set_by(m, rj) < 0 && pages_turn(rm, 3, 0, 0, &mo, &par, &v) == 0);
            }
        }
    }
    fm1_ms = 10000;
    host_ps_init();
    if (load("CASSIA 1") == 0) {                        /* #485: Cassia 1's 153 rows stored whole; one of 88 loads what it has */
        uint32_t d, i, n, st, nv, rows;
        int at, same = 1, kept = 1;
        static int32_t full[PS_MAXV], init[PS_MAXV], one[PS_MAXV];
        char nm[17];
        pages_ensure();
        for (d = 0; d < pg_ndev && pg_dev[d].nrows != 153u; d++)
            ;
        check("(Cassia 1's device: 153 rows)", d < pg_ndev);
        if (d < pg_ndev) {
            rows = pg_dev[d].nrows;
            (void)dp_list(d);
            n = (uint32_t)dp_entry(pr_list[1], nm);
            for (i = 0; i < n; i++)
                one[i] = pr_at[i];
            (void)dp_load(d, 1);
            dp_store(d);
            nv = dp_values(d);
            for (i = 0; i < nv; i++)
                full[i] = pr_vals[i];
            at = ps_find(pg_dev[d].structure, pg_pname[d]);
            if (at < 0 || ps_read((uint32_t)at, &st, nm, &n) || n != rows)
                same = 0;
            for (i = 0; same && i < rows; i++)
                same = ps_vbuf[i] == full[i];
            check("ENV held + SAVE on Cassia 1: all 153 rows stored, in two slots", nv == rows && same && ps_count(PS_LIVE) == 2u);
            (void)dp_load(d, 0);                        /* (Init's values, then a preset of 88 as 1.8.1 stored them) */
            nv = dp_values(d);
            for (i = 0; i < nv; i++)
                init[i] = pr_vals[i];
            check("(an 88-value preset as older firmware stored it)", ps_put(pg_dev[d].structure, "ZOLD", one, 88) == 0);
            n = dp_list(d);
            pg_cur_dev = d;
            (void)dp_entry(pr_list[n - 2u], nm);
            dp_name_set(d, nm);
            pages_ensure();
            msg_text[0] = 0;
            check("PRESET onto it: loaded", dev_preset_step(1) == 1 && !ps_name_cmp(pg_pname[d], "ZOLD") && dp_short);
            nv = dp_values(d);
            for (i = 0; i < nv; i++) {
                if (i < 88u && pr_vals[i] != full[i])     /* (as the whole preset loaded them: a row's value as it reads back) */
                    same = 0, printf("      (row %u: %d, the preset's %d)\n", i, pr_vals[i], full[i]);
                if (i >= 88u && pr_vals[i] != init[i])
                    kept = 0, printf("      (row %u: %d, Init's %d)\n", i, pr_vals[i], init[i]);
            }
            check("  its 88 rows set in order, all remaining rows keep their values", same && kept);
            check("  the bar: STORED SHORT: SEE EDITOR (24 characters)", !strcmp(msg_text, MSG_STORED_SHORT));
            later(1500);
        }
        host_ps_init();
        host_preset_stored = 0;
        m1_edited = 0;                                  /* (the preset names went into the running patch) */
    } else
        check("Cassia 1 loads for the preset store", 0);
    if (load("808 KIT")) {
        printf("FAIL  the 808 Kit loads\n");
        return 1;
    }
    booting = 0;
    pv_gen++;                                               /* (another patch: its home device, not the focus Cassia 1 left) */
    page = 0;
    screen_idle();
    /* the 808 Kit's devices (#196): Main, the 808 kit card with DRUMS and its Drum maps inside (no Drum map or track pages,
     * D-1059, #1202 K2), Output */
    check("the device page: the home device in focus (not Main)", page == 0 && pg_cur_dev == 1 && pg_cur_page == 0 && pg_ndev == 3);
    {                                                       /* the header (the owner's design, 2026-10-24) */
        uint32_t x, gold = 0;
        for (x = 0; x < 120u; x++)
            gold += px(x, LK_HH - 6u) == P_GOLD;
        check("the LCD: the header's dash of the device in focus gold, its name; K1's tab in its hue", gold >= 2u
              && on_screen("808 KIT") && K1_TAB == KNOB_HUE[0]);
    }
    {                                                       /* the footer: the octave in a slot of its own, so the tempo stays
                                                             * put whatever the octave (the owner, 2026-10-24); the 808 Kit's 12
                                                             * drum rows: the bank in its place (D-520), the tempo put there too
                                                             * (a kit of 8 rows: drum_bank_suite) */
        foot_t f;
        uint32_t xt = 0, moved = 0, rows = 1;
        int32_t o, was = octave;
        for (o = -3; o <= 3; o++) {
            octave = o;
            drum_bank = (uint8_t)(o & 1);
            (void)foot_layout(&f);
            if (o == -3)
                xt = f.xt;
            moved += f.xt != xt;
            rows &= !strcmp(f.o, o & 1 ? MSG_ROWS "9-12" : MSG_ROWS "1-11");
        }
        octave = was;
        drum_bank = 0;
        check("the footer on the 808 Kit: ROWS 1-11 / 9-12 in the octave's slot, the tempo at the same x in every state", moved == 0u && rows);
    }
    {                                                       /* #291: the screen as text, as SCREEN reports it */
        uint8_t idx[SCR_N];
        uint32_t n = scr_list(idx), i, ordered = 1;
        for (i = 1; i < n; i++)
            ordered &= scr_text[idx[i - 1]].y <= scr_text[idx[i]].y;
        check("the screen as text: the device page's octave slot (ROWS 1-11) and K1's row, in reading order", on_screen(MSG_ROWS "1-11") && n > 4u && ordered);
    }

    {   /* SELECT / ALGO (the owner's design, 2026-10-24): no toast, the header shows where they went; the header's sections
         * that changed, then the bars, in passes a newer click stops; lcd_px: the pixels sent */
        static uint16_t staged[240 * 240];
        uint32_t page_px, i, n;
        lcd_px = lcd_xfers = 0;
        ui_dirty = 2;                                       /* (a whole page) */
        loop();
        page_px = lcd_px;
        stop_n = 0;
        stop_answer = 0;
        pages_waiting = stop_probe;                         /* records lcd_px at each place a draw may give way */
        lcd_px = 0;
        fb_watch_reset();
        enc(1, 1);                                          /* ALGO */
        check("ALGO: the device's next page, the editor told", pg_cur_dev == 1 && pg_cur_page == 1 && focus_pg == 1);
        printf("      LCD pixels for one ALGO click: the header %u, the rows' type %u, the page %u (a whole page %u)\n",
               stop_px[0], stop_px[5], lcd_px, page_px);
        check("ALGO: the header's sections and the bars, nothing below them, no pixel twice", stop_n >= 6u
              && stop_px[0] <= 240u * LK_HH && fb_changed_in(0, FOOT_Y, 240, 240) == 0u && fb_blinked() == 0u);
        check("one ALGO click: the page under 80 % of a whole page's pixels (nothing cleared first)", lcd_px * 100u < page_px * 80u);
        snap_to(getenv("PANEL_SNAP_ALGO"));
        memcpy(staged, fb, sizeof staged);
        ui_dirty = 2;                                       /* the same state drawn whole: the same picture */
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += staged[i] != fb[i];
        check("the staged page is the page drawn whole, pixel for pixel", n == 0u);
        stop_answer = 1;                                    /* a newer click waits: fast scrolling */
        lcd_px = lcd_xfers = 0;
        enc(1, 1);
        printf("      LCD pixels for an ALGO click while the next one waits: %u\n", lcd_px);
        check("ALGO turning fast: only the header drawn, the page still due", lcd_px <= 240u * LK_HH && lcd_px > 0u
              && pg_cur_page == 2 && pg_algo_due && ui_dirty);
        stop_answer = 0;
        loop();                                             /* it stops: the page */
        memcpy(staged, fb, sizeof staged);
        ui_dirty = 2;
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += staged[i] != fb[i];
        check("a stopped draw, then drawn: the page whole, nothing left of the one before", n == 0u && !pg_algo_due);
        lcd_px = 0;
        later(700);
        check("700 ms later: nothing redrawn (no toast)", lcd_px == 0u);
        lcd_px = 0;
        stop_n = 0;
        enc(0, 1);                                          /* SELECT: the Output, and back */
        check("SELECT: the next device, the editor told, its name in the header", pg_cur_dev == 2 && focus_dev == 2
              && on_screen("OUTPUT"));
        printf("      LCD pixels for one SELECT click: the header %u, the page %u\n", stop_px[0], lcd_px);
        enc(0, -1);
        check("SELECT back: the device before", pg_cur_dev == 1 && focus_dev == 1 && pg_cur_page == 0 && !on_screen("OUTPUT"));
        enc(4, 1);
        enc(4, -1);
        later(1100);
        pages_waiting = 0;
        enc(1, 1);                                          /* (on the kit card's second page, as the tests below expect) */
        later(700);
        tap(BTN_OCT_UP);                                    /* the transport stopped, nothing else to redraw: the footer at once */
        check("OCT+ (the 808 Kit's drum rows, D-520): the footer's ROWS 9-12 at once, the nudge kept", drum_bank == 1u && octave == 0
              && on_screen(MSG_ROWS "9-12: MT/MC") && !on_screen(MSG_ROWS "1-11"));
        tap(BTN_OCT_DOWN);
        check("OCT-: ROWS 1-11 again", drum_bank == 0u && octave == 0 && on_screen(MSG_ROWS "1-11"));
        later(NUDGE_MS + 100u);                             /* (the bank's nudge ends) */
        param_now = 0;
    }

    {
        const ppage_t *pg = pages_now();
        mod = pg->mod[0];
        par = pg->par[0];
        v0 = eng_get_param(mod, par);
    }
    {   /* #298: a knob turned moves its own bar where it is: the slider and the number, nothing else on the screen */
        static uint16_t was[240 * 240];
        uint32_t i, outside = 0, k1_px, y_lo = row_y(0), y_hi = row_y(0) + row_h(), n;
        memcpy(was, fb, sizeof was);
        lcd_px = lcd_xfers = 0;
        enc(2, 5);                                          /* K1 */
        k1_px = lcd_px;
        check("K1: its row's parameter moved, the editor told", eng_get_param(mod, par) != v0 && param_now == 1);
        for (i = 0; i < 240u * 240u; i++)
            outside += was[i] != fb[i] && (i / 240u < y_lo || i / 240u >= y_hi || i % 240u < BAR_X || i % 240u >= BAR_X + BAR_W);
        printf("      LCD pixels for a K1 turn: %u in %u transfers\n", k1_px, lcd_xfers);
        check("K1: no pixel outside its bar changes, and the bar moves (no toast)", outside == 0u
              && memcmp(was, fb, sizeof was) != 0 && K1_TAB == KNOB_HUE[0]);
        memcpy(was, fb, sizeof was);
        lcd_px = 0;
        enc(2, 1);                                          /* K1 again: one click */
        k1_px = lcd_px;
        for (i = 0, outside = 0; i < 240u * 240u; i++)
            outside += was[i] != fb[i] && (i / 240u < y_lo || i / 240u >= y_hi);
        printf("      LCD pixels for one K1 click: %u\n", k1_px);
        check("one K1 click: under 2,500 px (about 3 ms), only its bar", k1_px < 2500u && outside == 0u);
        memcpy(was, fb, sizeof was);
        ui_dirty = 2;                                       /* the bar drawn whole: the same picture */
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += was[i] != fb[i];
        check("the moved bar is the bar drawn whole, pixel for pixel", n == 0u);
        fb_watch_reset();
        enc(2, -3);
        check("K1 turned back: no pixel blinks", fb_blinked() == 0);
        {
            static int32_t l[128], r[128];
            eng_render(l, r, 128);                          /* (the audio's next block: the effective value follows) */
        }
        lcd_px = 0;
        memcpy(was, fb, sizeof was);
        later(1100);
        for (i = 0, outside = 0; i < 240u * 240u; i++)
            outside += was[i] != fb[i] && (i / 240u < y_lo || i / 240u >= y_hi || i % 240u < BAR_X || i % 240u >= BAR_X + BAR_W);
        printf("      (a second later: %u px)\n", lcd_px);
        check("a second later: no toast to end (at most K1's live tick moves to the value the engine ran with)", outside == 0u
              && K1_TAB == KNOB_HUE[0]);
    }

    tap(BTN_HOME);                                          /* HOME on the device pages (#391, D-243) */
    check("HOME on a device's second page: its first page, the editor told, no step", page == 0 && pg_cur_dev == 1 && pg_cur_page == 0
          && focus_dev == 1 && focus_pg == 0 && trail_n == 0);
    enc(0, 1);
    check("SELECT: the next device's first page", pg_cur_dev == 2 && pg_cur_page == 0);
    tap(BTN_HOME);
    check("HOME on a device's first page: the patch's home page", page == 0 && pg_cur_dev == 1 && pg_cur_page == 0 && focus_dev == 1);
    loop();
    memcpy(before, fb, sizeof before);
    tap(BTN_HOME);
    check("HOME on the patch's home page: nothing", page == 0 && pg_cur_dev == 1 && pg_cur_page == 0
          && trail_n == 0 && memcmp(before, fb, sizeof before) == 0);
    enc(1, 1);

    panel_held |= 1u << BTN_HOME;                           /* HOME held: no menu (#395: GLO is the menu); the palette's
                                                             * overview (#1196) */
    panel_edges(1u << BTN_HOME, 0);
    later(1200);
    check("HOME held 1.2 s: no menu, the palette's overview shows", page == 0 && pal_view && on_screen(MSG_PAL_TITLE));
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);
    loop();
    check("  its release: the overview closes, nothing else (the device's second page stays)", !pal_view && !lcd_ovl
          && page == 0 && trail_n == 0 && pg_cur_dev == 1 && pg_cur_page == 1 && !on_screen(MSG_PAL_TITLE));
    mlen = 0;                                               /* (the MIDI log holds 256 messages; the menu's steps below would fill it) */
    tap(BTN_GLO);
    check("GLO: the menu on its MIDI tab, a step on the trail", page == PAGE_MENU && menu_tab == MT_MIDI && trail_n == 1 && menu_page());
    check("its header: MENU on coral; the rows: MIDI channel, clock in, MIDI out, clock out", px(2, 2) == P_CORAL && pages_now()->nrows == 4u
          && pages_now()->mod[0] == SETTING_ROW && pages_now()->par[0] == MR_CH && pages_now()->par[2] == MR_MOUT
          && pages_now()->par[3] == MR_CLKOUT && on_screen("CLOCK OUT"));
    {
        uint32_t ch = cfg.ch;
        int stepped = presets_stepped;
        enc(2, 1);
        check("K1 on MIDI: the channel one step a click", cfg.ch == (ch < 16u ? ch + 1u : 16u));
        enc(2, -1);
        check("  and back", cfg.ch == ch);
        check("K4 on MIDI: CLOCK OUT, ON as made (#473)", cfg.clock_out == 1u);
        enc(5, -1);
        check("  a turn left: OFF", cfg.clock_out == 0u && on_screen("OFF"));
        enc(5, 1);
        check("  a turn right: ON again", cfg.clock_out == 1u);
        enc(0, 1);
        check("SELECT in the menu: nothing", page == PAGE_MENU && menu_tab == MT_MIDI);
        enc(6, 1);
        check("PRESET in the menu: the next patch", presets_stepped == stepped + 1 && page == PAGE_MENU);
        patch_enc(1);
        check("HOME held + PRESET in the menu: the next patch, HOME's release stays in the menu", presets_stepped == stepped + 2 && page == PAGE_MENU);
        presets_stepped = stepped;
        check("  the header says MIDI 1/4 (#596, #1067)", on_screen("MIDI 1/4"));
        enc(1, 1);
        check("ALGO: MIDI's second page, TRANSPORT IN on K1, TRANSPORT OUT on K2, both ON as made (#596), CLOCK IN DELAY on K3 at 0 MS "
              "(#870)", menu_tab == MT_MIDI && menu_page2 && menu_page() && pages_now()->nrows == 3u && pages_now()->par[0] == MR_TIN
              && pages_now()->par[1] == MR_TOUT && pages_now()->par[2] == MR_CLK_DELAY && on_screen("MIDI 2/4") && on_screen("TRANSPORT IN")
              && on_screen("TRANSPORT OUT") && on_screen("CLOCK IN DELAY") && on_screen("0 MS") && cfg.transport_in && cfg.transport_out
              && cfg.clock_delay == 0u);
        enc(2, -1);
        check("  K1 left: TRANSPORT IN OFF", cfg.transport_in == 0u && on_screen("OFF"));
        enc(3, -1);
        check("  K2 left: TRANSPORT OUT OFF", cfg.transport_out == 0u);
        fm1_ms += 200;
        enc(4, 1);
        check("  K3 right: CLOCK IN DELAY 1 MS, a millisecond a click", cfg.clock_delay == 1u && on_screen("1 MS"));
        fm1_ms += 200;
        enc(4, -3);
        check("  K3 left past 0: held at 0 MS", cfg.clock_delay == 0u && on_screen("0 MS"));
        fm1_ms += 200;
        enc(4, 70);
        check("  70 clicks right: 70 MS (Reel's offset, #870)", cfg.clock_delay == 70u && on_screen("70 MS"));
        enc(4, 2);
        check("  turned fast (within 80 ms, KNOB ACCEL on): five a click, 80 MS", cfg.clock_delay == 80u && on_screen("80 MS"));
        cfg.accel = 0;
        enc(4, 2);
        check("  KNOB ACCEL off: one a click however fast, 82 MS", cfg.clock_delay == 82u);
        cfg.accel = 1;
        fm1_ms += 200;
        enc(4, 500);
        check("  far right: held at 200 MS", cfg.clock_delay == CIN_DELAY_MAX && on_screen("200 MS"));
        cfg_defaults();
        check("  FACTORY RESET's defaults: both ON, CLOCK IN DELAY 0 MS", cfg.transport_in == 1u && cfg.transport_out == 1u
              && cfg.clock_delay == 0u);
        enc(1, -1);
        check("ALGO back: MIDI 1/4", menu_tab == MT_MIDI && !menu_page2 && pages_now()->par[3] == MR_CLKOUT);
        enc(1, 1);
        enc(1, 1);
        check("ALGO twice: MIDI's third page: MAPPINGS (none), CLEAR, and LEARN reading HOME + SEL (#1067, D-939)", menu_tab == MT_MIDI
              && menu_page2 == 2u && pages_now()->nrows == 3u && pages_now()->par[0] == MR_MAPS && pages_now()->par[1] == MR_MAP_CLEAR
              && pages_now()->par[2] == MR_LEARN && on_screen("MAPPINGS") && on_screen("NONE") && on_screen("HOME + SEL")
              && on_screen("MIDI 3/4"));
        enc(1, 1);
        check("ALGO: MIDI's fourth page, the pad map: PAD MAP ON, row 1 with no pad, CLEAR, CLEAR ALL (#1067)", menu_tab == MT_MIDI
              && menu_page2 == 3u && pages_now()->nrows == 4u && pages_now()->par[0] == MR_PADS_ON && pages_now()->par[1] == MR_PAD_ROW
              && pages_now()->par[2] == MR_PAD_CLEAR && pages_now()->par[3] == MR_PADS_CLEAR && on_screen("MIDI 4/4") && on_screen("PAD MAP")
              && on_screen("CLEAR ALL") && pad_on && !pad_count());
        {
            uint32_t told = host_pads_told;
            pad_set(0, 36);
            pad_set(1, 38);
            ui_dirty = 1;
            panel_draw();
            check("  row 1's pad reads NOTE C2", on_screen("NOTE C2"));
            enc(4, 1);
            check("  K3 right clears it: NOTE C2 CLEARED, kept without SAVE, the editor told", pad_note[0] == PAD_NONE && pad_note[1] == 38u
                  && strstr(msg_text, "NOTE C2 CLEARED") && gt_due && host_pads_told == told + 1u);
            enc(3, 1);
            check("  K2 right: row 2, its pad NOTE D2", pad_sel == 1u && on_screen("NOTE D2"));
            enc(2, -1);
            check("  K1 left: PAD MAP OFF", !pad_on && on_screen("OFF") && host_pads_told == told + 2u);
            enc(2, 1);
            check("  K1 right: ON again", pad_on);
            enc(5, 1);
            check("  K4 right arms CLEAR ALL for GLO's hold", menu_armed == MR_PADS_CLEAR && strstr(msg_text, "HOLD GLO 2 S: CLEAR PADS"));
            check("  GLO's hold: every pad gone, PAD MAP stays on", menu_fire() && !pad_count() && pad_on && strstr(msg_text, "PADS CLEARED"));
            enc(3, -1);
            msg_until = fm1_ms;                             /* (the bar's message gone: the header again) */
        }
        enc(1, 1);
        check("ALGO: the PANEL tab (LEDs, knob accel, count-in, tempo)", menu_tab == MT_PANEL && pages_now()->nrows == 4u && pages_now()->par[0] == MR_LEDS && pages_now()->par[2] == MR_CIN && pages_now()->par[3] == MR_TEMPO);
        enc(4, 1);                                          /* K3: COUNT-IN (#414), OFF > 1 BAR > 2 BARS */
        check("K3 on PANEL: COUNT-IN OFF > 1 BAR (#414)", cfg.count_in == 1u && on_screen("1 BAR"));
        enc(4, 2);                                          /* (a setting steps once per turn, whatever the clicks) */
        check("  2 BARS at most", cfg.count_in == 2u && on_screen("2 BARS"));
        enc(4, 1);
        check("  stays at 2 BARS", cfg.count_in == 2u);
        enc(4, -1);
        enc(4, -1);
        check("  and back to OFF", cfg.count_in == 0u && on_screen("OFF"));
        check("  the header says PANEL 1/2 (#1011)", on_screen("PANEL 1/2"));
        {                                                   /* PANEL's second page: TIME SIG (#1011) */
            uint32_t told = host_tempo_told;
            enc(1, 1);
            check("ALGO again: PANEL's second page, TIME SIG alone on K1, 4/4 as made (#1011)", menu_tab == MT_PANEL && menu_page2 && menu_page()
                  && pages_now()->nrows == 1u && pages_now()->par[0] == MR_METER && on_screen("PANEL 2/2") && on_screen("TIME SIG") && on_screen("4/4")
                  && gt_meter == METER_DEFAULT && setting_bar(MR_METER, 70u) == METER_DEFAULT * 70u / (METER_N - 1u));
            enc(2, 1);
            check("K1 right: 5/4, the editor told, kept 5 s later (#1011)", gt_meter == 3u && on_screen("5/4") && eng_meter_get() == 3u
                  && host_tempo_told == told + 1u && gt_due);
            enc(2, -1);
            enc(2, -1);
            enc(2, -1);
            check("  K1 left: one meter a click, down to 2/4", gt_meter == 0u && on_screen("2/4") && setting_bar(MR_METER, 70u) == 0u);
            told = host_tempo_told;
            enc(2, -1);
            check("  stays at 2/4 (no wrap), the editor not told again", gt_meter == 0u && host_tempo_told == told);
            for (uint32_t k = 0; k < METER_N; k++)
                enc(2, 1);
            check("  up to 12/8 and stays (no wrap)", gt_meter == METER_N - 1u && on_screen("12/8") && setting_bar(MR_METER, 70u) == 70u);
            gt_set_meter(METER_DEFAULT, fm1_ms);
            enc(1, -1);
            check("ALGO back: PANEL 1/2", menu_tab == MT_PANEL && !menu_page2 && pages_now()->par[3] == MR_TEMPO && on_screen("PANEL 1/2"));
            enc(1, 1);
        }
        enc(1, 1);
        check("ALGO again: SYSTEM (update mode, factory reset, quick start, output)", menu_tab == MT_SYSTEM && !menu_page2 && pages_now()->nrows == 4u && pages_now()->par[1] == MR_DEFAULTS && pages_now()->par[2] == MR_QUICK && pages_now()->par[3] == MR_OUTPUT);
        check("  OUTPUT reads STEREO (#612)", !out_mono && on_screen("STEREO"));
        enc(5, 1);
        check("K4 on SYSTEM: OUTPUT STEREO > MONO (#612)", out_mono == 1u && on_screen("MONO") && !on_screen("MONO L"));
        enc(5, 1);
        check("  then MONO L", out_mono == 2u && on_screen("MONO L"));
        enc(5, 1);
        check("  stays at MONO L", out_mono == 2u);
        enc(5, -1);
        check("  back to MONO", out_mono == 1u && !on_screen("MONO L"));
        enc(5, -1);
        check("  and back to STEREO", !out_mono && on_screen("STEREO"));
        check("  the header says SYSTEM 1/2 (#702)", on_screen("SYSTEM 1/2"));
        enc(1, 1);
        check("ALGO again: SYSTEM's second page, EDITOR on K1 (#702)", menu_tab == MT_SYSTEM && menu_page2 && menu_page() && pages_now()->nrows == 3u
              && pages_now()->par[0] == MR_EDITOR && on_screen("SYSTEM 2/2") && on_screen("EDITOR") && on_screen("ALLOW"));
        check("  no armed-row line in the controls sheet's conditions there", !hc_menu_system());
        enc(2, 1);
        check("K1 right: EDITOR IGNORE", cfg.editor_ignore == 1u && on_screen("IGNORE"));
        check("  an INFO is due for the editor (main.c editor_poll)", editor_info_due == 1u);
        {
            uint8_t leds = cfg.leds;
            cfg_defaults();
            check("  FACTORY RESET's defaults: ALLOW", cfg.editor_ignore == 0u);
            cfg.editor_ignore = 1;
            cfg.leds = leds;
        }
        enc(2, -1);
        check("K1 left: EDITOR ALLOW", cfg.editor_ignore == 0u && on_screen("ALLOW"));
        enc(2, 4);
        enc(2, -1);
        check("  any turn steps once: ALLOW again", cfg.editor_ignore == 0u);
        check("K2 on SYSTEM 2/2: 3.5MM OUT, ON as made, no mark in the footer (#631, #600 gone)", pages_now()->par[1] == MR_OUT35 && !on_screen("USB LEVEL") && !out_off
              && on_screen("3.5MM OUT") && on_screen("ON") && px(OFF_FX + 2u, BATT_FY + 2u) != P_WARN);
        enc(3, -1);
        check("  K2 left: OFF, the red mark left of the battery (SCREEN: 3.5MM OFF)", out_off == 1u
              && on_screen("OFF") && px(OFF_FX + 2u, BATT_FY + 2u) == P_WARN && on_screen(MSG_FOOT_OUT35_OFF) && px(OFF_FX + 3u, BATT_FY + 2u) != P_WARN);
        enc(3, -1);
        check("  stays OFF", out_off == 1u);
        {
            uint8_t leds = cfg.leds, ign = cfg.editor_ignore;
            cfg_defaults();
            check("  FACTORY RESET's defaults: ON", out_off == 0u);
            cfg.leds = leds;
            cfg.editor_ignore = ign;
            out_off = 1;
        }
        enc(3, 1);
        ui_full = 1;
        loop();
        check("  K2 right: ON again, the mark gone", out_off == 0u && on_screen("ON") && px(OFF_FX + 2u, BATT_FY + 2u) != P_WARN && !on_screen(MSG_FOOT_OUT35_OFF));
        enc(1, -1);
        check("ALGO back: SYSTEM 1/2", menu_tab == MT_SYSTEM && !menu_page2 && pages_now()->par[3] == MR_OUTPUT && on_screen("SYSTEM 1/2"));
        enc(1, 1);
        enc(1, 1);
        check("ALGO again: EQ, the master EQ (#1107): LOW, MID, HIGH, MID FREQ, flat at 1 kHz as made", menu_tab == MT_EQ && menu_page()
              && pages_now()->nrows == 4u && pages_now()->par[0] == MR_EQ_LOW && pages_now()->par[1] == MR_EQ_MID && pages_now()->par[2] == MR_EQ_HIGH
              && pages_now()->par[3] == MR_EQ_FREQ && on_screen("MID FREQ") && on_screen("0 DB") && on_screen("1.0 KHZ") && on_screen("EQ"));
        gt_due = 0;
        enc(2, 1);
        loop();
        check("  K1 right: LOW +0.5 DB, the settings record due (kept without SAVE, as TEMPO)", (int8_t)meq_low == 1 && on_screen("+0.5 DB") && gt_due != 0u);
        enc(2, -3);
        loop();
        check("  K1 left: -1.0 DB", (int8_t)meq_low == -2 && on_screen("-1.0 DB"));
        enc(4, 60);
        loop();
        check("  K3 far right: HIGH stops at +12.0 DB", (int8_t)meq_high == MEQ_GAIN_MAX && on_screen("+12.0 DB"));
        enc(5, -30);
        loop();
        check("  K4 far left: MID FREQ stops at 100 HZ", meq_freq == 0u && on_screen("100 HZ"));
        enc(5, 6);
        loop();
        check("  K4 six clicks right: an octave up, 200 HZ", meq_freq == 6u && on_screen("200 HZ"));
        {
            uint8_t d[MEQ_BYTES];
            meq_pack(d);
            meq_defaults();
            meq_unpack(d);
            check("  the settings as bytes and back (main.c's settings extension)", (int8_t)meq_low == -2 && meq_mid == 0u && (int8_t)meq_high == MEQ_GAIN_MAX
                  && meq_freq == 6u);
            d[0] = 0x80u;                                   /* (out of range: held) */
            d[3] = 200u;
            meq_unpack(d);
            check("  bytes out of range: the gain held to -12 DB, MID FREQ back at 1 kHz", (int8_t)meq_low == -MEQ_GAIN_MAX && meq_freq == MEQ_FREQ_DEFAULT);
        }
        cfg_defaults();
        check("  FACTORY RESET's defaults: flat at 1 kHz", !meq_low && !meq_mid && !meq_high && meq_freq == MEQ_FREQ_DEFAULT);
        gt_due = 0;
        enc(1, 1);
        check("ALGO again: INFO, a list, not a page", menu_tab == MT_INFO && !menu_page() && on_screen("BANK SLOTS") && on_screen("VERSION"));
        check("  its top bar is the plain bar with the patch's name, not the coral header's top", on_screen(patch_label));
        enc(1, 1);
        check("ALGO again: GUIDE (D-248), a text, not a page", menu_tab == MT_GUIDE && !menu_page());
        check("  the tab chip and the title say GUIDE, its first lines point at the controls sheet", on_screen("GUIDE")
              && on_screen("Guide") && on_screen("PRESS OCT- + OCT+") && on_screen("TO SEE CONTROLS FOR CURRENT"));
        {                                                   /* the GUIDE's lines (D-200, D-248): at most 35 characters after
                                                             * the style marker, capitals, no ';'; it explains ideas, so no
                                                             * line names a control (a whole word) but its first two. PRESET
                                                             * is an idea as well as a knob */
            static const char *const CTRL[] = {"SELECT", "ALGO", "HOME", "GLO", "SAVE", "PLAY", "REC", "SEL", "ENV", "SEQ",
                                               "OCT", "K1", "K2", "K3", "K4", "KNOB", "KNOBS", "BUTTON", "BUTTONS", "FX",
                                               "LFO", "EDIT", "ARP"};
            static const char *const IDEA[] = {"#PATCH", "#PRESET", "#DEVICE", "#ASSEMBLY", "#MODULE", "#ENGINE", "#PAGE",
                                               "#TRACK", "#PATTERN", "#P-LOCK", "#SONG", "#ARMING", "#THE ENVIRONMENT", "#SANDBOX MODE", "#LIVE"};
            uint32_t i, k, bad = 0, ctrl = 0, vocab = 0;
            for (i = 0; i < MAN_N; i++) {
                const char *l = MANUAL[i];
                bad += strlen(l) > MAN_COLS + 1u || strchr(l, ';') != 0 || (l[0] && l[0] != '#' && l[0] != ' ' && l[0] != '~');
                for (k = 0; l[k]; k++)
                    bad += l[k] >= 'a' && l[k] <= 'z';
                for (k = 0; i >= 2u && l[0] != '~' && k < sizeof CTRL / sizeof CTRL[0]; k++) {
                    const char *w = l;
                    size_t n = strlen(CTRL[k]);
                    while ((w = strstr(w, CTRL[k])) != 0) {
                        int a = w > l && w[-1] >= 'A' && w[-1] <= 'Z', z = w[n] >= 'A' && w[n] <= 'Z';
                        if (!a && !z)
                            printf("      (the GUIDE names a control: \"%s\")\n", l), ctrl++;
                        w += n;
                    }
                }
                for (k = 0; k < sizeof IDEA / sizeof IDEA[0]; k++)
                    vocab += !strcmp(l, IDEA[k]);
            }
            check("  GUIDE lines: at most 35 characters, capitals, no ';' (D-200)", bad == 0u);
            check("  GUIDE: after the first two lines, no control named (D-248)", ctrl == 0u);
            check("  GUIDE: a heading for each of the 14 ideas of D-248, and P-lock (#524)", vocab == 15u);
        }
        enc(1, 1);
        check("ALGO wraps to MIDI, the coral header back", menu_tab == MT_MIDI && px(2, 2) == P_CORAL);
        enc(1, -1);
        check("ALGO back: GUIDE", menu_tab == MT_GUIDE);
    }
    {                                                       /* #146: an idle INFO tab redraws only the CPU values */
        uint32_t i, n = 0, outside = 0, y0 = MENU_Y + info_pos(MR_CPU) * MENU_PITCH, y1 = MENU_Y + info_pos(MR_PEAK) * MENU_PITCH;
        menu_tab = MT_INFO;
        ui_dirty = 2;
        loop();
        fb_watch_reset();
        eng_us_max = (cpu_pct + 7u) * 2902u / 100u + 1u;   /* another %, above the peak */
        fm1_ms += 500;
        cpu_poll();
        loop();
        for (i = 0; i < 240u * 240u; i++) {
            uint32_t x = i % 240u, y = i / 240u;
            int in = x >= 150u && x < 228u && ((y >= y0 + MENU_TXT && y < y0 + MENU_TXT + 18u) || (y >= y1 + MENU_TXT && y < y1 + MENU_TXT + 18u));
            n += fb_changes[i] != 0u;
            outside += fb_changes[i] != 0u && !in;
        }
        check("INFO idle, the CPU changed: only the CPU and CPU PEAK values redrawn, no blink",
              n > 0u && outside == 0u && fb_blinked() == 0);
        menu_tab = MT_PANEL;
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
    }
    {                                                       /* SYSTEM (#395): a turn arms a row, GLO held 2 s does it; a nudge or a tap never */
        int32_t oct = octave;
        menu_tab = MT_SYSTEM;
        ui_dirty = 2;
        loop();
        tap(BTN_OCT_UP);
        check("OCT+ in the menu: nothing (no octave, nothing armed)", host_updates == 0 && host_defaults == 0 && menu_armed == MR_COUNT && octave == oct);
        enc(3, 1);
        check("K2 right on SYSTEM: FACTORY RESET armed, not done", menu_armed == MR_DEFAULTS && host_defaults == 0 && on_screen(MSG_HOLD_GLO));
        tap(BTN_GLO);
        check("GLO tapped while armed: back out of the menu, nothing done", page == 0 && host_defaults == 0 && trail_n == 0);
        tap(BTN_GLO);
        enc(1, 1);
        enc(1, 1);
        enc(1, 1);
        enc(1, 1);
        enc(1, 1);
        enc(1, 1);                                          /* (MIDI's four pages, #596, #1067, and PANEL's two, #1011) */
        enc(3, 1);
        check("again: the menu, SYSTEM, FACTORY RESET armed", page == PAGE_MENU && menu_tab == MT_SYSTEM && menu_armed == MR_DEFAULTS);
        later(MENU_ARM_MS + 100u);
        panel_held |= 1u << BTN_GLO;
        panel_edges(1u << BTN_GLO, 0);
        later(2100);
        panel_held &= ~(1u << BTN_GLO);
        panel_edges(0, 1u << BTN_GLO);
        loop();
        check("armed over 5 s ago, GLO held 2 s: too late, nothing done; the hold is no tap, the menu stays", host_defaults == 0 && page == PAGE_MENU);
        enc(2, 1);
        check("K1 right: UPDATE MODE armed", menu_armed == MR_UPDATE);
        enc(2, -1);
        check("K1 left: disarmed", menu_armed == MR_COUNT);
        enc(2, 1);
        test_input_ms = fm1_ms ? fm1_ms : 1u;             /* the device test mode (#291): no FACTORY RESET or UPDATE MODE */
        panel_held |= 1u << BTN_GLO;
        panel_edges(1u << BTN_GLO, 0);
        later(2100);
        panel_held &= ~(1u << BTN_GLO);
        panel_edges(0, 1u << BTN_GLO);
        loop();
        check("test input: UPDATE MODE's hold refused, and said so", host_updates == 0 && on_screen(MSG_TEST_REFUSED) && page == PAGE_MENU);
        fm1_ms += TEST_HOLD_MS;
        enc(3, 1);
        panel_held |= 1u << BTN_GLO;
        panel_edges(1u << BTN_GLO, 0);
        later(2100);
        panel_held &= ~(1u << BTN_GLO);
        panel_edges(0, 1u << BTN_GLO);
        loop();
        check("  10 s after the last test input: K2 right, GLO held 2 s: FACTORY RESET by hand again", host_defaults == 1 && menu_armed == MR_COUNT);
        host_defaults = 0;
        test_input_ms = 0;
        menu_tab = MT_MIDI;
        ui_dirty = 2;
        loop();
        mlen = 0;
    }
    tap(BTN_SEQ);
    check("SEQ from the menu: the step page, a second step", page == PAGE_SEQ && trail_n == 2);
    tap(BTN_HOME);
    check("HOME: back to the menu", page == PAGE_MENU && trail_n == 1);
    tap(BTN_HOME);
    check("HOME tapped: the menu closes, back on the page it was opened from", page == 0 && trail_n == 0 && pg_cur_dev == 1 && pg_cur_page == 1);
    tap(BTN_GLO);                                           /* the menu again, then SAVE */
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
    pages_focus(2, 0);                                      /* (the Output: a module's page; the 808 kit card has presets) */
    loop();
    msg_text[0] = 0;
    enc(6, 1);
    check("PRESET alone on a module's page (#395): no patch, the bar says HOME+PRESET steps them (#450)", presets_stepped == 0 && !strcmp(msg_text, MSG_NONE_PATCHES));
    later(1600);
    patch_enc(1);
    check("HOME held + PRESET: the next patch", presets_stepped == 1 && page == 0);
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
        drum_bank = 0;                                      /* (OCT- then OCT+ on the 808 Kit picked its second drum bank, D-520) */
        pages_focus(0, 0);                                  /* (Main: SELECT lands on the 808 kit card, where PRESET loads a
                                                             * sound, so the patch is edited, D-1053) */
        loop();
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

    {                                                       /* Page buttons (#117), spliced into the 808 Kit's binary */
        /* LFO (button 3) a Page button: device 1 (the 808 kit card) page 0, then its page 1 (SEL is fixed since #197) */
        static const uint8_t sec[] = {0, 0, 0, 3, 0, 0, 0, 2, 1, 0, 1, 1};
        uint32_t at = panel_buttons_at();
        static uint8_t before[sizeof pv_bin];
        uint32_t before_len = pv_len, origin = eng_origins_at(pv_bin, pv_len);
        memcpy(before, pv_bin, pv_len);
        check("Page button insertion point precedes names, provenance and ranges", at && origin > at && !(pv_bin[6] & 64u));
        memmove(pv_bin + at + sizeof sec, pv_bin + at, pv_len - at);
        memcpy(pv_bin + at, sec, sizeof sec);
        pv_len += sizeof sec;
        pv_bin[6] |= 64u;
        pv_gen++;
        check("a patch with a Page button loads", eng_load(pv_bin, pv_len) == 0 && eng_button_kind(3) == ENG_BTN_PAGE);
        check("Page button insertion preserves every later section", !memcmp(before + at, pv_bin + at + sizeof sec, before_len - at)
              && eng_origins_at(pv_bin, pv_len) == origin + sizeof sec);
        memmove(pv_bin + at, pv_bin + at + sizeof sec, pv_len - at - sizeof sec);
        pv_len -= sizeof sec; pv_bin[6] &= ~64u;
        check("Page button removal and saved binary reload restore all bytes", pv_len == before_len && !memcmp(before, pv_bin, pv_len)
              && !eng_load(pv_bin, pv_len) && eng_origins_at(pv_bin, pv_len) == origin);
        memmove(pv_bin + at + sizeof sec, pv_bin + at, pv_len - at);
        memcpy(pv_bin + at, sec, sizeof sec); pv_len += sizeof sec; pv_bin[6] |= 64u;
        check("Page button saved binary reload retains its list and origin", !eng_load(pv_bin, pv_len)
              && eng_button_kind(3) == ENG_BTN_PAGE && eng_origins_at(pv_bin, pv_len) == origin + sizeof sec);

        page_show(0);
        trail_n = 0;
        pages_focus(2, 0);                                  /* (the Output) */
        loop();
        tap(5);
        check("LFO tapped: its list's first page, a step on the trail, lit", pg_list_btn == 3 && pg_cur_dev == 1 && pg_cur_page == 0
              && trail_n == 1 && (eng_buttons_get() >> 3 & 1u) && focus_dev == 1);
        later(2000);                                        /* (a message from before ends) */
        check("the top bar names the list", px(120, 2) == P_SEA);
        snap();
        tap(5);
        check("LFO again: the next page", pg_list_step == 1 && pg_cur_dev == 1 && pg_cur_page == 1 && trail_n == 1);
        tap(5);
        check("... round the list", pg_list_step == 0 && pg_cur_dev == 1 && pg_cur_page == 0);
        enc(1, 1);
        check("ALGO inside the list: its next step", pg_list_step == 1 && pg_cur_dev == 1 && pg_cur_page == 1);
        panel_held |= 1u << 5;                              /* held: the first page while it is down */
        panel_edges(1u << 5, 0);
        later(500);
        check("LFO held: the list's first page", pg_list_peek && pg_cur_dev == 1 && pg_cur_page == 0);
        panel_held &= ~(1u << 5);
        panel_edges(0, 1u << 5);
        loop();
        check("let go: back to the step it was on", !pg_list_peek && pg_list_step == 1 && pg_cur_dev == 1 && pg_cur_page == 1);
        tap(BTN_HOME);
        check("HOME: back to where it was before the list, unlit", pg_list_btn < 0 && pg_cur_dev == 2 && pg_cur_page == 0
              && trail_n == 0 && !(eng_buttons_get() >> 3 & 1u));
        tap(5);
        enc(0, 1);
        check("SELECT inside the list leaves it", pg_list_btn < 0 && !(eng_buttons_get() >> 3 & 1u));
        trail_n = 0;
    }

    {                                                       /* SEL on a device page arms its device (#395); SEQ opens a track's
                                                             * steps (#196) and arms it. The 808 kit card is DRUMS' device
                                                             * (#1202 K2): SEL on it arms the card with its track */
        uint32_t dm = (uint32_t)eng_steps_module(0), om = (uint32_t)eng_find(T_OUTPUT);
        eng_mset_t kit;
        foot_t f;
        check("the edited patch stays WIRED: nothing armed, the footer marks the edit and says KEYS WIRED", m64(eng_arm_mask_get()) == 0u
              && (foot_layout(&f), !strcmp(f.a, "808 KIT *") && !strcmp(f.w, MSG_KEYS_WIRED)));
        pages_focus(1, 0);                                  /* the 808 kit card */
        loop();
        kit = env_listeners(1);
        check("the kit card is the track's device: no RATE or SWING row on its first page", pages_focus_track() == 0 && mset_has(kit, dm)
              && !on_screen("RATE") && !on_screen("SWING"));
        tap(3);
        check("SEL there: the card and its track armed, no page opened, the bar names the card alone", page == 0 && mset_eq(eng_arm_mask_get(), kit)
              && !strcmp(msg_text, "808 KIT" MSG_ARMED));
        check("  the footer: ARM DRUMS", (foot_layout(&f), !strcmp(f.a, MSG_FOOT_ARM "DRUMS") && !f.w[0]));
        later(1500);
        tap(3);
        check("SEL again: a toggle, disarmed, the keys WIRED (#395)", page == 0 && m64(eng_arm_mask_get()) == 0u && !strcmp(msg_text, MSG_KEYS_WIRED));
        later(1500);
        tap(3);
        check("SEL a third time: armed again", mset_eq(eng_arm_mask_get(), kit) && !strcmp(msg_text, "808 KIT" MSG_ARMED));
        {                                               /* armed with another (a bit of the set): SEL takes it out, the other stays */
            eng_arm_mask(mset_or(kit, mset_one(om)));
            later(1500);
            tap(3);
            check("SEL on a device armed with another: taken out, the other stays", !mset_has(kit, om) && mset_eq(eng_arm_mask_get(), mset_one(om))
                  && !strcmp(msg_text, "808 KIT" MSG_DISARMED));
            eng_arm_mask(kit);
        }
        pages_focus(0, 0);                                  /* Main: no keys input */
        loop();
        later(1500);
        tap(3);
        check("SEL on Main: NOTHING HERE TAKES KEYS, the armed set as it was", page == 0 && mset_eq(eng_arm_mask_get(), kit)
              && !strcmp(msg_text, MSG_NOTHING_TAKES_KEYS));
        eng_arm_mask(s64(0));
        pages_focus(1, 0);
        loop();
        tap(BTN_SEQ);
        check("SEQ on the kit card: the SEQ page on its track, armed", page == PAGE_SEQ && seq_trk == 0 && mset_has(eng_arm_mask_get(), dm));
        tap(BTN_HOME);
        check("HOME: back to the kit card, still armed", page == 0 && pg_cur_dev == 1 && mset_has(eng_arm_mask_get(), dm));
        eng_arm_mask(s64(0));
        pages_focus(1, 0);
        later(1500);
        loop();
        trail_n = 0;
    }

    {                                                       /* ENV (#197): the environment */
        uint32_t d0, n0 = trail_n;
        pages_focus(1, 1);                                  /* the 808 kit card, its second page */
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
        {                                                   /* #229: SELECT redraws the old and the new row alone */
            uint32_t ya = ENV_Y0 + (d0 - env_first) * ENV_ROW_H, all, part;
            later(2000);                                    /* (no message on show) */
            fb_watch_reset();
            lcd_px = lcd_xfers = 0;
            enc(0, 1);
            all = fb_changed_in(0, 0, 240, 240);
            part = fb_changed_in(0, ya, 240, ya + 2u * ENV_ROW_H);
            printf("      (ENV, SELECT a row on: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
            check("SELECT: the next row", page == PAGE_ENV && pg_cur_dev == d0 + 1u && pg_cur_page == 0);
            check("  only the old and the new row redrawn (not the bar, not the other rows), no blink",
                  all > 0u && all == part && fb_blinked() == 0u && lcd_px <= 2u * 240u * ENV_ROW_H);
        }
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
        later(1500);
        tap(3);                                             /* the Output */
        check("SEL on a row that takes no keys: NOTHING HERE TAKES KEYS, nothing armed, the page stays",
              page == PAGE_ENV && pg_cur_dev == d0 + 1u && m64(eng_arm_mask_get()) == 0u && !strcmp(msg_text, MSG_NOTHING_TAKES_KEYS));
        tap(4);
        check("ENV again: back where it came from", page == 0 && trail_n == n0);
        pages_focus(1, 0);                                  /* SEL on a row (#395): the kit card, DRUMS' device, armed, then disarmed */
        loop();
        tap(4);
        tap(3);
        check("SEL on the environment's kit row: armed with its track (the set), no recording, the page stays", eng_armed() >= 0
              && mset_eq(eng_arm_mask_get(), env_listeners(1)) && mset_has(eng_arm_mask_get(), (uint32_t)eng_steps_module(0))
              && seq_rec == 0 && page == PAGE_ENV && !strcmp(msg_text, "808 KIT" MSG_ARMED));
        tap(BTN_REC);
        check("REC on the environment (#395): records the armed track, arms nothing, the page stays", mset_eq(eng_arm_mask_get(), env_listeners(1))
              && seq_rec && eng_transport_running() && (E.trk_rec >> E.node[eng_steps_module(0)].trk & 1u) && page == PAGE_ENV && !rec_held_used);
        tap(BTN_PLAY);
        check("  PLAY: REC and the transport stopped", !seq_rec && !eng_transport_running() && !E.trk_rec);
        tap(3);
        check("SEL again on the kit row: disarmed, the keys WIRED (the bar says so)", m64(eng_arm_mask_get()) == 0u && eng_armed() < 0
              && !strcmp(msg_text, MSG_KEYS_WIRED));
        {
            char s1[16], s0[16];
            env_status(0, s0);
            env_status(1, s1);
            check("  nothing armed: the kit's row says WIRED (the keys reach it by cable, #582), Main's its tempo",
                  !strcmp(s1, MSG_ROW_WIRED) && strstr(s0, "BPM") != 0);
            seq_arm_set(s64((uint64_t)1 << eng_steps_module(0)));
            env_status(1, s1);
            check("  its track armed: ARMED, no WIRED", !strcmp(s1, MSG_ROW_ARMED));
            seq_arm_set(s64(0));
            loop();
        }
        tap(4);
        panel_held |= 1u << 4;                              /* ENV held + SAVE: no environment on the release */
        panel_edges(1u << 4, 0);
        panel_edges(1u << BTN_SAVE, 0);
        panel_edges(0, 1u << BTN_SAVE);
        panel_held &= ~(1u << 4);
        panel_edges(0, 1u << 4);
        loop();
        check("ENV held + SAVE: the release opens nothing; on the kit card, its values stored as a user preset", page == 0 && host_preset_stored == 1u);
        later(1500);
        host_ps_init();                                     /* (the preset store empty again for the preset checks below) */
        host_preset_stored = 0;
        m1_edited = 0;
        pages_focus(1, 0);
        loop();
    }

    {                                                       /* a device whose keys come through a track outside it (#395, #582):
                                                             * Silver Box played by its PATTERN track */
        uint32_t d = 0, t;
        if (load("SILVER BOX") == 0) {
            pv_gen++;
            page = 0;
            trail_n = 0;
            loop();
            pages_ensure();
            for (d = 0; d < pg_ndev && !(pg_track_mod(d) < 0 && pg_dev[d].track < pg_ndev && mset_any(env_listeners(d))); d++)
                ;
            check("(Silver Box: a device driven by a track outside it)", d < pg_ndev);
        } else
            check("(Silver Box loads)", 0);
        if (d < pg_ndev) {
            int tm;
            char s1[16], s2[16];
            t = pg_dev[d].track;
            tm = pg_track_mod(t);
            pages_focus(t, 0);
            loop();
            tap(4);
            tap(3);
            check("SEL on the environment's track row: armed (the set), the page stays", eng_armed() == tm && page == PAGE_ENV
                  && !strcmp(msg_text, "PATTERN" MSG_ARMED));
            enc(0, (int32_t)d - (int32_t)t);
            later(1500);
            tap(3);
            check("SEL on the instrument's row, its track armed: armed through it, so taken out with it, the keys WIRED",
                  pg_cur_dev == d && m64(eng_arm_mask_get()) == 0u && !strcmp(msg_text, MSG_KEYS_WIRED));
            later(1500);
            tap(3);
            printf("      (the bar: \"%s\")\n", msg_text);
            check("SEL there again: the track it plays through armed; the bar names both (#582)", mset_has(eng_arm_mask_get(), (uint32_t)tm)
                  && !strcmp(msg_text, "SILVER BOX" MSG_ARMED_PLUS "PATTERN" MSG_ARMED));
            seq_arm_set(s64(0));
            env_status(t, s1);
            env_status(d, s2);
            check("  nothing armed: the track's and the instrument's rows say WIRED (the keys reach them by cable, #582)",
                  !strcmp(s1, MSG_ROW_WIRED) && !strcmp(s2, MSG_ROW_WIRED));
            seq_arm_set(mset_one((uint32_t)tm));
            env_status(t, s1);
            env_status(d, s2);
            check("  the track armed: ARMED on both, no WIRED", !strcmp(s1, MSG_ROW_ARMED) && !strcmp(s2, MSG_ROW_ARMED));
            seq_arm_set(s64(0));
            tap(4);
            later(1500);
        }
        load("808 KIT");
        pv_gen++;
        page = 0;
        trail_n = 0;
        loop();
        pages_focus(1, 0);
        loop();
    }

    {                                                       /* ENV past the last row shown: the list scrolls, the bar stays.
                                                             * The env-many fixture has more top-level devices than ENV shows. */
        if (load_fixture("build/panel-fixtures/env-many.m1p") == 0) {
            pv_gen++;
            page = 0;
            trail_n = 0;
            loop();
            pages_focus(2, 0);
            loop();
            tap(4);
            later(2000);
            check("(env-many: ENV, more devices than it shows)", page == PAGE_ENV && pg_ndev > ENV_ROWS);
            {
                uint32_t d1 = pg_cur_dev, all, list, i;
                for (i = 0; pg_cur_dev < env_first + ENV_ROWS - 1u && i < 16u; i++)
                    enc(0, 1);
                fb_watch_reset();
                lcd_px = lcd_xfers = 0;
                enc(0, 1);
                all = fb_changed_in(0, 0, 240, 240);
                list = fb_changed_in(0, ENV_Y0, 240, ENV_Y0 + ENV_ROWS * ENV_ROW_H);
                printf("      (ENV, SELECT scrolls the list: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
                check("  SELECT past the window: the list scrolls, only its area redrawn (the bar stays), no blink",
                      env_first > 0u && all > 0u && all == list && fb_blinked() == 0u);
                {
                    uint16_t keep[240 * 240];
                    memcpy(keep, fb, sizeof keep);
                    ui_dirty = 2;
                    loop();
                    check("  what it drew is what a whole redraw draws", !memcmp(keep, fb, sizeof keep));
                }
                while (pg_cur_dev != d1)
                    enc(0, -1);
            }
            tap(4);
            later(1500);
        } else {
            check("(the env-many fixture loads)", 0);
        }
        load("808 KIT");
        pv_gen++;
        page = 0;
        trail_n = 0;
        loop();
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
            {                                               /* PRESET on the assembly's page (#395): its next preset, loaded,
                                                             * the editor told, its name in the bar; the rows redrawn as a
                                                             * whole redraw would draw them */
                uint16_t keep[240 * 240];
                char before[17];
                int stepped = presets_stepped;
                uint32_t slot = cur_preset;
                memcpy(before, pg_pname[d], sizeof before);
                param_now = 0;
                later(2000);
                enc(6, 1);
                check("PRESET on an assembly's page: its first preset loaded (none was set), the editor told, PRESET <NAME> in the bar",
                      page == 0 && pg_pname[d][0] && strcmp(before, pg_pname[d]) != 0 && param_now > 0 && presets_stepped == stepped
                      && !strncmp(msg_text, MSG_PRESET, sizeof MSG_PRESET - 1u) && !strcmp(msg_text + sizeof MSG_PRESET - 1u, pg_pname[d]));
                memcpy(before, pg_pname[d], sizeof before);
                enc(6, 1);
                check("  again: the one after it, no patch change", strcmp(before, pg_pname[d]) != 0 && presets_stepped == stepped && cur_preset == slot);
                memcpy(keep, fb, sizeof keep);
                ui_dirty = 2;
                loop();
                check("  what it drew under the bar is what a whole redraw draws", !memcmp(keep + BAR_H * 240u, fb + BAR_H * 240u, sizeof keep - BAR_H * 240u * 2u));
                later(1500);
            }
            {                                               /* a device set to no preset stands on the entry whose values
                                                             * it has (#432): on Init, right is the entry after it, left the
                                                             * last, never Init again */
                char before[17], nm1[17], nml[17];
                uint32_t k, n = dp_list(d);
                int at = -1;
                memcpy(before, pg_pname[d], sizeof before);
                for (k = 0; k < n && at < 0; k++)
                    if (dp_entry(pr_list[k], nm1) >= 0 && !ps_name_cmp(nm1, before))
                        at = (int)k;
                (void)dp_entry(pr_list[1], nm1);
                (void)dp_entry(pr_list[n - 1u], nml);
                check("  (its list: an Init, then others)", n >= 2u && at >= 0 && !dp_load(d, 0));
                dp_name_set(d, "");
                pages_ensure();
                enc(6, 1);
                check("  on Init's values, set to none (#432): PRESET right loads the entry after Init", !ps_name_cmp(pg_pname[d], nm1) && !strcmp(msg_text + sizeof MSG_PRESET - 1u, pg_pname[d]));
                later(1500);
                (void)dp_load(d, 0);
                dp_name_set(d, "");
                pages_ensure();
                enc(6, -1);
                check("  and PRESET left the last entry", !ps_name_cmp(pg_pname[d], nml));
                later(1500);
                (void)dp_load(d, 0);
                dp_name_set(d, "");
                pages_ensure();
                dp_list(d);
                check("  on Init's values: dp_current finds Init, the name left unset", dp_current(d, n) == 0 && !pg_pname[d][0]);
                (void)dp_load(d, (uint32_t)at);              /* (back to the preset it was on, for what follows) */
                pages_ensure();
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
                      !strcmp(msg_text, MSG_PRESET_DELETED) && ps_list(pg_dev[d].structure, 0, 0) == 1u);
                msg_text[0] = 0;
                dp_deleted(pg_dev[d].structure, "NOT IN USE");
                check("  one no device is set to: no message", !msg_text[0]);
            }
            later(1500);
            tap(3);                                         /* SEL on the assembly's page (#395): armed, no preset list */
            loop();
            printf("      (the bar: \"%s\")\n", msg_text);
            {
                uint64_t a = m64(eng_arm_mask_get());
                uint32_t m, trk = 0, arp = 0;
                for (m = 0; m < 64u; m++)
                    if (a >> m & 1u) {
                        trk += eng_type(m) == T_STEPS;
                        arp += eng_type(m) == T_ARP;
                    }
                check("SEL on an instrument's page: no preset list; armed with the track and the Arpeggiator its keys come "
                      "through (#395), not NOTHING HERE TAKES KEYS",
                      page == 0 && a && a == m64(env_listeners(d)) && strstr(msg_text, MSG_ARMED) != 0 && trk == 1u && arp == 1u);
            }
            eng_arm_mask(s64(0));
            {                                           /* an Arpeggiator alone is not a device to arm (#395) */
                uint32_t e, d0 = pg_cur_dev, g0 = pg_cur_page;
                for (e = 0; e < pg_ndev && !(pg_dev[e].module >= 0 && eng_type((uint32_t)pg_dev[e].module) == T_ARP); e++)
                    ;
                check("  (the patch has an Arpeggiator's device)", e < pg_ndev);
                if (e < pg_ndev) {
                    (void)pages_focus(e, 0);
                    later(1500);
                    tap(3);
                    loop();
                    check("SEL on an Arpeggiator's page: nothing armed, NOTHING HERE TAKES KEYS",
                          m64(eng_arm_mask_get()) == 0u && !strcmp(msg_text, MSG_NOTHING_TAKES_KEYS));
                    (void)pages_focus(d0, g0);
                    later(1500);
                }
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

    {                                                       /* GLO (#199, #395): the menu, its MIDI tab first */
        int main = eng_find(T_FM1);
        int32_t bpm = eng_get_param((uint32_t)main, FM1_P_TEMPO);
        uint32_t d = pg_cur_dev, g = pg_cur_page, ch = cfg.ch;
        tap(7);
        check("GLO: the menu on MIDI, a step on the trail, GLO's jack was high while held", page == PAGE_MENU && menu_tab == MT_MIDI && trail_n == 1);
        check("its bar: MENU on coral", px(2, 2) == P_CORAL);
        enc(2, 4);
        check("K1 in the menu: the MIDI channel one step a turn, not the patch's tempo", cfg.ch == (ch < 16u ? ch + 1u : 16u) && eng_get_param((uint32_t)main, FM1_P_TEMPO) == bpm);
        enc(2, -4);
        later(1500);
        check("the rows: MIDI channel, clock in, MIDI out, clock out", pages_now()->nrows == 4u && pages_now()->mod[0] == SETTING_ROW && cfg.ch == ch);
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
        check("GLO again in the menu: back", page == 0);
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
        check("the row names come with the patch (format 33)", m1_drum_name((uint32_t)map, 1, nm) && !strcmp(nm, "SD"));   /* (the TR-808's legends, D-1053) */
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
        {                                                   /* #368: LFO + a white key ties a drum row's hit too (a Drum map row
                                                             * stays up while its note sounds: a Lire plate held) */
            static uint32_t keep[TRACK_NOTES_MAX];
            const uint32_t *ws;
            int keep_n = eng_steps_notes((uint32_t)drums, &ws), i;
            uint32_t y = GRID_Y + GRID_RH * seq_row + GRID_CH - 1u;
            for (i = 0; i < keep_n; i++)
                keep[i] = ws[i];
            if (eng_steps_note((uint32_t)drums, 3, 55))     /* (step 4 empty, so there is a hit on step 3 to tie) */
                eng_steps_toggle((uint32_t)drums, 3, 55, STEP_VEL);
            msg_text[0] = 0;
            panel_held |= 1u << BTN_LFO;
            panel_keys(1u << 6);                            /* LFO + B3: step 4 (index 3) */
            panel_keys(0);
            loop();
            w = eng_steps_note((uint32_t)drums, 2, 55);
            check("LFO + a white key on a drum track: the hit on the step before tied through it, drawn dim",
                  w && ((w >> 6) & 63u) == 1u && !eng_steps_note((uint32_t)drums, 3, 55) && !strcmp(msg_text, MSG_TIED)
                  && px(seq_grid_x(3) + 5u, y) == C_DIM && px(seq_grid_x(3) - 1u, y - 4u) == C_DIM);
            panel_keys(1u << 6);                            /* again: untied */
            panel_keys(0);
            loop();
            w = eng_steps_note((uint32_t)drums, 2, 55);
            check("again on the tied step: untied, the cell empty", w && ((w >> 6) & 63u) == 0u && !strcmp(msg_text, MSG_TIE_OFF)
                  && px(seq_grid_x(3) + 5u, y) != C_DIM && px(seq_grid_x(3) - 1u, y - 4u) == C_BG);
            panel_keys(1u << 6);                            /* tied again, then a plain white key there */
            panel_keys(0);
            panel_held &= ~(1u << BTN_LFO);
            panel_keys(1u << 6);
            panel_keys(0);
            loop();
            w = eng_steps_note((uint32_t)drums, 2, 55);
            check("a white key on a step a tie runs through: the tie cut before it, a hit there",
                  w && ((w >> 6) & 63u) == 0u && eng_steps_note((uint32_t)drums, 3, 55) && px(seq_grid_x(3) + 5u, y) == C_FG);
            {                                               /* the rule of 2026-10-28: LFO + step 16, the row's last hit before it
                                                             * ends there (one press); again: one step; LFO + a hit's own step with
                                                             * nothing before it: NOTHING TO TIE */
                uint32_t n16 = 0, at = 0, k;
                while (seq_white(n16) != 15)
                    n16++;
                for (k = 0; k < 15u; k++)
                    if (eng_steps_note((uint32_t)drums, k, 55))
                        at = k;
                panel_held |= 1u << BTN_LFO;
                panel_keys(1u << n16);
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, at, 55);
                check("LFO + step 16: the row's last hit before it ends on step 16, in one press",
                      w && (w & 63u) + ((w >> 6) & 63u) == 15u && !strcmp(msg_text, MSG_TIED) && px(seq_grid_x(15) + 5u, y) == C_DIM);
                panel_keys(1u << n16);
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, at, 55);
                check("again (its last step): one step", w && ((w >> 6) & 63u) == 0u && !strcmp(msg_text, MSG_TIE_OFF));
                panel_held &= ~(1u << BTN_LFO);
            }
            {                                               /* #384: the row's only hit on step 3. LFO + its own step: a drone
                                                             * (tied round the loop onto itself); again: one step. Tied step by
                                                             * step round the loop back to its step: a drone too */
                static uint32_t row[TRACK_NOTES_MAX];
                const uint32_t *ws2;
                int n2 = eng_steps_notes((uint32_t)drums, &ws2), m2 = 0, j;
                uint32_t len = (uint32_t)seq_len(drums), ym = GRID_Y + GRID_RH * seq_row + 7u, n16 = 0, n2k = 0, dim = 1, c;
                for (j = 0; j < n2; j++)
                    if (((ws2[j] >> 12) & 127u) != 55u)
                        row[m2++] = ws2[j];
                row[m2++] = 2u | 55u << 12 | (uint32_t)STEP_VEL << 19;
                (void)eng_steps_set_notes((uint32_t)drums, row, (uint32_t)m2);
                seq_sync(drums);
                while (seq_white(n16) != 15)
                    n16++;
                while (seq_white(n2k) != 1)
                    n2k++;
                panel_held |= 1u << BTN_LFO;
                panel_keys(1u << 4);                        /* A3: step 3, the hit's own step */
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 2, 55);
                for (c = 0; c < 16u && c < len; c++)
                    if (c != 2u && px(seq_grid_x(c) + 5u, y) != C_DIM)
                        dim = 0;
                check("#384: LFO + a hit's own step with nothing before it: a drone (tied round the loop), every other step dim, its cell marked",
                      w && eng_note_drone(w) && !strcmp(msg_text, MSG_DRONE) && dim && px(seq_grid_x(2) + 5u, y) == C_FG
                      && px(seq_grid_x(2) + 1u, ym) == C_DIM);
                panel_keys(1u << 4);                        /* again: one step */
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 2, 55);
                check("  again: one step (TIE OFF), the mark gone", w && !(w & ENG_NOTE_WRAP) && ((w >> 6) & 63u) == 0u
                      && !strcmp(msg_text, MSG_TIE_OFF) && px(seq_grid_x(2) + 1u, ym) == C_FG && px(seq_grid_x(3) + 5u, y) != C_DIM);
                panel_keys(1u << n16);                      /* step 16, then step 2 across the loop, then its own step 3 */
                panel_keys(0);
                loop();
                panel_keys(1u << n2k);
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 2, 55);
                check("  LFO + step 16, then step 2: tied across the loop point to end on step 2",
                      w && (w & ENG_NOTE_WRAP) && !eng_note_drone(w) && ((w >> 6) & 63u) + 1u == len && !strcmp(msg_text, MSG_TIED)
                      && px(seq_grid_x(0) + 5u, y) == C_DIM && px(seq_grid_x(1) + 5u, y) == C_DIM);
                panel_keys(1u << 4);
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 2, 55);
                check("  then its own step 3: the tie wraps round to it, a drone", w && eng_note_drone(w) && !strcmp(msg_text, MSG_DRONE));
                panel_held &= ~(1u << BTN_LFO);
                panel_keys(1u << 6);                        /* a plain white key on step 4: the drone cut before it, a hit there */
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 2, 55);
                check("  a plain white key on a step the drone runs through: the drone cut before it, a hit there",
                      w && !(w & ENG_NOTE_WRAP) && ((w >> 6) & 63u) == 0u && eng_steps_note((uint32_t)drums, 3, 55));
                panel_keys(1u << 0);                        /* (a plain white key on step 1: a hit there, nothing tied over it) */
                panel_keys(0);
                loop();
                panel_held |= 1u << BTN_LFO;
                panel_keys(1u << 0);                        /* LFO + step 1: the last hit (step 4) tied across the loop to it */
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 3, 55);
                check("  LFO + step 1 with hits after it: the row's last hit tied across the loop point, the hit on step 1 joining it",
                      w && (w & ENG_NOTE_WRAP) && ((w >> 6) & 63u) + 1u == len - 3u + 1u && !eng_steps_note((uint32_t)drums, 0, 55)
                      && !strcmp(msg_text, MSG_TIED));
                panel_held &= ~(1u << BTN_LFO);
            }
            {                                               /* #384, the owner's ruling of 2026-11-04: LFO + FX, no step held, the
                                                             * selected row one drone: its first note holds, the rest go; again an
                                                             * ordinary step; an empty row says so; step record keeps LFO's rest */
                static uint32_t row[TRACK_NOTES_MAX];
                const uint32_t *ws3;
                int n3 = eng_steps_notes((uint32_t)drums, &ws3), m3 = 0, j, mine = 0, other = 0;
                uint32_t r0 = seq_row, note = seq_grid_note(seq_map(), seq_row), before;
                for (j = 0; j < n3; j++)
                    if (((ws3[j] >> 12) & 127u) != note)
                        row[m3++] = ws3[j];
                other = m3;
                row[m3++] = 4u | note << 12 | (uint32_t)STEP_VEL << 19;
                row[m3++] = 9u | 1u << 6 | note << 12 | (uint32_t)ACCENT_VEL << 19;
                row[m3++] = 13u | note << 12 | (uint32_t)STEP_VEL << 19;
                (void)eng_steps_set_notes((uint32_t)drums, row, (uint32_t)m3);
                seq_sync(drums);
                panel_held |= 1u << BTN_LFO;
                tap(BTN_ACC);
                panel_held &= ~(1u << BTN_LFO);
                loop();
                n3 = eng_steps_notes((uint32_t)drums, &ws3);
                for (j = 0; j < n3; j++)
                    mine += ((ws3[j] >> 12) & 127u) == note;
                w = eng_steps_note((uint32_t)drums, 4, note);
                check("#384: LFO + FX on a row of three hits: its first hit a drone, the other two gone (DRONE), the rest of the track kept",
                      w && eng_note_drone(w) && mine == 1 && n3 == other + 1 && !strcmp(msg_text, MSG_DRONE)
                      && px(seq_grid_x(4) + 1u, GRID_Y + GRID_RH * seq_row + 7u) == C_DIM && px(seq_grid_x(9) + 5u, y) == C_DIM);
                panel_held |= 1u << BTN_ACC;                /* FX held first, then LFO: the same */
                tap(BTN_LFO);
                panel_held &= ~(1u << BTN_ACC);
                loop();
                w = eng_steps_note((uint32_t)drums, 4, note);
                check("  FX + LFO again: an ordinary one-step hit on that step (DRONE OFF)", w && !(w & ENG_NOTE_WRAP) && ((w >> 6) & 63u) == 0u
                      && !strcmp(msg_text, MSG_DRONE_OFF));
                {                                           /* a row without notes (the rest of the kit's rows cleared) */
                    uint32_t nr = (r0 + 1u) % ENG_DRUM_ROWS, keepn = 0;
                    static uint32_t kw[TRACK_NOTES_MAX];
                    n3 = eng_steps_notes((uint32_t)drums, &ws3);
                    for (j = 0; j < n3; j++)
                        if (((ws3[j] >> 12) & 127u) != seq_grid_note(seq_map(), nr))
                            kw[keepn++] = ws3[j];
                    (void)eng_steps_set_notes((uint32_t)drums, kw, keepn);
                    seq_sync(drums);
                    seq_row = (uint8_t)nr;
                }
                note = seq_grid_note(seq_map(), seq_row);
                before = (uint32_t)eng_steps_notes((uint32_t)drums, &ws3);
                for (j = 0, mine = 0; j < (int)before; j++)
                    mine += ((ws3[j] >> 12) & 127u) == note;
                check("  (an empty row found)", !mine);
                {
                    panel_held |= 1u << BTN_LFO;
                    tap(BTN_ACC);
                    panel_held &= ~(1u << BTN_LFO);
                    loop();
                    check("  on an empty row: NOTHING TO DRONE, nothing changed", !strcmp(msg_text, MSG_NOTHING_TO_DRONE)
                          && (uint32_t)eng_steps_notes((uint32_t)drums, &ws3) == before);
                }
                seq_row = (uint8_t)r0;
                sr_start(0, -1);                            /* step record: LFO + FX is LFO's rest, no drone */
                msg_text[0] = 0;
                before = sr_k;
                panel_held |= 1u << BTN_ACC;
                tap(BTN_LFO);
                panel_held &= ~(1u << BTN_ACC);
                loop();
                check("  in step record FX + LFO is LFO's rest (the cursor on), no drone", sr_on && sr_k == before + 1u && strcmp(msg_text, MSG_DRONE));
                sr_stop();
                loop();
            }
            (void)eng_steps_set_notes((uint32_t)drums, keep, (uint32_t)keep_n);
            seq_sync(drums);
        }
        panel_keys(1u << 4);
        panel_keys(0);
        tap(BTN_SEQ);
    }

    {                                                       /* the piano roll (#241) on <7PH's PATTERN (melodic, 46..65): 8 pitches
                                                             * x 16 steps, drawn in place; then arming and recording from the keys
                                                             * (#139): REC on the armed track stopped is the roll with REC on (no
                                                             * cursor entry), running a live take */
        static int32_t l[128], r[128];
        static uint32_t keep[TRACK_NOTES_MAX];
        int pat, i, keep_n, pos;
        const uint32_t *w;
        uint32_t before, base, n, all, part;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        check("(<7PH loads: DRUMS, then PATTERN into the Silver Box)", !load("<7PH")
              && eng_steps_count() == 2 && eng_steps_drummap((uint32_t)eng_steps_module(0)) >= 0
              && eng_steps_drummap((uint32_t)eng_steps_module(1)) < 0);
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        pat = eng_steps_module(1);
        keep_n = eng_steps_notes((uint32_t)pat, &w);
        for (i = 0; i < keep_n; i++)
            keep[i] = w[i];
        seq_select(1);
        page_set(PAGE_SEQ);
        later(1500);
        check("SEQ on PATTERN: the roll (no Drum map), on the fixed page of its median A#3 (G#3-D#4), A#3 selected",
              page == PAGE_SEQ && seq_map() < 0 && seq_roll_lo == 56u && seq_row == 5u && seq_grid_note(-1, seq_row) == 58u);
        later(1100);
        check("  the bar names the page's pitches (D-809)", bar_shows("PATTERN" MSG_BAR_ARM " G#3-D#4 P01", C_ACC));
        check("the roll: each pitch's notes on the 16 steps, a 2-step note runs on dim, the C row tinted", roll_shows(pat)
              && px(seq_grid_x(4) + GRID_CW, GRID_Y + GRID_RH * 5u + 5u) == C_DIM);
        check("the markers: over the steps with notes above (F4), under those with notes below (A#2)", marks_ok(pat)
              && px(seq_grid_x(0) + 5u, MARK_DN_Y) == C_DIM && px(seq_grid_x(1) + 5u, MARK_DN_Y) == C_BG);
        check("the names: pitches top down (D#4 .. G#3), the selected one on coral, C4's tinted",
              px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * 5u + 1u) == C_ACC && px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * 3u + 1u) == C_CROW
              && px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * 4u + 1u) == C_BG);
        snap_to(getenv("PANEL_SNAP_ROLL"));

        check("piano roll: keys play, sheet and hint teach playing", seq_play_keys() && !seq_kbd()
              && help_state() == HS_ROLL && !strcmp(seq_grid_text[2], HINT_ROLL));
        for (n = 0; n < 27; n++) {
            mlen = 0;
            int at = mlen;
            uint32_t row = seq_row;
            panel_keys(1u << n);
            check("every piano key sounds its own pitch while held", key_eng[n] == 53u + n + 12 * octave
                  && (key_sounding & (1u << n)) && seq_held < 0 && seq_row == row
                  && sent(at, 0x90u | cfg.ch, key_eng[n], STEP_VEL));
            panel_keys(0);
            check("releasing a piano key stops it without editing", !(key_sounding & (1u << n))
                  && sent(at, 0x80u | cfg.ch, key_eng[n], 0)
                  && eng_steps_notes((uint32_t)pat, &w) == keep_n && !memcmp(w, keep, keep_n * sizeof *w));
        }
        tap(BTN_OCT_UP);
        check("piano roll OCT changes the keys' octave", octave == 1 && seq_pg == 0);
        tap(BTN_OCT_DOWN);
        panel_held |= 1u << BTN_LFO;
        panel_keys(1u << 7);
        panel_keys(0);
        panel_held &= ~(1u << BTN_LFO);
        check("LFO with a piano key does not edit a tie", eng_steps_notes((uint32_t)pat, &w) == keep_n
              && !memcmp(w, keep, keep_n * sizeof *w));
        panel_yield = keys_yield_q;
        kq_edge(7, 1);
        kq_edge(7, 0);
        ui_dirty = 2;
        panel_draw();
        check("piano keys during a redraw play without editing or drawing inside it", kq_r == kq_w && yield_xfers == 0u
              && eng_steps_notes((uint32_t)pat, &w) == keep_n && !memcmp(w, keep, keep_n * sizeof *w));
        panel_yield = 0;
        loop();

        tap(BTN_PLAY);                                      /* the playhead moves on: its two columns */
        for (i = 0; i < 20; i++)
            eng_render(l, r, 128);
        later(1100);
        pos = eng_steps_pos((uint32_t)pat);
        for (i = 0; i < 400 && eng_steps_pos((uint32_t)pat) == pos; i++)
            eng_render(l, r, 128);
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        loop();
        {
            uint32_t xo = seq_grid_x((uint32_t)pos % 16u), xn = seq_grid_x((uint32_t)eng_steps_pos((uint32_t)pat) % 16u);
            all = fb_changed_in(0, 0, 240, 240);
            part = fb_changed_in(xo, GRID_Y, xo + GRID_CW, GRID_TICK_Y + 3u) + fb_changed_in(xn, GRID_Y, xn + GRID_CW, GRID_TICK_Y + 3u);
            printf("      (roll, the playhead a step on: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
            check("roll: the playhead a step on, only its old and new columns redrawn", pos >= 0 && eng_steps_pos((uint32_t)pat) != pos
                  && all > 0u && all == part && lcd_xfers <= 2u * (2u * ENG_DRUM_ROWS + 1u));
        }
        tap(BTN_PLAY);
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);
        ui_dirty = 2;
        loop();
        tap(BTN_HOME);

        base = (uint32_t)(53 + 12 * octave);
        check("the SEQ page armed the track it showed (#395)", m64(eng_arm_mask_get()) == (uint64_t)1 << pat);
        eng_arm_mask(s64(0));                                    /* (WIRED again, for REC held + a black key) */
        panel_held |= 1u << BTN_REC;                        /* REC held + black key 2 (G#3): PATTERN armed, no recording */
        panel_edges(1u << BTN_REC, 0);
        panel_keys(1u << 3);
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("REC held + a black key: the track armed, REC's release records nothing", pat >= 0 && eng_armed() == pat && seq_rec == 0
              && !eng_transport_running() && page == 0u);
        {                                                   /* REC, stopped, on the device page (#395): the transport starts and */
            int at = mlen;                                  /* it records the armed track; the page stays */
            tap(BTN_REC);
            check("REC, stopped: the transport starts (MIDI Start out) and PATTERN records, the device page stays", seq_rec
                  && eng_transport_running() && sent(at, 0xFAu, 0xFFu, 0xFFu) && page == 0u && (E.trk_rec >> E.node[pat].trk & 1u)
                  && !strcmp(msg_text, MSG_REC "PATTERN"));
        }
        check("REC's LED lit on the device page", host_led_mask(fm1_led, 0) >> BTN_REC & 1u);
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);
        for (i = 0; i < 40; i++)
            eng_render(l, r, 128);
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        panel_keys(1u << 0);                                /* F3: a note the track did not have */
        for (i = 0; i < 10; i++)
            eng_render(l, r, 128);
        panel_keys(0);
        eng_render(l, r, 128);
        loop();
        {
            int nn = eng_steps_notes((uint32_t)pat, &w), got = 0;
            for (i = 0; i < nn; i++)
                got |= ((w[i] >> 12) & 127u) == base;
            check("the live take on the device page: the played note in the track", got && (uint32_t)nn == before + 1u);
        }
        ui_dirty = 2;
        loop();
        snap_to(getenv("PANEL_SNAP_TAKE"));
        tap(BTN_SEQ);                                       /* SEQ while recording: the take's track, its keyboard */
        loop();
        check("SEQ while REC records: PATTERN's roll, all keys its keyboard (the hint says so)", page == PAGE_SEQ && seq_trk == 1u
              && seq_kbd() && !strcmp(seq_grid_text[2], HINT_LIVE));
        later(1100);
        check("  its bar: PATTERN REC on red", bar_shows("PATTERN" MSG_BAR_REC " G#3-D#4 P01", C_RED));
        snap_to(getenv("PANEL_SNAP_ROLL_REC"));
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        panel_keys(1u << 2);                                /* a white key (G3): its own pitch, not a step of the selected row */
        for (i = 0; i < 10; i++)
            eng_render(l, r, 128);
        panel_keys(0);
        eng_render(l, r, 128);
        loop();
        {
            int nn = eng_steps_notes((uint32_t)pat, &w), got = 0;
            for (i = 0; i < nn; i++)
                got += ((w[i] >> 12) & 127u) == base + 2u;
            check("  a white key: its own pitch (G3) recorded once into the nearest step", got == 1 && (uint32_t)nn == before + 1u);
        }
        tap(BTN_REC);                                       /* REC again: recording ends, the transport goes on */
        check("REC again: recording off, the transport still runs, the page stays", !seq_rec && eng_transport_running()
              && page == PAGE_SEQ && seq_play_keys() && !seq_kbd() && !(E.trk_rec >> E.node[pat].trk & 1u) && !strcmp(msg_text, MSG_REC_OFF));
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        panel_keys(1u << 8);                                /* black key 4, running, not recording: its row, nothing recorded */
        for (i = 0; i < 10; i++)
            eng_render(l, r, 128);
        panel_keys(0);
        eng_render(l, r, 128);
        loop();
        check("  a black key then: its own pitch played, nothing recorded", key_eng[8] == base + 8u && (uint32_t)eng_steps_notes((uint32_t)pat, &w) == before);
        tap(BTN_REC);                                       /* running: REC records at once */
        check("REC, running: recording again", seq_rec && seq_kbd() && (E.trk_rec >> E.node[pat].trk & 1u));
        enc(1, -1);                                         /* ALGO while recording: the track shown armed, it records instead */
        loop();
        {
            int t0 = eng_steps_module(0);
            check("  ALGO while recording: the track shown is armed and records, the other not, REC goes on", seq_rec && seq_trk == 0u
                  && m64(eng_arm_mask_get()) == (uint64_t)1 << t0 && (E.trk_rec >> E.node[t0].trk & 1u) && !(E.trk_rec >> E.node[pat].trk & 1u));
        }
        enc(1, 1);
        loop();
        check("  ALGO back: PATTERN records again", seq_rec && seq_trk == 1u && (E.trk_rec >> E.node[pat].trk & 1u) && seq_kbd());
        mlen = 0;                                           /* (the MIDI log holds 256 messages; the clock out fills it) */
        {
            int at = mlen;
            tap(BTN_PLAY);                                  /* PLAY stops everything */
            check("PLAY while recording: the transport stops (MIDI Stop out) and recording ends", !seq_rec && !eng_transport_running()
                  && sent(at, 0xFCu, 0xFFu, 0xFFu) && !(E.trk_rec >> E.node[pat].trk & 1u) && page == PAGE_SEQ);
            later(1500);
            check("  the bar says ARM again, not REC (redrawn by the loop)", bar_shows("PATTERN" MSG_BAR_ARM " G#3-D#4 P01", C_ACC));
        }
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);
        loop();
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        panel_keys(1u << 8);
        check("stopped, REC off: a black key plays its own pitch", key_eng[8] == base + 8u && (key_sounding & (1u << 8)));
        panel_keys(0);
        panel_keys(1u << 2);
        panel_keys(0);
        loop();
        check("stopped piano keys never switch steps", eng_steps_notes((uint32_t)pat, &w) == keep_n
              && !memcmp(w, keep, keep_n * sizeof *w));
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);

        panel_held |= 1u << BTN_REC;                        /* REC held + black key 2: PATTERN out of the armed set, the keys wired */
        panel_edges(1u << BTN_REC, 0);
        panel_keys(1u << 3);
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        tap(BTN_PLAY);                                      /* (running: on the SEQ page REC stopped is step record, D-548) */
        tap(BTN_REC);
        check("REC with nothing armed: it still runs, the bar says so, nothing records", seq_rec && eng_transport_running()
              && m64(eng_arm_mask_get()) == 0u && !E.trk_rec && !seq_kbd() && page == PAGE_SEQ && !strcmp(msg_text, MSG_REC_NO_TRACK));
        panel_held |= 1u << BTN_REC;                        /* REC held + black key 2 while recording: PATTERN armed, it records */
        panel_edges(1u << BTN_REC, 0);
        panel_keys(1u << 3);
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("  a track armed while REC is on records from then on (REC goes on)", seq_rec && eng_armed() == pat
              && (E.trk_rec >> E.node[pat].trk & 1u) && seq_kbd());
        tap(BTN_PLAY);
        check("  PLAY: all stopped", !seq_rec && !eng_transport_running() && !E.trk_rec);
        tap(BTN_PLAY);                                      /* a stop from elsewhere (the editor, MIDI Stop) ends recording too */
        tap(BTN_REC);
        check("(recording, running)", seq_rec && eng_transport_running());
        eng_transport(0);
        loop();
        check("the transport stopped from elsewhere: recording ends", !seq_rec && !E.trk_rec);
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        (void)load("SCROUNGE");                             /* the factory Scrounge's VOICE 1: it drives a Drum map, so its grid */
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        check("(Scrounge: a track per row and LEN GLB (D-1056), VOICE 1 first, into its Drum map)", eng_steps_count() == 8 && eng_steps_drummap((uint32_t)eng_steps_module(0)) >= 0);
        seq_select(0);
        page_set(PAGE_SEQ);
        later(1500);
        check("Scrounge's VOICE 1: the drum grid of its map's rows, not the roll", page == PAGE_SEQ && seq_map() >= 0
              && px(4u + GRID_NAME_W - 1u, GRID_Y + 1u) == C_ACC && !strcmp(seq_grid_text[2], HINT_DRUM));
        snap_to(getenv("PANEL_SNAP_SCROUNGE"));
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        (void)load("808 KIT");                              /* (the 808 Kit again for what follows) */
        pv_gen++;
        page = 0;
        screen_idle();
    }

    {                                                       /* #230: no key lost or late while the screen redraws */
        static int32_t l[128], r[128];
        int drums = eng_steps_module(0), map = eng_steps_drummap((uint32_t)eng_steps_module(0)), m0, i, n, got;
        int32_t base = 53 + 12 * octave;
        uint32_t keep[TRACK_NOTES_MAX], keep_n, wk[TRACK_NOTES_MAX], rn, r0;
        const uint32_t *w;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        later(1500);
        E.node[drums].ksrc = 0;                             /* (Main's keys off DRUMS: plain notes, each key its own on MIDI out) */
        mlen = 0;
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
        E.node[drums].ksrc = 1u;                            /* (Main's keys into DRUMS again) */

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
        check("(the SEQ page, a Drum map armed by it (#395), REC on, running)", page == PAGE_SEQ && seq_map() == map && seq_rec
              && eng_transport_running() && eng_steps_pos((uint32_t)drums) >= 0);
        yield_xfers = 0;
        r0 = seq_row;
        th = thru_head;
        kq_edge(8, 1);                                      /* C#4 hit and let go during a full redraw */
        kq_edge(8, 0);
        ui_dirty = 2;
        panel_draw();
        check("a black key's hit during a redraw: heard (through the track, #368), its row picked (#395), nothing drawn from inside",
              seq_row == 3u && thru_heard(th, (uint32_t)drums, rn) && kq_r == kq_w && yield_xfers == 0u);
        (void)r0;
        check("no header_draw left for the redraw's end (a hit leaves the bar)", !ui_yielding && !ui_header_due);
        blocks(4);                                          /* (the engine takes the note, let go: recorded, laid over the track) */
        loop();
        n = eng_steps_notes((uint32_t)drums, &w);
        for (i = 0, got = 0; i < n; i++)
            got += ((w[i] >> 12) & 127u) == rn;
        check("  recorded on its row once the engine took it", got == 1);
        th = thru_head;
        kq_edge(3, 1);                                      /* G#3 (row 2) hit and let go within one pass */
        kq_edge(3, 0);
        keys_poll_q(0);
        check("a hit pressed and let go within one pass: heard, its row picked", seq_row == 1u && thru_heard(th, (uint32_t)drums, seq_row_note(map, 1)));
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
        eng_arm_mask(s64(0));                                    /* (the page armed DRUMS, #395: WIRED again, as REC held + its key
                                                             * leaves it) */
        header_draw();
        ui_dirty = 2;
        later(1500);
        check("(the 808 Kit's DRUMS on the SEQ page, nothing armed)", page == PAGE_SEQ && seq_map() == map && eng_armed() < 0);
        memcpy(base, fb, sizeof base);
        seq_row_name(map, seq_row, row);
        fb_watch_reset();
        held_key(BTN_REC, 1);                               /* REC held + F#3 on a drum track's page: track 1, not a row */
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, 202, 240, 216);
        check("drum track's SEQ page: REC held + black key 1 arms DRUMS, REC's release records nothing",
              eng_armed() == drums && seq_rec == 0 && page == PAGE_SEQ);
        check("the arm: DRUMS ARMED in the bar, the track's line redrawn in place, nothing else, no blink",
              bar_shows("DRUMS" MSG_ARMED, C_FG) && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        later(1500);
        put(want, "DRUMS" MSG_BAR_ARM " P01")[0] = 0;         /* (a drum track's bar: no row, the grid shows it) */
        check("after the message the bar says ARM", bar_shows(want, C_ACC));
        snap_to(getenv("PANEL_SNAP_ARM"));
        fb_watch_reset();
        held_key(BTN_SEQ, 1);                               /* SEQ held + F#3: DRUMS muted */
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, 202, 240, 216);
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
              eng_armed() < 0 && seq_rec == 0 && bar_shows(MSG_NO_TRACK "2", C_FG) && seq_row == r0);
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
        bar = fb_changed_in(0, 0, 240, LK_HH);
        line = fb_changed_in(0, FOOT_Y, 240, 240);
        check("device page: the arm redraws the header's message and the footer (ARM DRUMS) only, no blink",
              eng_armed() == drums && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(LK_HH) == 0
              && on_screen(MSG_FOOT_ARM "DRUMS"));
        fb_watch_reset();
        held_key(BTN_SEQ, 1);
        check("device page: a mute draws only the header's message", eng_steps_muted((uint32_t)drums)
              && fb_changed_in(0, 0, 240, 240) == fb_changed_in(0, 0, 240, LK_HH) && fb_blinked_below(LK_HH) == 0);
        held_key(BTN_SEQ, 1);
        held_key(BTN_REC, 1);
        later(1500);
        check("device page, unmuted and disarmed: as it was", eng_armed() < 0 && !memcmp(base, fb, sizeof base));

        E.node[map].ksrc = 0;                               /* every Drum map off DRUMS: a melodic track, its roll (#241) */
        int map2 = eng_steps_drummap((uint32_t)drums);      /* (the 808 Kit's second map, MT/MC HT/HC CY AC, D-1053) */
        if (map2 >= 0) E.node[map2].ksrc = 0;
        tap(BTN_SEQ);
        eng_arm_mask(s64(0));                                    /* (WIRED again: the page armed it) */
        header_draw();
        ui_dirty = 2;
        later(1500);
        check("(DRUMS a melodic track now: the roll)", page == PAGE_SEQ && seq_map() < 0);
        memcpy(base, fb, sizeof base);
        fb_watch_reset();
        held_key(BTN_REC, 1);
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, 202, 240, 216);
        check("melodic track: REC held + black key 1 arms it, the bar's message and the track's line (ARMED) only, no blink",
              eng_armed() == drums && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        later(1500);
        check("melodic track: the bar says ARM", bar_roll("DRUMS" MSG_BAR_ARM, "P01", C_ACC));
        snap_to(getenv("PANEL_SNAP_ARM_TRACK"));
        fb_watch_reset();
        held_key(BTN_SEQ, 1);
        all = fb_changed_in(0, 0, 240, 240);
        bar = fb_changed_in(0, 0, 240, BAR_H);
        line = fb_changed_in(0, 202, 240, 216);
        check("melodic track: a mute redraws the bar's message and the track's line only, no blink", eng_steps_muted((uint32_t)drums)
              && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        held_key(BTN_SEQ, 1);
        held_key(BTN_REC, 1);
        later(1500);
        check("melodic track, unmuted and disarmed: the page as it was", eng_armed() < 0 && !memcmp(base, fb, sizeof base));
        tap(BTN_SEQ);
        E.node[map].ksrc = 2u + (uint32_t)drums;
        if (map2 >= 0) E.node[map2].ksrc = 2u + (uint32_t)drums;
    }

    {                                                       /* the keys on a Drum map (the owner, 2026-10-23): black keys 1..8 play
                                                             * its rows 1..8 on every page, the white keys nothing; while a melodic
                                                             * listener has the keys all of them play it */
        static int32_t l[128], r[128];
        static const char *const KIT[4] = {"808 Kit", "909 Kit", "<7PH, nothing armed", "<7PH, DRUMS armed"};
        uint32_t kit;
        for (kit = 0; kit < 4u; kit++) {
            char what[96];
            int map, ok = 1, quiet = 1, m0, i;
            uint32_t b, n, kn;
            while (page != 0u && trail_n)
                tap(BTN_HOME);
            if (eng_transport_running())
                tap(BTN_PLAY);
            if (kit < 2u)
                (void)load(kit ? "909 KIT" : "808 KIT");
            else
                (void)load("<7PH");
            page = 0;
            trail_n = 0;
            octave = 0;
            mlen = 0;                                       /* (the MIDI log from here) */
            screen_idle();
            if (kit == 3u)
                held_key(BTN_REC, 1);                       /* REC held + black key 1: DRUMS armed */
            map = eng_keys_drummap();
            if (kit == 2u) {
                check("<7PH, nothing armed: Main's keys reach PATTERN (melodic), no Drum map", map < 0 && eng_armed() < 0);
                for (n = 0; n < 27u; n++) {
                    panel_keys(1u << n);
                    ok &= key_eng[n] == key_note[n] && key_note[n] == 53u + n;
                    panel_keys(0);
                }
                check("<7PH, nothing armed: every key plays its own note, white and black", ok);
                continue;
            }
            if (kit < 2u) {                                 /* DRUMS and its Drum maps inside the kit card (D-1059, #1202 K2): no
                                                             * Drum map or track pages; Main, the kit card (DRUMS' device, driven
                                                             * by its own track, where the patch opens), the Output. The card has
                                                             * DRUMS' LAST STEP and none of its own RATE / SWING rows, which the
                                                             * kit's rate (and shuffle) selectors set through their ranges */
                uint32_t d, g, k, maps = 0, len = 0, held = 0;
                int drums = eng_steps_module(0);
                pages_ensure();
                for (d = 0; d < pg_ndev; d++)
                    maps += pg_dev[d].module >= 0 && (E.node[pg_dev[d].module].type == T_DRUMMAP || E.node[pg_dev[d].module].type == T_STEPS);
                for (g = 0; g < pg_dev[1].npg; g++)
                    for (k = 0; k < pg_page[pg_dev[1].pg0 + g].nrows; k++) {
                        const ppage_t *pg = &pg_page[pg_dev[1].pg0 + g];
                        len += pg->mod[k] == (uint32_t)drums && pg->par[k] == STEPS_P_LEN;
                        held += pg->mod[k] == (uint32_t)drums && (pg->par[k] == STEPS_P_RATE || pg->par[k] == STEPS_P_SWING);
                    }
                snprintf(what, sizeof what, "%s: one device, the kit card with DRUMS inside, driven by its own track", KIT[kit]);
                check(what, maps == 0u && pg_ndev == 3u && pg_dev[1].module < 0 && pg_dev[1].track == 1u && pg_dev[1].nmem > 0u
                      && pg_track_mod(1) == drums && env_track_no(1) == 0 && pages_home() == 1u);
                snprintf(what, sizeof what, "%s: the card has DRUMS' LAST STEP, not its RATE or SWING", KIT[kit]);
                check(what, len == 1u && held == 0u);
            }
            snprintf(what, sizeof what, "%s: the keys reach the drum track's Drum map", KIT[kit]);
            check(what, map >= 0 && map == eng_steps_drummap((uint32_t)eng_steps_module(0)) && (kit < 3u || eng_armed() == eng_steps_module(0)));
            if (map < 0)
                continue;
            for (b = 0; b < ENG_DRUM_ROWS; b++) {
                for (n = 0; seq_black(n) != (int)b; n++)
                    ;
                m0 = mlen;
                panel_keys(1u << n);
                for (i = 0; i < 3; i++)
                    eng_render(l, r, 128);
                ok &= (inst_pool[E.node[map].inst0].s.dm.gate >> b & 1u) && key_eng[n] == (uint32_t)eng_drummap_note((uint32_t)map, b)
                      && sent(m0, 0x90u, (uint32_t)eng_drummap_note((uint32_t)map, b), 100u) && mlen == m0 + 1;
                panel_keys(0);
                for (i = 0; i < 3; i++)
                    eng_render(l, r, 128);
                ok &= inst_pool[E.node[map].inst0].s.dm.gate == 0 && sent(m0, 0x80u, (uint32_t)eng_drummap_note((uint32_t)map, b), 0u) && mlen == m0 + 2;
            }
            snprintf(what, sizeof what, "%s: black keys 1..8 play rows 1..8 (the device page), MIDI out the rows' notes", KIT[kit]);
            check(what, ok);
            {
                uint8_t km[ENG_DRUM_LIST], kr[ENG_DRUM_LIST];
                kn = eng_keys_rows(km, kr);
                kn = kn < DRUM_KEYS ? kn : DRUM_KEYS;       /* (the black keys that play a row, D-520) */
            }
            for (n = 0; n < 27u; n++) {
                if (seq_black(n) >= 0 && seq_black(n) < (int)kn)
                    continue;
                m0 = mlen;
                panel_keys(1u << n);
                for (i = 0; i < 3; i++)
                    eng_render(l, r, 128);
                quiet &= inst_pool[E.node[map].inst0].s.dm.gate == 0 && key_eng[n] == KEY_SILENT && mlen == m0;
                panel_keys(0);
                quiet &= mlen == m0;
            }
            snprintf(what, sizeof what, "%s: white keys and the black keys past its rows play nothing, on MIDI out too", KIT[kit]);
            check(what, quiet);
            if (kit == 0u) {                                /* the map repeats its rows (#184): those keys play their own note */
                uint32_t rows = 0;
                ok = 1;
                eng_set_param((uint32_t)map, DRUMMAP_P_REPEAT, ENG_ONE);
                for (n = 0; n < 27u; n++) {
                    if (seq_black(n) >= 0 && seq_black(n) < (int)kn)
                        continue;
                    m0 = mlen;
                    panel_keys(1u << n);
                    for (i = 0; i < 3; i++)
                        eng_render(l, r, 128);
                    rows |= inst_pool[E.node[map].inst0].s.dm.gate;
                    ok &= inst_pool[E.node[map].inst0].s.dm.gate != 0 && key_eng[n] == key_note[n] && sent(m0, 0x90u, key_note[n], 100u);
                    panel_keys(0);
                    for (i = 0; i < 3; i++)
                        eng_render(l, r, 128);
                    ok &= inst_pool[E.node[map].inst0].s.dm.gate == 0;
                }
                eng_set_param((uint32_t)map, DRUMMAP_P_REPEAT, 0);
                check("808 Kit, its Drum map's repeat on: every other key plays a row (its own note on MIDI out), all eight rows reached", ok && rows == 0xFFu);
            }
            octave = 2;                                     /* at any octave: black key 2 is row 2 */
            panel_keys(1u << 3);
            for (i = 0; i < 3; i++)
                eng_render(l, r, 128);
            ok = inst_pool[E.node[map].inst0].s.dm.gate == 2u && sent(mlen - 1, 0x90u, (uint32_t)eng_drummap_note((uint32_t)map, 1), 100u);
            panel_keys(0);
            octave = 0;
            tap(BTN_ENV);                                   /* the environment: the same */
            panel_keys(1u << 4 | 1u << 8);                  /* (A3 white, C#4 black key 4) */
            for (i = 0; i < 3; i++)
                eng_render(l, r, 128);
            ok &= page == PAGE_ENV && inst_pool[E.node[map].inst0].s.dm.gate == 8u;
            panel_keys(0);
            tap(BTN_ENV);
            snprintf(what, sizeof what, "%s: the same at another octave and on the environment page", KIT[kit]);
            check(what, ok);
            for (i = 0; i < 3; i++)
                eng_render(l, r, 128);
            eng_note_on((uint32_t)eng_drummap_note((uint32_t)map, 2), ENG_ONE, 1);  /* MIDI in: by note number, as before */
            for (i = 0; i < 3; i++)
                eng_render(l, r, 128);
            snprintf(what, sizeof what, "%s: a MIDI note still plays the row of its note", KIT[kit]);
            check(what, inst_pool[E.node[map].inst0].s.dm.gate == 4u);
            eng_note_off((uint32_t)eng_drummap_note((uint32_t)map, 2), 1);
            if (kit == 3u) {
                held_key(BTN_REC, 1);
                check("<7PH: DRUMS disarmed, Main's keys back on PATTERN", eng_armed() < 0 && eng_keys_drummap() < 0);
            }
        }
    }

    {                                                       /* the drum grid (the owner, 2026-10-23): every row on the page's 16
                                                             * steps; a hit, a step or a row pick redraws only what changed */
        static int32_t l[128], r[128];
        static uint32_t keep[TRACK_NOTES_MAX];
        const uint32_t *w;
        int drums, map, i, pos, ok = 1, keep_n, steps, k;
        uint32_t row, st, n, all, part, r0, x, y;
        int32_t len0;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        (void)load("808 KIT");
        page = 0;
        trail_n = 0;
        screen_idle();
        drums = eng_steps_module(0);
        map = eng_steps_drummap((uint32_t)drums);
        keep_n = eng_steps_notes((uint32_t)drums, &w);
        for (i = 0; i < keep_n; i++)
            keep[i] = w[i];
        seq_row = 0;                                        /* (row 1 selected) */
        tap(BTN_SEQ);
        later(1500);
        check("(the 808 Kit's DRUMS on the SEQ page: the grid)", page == PAGE_SEQ && seq_map() == map && seq_row == 0);
        pos = eng_steps_pos((uint32_t)drums);
        for (row = 0; row < ENG_DRUM_ROWS; row++)
            for (st = 0; st < 16u; st++) {
                uint32_t hw = eng_steps_note((uint32_t)drums, st, seq_row_note(map, row));
                uint16_t want = !hw ? ((int)st == pos ? C_HINT : (st & 3u) ? C_TRACK : C_BEAT) : ((hw >> 19) & 127u) == ACCENT_VEL ? C_ACC : C_FG;
                ok &= px(seq_grid_x(st) + 5u, GRID_Y + GRID_RH * row + GRID_CH - 1u) == want;
            }
        check("the grid: each row's hits on the 16 steps (ivory, accents coral), the rest the panel colour", ok);
        ok = 1;
        for (row = 0; row < ENG_DRUM_ROWS; row++)
            ok &= px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * row + 1u) == (row == seq_row ? C_ACC : C_BG);
        check("the row names at the left, the selected one on coral", ok);
        snap_to(getenv("PANEL_SNAP_GRID"));

        r0 = seq_row;                                       /* a row pick, stopped: black key 3 (A#3) */
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        th = thru_head;
        panel_keys(1u << 5);
        panel_keys(0);
        loop();
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(4, GRID_Y + GRID_RH * r0, 4 + GRID_NAME_W, GRID_Y + GRID_RH * r0 + FONT_S.h)
             + fb_changed_in(4, GRID_Y + GRID_RH * 2u, 4 + GRID_NAME_W, GRID_Y + GRID_RH * 2u + FONT_S.h);
        printf("      (a row pick: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("black key 3, stopped: row 3 picked (heard); only its name and the last one's redrawn, no blink",
              seq_row == 2u && thru_heard(th, (uint32_t)drums, seq_row_note(map, 2)) && all > 0u && all == part && fb_blinked() == 0
              && lcd_px <= 2u * GRID_NAME_W * FONT_S.h);
        fb_watch_reset();                                   /* SELECT, no step held: the row (the owner, 2026-10-23) */
        lcd_px = lcd_xfers = 0;
        enc(0, 1);
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(4, GRID_Y + GRID_RH * 2u, 4 + GRID_NAME_W, GRID_Y + GRID_RH * 2u + FONT_S.h)
             + fb_changed_in(4, GRID_Y + GRID_RH * 3u, 4 + GRID_NAME_W, GRID_Y + GRID_RH * 3u + FONT_S.h);
        printf("      (SELECT a row on: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("SELECT: the next row, only the two names redrawn", seq_row == 3u && all > 0u && all == part && fb_blinked() == 0
              && lcd_px <= 2u * GRID_NAME_W * FONT_S.h);
        enc(0, 20);
        check("SELECT past the last row: the list's last (clamped, no wrap), the grid on its bank (D-521)",
              seq_rl_first() + seq_row == seq_rl_n - 1u && seq_rl_first() == (seq_rl_n - 1u) / ENG_DRUM_ROWS * ENG_DRUM_ROWS);
        enc(0, -20);
        check("SELECT back past the first: the first, the first bank", seq_row == 0u && seq_rl_first() == 0u);
        for (k = 0; k < 16 && !eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 0)); k++)
            ;                                               /* a kick step: held, SELECT is still its chance */
        for (n = 0; seq_white(n) != k; n++)
            ;
        panel_keys(1u << n);
        loop();
        enc(0, -2);
        {
            uint32_t hw = eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 0));
            check("a step held + SELECT: its chance (90 %), the row stays", seq_row == 0u && hw && ((hw >> 26) & 31u) == 2u);
        }
        panel_keys(0);
        loop();
        check("  let go after the turn: the hit stays (the owner's 1.9.0 device check: a used step switches nothing)",
              eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 0)) != 0);
        panel_keys(1u << n);                                /* held with nothing done: the hit stays while held, off when let go */
        loop();
        check("a drum step held: its hit stays while the key is down", eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 0)) != 0);
        panel_keys(0);
        loop();
        check("  let go with nothing done: off", !eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 0)));
        panel_keys(1u << n);                                /* (on again, as it was, its chance 100 %) */
        panel_keys(0);
        loop();
        enc(0, 2);                                          /* (row 3 again) */
        for (k = 0; k < 16 && eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 2)); k++)
            ;                                               /* a step without the clap */
        for (n = 0; seq_white(n) != k; n++)
            ;
        x = seq_grid_x((uint32_t)k);
        y = GRID_Y + GRID_RH * 2u;
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        panel_keys(1u << n);
        panel_keys(0);
        loop();
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(x, y, x + GRID_CW, y + GRID_CH);
        printf("      (a step: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("a white key: the selected row's hit on its step, that cell alone redrawn (ivory)", eng_steps_note((uint32_t)drums, (uint32_t)k, seq_row_note(map, 2))
              && all > 0u && all == part && lcd_px <= GRID_CW * GRID_CH && px(x + 5u, y + GRID_CH - 1u) == C_FG);
        panel_held |= 1u << BTN_ACC;                        /* FX + the same key: its accent */
        panel_keys(1u << n);
        panel_keys(0);
        panel_held &= ~(1u << BTN_ACC);
        loop();
        check("FX + a white key: an accent, coral", px(x + 5u, y + GRID_CH - 1u) == C_ACC);
        panel_keys(1u << n);                                /* (off again: FX off, plain) */
        panel_keys(0);
        loop();

        tap(BTN_PLAY);                                      /* REC, running: hits */
        tap(BTN_REC);
        for (i = 0; i < 20; i++)
            eng_render(l, r, 128);
        loop();
        later(1100);
        for (row = 0; row < ENG_DRUM_ROWS; row++) {         /* a row with no hits (the 808's rim) */
            for (st = 0; st < 16u && !eng_steps_note((uint32_t)drums, st, seq_row_note(map, row)); st++)
                ;
            if (st == 16u)
                break;
        }
        for (n = 0; seq_black(n) != (int)row; n++)
            ;
        seq_row = (uint8_t)row;                             /* (the row picked first: the hit redraws its cell alone) */
        ui_dirty = ui_dirty ? ui_dirty : 1;
        loop();
        r0 = seq_row;
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        panel_keys(1u << n);
        panel_keys(0);
        blocks(2);                                          /* (#368: the engine records it when let go) */
        loop();
        steps = 0;
        for (st = 0; st < 16u; st++)
            if (eng_steps_note((uint32_t)drums, st, seq_row_note(map, row)))
                k = (int)st, steps++;
        x = seq_grid_x((uint32_t)k);
        y = GRID_Y + GRID_RH * row;
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(x, y, x + GRID_CW, y + GRID_CH);
        printf("      (a hit while recording: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("REC on, running: a hit lands on its row's nearest step; that cell alone redrawn, the bar stays",
              row < ENG_DRUM_ROWS && seq_rec && steps == 1 && seq_row == r0 && all > 0u && all == part && lcd_px <= GRID_CW * GRID_CH
              && fb_changed_in(0, 0, 240, BAR_H) == 0u);
        {                                               /* #368 (the owner, 2026-10-28): a black key held over steps while REC
                                                         * records: one note on its row lasting the whole steps held; its Drum map
                                                         * row stays up while held */
            const uint32_t *ws2;
            uint32_t sl = (uint32_t)steps_inst((uint32_t)drums)->s.stp.slen, j, before = 0, after = 0, longest = 0;
            uint8_t up;
            int nn2 = eng_steps_notes((uint32_t)drums, &ws2);
            for (j = 0; j < (uint32_t)nn2; j++)
                before += ((ws2[j] >> 12) & 127u) == seq_row_note(map, row);
            panel_keys(1u << n);
            blocks(3u * sl / 128u + 2u);                    /* (three steps and a bit held) */
            up = inst_pool[E.node[map].inst0].s.dm.gate;
            panel_keys(0);
            blocks(2);
            loop();
            nn2 = eng_steps_notes((uint32_t)drums, &ws2);
            for (j = 0; j < (uint32_t)nn2; j++)
                if (((ws2[j] >> 12) & 127u) == seq_row_note(map, row)) {
                    after++;
                    if (((ws2[j] >> 6) & 63u) + 1u > longest)
                        longest = ((ws2[j] >> 6) & 63u) + 1u;
                }
            printf("      (held over three steps: recorded %u steps long; a step %u samples)\n", (unsigned)longest, (unsigned)sl);
            check("REC on, running: a black key held over steps records one note on its row, the whole steps held (3)",
                  after == before + 1u && longest >= 3u && longest <= 4u);
            check("  its Drum map row stays up while the key is held", (up >> row & 1u) != 0);
        }
        {                                               /* #395: a black key on another row while recording picks that row too */
            uint32_t other = row ? 0u : 1u, on;
            for (on = 0; seq_black(on) != (int)other; on++)
                ;
            panel_keys(1u << on);
            panel_keys(0);
            blocks(2);
            loop();
            check("REC on: a black key on another row records there and picks that row", seq_rec && seq_row == other);
            seq_row = (uint8_t)r0;
            ui_dirty = ui_dirty ? ui_dirty : 1;
            loop();
        }
        enc(0, 1);                                          /* SELECT with REC on: the row too */
        check("REC on: SELECT picks the next row", seq_rec && seq_row == (r0 + 1u < ENG_DRUM_ROWS ? r0 + 1u : r0));
        pos = eng_steps_pos((uint32_t)drums);               /* the playhead moves on: its two columns */
        for (i = 0; i < 400 && eng_steps_pos((uint32_t)drums) == pos; i++)
            eng_render(l, r, 128);
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        loop();
        {
            uint32_t xo = seq_grid_x((uint32_t)pos % 16u), xn = seq_grid_x((uint32_t)eng_steps_pos((uint32_t)drums) % 16u);
            all = fb_changed_in(0, 0, 240, 240);
            part = fb_changed_in(xo, GRID_Y, xo + GRID_CW, GRID_TICK_Y + 3u) + fb_changed_in(xn, GRID_Y, xn + GRID_CW, GRID_TICK_Y + 3u);
            printf("      (the playhead a step on: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
            check("the playhead a step on: only its old and new columns redrawn", eng_steps_pos((uint32_t)drums) != pos && all > 0u && all == part
                  && lcd_xfers <= 2u * (2u * ENG_DRUM_ROWS + 1u));
        }
        tap(BTN_REC);
        check("REC off: the page stays, the transport goes on", seq_rec == 0u && page == PAGE_SEQ && eng_transport_running());
        tap(BTN_PLAY);

        len0 = eng_get_param((uint32_t)drums, STEPS_P_LEN);   /* a track of 32: OCT+ its second page */
        eng_set_param((uint32_t)drums, STEPS_P_LEN, 32 << 16);
        ui_dirty = 2;
        loop();
        check("a track of 32: the hint names OCT for steps 17 and up (#490)", !strcmp(seq_grid_text[2], HINT_DRUM_LONG));
        {                                                   /* a step held: the hint line names its knobs, let go: back (#450) */
            uint32_t wk;
            for (wk = 0; seq_white(wk) != 0; wk++)
                ;
            panel_keys(1u << wk);
            loop();
            check("a step held: the hint says HELD and its knobs", seq_held == 0 && !strcmp(seq_grid_text[2], HINT_HELD_DRUM));
            panel_keys(0);
            loop();
            check("  let go: the hint as before", seq_held < 0 && !strcmp(seq_grid_text[2], HINT_DRUM_LONG));
        }
        tap(BTN_OCT_UP);
        ok = seq_pg == 1u && octave == 0;
        for (row = 0; row < ENG_DRUM_ROWS; row++)
            for (st = 0; st < 16u; st++)
                ok &= px(seq_grid_x(st) + 5u, GRID_Y + GRID_RH * row + GRID_CH - 1u)
                      == (eng_steps_note((uint32_t)drums, 16u + st, seq_row_note(map, row)) ? C_FG : (st & 3u) ? C_TRACK : C_BEAT);
        check("a track of 32: OCT+ shows steps 17-32 (the octave stays)", ok);
        tap(BTN_OCT_DOWN);
        check("OCT-: steps 1-16 again", seq_pg == 0u);
        eng_set_param((uint32_t)drums, STEPS_P_LEN, len0);
        (void)eng_steps_set_notes((uint32_t)drums, keep, (uint32_t)keep_n);
        seq_sync(drums);
        tap(BTN_SEQ);
        later(1500);
    }

    {                                                       /* #395 (the owner, 2026-10-28): REC is global, it never changes the
                                                             * page; what records is the armed Steps tracks */
        static int32_t l[128], r[128];
        int drums, map, i, n0, n1;
        const uint32_t *w;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        (void)load("<7PH");                                  /* DRUMS, PATTERN */
        page = 0;
        trail_n = 0;
        screen_idle();
        drums = eng_steps_module(0);
        map = eng_steps_drummap((uint32_t)drums);
        seq_trk = 1;                                        /* (PATTERN selected last) */
        tap(BTN_REC);
        check("REC, nothing armed (wired): the transport runs, REC is on, the page stays, the bar says nothing records",
              page == 0u && seq_rec && eng_transport_running() && !E.trk_rec && !strcmp(msg_text, MSG_REC_NO_TRACK));
        tap(BTN_PLAY);
        check("PLAY: the transport and REC stopped", !seq_rec && !eng_transport_running());
        page_set(PAGE_ENV);                                 /* REC on the environment: the same (D-238 retired) */
        loop();
        tap(BTN_REC);
        check("REC on the environment: the transport runs, REC on, the environment stays", page == PAGE_ENV && seq_rec
              && eng_transport_running());
        tap(BTN_REC);
        check("  REC again: REC off, the transport goes on", page == PAGE_ENV && !seq_rec && eng_transport_running());
        tap(BTN_PLAY);
        tap(BTN_HOME);
        seq_trk = 0;
        tap(BTN_SEQ);                                       /* DRUMS' grid (the page arms it), stopped, REC off */
        check("(DRUMS' grid, armed by the page, stopped)", page == PAGE_SEQ && seq_trk == 0u && seq_map() == map
              && eng_armed() == drums && !seq_rec && !eng_transport_running());
        n0 = eng_steps_notes((uint32_t)drums, &w);
        th = thru_head;
        panel_keys(1u << 3);                                /* black key 2, stopped: heard, its row picked, nothing recorded */
        panel_keys(0);
        blocks(4);
        loop();
        check("stopped, REC off: a black key is heard and picks its row, nothing recorded", thru_heard(th, (uint32_t)drums, seq_row_note(map, 1))
              && seq_row == 1u && eng_steps_notes((uint32_t)drums, &w) == n0);
        panel_keys(1u << 3);                                /* #368: held, stopped: its row stays up until let go */
        blocks(40);
        {
            uint8_t up = inst_pool[E.node[map].inst0].s.dm.gate;
            panel_keys(0);
            blocks(2);
            check("a black key held there, stopped: its Drum map row up while held, down when let go, nothing recorded",
                  (up >> 1 & 1u) && !(inst_pool[E.node[map].inst0].s.dm.gate >> 1 & 1u) && eng_steps_notes((uint32_t)drums, &w) == n0);
        }
        enc(0, 1);                                          /* SELECT: the next row, silently */
        th = thru_head;
        blocks(2);
        check("SELECT moves the row and sounds nothing", seq_row == 2u && thru_head == th);
        tap(BTN_HOME);
        tap(BTN_REC);                                       /* stopped, from the device page: the transport starts, a take on DRUMS */
        check("(REC, DRUMS armed, stopped: the transport runs and DRUMS records, the device page stays)", page == 0u && seq_rec
              && eng_transport_running() && (E.trk_rec >> E.node[drums].trk & 1u) && !strcmp(msg_text, MSG_REC "DRUMS"));
        for (i = 0; i < 20; i++)
            eng_render(l, r, 128);
        n0 = eng_steps_notes((uint32_t)drums, &w);
        for (i = n1 = 0; i < n0; i++)
            n1 += ((w[i] >> 12) & 127u) == seq_row_note(map, 6);
        panel_keys(1u << 15);                               /* G#4: black key 7, the rim's row */
        for (i = 0; i < 10; i++)
            eng_render(l, r, 128);
        panel_keys(0);
        eng_render(l, r, 128);
        loop();
        {
            int n = eng_steps_notes((uint32_t)drums, &w), got = 0;
            for (i = 0; i < n; i++)
                got += ((w[i] >> 12) & 127u) == seq_row_note(map, 6);
            check("the live take: black key 7 recorded as row 7's note", seq_black(15) == 6 && got == n1 + 1);
        }
        {                                                   /* the count-in (#414): MENU > PANEL > COUNT-IN; the bars count
                                                             * from the transport's start (eng_run_ticks) */
            int32_t rel;
            uint32_t guard;
            tap(BTN_REC);                                   /* REC off, the transport runs on */
            cfg.count_in = 1;
            tap(BTN_REC);                                   /* running: REC on, the count-in begins at the next bar line */
            check("COUNT-IN 1 BAR, REC while running: REC on, the count-in runs, nothing records yet, the bar says COUNT-IN",
                  seq_rec && seq_cin && !E.trk_rec && !strcmp(msg_text, MSG_COUNT_IN) && eng_transport_running());
            for (guard = 0; seq_cin == 1u && guard < 10u; guard++) {
                eng_render(l, r, 128);
                loop();
            }
            rel = eng_run_ticks();
            check("  it ends on the bar line a bar after the next one", seq_cin == 2u && seq_cin_end % 96u == 0u
                  && seq_cin_end > (uint32_t)rel + 96u && seq_cin_end <= (uint32_t)rel + 192u);
            for (guard = 0; seq_cin && seq_cin_end - (uint32_t)eng_run_ticks() > 96u - 25u && guard < 100000u; guard++) {
                eng_render(l, r, 128);
                loop();
            }
            check("  beat 2 of the count: the bar says COUNT-IN 2, nothing records", seq_cin == 2u && !strcmp(msg_text, MSG_COUNT_IN " 2") && !E.trk_rec);
            check("  REC's LED on the device page: on in the beat's first half", (host_led_mask(fm1_led, 0) >> BTN_REC & 1u) == ((uint32_t)(eng_run_ticks() - (int32_t)(seq_cin_end - 96u)) % 24u < 12u));
            n0 = eng_steps_notes((uint32_t)drums, &w);
            th = thru_head;
            panel_keys(1u << 15);                           /* G#4 during the count: heard through DRUMS, not recorded */
            blocks(10);
            panel_keys(0);
            blocks(2);
            loop();
            check("  a key played during the count-in sounds through the track and is not recorded", thru_heard(th, (uint32_t)drums, seq_row_note(map, 6))
                  && eng_steps_notes((uint32_t)drums, &w) == n0 && !E.trk_rec);
            for (guard = 0; seq_cin && guard < 100000u; guard++) {
                eng_render(l, r, 128);
                loop();
            }
            rel = eng_run_ticks();
            check("  at the bar line: the count-in ends, DRUMS records, the bar names it", !seq_cin && seq_rec && (E.trk_rec >> E.node[drums].trk & 1u)
                  && !strcmp(msg_text, MSG_REC "DRUMS") && rel >= 0 && (uint32_t)rel % 96u < 2u);
            tap(BTN_REC);
            tap(BTN_PLAY);
            blocks(1);                                      /* (the engine takes the stop: a start within the same block is
                                                             * none to it, and the tracks' bars go on from the old start) */
            cfg.count_in = 2;
            tap(BTN_REC);                                   /* stopped: the transport starts, two bars of count-in from its start */
            check("COUNT-IN 2 BARS, REC while stopped: the transport starts, the count-in runs from its start", seq_rec && seq_cin
                  && eng_transport_running() && !E.trk_rec);
            for (guard = 0; seq_cin == 1u && guard < 10u; guard++) {
                eng_render(l, r, 128);
                loop();
            }
            check("  it ends 192 ticks after the start", seq_cin == 2u && seq_cin_end == 192u);
            for (guard = 0; seq_cin && eng_run_ticks() < 24 * 5 + 1 && guard < 100000u; guard++) {
                eng_render(l, r, 128);
                loop();
            }
            check("  bar 2, beat 2: the bar says COUNT-IN 2.2", seq_cin == 2u && !strcmp(msg_text, MSG_COUNT_IN " 2.2"));
            tap(BTN_REC);
            check("  REC again during the count-in: REC off, nothing recorded, the transport goes on", !seq_rec && !seq_cin && !E.trk_rec
                  && eng_transport_running() && !strcmp(msg_text, MSG_REC_OFF));
            tap(BTN_REC);
            check("  REC once more: a new count-in", seq_rec && seq_cin);
            tap(BTN_PLAY);
            check("  PLAY during the count-in: all stopped, nothing recorded", !seq_rec && !seq_cin && !eng_transport_running() && !E.trk_rec);
            {                                               /* (D-803 amended 2026-11-07: REC's count-in clicks as play
                                                             * once's, on the analog output only) */
                uint32_t on = 0, onsets = 0, hi = 0, first = 0xFFFFFFFFu;
                blocks(1);                                  /* (the engine takes the stop) */
                cfg.count_in = 2;
                tap(BTN_REC);                               /* stopped: the transport starts, two bars from its start */
                for (guard = 0; seq_cin && guard < 100000u; guard++) {
                    int32_t c[128], d[128];
                    uint32_t j;
                    int32_t rt;
                    eng_render(l, r, 128);
                    rt = eng_run_ticks();
                    for (j = 0; j < 128u; j++)
                        c[j] = l[j], d[j] = r[j];
                    if (eng_click_mix(c, d, 128)) {
                        for (j = 0; j < 128u; j++) {
                            uint32_t a = (uint32_t)(c[j] - l[j] < 0 ? l[j] - c[j] : c[j] - l[j]);
                            hi = a > hi ? a : hi;
                        }
                        if (!on) {
                            onsets++;
                            first = first == 0xFFFFFFFFu ? (uint32_t)rt : first;
                        }
                        on = 1;
                    } else
                        on = 0;
                    loop();
                }
                check("COUNT-IN 2 BARS: REC's count-in clicks on each beat, 8 from the transport's start, a quarter of full scale, on the analog output only",
                      onsets == 8u && first <= 1u && hi >= 16000u && hi <= 16400u);
                printf("      (REC's count-in: %u clicks, the first %u ticks after the start)\n", (unsigned)onsets, (unsigned)first);
                blocks(12);
                {
                    int32_t c[128], d[128];
                    eng_render(c, d, 128);
                    check("  after the count-in: no click, REC records", !eng_click_mix(c, d, 128) && seq_rec && !seq_cin);
                }
                tap(BTN_REC);                               /* (REC off) */
            }
            cfg.count_in = 0;
            tap(BTN_REC);
            check("COUNT-IN OFF: REC records at once", seq_rec && !seq_cin && (E.trk_rec >> E.node[drums].trk & 1u) && !strcmp(msg_text, MSG_REC "DRUMS"));
        }
        tap(BTN_PLAY);
        held_key(BTN_REC, 1);
        check("(disarmed, stopped)", eng_armed() < 0 && !eng_transport_running() && seq_rec == 0u);
        while (page != 0u && trail_n)
            tap(BTN_HOME);
    }
    {                                                       /* play once (#632): SEQ held + PLAY counts in a bar with a click,
                                                             * plays the pattern once and stops by itself */
        static int32_t l[128], r[128];
        uint32_t guard, i, beats = 0, peak = 0, raw = 0, t0, run_ticks;
        int m0;
        (void)load("808 KIT");
        page_show(0);
        loop();
        m0 = mlen;
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        check("SEQ held + PLAY, stopped: play once counts in (COUNT-IN 1), the transport stays stopped, no Start yet",
              eng_once_state() == 1 && !eng_transport_running() && !strcmp(msg_text, MSG_COUNT_IN " 1") && !sent(m0, 0xFAu, 0xFFu, 0xFFu));
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  PLAY's and SEQ's releases do nothing of their own: still counting in, the page stays", eng_once_state() == 1 && page == 0u);
        for (guard = 0; eng_once_state() == 1 && guard < 4000u; guard++) {
            eng_render(l, r, 128);
            for (i = 0; i < 128u; i++)                      /* (eng_render's: what USB audio takes) */
                raw = (uint32_t)(l[i] < 0 ? -l[i] : l[i]) > raw ? (uint32_t)(l[i] < 0 ? -l[i] : l[i]) : raw;
            eng_click_mix(l, r, 128);                       /* (the analog output's, audio.c) */
            for (i = 0; i < 128u; i++)
                peak = (uint32_t)(l[i] < 0 ? -l[i] : l[i]) > peak ? (uint32_t)(l[i] < 0 ? -l[i] : l[i]) : peak;
            fm1_ms += 3;
            loop();
            if (!strncmp(msg_text, MSG_COUNT_IN " ", sizeof MSG_COUNT_IN) && msg_text[sizeof MSG_COUNT_IN] >= '1'
                && msg_text[sizeof MSG_COUNT_IN] <= '4')   /* (COUNT-IN and a space: sizeof's place for the NUL) */
                beats |= 1u << (msg_text[sizeof MSG_COUNT_IN] - '1');
        }
        check("  the count-in's click is on the analog output (a quarter of full scale), not on USB audio (D-820)", peak >= 16000u && peak <= 16400u && raw == 0u);
        check("  the bar counts the beats, COUNT-IN 1 to COUNT-IN 4", beats == 15u);
        t0 = eng_ticks();
        check("  after the bar: the transport runs, the bar says PLAY ONCE", eng_once_state() == 2 && eng_transport_running() && !strcmp(msg_text, MSG_PLAY_ONCE));
        for (guard = 0; eng_transport_running() && guard < 4000u; guard++) {
            eng_render(l, r, 128);
            loop();
        }
        run_ticks = eng_ticks() - t0;
        printf("      (the 808 Kit's pattern played once in %u ticks)\n", (unsigned)run_ticks);
        check("  the pattern played once, then the transport stopped by itself", !eng_transport_running() && eng_once_state() == 0
              && run_ticks >= 90u && run_ticks <= 100u);
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_PLAY);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        blocks(100);
        loop();
        m0 = mlen;
        tap(BTN_PLAY);
        blocks(2);
        loop();
        check("PLAY during the count-in: play once ends, all stopped, no Stop sent (nothing had started)", eng_once_state() == 0
              && !eng_transport_running() && !sent(m0, 0xFCu, 0xFFu, 0xFFu));
        tap(BTN_PLAY);
        check("(PLAY: running)", eng_transport_running());
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_PLAY);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        check("SEQ held + PLAY while running: it stops, as PLAY", !eng_transport_running() && eng_once_state() == 0 && page == 0u);
    }
    {                                                       /* #170, the owner's design (2026-10-24): PRESET grows the footer
                                                             * into a toast (the slot, the name, the filled slots), the new
                                                             * patch's page drawn around it at once */
        static uint16_t staged[240 * 240];
        uint32_t i, n;
        int main;
        char slot_label[8];
        fmt_int(slot_label, (int32_t)preset_at("<7PH") + 1);
        put(slot_label + str_len(slot_label), ".")[0] = 0;
        bank_mask = ((uint64_t)1 << N_PRESETS) - 1u;
        (void)load("909 KIT");
        cur_preset = preset_at("<7PH") - 1u;               /* the 909 Kit, then <7PH */
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        later(2000);
        preset_loads = 1;
        lcd_px = 0;
        patch_enc(1);
        check("PRESET: the next patch, its slot and name in the footer's toast, its page around it", cur_preset == preset_at("<7PH")
              && !strcmp(patch_label, "<7PH") && on_screen("<7PH") && on_screen(slot_label) && toast_scr != 0u
              && px(0, 240u - LK_TOH) == P_SAND && px(0, 239u - LK_TOH) != P_SAND && K1_TAB == KNOB_HUE[0]);
        printf("      LCD pixels for one PRESET click: %u\n", lcd_px);
        snap_to(getenv("PANEL_SNAP_PATCH"));
        memcpy(staged, fb, sizeof staged);
        ui_dirty = 2;
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += staged[i] != fb[i];
        check("PRESET's staged page is the page drawn whole", n == 0u);
        fb_watch_reset();
        later(300);
        check("a beat's redraw under it leaves it be", fb_blinked() == 0);
        cur_preset = N_PRESETS - 1u;                        /* (the last slot: the next click wraps to the first) */
        stop_n = 0;
        stop_answer = 1;                                    /* PRESET turning fast: a newer click waits */
        pages_waiting = stop_probe;
        lcd_px = 0;
        patch_enc(1);
        printf("      LCD pixels for a PRESET click while the next one waits: %u\n", lcd_px);
        check("PRESET turning fast: the next name, only the toast drawn", cur_preset == 0 && !strcmp(patch_label, "MONOLITH D")
              && on_screen("MONOLITH D") && lcd_px == 240u * LK_TOH);
        stop_answer = 0;
        loop();
        pages_waiting = 0;
        fb_watch_reset();
        lcd_px = 0;
        later(1100);
        printf("      LCD pixels for the toast's end: %u\n", lcd_px);
        check("the toast ends: only its band drawn again, the footer and the bars under it", toast_scr == 0u
              && fb_changed_in(0, 0, 240, 240u - LK_TOH) == 0u && lcd_px <= 240u * LK_TOH && px(0, 239) == P_SAND
              && px(0, 240u - LK_TOH) != P_SAND && on_screen("MONOLITH D"));
        memcpy(staged, fb, sizeof staged);
        ui_dirty = 2;
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += staged[i] != fb[i];
        check("  then the page drawn whole, pixel for pixel", n == 0u);
        main = eng_find(T_FM1);
        panel_held |= 1u << BTN_PLAY;                       /* PLAY held + PRESET: the tempo, no patch, no toast */
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 1);
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("PLAY held + PRESET: the tempo, the patch and the bars stay", main >= 0 && cur_preset == 0
              && K1_TAB != P_NIGHT && !toast_wanted());
        patch_enc(-1);
        enc(0, 1);                                          /* SELECT while it shows: the toast goes */
        check("SELECT during it: the toast gone, the footer back", !toast_wanted() && toast_scr == 0u
              && px(0, 240u - LK_TOH) != P_SAND);
        later(1100);
        preset_loads = 0;
    }

    {                                                       /* sandbox mode: the editor's Live paused (its patch is a sandbox
                                                             * patch): the FM-1 muted, the editor's page drawn as a device page
                                                             * (D-232, D-234), PRESET held */
        uint32_t slot = cur_preset, y, x, gold, i, n;
        int stepped = presets_stepped, from, pn, panel = eng_find(T_FM1), run;
        int32_t bpm0 = panel >= 0 ? eng_get_param((uint32_t)panel, FM1_P_TEMPO) : 0;
        uint32_t dev0, page0, edited0 = m1_edited;
        sb_page_t pg;
        uint8_t d[SB_BYTES + SB_EXT_BYTES];
        static uint16_t whole[240u * 240u];
#define SB_FOOT_GOLD (px(2, FOOT_Y + 1u) == P_GOLD && px(120, FOOT_Y + 1u) == P_GOLD)
        page = 0;
        trail_n = 0;
        screen_idle();
        later(2000);
        preset_loads = 1;
        info_told = 0;
        pages_ensure();
        dev0 = pg_cur_dev;
        page0 = pg_cur_page;
        m1_live(1);                                         /* LIVE paused: sandbox mode */
        check("LIVE paused: sandbox mode, the FM-1 muted", sb_on && snd_muted && !sb_have);
        check("  the MIDI OUT setting told once (INFO)", info_told == 1);
        loop();
        for (gold = 0, y = 70; y < 100u; y++)
            for (x = 0; x < 240u; x++)
                gold += px(x, y) == P_GOLD;
        check("  the screen: the card (no bars yet), the device page's header (no gold band), the gold footer", gold > 30u
              && K1_TAB == P_NIGHT && px(4, 4) != P_GOLD && SB_FOOT_GOLD && on_screen(MSG_SANDBOX) && on_screen(MSG_FOOT_OCT));
        from = mlen;
        pn = param_now;
        enc(2, 3);                                          /* K1..K4 before the first page: nothing moves (D-232) */
        enc(5, -2);
        enc(0, 1);                                          /* SELECT, ALGO: out as MIDI only */
        enc(1, 1);
        check("  K1..K4 before the editor's first page: no CC 16..19, the FM-1's patch untouched (not edited), its focus kept",
              !sent(from, 0xB0u, 16u, 0u) && mlen == from + 2 && param_now == pn && m1_edited == edited0 && pg_cur_dev == dev0
              && pg_cur_page == page0 && K1_TAB == P_NIGHT);
        msg_text[0] = 0;
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 2);                                          /* PLAY held + PRESET before a page: no tempo known here */
        panel_held &= ~(1u << BTN_PLAY);
        run = eng_transport_running();
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("  PLAY held + PRESET before the first page: SANDBOX: TEMPO IN EDITOR, the muted patch's tempo kept, no start",
              !strcmp(msg_text, MSG_SANDBOX_TEMPO) && (panel < 0 || eng_get_param((uint32_t)panel, FM1_P_TEMPO) == bpm0)
              && eng_transport_running() == run && m1_edited == edited0);
        later(1600);
        m1_live(1);                                         /* (Live goes on: every 2 s) */
        m1_live(1);                                         /* every 2 s again */
        check("  LIVE paused again: no INFO", info_told == 1);
        {                                                   /* an older editor's page (SANDBOX up to its rows), through sb_parse */
            uint32_t k;
            static const char *const LAB[4] = {"Cutoff", "Res", "Wave", ""};
            memset(d, 0, sizeof d);
            d[0] = 7;                                       /* rows 1..3 */
            d[1] = 2;
            d[2] = 5;
            memcpy(d + 3, "SOL 29N XL", 10);
            memcpy(d + 3 + SB_PATCH, "Sol filter", 10);
            memcpy(d + 3 + SB_PATCH + SB_DEV, "FILTER 1/2", 10);
            for (k = 0; k < 3u; k++) {
                uint8_t *r = d + SB_HEAD_BYTES + k * SB_ROW_BYTES;
                memcpy(r, LAB[k], strlen(LAB[k]));
                memcpy(r + SB_LABEL, k == 2u ? "SAW" : "2.40", k == 2u ? 3 : 4);
                if (k == 0u)
                    memcpy(r + SB_LABEL + SB_VALUE, "kHz", 3);
                r[SB_LABEL + SB_VALUE + SB_UNIT] = k == 0u ? 128u : k == 1u ? 255u : 0u;
                r[SB_LABEL + SB_VALUE + SB_UNIT + 1u] = k == 2u ? 3u : 0u;   /* Wave: three choices */
            }
            check("SANDBOX parses (and a short one does not); an older editor's: no fields after the rows, the group's pages"
                  " from its title", sb_parse(d, SB_BYTES, &pg) == 0 && sb_parse(d, SB_BYTES - 1u, &pg) < 0
                  && pg.rows == 7u && pg.index == 2u && pg.count == 5u && !strcmp(pg.patch, "SOL 29N XL") && !strcmp(pg.dev, "Sol filter")
                  && !strcmp(pg.label[0], "Cutoff") && !strcmp(pg.unit[0], "kHz") && pg.pos[0] == 128u && pg.steps[2] == 3u
                  && !pg.ext && pg.npage == 2u && pg.page_at == 0u && pg.ndev == 0u && pg.ngroup == 0u && pg.tempo == 0u);
        }
        m1_sandbox(&pg);
        loop();
        for (gold = 0, x = 0; x < 240u; x++)                /* the device's dash row: none from an older editor */
            gold += px(x, LK_HH - 6u) == P_GOLD;
        check("the page from an older editor: the device page's header (device, group without 1/2), its bars (K4 empty), the"
              " gold footer with SANDBOX and no tempo", sb_have && K1_TAB != P_NIGHT && px(BAR_X + 2u, row_y(3) + 2u) == P_STRIP
              && px(4, 4) != P_GOLD && on_screen("SOL FILTER") && on_screen("FILTER") && !on_screen("FILTER 1/2")
              && !on_screen("3/5") && !on_screen("SOL 29N XL") && on_screen(MSG_SANDBOX) && on_screen("--") && !on_screen(MSG_KEYS_WIRED)
              && SB_FOOT_GOLD && gold == 0u);
        check("  K1 half way: its fill to the middle", px(BAR_X + BAR_W / 2u - 8u, row_y(0) + 4u) != px(BAR_X + BAR_W / 2u + 8u, row_y(0) + 4u));
        msg_text[0] = 0;
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 1);
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("  PLAY held + PRESET from an older editor (no tempo sent): SANDBOX: TEMPO IN EDITOR", !strcmp(msg_text, MSG_SANDBOX_TEMPO));
        later(1600);
        m1_live(1);                                         /* (Live goes on: every 2 s) */
        {                                                   /* the same page from a 1.8 editor: the fields after the rows */
            uint8_t *e = d + SB_BYTES;
            e[0] = 5;                                       /* the third of five devices */
            e[1] = 2;
            e[2] = 3;                                       /* its second group of three */
            e[3] = 1;
            e[4] = 2;                                       /* the group's first page of two */
            e[5] = 0;
            e[6] = 128;                                     /* 128 bpm */
            e[7] = 0;
            e[8] = SB_UNSAVED;
            e[9] = e[10] = e[11] = e[12] = 0;               /* nothing armed: the keys wired */
            check("SANDBOX with the fields after the rows parses them", sb_parse(d, sizeof d, &pg) == 0 && pg.ext && pg.ndev == 5u
                  && pg.dev_at == 2u && pg.ngroup == 3u && pg.group_at == 1u && pg.npage == 2u && pg.page_at == 0u && pg.tempo == 128u
                  && pg.flags == SB_UNSAVED && pg.armed == 0u);
        }
        m1_sandbox(&pg);
        loop();
        for (gold = 0, x = 0; x < 240u; x++)
            gold += px(x, LK_HH - 6u) == P_GOLD;
        check("  drawn: the device's dashes (the current gold), the tempo, SANDBOX * (unsaved edits), KEYS WIRED", gold > 4u
              && on_screen("128") && on_screen(MSG_SANDBOX_EDITED) && on_screen(MSG_KEYS_WIRED) && SB_FOOT_GOLD);
        memcpy(whole, fb, sizeof whole);
        ui_dirty = 2;
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += whole[i] != fb[i];
        check("  the page drawn in place is the page drawn whole, pixel for pixel", n == 0u);
        {                                                   /* the editor moves on: another group, a row, the tempo, saved, armed */
            d[SB_BYTES + 3] = 2;
            d[SB_BYTES + 4] = 1;
            d[SB_BYTES + 6] = 140;
            d[SB_BYTES + 8] = 0;
            d[SB_BYTES + 9] = 4;
            memcpy(d + 3 + SB_PATCH + SB_DEV, "AMP\0\0\0\0\0\0\0", 10);
            memcpy(d + SB_HEAD_BYTES + SB_LABEL, "9.99", 4);
            d[SB_HEAD_BYTES + SB_LABEL + SB_VALUE + SB_UNIT] = 30u;
            (void)sb_parse(d, sizeof d, &pg);
        }
        m1_sandbox(&pg);
        loop();
        check("  the next page: its group, the new tempo, SANDBOX alone (saved, a device armed)", on_screen("AMP") && on_screen("140")
              && on_screen(MSG_SANDBOX) && !on_screen(MSG_SANDBOX_EDITED) && !on_screen(MSG_KEYS_WIRED) && on_screen("9.99"));
        memcpy(whole, fb, sizeof whole);
        ui_dirty = 2;
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += whole[i] != fb[i];
        check("  in place after it, again the page drawn whole", n == 0u);
        memcpy(d + 3 + SB_PATCH + SB_DEV, "FILTER 1/2", 10);   /* (back to the filter page for what follows) */
        memcpy(d + SB_HEAD_BYTES + SB_LABEL, "2.40", 4);
        d[SB_HEAD_BYTES + SB_LABEL + SB_VALUE + SB_UNIT] = 128u;
        d[SB_BYTES + 3] = 1;
        d[SB_BYTES + 4] = 2;
        d[SB_BYTES + 6] = 128;
        d[SB_BYTES + 8] = SB_UNSAVED;
        d[SB_BYTES + 9] = 0;
        (void)sb_parse(d, sizeof d, &pg);
        m1_sandbox(&pg);
        loop();
        from = mlen;
        msg_text[0] = 0;
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        run = eng_transport_running();
        enc(6, 3);                                          /* PLAY held + PRESET: the editor's tempo (D-232) */
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("PLAY held + PRESET in sandbox mode: PRESET's CC out, TEMPO 131 shown, the muted patch's tempo and binary"
              " untouched, PLAY's release starts nothing", sent(from, 0xB0u, CC_PRESET, 3u) && !strcmp(msg_text, MSG_TEMPO "131")
              && (panel < 0 || eng_get_param((uint32_t)panel, FM1_P_TEMPO) == bpm0) && m1_edited == edited0
              && eng_transport_running() == run);
        m1_sandbox(&pg);                                    /* the editor's page, not yet with the new tempo: 131 stays a moment */
        check("  an echo right after keeps 131", sb.tempo == 131u);
        later(1100);
        m1_live(1);
        check("  the footer shows 131", on_screen("131"));
        d[SB_BYTES + 6] = 131;
        (void)sb_parse(d, sizeof d, &pg);
        m1_sandbox(&pg);
        loop();
        check("  the editor's 131 then", sb.tempo == 131u && on_screen("131"));
        from = mlen;
        pn = param_now;
        enc(2, 1);                                          /* K1: one click from the editor's position (128 = CC 64) */
        check("K1 in sandbox mode: CC 16 one up from the editor's position, the FM-1's patch untouched",
              sent(from, 0xB0u, 16u, 65u) && param_now == pn && sb_cc[0] == 65u);
        from = mlen;
        enc(4, 1);                                          /* K3 on a row of three choices: the next one */
        check("K3 on three choices: CC 18 a choice up (64)", sent(from, 0xB0u, 18u, 64u));
        from = mlen;
        enc(3, 1);                                          /* K2 at its end: nothing to send */
        enc(5, 1);                                          /* K4: no row */
        check("K2 at its end, K4 with no row: no CC", mlen == from);
        memcpy(whole, fb, sizeof whole);
        ui_dirty = 2;
        loop();
        for (i = 0, n = 0; i < 240u * 240u; i++)
            n += whole[i] != fb[i];
        check("  the bars turned in place are the page drawn whole", n == 0u);
        pg.pos[0] = 10u;                                    /* the editor's page brings K1's old position back at once: */
        m1_sandbox(&pg);                                    /* the turn here wins for a moment */
        check("  an echo right after a turn keeps the turned position", sb_cc[0] == 65u);
        later(SB_ECHO_MS + 10u);
        m1_sandbox(&pg);
        check("  later the editor's position counts", sb_cc[0] == (10u * 127u + 127u) / 255u);
        from = mlen;
        tap(BTN_SEQ);                                       /* SEQ: out as MIDI only */
        check("SEQ in sandbox mode: its CC goes out, the page stays", sent(from, 0xB0u, 89u, 127u) && page == 0u && sb_on);
        later(1600);
        m1_live(1);                                         /* (Live goes on: every 2 s) */
        tap(BTN_GLO);                                       /* GLO: the menu (MIDI OUT is there) */
        check("GLO in sandbox mode: the menu", page == PAGE_MENU);
        tap(BTN_HOME);
        check("  HOME: back to the sandbox page", page == 0u && SB_FOOT_GOLD && K1_TAB != P_NIGHT);
        check("  the screen as text: the sandbox page, as a device page", on_screen(MSG_SANDBOX) && on_screen(MSG_FOOT_OCT)
              && on_screen("SOL FILTER") && !on_screen(MSG_BROWSER_PLAYS));
        loop();
        check("  the battery in the footer, night on gold", px(BATT_FX, BATT_FY) == P_NIGHT && px(BATT_FX - 2u, BATT_FY) == P_GOLD);
        tap(BTN_OCT_UP);
        check("  OCT+: the footer's octave", on_screen(MSG_FOOT_OCT_UP "+"));
        tap(BTN_OCT_DOWN);
        from = mlen;
        panel_keys(1u);                                     /* a key: the note goes out (the FM-1 itself is muted) */
        panel_keys(0u);
        loop();
        check("a key in sandbox mode: its note out", sent(from, 0x90u, (uint32_t)(53 + 12 * octave), 100u));
        enc(6, 1);
        check("PRESET in sandbox mode: no slot change, SANDBOX: PATCH STAYS", cur_preset == slot
              && presets_stepped == stepped && !strcmp(msg_text, MSG_SANDBOX_PATCH_STAYS));
        later(1600);
        m1_live(1);                                         /* (Live goes on: every 2 s) */
        check("  the message ends: the device page's header again", px(4, 4) != P_GOLD && on_screen("SOL FILTER"));
        cfg.midi_out = 0;                                   /* MIDI OUT off on the GLO page: the editor hears of it */
        m1_live(1);
        ui_dirty = 2;
        loop();
        check("MIDI OUT off: INFO again; the footer stays SANDBOX on gold", info_told == 2 && SB_FOOT_GOLD && !fb_has_hue(FOOT_Y, P_WARN));
        msg_text[0] = 0;
        enc(2, 1);
        check("  K1 with MIDI OUT off: the header says how to turn it on", !strcmp(msg_text, MSG_MIDI_OUT_OFF));
        later(1600);
        msg_text[0] = 0;
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 1);
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("  PLAY held + PRESET with MIDI OUT off: the same nudge, the tempo kept", !strcmp(msg_text, MSG_MIDI_OUT_OFF)
              && sb.tempo == 131u);
        later(1600);
        cfg.midi_out = 1;
        m1_live(1);
        msg_text[0] = 0;
        m1_live(0);                                         /* the patch fits again: Live resumes */
        loop();
        check("LIVE not paused: sandbox mode ends, the sound and the device page back", !sb_on && !snd_muted
              && px(2, FOOT_Y + 1u) == P_SAND && K1_TAB != P_NIGHT && msg_text[0] == 0);
        m1_sandbox(&pg);
        check("  a page after it: not taken", !sb_have);
        patch_enc(-1);
        check("PRESET under Live (resumed): still held, EDITOR LIVE: PATCH STAYS", cur_preset == slot
              && presets_stepped == stepped && !strcmp(msg_text, MSG_LIVE_PATCH_STAYS));
        later(1600);
        loop();
        msg_text[0] = 0;                                    /* (the 1.10 early check: HOME still held, the bar says it) */
        panel_held |= 1u << BTN_HOME;
        panel_edges(1u << BTN_HOME, 0);
        enc(6, 1);
        loop();
        check("  HOME still held: the header shows EDITOR LIVE: PATCH STAYS, the patch stays", cur_preset == slot
              && !strcmp(msg_text, MSG_LIVE_PATCH_STAYS) && on_screen(MSG_LIVE_PATCH_STAYS));
        panel_held &= ~(1u << BTN_HOME);
        panel_edges(0, 1u << BTN_HOME);
        loop();
        later(1600);
        m1_live(1);                                         /* over the budget once more */
        check("LIVE paused after a resume: sandbox mode again", sb_on && snd_muted);
        later(LIVE_HOLD_MS + 100u);                          /* no LIVE for 5 s (a closed tab): the sound and PRESET are free */
        check("Live lapsed: sandbox mode ends", !sb_on && !snd_muted);
        patch_enc(1);
        check("Live lapsed: PRESET steps again", presets_stepped == stepped + 1 && cur_preset != slot);
        later(1600);
        tap(BTN_SEQ);                                       /* the SEQ page up (its steps may run) when the patch goes over */
        check("SEQ without sandbox mode: the SEQ page", page == PAGE_SEQ);
        m1_live(1);
        loop();
        check("sandbox mode begun on the SEQ page: the sandbox page comes up at once", sb_on && page == 0u && SB_FOOT_GOLD);
        m1_live(0);
        loop();
        tap(BTN_GLO);
        m1_live(1);
        loop();
        check("  begun on GLO (the menu): the menu stays", sb_on && page == PAGE_MENU);
        tap(BTN_HOME);
        m1_live(0);
        loop();
        preset_loads = 0;
#undef SB_FOOT_GOLD
    }

    {                                                       /* #240: the battery (ui.c ui_battery; main.c feeds SARADC ch 3 every 2 s) */
        uint32_t i, all, cell;
        char v[24];
        int ok;
        page = 0;
        trail_n = 0;
        screen_idle();
        later(3000);
        check("host builds start full (BATT_START 900): 3 bars in the footer's battery", batt_shown() == 3u && batt_drawn == 3u
              && BPX(2, 2) == P_NIGHT && BPX(8, 2) == P_NIGHT && BPX(4, 2) == P_SAND);
        batt_q16 = 0;                                       /* (not read yet) */
        ui_battery(600, 0);
        ok = batt_raw() == 600;
        ui_battery(520, 0);
        ok = ok && batt_raw() == 580;                       /* a quarter of the way per reading */
        for (i = 0; i < 30u; i++)
            ui_battery(520, 0);
        check("smoothing: the first reading as it is, then a quarter of the way each", ok && batt_raw() >= 520 && batt_raw() <= 523);
        ui_battery(-1, 0);
        check("a timed-out conversion (-1) changes nothing", batt_raw() >= 520 && batt_raw() <= 523);
        {
            static const int32_t RAW[] = {520, 531, 533, 534, 560, 561, 563, 564, 590, 593, 594, 1023, 591, 590, 561, 560, 531, 530};
            static const uint8_t LVL[] = {0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 2, 2, 1, 1, 0};
            ok = 1;
            for (i = 0; i < sizeof RAW / sizeof RAW[0]; i++) {
                batt_q16 = RAW[i] * 16;                     /* (the smoothed value itself: one reading of the same) */
                ui_battery(RAW[i], 0);
                if (batt_lvl != LVL[i]) {
                    printf("      (raw %d: level %u, not %u)\n", RAW[i], batt_lvl, LVL[i]);
                    ok = 0;
                }
            }
            check("levels 0..3 at the stock thresholds 531 / 561 / 591, 3 counts of hysteresis on the way up", ok);
        }
        batt_q16 = 600 * 16;
        ui_battery(600, 0);
        loop();
        later(3100);                                        /* (the LOW BATTERY the readings under 531 gave: ended) */
        fb_watch_reset();
        lcd_xfers = 0;
        ui_battery(598, 0);                                 /* another reading, the same level */
        loop();
        check("the same level: nothing drawn", lcd_xfers == 0u && fb_changed_in(0, 0, 240, 240) == 0u);
        batt_q16 = 570 * 16;
        ui_battery(570, 0);                                 /* 2 bars */
        loop();
        all = fb_changed_in(0, 0, 240, 240);
        cell = fb_changed_in(BATT_FX, BATT_FY, BATT_FX + 13u, BATT_FY + 6u);
        check("a level change: the battery alone, a transfer a row, no blink", lcd_xfers == 6u && all > 0u && all == cell
              && fb_blinked() == 0 && BPX(8, 2) == P_SAND && BPX(5, 2) == P_NIGHT);
        batt_q16 = 540 * 16;
        ui_battery(540, 0);
        loop();
        check("one bar", BPX(2, 2) == P_NIGHT && BPX(5, 2) == P_SAND);
        page_set(PAGE_MENU);
        ui_dirty = 2;
        loop();
        check("the menu's MIDI tab: the battery in its footer too", BPX(2, 2) == P_NIGHT && BPX(5, 2) == P_SAND && px(4, 4) == P_CORAL);
        page_set(0);
        ui_dirty = 2;
        loop();
        check("  back on the device page: the same", BPX(2, 2) == P_NIGHT && BPX(5, 2) == P_SAND);
        msg_text[0] = 0;                                    /* (a marker: a new message fills it) */
        batt_q16 = 520 * 16;
        ui_battery(520, 0);                                 /* under 531: LOW BATTERY */
        later(10);
        check("under the lowest threshold: LOW BATTERY over the header, the battery's outline red",
              !strcmp(msg_text, MSG_LOW_BATTERY) && bar_shows(MSG_LOW_BATTERY, C_FG) && BPX(0, 0) == P_WARN && BPX(2, 2) == P_SAND);
        later(3100);
        check("  the message gone: the header again", px(4, 4) != C_FG && BPX(0, 0) == P_WARN);
        later(3100);
        msg_text[0] = 0;
        ui_battery(518, 0);
        later(2000);
        ui_battery(515, 0);
        later(10);
        check("LOW BATTERY once: not again while it stays low", msg_text[0] == 0);
        ui_battery(515, 1);                                 /* a USB host: external power, a bolt */
        loop();
        check("USB power: the bolt, no message", msg_text[0] == 0 && batt_shown() == BATT_USB
              && BPX(5, 1) == P_NIGHT && BPX(1, 1) == P_SAND && BPX(0, 0) == P_NIGHT);
        ui_battery(515, 0);                                 /* unplugged, still low: says so again */
        later(10);
        check("USB gone while low: LOW BATTERY again", !strcmp(msg_text, MSG_LOW_BATTERY));
        later(3100);
        batt_q16 = 600 * 16;
        ui_battery(600, 0);
        loop();
        menu_value(MR_BATT, v);
        check("MENU > INFO > BATTERY: the reading and its bars", !strcmp(v, "600  3/3"));
        ui_battery(600, 1);
        menu_value(MR_BATT, v);
        check("... USB on it", !strcmp(v, "600  USB"));
        ui_battery(600, 0);
        {
            uint8_t tab = menu_tab;
            uint32_t n = 0, outside = 0, y0 = MENU_Y + info_pos(MR_BATT) * MENU_PITCH;
            page_set(PAGE_MENU);
            menu_tab = MT_INFO;
            ui_dirty = 2;
            loop();
            check("INFO: its five rows fit above the hint", MENU_Y + INFO_N * MENU_PITCH <= 220u);
            fb_watch_reset();
            ui_battery(560, 0);                             /* 600 -> 590: 3 bars to 2, the value changes */
            loop();
            for (i = 0; i < 240u * 240u; i++) {
                uint32_t x = i % 240u, y = i / 240u;
                int in = (x >= 150u && x < 228u && y >= y0 + MENU_TXT && y < y0 + MENU_TXT + 18u);
                n += fb_changes[i] != 0u;
                outside += fb_changes[i] != 0u && !in;
            }
            menu_value(MR_BATT, v);
            check("INFO idle, a new reading: only its value redrawn (the menu has no battery), no blink", n > 0u && outside == 0u
                  && fb_blinked() == 0 && !strcmp(v, "590  2/3"));
            menu_tab = tab;
            screen_back();
            loop();
        }
        snap_to(getenv("PANEL_SNAP_BATTERY"));
    }

    {   /* ARP on a factory patch's Arpeggiator (D-231): its LED dark while the arpeggiator is bypassed (as saved), lit while
         * it plays; another Toggle keeps its rule (lit = its target bypassed) */
        uint32_t m, arp = 0xFFu;
        check("(Monolith D loads)", load("MONOLITH D") == 0);
        loop();
        for (m = 0; m < 64u; m++)
            if (eng_type(m) == T_ARP)
                arp = m;
        check("Monolith D: an Arpeggiator, saved bypassed; ARP's Toggle engaged, its LED dark", arp != 0xFFu && eng_bypass(arp)
              && (eng_buttons_get() >> 6 & 1u) && !(eng_buttons_lit() >> 6 & 1u));
        tap(10);
        check("ARP pressed: the arpeggiator plays, ARP lit", !eng_bypass(arp) && (eng_buttons_lit() >> 6 & 1u) && !(eng_buttons_get() >> 6 & 1u));
        tap(10);
        check("ARP again: bypassed, dark", eng_bypass(arp) && !(eng_buttons_lit() >> 6 & 1u));
        check("(the other buttons' LEDs as their state)", (eng_buttons_lit() & 0x3Fu) == (eng_buttons_get() & 0x3Fu));
        check("Monolith D: the keys play notes (no Drum map on the black keys)", eng_keys_drummap() < 0);
        check("8 Lire through the arpeggiator, Scrounge's tracks straight: they play their Drum maps, the black keys the rows",
              load("8 LIRE") == 0 && eng_keys_drummap() >= 0 && load("SCROUNGE") == 0 && eng_keys_drummap() >= 0);
    }

    {                                                       /* #231: SEQ held + REC clears the selected track, asked first */
        static uint32_t keep[TRACK_NOTES_MAX];
        const uint32_t *w;
        int kit, mod, keep_n, i, n;
        for (kit = 0; kit < 2; kit++) {
            const char *what = kit ? "<7PH's PATTERN (the roll)" : "the 808 Kit's DRUMS (the grid)";
            char want[32], name[TRACK_NAME_MAX + 8];
            uint32_t all, bar;
            while (page != 0u && trail_n)
                tap(BTN_HOME);
            if (eng_transport_running())
                tap(BTN_PLAY);
            if (kit)
                (void)load("<7PH");
            else
                (void)load("808 KIT");
            pv_gen++;
            page = 0;
            trail_n = 0;
            screen_idle();
            seq_select(kit ? 1u : 0u);
            page_set(PAGE_SEQ);
            later(2000);
            mod = seq_module();
            keep_n = eng_steps_notes((uint32_t)mod, &w);
            for (i = 0; i < keep_n; i++)
                keep[i] = w[i];
            seq_name(seq_trk, name);
            printf("      (%s: %d notes)\n", what, keep_n);
            check(kit ? "(<7PH's PATTERN on the SEQ page, notes on it)" : "(the 808 Kit's DRUMS on the SEQ page, hits on it)",
                  page == PAGE_SEQ && keep_n > 0 && (kit ? seq_map() < 0 : seq_map() >= 0));

            panel_held |= 1u << BTN_SEQ;                    /* SEQ held, REC: it asks */
            panel_edges(1u << BTN_SEQ, 0);
            loop();
            tap(BTN_REC);
            put(put(put(want, MSG_CLEAR), name), MSG_REC_AGAIN)[0] = 0;
            printf("      (the bar: \"%s\")\n", msg_text);
            check("SEQ held + REC: the bar asks (CLEAR name? REC AGAIN), nothing cleared, REC not switched on",
                  !strcmp(msg_text, want) && eng_steps_notes((uint32_t)mod, &w) == keep_n && seq_rec == 0u && page == PAGE_SEQ);
            later(SEQ_CLEAR_MS + 100u);                     /* the 3 s run out: REC asks again, it does not clear */
            tap(BTN_REC);
            check("  after 3 s: REC asks again, nothing cleared", !strcmp(msg_text, want) && eng_steps_notes((uint32_t)mod, &w) == keep_n);
            fb_watch_reset();
            lcd_px = lcd_xfers = 0;
            tap(BTN_REC);                                   /* REC again within them: cleared */
            all = fb_changed_in(0, BAR_H, 240, 240);
            bar = fb_changed_in(0, BAR_H, 240, MARK_UP_Y) + fb_changed_in(0, GRID_TICK_Y, 240, 240);   /* (the roll's markers go too) */
            put(put(want, name), MSG_CLEARED)[0] = 0;
            printf("      (cleared: %u LCD transfers, %u pixels; the bar: \"%s\")\n", (unsigned)lcd_xfers, (unsigned)lcd_px, msg_text);
            check(kit ? "  REC again: the roll's notes all gone, its cells cleared in place (no blink, nothing else below the bar)"
                      : "  REC again: the grid's hits all gone, its cells cleared in place (no blink, nothing else below the bar)",
                  eng_steps_notes((uint32_t)mod, &w) == 0 && !strcmp(msg_text, want) && all > 0u && bar == 0u && fb_blinked_below(BAR_H) == 0u
                  && (kit ? roll_shows(mod) && marks_ok(mod) : 1) && seq_rec == 0u);
            {
                uint16_t keep_fb[240 * 240];
                memcpy(keep_fb, fb, sizeof keep_fb);
                ui_dirty = 2;
                loop();
                check("  what it drew is what a whole redraw draws", !memcmp(keep_fb + 240u * BAR_H, fb + 240u * BAR_H, sizeof keep_fb - 480u * BAR_H));
            }
            panel_held &= ~(1u << BTN_SEQ);
            panel_edges(0, 1u << BTN_SEQ);
            loop();
            check("  SEQ let go: the page stays, REC off", page == PAGE_SEQ && seq_rec == 0u && !strcmp(msg_text, want));

            (void)eng_steps_set_notes((uint32_t)mod, keep, (uint32_t)keep_n);   /* a key between: not cleared */
            seq_sync(mod);
            ui_dirty = 2;
            later(2000);
            panel_held |= 1u << BTN_SEQ;
            panel_edges(1u << BTN_SEQ, 0);
            loop();
            tap(BTN_REC);
            for (n = 0; seq_white(n) != 15; n++)            /* (the last white key: a step on, then off again) */
                ;
            panel_keys(1u << n);
            panel_keys(0);
            loop();
            check("  a key while it asks: NOT CLEARED", !strcmp(msg_text, MSG_NOT_CLEARED));
            panel_keys(1u << n);
            panel_keys(0);
            loop();
            (void)eng_steps_set_notes((uint32_t)mod, keep, (uint32_t)keep_n);
            seq_sync(mod);
            tap(BTN_REC);
            check("  then REC asks again, nothing cleared", eng_steps_notes((uint32_t)mod, &w) == keep_n && !strncmp(msg_text, MSG_CLEAR, sizeof MSG_CLEAR - 1u));
            enc(0, 1);
            check("  a knob turned while it asks: NOT CLEARED", !strcmp(msg_text, MSG_NOT_CLEARED));
            enc(0, -1);
            tap(BTN_REC);
            panel_held &= ~(1u << BTN_SEQ);                 /* SEQ let go while it asks: not cleared */
            panel_edges(0, 1u << BTN_SEQ);
            loop();
            check("  SEQ let go while it asks: NOT CLEARED, the page stays", !strcmp(msg_text, MSG_NOT_CLEARED) && page == PAGE_SEQ);
            panel_held |= 1u << BTN_SEQ;
            panel_edges(1u << BTN_SEQ, 0);
            loop();
            tap(BTN_REC);
            check("  held again, REC: it asks again (the first press never clears)", eng_steps_notes((uint32_t)mod, &w) == keep_n && !strncmp(msg_text, MSG_CLEAR, sizeof MSG_CLEAR - 1u));
            panel_held &= ~(1u << BTN_SEQ);
            panel_edges(0, 1u << BTN_SEQ);
            loop();
            tap(BTN_REC);                                   /* REC alone: step record on / off (stopped, D-804) */
            check("  REC alone after it: step record on, nothing cleared", sr_on && !seq_rec && eng_steps_notes((uint32_t)mod, &w) == keep_n);
            tap(BTN_REC);
            (void)eng_steps_set_notes((uint32_t)mod, keep, (uint32_t)keep_n);
            seq_sync(mod);
            later(2000);
        }
        (void)load("808 KIT");
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
    }

    lcd_sync();
    {   /* #298 follow-up: K1..K4 turned in steps both ways, slow and fast, across every page of every factory patch (the
         * values crossing the name and value, the live tick, the hue's edge), with and without the audio's blocks between
         * the clicks and the ten-a-second tick pass: the screen after the bars' redraws in place is the screen drawn whole,
         * pixel for pixel (the owner saw thin ivory stripes left in the bars on 1.3.0-dev) */
        static uint16_t inc[240 * 240];
        static const int32_t TURN[] = {1, 1, 1, -1, -1, 3, -2, 5, 5, -5, 1, -1, 12, -12, 30, -30, 2, -7, 1, 1};
        static int32_t al[128], ar[128];
        uint32_t p, d, g, k, t, i, n, bad = 0, runs = 0, worst = 0, mode, clicks = 0;
        uint64_t click_px = 0;
        uint8_t accel_was = cfg.accel;
        sb_on = 0;
        page = 0;
        cfg.accel = 1;
        for (mode = 0; mode < 3u; mode++)                   /* 0: no audio between clicks, 1: a block before each, 2: some */
            for (p = 0; p < N_PRESETS; p++) {
                if (load_at(p))
                    continue;
                pv_gen++;
                screen_idle();
                for (d = 0; d < pg_ndev; d++)
                    for (g = 0; g < pg_dev[d].npg; g++) {
                        (void)pages_focus(d, g);
                        ui_dirty = 2;
                        loop();
                        for (k = 0; k < pg_page[pg_dev[d].pg0 + g].nrows; k++) {
                            for (t = 0; t < sizeof TURN / sizeof TURN[0]; t++) {
                                if (mode == 1u || (mode == 2u && t % 3u != 2u))
                                    eng_render(al, ar, 128);
                                fm1_ms += (t & 4u) ? 10u : 150u;  /* (fast: within 80 ms, five steps a click) */
                                lcd_px = 0;
                                enc(2u + k, TURN[t]);
                                click_px += lcd_px;
                                clicks++;
                                if (mode == 2u && t % 5u == 4u)
                                    later(120);             /* (the live ticks' pass) */
                                if (t != 9u && t + 1u != sizeof TURN / sizeof TURN[0])
                                    continue;
                                later(120);                 /* (the other rows' live ticks follow the audio) */
                                memcpy(inc, fb, sizeof inc);
                                ui_dirty = 2;
                                loop();
                                runs++;
                                for (i = 0, n = 0; i < 240u * 240u; i++)
                                    n += inc[i] != fb[i];
                                if (n) {
                                    if (bad < 6u) {
                                        for (i = 0; inc[i] == fb[i]; i++)
                                            ;
                                        printf("      (%s device %u page %u K%u, audio %u: %u px differ, the first at %u,%u: %#06x, drawn"
                                               " whole %#06x)\n", PRESET_LIST[p].name, d, g, k + 1u, mode, n, i % 240u, i / 240u, inc[i], fb[i]);
                                    }
                                    bad++;
                                    worst = n > worst ? n : worst;
                                }
                            }
                        }
                    }
            }
        printf("      knob turns: %u compared on %u factory patches, %u differ (worst %u px); %u LCD px a click on average\n",
               runs, (unsigned)N_PRESETS, bad, worst, (unsigned)(click_px / (clicks ? clicks : 1u)));
        check("K1..K4 turned on every factory page: the bars moved in place are the screen drawn whole, pixel for pixel",
              runs > 1000u && bad == 0u);
        cfg.accel = accel_was;
    }
    {   /* #525: a Matrix device's pages are its four outputs (OUT 1..OUT 4, each its own group); each draws the whole 4 x 4
         * grid (page_grid). K1..K4 turn the column's pins; ALGO moves the column; a pin of another column set from the editor
         * shows with the ten-a-second pass. After each, the screen is the screen drawn whole, pixel for pixel */
        static uint16_t inc[240 * 240];
        static int32_t al[128], ar[128];
        static const int32_t TURN[] = {1, 3, -1, 12, -30, 30, 5, -2};
        uint32_t d, g, k, t, i, n, bad = 0, runs = 0, names = 0;
        int mx = -1, turned = 1, grid = 1;
        sb_on = 0;
        page = 0;
        check("Matrix fixture loads", load_fixture("build/panel-fixtures/matrix-audio.m1p") == 0);
        pv_gen++;
        eng_render(al, ar, 128);
        screen_idle();
        pages_ensure();
        for (d = 0; d < pg_ndev; d++)
            if (pg_dev[d].module >= 0 && eng_type((uint32_t)pg_dev[d].module) == T_MATRIX)
                mx = (int)d;
        check("the Matrix is a device of four pages", mx >= 0 && pg_dev[mx].npg == 4u);
        for (g = 0; mx >= 0 && g < pg_dev[mx].npg; g++) {
            const ppage_t *pg = &pg_page[pg_dev[mx].pg0 + g];
            char want[8] = "OUT 1";
            want[4] = (char)('1' + g);
            names += pg->nlen == 5u && !memcmp(pg->name, want, 5) && pg->part == 0u && pg->parts == 1u;
            grid &= page_grid(pg) == (int)g;
            (void)pages_focus((uint32_t)mx, g);
            ui_dirty = 2;
            loop();
            for (k = 0; k < PG_ROWS; k++)
                for (t = 0; t < sizeof TURN / sizeof TURN[0]; t++) {
                    uint32_t mod = (uint32_t)pg_dev[mx].module, par = g * MATRIX_NOUT + k;
                    int32_t was = eng_get_param(mod, par), other = eng_get_param(mod, ((g + 1u) % MATRIX_NOUT) * MATRIX_NOUT + k);
                    fm1_ms += 150u;
                    enc(2u + k, TURN[t]);
                    turned &= eng_get_param(mod, par) != was || was == DEFS[T_MATRIX].pmin[par] || was == DEFS[T_MATRIX].pmax[par];
                    if (t == 3u) {                      /* the editor sets a pin of the next column */
                        eng_set_param(mod, ((g + 1u) % MATRIX_NOUT) * MATRIX_NOUT + k, other ? 0 : 40000);
                        eng_render(al, ar, 128);
                        later(120);
                    }
                    if (t == 5u) {                      /* ALGO there and back */
                        enc(1, 1);
                        loop();
                        enc(1, -1);
                        loop();
                    }
                    memcpy(inc, fb, sizeof inc);
                    ui_dirty = 2;
                    loop();
                    runs++;
                    for (i = 0, n = 0; i < 240u * 240u; i++)
                        n += inc[i] != fb[i];
                    if (n) {
                        if (bad < 6u)
                            printf("      (Matrix page %u K%u turn %u: %u px differ)\n", g, k + 1u, t, n);
                        bad++;
                    }
                }
        }
        check("the Matrix's pages: OUT 1..OUT 4, each its own group, each a grid of its column", names == 4u && grid);
        check("K1..K4 on a Matrix page turn its column's pins (in 1..in 4)", turned);
        check("the Matrix's grid redrawn in place (a turn, ALGO, the editor's pin) is the screen drawn whole", runs == 128u && bad == 0u);
        (void)load("808 KIT");
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
    }
    {   /* #1338: a DX7's pages (pages_ui.c dx7_page, pages.ts DX7_SECTIONS): 13, the parameters then the voice rows; K1 of
         * the first operator page picks the operator the next five show (their name OP n); a voice row turned edits the
         * voice in the binary and every copy, tells the editor (VOICE_NOW), not PARAM_NOW; the values as the DX7 shows them.
         * After the turns the screen is the screen drawn whole */
        static uint16_t inc[240 * 240];
        static int32_t al[128], ar[128];
        const char *const FIX[2] = {"build/panel-fixtures/dx7-voice.m1p", "build/panel-fixtures/dx7-poly.m1p"};
        char num[24], unit[8];
        uint32_t d, base, live, i, n, m = 0, ok_pages = 0, ok_alg = 0, ok_copies = 0;
        int dx = -1, pn, ok_show = 1;
        uint8_t *v;
#define DX7_SHOWS(k, want, wunit) (row_show(pages_now(), k, num, unit, 100, &base, &live), !strcmp(num, want) && !strcmp(unit, wunit))
        check("DX7 poly fixture loads", load_fixture(FIX[1]) == 0);   /* (a Voicing's four copies: the DX7 inside its card) */
        pv_gen++;
        eng_render(al, ar, 128);
        screen_idle();
        pages_ensure();
        for (d = 0, dx = -1; d < pg_ndev; d++)            /* (the card's own pages, then its DX7's 12: DX7, OP 1 1/6 .. VOICE) */
            if (pg_dev[d].module < 0 && pg_dev[d].npg > 12u && pg_page[pg_dev[d].pg0 + pg_dev[d].npg - 12u].mod[0] == VOICE_ROW)
                dx = (int)d;
        check("a card holding one DX7 has the DX7's voice pages after its own (DX7: ALGORITHM, FEEDBACK .. VOICE)", dx >= 0
              && pg_page[pg_dev[dx].pg0 + pg_dev[dx].npg - 12u].par[0] == DXF_ALG && pg_page[pg_dev[dx].pg0 + pg_dev[dx].npg - 12u].nrows == 2u
              && pg_page[pg_dev[dx].pg0 + pg_dev[dx].npg - 1u].nlen == 5u && !memcmp(pg_page[pg_dev[dx].pg0 + pg_dev[dx].npg - 1u].name, "VOICE", 5));
        if (dx >= 0) {
            m = pg_page[pg_dev[dx].pg0 + pg_dev[dx].npg - 12u].xo[0];
            v = m1_voice_at(m);
            (void)pages_focus((uint32_t)dx, pg_dev[dx].npg - 12u);
            loop();
            n = host_voice_told;
            enc(2, 1);                                    /* K1: ALGORITHM 5 -> 6 */
            for (i = 0, ok_copies = v && v[110] == 5u && host_voice_told == n + 1u; i < E.node[m].ninst; i++)   /* (each
                                                         * copy's unpacked voice: msfa's 134 the algorithm) */
                ok_copies &= inst_pool[E.node[m].inst0 + i].s.dx7.s->v[134] == 5u;
            ok_copies &= E.node[m].ninst == 4u;
        }
        check("a voice row turned on the card reaches every copy of its DX7 (a Voicing's four), live", ok_copies);
        dx7_op = 0;                                       /* (the picker as at start: it is kept across patches, and the
                                                          * fixtures' sweeps above, the DX7 Piano example among them, move it) */
        dx7_opname[3] = '1';
        check("DX7 fixture loads", load_fixture(FIX[0]) == 0);
        pv_gen++;
        eng_render(al, ar, 128);
        screen_idle();
        pages_ensure();
        for (d = 0, dx = -1; d < pg_ndev; d++)
            if (pg_dev[d].module >= 0 && eng_type((uint32_t)pg_dev[d].module) == T_DX7)
                dx = (int)d;
        if (dx >= 0) {
            m = (uint32_t)pg_dev[dx].module;
            v = m1_voice_at(m);
            ok_pages = pg_dev[dx].npg == 13u && pg_page[pg_dev[dx].pg0 + 2u].nlen == 4u && !memcmp(pg_page[pg_dev[dx].pg0 + 2u].name, "OP 1", 4)
                       && pg_page[pg_dev[dx].pg0 + 2u].parts == 6u && pg_page[pg_dev[dx].pg0 + 12u].nrows == 1u
                       && pg_page[pg_dev[dx].pg0].mod[3] == m && pg_page[pg_dev[dx].pg0].par[3] == DX7_P_OPS
                       && pg_page[pg_dev[dx].pg0 + 1u].mod[2] == VOICE_ROW && pg_page[pg_dev[dx].pg0 + 1u].par[2] == DXF_ALG;
            (void)pages_focus((uint32_t)dx, 1);           /* DX7 2/2: K3 the algorithm, 1..32 */
            ui_dirty = 2;
            loop();
            pn = param_now;
            n = host_voice_told;
            if (v && DX7_SHOWS(2u, "5", "")) {
                enc(4, 1);
                ok_alg = v[110] == 5u && DX7_SHOWS(2u, "6", "") && host_voice_told == n + 1u && param_now == pn
                         && inst_pool[E.node[m].inst0].s.dx7.s->v[134] == 5u;
            }
        }
        check("a DX7 is a device of 13 pages: DX7 1/2, 2/2, OP 1 1/6 .. 6/6, PITCH EG, LFO, VOICE", ok_pages);
        check("ALGORITHM on DX7 2/2 is the voice's number 1..32; a turn edits the voice and every copy, says VOICE_NOW, not PARAM_NOW", ok_alg);
        if (dx >= 0) {
            uint32_t g0 = pg_dev[dx].pg0, was;
            v = m1_voice_at(m);
            (void)pages_focus((uint32_t)dx, 2);           /* OP 1 1/6: K1 the picker */
            loop();
            ok_show &= DX7_SHOWS(0u, "1", "") && DX7_SHOWS(1u, "99", "") && DX7_SHOWS(2u, "1", "") && DX7_SHOWS(3u, "0", "");
            fm1_ms += 150u;
            enc(4, -1);                                   /* K3: ratio coarse 0 is 0.50 */
            ok_show &= DX7_SHOWS(2u, "0.50", "");
            for (i = 0; i < 5u; i++) {                    /* (single clicks, apart: never the fast step) */
                fm1_ms += 150u;
                enc(4, 1);
            }
            ok_show &= DX7_SHOWS(2u, "5", "");
            dx7_turn(m, DXF_FINE, 50, 0);                 /* fine 0 -> 50: its raw number, as the DX7 and the card */
            ok_show &= DX7_SHOWS(3u, "50", "") && DX7_SHOWS(2u, "5", "");
            dx7_turn(m, DXF_FINE, -50, 0);
            dx7_turn(m, DXF_COARSE, -4, 0);               /* (operator 1 back to coarse 1) */
            enc(2, 2);                                    /* K1: operator 3 */
            ok_show &= dx7_op == 2u && !memcmp(pg_page[g0 + 3u].name, "OP 3", 4) && DX7_SHOWS(0u, "3", "");
            enc(3, -9);                                   /* K2: operator 3's output level 99 -> 90 (packed: operator 6 first) */
            ok_show &= v[3u * 17u + 14u] == 90u && DX7_SHOWS(1u, "90", "") && inst_pool[E.node[m].inst0].s.dx7.s->v[3u * 21u + 16u] == 90u;
            (void)pages_focus((uint32_t)dx, 3);           /* OP 3 2/6: MODE, DETUNE */
            loop();
            ok_show &= DX7_SHOWS(0u, "RATIO", "") && DX7_SHOWS(1u, "0", "");
            enc(3, 3);
            enc(2, 1);                                    /* fixed: coarse 1 is 10 Hz */
            ok_show &= DX7_SHOWS(1u, "+3", "") && DX7_SHOWS(0u, "FIXED", "");
            (void)pages_focus((uint32_t)dx, 2);
            loop();
            ok_show &= DX7_SHOWS(2u, "10", "Hz") && DX7_SHOWS(3u, "0", "");
            fm1_ms += 150u;
            enc(4, 1);                                    /* K3: fixed coarse 2 is 100 Hz */
            ok_show &= DX7_SHOWS(2u, "100", "Hz");
            (void)pages_focus((uint32_t)dx, 6);           /* OP 3 5/6: BREAK as a note (39: C3), L CURVE */
            loop();
            ok_show &= DX7_SHOWS(0u, "C3", "") && DX7_SHOWS(3u, "-LIN", "");
            (void)pages_focus((uint32_t)dx, 10);          /* LFO 1/2: WAVE (sine, as the kit set none: TRI), SYNC */
            loop();
            ok_show &= DX7_SHOWS(0u, "TRI", "") && (DX7_SHOWS(3u, "ON", "") || DX7_SHOWS(3u, "OFF", ""));
            enc(2, 9);                                    /* (a choice: one step a click, held at its top) */
            ok_show &= DX7_SHOWS(0u, "S/H", "");
            (void)pages_focus((uint32_t)dx, 12);          /* VOICE: TRANSPOSE 24 is +0 */
            loop();
            ok_show &= DX7_SHOWS(0u, "0", "st") && pages_cc(0) == 24u * 127u / 48u;
            check("the DX7's voice rows show its values as the DX7 does (operator picker, ratio, fixed Hz, detune, note, curve, wave)", ok_show);
            check("a voice row takes no P-lock and no MIDI CC value", pages_lock_turn(pages_now(), 0, 0, 1, 0, (int32_t *)&base) < 0
                  && row_set_unit(pages_now(), 0, 32768, &base, &live, (int32_t *)&i) < 0);
            (void)pages_focus((uint32_t)dx, 0);           /* DX7 1/2: K1 the level, a parameter as before */
            loop();
            was = (uint32_t)eng_get_param(m, DX7_P_LEVEL);
            pn = param_now;
            enc(2, -3);
            check("a parameter row on the DX7's pages turns the parameter (PARAM_NOW)", (uint32_t)eng_get_param(m, DX7_P_LEVEL) != was && param_now > pn);
            (void)pages_focus((uint32_t)dx, 4);
            loop();
            enc(3, 5);
            memcpy(inc, fb, sizeof inc);
            ui_dirty = 2;
            loop();
            for (i = 0, n = 0; i < 240u * 240u; i++)
                n += inc[i] != fb[i];
            check("a voice row redrawn in place is the screen drawn whole", n == 0u);
            dx7_turn(m, DXF_OP, -9, 0);                   /* (operator 1 again for the tests after) */
        }
#undef DX7_SHOWS
        (void)load("808 KIT");
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
    }
    {   /* the Harmonizer's Side layout (#598): with the keys on a Harmonizer the seven lowest keys are its chord buttons
         * (black 1..3 maj min dim, white 1..4 sus2 sus4 7 9) whatever the octave, sent out as their keys under the split;
         * the other keys are roots, under the split too after an octave shift; the bar names the chord */
        int h, m0;
        int8_t oct = octave;
        sb_on = 0;
        page = 0;
        check("Harmonizer fixture loads", load_fixture("build/panel-fixtures/harm-side.m1p") == 0);
        loop();
        h = eng_keys_harm();
        check("the keys reach its Harmonizer", h >= 0 && eng_type((uint32_t)h) == T_HARM && eng_keys_drummap() < 0);
        octave = 0;
        mlen = 0;                                           /* (the log holds 256 messages: room for these) */
        m0 = mlen;
        msg_text[0] = 0;
        panel_keys(1u << 1);                                /* F#3: black key 1 = maj */
        loop();
        check("black key 1 is maj: no note, its key under the split sent (F#3), the bar says CHORD: MAJ",
              sent(m0, 0x90u, 54u, 100u) && !strcmp(harm_notes(h), "") && !strcmp(msg_text, MSG_CHORD "MAJ"));
        panel_keys(1u << 1 | 1u << 7);                      /* + C4 */
        check("C4 with it: C major", !strcmp(harm_notes(h), "60 64 67") && sent(m0, 0x90u, 60u, 100u));
        panel_keys(1u << 1 | 1u << 7 | 1u << 4);            /* + A3: white key 3 = 7 */
        loop();
        check("white key 3 (7) while C sounds: the bar says CHORD: 7, the chord sounding stays", !strcmp(msg_text, MSG_CHORD "7")
              && !strcmp(harm_notes(h), "60 64 67"));
        panel_keys(1u << 1 | 1u << 4 | 1u << 9);            /* C4 up, D4 down: D7 */
        check("D4 now: D7", !strcmp(harm_notes(h), "62 66 69 72"));
        panel_keys(0);
        check("all up: silent, the buttons' keys let go out", !strcmp(harm_notes(h), "") && sent(m0, 0x80u, 54u, 0u) && sent(m0, 0x80u, 57u, 0u));
        octave = -1;
        panel_keys(1u << 3);                                /* G#3: black key 2 = min, at OCT -1 too */
        panel_keys(1u << 3 | 1u << 12);                     /* F4 at OCT -1: F3, under the split, a root */
        check("OCT -1: black key 2 is still min, F4 plays F3 minor (a root under the split)", !strcmp(harm_notes(h), "53 56 60"));
        panel_keys(0);
        octave = oct;
        eng_set_param((uint32_t)h, HARM_P_TYPE, ENG_ONE);
        eng_set_param((uint32_t)h, HARM_P_EXT, 2 * ENG_ONE);
        {   /* extended chords must move the current lowest/highest note at every inversion */
            static const int steps[] = {-8, -4, 4, 8};
            static const char *want[] = {"38 40 43 48", "50 52 55 60", "74 76 79 84", "86 88 91 96"};
            uint32_t k;
            for (k = 0; k < 4; k++) {
                eng_set_param((uint32_t)h, HARM_P_VOICING, steps[k] * ENG_ONE);
                eng_note_on(60, ENG_ONE, 1);
                check("add9: repeated inversions move the lowest/highest note", !strcmp(harm_notes(h), want[k]));
                eng_note_off(60, 1);
            }
        }
        eng_set_param((uint32_t)h, HARM_P_VOICING, 0);
        eng_set_param((uint32_t)h, HARM_P_EXT, 0);
        eng_note_on(60, ENG_ONE, 1);
        eng_set_param((uint32_t)h, HARM_P_SPLIT, 67 * ENG_ONE);
        eng_note_off(60, 1);
        check("moving SPLIT over a held root still releases its chord", !strcmp(harm_notes(h), ""));
        eng_set_param((uint32_t)h, HARM_P_SPLIT, 60 * ENG_ONE);
        eng_note_on(54, ENG_ONE, 1);
        eng_set_param((uint32_t)h, HARM_P_SPLIT, 61 * ENG_ONE);
        eng_note_on(55, ENG_ONE, 1);
        eng_note_off(54, 1);
        check("moving SPLIT: the second key still holds the same chord button", E.harm[0].down == (1u << 1));
        eng_note_off(55, 1);
        check("moving SPLIT: the last key releases its original chord button", E.harm[0].down == 0);
        {   /* the inversion keys (#1311, owner 2026-11-25): with INVKEYS on, the three highest keys (F5 F#5 G5 at OCT 0) are
             * the 1st, 2nd and 3rd inversion, at any octave (I2), in place of VOICING (I3), lowest notes up an octave (I4),
             * the last pressed winning (I5), latched with the chord buttons (I6), the same as MIDI's F5..G5 over a C4 split
             * (I7); INVKEYS off they play notes */
            const uint32_t MIN = 1u << 3, MAJ = 1u << 1, SEV = 1u << 4, C4 = 1u << 7, I1 = 1u << 24, I2 = 1u << 25, I3 = 1u << 26;
            eng_set_param((uint32_t)h, HARM_P_SPLIT, 60 * ENG_ONE);
            eng_set_param((uint32_t)h, HARM_P_TYPE, 0);     /* (the card's chord none: a key alone plays itself) */
            octave = 0;
            panel_keys(I3);
            check("INVKEYS off (as made, every older patch): G5 plays itself", !strcmp(harm_notes(h), "79") && E.harm[0].down == 0);
            panel_keys(0);
            eng_set_param((uint32_t)h, HARM_P_INVKEYS, ENG_ONE);
            mlen = 0;
            m0 = mlen;
            panel_keys(MIN | SEV | I3);
            panel_keys(MIN | SEV | I3 | C4);
            check("the owner's Cmin7, 3rd inversion: min + 7 + G5 + C4 plays Bb C Eb G (70 72 75 79), G5 sent as itself, no note of its own",
                  !strcmp(harm_notes(h), "70 72 75 79") && sent(m0, 0x90u, 79u, 100u));
            panel_keys(0);
            check("all up: silent, G5's key let go out", !strcmp(harm_notes(h), "") && sent(m0, 0x80u, 79u, 0u) && E.harm[0].down == 0);
            panel_keys(MAJ | I3);                           /* (the buttons first: panel_keys takes the keys from the lowest up) */
            panel_keys(MAJ | I3 | C4);
            check("I4: a triad's 3rd inversion is root position an octave up (C major: 72 76 79)", !strcmp(harm_notes(h), "72 76 79"));
            panel_keys(0);
            octave = -1;
            mlen = 0;
            m0 = mlen;
            panel_keys(MAJ | I1);
            panel_keys(MAJ | I1 | C4);
            check("I2: at OCT -1 the top key F is still the 1st inversion (C3 major: 52 55 60), sent as F5",
                  !strcmp(harm_notes(h), "52 55 60") && sent(m0, 0x90u, 77u, 100u));
            panel_keys(0);
            octave = 0;
            eng_set_param((uint32_t)h, HARM_P_VOICING, -2 * ENG_ONE);
            panel_keys(MAJ | I2);
            panel_keys(MAJ | I2 | C4);
            check("I3: F#5 held sets the 2nd inversion exactly, VOICING -2 aside (67 72 76)", !strcmp(harm_notes(h), "67 72 76"));
            panel_keys(MAJ);
            panel_keys(MAJ | C4);
            check("I3: none held, VOICING applies again (-2: 52 55 60)", !strcmp(harm_notes(h), "52 55 60"));
            panel_keys(0);
            eng_set_param((uint32_t)h, HARM_P_VOICING, 0);
            panel_keys(MAJ | I1);
            panel_keys(MAJ | I1 | I3);
            panel_keys(MAJ | I1 | I3 | C4);
            check("I5: F5 then G5 held, the last pressed wins (3rd: 72 76 79)", !strcmp(harm_notes(h), "72 76 79"));
            panel_keys(MAJ | I1);
            panel_keys(MAJ | I1 | C4);
            check("I5: G5 let go, F5 still held: the 1st (64 67 72)", !strcmp(harm_notes(h), "64 67 72"));
            panel_keys(0);
            {   /* held, TYPE none (owner's 1.28.0 check S2): min + 7 held, F5 let go and F#5 pressed: the 2nd inversion */
                panel_keys(MIN | SEV | I1);
                panel_keys(MIN | SEV);
                panel_keys(MIN | SEV | I2);
                panel_keys(MIN | SEV | I2 | C4);
                check("held, TYPE none: min + 7 held, F5 let go, F#5 pressed: Cmin7 in the 2nd inversion (67 70 72 75)", !strcmp(harm_notes(h), "67 70 72 75"));
                panel_keys(0);
            }
            eng_set_param((uint32_t)h, HARM_P_LOCK, ENG_ONE);
            panel_keys(MAJ);
            panel_keys(MAJ | I2);
            panel_keys(0);
            loop();
            panel_keys(C4);
            check("I6: LOCK on, maj + F#5 pressed together stay latched (C major 2nd inversion: 67 72 76), the bar says CHORD: MAJ INV2",
                  !strcmp(harm_notes(h), "67 72 76") && !strcmp(msg_text, MSG_CHORD "MAJ INV2"));
            panel_keys(0);
            panel_keys(I1);                                 /* (owner's 1.28.0 check S2: with TYPE none it played single notes) */
            panel_keys(0);
            loop();
            panel_keys(C4);
            check("LOCK, TYPE none: F5 alone next replaces the latched inversion, maj stays (1st: 64 67 72), the bar says CHORD: MAJ INV1",
                  !strcmp(harm_notes(h), "64 67 72") && !strcmp(msg_text, MSG_CHORD "MAJ INV1"));
            panel_keys(0);
            panel_keys(I1);
            panel_keys(0);
            loop();
            panel_keys(C4);
            check("LOCK: F5 alone again lets the inversion go, maj stays (root position: 60 64 67), the bar says CHORD: MAJ",
                  !strcmp(harm_notes(h), "60 64 67") && !strcmp(msg_text, MSG_CHORD "MAJ"));
            panel_keys(0);
            panel_keys(I2);
            panel_keys(0);
            panel_keys(MIN);
            panel_keys(0);
            panel_keys(C4);
            check("LOCK: F#5 alone, then min alone: min replaces maj, the inversion stays (C minor 2nd inversion: 67 72 75)", !strcmp(harm_notes(h), "67 72 75"));
            panel_keys(0);
            panel_keys(MIN);
            panel_keys(0);
            loop();
            panel_keys(C4);
            check("LOCK: min alone again lets it go: the card's chord, none (C4 alone, which no inversion moves), the bar says CHORD: SINGLE NOTES",
                  !strcmp(harm_notes(h), "60") && !strcmp(msg_text, MSG_CHORD MSG_CHORD_NONE));
            panel_keys(0);
            panel_keys(I2);                                 /* (the 2nd inversion let go too) */
            panel_keys(0);
            check("LOCK: nothing latched now", E.harm[0].locked == 0);
            eng_set_param((uint32_t)h, HARM_P_TYPE, ENG_ONE);   /* the card's chord maj: it worked before, the latched chord kept now */
            panel_keys(MIN | SEV | I1);
            panel_keys(0);
            panel_keys(I3);
            panel_keys(0);
            loop();
            panel_keys(C4);
            check("LOCK, TYPE maj: min + 7 + F5 latched, then G5 alone: Cmin7 in the 3rd inversion (70 72 75 79), not the card's maj; CHORD: MIN7 INV3",
                  !strcmp(harm_notes(h), "70 72 75 79") && !strcmp(msg_text, MSG_CHORD "MIN7 INV3"));
            panel_keys(0);
            panel_keys(MAJ | 1u << 0 | 1u << 2 | 1u << 6);  /* maj + sus2 + sus4 + 9: the longest name, with the 3rd inversion */
            panel_keys(0);
            loop();
            check("a name too long for CHORD: before it shows alone (MAJ ADD2 ADD4 ADD9 INV3, 23 characters)", !strcmp(msg_text, "MAJ ADD2 ADD4 ADD9 INV3"));
            panel_keys(I3);                                 /* (all let go: G5 alone, maj alone replaces the four, maj alone again) */
            panel_keys(0);
            panel_keys(MAJ);
            panel_keys(0);
            panel_keys(MAJ);
            panel_keys(0);
            check("LOCK: nothing latched again", E.harm[0].locked == 0);
            eng_set_param((uint32_t)h, HARM_P_TYPE, 0);
            eng_set_param((uint32_t)h, HARM_P_LOCK, 0);
            eng_midi_channel(0);
            eng_note_on(54, ENG_ONE, 1);
            eng_note_on(79, ENG_ONE, 1);
            eng_note_on(60, ENG_ONE, 1);
            check("I7: from MIDI, F#3 (maj) and G5 held play C4 in the 3rd inversion (72 76 79)", !strcmp(harm_notes(h), "72 76 79"));
            eng_note_off(60, 1);
            eng_note_off(79, 1);
            eng_note_off(54, 1);
            check("I7: their note-offs let the buttons go", E.harm[0].down == 0 && !strcmp(harm_notes(h), ""));
            eng_set_param((uint32_t)h, HARM_P_INVKEYS, 0);
            eng_note_on(79, ENG_ONE, 1);
            check("INVKEYS off: MIDI's G5 is a root again", !strcmp(harm_notes(h), "79") && E.harm[0].down == 0);
            eng_note_off(79, 1);
            {   /* I1 / D-1041: a patch that leaves INVKEYS off keeps its format (this one 52, the Harmonizer's); its row
                 * turns on the FM-1 all the same. Only a binary eng_rec_grow cannot raise (a master FX bus before format
                 * 66) keeps the row from turning: the bar says to set it in the editor (a learned or CC control: silently) */
                uint32_t d, g, k, rk = 0, mo, par, n = pv_len, found = 0, b1 = pv_bin[1], b7 = pv_bin[7];
                int32_t v = 0;
                pv_gen++;
                pages_ensure();
                for (d = 0; d < pg_ndev && !found; d++)
                    for (g = pg_dev[d].pg0; g < pg_dev[d].pg0 + pg_dev[d].npg && !found; g++)
                        for (k = 0; k < pg_page[g].nrows && !found; k++)
                            if (pg_page[g].mod[k] == (uint32_t)h && pg_page[g].par[k] == HARM_P_INVKEYS) {
                                found = 1;
                                rk = k;
                                pages_focus(d, g - pg_dev[d].pg0);
                            }
                check("I1: the Harmonizer's page has INVKEYS; its patch is format 52", found && b1 == 52u);
                check("I1: on a format 52 patch the row turns on", pages_turn(rk, 1, 0, 0, &mo, &par, &v) == 0 && v == ENG_ONE);
                pv_bin[1] = 60u;                           /* (the same header as a format 60 binary with a master FX bus) */
                pv_bin[7] |= (uint8_t)(ENG_FLAG_FX_BUS >> 8);
                msg_text[0] = 0;
                check("I1: on a binary with a master FX bus it stays off, the bar says " MSG_OLD_ROW,
                      pages_turn(rk, 1, 0, 0, &mo, &par, &v) == -1 && !strcmp(msg_text, MSG_OLD_ROW) && str_len(MSG_OLD_ROW) <= 26u);
                check("I1: nor from MIDI (CC 16..19) there", pages_set_unit(rk, ENG_ONE, &mo, &par, &v) == -1);
                m1_patch_param((uint32_t)h, HARM_P_INVKEYS, ENG_ONE);
                check("I1: nor is the copy changed", pv_len == n && pv_bin[1] == 60u);
                pv_bin[1] = (uint8_t)b1;
                pv_bin[7] = (uint8_t)b7;
            }
        }
        {   /* RETRIG (#1329, owner 2026-11-26): OFF (as made) keeps a held root's chord as it went down (D-778); ALL re-forms
             * it at the next block, every note started again (the part playing C4 takes a new note); DIFF ends only the
             * notes the new chord drops and starts only the ones it adds (C4 and G keep sounding on their parts). The FM-1's
             * chord button min (black key 2) pressed while C4 is held, the card's chord maj */
            static const char *const want[3] = {"60 64 67", "60 63 67", "60 63 67"};
            static const char *const name[3] = {"RETRIG OFF: C major stays", "RETRIG ALL: C minor at once, C4 struck again",
                                                "RETRIG DIFF: C minor at once, C4 and G untouched"};
            uint32_t k, g, v, before = 0, after = 0;
            eng_set_param((uint32_t)h, HARM_P_TYPE, ENG_ONE);
            octave = 0;
            for (k = 0; k < 3u; k++) {
                eng_set_param((uint32_t)h, HARM_P_RETRIG, (int32_t)k * ENG_ONE);
                panel_keys(1u << 7);                        /* C4: C major */
                blocks(1);
                for (g = 1; g <= E.ngrp; g++)
                    for (v = 0; v < E.grp[g].parts; v++)
                        if (E.pv[E.grp[g].pv0 + v].on && E.pv[E.grp[g].pv0 + v].note == 60u)
                            before = E.pv[E.grp[g].pv0 + v].on_stamp;
                panel_keys(1u << 7 | 1u << 3);              /* + black key 2: min */
                blocks(1);
                for (g = 1; g <= E.ngrp; g++)
                    for (v = 0; v < E.grp[g].parts; v++)
                        if (E.pv[E.grp[g].pv0 + v].on && E.pv[E.grp[g].pv0 + v].note == 60u)
                            after = E.pv[E.grp[g].pv0 + v].on_stamp;
                check(name[k], !strcmp(harm_notes(h), want[k]) && (k == 1u) == (after != before));
                panel_keys(0);
                blocks(1);
                check("RETRIG: the root let go ends its chord", !strcmp(harm_notes(h), ""));
            }
            eng_set_param((uint32_t)h, HARM_P_RETRIG, 0);
            eng_set_param((uint32_t)h, HARM_P_TYPE, 0);
        }
        eng_set_bypass((uint32_t)h, 1);
        check("bypassed: the keys reach no Harmonizer (plain notes)", eng_keys_harm() < 0);
        {   /* I1 / D-1041: INVKEYS changed on the FM-1 is kept in its copy: a user patch in format 53 (its cables 3 bytes
             * each, ENG_FLAG_CABLES3) takes format 64's layout (eng_slim), is raised to 68 and its record grows to hold the
             * row; loaded again, the row is on, and the rest reads the same. The patch is the panel bank's Monolith D
             * (web/factory/bank.json, the source graph before the FX drawers: no effect, a Harmonizer and its keys route),
             * as any editor from 1.27.1 on writes it, byte for byte. It is not the shipped Monolith D: every factory patch
             * with a Harmonizer ships in format 66 (presets.h, the firmware tier and the factory region); 1.14 to 1.26.2
             * shipped them in formats 55 to 61 with the master FX bus, which the FM-1 refuses to raise (the case above) */
            static uint8_t copy[sizeof pv_bin];
            uint32_t was = 0, hn = 0, i;
            char la[ENG_PANEL_LABELS][ENG_PANEL_LABEL + 1], lb[ENG_PANEL_LABEL + 1];
            int labels = 1, ok = load("MONOLITH D") == 0 && E.nharm;
            check("I1: the panel bank's Monolith D (a Harmonizer, no effect) loads", ok);
            if (ok) {
                hn = E.harm[0].node;
                was = pv_bin[1];
            }
            for (i = 0; i < ENG_PANEL_LABELS; i++)
                (void)eng_panel_label(pv_bin, pv_len, i, la[i]);
            pv_gen++;
            pages_ensure();
            check("I1: its patch (format 53, 3-byte cables) can take INVKEYS on the FM-1", was == 53u
                  && (pv_bin[7] & ENG_FLAG_CABLES3) && !row_old(hn, HARM_P_INVKEYS, 0));
            m1_patch_param(hn, HARM_P_INVKEYS, ENG_ONE);
            for (i = 0; i < pv_len; i++) copy[i] = pv_bin[i];
            for (i = 0; i < ENG_PANEL_LABELS; i++)
                labels &= eng_panel_label(copy, pv_len, i, lb) == str_len(la[i]) && !strcmp(la[i], lb);
            check("I1: the FM-1's INVKEYS edit raises its copy from format 53 to 68 and is kept, the panel labels the same",
                  pv_bin[1] == 68u && eng_load(copy, pv_len) == 0 && eng_get_param(hn, HARM_P_INVKEYS) == ENG_ONE && labels);
            m1_patch_param(hn, HARM_P_INVKEYS, 0);
            for (i = 0; i < pv_len; i++) copy[i] = pv_bin[i];
            check("I1: and off again, still format 68 (never narrowed back)", pv_bin[1] == 68u && eng_load(copy, pv_len) == 0
                  && eng_get_param(hn, HARM_P_INVKEYS) == 0);
        }
        {   /* RETRIG (#1329, D-1041's rule for format 69): the Harmonizer's page has it; the panel bank's Monolith D (format
             * 53) takes it on the FM-1, raised to format 69 and kept; off again it stays 69 */
            static uint8_t copy[sizeof pv_bin];
            uint32_t d, g, k, i, hn = 0, was = 0, found = 0;
            int ok = load("MONOLITH D") == 0 && E.nharm;
            if (ok) {
                hn = E.harm[0].node;
                was = pv_bin[1];
            }
            pv_gen++;
            pages_ensure();
            for (d = 0; d < pg_ndev && !found; d++)
                for (g = pg_dev[d].pg0; g < pg_dev[d].pg0 + pg_dev[d].npg && !found; g++)
                    for (k = 0; k < pg_page[g].nrows && !found; k++)
                        found = pg_page[g].mod[k] == hn && pg_page[g].par[k] == HARM_P_RETRIG;
            check("RETRIG: the Harmonizer's page has the row, OFF ALL DIFF; Monolith D (format 53) can take it", ok && found
                  && was == 53u && !row_old(hn, HARM_P_RETRIG, 0) && !strcmp(HARM_CH[HARM_P_RETRIG][2], "DIFF"));
            m1_patch_param(hn, HARM_P_RETRIG, 2 * ENG_ONE);
            for (i = 0; i < pv_len; i++) copy[i] = pv_bin[i];
            check("RETRIG: the FM-1's edit raises its copy from format 53 to 69 and is kept", pv_bin[1] == 69u
                  && eng_load(copy, pv_len) == 0 && eng_get_param(hn, HARM_P_RETRIG) == 2 * ENG_ONE);
            m1_patch_param(hn, HARM_P_RETRIG, 0);
            for (i = 0; i < pv_len; i++) copy[i] = pv_bin[i];
            check("RETRIG: OFF again, still format 69", pv_bin[1] == 69u && eng_load(copy, pv_len) == 0
                  && eng_get_param(hn, HARM_P_RETRIG) == 0);
        }
        {   /* the Freq shifter's PM row (#1337, D-1041's rule for format 70): its page has it after MIX; a counted copy of
             * format 51 takes it on the FM-1, raised to format 70 and kept; back at 0 it stays 70 */
            static uint8_t copy[sizeof pv_bin];
            uint32_t d, g, k, i, sn = 0, was = 0, found = 0, m;
            int ok = load_fixture("build/panel-fixtures/shift-counted.m1p") == 0;
            for (m = 0; ok && m < E.nmod; m++)
                if (E.node[m].type == T_SHIFT)
                    sn = m, found = 1;
            ok = ok && found;
            found = 0;
            was = pv_bin[1];
            pv_gen++;
            pages_ensure();
            for (d = 0; d < pg_ndev && !found; d++)
                for (g = pg_dev[d].pg0; g < pg_dev[d].pg0 + pg_dev[d].npg && !found; g++)
                    for (k = 0; k < pg_page[g].nrows && !found; k++)
                        found = pg_page[g].mod[k] == sn && pg_page[g].par[k] == SHIFT_P_PM && k > 0
                                && pg_page[g].par[k - 1u] == SHIFT_P_MIX;
            check("PM: the Freq shifter's page has the row after MIX; its counted copy (format 51) can take it", ok && found
                  && was == 51u && !row_old(sn, SHIFT_P_PM, 0) && !strcmp(SHIFT_UNIT[SHIFT_P_PM], "RAD"));
            m1_patch_param(sn, SHIFT_P_PM, 3 * ENG_ONE / 2);
            for (i = 0; i < pv_len; i++) copy[i] = pv_bin[i];
            check("PM: the FM-1's edit raises its copy from format 51 to 70 and is kept", pv_bin[1] == 70u
                  && eng_load(copy, pv_len) == 0 && eng_get_param(sn, SHIFT_P_PM) == 3 * ENG_ONE / 2);
            m1_patch_param(sn, SHIFT_P_PM, 0);
            for (i = 0; i < pv_len; i++) copy[i] = pv_bin[i];
            check("PM: back at 0, still format 70", pv_bin[1] == 70u && eng_load(copy, pv_len) == 0
                  && eng_get_param(sn, SHIFT_P_PM) == 0);
        }
        (void)load("808 KIT");
        pv_gen++;
        page = 0;
        screen_idle();
    }
    {   /* Dense sequencer output keeps only events that can sound, with all releases preserved. */
        check("dense Steps fixture loads", !load_fixture("build/panel-fixtures/route-dense-steps.m1p"));
        eng_transport(1); blocks(4);
        uint32_t valid = E.harm[0].nroots == 8u;
        for (uint32_t i = 0; i < E.harm[0].nroots; i++) valid &= E.harm[0].root[i] >= 120u;
        check("all tracks deliver their final sounding roots", valid);
        blocks(150);
        check("dense pattern releases every harmony root", E.harm[0].nroots == 0u);
        eng_transport(0);
        check("branched snapshot fixture loads", !load_fixture("build/panel-fixtures/route-branch-snapshot.m1p"));
        eng_note_on(60, ENG_ONE, 1); blocks(4);
        check("each branch keeps its own chord snapshot", E.nharm == 2u && E.harm[0].count[64] && !E.harm[0].count[63]
              && E.harm[1].count[63] && !E.harm[1].count[64]);
        eng_note_off(60, 1); blocks(4);
        check("both snapshot branches release", !E.harm[0].nroots && !E.harm[1].nroots);
        check("snapshot fixture loads", !load_fixture("build/panel-fixtures/route-root-snapshot.m1p"));
        eng_midi_channel(0); eng_chord_button(3, 1); eng_note_on(60, ENG_ONE, 1); eng_chord_button(3, 0); blocks(4);
        check("live root keeps its minor chord through Steps delay", E.harm[0].count[63] && !E.harm[0].count[64]);
        eng_note_off(60, 1); blocks(4);
        check("snapshot root releases", E.harm[0].nroots == 0u);
    }
    {   /* Approved cable-order capture and Side controls while step recording. */
        const char *fixtures[] = {"build/panel-fixtures/route-harm-steps.m1p", "build/panel-fixtures/route-steps-harm.m1p"};
        for (uint32_t order = 0; order < 2u; order++) for (uint32_t preview = 0; preview < 2u; preview++) {
            panel_keys(0); sr_held = 0; sr_stop();
            check("routing capture fixture loads", !load_fixture(fixtures[order]));
            pv_gen++; pages_ensure(); seq_select(0); page = 0; page_set(PAGE_SEQ); later(1500); octave = 0; panel_held = 0; sb_on = 0;
            int mod = eng_steps_module(0);
            sr_empty(mod); sr_preview = (uint8_t)preview; sr_start(0, -1);
            sr_down(3); /* minor: a control, not G#3 */
            check("Side button does not enter or advance", sr_n == 0 && sr_k == 0 && sr_keys == 0);
            sr_down(K_C4);
            check("capture expands only upstream harmony", sr_n == (order ? 1u : 3u));
            sr_up(3); /* changing the chord now leaves this root's snapshot intact */
            check("releasing a control does not commit", sr_k == 0 && sr_notes(mod) == 0);
            sr_up(K_C4);
            check("root release commits once, preview independent", sr_k == 1 && sr_notes(mod) == (order ? 1 : 3) && sr_len_at(mod, 0, 60) == 1);
            if (!order) check("printed minor chord remains editable pitches", sr_len_at(mod, 0, 63) == 1 && sr_len_at(mod, 0, 67) == 1 && sr_len_at(mod, 0, 64) == 0);
            check("all audition notes released", seq_aud_count(K_C4) == 0);
            sr_stop();
        }
        {   /* I6 (#1311): an inversion key works in step recording as a chord button does: G5 held with min prints C minor's
             * 3rd inversion (72 75 79) into the track */
            panel_keys(0); sr_held = 0; sr_stop();
            check("inversion capture fixture loads", !load_fixture(fixtures[0]));
            for (uint32_t i = 0; i < E.nharm; i++) eng_set_param(E.harm[i].node, HARM_P_INVKEYS, ENG_ONE);
            pv_gen++; pages_ensure(); seq_select(0); page = 0; page_set(PAGE_SEQ); later(1500); octave = 0; panel_held = 0; sb_on = 0;
            int mod = eng_steps_module(0);
            sr_empty(mod); sr_preview = 1; sr_start(0, -1);
            sr_down(3);
            sr_down(26);
            check("I6: an inversion key does not enter or advance in step recording", sr_n == 0 && sr_k == 0 && sr_keys == 0);
            sr_down(K_C4);
            sr_up(K_C4);
            check("I6: min + G5 + C4 prints C minor's 3rd inversion (72 75 79)", sr_k == 1 && sr_notes(mod) == 3
                  && sr_len_at(mod, 0, 72) == 1 && sr_len_at(mod, 0, 75) == 1 && sr_len_at(mod, 0, 79) == 1);
            sr_up(26);
            sr_up(3);
            sr_stop();
        }
        panel_keys(0); sr_held = 0; sr_stop();
        check("full-note-pool fixture loads", !load_fixture(fixtures[0]));
        pv_gen++; pages_ensure(); seq_select(0); page = 0; page_set(PAGE_SEQ); later(1500);
        int full_mod = eng_steps_module(0); sr_empty(full_mod);
        uint32_t full_notes[128];
        for (uint32_t n = 0; n < 128u; n++) full_notes[n] = NW(0, 1, n, 100, 0);
        for (uint32_t p = 1; p <= 12u; p++) check("fill another pattern", eng_pattern_set_notes((uint32_t)full_mod, p, full_notes, 128));
        sr_start(0, -1); sr_down(K_C4); sr_up(K_C4);
        check("global note pool full does not advance or partly capture", sr_k == 0u && sr_notes(full_mod) == 0 && E.nnotes == ENG_MAX_NOTES);
        check("global note pool full explains rejected capture", !strcmp(msg_text, MSG_NOTE_MEMORY_FULL) || (seq_msg_due && !strcmp(seq_msg_due, MSG_NOTE_MEMORY_FULL)));
        sr_stop();
        /* A patch replacement can arrive before the next seq_poll and before the held key releases. */
        for (uint32_t bad = 0; bad < 2u; bad++) {
            panel_keys(0); sr_held = 0; sr_stop();
            check("reload entry fixture loads", !load_fixture(fixtures[0]));
            pv_gen++; pages_ensure(); seq_select(0); page = 0; page_set(PAGE_SEQ); later(1500);
            sr_start(0, -1); sr_down(K_C4);
            /* More than the legacy entry storage: many successive notes during a tied gesture. */
            for (uint32_t k = 0; k < 12u; k++) { sr_lfo(); sr_down(K_C4 + 2); sr_up(K_C4 + 2); }
            check("held gesture exceeds legacy entry capacity", sr_n > 27u);
            if (bad) { const uint8_t invalid[1] = {0}; check("failed load resets entry storage", eng_load(invalid, 1) < 0); }
            else check("legacy patch replaces chained entry storage", !load_fixture("build/panel-fixtures/steps-patterns.m1p"));
            /* No pages generation update or loop in between: the engine load itself invalidates the entry. */
            sr_key(K_C4, 0);
            check("stale entry never reads replacement storage", !sr_on && !sr_n && !sr_keys);
            sr_held = 0; panel_keys(0);
        }
        sr_preview = 1; page = 0; (void)load("808 KIT"); pv_gen++; screen_idle();
    }
    {   /* the owner's design (2026-10-24): on every page of every factory patch, reached by SELECT and ALGO (drawn in
         * passes, now and then stopped by a waiting click), and on every patch reached by PRESET (its toast first, the page
         * around it) and when its toast ends, the screen is the screen drawn whole, pixel for pixel; and the pixels each
         * costs, on average and at most */
        static uint16_t inc[240 * 240];
        uint32_t p, d, g, i, n, runs = 0, bad = 0, algo_n = 0, sel_n = 0, pre_n = 0, end_n = 0, outside_toast = 0;
        uint64_t algo_px = 0, sel_px = 0, pre_px = 0, end_px = 0;
        uint32_t algo_max = 0, sel_max = 0, pre_max = 0, end_max = 0;
#define SAME_AS_WHOLE(what) do { memcpy(inc, fb, sizeof inc); ui_dirty = 2; loop(); runs++; \
            for (i = 0, n = 0; i < 240u * 240u; i++) n += inc[i] != fb[i]; \
            if (n) { if (bad < 6u) { for (i = 0; inc[i] == fb[i]; i++) ; \
                printf("      (%s: %s device %u page %u: %u px differ, the first at %u,%u: %#06x, drawn whole %#06x)\n", what, \
                       PRESET_LIST[cur_preset].name, pg_cur_dev, pg_cur_page, n, i % 240u, i / 240u, inc[i], fb[i]); } bad++; } } while (0)
        sb_on = 0;
        page = 0;
        trail_n = 0;
        bank_mask = ((uint64_t)1 << N_PRESETS) - 1u;
        pages_waiting = stop_probe;
        for (p = 0; p < N_PRESETS; p++) {
            if (load_at(p))
                continue;
            cur_preset = p;
            pv_gen++;
            screen_idle();
            later(1100);
            for (d = 0; d < pg_ndev; d++)
                for (g = 0; g < pg_dev[d].npg; g++) {
                    if (!d && !g)
                        continue;
                    stop_answer = (d + g) % 5u == 3u;       /* (now and then a click waits: the draw stops, then goes on) */
                    lcd_px = 0;
                    if (g)
                        enc(1, 1);                          /* ALGO */
                    else {
                        (void)pages_focus(d - 1u, pg_dev[d - 1u].npg - 1u);   /* (from the last page of the device before) */
                        ui_dirty = 2;
                        loop();
                        lcd_px = 0;
                        enc(0, 1);                          /* SELECT */
                    }
                    if (!stop_answer) {
                        if (g) {
                            algo_px += lcd_px;
                            algo_n++;
                            algo_max = lcd_px > algo_max ? lcd_px : algo_max;
                        } else {
                            sel_px += lcd_px;
                            sel_n++;
                            sel_max = lcd_px > sel_max ? lcd_px : sel_max;
                        }
                    }
                    stop_answer = 0;
                    loop();
                    if (pg_cur_dev != d || pg_cur_page != g) {
                        printf("      (%s: SELECT / ALGO reached device %u page %u, not %u %u)\n", PRESET_LIST[p].name, pg_cur_dev,
                               pg_cur_page, d, g);
                        bad++;
                    }
                    SAME_AS_WHOLE(g ? "ALGO" : "SELECT");
                }
        }
        preset_loads = 1;                                   /* PRESET through the bank, every patch in turn */
        cur_preset = N_PRESETS - 1u;
        (void)load_at(cur_preset);
        pv_gen++;
        screen_idle();
        later(1100);
        for (p = 0; p < N_PRESETS; p++) {
            static uint16_t plain[240 * 240];
            memcpy(plain, fb, sizeof plain);
            fb_watch_reset();
            lcd_px = 0;
            patch_enc(1);
            pre_px += lcd_px;
            pre_n++;
            pre_max = lcd_px > pre_max ? lcd_px : pre_max;
            if (cur_preset != p || !toast_scr || !on_screen(PRESET_LIST[p].name)) {
                printf("      (PRESET to %s: slot %u, toast %u, its name %s)\n", PRESET_LIST[p].name, (unsigned)cur_preset, toast_scr,
                       on_screen(PRESET_LIST[p].name) ? "shown" : "not shown");
                bad++;
            }
            SAME_AS_WHOLE("PRESET");
            fb_watch_reset();
            lcd_px = 0;
            later(1100);                                    /* the toast's end: its band alone */
            if (pages_sounds() > 1u) {                      /* (#582: a patch of more sounds says so in the bar for 2 s: its end
                                                             * is the bar's, apart) */
                later(1000);
                continue;
            }
            end_px += lcd_px;
            end_n++;
            end_max = lcd_px > end_max ? lcd_px : end_max;
            outside_toast += fb_changed_in(0, 0, 240, toast_top);
            SAME_AS_WHOLE("the toast's end");
            (void)plain;
        }
        preset_loads = 0;
        pages_waiting = 0;
#undef SAME_AS_WHOLE
        printf("      pages and patches: %u compared, %u differ; LCD px a click: ALGO %u (most %u), SELECT %u (most %u), PRESET %u"
               " (most %u), the toast's end %u (most %u)\n", runs, bad, (unsigned)(algo_px / (algo_n ? algo_n : 1u)), algo_max,
               (unsigned)(sel_px / (sel_n ? sel_n : 1u)), sel_max, (unsigned)(pre_px / (pre_n ? pre_n : 1u)), pre_max,
               (unsigned)(end_px / (end_n ? end_n : 1u)), end_max);
        check("SELECT, ALGO and PRESET on every page of every factory patch, and the toast's end: the screen drawn whole, pixel"
              " for pixel", runs > 200u && bad == 0u);
        check("the toast's end: only its band drawn again", outside_toast == 0u && end_max <= 240u * (LK_TOH + 4u));
    }
    check("no renderer wrote the line buffer the LCD was still reading (#377: lcd_line is the other one, afresh each row)",
          lcd_line_clobbers == 0u);
    {   /* a module with its own name (#518, format 49: a device of kind 2): golden.ts's fm-3pm-index kit names its carrier */
        FILE *f = fopen("build/golden/fm-3pm-index.m1p", "rb");
        if (!f)
            printf("skip  named module: no build/golden/fm-3pm-index.m1p (tools/golden.sh writes it)\n");
        else {
            uint32_t d, n = 0, plain = 0;
            pv_len = (uint32_t)fread(pv_bin, 1, sizeof pv_bin, f);
            fclose(f);
            check("named module: the patch loads (format 49)", pv_bin[1] == 49u && eng_load(pv_bin, pv_len) == 0);
            pv_gen++;
            page = 0;
            pg_list_btn = -1;
            pages_ensure();
            for (d = 0; d < pg_ndev; d++)
                if (pg_dev[d].module >= 0 && eng_type((uint32_t)pg_dev[d].module) == T_OSC) {
                    n++;
                    plain += pg_dev[d].nlen == 10u && !memcmp(pg_dev[d].name, "OSCILLATOR", 10);
                }
            for (d = 0; d < pg_ndev && !(pg_dev[d].nlen == 11u && !memcmp(pg_dev[d].name, "saw carrier", 11)); d++)
                ;
            check("named module: the carrier is a device by its name, its pages the oscillator's under that name",
                  d < pg_ndev && pg_dev[d].module >= 0 && eng_type((uint32_t)pg_dev[d].module) == T_OSC &&
                  pg_dev[d].npg == (OSC_NPAR + 3u) / 4u && pg_page[pg_dev[d].pg0].name == pg_dev[d].name);
            check("named module: the other oscillators keep their type's name", n == 4u && plain == 3u);
        }
    }
    {   /* a card row that sets several parameters and a Selector's named positions (#357, #358): golden.ts's card-rows kit
         * (test-patches.ts cardRows): the voice's page is CUTOFF (both filters), RES (both), SOURCE (LOW HIGH RAW, 3 in use),
         * COUNT */
        FILE *f = fopen("build/golden/card-rows.m1p", "rb");
        if (!f)
            printf("skip  card rows: no build/golden/card-rows.m1p (tools/golden.sh writes it)\n");
        else {
            uint32_t d, mf, mg, ms, cut, res;
            const ppage_t *pg;
            const uint8_t *x;
            uint32_t m, j;
            int32_t v, was;
            pv_len = (uint32_t)fread(pv_bin, 1, sizeof pv_bin, f);
            fclose(f);
            check("card rows: the patch loads", eng_load(pv_bin, pv_len) == 0);
            pv_gen++;
            page = 0;
            pg_list_btn = -1;
            pages_ensure();
            for (d = 0; d < pg_ndev && !(pg_dev[d].nlen == 5u && !memcmp(pg_dev[d].name, "voice", 5)); d++)
                ;
            check("card rows: the voice is a device", d < pg_ndev);
            pages_focus(d, 0);
            later(50);
            pg = pages_now();
            x = row_more(pg, 0);
            check("card rows: its page has four rows; cutoff, res and source carry extras, count none",
                  pg->nrows == 4u && x && x[0] == 1u && row_more(pg, 1) && row_more(pg, 2) && !row_more(pg, 3));
            mf = pg->mod[0];
            cut = pg->par[0];
            mg = x[1];
            res = pg->par[1];
            ms = pg->mod[2];
            check("card rows: the cutoff row's other parameter is the second filter's cutoff", x[2] == cut && mg != mf);
            was = eng_get_param(mg, cut);
            enc(2u, 4);                                     /* K1 */
            check("card rows: K1 moves both filters' cutoff, to the same value",
                  eng_get_param(mf, cut) != was && eng_get_param(mg, cut) == eng_get_param(mf, cut));
            enc(3u, -3);                                    /* K2 */
            check("card rows: K2 moves both resonances", eng_get_param(mg, res) == eng_get_param(mf, res) && eng_get_param(mf, res) != 26214);
            pages_set_unit(0u, 0, &m, &j, &v);              /* MIDI CC 16 at 0: as main.c applies it */
            eng_knob_param(0u, m, j, v);
            pages_also(0u, v);
            check("card rows: a MIDI CC on K1 moves both too", eng_get_param(mg, cut) == eng_get_param(mf, cut) && v == eng_get_param(mf, cut));
            check("  and ramps the cutoff as a click does (#405)", ramp[0].left == ENG_RAMP_BLOCKS && ramp[0].mod == m && ramp[0].par == j);
            later(50);
            check("card rows: SOURCE shows position 2 by its name, HIGH", eng_get_param(ms, 0) == (2 << 16) && on_screen("HIGH"));
            enc(4u, 5);                                     /* K3, five clicks up: three positions in use */
            later(50);
            check("card rows: SOURCE stops at the last position in use, RAW", eng_get_param(ms, 0) == (3 << 16) && on_screen("RAW") && pages_cc(2u) == 127u);
            enc(4u, -5);
            later(50);
            check("card rows: and at the first, LOW", eng_get_param(ms, 0) == (1 << 16) && on_screen("LOW") && pages_cc(2u) == 0u);
            pages_set_unit(2u, 65536, &m, &j, &v);          /* MIDI CC 18 at 127: the last position in use */
            check("card rows: CC 18 at its top is position 3", m == ms && v == (3 << 16));
            enc(5u, 2);                                     /* K4: COUNT 3 -> 5 */
            enc(4u, 9);
            later(50);
            check("card rows: with five in use SOURCE reaches 5, by its number (it has no name)",
                  eng_get_param(ms, 0) == (5 << 16) && !on_screen("RAW") && !on_screen("HIGH"));
            enc(4u, -3);                                    /* back to HIGH: PANEL_SNAP_ROWS=file.ppm shows the page */
            later(50);
            snap_to(getenv("PANEL_SNAP_ROWS"));
        }
    }
    {   /* the 909 Kit's one hi-hat LEVEL (#1124): the hihat LEVEL row also sets the open hat's level VCA, which sits in the
         * sibling open hat card inside the 909 kit card; a K knob turn and a card preset load set both */
        uint32_t d, g, k, fg = 0, fk = 0, found = 0, ch = 0, oh = 0, gain = 0;
        int32_t was;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        check("909 Kit: loads", load("909 KIT") == 0);
        pv_gen++;
        page = 0;
        trail_n = 0;
        pg_list_btn = -1;
        pages_ensure();
        for (d = 0; d < pg_ndev && !(pg_dev[d].nlen == 7u && !memcmp(pg_dev[d].name, "909 kit", 7)); d++)
            ;
        check("909 Kit: the 909 kit card is a device", d < pg_ndev);
        for (g = 0; d < pg_ndev && !found && g < pg_dev[d].npg; g++)
            for (k = 0; !found && k < pg_page[pg_dev[d].pg0 + g].nrows; k++) {
                const ppage_t *pg = &pg_page[pg_dev[d].pg0 + g];
                const uint8_t *x = row_more(pg, k);
                if (x && x[0] == 1u && eng_type(pg->mod[k]) == T_VCA && eng_type(x[1]) == T_VCA && x[2] == pg->par[k]) {
                    found = 1;
                    fg = g;
                    fk = k;
                    ch = pg->mod[k];
                    oh = x[1];
                    gain = pg->par[k];
                }
            }
        check("909 Kit: one VCA level row also sets a second VCA (the hihat LEVEL: closed and open hat)", found && ch != oh);
        if (found) {
            pages_focus(d, fg);
            later(50);
            was = eng_get_param(oh, gain);
            enc(2u + fk, -4);
            check("909 Kit: turning hihat LEVEL down moves the closed and the open hat's VCA, to the same value",
                  eng_get_param(ch, gain) < was && eng_get_param(oh, gain) == eng_get_param(ch, gain));
            (void)dp_list(d);
            check("909 Kit: its Init preset sets both back", dp_load(d, 0) == 0 && eng_get_param(ch, gain) == was
                  && eng_get_param(oh, gain) == was);
        }
    }
    /* The panel's two recording entry points preview the same reverse step as playback. */
    {
        FILE *f = fopen("build/panel-fixtures/steps-direction-1-64.m1p", "rb");
        check("direction fixture exists", f != 0);
        if (f) {
            uint32_t st, i, count;
            int32_t l[128], r[128];
            const uint32_t *notes;
            uint32_t held = NW(63u, 4u, 90u, 100u, 0u);
            pv_len = (uint32_t)fread(pv_bin, 1, sizeof pv_bin, f);
            fclose(f);
            check("format 44 loads a long note at the last step", eng_load(pv_bin, pv_len) == 0);
            for (st = 0; st < E.nmod && E.node[st].type != T_STEPS; st++) ;
            check("direction fixture has a track", st < E.nmod);
            if (st < E.nmod) {
                check("TRACK retains duration independently of start", eng_steps_set_notes(st, &held, 1u));
                count = (uint32_t)eng_steps_notes(st, &notes);
                check("a held reverse note retains all four steps", count == 1u && NW_AT(notes[0]) == 63u && NW_LEN(notes[0]) == 4u);
                eng_set_param(0, FM1_P_TEMPO, 120 << 16);
                eng_set_param(st, STEPS_P_LEN, 4 << 16);
                eng_set_param(st, STEPS_P_RATE, 4 << 16);
                eng_set_param(st, STEPS_P_SWING, 50 << 16);
                eng_transport(1);
                for (i = 0; i < 32u; i++) eng_render(l, r, 128);
                check("reverse starts at the last step", eng_steps_pos(st) == 3);
                check("panel hit records ahead at reverse step 3", eng_steps_hit(st, 0, 1) == 2);
                check("panel drum hit records ahead at reverse step 3", eng_steps_hit_note(st, 61u, 0, 1) == 2);
                for (i = 0; i < 24u; i++) eng_render(l, r, 128);
                check("reverse reaches the recorded step next", eng_steps_pos(st) == 2);
            }
        }
    }
    {                                                       /* #395: the SEQ page arms what it shows, SEL on environment rows
                                                             * layers, the last one out leaves the keys WIRED; SEL arming
                                                             * another track ends a take */
        int drums, pat, dd = -1, dp = -1;
        uint32_t d;
        foot_t f;
        while (page != 0u && trail_n)
            tap(BTN_HOME);
        if (eng_transport_running())
            tap(BTN_PLAY);
        (void)load("<7PH");                                  /* DRUMS, PATTERN */
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        loop();
        drums = eng_steps_module(0);
        pat = eng_steps_module(1);
        check("(<7PH loads with nothing armed: WIRED)", drums >= 0 && pat >= 0 && m64(eng_arm_mask_get()) == 0u);
        seq_trk = 0;
        tap(BTN_SEQ);
        check("SEQ: the page arms the track it shows", page == PAGE_SEQ && seq_trk == 0u && m64(eng_arm_mask_get()) == (uint64_t)1 << drums);
        check("  its track line: ARMED, then the ALGO and clear hints where they fit (#450)", strstr(seq_grid_text[1], "  ARMED  ALGO track  SEQ+REC clear") != 0);
        enc(1, 1);
        check("ALGO there: the track it shows now armed, the one before disarmed", seq_trk == 1u && m64(eng_arm_mask_get()) == (uint64_t)1 << pat);
        later(1500);
        check("  its bar: PATTERN ARM", bar_roll("PATTERN" MSG_BAR_ARM, "P01", C_ACC));
        (void)load("<7PH");                                  /* another patch while the page shows (the editor's Send) */
        pv_gen++;
        loop();
        check("another patch while the SEQ page shows: the track it shows armed again", page == PAGE_SEQ
              && m64(eng_arm_mask_get()) == (uint64_t)1 << eng_steps_module(seq_trk));
        tap(BTN_SEQ);
        eng_arm_mask(s64(0));
        pages_ensure();
        for (d = 0; d < pg_ndev; d++) {
            if (pg_dev[d].module == drums)
                dd = (int)d;
            if (pg_dev[d].module == pat)
                dp = (int)d;
        }
        pages_focus((uint32_t)dd, 0);
        loop();
        tap(4);
        check("(the environment on DRUMS' row)", page == PAGE_ENV && pg_cur_dev == (uint32_t)dd && dp >= 0);
        tap(3);
        pages_select(dp - dd);
        loop();
        tap(3);
        check("SEL on two environment rows: both armed (a layer)", page == PAGE_ENV && pg_cur_dev == (uint32_t)dp
              && m64(eng_arm_mask_get()) == ((uint64_t)1 << drums | (uint64_t)1 << pat) && env_armed((uint32_t)dd) && env_armed((uint32_t)dp));
        {                                                   /* #191: a key with two armed reaches both, as engine.ts plays a set */
            static int32_t l2[128], r2[128];
            uint32_t hd = 0, hp = 0;
            th = thru_head;
            panel_keys(1u << 7);                            /* C4 */
            eng_render(l2, r2, 128);
            {
                uint16_t h;
                for (h = th; h != thru_head; h++) {
                    hd |= thru_ring[h % ENG_THRU][0] == (uint8_t)drums && (thru_ring[h % ENG_THRU][1] & 0x80u);
                    hp |= thru_ring[h % ENG_THRU][0] == (uint8_t)pat && (thru_ring[h % ENG_THRU][1] & 0x80u);
                }
            }
            panel_keys(0);
            eng_render(l2, r2, 128);
            loop();
            printf("      (two armed, a key: DRUMS %s, PATTERN %s)\n", hd ? "heard" : "-", hp ? "heard" : "-");
            check("  a key with both armed plays through both tracks (#191)", hd && hp);
        }
        pages_select(dd - dp);
        loop();
        tap(3);
        check("SEL on the first again: only the second stays armed", m64(eng_arm_mask_get()) == (uint64_t)1 << pat && !strcmp(msg_text, "DRUMS" MSG_DISARMED));
        pages_select(dp - dd);
        loop();
        tap(3);
        check("SEL on the last one armed: nothing armed, the keys WIRED", m64(eng_arm_mask_get()) == 0u && !strcmp(msg_text, MSG_KEYS_WIRED));
        tap(4);
        later(1500);
        printf("      (the footer: \"%s\" \"%s\")\n", (foot_layout(&f), f.a), f.w);
        check("  the device page's footer: KEYS WIRED", page == 0u && (foot_layout(&f), !strcmp(f.w, MSG_KEYS_WIRED)) && on_screen(MSG_KEYS_WIRED));
        pages_focus((uint32_t)dp, 0);                       /* a take on PATTERN, then SEL on DRUMS' page: DRUMS records instead */
        loop();
        tap(3);
        tap(BTN_PLAY);
        tap(BTN_REC);
        check("(a take on PATTERN, the device page)", page == 0u && seq_rec && eng_armed() == pat && (E.trk_rec >> E.node[pat].trk & 1u));
        pages_focus((uint32_t)dd, 0);
        loop();
        tap(3);
        check("SEL on another track's page while recording: that track armed alone and recording, REC goes on", m64(eng_arm_mask_get()) == (uint64_t)1 << drums
              && seq_rec && !(E.trk_rec >> E.node[pat].trk & 1u) && (E.trk_rec >> E.node[drums].trk & 1u));
        tap(BTN_PLAY);
        eng_arm_mask(s64(0));
        later(1500);
    }

    /* patterns and songs on the panel (#375, D-541, D-544): PRESET on the SEQ page picks the patch's pattern (at once while
     * stopped, at the end of the pass while running; the bar shows both), SEL tapped opens the SONG page, its knobs edit
     * the song, SEQ held + REC deletes an entry (asked first), SEL goes back; SEL held as the pen opens nothing */
    {
        int32_t l[128], r[128];
        uint32_t i, told;
        int mod;
        eng_transport(0);
        check("patterns fixture loads", load_fixture("build/panel-fixtures/steps-patterns.m1p") == 0);
        pv_gen++;
        eng_render(l, r, 128);
        if (page != PAGE_SEQ)
            page_set(PAGE_SEQ);
        seq_select(0);
        ui_dirty = 2;
        loop();
        mod = seq_module();
        check("the SEQ bar shows the pattern (P01)", bar_roll("STEPS 1" MSG_BAR_ARM, "P01", C_ACC));
        told = host_pattern_told;
        enc(6, 1);
        eng_render(l, r, 128);
        later(1100);
        check("PRESET on the SEQ page: pattern 2, at once while stopped, the editor told", eng_pattern() == 1
              && eng_pattern_playing((uint32_t)mod) == 1 && host_pattern_told == told + 1u);
        check("  the bar: P02; the page: its own length (5 steps)", bar_roll("STEPS 1" MSG_BAR_ARM, "P02", C_ACC) && seq_len(mod) == 5);
        eng_transport(1);
        for (i = 0; i < 4u; i++)
            eng_render(l, r, 128);
        enc(6, 1);
        later(1100);
        check("running: pattern 3 waits for the end of the track's pass", eng_pattern() == 2 && eng_pattern_playing((uint32_t)mod) == 1
              && eng_pattern_queued((uint32_t)mod) == 2);
        check("  the bar: P02>P03", bar_roll("STEPS 1" MSG_BAR_ARM, "P02>P03", C_ACC));
        for (i = 0; i < 800u && eng_pattern_playing((uint32_t)mod) != 2; i++)
            eng_render(l, r, 128);
        loop();
        check("  at the end of the pass: P03 (its own length, 12 steps)", eng_pattern_playing((uint32_t)mod) == 2
              && bar_roll("STEPS 1" MSG_BAR_ARM, "P03", C_ACC) && seq_len(mod) == 12);
        eng_transport(0);
        eng_render(l, r, 128);
        tap(BTN_SEL);
        check("SEL tapped on the SEQ page: the SONG page, song 1, empty (END); its bar, not STAYS ARMED (#582)", page == PAGE_SONG
              && song_sel == 0 && song_len() == 0 && on_screen("END") && on_screen(MSG_SONG "1") && !on_screen(MSG_STAYS_ARMED));
        told = host_song_told;
        enc(2, 1);
        check("K1 on END: an entry of the selected pattern, the editor told", song_len() == 1 && (eng_song_get(0, 0) & 0xFF) == 2
              && host_song_told == told + 1u);
        enc(2, 2);
        enc(3, -3);
        check("K1: its pattern, K2: its shift", eng_song_get(0, 0) == (4 | (0xFD << 8)) && on_screen("01  P05  -3"));
        panel_held |= 1u << BTN_ACC;
        enc(2, 1);
        panel_held &= ~(1u << BTN_ACC);
        check("FX + K1: a copy of it inserted before it", song_len() == 2 && eng_song_get(0, 1) == eng_song_get(0, 0));
        enc(5, 1);
        check("K4 right: the song plays", eng_song() == 1);
        {                                               /* (#582: the entry playing, its marker; stopped, none) */
            uint32_t x, y, tri = 0;
            enc(0, 5);                                  /* (the cursor on END: the entry's row not the cursor's bar) */
            later(1100);
            check("  stopped: the bar says SONG 1 STOPPED, no entry marked", bar_shows(MSG_SONG "1" MSG_SONG_STOPPED, C_ACC) && song_playing() < 0);
            eng_transport(1);
            for (i = 0; i < 4u; i++)
                eng_render(l, r, 128);
            loop();
            for (y = SONG_Y; y < SONG_Y + 14u; y++)
                for (x = 8u; x < 15u; x++)
                    tri += px(x, y) == C_ACC;
            check("  PLAY: entry 01 marked, a coral triangle before its number; the bar says SONG 1 PLAYS", song_playing() == 0
                  && tri >= 20u && on_screen("01  P05  -3") && bar_shows(MSG_SONG "1" MSG_SONG_RUNS, C_ACC));
            snap_to(getenv("PANEL_SNAP_SONG"));
            {
                static uint16_t w0[240 * 240];
                memcpy(w0, fb, sizeof w0);
                ui_full = 1;
                loop();
                check("  the marked row drawn in place = drawn whole", !memcmp(w0, fb, sizeof w0));
            }
            eng_transport(0);
            eng_render(l, r, 128);
            loop();
            for (tri = 0, y = SONG_Y; y < SONG_Y + 14u; y++)
                for (x = 8u; x < 15u; x++)
                    tri += px(x, y) == C_ACC;
            check("  stopped again: no marker, SONG 1 STOPPED", !tri && bar_shows(MSG_SONG "1" MSG_SONG_STOPPED, C_ACC));
            {                                           /* PLAY from the cursor's entry (#596): Song Position + Continue */
                int at = mlen = 0, t = eng_song_ticks((uint32_t)mod, 0, 1), f2 = 0, k;   /* (the MIDI log holds 256: empty) */
                uint32_t spp = t > 0 ? (uint32_t)t / 6u : 0u;
                enc(0, -1);                             /* (END to entry 02) */
                tap(BTN_PLAY);
                for (i = 0; i < 4u; i++)
                    eng_render(l, r, 128);
                loop();
                check("PLAY on entry 02: Song Position (its start: entry 01's pass in sixteenths), then Continue, no Start; the "
                      "track starts on entry 02, the run ticks from the song's top", spp > 0 && sent(at, 0xF2u, spp & 127u, spp >> 7)
                      && sent(at, 0xFBu, 0xFFu, 0xFFu) && !sent(at, 0xFAu, 0xFFu, 0xFFu) && eng_transport_running() && song_playing() == 1
                      && eng_run_ticks() >= (int32_t)(6u * spp));
                tap(BTN_PLAY);
                eng_render(l, r, 128);
                at = mlen;
                enc(0, -1);                             /* (entry 01) */
                tap(BTN_PLAY);
                for (i = 0; i < 4u; i++)
                    eng_render(l, r, 128);
                loop();
                for (k = at; k < mlen; k++)
                    f2 += mlog[k][0] == 0xF2u;
                check("  PLAY on entry 01: Start, from the top", sent(at, 0xFAu, 0xFFu, 0xFFu) && !f2 && song_playing() == 0
                      && eng_run_ticks() < 24);
                tap(BTN_PLAY);
                eng_render(l, r, 128);
                loop();
            }
            enc(0, -5);
        }
        enc(5, -1);
        check("K4 left: the pattern plays again", eng_song() == 0);
        enc(1, 1);
        check("ALGO: song 2 (empty)", song_sel == 1 && song_len() == 0);
        enc(1, -1);
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        panel_held |= 1u << BTN_REC;
        panel_edges(1u << BTN_REC, 0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("SEQ held + REC on the SONG page: it asks first", song_len() == 2 && song_del_at != 0u);
        panel_held |= 1u << BTN_REC;
        panel_edges(1u << BTN_REC, 0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        check("  REC again: the entry deleted", song_len() == 1);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  SEQ let go: the SONG page stays", page == PAGE_SONG);
        tap(BTN_SEL);
        check("SEL on the SONG page: back to the SEQ page", page == PAGE_SEQ);
        panel_held |= 1u << BTN_SEL;
        panel_edges(1u << BTN_SEL, 0);
        panel_keys(1u << 5);
        panel_keys(0);
        panel_held &= ~(1u << BTN_SEL);
        panel_edges(0, 1u << BTN_SEL);
        loop();
        check("SEL held with a key (the pen): its release opens nothing", page == PAGE_SEQ);
        enc(6, -2);
        eng_render(l, r, 128);
        check("PRESET back to pattern 1", eng_pattern() == 0 && eng_pattern_playing((uint32_t)mod) == 0);
    }
    /* the pattern commands (#1177, #1178, D-544): SEQ held + SAVE copies the selected pattern of every track to the first
     * empty number after it (round from P02) and selects it; SEQ held + HOME clears every pattern and song, asked first.
     * The fixture holds patterns 1 to 4 (pattern 4 only an empty one on the second track) and the song made above */
    {
        uint32_t told = host_op_told, t, k, ok;
        int m0 = eng_steps_module(0), m1 = eng_steps_module(1);
        const uint32_t *w, *x;
        enc(6, 1);                                      /* (pattern 2: on both tracks) */
        later(1100);
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SAVE);
        loop();
        ok = eng_pattern() == 4 && eng_pattern_has((uint32_t)m0, 4) && eng_pattern_has((uint32_t)m1, 4);
        for (t = 0; ok && t < 2u; t++) {
            int mm = eng_steps_module(t), n = eng_pattern_notes((uint32_t)mm, 1, &w);
            ok = n == eng_pattern_notes((uint32_t)mm, 4, &x) && !memcmp(w, x, 4u * (uint32_t)n)
                 && eng_pattern_len((uint32_t)mm, 1) == eng_pattern_len((uint32_t)mm, 4);
        }
        check("SEQ held + SAVE on pattern 2: every track's pattern 2 copied to pattern 5 (3 and 4 are used), its notes and "
              "length, and selected; the editor told (PATTERN_OP copy 2 to 5)", ok && host_op_told == told + 1u
              && host_op_last[0] == 1u && host_op_last[1] == 1u && host_op_last[2] == 4u);
        check("  the bar: P02 COPIED TO P05", strstr(msg_text, "P02" MSG_COPIED_TO "P05") != 0);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  SEQ let go: the SEQ page stays, the patch not saved", page == PAGE_SEQ);
        {                                               /* (#1202 P1: SEL held + SAVE's pattern save went) */
            int was = saved, pat = eng_pattern();
            panel_held |= 1u << BTN_SEL;
            panel_edges(1u << BTN_SEL, 0);
            tap(BTN_SAVE);
            loop();
            panel_held &= ~(1u << BTN_SEL);
            panel_edges(0, 1u << BTN_SEL);
            loop();
            check("SEL held + SAVE on the SEQ page: nothing, the patch not saved, SEL's release opens nothing",
                  saved == was && page == PAGE_SEQ && eng_pattern() == pat);
        }
        {                                               /* a pattern the track takes on its own (queued, at once while
                                                         * stopped: PRESET, a stored pattern loaded), after the page was drawn with the
                                                         * old one: the cells follow, not only the bar */
            static uint16_t keep[240 * 240];
            int pat = eng_pattern(), mod = eng_steps_module(0), was, to;
            blocks(2);
            later(200);
            was = eng_pattern_playing((uint32_t)mod);
            to = was ? 0 : 1;                           /* (P01 holds other notes than P02 and its copy P05) */
            eng_pattern_set((uint32_t)to);
            ui_dirty = ui_dirty ? ui_dirty : 1;
            loop();                                     /* (drawn before the engine takes it) */
            blocks(2);
            seq_shown_pos = (int8_t)eng_steps_pos((uint32_t)mod);   /* (the playhead as drawn: only the pattern changed,
                                                         * as with Silver Box's P02 in emu:smoke seq-50) */
            later(1700);
            memcpy(keep, fb, sizeof keep);
            ui_dirty = 2;
            loop();
            check("a pattern the track takes while stopped, after a redraw: the SEQ page shows its cells (what a whole "
                  "redraw draws)", eng_pattern_playing((uint32_t)mod) == to && !memcmp(keep, fb, sizeof keep));
            eng_pattern_set((uint32_t)pat);
            blocks(2);
            later(1700);
        }
        enc(6, -1);
        later(1100);
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SAVE);
        loop();
        check("pattern 4 (no notes on any track): P04 EMPTY: NOT COPIED, nothing copied", eng_pattern() == 3
              && strstr(msg_text, "P04" MSG_NOT_COPIED) != 0 && host_op_told == told + 1u && !eng_pattern_has((uint32_t)m0, 5));
        enc(6, 1);                                      /* (pattern 5: copies to 6, 7, .. 64) */
        later(1100);
        for (k = 5; k < 64u; k++)
            tap(BTN_SAVE);
        loop();
        check("copies on to pattern 64, each the next empty number after the last", eng_pattern() == 63 && eng_pattern_has((uint32_t)m1, 63));
        tap(BTN_SAVE);
        loop();
        check("  all 64 used: ALL 64 PATTERNS USED, nothing changes", eng_pattern() == 63 && strstr(msg_text, MSG_ALL_USED) != 0);
        eng_pattern_drop((uint32_t)m0, 5);
        eng_pattern_drop((uint32_t)m1, 5);
        tap(BTN_SAVE);
        loop();
        check("  pattern 6 emptied: a copy of pattern 64 goes round to it (none empty after 64)", eng_pattern() == 5
              && eng_pattern_has((uint32_t)m0, 5) && strstr(msg_text, "P64" MSG_COPIED_TO "P06") != 0);
        eng_pattern_drop((uint32_t)m0, 6);
        eng_pattern_drop((uint32_t)m1, 6);
        host_patterns_room = 0;
        told = host_op_told;
        tap(BTN_SAVE);
        loop();
        host_patterns_room = 1;
        check("  the patch has no room: PATCH FULL: NOT COPIED, pattern 7 stays empty, the editor not told", eng_pattern() == 5
              && !eng_pattern_has((uint32_t)m0, 6) && !eng_pattern_has((uint32_t)m1, 6) && strstr(msg_text, MSG_FULL_NOT_COPIED) != 0
              && host_op_told == told);
        tap(BTN_HOME);
        loop();
        check("SEQ held + HOME: it asks first (CLEAR ALL? HOME AGAIN), nothing cleared, the page stays", seq_all_at != 0u
              && strstr(msg_text, MSG_CLEAR_ALL) != 0 && eng_pattern_has((uint32_t)m0, 1) && page == PAGE_SEQ);
        panel_keys(1u << 3);
        panel_keys(0);
        loop();
        check("  a key meanwhile: NOT CLEARED", !seq_all_at && strstr(msg_text, MSG_NOT_CLEARED) != 0 && eng_pattern_has((uint32_t)m0, 1));
        tap(BTN_HOME);
        later(3100);
        tap(BTN_HOME);
        loop();
        check("  HOME again after 3 s: only asks again", seq_all_at != 0u && eng_pattern_has((uint32_t)m0, 1));
        told = host_op_told;
        tap(BTN_HOME);
        loop();
        ok = eng_pattern() == 0 && !eng_song() && eng_pattern_notes((uint32_t)m0, 0, &w) == 0 && eng_pattern_notes((uint32_t)m1, 0, &w) == 0;
        for (k = 1; ok && k < 64u; k++)
            ok = !eng_pattern_has((uint32_t)m0, k) && !eng_pattern_has((uint32_t)m1, k);
        for (k = 0; ok && k < ENG_SONGS; k++)
            ok = !eng_song_len(k);
        check("  HOME again within 3 s: every pattern and song cleared, pattern 1 empty and selected; the editor told", ok
              && !eng_locks_count() && strstr(msg_text, MSG_ALL_CLEARED) != 0 && host_op_told == told + 1u && host_op_last[0] == 2u);
        tap(BTN_HOME);
        loop();
        check("  SEQ held + HOME on an empty patch: NOTHING TO CLEAR, no question", !seq_all_at && strstr(msg_text, MSG_NOTHING_TO_CLEAR) != 0);
        tap(BTN_SEL);
        loop();
        check("  SEQ held + SEL without a pattern store: NO PATTERN STORE, no browser, no SONG page (#1202 G8)", !seq_br_at
              && strstr(msg_text, MSG_NO_PATTERN_STORE) != 0 && page == PAGE_SEQ);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  SEQ let go: the SEQ page stays", page == PAGE_SEQ);
        check("patterns fixture loads again", load_fixture("build/panel-fixtures/steps-patterns.m1p") == 0);
        pv_gen++;
    }
    /* the double (D-838): SEQ held + OCT+ makes the selected pattern of every track twice as long, its steps repeated, on
     * the press; OCT+'s release changes neither the octave nor the step page, SEQ's leaves the page. Running, the tracks
     * go on where they are. Refused (the patch's bytes, 64 steps), nothing changes and the editor is not told */
    {
        uint32_t told = host_op_told, p, pg;
        int m0 = eng_steps_module(0), m1 = eng_steps_module(1), l0, l1, n0, oct = octave, pos0, pos1;
        const uint32_t *w;
        char want[28];
        if (page != PAGE_SEQ)
            page_set(PAGE_SEQ);
        loop();
        p = (uint32_t)eng_pattern();
        l0 = eng_steps_len((uint32_t)m0);
        l1 = eng_steps_len((uint32_t)m1);
        n0 = eng_pattern_notes((uint32_t)m0, p, &w);
        pg = seq_pg;
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_OCT_UP);
        loop();
        check("SEQ held + OCT+: every track's pattern twice as long, the first's notes twice; the editor told (PATTERN_OP "
              "double)", eng_steps_len((uint32_t)m0) == 2 * l0 && eng_steps_len((uint32_t)m1) == 2 * l1
              && eng_pattern_notes((uint32_t)m0, p, &w) == 2 * n0 && host_op_told == told + 1u && host_op_last[0] == 4u && host_op_last[1] == p);
        snprintf(want, sizeof want, "%s%d%s", MSG_DOUBLED, 2 * (l0 > l1 ? l0 : l1), MSG_STEPS_AFTER);
        check("  the bar: DOUBLED: <the longest track> STEPS", strstr(msg_text, want) != 0);
        check("  OCT+'s release: the octave and the step page stay", octave == oct && seq_pg == pg);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  SEQ let go: the SEQ page stays", page == PAGE_SEQ);
        tap(BTN_PLAY);
        blocks(300);
        pos0 = eng_steps_pos((uint32_t)m0);
        told = host_op_told;
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        host_patterns_room = 0;
        tap(BTN_OCT_UP);
        loop();
        host_patterns_room = 1;
        check("the patch has no room: PATCH FULL: NOT DOUBLED, nothing changes, the editor not told", eng_steps_len((uint32_t)m0) == 2 * l0
              && strstr(msg_text, MSG_DOUBLE_FULL) != 0 && host_op_told == told);
        tap(BTN_OCT_UP);
        blocks(1);
        pos1 = eng_steps_pos((uint32_t)m0);
        check("doubled while playing: the transport goes on, the track where it was", eng_transport_running() && eng_steps_len((uint32_t)m0) == 4 * l0
              && pos0 >= 0 && pos1 >= pos0 && pos1 < 2 * l0);
        while (eng_steps_len((uint32_t)m0) <= 32 && eng_steps_len((uint32_t)m1) <= 32)
            tap(BTN_OCT_UP);
        l0 = eng_steps_len((uint32_t)m0);
        told = host_op_told;
        tap(BTN_OCT_UP);
        loop();
        check("  past 64 steps: 64 STEPS MAX: NOT DOUBLED, nothing changes", eng_steps_len((uint32_t)m0) == l0
              && strstr(msg_text, MSG_DOUBLE_STEPS) != 0 && host_op_told == told);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        tap(BTN_PLAY);
        loop();
        check("patterns fixture loads again", load_fixture("build/panel-fixtures/steps-patterns.m1p") == 0);
        pv_gen++;
    }
    /* the halve (D-841): SEQ held + OCT- makes the selected pattern of every track half as long, rounded down, its notes
     * kept, on the press; OCT-'s release changes neither the octave nor the step page, SEQ's leaves the page. Running, the
     * transport goes on. Refused (the patch's bytes, 1 step), nothing changes and the editor is not told */
    {
        uint32_t told = host_op_told, p, pg;
        int m0 = eng_steps_module(0), m1 = eng_steps_module(1), l0, l1, n0, oct = octave, h;
        const uint32_t *w;
        char want[28];
        if (page != PAGE_SEQ)
            page_set(PAGE_SEQ);
        loop();
        p = (uint32_t)eng_pattern();
        l0 = eng_steps_len((uint32_t)m0);
        l1 = eng_steps_len((uint32_t)m1);
        n0 = eng_pattern_notes((uint32_t)m0, p, &w);
        pg = seq_pg;
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_OCT_DOWN);
        loop();
        check("SEQ held + OCT-: every track's pattern half as long, the first's notes kept; the editor told (PATTERN_OP "
              "halve)", l0 > 1 && l1 > 1 && eng_steps_len((uint32_t)m0) == l0 / 2 && eng_steps_len((uint32_t)m1) == l1 / 2
              && eng_pattern_notes((uint32_t)m0, p, &w) == n0 && host_op_told == told + 1u && host_op_last[0] == 5u && host_op_last[1] == p);
        h = (l0 > l1 ? l0 : l1) / 2;
        snprintf(want, sizeof want, "%s%d%s", MSG_HALVED, h, h == 1 ? MSG_STEP_AFTER : MSG_STEPS_AFTER);
        check("  the bar: HALVED: <the longest track> STEPS", strstr(msg_text, want) != 0);
        check("  OCT-'s release: the octave and the step page stay", octave == oct && seq_pg == pg);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  SEQ let go: the SEQ page stays", page == PAGE_SEQ);
        tap(BTN_PLAY);
        blocks(300);
        told = host_op_told;
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        host_patterns_room = 0;
        tap(BTN_OCT_DOWN);
        loop();
        host_patterns_room = 1;
        check("the patch has no room: PATCH FULL: NOT HALVED, nothing changes, the editor not told", eng_steps_len((uint32_t)m0) == l0 / 2
              && strstr(msg_text, MSG_HALVE_FULL) != 0 && host_op_told == told);
        while (eng_steps_len((uint32_t)m0) > 1 && eng_steps_len((uint32_t)m1) > 1)
            tap(BTN_OCT_DOWN);
        blocks(300);
        check("halved while playing: the transport goes on, the tracks inside their new length", eng_transport_running()
              && eng_steps_pos((uint32_t)m0) < eng_steps_len((uint32_t)m0) && eng_steps_pos((uint32_t)m1) < eng_steps_len((uint32_t)m1));
        l0 = eng_steps_len((uint32_t)m0);
        l1 = eng_steps_len((uint32_t)m1);
        told = host_op_told;
        tap(BTN_OCT_DOWN);
        loop();
        check("  at 1 step: 1 STEP MIN: NOT HALVED, nothing changes, the notes all kept", eng_steps_len((uint32_t)m0) == l0
              && eng_steps_len((uint32_t)m1) == l1 && strstr(msg_text, MSG_HALVE_STEPS) != 0 && host_op_told == told
              && eng_pattern_notes((uint32_t)m0, p, &w) == n0);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        tap(BTN_PLAY);
        loop();
        check("patterns fixture loads again", load_fixture("build/panel-fixtures/steps-patterns.m1p") == 0);
        pv_gen++;
    }
    {   /* the stored patterns' browser and the EMPTY hint (#1202 G8): SEQ held + SEL lists the store's entries, PRESET moves
         * through them, SEL loads one (linked), HOME closes it; the hint says EMPTY  SEQ+SEL load a pattern on a patch
         * without a note while the store holds an entry */
        const uint32_t one = NW(0, 1, 36, STEP_VEL, 0);
        char got[PT_NAME + 8u];
        pt_info_t first, second;
        pl_out_t s = { m1_up, sizeof m1_up, 0, PT_FNV0 };
        uint32_t id = 0, told;
        check("(the factory 808 Kit on its SEQ page, every pattern cleared)", ct_load_factory("808 KIT") == 0);
        host_pt_init();
        pl_clear_all();
        ct_seq(0, 0, 1);
        check("(a note in P03, stored as an entry and as a kept copy)", eng_pattern_set_notes((uint32_t)seq_module(), 2, &one, 1) != 0);
        pl_encode(2, &s);
        check("  (stored)", pt_put(&id, "AAA P03", m1_up, s.n, 0) == 0 && pl_keep(2, got) == 1);
        ui_dirty = 2;
        loop();
        check("  P01 shown, notes only in P03: no EMPTY hint", eng_pattern() == 0 && !ct_shows(HINT_EMPTY));
        eng_pattern_drop((uint32_t)seq_module(), 2);
        ui_dirty = 2;
        loop();
        check("no note in any pattern, entries in the store: EMPTY  SEQ+SEL load a pattern", ct_shows("EMPTY  SEQ+SEL load a pattern")
              && !strcmp(HINT_EMPTY, "EMPTY  SEQ+SEL load a pattern"));
        pt_clear_all();
        ui_dirty = 2;
        loop();
        check("  the store empty: no EMPTY hint", !ct_shows(HINT_EMPTY));
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SEL);
        loop();
        check("  SEQ held + SEL: NO STORED PATTERNS, no browser", !seq_br_at && strstr(msg_text, MSG_NO_STORED_PATTERNS) != 0);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        id = 0;
        check("(the two entries again)", eng_pattern_set_notes((uint32_t)seq_module(), 2, &one, 1) != 0
              && pt_put(&id, "AAA P03", m1_up, s.n, 0) == 0 && pl_keep(2, got) == 1 && !pt_next(0, &first) && !pt_next(first.id, &second));
        eng_pattern_drop((uint32_t)seq_module(), 2);
        eng_pattern_set(2);
        check("(P03 selected, empty)", eng_pattern() == 2 && !pl_link(2));
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SEL);
        loop();
        check("SEQ held + SEL: the browser opens on the store's first entry, the SEQ page stays", seq_br_at == first.id && page == PAGE_SEQ);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        check("  SEL's and SEQ's releases: no SONG page, still open", page == PAGE_SEQ && seq_br_at == first.id);
        check("  it shows the pattern it loads into, its place, the entries' names, the kept copy marked, the hint",
              on_screen("LOAD INTO P03  1/2") && on_screen("AAA P03") && on_screen("KEPT") && ct_shows(HINT_BROWSE));
        enc(6, 1);
        check("  PRESET: the cursor on the next entry (2/2)", seq_br_at == second.id && on_screen("LOAD INTO P03  2/2"));
        enc(6, 1);
        check("  PRESET again: round to the first", seq_br_at == first.id);
        enc(6, -1);
        check("  PRESET back: round to the last", seq_br_at == second.id);
        tap(BTN_HOME);
        loop();
        check("  HOME: closed, nothing loaded, the page stays (HOME's release did nothing)", !seq_br_at && !pl_link(2) && page == PAGE_SEQ
              && !eng_pattern_has((uint32_t)seq_module(), 2));
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SEL);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        told = host_link_told;
        tap(BTN_SEL);
        loop();
        snprintf(got, sizeof got, "P3: %s", first.name);
        check("SEL in the browser: the entry loaded into P03 (its link told), the bar names it, closed, no SONG page",
              !seq_br_at && host_link_told == told + 1u && eng_pattern_has((uint32_t)seq_module(), 2) && strstr(msg_text, got) != 0
              && page == PAGE_SEQ);
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SEL);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        enc(6, 1);
        check("  opened again, PRESET moves on", seq_br_at == second.id);
        panel_keys(1u << 3);
        panel_keys(0);
        loop();
        check("  a key: closed, nothing loaded", !seq_br_at && host_link_told == told + 1u);
        panel_held |= 1u << BTN_SEQ;
        panel_edges(1u << BTN_SEQ, 0);
        tap(BTN_SEL);
        panel_held &= ~(1u << BTN_SEQ);
        panel_edges(0, 1u << BTN_SEQ);
        loop();
        enc(0, 1);
        check("  another knob: closed", !seq_br_at);
        check("(the factory Silver Box, every pattern cleared)", ct_load_factory("SILVER BOX") == 0);
        pl_clear_all();
        ct_seq(0, 0, 1);
        ui_dirty = 2;
        loop();
        check("Silver Box empty, entries stored: the keys play, and the hint line says EMPTY, not the roll's (D-836)", seq_play_keys()
              && ct_shows(HINT_EMPTY) && strcmp(seq_grid_text[2], HINT_ROLL) != 0);
        (void)eng_pattern_set_notes((uint32_t)seq_module(), 0, &one, 1);
        ui_dirty = 2;
        loop();
        check("  a note in P01: the roll's hint", !ct_shows(HINT_EMPTY) && !strcmp(seq_grid_text[2], HINT_ROLL));
        pt_on = 0;
    }
    {   /* The SEQ page drawn whole: once when SEQ opens it from a Steps track's device page (seq_select drew it a second
         * time after page_show, and the device page's header before it), and its ground cleared around the cells only
         * (seq_grid_ground): pixel for pixel the page drawn over a ground cleared whole first, from any screen */
        static uint16_t ref[240 * 240];
        static int32_t l[128], r[128];
        uint32_t i, d, t, seq_px = 0, bad = 0;
        check("(ELVIRA 2 for the SEQ page's whole draws)", load("ELVIRA 2") == 0);
        pv_gen++;
        trail_n = 0;
        page_show(0);
        screen_patch();
        later(2000);
        if (!eng_transport_running())
            tap(BTN_PLAY);
        for (d = 0; d < 12u && pages_focus_track() < 0; d++) {
            enc(0, 1);
            later(400);
        }
        check("(a Steps track's device page)", page == 0u && pages_focus_track() >= 0);
        lcd_px = lcd_xfers = 0;
        tap(BTN_SEQ);
        printf("      SEQ from a Steps track's device page: %u px in %u transfers\n", (unsigned)lcd_px, (unsigned)lcd_xfers);
        check("SEQ from a Steps track's device page: the SEQ page drawn once (under 1.5 screens of pixels)",
              page == PAGE_SEQ && lcd_px < 240u * 240u * 3u / 2u);
        for (t = 0; t < (uint32_t)eng_steps_count(); t++) {
            for (i = 0; i < 20u; i++)
                eng_render(l, r, 128);
            for (i = 0; i < 240u * 240u; i++)
                fb[i] = (uint16_t)(i * 2654435761u >> 7);
            lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
            seq_draw(1);
            memcpy(ref, fb, sizeof ref);
            for (i = 0; i < 240u * 240u; i++)
                fb[i] = (uint16_t)(i * 2654435761u >> 7);
            lcd_px = 0;
            seq_draw(1);
            seq_px = lcd_px;
            bad += memcmp(ref, fb, sizeof ref) != 0;
            enc(1, 1);                                      /* ALGO: the next track */
        }
        printf("      the SEQ page whole: %u px (the ground cleared whole and the cells over it alone were %u)\n",
               (unsigned)seq_px, (unsigned)(240u * (240u - BAR_H) + 128u * GRID_CW * GRID_CH));
        check("the SEQ page whole, each track: the same pixels as over a ground cleared whole", bad == 0u);
        check("  fewer of them than the ground cleared whole and the cells over it",
              seq_px < 240u * (240u - BAR_H) + 128u * GRID_CW * GRID_CH);
        {                                                   /* page_show clears only what the page leaves (the menu, SEQ and
                                                             * SONG clear their own; ENV's rows are edge to edge) */
            static const uint8_t PG[4] = {PAGE_ENV, PAGE_MENU, PAGE_SEQ, PAGE_SONG};
            bad = 0;
            for (t = 0; t < 4u; t++) {
                for (i = 0; i < 240u * 240u; i++)
                    fb[i] = (uint16_t)(i * 2654435761u >> 7);
                lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
                page_show(PG[t]);
                memcpy(ref, fb, sizeof ref);
                for (i = 0; i < 240u * 240u; i++)
                    fb[i] = (uint16_t)(i * 2654435761u >> 7);
                page_show(PG[t]);
                bad += memcmp(ref, fb, sizeof ref) != 0;
            }
            page_show(0);
            check("ENV, the menu, SEQ and SONG opened over any screen: as over one cleared first", bad == 0u);
        }
        tap(BTN_PLAY);
    }
    {   /* #340, #405: knob turns on Elvira 2's rows. A fast click counts only after a click the same way; HOME held, a
         * click is a tenth of a click and never under the editor's step; a click reaches the module over ENG_RAMP_BLOCKS
         * blocks (8: 23 ms), the parameter at once */
        uint32_t d, g, k, kd = 9, kf = 9, kc = 9, kl = 9, dd = 0, gd = 0, df = 0, gf = 0, dc = 0, gc = 0, dl = 0, gl = 0, m, j;
        int32_t v0, v1, v2, v3, e, off, step;
        const def_t *dn;
        check("(ELVIRA 2 for the knob turns)", load("ELVIRA 2") == 0);
        pv_gen++;
        page = 0;
        trail_n = 0;
        loop();
        pages_ensure();
        for (d = 0; d < pg_ndev; d++)
            for (g = 0; g < pg_dev[d].npg; g++) {
                const ppage_t *pg;
                pages_focus(d, g);
                pg = pages_now();
                for (k = 0; pg && k < pg->nrows; k++) {
                    int t;
                    if (pg->mod[k] == SETTING_ROW || (pg->par[k] & POLY_ROW))
                        continue;
                    t = eng_type(pg->mod[k]);
                    if (kd == 9 && t == T_MACRO) { kd = k; dd = d; gd = g; }
                    if (kf == 9 && t == T_WAVETABLE && pg->par[k] == WAVETABLE_P_FINE) { kf = k; df = d; gf = g; }
                    if (kc == 9 && DEFS[t].pchoice && DEFS[t].pchoice[pg->par[k]]) { kc = k; dc = d; gc = g; }
                    if (kl == 9 && DEFS[t].plog && DEFS[t].plog[pg->par[k]]) { kl = k; dl = d; gl = g; }
                }
            }
        check("Elvira 2: a drone row (a Macro's value), a fine row (a wavetable's) and a choice row on its pages", kd < 9u && kf < 9u && kc < 9u);
        if (kd < 9u && kf < 9u && kc < 9u) {
            char num[24], unit[8];
            pages_focus(dd, gd);
            ui_dirty = 2;
            loop();
            m = pages_now()->mod[kd];
            j = pages_now()->par[kd];
            dn = &DEFS[eng_type(m)];
            later(200);                                     /* (out of the acceleration window) */
            v0 = eng_get_param(m, j);
            enc(2u + kd, 1);
            v1 = eng_get_param(m, j);
            check("drone: a click adds 0.01 (1/100 of 0..1)", v1 == v0 + dn->pinc[j] && dn->pinc[j] == 655);
            enc(2u + kd, 1);                                /* at once, the same way: fast */
            v2 = eng_get_param(m, j);
            check("a second click within 80 ms the same way: five clicks (KNOB ACCEL)", v2 == v1 + 5 * dn->pinc[j]);
            enc(2u + kd, -1);                               /* at once, the other way: a single click, not five */
            v3 = eng_get_param(m, j);
            check("a click back within 80 ms: a single click, so the value before the fast one is reachable (#340)", v3 == v2 - dn->pinc[j]);
            enc(2u + kd, -1);
            check("  the next click back, the same way: fast again", eng_get_param(m, j) == v3 - 5 * dn->pinc[j]);
            value_parts(dn, j, v1, num, unit);
            printf("      (the drone row: device %u page %u K%u, the patch opens on device %u; after one click it reads \"%s\" \"%s\")\n", (unsigned)dd, (unsigned)gd, (unsigned)kd + 1u, (unsigned)pages_home(), num, unit);
            /* the ramp (#405) */
            later(200);
            blocks(ENG_RAMP_BLOCKS + 1u);                   /* (what was pending: done) */
            v0 = eng_get_param(m, j);
            check("(the module stands at the value)", eng_get_eff(m, j) == v0);
            enc(2u + kd, 1);
            v1 = eng_get_param(m, j);
            check("a click: the parameter takes the value at once, the module still at the old one", v1 == v0 + dn->pinc[j] && eng_get_eff(m, j) == v0);
            off = v0 - v1;
            step = off / ENG_RAMP_BLOCKS;
            blocks(1);
            e = eng_get_eff(m, j);
            check("one block later: the module an eighth of the way", e == v1 + off - step && e > v0 && e < v1);
            blocks(2);
            e = eng_get_eff(m, j);
            check("three blocks: three eighths", e == v1 + off - 3 * step);
            later(200);
            enc(2u + kd, 1);                                /* another click while the ramp runs: on from where it stands */
            v2 = eng_get_param(m, j);
            blocks(1);
            check("a click mid-ramp: the parameter at once, the module on from where it stood, no jump back",
                  v2 == v1 + dn->pinc[j] && eng_get_eff(m, j) > e && eng_get_eff(m, j) < v2);
            blocks(ENG_RAMP_BLOCKS - 1u);
            check("eight blocks after the last click: the module at the value", eng_get_eff(m, j) == v2 && ramp[kd].left == 0u);
            /* a choice row: at once */
            pages_focus(dc, gc);
            ui_dirty = 2;
            loop();
            m = pages_now()->mod[kc];
            j = pages_now()->par[kc];
            v0 = eng_get_param(m, j);
            later(200);
            enc(2u + kc, v0 > 0 ? -1 : 1);
            v1 = eng_get_param(m, j);
            blocks(1);
            check("a choice row's click: one choice, no ramp (the module at it after a block)", v1 != v0 && eng_get_eff(m, j) == v1 && ramp[kc].left == 0u);
            /* fine turns (#340): HOME held */
            pages_focus(df, gf);
            ui_dirty = 2;
            loop();
            m = pages_now()->mod[kf];
            j = pages_now()->par[kf];
            dn = &DEFS[eng_type(m)];
            later(200);
            v0 = eng_get_param(m, j);
            enc(2u + kf, 1);
            check("fine (ct): a click is 2 ct (1/100 of -100..100)", eng_get_param(m, j) == v0 + 2 * 65536 && dn->pinc[j] == 2 * 65536);
            later(200);
            panel_held |= 1u << BTN_HOME;
            panel_edges(1u << BTN_HOME, 0);
            enc(2u + kf, 1);
            check("HOME held + the knob: 1 ct, the editor's step (a tenth of a click would be 0.2 ct)", eng_get_param(m, j) == v0 + 3 * 65536 && home_turned);
            enc(2u + kf, 1);
            check("  within 80 ms the same way: five fine clicks", eng_get_param(m, j) == v0 + 8 * 65536);
            panel_held &= ~(1u << BTN_HOME);
            panel_edges(0, 1u << BTN_HOME);
            loop();
            check("  HOME's release after a fine turn: nothing (the page stays)", page == 0u && pg_cur_dev == df && pg_cur_page == gf);
            tap(4);                                         /* ENV: its K1..K4 are the focused row's first page; HOME goes back */
            if (page == PAGE_ENV && pages_now() && kf < pages_now()->nrows && pages_now()->mod[kf] == m && pages_now()->par[kf] == j) {
                later(200);
                v0 = eng_get_param(m, j);
                panel_held |= 1u << BTN_HOME;
                panel_edges(1u << BTN_HOME, 0);
                enc(2u + kf, -1);
                panel_held &= ~(1u << BTN_HOME);
                panel_edges(0, 1u << BTN_HOME);
                loop();
                check("ENV, HOME held + the knob: 1 ct, and HOME's release stays on ENV", eng_get_param(m, j) == v0 - 65536 && page == PAGE_ENV);
                tap(BTN_HOME);
                check("  HOME tapped: back", page == 0u);
            } else {
                printf("      (ENV's rows are not voice 1's first page here: the release check on the device page only)\n");
                if (page == PAGE_ENV)
                    tap(BTN_HOME);
            }
            pages_focus(dd, gd);                            /* the drone row fine: 0.01, the editor's step, not 0.001 */
            ui_dirty = 2;
            loop();
            m = pages_now()->mod[kd];
            j = pages_now()->par[kd];
            later(200);
            v0 = eng_get_param(m, j);
            panel_held |= 1u << BTN_HOME;
            panel_edges(1u << BTN_HOME, 0);
            enc(2u + kd, 1);
            panel_held &= ~(1u << BTN_HOME);
            panel_edges(0, 1u << BTN_HOME);
            loop();
            check("drone, HOME held + the knob: 0.01, the editor's step (a tenth of a click would be 0.001)", eng_get_param(m, j) == v0 + 655);
            value_parts(&DEFS[eng_type(m)], j, eng_get_param(m, j), num, unit);
            printf("      (the drone row after a fine click reads \"%s\")\n", num);
            if (kl < 9u) {                                  /* a log row: a fine click is 1/1000 octave, at least the step, at most the click */
                int32_t dc, dfine;
                pages_focus(dl, gl);
                ui_dirty = 2;
                loop();
                m = pages_now()->mod[kl];
                j = pages_now()->par[kl];
                dn = &DEFS[eng_type(m)];
                later(200);
                v0 = eng_get_param(m, j);
                enc(2u + kl, 1);
                dc = eng_get_param(m, j) - v0;
                later(200);
                v0 = eng_get_param(m, j);
                panel_held |= 1u << BTN_HOME;
                panel_edges(1u << BTN_HOME, 0);
                enc(2u + kl, 1);
                panel_held &= ~(1u << BTN_HOME);
                panel_edges(0, 1u << BTN_HOME);
                loop();
                dfine = eng_get_param(m, j) - v0;
                printf("      (a log row, %s %s: a click %d, a fine click %d, the step %d)\n", dn->name, dn->pname[j], (int)dc, (int)dfine, (int)dn->pstep[j]);
                check("a log row, HOME held: under a click, not under the editor's step", dfine > 0 && dfine <= dc && dfine >= dn->pstep[j]);
            } else {
                printf("      (no log row on Elvira 2's pages)\n");
            }
            later(200);
            blocks(ENG_RAMP_BLOCKS + 1u);
        }
    }
    help_suite();
    out35_suite();
    {                                                       /* the global tempo (D-907, tempo_glo.h) */
        uint8_t rec[16], old[16];
        uint32_t k, other = N_PRESETS, r, told, t0;
        int main_m;
        const uint32_t seven = preset_at("<7PH");
        page_show(0);
        for (k = 0; k < 16u; k++)
            old[k] = 0;
        old[0] = 1;
        old[5] = 1;                                         /* (an older firmware's record: CPU in the bar, program change on) */
        old[7] = 1;
        check("(the factory patch <7PH runs)", seven < N_PRESETS && load_at(seven) == 0);
        gt_unpack(old, 16);
        check("TEMPO: an older settings record reads as GLOBAL, the tempo not known yet, 4/4 (#1011)", gt_patch == 0u && gt_bpm == 0u && gt_meter == METER_DEFAULT);
        old[7] = GT_MARK;                                   /* (a record of a firmware before #1011: the mark, bits 2..5 at 0) */
        gt_meter = 0;
        gt_unpack(old, 16);
        check("  a record from before the time signature reads as 4/4 (#1011)", gt_meter == METER_DEFAULT && eng_meter_get() == METER_DEFAULT);
        old[7] = 1;
        gt_unpack(old, 16);
        r = gt_poll(fm1_ms, 1);
        check("  the boot's patch gives the global tempo (<7PH: 124), and the editor hears of it", eng_tempo_global_get() == 124u && gt_bpm == 124u && (r & 1u));
        for (k = 0; k < N_PRESETS && other == N_PRESETS; k++) {
            int m;
            if (k == seven || load_at(k) || (m = eng_find(T_FM1)) < 0)
                continue;
            if (((tempo_own + 32768) >> 16) == 124)    /* (its own tempo: Main's shows the global one) */
                continue;
            other = k;
        }
        main_m = eng_find(T_FM1);
        check("GLOBAL: another patch (PRESET) plays at the global tempo; Main's tempo shows it", other < N_PRESETS && main_m >= 0
              && ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) == 124 && E.tick_len == (int32_t)(60u * ENG_SR / (124u * 24u)));
        tap(BTN_PLAY);
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 2);                                          /* PLAY held + PRESET */
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        t0 = fm1_ms;
        r = gt_poll(t0, 0);
        check("PLAY held + PRESET in GLOBAL: the global tempo, told to the editor", eng_tempo_global_get() == 126u && gt_bpm == 126u && (r & 1u));
        check("  the patch's own tempo is not touched (proto.c m1_patch_param keeps it)", eng_tempo_row((uint32_t)main_m, FM1_P_TEMPO));
        blocks(1);
        check("  the clock runs at it", E.tick_len == (int32_t)(60u * ENG_SR / (126u * 24u)));
        r = gt_poll(t0 + GT_SAVE_MS, 0);
        check("  not written while the transport runs", !(r & 2u) && gt_due);
        check("  quiet: stopped and nothing heard for 2 s, not while a note or an echo may still sound (#651)",
              gt_quiet(t0 + 5000u, 0, t0 + 3000u) && !gt_quiet(t0 + 4999u, 0, t0 + 3000u) && !gt_quiet(t0 + 9000u, 1, t0));
        /* the audio interrupt set heard a tick after the now the main loop read (PR #707's smoke): not quiet */
        check("a sound heard a tick after the main loop's clock is not quiet (no flash write into it)",
              !gt_quiet(t0 + 5000u, 0, t0 + 5001u) && !gt_quiet(t0 + 5000u, 0, t0 + 5000u) && !gt_quiet(0u, 0, 1u));
        tap(BTN_PLAY);
        r = gt_poll(t0 + GT_SAVE_MS - 2u, 1);
        check("  not written before 5 s have passed", !(r & 2u));
        r = gt_poll(t0 + GT_SAVE_MS + 1u, 1);
        check("  written 5 s after the change once stopped (no SAVE)", (r & 2u) && !gt_due);
        (void)load_at(seven);
        check("  <7PH again: at the global tempo, not its own 124", ((eng_get_param((uint32_t)eng_find(T_FM1), FM1_P_TEMPO) + 32768) >> 16) == 126);
        eng_clock_external(1);
        panel_held |= 1u << BTN_PLAY;
        panel_edges(1u << BTN_PLAY, 0);
        enc(6, 2);
        panel_held &= ~(1u << BTN_PLAY);
        panel_edges(0, 1u << BTN_PLAY);
        loop();
        check("MIDI clock in: PLAY held + PRESET leaves the global tempo (D-452)", eng_tempo_global_get() == 126u && !strcmp(msg_text, MSG_TEMPO_MIDI_CLOCK));
        for (k = 0; k < 4u; k++) {                         /* a MIDI clock tick a block: 128 samples a tick */
            eng_clock_tick();
            blocks(1);
        }
        check("  and MIDI clock drives the clock, not the global tempo", E.tick_len == 128);
        eng_clock_external(0);
        gt_pack(rec);
        gt_patch = 1;
        gt_bpm = 0;
        gt_unpack(rec, 16);
        check("the settings record round trip: GLOBAL at 126", gt_patch == 0u && gt_bpm == 126u && rec[7] == (GT_MARK | (METER_DEFAULT + 1u) << 2));
        gt_meter = 6;                                       /* 9/8 (#1011) */
        gt_pack(rec);
        gt_meter = 0;
        gt_unpack(rec, 16);
        check("  and the time signature's: 9/8 in bits 2..5, bit 6 free (#1011)", gt_meter == 6u && eng_meter_get() == 6u && (rec[7] >> 2 & 15u) == 7u && !(rec[7] & 0x40u));
        gt_meter = METER_DEFAULT;
        gt_pack(rec);
        gt_unpack(rec, 16);
        later(1600);
        page = PAGE_MENU;
        menu_tab = MT_PANEL;
        ui_dirty = 2;
        loop();
        check("the menu's PANEL tab: TEMPO on K4, GLOBAL and the tempo (#582)", pages_now()->nrows == 4u && pages_now()->par[3] == MR_TEMPO && on_screen("TEMPO") && on_screen("GLOBAL 126"));
        told = host_tempo_told;
        enc(5, 1);                                          /* K4: PATCH */
        check("K4: PATCH and the patch's own tempo, the editor told", gt_patch == 1u && on_screen("PATCH 124") && host_tempo_told == told + 1u && gt_due);
        main_m = eng_find(T_FM1);
        check("PATCH: the running patch plays its own tempo again (124)", ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) == 124 && !eng_tempo_row((uint32_t)main_m, FM1_P_TEMPO));
        (void)load_at(other);
        main_m = eng_find(T_FM1);
        check("  another patch plays its own", ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) != 126 && eng_tempo_global_get() == 0u);
        gt_pack(rec);
        check("  the record keeps PATCH and the global tempo", rec[7] == (GT_MARK | (METER_DEFAULT + 1u) << 2 | 2u) && rec[5] == 126u);
        gt_bpm = 300;
        gt_pack(rec);
        gt_bpm = 0;
        gt_unpack(rec, 16);
        check("  a tempo past 255 round trips (byte 7 bit 0)", gt_patch == 1u && gt_bpm == 300u);
        enc(5, -1);                                         /* K4: GLOBAL again */
        check("K4 back: GLOBAL at 300", gt_patch == 0u && eng_tempo_global_get() == 300u
              && ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) == 300 && on_screen("GLOBAL 300"));
        eng_clock_external(1);
        ui_dirty = 2;
        loop();
        check("  under MIDI clock the row says GLOBAL alone (the footer says MIDI)", on_screen("GLOBAL") && !on_screen("GLOBAL 300"));
        eng_clock_external(0);
        gt_patch = 1;                                       /* (as the tests before: each patch its own) */
        gt_apply();
        page_show(0);
    }
    {   /* more than 64 modules (#721, D-256: the FM-1 takes 128): golden.ts's arm-many fixture, 70 modules, the Drum map
         * last (index 69), two Voicings on Main's keys before it. SEL on the Drum map arms it alone (the Voicings no longer
         * hear Main's keys), again disarms it; the editor's wide ARMS form arms a set across the module set's words */
        uint32_t d, seen = 0;
        int rc = load_fixture("build/panel-fixtures/arm-many.m1p"), dm = eng_find(T_DRUMMAP), part = eng_find(T_PART);
        check("arm-many: the fixture loads, more than 64 modules, the Drum map past 63",
              rc == 0 && eng_nmodules() > 64 && dm >= 64 && part >= 0);
        patch_label = "ARM MANY";
        pv_gen++;
        page_show(0);
        screen_patch();
        later(2000);
        pages_ensure();
        for (d = 0; d < pg_ndev && rc == 0; d++) {
            if (pg_dev[d].module != dm)
                continue;
            eng_arm_mask(mset_none());
            check("arm-many: the Drum map's device arms module 69", mset_eq(env_listeners(d), mset_one((uint32_t)dm)));
            pages_focus(d, 0);
            loop();
            later(1500);
            tap(BTN_SEL);
            check("arm-many: SEL on it arms it alone, the bar says so", mset_eq(eng_arm_mask_get(), mset_one((uint32_t)dm))
                  && eng_hears_keys((uint32_t)dm) && !eng_hears_keys((uint32_t)part) && strstr(msg_text, MSG_ARMED));
            tap(BTN_SEL);
            check("  SEL again: disarmed, the keys WIRED (the cables: all hear them)", !mset_any(eng_arm_mask_get())
                  && !strcmp(msg_text, MSG_KEYS_WIRED) && eng_hears_keys((uint32_t)dm) && eng_hears_keys((uint32_t)part));
            eng_arm_mask(mset_or(mset_one(0u), mset_one((uint32_t)dm)));   /* (the editor's wide ARMS: words 0 and 2) */
            check("  a set across the words (Main and the Drum map): both bits kept, the Drum map hears the keys",
                  mset_has(eng_arm_mask_get(), 0u) && mset_has(eng_arm_mask_get(), (uint32_t)dm) && eng_hears_keys((uint32_t)dm)
                  && !eng_hears_keys((uint32_t)part));
            eng_arm_mask(mset_one(ENG_MAX_MODULES - 1u));
            check("  a module the patch has not got: not armed", !mset_any(eng_arm_mask_get()));
            seen++;
        }
        check("arm-many: its Drum map seen as a device", seen == 1u);
        page_show(0);
    }
    drum_bank_suite();
    nudge_suite();
    steprec_suite();
    host_pt_init();                                     /* (the pattern store on: the SEQ page's pattern rows show, #901) */
    controls_suite();
    plock_suite();
    pt_on = 0;
    fx_suite();
    fx_sel_suite();
    fx_canvas_suite();
    fx_preset_suite();
    fxd_preset_suite();
    report_suite();
    palette_panel_suite();
    held_load_suite();
    printf("%s\n", failed ? "panel test FAILED" : "panel test passed");
    return failed != 0;
}
