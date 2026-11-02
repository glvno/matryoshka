/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The FM-1 teaching its own controls (#450): the controls sheet (OCT- + OCT+, D-245 / D-246) and the quick start after
 * power-on (D-247). Both are a card 16 px in from the screen's edges, with a 2 px sky edge, over the page dimmed to 40 %
 * (lcd_ovl.h: the page goes on drawing itself as a dim frame around it). After seq_ui.c, before panel.c, which routes the
 * controls while a card shows (help_edges, help_knobs): the note keys and PLAY work, HOME closes, the sheet's ALGO switches
 * its tabs and SELECT scrolls it by whole rows; every other control does nothing.
 *
 * The sheet's rows are specs: parts separated by '|', then '~' and the description. A part: k:NAME a button (an outlined
 * keycap), n:NAME a grey knob and its name, c:DIGITS coloured knobs K1..K4 with their numbers, w: a white key, b: a
 * black key (b:N black key N), t:TEXT grey joining words, m:TEXT bright words. Which rows show is decided per state as the sheet is drawn
 * (help_rows), so the sheet follows the state (help_follow): rows that do not apply to the device in focus, the patch or
 * the tab are left out, and a patch button is listed by its job in the loaded patch. */

#define HELP_SHEET 1u
#define HELP_QUICK 2u
static uint8_t help_on;                             /* the card showing: 0 none, HELP_SHEET, HELP_QUICK */
static uint8_t help_tab;                            /* the sheet's tab: 0 the state's, 1 EVERYWHERE */
static uint8_t help_top;                            /* the sheet's first row shown */
static uint8_t help_due;                            /* the card to draw: 1 its rows and tabs, 2 all of it */
static uint32_t help_sig;                           /* the state the sheet was drawn for (help_state_sig) */
static const char *help_msg;                        /* a boot message held back while the quick start shows (main.c) */
static uint32_t help_msg_ms;

/* the card's geometry (the approved mock, scratchpad/mock/mock_draw.h m_sheet / m_toast_quick10) */
#define HC_M 16u                                    /* the card's square: x, y 16 .. 223 (lcd_ovl.h OVL_A, OVL_B) */
#define HC_W 208u
#define HC_IX (HC_M + 2u)                           /* inside the sky edge */
#define HC_IW (HC_W - 4u)
#define HC_TOP (HC_M + 26u)                         /* the sheet's rows: y 42 .. 200 */
#define HC_BOT (HC_M + HC_W - 24u)
#define HC_ROW 19u
#define HC_X0 (HC_M + 8u)                           /* a row's first part */
#define HC_AC 124u                                  /* the sheet's description column */
#define HC_VIS ((HC_BOT - HC_TOP) / HC_ROW)         /* rows that fit: 8 */
#define HC_ROWS 24u

/* the states (D-245): the sheet's first tab is named after the one the FM-1 is in */
enum { HS_DEVICE, HS_ENV, HS_DRUM, HS_ROLL, HS_LIVE, HS_SONG, HS_MENU, HS_SANDBOX, HS_STEP };
static const char *const HS_NAME[9] = {"DEVICE", "ENVIRONMENT", "DRUM STEPS", "PIANO ROLL", "LIVE TAKE", "SONG", "SETTINGS", "SANDBOX",
                                       "STEP RECORD"};

static uint32_t help_state(void)
{
    if (page == PAGE_MENU)
        return HS_MENU;
    if (page == PAGE_ENV)
        return HS_ENV;
    if (page == PAGE_SONG)
        return HS_SONG;
    if (page == PAGE_SEQ)
        return sr_on ? HS_STEP : seq_kbd() ? HS_LIVE : seq_module() >= 0 && seq_map() < 0 ? HS_ROLL : HS_DRUM;
    return sb_on ? HS_SANDBOX : HS_DEVICE;
}

/* what the sheet's rows depend on: the state, the device in focus, a Page button's list, the menu's tab, the track and
 * its length, the patch */
