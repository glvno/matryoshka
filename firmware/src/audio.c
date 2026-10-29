/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Modular-1 (morgulbrut) and Matryoshka (glvno). */
/* I2S output (ALNK0 -> external codec) and the audio ISR, which renders the patch engine. Registers: hal/fm1_audio.h */
#define HALF_FRAMES 128u          /* I2S half buffer: 2.9 ms at 44.118 kHz */
#define HALF_WORDS (HALF_FRAMES * 2u)
#define FS 44118u                 /* the I2S rate (ENG_SR) */

static int32_t abuf[2u * HALF_WORDS] __attribute__((aligned(4)));

/* the patch engine (engine.c) renders one half buffer per ISR call. eng_run = 0: silence (a patch is being loaded) */
static volatile uint8_t eng_run;
static volatile uint32_t master_q12 = 2048;        /* the MASTER pot, 0..4088 (Q12), square law */
static volatile int32_t patch_gain = 65536;        /* the mixer page's level of the patch, Q16 (0 = muted; menu.c) */
static volatile uint8_t snd_muted;                 /* sandbox mode (sandbox_ui.c): the browser plays; the FM-1's patch runs on, unheard */
static volatile uint8_t tp_on;                     /* the device test mode (#291) asked for the output's level: tp_peak is kept */
static volatile uint32_t tp_peak;                  /* the loudest sample since the last TEST_PEAK, 16 bit: before the MASTER pot (as at its
                                                    * default, so a script does not depend on where the knob is), after mute */
static volatile uint32_t eng_us_last, eng_us_max, eng_halves;
static int32_t eng_l[HALF_FRAMES], eng_r[HALF_FRAMES];
#if FELUCCA_UAC
/* USB audio out (usb.c, included after this file): the ring's fill is sampled as a half starts, then the half's I2S words
 * (24 bit in the low bits; silence while the engine is stopped) go to the ring, >> 8 to 16 bit */
static void uac_render_start(void);
static void uac_tap(const int32_t *out, uint32_t n);
#endif

/* Overload guard (as Felucca's shed_check): a render that takes longer than the half it fills makes the ISR come back at
 * once, the main loop starves (no watchdog feed, no USB host: no OTA) and the watchdog resets. So after two halves in a
 * row above 85 % of a half (the render plus the key scan and USB nested in it) a part of a poly group is dropped
 * (eng_shed), one more per two halves while it lasts; when no group has more than one part the engine is muted
 * (eng_overload, OVERLOAD on the LCD) until a patch is loaded again (eng_resume). */
#define OVL_TICKS ((HALF_FRAMES * 1000000u / FS) * 85u / 100u * FM1_TICKS_PER_US)
static volatile uint8_t eng_overload;            /* muted after an overload: until the next patch load */
static volatile uint32_t eng_shed_count;         /* parts dropped since the last patch load (the LCD says so) */
static uint8_t ovl_bits;                         /* bit k: the half k halves ago was over 85 % */
static uint8_t shed_req;

/* after a patch load (or a flash write that had the audio off): play again, unless the overload muted it */
static void eng_resume(void) { eng_run = (uint8_t)!eng_overload; }
/* a new patch: the overload is forgotten */
static void eng_overload_clear(void)
{
    eng_overload = 0;
    eng_shed_count = 0;
    ovl_bits = 0;
    shed_req = 0;
}

void fm1_alnk0_irq(void)                       /* via isr_alnk0 (hal/fm1_isr.S) */
{
    uint8_t p = fm1_audio_pending();
    fm1_audio_ack_aux(p);
    if (p & FM1_AUDIO_HALF) {
        uint32_t half = fm1_audio_free_half(), i, t0 = fm1_ticks(), all;
        int32_t *o = &abuf[half * HALF_WORDS];
#if FELUCCA_UAC
        uac_render_start();
#endif
        if (shed_req && eng_run) {
            shed_req = 0;
            if (eng_shed()) {
                eng_shed_count++;
            } else {
                eng_run = 0;
                eng_overload = 1;
            }
        }
        if (eng_run) {
            eng_render(eng_l, eng_r, HALF_FRAMES);
            int32_t m = snd_muted ? 0 : (int32_t)(((int64_t)master_q12 * patch_gain) >> 16);
            for (i = 0; i < HALF_FRAMES; i++) {         /* Q16 (+-1.0) * MASTER -> 24 bit in the low bits, -6 dBFS ceiling */
                o[2u * i] = ((eng_l[i] * m) >> 12) << 6;
                o[2u * i + 1u] = ((eng_r[i] * m) >> 12) << 6;
            }
            if (tp_on) {                                /* (only once a script asked: no cost otherwise) */
                int32_t mr = snd_muted ? 0 : (int32_t)(((int64_t)2048 * patch_gain) >> 16);   /* MASTER at its default */
                uint32_t pk = tp_peak, a;
                for (i = 0; i < HALF_FRAMES; i++) {
                    a = (uint32_t)(eng_l[i] < 0 ? -eng_l[i] : eng_l[i]);
                    if (eng_r[i] < 0 ? (uint32_t)-eng_r[i] > a : (uint32_t)eng_r[i] > a)
                        a = (uint32_t)(eng_r[i] < 0 ? -eng_r[i] : eng_r[i]);
                    a = (uint32_t)(((uint64_t)a * (uint32_t)mr) >> 14);   /* the output's 16-bit scale: (x m >> 12 << 6) >> 8 */
                    if (a > pk)
                        pk = a;
                }
                tp_peak = pk;
            }
        } else {
            for (i = 0; i < HALF_WORDS; i++)
                o[i] = 0;
        }
#if FELUCCA_UAC
        uac_tap(o, HALF_FRAMES);
#endif
        fm1_audio_ack_half();
        all = fm1_ticks() - t0;                         /* includes the key scan and USB poll nested in the ISR */
        ovl_bits = (uint8_t)(ovl_bits << 1 | (all > OVL_TICKS));
        if ((ovl_bits & 3u) == 3u) {
            ovl_bits = 0;
            shed_req = 1;
        }
        eng_us_last = all / FM1_TICKS_PER_US;
        if (eng_us_last > eng_us_max)
            eng_us_max = eng_us_last;
        eng_halves++;
    }
}
extern void isr_alnk0(void);

static void audio_init(void)                   /* codec and ALNK0 bring-up (fm1_audio.h) */
{
    uint32_t i;
    for (i = 0; i < 2u * HALF_WORDS; i++)
        abuf[i] = 0;
    fm1_audio_init(abuf, HALF_WORDS, isr_alnk0, 3);
}
