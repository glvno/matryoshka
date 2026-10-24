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
#define PAGE_GLO 6u                             /* GLO: the FM-1's own page (#199, pages_ui.c pg_glo) */
#define PAGE_ENV 9u                             /* ENV: the environment (#197, pages_ui.c env_draw) */
#define PAGE_PRESETS 10u                        /* SEL on an assembly device: its presets (#194, pages_ui.c presets_draw) */
static uint8_t page;                            /* 0: the device page, 5 menu, 6 GLO, 8 the SEQ page, 9 the environment (seq_ui.c); (7, the legend, is gone: #114) */
static void seq_bar(void);
static void seq_draw(int full);
static uint8_t booting = 1;                     /* the loading screen is up (main.c boot_step): the pages stay unseen */
static uint8_t sb_on;                           /* sandbox mode (sandbox_ui.c): the device page shows the editor's page instead */
static void sandbox_draw(int full);
static void sandbox_bar(void);

/* the settings' rows (menu.c; GLO shows some of them: pages_ui.c glo_page) */
enum { MR_LEDS, MR_ACCEL, MR_CH, MR_CLOCK, MR_MOUT, MR_VERSION, MR_CPU, MR_PEAK, MR_SLOTS, MR_BATT, MR_UPDATE, MR_DEFAULTS, MR_COUNT };
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
static uint8_t ui_full;                         /* a patch was loaded: the whole screen (header too) at the next panel_draw */
static uint32_t panel_held;                     /* the buttons held now, matrix ids as bits (main.c sets it from the HAL, panel.c) */
static int32_t octave;                          /* the keys' octave shift, -3..3 (OCT- / OCT+) */
static uint32_t msg_until;                      /* a message in the top bar (SAVED ...) until this fm1_ms */
/* the device test mode (#291): the last fm1_ms a key or knob came over the editor link (main.c m1_test_key / m1_test_turn),
 * 0 none. Within TEST_HOLD_MS of it the panel refuses what a script must never do: UPDATE MODE, FACTORY RESET (menu.c) */
#define TEST_HOLD_MS 10000u
static uint32_t test_input_ms;
static int test_input_recent(void) { return test_input_ms && fm1_ms - test_input_ms < TEST_HOLD_MS; }

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
#define BATT_X 220u                             /* the top bar's right end, x 220..239: the battery's cell, which no bar paints */

/* The battery (#240): main.c reads SARADC ch 3 (the divider on PB1) every 2 s and hands the mean of a few conversions to
 * ui_battery; it is smoothed here (a one-pole, x16) into batt_q16 (0: not read yet). Its level is 0..3 bars by the stock
 * firmware's thresholds 531 / 561 / 591, as Felucca (hugelton/Felucca, GPL-3.0, firmware/src/ui_draw.c batt_level) has
 * them; still to be confirmed on our device. BATT_HYST of hysteresis on the way up keeps a reading at a threshold from
 * flickering. USB configured by a host (and not suspended) is shown as external power instead (a bolt): there is no
 * charger status line (Felucca's note), so a plain USB charger is not told apart from the battery. The cell is drawn by
 * the loop's drawing only, and only when the shown level changes (batt_mark_sync); under the lowest threshold the bar
 * says LOW BATTERY once (again only after it rose to a bar or USB came). Host builds (host_ui.h) start from BATT_START. */
#ifndef BATT_START
#define BATT_START 0
#endif
#define BATT_HYST 3
#define BATT_BG 0x08A2u                         /* the cell's ground on every bar: the device strip's (pages_ui.c P_STRIP) */
#define BATT_USB 4u                             /* the shown level for external power */
#define BATT_NONE 0xFFu                         /* not read yet: the cell stays blank */
static const int16_t BATT_T[3] = {531, 561, 591};
static int32_t batt_q16 = BATT_START * 16;      /* the smoothed raw reading x16 (0: none yet) */
static uint8_t batt_lvl = BATT_START >= 591 ? 3u : BATT_START >= 561 ? 2u : BATT_START >= 531 ? 1u : 0u;
static uint8_t batt_usb;                        /* a USB host powers it */
static uint8_t batt_drawn = BATT_NONE;          /* the level the cell shows */
static uint8_t batt_low_said, batt_low_due;     /* LOW BATTERY: said since the level fell to 0 / to say at the next draw */

static int32_t batt_raw(void) { return (batt_q16 + 8) >> 4; }   /* 0..1023, 0 = not read yet */

static uint8_t batt_shown(void)
{
    if (!batt_q16)
        return BATT_NONE;
    return batt_usb ? BATT_USB : batt_lvl;
}

/* a new reading (0..1023; <= 0: none, the conversion timed out) and whether a USB host is there. State only: drawn later */
static void ui_battery(int32_t sample, int host)
{
    uint32_t l = 0;
    batt_usb = (uint8_t)(host != 0);
    if (sample > 0) {
        sample = sample > 1023 ? 1023 : sample;
        if (!batt_q16)
            batt_q16 = sample * 16;             /* the first reading as it is */
        else
            batt_q16 += (sample * 16 - batt_q16) / 4;   /* then about 8 s (4 readings) to settle */
        while (l < 3u && batt_raw() >= BATT_T[l] + (l >= batt_lvl ? BATT_HYST : 0))
            l++;
        batt_lvl = (uint8_t)l;
    }
    if (!batt_q16)
        return;
    if (batt_lvl || batt_usb)
        batt_low_said = 0;
    else if (!batt_low_said) {
        batt_low_said = 1;
        batt_low_due = 1;
    }
}

