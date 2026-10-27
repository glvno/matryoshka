/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Modular-1 (morgulbrut) and Matryoshka (glvno). */
/* Matryoshka firmware: one compilation unit (the HAL is header-only). Boots on Felucca's HAL, shows its
 * identity on the LCD, plays a sine on MIDI notes, and keeps Felucca's USB-MIDI + OTA path so it can be re-flashed. */

#ifndef FELUCCA_ID
#define FELUCCA_ID "FM-1_700"    /* package identity (build.py: the .fwsc marker string) */
#endif
#ifndef FELUCCA_VERSION
#define FELUCCA_VERSION "v1.5.1-DEV"
#endif
#define FELUCCA_FLASH 1
#define FELUCCA_OTA 1
#define FELUCCA_OTA_DRYRUN 0
#define FELUCCA_CDC 0
#ifndef FELUCCA_UAC
#define FELUCCA_UAC 1            /* USB audio out (UAC1 recording device, 44.1 kHz 16-bit stereo; usb.c); FELUCCA_UAC=0 builds without */
#endif
#ifndef FELUCCA_UAC_48K
#define FELUCCA_UAC_48K 0        /* 48 kHz needs Felucca's resampler table uac_fir.h, not in this repo */
#endif
#if FELUCCA_UAC_48K
#error "FELUCCA_UAC_48K needs uac_fir.h (not in this repo)"
#endif
#ifndef FELUCCA_UAC_TONE
#define FELUCCA_UAC_TONE 0
#endif
#define UAC_IN_SHIFT 8           /* the I2S words carry 24 bit in the low bits (audio.c): >> 8 for the 16-bit stream */

#include <stdint.h>
#include "fm1_time.h"
#include "fm1_sys.h"
#include "fm1_irq.h"
#include "fm1_guard.h"
#include "fm1_input.h"
#include "fm1_timer.h"
#include "fm1_audio.h"
#include "fm1_adc.h"
#include "fm1_flash.h"
#include "fm1_lcd_hw.h"
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")

static volatile uint32_t fm1_ms;                   /* milliseconds since boot (TIMER5 ISR) */
struct { uint32_t magic, failed, pending; } bootguard __attribute__((section(".noinit")));
#define BOOTGUARD_MAGIC 0x42475244u

#include "libc.c"
#include "div64.c"           /* 64-bit division in 32-bit steps, ahead of libcompiler-rt.a in the link */
#define SCR_POOL __attribute__((section(".pool")))   /* screen_text.h: the texts on the screen, as text (#291) */
#include "lcd.c"
#include "font5x7.c"
#include "font_bc.c"
#define ENG_POOL __attribute__((section(".pool")))
#include "engine.c"
#include "presets.h"
#include "audio.c"
#include "usb.c"
#include "midi_uart.c"
#include "storage_hw.c"
#include "ota.c"
#include "ota_hw.c"
static int m1_apply(const uint8_t *patch, uint32_t len);       /* main.c: the hooks proto.c needs */
static int m1_store(const uint8_t *patch, uint32_t len);
static int m1_flash_ok(void);
static void m1_send(const uint8_t *f, uint32_t n);
static int m1_slot_write(uint32_t slot, const char *name, const uint8_t *p, uint32_t len);
static int m1_slot_erase(uint32_t slot);
static int m1_slot_info(uint32_t slot, char *name, uint32_t *len);
static uint32_t m1_diag(uint32_t page, uint8_t *out);          /* main.c: the DIAG command's pages */
static void m1_ui_changed(void);                               /* main.c: a live edit changed what the LCD shows */
static void m1_ui_rows(void);                                  /* main.c: a live parameter changed: the rows */
static void m1_transport(int run);                             /* main.c: the editor's TRANSPORT command (PLAY) */
static void m1_focus(uint32_t dev, uint32_t pg);               /* main.c: the editor's FOCUS command (a device page) */
static void m1_live(uint32_t paused);                          /* live.c: the editor's LIVE command (it drives the FM-1; paused: its patch is a sandbox patch) */
static int m1_midi_out(void);                                  /* main.c: MENU > MIDI OUT (INFO says it) */
#include "sandbox_msg.h"
static void m1_sandbox(const sb_page_t *s);                    /* sandbox_ui.c: the editor's page in sandbox mode */
static int m1_test_key(uint32_t id, int down);                 /* main.c: the device test mode (#291) */
static int m1_test_turn(uint32_t enc, int32_t clicks);
static uint32_t m1_test_screen(uint32_t k, uint8_t *out);
static uint32_t m1_test_peak(void);
#include "proto.c"
#include "slotstore.c"
#include "presetstore.c"
#ifdef M1_BENCH
#include "bench.c"
#endif
#define UI_POOL __attribute__((section(".pool")))
#include "ui.c"
#include "pages_ui.c"
#include "sandbox_ui.c"
static const uint8_t *pages_src(uint32_t *len) { *len = m1_cur_len; return m1_cur_len ? m1_cur : 0; }
static uint32_t pages_gen(void) { return m1_gen; }
#include "menu.c"
#include "seq_ui.c"
#include "splash.c"
#include "panel.c"
#include "main.c"
