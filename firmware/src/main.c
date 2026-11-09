/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Modular-1 (morgulbrut) and Matryoshka (glvno). */
/* Boot and main loop, reduced from Felucca's: WDT, boot-loop guard, fatal vectors, then LCD, input (TIMER5
 * IRQ, 10 kHz), audio (ALNK0 IRQ), USB. Kept so the device can always be re-flashed: the OTA command, answered from a
 * second before any patch loads; the boot-loop guard (one failed boot -> safe mode with the fallback patch, two -> update
 * mode); OCT- + OCT+ held at power-on and MENU > UPDATE MODE -> update mode (USB + OTA only); the audio overload guard
 * (audio.c) keeps the main loop alive. The chip's mask-ROM mode only by its explicit SysEx (chip_boot). */
extern uint32_t _data_start[], _data_end[], _data_load[], _bss_start[], _bss_end[];
extern uint32_t _pool_start[], _pool_end[], _rt_start[], _rt_end[], _rt_load[], _c1_start[], _c1_end[], _c1_load[];


/* Diagnostics for the device bring-up (#140), read with tools/m1_link.py diag: what the last run left behind. When the main
 * loop has not passed for DIAG_STALL_MS, TIMER5 samples where the CPU was (the interrupted pc and its rets) every
 * DIAG_EVERY_MS until the watchdog resets the chip. The record and the crash record (fm1_irq.h) survive the reset in
 * .noinit; the boot copies both and the reset cause into diag_prev and starts a new record. */
#define DIAG_MAGIC 0x44494147u                  /* "DIAG" */
#define DIAG_STALL_MS 1500u
#define DIAG_EVERY_MS 250u
#define DIAG_SAMPLES 24u
typedef struct { uint32_t magic, stall_ms, n, pc[DIAG_SAMPLES], rets[DIAG_SAMPLES]; } diag_t;
diag_t diag __attribute__((section(".noinit")));        /* (not static: see fm1_crash) */
static volatile uint32_t diag_alive, diag_armed;      /* fm1_ms of the main loop's last pass; set once the loop runs */
static struct { uint32_t p3, src, wdt; diag_t stall; fm1_crash_t crash; } diag_prev;   /* (m1_link.py diag reads it as u32s) */

/* #273: the SRAM below the RAM region (app.ld .lowram: the reverb and chorus lines) and the two stacks. The boot proves
 * .lowram word by word (two patterns, then zero) and paints both stacks with STACK_PAINT (on the stack it runs on, only
 * below its own frame); DIAG page 124 (tools/m1_link.py mem) reports the proof and how deep each stack has gone since boot.
 * The emulator reads the same paint (tools/emu/src/machine.rs PAINT). */
extern uint32_t _lr_start[], _lr_end[], _lr_limit[];
extern char _ustack_top[];
#define STACK_PAINT 0x5AC3A55Cu
#define LOWRAM_PAT 0xA5A55A5Au
static uint8_t lowram_state;                    /* 1: every word of .lowram took and gave back both patterns; 2: one did not */

static void lowram_prove(void)
{
    volatile uint32_t *d;
    uint32_t bad = 0;
    for (d = _lr_start; d < _lr_end; d++)
        *d = (uint32_t)(uintptr_t)d ^ LOWRAM_PAT;
    for (d = _lr_start; d < _lr_end; d++) {
        bad |= *d ^ ((uint32_t)(uintptr_t)d ^ LOWRAM_PAT);
        *d = ~((uint32_t)(uintptr_t)d ^ LOWRAM_PAT);
    }
    for (d = _lr_start; d < _lr_end; d++) {
        bad |= *d ^ ~((uint32_t)(uintptr_t)d ^ LOWRAM_PAT);
        *d = 0;
    }
    lowram_state = bad ? 2u : 1u;
}

