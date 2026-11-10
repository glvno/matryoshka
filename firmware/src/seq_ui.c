/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The SEQ page shows the track's drum grid or piano roll. Drum grids use black keys for rows and white keys for
 * steps, with FX accents, LFO ties and held-step knob edits. Piano-roll keys play their own pitches outside step
 * record (seq_play_keys); REC plus a running transport records a live take (seq_kbd). OCT changes the keys' octave.
 * SELECT moves the roll's pitch view by eight pitches; SEL + SELECT by one. SEL + a key moves the view to its pitch.
 *
 * REC tapped while stopped starts step record on the first visible step; REC + a white key starts on that step.
 * Keys held together make a chord; the last release writes it and moves the cursor. LFO rests or ties held notes,
 * FX accents, K4 moves the cursor, and black key 10 clears the previous step. REC, HOME and SEQ end step record;
 * PLAY turns it into a live take. SEL + FX toggles piano-roll preview without changing what is written. Preview starts
 * on at power-on. The drum grid keeps sounding its entered notes regardless of the piano-roll preview choice.
 *
 * ALGO picks the track, PRESET the pattern, SEL tapped the song page. REC + a black key arms a track and SEQ + a
 * black key mutes it. The controls table (web/src/controls.ts) defines the sheet, editor help and hint text.
 * The grid draws only changed cells, names, markers and playhead columns. Edits reach the running patch and editor.
 */

#include "controls.h"                             /* the controls table (web/src/controls.ts, #553): the hint lines */

#define PAGE_SEQ 8u
#define BTN_SEQ 11u
#define BTN_REC 13u
#define BTN_ENV 4u                      /* ENV: the environment (#197) */
#define BTN_ACC 2u                      /* FX: the SEQ page's accent key (#197; it was ENV) */
#define BTN_PEN 3u                      /* SEL: held, the roll's pen; tapped (no key meanwhile), the SONG page (panel.c) */
#define PAGE_SONG 11u                   /* the SONG page (#375): seq_ui.c song_draw */
#define BTN_LFO 5u                      /* LFO: the grid's tie key */

static uint8_t seq_trk;                 /* the selected track (index among the patch's Steps modules) */
static uint8_t seq_pg;                  /* the page of 16 steps */
static uint8_t seq_rec;                 /* REC records (#395: global; the armed Steps tracks; the transport runs meanwhile) */
static uint8_t seq_cin;                 /* REC's count-in (#414): 1 waiting for the engine to take the transport's start,
                                         * 2 counting; the tracks record once it ends (seq_cin_poll) */
static uint8_t seq_cin_bars;            /* ... the bars it counts (the setting when REC was pressed) */
static uint32_t seq_cin_at;             /* ... the clock's ticks when REC was pressed */
static uint32_t seq_cin_end;            /* ... ticks since the transport's start at which recording begins */
static uint8_t seq_cin_shown;           /* ... the beat the bar shows (0.. over the bars, 0xFF none yet) */
static uint8_t seq_cin_lit;             /* ... REC's LED (on for the first half of each beat) */
static uint8_t seq_cin_asked;           /* ... asked for (its bars) or ended (0) with its click: counts up, the bars in
                                         * seq_cin_click (fm1_ui.c tells the page, whose engine plays the click) */
static uint8_t seq_cin_click;
/* REC's count-in click (D-803): the engine's, on the analog output only (D-820), on the bars seq_cin_poll counts */
static void seq_cin_engine(uint32_t bars)
{
    eng_count_in(seq_cin_at, bars);
    seq_cin_click = (uint8_t)bars;
    seq_cin_asked++;
}
static uint8_t seq_thru_note[27];       /* a black key held on a drum track's page (#368): its note + 1 (0 none), sounding through */
static uint8_t seq_thru_chord[27][8], seq_thru_count[27];
static uint8_t seq_thru_mod[27];        /* ... the track it sounds through, let go there */
static uint8_t seq_row;                 /* the grid's selected row: a Drum map's row, or the roll's (0 the top: its highest pitch) */
static uint8_t seq_roll_lo = 57;        /* the roll (#241): the pitch of its lowest row (0..120) */
static int8_t seq_roll_trk = -1;        /* the track its window was opened for (-1: open it again), and the patch then */
static uint32_t seq_roll_gen;
static uint32_t ent_keys;               /* the keys held while they are the armed track's keyboard (bit n: key n) */
static int8_t seq_held = -1;            /* the step whose white key is held (SELECT / the roll's K3 its chance, K1 / K2 its values), -1 none */
static uint32_t seq_held_notes[TRACK_NOTES_MAX];   /* the track's notes before the held step's press switched it */
static uint8_t seq_held_n;
static uint8_t seq_held_turned;         /* a knob turned while it is held (an FX press's switch is undone once; 1: none to undo) */
static uint8_t seq_held_tap;            /* the held step not used yet: its key's release switches its note (seq_held_note) */
static uint8_t seq_held_note;           /* ... the selected row's note when its key went down */
static uint8_t seq_lpg;                 /* P-locks (#524, #519 Q2): ALGO's stop with a step held, 0 its note (K1..K3 as ever), n
                                         * the n-th page of the devices the track drives (K1..K4 lock its rows on the held
                                         * step); kept over presses, back to 0 with another track */
static int8_t seq_shown_pos = -2;       /* the playhead as last drawn */
static uint8_t seq_page_armed;           /* 1 + the track the SEQ page armed on opening, changing the armed set (#582) */
static const char *seq_msg_due;         /* a key's message for the bar, shown by the loop's pass (a key never draws: D-228) */
static uint16_t seq_msg_ms;             /* ... its time on show (0: 800 ms) */
static char seq_msg_buf[28];            /* ... a message made up of a track's name */
static uint32_t seq_clear_at;           /* SEQ held + REC (#231): fm1_ms | 1 of the press that asked, 0 none */
static uint32_t seq_clear_gen;          /* ... the patch then */
static uint8_t seq_clear_trk;           /* ... the track it asked for */
static uint32_t seq_pen_ms;             /* fm1_ms | 1 of the last key that was the pen (SEL held: its release then opens
                                         * nothing, D-541), 0 none */
static uint32_t seq_shown_pat = 0xFFFFFFFFu;   /* the bar's pattern, queued pattern, song and entry as drawn */
static uint8_t seq_shown_mark = 0xFFu;  /* ... and its ARM / REC (seq_bar_mark) */
static uint8_t seq_shown_sr = 0xFFu;    /* ... and its STEP n (step record's cursor + 1, 0 none) */
static uint8_t seq_shown_lo = 0xFEu;    /* ... and the roll's pitches (its lowest; 0xFF a drum grid) */

/* step record (#532, D-804): its state. The chord's notes come from the keys held together; a note starts on the cursor's
 * step as its key goes down and ends on the cursor's step when let go (a tie moved the cursor meanwhile). Each write lays
 * the chord over the track's notes as they were when its first key went down (seq_held_notes: no step is held meanwhile) */
#define SR_BACK 22u                     /* black key 10 (D#5): back one step, that step cleared */
#define SR_NOTES 128u
static uint8_t sr_on;                   /* step record runs */
static uint8_t sr_k;                    /* the cursor: a step of the pattern */
static uint8_t sr_from;                 /* the step the chord's first note started on */
static uint8_t sr_preview = 1;          /* audition piano-roll entry; SEL + FX toggles during step record */
static uint8_t sr_trk;                  /* the track it runs on, and the patch then (another one ends it) */
static uint32_t sr_gen;
static uint32_t sr_keys;                /* the keys of the chord held now (bit n: key n) */
static uint32_t sr_skip;                /* keys held as it started (REC's white key) or past a tie at the end: their
                                         * release is nobody's */
static uint8_t sr_n;                    /* the chord's notes: pitch, velocity, first and last step, keys holding it */
static uint8_t sr_note[SR_NOTES], sr_vel[SR_NOTES], sr_at[SR_NOTES], sr_end[SR_NOTES], sr_hold[SR_NOTES];
static uint8_t sr_of[27][8], sr_count[27];               /* each held key's note in the chord */
static void sr_stop(void);

/* note key n (0 = F3) -> its white key's step on the page (0..15) or its black key's number (0..10: a row on the SEQ
 * page, a track with SEQ or REC held), else -1 */
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
/* a module is in the armed set (#191) */
static int seq_mod_armed(int mod) { return mod >= 0 && mset_has(eng_arm_mask_get(), (uint32_t)mod); }
/* REC's LED: lit while REC is on, blinking on the beats of the count-in */
static int seq_rec_lit(void) { return seq_rec && (seq_cin != 2u || seq_cin_lit); }
/* the SEQ bar's mark: bit 0 the track shown armed (ARM / REC), bit 1 REC on (the bar red) */
static uint8_t seq_bar_mark(void) { return (uint8_t)(seq_mod_armed(seq_module()) | (seq_rec ? 2 : 0)); }
/* Piano-roll keys play notes outside step record, regardless of REC, transport or arming. */
static int seq_play_keys(void)
{
    return page == PAGE_SEQ && !sr_on && seq_module() >= 0 && seq_map() < 0;
}

