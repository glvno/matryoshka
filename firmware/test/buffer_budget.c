/* SPDX-License-Identifier: GPL-3.0-only */
/* Offline allocation evidence for #824. Includes the production loader and lane hooks; never contacts hardware. */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include "lanes_host.h"
#include "engine.c"

int main(int argc, char **argv)
{
    uint8_t data[16384];
    int32_t left[ENG_BLOCK], right[ENG_BLOCK];
    const uint32_t notes[] = {60, 64, 67, 71, 72, 76, 79, 83};
    uint64_t hash = 1469598103934665603ull;
    uint32_t peak = 0, compiled_rendered = 0;
    FILE *f;
    if (argc != 2 || !(f = fopen(argv[1], "rb"))) return 2;
    size_t n = fread(data, 1, sizeof data, f);
    if (ferror(f) || !feof(f)) { fclose(f); return 2; }
    fclose(f);
    int rc = eng_load(data, (uint32_t)n);
    if (rc) { fprintf(stderr, "eng_load %s failed: %d\n", argv[1], rc); return 1; }
    printf("{\"values\":%u,\"physical\":%u,\"arenaBeforeLines\":%u,\"compiledGuard\":%d",
           E.nbuf, E.nphys, arena_free(), aot_buffer_guard(data, (uint32_t)n));
    printf(",\"allocationRule\":%u", ENG_BUFFER_ALLOCATION);
#if ENG_AOT
    uint32_t sizes[ENG_MAX_LINES], offsets[ENG_MAX_LINES], count = 0, lines = 0;
    uint8_t regions[ENG_MAX_LINES];
    for (uint32_t m = 0; m < E.nmod; m++) {
        uint32_t bytes = line_bytes(E.node[m].type, E.node[m].par);
        for (uint32_t v = 0; bytes && v < E.node[m].ninst; v++) sizes[count++] = bytes;
    }
    if (line_place(sizes, count, regions, offsets)) return 3;
    for (uint32_t i = 0; i < count; i++) if (regions[i]) lines += sizes[i];
    uint32_t scratch = aot_m ? (uint32_t)sizeof(aot_mem_t) : 0;
    uint32_t offset = aot_m ? (uint32_t)((uint8_t *)aot_m - ((uint8_t *)eng_arena + ar_lo)) : 0;
    uint32_t alignment = (8u - ((ar_lo + lines) & 7u)) & 7u;
    printf(",\"compiledInstances\":%u,\"lineArenaBytes\":%u,\"compiledScratchBytes\":%u,\"compiledScratchOffset\":%u,\"compiledAlignmentBytes\":%u",
           aot_nx, lines, scratch, offset, alignment);
#endif
    /* Chord, stealing, release, idle/wake, partial blocks, and another chord. */
    for (uint32_t b = 0; b < 400; b++) {
        if (b == 2 || b == 330) for (uint32_t k = 0; k < 8; k++) eng_note_on(notes[k], 52000, 1);
        if (b == 120 || b == 370) for (uint32_t k = 0; k < 8; k++) eng_note_off(notes[k], 1);
        uint32_t frames = b % 19 == 0 ? 17 : ENG_BLOCK;
        eng_render(left, right, frames);
#if ENG_AOT
        for (uint32_t x = 0; x < aot_nx; x++) compiled_rendered |= aot_x[x].on;
#endif
        for (uint32_t k = 0; k < frames; k++) {
            hash = (hash ^ (uint32_t)left[k]) * 1099511628211ull;
            hash = (hash ^ (uint32_t)right[k]) * 1099511628211ull;
            uint32_t a = (uint32_t)llabs(left[k]), c = (uint32_t)llabs(right[k]);
            if (a > peak) peak = a;
            if (c > peak) peak = c;
        }
    }
    printf(",\"audioHash\":\"%016llx\",\"peak\":%u,\"laneJobs\":%ld,\"compiledRendered\":%u}\n", (unsigned long long)hash, peak, lh_jobs, compiled_rendered);
    return 0;
}
