/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The LCD's frame: the top bar, messages, and which page shows. Page 0 is the device page (pages_ui.c), the others the
 * menu (menu.c) and the SEQ page (seq_ui.c). The colours are the editor's dark theme (style.css):
 * night paper, ivory ink, the coral accent. */
#define C_BG 0x10E4u                            /* night */
#define C_FG 0xFFBDu                            /* ivory */
#define C_ACC 0xE3ABu                           /* the accent: coral */
#define C_DIM 0x9CF2u
#define C_RED 0xE249u
#define C_TRACK 0x2145u                         /* a bar's empty part, a hot row (the panel colour) */
#define C_HINT 0x6B6Du                          /* hint lines */

/* the panel state of the patch: the preset in the list, the module the knobs act on (SELECT turns it), its load error and name */
static uint32_t cur_preset, sel;
static int load_err;
static const char *patch_label;
#define PAGE_MENU 5u                            /* HOME held: the settings menu (menu.c) */
static uint8_t page;                            /* 0: the device page, 5 menu, 8 the SEQ page (seq_ui.c); (7, the legend, is gone: #114) */
static void seq_bar(void);
static void seq_draw(int full);
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
static uint32_t panel_held;                     /* the buttons held now, matrix ids as bits (main.c sets it from the HAL, panel.c) */
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

#define BAR_H 20u
static void bar_text(const char *s, uint16_t bg)
{
    char b[28];
    uint32_t n = str_len(s), w, i;
    n = n > 26u ? 26u : n;
    for (i = 0; i < n; i++)
        b[i] = s[i];
    b[n] = 0;
    (void)w;
    lcd_fill(0, 0, 240, BAR_H, bg);
    if (n)
        text_bc(&FONT_S, 0, 3, b, bg == C_FG || bg == C_ACC || bg == C_RED ? C_BG : C_FG, bg, 240, TA_CENTER);
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

static void pages_draw(int full);
static void pages_strip(void);
static void header_draw(void)
{
    if (page == 8u && !eng_overload && !load_err) {     /* the SEQ page: the track's name (seq_ui.c PAGE_SEQ) */
        seq_bar();
        msg_until = 0;
        return;
    }
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
        b[24] = 0;                              /* (the CPU load is in MENU > SYSTEM) */
        msg_until = 0;
        if (page == 0)                          /* the device page: the devices strip (the patch is on the info line) */
            pages_strip();
        else
            bar_text(b, C_ACC);
        return;
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

/* the patch buttons that glow: assigned (any kind but Nothing, #116) or with a cable from them; the rest stay dark */
static uint32_t panel_used(void)
{
    uint32_t i, from, fp, to, tp, used = 0;
    int main = eng_find(T_FM1);
    for (i = 0; i < ENG_PANEL_BUTTONS; i++)
        if (eng_button_kind(i) != ENG_BTN_NOTHING)
            used |= 1u << i;
    for (i = 0; main >= 0 && i < (uint32_t)eng_ncables(); i++) {
        eng_cable(i, &from, &fp, &to, &tp);
        if (from == (uint32_t)main && fp >= FM1_O_FX && fp < FM1_O_FX + ENG_PANEL_BUTTONS)
            used |= 1u << (fp - FM1_O_FX);
    }
    return used;
}

static void menu_draw(int full);

#define LEFT_W 216u

/* label i of the panel section (the buttons, PANEL_BTN_ID order) into out (11 bytes); 0 if the patch has none */
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

static const char *const PANEL_BTN_NAME[ENG_PANEL_BUTTONS] = {"FX", "SCL", "ENV", "LFO", "EDIT", "GLO", "ARP"};

static void view_draw(int full)                 /* whichever page is showing */
{
    if (page == PAGE_MENU)
        menu_draw(full);
    else if (page == 8u)
        seq_draw(full);
    else
        pages_draw(full);
}


static void screen_idle(void)                   /* redraws in place: every text pads its field, no blanking of the screen */
{
    if (booting)
        return;
    header_draw();
    view_draw(1);
}