/* A live take is reported separately from ordinary piano-roll playing. */
static int seq_kbd(void)
{
    return seq_rec && page == PAGE_SEQ && seq_mod_armed(seq_module()) && seq_map() < 0 && eng_transport_running();
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

/* the roll (#241): pitch p on the selected row. The view moves only if p is off screen (or `jump`), to the fixed page
 * of 8 pitches p is on (its lowest a multiple of 8: C3-G3, G#3-D#4 ..., D-809); a view SEL + SELECT moved stays while
 * p is on it */
static void seq_roll_show(int32_t p, int jump)
{
    p = clampi(p, 0, 127);
    if (jump || p < seq_roll_lo || p > seq_roll_lo + 7)
        seq_roll_lo = (uint8_t)clampi(p / 8 * 8, 0, 120);
    seq_row = (uint8_t)(seq_roll_lo + 7 - p);
}
/* the roll opened for the selected track, once per track and patch: on the page of its notes' median pitch, an empty
 * track on the page of C of the keys' octave. Changes state only (a key handler may call it) */
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
    int mod = seq_module(), pos = mod >= 0 ? eng_steps_pos((uint32_t)mod) : -1;
    int blink = (fm1_ms / 200u) & 1u, kbd = seq_play_keys(), map = seq_map();
    uint32_t n, rows = 0, rn = mod >= 0 ? seq_grid_note(map, seq_row) : 0u;
    if (mod >= 0) {                              /* the rows with notes, bit b: black key b's row (the roll's: 7 - b) */
        const uint32_t *ws;
        int i, nn = eng_steps_notes((uint32_t)mod, &ws);
        uint32_t r;
        for (r = 0; r < ENG_DRUM_ROWS; r++)
            for (i = 0; i < nn; i++)
                if (((ws[i] >> 12) & 127u) == seq_grid_note(map, map >= 0 ? r : 7u - r) && (int)(ws[i] & 63u) < seq_len(mod))
                    rows |= 1u << r;
    }
    for (n = 0; n < 27u; n++) {
        int w = seq_white(n), b = seq_black(n), lit = 0, mid = 0, dim = 0;
        if (kbd || sr_on) {                      /* the armed track's keyboard, step record's: the keys held bright, every */
            uint32_t note = (uint32_t)clampi(53 + (int32_t)n + 12 * octave, 0, 127);   /* C dim (to find your place; */
            lit = (int)((sr_on ? sr_keys : ent_keys) >> n & 1u);                       /* a drum grid: its rows' keys) */
            dim = !lit && (sr_on && map >= 0 ? b >= 0 && b < (int)ENG_DRUM_ROWS : note % 12u == 0u);
        } else if (mod >= 0 && b >= 0) {        /* the rows (a drum track's; the roll's on screen, black key 1 its */
            uint32_t row = map >= 0 ? (uint32_t)b : 7u - (uint32_t)b;   /* bottom row, #387): the selected one bright */
            if (b < (int)ENG_DRUM_ROWS)          /* (blinking: muted), the others with notes dim */
                lit = row == seq_row && (!eng_steps_muted((uint32_t)mod) || blink), dim = row != seq_row && (rows >> b & 1u);
        } else if (w >= 0 && mod >= 0) {        /* the selected row's notes on the page's steps */
            int k = seq_pg * 16 + w, on = k < seq_len(mod) && seq_step_has(mod, (uint32_t)k, rn);
            lit = on && k != pos;
            mid = !on && k == pos;
        }
        led_bit(fm1_led, 14u + n, lit);
        led_bit(fm1_led_mid, 14u + n, mid);
        led_bit(fm1_led_dim, 14u + n, dim);
    }
    fm1_led_key(BTN_REC, seq_rec_lit() || sr_on);   /* (step record: lit, REC ends it) */
}

/* ---- the panel */

static void seq_arm_shown(int opening);
static void seq_select(uint32_t t)
{
    if (t >= (uint32_t)eng_steps_count())
        return;
    sr_stop();                                   /* (another track: step record ends, D-808) */
    seq_trk = (uint8_t)t;
    seq_pg = 0;
    seq_held = -1;
    seq_lpg = 0;
    seq_row = 0;
    seq_roll_trk = -1;                           /* (a roll opens around its notes again) */
    if (page != PAGE_SEQ)
        return;                                  /* (from another page: the caller's page_set draws the SEQ page whole) */
    seq_arm_shown(0);                            /* (ALGO: the track shown is the one armed, #395; REC on: it records) */
    header_draw();
    ui_dirty = 2;
}

/* SELECT with no step held (the owner, 2026-10-23): a drum grid's selected row, d rows down, clamped at the first and the
 * last row (no wrap; REC on or off). The roll (the owner, 2026-11-02, D-809): its view d pages of 8 pitches down (a
 * fixed page stays one; a view moved by a pitch keeps that offset), with SEL held (fine) d pitches; the selected row stays
 * on its screen row, so its black key stays. Only the two names are redrawn, or a scroll's rows (seq_grid_draw) */
