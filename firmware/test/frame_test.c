/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* Host test of the main loop's turn at a received SysEx frame (firmware/src/host_frame.h, #486):
 *   - the USB poll (TIMER5 ISR) finishing a frame between any two of host_frame's steps, or between two passes: every
 *     editor frame reaches m1_handle exactly once and in order, every update protocol frame reaches ota_service, nothing
 *     is handled twice;
 *   - the same with the main loop as it was before #486 (m1_handle when a frame is there, then ota_service whatever is
 *     there): the harness finds the editor frame ota_service dropped, so it can tell.
 *   tools/frame_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int step_at = -1;        /* the step of host_frame after which the ISR lands (-1: between passes only) */
static int step_now;
static void isr_hook(void);
#define HF_STEP() isr_hook()

/* ---- the stand-ins: usb.c's one-frame mailbox, proto.c's m1_handle, ota.c's ota_service ---- */
#define NF 4000
static uint8_t frames[NF][4];   /* [0] 0x7D: the editor's (with its number in [1..2]), else the update protocol's */
static uint32_t next_in;        /* the next frame the host sends */
static uint8_t slot[4];
static int ready;               /* sx_ready */
static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL " __VA_ARGS__); printf("\n"); } } while (0)

static void isr_land(void)      /* usb_poll: the next frame into the mailbox, if the main loop released the last */
{
    uint32_t i;
    if (ready || next_in >= NF)
        return;
    for (i = 0; i < 4u; i++)
        slot[i] = frames[next_in][i];
    next_in++;
    ready = 1;
}
static void isr_hook(void)
{
    if (step_now++ == step_at)
        isr_land();
}
static int ota_frame_get(const uint8_t **p, uint32_t *n)
{
    if (!ready)
        return 0;
    *p = slot;
    *n = 4;
    return 1;
}
static void ota_frame_done(void) { ready = 0; }

static int32_t ed_last = -1;    /* the editor frame m1_handle saw last */
static uint32_t ed_seen, ota_seen, ota_bad;
static int strict;              /* the order is checked (host_frame; the old loop is expected to lose frames) */
static int m1_handle(const uint8_t *f, uint32_t n)
{
    int32_t k;
    if (n < 3u || f[0] != 0x7D)
        return 0;
    k = f[1] | f[2] << 7;
    if (strict)
        CHECK(k == ed_last + 1, "editor frame %d after %d (lost or twice)", (int)k, (int)ed_last);
    ed_last = k;
    ed_seen++;
    return 1;
}
static void ota_service(void)   /* ota.c: takes whatever frame is there, drops what is not the update protocol's */
{
    const uint8_t *p;
    uint32_t n;
    if (!ota_frame_get(&p, &n))
        return;
    if (p[0] == 0x7D)
        ota_bad++;              /* an editor frame went here: dropped */
    else
        ota_seen++;
    ota_frame_done();
}

#include "../src/host_frame.h"

/* the main loop's turn as it was before #486 */
static void host_frame_old(void)
{
    const uint8_t *fp;
    uint32_t fn;
    if (ota_frame_get(&fp, &fn) && m1_handle(fp, fn)) {
        HF_STEP();
        ota_frame_done();
    }
    HF_STEP();
    ota_service();
}

/* every frame through `pass` with the ISR landing between passes every `gap` passes, and after step `at` of each pass;
 * returns the editor frames ota_service dropped */
static uint32_t run(void (*pass)(void), int at, uint32_t gap, uint32_t seed)
{
    uint32_t k, ed = 0, ot = 0, guard = 0;
    srand(seed);
    for (k = 0; k < NF; k++) {
        if (rand() % 16 == 0) {             /* now and then a frame of the update protocol */
            frames[k][0] = 0x00;
            frames[k][1] = 0x59;
            ot++;
        } else {
            frames[k][0] = 0x7D;
            frames[k][1] = (uint8_t)(ed & 127u);
            frames[k][2] = (uint8_t)(ed >> 7 & 127u);
            ed++;
        }
    }
    next_in = 0;
    ready = 0;
    ed_last = -1;
    ed_seen = ota_seen = ota_bad = 0;
    step_at = at;
    strict = pass == host_frame;
    while ((next_in < NF || ready) && guard++ < 100u * NF) {
        if (guard % gap == 0u)
            isr_land();                     /* between two passes */
        step_now = 0;
        pass();
    }
    CHECK(next_in == NF && !ready, "all %u frames sent and taken (sent %u)", (unsigned)NF, (unsigned)next_in);
    CHECK(ota_seen == ot, "update protocol frames: %u of %u reached ota_service", (unsigned)ota_seen, (unsigned)ot);
    if (pass == host_frame)
        CHECK(ed_seen == ed && !ota_bad, "editor frames: %u of %u reached m1_handle, %u dropped", (unsigned)ed_seen,
              (unsigned)ed, (unsigned)ota_bad);
    return ota_bad;
}

int main(void)
{
    int at;
    uint32_t gap, lost_old = 0;
    for (at = -1; at < 3; at++)
        for (gap = 1; gap <= 4u; gap++) {
            (void)run(host_frame, at, gap, (uint32_t)(at + 7) * 31u + gap);
            lost_old += run(host_frame_old, at, gap, (uint32_t)(at + 7) * 31u + gap);
        }
    printf("%s  a frame landing between any two steps or passes: every editor frame handled once, in order\n",
           fails ? "FAIL" : "ok  ");
    ed_last = -1;
    CHECK(lost_old > 0, "the main loop before #486 loses editor frames to ota_service in this harness (%u)",
          (unsigned)lost_old);
    printf("%s  the main loop before #486: %u editor frames dropped by ota_service (the harness can tell)\n",
           lost_old ? "ok  " : "FAIL", (unsigned)lost_old);
    if (fails) {
        printf("frame test FAILED (%d)\n", fails);
        return 1;
    }
    printf("frame test passed\n");
    return 0;
}
