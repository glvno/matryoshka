/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 michael glaviano */
/* Host test of the audio ISR's outputs (firmware/src/audio.c fm1_alnk0_irq): what USB audio takes (uac_tap) and what the
 * analog output (the speaker and the headphone jack, the I2S half) plays, under GLO > SYSTEM's settings:
 *   - 3.5MM OUT ON (#631, D-925): the analog half bit for bit what it was before the setting (MASTER's level, OUTPUT's
 *     mono fold);
 *   - 3.5MM OUT OFF: the analog half silent, with every MASTER and OUTPUT; USB audio the same words as with ON, at
 *     MASTER's level, stereo;
 *   - the engine stopped: both silent;
 *   - the device test mode's fixed USB level (#1170): taken only in the test mode, off when it ends; USB audio at
 *     MASTER's default with every knob while it is on, at MASTER's level while it is off (D-927), the analog half as
 *     without it.
 * The emulator has no USB audio, so this is where USB audio's side of these is checked.
 *   tools/audio_out_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define FELUCCA_UAC 1
#define FELUCCA_UAC_RETURN 1
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
/* what master_eq.h takes from engine.c: the EQ module's design (eq_design.h, the same file) and the helpers it uses */
#define ENG_SR 44118u
#define EQ_SHELF_Q 2.0f
#define EQ_SHELF_TOP 2.19911486f
#define RING_END (1.0f / 256.0f)
static float clampf(float x, float l) { return x > l ? l : x < -l ? -l : x; }
static int ring_endf(const float *s, uint32_t ns)
{
    uint32_t i, any = 0;
    for (i = 0; i < ns; i++) {
        if (s[i] >= RING_END || s[i] <= -RING_END)
            return 0;
        any |= s[i] != 0.0f;
    }
    return (int)any;
}
static inline float exp2_f(float x)                     /* (engine.c's, the same series) */
{
    union { float f; int32_t i; } s;
    int32_t w;
    float f;
    x = x < -126.0f ? -126.0f : x > 127.0f ? 127.0f : x;
    w = (int32_t)x;
    if ((float)w > x)
        w--;
    f = (x - (float)w) * 0.69314718f;
    s.i = (w + 127) << 23;
    return s.f * (1.0f + f * (1.0f + f * (1.0f / 2.0f) * (1.0f + f * (1.0f / 3.0f) * (1.0f + f * (1.0f / 4.0f) * (1.0f + f * (1.0f / 5.0f)
           * (1.0f + f * (1.0f / 6.0f) * (1.0f + f * (1.0f / 7.0f) * (1.0f + f * (1.0f / 8.0f) * (1.0f + f * (1.0f / 9.0f))))))))));
}
#include "../src/eq_design.h"
#include "../src/audio.c"
static int32_t usb[256];
static int return_on;
static int uac_play_mix(int32_t *out, uint32_t n) {
    if(return_on) for(uint32_t i=0;i<n;i++) { out[2*i]+=1024; out[2*i+1]-=2048; }
    return return_on;
}
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
/* USB audio's words: MASTER's level, stereo */
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

