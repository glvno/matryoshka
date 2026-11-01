/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The panel core (firmware/src/panel.c) on the host, with no HAL: SELECT, ALGO, K1, HOME (the trail back), GLO (the menu),
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
#include "../src/poly_edit.h"
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v)
{
    return poly_patch_set(pv_bin, pv_len, mod, field, v, eng_load);
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
static int thru_heard(uint8_t from, uint32_t mod, uint32_t note)
{
    uint8_t h;
    for (h = from; h != thru_head; h++)
        if (thru_ring[h % ENG_THRU][0] == mod && thru_ring[h % ENG_THRU][1] == (note | 0x80u))
            return 1;
    return 0;
}
static uint8_t th;                          /* (where the thru ring stood before a key) */
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
                tie |= ((w[i] >> 12) & 127u) == p && (w[i] & 63u) < k && k <= (w[i] & 63u) + ((w[i] >> 6) & 63u);
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
    poly_row_set(mod, 0, 5);
    check("a rejected fifth voice restores the engine and patch", eng_poly_get(0, 0) == 4 && pv_bin[8] == 4);
    poly_row_set(mod, 0, 2);
    check("voices can be reduced after a rejected edit", eng_poly_get(0, 0) == 2 && pv_bin[8] == 2);
    check("no-steal row changes the engine and saved flag", poly_row_set(mod, ENG_POLY_STEAL, 0) == 0 && eng_poly_get(0, ENG_POLY_STEAL) == 0 && (pv_bin[11] & 0x80u));
    check("priority row preserves no-steal", poly_row_set(mod, ENG_POLY_PRIORITY, 2) == 0 && pv_bin[11] == 0x82u && eng_poly_get(0, ENG_POLY_PRIORITY) == 2);
    check("reset assignment reaches the engine and saved patch", poly_row_set(mod, ENG_POLY_ASSIGN, 3) == 0 && eng_poly_get(0, ENG_POLY_ASSIGN) == 3 && pv_bin[9] == 3);
    check("assignment row spans all four choices", poly_max(ENG_POLY_ASSIGN) == 3);
    check("steal row is boolean", poly_max(ENG_POLY_STEAL) == 1);
    check("reload retains no-steal and reset assignment", eng_load(pv_bin, pv_len) == 0 && eng_poly_get(0, ENG_POLY_STEAL) == 0 && eng_poly_get(0, ENG_POLY_ASSIGN) == 3);
    check("turning stealing back on preserves priority", poly_row_set(mod, ENG_POLY_STEAL, 1) == 0 && pv_bin[11] == 2 && eng_poly_get(0, ENG_POLY_STEAL) == 1);
    check("unison count edits preserve poly voices", poly_row_set(mod, ENG_POLY_STACK, 1) == 0 && eng_poly_get(0, ENG_POLY_STACK) == 1 && eng_poly_get(0, ENG_POLY_PARTS) == 2 && pv_bin[8] == 0x12u);
    check("unison count row spans all hardware voices", poly_max(ENG_POLY_STACK) == ENG_MAX_PARTS);
    check("poly count edits preserve the unison count", poly_row_set(mod, ENG_POLY_PARTS, 4) == 0 && pv_bin[8] == 0x14u);
    check("rejected poly edit restores both counts", poly_row_set(mod, ENG_POLY_PARTS, 5) != 0 && pv_bin[8] == 0x14u && eng_poly_get(0, ENG_POLY_STACK) == 1 && eng_poly_get(0, ENG_POLY_PARTS) == 4);
    check("unison count survives reloading", eng_load(pv_bin, pv_len) == 0 && eng_poly_get(0, ENG_POLY_STACK) == 1);
    check("unison can use one of four voices", poly_row_set(mod, ENG_POLY_UNISON, 1) == 0 && eng_poly_get(0, ENG_POLY_UNISON) == 1);
    group_on(&E.grp[1], 60, ENG_ONE); /* Cassia receives keys through its Arpeggiator. */
    check("one unison voice sounds", E.pv[E.grp[1].pv0].on && !E.pv[E.grp[1].pv0 + 1].on);
    check("increasing unison count wakes held voices", poly_row_set(mod, ENG_POLY_STACK, 3) == 0 && E.pv[E.grp[1].pv0 + 2].on && !E.pv[E.grp[1].pv0 + 3].on);
    check("zero unison count means all", poly_row_set(mod, ENG_POLY_STACK, 0) == 0 && E.pv[E.grp[1].pv0 + 3].on);
    check("reducing unison count releases excess voices", poly_row_set(mod, ENG_POLY_STACK, 1) == 0 && !E.pv[E.grp[1].pv0 + 1].on);
    check("shared unison mode saves both flags", poly_row_set(mod, ENG_POLY_UNISON, 2) == 0 && eng_poly_get(0, ENG_POLY_UNISON) == 2 && (pv_bin[10] & 0xC0u) == 0xC0u);
    check("legato edit preserves shared unison", poly_row_set(mod, ENG_POLY_LEGATO, 2) == 0 && pv_bin[10] == 0xC2u);
    check("unison mode row has three choices", poly_max(ENG_POLY_UNISON) == 2);
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
    fm1_ms = 10000;
    host_ps_init();
    if (load("808 KIT")) {
        printf("FAIL  the 808 Kit loads\n");
        return 1;
    }
    booting = 0;
    page = 0;
    screen_idle();
    /* the 808 Kit's devices (#196): Main, DRUMS (the track), the Drum map it drives (3 pages: its rows, then REPEAT, #184), the 808 kit card, Output */
    check("the device page: the home device in focus (not Main or the track)", page == 0 && pg_cur_dev == 2 && pg_cur_page == 0 && pg_ndev > 4);
    {                                                       /* the header (the owner's design, 2026-10-24) */
        uint32_t x, gold = 0;
        for (x = 0; x < 120u; x++)
            gold += px(x, LK_HH - 6u) == P_GOLD;
        check("the LCD: the header's dash of the device in focus gold, its name; K1's tab in its hue", gold >= 2u
              && on_screen("DRUM MAP") && K1_TAB == KNOB_HUE[0]);
    }
    {                                                       /* the footer: the octave in a slot of its own, so the tempo stays
                                                             * put whatever the octave (the owner, 2026-10-24) */
        foot_t f;
        uint32_t xt = 0, widest = 0, moved = 0;
        int32_t o, was = octave;
        for (o = -3; o <= 3; o++) {
            octave = o;
            (void)foot_layout(&f);
            if (o == -3)
                xt = f.xt;
            moved += f.xt != xt;
            widest = text_w(&FONT_F, f.o, -1) > widest ? text_w(&FONT_F, f.o, -1) : widest;
        }
        octave = was;
        check("the footer: the tempo at the same x in every octave state, the octave's slot its widest", moved == 0u
              && widest == FOOT_OCT_W);
    }
    {                                                       /* #291: the screen as text, as SCREEN reports it */
        uint8_t idx[SCR_N];
        uint32_t n = scr_list(idx), i, ordered = 1;
        for (i = 1; i < n; i++)
            ordered &= scr_text[idx[i - 1]].y <= scr_text[idx[i]].y;
        check("the screen as text: the device page's octave and K1's row, in reading order", on_screen("= OCT =") && n > 4u && ordered);
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
        check("ALGO: the device's next page, the editor told", pg_cur_dev == 2 && pg_cur_page == 1 && focus_pg == 1);
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
        enc(0, 1);                                          /* SELECT: the 808 kit card, and back */
        check("SELECT: the next device, the editor told, its name in the header", pg_cur_dev == 3 && focus_dev == 3
              && on_screen("808 KIT") && !on_screen("DRUM MAP"));
        printf("      LCD pixels for one SELECT click: the header %u, the page %u\n", stop_px[0], lcd_px);
        enc(0, -1);
        check("SELECT back: the device before", pg_cur_dev == 2 && focus_dev == 2 && pg_cur_page == 0);
        enc(4, 1);
        enc(4, -1);
        later(1100);
        pages_waiting = 0;
        enc(1, 1);                                          /* (on the Drum map's second page, as the tests below expect) */
        later(700);
        tap(BTN_OCT_UP);                                    /* the transport stopped, nothing else to redraw: the footer at once */
        check("OCT+: the footer's octave at once (it stayed = OCT =), the message kept", octave == 1 && on_screen("OCT +")
              && !on_screen("= OCT =") && on_screen("OCTAVE +1"));
        tap(BTN_OCT_DOWN);
        check("OCT-: = OCT = again", octave == 0 && on_screen("= OCT ="));
        later(1100);                                        /* (the OCTAVE message ends) */
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
        later(1100);
        printf("      (a second later: %u px)\n", lcd_px);
        check("a second later: nothing redrawn (no toast to end)", lcd_px == 0u && K1_TAB == KNOB_HUE[0]);
    }

    tap(BTN_HOME);                                          /* HOME on the device pages (#391, D-243) */
    check("HOME on a device's second page: its first page, the editor told, no step", page == 0 && pg_cur_dev == 2 && pg_cur_page == 0
          && focus_dev == 2 && focus_pg == 0 && trail_n == 0);
    enc(0, 1);
    check("SELECT: the next device's first page", pg_cur_dev == 3 && pg_cur_page == 0);
    tap(BTN_HOME);
    check("HOME on a device's first page: the patch's home page", page == 0 && pg_cur_dev == 2 && pg_cur_page == 0 && focus_dev == 2);
    loop();
    memcpy(before, fb, sizeof before);
    tap(BTN_HOME);
    check("HOME on the patch's home page: nothing", page == 0 && pg_cur_dev == 2 && pg_cur_page == 0
          && trail_n == 0 && memcmp(before, fb, sizeof before) == 0);
    enc(1, 1);

    panel_held |= 1u << BTN_HOME;                           /* HOME held: nothing any more (#395: GLO is the menu) */
    panel_edges(1u << BTN_HOME, 0);
    later(1200);
    panel_held &= ~(1u << BTN_HOME);
    panel_edges(0, 1u << BTN_HOME);
    loop();
    check("HOME held 1.2 s: no menu (its release is a tap: the device's first page)", page == 0 && trail_n == 0 && pg_cur_dev == 2 && pg_cur_page == 0);
    enc(1, 1);                                              /* (the second page again: the checks below expect it) */
    check("ALGO: the second page again", pg_cur_dev == 2 && pg_cur_page == 1);
    mlen = 0;                                               /* (the MIDI log holds 256 messages; the menu's steps below would fill it) */
    tap(BTN_GLO);
    check("GLO: the menu on its MIDI tab, a step on the trail", page == PAGE_MENU && menu_tab == MT_MIDI && trail_n == 1 && menu_page());
    check("its header: MENU on coral; the rows: MIDI channel, clock in, MIDI out", px(2, 2) == P_CORAL && pages_now()->nrows == 3u
          && pages_now()->mod[0] == SETTING_ROW && pages_now()->par[0] == MR_CH && pages_now()->par[2] == MR_MOUT);
    {
        uint32_t ch = cfg.ch;
        int stepped = presets_stepped;
        enc(2, 1);
        check("K1 on MIDI: the channel one step a click", cfg.ch == (ch < 16u ? ch + 1u : 16u));
        enc(2, -1);
        check("  and back", cfg.ch == ch);
        enc(0, 1);
        check("SELECT in the menu: nothing", page == PAGE_MENU && menu_tab == MT_MIDI);
        enc(6, 1);
        check("PRESET in the menu: the next patch", presets_stepped == stepped + 1 && page == PAGE_MENU);
        patch_enc(1);
        check("HOME held + PRESET in the menu: the next patch, HOME's release stays in the menu", presets_stepped == stepped + 2 && page == PAGE_MENU);
        presets_stepped = stepped;
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
        enc(1, 1);
        check("ALGO again: SYSTEM (update mode, factory reset, quick start)", menu_tab == MT_SYSTEM && pages_now()->nrows == 3u && pages_now()->par[1] == MR_DEFAULTS && pages_now()->par[2] == MR_QUICK);
        enc(1, 1);
        check("ALGO again: INFO, a list, not a page", menu_tab == MT_INFO && !menu_page() && on_screen("BANK SLOTS") && on_screen("VERSION"));
        check("  its top bar is the plain bar with the patch's name, not the coral header's top", on_screen(patch_label));
        enc(1, 1);
        check("ALGO again: GUIDE (D-248), a text, not a page", menu_tab == MT_GUIDE && !menu_page());
        check("  the tab chip and the title say GUIDE, its first lines point at the controls sheet", on_screen("GUIDE")
              && on_screen("Guide") && on_screen("PRESS OCT- + OCT+") && on_screen("TO SEE CONTROLS FOR CURRENT")
              && !on_screen("MANUAL"));
        {                                                   /* the GUIDE's lines (D-200, D-248): at most 35 characters after
                                                             * the style marker, capitals, no ';'; it explains ideas, so no
                                                             * line names a control (a whole word) but its first two. PRESET
                                                             * is an idea as well as a knob */
            static const char *const CTRL[] = {"SELECT", "ALGO", "HOME", "GLO", "SAVE", "PLAY", "REC", "SEL", "ENV", "SEQ",
                                               "OCT", "K1", "K2", "K3", "K4", "KNOB", "KNOBS", "BUTTON", "BUTTONS", "FX",
                                               "LFO", "EDIT", "ARP"};
            static const char *const IDEA[] = {"#PATCH", "#PRESET", "#DEVICE", "#ASSEMBLY", "#MODULE", "#ENGINE", "#PAGE",
                                               "#TRACK", "#PATTERN", "#SONG", "#ARMING", "#THE ENVIRONMENT", "#SANDBOX MODE", "#LIVE"};
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
            check("  GUIDE: the first two lines, then no control named (D-248)", !strcmp(MANUAL[0] + 1, "PRESS OCT- + OCT+")
                  && !strcmp(MANUAL[1] + 1, "TO SEE CONTROLS FOR CURRENT PAGE") && ctrl == 0u);
            check("  GUIDE: a heading for each of the 14 ideas of D-248", vocab == 14u);
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
        check("K2 right on SYSTEM: FACTORY RESET armed, not done", menu_armed == MR_DEFAULTS && host_defaults == 0 && on_screen("HOLD GLO 2 S"));
        tap(BTN_GLO);
        check("GLO tapped while armed: back out of the menu, nothing done", page == 0 && host_defaults == 0 && trail_n == 0);
        tap(BTN_GLO);
        enc(1, 1);
        enc(1, 1);
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
        check("test input: UPDATE MODE's hold refused, and said so", host_updates == 0 && on_screen("TEST INPUT: REFUSED") && page == PAGE_MENU);
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
    check("HOME tapped: the menu closes, back on the page it was opened from", page == 0 && trail_n == 0 && pg_cur_dev == 2 && pg_cur_page == 1);
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
    msg_text[0] = 0;
    enc(6, 1);
    check("PRESET alone on a module's page (#395): no patch, the bar says HOME+PRESET steps them (#450)", presets_stepped == 0 && !strcmp(msg_text, "NONE. HOME+PRESET: PATCHES"));
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
        /* LFO (button 3) a Page button: device 2 (the Drum map) page 0, then its page 1 (SEL is fixed since #197) */
        static const uint8_t sec[] = {0, 0, 0, 3, 0, 0, 0, 2, 2, 0, 2, 1};
        uint32_t at = pv_len, n, end = pv_len;
        if (pv_bin[6] & 2u)                                 /* before the macro ranges, always last: u8 count, count x 5 bytes */
            for (n = 1; n < 256u; n++)
                if (pv_len >= 1u + n * 5u && pv_bin[pv_len - 1u - n * 5u] == n) {
                    at = end = pv_len - 1u - n * 5u;
                    break;
                }
        if (pv_bin[6] & 128u)                               /* and before the Drum maps' row names (format 33): */
            for (n = 1; n < 16u; n++)                       /* u8 count, count x (1 + 64) bytes */
                if (end >= 1u + n * 65u && pv_bin[end - 1u - n * 65u] == n) {
                    at = end - 1u - n * 65u;
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
        pages_focus(4, 0);                                  /* (the Output) */
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

    {                                                       /* SEL on a device page arms its device (#395); SEQ opens a track's
                                                             * steps (#196) and arms it */
        uint64_t drums = (uint64_t)1 << eng_steps_module(0);
        foot_t f;
        check("a patch loads WIRED: nothing armed, the footer: the patch, then KEYS WIRED", eng_arm_mask_get() == 0u
              && (foot_layout(&f), !strcmp(f.a, "808 KIT") && !strcmp(f.w, "KEYS WIRED")));
        pages_focus(1, 0);                                  /* DRUMS */
        loop();
        check("the track's device page: LEN RATE SWING GATE", pages_now()->nrows == 4u && pages_focus_track() == 0);
        tap(3);
        check("SEL there: that track armed, no page opened", page == 0 && eng_arm_mask_get() == drums && !strcmp(msg_text, "DRUMS ARMED"));
        check("  the footer: ARM DRUMS", (foot_layout(&f), !strcmp(f.a, "ARM DRUMS") && !f.w[0]));
        later(1500);
        tap(3);
        check("SEL again: a toggle, disarmed, the keys WIRED (#395)", page == 0 && eng_arm_mask_get() == 0u && !strcmp(msg_text, "KEYS WIRED"));
        later(1500);
        tap(3);
        check("SEL a third time: armed again", eng_arm_mask_get() == drums && !strcmp(msg_text, "DRUMS ARMED"));
        {                                               /* armed with another (a bit of the set): SEL takes it out, the other stays */
            uint64_t other = (uint64_t)1 << (eng_steps_module(0) ? 0u : 1u);
            eng_arm_mask(drums | other);
            later(1500);
            tap(3);
            check("SEL on a device armed with another: taken out, the other stays", eng_arm_mask_get() == other
                  && !strcmp(msg_text, "DRUMS DISARMED"));
            eng_arm_mask(drums);
        }
        pages_focus(0, 0);                                  /* Main: no keys input */
        loop();
        later(1500);
        tap(3);
        check("SEL on Main: NOTHING HERE TAKES KEYS, the armed set as it was", page == 0 && eng_arm_mask_get() == drums
              && !strcmp(msg_text, "NOTHING HERE TAKES KEYS"));
        eng_arm_mask(0);
        pages_focus(1, 0);
        loop();
        tap(BTN_SEQ);
        check("SEQ on the track's page: the SEQ page on that track, armed", page == PAGE_SEQ && seq_trk == 0 && eng_arm_mask_get() == drums);
        tap(BTN_HOME);
        check("HOME: back to the track's page, still armed", page == 0 && pg_cur_dev == 1 && eng_arm_mask_get() == drums);
        eng_arm_mask(0);
        pages_focus(2, 0);
        later(1500);
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
        tap(3);                                             /* the 808 kit card: its keys come from the Drum map, not Main */
        check("SEL on a row that takes no keys: NOTHING HERE TAKES KEYS, nothing armed, the page stays",
              page == PAGE_ENV && pg_cur_dev == d0 + 1u && eng_arm_mask_get() == 0u && !strcmp(msg_text, "NOTHING HERE TAKES KEYS"));
        tap(4);
        check("ENV again: back where it came from", page == 0 && trail_n == n0);
        pages_focus(1, 0);                                  /* SEL on a row (#395): DRUMS armed, then disarmed */
        loop();
        tap(4);
        tap(3);
        check("SEL on the environment's track row: armed (the set), no recording, the page stays", eng_armed() == eng_steps_module(0)
              && seq_rec == 0 && page == PAGE_ENV && !strcmp(msg_text, "DRUMS ARMED"));
        tap(BTN_REC);
        check("REC on the environment (#395): records the armed track, arms nothing, the page stays", eng_arm_mask_get() == (uint64_t)1 << eng_steps_module(0)
              && seq_rec && eng_transport_running() && (E.trk_rec >> E.node[eng_steps_module(0)].trk & 1u) && page == PAGE_ENV && !rec_held_used);
        tap(BTN_PLAY);
        check("  PLAY: REC and the transport stopped", !seq_rec && !eng_transport_running() && !E.trk_rec);
        pages_focus(2, 0);                                  /* the Drum map: its keys come through the track (#395) */
        tap(3);
        check("SEL on the Drum map's row, its track armed: armed through it, so taken out with it, the keys WIRED",
              eng_arm_mask_get() == 0u && !strcmp(msg_text, "KEYS WIRED"));
        tap(3);
        check("SEL there again: the track it plays through armed", eng_arm_mask_get() == (uint64_t)1 << eng_steps_module(0)
              && strstr(msg_text, " ARMED") != 0);
        pages_focus(1, 0);
        tap(3);
        check("SEL again on the track: disarmed, the keys WIRED (the bar says so)", eng_arm_mask_get() == 0u && eng_armed() < 0
              && !strcmp(msg_text, "KEYS WIRED"));
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

    {                                                       /* ENV past the last row shown: the list scrolls, the bar stays.
                                                             * On the 909 Kit: the 808 Kit has fewer devices than ENV shows */
        if (load("909 KIT") == 0) {
            pv_gen++;
            page = 0;
            trail_n = 0;
            loop();
            pages_focus(2, 0);
            loop();
            tap(4);
            later(2000);
            check("(the 909 Kit: ENV, more devices than it shows)", page == PAGE_ENV && pg_ndev > ENV_ROWS);
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
            check("(the 909 Kit loads)", 0);
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
                memcpy(before, pg_pname[d], sizeof before);
                param_now = 0;
                later(2000);
                enc(6, 1);
                check("PRESET on an assembly's page: its first preset loaded (none was set), the editor told, PRESET <NAME> in the bar",
                      page == 0 && pg_pname[d][0] && strcmp(before, pg_pname[d]) != 0 && param_now > 0 && presets_stepped == stepped
                      && !strncmp(msg_text, "PRESET ", 7) && !strcmp(msg_text + 7, pg_pname[d]));
                memcpy(before, pg_pname[d], sizeof before);
                enc(6, 1);
                check("  again: the one after it, no patch change", strcmp(before, pg_pname[d]) != 0 && presets_stepped == stepped && cur_preset == preset_at("ORACLE V"));
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
                check("  on Init's values, set to none (#432): PRESET right loads the entry after Init", !ps_name_cmp(pg_pname[d], nm1) && !strcmp(msg_text + 7, pg_pname[d]));
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
                      !strcmp(msg_text, "PRESET DELETED: SOUND KEPT") && ps_list(pg_dev[d].structure, 0, 0) == 1u);
                msg_text[0] = 0;
                dp_deleted(pg_dev[d].structure, "NOT IN USE");
                check("  one no device is set to: no message", !msg_text[0]);
            }
            later(1500);
            tap(3);                                         /* SEL on the assembly's page (#395): armed, no preset list */
            loop();
            printf("      (the bar: \"%s\")\n", msg_text);
            {
                uint64_t a = eng_arm_mask_get();
                uint32_t m, trk = 0, arp = 0;
                for (m = 0; m < 64u; m++)
                    if (a >> m & 1u) {
                        trk += eng_type(m) == T_STEPS;
                        arp += eng_type(m) == T_ARP;
                    }
                check("SEL on an instrument's page: no preset list; armed with the track and the Arpeggiator its keys come "
                      "through (#395), not NOTHING HERE TAKES KEYS",
                      page == 0 && a && a == env_listeners(d) && strstr(msg_text, " ARMED") != 0 && trk == 1u && arp == 1u);
            }
            eng_arm_mask(0);
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
                          eng_arm_mask_get() == 0u && !strcmp(msg_text, "NOTHING HERE TAKES KEYS"));
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
        check("the rows: MIDI channel, clock in, MIDI out", pages_now()->nrows == 3u && pages_now()->mod[0] == SETTING_ROW && cfg.ch == ch);
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
                  w && ((w >> 6) & 63u) == 1u && !eng_steps_note((uint32_t)drums, 3, 55) && !strcmp(msg_text, "TIED")
                  && px(seq_grid_x(3) + 5u, y) == C_DIM && px(seq_grid_x(3) - 1u, y - 4u) == C_DIM);
            panel_keys(1u << 6);                            /* again: untied */
            panel_keys(0);
            loop();
            w = eng_steps_note((uint32_t)drums, 2, 55);
            check("again on the tied step: untied, the cell empty", w && ((w >> 6) & 63u) == 0u && !strcmp(msg_text, "TIE OFF")
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
                      w && (w & 63u) + ((w >> 6) & 63u) == 15u && !strcmp(msg_text, "TIED") && px(seq_grid_x(15) + 5u, y) == C_DIM);
                panel_keys(1u << n16);
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, at, 55);
                check("again (its last step): one step", w && ((w >> 6) & 63u) == 0u && !strcmp(msg_text, "TIE OFF"));
                panel_keys(1u << 4);                        /* A3: step 3, its own hit, no row-2 hit before it */
                panel_keys(0);
                loop();
                w = eng_steps_note((uint32_t)drums, 2, 55);
                check("LFO + a hit's own step with nothing before it: NOTHING TO TIE (no tie across the loop)",
                      w && ((w >> 6) & 63u) == 0u && !strcmp(msg_text, "NOTHING TO TIE"));
                panel_held &= ~(1u << BTN_LFO);
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
        int pat, i, keep_n, k, pos;
        const uint32_t *w;
        uint32_t before, base, n, all, part, x, y, hw, r0, lo0;
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
        check("SEQ on PATTERN: the roll (no Drum map), opened around its notes: the median A#3 on the middle row",
              page == PAGE_SEQ && seq_map() < 0 && seq_roll_lo == 55u && seq_row == 4u && seq_grid_note(-1, seq_row) == 58u);
        check("the roll: each pitch's notes on the 16 steps, a 2-step note runs on dim, the C row tinted", roll_shows(pat)
              && px(seq_grid_x(4) + GRID_CW, GRID_Y + GRID_RH * 4u + 5u) == C_DIM);
        check("the markers: over the steps with notes above (D#4, F4), under those with notes below (A#2)", marks_ok(pat)
              && px(seq_grid_x(0) + 5u, MARK_DN_Y) == C_DIM && px(seq_grid_x(11) + 5u, MARK_UP_Y + 2u) == C_DIM
              && px(seq_grid_x(1) + 5u, MARK_DN_Y) == C_BG);
        check("the names: pitches top down (D4 .. G3), the selected one on coral, C4's tinted",
              px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * 4u + 1u) == C_ACC && px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * 2u + 1u) == C_CROW
              && px(4u + GRID_NAME_W - 1u, GRID_Y + GRID_RH * 3u + 1u) == C_BG);
        snap_to(getenv("PANEL_SNAP_ROLL"));

        k = 2;                                              /* a white key: A#3 on step 3 (it has none) */
        for (n = 0; seq_white(n) != k; n++)
            ;
        x = seq_grid_x((uint32_t)k);
        y = GRID_Y + GRID_RH * 4u;
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        panel_keys(1u << n);
        panel_keys(0);
        loop();
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(x, y, x + GRID_CW, y + GRID_CH);
        printf("      (roll, a step: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("a white key: the selected pitch's note on its step, that cell alone redrawn (ivory)", eng_steps_note((uint32_t)pat, 2u, 58u)
              && all > 0u && all == part && lcd_px <= GRID_CW * GRID_CH && px(x + 5u, y + GRID_CH - 1u) == C_FG);
        panel_keys(1u << n);                                /* again: gone */
        panel_keys(0);
        loop();
        check("again: off", !eng_steps_note((uint32_t)pat, 2u, 58u) && roll_shows(pat));

        fb_watch_reset();                                   /* SELECT: the next row down (A3) */
        lcd_px = lcd_xfers = 0;
        enc(0, 1);
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(4, GRID_Y + GRID_RH * 4u, 4 + GRID_NAME_W, GRID_Y + GRID_RH * 4u + FONT_S.h)
             + fb_changed_in(4, GRID_Y + GRID_RH * 5u, 4 + GRID_NAME_W, GRID_Y + GRID_RH * 5u + FONT_S.h);
        printf("      (roll, SELECT a row on: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("SELECT: the next pitch down, only the two names redrawn", seq_row == 5u && seq_grid_note(-1, seq_row) == 57u
              && all > 0u && all == part && fb_blinked() == 0 && lcd_px <= 2u * GRID_NAME_W * FONT_S.h);
        enc(0, -5);
        check("SELECT back up to the top row (D4)", seq_row == 0u && seq_roll_lo == 55u);
        fb_watch_reset();                                   /* past the top: the window scrolls a semitone */
        lcd_px = lcd_xfers = 0;
        enc(0, -1);
        all = fb_changed_in(0, 0, 240, 240);
        part = fb_changed_in(0, MARK_UP_Y, 240, GRID_TICK_Y);
        printf("      (roll, a scroll: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("SELECT past the top row: the window scrolls (D#4 on top), only the rows redrawn (not the bar, the lines)",
              seq_row == 0u && seq_roll_lo == 56u && seq_grid_note(-1, 0) == 63u && all > 0u && all == part && fb_blinked() == 0
              && roll_shows(pat) && marks_ok(pat));

        {                                                   /* the roll's black keys (#387): 1..8 the rows on screen, black key 1
                                                             * the bottom one; stopped, the row sounds; the track stays */
            uint32_t keys, nn0 = (uint32_t)eng_steps_notes((uint32_t)pat, &w), trk0 = seq_trk;
            steps_inst((uint32_t)pat)->s.stp.hit = 0;
            fb_watch_reset();
            lcd_px = lcd_xfers = 0;
            panel_keys(1u << 1);                            /* black key 1 (F#3): the bottom row, G#3 */
            panel_keys(0);
            loop();
            all = fb_changed_in(0, 0, 240, 240);
            part = fb_changed_in(4, GRID_Y, 4 + GRID_NAME_W, GRID_Y + FONT_S.h)
                 + fb_changed_in(4, GRID_Y + GRID_RH * 7u, 4 + GRID_NAME_W, GRID_Y + GRID_RH * 7u + FONT_S.h);
            keys = host_led_mask(fm1_led, 14);
            printf("      (roll, black key 1: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
            check("roll: black key 1 picks the bottom row (G#3) and sounds it; the track stays, nothing written, two names redrawn",
                  seq_row == 7u && seq_grid_note(-1, seq_row) == 56u && seq_roll_lo == 56u && seq_trk == trk0
                  && steps_inst((uint32_t)pat)->s.stp.hit && E.trk_last[E.node[pat].trk] == 56u
                  && (uint32_t)eng_steps_notes((uint32_t)pat, &w) == nn0 && all > 0u && all == part);
            check("  its LED bright, no other black key bright", (keys >> 1 & 1u) && !(keys & (1u << 3 | 1u << 5 | 1u << 8 | 1u << 10
                  | 1u << 13 | 1u << 15 | 1u << 17 | 1u << 20 | 1u << 22 | 1u << 25)));
            panel_keys(1u << 17);                           /* black key 8 (A#4): the top row, D#4 */
            panel_keys(0);
            loop();
            keys = host_led_mask(fm1_led, 14);
            check("roll: black key 8 picks the top row (D#4), its LED bright", seq_row == 0u && seq_grid_note(-1, seq_row) == 63u
                  && seq_trk == trk0 && (keys >> 17 & 1u) && !(keys >> 1 & 1u));
            panel_keys(1u << 20);                           /* black key 9 (C#5): nothing (8 rows) */
            panel_keys(0);
            loop();
            check("roll: black key 9 does nothing (the track, the row stay)", seq_row == 0u && seq_trk == trk0 && seq_roll_lo == 56u);
            enc(0, -1);                                     /* the window scrolls: black key 1 follows it (now A3) */
            panel_keys(1u << 1);
            panel_keys(0);
            loop();
            check("roll: the window scrolled a semitone, black key 1 is its new bottom row (A3)", seq_roll_lo == 57u && seq_row == 7u
                  && seq_grid_note(-1, seq_row) == 57u);
            enc(0, 1);                                      /* (back as it was: G#3 at the bottom, the top row D#4) */
            enc(0, -7);
            check("  (SELECT back: the window and the row as before)", seq_roll_lo == 56u && seq_row == 0u);
        }

        steps_inst((uint32_t)pat)->s.stp.hit = 0;           /* FX held + OCT-: the keys' octave; then the pen, SEL held + a key */
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        panel_held |= 1u << BTN_ACC;
        tap(BTN_OCT_DOWN);
        panel_held &= ~(1u << BTN_ACC);
        check("FX held + OCT- on the roll: the keys' octave (not the page)", octave == -1 && seq_pg == 0u);
        check("the octave message ends after its number (it showed a stray character)", !strcmp(msg_text, "OCTAVE -1"));
        lo0 = seq_roll_lo;
        panel_held |= 1u << BTN_SEL;
        panel_keys(1u << 5);                                /* A#2 at octave -1 (out of the window) */
        panel_keys(0);
        loop();
        check("SEL + a key (the pen): the selected row is its pitch (A#2), the window opens around it, heard, no note written",
              seq_grid_note(-1, seq_row) == 46u && seq_roll_lo == 43u && lo0 != 43u && steps_inst((uint32_t)pat)->s.stp.hit
              && (uint32_t)eng_steps_notes((uint32_t)pat, &w) == before && roll_shows(pat));
        check("  the markers: a triangle over each step with notes above the window (A#3 on step 2), none below",
              marks_ok(pat) && px(seq_grid_x(1) + 5u, MARK_UP_Y + 2u) == C_DIM && px(seq_grid_x(2) + 5u, MARK_UP_Y + 2u) == C_BG
              && px(seq_grid_x(0) + 5u, MARK_DN_Y) == C_BG);
        snap_to(getenv("PANEL_SNAP_ROLL_MARKS"));
        r0 = seq_row;
        fb_watch_reset();
        lcd_px = lcd_xfers = 0;
        panel_keys(1u << 7);                                /* the pen on C3, in the window: the row moves, no scroll */
        panel_keys(0);
        loop();
        printf("      (roll, the pen in the window: %u LCD transfers, %u pixels)\n", (unsigned)lcd_xfers, (unsigned)lcd_px);
        check("the pen in the window: the row moves, only the two names redrawn", seq_grid_note(-1, seq_row) == 48u && seq_roll_lo == 43u
              && fb_changed_in(0, 0, 240, 240) == fb_changed_in(4, GRID_Y + GRID_RH * r0, 4 + GRID_NAME_W, GRID_Y + GRID_RH * r0 + FONT_S.h)
                 + fb_changed_in(4, GRID_Y + GRID_RH * seq_row, 4 + GRID_NAME_W, GRID_Y + GRID_RH * seq_row + FONT_S.h));
        panel_keys(1u << 5);                                /* (A#2 again) */
        panel_keys(0);
        panel_held &= ~(1u << BTN_SEL);
        panel_edges(0, 1u << BTN_SEL);                      /* (SEL let go on the SEQ page: nothing) */
        loop();
        check("  SEL let go: the page stays", page == PAGE_SEQ);
        panel_held |= 1u << BTN_ACC;
        tap(BTN_OCT_UP);
        panel_held &= ~(1u << BTN_ACC);
        loop();
        check("(FX + OCT+: octave 0 again)", octave == 0 && seq_grid_note(-1, seq_row) == 46u);

        panel_keys(1u << 0);                                /* step 1 held (its A#2 switched off by the press) */
        loop();
        enc(2, 1);                                          /* + K1: the note back, a semitone up, the row follows */
        check("a held step + K1: its note in the selected row a semitone up (B2), the row follows it",
              eng_steps_note((uint32_t)pat, 0u, 47u) && !eng_steps_note((uint32_t)pat, 0u, 46u) && seq_grid_note(-1, seq_row) == 47u
              && !strcmp(msg_text, "STEP 1  B2  VEL 127"));
        enc(2, -1);
        later(200);                                         /* (not turned fast) */
        enc(3, -5);                                         /* + K2: its velocity (it was accented: 127) */
        hw = eng_steps_note((uint32_t)pat, 0u, 46u);
        check("+ K1 back, + K2: its velocity (122)", hw && ((hw >> 19) & 127u) == 122u && seq_grid_note(-1, seq_row) == 46u);
        panel_keys(0);
        loop();
        panel_held |= 1u << BTN_ACC;                        /* FX + the white key: its accent (as on drums) */
        panel_keys(1u << 0);
        panel_keys(0);
        panel_held &= ~(1u << BTN_ACC);
        loop();
        hw = eng_steps_note((uint32_t)pat, 0u, 46u);
        check("FX + a white key on a note: its accent (127, coral)", hw && ((hw >> 19) & 127u) == ACCENT_VEL
              && px(seq_grid_x(0) + 5u, GRID_Y + GRID_RH * seq_row + GRID_CH - 1u) == C_ACC);
        panel_held |= 1u << BTN_ACC;                        /* FX + an empty step: an accented note */
        panel_keys(1u << 4);
        panel_keys(0);
        panel_held &= ~(1u << BTN_ACC);
        loop();
        hw = eng_steps_note((uint32_t)pat, 2u, 46u);
        check("FX + a white key on an empty step: an accented note", hw && ((hw >> 19) & 127u) == ACCENT_VEL);
        panel_keys(1u << 4);                                /* (off again) */
        panel_keys(0);
        panel_keys(1u << 0);                                /* step 1 held again */
        loop();
        enc(4, -2);                                         /* + K3: its chance (the owner, 2026-10-24: not SELECT on the roll) */
        hw = eng_steps_note((uint32_t)pat, 0u, 46u);
        check("+ K3: its chance (90 %), the row stays", hw && ((hw >> 26) & 31u) == 2u && seq_grid_note(-1, seq_row) == 46u
              && !strcmp(msg_text, "CHANCE 90%"));
        enc(0, 1);                                          /* + SELECT: the row moves, the chance stays */
        hw = eng_steps_note((uint32_t)pat, 0u, 46u);
        check("+ SELECT with a step held on the roll: the row moves (A2), the chance stays", seq_grid_note(-1, seq_row) == 45u
              && hw && ((hw >> 26) & 31u) == 2u);
        enc(0, -1);
        panel_keys(0);
        loop();

        panel_held |= 1u << BTN_LFO;                        /* LFO + step 11: A#2 on step 9 (2 steps) goes on through it */
        panel_keys(1u << 18);
        panel_keys(0);
        loop();
        hw = eng_steps_note((uint32_t)pat, 8u, 46u);
        check("LFO + a white key: the note sounding on the step before tied through it (3 steps), drawn dim",
              seq_white(18) == 10 && hw && ((hw >> 6) & 63u) == 2u && roll_shows(pat)
              && px(seq_grid_x(10) + 5u, GRID_Y + GRID_RH * seq_row + 5u) == C_DIM);
        panel_keys(1u << 16);                               /* LFO + step 10 (inside it, 2026-10-28): it ends there */
        panel_keys(0);
        loop();
        hw = eng_steps_note((uint32_t)pat, 8u, 46u);
        check("LFO + a step inside the note: it ends there (2 steps)", seq_white(16) == 9 && hw && ((hw >> 6) & 63u) == 1u
              && roll_shows(pat) && px(seq_grid_x(10) - 1u, GRID_Y + GRID_RH * seq_row + 5u) == C_BG && !strcmp(msg_text, "TIED"));
        panel_keys(1u << 16);                               /* LFO + step 10 again, its last step: one step again */
        panel_keys(0);
        loop();
        hw = eng_steps_note((uint32_t)pat, 8u, 46u);
        check("LFO + the note's last step: one step again (TIE OFF)", hw && ((hw >> 6) & 63u) == 0u && roll_shows(pat)
              && px(seq_grid_x(9) - 1u, GRID_Y + GRID_RH * seq_row + 5u) == C_BG && !strcmp(msg_text, "TIE OFF"));
        msg_text[0] = 0;
        panel_keys(1u << 0);                                /* LFO + step 1: its own A#2, none before it (no tie across the loop) */
        panel_keys(0);
        loop();
        check("LFO + a note's own step, nothing before it: NOTHING TO TIE", seq_white(0) == 0 && eng_steps_note((uint32_t)pat, 0u, 46u)
              && ((eng_steps_note((uint32_t)pat, 0u, 46u) >> 6) & 63u) == 0u && !strcmp(msg_text, "NOTHING TO TIE"));
        later(1000);
        panel_yield = keys_yield_q;                         /* the roll's keys during a full redraw (D-228): nothing drawn from inside */
        yield_xfers = 0;
        msg_text[0] = 0;
        kq_edge(0, 1);                                      /* LFO + step 1 again: its message waits for the loop's pass */
        kq_edge(0, 0);
        ui_dirty = 2;
        panel_draw();
        check("in a redraw, LFO + a step: taken, its message left for the pass", kq_r == kq_w && yield_xfers == 0u && !msg_text[0]);
        loop();
        check("  the pass shows it", !strcmp(msg_text, "NOTHING TO TIE"));
        panel_held &= ~(1u << BTN_LFO);
        panel_held |= 1u << BTN_SEL;
        kq_edge(7, 1);                                      /* SEL + C4 (the pen) during a redraw */
        kq_edge(7, 0);
        ui_dirty = 2;
        panel_draw();
        panel_held &= ~(1u << BTN_SEL);
        hw = eng_steps_note((uint32_t)pat, 2u, 60u);
        kq_edge(4, 1);                                      /* A3: C4 on step 3, during a redraw */
        kq_edge(4, 0);
        ui_dirty = 2;
        panel_draw();
        check("in a redraw, the pen and a white key: the row C4, its note on step 3 switched, nothing drawn from inside",
              seq_grid_note(-1, seq_row) == 60u && !hw == !!eng_steps_note((uint32_t)pat, 2u, 60u) && kq_r == kq_w && yield_xfers == 0u);
        panel_yield = 0;
        loop();
        check("  the next pass draws the roll as it is", roll_shows(pat));

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
        check("the SEQ page armed the track it showed (#395)", eng_arm_mask_get() == (uint64_t)1 << pat);
        eng_arm_mask(0);                                    /* (WIRED again, for REC held + a black key) */
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
                  && !strcmp(msg_text, "REC PATTERN"));
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
              && seq_kbd() && !strcmp(seq_grid_text[2], "KEYS record  SELECT row  OCT octave  FX acc"));
        later(1100);
        check("  its bar: PATTERN REC on red", bar_shows("PATTERN REC P01", C_RED));
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
              && page == PAGE_SEQ && !seq_kbd() && !(E.trk_rec >> E.node[pat].trk & 1u) && !strcmp(msg_text, "REC OFF"));
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        panel_keys(1u << 8);                                /* black key 4, running, not recording: its row, nothing recorded */
        for (i = 0; i < 10; i++)
            eng_render(l, r, 128);
        panel_keys(0);
        eng_render(l, r, 128);
        loop();
        check("  a black key then: its row picked, nothing recorded", seq_row == 4u && (uint32_t)eng_steps_notes((uint32_t)pat, &w) == before);
        tap(BTN_REC);                                       /* running: REC records at once */
        check("REC, running: recording again", seq_rec && seq_kbd() && (E.trk_rec >> E.node[pat].trk & 1u));
        enc(1, -1);                                         /* ALGO while recording: the track shown armed, it records instead */
        loop();
        {
            int t0 = eng_steps_module(0);
            check("  ALGO while recording: the track shown is armed and records, the other not, REC goes on", seq_rec && seq_trk == 0u
                  && eng_arm_mask_get() == (uint64_t)1 << t0 && (E.trk_rec >> E.node[t0].trk & 1u) && !(E.trk_rec >> E.node[pat].trk & 1u));
        }
        enc(1, 1);
        loop();
        check("  ALGO back: PATTERN records again", seq_rec && seq_trk == 1u && (E.trk_rec >> E.node[pat].trk & 1u) && seq_kbd());
        {
            int at = mlen;
            tap(BTN_PLAY);                                  /* PLAY stops everything */
            check("PLAY while recording: the transport stops (MIDI Stop out) and recording ends", !seq_rec && !eng_transport_running()
                  && sent(at, 0xFCu, 0xFFu, 0xFFu) && !(E.trk_rec >> E.node[pat].trk & 1u) && page == PAGE_SEQ);
            later(1500);
            check("  the bar says ARM again, not REC (redrawn by the loop)", bar_shows("PATTERN ARM P01", C_ACC));
        }
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);
        loop();
        before = (uint32_t)eng_steps_notes((uint32_t)pat, &w);
        steps_inst((uint32_t)pat)->s.stp.hit = 0;
        panel_keys(1u << 8);                                /* stopped: black key 4 (C#4) picks its row and it is heard, nothing */
        panel_keys(0);                                      /* recorded (#387) */
        check("stopped, REC off: a black key picks its row and it is heard, nothing recorded", steps_inst((uint32_t)pat)->s.stp.hit
              && seq_row == 4u && E.trk_last[E.node[pat].trk] == seq_roll_lo + 3u
              && (uint32_t)eng_steps_notes((uint32_t)pat, &w) == before);
        hw = eng_steps_note((uint32_t)pat, 1u, seq_grid_note(-1, seq_row));
        panel_keys(1u << 2);                                /* a white key: step 2, the selected pitch */
        panel_keys(0);
        loop();
        check("a white key: the selected pitch's note on its step switched", !hw == !!eng_steps_note((uint32_t)pat, 1u, seq_grid_note(-1, seq_row)));
        (void)eng_steps_set_notes((uint32_t)pat, keep, (uint32_t)keep_n);
        seq_sync(pat);

        panel_held |= 1u << BTN_REC;                        /* REC held + black key 2: PATTERN out of the armed set, the keys wired */
        panel_edges(1u << BTN_REC, 0);
        panel_keys(1u << 3);
        panel_keys(0);
        panel_held &= ~(1u << BTN_REC);
        panel_edges(0, 1u << BTN_REC);
        loop();
        tap(BTN_REC);
        check("REC with nothing armed: it still runs, the bar says so, nothing records", seq_rec && eng_transport_running()
              && eng_arm_mask_get() == 0u && !E.trk_rec && !seq_kbd() && page == PAGE_SEQ && !strcmp(msg_text, "REC: NO TRACK ARMED"));
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
        (void)load("SCROUNGE");                             /* the factory Scrounge's PATTERN: it drives a Drum map, so its grid */
        pv_gen++;
        page = 0;
        trail_n = 0;
        screen_idle();
        check("(Scrounge: one track, PATTERN, into its Drum map)", eng_steps_count() == 1 && eng_steps_drummap((uint32_t)eng_steps_module(0)) >= 0);
        seq_select(0);
        page_set(PAGE_SEQ);
        later(1500);
        check("Scrounge's PATTERN: the drum grid of its map's rows, not the roll", page == PAGE_SEQ && seq_map() >= 0
              && px(4u + GRID_NAME_W - 1u, GRID_Y + 1u) == C_ACC && !strcmp(seq_grid_text[2], "BLACK row  WHITE step  FX acc  SEL song"));
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
        eng_arm_mask(0);                                    /* (the page armed DRUMS, #395: WIRED again, as REC held + its key
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
              bar_shows("DRUMS ARMED", C_FG) && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(BAR_H) == 0);
        later(1500);
        put(want, "DRUMS ARM P01")[0] = 0;                    /* (a drum track's bar: no row, the grid shows it) */
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
        bar = fb_changed_in(0, 0, 240, LK_HH);
        line = fb_changed_in(0, FOOT_Y, 240, 240);
        check("device page: the arm redraws the header's message and the footer (ARM DRUMS) only, no blink",
              eng_armed() == drums && bar > 0u && line > 0u && all == bar + line && fb_blinked_below(LK_HH) == 0
              && on_screen("ARM DRUMS"));
        fb_watch_reset();
        held_key(BTN_SEQ, 1);
        check("device page: a mute draws only the header's message", eng_steps_muted((uint32_t)drums)
              && fb_changed_in(0, 0, 240, 240) == fb_changed_in(0, 0, 240, LK_HH) && fb_blinked_below(LK_HH) == 0);
        held_key(BTN_SEQ, 1);
        held_key(BTN_REC, 1);
        later(1500);
        check("device page, unmuted and disarmed: as it was", eng_armed() < 0 && !memcmp(base, fb, sizeof base));

        E.node[map].ksrc = 0;                               /* the Drum map off DRUMS: a melodic track, its roll (#241) */
        tap(BTN_SEQ);
        eng_arm_mask(0);                                    /* (WIRED again: the page armed it) */
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
        check("melodic track: the bar says ARM", bar_shows("DRUMS ARM P01", C_ACC));
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
            uint32_t b, n;
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
                ok &= (inst_pool[E.node[map].inst0].s.dm.gate >> b & 1u) && key_eng[n] == seq_row_note(map, b)
                      && sent(m0, 0x90u, seq_row_note(map, b), 100u) && mlen == m0 + 1;
                panel_keys(0);
                for (i = 0; i < 3; i++)
                    eng_render(l, r, 128);
                ok &= inst_pool[E.node[map].inst0].s.dm.gate == 0 && sent(m0, 0x80u, seq_row_note(map, b), 0u) && mlen == m0 + 2;
            }
            snprintf(what, sizeof what, "%s: black keys 1..8 play rows 1..8 (the device page), MIDI out the rows' notes", KIT[kit]);
            check(what, ok);
            for (n = 0; n < 27u; n++) {
                if (seq_black(n) >= 0 && seq_black(n) < (int)ENG_DRUM_ROWS)
                    continue;
                m0 = mlen;
                panel_keys(1u << n);
                for (i = 0; i < 3; i++)
                    eng_render(l, r, 128);
                quiet &= inst_pool[E.node[map].inst0].s.dm.gate == 0 && key_eng[n] == KEY_SILENT && mlen == m0;
                panel_keys(0);
                quiet &= mlen == m0;
            }
            snprintf(what, sizeof what, "%s: white keys and black keys 9..11 play nothing, on MIDI out too", KIT[kit]);
            check(what, quiet);
            if (kit == 0u) {                                /* the map repeats its rows (#184): those keys play their own note */
                uint32_t rows = 0;
                ok = 1;
                eng_set_param((uint32_t)map, DRUMMAP_P_REPEAT, ENG_ONE);
                for (n = 0; n < 27u; n++) {
                    if (seq_black(n) >= 0 && seq_black(n) < (int)ENG_DRUM_ROWS)
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
            ok = inst_pool[E.node[map].inst0].s.dm.gate == 2u && sent(mlen - 1, 0x90u, seq_row_note(map, 1), 100u);
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
            eng_note_on(seq_row_note(map, 2), ENG_ONE, 1);  /* MIDI in: by note number, as before */
            for (i = 0; i < 3; i++)
                eng_render(l, r, 128);
            snprintf(what, sizeof what, "%s: a MIDI note still plays the row of its note", KIT[kit]);
            check(what, inst_pool[E.node[map].inst0].s.dm.gate == 4u);
            eng_note_off(seq_row_note(map, 2), 1);
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
        check("SELECT past the last row: the last (clamped, no wrap)", seq_row == ENG_DRUM_ROWS - 1u);
        enc(0, -20);
        check("SELECT back past the first: the first", seq_row == 0u);
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
        check("a track of 32: the hint names OCT for steps 17 and up (#490)", !strcmp(seq_grid_text[2], "BLACK/SELECT row  WHITE step  FX acc  OCT 17+"));
        {                                                   /* a step held: the hint line names its knobs, let go: back (#450) */
            uint32_t wk;
            for (wk = 0; seq_white(wk) != 0; wk++)
                ;
            panel_keys(1u << wk);
            loop();
            check("a step held: the hint says HELD STEP and its knobs", seq_held == 0 && !strcmp(seq_grid_text[2], "HELD STEP: K2 vel  SELECT chance"));
            panel_keys(0);
            loop();
            check("  let go: the hint as before", seq_held < 0 && !strcmp(seq_grid_text[2], "BLACK/SELECT row  WHITE step  FX acc  OCT 17+"));
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
              page == 0u && seq_rec && eng_transport_running() && !E.trk_rec && !strcmp(msg_text, "REC: NO TRACK ARMED"));
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
              && eng_transport_running() && (E.trk_rec >> E.node[drums].trk & 1u) && !strcmp(msg_text, "REC DRUMS"));
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
                  seq_rec && seq_cin && !E.trk_rec && !strcmp(msg_text, "COUNT-IN") && eng_transport_running());
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
            check("  beat 2 of the count: the bar says COUNT-IN 2, nothing records", seq_cin == 2u && !strcmp(msg_text, "COUNT-IN 2") && !E.trk_rec);
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
                  && !strcmp(msg_text, "REC DRUMS") && rel >= 0 && (uint32_t)rel % 96u < 2u);
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
            check("  bar 2, beat 2: the bar says COUNT-IN 2.2", seq_cin == 2u && !strcmp(msg_text, "COUNT-IN 2.2"));
            tap(BTN_REC);
            check("  REC again during the count-in: REC off, nothing recorded, the transport goes on", !seq_rec && !seq_cin && !E.trk_rec
                  && eng_transport_running() && !strcmp(msg_text, "REC OFF"));
            tap(BTN_REC);
            check("  REC once more: a new count-in", seq_rec && seq_cin);
            tap(BTN_PLAY);
            check("  PLAY during the count-in: all stopped, nothing recorded", !seq_rec && !seq_cin && !eng_transport_running() && !E.trk_rec);
            cfg.count_in = 0;
            tap(BTN_REC);
            check("COUNT-IN OFF: REC records at once", seq_rec && !seq_cin && (E.trk_rec >> E.node[drums].trk & 1u) && !strcmp(msg_text, "REC DRUMS"));
        }
        tap(BTN_PLAY);
        held_key(BTN_REC, 1);
        check("(disarmed, stopped)", eng_armed() < 0 && !eng_transport_running() && seq_rec == 0u);
        while (page != 0u && trail_n)
            tap(BTN_HOME);
    }
    {                                                       /* #170, the owner's design (2026-10-24): PRESET grows the footer
                                                             * into a toast (the slot, the name, the filled slots), the new
                                                             * patch's page drawn around it at once */
        static uint16_t staged[240 * 240];
        uint32_t i, n;
        int main;
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
              && !strcmp(patch_label, "<7PH") && on_screen("<7PH") && on_screen("23.") && toast_scr != 0u
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
        check("PRESET turning fast: the next name, only the toast drawn", cur_preset == 0 && !strcmp(patch_label, "ORACLE V")
              && on_screen("ORACLE V") && lcd_px == 240u * LK_TOH);
        stop_answer = 0;
        loop();
        pages_waiting = 0;
        fb_watch_reset();
        lcd_px = 0;
        later(1100);
        printf("      LCD pixels for the toast's end: %u\n", lcd_px);
        check("the toast ends: only its band drawn again, the footer and the bars under it", toast_scr == 0u
              && fb_changed_in(0, 0, 240, 240u - LK_TOH) == 0u && lcd_px <= 240u * LK_TOH && px(0, 239) == P_SAND
              && px(0, 240u - LK_TOH) != P_SAND && on_screen("ORACLE V"));
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
                                                             * patch): the FM-1 muted, the editor's page drawn, PRESET held */
        uint32_t slot = cur_preset, y, x, gold;
        int stepped = presets_stepped, from, pn;
        sb_page_t pg;
        page = 0;
        trail_n = 0;
        screen_idle();
        later(2000);
        preset_loads = 1;
        info_told = 0;
        m1_live(1);                                         /* LIVE paused: sandbox mode */
        check("LIVE paused: sandbox mode, the FM-1 muted", sb_on && snd_muted && !sb_have);
        check("  the MIDI OUT setting told once (INFO)", info_told == 1);
        loop();
        for (gold = 0, y = 70; y < 100u; y++)
            for (x = 0; x < 240u; x++)
                gold += px(x, y) == P_GOLD;
        check("  the screen: the gold SANDBOX bar and the card (no bars yet)", px(4, 4) == P_GOLD && gold > 30u
              && K1_TAB == P_NIGHT);
        later(1000);
        m1_live(1);                                         /* every 2 s again */
        check("  LIVE paused again: no INFO", info_told == 1);
        {                                                   /* the editor's page (SANDBOX), through sb_parse */
            uint8_t d[SB_BYTES];
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
            check("SANDBOX parses (and a short one does not)", sb_parse(d, sizeof d, &pg) == 0 && sb_parse(d, sizeof d - 1u, &pg) < 0
                  && pg.rows == 7u && pg.index == 2u && pg.count == 5u && !strcmp(pg.patch, "SOL 29N XL") && !strcmp(pg.dev, "Sol filter")
                  && !strcmp(pg.label[0], "Cutoff") && !strcmp(pg.unit[0], "kHz") && pg.pos[0] == 128u && pg.steps[2] == 3u);
        }
        m1_sandbox(&pg);
        loop();
        for (gold = 0, x = 0; x < 240u; x++)
            gold += px(x, SB_RAIL_Y) == P_GOLD;
        check("the page: its bars (K4 empty), the third page of five lit in gold", sb_have && K1_TAB != P_NIGHT
              && px(BAR_X + 2u, row_y(3) + 2u) == P_STRIP && gold > 20u && px(4, 4) == P_GOLD);
        check("  K1 half way: its fill to the middle", px(BAR_X + BAR_W / 2u - 8u, row_y(0) + 4u) != px(BAR_X + BAR_W / 2u + 8u, row_y(0) + 4u));
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
        pg.pos[0] = 10u;                                    /* the editor's page brings K1's old position back at once: */
        m1_sandbox(&pg);                                    /* the turn here wins for a moment */
        check("  an echo right after a turn keeps the turned position", sb_cc[0] == 65u);
        later(SB_ECHO_MS + 10u);
        m1_sandbox(&pg);
        check("  later the editor's position counts", sb_cc[0] == (10u * 127u + 127u) / 255u);
        from = mlen;
        tap(BTN_SEQ);                                       /* SEQ: out as MIDI only */
        check("SEQ in sandbox mode: its CC goes out, the page stays", sent(from, 0xB0u, 89u, 127u) && page == 0u && sb_on);
        tap(BTN_GLO);                                       /* GLO: the menu (MIDI OUT is there) */
        check("GLO in sandbox mode: the menu", page == PAGE_MENU);
        tap(BTN_HOME);
        check("  HOME: back to the sandbox page", page == 0u && px(4, 4) == P_GOLD && K1_TAB != P_NIGHT);
        check("  the screen as text: the sandbox page, the device page's texts gone", on_screen("BROWSER PLAYS") && !on_screen("= OCT ="));
        loop();
        check("  the battery in the footer, night on sand", px(BATT_FX, BATT_FY) == P_NIGHT && px(BATT_FX - 2u, BATT_FY) == P_SAND);
        from = mlen;
        panel_keys(1u);                                     /* a key: the note goes out (the FM-1 itself is muted) */
        panel_keys(0u);
        loop();
        check("a key in sandbox mode: its note out", sent(from, 0x90u, (uint32_t)(53 + 12 * octave), 100u));
        enc(6, 1);
        check("PRESET in sandbox mode: no slot change, SANDBOX: PATCH STAYS", cur_preset == slot
              && presets_stepped == stepped && !strcmp(msg_text, "SANDBOX: PATCH STAYS"));
        later(1600);
        check("  the message ends: the gold bar again", px(4, 4) == P_GOLD);
        cfg.midi_out = 0;                                   /* MIDI OUT off on the GLO page: the editor hears of it */
        m1_live(1);
        ui_dirty = 2;
        loop();
        check("MIDI OUT off: INFO again, the foot line says how to turn it on", info_told == 2 && fb_has_hue(FOOT_Y, P_WARN));
        cfg.midi_out = 1;
        m1_live(1);
        msg_text[0] = 0;
        m1_live(0);                                         /* the patch fits again: Live resumes */
        loop();
        check("LIVE not paused: sandbox mode ends, the sound and the device page back", !sb_on && !snd_muted
              && px(4, 4) != P_GOLD && K1_TAB != P_NIGHT && msg_text[0] == 0);
        m1_sandbox(&pg);
        check("  a page after it: not taken", !sb_have);
        patch_enc(-1);
        check("PRESET under Live (resumed): still held, EDITOR LIVE: PATCH STAYS", cur_preset == slot
              && presets_stepped == stepped && !strcmp(msg_text, "EDITOR LIVE: PATCH STAYS"));
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
        check("sandbox mode begun on the SEQ page: the sandbox page comes up at once", sb_on && page == 0u && px(4, 4) == P_GOLD);
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
              !strcmp(msg_text, "LOW BATTERY") && bar_shows("LOW BATTERY", C_FG) && BPX(0, 0) == P_WARN && BPX(2, 2) == P_SAND);
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
        check("USB gone while low: LOW BATTERY again", !strcmp(msg_text, "LOW BATTERY"));
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
        check("8 Lire, Scrounge: PATTERN plays their Drum maps through the arpeggiator: the black keys play the rows",
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
            put(put(put(want, "CLEAR "), name), "? REC AGAIN")[0] = 0;
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
            put(put(want, name), " CLEARED")[0] = 0;
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
            check("  a key while it asks: NOT CLEARED", !strcmp(msg_text, "NOT CLEARED"));
            panel_keys(1u << n);
            panel_keys(0);
            loop();
            (void)eng_steps_set_notes((uint32_t)mod, keep, (uint32_t)keep_n);
            seq_sync(mod);
            tap(BTN_REC);
            check("  then REC asks again, nothing cleared", eng_steps_notes((uint32_t)mod, &w) == keep_n && !strncmp(msg_text, "CLEAR ", 6));
            enc(0, 1);
            check("  a knob turned while it asks: NOT CLEARED", !strcmp(msg_text, "NOT CLEARED"));
            enc(0, -1);
            tap(BTN_REC);
            panel_held &= ~(1u << BTN_SEQ);                 /* SEQ let go while it asks: not cleared */
            panel_edges(0, 1u << BTN_SEQ);
            loop();
            check("  SEQ let go while it asks: NOT CLEARED, the page stays", !strcmp(msg_text, "NOT CLEARED") && page == PAGE_SEQ);
            panel_held |= 1u << BTN_SEQ;
            panel_edges(1u << BTN_SEQ, 0);
            loop();
            tap(BTN_REC);
            check("  held again, REC: it asks again (the first press never clears)", eng_steps_notes((uint32_t)mod, &w) == keep_n && !strncmp(msg_text, "CLEAR ", 6));
            panel_held &= ~(1u << BTN_SEQ);
            panel_edges(0, 1u << BTN_SEQ);
            loop();
            tap(BTN_REC);                                   /* REC alone: recording on / off as before */
            check("  REC alone after it: recording on, nothing cleared", seq_rec != 0u && eng_steps_notes((uint32_t)mod, &w) == keep_n);
            tap(BTN_REC);
            tap(BTN_PLAY);                                  /* (REC started the transport, #395: stopped again) */
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
        check("(<7PH loads with nothing armed: WIRED)", drums >= 0 && pat >= 0 && eng_arm_mask_get() == 0u);
        seq_trk = 0;
        tap(BTN_SEQ);
        check("SEQ: the page arms the track it shows", page == PAGE_SEQ && seq_trk == 0u && eng_arm_mask_get() == (uint64_t)1 << drums);
        check("  its track line: ARMED, then the ALGO and clear hints where they fit (#450)", strstr(seq_grid_text[1], "  ARMED  ALGO track  SEQ+REC clear") != 0);
        enc(1, 1);
        check("ALGO there: the track it shows now armed, the one before disarmed", seq_trk == 1u && eng_arm_mask_get() == (uint64_t)1 << pat);
        later(1500);
        check("  its bar: PATTERN ARM", bar_shows("PATTERN ARM P01", C_ACC));
        (void)load("<7PH");                                  /* another patch while the page shows (the editor's Send) */
        pv_gen++;
        loop();
        check("another patch while the SEQ page shows: the track it shows armed again", page == PAGE_SEQ
              && eng_arm_mask_get() == (uint64_t)1 << eng_steps_module(seq_trk));
        tap(BTN_SEQ);
        eng_arm_mask(0);
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
              && eng_arm_mask_get() == ((uint64_t)1 << drums | (uint64_t)1 << pat) && env_armed((uint32_t)dd) && env_armed((uint32_t)dp));
        pages_select(dd - dp);
        loop();
        tap(3);
        check("SEL on the first again: only the second stays armed", eng_arm_mask_get() == (uint64_t)1 << pat && !strcmp(msg_text, "DRUMS DISARMED"));
        pages_select(dp - dd);
        loop();
        tap(3);
        check("SEL on the last one armed: nothing armed, the keys WIRED", eng_arm_mask_get() == 0u && !strcmp(msg_text, "KEYS WIRED"));
        tap(4);
        later(1500);
        printf("      (the footer: \"%s\" \"%s\")\n", (foot_layout(&f), f.a), f.w);
        check("  the device page's footer: KEYS WIRED", page == 0u && (foot_layout(&f), !strcmp(f.w, "KEYS WIRED")) && on_screen("KEYS WIRED"));
        pages_focus((uint32_t)dp, 0);                       /* a take on PATTERN, then SEL on DRUMS' page: DRUMS records instead */
        loop();
        tap(3);
        tap(BTN_PLAY);
        tap(BTN_REC);
        check("(a take on PATTERN, the device page)", page == 0u && seq_rec && eng_armed() == pat && (E.trk_rec >> E.node[pat].trk & 1u));
        pages_focus((uint32_t)dd, 0);
        loop();
        tap(3);
        check("SEL on another track's page while recording: that track armed alone and recording, REC goes on", eng_arm_mask_get() == (uint64_t)1 << drums
              && seq_rec && !(E.trk_rec >> E.node[pat].trk & 1u) && (E.trk_rec >> E.node[drums].trk & 1u));
        tap(BTN_PLAY);
        eng_arm_mask(0);
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
        check("the SEQ bar shows the pattern (P01)", bar_shows("STEPS 1 ARM P01", C_ACC));
        told = host_pattern_told;
        enc(6, 1);
        eng_render(l, r, 128);
        later(1100);
        check("PRESET on the SEQ page: pattern 2, at once while stopped, the editor told", eng_pattern() == 1
              && eng_pattern_playing((uint32_t)mod) == 1 && host_pattern_told == told + 1u);
        check("  the bar: P02; the page: its own length (5 steps)", bar_shows("STEPS 1 ARM P02", C_ACC) && seq_len(mod) == 5);
        eng_transport(1);
        for (i = 0; i < 4u; i++)
            eng_render(l, r, 128);
        enc(6, 1);
        later(1100);
        check("running: pattern 3 waits for the end of the track's pass", eng_pattern() == 2 && eng_pattern_playing((uint32_t)mod) == 1
              && eng_pattern_queued((uint32_t)mod) == 2);
        check("  the bar: P02>P03", bar_shows("STEPS 1 ARM P02>P03", C_ACC));
        for (i = 0; i < 800u && eng_pattern_playing((uint32_t)mod) != 2; i++)
            eng_render(l, r, 128);
        loop();
        check("  at the end of the pass: P03 (its own length, 12 steps)", eng_pattern_playing((uint32_t)mod) == 2
              && bar_shows("STEPS 1 ARM P03", C_ACC) && seq_len(mod) == 12);
        eng_transport(0);
        eng_render(l, r, 128);
        tap(BTN_SEL);
        check("SEL tapped on the SEQ page: the SONG page, song 1, empty (END)", page == PAGE_SONG && song_sel == 0 && song_len() == 0
              && on_screen("END"));
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
        snap_to(getenv("PANEL_SNAP_SONG"));
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
        check("TEMPO: an older settings record reads as GLOBAL, the tempo not known yet", gt_patch == 0u && gt_bpm == 0u);
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
        check("MIDI clock in: PLAY held + PRESET leaves the global tempo (D-452)", eng_tempo_global_get() == 126u && !strcmp(msg_text, "TEMPO: MIDI CLOCK"));
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
        check("the settings record round trip: GLOBAL at 126", gt_patch == 0u && gt_bpm == 126u && rec[7] == GT_MARK);
        later(1600);
        page = PAGE_MENU;
        menu_tab = MT_PANEL;
        ui_dirty = 2;
        loop();
        check("the menu's PANEL tab: TEMPO on K4, GLOBAL", pages_now()->nrows == 4u && pages_now()->par[3] == MR_TEMPO && on_screen("TEMPO") && on_screen("GLOBAL"));
        told = host_tempo_told;
        enc(5, 1);                                          /* K4: PATCH */
        check("K4: PATCH, the editor told", gt_patch == 1u && on_screen("PATCH") && host_tempo_told == told + 1u && gt_due);
        main_m = eng_find(T_FM1);
        check("PATCH: the running patch plays its own tempo again (124)", ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) == 124 && !eng_tempo_row((uint32_t)main_m, FM1_P_TEMPO));
        (void)load_at(other);
        main_m = eng_find(T_FM1);
        check("  another patch plays its own", ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) != 126 && eng_tempo_global_get() == 0u);
        gt_pack(rec);
        check("  the record keeps PATCH and the global tempo", rec[7] == (GT_MARK | 2u) && rec[5] == 126u);
        gt_bpm = 300;
        gt_pack(rec);
        gt_bpm = 0;
        gt_unpack(rec, 16);
        check("  a tempo past 255 round trips (byte 7 bit 0)", gt_patch == 1u && gt_bpm == 300u);
        enc(5, -1);                                         /* K4: GLOBAL again */
        check("K4 back: GLOBAL at 300", gt_patch == 0u && eng_tempo_global_get() == 300u
              && ((eng_get_param((uint32_t)main_m, FM1_P_TEMPO) + 32768) >> 16) == 300);
        gt_patch = 1;                                       /* (as the tests before: each patch its own) */
        gt_apply();
        page_show(0);
    }
    nudge_suite();
    printf("%s\n", failed ? "panel test FAILED" : "panel test passed");
    return failed != 0;
}