static void seq_row_step(int32_t d, int fine)
{
    int mod = seq_module();
    if (mod >= 0 && seq_map() < 0) {
        seq_roll_aim(mod);
        seq_roll_lo = (uint8_t)clampi((int32_t)seq_roll_lo - (fine ? d : 8 * d), 0, 120);
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
 * message, the bar; the device pages' info line (the arm) is drawn on every redraw. seq_rec_off's 2 (recording ended,
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

/* the note of `note` that sounds on step k without starting there (a note through it, across the loop point too on a
 * pattern of `len` steps), its index; -1 none */
static int seq_through(const uint32_t *ws, int nn, uint32_t k, uint32_t note, uint32_t len)
{
    int i;
    for (i = 0; i < nn; i++)
        if (((ws[i] >> 12) & 127u) == note && eng_note_through(ws[i], k, len))
            return i;
    return -1;
}

/* the roll's white key (#241): the selected pitch's note on step k on / off; a press on a step its note runs through cuts
 * that note before it and starts one there */
static void seq_roll_toggle(int mod, uint32_t k, uint32_t note, uint32_t vel)
{
    uint32_t w[TRACK_NOTES_MAX], len = (uint32_t)seq_len(mod);
    const uint32_t *ws;
    int i, nn = eng_steps_notes((uint32_t)mod, &ws), t = seq_through(ws, nn, k, note, len);
    if (t < 0) {
        eng_steps_toggle((uint32_t)mod, k, note, vel);
        return;
    }
    for (i = 0; i < nn; i++)
        w[i] = ws[i];
    w[t] = eng_note_cut_before(w[t], k, len);
    (void)eng_steps_set_notes((uint32_t)mod, w, (uint32_t)nn);
    eng_steps_toggle((uint32_t)mod, k, note, vel);
}

/* the held step's pending switch (a white key's press, not used yet) done now: its key let go, or another white key
 * pressed (the owner's 1.9.0 device check, 2026-11-03) */
static void seq_held_tap_done(int mod)
{
    if (!seq_held_tap)
        return;
    seq_held_tap = 0;
    if (mod < 0 || seq_held < 0 || seq_held >= seq_len(mod))
        return;
    seq_roll_toggle(mod, (uint32_t)seq_held, seq_held_note, STEP_VEL);
    seq_sync(mod);
}

/* LFO held + a white key (the roll, #241; a drum track, #368; the rule of 2026-10-28; #384): the selected row's note
 * around step k, in grid order on the pattern's `len` steps. On a step a note of that row runs through (after its start,
 * or across the loop point): k its last step already, the note is one step again (TIE OFF), else it now ends on k
 * (TIED). Else the row's last note starting before k ends on k (one press ties step 1 to 16), a note of its own starting
 * on k joining it (TIED). With no note of the row before k the tie wraps round the loop: the row's last note is tied
 * across the loop point to end on k (TIED), or, starting on k itself, becomes a drone that never starts again (DRONE; a
 * drone there already: one step again, TIE OFF). No note in the row: NOTHING TO TIE */
static void seq_roll_tie(int mod, uint32_t k, uint32_t note)
{
    uint32_t w[TRACK_NOTES_MAX], len = (uint32_t)seq_len(mod);
    const uint32_t *ws;
    int i, m, nn = eng_steps_notes((uint32_t)mod, &ws), t = seq_through(ws, nn, k, note, len), prev = -1, wrap;
    for (i = 0; i < nn; i++)
        w[i] = ws[i];
    if (t >= 0) {                                /* inside a note: it ends on k, or (k its last step) is one step again */
        uint32_t at = w[t] & 63u, n = ((w[t] >> 6) & 63u) + 1u;
        uint32_t last = (w[t] & ENG_NOTE_WRAP) && at + n > len ? at + n - len - 1u : at + n - 1u;
        if (!eng_note_drone(w[t]) && k == last) {
            w[t] &= ~(ENG_NOTE_WRAP | 63u << 6);
            seq_msg_due = "TIE OFF";
        } else {
            w[t] = eng_note_end_on(w[t], k, len);
            seq_msg_due = "TIED";
        }
    } else {
        for (i = 0; i < nn; i++)                 /* the row's last note starting before k */
            if (((w[i] >> 12) & 127u) == note && (w[i] & 63u) < k && (prev < 0 || (w[i] & 63u) > (w[prev] & 63u)))
                prev = i;
        wrap = prev < 0;
        if (wrap)                                /* none: the row's last note, whose tie wraps round the loop */
            for (i = 0; i < nn; i++)
                if (((w[i] >> 12) & 127u) == note && (w[i] & 63u) < len && (prev < 0 || (w[i] & 63u) > (w[prev] & 63u)))
                    prev = i;
        if (prev < 0) {
            seq_msg_due = "NOTHING TO TIE";
            return;
        }
        if ((w[prev] & 63u) == k) {              /* the last note starts on k: a drone, or one step again */
            if (eng_note_drone(w[prev])) {
                w[prev] &= ~(ENG_NOTE_WRAP | 63u << 6);
                seq_msg_due = "TIE OFF";
            } else {
                w[prev] |= ENG_NOTE_WRAP | 63u << 6;
                seq_msg_due = "DRONE";
            }
            (void)eng_steps_set_notes((uint32_t)mod, w, (uint32_t)nn);
            return;
        }
        {
            uint32_t at = w[prev] & 63u, extra = 0, n;
            for (i = m = 0; i < nn; i++) {       /* a note of its own on k joins it */
                if (i != prev && ((w[i] >> 12) & 127u) == note && (w[i] & 63u) == k) {
                    extra = (w[i] >> 6) & 63u;
                    continue;
                }
                w[m++] = w[i];
                if (i == prev)
                    prev = m - 1;
            }
            nn = m;
            w[prev] = eng_note_end_on(w[prev], k, len);
            n = ((w[prev] >> 6) & 63u) + 1u + extra;
            if (wrap ? n > len : at + n > TRACK_STEPS)
                n = wrap ? len : TRACK_STEPS - at;
            w[prev] = (w[prev] & ~(63u << 6)) | (n - 1u) << 6;
        }
        seq_msg_due = "TIED";
    }
    (void)eng_steps_set_notes((uint32_t)mod, w, (uint32_t)nn);
}

/* LFO + FX with no step held, outside step record (#384, D-819: the owner's ruling of 2026-11-04): the selected row's
 * first note becomes a drone, the row's other notes go (DRONE); a row that is one drone already is an ordinary one-step
 * note on that step again (DRONE OFF); a row without notes: NOTHING TO DRONE (track.ts droneRow) */
static void seq_row_drone(void)
{
    uint32_t w[TRACK_NOTES_MAX], note;
    const uint32_t *ws;
    int mod = seq_module(), i, m, nn, first = -1, count = 0;
    if (mod < 0 || seq_held >= 0)
        return;
    note = seq_grid_note(seq_map(), seq_row);
    nn = eng_steps_notes((uint32_t)mod, &ws);
    for (i = 0; i < nn; i++)
        if (((ws[i] >> 12) & 127u) == note) {
            count++;
            if (first < 0 || (ws[i] & 63u) < (ws[first] & 63u))
                first = i;
        }
    if (first < 0) {
        seq_msg_due = "NOTHING TO DRONE";
        return;
    }
    for (i = m = 0; i < nn; i++)
        if (i == first) {
            uint32_t x = ws[i];
            if (count == 1 && eng_note_drone(x)) {
                w[m++] = x & ~(ENG_NOTE_WRAP | 63u << 6);
                seq_msg_due = "DRONE OFF";
            } else {
                w[m++] = x | ENG_NOTE_WRAP | 63u << 6;
                seq_msg_due = "DRONE";
            }
        } else if (((ws[i] >> 12) & 127u) != note)
            w[m++] = ws[i];
    (void)eng_steps_set_notes((uint32_t)mod, w, (uint32_t)m);
    seq_sync(mod);
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

/* SEL held + a key on the roll (#241): the pen. The selected row is that key's pitch (the keys' octave; off screen: the
 * view shows its fixed page, D-809), and the pitch sounds */
static void seq_pen(int mod, uint32_t n)
{
    int32_t note = clampi(53 + (int32_t)n + 12 * octave, 0, 127);
    seq_pen_ms = fm1_ms | 1u;
    seq_roll_show(note, 0);
    if (!sr_on || sr_preview)
        (void)eng_steps_hit_note((uint32_t)mod, (uint32_t)note, 0, 0);
}

/* a black key let go that sounded through a drum track (#368): its note ends (recording: it is recorded now) */
static void seq_thru_up(uint32_t n)
{
    if (n < 27u) {
        for (uint32_t j = 0; j < seq_thru_count[n]; j++) {
            uint32_t note = seq_thru_chord[n][j], held = 0;
            for (uint32_t k = 0; k < 27u; k++) if (k != n)
                for (uint32_t z = 0; z < seq_thru_count[k]; z++)
                    if (seq_thru_mod[k] == seq_thru_mod[n] && seq_thru_chord[k][z] == note) held = 1;
            if (!held) eng_steps_thru(seq_thru_mod[n], note, 0);
        }
        seq_thru_count[n] = 0;
    }
    if (n < 27u && seq_thru_note[n]) {
        eng_steps_thru(seq_thru_mod[n], seq_thru_note[n] - 1u, 0);
        seq_thru_note[n] = 0;
    }
}

/* ---- step record (#532, D-804..D-808) */

/* the note key n writes in step record on this grid: the roll its own pitch at the keys' octave; a drum grid as the keys
 * reach a Drum map everywhere (panel.c panel_key, the live take's rule, D-805): black keys 1..8 its rows, another key
 * its own note when the map repeats its rows, else nothing (-1) */
static int sr_pitch(int map, uint32_t n)
{
    int b = seq_black(n), own = clampi(53 + (int32_t)n + 12 * octave, 0, 127);
    if (map < 0)
        return own;
    if (b >= 0 && b < (int)ENG_DRUM_ROWS)
        return eng_drummap_note((uint32_t)map, (uint32_t)b);
    return eng_drummap_repeat((uint32_t)map) ? own : -1;
}

/* steps from..to replaced: the notes in seq_held_notes (the track as it was) less those starting on them, one starting
 * before `from` and sounding into it ending before it (a tie through a written step is cut, as a plain white key cuts it,
 * D-531), plus the chord's notes (with chord: a note still held ends on the cursor's step). Into the engine, the patch
 * and the editor (TRACK_NOW) */
static int sr_put(int mod, uint32_t from, uint32_t to, int chord)
{
    uint32_t w[TRACK_NOTES_MAX];
    uint32_t i, m = 0, len = (uint32_t)seq_len(mod);
    for (i = 0; i < seq_held_n; i++) {
        uint32_t x = seq_held_notes[i], at = x & 63u;
        if (at >= from && at <= to)
            continue;
        if (eng_note_through(x, from, len))      /* (across the loop point too, #384) */
            x = eng_note_cut_before(x, from, len);
        w[m++] = x;
    }
    if (chord && m + sr_n > TRACK_NOTES_MAX) { ui_msg("TRACK FULL: 128 NOTES", 1500); return 0; }
    for (i = 0; chord && i < sr_n; i++) {
        uint32_t end = sr_hold[i] ? sr_k : sr_end[i];
        w[m++] = sr_at[i] | (end - sr_at[i]) << 6 | (uint32_t)sr_note[i] << 12 | (uint32_t)sr_vel[i] << 19;
    }
    if (!eng_steps_set_notes((uint32_t)mod, w, m))
        seq_msg_due = "TRACK FULL: 128 NOTES";
    seq_sync(mod);
    ui_dirty = ui_dirty ? ui_dirty : 1;
    return 1;
}

/* step k made a rest: its notes go, a note sounding into it ends before it */
static void sr_clear(int mod, uint32_t k)
{
    seq_held_keep(mod);
    sr_put(mod, k, k, 0);
}

/* the cursor d steps on (a negative d back), wrapping at the pattern's ends; the view shows its 16 steps (D-806) */
static void sr_move(int mod, int32_t d)
{
    int32_t len = seq_len(mod), k = ((int32_t)sr_k + d) % len;
    if (k < 0)
        k += len;
    sr_k = (uint8_t)k;
    if (seq_pg != k / 16) {
        seq_pg = (uint8_t)(k / 16);
        ui_dirty = ui_dirty < 2u ? 1 : 2;       /* (the grid redraws its cells in place) */
    }
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

/* step record starts on step k (D-804); key: the white key REC held went down on (its release is nobody's), -1 none.
 * The caller ends REC's recording first (D-808): the keys would be recorded twice */
static void sr_start(int k, int key)
{
    int mod = seq_module();
    if (mod < 0 || k < 0 || k >= seq_len(mod))
        return;
    sr_on = 1;
    sr_k = (uint8_t)k;
    sr_keys = 0;
    sr_n = 0;
    sr_skip = key >= 0 ? 1u << key : 0u;
    sr_trk = seq_trk;
    sr_gen = pages_gen();
    seq_held = -1;
    sr_move(mod, 0);                             /* (the view shows the cursor's 16 steps) */
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

/* step record ends (HOME, SEQ, REC, ALGO, another page or patch): a chord still held is not written; its keys sound
 * until let go */
static void sr_stop(void)
{
    if (!sr_on)
        return;
    sr_on = 0;
    sr_skip = 0;
    sr_keys = 0;
    sr_n = 0;
    if (!ui_dirty)
        ui_dirty = 1;
}

/* LFO in step record (panel.c): no key held, a rest and on one; keys held, the tie: the notes still held go on through
 * the next step and the cursor moves there. At the pattern's last step a tie cannot go on (no tie across the loop's end,
 * D-531): the chord is written as it is, the held keys' releases then do nothing, the cursor wraps (D-807) */
static void sr_lfo(void)
{
    int mod = seq_module();
    uint32_t i;
    if (mod < 0)
        return;
    if (!sr_keys) {
        sr_clear(mod, sr_k);
        sr_move(mod, 1);
        return;
    }
    if ((int32_t)sr_k + 1 >= seq_len(mod)) {
        for (i = 0; i < sr_n; i++)
            if (sr_hold[i]) {
                sr_hold[i] = 0;
                sr_end[i] = sr_k;
            }
        sr_put(mod, sr_from, sr_k, 1);
        sr_skip |= sr_keys;
        sr_keys = 0;
        sr_n = 0;
        seq_msg_due = "NO TIE PAST THE END";
        sr_move(mod, 1);
        return;
    }
    sr_k++;
    sr_put(mod, sr_from, sr_k, 1);
    sr_move(mod, 0);                             /* (the view follows the cursor) */
}

/* K4 in step record: the cursor, nothing written (not while a chord is held: its notes started where it was) */
static void sr_knob(int32_t clicks)
{
    int mod = seq_module();
    if (mod >= 0 && !sr_keys && clicks)
        sr_move(mod, clicks);
}

/* a key in step record (seq_key). A press sounds its note through the track and joins the chord on the cursor's step;
 * the last release writes the chord and moves the cursor on. Black key 10 (no chord held): back one step, cleared */
static void sr_key(uint32_t n, int down)
{
    int mod = seq_module(), p;
    uint32_t bit = 1u << n, i;
    if (sr_skip & bit) {
        if (!down) {
            sr_skip &= ~bit;
            seq_thru_up(n);
        }
        return;
    }
    if (mod < 0)
        return;
    if (n == SR_BACK) {
        if (down && !sr_keys) {
            sr_move(mod, -1);
            sr_clear(mod, sr_k);
        }
        return;
    }
    if (!down) {
        if (!(sr_keys & bit)) {
            seq_thru_up(n);                      /* (a key held from before step record: its note ends) */
            return;
        }
        sr_keys &= ~bit;
        seq_thru_up(n);
        for (uint32_t j = 0; j < sr_count[n]; j++) {
            i = sr_of[n][j];
            if (i < sr_n && sr_hold[i] && !--sr_hold[i]) sr_end[i] = sr_k;
        }
        sr_count[n] = 0;
        if (!sr_keys) {                          /* the last key let go: the chord written, the cursor on one */
            int wrote = sr_put(mod, sr_from, sr_k, 1);
            sr_n = 0;
            if (wrote) sr_move(mod, 1);
        }
        return;
    }
    if ((p = sr_pitch(seq_map(), n)) < 0)
        return;                                  /* (a drum grid's key that reaches no row: silent, D-805) */
    if (seq_map() < 0 && (p < seq_roll_lo || p > seq_roll_lo + 7)) {
        seq_roll_show(p, 0);                     /* a note off the roll's view: the view moves to its page, as the pen's
                                                  * (#582, D-809), so its pitch and its tie show */
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
    if (!sr_keys) {                              /* a new chord on the cursor's step, over the track as it is now */
        sr_n = 0;
        sr_from = sr_k;
        seq_held_keep(mod);
    }
    uint8_t notes[8];
    uint32_t count = eng_steps_input_notes((uint32_t)mod, (uint32_t)p, notes), need = 0, j;
    /* Accept the whole gesture or none; never silently record half a chord. */
    for (j = 0; j < count; j++) {
        for (i = 0; i < sr_n && !(sr_note[i] == notes[j] && sr_at[i] == sr_k); i++);
        if (i == sr_n) need++;
    }
    if (sr_n + need > SR_NOTES) { ui_msg("CHORD FULL", 1500); return; }
    seq_thru_up(n);
    sr_count[n] = (uint8_t)count;
    seq_thru_mod[n] = (uint8_t)mod;
    for (j = 0; j < count; j++) {
        for (i = 0; i < sr_n && !(sr_note[i] == notes[j] && sr_at[i] == sr_k); i++);
        if (i == sr_n) {
            sr_note[i] = notes[j]; sr_at[i] = sr_k; sr_hold[i] = 0; sr_n++;
        }
        sr_vel[i] = (panel_held >> BTN_ACC & 1u) ? ACCENT_VEL : STEP_VEL;
        sr_hold[i]++;
        sr_of[n][j] = (uint8_t)i;
        if (seq_map() >= 0 || sr_preview) {
            uint32_t held = 0;
            for (uint32_t k = 0; k < 27u; k++)
                for (uint32_t z = 0; z < seq_thru_count[k]; z++)
                    if (seq_thru_mod[k] == (uint8_t)mod && seq_thru_chord[k][z] == notes[j]) held = 1;
            if (!held) eng_steps_thru((uint32_t)mod, notes[j], sr_vel[i]);
            seq_thru_chord[n][seq_thru_count[n]++] = notes[j];
        }
    }
    sr_keys |= bit;
}

/* Toggling preview does not write, move the cursor, or change the held chord. */
static void sr_preview_toggle(void)
{
    uint32_t n;
    sr_preview = !sr_preview;
    if (!sr_preview)
        for (n = 0; n < 27u; n++)
            if (sr_keys >> n & 1u)
                seq_thru_up(n);
    seq_pen_ms = fm1_ms | 1u;                     /* SEL's release must not open SONG */
    ui_msg(sr_preview ? "NOTE PREVIEW ON" : "NOTE PREVIEW OFF", 1500);
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

/* Step-record keys, or drum-grid rows and steps. Piano-roll playing is handled by panel_key. */
static void seq_key(uint32_t n, int down)
{
    int w = seq_white(n), b = seq_black(n), mod = seq_module(), map = seq_map();
    int fx = (int)(panel_held >> BTN_ACC & 1u);
    if (sr_on) {                                 /* (on the roll SEL held + any key is the pen, D-804: nothing written) */
        if (down && mod >= 0 && map < 0 && (panel_held >> BTN_PEN & 1u)) {
            seq_roll_aim(mod);
            seq_pen(mod, n);
            ui_dirty = ui_dirty ? ui_dirty : 1;
            return;
        }
        sr_key(n, down);
        return;
    }
    if (map < 0)
        return;                                  /* melodic keys belong to panel_key outside step record */
    if (!down) {
        if (w >= 0 && seq_held == seq_pg * 16 + w) {
            seq_held_tap_done(mod);              /* (a tap: its step switched now; a step used while held: nothing) */
            seq_held = -1;
            ui_dirty = ui_dirty ? ui_dirty : 1;  /* (the hint line: no step held, #450) */
        }
        seq_thru_up(n);
        return;
    }
    if (mod < 0)
        return;
    if (b >= 0) {
        if (b >= (int)ENG_DRUM_ROWS)
            return;
        /* the row's note sounds through the track while the key is held (#368, the owner 2026-10-28: running or stopped)
         * and the row is picked, REC on or off (#395); while REC records the track (it is armed: seq_rec_sync) the note is
         * recorded as a live take records it (the nearest step, the whole steps held, at least one: eng_steps_rec, laid
         * over the track by seq_take) */
        seq_row = (uint8_t)b;
        seq_thru_up(n);
        seq_thru_mod[n] = (uint8_t)mod;
        seq_thru_note[n] = (uint8_t)(seq_row_note(map, (uint32_t)b) + 1u);
        eng_steps_thru((uint32_t)mod, seq_thru_note[n] - 1u, fx ? ACCENT_VEL : STEP_VEL);
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
        seq_held_tap_done(mod);                  /* (a white key still held, not used: its step switched first) */
        seq_held_keep(mod);
        if (panel_held >> BTN_LFO & 1u) {        /* LFO held: the tie (not a held step) */
            seq_roll_tie(mod, (uint32_t)k, note);
            seq_sync(mod);
            ui_dirty = ui_dirty ? ui_dirty : 1;
            return;
        }
        seq_held = (int8_t)k;
        if (!fx) {                               /* a plain press: the step held, switched on its release if not used */
            seq_held_turned = 1;                 /* (nothing to undo) */
            seq_held_tap = 1;
            seq_held_note = (uint8_t)note;
            ui_dirty = ui_dirty ? ui_dirty : 1;  /* (the hint line: a step held, #450) */
            return;
        }
        have = eng_steps_note((uint32_t)mod, (uint32_t)k, note);
        if (have)                                /* FX held: the accent on / off, at the press */
            eng_steps_overdub((uint32_t)mod, (have & ~(127u << 19)) | (uint32_t)(((have >> 19) & 127u) == ACCENT_VEL ? STEP_VEL : ACCENT_VEL) << 19);
        else                                     /* (a step a tie runs through: the tie cut before it, #368 on a drum track) */
            seq_roll_toggle(mod, (uint32_t)k, note, ACCENT_VEL);
        seq_sync(mod);
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
}

/* the held step's note in the selected row, the step used (its release switches nothing) and an FX press's switch undone
 * once (an edit means it should play): its note word, put there if it was not, 0 when it cannot be there */
static uint32_t seq_grid_held(int map, int mod)
{
    uint32_t note = seq_grid_note(map, seq_row), w;
    seq_held_tap = 0;
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

/* REC's recording follows the armed set (#395): a Steps track records while REC is on and it is armed, the others not (the
 * engine's flag per track, eng_steps_rec); none while the count-in runs (#414). Every pass (seq_take), and at once after
 * REC or an arm */
static void seq_rec_sync(void)
{
    int t, n = eng_steps_count();
    for (t = 0; t < n; t++) {
        int mod = eng_steps_module((uint32_t)t);
        eng_steps_rec((uint32_t)mod, seq_rec && !seq_cin && seq_mod_armed(mod));
    }
}

/* recording ends (REC again, PLAY, any stop of the transport): the notes still held are recorded when let go; a
 * count-in still running is dropped, nothing recorded */
static void seq_rec_off(void)
{
    seq_rec = 0;
    if (seq_cin)                                 /* (REC off in the count-in: its click ends too) */
        seq_cin_engine(0u);
    seq_cin = 0;
    seq_rec_sync();
    ent_keys = 0;
    ui_dirty = 2;
}

/* the armed set becomes `mask` (#395: SEL on a device page or an environment row, the SEQ page's track), the editor's FM-1
 * tab told; while REC is on, the tracks armed now record and the others stop (seq_rec_sync) */
static void seq_arm_set(eng_mset_t mask)
{
    if (mset_eq(mask, eng_arm_mask_get()))
        return;
    eng_arm_mask(mask);
    m1_arms_now(eng_arm_mask_get());
    seq_rec_sync();
    seq_track_redraw();
}

/* the SEQ page arms the track it shows (#395): opening the page (panel.c page_show), ALGO there (seq_select), or another
 * patch while it shows (seq_poll) arm that track and disarm the rest. opening: the page opens, and while REC records a
 * track (the first armed) it shows that one, so the recording goes on there (D-547) */
static uint32_t seq_armed_gen;          /* the patch the page last armed its track in */
static void seq_arm_shown(int opening)
{
    int mod, t = seq_armed_trk();
    if (opening && seq_rec && t >= 0 && (uint32_t)t != seq_trk) {
        seq_trk = (uint8_t)t;
        seq_pg = 0;
        seq_row = 0;
        seq_held = -1;
        seq_roll_trk = -1;
    }
    seq_clamp();
    mod = seq_module();
    seq_armed_gen = pages_gen();
    if (mod >= 0) {
        eng_mset_t was = eng_arm_mask_get();
        seq_arm_set(mset_one((uint32_t)mod));
        if (!mset_eq(eng_arm_mask_get(), was))          /* (#582: the page changed the arming, which stays after it: seq_leave says so) */
            seq_page_armed = (uint8_t)(seq_trk + 1u);
    }
}

/* the bar names what records (D-549): REC and the track, REC n TRACKS, or REC: NO TRACK ARMED (REC still runs: a track
 * armed later records) */
static void seq_rec_msg(void)
{
    int t, n = 0, first = -1;
    char m[32], num[8], name[TRACK_NAME_MAX + 8];
    for (t = 0; t < eng_steps_count(); t++)
        if (seq_mod_armed(eng_steps_module((uint32_t)t)) && !n++)
            first = t;
    if (!n)
        put(m, "REC: NO TRACK ARMED")[0] = 0;
    else if (n == 1) {
        seq_name((uint32_t)first, name);
        put(put(m, "REC "), name)[0] = 0;
    } else {
        fmt_int(num, n);
        put(put(put(m, "REC "), num), " TRACKS")[0] = 0;
    }
    ui_msg(m, 1200);
}

/* REC let go (panel.c, which started the transport first when it was stopped; not after REC held + a black key armed a
 * track), on any page (#395): recording off, or on for the armed Steps tracks, after the count-in when the setting is on
 * (#414: the bar says COUNT-IN until its first beat). The page stays */
static void seq_rec_press(void)
{
    sr_stop();                                   /* (REC ends step record, then acts: D-808) */
    if (seq_rec) {
        seq_rec_off();
        ui_msg("REC OFF", 1000);
        return;
    }
    seq_rec = 1;
    if (cfg.count_in) {
        seq_cin = 1;
        seq_cin_bars = cfg.count_in;
        seq_cin_at = eng_ticks();
        seq_cin_shown = 0xFF;
        seq_cin_lit = 1;
        seq_cin_engine(seq_cin_bars);            /* (a click on each beat, D-803) */
        ui_msg("COUNT-IN", 4000);
    } else
        seq_rec_msg();
    seq_rec_sync();
    ui_dirty = 2;
}

/* REC let go on the SEQ page (panel.c; the owner, 2026-11-02: D-548, D-804, D-808): step record on, it ends; else
 * stopped, step record starts on the first step of the page shown (never where the cursor last was); running, REC
 * records as on every page. The page stays */
static void sr_rec_tap(void)
{
    if (sr_on)
        sr_stop();
    else if (seq_rec || eng_transport_running())
        seq_rec_press();
    else if (seq_module() < 0)
        ui_msg("NO STEPS MODULE", 1000);
    else
        sr_start(seq_pg * 16, -1);
}

/* REC held + white key n on the SEQ page (panel.c): step record from that step, stopped or running (in step record: the
 * cursor moves there, a chord held is not written). While REC records, the recording ends first (D-808). REC's release
 * then does nothing. A key handler: state only */
static void sr_rec_white(uint32_t n)
{
    int mod = seq_module(), k = seq_pg * 16 + seq_white(n);
    if (mod < 0 || seq_white(n) < 0 || k >= seq_len(mod))
        return;
    if (seq_rec) {
        seq_rec_off();
        seq_msg_due = "REC OFF: STEP RECORD";
    }
    sr_stop();
    sr_start(k, (int)n);
}

/* The count-in (#414), every pass while it runs (seq_take). Its bars count from the transport's start (eng_run_ticks:
 * where the tracks' bars are). REC with the transport stopped started it: the count-in is its first bars; running
 * already: it begins at the next bar line and lasts the set bars, so recording always begins on a bar. Each beat the bar
 * says COUNT-IN and the beat (with two bars the bar before it: 1.3) and REC's LED is on for the beat's first half; the
 * keys sound as ever and the tracks do not record (seq_rec_sync). When it ends the tracks record and the bar names them */
#define CIN_BAR 96u                              /* ticks a bar: four beats of 24 */
static void seq_cin_poll(void)
{
    int32_t rel = eng_run_ticks();
    uint32_t into, k;
    char m[24], num[8], *p;
    if (rel < 0)
        return;                                  /* (the engine has not taken the start yet) */
    if (seq_cin == 1u) {
        uint32_t start = eng_ticks() - (uint32_t)rel, from = 0;   /* the tick the transport started on */
        if ((int32_t)(seq_cin_at - start) > 0)   /* running already when REC was pressed: from the next bar line */
            from = (seq_cin_at - start + CIN_BAR - 1u) / CIN_BAR * CIN_BAR;
        seq_cin_end = from + seq_cin_bars * CIN_BAR;
        seq_cin = 2;
    }
    if ((uint32_t)rel >= seq_cin_end) {          /* it ends: the armed tracks record from this bar */
        seq_cin = 0;
        seq_rec_sync();
        seq_rec_msg();
        ui_dirty = ui_dirty ? ui_dirty : 1;      /* (the footer: REC and the track) */
        return;
    }
    if (seq_cin_end - (uint32_t)rel > seq_cin_bars * CIN_BAR) {   /* before the bar line it begins on */
        seq_cin_lit = 1;
        return;
    }
    into = seq_cin_bars * CIN_BAR - (seq_cin_end - (uint32_t)rel);   /* ticks into the count */
    seq_cin_lit = (uint8_t)(into % 24u < 12u);
    k = into / 24u;                              /* the beat, 0.. over the bars */
    if (k == seq_cin_shown)
        return;
    seq_cin_shown = (uint8_t)k;
    p = put(m, "COUNT-IN ");
    if (seq_cin_bars > 1u) {
        fmt_int(num, (int32_t)(k / 4u) + 1);
        p = put(p, num);
        *p++ = '.';
    }
    fmt_int(num, (int32_t)(k % 4u) + 1);
    put(p, num)[0] = 0;
    ui_msg(m, 4000);                             /* (the next beat's message replaces it, or the end's) */
}

/* REC held + a black key (any page): that track armed, or disarmed if it was */
static void seq_arm_key(uint32_t n)
{
    int b = seq_black(n), mod;
    char m[32], name[TRACK_NAME_MAX + 8];
    if (seq_no_track(b))
        return;
    mod = eng_steps_module((uint32_t)b);
    eng_arm_mask(mset_flip(eng_arm_mask_get(), (uint32_t)mod));   /* (#191: one of the armed set, the others stay) */
    m1_arms_now(eng_arm_mask_get());
    seq_rec_sync();                              /* (REC on: it records from now on, or no longer: #395) */
    seq_name((uint32_t)b, name);
    put(put(m, name), mset_has(eng_arm_mask_get(), (uint32_t)mod) ? " ARMED" : " DISARMED")[0] = 0;
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

/* the page is left: the roll's keyboard forgets its keys (REC goes on: it is global, #395); step record ends */
static void seq_leave(void)
{
    ent_keys = 0;
    sr_stop();
    if (seq_page_armed && page != PAGE_SONG) {   /* the page armed its track (#582): on the way out the bar says it stays so,
                                                  * the footer's ARM name has a reason (not on the way to the SONG page,
                                                  * the SEQ page's own: said when that is left for another) */
        static char m[32];
        char name[TRACK_NAME_MAX + 8];
        uint32_t t = seq_page_armed - 1u;
        seq_page_armed = 0;
        if ((int)t < eng_steps_count() && seq_mod_armed(eng_steps_module(t))) {
            seq_name(t, name);
            put(put(m, name), " STAYS ARMED")[0] = 0;
            seq_msg_due = m;
            seq_msg_ms = 1500;
        }
    }
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
    int t = seq_armed_trk(), k, more = 0;
    char name[TRACK_NAME_MAX + 8], *q;
    if (t < 0)
        return 0;
    for (k = 0; k < eng_steps_count(); k++)      /* (#582: the other armed tracks counted, "ARM DRUMS +1") */
        more += k != t && seq_mod_armed(eng_steps_module((uint32_t)k));
    seq_name((uint32_t)t, name);
    *rec = seq_rec != 0;                         /* (REC on: the armed tracks record, #395; COUNT-IN until then, #414) */
    q = put(put(out, seq_cin ? "COUNT-IN " : *rec ? "REC " : "ARM "), name);
    if (more) {
        q = put(q, " +");
        q[0] = (char)('0' + (more > 9 ? 9 : more));
        q[1] = 0;
    } else
        q[0] = 0;
    return 1;
}

/* the main loop, every pass (seq_poll): the notes the engine recorded laid over their tracks; the transport stopped (PLAY,
 * the editor, MIDI Stop) ends recording (and a count-in), the count-in goes on, else the armed tracks record
 * (seq_rec_sync: another patch, an arm); REC's LED off the page */
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
    if (seq_rec && !eng_transport_running())
        seq_rec_off();
    if (seq_cin)
        seq_cin_poll();
    seq_rec_sync();
    if (page != PAGE_SEQ)
        fm1_led_key(BTN_REC, seq_rec_lit());
}

/* ---- the LCD */

/* the roll's lowest pitch as the bar shows it (the roll opened first: the bar may come before the grid), 0xFF a drum grid */
static uint8_t seq_bar_lo(void)
{
    int mod = seq_module();
    if (mod < 0 || seq_map() >= 0)
        return 0xFFu;
    seq_roll_aim(mod);
    return seq_roll_lo;
}

/* the top bar on the SEQ page: the track's name, REC / ARM, the roll's pitches (the grid's TRACK line counts the tracks,
 * the rows show the row) */
static void seq_bar(void)
{
    char b[48], name[TRACK_NAME_MAX + 8], *p = b;
    if (!eng_steps_count()) {
        bar_text("NO STEPS MODULE", C_ACC);
        return;
    }
    seq_name(seq_trk, name);
    if (sr_on) {                                 /* step record (#532): STEP n/16 first, the cursor's step of the pattern's
                                                  * length (#582: it wraps from 16/16 to 1/16) */
        char num[8];
        int mod = seq_module();
        fmt_int(num, (int32_t)sr_k + 1);
        p = put(put(put(p, "STEP "), num), "/");
        fmt_int(num, mod >= 0 ? seq_len(mod) : 16);
        p = put(put(p, num), "  ");
    }
    p = put(p, name);
    if (seq_mod_armed(seq_module()))             /* the track shown is armed (#179): REC records it (#395) */
        p = put(p, seq_rec ? " REC" : " ARM");
    if (seq_bar_lo() != 0xFFu)                   /* the roll: the pitches shown, C3-G3 (D-809) */
        p = seq_note_name(put(seq_note_name(put(p, " "), seq_roll_lo), "-"), seq_roll_lo + 7u);
    p = seq_pat_text(p);                         /* (after REC / ARM: name REC C3-G3 P03>P04) */
    seq_shown_pat = seq_pat_state();
    seq_shown_mark = seq_bar_mark();
    seq_shown_sr = (uint8_t)(sr_on ? sr_k + 1u : 0u);
    seq_shown_lo = seq_bar_lo();
    *p = 0;
    bar_text(b, seq_rec ? C_RED : C_ACC);
}

/* ---- P-locks on the FM-1 (#524, the owner's design of 2026-11-01, #519 Q2 and Q11): a step held, ALGO pages through the
 * pages of the devices the track drives (its first stop is the step's note, as before); K1..K4 lock that page's rows on the
 * held step, from the lock's value or the row's normal one. Turning a row back to its normal value (or past it) removes the
 * lock. The locks go into the pattern the track plays (one it has not got is made from pattern 1 first, as an edit of its
 * notes makes it), the running patch (SAVE keeps them) and the editor (LOCKS_NOW). A step with locks has a corner mark on
 * its cells; while it is held the track line lists the page's rows, a locked one marked * */

/* the pages of the devices the track shown drives (pages_ui.c pg_dev[].track), as pg_page indices into out: their count */
static uint32_t seq_lock_pages(uint16_t *out, uint32_t max)
{
    int mod = seq_module();
    uint32_t d, e, g, n = 0;
    if (mod < 0)
        return 0;
    pages_ensure();
    for (e = 0; e < pg_ndev && pg_dev[e].module != mod; e++)
        ;
    if (e == pg_ndev)
        return 0;
    for (d = 0; d < pg_ndev; d++)
        if (pg_dev[d].track == e)
            for (g = 0; g < pg_dev[d].npg && n < max; g++)
                out[n++] = (uint16_t)(pg_dev[d].pg0 + g);
    return n;
}
/* the page ALGO's stop shows (seq_lpg), 0 the note's stop or none */
static const ppage_t *seq_lock_page(void)
{
    uint16_t l[PG_PAGES];
    uint32_t n = seq_lpg ? seq_lock_pages(l, PG_PAGES) : 0;
    return seq_lpg && seq_lpg <= n ? &pg_page[l[seq_lpg - 1u]] : 0;
}
/* the pattern whose locks the grid shows: the one the track plays, or its pattern 1 when it has not got that one */
static uint32_t seq_lock_pat(int mod)
{
    int p = eng_pattern_playing((uint32_t)mod);
    return p > 0 && eng_pattern_has((uint32_t)mod, (uint32_t)p) ? (uint32_t)p : 0u;
}
/* the held step used (its release switches nothing) and an FX press's switch undone once (a knob turned on it: the step
 * should keep what it had; as seq_grid_held, without putting a note there: a lock needs none) */
static void seq_held_undo(int mod)
{
    seq_held_tap = 0;
    if (seq_held_turned)
        return;
    seq_held_turned = 1;
    (void)eng_steps_set_notes((uint32_t)mod, seq_held_notes, seq_held_n);
    seq_sync(mod);
}
/* ALGO with a step held: the next / previous stop (0 the note, then the device's pages; it stays at the ends) */
static void seq_lock_step(int32_t d)
{
    uint16_t l[PG_PAGES];
    int mod = seq_module();
    uint32_t n = seq_lock_pages(l, PG_PAGES);
    int32_t s = clampi((int32_t)seq_lpg + (d > 0 ? 1 : -1), 0, (int32_t)n);
    char m[32];
    if (mod < 0 || seq_held < 0)
        return;
    seq_held_undo(mod);
    if (!n) {
        ui_msg("NO DEVICE TO LOCK", 1200);
        return;
    }
    seq_lpg = (uint8_t)s;
    if (!s)
        put(m, "STEP NOTE")[0] = 0;
    else {
        const ppage_t *pg = &pg_page[l[s - 1]];
        char t[16];
        caps(t, pg->name, pg->nlen, 12u);
        put(put(m, "LOCK "), t)[0] = 0;
        if (pg->parts > 1u) {
            char num[8], *q = m + str_len(m);
            *q++ = ' ';
            fmt_int(num, pg->part + 1);
            q = put(q, num);
            *q++ = '/';
            fmt_int(num, pg->parts);
            put(q, num)[0] = 0;
        }
    }
    ui_msg(m, 1200);
    ui_dirty = ui_dirty ? ui_dirty : 1;
}
/* K1..K4 (knob k) with a step held on a lock page: its row locked on the step, from the lock's value or the normal one */
static void seq_lock_turn(uint32_t k, int32_t clicks, int fast)
{
    const ppage_t *pg;
    int mod = seq_module(), had, p, made;
    uint32_t m, j;
    int32_t normal, cur = 0, v;
    char msg[40], t[16], num[16], unit[8];
    if (mod < 0 || seq_held < 0 || !(pg = seq_lock_page()) || k >= pg->nrows)
        return;
    m = pg->mod[k];
    j = pg->par[k];
    seq_held_undo(mod);
    if (pages_lock_turn(pg, k, 0, 1, 0, &v) < 0) {
        ui_msg("THIS ROW CANNOT LOCK", 1200);
        return;
    }
    made = !eng_pattern_has((uint32_t)mod, (uint32_t)eng_pattern_playing((uint32_t)mod));
    if ((p = eng_locks_pattern((uint32_t)mod)) < 0)
        return;
    if (made)                                    /* (a pattern made from pattern 1: its notes into the patch and the editor) */
        seq_sync(mod);
    normal = eng_get_param(m, j);
    had = eng_lock_get((uint32_t)mod, (uint32_t)p, (uint32_t)seq_held, m, j, &cur);
    if (!had)
        cur = normal;
    (void)pages_lock_turn(pg, k, cur, clicks, fast, &v);
    caps(t, pg->lab[k], pg->llen[k], 12u);
    if (had && (v == normal || (cur > normal) != (v > normal))) {   /* back to the normal value, or past it: no lock */
        (void)eng_lock_set((uint32_t)mod, (uint32_t)p, (uint32_t)seq_held, m, j, 0, 0, 0);
        put(put(msg, t), ": NO LOCK")[0] = 0;
    } else if (v == cur)
        return;
    else {
        if (eng_lock_set((uint32_t)mod, (uint32_t)p, (uint32_t)seq_held, m, j, row_more(pg, k), v, 1) < 0) {
            ui_msg("NO ROOM FOR MORE LOCKS", 1500);
            return;
        }
        value_parts(&DEFS[eng_type(m)], j, v, num, unit);
        put(put(put(put(put(msg, "LOCK "), t), " "), num), unit[0] ? " " : "")[0] = 0;
        put(msg + str_len(msg), unit)[0] = 0;
    }
    if (!m1_patch_locks()) {                     /* (the patch would outgrow the FM-1's bytes: the edit is undone) */
        if (had)
            (void)eng_lock_set((uint32_t)mod, (uint32_t)p, (uint32_t)seq_held, m, j, 0, cur, 1);
        else
            (void)eng_lock_set((uint32_t)mod, (uint32_t)p, (uint32_t)seq_held, m, j, 0, 0, 0);
        ui_msg("PATCH FULL", 1500);
        return;
    }
    m1_locks_now((uint32_t)mod, (uint32_t)p);
    ui_msg(msg, 1200);
    ui_dirty = ui_dirty ? ui_dirty : 1;
}
/* the track line while a step is held on a lock page: the page's rows, a row the step locks marked * */
static int seq_lock_line(int mod, char *line, uint32_t max)
{
    const ppage_t *pg = seq_held >= 0 ? seq_lock_page() : 0;
    uint32_t k, p;
    char *q = line, t[16];
    if (!pg)
        return 0;
    p = seq_lock_pat(mod);
    for (k = 0; k < pg->nrows && (uint32_t)(q - line) + 16u < max; k++) {
        caps(t, pg->lab[k], pg->llen[k], 8u);
        if (k)
            q = put(q, "  ");
        if (eng_lock_get((uint32_t)mod, p, (uint32_t)seq_held, pg->mod[k], pg->par[k], 0))
            *q++ = '*';
        q = put(q, t);
    }
    *q = 0;
    return 1;
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
 *   y 196  the playhead: a coral tick under its column; y 199 step record's cursor, a sky tick (its column's empty cells
 *          tinted sky, #532)
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
#define C_CUR 0x3AEFu                   /* step record's cursor (#532): its column's empty cells (a dark sky) */
#define GRID_CUR 0x100u                 /* a cell's code: in step record's cursor column */
#define GRID_CUR_Y (GRID_TICK_Y + 3u)   /* the cursor's tick: 2 px under the playhead's */
#define GRID_LOCK 0x200u                /* a cell's code: its step has P-locks (#524): a gold corner mark, top right */
#define GRID_DRONE 0x400u               /* a cell's code: a drone starts there (#384): the tie's band comes in at its left */
static uint16_t seq_grid_cell[ENG_DRUM_ROWS][16];  /* the cells as drawn (seq_grid_state's codes) */
static int8_t seq_grid_row = -1, seq_grid_tick = -2; /* the selected row, the playhead's column as drawn (-1 none) */
static int8_t seq_grid_cur = -2;        /* step record's cursor column as drawn (-1 none) */
static uint8_t seq_grid_lo = 0xFFu;     /* the roll's lowest pitch as drawn (0xFF: a drum grid's names) */
static uint8_t seq_grid_ok;             /* the grid is on the LCD (else the next draw is a whole one) */
static uint32_t seq_grid_mark;          /* the roll's markers as drawn: bit c a note above the window on column c, bit 16 + c
                                         * one below */
static char seq_grid_text[3][48];       /* the info, track and hint lines as drawn */

static uint32_t seq_grid_x(uint32_t i) { return GRID_X + 11u * i + 2u * (i / 4u); }

/* a cell's code: GRID_PAST, GRID_TIE, else bit 0 a hit, bit 1 its accent, bits 2..6 its chance code (an empty cell:
 * GRID_TINT in a C row), bit 7 the step playing; GRID_CUR in step record's cursor column. w: the note word starting
 * there, 1 a note through it, 0 none */
static uint32_t seq_grid_state(uint32_t w, int k, int32_t len, int pos, int tint, int cur)
{
    uint32_t s = 0;
    if (k >= len)
        return GRID_PAST;
    if (w == 1u)
        return GRID_TIE;                         /* (a tie looks the same in the cursor's column: its tick shows it) */
    if (cur && !w)
        return GRID_CUR | (tint ? GRID_TINT : 0u);
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
    uint16_t empty = (s & GRID_CUR) ? C_CUR : (s & 0x80u) ? C_HINT : (s & 0x7Fu) == GRID_TINT ? ((i & 3u) ? C_CROW : C_CBEAT)
                     : (i & 3u) ? C_TRACK : C_BEAT;
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
    if (s & GRID_DRONE)                          /* a drone (#384): tied round the loop onto its own step */
        lcd_fill(x, y + GRID_CH / 2u - 2u, 3, 5, C_DIM);
    if (s & GRID_LOCK) {                         /* a step with P-locks (#519 Q11): a corner of 4, 3, 2, 1 px */
        lcd_fill(x + GRID_CW - 4u, y, 4, 1, P_GOLD);
        lcd_fill(x + GRID_CW - 3u, y + 1u, 3, 1, P_GOLD);
        lcd_fill(x + GRID_CW - 2u, y + 2u, 2, 1, P_GOLD);
        lcd_fill(x + GRID_CW - 1u, y + 3u, 1, 1, P_GOLD);
    }
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
    uint32_t cell[ENG_DRUM_ROWS][16], note[ENG_DRUM_ROWS], r, i, lo = map >= 0 ? 0xFFu : seq_roll_lo, mark = 0, locked = 0, hit = 0;
    const uint32_t *ws;
    int nn = eng_steps_notes((uint32_t)mod, &ws), j, pos = eng_steps_pos((uint32_t)mod), tick;
    int32_t len = seq_len(mod), k0 = seq_pg * 16;
    char line[64], num[8], *p;
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
        seq_grid_cur = -2;
        seq_grid_mark = 0;
        seq_grid_ok = 0;
    }
    for (r = 0; r < ENG_DRUM_ROWS; r++) {        /* the page's notes, by row, from one pass over the track's notes */
        note[r] = seq_grid_note(map, r);
        for (i = 0; i < 16u; i++)
            cell[r][i] = 0;
    }
    for (j = 0; j < nn; j++) {
        int k = (int)(ws[j] & 63u) - k0, c;
        uint32_t pn = (ws[j] >> 12) & 127u;
        if (map < 0 && (pn < lo || pn > lo + 7u))    /* the roll: a note above / below the window, on the steps it sounds */
            for (c = 0; c < 16; c++)
                if (k0 + c < len && (c == k || eng_note_through(ws[j], (uint32_t)(k0 + c), (uint32_t)len)))
                    mark |= 1u << (c + (pn < lo ? 16 : 0));
        for (r = 0; r < ENG_DRUM_ROWS; r++)
            if (((ws[j] >> 12) & 127u) == note[r]) {
                if (k >= 0 && k < 16 && cell[r][k] <= 1u)
                    cell[r][k] = ws[j];
                for (c = 0; c < 16; c++)         /* (the steps it goes on through, across the loop point too: #384) */
                    if (!cell[r][c] && eng_note_through(ws[j], (uint32_t)(k0 + c), (uint32_t)len))
                        cell[r][c] = 1u;
            }
    }
    seq_grid_line(0, 26, info, C_FG, 224);
    {                                            /* the steps with P-locks (#524): bit i; and those with a hit shown */
        uint32_t lp = seq_lock_pat(mod);
        for (i = 0; i < 16u; i++)
            if (k0 + (int)i < len && eng_locks_step((uint32_t)mod, lp, (uint32_t)(k0 + (int)i)))
                locked |= 1u << i;
        for (r = 0; r < ENG_DRUM_ROWS; r++)
            for (i = 0; i < 16u; i++)
                if (cell[r][i] > 1u)
                    hit |= 1u << i;
    }
    for (r = 0; r < ENG_DRUM_ROWS; r++) {
        int tint = map < 0 && note[r] % 12u == 0u;
        if (!seq_grid_ok || ((int)r == seq_grid_row) != (r == seq_row) || lo != seq_grid_lo)
            seq_grid_name(map, r);
        for (i = 0; i < 16u; i++) {
            uint32_t s = seq_grid_state(cell[r][i], k0 + (int)i, len, pos, tint, sr_on && k0 + (int)i == sr_k);
            if ((locked >> i & 1u) && s != GRID_PAST && s != GRID_TIE && (hit >> i & 1u ? cell[r][i] > 1u : r == seq_row))
                s |= GRID_LOCK;                  /* (on the step's hits; a step without one: the selected row's cell) */
            if (s != GRID_PAST && cell[r][i] > 1u && eng_note_drone(cell[r][i]))
                s |= GRID_DRONE;
            if (s != seq_grid_cell[r][i]) {
                seq_grid_paint(r, i, s, seq_grid_cell[r][i]);
                seq_grid_cell[r][i] = (uint16_t)s;
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
    tick = sr_on && sr_k >= k0 && sr_k < k0 + 16 ? sr_k - k0 : -1;
    if (tick != seq_grid_cur) {                  /* step record's cursor tick: off the old column, onto the new */
        if (seq_grid_cur >= 0)
            lcd_fill(seq_grid_x((uint32_t)seq_grid_cur), GRID_CUR_Y, GRID_CW, 2, C_BG);
        if (tick >= 0)
            lcd_fill(seq_grid_x((uint32_t)tick), GRID_CUR_Y, GRID_CW, 2, P_SKY);
        seq_grid_cur = (int8_t)tick;
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
    {                                            /* the hints where they fit (#231; the track shown is armed: #395; step
                                                  * record's, #532) */
        char *q = put(put(p, "  "), sr_on ? HINT_ROW_SR_ACCENT : HINT_ROW_TRACK);   /* (controls.h, #553) */
        *put(put(q, "  "), sr_on ? HINT_ROW_SR_BACK : HINT_ROW_CLEAR) = 0;
        if (text_w(&FONT_S, line, -1) > 224u)
            *q = 0;
        if (text_w(&FONT_S, line, -1) > 224u)
            *p = 0;
    }
    if (seq_lock_line(mod, line, sizeof line))  /* a step held on a lock page: its rows, the locked ones marked */
        seq_grid_line(1, 202, line, P_GOLD, 224);
    else
        seq_grid_line(1, 202, line, C_DIM, 224);
    /* the hint line (FONT_S, at most 228 px: export-defs checks it), in the controls table's words (controls.ts HINTS,
     * #553): a step held, its knobs; a track of more than 16 steps, OCT's pages (#490); else SEL's SONG page */
    if (sr_on)
        hint = map < 0 && !sr_preview ? HINT_STEP_SILENT : HINT_STEP_RECORD;
    else if (seq_play_keys())
        hint = seq_kbd() ? HINT_LIVE : HINT_ROLL;
    else if (seq_held >= 0 && seq_lock_page())
        hint = HINT_HELD_LOCK;
    else if (seq_held >= 0)
        hint = HINT_HELD_DRUM;
    else if (map >= 0 && seq_rec && seq_mod_armed(mod))
        hint = len > 16 ? HINT_DRUM_REC_LONG : HINT_DRUM_REC;
    else if (map >= 0)
        hint = len > 16 ? HINT_DRUM_LONG : HINT_DRUM;
    else
        hint = HINT_ROLL;
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
            text_bc(&FONT_S, 10, 222, HINT_NO_TRACK, C_HINT, C_BG, 224, TA_LEFT);
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
 *   K1              the entry's pattern; on END: adds an entry (the selected pattern, no shift); FX held: a copy of the
 *                   entry inserted before it
 *   K2              the entry's shift, -12..+12 semitones (a track that plays a Drum map is never shifted)
 *   K4              right: the song plays (from the end of each track's pass, its first entry), left: the pattern again
 *   ALGO            the song, 1..8 (while one plays, that one plays)
 *   SEQ held + REC  deletes the entry, asked first (REC again within 3 s), as the track clear
 *   PRESET          the pattern, as on the SEQ page
 *   SEL / HOME      back to the SEQ page
 * The entry the selected track plays is marked (a coral triangle and number, #582; stopped: none, the bar says SONG n
 * STOPPED); only the rows that changed are redrawn. Edits go into the running patch (SAVE
 * keeps them) and to the editor (SONG_NOW, PATTERN_NOW). */
#define SONG_ROWS 8u
#define SONG_Y 44u
#define SONG_RH 19u
static uint8_t song_sel;                /* the song shown (0..ENG_SONGS - 1) */
static uint8_t song_cur, song_top;      /* the cursor (an entry, or the song's length: END), the first row shown */
static char song_text[SONG_ROWS + 3u][48];   /* the rows, the info, the footer and the hint as drawn (a row's first byte: 1 the cursor, 2 not, | 4 the entry playing) */
static uint8_t song_ok;                 /* the page is on the LCD as song_text says */
static int16_t song_shown_play = -2;    /* the entry playing as drawn */
static int8_t song_shown_run = -1;      /* the transport as the bar last said it (SONG n PLAYS / STOPPED) */
                                        /* song_del_at: SEQ held + REC: fm1_ms | 1 of the press that asked, 0 none */
static uint8_t song_del_k;              /* ... the entry it asked for */

static int song_len(void) { return eng_song_len(song_sel); }
/* the entry the selected track plays in the song shown, -1 when that song does not play or the transport is stopped
 * (#582: stopped, no marker) */
static int song_playing(void)
{
    int mod = seq_module();
    return mod >= 0 && eng_song() == song_sel + 1 && eng_transport_running() ? eng_song_entry((uint32_t)mod) : -1;
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
    {
        int mod = seq_module();
        char *q = put(put2(put(m, "PATTERN "), p + 1), eng_song() ? " (SONG PLAYS)" : eng_transport_running() ? " NEXT" : "");
        if (!eng_song() && p > 0 && mod >= 0 && !eng_pattern_has((uint32_t)mod, (uint32_t)p))
            q = put(q, ": COPY OF 01");             /* (#582: a pattern the track has not got plays its pattern 1, and an
                                                     * edit makes it from that first) */
        q[0] = 0;
    }
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
        if (song_cur >= n) {                     /* END: a new entry, the selected pattern (#582: as PRESET picked it; it
                                                  * was the last entry's) */
            if (n < ENG_SONG_LEN && !eng_song_put(song_sel, (uint32_t)n, (uint32_t)eng_pattern(), 0))
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
    song_shown_run = (int8_t)(eng_transport_running() != 0);
    p = put(p, eng_song() == song_sel + 1 ? (song_shown_run ? " PLAYS" : " STOPPED") : eng_song() ? " (SONG " : " (PATTERN P");
    if (eng_song() && eng_song() != song_sel + 1) {
        *p++ = (char)('0' + eng_song());
        p = put(p, " PLAYS)");
    } else if (!eng_song())
        p = put(put2(p, eng_pattern() + 1), ")");
    *p = 0;
    bar_text(b, C_ACC);
}
/* a text line of the page, drawn when it is not on the LCD as it is (cur: the cursor's colours). mark < 0: a plain line
 * at x 8; else an entry's (or END's) row: a marker column, then the text at x 18; mark 1 the entry playing (#582): a
 * filled triangle and its number in the accent colour (on the cursor's bar both in the bar's text colour) */
#define SONG_TX 10u                     /* the row's text, from the field's left (x 8) */
static void song_line(uint32_t n, uint32_t y, const char *s, uint16_t fg, int cur, uint32_t field, int mark)
{
    uint32_t i, r, key = (cur ? 1u : 2u) | (mark > 0 ? 4u : 0u);
    if (song_ok && song_text[n][0] == (char)key) {
        for (i = 0; s[i] && s[i] == song_text[n][1u + i]; i++)
            ;
        if (s[i] == song_text[n][1u + i])
            return;
    }
    song_text[n][0] = (char)key;
    for (i = 0; s[i] && i < sizeof song_text[n] - 2u; i++)
        song_text[n][1u + i] = s[i];
    song_text[n][1u + i] = 0;
    if (mark < 0) {
        text_bc(&FONT_S, 8, y, s, cur ? C_BG : fg, cur ? C_ACC : C_BG, field, TA_LEFT);
        return;
    }
    for (r = 0; r < FONT_S.h; r++) {             /* (a scanline at a time, as text_bcn: the row never blinks) */
        uint16_t *row = lcd_line, bg = cur ? C_ACC : C_BG, ink = cur ? C_BG : fg, acc = cur ? C_BG : C_ACC;
        uint32_t px = SONG_TX, num = 0;
        int32_t k;
        for (i = 0; i < field; i++)
            row[i] = bg;
        if (mark > 0)                            /* the triangle: 5 px wide, 9 high, on the digits' height */
            for (i = 0; i < 5u; i++)
                if (r >= 2u + i && r <= 10u - i)
                    row[1u + i] = acc;
        if (r == 0u)
            scr_pend(SONG_TX, text_w(&FONT_S, s, -1), FONT_S.h, s, -1);
        for (k = 0; s[k]; k++) {
            uint32_t c = (uint8_t)s[k], j, rb;
            const fglyph_t *g;
            const uint8_t *bits;
            uint8_t gi = c >= 0x20u && c < 0x7Fu ? FONT_S.map[c - 0x20u] : 255u;
            uint16_t col;
            if (gi == 255u)
                continue;
            num += c >= '0' && c <= '9' && num == (uint32_t)k;   /* (the leading digits: the entry's number) */
            col = mark > 0 && (uint32_t)k < num ? acc : ink;
            g = &FONT_S.g[gi];
            rb = (g->w + 1u) / 2u;
            bits = FONT_S.bits + g->off + r * rb;
            for (j = 0; j < g->w; j++) {
                uint32_t a = (j & 1u) ? bits[j >> 1] & 15u : bits[j >> 1] >> 4, at = px + (uint32_t)((int32_t)j + g->x);
                if (a && at < field)
                    row[at] = mix565(col, bg, a + (a > 7u ? 1u : 0u));
            }
            px += g->adv;
            if (px >= field)
                break;
        }
        lcd_line_out(8, y + r, field);
    }
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
    song_line(SONG_ROWS, 26, t, C_FG, 0, 224, -1);
    for (r = 0; r < SONG_ROWS; r++) {
        int k = song_top + (int)r;
        p = t;
        if (k < n) {                             /* 03  P12  +5 (the entry playing: a triangle before it, song_line) */
            int e = eng_song_get(song_sel, (uint32_t)k), sh = (int8_t)(e >> 8);
            p = put2(p, k + 1);
            p = put2(put(p, "  P"), (e & 0xFF) + 1);
            p = put(p, "  ");
            if (sh > 0)
                *p++ = '+';
            fmt_int(num, sh);
            p = put(p, num);
        } else if (k == n)
            p = put(p, n < (int)ENG_SONG_LEN ? "END   K1: ADD" : "END   FULL");
        *p = 0;
        song_line(r, SONG_Y + SONG_RH * r, t, k > n ? C_BG : k == n ? C_DIM : C_FG, k == song_cur, 120, k < n && k == play);
    }
    /* (FONT_S, the controls table's words: controls.ts HINTS, #553) */
    song_line(SONG_ROWS + 1u, 202, HINT_SONG_1, C_DIM, 0, 224, -1);
    song_line(SONG_ROWS + 2u, 222, HINT_SONG_2, C_HINT, 0, 228, -1);
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
    if (page == PAGE_SONG && song_shown_run >= 0 && song_shown_run != (eng_transport_running() != 0)
        && (!msg_until || fm1_ms >= msg_until))
        header_draw();                           /* (PLAY or stop: SONG n PLAYS / STOPPED, #582; not over a message) */
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
    if (page == PAGE_SEQ && eng_steps_count() && (seq_pat_state() != seq_shown_pat || seq_bar_mark() != seq_shown_mark
        || seq_shown_sr != (uint8_t)(sr_on ? sr_k + 1u : 0u) || seq_shown_lo != seq_bar_lo()) && !ui_yielding
        && !(msg_until && (int32_t)(fm1_ms - msg_until) < 0))
        header_draw();                           /* (a pattern taken at the end of a pass, a song's next entry, REC ended
                                                  * by PLAY or a stop (#395), step record's cursor, the roll's pitches:
                                                  * the bar, once a message on it is over) */
    if (page != PAGE_SEQ) {
        kbd_was = -1;
        return;
    }
    if (seq_armed_gen != pages_gen())            /* another patch while the page shows: its track armed (#395) */
        seq_arm_shown(0);
    if (sr_on && (sr_gen != pages_gen() || sr_trk != seq_trk || seq_module() < 0))
        sr_stop();                               /* (another patch, track: step record ends, D-808) */
    if (sr_on && (int32_t)sr_k >= seq_len(seq_module())) {
        sr_k = 0;                                /* (the pattern got shorter under the cursor) */
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
    if (seq_kbd() != kbd_was) {                  /* REC on / off on the armed roll, a stop: its keyboard or the roll */
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