static uint32_t help_state_sig(void)
{
    int mod = page == PAGE_SEQ ? seq_module() : -1;
    uint32_t s = help_state(), len = mod >= 0 ? (uint32_t)seq_len(mod) > 16u : 0u;
    return s | (uint32_t)(pg_cur_dev & 63u) << 4 | (uint32_t)(pg_list_btn >= 0) << 10 | (uint32_t)menu_tab << 11
         | (uint32_t)(seq_trk & 15u) << 14 | len << 18 | (uint32_t)(eng_steps_count() > 0) << 19 | (pages_gen() & 0xFFFu) << 20;
}

/* the device in focus: it has presets to step / it can store one (an assembly) / it takes keys (SEL arms it) */
static int help_dev_presets(void) { pages_ensure(); return pg_cur_dev < pg_ndev && dp_list(pg_cur_dev) > 0u; }
static int help_dev_store(void) { pages_ensure(); return pg_cur_dev < pg_ndev && pg_dev[pg_cur_dev].structure != 0u; }
static int help_dev_keys(void) { pages_ensure(); return pg_cur_dev < pg_ndev && env_listeners(pg_cur_dev) != 0u; }

/* the rows of the patch buttons with a job in the loaded patch (FX, LFO, EDIT, ARP; SEL, ENV and GLO are fixed): the
 * button by its own name, then its job: a Toggle "name on/off", a Page button "name pages", a Gate with a cable from its
 * jack "name held", or "name on/off" when it switches; the name is the patch's label for it, in lower case. A Gate with
 * no cable does nothing: no row */
static char help_btn_row[4][40];
static uint32_t help_patch_rows(const char **out)
{
    static const uint8_t B[4] = {0, 3, 4, 6};
    const uint8_t *pn = m1_panel();
    uint32_t i, n = 0, tog = pn ? ((uint32_t)pn[0] | (uint32_t)pn[1] << 8) : 0u;
    for (i = 0; i < 4u; i++) {
        uint32_t b = B[i], kind = eng_button_kind(b), k;
        char lab[16], *p = help_btn_row[n];
        if (!panel_btn_job(b))                      /* (ui.c: a Gate's job is its jack's cable) */
            continue;
        if (!panel_label(b, lab))
            put(lab, PANEL_BTN_NAME[b])[0] = 0;
        for (k = 0; lab[k]; k++)
            lab[k] = lab[k] >= 'A' && lab[k] <= 'Z' ? (char)(lab[k] + 32) : lab[k];
        p = put(put(put(p, "k:"), PANEL_BTN_NAME[b]), "~");
        p = put(p, lab);
        p = put(p, kind == ENG_BTN_PAGE ? " pages" : kind == ENG_BTN_TOGGLE || (tog >> b & 1u) ? " on/off" : " held");
        *p = 0;
        out[n] = help_btn_row[n];
        n++;
    }
    return n;
}

#define E_TEMPO "k:PLAY|t:+|n:PRESET~tempo"
#define E_PATCH "k:HOME|t:+|n:PRESET~patches"
#define E_STORE "k:ENV|t:+|k:SAVE~save device preset"
#define E_ARM "k:REC|t:+|b:~arm a track"
#define E_MUTE "k:SEQ|t:+|b:~mute a track"

