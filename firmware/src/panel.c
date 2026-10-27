/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The panel core: what the FM-1's knobs, keys and buttons do, apart from the HAL. main.c's polls read the hardware and
 * hand it in (panel_held, panel_encoders, panel_keys, panel_edges), and its loop calls panel_status / panel_draw;
 * a host build (firmware/test/panel_test.c, the editor's emulator) drives the same functions with no hardware. What the
 * core asks of the outside are the hooks below (main.c on the device, stubs on a host): LEDs, the bank, SAVE, MIDI out,
 * a poly group's setting (the running patch's record). Needs ui.c, pages_ui.c, menu.c, seq_ui.c before it; panel_held
 * (the buttons held now, matrix ids as bits) is ui.c's. */

/* hooks */
static void leds_octave(void);
static void leds_play(void);
static void leds_panel(void);
static void leds_avail(void);
static void midi_send(uint32_t status, uint32_t d1, uint32_t d2);
static void midi_send_rt(uint32_t b);                   /* a one-byte real-time message (Start 0xFA, Stop 0xFC) */
static void preset_step(int32_t d);                     /* PRESET: the next / previous patch */
static void save_state(void);                           /* SAVE */
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v);

static uint8_t knob_touched, button_touched;  /* the knob (1..6) / patch button (1..7) last moved: the bar shows it */
#define BTN_PLAY 12u                  /* PLAY: the transport; held, PRESET sets the tempo */
#define BTN_GLO_IDX 5u                /* GLO among the patch buttons (PANEL_BTN_ID): the FM-1's own page, never switching */
#define BTN_SEL_IDX 1u                /* SEL (#197): fixed, one level deeper; its jack a Gate */
#define BTN_ENV_IDX 2u                /* ENV (#197): fixed, the environment; its jack a Gate */
#define FIXED_BTNS ((1u << BTN_GLO_IDX) | (1u << BTN_SEL_IDX) | (1u << BTN_ENV_IDX))
static uint8_t play_turned;                   /* PRESET turned the tempo while PLAY was held: its release does not start / stop */

static const uint8_t PANEL_BTN_ID[ENG_PANEL_BUTTONS] = {2, 3, 4, 5, 6, 7, 10};   /* (SEQ 11 and REC 13: the step page, seq_ui.c) */

/* The device's own buttons (matrix ids, M-VAVE's fm1_open order): OCT- 0, OCT+ 1: octave; SAVE 9: write the patch into its slot
 * (in the menu: and close it); HOME 8: tap = back (the trail), held = the menu; PLAY 12: the transport. The others are the
 * patch's (PANEL_BTN_ID). */
#define BTN_OCT_DOWN 0u
#define BTN_OCT_UP 1u
#define BTN_SAVE 9u
#define BTN_HOME 8u
#define BTN_SEL 3u                    /* SEL (SCL in Felucca's table): on a Steps track's page it opens the track's steps (#196) */
#define BTN_GLO 7u
/* the buttons that act on the FM-1 itself in sandbox mode (sandbox_ui.c); the others only go out as MIDI */
#define SB_OWN_BTNS ((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP) | (1u << BTN_HOME) | (1u << BTN_PLAY) | (1u << BTN_GLO))

/* MIDI out (#115, MENU > MIDI OUT; docs/ARCHITECTURE.md "MIDI out map"): every panel control as it is touched, whatever
 * it does here, so a host can mirror or replay the panel. Buttons: CC 127 on the press, 0 on the release (by matrix id
 * below); SELECT / ALGO / PRESET: relative CCs (1..63 up, 127..65 down, two's complement); MASTER: CC 7; PLAY also Start /
 * Stop when it starts / stops the transport; keys as notes; K1..K4 as CC 16..19 (their rows' positions). */
static const uint8_t BTN_CC[14] = {92, 93, 80, 81, 82, 83, 84, 85, 87, 88, 86, 89, 91, 90};
#define CC_SELECT 20u
#define CC_ALGO 21u
#define CC_PRESET 23u
#define CC_MASTER 7u
static const uint8_t ENC_CC[7] = {CC_SELECT, CC_ALGO, 0, 0, 0, 0, CC_PRESET};

/* clicks of an encoder as a relative CC value (two's complement, at most 63 a message) */
static uint32_t rel_cc(int32_t c) { return c > 0 ? (uint32_t)(c > 63 ? 63 : c) : 128u - (uint32_t)(c < -63 ? 63 : -c); }

/* the MASTER pot moved (0..1023, smoothed): CC 7 when its 7-bit value changes by more than the pot's jitter */
static void panel_master(uint32_t adc)
{
    static int32_t sent = -1;
    int32_t v = (int32_t)(adc > 1023u ? 1023u : adc);
    if (sent >= 0 && (v >> 3) == (sent >> 3))
        return;
    if (sent >= 0 && v - sent < 6 && sent - v < 6 && v >> 3 != 0 && v >> 3 != 127)
        return;
    sent = v;
    midi_send(0xB0u, CC_MASTER, (uint32_t)v >> 3);
}

/* a patch button pressed / let go (index into PANEL_BTN_ID): a switching one flips on the press, the others act while held;
 * a switch is kept in the patch (SAVE stores it). A Toggle (#116) bypasses its modules while on. The same for the panel
 * and CC 80..86 coming in. */
