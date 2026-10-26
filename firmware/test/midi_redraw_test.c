/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Real MIDI queue, TRS parser, dispatcher, engine and panel. Input arrives BETWEEN LCD transfers; a note and its
 * release must reach the engine before the draw ends. No audio or screen timing is simulated by this host test. */
#define main panel_suite_main
#include "panel_test.c"
#undef main
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#include "../src/midi_queue.h"
#include "../src/midi_uart.c"
static uint8_t eng_run = 1;
static int slot_used(uint32_t s) { return s < 64u && (bank_mask >> s & 1u); }
static uint32_t preset_note_during;
static int preset_load(uint32_t n)
{
    int rc = load_at(n);
    ui_msg("PATCH", 20); /* like a real patch change, this can draw from inside the normal MIDI drain */
    preset_note_during = E.grp[0].nheld;
    return rc;
}
#include "../src/midi_input.h"

static uint32_t transfer, source, played, released, inside_xfers;
static void arrive(void)
{
    uint32_t before = lcd_xfers;
    transfer++;
    if (transfer == 2u || transfer == 8u) {
        uint32_t st = transfer == 2u ? 0x90u : 0x80u;
        if (source == 2u) {
            um_byte(st); um_byte(72); um_byte(0xF8); um_byte(100);
        } else
            midi_enqueue((st >> 4) | st << 8 | 72u << 16 | 100u << 24, 1);
    }
    if (transfer == 3u)
        played = E.grp[0].nheld != 0;
    if (transfer == 9u)
        released = E.grp[0].nheld == 0 && mi_r == mi_w;
    inside_xfers += lcd_xfers - before;
}
static void service_probe(void)
{
    uint32_t before = lcd_xfers;
    midi_yield();
    inside_xfers += lcd_xfers - before;
}
static void reset_probe(void)
{
    eng_all_notes_off();
    mi_w = mi_r = 0;
    transfer = played = released = inside_xfers = 0;
    lcd_line_clobbers = 0;
    lcd_service = service_probe;
    lcd_test_transfer = arrive;
}
static void result(const char *name)
{
    lcd_sync();
    check(name, transfer >= 9u && played && released && mi_r == mi_w);
    check("MIDI during a draw writes no LCD pixels or in-flight line buffer", !inside_xfers && !lcd_line_clobbers);
    lcd_test_transfer = 0;
}
int main(void)
{
    check("factory patch loads", load_at(0) == 0);
    cfg.ch = 0;
    for (source = 1; source <= 2; source++) {
        reset_probe();
        ui_dirty = 2;
        panel_draw();
        result(source == 1 ? "USB notes play and release DURING page redraw" : "TRS notes play and release DURING page redraw");
        reset_probe();
        panel_edges(1u << BTN_OCT_UP, 0);
        result(source == 1 ? "USB notes play and release DURING octave message" : "TRS notes play and release DURING octave message");
        panel_edges(0, 1u << BTN_OCT_UP);
    }
    eng_all_notes_off();
    lcd_service = service_probe;
    midi_enqueue(0x0Bu | 0xB0u << 8 | 1u << 16 | 127u << 24, 1);
    midi_enqueue(0x0Eu | 0xE0u << 8 | 127u << 24, 1);
    midi_enqueue(0x0Du | 0xD0u << 8 | 127u << 16, 1);
    midi_yield();
    check("modulation, pitch bend and aftertouch also pass during drawing",
          mi_r == mi_w && E.ctl[ENG_CTL_MOD] == 65536 && E.ctl[ENG_CTL_BEND] > 0 && E.ctl[ENG_CTL_AT] == 65536);
    cfg.clock_in = 1;
    um_byte(0xFA); um_byte(0xF8);
    midi_yield();
    check("TRS Start and Clock pass during drawing", eng_transport_running() && midi_clk_seen && mi_r == mi_w);
    um_byte(0xFC);
    midi_yield();
    check("TRS Stop passes during drawing", !eng_transport_running() && mi_r == mi_w);
    fm1_ms += 501;
    midi_yield();
    check("clock timeout still restores the internal clock", !midi_clk_seen);
    for (uint32_t kind = 0; kind < 3; kind++) {
        uint32_t st = kind == 2 ? 0xC0u : 0xB0u, n = kind == 0 ? 16u : kind == 1 ? 80u : 0u;
        eng_all_notes_off();
        cfg.prog_chg = 1;
        midi_enqueue((st >> 4) | st << 8 | n << 16, 1);
        midi_enqueue(9u | 0x90u << 8 | 72u << 16 | 100u << 24, 1);
        uint32_t r = mi_r, x = lcd_xfers;
        midi_yield();
        check("page knob, patch button or program change waits, with the following note in order",
              mi_r == r && lcd_xfers == x && E.grp[0].nheld == 0);
        midi_drain();
        check("normal drain applies the control, then plays the queued note", mi_r == mi_w && E.grp[0].nheld == 1);
    }
    check("a draw inside a program change cannot reenter MIDI dispatch", !preset_note_during && !midi_draining);
    midi_enqueue(9u | 0x90u << 8 | 72u << 16, 1);
    midi_yield();
    check("zero-velocity note-on releases during drawing", !E.grp[0].nheld);
    cfg.ch = 2;
    midi_enqueue(0x0Bu | 0xB0u << 8 | 16u << 16, 1); /* ignored channel-1 control must not hold up channel 2 */
    midi_enqueue(9u | 0x91u << 8 | 72u << 16 | 100u << 24, 1);
    midi_yield();
    check("an ignored channel's page control does not block a note", mi_r == mi_w && E.grp[0].nheld == 1);
    midi_enqueue(0x0Bu | 0xB1u << 8 | 123u << 16, 1);
    midi_yield();
    check("all-notes-off passes during drawing", mi_r == mi_w && !E.grp[0].nheld);
    eng_run = 0;
    midi_enqueue(9u | 0x91u << 8 | 72u << 16 | 100u << 24, 1);
    midi_yield();
    check("no dispatch while the engine is stopped for loading", mi_r != mi_w && !E.grp[0].nheld);
    eng_run = 1;
    midi_yield();
    check("queued note plays once the engine is running", mi_r == mi_w && E.grp[0].nheld == 1);
    return failed ? 1 : 0;
}
