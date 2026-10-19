/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The SEQ page (#83), after menu.c and before main.c: XOX step entry for the patch's Steps modules (drum tracks).
 *
 *   SEQ             opens / closes the page; held + a black key: mute / unmute that track (from any page, not saved)
 *   black keys      pick the track (1..11, patch order); ALGO steps through all of them; with REC on a black key is a hit on
 *                   its track instead: it sounds and, while the track plays, goes into the nearest step (ENV held: accented)
 *   white keys      the 16 steps of the page: a press switches the step on / off (ENV held: its accent instead)
 *   white key held  + SELECT: the step's chance, 100 % .. 5 % in steps of 5; + K1: its note (a semitone a click; on a track
 *                   without notes the first click starts from C of the keys' octave); + K2: its velocity (#93). Turning a
 *                   knob on a held step undoes the press's on / off: the step keeps its accent and plays.
 *   OCT- / OCT+     the page of a track longer than 16 steps (17-32 ...)
 *   REC             live recording on / off (its LED is lit while on)
 * On this page the keys play no notes. Key LEDs: the selected track's steps bright, the step playing at the mid level (dark
 * on a step that is on), the selected track's black key bright, tracks with hits glowing, muted ones blinking. The top bar
 * shows the track's name (STEPS n without one). Edits go into the running patch (SAVE keeps them) and to the editor. */

#define PAGE_SEQ 8u
#define BTN_SEQ 11u
#define BTN_REC 13u
#define BTN_ENV 4u

static uint8_t seq_trk;                 /* the selected track (index among the patch's Steps modules) */
static uint8_t seq_pg;                  /* the page of 16 steps */
static uint8_t seq_rec;                 /* REC: live recording */
static int8_t seq_held = -1;            /* the step whose white key is held (SELECT sets its chance, K1 / K2 its values), -1 none */
static uint8_t seq_held_was;            /* that step's byte before its press switched it */
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
    m1_step_now((uint32_t)mod, k, b);
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

static void seq_leds(void)
{
    int mod = seq_module(), pos = mod >= 0 ? eng_steps_pos((uint32_t)mod) : -1;
    int blink = (fm1_ms / 200u) & 1u;
    uint32_t n;
    for (n = 0; n < 27u; n++) {
        int w = seq_white(n), b = seq_black(n), lit = 0, mid = 0, dim = 0;
        if (w >= 0 && mod >= 0) {
            int k = seq_pg * 16 + w, on = k < seq_len(mod) && (eng_steps_get((uint32_t)mod, (uint32_t)k) & 1);
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
    header_draw();
    ui_dirty = 2;
}

/* SEQ held + a black key (any page): that track muted / unmuted */
static void seq_mute_key(uint32_t n)
{
    int b = seq_black(n), mod;
    char m[24], name[TRACK_NAME_MAX + 8];
    if (b < 0 || b >= eng_steps_count())
        return;
    mod = eng_steps_module((uint32_t)b);
    eng_steps_mute((uint32_t)mod, !eng_steps_muted((uint32_t)mod));
    m1_mute_now((uint32_t)mod, eng_steps_muted((uint32_t)mod));
    seq_name((uint32_t)b, name);
    put(put(m, name), eng_steps_muted((uint32_t)mod) ? " MUTED" : " ON")[0] = 0;
    ui_msg(m, 1000);
    ui_dirty = 2;
}

/* a key on the SEQ page (n: note key 0..26) */
static void seq_key(uint32_t n, int down)
{
    int w = seq_white(n), b = seq_black(n), mod = seq_module();
    int env = (int)(fm1_in.buttons >> BTN_ENV & 1u);
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
        if (env)                                 /* ENV held: the accent (an off step comes on accented) */
            s = (s & 1u) ? s ^ 2u : s | 3u;
        else
            s = (s & 1u) ? s & ~3u : s | 1u;     /* (switched off: its accent goes too; its chance stays) */
        seq_held_was = (uint8_t)eng_steps_get((uint32_t)mod, (uint32_t)k);
        seq_held_turned = 0;
        seq_put(mod, (uint32_t)k, s);
        seq_held = (int8_t)k;
        ui_dirty = ui_dirty ? ui_dirty : 1;
    }
}

/* the first knob turn on a held step: its byte as before the press, on (an edit means the step should play) */
static void seq_held_restore(int mod)
{
    if (seq_held_turned)
        return;
    seq_held_turned = 1;
    seq_put(mod, (uint32_t)seq_held, seq_held_was | 1u);
}

/* SELECT turned with a step held: its chance, 5 % a click */
static void seq_chance(int32_t clicks)
{
    int mod = seq_module();
    uint32_t s;
    int32_t code;
    char m[24], num[8];
    if (mod < 0 || seq_held < 0)
        return;
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
    int mod = seq_module(), v, k;
    int32_t note, vel;
    char m[24], num[8], *p;
    if (mod < 0 || seq_held < 0 || (!note_clicks && !vel_clicks))
        return;
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
    m1_stepval_now((uint32_t)mod, (uint32_t)seq_held, (uint32_t)note, (uint32_t)vel);
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

static void seq_rec_toggle(void)
{
    seq_rec = (uint8_t)!seq_rec;
    ui_msg(seq_rec ? "REC: BLACK KEYS RECORD" : "REC OFF", 1000);
    ui_dirty = 2;
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
    fmt_int(num, (int32_t)seq_trk + 1);
    p = put(p, num);
    *p++ = '/';
    fmt_int(num, eng_steps_count());
    p = put(p, num);
    if (seq_rec)
        p = put(p, " REC");
    *p = 0;
    bar_text(b, seq_rec ? C_RED : C_ACC);
}

/*   y  32  the page's steps of the track's length, its rate and swing (when not straight)
 *   y  52  the 16 steps of the page: a cell each (filled = on, accent = the accent colour, a chance fills it part way up),
 *          the step playing underlined
 *   y 100  every track: number, name, M when muted (the selected one in the accent colour)
 *   y 228  the hint line */
static void seq_draw(int full)
{
    char line[40], num[8], name[TRACK_NAME_MAX + 8], *p;
    int mod = seq_module(), pos, i;
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
    }
    seq_shown_pos = (int8_t)pos;
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
        }
        *p = 0;
        text_bc(&FONT_S, x, y, line, t == seq_trk ? C_ACC : t < (uint32_t)eng_steps_count() && !eng_steps_muted((uint32_t)eng_steps_module(t)) ? C_FG : C_DIM, C_BG, 108, TA_LEFT);
    }
    if (full)
        text_bc(&FONT_S, 8, 222, seq_rec ? "BLACK  hit    ENV+BLACK  accent" : "ENV accent   HOLD+SEL %   K1 note   K2 vel", C_HINT, C_BG, 228, TA_LEFT);
}

/* the main loop, every pass: the LEDs, and the cells when the playhead moved */
static void seq_poll(void)
{
    int mod;
    if (page != PAGE_SEQ)
        return;
    seq_leds();
    mod = seq_module();
    if (mod >= 0 && eng_steps_pos((uint32_t)mod) != seq_shown_pos && !ui_dirty)
        ui_dirty = 1;
}
