/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The LCD: patch name and CPU load, the octave, a small picture of the patch, the selected module with what the four
 * knobs change (for the FM-1 panel module: where each knob goes), and the two parameter inputs.
 *
 *   y   2  MODULAR-1 and version        y  40  3/8 FILTER (the selected module)
 *   y  19  patch name, octave, message  y  58  the patch picture, 220 x 56
 *   y  29  CPU                          y 120  K1..K4 rows        y 200 P1, P2 */
#define C_BG 0x0000u
#define C_FG 0xFFFFu
#define C_ACC 0xFD20u                           /* the accent: orange */
#define C_DIM 0x7BEFu
#define C_RED 0xF800u

/* the panel state of the patch: the preset in the list, the module the knobs act on (SELECT turns it), its load error and name */
static uint32_t cur_preset, sel;
static int load_err;
static const char *patch_label;
#define PAGE_MENU 5u                            /* HOME held: the settings menu (menu.c) */
#define PAGE_LEGEND 7u                          /* HOME tapped: every knob and patch button with its label (legend_draw) */
static uint8_t page;                            /* 0: the player screen, 5 menu, 7 legend */
static uint8_t booting = 1;                     /* the loading screen is up (main.c boot_step): the pages stay unseen */

/* the settings of the menu (menu.c); saved with the state (SAVE) */
static struct {
    uint8_t leds;                       /* the idle buttons glow: 0 off, 1 dim low, 2 dim higher */
    uint8_t cpu_bar;                    /* the CPU load in the top bar */
    uint8_t accel;                      /* a knob turned fast steps 5 times as far */
    uint8_t ch;                         /* the MIDI channel: 1..16, 0 all (omni); MIDI out goes on it (omni: channel 1) */
    uint8_t clock_in;                   /* MIDI clock drives the clock output */
    uint8_t prog_chg;                   /* MIDI program change loads a preset */
    uint8_t midi_out;                   /* the keys, knobs and patch buttons go out over USB MIDI */
} cfg = {2, 1, 1, 0, 1, 1, 1};
static void cfg_defaults(void)
{
    cfg.cpu_bar = cfg.accel = cfg.clock_in = cfg.prog_chg = cfg.midi_out = 1;
    cfg.leds = 2;
    cfg.ch = 0;
}
static uint32_t cpu_pct;                /* the audio ISR's peak time over the last half second, in % of the 2.9 ms half buffer */
static volatile uint8_t ui_dirty;               /* 1: the knob rows need a redraw, 2: the module changed too (title, picture) */
static int32_t octave;                          /* the keys' octave shift, -3..3 (OCT- / OCT+) */
static uint32_t msg_until;                      /* a message in the top bar (SAVED ...) until this fm1_ms */

static char *put(char *d, const char *s)
{
    while (*s)
        *d++ = *s++;
    return d;
}

static char *pad(char *d, const char *start, uint32_t width)
{
    while (d < start + width)
        *d++ = ' ';
    *d = 0;
    return d;
}

/* a poly group's part count: 1 PART / 4 PARTS */
static char *put_parts(char *d, int32_t n)
{
    char num[12];
    fmt_int(num, n);
    d = put(d, num);
    return put(d, n == 1 ? " PART" : " PARTS");
}

/* hundredths as -0.50 / 12.5 / 1200 (fmt_fix leaves out the leading zero) */
static char *put_hundredths(char *d, int32_t x, int decimals)
{
    int32_t a = x < 0 ? -x : x;
    char num[12];
    if (x < 0)
        *d++ = '-';
    if (decimals == 0) {
        fmt_int(num, (a + 50) / 100);
        return put(d, num);
    }
    fmt_int(num, a / 100);
    d = put(d, num);
    *d++ = '.';
    if (decimals == 1) {
        *d++ = (char)('0' + (a / 10) % 10);
    } else {
        *d++ = (char)('0' + (a / 10) % 10);
        *d++ = (char)('0' + a % 10);
    }
    *d = 0;
    return d;
}

/* a Q16 number, three significant figures: 1200, 12.5, 0.25 */
static char *put_num(char *d, int32_t q16)
{
    int64_t x = ((int64_t)q16 * 100) / 65536;            /* hundredths */
    int64_t a = x < 0 ? -x : x;
    return put_hundredths(d, (int32_t)x, a >= 10000 ? 0 : a >= 1000 ? 1 : 2);
}