/* the cell, 20 x 20: a battery 12 x 9 and its nub, 0..3 bars inside (one bar coral, empty: a red outline), a bolt in
 * seafoam on USB power; two blits of ten rows through lcd.c's lcd_line (240 pixels; a buffer of its own would cost
 * 800 B of RAM, which the build's 4 KB headroom check does not have) */
static void batt_mark_draw(uint8_t lvl)
{
    uint16_t *px = lcd_line;                    /* (big endian, as the LCD takes it; rows y0..y0+9 of the cell) */
    static const char BOLT[5][11] = {".....##...", "...###....", ".#######..", "..###.....", ".##......."};
    uint16_t ink = lvl == 0u ? C_RED : lvl == BATT_USB ? 0x7E38u : C_DIM, bar = lvl == 1u ? C_ACC : C_FG;
    uint32_t x, y, y0;
    for (y0 = 0; y0 < BAR_H; y0 += 10u) {
        lcd_sync();                                 /* (the last transfer from lcd_line may still run) */
        for (y = y0; y < y0 + 10u && y < BAR_H; y++)
            for (x = 0; x < 20u; x++) {
                uint16_t c = BATT_BG;
                int in = x > 2u && x < 13u && y > 6u && y < 14u;     /* inside the outline: x 3..12, y 7..13 */
                if (lvl == BATT_NONE)
                    c = BATT_BG;                    /* (blank) */
                else if ((x >= 2u && x <= 13u && (y == 6u || y == 14u)) || ((x == 2u || x == 13u) && y >= 6u && y <= 14u))
                    c = ink;                        /* the outline */
                else if (x >= 14u && x < 16u && y >= 8u && y < 13u)
                    c = ink;                        /* the nub */
                else if (in && lvl == BATT_USB)
                    c = y >= 8u && y < 13u && BOLT[y - 8u][x - 3u] == '#' ? ink : BATT_BG;
                else if (in && y >= 8u && y < 13u && x >= 4u && x < 13u && (x - 4u) % 3u != 2u && (x - 4u) / 3u < lvl)
                    c = bar;                        /* bar k: x 4 + 3k, two wide */
                px[(y - y0) * 20u + x] = (uint16_t)((c >> 8) | (c << 8));
            }
        lcd_blit(BATT_X, y0, 20, y - y0, px);
    }
    batt_drawn = lvl;
}

/* the cell as the level is now: drawn only when that changed (by the loop's drawing: panel_draw, screen_idle) */
static void batt_mark_sync(void)
{
    uint8_t s = batt_shown();
    if (s != batt_drawn && !booting)
        batt_mark_draw(s);
}

static void bar_text(const char *s, uint16_t bg)
{
    char b[28];
    uint32_t n = str_len(s), w, i;
    n = n > 26u ? 26u : n;
    for (i = 0; i < n; i++)
        b[i] = s[i];
    b[n] = 0;
    (void)w;
    lcd_fill(0, 0, BATT_X, BAR_H, bg);
    if (n)
        text_bc(&FONT_S, 0, 3, b, bg == C_FG || bg == C_ACC || bg == C_RED ? C_BG : C_FG, bg, BATT_X, TA_CENTER);
}

static void pages_draw(int full);
static void pages_strip(void);
static void presets_bar(void);
static uint8_t ui_yielding;                     /* panel.c: keys are taken from inside a redraw (#230): nothing may draw */
static uint8_t ui_header_due;                   /* a header_draw asked for meanwhile: panel_draw does it at the end */
static void header_draw(void)
{
    if (ui_yielding) {
        ui_header_due = 1;
        return;
    }
    if (sb_on && page == 0u) {                  /* sandbox: SANDBOX and the editor's patch, on gold (sandbox_ui.c) */
        sandbox_bar();
        msg_until = 0;
        return;
    }
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
        if (page == 0 || page == PAGE_GLO || page == PAGE_ENV)   /* the device page: the devices strip; GLO's and ENV's bars */
            pages_strip();
        else if (page == PAGE_PRESETS)          /* the preset list: PRESETS and the device, on gold */
            presets_bar();
        else
            bar_text(b, C_ACC);
        return;
    }
    msg_until = 0;
}

static char msg_text[40];                       /* the message on show (panel_draw puts it back after a full redraw) */
static void ui_msg(const char *s, uint32_t ms)  /* a short message in the bar instead of the name */
{
    uint32_t i;
    for (i = 0; s[i] && i < sizeof msg_text - 1u; i++)
        msg_text[i] = s[i];
    msg_text[i] = 0;
    bar_text(msg_text, C_FG);
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
static void env_draw(int full);
static void presets_draw(int full);

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

static const char *const PANEL_BTN_NAME[ENG_PANEL_BUTTONS] = {"FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "ARP"};

static uint8_t pg_plain;                        /* pages_ui.c: the device page's bars are on screen as it draws them */
static void view_draw(int full)                 /* whichever page is showing */
{
    if ((page != 0u && page != PAGE_GLO) || sb_on)
        pg_plain = 0;
    if (page == PAGE_MENU)
        menu_draw(full);
    else if (page == 8u)
        seq_draw(full);
    else if (page == PAGE_ENV)
        env_draw(full);
    else if (page == PAGE_PRESETS)
        presets_draw(full);
    else if (sb_on && page == 0u)
        sandbox_draw(full);
    else
        pages_draw(full);
}


static void screen_idle(void)                   /* redraws in place: every text pads its field, no blanking of the screen */
{
    if (booting)
        return;
    ui_full = 0;                                /* (a patch load's pending full redraw: this is it, not a second one) */
    header_draw();
    view_draw(1);
    batt_mark_sync();
}
