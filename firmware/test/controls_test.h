/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* #553, part of panel_test.c (its helpers): every row of the controls table (web/src/controls.ts, generated into
 * controls.h) driven in each state whose sheet lists it, and its effect checked. A fixture puts the FM-1 in the state
 * (some states have variants: a Page button's list on, a long track, a menu tab); the row is tested in the first variant
 * whose sheet shows it, so its condition is checked too. Its gesture is driven as the panel takes it (each alternative of
 * "OCT- / OCT+" alone; an encoder or knob one click right, else left), then what the row says it does must have
 * happened. A handler changed without its row fails here: change controls.ts with it (the sheet, the editor's help and
 * the hints follow). */

#define CT_STEP 2                                       /* the white key a gesture presses: the one of step 3 */

/* what a row's effect is checked on */
typedef struct {
    uint32_t page, sr_on, sr_k, run, once, rec, saved, stepped, dev, devpage, menu_tab, man_top, updates, cfg_sum;
    int32_t octave, tempo, list_btn, list_step;
    uint32_t params, mutes, trk, row, roll_lo, seq_pg, pattern, lpg, locks;
    eng_mset_t arms;                                    /* (all 128 modules: a big patch's tracks sit above 31, #721) */
    int32_t notes_n;
    uint32_t notes_sum, acc_n, len_sum, vel_sum, chance_sum, pitch_sum;
    uint32_t song_sel, song_cur, song_len, song_sum, song, clear_at, del_at, msg_sum;
    int mlen;
} ct_snap_t;
static int ct_mod;                                      /* the track shown when the gesture began, -1 none */
static uint32_t ct_pre_dev, ct_pre_pg;                  /* the device page before the Page button's press (ct_page_button) */

static uint32_t ct_fnv(uint32_t h, uint32_t v) { return (h ^ v) * 0x01000193u; }
static uint32_t ct_params(void)
{
    uint32_t h = 0x811c9dc5u, m, p;
    for (m = 0; (int)m < eng_nmodules(); m++)
        for (p = 0; eng_type(m) >= 0 && p < DEFS[eng_type(m)].npar; p++)
            h = ct_fnv(h, (uint32_t)eng_get_param(m, p));
    return h;
}
static void ct_take(ct_snap_t *s)
{
    uint32_t i, k;
    int panel = eng_find(T_FM1);
    memset(s, 0, sizeof *s);
    s->page = page;
    s->sr_on = sr_on;
    s->sr_k = sr_k;
    s->run = (uint32_t)eng_transport_running();
    s->once = (uint32_t)eng_once_state();
    s->rec = seq_rec;
    s->saved = (uint32_t)saved;
    s->stepped = (uint32_t)presets_stepped;
    pages_ensure();
    s->dev = pg_cur_dev;
    s->devpage = pg_cur_page;
    s->list_btn = pg_list_btn;
    s->list_step = pg_list_step;
    s->menu_tab = menu_tab;
    s->man_top = man_top;
    s->updates = (uint32_t)(host_updates + host_defaults);
    s->cfg_sum = ct_fnv(ct_fnv(ct_fnv(ct_fnv(ct_fnv(ct_fnv(0, cfg.ch), cfg.midi_out), cfg.count_in), cfg.quick), (uint32_t)gt_patch), cfg.clock_in);
    s->octave = octave;
    s->tempo = (panel >= 0 ? eng_get_param((uint32_t)panel, FM1_P_TEMPO) : 0) + (int32_t)eng_tempo_global_get();
    s->params = ct_params();
    s->arms = eng_arm_mask_get();
    for (i = 0; (int)i < eng_steps_count(); i++)
        s->mutes |= (uint32_t)(eng_steps_muted((uint32_t)eng_steps_module(i)) != 0) << i;
    s->trk = seq_trk;
    s->row = seq_row;
    s->roll_lo = seq_roll_lo;
    s->seq_pg = seq_pg;
    s->pattern = (uint32_t)eng_pattern();
    s->lpg = seq_lpg;
    s->locks = (uint32_t)eng_locks_count();
    s->notes_sum = 0x811c9dc5u;
    if (ct_mod >= 0) {
        const uint32_t *w;
        int n = eng_steps_notes((uint32_t)ct_mod, &w);
        s->notes_n = n;
        for (k = 0; (int)k < n; k++) {
            s->notes_sum = ct_fnv(s->notes_sum, w[k]);
            s->acc_n += ((w[k] >> 19) & 127u) == ACCENT_VEL;
            s->len_sum += (w[k] >> 6) & 63u;
            s->vel_sum += (w[k] >> 19) & 127u;
            s->chance_sum += (w[k] >> 26) & 31u;
            s->pitch_sum += (w[k] >> 12) & 127u;
        }
    }
    s->song_sel = song_sel;
    s->song_cur = song_cur;
    s->song_len = (uint32_t)eng_song_len(song_sel);
    s->song_sum = 0x811c9dc5u;
    for (k = 0; (int)k < eng_song_len(song_sel); k++)
        s->song_sum = ct_fnv(s->song_sum, (uint32_t)eng_song_get(song_sel, k));
    s->song = (uint32_t)eng_song();
    s->clear_at = seq_clear_at;
    s->del_at = song_del_at;
    s->msg_sum = 0x811c9dc5u;
    for (k = 0; msg_text[k]; k++)
        s->msg_sum = ct_fnv(s->msg_sum, (uint8_t)msg_text[k]);
    s->mlen = mlen;
}

/* the row's effect from b (before) to a (after) */
static int ct_effect(uint32_t e, const ct_snap_t *b, const ct_snap_t *a)
{
    int moved = a->page != b->page || a->dev != b->dev || a->devpage != b->devpage || a->list_btn != b->list_btn;
    int same_notes = a->notes_n == b->notes_n;
    switch (e) {
    case CE_TRANSPORT: return a->run != b->run;
    case CE_PLAY_ONCE: return a->run != b->run || a->once != b->once;   /* (stopped: the count-in; running: a stop) */
    case CE_RECORD: return a->rec != b->rec;
    case CE_SAVE: return a->saved != b->saved;
    case CE_BACK: return moved || (b->sr_on && !a->sr_on);
    case CE_MENU: return a->page == PAGE_MENU && b->page != PAGE_MENU;
    case CE_ENV: return a->page == PAGE_ENV && b->page != PAGE_ENV;
    case CE_SEQ: return a->page == PAGE_SEQ && b->page != PAGE_SEQ;
    case CE_OCTAVE: case CE_KEYS_OCTAVE: return a->octave != b->octave;
    case CE_TEMPO: return a->tempo != b->tempo || (sb_on && a->msg_sum != b->msg_sum);   /* (sandbox: the editor's) */
    case CE_PATCH: return a->stepped != b->stepped;
    case CE_STORE: return a->msg_sum != b->msg_sum;     /* (dp_store says what it stored) */
    case CE_ARM: return !mset_eq(a->arms, b->arms);
    case CE_MUTE: return a->mutes != b->mutes;
    case CE_FOCUS: return a->dev != b->dev;
    case CE_DEVICE_PAGE: return a->devpage != b->devpage;
    case CE_LIST_BACK:                                  /* (the list closed, the page before the button's press back) */
        return b->list_btn >= 0 && a->list_btn < 0 && a->page == 0u && a->dev == ct_pre_dev && a->devpage == ct_pre_pg
            && (b->dev != ct_pre_dev || b->devpage != ct_pre_pg);
    case CE_LIST_PAGE: return a->list_step != b->list_step || a->dev != b->dev || a->devpage != b->devpage;
    case CE_PRESET: case CE_PARAM: case CE_FINE: return a->params != b->params;
    case CE_STEP: return a->notes_n != b->notes_n;
    case CE_ROW: return a->row != b->row;
    case CE_ROLL_VIEW: return a->roll_lo == b->roll_lo + 8u || a->roll_lo + 8u == b->roll_lo;
    case CE_ROLL_PITCH: return a->roll_lo == b->roll_lo + 1u || a->roll_lo + 1u == b->roll_lo;
    case CE_JUMP: return a->roll_lo != b->roll_lo;
    case CE_TRACK: return a->trk != b->trk;
    case CE_PATTERN: return a->pattern != b->pattern;
    case CE_ACCENT: case CE_TAKE_ACCENT: return a->acc_n != b->acc_n;
    case CE_TIE: return a->len_sum != b->len_sum;
    case CE_DRONE: return a->notes_sum != b->notes_sum || a->msg_sum != b->msg_sum;   /* (an empty row: NOTHING TO DRONE) */
    case CE_STEP_RECORD: return a->sr_on && !b->sr_on;
    case CE_STEP_RECORD_AT: return a->sr_on && !b->sr_on && a->sr_k == (uint32_t)CT_STEP;
    case CE_VELOCITY: return same_notes && a->vel_sum != b->vel_sum;
    case CE_CHANCE: return same_notes && a->chance_sum != b->chance_sum;
    case CE_PITCH: return same_notes && a->pitch_sum != b->pitch_sum;
    case CE_LOCK_PAGE: return a->lpg != b->lpg;
    case CE_LOCK: return a->locks != b->locks;
    case CE_SONG_PAGE: return a->page == PAGE_SONG && b->page != PAGE_SONG;
    case CE_CLEAR: return a->notes_n == 0 && b->notes_n > 0;
    case CE_STEPS_PAGE: return a->seq_pg != b->seq_pg;
    case CE_WRITE: return a->notes_n > b->notes_n && a->sr_k != b->sr_k;   /* (on an empty track) */
    case CE_CHORD: return a->notes_n >= b->notes_n + 2 && a->sr_k != b->sr_k;
    case CE_REST: case CE_CURSOR: return a->sr_k != b->sr_k && same_notes;
    case CE_BACK_CLEAR: return a->sr_k != b->sr_k && a->notes_n <= b->notes_n;
    case CE_LIVE: return a->run && !b->run;
    case CE_END: return b->sr_on && !a->sr_on;
    case CE_TAKE: return a->notes_sum != b->notes_sum;
    case CE_ENTRY: return a->song_cur != b->song_cur;
    case CE_ENTRY_PATTERN: case CE_TRANSPOSE: return a->song_len == b->song_len && a->song_sum != b->song_sum;
    case CE_ADD_ENTRY: case CE_DUP_ENTRY: return a->song_len == b->song_len + 1u;
    case CE_SONG_PLAY: return a->song != b->song;
    case CE_SONG: return a->song_sel != b->song_sel;
    case CE_DELETE_ENTRY: return a->song_len + 1u == b->song_len;
    case CE_BACK_STEPS: return b->page == PAGE_SONG && a->page == PAGE_SEQ;
    case CE_TAB: return a->menu_tab != b->menu_tab;
    case CE_SCROLL: return a->man_top != b->man_top;
    case CE_SET: return a->cfg_sum != b->cfg_sum;
    case CE_SAVE_CLOSE: return a->saved != b->saved && a->page != PAGE_MENU;
    case CE_RUN_ROW: return a->updates != b->updates;
    case CE_EDITOR: {                                   /* sandbox mode: out as MIDI to the editor, nothing here moved (D-232) */
        int i, cc = 0;
        for (i = b->mlen; i < a->mlen; i++)
            cc |= mlog[i][0] == 0xB0u;
        return cc && !moved && a->params == b->params && a->run == b->run && a->saved == b->saved;
    }
    default: return 0;
    }
}

/* ---- the fixtures */

/* the device with an assembly's presets and keys, else the first with any */
static void ct_focus_assembly(void)
{
    uint32_t d;
    pages_ensure();
    for (d = 0; d < pg_ndev; d++)
        if (pg_dev[d].structure && dp_list(d) > 0u && m64(env_listeners(d))) {
            pages_focus(d, 0);
            return;
        }
    for (d = 0; d < pg_ndev; d++)
        if (pg_dev[d].structure) {
            pages_focus(d, 0);
            return;
        }
}
static void ct_reset(void)
{
    uint32_t i;
    while (help_on)
        tap(BTN_HOME);
    if (sr_on)
        sr_stop();
    if (eng_transport_running() || eng_once_state())
        tap(BTN_PLAY);
    if (seq_rec)
        seq_rec_off();
    sandbox_set(0);
    panel_held = 0;
    panel_keys(0);
    for (i = 0; i < 2u; i++)
        loop();
    page = 0;
    trail_n = 0;
    octave = 0;
    menu_tab = 0;
    menu_armed = MR_COUNT;
    man_top = 0;
    mlen = 0;
    cfg.midi_out = 1;
    cfg.count_in = 0;
    pg_list_btn = -1;
    song_sel = 0;
    song_cur = 0;
    ui_full = 1;
    later(3000);
}
static int ct_load(const char *name)
{
    ct_reset();
    if (load(name))
        return -1;
    pv_gen++;
    page_show(0);
    screen_patch();
    pages_ensure();
    pages_focus(pages_home(), 0);
    later(2000);
    return 0;
}
/* the SEQ page of track t (a step of it on, in the selected row, under the white key CT_STEP: a held step has a note;
 * longer: 32 steps; empty: no notes, for step record and a live take) */
static void ct_seq(uint32_t t, int longer, int empty)
{
    int mod, map;
    uint32_t note;
    ct_focus_assembly();
    seq_select(t);
    mod = seq_module();
    if (longer && mod >= 0)
        eng_set_param((uint32_t)mod, STEPS_P_LEN, 32 << 16);
    page_set(PAGE_SEQ);
    later(1500);
    mod = seq_module();
    map = seq_map();
    if (mod >= 0 && empty) {
        static const uint32_t none[1];
        (void)eng_steps_set_notes((uint32_t)mod, none, 0);
        seq_sync(mod);
    } else if (mod >= 0) {
        if (map < 0)
            seq_roll_aim(mod);
        note = seq_grid_note(map, seq_row);
        if (!eng_steps_note((uint32_t)mod, (uint32_t)CT_STEP, note))
            eng_steps_toggle((uint32_t)mod, (uint32_t)CT_STEP, note, STEP_VEL);
        seq_sync(mod);
    }
    later(200);
}
/* a Page button: LFO on the 808 Kit (as the Page buttons' test above), its list on */
static int ct_page_button(void)
{
    static const uint8_t sec[] = {0, 0, 0, 3, 0, 0, 0, 2, 2, 0, 2, 1};
    uint32_t at, n, end;
    if (ct_load("808 KIT"))
        return 0;
    at = end = pv_len;
    if (pv_bin[6] & 2u)
        for (n = 1; n < 256u; n++)
            if (pv_len >= 1u + n * 5u && pv_bin[pv_len - 1u - n * 5u] == n) {
                at = end = pv_len - 1u - n * 5u;
                break;
            }
    if (pv_bin[6] & 128u)
        for (n = 1; n < 16u; n++)
            if (end >= 1u + n * 65u && pv_bin[end - 1u - n * 65u] == n) {
                at = end - 1u - n * 65u;
                break;
            }
    memmove(pv_bin + at + sizeof sec, pv_bin + at, pv_len - at);
    memcpy(pv_bin + at, sec, sizeof sec);
    pv_len += sizeof sec;
    pv_bin[6] |= 64u;
    pv_gen++;
    if (eng_load(pv_bin, pv_len))
        return 0;
    page_show(0);
    trail_n = 0;
    pages_focus(4, 0);                                  /* (the Output: not on the list, so HOME's way back shows) */
    ct_pre_dev = pg_cur_dev;
    ct_pre_pg = pg_cur_page;
    loop();
    tap(5);
    later(1500);
    return pg_list_btn >= 0;
}
/* sandbox mode with a page from the editor (rows 1..3) */
static void ct_sandbox(void)
{
    static uint8_t d[SB_BYTES + SB_EXT_BYTES];
    sb_page_t pg;
    uint32_t k;
    m1_live(1);
    loop();
    memset(d, 0, sizeof d);
    d[0] = 7;
    d[1] = 2;
    d[2] = 5;
    memcpy(d + 3, "SOL 29N XL", 10);
    memcpy(d + 3 + SB_PATCH, "Sol filter", 10);
    memcpy(d + 3 + SB_PATCH + SB_DEV, "FILTER 1/2", 10);
    for (k = 0; k < 3u; k++) {
        uint8_t *r = d + SB_HEAD_BYTES + k * SB_ROW_BYTES;
        memcpy(r, "Row", 3);
        memcpy(r + SB_LABEL, "2.40", 4);
        r[SB_LABEL + SB_VALUE + SB_UNIT] = 128u;
    }
    if (sb_parse(d, SB_BYTES, &pg) == 0)
        m1_sandbox(&pg);
    later(500);
}
/* the FM-1 in state s, variant v (0..): 0 when there is no such variant */
static int ct_enter(uint32_t s, uint32_t v)
{
    switch (s) {
    case HS_DEVICE:
        if (v == 0) {                                   /* ORACLE V: an assembly with presets and keys, its second page */
            if (ct_load("ORACLE V"))
                return 0;
            ct_focus_assembly();
            pages_page(1);
            later(500);
            return 1;
        }
        if (v == 1)
            return ct_page_button();
        if (v == 2) {                                   /* tracks: <7PH */
            if (ct_load("<7PH"))
                return 0;
            ct_focus_assembly();
            pages_page(1);
            later(500);
            return 1;
        }
        return 0;
    case HS_ENV:
        if (v > 1 || ct_load(v ? "<7PH" : "ORACLE V"))
            return 0;
        ct_focus_assembly();
        tap(BTN_ENV);
        later(500);
        return page == PAGE_ENV;
    case HS_DRUM:                                       /* the 808 Kit's DRUMS, 16 and 32 steps; <7PH's drums (two tracks) */
        if (v > 2 || ct_load(v == 2 ? "<7PH" : "808 KIT"))
            return 0;
        ct_seq(0, v == 1, 0);
        return 1;
    case HS_ROLL:
        if (v > 1 || ct_load("<7PH"))
            return 0;
        ct_seq(1, (int)v, 0);
        return 1;
    case HS_LIVE:
        if (v > 0 || ct_load("<7PH"))
            return 0;
        ct_seq(1, 0, 1);
        tap(BTN_PLAY);
        tap(BTN_REC);
        blocks(40);                                     /* (the take under way, as the live take's test above) */
        later(100);
        return seq_kbd();
    case HS_SONG:
        if (v > 0 || ct_load("<7PH"))
            return 0;
        ct_seq(1, 0, 0);
        (void)eng_song_put(0, 0, 0, 0);                 /* (an entry to edit) */
        (void)eng_song_put(0, 1, 1, 0);
        tap(BTN_SEL);
        song_cur = 0;
        later(500);
        return page == PAGE_SONG;
    case HS_MENU:
        if (v > 4 || ct_load("<7PH"))
            return 0;
        ct_focus_assembly();
        tap(BTN_GLO);
        menu_tab = (uint8_t)(v == 2 ? MT_SYSTEM : v == 4 ? MT_GUIDE : v == 3 ? MT_INFO : v);
        ui_dirty = 2;
        later(300);
        if (v == 2)
            enc(2, 1);                                  /* (SYSTEM: UPDATE MODE armed for GLO's hold) */
        return page == PAGE_MENU;
    case HS_SANDBOX:                                    /* (v 1: begun in the menu, a step on the trail: D-243's HOME) */
        if (v > 1 || ct_load("<7PH"))
            return 0;
        if (v)
            tap(BTN_GLO);
        ct_sandbox();
        return sb_on;
    case HS_STEP:
        if (v > 1 || ct_load(v ? "808 KIT" : "<7PH"))
            return 0;
        ct_seq(v ? 0u : 1u, 0, 1);
        tap(BTN_REC);
        later(100);
        return sr_on;
    }
    return 0;
}

/* ---- the gestures */

static uint32_t ct_white(int step)
{
    uint32_t n;
    for (n = 0; n < 27u && seq_white(n) != step; n++)
        ;
    return n;
}
static uint32_t ct_black(int b)
{
    uint32_t n;
    for (n = 0; n < 27u && seq_black(n) != b; n++)
        ;
    return n;
}
static void ct_down(uint32_t id) { panel_held |= 1u << id; panel_edges(1u << id, 0); loop(); }
static void ct_up(uint32_t id) { panel_held &= ~(1u << id); panel_edges(0, 1u << id); loop(); }
static uint32_t ct_keys;
static void ct_key(uint32_t n, int down)
{
    ct_keys = down ? ct_keys | 1u << n : ct_keys & ~(1u << n);
    panel_keys(ct_keys);
    loop();
    if (eng_transport_running())
        blocks(10);                                     /* (a live take: the engine records) */
    loop();
}
/* part p of the row's gesture (dir: an encoder's or knob's click) */
static void ct_part(const ctl_part_t *p, uint32_t how, int dir, uint32_t hold)
{
    uint32_t k;
    switch (p->kind) {
    case CK_BUTTON:
        if (how == CW_HOLD2S) {
            ct_down(p->id);
            later(2100);
            ct_up(p->id);
        } else if (how == CW_HELD) {                    /* FX held while a key plays */
            ct_down(p->id);
            ct_key(ct_white(CT_STEP), 1);
            ct_key(ct_white(CT_STEP), 0);
            ct_up(p->id);
        } else
            tap(p->id);
        break;
    case CK_ENCODER:
        enc(p->id, dir);
        break;
    case CK_KNOBS:
        for (k = 0; k < 4u && !(p->id >> k & 1u); k++)
            ;
        enc(2u + k, dir);
        break;
    case CK_WHITE:
        ct_key(ct_white(CT_STEP), 1);
        ct_key(ct_white(CT_STEP), 0);
        break;
    case CK_BLACK:                                      /* (REC / SEQ held: track 1; else a second row; b:N black key N) */
        k = p->n ? ct_black(p->n - 1) : ct_black(hold == 13u || hold == 11u ? 0 : 1);
        ct_key(k, 1);
        ct_key(k, 0);
        break;
    case CK_ANY:
        ct_key(26, 1);                                  /* (the top key: a pitch out of the view) */
        ct_key(26, 0);
        break;
    case CK_KEYS:
        ct_key(ct_white(CT_STEP), 1);
        ct_key(ct_white(CT_STEP), 0);
        break;
    case CK_CHORD:
        ct_key(ct_white(CT_STEP), 1);
        ct_key(ct_white(CT_STEP + 2), 1);
        ct_key(ct_white(CT_STEP), 0);
        ct_key(ct_white(CT_STEP + 2), 0);
        break;
    }
}
/* the row's gesture, alternative alt. What some effects need besides the row's own words: a lock's rows are a lock
 * page's, which ALGO picks first with the step held (#524); a clear and a delete ask first, REC again does it (#231) */
static void ct_drive(const ctl_row_t *r, uint32_t alt, int dir)
{
    if (r->first != CH_NONE) {                          /* (ENV then SEL: ENV tapped first, on the page it opens) */
        tap(r->first);
        later(500);
    }
    if (r->at_end)                                      /* (on END: the SONG page's cursor past the last entry) */
        song_cur = (uint8_t)eng_song_len(song_sel);
    if (r->hold == CH_STEP) {
        uint32_t n = ct_white(CT_STEP);
        ct_key(n, 1);
        if (r->effect == CE_LOCK)
            enc(1, 1);
        ct_part(&r->alt[alt], r->how, dir, r->hold);
        ct_key(n, 0);
    } else if (r->hold != CH_NONE) {
        ct_down(r->hold);
        ct_part(&r->alt[alt], r->how, dir, r->hold);
        if (r->effect == CE_CLEAR || r->effect == CE_DELETE_ENTRY)
            ct_part(&r->alt[alt], r->how, dir, r->hold);
        ct_up(r->hold);
    } else
        ct_part(&r->alt[alt], r->how, dir, r->hold);
    later(50);
}

/* the sheet of state s's tab t lists row i now */
static int ct_listed(uint32_t i, uint32_t t)
{
    const char *r[HC_ROWS];
    uint32_t n = help_rows(t, r), k;
    for (k = 0; k < n; k++)
        if (help_line[k] != CTL_PATCH && CTL_LINE[help_line[k]].row == i)
            return 1;
    return 0;
}

/* row i, which the sheet leaves out (controls.ts `listed: false`), works now: its line's condition holds */
static int ct_applies(uint32_t i)
{
    uint32_t l;
    for (l = 0; l < sizeof CTL_LINE / sizeof CTL_LINE[0]; l++)
        if (CTL_LINE[l].row == i)
            return !CTL_LINE[l].cond || !HC_FN[CTL_LINE[l].cond]() != !CTL_LINE[l].neg;
    return 0;
}

/* a text on the screen (SCREEN keeps the first SCR_CH characters of each) */
static int ct_shows(const char *t)
{
    char b[SCR_CH + 1u];
    strncpy(b, t, SCR_CH);
    b[SCR_CH] = 0;
    return on_screen(b);
}

static void controls_suite(void)
{
    uint32_t i, s, t, v, alt, rows = 0, runs = 0, bad = 0;
    for (i = 0; i < CTL_NROWS; i++) {
        const ctl_row_t *r = &CTL_ROW[i];
        for (s = 0; s < HS_COUNT; s++)
            for (t = 0; t < 2u; t++) {
                const uint8_t *l;
                int placed = 0, unlisted = 0;
                for (l = CTL_SHEET[t][s]; *l != CTL_END; l++)
                    placed |= CTL_LINE[*l].row == i;
                for (l = CTL_UNLISTED[t][s]; *l != CTL_END; l++)
                    unlisted |= CTL_LINE[*l].row == i;
                if (!placed && !unlisted)
                    continue;
                for (alt = 0; alt < r->nalt; alt++) {
                    int shown = 0, ok = 0, dir;
                    for (v = 0; !ok && ct_enter(s, v); v++) {
                        if (help_state() != s || !(placed ? ct_listed(i, t) : ct_applies(i)))
                            continue;
                        shown = 1;
                        for (dir = 1; !ok && dir >= -1; dir -= 2) {
                            ct_snap_t b, a;
                            if (dir < 0 && (!ct_enter(s, v) || help_state() != s))
                                break;
                            if (dir < 0 && r->nalt == 2u)   /* (the other way: OCT+ first, then OCT- has a page to go back to) */
                                ct_drive(r, alt ^ 1u, 1);
                            ct_mod = seq_module();
                            msg_text[0] = 0;
                            ct_take(&b);
                            ct_drive(r, alt, dir);
                            ct_take(&a);
                            ok = ct_effect(r->effect, &b, &a);
                            runs++;
                            if (getenv("CT_DEBUG") && !strcmp(getenv("CT_DEBUG"), r->id))   /* CT_DEBUG=<row id>: each run */
                                printf("      [%s v%u dir %d] page %u>%u dev %u>%u pg %u>%u sr %u/%u>%u/%u notes %d>%d acc %u>%u len %u>%u run %u>%u rec %u>%u"
                                       " mlen %d>%d trk %u>%u params %08x>%08x lbtn %d>%d song %u>%u del %u>%u msg '%s' ok %d\n", r->id, (unsigned)v, dir,
                                       b.page, a.page, b.dev, a.dev, b.devpage, a.devpage, b.sr_on, b.sr_k, a.sr_on, a.sr_k, b.notes_n, a.notes_n,
                                       b.acc_n, a.acc_n, b.len_sum, a.len_sum, b.run, a.run, b.rec, a.rec, b.mlen, a.mlen, b.trk, a.trk, b.params,
                                       a.params, b.list_btn, a.list_btn, b.song_len, a.song_len, b.del_at, a.del_at, msg_text, ok);
                        }
                    }
                    if (!shown || !ok) {
                        char what[96];
                        snprintf(what, sizeof what, "controls: %s (alternative %u) in %s%s: %s", r->id, (unsigned)alt + 1u, HS_NAME[s],
                                 t ? " (EVERYWHERE)" : "", shown ? "does not do what its row says" : "never shown in a fixture");
                        check(what, 0);
                        bad++;
                    }
                }
                rows++;
            }
    }
    printf("      (controls: %u rows in their states, %u gestures driven, %u wrong)\n", (unsigned)rows, (unsigned)runs, (unsigned)bad);
    /* the hint lines come from the table too: the menu's three (one wording, #553) and the SONG page's */
    check("the menu's hint line from the table: a settings tab, INFO, GUIDE", ct_enter(HS_MENU, 0) && ct_shows(HINT_MENU_PAGE)
          && ct_enter(HS_MENU, 3) && ct_shows(HINT_MENU_INFO) && ct_enter(HS_MENU, 4) && ct_shows(HINT_MENU_GUIDE));
    {                                                   /* {list}: the Page button whose list shows, as the top bar names it */
        const char *r[HC_ROWS];
        uint32_t n = ct_enter(HS_DEVICE, 1) ? help_rows(0, r) : 0u, k, home = 0, algo = 0;
        for (k = 0; k < n; k++) {
            home |= !strcmp(r[k], "k:HOME~leave LFO's pages");
            algo |= !strcmp(r[k], "n:ALGO~LFO's pages");
        }
        check("a Page button's list: the sheet's HOME and ALGO rows name it (leave LFO's pages, LFO's pages)", home && algo);
        if (n && m1_panel()) {                          /* the patch's label for it, as the top bar; one too wide: the name */
            uint8_t *lab = (uint8_t *)m1_panel() + 4u + 3u * ENG_PANEL_LABEL;
            uint8_t was[ENG_PANEL_LABEL];
            memcpy(was, lab, sizeof was);
            memset(lab, 0, ENG_PANEL_LABEL);
            memcpy(lab, "MOD", 3);
            n = help_rows(0, r);
            for (k = 0, home = 0; k < n; k++)
                home |= !strcmp(r[k], "k:HOME~leave MOD's pages");
            memcpy(lab, "WWWWWWWWWW", ENG_PANEL_LABEL);
            n = help_rows(0, r);
            for (k = 0, algo = 0; k < n; k++)
                algo |= !strcmp(r[k], "k:HOME~leave LFO's pages");
            memcpy(lab, was, sizeof was);
            check("  the patch's label for it (MOD); a label too wide for the line: the button's name", home && algo);
        }
        if (n) {                                        /* the trail emptied under the list (a full trail): HOME still leaves it */
            trail_n = 0;
            tap(BTN_HOME);
            check("  HOME with the trail empty: the list closes", pg_list_btn < 0);
        }
    }
    check("the SONG page's two hint lines from the table", ct_enter(HS_SONG, 0) && ct_shows(HINT_SONG_1) && ct_shows(HINT_SONG_2));
    check("every row of the controls table does what it says in each state it works in (web/src/controls.ts)", bad == 0u);
    ct_reset();
}
