/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* MIDI learn on the FM-1 (#1067; web/src/midi-learn.ts is the editor's), after pages_ui.c, before menu.c. A MIDI
 * controller's CC, pitch bend or note moves one row of the running patch, on any page, in focus or not. The patch keeps
 * its mappings in its binary (engine.h eng_maps: the source, the row's module and parameter bytes, its low and high end),
 * so the FM-1 plays them without the editor. A learned control does only that: its fixed job (midi_input.h: Main's mod
 * wheel, breath, sustain, foot, K1..K4, morph, pitch bend; a note's sound) waits until its mapping is cleared. CC 80..86
 * (the patch buttons) and 120..127 (the channel mode messages) are never learned. Mappings follow MENU > MIDI CHANNEL.
 *
 * Learning (D-939): HOME held + SEL (panel.c), or MIDI 3/4's LEARN turned right, toggles learn mode on a device page or
 * the environment. The next knob turned picks its row, which does not move (learn_row), and the first control to send
 * three different values (two for a switch row), or the first note played, moves it from then on; that ends learn mode.
 * A HOME tap, HOME + SEL again, another patch, or LEARN_MS without a step ends it too. Controls with a fixed job heard
 * meanwhile (FIXED_CC) are named when the learn ends: they still do their job. GLO > MIDI 3/4 lists the mappings
 * (MAPPING) and clears the one it shows (CLEAR). A linked editor hears each change (MAP_NOW) and every move (PARAM_NOW, at
 * most every MAP_REPORT_MS for a mapping).
 *
 * A note (source ENG_MAP_NOTE + its number) toggles a switch row at each note-on, between the mapping's ends; any other
 * row takes the note-on's velocity between them. Its note-off does nothing.
 *
 * The global pad map (pad_map.h, #1067): in learn mode while Main's keys reach a kit, a drum key picks its row (in the
 * bank the keys are on, D-520) and the next note played becomes that row's pad; learn mode then waits for the next
 * row's pad, until the last row, a HOME tap or HOME + SEL. A pad plays its row, after the patch's own learned notes
 * (pad_midi). GLO > MIDI 4/4 shows it: PAD MAP, a row and its pad, CLEAR, CLEAR ALL. */

#define LEARN_MS 30000u
#define LEARN_CANDS 2u                                  /* controls a learn tells apart at once (an X-Y pad sends two) */
#define MAP_REPORT_MS 25u

/* the CCs with a fixed job (midi_input.h), named when a learn heard them (D-939): K1..K4, mod wheel, breath, morph,
 * sustain, foot */
static const uint8_t FIXED_CC[9] = {16, 17, 18, 19, 1, 2, 22, 64, 65};
static const char *const FIXED_JOB[9] = {"TURNS K1", "TURNS K2", "TURNS K3", "TURNS K4", "MOD WHEEL", "BREATH", "MORPH",
                                         "SUSTAIN", "FOOT"};

static struct {
    uint8_t on;                                         /* 1: learn mode waits, 2: a row waits for a control, 3: a drum row
                                                         * (mod) waits for a pad; par counts the pads learned, need = 1 while
                                                         * the bar names the last one, before the next row's prompt */
    uint8_t mod, par, need;                             /* the row (a page row's module and parameter bytes), values to see */
    uint8_t nc;
    uint16_t also;                                      /* bit i: FIXED_CC[i] was heard meanwhile */
    uint32_t gen, at;                                   /* the patch it learns for (pages_gen), its last step (fm1_ms) */
    struct { uint8_t src, n; uint16_t v[2]; } c[LEARN_CANDS];   /* the controls heard: their different values so far */
} ml ENG_LOWRAM;                                        /* (.lowram, zeroed at boot: the RAM region has no room left) */
static uint8_t map_sel;                                 /* the mapping GLO > MIDI 3/4 shows (MAPPING, CLEAR) */
static uint8_t pad_sel;                                 /* the pad map's row GLO > MIDI 4/4 shows */
static uint8_t pad_sound[PAD_ROWS];                     /* the note a row's pad started, + 1 (0: none): its note-off ends it */
typedef struct { uint8_t due, mod, par; int32_t v; uint32_t at; } map_rep_t;
static map_rep_t map_rep[ENG_MAP_RAMPS];               /* the moves told to the editor (PARAM_NOW), per ramp slot */
static char *seq_note_name(char *p, uint32_t n);        /* (seq_ui.c: C4 is note 60) */
static void screen_back(void);                         /* (panel.c) */
static int m1_drum_name(uint32_t map, uint32_t r, char *out);   /* (proto.c; the host's after this file) */
static int map_has(uint32_t src);
#define PAD_SHOW_MS 1000u                               /* a pad learned: its name shows this long before the next row's prompt */
/* the running patch's mappings: their count, *e at the first one's bytes */
static uint32_t map_list(const uint8_t **e)
{
    uint32_t len;
    const uint8_t *p = pages_src(&len);
    return p ? eng_maps(p, len, e) : 0u;
}

/* a learnable CC (0..119 but 80..86), pitch bend (ENG_MAP_BEND) or note (ENG_MAP_NOTE + n) */
static int map_learnable(uint32_t src)
{
    return src == ENG_MAP_BEND || (src >= ENG_MAP_NOTE && src < ENG_MAP_NOTE + 128u) ||
           (src < 120u && !(src >= 80u && src < 80u + ENG_PANEL_BUTTONS));
}

/* a source's name: CC 1, BEND, NOTE C2 */
static char *map_src_name(char *p, uint32_t src)
{
    if (src == ENG_MAP_BEND)
        return put(p, "BEND");
    if (src >= ENG_MAP_NOTE)
        return seq_note_name(put(p, "NOTE "), src - ENG_MAP_NOTE);
    p = put(p, "CC ");
    fmt_int(p, (int32_t)src);
    return p + str_len(p);
}

/* module m's row byte j by its row's name in capitals (at most 12 characters), "?" when no page has it */
static char *map_row_name(char *p, uint32_t m, uint32_t j)
{
    uint32_t k;
    const ppage_t *pg = row_find(m, j, &k);
    if (!pg) {
        p = put(p, "?");
        *p = 0;
        return p;
    }
    caps(p, pg->lab[k], pg->llen[k], 12u);
    return p + str_len(p);
}

/* a row with two positions (a two-way choice, or a 0..1 switch in whole steps): a learn of it needs two values, a note
 * toggles it */
static int map_switch(uint32_t m, uint32_t j)
{
    int t = eng_type(m);
    const def_t *d;
    uint32_t n = 0;
    if (t < 0)
        return 0;
    d = &DEFS[t];
    while (d->pchoice && d->pchoice[j] && d->pchoice[j][n])
        n++;
    return n == 2u || (!n && d->pmin[j] == 0 && d->pmax[j] == 65536 && d->pinc[j] == 65536);
}

/* is a learn under way? 1: learn mode waits for a knob or a drum key, 2: a row waits for a control, 3: a drum row waits
 * for a pad. It ends with another patch or LEARN_MS after its last step */
static int learn_live(void)
{
    if (ml.on && (ml.gen != pages_gen() || fm1_ms - ml.at > LEARN_MS))
        ml.on = 0;
    return ml.on;
}

/* does learn mode wait for a knob or a drum key (panel.c learn_knob, panel_key) */
static int learn_keys(void)
{
    int s = learn_live();
    return s == 1 || s == 3;
}

/* the drum rows Main's keys reach, as eng_keys_rows lists them (D-520); 0 when they reach none (sandbox mode: plain notes) */
static uint32_t pad_rows(uint8_t *rm, uint8_t *rr)
{
    return sb_on || eng_keys_drummap() < 0 ? 0u : eng_keys_rows(rm, rr);
}

/* drum row i as the bar names it: its number, then its name in capitals (at most max characters), "1 BASS DRU" */
static char *pad_name(char *p, uint32_t i, uint32_t max)
{
    uint8_t rm[ENG_DRUM_LIST], rr[ENG_DRUM_LIST];
    char name[ENG_DRUM_NAME + 1u];
    uint32_t rn = pad_rows(rm, rr);
    fmt_int(p, (int32_t)i + 1);
    p += str_len(p);
    if (i < rn && m1_drum_name(rm[i], rr[i], name) && name[0]) {
        *p++ = ' ';
        caps(p, name, str_len(name), max);
        p += str_len(p);
    }
    *p = 0;
    return p;
}

/* learn mode on or off (D-939): HOME held + SEL (panel.c) or MIDI 3/4's LEARN turned right. On a device page or the
 * environment the next knob turned picks its row (learn_row), a drum key its pad's row (pad_pick); the SEQ and SONG pages
 * and sandbox mode refuse it */
static void learn_mode(int on)
{
    uint8_t rm[ENG_DRUM_LIST], rr[ENG_DRUM_LIST];
    if (!on) {
        if (ml.on == 3 && ml.par) {                     /* (pads learned this time: how many rows have one now) */
            char text[24];
            fmt_int(put(text, MSG_PADS), (int32_t)pad_count());
            put(text + str_len(text), MSG_PADS_LEARNED)[0] = 0;
            ui_msg(text, 2000);
        } else if (ml.on)
            ui_msg(MSG_LEARN_OFF, 1500);
        ml.on = 0;
        return;
    }
    if (sb_on) {
        ui_msg(MSG_LEARN_SANDBOX, 1500);
        return;
    }
    if (page != 0u && page != PAGE_ENV) {               /* (the SEQ and SONG pages and the rest: no row to pick) */
        ui_msg(MSG_LEARN_HERE, 1500);
        return;
    }
    ml.gen = pages_gen();
    ml.at = fm1_ms;
    ml.on = 1;
    ml.par = 0;
    ml.need = 0;
    ui_msg(pad_rows(rm, rr) ? MSG_LEARN_KIT : MSG_LEARN_TURN, LEARN_MS);
}

/* the bar's prompt for drum row ml.mod: 1 BASS DRU: HIT A PAD */
static void pad_prompt(void)
{
    char text[40];
    put(pad_name(text, ml.mod, 12u), MSG_PAD_HIT)[0] = 0;
    ui_msg(text, LEARN_MS);
}

/* a drum key in learn mode (panel.c panel_key): list row i of the rows the keys reach waits for a pad; the key still plays */
static void pad_pick(uint32_t i)
{
    if (i >= PAD_ROWS) {
        ui_msg(MSG_PAD_ROWS, 1500);
        return;
    }
    ml.mod = (uint8_t)i;
    ml.need = 0;
    ml.gen = pages_gen();
    ml.at = fm1_ms;
    ml.on = 3;
    pad_prompt();
}

/* a pad's note n (raw its velocity, 0 a note-off) on the MIDI channel chn: it plays its row of the kit the keys reach, at
 * the pad's velocity, and its note-off ends what it started. 1 taken; 0 not a pad, PAD MAP off, or no such row now: the
 * note plays as itself */
static int pad_midi(uint32_t n, uint32_t raw, uint32_t chn)
{
    uint8_t rm[ENG_DRUM_LIST], rr[ENG_DRUM_LIST];
    int r = pad_row_of(n), note;
    if (r < 0)
        return 0;
    if (!raw) {                                         /* (the note its note-on started, whatever the keys reach by now) */
        if (!pad_sound[r])
            return 0;
        eng_midi_channel(cfg.ch);
        eng_note_off(pad_sound[r] - 1u, chn);
        pad_sound[r] = 0;
        return 1;
    }
    if (!pad_on || (uint32_t)r >= pad_rows(rm, rr) || (note = eng_drummap_note(rm[r], rr[r])) < 0)
        return 0;
    pad_sound[r] = (uint8_t)(note + 1);
    eng_midi_channel(cfg.ch);
    eng_note_on((uint32_t)note, (int32_t)(raw * 65536u / 127u), chn);
    return 1;
}

/* a note-on while a drum row waits for a pad (midi_input.h, on the MIDI channel): it becomes the row's pad, plays it, and
 * the next row waits (its prompt after PAD_SHOW_MS: map_poll); after the last row learn mode ends. 1 taken */
static int pad_learn(uint32_t n, uint32_t raw, uint32_t chn)
{
    uint8_t rm[ENG_DRUM_LIST], rr[ENG_DRUM_LIST];
    uint32_t rn, r;
    char text[40], *p;
    if (learn_live() != 3 || !raw)
        return 0;
    rn = pad_rows(rm, rr);
    r = ml.mod;
    if (r >= rn)
        return 0;
    pad_set(r, n);
    gt_changed(fm1_ms);                                 /* (kept as the settings are, without SAVE) */
    m1_pads_now();
    ml.par++;
    pad_midi(n, raw, chn);
    p = put(map_src_name(text, ENG_MAP_NOTE + n), MSG_PAD_TO);
    pad_name(p, r, 11u);
    ui_msg(text, LEARN_MS);
    if (++r < rn && r < PAD_ROWS) {
        ml.mod = (uint8_t)r;
        ml.need = 1;
        ml.at = fm1_ms;
    } else
        learn_mode(0);
    if (!ui_dirty)
        ui_dirty = 1;
    return 1;
}

/* a knob k turned in learn mode (panel.c learn_knob): row k of the page in focus waits for a control and does not move;
 * a row that takes nothing from MIDI leaves learn mode waiting for another knob */
static void learn_row(uint32_t k)
{
    const ppage_t *pg = pages_now();
    uint32_t m, j;
    int t;
    char text[40], *p;
    if (!pg || k >= pg->nrows || (m = pg->mod[k]) == SETTING_ROW || ((j = pg->par[k]) & POLY_ROW) || (t = eng_type(m)) < 0 ||
        DEF_FIXED((uint32_t)t, j)) {
        ui_msg(MSG_LEARN_NO_ROW, 1500);
        return;
    }
    ml.need = (uint8_t)(map_switch(m, j) ? 2u : 3u);
    ml.mod = (uint8_t)m;
    ml.par = (uint8_t)j;
    ml.nc = 0;
    ml.also = 0;
    ml.gen = pages_gen();
    ml.at = fm1_ms;
    ml.on = 2;
    p = put(text, MSG_LEARN);
    caps(p, pg->lab[k], pg->llen[k], 12u);
    put(p + str_len(p), MSG_LEARN_MOVE)[0] = 0;
    ui_msg(text, LEARN_MS);
}

/* the learn found its control: it moves the row from now on. The bar names it, or a control with a fixed job heard
 * meanwhile that still does that job (CC 16 ALSO SENT: TURNS K1) */
static void learn_bind(uint32_t src)
{
    char text[40], *p;
    uint8_t also[9];
    uint32_t i, na = 0, first = 9u;
    ml.on = 0;
    if (!m1_patch_map(src, ml.mod, ml.par, 0u, 255u, 1)) {
        ui_msg(MSG_LEARN_FULL, 2000);
        return;
    }
    for (i = 0; i < 9u; i++)                            /* (a fixed-job CC another row learned does that row's job now: not named) */
        if ((ml.also >> i & 1u) && FIXED_CC[i] != src && !map_has(FIXED_CC[i])) {
            if (first == 9u)
                first = i;
            also[na++] = FIXED_CC[i];
        }
    m1_map_now(src, also, na);
    if (first < 9u) {
        p = put(map_src_name(text, FIXED_CC[first]), MSG_LEARN_ALSO);
        put(p, FIXED_JOB[first])[0] = 0;
        ui_msg(text, 4000);
        return;
    }
    p = map_src_name(text, src);
    p = put(p, MSG_LEARN_MOVES);
    map_row_name(p, ml.mod, ml.par);
    ui_msg(text, 2500);
}

/* a learnable control's value (a CC's 0..127, pitch bend's 0..16383, a note's velocity, 0 for its note-off) while a row
 * waits for one: 1, taken (it does nothing else); the control that sends the row's count of different values first, or
 * the first note played, is learned. A note-off is not taken (a note held from before the learn still ends) */
static int learn_take(uint32_t src, uint32_t raw)
{
    uint32_t i, k;
    if (learn_live() != 2)
        return 0;
    if (src >= ENG_MAP_NOTE) {
        if (!raw)
            return 0;
        learn_bind(src);
        return 1;
    }
    for (i = 0; i < 9u; i++)
        if (FIXED_CC[i] == src)
            ml.also |= (uint16_t)(1u << i);
    for (i = 0; i < ml.nc && ml.c[i].src != src; i++)
        ;
    if (i == ml.nc) {                                   /* a new control: a place of its own, else the one with the fewest
                                                         * values (a touch switch sends two, the axes many) */
        if (ml.nc < LEARN_CANDS)
            ml.nc++;
        else
            for (i = 0, k = 1; k < LEARN_CANDS; k++)
                if (ml.c[k].n < ml.c[i].n)
                    i = k;
        ml.c[i].src = (uint8_t)src;
        ml.c[i].n = 0;
    }
    for (k = 0; k < ml.c[i].n && ml.c[i].v[k] != raw; k++)
        ;
    if (k == ml.c[i].n) {
        if (k + 1u >= ml.need) {
            learn_bind(src);
            return 1;
        }
        ml.c[i].v[k] = (uint16_t)raw;
        ml.c[i].n++;
    }
    return 1;
}

/* mapping i's move to the linked editor: at once, else after MAP_REPORT_MS (map_poll), the latest value */
static void map_report(uint32_t i, uint32_t mod, uint32_t par, int32_t v)
{
    map_rep_t *r = &map_rep[i % ENG_MAP_RAMPS];
    if (r->due && (r->mod != mod || r->par != par))     /* (another mapping took the slot: the row before gets its last value) */
        m1_param_now(r->mod, r->par, r->v);
    r->mod = (uint8_t)mod;
    r->par = (uint8_t)par;
    r->v = v;
    r->due = 1;
    if (fm1_ms - r->at >= MAP_REPORT_MS) {
        r->at = fm1_ms;
        r->due = 0;
        m1_param_now(mod, par, v);
    }
}

/* the moves map_report held back, once their MAP_REPORT_MS are over, and the next drum row's prompt once the pad learned
 * has shown PAD_SHOW_MS (midi_input.h, after each drain) */
static void map_poll(void)
{
    uint32_t i;
    for (i = 0; i < ENG_MAP_RAMPS; i++)
        if (map_rep[i].due && fm1_ms - map_rep[i].at >= MAP_REPORT_MS) {
            map_rep[i].at = fm1_ms;
            map_rep[i].due = 0;
            m1_param_now(map_rep[i].mod, map_rep[i].par, map_rep[i].v);
        }
    if (ml.need && ml.on == 3 && learn_live() == 3 && fm1_ms - ml.at >= PAD_SHOW_MS) {
        ml.need = 0;
        pad_prompt();
    }
}

/* does control src move a row of the running patch, or does a learn wait for a control (midi_input.h: the message then
 * waits for the main loop, as CC 16..19 do; a mapped note is never played) */
static int map_has(uint32_t src)
{
    const uint8_t *e = 0;
    uint32_t n, i;
    if (!map_learnable(src))
        return 0;
    if (learn_live() == 2 || (learn_live() == 3 && src >= ENG_MAP_NOTE))   /* (a pad's learn: as a control's) */
        return 1;
    n = map_list(&e);
    for (i = 0; i < n; i++, e += ENG_MAP_BYTES)
        if (e[0] == src)
            return 1;
    return 0;
}

/* a CC (src 0..119, raw 0..127), pitch bend (ENG_MAP_BEND, raw 0..16383) or note (ENG_MAP_NOTE + n, raw its velocity, 0
 * a note-off) on the MIDI channel: 1 when a learn or a mapping took it, so it does nothing else (midi_input.h); 0, it does
 * its fixed job */
static int map_midi(uint32_t src, uint32_t raw)
{
    const uint8_t *e = 0;
    uint32_t n, i, m, j, mod, par;
    int32_t u, v, lo, hi;                               /* (lo, hi: the ends 0..255) */
    if (!map_learnable(src))
        return 0;
    if (learn_take(src, raw))
        return 1;
    n = map_list(&e);
    for (i = 0; i < n && e[0] != src; i++, e += ENG_MAP_BYTES)
        ;
    if (i == n)
        return 0;
    m = e[1];                                           /* (copied: the move may grow the binary, which moves the section) */
    j = e[2];
    lo = e[3];
    hi = e[4];
    if (src >= ENG_MAP_NOTE) {
        int t = eng_type(m);
        if (!raw)                                       /* (a note-off: nothing, and not played) */
            return 1;
        if (map_switch(m, j) && t >= 0) {               /* a switch: to the end it is further from */
            const def_t *d = &DEFS[t];
            int32_t span = d->pmax[j] - d->pmin[j];
            int32_t at = span > 0 ? (int32_t)(((int64_t)(eng_get_param(m, j) - d->pmin[j]) * 255) / span) : 0;
            u = ((at > hi ? at - hi : hi - at) < (at > lo ? at - lo : lo - at) ? lo : hi) * 65536 / 255;
        } else                                          /* (the velocity 1..127 across the ends, as a CC's value) */
            u = (int32_t)(((int64_t)lo * 65536 + (int64_t)(hi - lo) * (int32_t)(raw * 65536u / 127u)) / 255);
    } else {
        if (src == ENG_MAP_BEND)                        /* (its centre, 8192, is the middle; its ends the ends) */
            u = raw < 8192u ? (int32_t)(raw * 4u) : 32768 + (int32_t)((raw - 8192u) * 32768u / 8191u);
        else
            u = (int32_t)(raw * 65536u / 127u);
        u = (int32_t)(((int64_t)lo * 65536 + (int64_t)(hi - lo) * u) / 255);
    }
    if (!pages_map_move(m, j, u, i, &mod, &par, &v))
        return src >= ENG_MAP_NOTE;                     /* (a mapped note is never played, even on a row it cannot move) */
    map_report(i, mod, par, v);
    return 1;
}

/* ---- GLO > MIDI 3/4 (menu.c): MAPPING, CLEAR and LEARN (HOME + SEL; turned right it starts learn mode) */

/* MAPPING's label: the mapping shown, "CC 1  1/2" (a note: "NOTE C#-1 1/2"), or MAPPINGS when there are none */
static const char *map_label(void)
{
    static char t[16];
    const uint8_t *e = 0;
    uint32_t n = map_list(&e), src;
    char *p;
    if (!n)
        return "MAPPINGS";
    if (map_sel >= n)
        map_sel = (uint8_t)(n - 1u);
    src = e[ENG_MAP_BYTES * map_sel];
    p = map_src_name(t, src);
    p = put(p, src >= ENG_MAP_NOTE ? " " : "  ");
    fmt_int(p, map_sel + 1);
    p = put(p + str_len(p), "/");
    fmt_int(p, (int32_t)n);
    return t;
}

/* a row's value as menu.c menu_value writes it */
static void map_value(uint32_t row, char *out)
{
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    char *p = out;
    if (row == MR_PADS_ON)                              /* (the pad map, MIDI 4/4) */
        p = put(p, pad_on ? "ON" : "OFF");
    else if (row == MR_PAD_ROW)
        p = pad_note[pad_sel] == PAD_NONE ? put(p, "-") : map_src_name(p, ENG_MAP_NOTE + pad_note[pad_sel]);
    else if (row == MR_PAD_CLEAR)
        p = put(p, pad_note[pad_sel] == PAD_NONE ? "-" : "TURN >");
    else if (row == MR_LEARN)
        p = put(p, "HOME + SEL");
    else if (row == MR_MAP_CLEAR)
        p = put(p, n ? "TURN >" : "-");
    else if (!n)
        p = put(p, "NONE");
    else {
        char name[16];
        if (map_sel >= n)
            map_sel = (uint8_t)(n - 1u);
        e += ENG_MAP_BYTES * map_sel;
        map_row_name(name, e[1], e[2]);
        name[10] = 0;                                   /* (a value takes 10 characters) */
        p = put(p, name);
    }
    *p = 0;
}

/* the pad map's rows GLO > MIDI 4/4 steps through: as many as the kit the keys reach has (at most PAD_ROWS), all of them
 * while they reach none */
static uint32_t pad_menu_rows(void)
{
    uint8_t rm[ENG_DRUM_LIST], rr[ENG_DRUM_LIST];
    uint32_t rn = pad_rows(rm, rr);
    return rn && rn < PAD_ROWS ? rn : PAD_ROWS;
}

/* MIDI 4/4's row label: the row shown, its number and name (1 BASS DRU) */
static const char *pad_label(void)
{
    static char t[16];
    uint32_t n = pad_menu_rows();
    if (pad_sel >= n)
        pad_sel = (uint8_t)(n - 1u);
    pad_name(t, pad_sel, 9u);
    return t;
}

/* CLEAR ALL (menu.c menu_fire, after GLO's hold): every row's pad gone */
static void pad_clear_now(void)
{
    pad_clear_all();
    gt_changed(fm1_ms);
    m1_pads_now();
    ui_msg(MSG_PADS_CLEARED, 1500);
}

/* a row's place in its range over width px (menu.c setting_bar) */
static uint32_t map_bar(uint32_t row, uint32_t width)
{
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    if (row == MR_PAD_ROW)
        return pad_sel * width / (pad_menu_rows() - 1u);
    if (row == MR_MAPS)
        return n > 1u ? (map_sel < n ? map_sel : n - 1u) * width / (n - 1u) : n ? width : 0u;
    return 0u;
}

/* a row turned (menu.c setting_step) */
static void map_step(uint32_t row, int32_t s)
{
    const uint8_t *e = 0;
    uint32_t n = map_list(&e);
    if (row == MR_LEARN && s > 0) {                     /* (the menu closes: learn mode on the page it came from) */
        screen_back();
        learn_mode(1);
    } else if (row == MR_PADS_ON) {
        if (pad_on != (s > 0)) {
            pad_on = (uint8_t)(s > 0);
            gt_changed(fm1_ms);
            m1_pads_now();
        }
    } else if (row == MR_PAD_ROW) {
        int32_t v = (int32_t)pad_sel + (s > 0 ? 1 : -1), top = (int32_t)pad_menu_rows() - 1;
        pad_sel = (uint8_t)(v < 0 ? 0 : v > top ? top : v);
    } else if (row == MR_PAD_CLEAR && s > 0 && pad_note[pad_sel] != PAD_NONE) {
        char text[24];
        put(map_src_name(text, ENG_MAP_NOTE + pad_note[pad_sel]), MSG_MAP_CLEARED)[0] = 0;
        pad_set(pad_sel, PAD_NONE);
        gt_changed(fm1_ms);
        m1_pads_now();
        ui_msg(text, 1500);
    } else if (row == MR_MAPS) {
        int32_t v = (int32_t)map_sel + (s > 0 ? 1 : -1);
        map_sel = (uint8_t)(n ? (v < 0 ? 0 : v >= (int32_t)n ? (int32_t)n - 1 : v) : 0);
    } else if (row == MR_MAP_CLEAR && s > 0 && n) {
        char text[24];
        uint32_t src;
        if (map_sel >= n)
            map_sel = (uint8_t)(n - 1u);
        src = e[ENG_MAP_BYTES * map_sel];
        if (m1_patch_map(src, 0, 0, 0, 0, 0)) {
            m1_map_now(src, 0, 0);
            put(map_src_name(text, src), MSG_MAP_CLEARED)[0] = 0;
            ui_msg(text, 1500);
        }
    }
}