/* parameter j of a module type as the LCD shows it: a choice by name (SAW), else the number and its unit (1200 HZ) */
static char *put_param(char *d, const def_t *def, uint32_t j, int32_t q16)
{
    if (def->pchoice && def->pchoice[j]) {
        const char *const *names = def->pchoice[j];
        int32_t i = (q16 + 32768) >> 16, n = 0;
        while (names[n])
            n++;
        i = i < 0 ? 0 : i >= n ? n - 1 : i;
        d = put(d, names[i]);
        *d = 0;
        return d;
    }
    d = put_num(d, q16);
    if (def->punit && def->punit[j][0]) {
        *d++ = ' ';
        d = put(d, def->punit[j]);
    }
    *d = 0;
    return d;
}

static uint32_t log2_q8(uint32_t x)             /* log2 of x >= 1 in 1/256, linear inside each octave */
{
    uint32_t b = 31u - (uint32_t)__builtin_clz(x);
    uint32_t frac = b >= 8u ? (x >> (b - 8u)) - 256u : (x << (8u - b)) - 256u;
    return b * 256u + frac;
}

/* where parameter j stands in its range, 0..width pixels (logarithmic parameters on a log scale) */
static uint32_t param_bar(const def_t *def, uint32_t j, int32_t q16, uint32_t width)
{
    int32_t lo = def->pmin[j], hi = def->pmax[j];
    int64_t v = q16 < lo ? lo : q16 > hi ? hi : q16;
    if (hi <= lo)
        return 0;
    if (def->plog && def->plog[j] && lo > 0) {
        uint32_t a = log2_q8((uint32_t)lo), b = log2_q8((uint32_t)hi), x = log2_q8((uint32_t)v);
        return b > a ? (x - a) * width / (b - a) : 0u;
    }
    return (uint32_t)(((v - lo) * (int64_t)width) / (hi - lo));
}

/* ---- the picture of the patch: modules as coloured boxes in rows by depth (a vertical strip), cables as lines */

#define BAR_H 22u
static void bar_text(const char *s, uint16_t bg)
{
    char b[28];
    uint32_t n = str_len(s), w, i;
    n = n > 26u ? 26u : n;
    for (i = 0; i < n; i++)
        b[i] = s[i];
    b[n] = 0;
    w = n * 9u;
    lcd_fill(0, 0, 240, BAR_H, bg);
    if (n)
        text_mid((240u - w) / 2u, (BAR_H - 11u) / 2u, b, C_BG, bg);
}

/* the name at the left and the CPU load at the right, black on the accent colour */
static void bar_name_cpu(const char *s, uint16_t bg)
{
    char b[24], num[12], *p = num;
    uint32_t n = str_len(s), i, w;
    n = n > 19u ? 19u : n;
    for (i = 0; i < n; i++)
        b[i] = s[i];
    b[n] = 0;
    fmt_int(num, (int32_t)cpu_pct);
    p = num + str_len(num);
    *p++ = '%';
    *p = 0;
    w = str_len(num) * 9u;
    lcd_fill(0, 0, 240, BAR_H, bg);
    text_mid(8, (BAR_H - 11u) / 2u, b, C_BG, bg);
    text_mid(232u - w, (BAR_H - 11u) / 2u, num, C_BG, bg);
}

static void header_draw(void)
{
    if (eng_overload) {                     /* audio.c: the patch was too heavy and is muted until another one loads */
        bar_text("OVERLOAD: CHANGE PATCH", C_RED);
    } else if (load_err) {
        char b[24], num[12], *p = b;
        p = put(p, "LOAD ERR ");
        fmt_int(num, load_err);
        put(p, num);
        p[str_len(num)] = 0;
        bar_text(b, C_RED);
    } else {
        char b[40], num[12], *p = b;
        if (cur_preset < M1_SLOTS && !booting) {   /* the slot's number (1..64) before the name */
            fmt_int(num, (int32_t)cur_preset + 1);
            if (cur_preset < 9u)
                *p++ = '0';
            p = put(p, num);
            *p++ = ' ';
        }
        p = put(p, patch_label ? patch_label : "");
        if (m1_edited)
            p = put(p, " *");                   /* edited since it was loaded (SAVE writes it into its slot) */
        *p = 0;
        if (cfg.cpu_bar) {
            bar_name_cpu(b, C_ACC);
        } else {
            b[24] = 0;
            bar_text(b, C_ACC);
        }
    }
    msg_until = 0;
}

static void ui_msg(const char *s, uint32_t ms)  /* a short message in the bar instead of the name */
{
    bar_text(s, C_FG);
    msg_until = fm1_ms + ms;
}

static void ui_msg_clear(void)
{
    header_draw();
}