static void stack_paint(char *lo, char *top)
{
    volatile uint32_t here = 0, *d, *end = (uint32_t *)top;
    if ((char *)&here >= lo && (char *)&here < top)
        end = (uint32_t *)&here - 64;           /* the stack this runs on: this frame and 256 B under it stay */
    for (d = (uint32_t *)lo; d < end; d++)
        *d = STACK_PAINT;
}

static uint32_t stack_deepest(char *lo, char *top)     /* the most bytes the stack has held since boot */
{
    const volatile uint32_t *d = (const uint32_t *)lo;
    while ((char *)d < top && *d == STACK_PAINT)
        d++;
    return (uint32_t)(top - (char *)d);
}

/* #271: the second core (hal/fm1_cpu1.h, X0X's). Started at power-on before the audio and the timers, the only start that
 * works on the device (X0X's, Melodee's and Felucca's finding), and after the boot guard's update-mode check: not in update
 * mode, not after a failed boot, not when barred (fm1_c1_bar in .noinit: one core until power-off), not when the stock
 * supply setup failed (hal/fm1_power.h, #735: Melodee's rule). It renders the odd
 * parts of each poly segment (engine.c render_split, from the audio interrupt). Every C1_TEST_MS the main loop also
 * hands it the self-test (c1_sum: SIN_T read from the flash, the seed from the mailbox, the
 * answer written to RAM) and checks the answer against its own. A wrong answer, a job it refuses (a misread check
 * word) or one not back in 8 ms holds it for good and bars it: one core until power-off (Melodee's fallback, the owner's
 * ruling of 2026-11-04). Update mode and the chip's boot mode hold it first; fm1_reboot and fm1_enter_update hold it too
 * (fm1_sys.h). DIAG page 114 (tools/m1_link.py cores) reports it, page 113 arms one wrong check word (the fallback's
 * test); MENU > INFO > PROCESSOR says 2 CORES or 1 CORE (ui.c cores_up). */
#define C1_TEST_MS 100u
static uint32_t c1_test_ms = C1_TEST_MS;        /* DIAG 108 (a stress test, until 109 or a restart): every 1 ms, and the
                                                 * hand-off's race window widened to 100 us (fm1_c1_race_ticks) */
#define C1_WRONG 4u                             /* fm1_c1_gave_up: its answer was wrong (1 refused a job, 2 late, 3 barred) */
enum { C1_TRIED, C1_SKIP_UPDATE, C1_SKIP_FAILED, C1_SKIP_POWER };
static volatile uint32_t c1_out;                /* the self-test's answer, written by core 1 */
static uint32_t c1_pass, c1_fail, c1_wait_max, c1_last;
static uint32_t c1_bad_xor, c1_bad_seed, c1_bad_out;   /* the wrong answer of the last failed self-test (DIAG page 115) */
static uint8_t c1_skip, c1_inject;

static uint32_t c1_sum(uint32_t seed)           /* both cores run this: 256 words of SIN_T (from the flash) into a hash */
{
    uint32_t i, h = seed ^ 0x811C9DC5u, at = seed & 768u;
    for (i = 0; i < 256u; i++)
        h = (h ^ (uint32_t)SIN_T[at + i]) * 0x01000193u;
    return h;
}

static void c1_job(uint32_t seed)               /* (runs on core 1) */
{
    c1_out = c1_sum(seed);
}

