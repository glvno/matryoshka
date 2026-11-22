/* SPDX-License-Identifier: GPL-3.0-only */
/* Run only the #833 preset selection slice against the actual panel implementation. */
#include <stdint.h>
#define HOST_DEFAULT_PATTERN_IMPL
int host_preset_name(uint8_t *, uint32_t *, uint32_t, const char *);
int host_default_pattern(uint8_t *, uint32_t *, uint32_t, uint32_t, const uint32_t *, uint32_t, uint32_t);
#define main unused_panel_main
#include "panel_test.c"
#undef main
#include "pattern_cases.h"

/* factory patch i running, the 808 and 909 Kits with their demo sets loaded as the editor loads them (pattern_cases.h
 * DEMO_CASES; #1179: they ship without pattern 1's notes and origin) */
static int load_kit(uint32_t i)
{
    const char *demo = !strcmp(PRESET_LIST[i].name, "808 KIT") ? "808 Kit" : !strcmp(PRESET_LIST[i].name, "909 KIT") ? "909 Kit" : 0;
    static int32_t l[128], r[128];
    uint32_t k;
    if (!demo)
        return load_at(i);
    for (k = 0; k < N_DEMO_CASES && strcmp(DEMO_CASES[k].name, demo); k++)
        ;
    if (k == N_DEMO_CASES || !DEMO_CASES[k].loaded || DEMO_CASES[k].loaded_len > sizeof pv_bin)
        return -1;
    memcpy(pv_bin, DEMO_CASES[k].loaded, DEMO_CASES[k].loaded_len);
    pv_len = DEMO_CASES[k].loaded_len;
    if (eng_load(pv_bin, pv_len))
        return -1;
    m1_pat_load();
    patch_label = PRESET_LIST[i].name;
    eng_render(l, r, 128);
    return 0;
}

/* Expose only binary walkers to the separately compiled real protocol writer. */
uint32_t host_eng_rec_head(uint32_t ver) { return eng_rec_head(ver); }
uint32_t host_eng_rec_npar(const uint8_t *p, uint32_t at) { return eng_rec_npar(p, at); }
uint32_t host_eng_rec_block(const uint8_t *p, uint32_t at) { return eng_rec_block(p, at); }
int host_eng_rec_ok(const uint8_t *p, uint32_t len, uint32_t at) { return eng_rec_ok(p, len, at); }
uint32_t host_eng_rec_size(const uint8_t *p, uint32_t at) { return eng_rec_size(p, at); }
uint32_t host_eng_cables_end(const uint8_t *p, uint32_t len) { return eng_cables_end(p, len); }
uint32_t host_eng_routes_end(const uint8_t *p, uint32_t len, uint32_t at) { return eng_routes_end(p, len, at); }