/* where knob k of the FM-1 panel module goes: "<MODULE> <PARAMETER>" of the first module input the cable from k leads to */
static int knob_target(uint32_t panel, uint32_t k, char *out)
{
    uint32_t nc = (uint32_t)eng_ncables(), c, more = 0;
    int found = 0;
    for (c = 0; c < nc; c++) {
        uint32_t f, fp, t, tp;
        const def_t *d;
        char *p = out;
        const char *what = 0;
        eng_cable(c, &f, &fp, &t, &tp);
        if (f != panel || fp != FM1_O_K1 + k)
            continue;
        d = &DEFS[eng_type(t)];
        if (d->cvbase >= 0 && (int32_t)tp >= d->cvbase && (int32_t)tp < d->cvbase + 2) {
            uint32_t mask = eng_map(t, tp - (uint32_t)d->cvbase), j;
            for (j = 0; j < d->npar; j++)
                if (mask >> j & 1u) {
                    what = d->pname[j];
                    break;
                }
            if (!what) {
                if (found)
                    more = 1;
                continue;                               /* a parameter input that controls nothing */
            }
        } else {
            what = d->inname[tp];
        }
        if (found) {
            more = 1;
            continue;
        }
        {   /* "<MODULE> <PARAMETER>"; if that is too long for a row the last word of the module name, else the parameter alone */
            const char *mn = d->name, *last = mn, *s;
            for (s = mn; *s; s++)
                if (*s == ' ')
                    last = s + 1;
            if (str_len(mn) + 1u + str_len(what) > 16u)
                mn = str_len(last) + 1u + str_len(what) <= 16u ? last : "";
            if (*mn) {
                p = put(p, mn);
                *p++ = ' ';
            }
            p = put(p, what);
            *p = 0;
        }
        found = 1;
    }
    if (found && more) {
        uint32_t l = str_len(out);
        l = l > 15u ? 15u : l;
        out[l] = '+';
        out[l + 1u] = 0;
    }
    return found;
}

/* the patch buttons a cable leaves from (the rest stay dark) */
static uint32_t panel_used(void)
{
    uint32_t i, from, fp, to, tp, used = 0;
    int main = eng_find(T_FM1);
    for (i = 0; main >= 0 && i < (uint32_t)eng_ncables(); i++) {
        eng_cable(i, &from, &fp, &to, &tp);
        if (from == (uint32_t)main && fp >= FM1_O_FX && fp < FM1_O_FX + ENG_PANEL_BUTTONS)
            used |= 1u << (fp - FM1_O_FX);
    }
    return used;
}

static void menu_draw(int full);

/* The player screen (#63): what the patch's author put on the panel, readable from arm's length.
 *   top bar  slot and name, * when edited (header_draw)
 *   y  30..  K1..K4: the author's label (else where the knob's cable goes), the knob's position in percent, a bar
 *   y 176    K5 / K6 (SELECT / ALGO): label and value, side by side
 *   y 206    PLAY / STOP and the tempo (MIDI when the clock comes in), the parts, the octave
 *   y 228    the last knob or button touched, else the hint line
 * Labels come from the patch's panel section (proto.c m1_panel); a knob without one shows its destination (knob_target). */
#define LEFT_W 216u

/* label i of the panel section (0..5 K1..K6, 6.. the buttons) into out (11 bytes); 0 if the patch has none */
static int panel_label(uint32_t i, char *out)
{
    const uint8_t *pn = m1_panel();
    uint32_t k;
    out[0] = 0;
    if (!pn || i >= ENG_PANEL_LABELS)
        return 0;
    for (k = 0; k < ENG_PANEL_LABEL && pn[4u + i * ENG_PANEL_LABEL + k]; k++)
        out[k] = (char)pn[4u + i * ENG_PANEL_LABEL + k];
    out[k] = 0;
    return k > 0;
}

static const char *const PANEL_BTN_NAME[ENG_PANEL_BUTTONS] = {"FX", "SCL", "ENV", "LFO", "EDIT", "GLO", "ARP", "SEQ", "REC"};

/* the name a knob shows: its label, else its destination, else K1..K6 */
static void knob_name(int panel, uint32_t k, char *out)
{
    char t[40];
    if (panel_label(k, out))
        return;
    if (panel >= 0 && knob_target((uint32_t)panel, k, t)) {
        t[15] = 0;
        put(out, t)[0] = 0;
        return;
    }
    out[0] = 'K';
    out[1] = (char)('1' + k);
    out[2] = 0;
}

