/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The FM-1's UI as WebAssembly, for the editor's FM-1 tab (#109, #110): the real panel core (panel.c) and screens (ui.c,
 * pages_ui.c, menu.c, seq_ui.c) on the engine, over the host stand-ins of firmware/test/host_ui.h. No libc, no HAL, no
 * flash: what the core asks of the outside goes to the page (the imports below); the page puts a patch binary in
 * (fm1w_patch, fm1w_load), drives the panel (fm1w_encoder, fm1w_button, fm1w_keys) and the clock (fm1w_tick), and
 * reads the 240 x 240 RGB565 framebuffer (fm1w_fb) when fm1w_take_dirty says it changed.
 * The engine runs on the tick (silent blocks) so the transport, the effective values (live ticks) and the SEQ playhead
 * move; its audio is not used (the browser engine plays).
 * Built by web/scripts/fm1-wasm.mjs (npm run fm1-wasm) into web/public/fm1-ui.wasm. */
#include <stdint.h>
#include "../src/libc.c"

#define WASM_IMPORT(name) __attribute__((import_module("fm1"), import_name(name)))
#define WASM_EXPORT(name) __attribute__((export_name(name)))

/* the page: the focus and a parameter moved here (the editor follows, as with the device link's FOCUS_NOW / PARAM_NOW;
 * a poly row's parameter index has bit 7 set, as there), PRESET turned, SAVE pressed, a MIDI message the panel sent,
 * the transport started / stopped (PLAY) */
WASM_IMPORT("focus") void js_focus(uint32_t dev, uint32_t page);
WASM_IMPORT("param") void js_param(uint32_t mod, uint32_t par, int32_t v);
WASM_IMPORT("preset") void js_preset(int32_t d);
WASM_IMPORT("save") void js_save(void);
WASM_IMPORT("midi") void js_midi(uint32_t status, uint32_t d1, uint32_t d2);
WASM_IMPORT("transport") void js_transport(uint32_t run);
/* the SEQ page edited a track (its notes as they are now: n words at `at` in memory, track.ts noteWord, of the pattern it
 * plays, 0-based), muted a track: module = its index in the binary */
WASM_IMPORT("track") void js_track(uint32_t mod, const uint32_t *at, uint32_t n, uint32_t pat);
/* PRESET on the SEQ page / the SONG page chose the patch's pattern (0-based) or song (0 none); the SONG page edited song s
 * (n entries at `at`: pattern, shift as i8, two bytes each) (#375) */
WASM_IMPORT("pattern") void js_pattern(uint32_t pat, uint32_t song);
WASM_IMPORT("song") void js_song(uint32_t s, const uint8_t *at, uint32_t n);
WASM_IMPORT("mute") void js_mute(uint32_t mod, uint32_t on);
/* the FM-1 armed or disarmed (#139, #191: REC held + a black key, REC on an environment row): the armed modules as a mask
 * (lo, hi: modules 0..31, 32..63); the page arms the same devices */
WASM_IMPORT("arms") void js_arms(uint32_t lo, uint32_t hi);
int eng_steps_notes(uint32_t module, const uint32_t **w);   /* (engine.c, included by host_ui.h) */
int eng_pattern_playing(uint32_t module);
int eng_pattern(void);
int eng_song(void);
int eng_song_len(uint32_t s);
int eng_song_get(uint32_t s, uint32_t k);
static void m1_track_now(uint32_t mod)
{
    const uint32_t *w;
    int n = eng_steps_notes(mod, &w);
    if (n >= 0)
        js_track(mod, w, (uint32_t)n, (uint32_t)eng_pattern_playing(mod));
}
static void m1_pattern_now(void) { js_pattern((uint32_t)eng_pattern(), (uint32_t)eng_song()); }
static void m1_song_now(uint32_t s)
{
    static uint8_t e[2u * 64u];
    uint32_t n = (uint32_t)eng_song_len(s), k;
    for (k = 0; k < n && k < 64u; k++) {
        int x = eng_song_get(s, k);
        e[2u * k] = (uint8_t)x;
        e[2u * k + 1u] = (uint8_t)(x >> 8);
    }
    js_song(s, e, n);
}
static void m1_mute_now(uint32_t mod, int on) { js_mute(mod, (uint32_t)on); }
static void m1_arms_now(uint32_t lo, uint32_t hi) { js_arms(lo, hi); }
#define HOST_STEP_HOOKS
#define HOST_LED_HOOKS

#include "../test/host_ui.h"

/* what panel.c asks of proto.c and audio.c */
static volatile uint32_t eng_shed_count;
static void m1_focus_now(uint32_t d, uint32_t g) { js_focus(d, g); }
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v) { js_param(mod, par, v); }
/* the running patch's copy of a parameter: on the device proto.c's; here only the tempo (PLAY held + PRESET) goes out, a
 * knob row also says m1_param_now */
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v)
{
    if ((int)mod == eng_find(T_FM1) && par == FM1_P_TEMPO)
        js_param(mod, par, v);
}
static void m1_panel_on(uint32_t mask) { (void)mask; }
static void m1_patch_bypass(uint32_t mod, int on) { (void)mod; (void)on; }   /* (the page hears of a Toggle through its button) */
#include "../src/panel.c"