static void panel_button_set(uint32_t b, int down);
static void panel_button(uint32_t b, int down) { panel_button_set(b, down); }
static void page_button(uint32_t b, int down);
static void page_set(uint32_t p);
static void page_mask(void);
static void panel_button_set(uint32_t b, int down)
{
    const uint8_t *pn;
    if (eng_button_kind(b) == ENG_BTN_PAGE && !(FIXED_BTNS >> b & 1u)) {   /* a page list (#117): its own press / hold rules */
        page_button(b, down);
        return;
    }
    if (b == BTN_GLO_IDX && down)                  /* GLO (#118): Main's global page; again (or HOME) goes back. Its jack as a Gate */
        page_set(PAGE_GLO);
    pn = m1_panel();
    uint32_t tog = pn ? ((uint32_t)pn[0] | (uint32_t)pn[1] << 8) & ~FIXED_BTNS : 0u, mask = eng_buttons_get(), was = mask;
    if (tog >> b & 1u) {
        if (down)
            mask ^= 1u << b;
    } else {
        mask = down ? mask | 1u << b : mask & ~(1u << b);
    }
    if (mask == was)
        return;
    eng_buttons(mask);                              /* (a Toggle bypasses its modules, engine.c) */
    mask = eng_buttons_get();
    if (eng_button_kind(b) == ENG_BTN_TOGGLE) {     /* ... in the running binary too: SAVE keeps a switched one */
        const uint8_t *t;
        uint32_t k, n = eng_button_targets(b, &t);
        for (k = 0; k < n; k++)
            m1_patch_bypass(t[k], (int)(mask >> b & 1u));
    }
    if (tog >> b & 1u)
        m1_panel_on(mask & tog);
    leds_panel();
    if (down && !(FIXED_BTNS >> b & 1u)) {          /* (GLO, SEL, ENV say what they do themselves: no "SEL ON") */
        button_touched = (uint8_t)(b + 1u);
        if (!ui_dirty)
            ui_dirty = 1;
    }
}

/* The trail (#114): every screen change by a button (SEQ, REC, opening the menu; page buttons and GLO later) leaves a step
 * of where it came from; a HOME tap goes back one. ALGO / SELECT moving on the device pages are no steps. The oldest step
 * goes when the trail is full. */
#define TRAIL_MAX 8u
static struct { uint8_t page, dev, pg; int8_t lbtn; uint8_t lstep; } trail[TRAIL_MAX];   /* (lbtn: a page list on, -1 none) */
static uint8_t trail_n;

/* a step on the trail: where we are now (the oldest step goes when it is full) */
static void trail_push(void)
{
    if (trail_n == TRAIL_MAX) {
        uint32_t i;
        for (i = 1; i < TRAIL_MAX; i++)
            trail[i - 1u] = trail[i];
        trail_n--;
    }
    trail[trail_n].page = page;
    trail[trail_n].dev = (uint8_t)pg_cur_dev;
    trail[trail_n].pg = (uint8_t)pg_cur_page;
    trail[trail_n].lbtn = pg_list_btn;
    trail[trail_n].lstep = pg_list_step;
    trail_n++;
}

static void page_show(uint32_t p)
{
    page = (uint8_t)p;
    pg_strip_dirty = 1;
    if (page == PAGE_MENU)
        menu_open();
    if (page != PAGE_SEQ) {                         /* (leaving the SEQ page ends its recording, not a live take: seq_leave) */
        seq_leave();
        seq_leds_off();
    }
    if (dev_like() && !sb_on && !eng_overload && !load_err)
        msg_until = 0;                              /* (the device page and GLO's draw their header with the rest) */
    else
        header_draw();
    leds_play();
    leds_panel();                                   /* (GLO is lit while its page shows) */
    if (page == PAGE_ENV || page == PAGE_PRESETS) {   /* their rows are drawn whole, edge to edge: only the strips above
                                                     * and below them are cleared (the menu, SEQ and SONG pages clear their
                                                     * own ground when drawn whole) */
        lcd_fill(0, BAR_H, 240, ENV_Y0 - BAR_H, C_BG);
        lcd_fill(0, ENV_Y0 + ENV_ROWS * ENV_ROW_H, 240, 240u - ENV_Y0 - ENV_ROWS * ENV_ROW_H, C_BG);
    }
    view_draw(1);
}

/* HOME tapped: one step back along the trail (the device page in focus then, if it moved); nothing when the trail is empty */
static void screen_back(void)
{
    if (!trail_n)
        return;
    trail_n--;
    pg_list_btn = trail[trail_n].lbtn;
    pg_list_step = trail[trail_n].lstep;
    pg_list_peek = 0;
    pg_strip_dirty = 1;
    if (trail[trail_n].page == 0u && pages_focus(trail[trail_n].dev, trail[trail_n].pg))
        m1_focus_now(pg_cur_dev, pg_cur_page);
    page_show(trail[trail_n].page);
    page_mask();
}

/* a button opens screen p: a step on the trail; the same button again (p showing) goes back */
static void page_set(uint32_t p)
{
    if (page == p) {
        screen_back();
        return;
    }
    trail_push();
    page_show(p);
}

