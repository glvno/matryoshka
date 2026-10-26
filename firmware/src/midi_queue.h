/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Matryoshka (glvno). */
/* MIDI rings: 4-byte USB-MIDI event packets */
#define MQ 64u
static uint32_t midi_in_q[MQ];
static uint32_t midi_in_ms[MQ];
static uint8_t midi_in_source[MQ];                    /* 1 USB, 2 TRS */
static volatile uint32_t mi_w, mi_r;
static volatile uint8_t midi_in_overflow;               /* audio ISR discards a broken stream and releases notes */
/* An update session or update mode (main.c, midi_in_quiet): nobody drains the ring there, so USB and TRS MIDI events
 * are dropped as they come. Else 41 queued events (MIDI clock from a controller on the TRS jack fills that in under a
 * second) leave ep1_take refusing every EP1 OUT packet: the host is NAKed and the installer's SysEx never arrives (#177). */
static volatile uint8_t midi_in_mute;

static int midi_enqueue(uint32_t pkt, uint32_t source)
{
    uint32_t at = mi_w % MQ;
    if (midi_in_mute)
        return 1;                                       /* taken, and dropped */
    if (midi_in_overflow)
        return 0;
    if (mi_w - mi_r >= MQ) {
        midi_in_overflow = 1;
        return 0;
    }
    midi_in_q[at] = pkt;
    midi_in_ms[at] = fm1_ms;
    midi_in_source[at] = (uint8_t)source;
    RING_PUBLISH();
    mi_w++;
    return 1;
}

/* main loop (the ring's consumer): drop MIDI in from now on, and what is queued; midi_in_resume() takes it again */
static __attribute__((unused)) void midi_in_quiet(void)
{
    midi_in_mute = 1;
    RING_PUBLISH();
    mi_r = mi_w;
    midi_in_overflow = 0;
}
static __attribute__((unused)) void midi_in_resume(void)
{
    RING_PUBLISH();
    midi_in_mute = 0;
}

