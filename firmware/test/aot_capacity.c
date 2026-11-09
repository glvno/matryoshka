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
    int rc;
    if (argc != 2 || !(f = fopen(argv[1], "rb"))) return 2;
    n = fread(data, 1, sizeof(data), f);
    if (ferror(f) || !feof(f)) { fclose(f); return 2; }
    fclose(f);
    rc = eng_load(data, (uint32_t)n);
    if (rc) { fprintf(stderr, "eng_load failed: %d\n", rc); return 1; }
    printf("%s AOT=%d bytes=%zu arena_free=%u instances=%u nodes=%u buffers=%u physical=%u",
           argv[1], ENG_AOT, n, arena_free(), E.ninst, ar_nnode, E.nbuf, E.nphys);
#if ENG_AOT
    printf(" compiled_instances=%u", aot_nx);
#endif
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
    if (!active || active != aot_nx) return 1;
#endif
    printf(" peak_L=%u peak_R=%u absolute_sum_L=%llu absolute_sum_R=%llu\n", peak[0], peak[1],
           (unsigned long long)energy[0], (unsigned long long)energy[1]);
    return peak[0] && peak[1] ? 0 : 1;
}