/* ---- the master EQ (master_eq.h, #1107) */
#include <math.h>
/* |the analog curve| in dB at f (the Audio EQ Cookbook's, as eq_design matches): shape 0 low shelf, 1 bell, 2 high shelf */
static double analog_db(int shape, double f0, double g, double q, double f)
{
    double a = pow(10.0, g / 40.0), w = f / f0, w2 = w * w, nr, ni, dr, di;
    if (shape == 1) {
        nr = 1.0 - w2; ni = w * a / q; dr = 1.0 - w2; di = w / (a * q);
    } else {
        double sa = sqrt(a);
        if (shape == 0) { nr = a * (a - w2); ni = a * sa * w / q; dr = 1.0 - a * w2; di = sa * w / q; }
        else { nr = a * (1.0 - a * w2); ni = a * sa * w / q; dr = a - w2; di = sa * w / q; }
    }
    return 10.0 * log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
static double phase;
/* the analog output's level (rms of the left side, after 40 halves to settle, over the next 80) of a sine at f Hz */
static double eq_rms(double f)
{
    double s = 0.0;
    uint32_t h, i;
    phase = 0.0;
    for (h = 0; h < 120u; h++) {
        for (i = 0; i < HALF_FRAMES; i++, phase += 2.0 * M_PI * f / FS)
            sig_l[i] = sig_r[i] = (int32_t)(16384.0 * sin(phase));
        fm1_alnk0_irq();
        for (i = 0; h >= 40u && i < HALF_FRAMES; i++)
            s += (double)abuf[2u * i] * abuf[2u * i];
    }
    return sqrt(s / (80.0 * HALF_FRAMES));
}
static void meq_test(void)
{
    static const struct { int band; double f; } PTS[] = {
        {0, 30}, {0, 120}, {0, 1000}, {0, 8000}, {1, 100}, {1, 1008}, {1, 10000}, {2, 1000}, {2, 8000}, {2, 18000}};
    static const double F0[3] = {120.0, 0.0, 8000.0};
    int32_t want[HALF_WORDS], wusb[HALF_WORDS];
    uint32_t k, i, bad = 0;
    double worst = 0.0;
    master_q12 = 2048; out_mono = 0; out_off = 0; click_on = 0; return_on = 0; snd_muted = 0; eng_run = 1;
    for (k = 0; k < sizeof PTS / sizeof PTS[0]; k++) {   /* +6 dB on one band: the analog curve, at the FM-1's rate */
        double dry, wet, err, f0 = PTS[k].band == 1 ? 100.0 * pow(2.0, MEQ_FREQ_DEFAULT / 6.0) : F0[PTS[k].band];
        meq_defaults();
        dry = eq_rms(PTS[k].f);
        if (PTS[k].band == 0) meq_low = 12; else if (PTS[k].band == 1) meq_mid = 12; else meq_high = 12;
        wet = eq_rms(PTS[k].f);
        err = fabs(20.0 * log10(wet / dry) - analog_db(PTS[k].band, f0, 6.0, MEQ_SHELF_Q, PTS[k].f));
        printf("      (band %d at %5.0f Hz: %+.2f dB, the analog curve %+.2f dB)\n", PTS[k].band, PTS[k].f, 20.0 * log10(wet / dry),
               analog_db(PTS[k].band, f0, 6.0, MEQ_SHELF_Q, PTS[k].f));
        worst = err > worst ? err : worst;
    }
    CHECK(worst < 0.25, "master EQ: +6 dB on LOW, MID or HIGH follows the analog curve at the output, within 0.25 dB (worst %.3f)", worst);
    meq_defaults();
    meq_low = 0xF4u;                                    /* (LOW -6 dB, HIGH +6 dB) */
    meq_high = 12;
    for (i = 0; i < 128u; i++) {
        sig_l[i] = (int32_t)((i * 977u) % 131072u) - 65536;
        sig_r[i] = (int32_t)((i * 613u + 4000u) % 131072u) - 65536;
    }
    for (k = 0; k < 4u; k++) {
        fm1_alnk0_irq();
        usb_words(wusb, 2048);
        before(want, 2048, 0);
        bad += memcmp(usb, wusb, sizeof wusb) != 0;
    }
    CHECK(bad == 0u && memcmp(abuf, want, sizeof want) != 0, "master EQ on: USB audio the same words as without it, the analog half equalized");
    meq_defaults();
    fm1_alnk0_irq();                                    /* (the bands fade to 0 dB over this half) */
    for (k = bad = 0; k < 4u; k++) {
        fm1_alnk0_irq();
        before(want, 2048, 0);
        bad += memcmp(abuf, want, sizeof want) != 0;
    }
    CHECK(bad == 0u && !meq_fade, "master EQ back to 0 dB: after one half's fade the analog half bit for bit as without it");
}

/* ---- the device test mode's fixed USB level (#1170): DIAG pages 100 / 101 (usb_fixed_diag) and the test mode's end
 * (usb_fixed_poll). Off, USB audio follows MASTER (D-927); on, USB audio at MASTER's default with every knob, and the
 * analog half bit for bit what it is without it */
static void usb_fixed_test(void)
{
    static const uint32_t KNOBS[4] = {0, 300, 2048, 4088};
    int32_t want[HALF_WORDS], wusb[HALF_WORDS];
    uint8_t out[2];
    uint32_t i, k, mono, n = 0, bad_a = 0, bad_u = 0, bad_off = 0, bad_eq = 0;
    for (i = 0; i < 128u; i++) {
        sig_l[i] = (int32_t)((i * 977u) % 131072u) - 65536;
        sig_r[i] = (int32_t)((i * 613u + 4000u) % 131072u) - 65536;
    }
    meq_defaults(); out_mono = 0; out_off = 0; click_on = 0; return_on = 0; snd_muted = 0; eng_run = 1; usb_fixed = 0;
    CHECK(usb_fixed_diag(100, 0, out) == 2u && !usb_fixed && out[0] == 0u && out[1] == 0u,
          "fixed USB level: DIAG 100 refused outside the device test mode");
    for (k = 0; k < 4u; k++) {
        master_q12 = KNOBS[k];
        fm1_alnk0_irq();
        usb_words(wusb, KNOBS[k]);
        bad_u += memcmp(usb, wusb, sizeof wusb) != 0;
    }
    CHECK(bad_u == 0u, "fixed USB level off (normal use): USB audio at MASTER's level, every knob (D-927)");
    CHECK(usb_fixed_diag(100, 1, out) == 2u && usb_fixed == 1u && out[0] == 1u && out[1] == 1u,
          "fixed USB level: DIAG 100 taken in the device test mode");
    for (k = bad_u = 0; k < 4u; k++)
        for (mono = 0; mono < 3u; mono++) {
            master_q12 = KNOBS[k];
            out_mono = (uint8_t)mono;
            out_off = 0;
            fm1_alnk0_irq();
            usb_words(wusb, USB_FIXED_Q12);
            before(want, KNOBS[k], mono);
            bad_u += memcmp(usb, wusb, sizeof wusb) != 0;
            bad_a += memcmp(abuf, want, sizeof want) != 0;
            out_off = 1;
            fm1_alnk0_irq();
            bad_u += memcmp(usb, wusb, sizeof wusb) != 0;
            bad_off += !silent(abuf);
            n++;
        }
    out_mono = 0;
    out_off = 0;
    CHECK(bad_u == 0u, "fixed USB level on: USB audio at MASTER's default with every knob, OUTPUT and 3.5MM OUT (%u of %u differ)", bad_u, 2u * n);
    CHECK(bad_a == 0u, "fixed USB level on: the analog half bit for bit at the knob's level (%u of %u settings differ)", bad_a, n);
    CHECK(bad_off == 0u, "fixed USB level on: 3.5MM OUT OFF still silences the analog half (%u of %u not)", bad_off, n);
    master_q12 = 300;
    meq_low = 0xF4u;                                    /* (LOW -6 dB, HIGH +6 dB) */
    meq_high = 12;
    for (k = 0; k < 4u; k++) {
        fm1_alnk0_irq();
        usb_words(wusb, USB_FIXED_Q12);
        before(want, 300, 0);
        bad_eq += memcmp(usb, wusb, sizeof wusb) != 0 || !memcmp(abuf, want, sizeof want);
    }
    CHECK(bad_eq == 0u, "fixed USB level on with the master EQ: USB audio at the fixed level, the analog half equalized");
    meq_defaults();
    fm1_alnk0_irq();                                    /* (the bands fade to 0 dB over this half) */
    snd_muted = 1;
    fm1_alnk0_irq();
    CHECK(silent(abuf) && silent(usb), "fixed USB level on: sandbox mode's mute still silences both");
    snd_muted = 0;
    usb_fixed_poll(1);
    CHECK(usb_fixed == 1u, "fixed USB level: kept while the device test mode lasts");
    usb_fixed_poll(0);
    fm1_alnk0_irq();
    usb_words(wusb, 300);
    CHECK(!usb_fixed && !memcmp(usb, wusb, sizeof wusb), "fixed USB level: off when the device test mode ends, USB audio at MASTER's again");
    usb_fixed_diag(100, 1, out);
    CHECK(usb_fixed_diag(101, 1, out) == 2u && !usb_fixed && out[0] == 0u, "fixed USB level: DIAG 101 turns it off");
}

int main(void)
{
    static const uint32_t KNOBS[3] = {300, 2048, 4088};
    int32_t want[HALF_WORDS], wusb[HALF_WORDS];
    uint32_t i, k, mono, n = 0, bad_on = 0, bad_off = 0, bad_usb = 0;
    for (i = 0; i < 128u; i++) {                       /* a loud, uneven signal: both sides differ */
        sig_l[i] = (int32_t)((i * 977u) % 131072u) - 65536;
        sig_r[i] = (int32_t)((i * 613u + 4000u) % 131072u) - 65536;
    }
    eng_run = 1;
    for (k = 0; k < 3u; k++)
        for (mono = 0; mono < 3u; mono++) {
            master_q12 = KNOBS[k];
            out_mono = (uint8_t)mono;
            out_off = 0;
            fm1_alnk0_irq();
            before(want, KNOBS[k], mono);
            usb_words(wusb, KNOBS[k]);
            bad_on += memcmp(abuf, want, sizeof want) != 0;
            bad_usb += memcmp(usb, wusb, sizeof wusb) != 0;
            out_off = 1;
            fm1_alnk0_irq();
            bad_off += !silent(abuf);
            bad_usb += memcmp(usb, wusb, sizeof wusb) != 0;
            n++;
        }
    CHECK(bad_on == 0u, "3.5MM OUT ON: the analog half bit for bit as before, at MASTER's level (%u of %u settings differ)", bad_on, n);
    CHECK(bad_off == 0u, "3.5MM OUT OFF: the analog half silent, every MASTER and OUTPUT (%u of %u not)", bad_off, n);
    CHECK(bad_usb == 0u, "USB audio: the same words with 3.5MM OUT ON and OFF, at MASTER's level, stereo (%u of %u differ)", bad_usb, 2u * n);
    master_q12 = 2048;
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
    return_on=1; eng_run=1; master_q12=2048; out_mono=0; out_off=0; click_on=1;
    fm1_alnk0_irq(); usb_words(wusb,2048);
    CHECK(!memcmp(usb,wusb,sizeof wusb), "phone playback and count-in stay out of USB recording");
    int32_t with_return[256]; memcpy(with_return,abuf,sizeof abuf/2);
    return_on=0; fm1_alnk0_irq();
    CHECK(with_return[0]==abuf[0]+1024 && with_return[1]==abuf[1]-2048, "return mixed after count-in rewrite, stereo");
    return_on=1; out_off=1; fm1_alnk0_irq();
    CHECK(silent(abuf), "analog OFF silences USB return too");
    eng_run=0; out_off=0; out_mono=2; fm1_alnk0_irq();
    CHECK(abuf[0]==-512 && abuf[1]==0 && silent(usb), "return works with engine stopped, and follows analog MONO L");
    usb_fixed_test();
    meq_test();
    printf(fails ? "audio out test FAILED\n" : "audio out test passed\n");
    return fails != 0;
}