/* ---- Page buttons (#117): a press puts the next page of the button's list on K1..K4 (round the list; the first press
 * a step on the trail, so HOME goes back to where you were); held, its first page shows while it is down. While one of
 * its pages shows the button is engaged (lit, its jack high) and the top bar names it. ALGO steps the list, SELECT leaves it. */
#define PAGE_HOLD_MS 400u
static int8_t page_held = -1;                       /* the Page button down now, -1 none */
static uint32_t page_t0;                            /* fm1_ms of its press */
static int8_t peek_btn;                             /* what showed before a hold peeked: the list, its step, the focus */
static uint8_t peek_step, peek_dev, peek_pg;

/* the Page buttons' jacks: high while held or while their list shows (the other buttons' bits stay) */
static void page_mask(void)
{
    uint32_t b, mask = eng_buttons_get(), was = mask;
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        if (eng_button_kind(b) == ENG_BTN_PAGE) {
            int on = page_held == (int8_t)b || pg_list_btn == (int8_t)b;
            mask = on ? mask | 1u << b : mask & ~(1u << b);
        }
    if (mask != was) {
        eng_buttons(mask);
        leds_panel();
    }
}

/* the list's page in focus (the first while a hold peeks) */
static void list_focus(void)
{
    const uint8_t *l;
    uint32_t n = pg_list_btn >= 0 ? pages_list((uint32_t)pg_list_btn, &l) : 0u, k;
    if (!n)
        return;
    k = pg_list_peek ? 0u : pg_list_step % n;
    if (pages_focus(l[2u * k], l[2u * k + 1u]))
        m1_focus_now(pg_cur_dev, pg_cur_page);
    pg_strip_dirty = 1;
    ui_dirty = 2;
}

static void page_button(uint32_t b, int down)
{
    const uint8_t *l;
    uint32_t n = pages_list(b, &l);
    if (down) {
        page_held = (int8_t)b;
        page_t0 = fm1_ms;
        page_mask();
        return;
    }
    if (page_held != (int8_t)b)
        return;
    page_held = -1;
    if (pg_list_peek) {                             /* the hold ends: back to what showed before it */
        pg_list_peek = 0;
        pg_list_btn = peek_btn;
        pg_list_step = peek_step;
        if (pages_focus(peek_dev, peek_pg))
            m1_focus_now(pg_cur_dev, pg_cur_page);
        pg_strip_dirty = 1;
        ui_dirty = 2;
    } else if (n) {                                 /* a tap: the next page of the list, or into it */
        if (pg_list_btn == (int8_t)b && page == 0u) {
            pg_list_step = (uint8_t)((pg_list_step + 1u) % n);
        } else {
            trail_push();
            pg_list_btn = (int8_t)b;
            pg_list_step = 0;
            if (page != 0u)
                page_show(0);
        }
        list_focus();
    }
    page_mask();
}

/* a Page button held long enough: its first page shows until it is let go (from panel_edges, every pass) */
static void page_hold_poll(void)
{
    const uint8_t *l;
    if (page_held < 0 || pg_list_peek || fm1_ms - page_t0 < PAGE_HOLD_MS || page != 0u || !pages_list((uint32_t)page_held, &l))
        return;
    peek_btn = pg_list_btn;
    peek_step = pg_list_step;
    peek_dev = (uint8_t)pg_cur_dev;
    peek_pg = (uint8_t)pg_cur_page;
    pg_list_btn = page_held;
    pg_list_peek = 1;
    list_focus();
}

static void play_toggle(void)                       /* PLAY: the transport (the Main module's run output and clock) */
{
    eng_transport(!eng_transport_running());
    midi_send_rt(eng_transport_running() ? 0xFAu : 0xFCu);
    leds_play();
    ui_dirty = ui_dirty ? ui_dirty : 1;
}