/* the rows of tab t (0 the state's, 1 EVERYWHERE) in the state now */
static uint32_t help_rows(uint32_t t, const char **r)
{
    uint32_t n = 0, s = help_state();
    int tracks = eng_steps_count() > 0, mod = seq_module(), store = help_dev_store();
    int longtrk = page == PAGE_SEQ && mod >= 0 && seq_len(mod) > 16;
#define R(x) (r[n++] = (x))
    if (t) {                                        /* EVERYWHERE: each button's job everywhere, then the combinations, but
                                                     * what the state's tab lists or gives another job (D-246) */
        int seq = s == HS_DRUM || s == HS_ROLL || s == HS_LIVE || s == HS_SONG || s == HS_STEP;
        R("k:PLAY~start / stop");
        if (s != HS_SANDBOX)
            R("k:REC~record");
        if (s != HS_MENU && s != HS_SANDBOX)
            R("k:SAVE~save patch");
        R("k:HOME~back");
        if (s != HS_MENU)
            R("k:GLO~settings");
        if (s != HS_ENV && s != HS_SANDBOX)
            R("k:ENV~environment");
        if (!seq && s != HS_SANDBOX)
            R("k:SEQ~steps page");
        if (s != HS_DRUM && s != HS_ROLL && s != HS_MENU && s != HS_STEP)
            R("k:OCT-|t:/|k:OCT+~octave");
        R(E_TEMPO);
        if (s == HS_SANDBOX)
            return n;
        if (s != HS_MENU)
            R(E_PATCH);
        if (store && s != HS_DEVICE && s != HS_ENV)
            R(E_STORE);
        if (tracks) {
            R(E_ARM);
            R(E_MUTE);
        }
        return n;
    }
    switch (s) {
    case HS_DEVICE:
        R(pg_list_btn >= 0 ? "n:SELECT~leave the list" : "n:SELECT~devices");
        R(pg_list_btn >= 0 ? "n:ALGO~the list's pages" : "n:ALGO~device pages");
        if (help_dev_presets())
            R("n:PRESET~device presets");
        R("c:1234~adjust values");
        R("k:HOME|t:+|c:1234~fine adjust");
        if (help_dev_keys())
            R("k:SEL~arm this device");
        if (store)
            R(E_STORE);
        n += help_patch_rows(r + n);
        break;
    case HS_ENV:
        R("n:SELECT~device rows");
        R("c:1234~row's first page");
        if (help_dev_presets()) {
            R("n:PRESET~row's presets");
            R("n:ALGO~row's presets");
        }
        if (help_dev_keys())
            R("k:SEL~arm / disarm row");
        if (store)
            R(E_STORE);
        break;
    case HS_DRUM:
        R("w:~step on / off");
        R("b:~pick a row");
        R("n:SELECT~pick a row");
        if (longtrk)
            R("k:OCT-|t:/|k:OCT+~steps 17+");
        R("n:ALGO~track");
        R("n:PRESET~pattern");
        R("k:FX|t:+|w:~accent");
        R("k:LFO|t:+|w:~tie");
        R("b:11|t:+|w:~step record");
        R("t:hold step +|c:2~velocity");
        R("t:hold step +|n:SELECT~chance");
        R("k:SEL|t:tap~song");
        R("k:SEQ|t:+|k:REC~clear track");
        break;
    case HS_ROLL:
        R("w:~step on / off");
        R("b:~pick a row");
        R("n:SELECT~scroll rows");
        R("k:SEL|t:+|m:KEY~jump to pitch");
        R("k:FX|t:+|w:~accent");
        R("k:LFO|t:+|w:~tie");
        R("b:11|t:+|w:~step record");
        R("t:hold step +|c:1~pitch");
        R("t:hold step +|c:2~velocity");
        R("t:hold step +|c:3~chance");
        if (longtrk)
            R("k:OCT-|t:/|k:OCT+~steps 17+");
        R("k:FX|t:+|k:OCT~keys' octave");
        R("n:ALGO~track");
        R("n:PRESET~pattern");
        R("k:SEL|t:tap~song");
        R("k:SEQ|t:+|k:REC~clear track");
        break;
    case HS_STEP:                                   /* step record (#532, D-804) */
        R("m:KEYS~play, let go: write");
        R("t:keys together~one chord");
        R("k:LFO~rest");
        R("t:keys held +|k:LFO~tie");
        R("k:FX|t:held~accent");
        R("c:4~move cursor");
        R("b:10~back, clear step");
        R("k:OCT-|t:/|k:OCT+~octave");
        R("k:HOME|t:/|k:SEQ~end step record");
        break;
    case HS_LIVE:
        R("m:KEYS~record notes");
        R("k:FX|t:held~accented notes");
        R("n:SELECT~pick a row");
        R("n:ALGO~track");
        R("n:PRESET~pattern");
        break;
    case HS_SONG:
        R("n:SELECT~pick entry");
        R("c:1~entry's pattern");
        R("c:1|t:on END~add entry");
        R("k:FX|t:+|c:1~duplicate entry");
        R("c:2~transpose entry");
        R("c:4~song on / off");
        R("n:ALGO~song 1-8");
        R("n:PRESET~selected pattern");
        R("k:SEQ|t:+|k:REC~delete entry");
        R("k:SEL~back to steps");
        break;
    case HS_MENU:
        R("n:ALGO~tab");
        if (menu_tab == MT_GUIDE)
            R("n:SELECT~scroll");
        if (menu_page())
            R("c:1234~set");
        R("n:PRESET~patches");
        R("k:SAVE~save, close");
        if (menu_tab == MT_SYSTEM)
            R("t:hold|k:GLO|t:2 s~run armed row");
        break;
    default:                                        /* sandbox mode: the editor's page; its own buttons go to the editor */
        R("n:SELECT~devices");
        R("n:ALGO~device pages");
        R("c:1234~adjust values");
        R("t:in the editor:");
        R("k:SEQ|k:ENV|k:REC|k:SAVE|k:SEL");
        break;
    }
#undef R
    return n;
}

