/* SPDX-License-Identifier: GPL-3.0-only */
/* Run only the #833 preset selection slice against the actual panel implementation. */
#include <stdint.h>
#define HOST_DEFAULT_PATTERN_IMPL
int host_default_pattern(uint8_t *, uint32_t *, uint32_t, uint32_t, const uint32_t *, uint32_t, uint32_t);
#define main unused_panel_main
#include "panel_test.c"
#undef main

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
    uint32_t i, d, kits = 0;
    for (i = 0; i < N_PRESETS; i++) {
        if (strcmp(PRESET_LIST[i].name, "808 KIT") && strcmp(PRESET_LIST[i].name, "909 KIT") && strcmp(PRESET_LIST[i].name, "<7PH")) continue;
        check("load actual kit", !load_at(i)); pv_gen++; pages_ensure();
        for (d = 0; d < pg_ndev; d++) {
            int mod = dp_pattern_module(d), n;
            const uint32_t *words;
            const preset_pattern_t *before;
            uint32_t saved[128], other[16][128], counts[16], tr, k, target = 0;
            if (mod < 0 || !(before = preset_pattern_identity(m1_pattern_origin((uint32_t)mod, 0))) || before->structure != pg_dev[d].structure) continue;
            for (k = 0; k < dp_list(d); k++) if (!(pr_list[k] & PR_USER) && k) { target = k; break; }
            check("kit has a second factory sound", target > 0);
            n = eng_pattern_notes((uint32_t)mod, 0, &words); memcpy(saved, words, (size_t)n * 4);
            for (tr = 0; tr < (uint32_t)eng_steps_count(); tr++) {
                counts[tr] = (uint32_t)eng_pattern_notes((uint32_t)eng_steps_module(tr), 0, &words);
                memcpy(other[tr], words, counts[tr] * 4);
            }
            { uint32_t bytes = pv_len, rows = pg_dev[d].nrows;
              int32_t expected[PS_MAXV]; char name[17];
              int want = dp_entry(pr_list[target], name);
              memcpy(expected, pr_at, (size_t)want * sizeof(int32_t));
              check("actual dp_load factory selection", !dp_load(d, target));
              check("real protocol resized saved notes", pv_len != bytes);
              for (k = 0; k < rows && k < (uint32_t)want; k++)
                  check("all sound rows applied after resize", dp_row_value(d, k) == expected[k]);
              check("resized binary reloads", !eng_load(pv_bin, pv_len));
              for (k = 0; k < rows && k < (uint32_t)want; k++)
                  check("all sound rows survive reload", dp_row_value(d, k) == expected[k]);
            }
            check("default identity changes", m1_pattern_origin((uint32_t)mod, 0) != before->identity);
            check("new default matches", preset_pattern_untouched((uint32_t)mod, 0, preset_pattern_identity(m1_pattern_origin((uint32_t)mod, 0))));
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
            kits++; break;
        }
    }
    check("all three kit wrappers exercised", kits == 3);
    printf("focused preset panel: %u kits, %s\n", kits, failed ? "FAILED" : "passed");
    return failed != 0;
}
