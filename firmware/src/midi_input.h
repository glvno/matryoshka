/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Modular-1 (morgulbrut) and Matryoshka (glvno). */
/* USB and TRS events from midi_queue.h, dispatched on the main thread. */
static uint32_t midi_clk_ms;                    /* fm1_ms of the last MIDI clock tick (MIDI clock drives the clock while they come) */
static uint8_t midi_clk_seen;

/* Keep the input order: page controls and program changes may draw or rebuild the engine, so they and the events
 * behind them wait for the main loop. Notes, clock, bend, aftertouch, modulation and all-notes-off never draw.
 * The busy guard also covers a draw started by a normal drain (for example a MIDI page knob ending a title toast). */
static uint8_t midi_draining;
static void midi_drain_mode(int quick)
{
    uint32_t end = mi_w;
    if (midi_draining)
        return;
    midi_draining = 1;
    while (mi_r != end) {
        uint32_t pkt = midi_in_q[mi_r % MQ], st = (pkt >> 8) & 0xF0u, n = (pkt >> 16) & 0x7Fu, v = pkt >> 24;
        uint32_t chn = ((pkt >> 8) & 15u) + 1u;
        if (quick && (!cfg.ch || cfg.ch == chn) &&
            (st == 0xC0u || (st == 0xB0u && ((n >= 16u && n <= 19u) ||
                                             (n >= 80u && n < 80u + ENG_PANEL_BUTTONS)))))
            break;
        RING_PUBLISH();
        mi_r++;
        if (st == 0xF0u) {                      /* realtime (MENU > CLOCK IN): MIDI clock drives the clock, Start / Continue / Stop the transport */
            uint32_t rt = (pkt >> 8) & 0xFFu;
            if (!cfg.clock_in) {
            } else if (rt == 0xF8u) {
                if (!midi_clk_seen)
                    eng_clock_external(1);
                midi_clk_seen = 1;
                midi_clk_ms = fm1_ms;
                eng_clock_tick();
            } else if (rt == 0xFAu || rt == 0xFBu || rt == 0xFCu) {
                eng_transport(rt != 0xFCu);
                leds_play();
                if (!ui_dirty)
                    ui_dirty = 1;
            }
        } else if (st == 0x90u || st == 0x80u) {  /* notes on every channel: the engine judges them (a Voice allocator may take its own channel) */
            eng_midi_channel(cfg.ch);
            if (st == 0x90u && v)
                eng_note_on(n, (int32_t)(v * 65536u / 127u), chn);
            else
                eng_note_off(n, chn);
        } else if (!cfg.ch || cfg.ch == chn) {  /* other channel messages on the MIDI channel (MENU > MIDI CHANNEL; 0 = all) */
            if (st == 0xB0u && n == 123u) {
                eng_all_notes_off();
            } else if (st == 0xB0u && n == 1u) {        /* mod wheel: the Main module's mod output */
                eng_ctl(ENG_CTL_MOD, (int32_t)(v * 65536u / 127u));
            } else if (st == 0xB0u && (n == 2u || n == 64u || n == 65u)) { /* Main's breath, sustain and foot outputs */
                eng_ctl(n == 2u ? ENG_CTL_BREATH : n == 64u ? ENG_CTL_SUSTAIN : ENG_CTL_FOOT,
                        (int32_t)(v * 65536u / 127u));
            } else if (st == 0xB0u && n >= 16u && n <= 19u) {   /* CC 16..19: K1..K4, the rows of the device page in focus */
                uint32_t mod, par;
                int32_t val, r = pages_set_unit(n - 16u, (int32_t)(v * 65536u / 127u), &mod, &par, &val);
                if (r >= 0) {
                    if (r == 1) {
                        if (poly_row_set(mod, par & 0x7Fu, val))
                            continue;
                    } else {
                        eng_set_param(mod, par, val);
                        m1_patch_param(mod, par, val);
                        pages_also(n - 16u, val);       /* (the parameters the row also sets, #357) */
                    }
                    m1_param_now(mod, par, r == 1 ? val << 16 : val);
                    if (!ui_dirty)
                        ui_dirty = 1;
                }
            } else if (st == 0xB0u && n == 22u) {      /* CC 22: the Main module's MORPH */
                int m = eng_find(T_FM1);
                if (m >= 0) {
                    eng_set_param((uint32_t)m, FM1_P_MORPH, (int32_t)(v * 65536u / 127u));
                    m1_patch_param((uint32_t)m, FM1_P_MORPH, (int32_t)(v * 65536u / 127u));
                }
            } else if (st == 0xB0u && n >= 80u && n < 80u + ENG_PANEL_BUTTONS) {   /* CC 80..86: the patch buttons pressed (64 and up) / let go */
                panel_button_set(n - 80u, v >= 64u);
            } else if (st == 0xE0u) {                   /* pitch bend: +-2 semitones on the pitch, and the bend output */
                eng_ctl(ENG_CTL_BEND, ((int32_t)(v << 7 | n) - 8192) << 3);
            } else if (st == 0xD0u) {                   /* channel aftertouch: the at output */
                eng_ctl(ENG_CTL_AT, (int32_t)(n * 65536u / 127u));
            } else if (st == 0xC0u && cfg.prog_chg && slot_used(n) && !editor_live()) {   /* program change n: bank slot n (an empty one, or the editor's Live: nothing) */
                pages_patch_ask();                     /* its name in the title toast, as PRESET (#170, #298) */
                preset_load(n);
            }
        }
    }
    midi_in_overflow = 0;
    if (midi_clk_seen && fm1_ms - midi_clk_ms > 500u) {   /* half a second without MIDI clock: the Main module's tempo again */
        midi_clk_seen = 0;
        eng_clock_external(0);
    }
    midi_draining = 0;
}

static void midi_drain(void) { midi_drain_mode(0); }
/* Installed after boot. Also serves direct draws (octave messages, menus, headers), outside panel_draw. */
static void midi_yield(void)
{
    if (eng_run)
        midi_drain_mode(1);
}
