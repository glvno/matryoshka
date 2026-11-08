/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* Host test of the audio ISR's outputs (firmware/src/audio.c fm1_alnk0_irq): what USB audio takes (uac_tap) and what the
 * analog output (the speaker and the headphone jack, the I2S half) plays, under GLO > SYSTEM's settings:
 *   - 3.5MM OUT ON (#631, D-925): the analog half bit for bit what it was before the setting (MASTER's level, USB LEVEL's
 *     second render, OUTPUT's mono fold);
 *   - 3.5MM OUT OFF: the analog half silent, with every USB LEVEL and OUTPUT; USB audio the same words as with ON;
 *   - the engine stopped: both silent.
 * The emulator has no USB audio, so this is where USB audio's side of the setting is checked.
 *   tools/audio_out_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define FELUCCA_UAC 1
#define FM1_AUDIO_HALF 1u
#define FM1_TICKS_PER_US 1u
static volatile uint32_t fm1_ms;
static uint8_t fm1_audio_pending(void) { return FM1_AUDIO_HALF; }
static void fm1_audio_ack_aux(uint8_t p) { (void)p; }
static uint32_t fm1_audio_free_half(void) { return 0; }
static void fm1_audio_ack_half(void) {}
static uint32_t fm1_ticks(void) { return 0; }
static void fm1_audio_init(int32_t *b, uint32_t n, void (*isr)(void), int prio) { (void)b; (void)n; (void)isr; (void)prio; }
static void isr_alnk0(void) {}
static int eng_shed(void) { return 1; }
static int32_t sig_l[128], sig_r[128];
static void eng_render(int32_t *l, int32_t *r, uint32_t n) { memcpy(l, sig_l, n * 4u); memcpy(r, sig_r, n * 4u); }
static int click_on;                                    /* a count-in's click this half (engine.c eng_click_mix: analog only) */
static int eng_click_mix(int32_t *l, int32_t *r, uint32_t n)
{
    uint32_t i;
    if (!click_on)
        return 0;
    for (i = 0; i < n; i++) {
        l[i] += 16384;
        r[i] += 16384;
    }
    return 1;
}
#include "../src/audio.c"
static int32_t usb[256];
static void uac_render_start(void) {}
static void uac_tap(const int32_t *out, uint32_t n) { memcpy(usb, out, n * 2u * 4u); }
static void clk_out_block(uint32_t t0, int rendered) { (void)t0; (void)rendered; }

static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL "); printf(__VA_ARGS__); printf("\n"); } else { printf("ok   "); printf(__VA_ARGS__); printf("\n"); } } while (0)

/* the half as the ISR wrote it before #631 (the analog side): MASTER's level, OUTPUT's fold */
static void before(int32_t *o, uint32_t knob, uint32_t mono)
{
    uint32_t i;
    int32_t m = snd_muted ? 0 : (int32_t)(((int64_t)knob * patch_gain) >> 16);
    for (i = 0; i < HALF_FRAMES; i++) {
        o[2u * i] = ((sig_l[i] * m) >> 12) << 6;
        o[2u * i + 1u] = ((sig_r[i] * m) >> 12) << 6;
    }
    if (mono)
        for (i = 0; i < HALF_FRAMES; i++) {
            int32_t s = (o[2u * i] + o[2u * i + 1u]) >> 1;
            o[2u * i] = s;
            o[2u * i + 1u] = mono == 2u ? 0 : s;
        }
}
/* USB audio's words: its level, stereo */
static void usb_words(int32_t *o, uint32_t q)
{
    uint32_t i;
    int32_t m = snd_muted ? 0 : (int32_t)(((int64_t)q * patch_gain) >> 16);
    for (i = 0; i < HALF_FRAMES; i++) {
        o[2u * i] = ((sig_l[i] * m) >> 12) << 6;
        o[2u * i + 1u] = ((sig_r[i] * m) >> 12) << 6;
    }
}
static int silent(const int32_t *o)
{
    uint32_t i;
    for (i = 0; i < HALF_WORDS; i++)
        if (o[i])
            return 0;
    return 1;
}

int main(void)
{
    static const uint32_t KNOBS[3] = {300, 2048, 4088};
    int32_t want[HALF_WORDS], wusb[HALF_WORDS];
    uint32_t i, k, lv, mono, n = 0, bad_on = 0, bad_off = 0, bad_usb = 0;
    for (i = 0; i < 128u; i++) {                       /* a loud, uneven signal: both sides differ */
        sig_l[i] = (int32_t)((i * 977u) % 131072u) - 65536;
        sig_r[i] = (int32_t)((i * 613u + 4000u) % 131072u) - 65536;
    }
    eng_run = 1;
    for (k = 0; k < 3u; k++)
        for (lv = 0; lv < LVL_N; lv++)
            for (mono = 0; mono < 3u; mono++) {
                master_q12 = KNOBS[k];
                usb_level = (uint8_t)lv;
                out_mono = (uint8_t)mono;
                out_off = 0;
                fm1_alnk0_irq();
                before(want, KNOBS[k], mono);
                usb_words(wusb, lvl_q12(lv, KNOBS[k]));
                bad_on += memcmp(abuf, want, sizeof want) != 0;
                bad_usb += memcmp(usb, wusb, sizeof wusb) != 0;
                out_off = 1;
                fm1_alnk0_irq();
                bad_off += !silent(abuf);
                bad_usb += memcmp(usb, wusb, sizeof wusb) != 0;
                n++;
            }
    CHECK(bad_on == 0u, "3.5MM OUT ON: the analog half bit for bit as before, at MASTER's level (%u of %u settings differ)", bad_on, n);
    CHECK(bad_off == 0u, "3.5MM OUT OFF: the analog half silent, every MASTER, USB LEVEL and OUTPUT (%u of %u not)", bad_off, n);
    CHECK(bad_usb == 0u, "USB audio: the same words with 3.5MM OUT ON and OFF, at USB LEVEL's level, stereo (%u of %u differ)", bad_usb, 2u * n);
    master_q12 = 2048;
    usb_level = 0;
    out_mono = 0;
    click_on = 1;                                       /* the count-in's click: the analog output only, and OFF silences it */
    out_off = 0;
    fm1_alnk0_irq();
    usb_words(wusb, 2048);
    CHECK(memcmp(usb, wusb, sizeof wusb) == 0 && memcmp(abuf, wusb, sizeof wusb) != 0, "the click: on the analog output, not in USB audio");
    out_off = 1;
    fm1_alnk0_irq();
    CHECK(silent(abuf) && memcmp(usb, wusb, sizeof wusb) == 0, "3.5MM OUT OFF: the click silenced too, USB audio as before");
    click_on = 0;
    snd_muted = 1;                                      /* sandbox mode: both silent, as before */
    fm1_alnk0_irq();
    CHECK(silent(abuf) && silent(usb), "sandbox mode's mute: both silent");
    snd_muted = 0;
    eng_run = 0;                                        /* a patch loading: both silent */
    out_off = 0;
    fm1_alnk0_irq();
    CHECK(silent(abuf) && silent(usb), "the engine stopped: both silent");
    printf(fails ? "audio out test FAILED\n" : "audio out test passed\n");
    return fails != 0;
}