static void player_draw(int full)
{
    char line[40], name[40], num[12], *p;
    int panel = eng_find(T_FM1);
    uint32_t k;
    (void)full;
    for (k = 0; k < 4u; k++) {                          /* K1..K4: big */
        int32_t v = panel >= 0 ? clampi(eng_get_param((uint32_t)panel, FM1_P_K1 + k), 0, 65536) : 0;
        uint32_t y = 30u + 36u * k, w = (uint32_t)(((int64_t)v * LEFT_W) >> 16);
        int has = panel >= 0;
        knob_name(panel, k, name);
        name[17] = 0;
        p = put(line, name);
        pad(p, line, 18);
        text_mid(12, y + 2u, line, has ? C_FG : C_DIM, C_BG);
        fmt_int(num, (int32_t)(((int64_t)v * 100) >> 16));
        p = put(line, num);
        *p++ = '%';
        pad(p, line, 4);
        text5x7(12 + LEFT_W - 24u, y + 4u, line, 1, C_DIM, C_BG);
        lcd_fill(12, y + 22u, w, 3, has ? C_ACC : C_DIM);
        lcd_fill(12 + w, y + 22u, LEFT_W - w, 3, 0x2104u);
    }
    for (k = 4; k < 6u; k++) {                          /* K5 / K6: small, side by side */
        int32_t v = panel >= 0 ? clampi(eng_get_param((uint32_t)panel, FM1_P_K5 + (k - 4u)), 0, 65536) : 0;
        uint32_t x = 12u + 112u * (k - 4u), w = (uint32_t)(((int64_t)v * 104) >> 16);
        knob_name(panel, k, name);
        name[12] = 0;
        p = put(line, name);
        *p++ = ' ';
        fmt_int(num, (int32_t)(((int64_t)v * 100) >> 16));
        p = put(p, num);
        *p++ = '%';
        pad(p, line, 17);
        text5x7(x, 176, line, 1, C_FG, C_BG);
        lcd_fill(x, 186, w, 2, C_ACC);
        lcd_fill(x + w, 186, 104u - w, 2, 0x2104u);
    }
    {                                                   /* PLAY 120  4 PARTS  OCT +1 */
        int run = eng_transport_running(), beat = run && (eng_ticks() % 24u) < 6u;
        p = put(line, run ? "PLAY " : "STOP ");
        if (eng_clock_is_external())
            p = put(p, "MIDI");
        else {
            fmt_int(num, panel >= 0 ? (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16 : 120);
            p = put(p, num);
        }
        *p++ = ' ';
        *p++ = ' ';
        if (eng_groups())
            p = put_parts(p, eng_parts());
        else
            p = put(p, "MONO");
        p = put(p, "  OCT ");
        if (octave >= 0)
            *p++ = '+';
        fmt_int(num, octave);
        p = put(p, num);
        pad(p, line, 26);
        text5x7(12, 206, line, 1, run ? C_FG : C_DIM, C_BG);
        lcd_fill(228, 206, 7, 7, beat ? C_ACC : C_BG);  /* the beat while the transport runs */
    }
    if (full)
        text5x7(12, 228, "SAVE: STORE  HOME: LEGEND", 1, 0x4208u, C_BG);
}

/* The legend (HOME tap): every knob and patch button with its label; a button the patch does not use is dim, a lit one is on. */
static void legend_draw(int full)
{
    char line[40], name[16], *p;
    int panel = eng_find(T_FM1);
    uint32_t k, used = panel_used(), on = eng_buttons_get();
    if (full)
        text_mid(12, 30, "LEGEND", C_ACC, C_BG);
    for (k = 0; k < 6u; k++) {
        knob_name(panel, k, name);
        name[13] = 0;
        p = put(line, k < 4u ? "K" : k == 4u ? "SEL " : "ALG ");
        if (k < 4u) {
            *p++ = (char)('1' + k);
            *p++ = ' ';
            *p++ = ' ';
        }
        p = put(p, name);
        pad(p, line, 18);
        text5x7(12, 52u + 12u * k, line, 1, C_FG, C_BG);
    }
    for (k = 0; k < ENG_PANEL_BUTTONS; k++) {
        int has = (int)(used >> k & 1u);
        p = put(line, PANEL_BTN_NAME[k]);
        pad(p, line, 5);
        p = line + 5;
        if (!panel_label(6u + k, name))
            put(name, has ? "-" : "")[0] = 0;
        p = put(p, name);
        if (has && (on >> k & 1u))
            p = put(p, " (ON)");
        pad(p, line, 18);
        text5x7(12u + 112u * (k % 2u), 132u + 12u * (k / 2u), line, 1, has ? C_FG : C_DIM, C_BG);
    }
    if (full)
        text5x7(12, 228, "HOME: BACK", 1, 0x4208u, C_BG);
}

static void view_draw(int full)                 /* whichever page is showing */
{
    if (page == PAGE_MENU)
        menu_draw(full);
    else if (page == PAGE_LEGEND)
        legend_draw(full);
    else
        player_draw(full);
}


static void screen_idle(void)                   /* redraws in place: every text pads its field, no blanking of the screen */
{
    if (booting)
        return;
    header_draw();
    view_draw(1);
}
