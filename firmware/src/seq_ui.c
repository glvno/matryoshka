/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The SEQ page (#83), after menu.c and before main.c: XOX step entry for the patch's Steps modules (drum tracks).
 *
 *   SEQ             opens / closes the page; held + a black key: mute / unmute that track (from any page, not saved)
 *   black keys      pick the track (1..11, patch order); ALGO steps through all of them; with REC on a black key is a hit on
 *                   its track instead: it sounds and, while the track plays, goes into the nearest step (ENV held: accented)
 *   white keys      the 16 steps of the page: a press switches the step on / off (ENV held: its accent instead); the
 *                   track holds notes (#133): the step view of eng_steps_get / set (on = notes start there, a tied step
 *                   is untied by a press; off = its notes go, an accent = full velocity)
 *   white key held  + SELECT: the step's chance, 100 % .. 5 % in steps of 5; + K1: its note (a semitone a click, a chord
 *                   moves as one; on a track whose notes are all C4 the first click starts from C of the keys' octave);
 *                   + K2: its velocity (#93). Turning a knob on a held step undoes the press: the track's notes as they
 *                   were, the step on.
 *   OCT- / OCT+     the page of a track longer than 16 steps (17-32 ...)
 *   REC             live recording on / off (its LED is lit while on); it acts on its release
 * On this page the keys play no notes, unless REC records an armed track.
 *
 * Arming and recording from the keys (#139, the editor's #134 / #135):
 *   REC held + a black key (any page): arm that track, again: disarm. While a track is armed the keys (and MIDI notes)
 *                   play through it to what it plays (engine.c eng_arm); the device pages' info line says ARM and its name,
 *                   the SEQ page ARM in the bar and on the track's row (#179). Black key n is track n here also on a drum
 *                   track's page, where the keys alone pick rows; a key past the tracks says NO TRACK n.
 *   REC with a track armed: stopped, the SEQ page opens on it in step entry: the 27 keys are its keyboard, every key held
 *                   when the first is let go fills the cursor's step (a chord, one step long; ENV held: full velocity), the
 *                   cursor moves on; ENV + OCT a rest, LFO + OCT a tie, SELECT moves the cursor, OCT- / OCT+ the octave.
 *                   Running, the page stays: the keys play and the engine records them live onto the nearest step
 *                   (eng_steps_rec); on the SEQ page they are the track's keyboard. PLAY / stop switches between the two.
 *                   REC again, or another arm, ends it; leaving the page ends step entry (a live take goes on). Key LEDs: the selected track's steps bright, the step playing at the mid level (dark
 * on a step that is on), the selected track's black key bright, tracks with hits glowing, muted ones blinking. The top bar
 * shows the track's name (STEPS n without one). Edits go into the running patch (SAVE keeps them) and to the editor. */

#define PAGE_SEQ 8u
#define BTN_SEQ 11u
#define BTN_REC 13u
#define BTN_ENV 4u                      /* ENV: the environment (#197) */
#define BTN_ACC 2u                      /* FX: the SEQ page's accent / rest key (#197; it was ENV)*/
#define BTN_LFO 5u

static uint8_t seq_trk;                 /* the selected track (index among the patch's Steps modules) */
static uint8_t seq_pg;                  /* the page of 16 steps */
static uint8_t seq_rec;                 /* REC: 1 black keys record hits, 2 the keys record into the armed track (#139) */
static int8_t seq_cur;                  /* step entry: the cursor's step */
static uint8_t seq_row;                 /* a drum track (the #139 follow-up): the Drum map's row the white keys edit */
static uint32_t ent_keys;               /* the keys held while they are the armed track's keyboard (bit n: key n) */
static uint8_t ent_note[TRACK_POLY], ent_n, ent_vel;   /* step entry: the chord being played for the cursor's step */
static int8_t seq_held = -1;            /* the step whose white key is held (SELECT sets its chance, K1 / K2 its values), -1 none */
static uint32_t seq_held_notes[TRACK_NOTES_MAX];   /* the track's notes before the held step's press switched it */
static uint8_t seq_held_n;
static uint8_t seq_held_turned;         /* a knob turned while it is held (the press's switch is undone once) */
static int8_t seq_shown_pos = -2;       /* the playhead as last drawn */

/* note key n (0 = F3) -> its white key's step on the page (0..15) or its black key's track (0..10), else -1 */
static int seq_white(uint32_t n)
{
    static const int8_t W[12] = {0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6};   /* from F: F F# G G# A A# B C C# D D# E */
    return n < 27u && W[n % 12u] >= 0 ? (int)(n / 12u) * 7 + W[n % 12u] : -1;
}
static int seq_black(uint32_t n)
{
    static const int8_t B[12] = {-1, 0, -1, 1, -1, 2, -1, -1, 3, -1, 4, -1};
    return n < 27u && B[n % 12u] >= 0 ? (int)(n / 12u) * 5 + B[n % 12u] : -1;
}

static int seq_module(void) { return eng_steps_module(seq_trk); }

/* a drum track (the #139 follow-up): the Drum map the selected track plays (-1: none, or the keys are its keyboard), a row's note and
 * name (the binary's, else ROW n) */
static int seq_kbd(void);
static int seq_map(void)
{
    int mod = seq_module();
    return mod >= 0 && !seq_kbd() ? eng_steps_drummap((uint32_t)mod) : -1;
}
static uint32_t seq_row_note(int map, uint32_t r) { int n = eng_drummap_note((uint32_t)map, r); return n < 0 ? STEP_NOTE : (uint32_t)n; }
static void seq_row_name(int map, uint32_t r, char *out)
{
    char num[8];
    if (map >= 0 && m1_drum_name((uint32_t)map, r, out))
        return;
    fmt_int(num, (int32_t)r + 1);
    put(put(out, "ROW "), num)[0] = 0;
}

/* the armed track's index among the Steps modules, -1 none */
static int seq_armed_trk(void)
{
    int t, a = eng_armed();
    for (t = 0; a >= 0 && t < eng_steps_count(); t++)
        if (eng_steps_module((uint32_t)t) == a)
            return t;
    return -1;
}
/* the keys are the armed track's keyboard (REC on it, on this page); step entry: that, stopped */
static int seq_kbd(void) { return seq_rec == 2u && page == PAGE_SEQ; }
static int seq_entry(void) { return seq_kbd() && !eng_transport_running(); }

static int32_t seq_len(int mod)
{
    return mod < 0 ? 16 : clampi((eng_get_param((uint32_t)mod, STEPS_P_LEN) + 32768) >> 16, 1, TRACK_STEPS);
}

/* the track's name as the bar shows it: its own, else STEPS n */
static void seq_name(uint32_t t, char *out)
{
    int mod = eng_steps_module(t);
    char num[8];
    if (mod >= 0)
        m1_track_name((uint32_t)mod, out);
    else
        out[0] = 0;
    if (!out[0]) {
        fmt_int(num, (int32_t)t + 1);
        put(put(out, "STEPS "), num)[0] = 0;
    }
}

/* a page of the selected track that exists, a track that exists (after a patch change, a len change) */
static void seq_clamp(void)
{
    int32_t pages;
    if (seq_trk >= (uint32_t)eng_steps_count())
        seq_trk = 0;
    pages = (seq_len(seq_module()) + 15) / 16;
    if (seq_pg >= pages)
        seq_pg = (uint8_t)(pages - 1);
}

/* a step's new byte into the engine, the binary and the editor */
static void seq_put(int mod, uint32_t k, uint32_t b)
{
    m1_patch_step((uint32_t)mod, k, b);
    m1_track_now((uint32_t)mod);
}

/* ---- the key LEDs */

static void led_bit(uint8_t *a, uint32_t id, int on)   /* a key's bit in one of the HAL's LED arrays */
{
    uint32_t p, r;
    for (p = 0; p < FM1_NCOL; p++)
        for (r = 1; r < 5u; r++)
            if (FM1_KEYMAP[r][p] == (int8_t)id) {
                if (on)
                    a[p] |= (uint8_t)(1u << r);
                else
                    a[p] &= (uint8_t)~(1u << r);
            }
}

static void seq_leds_off(void)
{
    uint32_t n;
    for (n = 0; n < 27u; n++) {
        led_bit(fm1_led, 14u + n, 0);
        led_bit(fm1_led_dim, 14u + n, 0);
        led_bit(fm1_led_mid, 14u + n, 0);
    }
    fm1_led_key(BTN_REC, 0);
}

/* does step k of `mod` start this note (step entry: the keys of the cursor's step glow) */
static int seq_step_has(int mod, uint32_t k, uint32_t note)
{
    const uint32_t *w;
    int i, n = eng_steps_notes((uint32_t)mod, &w);
    for (i = 0; i < n; i++)
        if ((w[i] & 63u) == k && ((w[i] >> 12) & 127u) == note)
            return 1;
    return 0;
}

static void seq_leds(void)
{
    int mod = seq_module(), pos = mod >= 0 ? eng_steps_pos((uint32_t)mod) : -1, arm = seq_armed_trk();
    int blink = (fm1_ms / 200u) & 1u, kbd = seq_kbd(), entry = seq_entry(), map = seq_map();
    uint32_t n, rows = 0, rn = map >= 0 ? seq_row_note(map, seq_row) : 0u;
    if (map >= 0) {                              /* a drum track: the rows with hits */
        const uint32_t *ws;
        int i, nn = eng_steps_notes((uint32_t)mod, &ws);
        uint32_t r;
        for (r = 0; r < ENG_DRUM_ROWS; r++)
            for (i = 0; i < nn; i++)
                if (((ws[i] >> 12) & 127u) == seq_row_note(map, r) && (int)(ws[i] & 63u) < seq_len(mod))
                    rows |= 1u << r;
    }
    for (n = 0; n < 27u; n++) {
        int w = seq_white(n), b = seq_black(n), lit = 0, mid = 0, dim = 0;
        if (kbd) {                               /* the armed track's keyboard: the keys held bright; step entry: the notes */
            uint32_t note = (uint32_t)clampi(53 + (int32_t)n + 12 * octave, 0, 127);   /* on the cursor's step glow, */
            lit = (int)(ent_keys >> n & 1u);     /* live: every C, to find your place */
            dim = !lit && (entry ? mod >= 0 && seq_step_has(mod, (uint32_t)seq_cur, note) : note % 12u == 0u);
        } else if (map >= 0 && b >= 0) {        /* a drum track's rows: the selected one bright (blinking: muted), the */
            if (b < (int)ENG_DRUM_ROWS)          /* others with hits dim */
                lit = (uint32_t)b == seq_row && (!eng_steps_muted((uint32_t)mod) || blink), dim = (uint32_t)b != seq_row && (rows >> b & 1u);
        } else if (w >= 0 && mod >= 0) {
            int k = seq_pg * 16 + w, on = k < seq_len(mod) && (map >= 0 ? seq_step_has(mod, (uint32_t)k, rn) : (eng_steps_get((uint32_t)mod, (uint32_t)k) & 1));
            lit = on && k != pos;
            mid = !on && k == pos;
        } else if (b >= 0 && b < eng_steps_count()) {
            int bm = eng_steps_module((uint32_t)b), any = 0, k;
            for (k = 0; k < seq_len(bm) && !any; k++)
                any = eng_steps_get((uint32_t)bm, (uint32_t)k) & 1;
            if (eng_steps_muted((uint32_t)bm))
                lit = blink;
            else if ((uint32_t)b == seq_trk)
                lit = 1;
            else if (b == arm)                   /* the armed track: the mid level */
                mid = 1;
            else
                dim = any;
        }
        led_bit(fm1_led, 14u + n, lit);
        led_bit(fm1_led_mid, 14u + n, mid);
        led_bit(fm1_led_dim, 14u + n, dim);
    }
    fm1_led_key(BTN_REC, seq_rec);
}

/* ---- the panel */

static void seq_select(uint32_t t)
{
    if (t >= (uint32_t)eng_steps_count())
        return;
    seq_trk = (uint8_t)t;
    seq_pg = 0;
    seq_held = -1;
    seq_row = 0;
    header_draw();
    ui_dirty = 2;
}

/* SEQ / REC held + a black key past the patch's tracks: say so, instead of nothing (#179: on a drum track's page the black
 * keys are its rows, but held with SEQ or REC they count tracks, black key 1 = track 1) */
static int seq_no_track(int b)
{
    char m[24], num[8];
    if (b >= 0 && b < eng_steps_count())
        return 0;
    if (!eng_steps_count()) {
        ui_msg("NO STEPS MODULE", 1000);
        return 1;
    }
    fmt_int(num, b + 1);
    put(put(m, "NO TRACK "), num)[0] = 0;
    ui_msg(m, 1000);
    return 1;
}

/* a mute or an arm changed: redrawn in place, nothing cleared first (#179). On the SEQ page its track row and, after the
 * message, the bar; the device pages' info line (the arm) is drawn on every redraw. seq_rec_off's 2 (a take ended,
 * the page's layout changes) stays. */
static void seq_track_redraw(void)
{
    if (!ui_dirty)
        ui_dirty = 1;
}

/* SEQ held + a black key (any page): that track muted / unmuted */
static void seq_mute_key(uint32_t n)
{
    int b = seq_black(n), mod;
    char m[24], name[TRACK_NAME_MAX + 8];
    if (seq_no_track(b))
        return;
    mod = eng_steps_module((uint32_t)b);
    eng_steps_mute((uint32_t)mod, !eng_steps_muted((uint32_t)mod));
    m1_mute_now((uint32_t)mod, eng_steps_muted((uint32_t)mod));
    seq_name((uint32_t)b, name);
    put(put(m, name), eng_steps_muted((uint32_t)mod) ? " MUTED" : " ON")[0] = 0;
    ui_msg(m, 1000);
    if (page == PAGE_SEQ)                        /* (no other page shows mutes) */
        seq_track_redraw();
}

/* a key on the SEQ page (n: note key 0..26) */
static void seq_sync(int mod);
/* a key on the SEQ page of a drum track (the #139 follow-up): black keys 1..8 the Drum map's rows (stopped: heard; REC on: a hit on the
 * row, into the nearest step while it plays), white keys that row's hit on the page's steps (ENV held: an accent) */
static void seq_drum_key(int map, uint32_t n, int down)
{
    int w = seq_white(n), b = seq_black(n), mod = seq_module();
    int env = (int)(panel_held >> BTN_ACC & 1u);
    if (!down) {
        if (w >= 0 && seq_held == seq_pg * 16 + w)
            seq_held = -1;
        return;
    }
    if (b >= 0) {
        if (b >= (int)ENG_DRUM_ROWS)
            return;
        seq_row = (uint8_t)b;
        if (seq_rec) {
            if (eng_steps_hit_note((uint32_t)mod, seq_row_note(map, seq_row), env, 1) >= 0)
                seq_sync(mod);
        } else if (!eng_transport_running())
            (void)eng_steps_hit_note((uint32_t)mod, seq_row_note(map, seq_row), 0, 0);
        header_draw();
        ui_dirty = 2;
        return;
    }
    if (w < 0)
        return;
    {
        int k = seq_pg * 16 + w;
        uint32_t note = seq_row_note(map, seq_row), have;
        const uint32_t *ws;
        int i, nn;
        if (k >= seq_len(mod))
            return;
        nn = eng_steps_notes((uint32_t)mod, &ws);       /* (a knob turned on the held step brings them back) */
        seq_held_n = (uint8_t)(nn > 0 ? nn : 0);
        for (i = 0; i < nn; i++)
            seq_held_notes[i] = ws[i];
        seq_held_turned = 0;
        have = eng_steps_note((uint32_t)mod, (uint32_t)k, note);
        if (env && have)                         /* ENV held: the accent on / off */
            eng_steps_overdub((uint32_t)mod, (have & ~(127u << 19)) | (uint32_t)(((have >> 19) & 127u) == ACCENT_VEL ? STEP_VEL : ACCENT_VEL) << 19);
        else
            eng_steps_toggle((uint32_t)mod, (uint32_t)k, note, env ? ACCENT_VEL : STEP_VEL);
        seq_sync(mod);
        seq_held = (int8_t)k;
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
}

/* the held step's row note on a drum track, after the press's switch is undone once (an edit means it should play): its
 * note word, 0 when it cannot be there */
static uint32_t seq_drum_held(int map, int mod)
{
    uint32_t note = seq_row_note(map, seq_row), w;
    if (!seq_held_turned) {
        seq_held_turned = 1;
        (void)eng_steps_set_notes((uint32_t)mod, seq_held_notes, seq_held_n);
    }
    if (!(w = eng_steps_note((uint32_t)mod, (uint32_t)seq_held, note))) {
        eng_steps_toggle((uint32_t)mod, (uint32_t)seq_held, note, STEP_VEL);
        w = eng_steps_note((uint32_t)mod, (uint32_t)seq_held, note);
    }
    return w;
}

static void seq_key(uint32_t n, int down)
{
    int w = seq_white(n), b = seq_black(n), mod = seq_module(), map = seq_map();
    int env = (int)(panel_held >> BTN_ACC & 1u);
    if (map >= 0) {
        seq_drum_key(map, n, down);
        return;
    }
    if (!down) {
        if (w >= 0 && seq_held == seq_pg * 16 + w)
            seq_held = -1;
        return;
    }
    if (b >= 0) {
        if (b >= eng_steps_count())
            return;
        if (seq_rec) {                           /* a hit: heard now, into the nearest step while the track plays */
            int bm = eng_steps_module((uint32_t)b), k = eng_steps_hit((uint32_t)bm, env, 1);
            if (k >= 0)
                seq_put(bm, (uint32_t)k, (uint32_t)eng_steps_get((uint32_t)bm, (uint32_t)k));
            if ((uint32_t)b != seq_trk)
                seq_select((uint32_t)b);
            ui_dirty = ui_dirty ? ui_dirty : 1;
        } else
            seq_select((uint32_t)b);
        return;
    }
    if (w < 0 || mod < 0)
        return;
    {
        int k = seq_pg * 16 + w;
        uint32_t s;
        if (k >= seq_len(mod))
            return;
        s = (uint32_t)eng_steps_get((uint32_t)mod, (uint32_t)k);
        if (s & 0x80u)                           /* a tied step: untied, on (accented with ENV held) */
            s = env ? 3u : 1u;
        else if (env)                            /* ENV held: the accent (an off step comes on accented) */
            s = (s & 1u) ? s ^ 2u : s | 3u;
        else
            s = (s & 1u) ? s & ~3u : s | 1u;     /* (switched off: its notes go) */
        {                                        /* (a knob turned on the held step brings them back) */
            const uint32_t *w;
            int i, nn = eng_steps_notes((uint32_t)mod, &w);
            seq_held_n = (uint8_t)(nn > 0 ? nn : 0);
            for (i = 0; i < nn; i++)
                seq_held_notes[i] = w[i];
        }
        seq_held_turned = 0;
        seq_put(mod, (uint32_t)k, s);
        seq_held = (int8_t)k;
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
}

/* the first knob turn on a held step: the track as before the press, the step on (an edit means the step should play) */
static void seq_held_restore(int mod)
{
    if (seq_held_turned)
        return;
    seq_held_turned = 1;
    (void)eng_steps_set_notes((uint32_t)mod, seq_held_notes, seq_held_n);
    seq_put(mod, (uint32_t)seq_held, (eng_steps_get((uint32_t)mod, (uint32_t)seq_held) & 1) ? (uint32_t)eng_steps_get((uint32_t)mod, (uint32_t)seq_held) : 1u);
}

/* SELECT turned with a step held: its chance, 5 % a click */
static void seq_chance(int32_t clicks)
{
    int mod = seq_module(), map = seq_map();
    uint32_t s;
    int32_t code;
    char m[24], num[8];
    if (mod < 0 || seq_held < 0)
        return;
    if (map >= 0) {                              /* a drum track: the row's hit on the held step */
        uint32_t w = seq_drum_held(map, mod);
        if (!w)
            return;
        code = clampi((int32_t)((w >> 26) & 31u) - clicks, 0, 19);
        eng_steps_overdub((uint32_t)mod, (w & ~(31u << 26)) | (uint32_t)code << 26);
        seq_sync(mod);
        fmt_int(num, 100 - 5 * code);
        put(put(put(m, "CHANCE "), num), "%")[0] = 0;
        ui_msg(m, 1000);
        ui_dirty = ui_dirty ? ui_dirty : 1;
        return;
    }
    seq_held_restore(mod);
    s = (uint32_t)eng_steps_get((uint32_t)mod, (uint32_t)seq_held);
    code = clampi((int32_t)((s >> 2) & 31u) - clicks, 0, 19);
    s = (s & 3u) | (uint32_t)code << 2 | 1u;     /* (a chance only means something on a step that is on) */
    seq_put(mod, (uint32_t)seq_held, s);
    fmt_int(num, 100 - 5 * code);
    put(put(put(m, "CHANCE "), num), "%")[0] = 0;
    ui_msg(m, 1000);
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

/* a note number as the LCD writes it: C4, F#2 (60 = C4) */
static char *seq_note_name(char *p, uint32_t n)
{
    static const char NAMES[12][3] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
    char num[8];
    p = put(p, NAMES[n % 12u]);
    fmt_int(num, (int32_t)(n / 12u) - 1);
    return put(p, num);
}

/* K1 / K2 turned with a step held: its note (a semitone a click) / velocity (1 a click, 5 when turned fast) */
static void seq_value(int32_t note_clicks, int32_t vel_clicks, int fast)
{
    int mod = seq_module(), v, k, map = seq_map();
    int32_t note, vel;
    char m[24], num[8], *p;
    if (mod < 0 || seq_held < 0 || (!note_clicks && !vel_clicks))
        return;
    if (map >= 0) {                              /* a drum track: K2 the row hit's velocity (its note is the row's) */
        uint32_t w;
        if (!vel_clicks || !(w = seq_drum_held(map, mod)))
            return;
        vel = clampi((int32_t)((w >> 19) & 127u) + vel_clicks * (fast ? 5 : 1), 1, 127);
        eng_steps_overdub((uint32_t)mod, (w & ~(127u << 19)) | (uint32_t)vel << 19);
        seq_sync(mod);
        fmt_int(num, seq_held + 1);
        p = put(put(m, "STEP "), num);
        p = put(p, "  VEL ");
        fmt_int(num, vel);
        put(p, num)[0] = 0;
        ui_msg(m, 1200);
        ui_dirty = ui_dirty ? ui_dirty : 1;
        return;
    }
    seq_held_restore(mod);
    v = eng_steps_value((uint32_t)mod, (uint32_t)seq_held);
    note = v & 0x7F;
    vel = (v >> 8) & 0x7F;
    if (note_clicks) {
        int fresh = 1;                           /* a track without notes: the first click starts from C of the keys' octave */
        for (k = 0; k < TRACK_STEPS && fresh; k++)
            fresh = (eng_steps_value((uint32_t)mod, (uint32_t)k) & 0x7F) == STEP_NOTE;
        if (fresh)
            note = STEP_NOTE + 12 * octave;
        note = clampi(note + note_clicks, 0, 127);
    }
    vel = clampi(vel + vel_clicks * (fast ? 5 : 1), 0, 127);
    m1_patch_stepval((uint32_t)mod, (uint32_t)seq_held, (uint32_t)note, (uint32_t)vel);
    m1_track_now((uint32_t)mod);
    fmt_int(num, seq_held + 1);
    p = put(put(m, "STEP "), num);
    p = put(p, "  ");
    p = seq_note_name(p, (uint32_t)note);
    p = put(p, "  VEL ");
    fmt_int(num, vel);
    put(p, num)[0] = 0;
    ui_msg(m, 1200);
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

static void seq_page_step(int d)
{
    int32_t pages = (seq_len(seq_module()) + 15) / 16, pg = clampi(seq_pg + d, 0, pages - 1);
    char m[24], num[8], *q = m;
    if (pg == seq_pg)
        return;
    seq_pg = (uint8_t)pg;
    seq_held = -1;
    fmt_int(num, pg * 16 + 1);
    q = put(put(q, "STEPS "), num);
    *q++ = '-';
    fmt_int(num, pg * 16 + 16);
    put(q, num)[0] = 0;
    ui_msg(m, 800);
    ui_dirty = 2;
}

/* the running patch's copy of a track after an engine edit of its notes (proto.c), and the editor */
static void seq_sync(int mod)
{
    m1_patch_notes((uint32_t)mod);
    m1_track_now((uint32_t)mod);
}

static void seq_rec_off(void)
{
    if (seq_rec == 2u && eng_armed() >= 0)
        eng_steps_rec((uint32_t)eng_armed(), 0);
    seq_rec = 0;
    ent_n = 0;
    ent_keys = 0;
    ui_dirty = 2;
}

/* REC let go (panel.c; not after REC held + a black key armed a track): off, or on: with a track armed into it (stopped:
 * step entry on the SEQ page, the caller opens it: seq_rec_page), else the black keys record hits */
static int seq_rec_page(void) { return !seq_rec && (eng_armed() < 0 || !eng_transport_running()); }
static void seq_rec_press(void)
{
    int t = seq_armed_trk();
    char m[32], name[TRACK_NAME_MAX + 8];
    if (seq_rec) {
        seq_rec_off();
        ui_msg("REC OFF", 1000);
        return;
    }
    if (t < 0) {
        seq_rec = 1;
        ui_msg("REC: BLACK KEYS RECORD", 1000);
        ui_dirty = 2;
        return;
    }
    seq_rec = 2;
    eng_steps_rec((uint32_t)eng_armed(), 1);
    if ((uint32_t)t != seq_trk)
        seq_pg = 0;
    seq_trk = (uint8_t)t;
    seq_held = -1;
    seq_cur = (int8_t)(seq_pg * 16);
    ent_n = 0;
    seq_name((uint32_t)t, name);
    put(put(m, eng_transport_running() ? "REC " : "WRITE "), name)[0] = 0;
    ui_msg(m, 1000);
    ui_dirty = 2;
}

/* REC held + a black key (any page): that track armed, or disarmed if it was */
static void seq_arm_key(uint32_t n)
{
    int b = seq_black(n), mod;
    char m[32], name[TRACK_NAME_MAX + 8];
    if (seq_no_track(b))
        return;
    mod = eng_steps_module((uint32_t)b);
    if (seq_rec == 2u)                           /* (a take on the track armed before ends) */
        seq_rec_off();
    eng_arm_mask(eng_arm_mask_get() ^ (uint64_t)1 << mod);   /* (#191: one of the armed set, the others stay) */
    m1_arms_now((uint32_t)eng_arm_mask_get(), (uint32_t)(eng_arm_mask_get() >> 32));
    seq_name((uint32_t)b, name);
    put(put(m, name), (eng_arm_mask_get() >> mod & 1u) ? " ARMED" : " DISARMED")[0] = 0;
    ui_msg(m, 1200);
    seq_track_redraw();
}

/* the page is left: step entry and the black keys' recording end (a live take on the armed track goes on) */
static void seq_leave(void)
{
    if (seq_rec == 1u || (seq_rec == 2u && !eng_transport_running()))
        seq_rec_off();
    ent_keys = 0;
    ent_n = 0;
}

/* the cursor moves by d steps (round the track's length); the page follows it */
static void seq_cur_move(int32_t d)
{
    int32_t len = seq_len(seq_module());
    seq_cur = (int8_t)(((seq_cur + d) % len + len) % len);
    seq_pg = (uint8_t)(seq_cur / 16);
    ui_dirty = 2;
}

/* a key while the keys are the armed track's keyboard (the panel plays it too): step entry collects a chord, written into
 * the cursor's step when the first of its keys is let go (the editor's step entry) */
static void seq_kbd_key(uint32_t n, uint32_t note, int down, uint32_t vel)
{
    int mod = eng_armed();
    if (down)
        ent_keys |= 1u << n;
    else
        ent_keys &= ~(1u << n);
    ui_dirty = ui_dirty ? ui_dirty : 1;
    if (!seq_entry() || mod < 0)
        return;
    if (down) {
        uint32_t i;
        if (!(ent_keys & ~(1u << n)))
            ent_n = 0;                           /* (the first key of a new chord) */
        for (i = 0; i < ent_n && ent_note[i] != note; i++)
            ;
        if (i == ent_n && ent_n < TRACK_POLY)
            ent_note[ent_n++] = (uint8_t)note;
        ent_vel = (uint8_t)vel;
        return;
    }
    if (!ent_n)
        return;
    eng_steps_chord((uint32_t)mod, (uint32_t)seq_cur, ent_note, ent_n, ent_vel);
    seq_sync(mod);
    ent_n = 0;                                   /* (the keys still down were in it; a key now starts the next chord) */
    seq_cur_move(1);
}

/* OCT- / OCT+ in step entry: with ENV held a rest, with LFO held a tie (then the cursor moves on); 0: not taken (the
 * octave) */
static int seq_entry_oct(void)
{
    int mod = eng_armed(), env = (int)(panel_held >> BTN_ACC & 1u), lfo = (int)(panel_held >> BTN_LFO & 1u);
    if (!seq_entry() || mod < 0 || (!env && !lfo))
        return 0;
    m1_patch_step((uint32_t)mod, (uint32_t)seq_cur, env ? 0u : 0x80u);
    m1_track_now((uint32_t)mod);
    seq_cur_move(1);
    return 1;
}

/* the device pages' info line: ARM / REC and the armed track's name (the colour: recording or not); 0 when none is armed */
static int seq_arm_label(char *out, int *rec)
{
    int t = seq_armed_trk();
    char name[TRACK_NAME_MAX + 8];
    if (t < 0)
        return 0;
    seq_name((uint32_t)t, name);
    *rec = seq_rec == 2u;
    put(put(out, *rec ? "REC " : "ARM "), name)[0] = 0;
    return 1;
}

/* the main loop, every pass (seq_poll): the notes the engine recorded laid over their tracks; a patch that took the arm
 * away ends the take; REC's LED off the page */
static void seq_take(void)
{
    uint32_t m, w, done = 0;
    int last = -1;
    while (eng_steps_take(&m, &w)) {
        eng_steps_overdub(m, w);
        if ((int)m != last && last >= 0)
            seq_sync(last);
        last = (int)m;
        done = 1;
    }
    if (last >= 0)
        seq_sync(last);
    if (done && page == PAGE_SEQ)
        ui_dirty = ui_dirty ? ui_dirty : 1;
    if (seq_rec == 2u && eng_armed() < 0)
        seq_rec_off();
    if (page != PAGE_SEQ)
        fm1_led_key(BTN_REC, seq_rec != 0);
}

/* ---- the LCD */

/* the top bar on the SEQ page: the track's name, its number of how many, REC */
static void seq_bar(void)
{
    char b[32], name[TRACK_NAME_MAX + 8], num[8], *p = b;
    if (!eng_steps_count()) {
        bar_text("NO STEPS MODULE", C_ACC);
        return;
    }
    seq_name(seq_trk, name);
    p = put(p, name);
    *p++ = ' ';
    if (seq_kbd())                               /* the keys record into the armed track: step entry's cursor, or live */
        p = put(p, seq_entry() ? "WRITE" : "KEYS");
    else if (seq_map() >= 0) {                   /* a drum track: the row the white keys edit (DRUMS: SNARE) */
        p[-1] = ':';
        *p++ = ' ';
        seq_row_name(seq_map(), seq_row, name);
        p = put(p, name);
    } else {
        fmt_int(num, (int32_t)seq_trk + 1);
        p = put(p, num);
        *p++ = '/';
        fmt_int(num, eng_steps_count());
        p = put(p, num);
    }
    if (seq_rec)
        p = put(p, " REC");
    else if (seq_armed_trk() == (int)seq_trk)    /* the track shown is armed (#179) */
        p = put(p, " ARM");
    *p = 0;
    bar_text(b, seq_rec ? C_RED : C_ACC);
}

/*   y  32  the page's steps of the track's length, its rate and swing (when not straight)
 *   y  52  the 16 steps of the page: a cell each (filled = on, accent = the accent colour, a chance fills it part way up),
 *          the step playing underlined
 *   y 100  every track: number, name, M when muted, ARM when armed (the selected one in the accent colour); a drum
 *          track: its map's rows, and at y 172 its number of how many, ARMED, MUTED
 *   y 228  the hint line */
static void seq_draw(int full)
{
    char line[40], num[8], name[TRACK_NAME_MAX + 8], *p;
    int mod = seq_module(), pos, i, map = seq_map();
    int32_t len;
    uint32_t t;
    seq_clamp();
    if (mod < 0) {
        if (full) {
            lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
            text_bc(&FONT_M, 10, 56, "This patch has no Steps module.", C_FG, C_BG, 224, TA_LEFT);
            text_bc(&FONT_S, 10, 80, "Add one in the editor.", C_DIM, C_BG, 224, TA_LEFT);
            text_bc(&FONT_S, 10, 222, "SEQ  back", C_HINT, C_BG, 224, TA_LEFT);
        }
        return;
    }
    len = seq_len(mod);
    pos = eng_steps_pos((uint32_t)mod);
    fmt_int(num, seq_pg * 16 + 1);              /* 1-16 OF 32  RATE 1/16  SW 66% */
    p = put(line, num);
    *p++ = '-';
    fmt_int(num, seq_pg * 16 + 16 < len ? seq_pg * 16 + 16 : len);
    p = put(p, num);
    p = put(p, " OF ");
    fmt_int(num, len);
    p = put(p, num);
    p = put(p, "  RATE ");
    p = put_param(p, &DEFS[T_STEPS], STEPS_P_RATE, eng_get_param((uint32_t)mod, STEPS_P_RATE));
    {
        int32_t sw = (eng_get_param((uint32_t)mod, STEPS_P_SWING) + 32768) >> 16;
        if (sw > 50) {
            p = put(p, "  SW ");
            fmt_int(num, sw);
            p = put(p, num);
            *p++ = '%';
        }
    }
    *p = 0;
    if (full)
        lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
    text_bc(&FONT_S, 8, 28, line, C_FG, C_BG, 224, TA_LEFT);
    for (i = 0; i < 16; i++) {
        int k = seq_pg * 16 + i;
        uint32_t x = 8u + 14u * (uint32_t)i, s = k < len ? (uint32_t)eng_steps_get((uint32_t)mod, (uint32_t)k) : 0u;
        if (map >= 0 && k < len) {               /* a drum track: the row's hit, as a step byte (on, accent, chance) */
            uint32_t w = eng_steps_note((uint32_t)mod, (uint32_t)k, seq_row_note(map, seq_row));
            s = w ? 1u | (((w >> 19) & 127u) == ACCENT_VEL ? 2u : 0u) | (((w >> 26) & 31u) > 19u ? 19u : (w >> 26) & 31u) << 2 : 0u;
        }
        uint32_t h = 34u, fill = (s & 1u) ? h * (100u - 5u * ((s >> 2) & 31u)) / 100u : 0u;
        uint16_t c = (s & 2u) ? C_ACC : C_FG;
        if (k >= len) {
            lcd_fill(x, 52, 12, h, C_BG);
            lcd_fill(x, 52 + h + 3u, 12, 3, C_BG);
            continue;
        }
        lcd_fill(x, 52, 12, h - fill, (i & 3) ? C_TRACK : C_TRACK);   /* the beats a shade lighter */
        if (fill)
            lcd_fill(x, 52 + h - fill, 12, fill, c);
        lcd_fill(x, 52 + h + 3u, 12, 3, k == pos ? C_ACC : C_BG);
        {                                        /* step entry's cursor: a frame round its cell */
            uint16_t fc = seq_entry() && k == seq_cur ? C_ACC : C_BG;
            lcd_fill(x - 1u, 50, 14, 1, fc);
            lcd_fill(x - 1u, 51, 1, h + 1u, fc);
            lcd_fill(x + 12u, 51, 1, h + 1u, fc);
        }
    }
    seq_shown_pos = (int8_t)pos;
    if (seq_entry()) {                           /* step entry: the chord being played, what the cursor's step holds */
        const uint32_t *w;
        int i, nn = eng_steps_notes((uint32_t)mod, &w), any = 0;
        uint32_t k = (uint32_t)seq_cur;
        fmt_int(num, seq_cur + 1);
        p = put(put(line, "WRITE "), num);
        p = put(p, "  ");
        for (i = 0; i < ent_n && p < line + 30; i++) {
            p = seq_note_name(p, ent_note[i]);
            *p++ = ' ';
        }
        *p = 0;
        text_bc(&FONT_M, 8, 100, line, C_FG, C_BG, 224, TA_LEFT);
        p = put(line, "ON THE STEP: ");
        for (i = 0; i < nn && p < line + 32; i++)
            if ((w[i] & 63u) == k) {
                p = seq_note_name(p, (w[i] >> 12) & 127u);
                *p++ = ' ';
                any = 1;
            }
        if (!any)
            p = put(p, (eng_steps_get((uint32_t)mod, k) & 0x80) ? "TIED" : "EMPTY");
        *p = 0;
        text_bc(&FONT_S, 8, 128, line, C_DIM, C_BG, 224, TA_LEFT);
        if (full)
            text_bc(&FONT_S, 8, 222, "ENV+OCT rest  LFO+OCT tie  SEL move", C_HINT, C_BG, 228, TA_LEFT);
        return;
    }
    if (map >= 0) {                              /* a drum track: its map's rows, two columns of four (black keys 1-8) */
        for (t = 0; t < ENG_DRUM_ROWS; t++) {
            uint32_t x = 12u + 112u * (t / 4u), y = 100u + 16u * (t % 4u);
            fmt_int(num, (int32_t)t + 1);
            p = put(line, num);
            *p++ = ' ';
            seq_row_name(map, t, name);
            put(p, name)[0] = 0;
            text_bc(&FONT_S, x, y, line, t == seq_row ? C_ACC : C_FG, C_BG, 108, TA_LEFT);
        }
        fmt_int(num, (int32_t)seq_trk + 1);
        p = put(line, "TRACK ");
        p = put(p, num);
        *p++ = '/';
        fmt_int(num, eng_steps_count());
        p = put(p, num);
        if (seq_armed_trk() == (int)seq_trk)    /* the track row's marks: ARMED (#179), MUTED */
            p = put(p, "  ARMED");
        if (eng_steps_muted((uint32_t)mod))
            p = put(p, "  MUTED");
        put(p, seq_armed_trk() == (int)seq_trk || eng_steps_muted((uint32_t)mod) ? "" : "  ALGO: TRACK")[0] = 0;
        text_bc(&FONT_S, 12, 172, line, C_DIM, C_BG, 216, TA_LEFT);
        if (full)
            text_bc(&FONT_S, 8, 222, seq_rec ? "BLACK  hit on a row   ENV  accent" : "BLACK row  WHITE hit  ENV acc  K2 vel", C_HINT, C_BG, 228, TA_LEFT);
        return;
    }
    for (t = 0; t < 12u; t++) {                  /* the tracks, two columns of six */
        uint32_t x = 12u + 112u * (t / 6u), y = 100u + 16u * (t % 6u);
        p = line;
        if (t < (uint32_t)eng_steps_count()) {
            int tm = eng_steps_module(t);
            fmt_int(num, (int32_t)t + 1);
            p = put(p, num);
            *p++ = ' ';
            seq_name(t, name);
            p = put(p, name);
            if (eng_steps_muted((uint32_t)tm))
                p = put(p, " M");
            if ((int)t == seq_armed_trk())       /* (#179) */
                p = put(p, " ARM");
        }
        *p = 0;
        text_bc(&FONT_S, x, y, line, t == seq_trk ? C_ACC : t < (uint32_t)eng_steps_count() && !eng_steps_muted((uint32_t)eng_steps_module(t)) ? C_FG : C_DIM, C_BG, 108, TA_LEFT);
    }
    if (full)
        text_bc(&FONT_S, 8, 222, seq_kbd() ? "KEYS record   OCT octave   REC stop" : seq_rec ? "BLACK  hit    ENV+BLACK  accent" : "ENV accent   HOLD+SEL %   K1 note   K2 vel", C_HINT, C_BG, 228, TA_LEFT);
}

/* the main loop, every pass: the LEDs, and the cells when the playhead moved */
static void seq_poll(void)
{
    static int8_t entry_was = -1;
    int mod;
    seq_take();
    if (page != PAGE_SEQ) {
        entry_was = -1;
        return;
    }
    if ((seq_kbd() ? seq_entry() : -1) != entry_was) {   /* PLAY / stop while REC records the armed track: step entry or live */
        entry_was = (int8_t)(seq_kbd() ? seq_entry() : -1);
        ent_n = 0;
        header_draw();
        ui_dirty = 2;
    }
    seq_leds();
    mod = seq_module();
    if (mod >= 0 && eng_steps_pos((uint32_t)mod) != seq_shown_pos && !ui_dirty)
        ui_dirty = 1;
}
