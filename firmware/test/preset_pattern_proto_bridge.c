/* SPDX-License-Identifier: GPL-3.0-only */
/* Link the focused panel check to the real protocol writer and the panel's one engine. */
#include <stdint.h>
#define ENG_POOL
#define ENG_MAX_CABLES 255
uint32_t host_eng_rec_head(uint32_t ver);
#define eng_rec_head host_eng_rec_head
uint32_t host_eng_rec_npar(const uint8_t *p, uint32_t at);
#define eng_rec_npar host_eng_rec_npar
uint32_t host_eng_rec_block(const uint8_t *p, uint32_t at);
#define eng_rec_block host_eng_rec_block
int host_eng_rec_ok(const uint8_t *p, uint32_t len, uint32_t at);
#define eng_rec_ok host_eng_rec_ok
uint32_t host_eng_rec_size(const uint8_t *p, uint32_t at);
#define eng_rec_size host_eng_rec_size
uint32_t host_eng_cables_end(const uint8_t *p, uint32_t len);
#define eng_cables_end host_eng_cables_end
uint32_t host_eng_routes_end(const uint8_t *p, uint32_t len, uint32_t at);
#define eng_routes_end host_eng_routes_end
#define PROTO_TEST_EXTERNAL_ENGINE
#define main unused_proto_main
#include "proto_test.c"
#undef main
int host_preset_name(uint8_t *bin, uint32_t *len, uint32_t dev, const char *name)
{
    int result;
    m1_set_current(bin, *len);
    result = m1_preset_name(dev, name);
    memcpy(bin, m1_cur, m1_cur_len); *len = m1_cur_len;
    return result;
}
int host_default_pattern(uint8_t *bin, uint32_t *len, uint32_t mod, uint32_t pattern,
                         const uint32_t *words, uint32_t n, uint32_t identity)
{
    int result;
    m1_set_current(bin, *len);
    result = m1_default_pattern(mod, pattern, words, n, identity);
    memcpy(bin, m1_cur, m1_cur_len); *len = m1_cur_len;
    return result;
}