static void c1_test(int irqs)                   /* irqs: the interrupts are on (the main loop; not at boot) */
{
    uint32_t seed, want, t0, dt, k = 0;
    int rc, w;
    if (!fm1_c1_on)
        return;
    seed = fm1_ticks();
    want = c1_sum(seed);
    c1_out = ~want;
    t0 = fm1_ticks();
    /* the hand-off with the interrupts off: the audio interrupt hands core 1 its lane jobs too (modular.c eng_lane_run).
     * Coming between this job's words and its number, it saw nothing outstanding, handed its own job over under the
     * same number, and this test's job never ran: a wrong answer, and core 1 given up for nothing (the rig, 2026-11-06).
     * Once the number is out, the interrupt waits for this job first (fm1_cpu1_busy), so the wait below keeps them on. */
    if (irqs)
        k = fm1__lock();
    rc = c1_inject ? fm1_cpu1_run_mischecked(c1_job, seed) : fm1_cpu1_run(c1_job, seed);
    if (irqs)
        fm1__unlock(k);
    c1_inject = 0;
    w = rc ? fm1_cpu1_wait() : 0;
    dt = fm1_ticks() - t0;
    if (!rc)
        return;
    if (w != 0) {                               /* refused or late: held and barred (fm1_cpu1_wait) */
        c1_fail++;
        return;
    }
    if (c1_out != want) {
        c1_bad_xor = c1_out ^ want;             /* (~0: the answer was never written, the job never ran) */
        c1_bad_seed = seed;
        c1_bad_out = c1_out;
        fm1_cpu1_hold();
        fm1_cpu1_bar();
        fm1_c1_gave_up = C1_WRONG;
        c1_fail++;
        return;
    }
    c1_pass++;
    if (dt > c1_wait_max)
        c1_wait_max = dt;
}

static void c1_boot(int update)                 /* fm1_main, before the audio and the timers */
{
    int locked;
    if (update || bootguard.failed) {
        c1_skip = update ? C1_SKIP_UPDATE : C1_SKIP_FAILED;
        return;
    }
    if (fm1_power_state != FM1_POWER_OK) {      /* the supply setup failed: one core, the registers as it left them (#735) */
        c1_skip = C1_SKIP_POWER;
        return;
    }
    locked = fm1_guard_top_locked();            /* (not yet at boot: left so) */
    if (locked)
        fm1_guard_unlock_top();                 /* its entry word is in the protected top of RAM */
    fm1_guard_pc_open();                        /* it starts in the chip's ROM */
    (void)fm1_cpu1_start();
    fm1_guard_enable(FM1_GUARD_PC);
    if (locked)
        fm1_guard_lock_top();
    c1_test(0);
    cores_up = fm1_c1_on ? 2u : 1u;
}

static void c1_poll(void)                       /* the main loop */
{
    uint8_t up;
    if (fm1_ms - c1_last >= c1_test_ms) {
        c1_last = fm1_ms;
        c1_test(1);
    }
    up = fm1_c1_on ? 2u : 1u;
    if (up != cores_up) {
        cores_up = up;
        menu_value_draw(MR_CORES);
    }
}

/* #729: TIMER5's longest wait between two entries (TIMER4 ticks) since DIAG page 130 was read, and the fm1_ms it ended
 * at. TIMER5 nests in the audio interrupt, so only the interrupts off (or its own long run) hold it back, and with it
 * the 2 kHz USB service that queues each USB audio packet */
static volatile uint32_t t5_gap_max, t5_gap_at;
void fm1_timer5_irq(uint32_t *f)                /* f: the saved r0..r3, reti, rets, psr (fm1_isr.S) */
{
    static uint32_t sub, last, acc, next;
    uint32_t t0 = fm1_ticks();
    fm1_timer5_ack();
    fm1_input_tick();
    if (t0 - last > t5_gap_max) {
        t5_gap_max = t0 - last;
        t5_gap_at = fm1_ms;
    }
    acc += t0 - last;                           /* milliseconds from the 24 MHz TIMER4 */
    last = t0;
    while (acc >= 1000u * FM1_TICKS_PER_US) {
        acc -= 1000u * FM1_TICKS_PER_US;
        fm1_ms++;
    }
    if (diag_armed && fm1_ms - diag_alive > DIAG_STALL_MS && (int32_t)(fm1_ms - next) >= 0 && diag.n < DIAG_SAMPLES) {
        if (!diag.n)
            diag.stall_ms = diag_alive;
        diag.pc[diag.n] = f[4];
        diag.rets[diag.n] = f[5];
        diag.n++;
        next = fm1_ms + DIAG_EVERY_MS;
    }
    if (sub++ % 5u == 0u) {
        clk_out_poll(t0);                       /* MIDI clock out: the ticks due now to the USB ring (clock_out.h) */
        usb_poll();                             /* 2 kHz: all USB SIE traffic lives here */
        uart_midi_poll();                       /* the TRS jack's DMA ring (128 bytes = 41 ms) */
    }
    if (sub == 10u)
        sub = 0;
    bt_t5(t0);                                  /* (blk_time.h: its time, read only) */
}
extern void isr_timer5(void);