/* ---- drawing (the card draws itself plain: lcd_ovl_self) */

/* a colour PCT % as bright, channel by channel (RGB565) */
static uint16_t help_pct(uint16_t c, uint32_t pct)
{
    uint32_t r = (c >> 11) & 31u, g = (c >> 5) & 63u, b = c & 31u;
    return (uint16_t)((r * pct / 100u) << 11 | (g * pct / 100u) << 5 | (b * pct / 100u));
}

/* n 16 px knobs side by side at (x, y), 17 px apart, on the panel: grey with no number (digits 0), or K1..K4 in their
 * colours with the number inside in the 5x7 font; a 2 px pointer at the top, 4 px long, in the knob's colour at 50 % */
static void help_knobs(uint32_t x, uint32_t y, const char *digits, uint32_t n)
{
    static const uint8_t W[16] = {6, 10, 12, 14, 14, 16, 16, 16, 16, 16, 16, 14, 14, 12, 10, 6};
    uint32_t r, i, j, w = n * 17u - 1u;
    for (r = 0; r < 16u; r++) {
        uint16_t *row = lcd_line;
        for (j = 0; j < w; j++)
            row[j] = P_PANEL;
        for (i = 0; i < n; i++) {
            uint16_t c = digits ? KNOB_HUE[digits[i] - '1'] : P_DIM, *k = row + i * 17u;
            for (j = (16u - W[r]) / 2u; j < (16u + W[r]) / 2u; j++)
                k[j] = c;
            if (r < 4u)
                k[7] = k[8] = help_pct(c, 50u);
            if (digits && r >= 5u && r < 12u) {
                const uint8_t *g = FONT5X7[digits[i] - 0x20];
                for (j = 0; j < 5u; j++)
                    if (g[j] >> (r - 5u) & 1u)
                        k[5u + j] = P_NIGHT;
            }
        }
        lcd_line_out(x, y + r, w);
    }
}

