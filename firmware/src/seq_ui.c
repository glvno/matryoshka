/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The SEQ page (#83), after menu.c and before main.c: the patch's Steps tracks, each on an 8 x 16 grid (seq_grid_draw):
 * a drum track's Drum map rows, a melodic track's piano roll (#241). The page's 16 steps run across, OCT- / OCT+ page
 * through a track longer than 16 steps (17-32 ...).
 *
 *   SEQ             opens / closes the page; held + a black key: mute / unmute that track (from any page, not saved);
 *                   held + REC (here): clear the selected track, asked first (REC again within 3 s: seq_clear_press)
 *   ALGO            steps through the tracks (not while REC records the armed one)
 *   SELECT          the selected row, a row a click (a drum track: clamped at the first and the last; the roll scrolls
 *                   its window of 8 pitches when it reaches an edge); on a drum track with a white key held: that
 *                   step's chance (the roll: always the row)
 *   white keys      the 16 steps of the page: the selected row's note on the step on / off (FX held: its accent). A held
 *                   white key + K2: its velocity; + SELECT (a drum track) or K3 (the roll; the owner, 2026-10-24): the
 *                   note's chance, 100 % .. 5 % in steps of 5; on the roll + K1: its pitch (a semitone a click, past the
 *                   step's other notes; the selected row follows it). Turning a knob on a held step undoes the press:
 *                   the track's notes as they were, the note there.
 *   REC             live recording on / off (its LED is lit while on); it acts on its release
 *   PRESET          the patch's pattern (#375, D-541): running, each track takes it at the end of its pass (the bar shows
 *                   P03>P04 until then); stopped, at once. The bar shows the pattern (and the song while one plays)
 *   SEL tapped      (pressed and let go with no key): the SONG page (below)
 *
 * A drum track (its keys out into a Drum map; the #139 follow-up, the owner's grid of 2026-10-23): the rows are the map's
 * rows. Black keys 1..8 pick the row (stopped: it sounds); with REC on they are hits on their rows instead (heard; while
 * running into the nearest step), the row picked stays. Off this page the keys play a Drum map the same way (panel.c
 * panel_key).
 *
 * A melodic track (the owner, 2026-10-23, #241): the piano roll, 8 chromatic pitches of the track's range (C-1..G9, MIDI 0..127)
 * top to bottom, labelled C4, C#4 ..., the C rows tinted. A chord is several cells in one column; a note longer than a
 * step runs on in dim cells joined to its first. A dim triangle over (under) a step: a note sounds there above (below)
 * the 8 rows shown. It opens around the track's notes (the median pitch on the middle
 * row; an empty track: C of the keys' octave).
 *   black keys      pick the track (1..11, patch order)
 *   SEL held + a key  the pen: the selected row jumps to that key's pitch (the keys' octave; the window scrolls to show
 *                   it) and it sounds. FX held + OCT- / OCT+: the keys' octave (the pen's)
 *   LFO held + a white key  ties the selected row's note through that step (the note sounding on the step before goes
 *                   on through it, a note of its own there joins it); again on a tied step: cut before it
 *
 * Arming and recording from the keys (#139, the editor's #134 / #135):
 *   REC held + a black key (any page): arm that track, again: disarm. While a track is armed the keys (and MIDI notes)
 *                   play through it to what it plays (engine.c eng_arm); the device pages' info line says ARM and its name,
 *                   the SEQ page ARM in the bar and ARMED on the track's line (#179). Black key n is track n here also on a
 *                   drum track's page, where the keys alone pick rows; a key past the tracks says NO TRACK n.
 *   REC with a track armed: stopped, the SEQ page opens on it with REC on: the grid as without REC, but the black keys
 *                   sound (a drum track: hits on its rows; the roll: their own pitch), nothing recorded; the white keys
 *                   place steps. Running, the page stays: the keys play and the engine records them live onto the
 *                   nearest step (eng_steps_rec); on a melodic track's roll all 27 keys are its keyboard (seq_kbd) and OCT-
 *                   / OCT+ the octave. REC again, or another arm, ends it; leaving the page stopped ends it (a live take
 *                   goes on).
 *   REC with nothing armed: on a melodic track's roll it arms that track and records it as above (the owner's 1.2.0
 *                   device check: the keys are notes there, not track hits), REC off disarms it again (seq_rec_arms);
 *                   else the black keys record hits; from another page it opens this one on the selected track if it
 *                   is a drum track, else the first drum track (seq_rec_aim), so the hits are seen landing.
 *
 * Key LEDs: the selected row's notes on the page bright, the step playing at the mid level (dark on a step that is on),
 * a drum track's selected row bright and rows with hits dim, else the selected track's black key bright, tracks with
 * notes glowing, muted ones blinking; the roll's keyboard (a live take): the keys held bright, every C dim. The top bar
 * shows the track's name (STEPS n without one). Edits go into the running patch (SAVE keeps them) and to the editor. */

#define PAGE_SEQ 8u
#define BTN_SEQ 11u
#define BTN_REC 13u
#define BTN_ENV 4u                      /* ENV: the environment (#197) */
#define BTN_ACC 2u                      /* FX: the SEQ page's accent key (#197; it was ENV) */
#define BTN_PEN 3u                      /* SEL: held, the roll's pen; tapped (no key meanwhile), the SONG page (panel.c) */
#define PAGE_SONG 11u                   /* the SONG page (#375): seq_ui.c song_draw */
#define BTN_LFO 5u                      /* LFO: the roll's tie key */

static uint8_t seq_trk;                 /* the selected track (index among the patch's Steps modules) */
static uint8_t seq_pg;                  /* the page of 16 steps */
static uint8_t seq_rec;                 /* REC: 1 black keys record hits, 2 the keys record into the armed track (#139) */
static int8_t seq_rec_arms = -1;        /* the module REC armed itself on the roll (seq_rec_press), disarmed when REC ends */
static uint8_t seq_row;                 /* the grid's selected row: a Drum map's row, or the roll's (0 the top: its highest pitch) */
static uint8_t seq_roll_lo = 57;        /* the roll (#241): the pitch of its lowest row (0..120) */
static int8_t seq_roll_trk = -1;        /* the track its window was opened for (-1: open it again), and the patch then */
static uint32_t seq_roll_gen;
static uint32_t ent_keys;               /* the keys held while they are the armed track's keyboard (bit n: key n) */
static int8_t seq_held = -1;            /* the step whose white key is held (SELECT / the roll's K3 its chance, K1 / K2 its values), -1 none */
static uint32_t seq_held_notes[TRACK_NOTES_MAX];   /* the track's notes before the held step's press switched it */
static uint8_t seq_held_n;
static uint8_t seq_held_turned;         /* a knob turned while it is held (the press's switch is undone once) */
static int8_t seq_shown_pos = -2;       /* the playhead as last drawn */
static const char *seq_msg_due;         /* a key's message for the bar, shown by the loop's pass (a key never draws: D-228) */
static uint16_t seq_msg_ms;             /* ... its time on show (0: 800 ms) */
static char seq_msg_buf[28];            /* ... a message made up of a track's name */
static uint32_t seq_clear_at;           /* SEQ held + REC (#231): fm1_ms | 1 of the press that asked, 0 none */
static uint32_t seq_clear_gen;          /* ... the patch then */
static uint8_t seq_clear_trk;           /* ... the track it asked for */
static uint32_t seq_pen_ms;             /* fm1_ms | 1 of the last key that was the pen (SEL held: its release then opens
                                         * nothing, D-541), 0 none */
static uint32_t seq_shown_pat = 0xFFFFFFFFu;   /* the bar's pattern, queued pattern, song and entry as drawn */

