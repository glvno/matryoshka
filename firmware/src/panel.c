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
static void poly_row_set(uint32_t mod, uint32_t field, int32_t v);

static uint8_t knob_touched, button_touched;  /* the knob (1..6) / patch button (1..7) last moved: the bar shows it */
#define BTN_PLAY 12u                  /* PLAY: the transport; held, PRESET sets the tempo */
static uint8_t play_turned;                   /* PRESET turned the tempo while PLAY was held: its release does not start / stop */

static const uint8_t PANEL_BTN_ID[ENG_PANEL_BUTTONS] = {2, 3, 4, 5, 6, 7, 10};   /* (SEQ 11 and REC 13: the step page, seq_ui.c) */

/* The device's own buttons (matrix ids, M-VAVE's fm1_open order): OCT- 0, OCT+ 1: octave; SAVE 9: write the patch into its slot
 * (in the menu: and close it); HOME 8: tap = back (the trail), held = the menu; PLAY 12: the transport. The others are the
 * patch's (PANEL_BTN_ID). */
#define BTN_OCT_DOWN 0u
#define BTN_OCT_UP 1u
#define BTN_SAVE 9u
#define BTN_HOME 8u

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
static void panel_button_set(uint32_t b, int down)
{
    const uint8_t *pn = m1_panel();
    uint32_t tog = pn ? (uint32_t)pn[0] | (uint32_t)pn[1] << 8 : 0u, mask = eng_buttons_get(), was = mask;
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
    if (down) {
        button_touched = (uint8_t)(b + 1u);
        if (!ui_dirty)
            ui_dirty = 1;
    }
}

/* The trail (#114): every screen change by a button (SEQ, REC, opening the menu; page buttons and GLO later) leaves a step
 * of where it came from; a HOME tap goes back one. ALGO / SELECT moving on the device pages are no steps. The oldest step
 * goes when the trail is full. */
#define TRAIL_MAX 8u
static struct { uint8_t page, dev, pg; } trail[TRAIL_MAX];
static uint8_t trail_n;

static void page_show(uint32_t p)
{
    page = (uint8_t)p;
    if (page == PAGE_MENU)
        menu_open();
    if (page != PAGE_SEQ) {                         /* (leaving the SEQ page ends live recording) */
        seq_rec = 0;
        seq_leds_off();
    }
    header_draw();
    leds_play();
    lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
    view_draw(1);
}

/* HOME tapped: one step back along the trail (the device page in focus then, if it moved); nothing when the trail is empty */
static void screen_back(void)
{
    if (!trail_n)
        return;
    trail_n--;
    if (trail[trail_n].page == 0u && pages_focus(trail[trail_n].dev, trail[trail_n].pg))
        m1_focus_now(pg_cur_dev, pg_cur_page);
    page_show(trail[trail_n].page);
}

/* a button opens screen p: a step on the trail; the same button again (p showing) goes back */
static void page_set(uint32_t p)
{
    if (page == p) {
        screen_back();
        return;
    }
    if (trail_n == TRAIL_MAX) {
        uint32_t i;
        for (i = 1; i < TRAIL_MAX; i++)
            trail[i - 1u] = trail[i];
        trail_n--;
    }
    trail[trail_n].page = page;
    trail[trail_n].dev = (uint8_t)pg_cur_dev;
    trail[trail_n].pg = (uint8_t)pg_cur_page;
    trail_n++;
    page_show(p);
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
    if (st[6]) {
        preset_step(st[6]);
        return;
    }
    if (page == PAGE_SEQ) {                         /* the SEQ page: ALGO picks the track, SELECT with a step held its chance */
        if (st[1] && eng_steps_count())
            seq_select((uint32_t)((seq_trk + (uint32_t)eng_steps_count() * 8u + (uint32_t)st[1]) % (uint32_t)eng_steps_count()));
        st[1] = 0;
        if (st[0] && seq_held >= 0) {
            seq_chance(st[0]);
            st[0] = 0;
        }
        if ((st[2] || st[3]) && seq_held >= 0) {   /* K1 / K2 with a step held: its note / velocity (not the Main knobs) */
            seq_value(st[2], st[3], cfg.accel && fm1_ms - last_ms[1] < 80u);
            last_ms[1] = fm1_ms;
            st[2] = st[3] = 0;
        }
    }
    if (page != 0)
        return;
    if (pages_select(st[0]) | pages_page(st[1])) {  /* SELECT: the device, ALGO: its page (the editor follows) */
        m1_focus_now(pg_cur_dev, pg_cur_page);
        ui_dirty = 2;
    }
    for (k = 0; k < 4u; k++) {                      /* K1..K4: the rows of the page in focus, relative */
        uint32_t mod, par;
        int32_t v, c = st[2u + k], r;
        if (!c || (r = pages_turn(k, c, cfg.accel && fm1_ms - last_ms[2u + k] < 80u, &mod, &par, &v)) < 0)
            continue;
        last_ms[2u + k] = fm1_ms;
        if (r == 1)
            poly_row_set(mod, par & 0x7Fu, v);      /* a poly group's setting (the Voice allocator's in the editor) */
        else {
            eng_set_param(mod, par, v);
            m1_patch_param(mod, par, v);
        }
        m1_param_now(mod, par, r == 1 ? v << 16 : v);   /* the editor follows (Live) */
        midi_send(0xB0u, 16u + k, pages_cc(k));
        if (!ui_dirty)
            ui_dirty = 1;
    }
    (void)panel;
}

