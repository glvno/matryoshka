/* SPDX-License-Identifier: GPL-3.0-only */
/* Focused #833 host check. Reuse protocol stubs; do not run the broad protocol/panel suites. */
#define main unused_proto_main
#include "proto_test.c"
#undef main
#include "../src/presets.h"
#include "../src/preset_pattern.h"
static int check_origin_format(uint32_t mod)
{
    static uint8_t saved[M1_PATCH_MAX];
    uint32_t len = m1_cur_len, at = eng_origins_at(m1_cur, len), end, identity = m1_pattern_origin(mod, 0);
    CHECK(at && identity); end = eng_origins_end(m1_cur, len, at);
    memcpy(saved, m1_cur, len);
    /* Ranges remain last: append, update, delete cannot truncate provenance. */
    m1_patch_range(0, 0, 0, 1, 10, 240);
    CHECK(m1_valid(m1_cur, m1_cur_len)); CHECK(m1_pattern_origin(mod, 0) == identity);
    m1_patch_range(0, 0, 0, 1, 20, 220);
    CHECK(m1_pattern_origin(mod, 0) == identity);
    m1_patch_range(0, 0, 0, 0, 0, 0);
    CHECK(m1_valid(m1_cur, m1_cur_len)); CHECK(m1_pattern_origin(mod, 0) == identity);
    CHECK(!memcmp(saved + at, m1_cur + at, end - at));
    memcpy(m1_cur, saved, len); m1_cur_len = len;
    CHECK(!eng_origins_end(m1_cur, at + 1u, at));
    CHECK(!eng_origins_end(m1_cur, end - 1u, at));
    m1_cur[at] = 255; m1_cur[at + 1u] = 255;
    CHECK(!m1_valid(m1_cur, len)); CHECK(eng_load(m1_cur, len) != 0);
    memcpy(m1_cur, saved, len); m1_cur[at + 3u] = 64;
    CHECK(!m1_valid(m1_cur, len)); CHECK(eng_load(m1_cur, len) != 0);
    memcpy(m1_cur, saved, len); m1_cur[at + 2u] = m1_cur[2];
    CHECK(!m1_valid(m1_cur, len));
    memcpy(m1_cur, saved, len); m1_cur[1] = 53;
    CHECK(!m1_valid(m1_cur, len)); CHECK(eng_load(m1_cur, len) != 0);
    /* A duplicate owner is rejected even though every individual record is in range. */
    memcpy(m1_cur, saved, len); m1_cur_len = len;
    m1_splice(end, 0, 6); memcpy(m1_cur + end, m1_cur + at + 2u, 6);
    m1_cur[at]++; CHECK(!m1_valid(m1_cur, m1_cur_len)); CHECK(eng_load(m1_cur, m1_cur_len) != 0);
    memcpy(m1_cur, saved, len); m1_cur_len = len;
    CHECK(eng_load(m1_cur, len) == 0);
    m1_clear_origin(mod, 0); CHECK(!m1_pattern_origin(mod, 0));
    CHECK(m1_valid(m1_cur, len)); CHECK(eng_load(m1_cur, len) == 0); CHECK(!m1_pattern_origin(mod, 0));
    memcpy(m1_cur, saved, len); m1_cur_len = len; CHECK(eng_load(m1_cur, len) == 0);
    return 0;
}
int main(void)
{
    uint32_t i, seen = 0;
    for (i = 0; i < N_PRESETS; i++) {
        int mod, tr;
        uint32_t j;
        const preset_pattern_t *init = 0, *next = 0;
        m1_set_current(PRESET_LIST[i].data, PRESET_LIST[i].len);
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        if (!eng_steps_count()) continue;
        mod = eng_steps_module(0);
        for (j = 0; j < N_PRESET_PATTERNS; j++) {
            if (!strcmp(PRESET_PATTERNS[j].name, "INIT") && preset_pattern_untouched((uint32_t)mod, 0, &PRESET_PATTERNS[j])) {
                init = &PRESET_PATTERNS[j];
                if (j + 1 < N_PRESET_PATTERNS && PRESET_PATTERNS[j + 1].structure == init->structure) next = &PRESET_PATTERNS[j + 1];
                break;
            }
        }
        if (!init || !next) continue;
        CHECK(m1_pattern_origin((uint32_t)mod, 0) == init->identity);
        CHECK(!check_origin_format((uint32_t)mod));
        CHECK(preset_pattern_identity(init->identity) == init);
        CHECK(!preset_pattern_identity(0)); CHECK(!preset_pattern_identity(0xdeadbeefu));
        CHECK(preset_pattern_find(init->structure, "Init") == init);
        CHECK(!preset_pattern_find(init->structure, "My sound"));
        CHECK(!preset_pattern_untouched((uint32_t)mod, 1, init));
        eng_set_param((uint32_t)mod, STEPS_P_SWING, 60 << 16);
        CHECK(!preset_pattern_untouched((uint32_t)mod, 0, init));
        eng_set_param((uint32_t)mod, STEPS_P_SWING, 50 << 16);
        { const uint32_t *words; uint32_t changed[128]; int n = eng_pattern_notes((uint32_t)mod, 0, &words);
          memcpy(changed, words, (size_t)n * 4); changed[0] ^= 1u << 19;
          CHECK(eng_pattern_set_notes((uint32_t)mod, 0, changed, (uint32_t)n));
          CHECK(!preset_pattern_untouched((uint32_t)mod, 0, init));
          CHECK(eng_pattern_set_notes((uint32_t)mod, 0, init->notes, init->n)); }
        { uint32_t other[16][128], count[16]; const uint32_t *w;
          for (tr = 1; tr < eng_steps_count(); tr++) { count[tr] = (uint32_t)eng_pattern_notes((uint32_t)eng_steps_module((uint32_t)tr), 0, &w); memcpy(other[tr], w, count[tr] * 4); }
          CHECK(m1_default_pattern((uint32_t)mod, 0, next->notes, next->n, next->identity));
          CHECK(preset_pattern_untouched((uint32_t)mod, 0, next));
          CHECK(eng_pattern() == 0);
          for (tr = 1; tr < eng_steps_count(); tr++) { CHECK(eng_pattern_notes((uint32_t)eng_steps_module((uint32_t)tr), 0, &w) == (int)count[tr]); CHECK(!memcmp(other[tr], w, count[tr] * 4)); }
        }
        CHECK(m1_valid(m1_cur, m1_cur_len));
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        CHECK(preset_pattern_untouched((uint32_t)mod, 0, next));
        CHECK(m1_pattern_origin((uint32_t)mod, 0) == next->identity);
        CHECK(m1_default_pattern((uint32_t)mod, 0, init->notes, init->n, init->identity));
        CHECK(eng_load(m1_cur, m1_cur_len) == 0);
        CHECK(preset_pattern_untouched((uint32_t)mod, 0, init));
        seen++;
    }
    CHECK(seen >= 5);
    printf("factory default patterns: %u kits, compare/swap/save-reload/unrelated tracks passed\n", seen);
    return 0;
}