/* a part's width (and with draw, the part at (x, y)) */
static uint32_t help_part(uint32_t x, uint32_t y, const char *p, uint32_t len, int draw)
{
    char buf[32];
    uint32_t n = len - 2u < sizeof buf - 1u ? len - 2u : sizeof buf - 1u, w, k;
    for (k = 0; k < n; k++)
        buf[k] = p[2u + k];
    buf[n] = 0;
    switch (p[0]) {
    case 'k': w = text_w(&FONT_S, buf, -1) + 8u; break;
    case 'n': w = 16u + 4u + text_w(&FONT_S, buf, -1); break;
    case 'c': w = n * 17u - 1u; break;
    case 'w': w = 11u + text_w(&FONT_S, "WHITE", -1); break;
    case 'b': w = 11u + text_w(&FONT_S, "BLACK", -1) + (n ? text_w(&FONT_S, " ", -1) + text_w(&FONT_S, buf, -1) : 0u); break;
    default: w = text_w(&FONT_S, buf, -1); break;
    }
    if (!draw)
        return w;
    switch (p[0]) {
    case 'k':                                       /* an outlined keycap, 15 px high, its corners cut */
        lcd_fill(x, y + 1u, w, 15, P_DIM);
        lcd_fill(x + 1u, y + 2u, w - 2u, 13, P_PANEL);
        lcd_fill(x, y + 1u, 1, 1, P_PANEL);
        lcd_fill(x + w - 1u, y + 1u, 1, 1, P_PANEL);
        lcd_fill(x, y + 15u, 1, 1, P_PANEL);
        lcd_fill(x + w - 1u, y + 15u, 1, 1, P_PANEL);
        text_bc(&FONT_S, x + 4u, y + 2u, buf, P_INK, P_PANEL, w - 8u, TA_LEFT);
        break;
    case 'n':
        help_knobs(x, y, 0, 1);
        text_bc(&FONT_S, x + 20u, y + 2u, buf, P_INK, P_PANEL, w - 20u, TA_LEFT);
        break;
    case 'c':
        help_knobs(x, y, buf, n);
        break;
    case 'w':                                       /* a white key: ivory, 7 x 15, and its word */
        lcd_fill(x, y + 1u, 7, 15, P_INK);
        text_bc(&FONT_S, x + 11u, y + 2u, "WHITE", P_INK, P_PANEL, w - 10u, TA_LEFT);
        break;
    case 'b':                                       /* a black key: night with a grey edge; b:N its number after BLACK */
        lcd_fill(x, y + 1u, 7, 15, P_DIM);
        lcd_fill(x + 1u, y + 2u, 5, 13, P_NIGHT);
        {
            char t[40];
            *(n ? put(put(t, "BLACK "), buf) : put(t, "BLACK")) = 0;
            text_bc(&FONT_S, x + 11u, y + 2u, t, P_INK, P_PANEL, w - 10u, TA_LEFT);
        }
        break;
    default:
        text_bc(&FONT_S, x, y + 2u, buf, p[0] == 'm' ? P_INK : P_DIM, P_PANEL, w + 1u, TA_LEFT);
    }
    return w;
}

/* a row at (x, y), its description at column ac or after the parts (draw 0: only where its parts end) */
static uint32_t help_row(uint32_t x, uint32_t y, const char *r, uint32_t ac, int draw)
{
    const char *q = r, *e, *d = r;
    while (*d && *d != '~')
        d++;
    while (q < d) {
        e = q;
        while (e < d && *e != '|')
            e++;
        x += help_part(x, y, q, (uint32_t)(e - q), draw) + 4u;
        q = e < d ? e + 1 : e;
    }
    if (draw && *d) {
        uint32_t dx = x > ac ? x + 2u : ac;
        text_bc(&FONT_S, dx, y + 2u, d + 1, P_DIM, P_PANEL, 222u - dx, TA_LEFT);
    }
    return x;
}

/* text in runs of colour, centred as a whole in the card: t[i] in c[i] */
static void help_runs(uint32_t y, const char *const *t, const uint16_t *c, uint32_t n)
{
    uint32_t i, tw = 0, x;
    for (i = 0; i < n; i++)
        tw += text_w(&FONT_S, t[i], -1);
    x = HC_IX + (HC_IW - tw) / 2u;
    for (i = 0; i < n; i++) {
        uint32_t sw = text_w(&FONT_S, t[i], -1);
        text_bc(&FONT_S, x, y, t[i], c[i], P_PANEL, sw, TA_LEFT);
        x += sw;
    }
}

/* the card's ground: the sky edge and the panel inside */
static void help_ground(void)
{
    lcd_fill(HC_M, HC_M, HC_W, HC_W, P_SKY);
    lcd_fill(HC_IX, HC_M + 2u, HC_IW, HC_W - 4u, P_PANEL);
}