/* the hooks: the LEDs as main.c lights them on the device, into the host's LED arrays (host_ui.h), which the page
 * reads as bits (fm1w_led); the rest goes to the page. Lighting after X0X (charlesvestal/fm1-x0x, GPL-3.0-only):
 * its browser emulator shows the panel's lights from such masks. */
static int play_was;                            /* the transport as the page last heard of it */
static void leds_play(void)
{
    int run = eng_transport_running();
    fm1_led_key(BTN_PLAY, !run);                /* stopped: PLAY's red LED; running: the green one breathes (main.c) */
    host_led_set(fm1_led_breath, BTN_PLAY, run);
    if (run != play_was) {                      /* PLAY: the page's transport follows */
        play_was = run;
        js_transport((uint32_t)run);
    }
}
static void leds_panel(void)
{
    uint32_t b, mask = eng_buttons_lit();   /* (ARP on Arpeggiators: lit while they play, main.c) */
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        fm1_led_key(PANEL_BTN_ID[b], (int)(mask >> b & 1u) || (b == BTN_GLO_IDX && page == PAGE_GLO));   /* (GLO: lit on its page) */
}
/* OCT- / OCT+ breathe while the octave is shifted; HOME and the patch buttons the patch uses glow (MENU > LEDS) */
static void leds_octave(void)
{
    host_led_set(fm1_led_breath, BTN_OCT_DOWN, octave < 0);
    host_led_set(fm1_led_breath, BTN_OCT_UP, octave > 0);
    fb_dirty |= 2;
}
static void leds_avail(void)
{
    int on = cfg.leds != 0;
    uint32_t b, used = panel_used();
    host_led_set(fm1_led_dim, BTN_HOME, on);
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        host_led_set(fm1_led_dim, PANEL_BTN_ID[b], on && (used >> b & 1u));
    leds_panel();
    fb_dirty |= 2;
}

static void midi_send(uint32_t status, uint32_t d1, uint32_t d2)
{
    if (cfg.midi_out)
        js_midi(status | (cfg.ch ? cfg.ch - 1u : 0u), d1 & 127u, d2 & 127u);
}
static void midi_send_rt(uint32_t b)
{
    if (cfg.midi_out)
        js_midi(b & 0xFFu, 0u, 0u);
}
static void preset_step(int32_t d) { js_preset(d); }
static void save_state(void) { js_save(); }
/* a poly group's setting from a device page: into the group record of the running patch, as main.c does on the device
 * (the page hears of it through m1_param_now and sends the edited patch again) */
#include "../src/poly_edit.h"
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v)
{
    if (poly_patch_set(pv_bin, pv_len, mod, field, v, eng_load)) {
        ui_msg("NO ROOM", 1500);
        ui_dirty = 2;
        return -1;
    }
    return 0;
}

static char name_buf[24];                     /* the patch name the page writes (fm1w_name), NUL-terminated */
static uint32_t last_ms, frac;                  /* the engine's clock: ms of the last tick, samples owed (x1000) */

WASM_EXPORT("fm1w_patch") uint8_t *fm1w_patch(void) { return pv_bin; }
WASM_EXPORT("fm1w_patch_max") uint32_t fm1w_patch_max(void) { return sizeof pv_bin; }
WASM_EXPORT("fm1w_name") char *fm1w_name(void) { return name_buf; }
WASM_EXPORT("fm1w_fb") uint16_t *fm1w_fb(void) { return fb; }
/* the LEDs as bits: kind 0 lit, 1 dim glow, 2 the mid level (the SEQ playhead), 3 breathing; ids from `first` (0: the
 * buttons by matrix id, 14: the 27 keys) */
WASM_EXPORT("fm1w_led") uint32_t fm1w_led(uint32_t kind, uint32_t first)
{
    const uint8_t *a = kind == 1u ? fm1_led_dim : kind == 2u ? fm1_led_mid : kind == 3u ? fm1_led_breath : fm1_led;
    return host_led_mask(a, first);
}
WASM_EXPORT("fm1w_page") uint32_t fm1w_page(void) { return page; }
WASM_EXPORT("fm1w_take_dirty") uint32_t fm1w_take_dirty(void)
{
    uint32_t d = fb_dirty;
    fb_dirty = 0;
    return d;
}

/* the patch the page put at fm1w_patch (len bytes, its name at fm1w_name, the slot number shown: slot 0..63, else
 * none): into the engine and on the screen. Returns eng_load's result (0 = it runs). `fresh`: another patch (the
 * focus goes to its first device), else the same one edited (the focus stays) */
