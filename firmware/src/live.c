/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The editor's Live (proto.c LIVE, sent every 2 s while it is on): the FM-1 plays the editor's patch, so PRESET and program
 * change do not load a slot under it (the two would edit different patches, #185); it lapses 5 s after the last LIVE, so a
 * closed tab or a pulled cable frees them. Included by main.c; firmware/test/panel_test.c drives it on the host (#200). */
#define LIVE_HOLD_MS 5000u
static uint32_t live_until;
static uint8_t live_seen, live_paused;
static uint8_t live_mout_told = 0xFFu;                  /* MENU > MIDI OUT as the editor last heard it (INFO), 0xFF not yet */
/* paused: the editor's patch is a sandbox patch (over the FM-1's budget), so it is not here: sandbox mode (sandbox_ui.c)
 * mutes the FM-1 and shows the editor's page while it lasts. PRESET waits all the same (the editor's Live is on). A MIDI
 * OUT setting changed since the editor last heard it goes out as INFO (the editor says how to turn it on) */
static void m1_live(uint32_t paused)
{
    live_until = fm1_ms + LIVE_HOLD_MS;
    live_seen = 1;
    live_paused = paused != 0u;
    sandbox_live(live_paused, live_until);
    if (cfg.midi_out != live_mout_told) {
        live_mout_told = cfg.midi_out;
        m1_info();
    }
}
static int editor_live(void)
{
    if (live_seen && (int32_t)(live_until - fm1_ms) <= 0) {
        live_seen = 0;
        live_mout_told = 0xFFu;
    }
    return live_seen;
}
/* PRESET under the editor's Live: 1 = it waits (and the FM-1 says why), 0 = it steps */
static int live_holds_preset(void)
{
    if (!editor_live())
        return 0;
    ui_msg(live_paused ? "SANDBOX: NO PRESET" : "EDITOR LIVE: NO PRESET", 1500);
    return 1;
}
