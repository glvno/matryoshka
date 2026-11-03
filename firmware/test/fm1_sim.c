/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The FM-1 on the host for onboarding tests (tools/fm1_sim/): the panel, the screen and the engine of the firmware, as
 * panel_test.c builds them, driven by a list of actions from power-on. Each run replays the whole list, so a session is
 * the list alone (nothing kept between runs) and a run can be repeated exactly.
 *   fm1_sim ACTIONS OUT.ppm STATE.json [HEARD.txt [SETTLED.ppm]]
 * ACTIONS: one per line
 *   press NAME        a button tapped (OCT- OCT+ FX SEL ENV LFO EDIT GLO HOME SAVE ARP SEQ PLAY REC)
 *   down NAME / up NAME   a button held / let go
 *   turn KNOB N       a knob turned N clicks (SELECT ALGO K1 K2 K3 K4 PRESET; + clockwise)
 *   keydown K / keyup K   a key (1..27, left to right, F3 up at octave 0) held / let go
 *   wait MS           time passing (the engine runs)
 *   listen MS         as wait, and what is heard goes to HEARD.txt
 * OUT.ppm is the LCD after the last action; STATE.json what the grader reads (never shown to the player). */
#include <math.h>
#define UI_PREVIEW_LIB
#include "ui_preview.c"

static volatile uint32_t eng_shed_count;
static void m1_focus_now(uint32_t d, uint32_t g) { (void)d; (void)g; }
static void m1_param_now(uint32_t mod, uint32_t par, int32_t v) { (void)mod; (void)par; (void)v; }
static void m1_patch_param(uint32_t mod, uint32_t par, int32_t v) { (void)mod; (void)par; (void)v; }
static void m1_panel_on(uint32_t mask) { (void)mask; }
static void m1_patch_bypass(uint32_t mod, int on) { (void)mod; (void)on; }
#include "../src/panel.c"
static void leds_play(void) {}
static void leds_panel(void) {}
static void midi_send(uint32_t status, uint32_t d1, uint32_t d2) { (void)status; (void)d1; (void)d2; }
static void midi_send_rt(uint32_t b) { (void)b; }
static void m1_info(void) {}
#include "../src/live.c"
static int load_at(uint32_t p);
static void preset_step(int32_t d)
{
    uint32_t n;
    if (live_holds_preset())
        return;
    n = (uint32_t)(((int32_t)cur_preset + d % (int32_t)N_PRESETS + (int32_t)N_PRESETS) % (int32_t)N_PRESETS);
    (void)load_at(n);
    cur_preset = n;
    pv_gen++;
    screen_patch();
}
static int saves;
static void save_state(void)                        /* main.c's, without the flash: its messages */
{
    saves++;
    ui_msg("SAVED", 1500);
}
static void settings_store(void) {}
#include "../src/poly_edit.h"
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v)
{
    return poly_patch_set(pv_bin, pv_len, mod, field, v, eng_load);
}

static int load_at(uint32_t p)
{
    if (p >= N_PRESETS)
        return -1;
    memcpy(pv_bin, PRESET_LIST[p].data, PRESET_LIST[p].len);
    pv_len = PRESET_LIST[p].len;
    if (eng_load(pv_bin, pv_len))
        return -1;
    patch_label = PRESET_LIST[p].name;
    return 0;
}

/* one turn of the main loop (as fm1_main) */
static void loop(void)
{
    panel_status();
    panel_edges(0, 0);
    seq_poll();
    panel_draw();
}