static void hexs(char *b, uint32_t v)
{
    uint32_t i;
    for (i = 0; i < 8u; i++)
        b[i] = "0123456789ABCDEF"[(v >> (28u - 4u * i)) & 15u];
    b[8] = 0;
}

static void fm1_fault(const fm1_crash_t *c)
{
    char b[12];
    uint32_t t0;
    if (fm1_c1_on)
        fm1_cpu1_bar();                         /* a crash beside the second core: one core until power-off (X0X's, #271) */
    fm1_audio_stop();
    lcd_service = lcd_yield = 0;                  /* a fault screen must not resume input or engine work */
    lcd_wake_now();
    lcd_fill(0, 0, 240, 240, 0xF800u);
    text5x7(8, 8, "CRASH", 3, C_FG, 0xF800u);
    hexs(b, c->vec);
    text5x7(10, 50, b, 2, C_FG, 0xF800u);
    hexs(b, c->pc);
    text5x7(10, 70, b, 2, C_FG, 0xF800u);
    hexs(b, c->emu);
    text5x7(10, 90, b, 2, C_FG, 0xF800u);
    t0 = fm1_ticks();
    while ((uint32_t)(fm1_ticks() - t0) < 4000u * 1000u * FM1_TICKS_PER_US)
        ;
    fm1_reboot();
}