WASM_EXPORT("fm1w_load") int32_t fm1w_load(uint32_t len, uint32_t slot, uint32_t fresh)
{
    static int32_t l[128], r[128];
    int e;
    uint32_t dev = pg_cur_dev, pg = pg_cur_page;
    static uint8_t ps_ready;
    if (!ps_ready) {                                /* the preset store's RAM flash, once (#194: the tab's presets live until a reload) */
        host_ps_init();
        ps_ready = 1;
    }
    if (len > sizeof pv_bin)
        return -1;
    pv_len = len;
    e = eng_load(pv_bin, pv_len);
    if (e)
        return e;
    name_buf[sizeof name_buf - 1u] = 0;
    patch_label = name_buf;
    cur_preset = slot;
    pv_gen++;
    eng_render(l, r, 128);                      /* the modules' effective parameters */
    booting = 0;
    pages_ensure();
    if (!fresh)
        (void)pages_focus(dev, pg);
    toast_end();
    play_was = eng_transport_running();         /* (a load is no PLAY: the page sets the transport with fm1w_transport) */
    leds_play();
    leds_avail();
    leds_octave();
    ui_dirty = 2;
    panel_draw();
    return 0;
}

/* the clock: ms since the page started. Runs the engine for the time gone (at most a tenth of a second) and the loop's
 * bookkeeping and drawing (as fm1_main does each turn) */
WASM_EXPORT("fm1w_tick") void fm1w_tick(uint32_t ms)
{
    static int32_t l[128], r[128];
    uint32_t gone = ms - last_ms, blocks = 0;
    last_ms = ms;
    fm1_ms = ms;
    if (pv_len) {
        frac += (gone > 100u ? 100u : gone) * (uint32_t)ENG_SR;
        while (frac >= 128000u && blocks++ < 40u) {
            eng_render(l, r, 128);
            frac -= 128000u;
        }
    }
    panel_status();
    panel_edges(0, 0);
    seq_poll();
    panel_draw();
}

/* the panel: encoder n (0 SELECT, 1 ALGO, 2..5 K1..K4, 6 PRESET) turned by clicks; button id (matrix id) down / up; the
 * 27 keys now held (bit 0 = F3) */
WASM_EXPORT("fm1w_encoder") void fm1w_encoder(uint32_t n, int32_t clicks)
{
    int32_t st[7] = {0};
    if (n >= 7u)
        return;
    st[n] = clicks;
    panel_encoders(st);
    panel_draw();
}
WASM_EXPORT("fm1w_button") void fm1w_button(uint32_t id, uint32_t down)
{
    if (id >= 32u)
        return;
    if (down) {
        panel_held |= 1u << id;
        panel_edges(1u << id, 0);
    } else {
        panel_held &= ~(1u << id);
        panel_edges(0, 1u << id);
    }
    panel_draw();
}
WASM_EXPORT("fm1w_keys") void fm1w_keys(uint32_t bits)
{
    panel_keys(bits & 0x7FFFFFFu);
    panel_draw();
}

/* the editor: another device page in focus; a parameter set there (the bars follow) */
WASM_EXPORT("fm1w_focus") void fm1w_focus(uint32_t dev, uint32_t pg)
{
    if (pages_focus(dev, pg) && page == 0)
        ui_dirty = 2;
    panel_draw();
}
WASM_EXPORT("fm1w_param") void fm1w_param(uint32_t mod, uint32_t par, int32_t v)
{
    if ((int)mod < eng_nmodules()) {
        eng_set_param(mod, par, v);
        if (!ui_dirty)
            ui_dirty = 1;
    }
}
/* a track muted / unmuted on the FM-1 the page follows (its MUTE_NOW): the black key's light follows. SEQ held here
 * (the FM-1's SEQ, mirrored): the black key that muted was the FM-1's, so SEQ's release does not switch the page */
WASM_EXPORT("fm1w_mute") void fm1w_mute(uint32_t mod, uint32_t on)
{
    if ((int)mod >= eng_nmodules())
        return;
    eng_steps_mute(mod, (int)on);
    if (panel_held >> BTN_SEQ & 1u)
        seq_held_used = 1;
    ui_dirty = 2;
    panel_draw();
}
/* the page's transport (its Play button, Space) */
WASM_EXPORT("fm1w_transport") void fm1w_transport(uint32_t run)
{
    if ((int)run != eng_transport_running())
        eng_transport((int)run);
    leds_play();
    if (!ui_dirty)
        ui_dirty = 1;
    panel_draw();
}
/* the editor's armed devices (#191) as a mask of their modules (lo, hi): only they hear the keys; REC records into the
 * first armed track, the info line names it */
WASM_EXPORT("fm1w_arm_mask") void fm1w_arm_mask(uint32_t lo, uint32_t hi)
{
    eng_arm_mask((uint64_t)lo | (uint64_t)hi << 32);
    ui_dirty = 2;
    panel_draw();
}
WASM_EXPORT("fm1w_focus_dev") uint32_t fm1w_focus_dev(void) { return pg_cur_dev; }
WASM_EXPORT("fm1w_focus_page") uint32_t fm1w_focus_page(void) { return pg_cur_page; }
WASM_EXPORT("fm1w_octave") int32_t fm1w_octave(void) { return octave; }
