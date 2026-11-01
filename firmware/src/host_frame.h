/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 glvno */
/* The main loop's turn at the received SysEx frame (#486): the editor's (proto.c m1_handle) first, else the update
 * protocol's handshake (ota.c ota_service). The frame is looked at once. Before #486 the main loop asked twice: m1_handle
 * when a frame was there, then ota_service, which takes whatever frame is there and drops what is not the update
 * protocol's. A frame that the USB poll (TIMER5 ISR) finished between the two asks went to ota_service and was dropped:
 * about 1 editor message in 500 with the transport running (the audio ISR, nested between the two, widens the gap).
 * The includer provides ota_frame_get / ota_frame_done (usb.c), m1_handle (proto.c), ota_service (ota.c).
 * firmware/test/frame_test.c checks it with a frame landing between any two of its steps. */
#pragma once
#ifndef HF_STEP
#define HF_STEP() ((void)0)                     /* the host test lands the ISR here */
#endif

enum { HF_NONE, HF_EDITOR, HF_UPDATE };

/* who took the frame: HF_NONE (none waited), HF_EDITOR, HF_UPDATE (the update protocol, which drops what is not its own) */
static uint32_t host_frame(void)
{
    const uint8_t *fp;
    uint32_t fn;
    if (!ota_frame_get(&fp, &fn))
        return HF_NONE;                         /* a frame finished after this waits for the next pass */
    HF_STEP();
    if (m1_handle(fp, fn)) {
        HF_STEP();
        ota_frame_done();
        return HF_EDITOR;
    }
    HF_STEP();
    ota_service();                              /* not the editor's: the update protocol's (it takes the frame) */
    return HF_UPDATE;
}
