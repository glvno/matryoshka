/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The editor's Live (proto.c LIVE, sent every 2 s while it is on): the FM-1 plays the editor's patch, so PRESET and program
 * change do not load a slot under it (the two would edit different patches, #185); it lapses 5 s after the last LIVE, so a
 * closed tab or a pulled cable frees them. Included by main.c; firmware/test/panel_test.c drives it on the host (#200). */
#define LIVE_HOLD_MS 5000u
static uint32_t live_until;
static uint8_t live_seen, live_paused;
/* paused (#200): the editor's patch is over the FM-1's budget, so it is not here; PRESET waits all the same (the editor's
 * Live is on) and the FM-1 says why */
static void m1_live(uint32_t paused)
{
    if (paused && (!live_paused || !live_seen))
        ui_msg("EDITOR PATCH TOO BIG", 2500);
    live_until = fm1_ms + LIVE_HOLD_MS;
    live_seen = 1;
    live_paused = paused != 0u;
}
static int editor_live(void)
{
    if (live_seen && (int32_t)(live_until - fm1_ms) <= 0)
        live_seen = 0;
    return live_seen;
}
/* PRESET under the editor's Live: 1 = it waits (and the FM-1 says why), 0 = it steps */
static int live_holds_preset(void)
{
    if (!editor_live())
        return 0;
    ui_msg(live_paused ? "EDITOR PATCH TOO BIG" : "EDITOR LIVE: NO PRESET", 1500);
    return 1;
}