static uint8_t key_note[27];                     /* the note each held key started, so a release (or an octave change in between) ends the right one */
static uint32_t key_sounding;                    /* bit n: key n started a note (not a key pressed on the SEQ page) */
static uint8_t seq_held_used;                    /* SEQ is held and a black key muted a track: its release does not switch the page */
/* the 27 keys now held (bit 0 = F3 = MIDI 53), shifted by the octave, -> the engine */
static void panel_keys(uint32_t now)
{
    static uint32_t prev;
    uint32_t diff, n;
    diff = now ^ prev;
    prev = now;
    if (diff)
        eng_midi_channel(cfg.ch);
    for (n = 0; diff && n < 27u; n++) {
        if (!(diff & (1u << n)))
            continue;
        diff &= ~(1u << n);
        if ((now & (1u << n)) && (panel_held >> BTN_SEQ & 1u) && seq_black(n) >= 0) {   /* SEQ held + a black key: a mute */
            seq_mute_key(n);
            seq_held_used = 1;
            continue;
        }
        if (!(key_sounding & (1u << n)) && (page == PAGE_SEQ || !(now & (1u << n)))) {   /* the SEQ page: steps and tracks */
            if (page == PAGE_SEQ)
                seq_key(n, (int)(now >> n & 1u));
            continue;
        }
        if (now & (1u << n)) {
            int32_t note = 53 + (int32_t)n + 12 * octave;
            key_note[n] = (uint8_t)(note < 0 ? 0 : note > 127 ? 127 : note);
            key_sounding |= 1u << n;
            eng_note_on(key_note[n], ENG_ONE, cfg.ch ? cfg.ch : 1u);   /* the panel plays on the device's channel */
            midi_send(0x90u, key_note[n], 100u);
        } else {
            key_sounding &= ~(1u << n);
            eng_note_off(key_note[n], cfg.ch ? cfg.ch : 1u);
            midi_send(0x80u, key_note[n], 0u);
        }
    }
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
    if (page == PAGE_MENU) {                        /* the menu: OCT- / OCT+ step the selected row's value */
        if (p & (1u << BTN_OCT_DOWN))
            menu_set_row(menu_sel, -1);
        if (p & (1u << BTN_OCT_UP))
            menu_set_row(menu_sel, 1);
        p &= ~((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP));
    }
    if (page == PAGE_SEQ) {                         /* the SEQ page: OCT- / OCT+ page through a long track, ENV is the accent key */
        if (p & (1u << BTN_OCT_DOWN))
            seq_page_step(-1);
        if (p & (1u << BTN_OCT_UP))
            seq_page_step(1);
        p &= ~((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP) | (1u << BTN_ENV));
    }
    if (p & (1u << BTN_SEQ))                        /* SEQ acts on release, unless a black key muted a track meanwhile */
        seq_held_used = 0;
    if ((rel & (1u << BTN_SEQ)) && !seq_held_used)
        page_set(PAGE_SEQ);
    if (p & (1u << BTN_REC)) {                      /* REC: live recording, on the SEQ page */
        if (page != PAGE_SEQ)
            page_set(PAGE_SEQ);
        seq_rec_toggle();
    }
    if (p & (1u << BTN_OCT_DOWN))
        octave = octave > -3 ? octave - 1 : octave;
    if (p & (1u << BTN_OCT_UP))
        octave = octave < 3 ? octave + 1 : octave;
    if (p & ((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP))) {
        leds_octave();
        {
            char m[12], num[8], *q = m;
            q = put(q, "OCTAVE ");
            if (octave > 0)
                *q++ = '+';
            fmt_int(num, octave);
            put(q, num);
            ui_msg(m, 1000);
        }
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
    if (knob_touched || button_touched) {           /* what was just moved, in the bar for a second */
        char m[40], name[16], num[12], *q = m;
        (void)num;
        if (!knob_touched) {
            uint32_t b = button_touched - 1u;
            if (!panel_label(b, name))
                put(name, PANEL_BTN_NAME[b])[0] = 0;
            q = put(q, name);
            q = put(q, eng_buttons_get() >> b & 1u ? " ON" : " OFF");
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
    if (page == 0 && pages_expired())             /* a toast ended: the picture comes back */
        ui_dirty = ui_dirty ? ui_dirty : 1;
    {                                               /* the live ticks of modulated rows, ten times a second */
        static uint32_t tick_ms;
        if (page == 0 && !ui_dirty && fm1_ms - tick_ms >= 100u) {
            tick_ms = fm1_ms;
            pages_ticks();
        }
    }
}

/* the loop's drawing after the inputs: the message ends, the page is redrawn when something changed */
static void panel_draw(void)
{
    if (msg_until && fm1_ms >= msg_until)
        ui_msg_clear();
    if (ui_dirty) {
        int full = ui_dirty > 1;
        ui_dirty = 0;
        view_draw(full);
    }
}