/* what is heard: the notes the tracks start, in order, and whether the output sounds */
static FILE *heard;
static int listening;
static int last_pos[16];
static uint32_t heard_n;
static void hear_tracks(void)
{
    int t, n = eng_steps_count();
    for (t = 0; t < n && t < 16; t++) {
        int mod = eng_steps_module((uint32_t)t), pos, i, nn;
        const uint32_t *w;
        if (mod < 0)
            continue;
        pos = eng_steps_pos((uint32_t)mod);
        if (pos == last_pos[t])
            continue;
        last_pos[t] = pos;
        if (!listening || !eng_transport_running() || pos < 0)
            continue;
        nn = eng_steps_notes((uint32_t)mod, &w);
        for (i = 0; i < nn; i++)
            if ((int)(w[i] & 63u) == pos) {
                static const char *const NM[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
                uint32_t p = (w[i] >> 12) & 127u;
                if (heard && heard_n < 512u)
                    fprintf(heard, "%s%s%d", heard_n++ ? " " : "", NM[p % 12u], (int)p / 12 - 1);
            }
    }
}
static double out_peak, out_energy;
static void run_ms(uint32_t ms)
{
    static int32_t l[128], r[128];
    uint32_t blocks = ms * 48u / 128u, i, j;
    for (i = 0; i < blocks; i++) {
        eng_render(l, r, 128);
        for (j = 0; j < 128u; j++) {
            double a = fabs((double)l[j]) + fabs((double)r[j]);
            if (listening && a > out_peak)
                out_peak = a;
            if (listening)
                out_energy += a * a;
        }
        hear_tracks();
        if (i % 4u == 3u) {
            fm1_ms += 10u;
            loop();
        }
    }
    fm1_ms += 1u;
    loop();
}

/* a listen of ms: *whole its peak; how many separate sounds a person hears, read from the state (a sound made of the
 * output alone cannot be split by device): while it sounds, each armed device is one (an instrument and the track that
 * feeds it count once), and with none armed the keys' cables make one */
static uint32_t count_sounds(uint32_t ms, double *whole)
{
    uint32_t d, n = 0;
    listening = 1;
    out_peak = out_energy = 0;
    run_ms(ms);
    *whole = out_peak;
    if (out_peak <= 1000.0)
        return 0;
    pages_ensure();
    for (d = 0; d < pg_ndev; d++) {                     /* an armed instrument whose own track is armed too is that one sound */
        uint32_t tr = pg_dev[d].track;
        if (!env_listeners(d) || !env_armed(d))
            continue;
        n += !(tr < pg_ndev && tr != d && env_armed(tr));
    }
    return n ? n : 1u;
}

static const char *const BTN_NAMES[14] = {"OCT-", "OCT+", "FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"};
static int btn_id(const char *s)
{
    int i;
    for (i = 0; i < 14; i++)
        if (!strcmp(s, BTN_NAMES[i]))
            return i;
    return -1;
}
static const char *const KNOB_NAMES[7] = {"SELECT", "ALGO", "K1", "K2", "K3", "K4", "PRESET"};
static int knob_id(const char *s)
{
    int i;
    for (i = 0; i < 7; i++)
        if (!strcmp(s, KNOB_NAMES[i]))
            return i;
    return -1;
}
static uint32_t keys_held;

static void btn(int id, int down)
{
    if (down) {
        panel_held |= 1u << id;
        panel_edges(1u << id, 0);
    } else {
        panel_held &= ~(1u << id);
        panel_edges(0, 1u << id);
    }
    loop();
}

/* device d's preset now, by name ("" none or no presets) */
static const char *dev_preset(uint32_t d)
{
    static char nm[17];
    uint32_t n = dp_list(d);
    int c = n ? dp_current(d, n) : -1;
    nm[0] = 0;
    if (c >= 0 && dp_entry(pr_list[c], nm) < 0)
        nm[0] = 0;
    return nm;
}

static void write_ppm(const char *path)
{
    FILE *o = fopen(path, "wb");
    uint32_t i;
    if (!o)
        return;
    fprintf(o, "P6\n240 240\n255\n");
    for (i = 0; i < 240u * 240u; i++) {
        uint16_t c = fb[i];
        fputc((c >> 11 & 31) * 255 / 31, o);
        fputc((c >> 5 & 63) * 255 / 63, o);
        fputc((c & 31) * 255 / 31, o);
    }
    fclose(o);
}

static void json_str(FILE *f, const char *s)
{
    fputc('"', f);
    for (; s && *s; s++)
        if (*s == '"' || *s == '\\')
            fprintf(f, "\\%c", *s);
        else if ((unsigned char)*s >= 32u)
            fputc(*s, f);
    fputc('"', f);
}

static void write_state(const char *path, int ok_lines, int bad_line)
{
    FILE *f = fopen(path, "w");
    uint32_t d;
    int t, i;
    if (!f)
        return;
    pages_ensure();
    fprintf(f, "{\n  \"actions_applied\": %d,\n  \"bad_action_line\": %d,\n  \"patch_slot\": %u,\n  \"patch\": ", ok_lines, bad_line, (unsigned)cur_preset + 1u);
    json_str(f, patch_label);
    fprintf(f, ",\n  \"page\": %u,\n  \"card\": %u,\n  \"menu_tab\": %u,\n  \"octave\": %d,\n", (unsigned)page, (unsigned)help_on, (unsigned)menu_tab, (int)octave);
    {
        int panel = eng_find(T_FM1);
        fprintf(f, "  \"tempo\": %d,\n", panel >= 0 ? (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16 : -1);
    }
    fprintf(f, "  \"tempo_global\": %u,\n  \"transport_running\": %d,\n  \"pattern\": %d,\n  \"saves\": %d,\n", (unsigned)eng_tempo_global_get(), eng_transport_running(), eng_pattern() + 1, saves);
    fprintf(f, "  \"focus_device\": ");
    if (pg_cur_dev < pg_ndev)
        fprintf(f, "%u", (unsigned)pg_cur_dev);
    else
        fprintf(f, "null");
    fprintf(f, ",\n  \"devices\": [");
    for (d = 0; d < pg_ndev; d++) {
        char nm[40];
        uint32_t k;
        for (k = 0; k < pg_dev[d].nlen && k < sizeof nm - 1u; k++)
            nm[k] = pg_dev[d].name[k];
        nm[k] = 0;
        fprintf(f, "%s\n    {\"name\": ", d ? "," : "");
        json_str(f, nm);
        fprintf(f, ", \"fed_by\": %d", pg_dev[d].track < pg_ndev && pg_dev[d].track != d ? (int)pg_dev[d].track : -1);
        fprintf(f, ", \"type\": %d, \"key_source\": %d, \"armed\": %d, \"preset\": ", pg_dev[d].module >= 0 ? eng_type((uint32_t)pg_dev[d].module) : -1,
                pg_dev[d].module >= 0 && (eng_type((uint32_t)pg_dev[d].module) == T_STEPS || eng_type((uint32_t)pg_dev[d].module) == T_ARP), env_armed(d));
        json_str(f, dev_preset(d));
        fputc('}', f);
    }
    fprintf(f, "\n  ],\n  \"tracks\": [");
    for (t = 0; t < eng_steps_count(); t++) {
        int mod = eng_steps_module((uint32_t)t), nn;
        const uint32_t *w;
        if (mod < 0)
            continue;
        nn = eng_steps_notes((uint32_t)mod, &w);
        fprintf(f, "%s\n    {\"module\": %d, \"length\": %d, \"notes\": [", t ? "," : "", mod, seq_len(mod));
        for (i = 0; i < nn; i++)
            fprintf(f, "%s[%u, %u, %u]", i ? ", " : "", (unsigned)(w[i] & 63u), (unsigned)((w[i] >> 6) & 63u), (unsigned)((w[i] >> 12) & 127u));
        fprintf(f, "]}");
    }
    fprintf(f, "\n  ]\n}\n");
    fclose(f);
}

int main(int argc, char **argv)
{
    FILE *a;
    char line[160];
    int n_ok = 0, bad = 0, lineno = 0;
    if (argc < 4) {
        fprintf(stderr, "usage: fm1_sim ACTIONS OUT.ppm STATE.json [HEARD.txt]\n");
        return 2;
    }
    if (argc > 4)
        heard = fopen(argv[4], "w");
    /* power-on, as main.c: the bank's first patch, the quick start over its first page (D-247) */
    if (load_at(0))
        return 1;
    cur_preset = 0;
    gt_apply();                                         /* TEMPO: GLOBAL at the boot patch's tempo (main.c, D-907) */
    booting = 0;                                        /* the splash over (main.c): the pages draw */
    help_open(HELP_QUICK);
    screen_idle();
    loop();
    {                                                   /* the page must be drawn under the card (a dim frame round it) */
        uint32_t i, lit = 0;
        for (i = 0; i < 240u * 16u; i++)
            lit += fb[i] != 0;
        if (!lit) {
            fprintf(stderr, "fm1_sim: nothing drawn at power-on\n");
            return 1;
        }
    }
    a = fopen(argv[1], "r");
    while (a && fgets(line, sizeof line, a)) {
        char verb[16] = "", arg[32] = "";
        long num = 0;
        int k, got;
        lineno++;
        got = sscanf(line, "%15s %31s %ld", verb, arg, &num);
        if (got < 1 || verb[0] == '#')
            continue;
        if (!strcmp(verb, "press") && (k = btn_id(arg)) >= 0) {
            btn(k, 1);
            fm1_ms += 60u;
            btn(k, 0);
        } else if (!strcmp(verb, "down") && (k = btn_id(arg)) >= 0) {
            btn(k, 1);
        } else if (!strcmp(verb, "up") && (k = btn_id(arg)) >= 0) {
            btn(k, 0);
        } else if (!strcmp(verb, "turn") && (k = knob_id(arg)) >= 0 && got == 3 && num != 0) {
            int32_t st[7] = {0};
            long s = num > 0 ? 1 : -1, i;
            for (i = 0; i != num; i += s) {             /* one click a turn, 120 ms apart: no acceleration */
                memset(st, 0, sizeof st);
                st[k] = (int32_t)s;
                fm1_ms += 120u;
                panel_encoders(st);
                loop();
            }
        } else if ((!strcmp(verb, "keydown") || !strcmp(verb, "keyup")) && (k = atoi(arg)) >= 1 && k <= 27) {
            int down = verb[3] == 'd';
            if (down)
                keys_held |= 1u << (k - 1);
            else
                keys_held &= ~(1u << (k - 1));
            (void)panel_key((uint32_t)k - 1u, down, 0);
            loop();
        } else if ((!strcmp(verb, "wait") || !strcmp(verb, "listen")) && (k = atoi(arg)) > 0 && k <= 60000) {
            heard_n = 0;
            if (verb[0] == 'l') {
                double whole = 0;
                uint32_t sounds;
                if (heard)
                    fprintf(heard, "notes: ");
                fflush(heard);
                sounds = count_sounds((uint32_t)k, &whole);
                if (heard)
                    fprintf(heard, "%s\npeak: %.0f\nsounds: %u\n", heard_n ? "" : "(none)", whole, (unsigned)sounds);
            } else {
                listening = 0;
                run_ms((uint32_t)k);
            }
            listening = 0;
        } else {
            bad = lineno;
            break;
        }
        n_ok++;
        fm1_ms += 30u;
        loop();
    }
    if (a)
        fclose(a);
    run_ms(20);
    write_ppm(argv[2]);
    write_state(argv[3], n_ok, bad);
    if (argc > 5) {                                     /* the screen settled: messages and banners gone, nothing touched
                                                         * (only shown: the session's own time does not move on) */
        static uint16_t was[240 * 240];
        uint32_t t, still = 0;
        FILE *h = heard;
        heard = 0;
        for (t = 0; t < 6000u && still < 300u; t += 100u) {
            memcpy(was, fb, sizeof fb);
            run_ms(100);
            still = (!msg_until || fm1_ms >= msg_until) && (!toast_until || fm1_ms >= toast_until) && !memcmp(was, fb, sizeof fb)
                  ? still + 100u : 0u;                  /* (the top bar's message, a toast such as the patch's banner) */
        }
        heard = h;
        write_ppm(argv[5]);
    }
    if (heard)
        fclose(heard);
    return bad ? 3 : 0;
}
