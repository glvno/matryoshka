/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* Idle parts' checks are staggered (#434): an idle part runs every IDLE_CHECK-th block to check it is still silent, and no
 * two idle parts run their check in the same block (the FM-1's ENG_MAX_GROUPS x ENG_MAX_PARTS parts fit IDLE_CHECK slots).
 *   idle_test NAME.m1p NAME.ev        (tools/golden.sh runs it on the idle-stagger kit)
 * .ev as host_test reads it: "frame on NOTE VEL [CH]" / "frame off NOTE [CH]", frames multiples of ENG_BLOCK, "end FRAMES". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/engine.c"

static int32_t l[ENG_BLOCK], r[ENG_BLOCK];

int main(int argc, char **argv)
{
    FILE *f;
    long np, frame, pos = 0, total = 0, blk = 0, checks = 0, worst = 0;
    uint8_t *patch, was[ENG_NPV];
    uint16_t last[ENG_NPV];
    char kind[16];
    unsigned note, vel;
    uint32_t k, v;
    int rc;
    if (argc < 3) {
        fprintf(stderr, "usage: idle_test NAME.m1p NAME.ev\n");
        return 2;
    }
    f = fopen(argv[1], "rb");
    if (!f)
        return 2;
    fseek(f, 0, SEEK_END);
    np = ftell(f);
    fseek(f, 0, SEEK_SET);
    patch = malloc((size_t)np);
    if (fread(patch, 1, (size_t)np, f) != (size_t)np)
        return 2;
    fclose(f);
    if ((rc = eng_load(patch, (uint32_t)np)) != 0) {
        fprintf(stderr, "eng_load failed (%d)\n", rc);
        return 1;
    }
    for (k = 0; k < ENG_NPV; k++)
        last[k] = 0xFFFFu;
    f = fopen(argv[2], "r");
    if (!f)
        return 2;
    for (;;) {
        int more = fscanf(f, "%ld %15s", &frame, kind) == 2;
        if (!more)
            break;
        if (!strcmp(kind, "end"))
            total = frame;
        for (; pos < frame; pos += ENG_BLOCK, blk++) {
            long n = 0;
            for (k = 0; k < ENG_NPV; k++)
                was[k] = E.pv[k].idle;
            eng_render(l, r, ENG_BLOCK);
            for (k = 1; k <= E.ngrp; k++)
                for (v = 0; v < E.grp[k].parts; v++) {
                    uint32_t i = E.grp[k].pv0 + v;
                    if (!was[i] || E.pv[i].gate) {              /* not idle, or woken by a note: its checks start again */
                        last[i] = 0xFFFFu;
                        continue;
                    }
                    if (E.pv[i].skip)
                        continue;
                    n++;
                    if (last[i] != 0xFFFFu && blk - last[i] != (long)IDLE_CHECK) {
                        printf("FAIL block %ld: part %u checked %ld blocks after its last check\n", blk, (unsigned)i, blk - last[i]);
                        return 1;
                    }
                    last[i] = (uint16_t)blk;
                }
            checks += n;
            if (n > worst)
                worst = n;
            if (n > 1) {
                printf("FAIL block %ld: %ld idle parts run their check\n", blk, n);
                return 1;
            }
        }
        if (!strcmp(kind, "on")) {
            if (fscanf(f, "%u %u", &note, &vel) == 2)
                eng_note_on(note, (int32_t)(vel * 65536u / 127u), 1);
        } else if (!strcmp(kind, "off")) {
            if (fscanf(f, "%u", &note) == 1)
                eng_note_off(note, 1);
        }
        while ((rc = fgetc(f)) != EOF && rc != '\n')
            ;
    }
    fclose(f);
    if (!total || !checks) {
        printf("FAIL: %ld frames, %ld checks\n", total, checks);
        return 1;
    }
    printf("ok   idle checks: %ld in %ld blocks, at most %ld in a block\n", checks, blk, worst);
    return 0;
}
