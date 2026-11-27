/* SPDX-License-Identifier: Apache-2.0 */
/* Spike #1338 (never merged): the C interface of the msfa voices (unit.cc). */
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void dxs_init(void);
void dxs_unpack(const uint8_t bulk[128], uint8_t out[156]);
void dxs_set_voice(const uint8_t v[156]);
void dxs_note_on(int midinote, int velocity);
void dxs_note_off(int midinote);
int dxs_live(void);
unsigned dxs_voice_bytes(void);
unsigned dxs_shared_bytes(void);
void dxs_render(int32_t *out, unsigned n);
#ifdef __cplusplus
}
#endif