/* the encoders turned: st[0..6] = SELECT, ALGO, K1..K4, PRESET (clicks since the last call; the array is used up) */
static void panel_encoders(int32_t *st)
{
    static uint32_t last_ms[6];
    uint32_t k;
    int panel = eng_find(T_FM1);
    for (k = 0; k < 7u; k++)                        /* MIDI out: the encoders as they turn, before anything uses them */
        if (ENC_CC[k] && st[k])
            midi_send(0xB0u, ENC_CC[k], rel_cc(st[k]));
    for (k = 0; k < 7u; k++)                        /* a turn while the track's clear asks: not cleared (#231) */
        if (st[k])
            seq_clear_cancel();
    if (page == PAGE_MENU) {                        /* the settings menu: ALGO tabs, SELECT rows, K1..K4 the value */
        menu_knobs(st);
        if (st[6])                                  /* (PRESET only ever steps the patches) */
            preset_step(st[6]);
        return;
    }
    if (st[6] && (panel_held >> BTN_PLAY & 1u)) {   /* PLAY held + PRESET: the tempo (the Main module's), 1 bpm a click */
        play_turned = 1;
        if (panel >= 0 && !eng_clock_is_external()) {
            char m[16], num[8];
            int32_t bpm = (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16;
            bpm = clampi(bpm + st[6] * (cfg.accel && fm1_ms - last_ms[0] < 80u ? 5 : 1), 20, 300);
            last_ms[0] = fm1_ms;
            eng_set_param((uint32_t)panel, FM1_P_TEMPO, bpm << 16);
            m1_patch_param((uint32_t)panel, FM1_P_TEMPO, bpm << 16);
            fmt_int(num, bpm);
            put(put(m, "TEMPO "), num)[0] = 0;
            ui_msg(m, 1000);
            if (!ui_dirty)
                ui_dirty = 1;
        } else if (panel >= 0) {
            ui_msg("TEMPO: MIDI CLOCK", 1000);
        }
        return;
    }
    if (page == PAGE_ENV && st[6]) {                /* PRESET on the environment: the row's presets (#198), not the patch */
        if (env_preset_step(st[6]))
            ui_dirty = ui_dirty ? ui_dirty : 1;   /* (the rows that changed: #229) */
        return;
    }
    if (page == PAGE_PRESETS && st[6]) {            /* PRESET on the preset list: the presets too (#194) */
        if (presets_turn(st[6]))
            ui_dirty = ui_dirty ? ui_dirty : 1;
        return;
    }
    if ((page == PAGE_SEQ || page == PAGE_SONG) && st[6]) {   /* PRESET on the SEQ / SONG page: the patch's pattern (#375,
                                                     * D-541), as on ENV and PRESETS it is the page's list */
        seq_pattern_step(st[6]);
        return;
    }
    if (st[6]) {                                    /* PRESET: the next patch, its name over the bars (#170) */
        if (!sb_on)
            pages_patch_ask();
        preset_step(st[6]);                         /* (in sandbox mode the editor's Live holds it: live.c) */
        return;
    }
    if (sb_on && page == 0u && sb_have) {           /* sandbox mode: SELECT / ALGO went out as MIDI (the editor's page follows),
                                                     * K1..K4 turn the editor's rows from the positions it sent (sandbox_ui.c) */
        for (k = 0; k < 4u; k++) {
            int32_t v = sandbox_knob(k, st[2u + k], cfg.accel && fm1_ms - last_ms[2u + k] < 80u);
            if (st[2u + k])
                last_ms[2u + k] = fm1_ms;
            if (v >= 0) {
                midi_send(0xB0u, 16u + k, (uint32_t)v);
                if (!ui_dirty)
                    ui_dirty = 1;
            }
        }
        return;
    }
    if (page == PAGE_SONG) {                        /* the SONG page (#375): its knobs, nothing else's */
        song_knobs(st);
        return;
    }
    if (page == PAGE_SEQ && seq_rec == 2u)          /* the keys record into the armed track: ALGO keeps it */
        st[1] = 0;
    if (page == PAGE_SEQ) {                         /* the SEQ page: ALGO picks the track; a step held: its chance, SELECT on a
                                                     * drum grid, K3 on the roll (the owner, 2026-10-24: there SELECT moves the row) */
        int roll = seq_module() >= 0 && seq_map() < 0;
        if (st[1] && eng_steps_count())
            seq_select((uint32_t)((seq_trk + (uint32_t)eng_steps_count() * 8u + (uint32_t)st[1]) % (uint32_t)eng_steps_count()));
        st[1] = 0;
        if (st[0] && seq_held >= 0 && !roll) {
            seq_chance(st[0]);
            st[0] = 0;
        }
        if (st[4] && seq_held >= 0 && roll) {
            seq_chance(st[4]);
            st[4] = 0;
        }
        if (st[0] && seq_module() >= 0) {           /* no step held: SELECT moves the row (REC on or off; the roll scrolls) */
            seq_row_step(st[0]);
            st[0] = 0;
        }
        if ((st[2] || st[3]) && seq_held >= 0) {   /* K1 / K2 with a step held: its note / velocity (not the Main knobs) */
            seq_value(st[2], st[3], cfg.accel && fm1_ms - last_ms[1] < 80u);
            last_ms[1] = fm1_ms;
            st[2] = st[3] = 0;
        }
    }
    if (page == PAGE_GLO && (st[0] || st[1]))       /* SELECT / ALGO on GLO's page: back to the device pages, then as there */
        screen_back();
    if (page == PAGE_PRESETS) {                     /* the preset list: SELECT / ALGO load the next / previous as they turn */
        if (presets_turn(st[0] + st[1]))
            ui_dirty = ui_dirty ? ui_dirty : 1;   /* (the old and the new row: #229) */
        return;
    }
    if (page == PAGE_ENV) {                         /* the environment: SELECT the row (its first page on K1..K4), ALGO its presets */
        if (st[0] && pages_select(st[0])) {
            m1_focus_now(pg_cur_dev, pg_cur_page);
            ui_dirty = ui_dirty ? ui_dirty : 1;   /* (the old and the new row: #229) */
        }
        if (st[1] && env_preset_step(st[1]))
            ui_dirty = ui_dirty ? ui_dirty : 1;
        st[0] = st[1] = 0;
    }
    if (page != 0 && page != PAGE_GLO && page != PAGE_ENV)
        return;
    if (st[0] && pg_list_btn >= 0 && !pg_list_peek) {   /* SELECT inside a page list: leaves it */
        pg_list_btn = -1;
        pg_strip_dirty = 1;
        page_mask();
    }
    if (st[1] && pg_list_btn >= 0 && !pg_list_peek) {   /* ALGO inside a page list: its steps */
        const uint8_t *l;
        uint32_t n = pages_list((uint32_t)pg_list_btn, &l);
        if (n) {
            pg_list_step = (uint8_t)(((int32_t)pg_list_step + st[1] % (int32_t)n + (int32_t)n) % (int32_t)n);
            list_focus();
        }
        st[1] = 0;
    }
    if (page == 0) {                                /* SELECT: the device, ALGO: its page (the editor follows); the header shows
                                                     * which, the page is drawn in passes (#298) */
        int dev = pages_select(st[0]), pg = pages_page(st[1]);
        if (dev | pg) {
            pages_moved();
            m1_focus_now(pg_cur_dev, pg_cur_page);
            if (!ui_dirty)
                ui_dirty = 1;
        }
    }
    for (k = 0; k < 4u; k++) {                      /* K1..K4: the rows of the page in focus, relative */
        uint32_t mod, par;
        int32_t v, c = st[2u + k], r;
        if (!c || (r = pages_turn(k, c, cfg.accel && fm1_ms - last_ms[2u + k] < 80u, &mod, &par, &v)) < 0)
            continue;
        last_ms[2u + k] = fm1_ms;
        if (r == 2) {                               /* GLO: an FM-1 setting (pages_turn set it): not the patch's, not the editor's */
            if (!ui_dirty)
                ui_dirty = 1;
            continue;
        }
        if (r == 1) {
            if (poly_row_set(mod, par & 0x7Fu, v))
                continue;                         /* rejected: keep the old value in the editor too */
        } else {
            eng_set_param(mod, par, v);
            m1_patch_param(mod, par, v);
            pages_also(k, v);                       /* (the parameters the row also sets, #357) */
        }
        m1_param_now(mod, par, r == 1 ? v << 16 : v);   /* the editor follows (Live) */
        if (page == PAGE_ENV)
            env_knob_msg(k);
        midi_send(0xB0u, 16u + k, pages_cc(k));
        if (!ui_dirty)
            ui_dirty = 1;
    }
    (void)panel;
}

static uint8_t key_note[27];                     /* the note each held key started, so a release (or an octave change in between) ends the right one */
static uint8_t key_eng[27];                      /* the note it played in the engine: key_note, a Drum map row's (eng_keys_drummap), */
#define KEY_SILENT 0xFFu                         /* or none (a white key on a Drum map) */
static uint32_t key_sounding;                    /* bit n: key n started a note (not a key pressed on the SEQ page) */
static uint8_t seq_held_used;                    /* SEQ is held and a black key muted a track: its release does not switch the page */
static uint8_t rec_held_used;                    /* REC is held and a black key armed a track: its release does not record */
/* the keys as the panel last took them (bit n: key n down) */
static uint32_t keys_now;
/* one key edge (key n pressed or let go), shifted by the octave, -> the engine, the SEQ page. quick: from inside a redraw
 * (panel_draw's yield, #230), where nothing may draw: a REC / SEQ held + black key (an arm, a mute: a message, a row
 * redrawn) is then not taken (0, nothing done) and waits for the loop's pass. All else here only changes state and asks
 * for a redraw (ui_dirty; a header_draw waits for the end of the redraw: ui_yielding). An edge that changes nothing is
 * taken. */
static int panel_key(uint32_t n, int down, int quick)
{
    uint32_t bit = 1u << n;
    if (n >= 27u || !(keys_now & bit) == !down)
        return 1;
    if (quick && down && !sb_on && seq_black(n) >= 0 && (panel_held & (1u << BTN_REC | 1u << BTN_SEQ)))
        return 0;
    keys_now ^= bit;
    if (down)                                       /* a key while the track's clear asks: not cleared (#231) */
        seq_clear_cancel();
    eng_midi_channel(cfg.ch);
    if (down && !sb_on && (panel_held >> BTN_REC & 1u) && seq_black(n) >= 0) {   /* REC held + a black key: arm (#139) */
        seq_arm_key(n);
        rec_held_used = 1;
        return 1;
    }
    if (down && !sb_on && (panel_held >> BTN_SEQ & 1u) && seq_black(n) >= 0) {   /* SEQ held + a black key: a mute */
        seq_mute_key(n);
        seq_held_used = 1;
        return 1;
    }
    if (!(key_sounding & bit) && ((page == PAGE_SEQ && !seq_kbd()) || !down)) {   /* the SEQ page: steps and tracks */
        if (page == PAGE_SEQ && !seq_kbd())
            seq_key(n, down);
        return 1;
    }
    if (down) {
        int32_t note = 53 + (int32_t)n + 12 * octave;
        /* into an armed track at the default velocity (ENV held on its keyboard: full), so a take records what a step
         * entered would be; else at full velocity as always */
        uint32_t vel = eng_armed() < 0 ? 127u : seq_kbd() && (panel_held >> BTN_ACC & 1u) ? ACCENT_VEL : STEP_VEL;
        int map = seq_kbd() || sb_on ? -1 : eng_keys_drummap(), b = seq_black(n);   /* (sandbox mode: the plain notes) */
        key_note[n] = (uint8_t)(note < 0 ? 0 : note > 127 ? 127 : note);
        /* the keys reach a Drum map (the owner, 2026-10-23): black keys 1..8 play its rows 1..8 at any octave, as on the
         * SEQ page, the white keys nothing, or their own note when the map repeats its rows (#184: the repeat picks the
         * row); MIDI out sends what plays: the row's note, the key's own, nothing for a silent key, so a recording played
         * back into a Drum map hits the same rows */
        key_eng[n] = map < 0 ? key_note[n] : b >= 0 && b < (int)ENG_DRUM_ROWS ? (uint8_t)eng_drummap_note((uint32_t)map, (uint32_t)b)
            : eng_drummap_repeat((uint32_t)map) ? key_note[n] : KEY_SILENT;
        key_sounding |= bit;
        if (key_eng[n] != KEY_SILENT)
            eng_note_on(key_eng[n], vel == 127u ? ENG_ONE : (int32_t)((vel << 16) / 127u), cfg.ch ? cfg.ch : 1u);   /* the panel plays on the device's channel */
        if (key_eng[n] != KEY_SILENT)
            midi_send(0x90u, key_eng[n], 100u);
        if (seq_kbd())
            seq_kbd_key(n, 1);
    } else {
        key_sounding &= ~bit;
        if (key_eng[n] != KEY_SILENT)
            eng_note_off(key_eng[n], cfg.ch ? cfg.ch : 1u);
        if (key_eng[n] != KEY_SILENT)
            midi_send(0x80u, key_eng[n], 0u);
        if (seq_kbd())
            seq_kbd_key(n, 0);
    }
    return 1;
}

/* the 27 keys now held (bit 0 = F3 = MIDI 53): each one that changed, from key 0 up */
static void panel_keys(uint32_t now)
{
    uint32_t n;
    for (n = 0; n < 27u; n++)
        if ((now ^ keys_now) >> n & 1u)
            (void)panel_key(n, (int)(now >> n & 1u), 0);
}

/* the latched key edges (the HAL's queue, main.c keys_poll; #230) through panel_key in order, while it takes them: peek
 * gives the oldest (key | 0x80 pressed, -1 none), pop takes it. So a press and its release within one pass both count. */
static void panel_key_queue(int (*peek)(void), void (*pop)(void), int quick)
{
    int e;
    while ((e = peek()) >= 0 && panel_key((uint32_t)e & 31u, e >> 7 & 1, quick))
        pop();
}

/* fm1_ms of SEL's press (its release on the SEQ page: the SONG page unless a key was the pen since) */
static uint32_t sel_down_ms;

/* ENV held and SAVE pressed meanwhile: its release opens nothing */
static uint8_t env_held_used;

/* SEL (#197): one level deeper. The environment's row: its device pages; a Steps track's page: its steps (#196); an
 * assembly device's page: its presets (#194); on the preset list: back */
static void sel_open(void)
{
    pages_ensure();
    if (page == PAGE_ENV) {
        page_set(0);
        m1_focus_now(pg_cur_dev, pg_cur_page);
    } else if (page == PAGE_PRESETS || page == PAGE_SONG) {
        screen_back();
    } else if (page == 0 && pages_focus_track() >= 0) {
        seq_select((uint32_t)pages_focus_track());
        page_set(PAGE_SEQ);
    } else if (page == 0 && pg_cur_dev < pg_ndev && pg_dev[pg_cur_dev].structure) {
        presets_open();
        page_set(PAGE_PRESETS);
    } else if (page == 0)
        dp_none_msg(pg_cur_dev);                    /* (why not: an old patch, a plain module) */
}

/* ENV held + SAVE (#194): the focused device's values as its preset */
static void preset_store_focused(void)
{
    dp_store(pg_cur_dev);
    if (page == PAGE_ENV || page == PAGE_PRESETS)
        ui_dirty = 2;
}

/* buttons pressed (p) and let go (rel) since the last call, matrix ids as bits; call it often, also with no edges: a
 * held HOME opens the menu after 0.7 s */
static void panel_edges(uint32_t p, uint32_t rel)
{
    static uint32_t home_t0;                        /* fm1_ms | 1 of the HOME press, 0: not held; bit 1: the hold fired */
    {                                               /* MIDI out: every button, raw, before anything uses it */
        uint32_t id;
        for (id = 0; (p | rel) >> id && id < 14u; id++) {
            if (p >> id & 1u)
                midi_send(0xB0u, BTN_CC[id], 127u);
            if (rel >> id & 1u)
                midi_send(0xB0u, BTN_CC[id], 0u);
        }
    }
    if (sb_on && page != PAGE_MENU) {               /* sandbox mode: the buttons went out as MIDI for the editor's patch; here only
                                                     * the FM-1's own (OCT, HOME, PLAY, GLO) */
        p &= SB_OWN_BTNS;
        rel &= SB_OWN_BTNS;
    }
    if ((p & ~(1u << BTN_REC)) || (rel & (1u << BTN_SEQ)))   /* the track's clear asks: another button, or SEQ let go, */
        seq_clear_cancel();                                   /* and it is not cleared (#231) */
    if ((page == PAGE_SEQ || page == PAGE_SONG) && (p & (1u << BTN_REC)) && (panel_held >> BTN_SEQ & 1u)) {   /* SEQ held + REC:
                                                     * clear the track (the SONG page: delete the entry), asked first (#231);
                                                     * neither SEQ's nor REC's release does its own */
        seq_held_used = rec_held_used = 1;
        p &= ~(1u << BTN_REC);
        if (page == PAGE_SONG)
            song_del_press();
        else
            seq_clear_press();
    }
    if (page == PAGE_MENU) {                        /* the menu: OCT- / OCT+ step the selected row's value */
        if (p & (1u << BTN_OCT_DOWN))
            menu_set_row(menu_sel, -1);
        if (p & (1u << BTN_OCT_UP))
            menu_set_row(menu_sel, 1);
        p &= ~((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP));
    }
    if (page == PAGE_SEQ && seq_kbd()) {            /* the armed track's keyboard (a live take): OCT the octave, FX and LFO are the
                                                     * page's */
        p &= ~((1u << BTN_ACC) | (1u << BTN_LFO));
    } else if (page == PAGE_SEQ) {                  /* the SEQ page: OCT- / OCT+ page through a long track (the roll with FX held:
                                                     * the keys' octave, the pen's), FX the accent key, LFO the roll's tie */
        int roll = seq_module() >= 0 && seq_map() < 0;
        if (!roll || !(panel_held >> BTN_ACC & 1u)) {
            if (p & (1u << BTN_OCT_DOWN))
                seq_page_step(-1);
            if (p & (1u << BTN_OCT_UP))
                seq_page_step(1);
            p &= ~((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP));
        }
        p &= ~((1u << BTN_ACC) | (roll ? 1u << BTN_LFO : 0u));
    }
    /* SEQ and REC act on release, unless a black key muted / armed a track meanwhile; the flag is cleared at the release,
     * not the press: panel_keys runs first in a pass, so a key that lands in the same pass as the press has set it (#179) */
    if ((rel & (1u << BTN_SEQ)) && !seq_held_used && page == PAGE_SONG)
        screen_back();                              /* SEQ on the SONG page: back to the SEQ page */
    else if ((rel & (1u << BTN_SEQ)) && !seq_held_used) {
        if (page == 0 && pages_focus_track() >= 0)  /* from a Steps track's device page: that track's steps (#196) */
            seq_select((uint32_t)pages_focus_track());
        page_set(PAGE_SEQ);
    }
    if (p & (1u << BTN_SEL))
        sel_down_ms = fm1_ms;
    if ((rel & (1u << BTN_SEL)) && page == PAGE_SEQ) {   /* SEL tapped on the SEQ page (no key as the pen since its press,
                                                     * a key in the same pass counting): the SONG page (#375, D-541) */
        if (!(seq_pen_ms && (int32_t)((seq_pen_ms & ~1u) - (sel_down_ms & ~1u)) >= 0) && eng_steps_count()) {
            song_prep();
            page_set(PAGE_SONG);
        }
    } else if (rel & (1u << BTN_SEL))               /* SEL (#197, fixed): one level deeper */
        sel_open();
    if (p & (1u << BTN_ENV))                        /* ENV (#197, fixed): the environment, on its release (held + SAVE: a preset) */
        env_held_used = 0;
    if ((rel & (1u << BTN_ENV)) && !env_held_used && page != PAGE_MENU) {
        if (page != PAGE_ENV)
            env_open();
        page_set(PAGE_ENV);                         /* (again: back) */
    }
    if (rel & (1u << BTN_SEQ))
        seq_held_used = 0;
    if ((rel & (1u << BTN_REC)) && !rec_held_used && page == PAGE_ENV) {   /* REC on the environment: the row's arm (#191, #198) */
        env_arm_toggle();
        rel &= ~(1u << BTN_REC);
        ui_dirty = ui_dirty ? ui_dirty : 1;          /* (its row) */
    }
    if ((rel & (1u << BTN_REC)) && !rec_held_used) {   /* REC: recording on / off (the SEQ page opens for hits, the armed track) */
        if (seq_rec_page() && page != PAGE_SEQ) {
            seq_rec_aim();                          /* (nothing armed: on a drum track, the hits seen landing) */
            page_set(PAGE_SEQ);
        }
        seq_rec_press();
    }
    if (rel & (1u << BTN_REC))
        rec_held_used = 0;
    if (p & (1u << BTN_OCT_DOWN))
        octave = octave > -3 ? octave - 1 : octave;
    if (p & (1u << BTN_OCT_UP))
        octave = octave < 3 ? octave + 1 : octave;
    if (p & ((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP))) {
        leds_octave();
        ui_dirty = ui_dirty ? ui_dirty : 1;         /* (the footer's octave) */
        {
            char m[12], num[8], *q = m;
            q = put(q, "OCTAVE ");
            if (octave > 0)
                *q++ = '+';
            fmt_int(num, octave);
            put(q, num)[0] = 0;                 /* (put does not end the text) */
            ui_msg(m, 1000);
        }
    }
    if ((p & (1u << BTN_SAVE)) && (panel_held >> BTN_ENV & 1u)) {   /* ENV held + SAVE: the focused device's preset (#194) */
        env_held_used = 1;
        p &= ~(1u << BTN_SAVE);
        preset_store_focused();
    }
    if (p & (1u << BTN_SAVE)) {
        int menu = page == PAGE_MENU;
        save_state();
        if (menu)                                   /* SAVE in the menu: saved (the settings too), and the menu closes */
            screen_back();
    }
    {
        uint32_t b;
        for (b = 0; b < ENG_PANEL_BUTTONS; b++) {
            if (p >> PANEL_BTN_ID[b] & 1u)
                panel_button(b, 1);
            if (rel >> PANEL_BTN_ID[b] & 1u)
                panel_button(b, 0);
        }
    }
    page_hold_poll();
    if (p & (1u << BTN_HOME))
        home_t0 = (fm1_ms & ~3u) | 1u;              /* HOME acts on release: a tap goes back, 0.7 s held opens the menu
                                                     * (bit 1 cleared: with fm1_ms's own bit 1 a press looked fired) */
    if (home_t0 && !(home_t0 & 2u) && (panel_held >> BTN_HOME & 1u) && fm1_ms - (home_t0 & ~3u) > 700u) {
        home_t0 |= 2u;
        if (page != PAGE_MENU)
            page_set(PAGE_MENU);
    }
    if (rel & (1u << BTN_HOME)) {
        if (home_t0 && !(home_t0 & 2u))
            screen_back();                          /* a tap: one step back (out of the menu, the SEQ page ...) */
        home_t0 = 0;
    }
    if (p & (1u << BTN_PLAY))                       /* PLAY acts on release, unless PRESET turned the tempo meanwhile */
        play_turned = 0;
    if ((rel & (1u << BTN_PLAY)) && !play_turned)
        play_toggle();
}

/* the loop's bookkeeping before the inputs are read: what was just moved, the beat, the overload guard, the toasts
 * ending, the live ticks of modulated rows */
static void panel_status(void)
{
    static uint8_t ovl_seen;
    static uint32_t shed_seen;
    sandbox_poll();                                 /* (no LIVE for 5 s: the FM-1 sounds again) */
    if (sb_home_due) {                              /* sandbox mode began: its page, unless the FM-1's own settings show */
        sb_home_due = 0;
        if (sb_on && page != 0u && page != PAGE_MENU && page != PAGE_GLO)
            page_show(0u);
    }
    if (knob_touched || button_touched) {           /* what was just moved, in the bar for a second */
        char m[40], name[16], num[12], *q = m;
        (void)num;
        if (!knob_touched) {
            uint32_t b = button_touched - 1u;
            if (!panel_label(b, name))
                put(name, PANEL_BTN_NAME[b])[0] = 0;
            q = put(q, name);
            q = put(q, eng_buttons_lit() >> b & 1u ? " ON" : " OFF");   /* (as its LED: ARP ON = arpeggiating) */
        }
        *q = 0;
        if (page == 0 && !knob_touched)
            ui_msg(m, 1000);
        knob_touched = button_touched = 0;
    }
    {                                               /* the beat on the player screen while the transport runs */
        static uint32_t beat_seen;
        uint32_t beat = eng_transport_running() ? eng_ticks() / 6u : 0u;
        if (beat != beat_seen && page == 0) {
            beat_seen = beat;
            if (!ui_dirty)
                ui_dirty = 1;
        }
    }
    if (eng_overload != ovl_seen) {                 /* audio.c's overload guard: muted, or a part fewer */
        ovl_seen = eng_overload;
        header_draw();
    } else if (eng_shed_count != shed_seen) {
        shed_seen = eng_shed_count;
        if (shed_seen)
            ui_msg("OVERLOAD: A PART LESS", 1500);
    }
    if ((page == 0 || page == PAGE_GLO) && pages_expired())   /* PRESET's toast ended: the page comes back */
        ui_dirty = ui_dirty ? ui_dirty : 1;
    {                                               /* the live ticks of modulated rows, ten times a second */
        static uint32_t tick_ms;
        if ((page == 0 || page == PAGE_GLO) && !ui_dirty && fm1_ms - tick_ms >= 100u) {
            tick_ms = fm1_ms;
            pages_ticks();
        }
    }
}

/* the keys while a redraw runs (#230): a full page is ~0.15 s of LCD transfers, and a note waited for all of it. main.c
 * (the tests) set panel_yield: the key edges latched so far, through panel_key_queue quick. panel_draw hands it to the LCD
 * (lcd_yield: lcd.c calls it while a transfer runs) for its own time only, so a key is never taken in the middle of
 * the loop's other work. Not again from inside itself; a header_draw asked for meanwhile waits for the redraw's end. */
static void (*panel_yield)(void);
static void panel_draw_yield(void)
{
    lcd_yield = 0;
    ui_yielding = 1;
    panel_yield();
    ui_yielding = 0;
    lcd_yield = panel_draw_yield;
}

static void panel_draw_now(void);
/* the loop's drawing after the inputs: the message ends, the page is redrawn when something changed */
static void panel_draw(void)
{
    lcd_yield = panel_yield ? panel_draw_yield : 0;
    panel_draw_now();
    lcd_yield = 0;
    if (ui_header_due) {                            /* a key's header_draw while the redraw ran */
        ui_header_due = 0;
        header_draw();
    }
    batt_draw();                                    /* the battery's cell, LOW BATTERY, its menu row (menu.c) */
}
static void panel_draw_now(void)
{
    if (msg_until && fm1_ms >= msg_until)
        ui_msg_clear();
    if (ui_full) {                                  /* (a message still on show, such as the boot's, stays) */
        uint32_t left = msg_until && fm1_ms < msg_until ? msg_until - fm1_ms : 0u;
        ui_full = 0;
        ui_dirty = 0;
        screen_idle();
        if (left)
            ui_msg(msg_text, left);
    }
    if (ui_dirty) {
        int full = ui_dirty > 1;
        ui_dirty = 0;
        view_draw(full);
    }
}