/* proto.c hooks */
static int m1_flash_ok(void) { return flash_ok; }
static int m1_editor_ignore(void) { return cfg.editor_ignore; }   /* proto.c INFO: GLO > SYSTEM > EDITOR at IGNORE (#702) */
static int m1_midi_out(void) { return cfg.midi_out; }   /* proto.c INFO: MENU > MIDI OUT (sandbox mode needs it) */
static void m1_send(const uint8_t *f, uint32_t n) { (void)ota_wire_send(f, n); }
static int m1_apply(const uint8_t *patch, uint32_t len)
{
    int rc;
    eng_run = 0;                                /* the ISR renders silence while the patch is replaced */
    __asm__ volatile("" ::: "memory");          /* (volatile alone does not keep the engine's writes after it: #78) */
    rc = eng_load(patch, len);
    load_err = -rc;
    eng_us_max = 0;
    eng_overload_clear();                       /* a new patch: an overload is forgotten */
    __asm__ volatile("" ::: "memory");
    eng_run = 1;                                /* a voice that did not load renders silence by itself */
    sel = 0;
    patch_label = "FROM EDITOR";
    leds_avail();                               /* the patch buttons it uses */
    ui_full = 1;                                /* not drawn here: the pages come from m1_cur, which the caller sets after this
                                                 * (m1_set_current); drawn now, the old patch's rows met the new engine (#140) */
    return rc;
}
static uint32_t batt_us;                        /* the last battery read's time, us (batt_poll) */
/* the DIAG command (proto.c): page 0 the reset cause and the crash record, pages 1.. the stall record, 32 bytes a page;
 * page 127 the CPU now: % of the half buffer, the longest audio ISR (us) since the last read of this page (then reset),
 * the half buffer's budget (us), the overload mute, the halves rendered, the battery read's time (us, batt_poll) and its
 * smoothed reading (0..1023, 0 = none yet), then voices shed since the last patch load;
 * pages 125, 126 the USB audio stream (usb.c uac, FELUCCA_UAC; m1_link.py uac), 8 words each:
 *   125: flags (bit 0 presented, 1 alt 1 set by the host, 2 the host reads, 3 primed, 4 configured), streams started,
 *        packets, frames in them, SET_CUR requests, bus resets, last fill_min, USB frame number
 *   126: underruns, overruns, missed IN tokens, stalls, adj_up, adj_down, fill_lo (min of fill_min since the stream
 *        started, 0xFFFFFFFF: none yet), fill_hi
 * pages 40..103 the USB setup log's ring (usb.c ul_ring, #535; m1_link.py usblog), two 16-byte entries a page, entry k
 * in slot k % USB_LOG_N; page 104 its state (entries added, the one-shot capture's first entry, the mode | USB_LOG_N << 8 |
 * the entry size << 24, fm1_ms now, bus resets, suspends, SETUPs, configured | suspended << 1 | up << 2 | the address
 * << 8 | SIE restarts << 16), page 105 its counters (unknown requests, stalls answered, STALL handshakes sent, of those
 * with a SETUP waiting, SetupEnd, status stages completed, OUT data stages, SIE timeouts); reading page 106 starts a
 * one-shot capture (the next USB_LOG_N entries are kept), page 107 goes back to the newest entries; both answer as 104;
 * page 116 MIDI clock out (clock_out.h, #473): ticks sent, ticks dropped, bytes waiting, USB MIDI ring fill, CLOCK OUT,
 * MIDI OUT, clock in drives, the transport runs;
 * page 119 the overload guard (audio.c, #458): halves rendered, halves over 85 %, late halves (the hardware played them
 * before their render ended), then since the last read of this page the longest run of halves over 85 %, the longest
 * gap between two audio ISRs (us) and the shortest ISR (us), then parts shed since the last patch load and the guard's
 * mean ISR time (us);
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page >= 132u && page <= 139u) {         /* #802, #803: the block's time (blk_time.h) */
        uint32_t v[8], k;
        const bt_acc_t *w = &bt_last;
        if (page == 132u) {
            uint32_t ms = fm1_ms;
            bt_take();
            v[0] = w->blocks;
            v[1] = w->stopped;
            v[2] = ms - w->ms0;
            v[3] = w->jobs;
            v[4] = w->parts[0];
            v[5] = w->parts[1];
            v[6] = w->refused;
            v[7] = (uint32_t)fm1_c1_on | (uint32_t)lanes_off << 1 | (uint32_t)(w->blocks >= BT_BLOCKS_MAX) << 3 |
                   (w->jobs_max > 255u ? 255u : w->jobs_max) << 8 | (w->gave_up > 65535u ? 65535u : w->gave_up) << 16;
#if FELUCCA_UAC
            v[7] |= (uint32_t)uac.feed << 2;
#endif
        } else if (page <= 137u) {
            for (k = 0; k < 4u; k++) {
                uint32_t q = 4u * (page - 133u) + k;
                v[2u * k] = q < BT_N ? bt_ns(w->sum[q], w->blocks) : 0u;
                v[2u * k + 1u] = q < BT_N ? bt_ns(w->max[q], 1u) : 0u;
            }
        } else if (page == 138u) {
            v[0] = bt_ns(w->lat_sum, w->jobs);
            v[1] = bt_ns(w->lat_max, 1u);
            v[2] = bt_ns(w->sum[BT_T5_IN] + w->sum[BT_T5_OUT], w->t5_in + w->t5_out);
            v[3] = bt_ns(w->t5_max, 1u);
            v[4] = w->t5_in;
            v[5] = w->t5_out;
            v[6] = bt_ns(w->sum[BT_C1_BUSY], w->jobs);
            v[7] = bt_ns(w->job_max, 1u);
        } else
            bt_spin(v);