/* note key n (0 = F3) -> its white key's step on the page (0..15) or its black key's track (0..10), else -1 */
static int seq_white(uint32_t n)
{
    static const int8_t W[12] = {0, -1, 1, -1, 2, -1, 3, 4, -1, 5, -1, 6};   /* from F: F F# G G# A A# B C C# D D# E */
    return n < 27u && W[n % 12u] >= 0 ? (int)(n / 12u) * 7 + W[n % 12u] : -1;
}
static int seq_black(uint32_t n)
{
    static const int8_t B[12] = {-1, 0, -1, 1, -1, 2, -1, -1, 3, -1, 4, -1};
    return n < 27u && B[n % 12u] >= 0 ? (int)(n / 12u) * 5 + B[n % 12u] : -1;
}

static int seq_module(void) { return eng_steps_module(seq_trk); }

/* a drum track (the #139 follow-up): the Drum map the selected track plays (-1: none, a melodic track: the roll), a row's
 * note and name (the binary's, else ROW n) */
static int seq_map(void)
{
    int mod = seq_module();
    return mod >= 0 ? eng_steps_drummap((uint32_t)mod) : -1;
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
/* the note row r of the grid edits: a Drum map's row's, or the roll's pitch */
static uint32_t seq_grid_note(int map, uint32_t r) { return map >= 0 ? seq_row_note(map, r) : seq_roll_lo + 7u - r; }

/* the armed track's index among the Steps modules, -1 none */
static int seq_armed_trk(void)
{
    int t, a = eng_armed();
    for (t = 0; a >= 0 && t < eng_steps_count(); t++)
        if (eng_steps_module((uint32_t)t) == a)
            return t;
    return -1;
}
/* the keys are the armed melodic track's keyboard: REC records it on this page while the transport runs (a live take); a
 * drum track's grid takes the black keys as hits instead (seq_key) */
static int seq_kbd(void)
{
    return seq_rec == 2u && page == PAGE_SEQ && eng_armed() >= 0 && eng_steps_drummap((uint32_t)eng_armed()) < 0 && eng_transport_running();
}

static int32_t seq_len(int mod)
{
    return mod < 0 ? 16 : clampi(eng_steps_len((uint32_t)mod), 1, TRACK_STEPS);   /* (the pattern's own length, else the track's) */
}

/* a number as two digits (a pattern, an entry: 01..64) */
static char *put2(char *p, int32_t v)
{
    v = clampi(v, 0, 99);
    *p++ = (char)('0' + v / 10);
    *p++ = (char)('0' + v % 10);
    *p = 0;
    return p;
}
/* the pattern state as the SEQ bar shows it: the selected track's pattern playing, the one it takes at the end of its pass
 * and, while a song plays, its song and entry (one word, to see a change) */
static uint32_t seq_pat_state(void)
{
    int mod = seq_module(), pl = mod >= 0 ? eng_pattern_playing((uint32_t)mod) : eng_pattern(), q = mod >= 0 ? eng_pattern_queued((uint32_t)mod) : -1;
    return (uint32_t)(pl & 0xFF) | (uint32_t)(q & 0xFF) << 8 | (uint32_t)eng_song() << 16 | (uint32_t)(mod >= 0 ? eng_song_entry((uint32_t)mod) & 0xFF : 0xFF) << 24;
}
/* " P03", " P03>P04" (waiting for the end of the pass), " S1 P03" (song 1 plays) */
static char *seq_pat_text(char *p)
{
    uint32_t st = seq_pat_state();
    int pl = (int)(st & 0xFFu), q = (int)(st >> 8 & 0xFFu);
    if (pl == 0xFF)
        return p;
    if (eng_song()) {
        p = put(p, " S");
        *p++ = (char)('0' + eng_song());
    }
    p = put2(put(p, " P"), pl + 1);
    if (q != 0xFF && q != pl)
        p = put2(put(p, ">P"), q + 1);
    return p;
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

/* the roll (#241): pitch p on the selected row; the window moves only if p is outside it (centre: p on its middle row) */
static void seq_roll_show(int32_t p, int centre)
{
    int32_t lo = seq_roll_lo;
    p = clampi(p, 0, 127);
    if (centre)
        lo = p - 3;
    else if (p < lo)
        lo = p;
    else if (p > lo + 7)
        lo = p - 7;
    seq_roll_lo = (uint8_t)clampi(lo, 0, 120);
    seq_row = (uint8_t)(seq_roll_lo + 7 - p);
}
/* the roll opened for the selected track, once per track and patch: around its notes (the median pitch), an empty track
 * around C of the keys' octave. Changes state only (a key handler may call it) */
static void seq_roll_aim(int mod)
{
    const uint32_t *ws;
    int n, i;
    int32_t c = STEP_NOTE + 12 * octave;
    if (mod < 0 || (seq_roll_trk == (int8_t)seq_trk && seq_roll_gen == pages_gen()))
        return;
    seq_roll_trk = (int8_t)seq_trk;
    seq_roll_gen = pages_gen();
    n = eng_steps_notes((uint32_t)mod, &ws);
    if (n > 0) {                                 /* the lowest pitch with at least half the notes at or under it */
        int below = 0;
        for (c = 0; c < 127; c++) {
            for (i = 0; i < n; i++)
                below += ((ws[i] >> 12) & 127u) == (uint32_t)c;
            if (2 * below >= n)
                break;
        }
    }
    seq_roll_show(c, 1);
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

/* does step k of `mod` start this note */
static int seq_step_has(int mod, uint32_t k, uint32_t note)
{
    return eng_steps_note((uint32_t)mod, k, note) != 0u;
}

static void seq_leds(void)
{
    int mod = seq_module(), pos = mod >= 0 ? eng_steps_pos((uint32_t)mod) : -1, arm = seq_armed_trk();
    int blink = (fm1_ms / 200u) & 1u, kbd = seq_kbd(), map = seq_map();
    uint32_t n, rows = 0, rn = mod >= 0 ? seq_grid_note(map, seq_row) : 0u;
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
        if (kbd) {                               /* the armed track's keyboard: the keys held bright, every C dim (to find */
            uint32_t note = (uint32_t)clampi(53 + (int32_t)n + 12 * octave, 0, 127);   /* your place) */
            lit = (int)(ent_keys >> n & 1u);
            dim = !lit && note % 12u == 0u;
        } else if (map >= 0 && b >= 0) {        /* a drum track's rows: the selected one bright (blinking: muted), the */
            if (b < (int)ENG_DRUM_ROWS)          /* others with hits dim */
                lit = (uint32_t)b == seq_row && (!eng_steps_muted((uint32_t)mod) || blink), dim = (uint32_t)b != seq_row && (rows >> b & 1u);
        } else if (w >= 0 && mod >= 0) {        /* the selected row's notes on the page's steps */
            int k = seq_pg * 16 + w, on = k < seq_len(mod) && seq_step_has(mod, (uint32_t)k, rn);
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
    seq_roll_trk = -1;                           /* (a roll opens around its notes again) */
    if (page != PAGE_SEQ)
        return;                                  /* (from another page: the caller's page_set draws the SEQ page whole) */
    header_draw();
    ui_dirty = 2;
}

/* SELECT with no step held (the owner, 2026-10-23): the selected row, d rows down; a drum grid clamps at the first and the
 * last row (no wrap; REC on or off), the roll scrolls its window at an edge (#241). Only the two names are redrawn, or a
 * scroll's rows (seq_grid_draw) */
static void seq_row_step(int32_t d)
{
    int mod = seq_module();
    if (mod >= 0 && seq_map() < 0) {
        seq_roll_aim(mod);
        seq_roll_show((int32_t)seq_grid_note(-1, seq_row) - d, 0);
    } else
        seq_row = (uint8_t)clampi((int32_t)seq_row + d, 0, (int32_t)ENG_DRUM_ROWS - 1);
    ui_dirty = ui_dirty ? ui_dirty : 1;
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

/* a mute or an arm changed: redrawn in place, nothing cleared first (#179). On the SEQ page its track line and, after the
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

static void seq_sync(int mod);

/* the track's notes as they are before a press switches one (a knob turned on the held step brings them back) */
static void seq_held_keep(int mod)
{
    const uint32_t *ws;
    int i, nn = eng_steps_notes((uint32_t)mod, &ws);
    seq_held_n = (uint8_t)(nn > 0 ? nn : 0);
    for (i = 0; i < nn; i++)
        seq_held_notes[i] = ws[i];
    seq_held_turned = 0;
}

/* the note of `note` that sounds on step k without starting there (a note through it), its index; -1 none */
static int seq_through(const uint32_t *ws, int nn, uint32_t k, uint32_t note)
{
    int i;
    for (i = 0; i < nn; i++)
        if (((ws[i] >> 12) & 127u) == note && (ws[i] & 63u) < k && k <= (ws[i] & 63u) + ((ws[i] >> 6) & 63u))
            return i;
    return -1;
}

/* the roll's white key (#241): the selected pitch's note on step k on / off; a press on a step its note runs through cuts
 * that note before it and starts one there */
static void seq_roll_toggle(int mod, uint32_t k, uint32_t note, uint32_t vel)
{
    uint32_t w[TRACK_NOTES_MAX];
    const uint32_t *ws;
    int i, nn = eng_steps_notes((uint32_t)mod, &ws), t = seq_through(ws, nn, k, note);
    if (t < 0) {
        eng_steps_toggle((uint32_t)mod, k, note, vel);
        return;
    }
    for (i = 0; i < nn; i++)
        w[i] = ws[i];
    w[t] = (w[t] & ~(63u << 6)) | (k - (w[t] & 63u) - 1u) << 6;     /* (length k - at) */
    (void)eng_steps_set_notes((uint32_t)mod, w, (uint32_t)nn);
    eng_steps_toggle((uint32_t)mod, k, note, vel);
}

/* LFO held + a white key on the roll (#241): the selected pitch tied through step k. Its note sounding on the step before
 * goes on through k (a note of its own on k joins it); on a step it already runs through: cut before it */
static void seq_roll_tie(int mod, uint32_t k, uint32_t note)
{
    uint32_t w[TRACK_NOTES_MAX];
    const uint32_t *ws;
    int i, m, nn = eng_steps_notes((uint32_t)mod, &ws), t = seq_through(ws, nn, k, note), prev = -1;
    for (i = 0; i < nn; i++)
        w[i] = ws[i];
    if (t >= 0) {                                /* tied already: the note ends before k */
        w[t] = (w[t] & ~(63u << 6)) | (k - (w[t] & 63u) - 1u) << 6;
        seq_msg_due = "TIE OFF";
    } else {
        for (i = 0; k > 0u && i < nn; i++)       /* the note of this pitch sounding on k - 1 */
            if (((w[i] >> 12) & 127u) == note && (w[i] & 63u) <= k - 1u && k - 1u <= (w[i] & 63u) + ((w[i] >> 6) & 63u))
                prev = i;
        if (prev < 0) {
            seq_msg_due = "NOTHING TO TIE";
            return;
        }
        {
            uint32_t at = w[prev] & 63u, end = k + 1u;   /* (one past its last step) */
            for (i = m = 0; i < nn; i++) {       /* a note of its own on k joins it */
                if (i != prev && ((w[i] >> 12) & 127u) == note && (w[i] & 63u) == k) {
                    end = k + 1u + ((w[i] >> 6) & 63u);
                    continue;
                }
                w[m++] = w[i];
                if (i == prev)
                    prev = m - 1;
            }
            nn = m;
            if (end > at + TRACK_STEPS)         /* (a note lasts 64 steps at most, and may run past the last) */
                end = at + TRACK_STEPS;
            w[prev] = (w[prev] & ~(63u << 6)) | (end - at - 1u) << 6;
        }
        seq_msg_due = "TIED";
    }
    (void)eng_steps_set_notes((uint32_t)mod, w, (uint32_t)nn);
}

/* SEL held + a key on the roll (#241): the pen. The selected row is that key's pitch (the keys' octave; out of the window: it
 * opens around it), and the pitch sounds */
static void seq_pen(int mod, uint32_t n)
{
    int32_t note = clampi(53 + (int32_t)n + 12 * octave, 0, 127);
    seq_pen_ms = fm1_ms | 1u;
    seq_roll_show(note, note < seq_roll_lo || note > seq_roll_lo + 7);
    (void)eng_steps_hit_note((uint32_t)mod, (uint32_t)note, 0, 0);
}

/* a key on the SEQ page (n: note key 0..26). Drum track (the #139 follow-up): black keys 1..8 the Drum map's rows (stopped:
 * heard; REC on: a hit on the row, into the nearest step while it plays), white keys that row's hit on the page's steps
 * (FX held: an accent). The roll (#241): black keys the tracks (REC on: heard; REC with nothing armed: a hit on that
 * track), SEL + a key the pen, white keys the selected pitch's notes (FX held: an accent; LFO held: its tie) */
static void seq_key(uint32_t n, int down)
{
    int w = seq_white(n), b = seq_black(n), mod = seq_module(), map = seq_map();
    int fx = (int)(panel_held >> BTN_ACC & 1u);
    if (!down) {
        if (w >= 0 && seq_held == seq_pg * 16 + w)
            seq_held = -1;
        return;
    }
    if (mod < 0)
        return;
    if (map < 0) {
        seq_roll_aim(mod);
        if (panel_held >> BTN_PEN & 1u) {
            seq_pen(mod, n);
            ui_dirty = ui_dirty ? ui_dirty : 1;
            return;
        }
    }
    if (b >= 0) {
        if (map < 0) {                           /* the roll: the tracks; REC on the armed track: the key heard */
            if (seq_rec == 2u) {
                (void)eng_steps_hit_note((uint32_t)mod, (uint32_t)clampi(53 + (int32_t)n + 12 * octave, 0, 127), 0, 0);
                return;
            }
            if (b >= eng_steps_count())
                return;
            if (seq_rec) {                  /* a hit: heard now, into the nearest step while the track plays */
                int bm = eng_steps_module((uint32_t)b), k = eng_steps_hit((uint32_t)bm, 0, 1);
                if (k >= 0)
                    seq_put(bm, (uint32_t)k, (uint32_t)eng_steps_get((uint32_t)bm, (uint32_t)k));
                if ((uint32_t)b != seq_trk)
                    seq_select((uint32_t)b);
                ui_dirty = ui_dirty ? ui_dirty : 1;
            } else
                seq_select((uint32_t)b);
            return;
        }
        if (b >= (int)ENG_DRUM_ROWS)
            return;
        if (seq_rec) {                           /* REC on: a hit on that row, the row picked stays (only its cell is drawn) */
            if (eng_steps_hit_note((uint32_t)mod, seq_row_note(map, (uint32_t)b), fx, 1) >= 0)
                seq_sync(mod);
        } else {                                 /* else the row picked (stopped: heard); its name and the last one redrawn */
            seq_row = (uint8_t)b;
            if (!eng_transport_running())
                (void)eng_steps_hit_note((uint32_t)mod, seq_row_note(map, seq_row), 0, 0);
        }
        ui_dirty = ui_dirty ? ui_dirty : 1;
        return;
    }
    if (w < 0)
        return;
    {
        int k = seq_pg * 16 + w;
        uint32_t note = seq_grid_note(map, seq_row), have;
        if (k >= seq_len(mod))
            return;
        seq_held_keep(mod);
        if (map < 0 && (panel_held >> BTN_LFO & 1u)) {   /* the roll, LFO held: the tie (not a held step) */
            seq_roll_tie(mod, (uint32_t)k, note);
            seq_sync(mod);
            ui_dirty = ui_dirty ? ui_dirty : 1;
            return;
        }
        have = eng_steps_note((uint32_t)mod, (uint32_t)k, note);
        if (fx && have)                          /* FX held: the accent on / off */
            eng_steps_overdub((uint32_t)mod, (have & ~(127u << 19)) | (uint32_t)(((have >> 19) & 127u) == ACCENT_VEL ? STEP_VEL : ACCENT_VEL) << 19);
        else if (map < 0)
            seq_roll_toggle(mod, (uint32_t)k, note, fx ? ACCENT_VEL : STEP_VEL);
        else
            eng_steps_toggle((uint32_t)mod, (uint32_t)k, note, fx ? ACCENT_VEL : STEP_VEL);
        seq_sync(mod);
        seq_held = (int8_t)k;
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
}

/* the held step's note in the selected row, after the press's switch is undone once (an edit means it should play): its
 * note word, 0 when it cannot be there */
static uint32_t seq_grid_held(int map, int mod)
{
    uint32_t note = seq_grid_note(map, seq_row), w;
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

/* SELECT (a drum track) or K3 (the roll) turned with a step held: the selected row's note's chance, 5 % a click */
static void seq_chance(int32_t clicks)
{
    int mod = seq_module(), map = seq_map();
    uint32_t w;
    int32_t code;
    char m[24], num[8];
    if (mod < 0 || seq_held < 0 || !(w = seq_grid_held(map, mod)))
        return;
    code = clampi((int32_t)((w >> 26) & 31u) - clicks, 0, 19);
    eng_steps_overdub((uint32_t)mod, (w & ~(31u << 26)) | (uint32_t)code << 26);
    seq_sync(mod);
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

/* the held step's note: STEP n  C#4  VEL 100 (a drum track: no note, it is the row's) */
static void seq_held_msg(int map, uint32_t w)
{
    char m[32], num[8], *p;
    fmt_int(num, seq_held + 1);
    p = put(put(m, "STEP "), num);
    if (map < 0)
        p = seq_note_name(put(p, "  "), (w >> 12) & 127u);
    p = put(p, "  VEL ");
    fmt_int(num, (int32_t)((w >> 19) & 127u));
    put(p, num)[0] = 0;
    ui_msg(m, 1200);
}

/* K1 / K2 turned with a step held: the selected row's note's velocity (K2, 1 a click, 5 when turned fast); on the roll K1
 * its pitch, a semitone a click past the step's other notes, the selected row following it (a drum track: its note is
 * the row's) */
static void seq_value(int32_t note_clicks, int32_t vel_clicks, int fast)
{
    int mod = seq_module(), map = seq_map();
    uint32_t w;
    if (mod < 0 || seq_held < 0 || (!vel_clicks && (!note_clicks || map >= 0)))
        return;
    if (map < 0)
        seq_roll_aim(mod);
    if (!(w = seq_grid_held(map, mod)))
        return;
    if (vel_clicks) {
        int32_t vel = clampi((int32_t)((w >> 19) & 127u) + vel_clicks * (fast ? 5 : 1), 1, 127);
        w = (w & ~(127u << 19)) | (uint32_t)vel << 19;
        eng_steps_overdub((uint32_t)mod, w);
    }
    if (note_clicks && map < 0) {
        int32_t p = (int32_t)((w >> 12) & 127u), d = note_clicks < 0 ? -1 : 1, c = note_clicks < 0 ? -note_clicks : note_clicks, q = p;
        while (c > 0 && q + d >= 0 && q + d <= 127) {   /* (a pitch the step already holds is stepped over) */
            q += d;
            if (!eng_steps_note((uint32_t)mod, (uint32_t)seq_held, (uint32_t)q))
                c--, p = q;
        }
        if (p != (int32_t)((w >> 12) & 127u)) {
            eng_steps_toggle((uint32_t)mod, (uint32_t)seq_held, (w >> 12) & 127u, STEP_VEL);   /* (off: it is there) */
            w = (w & ~(127u << 12)) | (uint32_t)p << 12;
            eng_steps_overdub((uint32_t)mod, w);
            seq_roll_show(p, 0);
        }
    }
    seq_sync(mod);
    seq_held_msg(map, w);
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
    ui_dirty = ui_dirty < 2u ? 1 : 2;           /* (the grid redraws its cells in place) */
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
    if (seq_rec_arms >= 0 && (eng_arm_mask_get() >> seq_rec_arms & 1u)) {
        eng_arm_mask(eng_arm_mask_get() & ~((uint64_t)1 << seq_rec_arms));
        m1_arms_now((uint32_t)eng_arm_mask_get(), (uint32_t)(eng_arm_mask_get() >> 32));
    }
    seq_rec_arms = -1;
    seq_rec = 0;
    ent_keys = 0;
    ui_dirty = 2;
}

/* REC let go (panel.c; not after REC held + a black key armed a track): off, or on: with a track armed into it (stopped:
 * its grid with REC on, the caller opens the SEQ page: seq_rec_page), else the black keys record hits */
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
    if (t < 0 && page == PAGE_SEQ && seq_module() >= 0 && seq_map() < 0) {
        /* nothing armed, a melodic track's roll shown (the owner's 1.2.0 device check): REC records that track, so the
         * keys play its pitches and a running take records them, as if it were armed; REC off disarms it again */
        int mod = seq_module();
        eng_arm_mask(eng_arm_mask_get() | (uint64_t)1 << mod);
        m1_arms_now((uint32_t)eng_arm_mask_get(), (uint32_t)(eng_arm_mask_get() >> 32));
        seq_rec_arms = (int8_t)mod;
        t = seq_armed_trk();
    }
    if (t < 0) {
        seq_rec = 1;
        ui_msg("REC: BLACK KEYS RECORD", 1000);
        ui_dirty = 2;
        return;
    }
    seq_rec = 2;                                 /* the armed track's grid or roll, REC on (#241: no step entry) */
    eng_steps_rec((uint32_t)eng_armed(), 1);
    if ((uint32_t)t != seq_trk) {
        seq_pg = 0;
        seq_row = 0;
        seq_roll_trk = -1;
    }
    seq_trk = (uint8_t)t;
    seq_held = -1;
    seq_name((uint32_t)t, name);
    put(put(m, "REC "), name)[0] = 0;
    ui_msg(m, 1000);
    ui_dirty = 2;
}

/* REC about to open the SEQ page with nothing armed (panel.c, before page_set): the selected track if it is a drum track,
 * else the first drum track, so the hits are seen landing on its grid */
static void seq_rec_aim(void)
{
    int t, n = eng_steps_count();
    if (seq_rec || eng_armed() >= 0 || (seq_trk < (uint32_t)n && seq_map() >= 0))
        return;
    for (t = 0; t < n; t++)
        if (eng_steps_drummap((uint32_t)eng_steps_module((uint32_t)t)) >= 0) {
            seq_trk = (uint8_t)t;
            seq_pg = 0;
            seq_row = 0;
            seq_held = -1;
            return;
        }
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

/* SEQ held + REC on the SEQ page (#231, the owner, 2026-10-23): clear the selected track, as FACTORY RESET asks first.
 * The first press asks in the bar (CLEAR name? REC AGAIN, 3 s); REC again within them, SEQ still held and nothing else
 * pressed or turned meanwhile (seq_clear_cancel), removes all its notes: a drum grid's hits and a roll's notes, the cells
 * cleared in place, the editor told (one step in its undo). A key handler: state only, the bar is the loop's (D-228) */
#define SEQ_CLEAR_MS 3000u
static void seq_clear_press(void)
{
    int mod = seq_module();
    char name[TRACK_NAME_MAX + 8];
    if (mod < 0)
        return;
    seq_name(seq_trk, name);
    if (seq_clear_at && seq_clear_trk == seq_trk && seq_clear_gen == pages_gen() && fm1_ms - (seq_clear_at & ~1u) < SEQ_CLEAR_MS) {
        static const uint32_t none[1];
        seq_clear_at = 0;
        (void)eng_steps_set_notes((uint32_t)mod, none, 0);
        seq_held = -1;
        seq_sync(mod);
        put(put(seq_msg_buf, name), " CLEARED")[0] = 0;
        seq_msg_due = seq_msg_buf;
        seq_msg_ms = 1200;
        ui_dirty = ui_dirty ? ui_dirty : 1;      /* (the cells that had notes) */
        return;
    }
    seq_clear_at = fm1_ms | 1u;
    seq_clear_gen = pages_gen();
    seq_clear_trk = seq_trk;
    put(put(put(seq_msg_buf, "CLEAR "), name), "? REC AGAIN")[0] = 0;   /* (26 characters at most: a name has 8) */
    seq_msg_due = seq_msg_buf;
    seq_msg_ms = SEQ_CLEAR_MS;
}
/* anything else pressed or turned, or SEQ let go, while the clear asks: not cleared */
static uint32_t song_del_at;
static void seq_clear_cancel(void)
{
    song_del_at = 0;                             /* (the SONG page's delete asks the same way) */
    if (!seq_clear_at)
        return;
    seq_clear_at = 0;
    seq_msg_due = "NOT CLEARED";
    seq_msg_ms = 0;
}

/* the page is left: REC on the armed track while stopped and the black keys' recording end (a live take goes on) */
static void seq_leave(void)
{
    if (seq_rec == 1u || (seq_rec == 2u && !eng_transport_running()))
        seq_rec_off();
    ent_keys = 0;
}

/* a key while the keys are the armed track's keyboard (the panel plays it, the engine records it): its LED */
static void seq_kbd_key(uint32_t n, int down)
{
    if (down)
        ent_keys |= 1u << n;
    else
        ent_keys &= ~(1u << n);
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

/* the top bar on the SEQ page: the track's name, REC / ARM (the grid's TRACK line counts the tracks, the rows show the row) */
static void seq_bar(void)
{
    char b[32], name[TRACK_NAME_MAX + 8], *p = b;
    if (!eng_steps_count()) {
        bar_text("NO STEPS MODULE", C_ACC);
        return;
    }
    seq_name(seq_trk, name);
    p = put(p, name);
    if (seq_rec)
        p = put(p, " REC");
    else if (seq_armed_trk() == (int)seq_trk)    /* the track shown is armed (#179) */
        p = put(p, " ARM");
    p = seq_pat_text(p);                         /* (after REC / ARM: name REC P03>P04) */
    seq_shown_pat = seq_pat_state();
    *p = 0;
    bar_text(b, seq_rec ? C_RED : C_ACC);
}

/* The grid (the owner, 2026-10-23): a drum track's Drum map rows, or a melodic track's piano roll (#241), on the page's 16
 * steps at once, drawn in place against what is on the LCD (seq_grid_*), so a hit, a step or a row pick redraws only its
 * cells or two names, the playhead its two columns, a scroll of the roll its rows (names and the cells that changed):
 *   y  26  the page's steps, rate, swing (as for any track)
 *   y  44  8 rows of 19 px: the row's name (8 characters, 46 px; the selected row ivory on coral; the roll: its pitch,
 *          C4, C#4 ..., a C row's name and empty cells tinted) and 16 cells of 10 x 15 (11 px apart, 2 px more between
 *          beats): empty = the panel colour (a beat's first a shade lighter, the step playing grey), a hit = ivory, an
 *          accent = coral, a chance fills it part way up, a note going on through the step (the roll) dim and joined to
 *          the cell before, past the length = nothing
 *   y  40  the roll's markers over the top row, y 192 under the bottom row (a note sounds on that step above / below)
 *   y 196  the playhead: a coral tick under its column
 *   y 202  TRACK n/m, ARMED, MUTED
 *   y 222  the hint line */
#define GRID_X 52u
#define GRID_Y 44u
#define GRID_RH 19u
#define GRID_CW 10u
#define GRID_CH 15u
#define GRID_NAME_W 46u
#define GRID_TICK_Y (GRID_Y + GRID_RH * ENG_DRUM_ROWS)
#define GRID_NONE 0xFEu                 /* a cell not drawn yet */
#define GRID_PAST 0xFFu                 /* past the track's length */
#define GRID_TIE 0x7Cu                  /* a note going on through the step (no hit has chance code 31) */
#define GRID_TINT 0x04u                 /* an empty cell of a C row (the roll) */
#define C_BEAT 0x31C8u                  /* a beat's first empty cell */
#define C_CROW 0x2987u                  /* the roll's C rows: an empty cell, its name's ground */
#define C_CBEAT 0x3A49u                 /* ... a beat's first */
static uint8_t seq_grid_cell[ENG_DRUM_ROWS][16];   /* the cells as drawn (seq_grid_state's codes) */
static int8_t seq_grid_row = -1, seq_grid_tick = -2; /* the selected row, the playhead's column as drawn (-1 none) */
static uint8_t seq_grid_lo = 0xFFu;     /* the roll's lowest pitch as drawn (0xFF: a drum grid's names) */
static uint8_t seq_grid_ok;             /* the grid is on the LCD (else the next draw is a whole one) */
static uint32_t seq_grid_mark;          /* the roll's markers as drawn: bit c a note above the window on column c, bit 16 + c
                                         * one below */
static char seq_grid_text[3][48];       /* the info, track and hint lines as drawn */

static uint32_t seq_grid_x(uint32_t i) { return GRID_X + 11u * i + 2u * (i / 4u); }

/* a cell's code: GRID_PAST, GRID_TIE, else bit 0 a hit, bit 1 its accent, bits 2..6 its chance code (an empty cell:
 * GRID_TINT in a C row), bit 7 the step playing. w: the note word starting there, 1 a note through it, 0 none */
static uint32_t seq_grid_state(uint32_t w, int k, int32_t len, int pos, int tint)
{
    uint32_t s = 0;
    if (k >= len)
        return GRID_PAST;
    if (w == 1u)
        return GRID_TIE;
    if (w) {
        uint32_t ch = (w >> 26) & 31u;
        s = 1u | (((w >> 19) & 127u) == ACCENT_VEL ? 2u : 0u) | (ch > 19u ? 19u : ch) << 2;
    } else if (tint)
        s = GRID_TINT;
    return s | (k == pos && (!(s & 1u) || s >> 2) ? 0x80u : 0u);   /* (a full hit looks the same under the playhead) */
}

/* a cell painted as code s (was: as drawn); a tie also fills the gap to the cell before, which a cell no longer tied clears */
static void seq_grid_paint(uint32_t r, uint32_t i, uint32_t s, uint32_t was)
{
    uint32_t x = seq_grid_x(i), y = GRID_Y + GRID_RH * r, fill;
    uint16_t empty = (s & 0x80u) ? C_HINT : (s & 0x7Fu) == GRID_TINT ? ((i & 3u) ? C_CROW : C_CBEAT) : (i & 3u) ? C_TRACK : C_BEAT;
    if (i && (s == GRID_TIE || was == GRID_TIE)) {
        uint32_t gx = seq_grid_x(i - 1u) + GRID_CW;
        lcd_fill(gx, y, x - gx, GRID_CH, s == GRID_TIE ? C_DIM : C_BG);
    }
    if (s == GRID_PAST || s == GRID_TIE) {
        lcd_fill(x, y, GRID_CW, GRID_CH, s == GRID_TIE ? C_DIM : C_BG);
        return;
    }
    fill = (s & 1u) ? GRID_CH * (100u - 5u * ((s >> 2) & 31u)) / 100u : 0u;
    if (fill < GRID_CH)
        lcd_fill(x, y, GRID_CW, GRID_CH - fill, empty);
    if (fill)
        lcd_fill(x, y + GRID_CH - fill, GRID_CW, fill, (s & 2u) ? C_ACC : C_FG);
}

/* the roll's marker of column i (#241): a small triangle over the top row (up) or under the bottom row (down), pointing
 * at notes outside the window on that step; on: drawn, else cleared */
#define MARK_UP_Y (GRID_Y - 4u)                     /* y 40..42: under the info line */
#define MARK_DN_Y (GRID_Y + GRID_RH * 7u + GRID_CH) /* y 192..194: over the playhead's tick */
static void seq_grid_mark_paint(uint32_t i, int down, int on)
{
    uint32_t x = seq_grid_x(i), y = down ? MARK_DN_Y : MARK_UP_Y, k;
    if (!on) {
        lcd_fill(x + 2u, y, 6, 3, C_BG);
        return;
    }
    for (k = 0; k < 3u; k++) {                   /* rows 2, 4, 6 px wide (down: 6, 4, 2) */
        uint32_t w = 2u + 2u * (down ? 2u - k : k);
        lcd_fill(x + 5u - w / 2u, y + k, w, 1, C_DIM);
    }
}

static void seq_grid_name(int map, uint32_t r)
{
    char name[16];
    int sel = r == seq_row;
    uint16_t bg = C_BG;
    if (map >= 0)
        seq_row_name(map, r, name);
    else {
        uint32_t note = seq_grid_note(map, r);
        seq_note_name(name, note)[0] = 0;
        bg = note % 12u ? C_BG : C_CROW;
    }
    name[8] = 0;
    text_bc(&FONT_S, 4, GRID_Y + GRID_RH * r, name, sel ? C_BG : C_FG, sel ? C_ACC : bg, GRID_NAME_W, TA_LEFT);
}

/* a text line of the grid page, drawn when it is not on the LCD as it is */
static void seq_grid_line(uint32_t n, uint32_t y, const char *s, uint16_t fg, uint32_t field)
{
    uint32_t i;
    for (i = 0; s[i] && s[i] == seq_grid_text[n][i]; i++)
        ;
    if (seq_grid_ok && s[i] == seq_grid_text[n][i])
        return;
    for (i = 0; s[i] && i < sizeof seq_grid_text[n] - 1u; i++)
        seq_grid_text[n][i] = s[i];
    seq_grid_text[n][i] = 0;
    text_bc(&FONT_S, 8, y, s, fg, C_BG, field, TA_LEFT);
}

/* the ground of a whole redraw: the page's colour everywhere but under the 128 cells, which seq_grid_draw paints whole
 * next (a cell is always painted edge to edge: seq_grid_paint), so their pixels go out once (a whole SEQ page was the
 * ground and then the cells over it) */
static void seq_grid_ground(void)
{
    uint32_t i, r, x1 = seq_grid_x(15) + GRID_CW;
    lcd_fill(0, BAR_H, 240, GRID_Y - BAR_H, C_BG);                       /* the info line's band */
    lcd_fill(0, GRID_Y, seq_grid_x(0), GRID_TICK_Y - GRID_Y, C_BG);       /* the names' column */
    lcd_fill(x1, GRID_Y, 240u - x1, GRID_TICK_Y - GRID_Y, C_BG);          /* right of the last cell */
    for (i = 0; i + 1u < 16u; i++)                                        /* the gaps between the columns */
        lcd_fill(seq_grid_x(i) + GRID_CW, GRID_Y, seq_grid_x(i + 1u) - seq_grid_x(i) - GRID_CW, GRID_TICK_Y - GRID_Y, C_BG);
    for (r = 0; r < ENG_DRUM_ROWS; r++)                                   /* the gaps under each row of cells */
        lcd_fill(seq_grid_x(0), GRID_Y + GRID_RH * r + GRID_CH, x1 - seq_grid_x(0), GRID_RH - GRID_CH, C_BG);
    lcd_fill(0, GRID_TICK_Y, 240, 240u - GRID_TICK_Y, C_BG);              /* the playhead, the track and hint lines */
}

static void seq_grid_draw(int full, int mod, int map, const char *info)
{
    uint32_t cell[ENG_DRUM_ROWS][16], note[ENG_DRUM_ROWS], r, i, lo = map >= 0 ? 0xFFu : seq_roll_lo, mark = 0;
    const uint32_t *ws;
    int nn = eng_steps_notes((uint32_t)mod, &ws), j, pos = eng_steps_pos((uint32_t)mod), tick;
    int32_t len = seq_len(mod), k0 = seq_pg * 16;
    char line[48], num[8], *p;
    const char *hint;
    int remark = !full && !seq_grid_ok;          /* the markers' columns unknown: each drawn or cleared */
    if (full || !seq_grid_ok) {
        if (full)
            seq_grid_ground();
        for (r = 0; r < ENG_DRUM_ROWS; r++)
            for (i = 0; i < 16u; i++)
                seq_grid_cell[r][i] = GRID_NONE;
        seq_grid_row = -1;
        seq_grid_tick = -2;
        seq_grid_mark = 0;
        seq_grid_ok = 0;
    }
    for (r = 0; r < ENG_DRUM_ROWS; r++) {        /* the page's notes, by row, from one pass over the track's notes */
        note[r] = seq_grid_note(map, r);
        for (i = 0; i < 16u; i++)
            cell[r][i] = 0;
    }
    for (j = 0; j < nn; j++) {
        int k = (int)(ws[j] & 63u) - k0, e = map >= 0 ? k + 1 : k + 1 + (int)((ws[j] >> 6) & 63u), c;
        uint32_t pn = (ws[j] >> 12) & 127u;
        if (map < 0 && (pn < lo || pn > lo + 7u))    /* the roll: a note above / below the window, on the steps it sounds */
            for (c = k < 0 ? 0 : k; c < e && c < 16; c++)
                if (k0 + c < len)
                    mark |= 1u << (c + (pn < lo ? 16 : 0));
        for (r = 0; r < ENG_DRUM_ROWS; r++)
            if (((ws[j] >> 12) & 127u) == note[r]) {
                if (k >= 0 && k < 16 && cell[r][k] <= 1u)
                    cell[r][k] = ws[j];
                for (c = k + 1 < 0 ? 0 : k + 1; c < e && c < 16; c++)   /* (the roll: the steps it goes on through) */
                    if (!cell[r][c])
                        cell[r][c] = 1u;
            }
    }
    seq_grid_line(0, 26, info, C_FG, 224);
    for (r = 0; r < ENG_DRUM_ROWS; r++) {
        int tint = map < 0 && note[r] % 12u == 0u;
        if (!seq_grid_ok || ((int)r == seq_grid_row) != (r == seq_row) || lo != seq_grid_lo)
            seq_grid_name(map, r);
        for (i = 0; i < 16u; i++) {
            uint32_t s = seq_grid_state(cell[r][i], k0 + (int)i, len, pos, tint);
            if (s != seq_grid_cell[r][i]) {
                seq_grid_paint(r, i, s, seq_grid_cell[r][i]);
                seq_grid_cell[r][i] = (uint8_t)s;
            }
        }
    }
    seq_grid_row = (int8_t)seq_row;
    seq_grid_lo = (uint8_t)lo;
    if (mark != seq_grid_mark || remark) {       /* the markers: only the columns that changed */
        for (i = 0; i < 32u; i++)
            if (((mark ^ seq_grid_mark) >> i & 1u) || remark)
                seq_grid_mark_paint(i & 15u, i >= 16u, (int)(mark >> i & 1u));
        seq_grid_mark = mark;
    }
    tick = pos >= k0 && pos < k0 + 16 ? pos - k0 : -1;
    if (tick != seq_grid_tick) {                 /* the playhead's tick: off the old column, onto the new */
        if (seq_grid_tick >= 0)
            lcd_fill(seq_grid_x((uint32_t)seq_grid_tick), GRID_TICK_Y, GRID_CW, 3, C_BG);
        if (tick >= 0)
            lcd_fill(seq_grid_x((uint32_t)tick), GRID_TICK_Y, GRID_CW, 3, C_ACC);
        seq_grid_tick = (int8_t)tick;
    }
    seq_shown_pos = (int8_t)pos;
    fmt_int(num, (int32_t)seq_trk + 1);
    p = put(line, "TRACK ");
    p = put(p, num);
    *p++ = '/';
    fmt_int(num, eng_steps_count());
    p = put(p, num);
    if (seq_armed_trk() == (int)seq_trk)        /* the track line's marks: ARMED (#179), MUTED */
        p = put(p, "  ARMED");
    if (eng_steps_muted((uint32_t)mod))
        p = put(p, "  MUTED");
    if (seq_armed_trk() != (int)seq_trk && !eng_steps_muted((uint32_t)mod)) {
        p = put(p, map >= 0 ? "  ALGO: TRACK" : "  BLACK/ALGO: TRACK");
        *put(p, "  SEQ+REC: CLEAR") = 0;           /* (#231: where it fits) */
        if (text_w(&FONT_S, line, -1) > 224u)
            *p = 0;
    } else
        *p = 0;
    seq_grid_line(1, 202, line, C_DIM, 224);
    if (map >= 0)
        hint = seq_rec ? "BLACK hit  SEL row  WHITE step  FX acc" : "BLACK/SEL row  WHITE step  FX acc  K2 vel";
    else if (seq_kbd())
        hint = "KEYS record  SEL row  OCT octave";
    else
        hint = seq_rec == 2u ? "BLACK hear  SEL+KEY pen  WHITE step" : seq_rec ? "BLACK hit  SEL+KEY pen  WHITE step"
             : "SEL+KEY pen  WHITE step  FX acc  LFO tie";
    seq_grid_line(2, 222, hint, C_HINT, 228);
    seq_grid_ok = 1;
}

/* the page: the info line (y 26: the page's steps of the track's length, its rate and swing when not straight), then the
 * grid (seq_grid_draw, above) */
static void seq_draw(int full)
{
    char line[40], num[8], *p;
    int mod = seq_module(), map = seq_map();
    int32_t len;
    seq_clamp();
    if (mod < 0) {
        seq_grid_ok = 0;
        if (full) {
            lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
            text_bc(&FONT_M, 10, 56, "This patch has no Steps module.", C_FG, C_BG, 224, TA_LEFT);
            text_bc(&FONT_S, 10, 80, "Add one in the editor.", C_DIM, C_BG, 224, TA_LEFT);
            text_bc(&FONT_S, 10, 222, "SEQ  back", C_HINT, C_BG, 224, TA_LEFT);
        }
        return;
    }
    if (map < 0)
        seq_roll_aim(mod);
    len = seq_len(mod);
    fmt_int(num, seq_pg * 16 + 1);              /* 1-16 OF 32  RATE 1/16  SW 66% */
    p = put(line, num);
    *p++ = '-';
    fmt_int(num, seq_pg * 16 + 16 < len ? seq_pg * 16 + 16 : len);
    p = put(p, num);
    p = put(p, " OF ");
    fmt_int(num, len);
    p = put(p, num);
    p = put(p, "  RATE ");
    {                                            /* (the pattern's own rate, else the track's) */
        int rt = eng_pattern_rate((uint32_t)mod, (uint32_t)eng_pattern_playing((uint32_t)mod));
        p = put_param(p, &DEFS[T_STEPS], STEPS_P_RATE, rt >= 0 && eng_pattern_has((uint32_t)mod, (uint32_t)eng_pattern_playing((uint32_t)mod)) ? rt << 16 : eng_get_param((uint32_t)mod, STEPS_P_RATE));
    }
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
    seq_grid_draw(full, mod, map, line);
}

/* ---- the SONG page (#375; the owner, 2026-10-27: D-541, D-544): SEL tapped on the SEQ page. A song's entries, one a row
 * (03  P12  +5: its number, pattern, shift), an END row after the last; the patch plays its songs or its selected pattern.
 *   SELECT          the cursor (an entry, or END)
 *   K1              the entry's pattern; on END: adds an entry (the last one's pattern, no shift); FX held: a copy of the
 *                   entry inserted before it
 *   K2              the entry's shift, -12..+12 semitones (a track that plays a Drum map is never shifted)
 *   K4              right: the song plays (from the end of each track's pass, its first entry), left: the pattern again
 *   ALGO            the song, 1..8 (while one plays, that one plays)
 *   SEQ held + REC  deletes the entry, asked first (REC again within 3 s), as the track clear
 *   PRESET          the pattern, as on the SEQ page
 *   SEL / HOME      back to the SEQ page
 * The entry each track plays is marked (>); only the rows that changed are redrawn. Edits go into the running patch (SAVE
 * keeps them) and to the editor (SONG_NOW, PATTERN_NOW). */
#define SONG_ROWS 8u
#define SONG_Y 44u
#define SONG_RH 19u
static uint8_t song_sel;                /* the song shown (0..ENG_SONGS - 1) */
static uint8_t song_cur, song_top;      /* the cursor (an entry, or the song's length: END), the first row shown */
static char song_text[SONG_ROWS + 3u][40];   /* the rows, the info, the footer and the hint as drawn (a row's first byte: 1 the cursor) */
static uint8_t song_ok;                 /* the page is on the LCD as song_text says */
static int16_t song_shown_play = -2;    /* the entry playing as drawn */
                                        /* song_del_at: SEQ held + REC: fm1_ms | 1 of the press that asked, 0 none */
static uint8_t song_del_k;              /* ... the entry it asked for */

static int song_len(void) { return eng_song_len(song_sel); }
/* the entry the selected track plays in the song shown, -1 when that song does not play */
static int song_playing(void)
{
    int mod = seq_module();
    return mod >= 0 && eng_song() == song_sel + 1 ? eng_song_entry((uint32_t)mod) : -1;
}
/* the page about to open (panel.c, SEL tapped on the SEQ page): the song playing, else the last one shown */
static void song_prep(void)
{
    if (eng_song())
        song_sel = (uint8_t)(eng_song() - 1);
    song_cur = song_top = 0;
    song_del_at = 0;
    song_ok = 0;
}
/* the song's entries changed: into the running binary and to the editor */
static void song_sync(void)
{
    m1_patch_patterns();
    m1_song_now(song_sel);
}
/* PRESET on the SEQ or SONG page: the patch's pattern, d patterns on */
static void seq_pattern_step(int32_t d)
{
    char m[32];
    int p = eng_pattern();
    if (p < 0 || !eng_steps_count()) {
        ui_msg("NO STEPS MODULE", 1000);
        return;
    }
    p = clampi(p + d, 0, ENG_PATTERNS - 1);
    if (p == eng_pattern())
        return;
    eng_pattern_set((uint32_t)p);
    m1_patch_patterns();
    m1_pattern_now();
    put(put2(put(m, "PATTERN "), p + 1), eng_song() ? " (SONG PLAYS)" : eng_transport_running() ? " NEXT" : "")[0] = 0;
    ui_msg(m, 1000);
    if (!ui_dirty)
        ui_dirty = 1;
}
/* the knobs on the SONG page (panel.c panel_encoders): st[0..6] = SELECT, ALGO, K1..K4, PRESET */
static void song_knobs(int32_t *st)
{
    int n = song_len(), changed = 0, e;
    if (st[1]) {                                 /* ALGO: the song (while one plays, this one) */
        song_sel = (uint8_t)(((int32_t)song_sel + ENG_SONGS * 8 + st[1]) % ENG_SONGS);
        song_cur = song_top = 0;
        if (eng_song() && eng_song() != song_sel + 1) {
            eng_song_set(song_sel + 1u);
            m1_patch_patterns();
            m1_pattern_now();
        }
        n = song_len();
        header_draw();
    }
    if (st[0])
        song_cur = (uint8_t)clampi((int32_t)song_cur + st[0], 0, n);
    if (st[2]) {
        if (song_cur >= n) {                     /* END: a new entry, the last one's pattern (the selected one first) */
            if (n < ENG_SONG_LEN && !eng_song_put(song_sel, (uint32_t)n, n ? (uint32_t)eng_song_get(song_sel, (uint32_t)n - 1u) & 0xFFu : (uint32_t)eng_pattern(), 0))
                changed = 1;
            else if (n >= ENG_SONG_LEN)
                ui_msg("SONG FULL: 64 ENTRIES", 1000);
        } else if (panel_held >> BTN_ACC & 1u) { /* FX held: a copy before it (the 303's INS) */
            if (!eng_song_insert(song_sel, song_cur))
                changed = 1;
            else
                ui_msg("SONG FULL: 64 ENTRIES", 1000);
        } else {
            e = eng_song_get(song_sel, song_cur);
            changed = !eng_song_put(song_sel, song_cur, (uint32_t)clampi((e & 0xFF) + st[2], 0, ENG_PATTERNS - 1), (int8_t)(e >> 8));
        }
    }
    if (st[3] && song_cur < song_len()) {
        e = eng_song_get(song_sel, song_cur);
        changed |= !eng_song_put(song_sel, song_cur, (uint32_t)(e & 0xFF), clampi((int8_t)(e >> 8) + st[3], -ENG_SHIFT_MAX, ENG_SHIFT_MAX));
    }
    if (st[5]) {                                 /* K4: the song plays (right) or the pattern (left) */
        uint32_t want = st[5] > 0 ? song_sel + 1u : 0u;
        if ((int)want != eng_song()) {
            eng_song_set(want);
            m1_patch_patterns();
            m1_pattern_now();
            ui_msg(want ? "SONG PLAYS" : "PATTERN PLAYS", 1000);
            header_draw();
        }
    }
    if (st[6])
        seq_pattern_step(st[6]);
    if (changed)
        song_sync();
    ui_dirty = ui_dirty ? ui_dirty : 1;
}
/* SEQ held + REC on the SONG page: the entry at the cursor deleted, asked first (as seq_clear_press) */
static void song_del_press(void)
{
    char num[4];
    if (song_cur >= song_len()) {
        seq_msg_due = "NO ENTRY HERE";
        return;
    }
    put2(num, song_cur + 1);
    if (song_del_at && song_del_k == song_cur && fm1_ms - (song_del_at & ~1u) < SEQ_CLEAR_MS) {
        song_del_at = 0;
        (void)eng_song_delete(song_sel, song_cur);
        song_sync();
        put(put(put(seq_msg_buf, "ENTRY "), num), " DELETED")[0] = 0;
        seq_msg_due = seq_msg_buf;
        seq_msg_ms = 1200;
        ui_dirty = ui_dirty ? ui_dirty : 1;
        return;
    }
    song_del_at = fm1_ms | 1u;
    song_del_k = song_cur;
    put(put(put(seq_msg_buf, "DELETE ENTRY "), num), "? REC AGAIN")[0] = 0;
    seq_msg_due = seq_msg_buf;
    seq_msg_ms = SEQ_CLEAR_MS;
}
static void song_bar(void)
{
    char b[32], *p = b;
    p = put(p, "SONG ");
    *p++ = (char)('1' + song_sel);
    p = put(p, eng_song() == song_sel + 1 ? " PLAYS" : eng_song() ? " (SONG " : " (PATTERN P");
    if (eng_song() && eng_song() != song_sel + 1) {
        *p++ = (char)('0' + eng_song());
        p = put(p, " PLAYS)");
    } else if (!eng_song())
        p = put(put2(p, eng_pattern() + 1), ")");
    *p = 0;
    bar_text(b, C_ACC);
}
/* a text line of the page, drawn when it is not on the LCD as it is (cur: the cursor's colours) */
static void song_line(uint32_t n, uint32_t y, const char *s, uint16_t fg, int cur, uint32_t field)
{
    uint32_t i;
    if (song_ok && song_text[n][0] == (char)(cur ? 1 : 2)) {
        for (i = 0; s[i] && s[i] == song_text[n][1u + i]; i++)
            ;
        if (s[i] == song_text[n][1u + i])
            return;
    }
    song_text[n][0] = (char)(cur ? 1 : 2);
    for (i = 0; s[i] && i < sizeof song_text[n] - 2u; i++)
        song_text[n][1u + i] = s[i];
    song_text[n][1u + i] = 0;
    text_bc(&FONT_S, 8, y, s, cur ? C_BG : fg, cur ? C_ACC : C_BG, field, TA_LEFT);
}
static void song_draw(int full)
{
    char t[40], num[8], *p;
    int n, play = song_playing();
    uint32_t r;
    if (!eng_steps_count()) {
        song_ok = 0;
        if (full) {
            lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
            text_bc(&FONT_M, 10, 56, "This patch has no Steps module.", C_FG, C_BG, 224, TA_LEFT);
        }
        return;
    }
    if (full) {
        lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
        song_ok = 0;
    }
    n = song_len();
    if (song_cur > n)
        song_cur = (uint8_t)n;
    if (song_cur < song_top)
        song_top = song_cur;
    if (song_cur >= song_top + SONG_ROWS)
        song_top = (uint8_t)(song_cur - SONG_ROWS + 1u);
    fmt_int(num, n);                             /* 12 ENTRIES  K4: PATTERN / SONG */
    p = put(put(t, num), n == 1 ? " ENTRY" : " ENTRIES");
    put(p, eng_song() == song_sel + 1 ? "  K4 LEFT: PATTERN" : "  K4 RIGHT: SONG")[0] = 0;
    song_line(SONG_ROWS, 26, t, C_FG, 0, 224);
    for (r = 0; r < SONG_ROWS; r++) {
        int k = song_top + (int)r;
        p = t;
        if (k < n) {                             /* >03  P12  +5 */
            int e = eng_song_get(song_sel, (uint32_t)k), sh = (int8_t)(e >> 8);
            *p++ = k == play ? '>' : ' ';
            p = put2(p, k + 1);
            p = put2(put(p, "  P"), (e & 0xFF) + 1);
            p = put(p, "  ");
            if (sh > 0)
                *p++ = '+';
            fmt_int(num, sh);
            p = put(p, num);
        } else if (k == n)
            p = put(p, n < (int)ENG_SONG_LEN ? " END   K1: ADD" : " END   FULL");
        *p = 0;
        song_line(r, SONG_Y + SONG_RH * r, t, k > n ? C_BG : k == n ? C_DIM : C_FG, k == song_cur, 120);
    }
    song_line(SONG_ROWS + 1u, 202, "K1 PAT  K2 SHIFT  FX+K1 INSERT", C_DIM, 0, 224);
    song_line(SONG_ROWS + 2u, 222, "ALGO SONG  SEQ+REC DEL  SEL BACK", C_HINT, 0, 228);
    song_shown_play = (int16_t)play;
    song_ok = 1;
}
/* every pass (seq_poll): the SONG page's marker follows the entry playing; a delete asked in vain ends */
static void song_poll(void)
{
    if (song_del_at && fm1_ms - (song_del_at & ~1u) >= SEQ_CLEAR_MS)
        song_del_at = 0;
    if (page == PAGE_SONG && song_playing() != song_shown_play && !ui_dirty)
        ui_dirty = 1;
}

/* the main loop, every pass: the LEDs, and the cells when the playhead moved */
static void seq_poll(void)
{
    static int8_t kbd_was = -1;
    int mod;
    seq_take();
    if (seq_msg_due) {
        ui_msg(seq_msg_due, seq_msg_ms ? seq_msg_ms : 800u);
        seq_msg_due = 0;
        seq_msg_ms = 0;
    }
    if (seq_clear_at && fm1_ms - (seq_clear_at & ~1u) >= SEQ_CLEAR_MS)
        seq_clear_at = 0;                        /* (the clear asked in vain: its message ends with it) */
    song_poll();
    if (page == PAGE_SEQ && eng_steps_count() && seq_pat_state() != seq_shown_pat && !ui_yielding
        && !(msg_until && (int32_t)(fm1_ms - msg_until) < 0))
        header_draw();                           /* (a pattern taken at the end of a pass, a song's next entry: the bar,
                                                  * once a message on it is over) */
    if (page != PAGE_SEQ) {
        kbd_was = -1;
        return;
    }
    if (seq_kbd() != kbd_was) {                  /* PLAY / stop while REC records the armed track: its keyboard or the roll */
        kbd_was = (int8_t)seq_kbd();
        ent_keys = 0;
        seq_held = -1;
        ui_dirty = ui_dirty ? ui_dirty : 1;      /* (the hint line) */
    }
    mod = seq_module();
    if (mod >= 0 && seq_map() < 0)
        seq_roll_aim(mod);
    seq_leds();
    if (mod >= 0 && eng_steps_pos((uint32_t)mod) != seq_shown_pos && !ui_dirty)
        ui_dirty = 1;
}