/* the sheet: full, the card whole; else its tabs, rows and scroll bar (ALGO, SELECT, the state changed) */
static void help_sheet_draw(int full)
{
    const char *r[HC_ROWS];
    uint32_t n = help_rows(help_tab, r), i, y, total = n * HC_ROW, win = HC_BOT - HC_TOP;
    const char *title = HS_NAME[help_state()];
    uint32_t w1 = text_w(&FONT_S, title, -1) + 20u, w2 = HC_IW - w1;
    uint16_t on = help_pct(P_SKY, 75u);
    int t = help_tab != 0;
    if (help_top + HC_VIS > n)
        help_top = (uint8_t)(n > HC_VIS ? n - HC_VIS : 0u);
    if (full)
        help_ground();
    else
        lcd_fill(HC_IX, HC_TOP, HC_IW, HC_M + HC_W - 2u - HC_TOP, P_PANEL);
    {                                               /* the bottom line: SELECT only when the rows scroll (D-246) */
        static const char *const F[6] = {"ALGO", " tab   ", "SELECT", " scroll   ", "HOME", " close"};
        static const char *const F2[4] = {"ALGO", " tab   ", "HOME", " close"};
        static const uint16_t FC[6] = {P_INK, P_FAINT, P_INK, P_FAINT, P_INK, P_FAINT};
        if (n > HC_VIS)
            help_runs(HC_M + HC_W - 20u, F, FC, 6);
        else
            help_runs(HC_M + HC_W - 20u, F2, FC, 4);
    }
    lcd_fill(HC_IX, HC_M + 2u, w1, 20, t ? P_TRACK : on);          /* the tabs: the one shown sky at 75 % */
    lcd_fill(HC_IX + w1, HC_M + 2u, w2, 20, t ? on : P_TRACK);
    text_bc(&FONT_S, HC_IX, HC_M + 5u, title, t ? P_DIM : P_NIGHT, t ? P_TRACK : on, w1, TA_CENTER);
    text_bc(&FONT_S, HC_IX + w1, HC_M + 5u, "EVERYWHERE", t ? P_NIGHT : P_DIM, t ? on : P_TRACK, w2, TA_CENTER);
    lcd_fill(HC_IX + w1, HC_M + 2u, 1, 20, P_PANEL);
    for (i = help_top, y = HC_TOP; i < n && y + HC_ROW <= HC_BOT; i++, y += HC_ROW)
        help_row(HC_X0, y, r[i], HC_AC, 1);
    if (total > win) {                              /* the scroll bar */
        uint32_t s0 = help_top * HC_ROW, th = win * win / total;
        s0 = s0 > total - win ? total - win : s0;
        lcd_fill(HC_M + HC_W - 6u, HC_TOP, 2, win, P_TRACK);
        lcd_fill(HC_M + HC_W - 6u, HC_TOP + (win - th) * s0 / (total - win), 2, th, P_DIM);
    }
}

/* the quick start (D-247) */
static void help_quick_draw(void)
{
    static const char *const R[5] = {"n:SELECT~devices", "n:ALGO~device pages", "n:PRESET~device presets",
                                     "k:HOME|t:+|n:PRESET~patches", "c:1234~adjust values"};
    static const char *const F[6] = {"HOME", " dismiss    ", "HOME", "+", "SAVE", " forever"};
    static const uint16_t FC[6] = {P_INK, P_FAINT, P_INK, P_FAINT, P_INK, P_FAINT};
    static const char *const K[2] = {"OCT-", "OCT+"};
    const uint32_t cx = 120u, ky0 = 20u, kw = 46u, kh = 20u;
    uint32_t i, k, y, ac = 0;
    for (i = 0; i < 5u; i++) {                      /* the description column: clear of the widest row */
        uint32_t e = help_row(HC_X0, 0, R[i], 0, 0);
        ac = e > ac ? e : ac;
    }
    ac += 6u;
    help_ground();
    lcd_fill(HC_IX, HC_M + 2u, HC_IW, 20, P_SKY);
    text_bc(&FONT_M, HC_IX, HC_M + 3u, "QUICK START", P_NIGHT, P_SKY, HC_IW, TA_CENTER);
    for (i = 0, y = HC_M + 28u; i < 5u; i++, y += HC_ROW)
        help_row(HC_X0, y, R[i], ac, 1);
    y += 2u;
    lcd_fill(HC_X0, y, HC_W - 16u, 1, P_TRACK);
    text_bc(&FONT_S, HC_IX, y + 4u, "PRESS", P_DIM, P_PANEL, HC_IW, TA_CENTER);
    for (k = 0; k < 2u; k++) {                      /* OCT- + OCT+ as two ivory keycaps */
        uint32_t x = k ? cx + 10u : cx - 10u - kw, ky = y + ky0;
        lcd_fill(x, ky, kw, kh, P_INK);
        lcd_fill(x, ky, 2, 2, P_PANEL);
        lcd_fill(x + kw - 2u, ky, 2, 2, P_PANEL);
        lcd_fill(x, ky + kh - 2u, 2, 2, P_PANEL);
        lcd_fill(x + kw - 2u, ky + kh - 2u, 2, 2, P_PANEL);
        text_bc(&FONT_S, x, ky + 3u, K[k], P_NIGHT, P_INK, kw, TA_CENTER);
    }
    text_bc(&FONT_M, cx - 10u, y + ky0, "+", P_INK, P_PANEL, 20, TA_CENTER);
    text_bc(&FONT_S, HC_IX, y + ky0 + kh + 4u, "TO SEE CONTROLS FOR CURRENT PAGE", P_DIM, P_PANEL, HC_IW, TA_CENTER);
    help_runs(HC_M + HC_W - 20u, F, FC, 6);
}

