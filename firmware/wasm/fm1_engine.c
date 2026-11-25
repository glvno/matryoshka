/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The FM-1's fixed-point engine alone as WebAssembly, for the editor's FM-1 engine switch (#941): engine.c as the FM-1
 * builds it, no panel, no screen, no libc. The page (web/src/fm1-engine.ts, in the AudioWorklet) puts the binary the
 * FM-1 would get (encodePatch of the device form) at fm1e_bin and loads it (fm1e_load), sends what the editor does
 * (fm1e_param, fm1e_note, fm1e_transport, ...: what the device link sends, by module index in the binary) and renders
 * 128-frame blocks at ENG_SR (fm1e_render), Q16 in fm1e_l / fm1e_r, with the count-in's click as audio.c mixes it.
 * Built by web/scripts/fm1-wasm.mjs (npm run fm1-wasm) into web/public/fm1-engine.wasm. */
#include <stdint.h>
#include "../src/libc.c"
#include "../src/engine.c"

#define WASM_EXPORT(name) __attribute__((export_name(name)))

static uint8_t bin[16384];                     /* the patch the page writes: as the link sends it with no pattern store, so
                                                * a kit's linked patterns are in it (the FM-1 keeps those in its store) */
static uint32_t words[2u * 64u * 4u];          /* a track's note words the page writes (fm1e_track) */
static int32_t out_l[ENG_BLOCK], out_r[ENG_BLOCK];
static uint32_t buttons;                       /* the patch buttons held or on (eng_buttons) */
static uint8_t loaded;

WASM_EXPORT("fm1e_bin") uint8_t *fm1e_bin(void) { return bin; }
WASM_EXPORT("fm1e_bin_max") uint32_t fm1e_bin_max(void) { return sizeof bin; }
WASM_EXPORT("fm1e_words") uint32_t *fm1e_words(void) { return words; }
WASM_EXPORT("fm1e_words_max") uint32_t fm1e_words_max(void) { return sizeof words / sizeof words[0]; }
WASM_EXPORT("fm1e_l") int32_t *fm1e_l(void) { return out_l; }
WASM_EXPORT("fm1e_r") int32_t *fm1e_r(void) { return out_r; }
WASM_EXPORT("fm1e_rate") uint32_t fm1e_rate(void) { return ENG_SR; }

/* the binary at fm1e_bin (len bytes) into the engine: 0 it plays, else eng_load's error (silent until the next load).
 * The transport, the tempo and the clock are the engine's own and stay, as on the FM-1 when the editor sends a patch. The
 * patch buttons are the patch's, as eng_load sets them (the switched-on ones it was saved with, its Toggles' targets
 * bypassed or not): the last patch's never act on it (#1041) */
WASM_EXPORT("fm1e_load") int32_t fm1e_load(uint32_t len)
{
    int e;
    if (len > sizeof bin)
        return -1;
    e = eng_load(bin, len);
    loaded = e == 0;
    if (loaded)
        buttons = eng_buttons_get();
    return e;
}

/* one block of n <= ENG_BLOCK frames into fm1e_l / fm1e_r (silence without a patch) */
WASM_EXPORT("fm1e_render") void fm1e_render(uint32_t n)
{
    uint32_t i;
    if (n > ENG_BLOCK)
        n = ENG_BLOCK;
    if (!loaded) {
        for (i = 0; i < n; i++)
            out_l[i] = out_r[i] = 0;
        return;
    }
    eng_render(out_l, out_r, n);
    (void)eng_click_mix(out_l, out_r, n);       /* (the analog output's click, audio.c) */
}

/* a parameter as the device link's PARAM sets it (Q16; par 0xFF: the bypass, as fm1_ui.c's fm1w_param) */
WASM_EXPORT("fm1e_param") void fm1e_param(uint32_t mod, uint32_t par, int32_t v)
{
    if (!loaded || mod >= (uint32_t)eng_nmodules())
        return;
    if (par == 0xFFu)
        eng_set_bypass(mod, v != 0);
    else
        eng_set_param(mod, par, v);
}
WASM_EXPORT("fm1e_att") void fm1e_att(uint32_t mod, uint32_t input, int32_t v)
{
    if (loaded && mod < (uint32_t)eng_nmodules())
        eng_set_att(mod, input, v);
}

/* a key (vel Q16; 0 or on = 0: let go) on MIDI channel ch (0: the keyboard's); root: one the Harmonizers take as a root
 * whatever it is (the FM-1's keys: engine.ts noteOn root, host_test.c "kon") */
WASM_EXPORT("fm1e_note") void fm1e_note(uint32_t note, int32_t vel, uint32_t on, uint32_t ch, uint32_t root)
{
    if (root)
        eng_harm_zone(0);
    if (on && vel > 0)
        eng_note_on(note & 127u, vel, ch);
    else
        eng_note_off(note & 127u, ch);
    if (root)
        eng_harm_zone(1);
}
WASM_EXPORT("fm1e_panic") void fm1e_panic(void) { eng_all_notes_off(); }
WASM_EXPORT("fm1e_ctl") void fm1e_ctl(uint32_t which, int32_t q16)
{
    if (which < ENG_NCTL)
        eng_ctl(which, q16);
}
/* MIDI CC 22: Main's MORPH, as midi_input.h */
WASM_EXPORT("fm1e_morph") void fm1e_morph(int32_t q16)
{
    int m = loaded ? eng_find(T_FM1) : -1;
    if (m >= 0)
        eng_set_param((uint32_t)m, FM1_P_MORPH, q16);
}
WASM_EXPORT("fm1e_button") void fm1e_button(uint32_t b, uint32_t on)
{
    if (b >= ENG_PANEL_BUTTONS)
        return;
    buttons = on ? buttons | 1u << b : buttons & ~(1u << b);
    eng_buttons(buttons);
}
WASM_EXPORT("fm1e_chord") void fm1e_chord(uint32_t b, uint32_t down, int32_t track)
{
    if (track >= 0)
        eng_steps_chord_button((uint32_t)track, b, (int)down);
    else
        eng_chord_button(b, (int)down);
}

/* the transport and the clock */
WASM_EXPORT("fm1e_transport") void fm1e_transport(uint32_t on) { eng_transport((int)on); }
WASM_EXPORT("fm1e_transport_at") void fm1e_transport_at(uint32_t ticks, uint32_t wait) { eng_transport_at(ticks, (int)wait); }   /* MIDI Start, Continue after a Song Position (#870, #596) */
WASM_EXPORT("fm1e_running") uint32_t fm1e_running(void) { return (uint32_t)eng_transport_running(); }
WASM_EXPORT("fm1e_once") void fm1e_once(void) { eng_play_once(); }
WASM_EXPORT("fm1e_count_in") void fm1e_count_in(uint32_t bars) { eng_count_in(eng_ticks(), bars); }
WASM_EXPORT("fm1e_tempo") void fm1e_tempo(uint32_t bpm) { eng_tempo_global(bpm); }   /* 0: each patch its own */
WASM_EXPORT("fm1e_meter") void fm1e_meter(uint32_t m) { eng_meter(m); }   /* the global time signature (#1011) */
WASM_EXPORT("fm1e_clock_tick") void fm1e_clock_tick(void) { eng_clock_tick(); }
WASM_EXPORT("fm1e_clock_external") void fm1e_clock_external(uint32_t on) { eng_clock_external((int)on); }

/* the sequencer: the patch's pattern / song, FILL, a track's mute, its notes (n words at fm1e_words, of pattern pat;
 * pat < 0: the one it plays), a note into its keys, the armed modules (ENG_MSET_WORDS words) */
WASM_EXPORT("fm1e_pattern") void fm1e_pattern(uint32_t p) { if (loaded) eng_pattern_set(p); }
WASM_EXPORT("fm1e_song") void fm1e_song(uint32_t s) { if (loaded) eng_song_set(s); }
WASM_EXPORT("fm1e_fill") void fm1e_fill(uint32_t on) { eng_fill((int)on); }
WASM_EXPORT("fm1e_mute") void fm1e_mute(uint32_t mod, uint32_t on)
{
    if (loaded && mod < (uint32_t)eng_nmodules())
        eng_steps_mute(mod, (int)on);
}
WASM_EXPORT("fm1e_track") int32_t fm1e_track(uint32_t mod, int32_t pat, uint32_t n)
{
    int p;
    if (!loaded || mod >= (uint32_t)eng_nmodules() || n > sizeof words / sizeof words[0])
        return -1;
    p = pat >= 0 ? pat : eng_pattern_playing(mod);
    return p < 0 ? -1 : eng_pattern_set_notes(mod, (uint32_t)p, words, n);
}
WASM_EXPORT("fm1e_thru") void fm1e_thru(uint32_t mod, uint32_t note, uint32_t vel)
{
    if (loaded && mod < (uint32_t)eng_nmodules())
        eng_steps_thru(mod, note & 127u, vel & 127u);
}
WASM_EXPORT("fm1e_arm") void fm1e_arm(uint32_t w0, uint32_t w1, uint32_t w2, uint32_t w3, uint32_t w4, uint32_t w5, uint32_t w6, uint32_t w7)
{
    eng_mset_t s = {{w0, w1, w2, w3, w4, w5, w6, w7}};
    if (loaded)
        eng_arm_mask(s);
}
