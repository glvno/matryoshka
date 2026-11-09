/* SPDX-License-Identifier: GPL-3.0-only */
/* Host allocation and sequenced-audio evidence for #808. One patch per process, so every run starts fresh.
 * Compile with ENG_AOT=0 and 1. Hardware timing and the saved-patch size limit are checked separately. */
#include <stdio.h>
#include <stdlib.h>
#include "../src/engine.c"

int main(int argc, char **argv)
{
    uint8_t data[16384];
    int32_t l[128], r[128];
    uint32_t peak[2] = {0, 0};
    uint64_t energy[2] = {0, 0};
    FILE *f;
    size_t n;
    int rc, solo = argc == 4 ? atoi(argv[3]) : -1;
    uint32_t effect_bytes = 0, track = 0;
    if ((argc != 3 && argc != 4) || !(f = fopen(argv[1], "rb"))) return 2;
    n = fread(data, 1, sizeof(data), f);
    if (ferror(f) || !feof(f)) { fclose(f); return 2; }
    fclose(f);
    rc = eng_load(data, (uint32_t)n);
    if (rc) { fprintf(stderr, "eng_load failed: %d\n", rc); return 1; }
    for (uint32_t i = 0; i < E.nmod; i++) {
        effect_bytes += line_bytes(E.node[i].type, E.node[i].par) * E.node[i].ninst;
        if (E.node[i].type == T_STEPS) {
            if (solo >= 0) eng_steps_mute(i, track != (uint32_t)solo);
            track++;
        }
    }
    if (solo >= 0 && (uint32_t)solo >= track) return 2;
    printf("%s AOT=%d bytes=%zu arena_before_lines_aot=%u instances=%u nodes=%u buffers=%u physical=%u",
           argv[1], ENG_AOT, n, arena_free(), E.ninst, ar_nnode, E.nbuf, E.nphys);
#if ENG_AOT
    printf(" compiled_instances=%u aot_state_host_bytes=%zu", aot_nx, sizeof(aot_mem_t));
#if ENG_AOT_PAIR
    uint32_t pairs = 0;
    for (uint32_t i = 0; i < aot_nx; i++) pairs += aot_m->pair[i] != 0;
    printf(" independent_pairs=%u", pairs);
#endif
#endif
    printf(" effect_line_bytes=%u solo_track=%d", effect_bytes, solo);
    eng_transport(1);
    for (uint32_t block = 0; block < 44100u * 8u / 128u; block++) {
        eng_render(l, r, 128);
        for (uint32_t i = 0; i < 128; i++) {
            uint32_t a = (uint32_t)llabs((long long)l[i]), b = (uint32_t)llabs((long long)r[i]);
            if (a > peak[0]) peak[0] = a;
            if (b > peak[1]) peak[1] = b;
            energy[0] += a;
            energy[1] += b;
        }
    }
#if ENG_AOT
    uint32_t active = 0;
    for (uint32_t i = 0; i < aot_nx; i++) active += aot_x[i].on != 0;
    printf(" active_compiled_instances=%u", active);
    if (!active || active != (uint32_t)atoi(argv[2])) return 1;
#endif
    printf(" peak_L=%u peak_R=%u absolute_sum_L=%llu absolute_sum_R=%llu\n", peak[0], peak[1],
           (unsigned long long)energy[0], (unsigned long long)energy[1]);
    return (solo >= 0 ? peak[0] || peak[1] : peak[0] && peak[1]) ? 0 : 1;
}