/* the card, as help_due asks (panel.c panel_draw, before the page's own drawing) */
static void help_draw(void)
{
    uint32_t full = help_due > 1u;
    help_due = 0;
    if (!help_on)
        return;
    lcd_ovl_self = 1;
    if (help_on == HELP_QUICK)
        help_quick_draw();
    else
        help_sheet_draw((int)full);
    lcd_ovl_self = 0;
}

/* ---- opening, closing, following */

/* a card opens over the page (the sheet replaces the quick start): the page is drawn again as the dim frame around it */
static void help_open(uint32_t which)
{
    if (help_on == which)
        return;
    help_on = (uint8_t)which;
    help_tab = 0;
    help_top = 0;
    help_sig = help_state_sig();
    help_due = 2;
    lcd_ovl = 1;
    ui_full = 1;
    batt_drawn = BATT_NONE;                         /* (the footer's battery: drawn again, dim) */
}

/* HOME (or HOME + SAVE on the quick start): the card goes, the page is drawn whole again; a boot message held back
 * shows now */
static void help_close(void)
{
    if (!help_on)
        return;
    help_on = 0;
    help_due = 0;
    lcd_ovl = 0;
    ui_full = 1;
    batt_drawn = BATT_NONE;
    if (help_msg) {
        uint32_t i;
        for (i = 0; help_msg[i] && i < sizeof msg_text - 1u; i++)
            msg_text[i] = help_msg[i];
        msg_text[i] = 0;
        msg_until = fm1_ms + help_msg_ms;           /* (panel_draw's full redraw puts it in the bar) */
        help_msg = 0;
    }
}

/* the sheet follows the state (D-245): another state, device, tab, track or patch draws its rows again, from the top
 * when the state itself changed. From panel_draw, every pass */
static void help_follow(void)
{
    uint32_t s;
    if (help_on != HELP_SHEET)
        return;
    s = help_state_sig();
    if (s == help_sig)
        return;
    if ((s & 15u) != (help_sig & 15u))
        help_top = 0;
    help_sig = s;
    help_due = help_due ? help_due : 1u;
}

/* SELECT on the sheet: whole rows, as far as the last row; ALGO: the other tab */
static void help_knobs_turn(int32_t select, int32_t algo)
{
    const char *r[HC_ROWS];
    if (help_on != HELP_SHEET)
        return;
    if (algo && (algo > 0) != (help_tab != 0)) {     /* right: EVERYWHERE, left: the state's tab */
        help_tab = (uint8_t)(algo > 0);
        help_top = 0;
        help_due = help_due ? help_due : 1u;
    }
    if (select) {
        uint32_t n = help_rows(help_tab, r), max = n > HC_VIS ? n - HC_VIS : 0u;
        int32_t t = (int32_t)help_top + select;
        t = t < 0 ? 0 : t > (int32_t)max ? (int32_t)max : t;
        if ((uint32_t)t != help_top) {
            help_top = (uint8_t)t;
            help_due = help_due ? help_due : 1u;
        }
    }
}