int main(void)
{
    uint32_t i, d, kits = 0, seven = 0;
    const char *paths[] = {"build/panel-fixtures/pattern-control-only.m1p", "build/panel-fixtures/pattern-direct-trig.m1p", "build/panel-fixtures/pattern-ambiguous-gate.m1p"};
    for (i = 0; i < 3; i++) {
        const uint32_t *words; uint32_t saved[128]; int n, mod;
        check("load the drum routing fixture (Verona Drum 1, its track outside its card)", !load_fixture(paths[i])); pv_gen++; pages_ensure();
        mod = eng_steps_module(0);
        for (d = 0; d < pg_ndev; d++) {
            static fc_pattern_t origin;
            if (preset_pattern_identity(m1_pattern_origin((uint32_t)mod, 0), &origin) || origin.structure != pg_dev[d].structure) continue;
            n = eng_pattern_notes((uint32_t)mod, 0, &words); memcpy(saved, words, (size_t)n * 4);
            check("grouping cannot authorize control-only or ambiguous replacement", dp_pattern_module(d) == (i == 1 ? mod : -1));
            check("routing fixture selects factory sound", !dp_load(d, 1));
            check("routing fixture binary reloads", !eng_load(pv_bin, pv_len)); pv_gen++; pages_ensure();
            if (i == 1) check("direct Steps trig replaces notes through real saved binary", eng_pattern_notes((uint32_t)mod, 0, &words) != n || memcmp(saved, words, (size_t)n * 4));
            else check("control-only and ambiguous notes survive selection and reload", eng_pattern_notes((uint32_t)mod, 0, &words) == n && !memcmp(saved, words, (size_t)n * 4));
            break;
        }
        check("routing fixture found the real drum card", d < pg_ndev);
    }
    for (i = 0; i < N_PRESETS; i++) {
        if (strcmp(PRESET_LIST[i].name, "808 KIT") && strcmp(PRESET_LIST[i].name, "909 KIT") && strcmp(PRESET_LIST[i].name, "<7PH")) continue;
        check("load actual kit", !load_kit(i)); pv_gen++; pages_ensure();
        for (d = 0; d < pg_ndev; d++) {
            int mod = dp_pattern_module(d), n;
            const uint32_t *words;
            static fc_pattern_t before, now;
            uint32_t saved[128], other[16][128], counts[16], tr, k, target = 0;
            if (mod < 0 || preset_pattern_identity(m1_pattern_origin((uint32_t)mod, 0), &before) || before.structure != pg_dev[d].structure) continue;
            for (k = 0; k < dp_list(d); k++) if (!(pr_list[k] & PR_USER) && k) { target = k; break; }
            check("kit has a second factory sound", target > 0);
            if (strcmp(PRESET_LIST[i].name, "808 KIT")) {
                uint32_t g, rows = 0, own = 0;
                booting = 0; page = 0;
                for (g = 0; g < pg_dev[d].npg; g++) {
                    pages_focus(d, g);
                    check("909 wrapper navigation reaches each child-control page", pg_cur_dev == d && pg_cur_page == g && pages_now()->nrows > 0);
                    rows += pages_now()->nrows;
                }
                for (g = 0; g < pg_dev[d].nrows; g++)   /* (a card row the FM-1 has not got, the DRUMS grid: 0xFF 0xFF) */
                    own += pg_dev[d].rows[2u * g] != 0xFFu;
                check("909 wrapper navigation includes every promoted row", rows == own);
            }
            n = eng_pattern_notes((uint32_t)mod, 0, &words); memcpy(saved, words, (size_t)n * 4);
            for (tr = 0; tr < (uint32_t)eng_steps_count(); tr++) {
                counts[tr] = (uint32_t)eng_pattern_notes((uint32_t)eng_steps_module(tr), 0, &words);
                memcpy(other[tr], words, counts[tr] * 4);
            }
            { uint32_t rows = pg_dev[d].nrows;
              int32_t expected[PS_MAXV]; char name[17];
              int want = dp_entry(pr_list[target], name);
              memcpy(expected, pr_at, (size_t)want * sizeof(int32_t));
              check("actual dp_load factory selection", !dp_load(d, target));
              /* (the binary's length alone can stay: the 808 Kit's Electro Snap is two notes shorter than Init and its
               * name eight bytes longer, D-1053; the notes read back from the rewritten binary are the proof) */
              pages_ensure();
              for (k = 0; k < rows && k < (uint32_t)want; k++)
                  check("all sound rows applied after resize", dp_row_value(d, k) == expected[k]);
              check("resized binary reloads", !eng_load(pv_bin, pv_len));
              check("real protocol rewrote saved notes", eng_pattern_notes((uint32_t)mod, 0, &words) != n || memcmp(saved, words, (size_t)n * 4));
              for (k = 0; k < rows && k < (uint32_t)want; k++)
                  check("all sound rows survive reload", dp_row_value(d, k) == expected[k]);
            }
            check("default identity changes", m1_pattern_origin((uint32_t)mod, 0) != before.identity);
            check("new default matches", !preset_pattern_identity(m1_pattern_origin((uint32_t)mod, 0), &now) && preset_pattern_untouched((uint32_t)mod, 0, &now));
            for (tr = 0; tr < (uint32_t)eng_steps_count(); tr++) if (eng_steps_module(tr) != mod) {
                check("unrelated track length", eng_pattern_notes((uint32_t)eng_steps_module(tr), 0, &words) == (int)counts[tr]);
                check("unrelated track notes", !memcmp(words, other[tr], counts[tr] * 4));
            }
            /* A USER entry with the factory's name and exact values must still clear origin. */
            k = dp_values(d); check("store same-name USER", !ps_put(pg_dev[d].structure, "INIT", pr_vals, k));
            for (k = 0; k < dp_list(d); k++) if (pr_list[k] & PR_USER) break;
            check("select USER", !dp_load(d, k)); check("USER clears origin", !m1_pattern_origin((uint32_t)mod, 0));
            n = eng_pattern_notes((uint32_t)mod, 0, &words); memcpy(saved, words, (size_t)n * 4);
            check("next factory sound after USER", !dp_load(d, 0));
            check("USER pattern preserved", eng_pattern_notes((uint32_t)mod, 0, &words) == n && !memcmp(saved, words, (size_t)n * 4));
            if (!strcmp(PRESET_LIST[i].name, "<7PH")) seven++;
            kits++; break;
        }
    }
    /* <7PH keeps its frozen lean 909 card (D-890), which ships no factory sounds since the 909 Kit is the whole TR-909
     * (D-1055): only the 808 and 909 Kits' cards switch a factory pattern */
    check("<7PH's frozen 909 card has no factory sound", seven == 0);
    check("both kit wrappers exercised", kits == 2);
    for (i = 0; i < N_PRESETS; i++) {
        if (strcmp(PRESET_LIST[i].name, "MERIDIAN 8")) continue;
        check("load Meridian save fixture", !load_at(i)); pv_gen++; pages_ensure();
        host_ps_init();
        for (d = 0; d < pg_ndev; d++) {
            int mod = dp_pattern_module(d), n;
            const uint32_t *words;
            uint32_t k, saved[128], bytes;
            if (mod < 0 || !m1_pattern_origin((uint32_t)mod, 0)) continue;
            for (k = 0; k < dp_list(d); k++) {
                char name[17];
                if (dp_entry(pr_list[k], name) >= 0 && !strcmp(name, "INDUSTRIAL")) break;
            }
            check("select INDUSTRIAL", !dp_load(d, k));
            check("factory selection retains origin after name resize", !!m1_pattern_origin((uint32_t)mod, 0));
            n = eng_pattern_notes((uint32_t)mod, 0, &words); memcpy(saved, words, (size_t)n * 4);
            bytes = pv_len;
            dp_store(d);
            check("physical preset save grows the real binary name", pv_len > bytes);
            check("physical preset save clears origin", !m1_pattern_origin((uint32_t)mod, 0));
            check("saved Meridian binary reloads", !eng_load(pv_bin, pv_len)); pv_gen++; pages_ensure();
            check("origin stays cleared after reload", !m1_pattern_origin((uint32_t)mod, 0));
            check("select factory after physical preset save", !dp_load(d, 0));
            check("saved user pattern survives factory selection", eng_pattern_notes((uint32_t)mod, 0, &words) == n && !memcmp(saved, words, (size_t)n * 4));
            {   /* #1134: a binary past M1_PATCH_MAX (PR #1129's test patch was 3,841 bytes) after this one is refused as it
                 * is: not named or given a pattern with this patch's data */
                static uint8_t big[4096], keep[4096];
                uint32_t fits = pv_len, over = 3841u;
                memcpy(big, pv_bin, pv_len);
                check("a binary that fits is named", host_preset_name(big, &fits, pg_dev[d].bin, "FITS") == 0);
                memcpy(big, pv_bin, pv_len); memset(big + pv_len, 0xA5, sizeof big - pv_len); memcpy(keep, big, sizeof big);
                check("an over-size binary is refused a name", host_preset_name(big, &over, pg_dev[d].bin, "OVER") == -1);
                check("an over-size binary is refused a default pattern", !host_default_pattern(big, &over, (uint32_t)mod, 0, words, (uint32_t)n, 1u));
                check("the over-size binary stays as it was", over == 3841u && !memcmp(big, keep, sizeof big));
            }
            break;
        }
        check("Meridian save owner found", d < pg_ndev);
        break;
    }
    check("Meridian save fixture found", i < N_PRESETS);
    printf("focused preset panel: %u kits, %s\n", kits, failed ? "FAILED" : "passed");
    return failed != 0;
}
