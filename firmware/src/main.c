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
 * mode, not after a failed boot, not when barred (fm1_c1_bar in .noinit: one core until power-off). It renders the odd
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
enum { C1_TRIED, C1_SKIP_UPDATE, C1_SKIP_FAILED };
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

void fm1_timer5_irq(uint32_t *f)                /* f: the saved r0..r3, reti, rets, psr (fm1_isr.S) */
{
    static uint32_t sub, last, acc, next;
    uint32_t t0 = fm1_ticks();
    fm1_timer5_ack();
    fm1_input_tick();
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
 * page 131 the CPU clock and the rails, read only (#735, hal/fm1_clock.h): PLL2_CON1, CLK_CON2, the rail registers,
 * TIMER4 ticks for 16384 and 49152 dependent adds */
static void settings_store(void);
static uint32_t m1_diag(uint32_t page, uint8_t *out)
{
    const uint8_t *b = (const uint8_t *)&diag_prev;
    uint32_t i, off = page * 32u, n = sizeof diag_prev > off ? sizeof diag_prev - off : 0u;
#if FELUCCA_UAC
    if (page == 125u || page == 126u) {
        uint32_t v[8];
        if (page == 125u) {
            v[0] = (uint32_t)usb_uac_on | (uint32_t)(uac.alt != 0) << 1 | (uint32_t)uac.flowing << 2 |
                   (uint32_t)uac.go << 3 | (uint32_t)(usb.config != 0) << 4;
            v[1] = uac.starts;
            v[2] = uac.pkts;
            v[3] = uac.frames;
            v[4] = uac.rate_sets;
            v[5] = usb.resets;
            v[6] = uac.fill_min;
            v[7] = usb.frame;
        } else {
            v[0] = uac.underruns;
            v[1] = uac.overruns;
            v[2] = uac.missed;
            v[3] = uac.stalls;
            v[4] = uac.adj_up;
            v[5] = uac.adj_down;
            v[6] = uac.fill_lo;
            v[7] = uac.fill_hi;
        }
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
#endif
#if USB_LOG
    if (page >= 40u && page < 40u + USB_LOG_N / 2u) {    /* #535: the USB setup log's ring, two 16-byte entries a page */
        const uint8_t *e = (const uint8_t *)&ul_ring[2u * (page - 40u)];
        for (i = 0; i < 32u; i++)
            out[i] = e[i];
        return 32u;
    }
    if (page >= 104u && page <= 107u) {         /* #535: the USB setup log's state (106 arms a one-shot capture, 107 wraps) */
        uint32_t v[8];
        if (page == 106u || page == 107u) {
            fm1_irq_off();
            if (page == 106u)
                usb_log_arm();
            else
                usb_log_wrap();
            fm1_irq_on();
        }
        if (page == 105u) {
            v[0] = ul.unknown;
            v[1] = ul.stalls;
            v[2] = ul.stall_sent;
            v[3] = ul.stall_setup;
            v[4] = ul.setup_end;
            v[5] = ul.status;
            v[6] = ul.out_data;
            v[7] = ul.sie_timeouts;
        } else {
            v[0] = ul.n;
            v[1] = ul.base;
            v[2] = (uint32_t)ul.oneshot | USB_LOG_N << 8 | (uint32_t)sizeof(usb_ev_t) << 24;
            v[3] = fm1_ms;
            v[4] = usb.resets;
            v[5] = usb.suspends;
            v[6] = usb.setups;
            v[7] = (uint32_t)(usb.config != 0) | (uint32_t)usb.suspended << 1 | (uint32_t)usb.up << 2 |
                   (uint32_t)ul.addr << 8 | (uint32_t)usb.retries << 16;
        }
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
#endif
    if (page == 116u) {                         /* #473: MIDI clock out (clock_out.h), since boot: ticks sent, ticks dropped
                                                 * (the host stopped reading), the bytes waiting for their time, the MIDI
                                                 * packets waiting in the USB ring, CLOCK OUT, MIDI OUT, MIDI clock in drives */
        uint32_t v[8];
        v[0] = co_sent;
        v[1] = co_dropped;
        v[2] = co_w - co_r;
        v[3] = mo_w - mo_r;
        v[4] = cfg.clock_out;
        v[5] = cfg.midi_out;
        v[6] = (uint32_t)eng_clock_is_external();
        v[7] = (uint32_t)eng_transport_running();
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page == 117u || page == 118u) {         /* #486: the editor link's counters (usb.c lk), since boot */
        uint32_t v[8];
        if (page == 118u) {                     /* in */
            v[0] = usb.rx_pkts;
            v[1] = lk.rx_events;
            v[2] = lk.sx_frames;
            v[3] = lk.sx_broken;
            v[4] = lk.sx_orphan;
            v[5] = lk.sx_lost;
            v[6] = lk.ed_frames;
            v[7] = lk.up_frames;
        } else {                                /* out, and the bus */
            v[0] = lk.tx_msgs;
            v[1] = lk.tx_nohost;
            v[2] = lk.tx_noroom;
            v[3] = usb.tx_pkts;
            v[4] = usb.resets;
            v[5] = usb.suspends;
            v[6] = usb.frame_stalls;
            v[7] = (uint32_t)usb.suspended | (uint32_t)(usb.config != 0) << 1 | (so_w - so_r) << 8;
        }
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page == 108u || page == 109u) {         /* #271: the self-test stress on (108) / off (109); reads as 114 */
        c1_test_ms = page == 108u ? 1u : C1_TEST_MS;
        fm1_c1_race_ticks = page == 108u ? 100u * FM1_TICKS_PER_US : 0u;
        page = 114u;
    }
    if (page == 115u) {                         /* #271: the last failed self-test: its answer XOR the right one (all ones:
                                                 * never written), the seed, the answer */
        uint32_t v[3];
        v[0] = c1_bad_xor;
        v[1] = c1_bad_seed;
        v[2] = c1_bad_out;
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page >= 110u && page <= 114u) {         /* #271: the second core (113 first arms one wrong check word: the fallback;
                                                 * 110 / 111 turn the render's split off / on, 112 reads) */
        uint32_t v[8];
        if (page == 113u)
            c1_inject = 1;
        if (page == 110u || page == 111u)
            lanes_off = page == 110u;
        v[0] = (uint32_t)fm1_c1_on | (uint32_t)fm1_c1_gave_up << 8 |
               (uint32_t)(fm1_c1_bar.magic == FM1_C1_BAR_MAGIC && fm1_c1_bar.barred == 1u) << 16 | (uint32_t)c1_skip << 24 |
               (uint32_t)lanes_off << 31;
        v[1] = fm1_c1_trace;
        v[2] = c1_pass;
        v[3] = c1_fail;
        v[4] = fm1_c1_mb.bad;
        v[5] = fm1_cpu1_stack_used();
        v[6] = c1_wait_max / FM1_TICKS_PER_US;
        v[7] = fm1_c1_mb.done;
        c1_wait_max = 0;
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page == 124u) {                         /* #273: .lowram and the stacks */
        uint32_t v[8];
        v[0] = lowram_state;
        v[1] = (uint32_t)((uintptr_t)_lr_end - (uintptr_t)_lr_start);
        v[2] = (uint32_t)((uintptr_t)_lr_limit - (uintptr_t)_lr_end);
        v[3] = (uint32_t)(_ustack_top - _ustack_lo);
        v[4] = stack_deepest(_ustack_lo, _ustack_top);
        v[5] = (uint32_t)(_sstack_top - _sstack_lo);
        v[6] = stack_deepest(_sstack_lo, _sstack_top);
        v[7] = (uint32_t)((uintptr_t)_c1_ustack - (uintptr_t)_pool_end);   /* the pool left free (up to core 1's stacks, #271) */
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page >= 120u && page <= 123u)                    /* the draw times (ui.c ui_time_diag) */
        return ui_time_diag(page, out);
    if (page == 119u) {                         /* the overload guard's view (audio.c), the run, gap and min since the last read */
        uint32_t v[8];
        v[0] = eng_halves;
        v[1] = ovl_hot;
        v[2] = ovl_late;
        v[3] = ovl_run_max;
        v[4] = ovl_gap_max;
        v[5] = ovl_us_min;
        v[6] = eng_shed_count;
        v[7] = ovl_guard_mean(&ovl_g) / FM1_TICKS_PER_US;
        ovl_run_max = 0;
        ovl_gap_max = 0;
        ovl_us_min = 0xFFFFFFFFu;
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page == 128u || page == 129u) {         /* #656: the store's flash writes (storage_hw.c st_stat: erases, programs, the
                                                 * longest stretch with the interrupts off, the longest erase and program, the
                                                 * steps the interrupts ran in, writes without steps, suspends not taken; us);
                                                 * 129 first writes the settings record (a test: it does not wait for silence
                                                 * as D-921's does) */
        uint32_t v[8];
        if (page == 129u)
            settings_store();
        v[0] = st_stat.erases;
        v[1] = st_stat.progs;
        v[2] = st_stat.off_max;
        v[3] = st_stat.erase_max;
        v[4] = st_stat.prog_max;
        v[5] = st_stat.steps;
        v[6] = st_stat.unserved;
        v[7] = st_stat.sus_fail;
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page == 131u) {                         /* #735: the clock and the rails, read only (hal/fm1_clock.h fm1_clock_probe) */
        uint32_t v[8];
        fm1_clock_probe(v);
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    if (page == 127u) {
        uint32_t v[8];
        v[0] = cpu_pct;
        v[1] = diag_us_peak > eng_us_max ? diag_us_peak : eng_us_max;
        v[2] = 2902u;
        v[3] = eng_overload;
        v[4] = eng_halves;
        v[5] = batt_us;
        v[6] = (uint32_t)batt_raw();
        v[7] = eng_shed_count;
        diag_us_peak = 0;
        for (i = 0; i < sizeof v; i++)
            out[i] = (uint8_t)(v[i / 4u] >> (8u * (i % 4u)));
        return sizeof v;
    }
    n = n > 32u ? 32u : n;
    for (i = 0; i < n; i++)
        out[i] = b[off + i];
    return n;
}
/* the editor's TRANSPORT command (PLAY) */
static void m1_transport(int run)
{
    eng_transport(run);
    leds_play();
    ui_dirty = ui_dirty ? ui_dirty : 1;
}

/* The bank (slotstore.c) is the only patch list: 64 slots, filled with the factory patches (presets.h) on the first boot
 * and by FACTORY RESET. PRESET steps through the occupied slots, MIDI program change n loads slot n, SAVE writes the running
 * patch (edits included) back into its slot and the panel settings into the settings record, which the next boot reads
 * (the slot it opens, the octave, the menu, the mixer). cur_preset is the slot the running patch came from. */
static uint32_t popcount64(uint64_t v)
{
    uint32_t n = 0;
    for (; v; v &= v - 1u)
        n++;
    return n;
}
static int slot_used(uint32_t s) { return s < M1_SLOTS && (bank_mask >> s & 1u); }

/* the settings record: version, slot, octave + 8, LED mode, knob accel (bit 0; bit 1: the quick start off, D-247: a record
 * from before reads as on, and an older firmware reads the accel as before; bits 2..3: OUTPUT, #612: 0 STEREO, 1 MONO, 2
 * MONO L, a record from before reads as STEREO; bit 4: EDITOR, #702: 0 ALLOW, 1 IGNORE, a record from before reads as
 * ALLOW; bits 5..7 unused: a development build wrote USB LEVEL there, #600, never released, and they are not read), the
 * global tempo's low byte (byte 5,
 * D-907; was CPU in the bar), clock in (bit 0; bit 1: CLOCK OUT off, #473, read alike; bit 2: 3.5MM OUT off, #631, a
 * record from before reads as ON), TEMPO and the tempo's bit 8 (byte 7, tempo_glo.h; was program change),
 * MIDI channel, MIDI out, the bank's format, the selected module, REC's count-in (byte 12, #414: a record without
 * it, SET_MIN bytes, reads as OFF), the factory set the bank's untouched factory slots hold (bytes 13..15, #441: a
 * record without them reads as unknown). The version stays 1, so an older firmware reads the longer record too; it
 * must stay at most 16 bytes: firmware up to 1.6 reads it into a buffer of 12 + 4 bytes without a bound */
#define SET_VERSION 1u
#define SET_MIN 12u
#define SET_LEN 16u
/* the patch format the bank's untouched factory slots were brought to (settings byte 10; 0 in a record from before)
 * and the factory set they were brought to (presets.h FACTORY_SET_ID; 0 = unknown): either one off, the boot rewrites
 * them once (bank_upgrade) */
static uint8_t bank_fmt;
static uint32_t bank_set;
static void settings_pack(uint8_t *d)
{
    d[0] = SET_VERSION;
    d[1] = (uint8_t)cur_preset;
    d[2] = (uint8_t)(octave + 8);
    d[3] = cfg.leds;
    d[4] = (uint8_t)(cfg.accel | (cfg.quick ? 0u : 2u) | (uint8_t)(out_mono << 2) | (cfg.editor_ignore ? 16u : 0u));   /* (bits 2..3: OUTPUT, #612; bit 4: EDITOR, #702) */
    d[6] = (uint8_t)(co_set_byte(cfg.clock_in, cfg.clock_out) | (out_off ? 4u : 0u));   /* (bit 1: CLOCK OUT off, #473:
                                                * clock_out.h; bit 2: 3.5MM OUT off, #631) */
    gt_pack(d);                                 /* bytes 5 and 7: the global tempo and TEMPO (D-907) */
    d[8] = cfg.ch;
    d[9] = cfg.midi_out;                        /* (was the mixer's level before #60: values over 1 read as on) */
    d[10] = bank_fmt;
    d[11] = (uint8_t)sel;
    d[12] = cfg.count_in;
    d[13] = (uint8_t)bank_set;
    d[14] = (uint8_t)(bank_set >> 8);
    d[15] = (uint8_t)(bank_set >> 16);
}
static int settings_unpack(const uint8_t *d, uint32_t len, uint32_t *slot, uint32_t *module)
{
    if (len < SET_MIN || d[0] != SET_VERSION)
        return -1;
    *slot = d[1];
    octave = clampi((int32_t)d[2] - 8, -3, 3);
    cfg.leds = d[3] > 2u ? 2u : d[3];
    cfg.accel = d[4] & 1u;
    cfg.quick = !(d[4] & 2u);
    out_mono = (uint8_t)(d[4] >> 2 & 3u);       /* (a record from before reads as STEREO) */
    if (out_mono > 2u)
        out_mono = 0;
    cfg.editor_ignore = (uint8_t)(d[4] >> 4 & 1u);  /* (a record from before reads as ALLOW) */
    cfg.clock_in = d[6] & 1u;
    cfg.clock_out = co_set_clock_out(d[6]);     /* (a record from before reads as ON) */
    out_off = (uint8_t)(d[6] >> 2 & 1u);        /* (a record from before reads as ON) */
    gt_unpack(d, len);                          /* bytes 5 and 7 (CPU in the bar and program change before): the global tempo */
    cfg.ch = d[8] > 16u ? 0u : d[8];
    cfg.midi_out = d[9] == 0u ? 0u : 1u;
    bank_fmt = d[10];
    *module = d[11];
    cfg.count_in = len > 12u ? (d[12] > 2u ? 2u : d[12]) : 0u;
    bank_set = len > 15u ? (uint32_t)d[13] | (uint32_t)d[14] << 8 | (uint32_t)d[15] << 16 : 0u;
    return 0;
}

/* a store write: the sound goes on (storage_hw.c st_op runs the flash's erases and programs in steps the audio
 * interrupt renders between, #656) */
static int store_write(uint32_t id, const char *name, const uint8_t *p, uint32_t len)
{
    if (!flash_ok)
        return -1;
    return sl_write(id, name, p, len);
}

/* the settings record alone, now (panel.c: HOME + SAVE on the quick start turns it off for good, D-247; the global
 * tempo 5 s after its last change, D-907) */
static void settings_store(void)
{
    uint8_t set[SET_LEN];
    settings_pack(set);
    (void)store_write(SL_SETTINGS, 0, set, SET_LEN);
}

/* TEMPO from the editor (proto.c, D-907) */
static void m1_tempo(uint32_t patch, uint32_t bpm)
{
    gt_set(patch, bpm, fm1_ms);
    if (!ui_dirty)
        ui_dirty = 1;
}

static char label_buf[M1_NAME + 1];              /* the running patch's name (its slot's) */

static int m1_store(const uint8_t *patch, uint32_t len)        /* SAVE, the editor's STORE: the running patch into its slot */
{
    uint8_t set[SET_LEN];
    char name[M1_NAME];
    uint32_t i;
    const char *src = label_buf[0] ? label_buf : patch_label ? patch_label : "PATCH";
    (void)patch;
    (void)len;
    if (!flash_ok || !m1_cur_len || cur_preset >= M1_SLOTS)
        return -1;
    for (i = 0; i < M1_NAME; i++)                /* the slot keeps its name; a patch from the editor or the fallback brings its own */
        name[i] = 0;
    for (i = 0; i < M1_NAME && src[i]; i++)
        name[i] = src[i];
    if (store_write(cur_preset, name, m1_cur, m1_cur_len))
        return -2;
    settings_pack(set);
    if (store_write(SL_SETTINGS, 0, set, SET_LEN))
        return -2;
    gt_due = 0;                                  /* (the global tempo is in it) */
    for (i = 0; i < M1_NAME; i++)
        label_buf[i] = name[i];
    label_buf[M1_NAME] = 0;
    patch_label = label_buf;
    m1_edited = 0;
    m1_slot_now(cur_preset, label_buf);
    return 0;
}

static void fallback_boot(void);
static uint8_t patches_up;                      /* patch_boot has run (host_poll may reload the current patch) */

/* slot n into the engine; an empty slot or one that does not load: the fallback patch. 0 = the slot's patch runs */
static int preset_load(uint32_t n)
{
    static uint8_t bank_buf[M1_PATCH_MAX] ENG_POOL;
    uint32_t len = 0;
    char slot_name[M1_NAME + 1];
    if (!slot_used(n) || sl_read(n, bank_buf, &len, slot_name) || m1_apply(bank_buf, len)) {
        fallback_boot();
        cur_preset = n < M1_SLOTS ? n : 0u;
        return -1;
    }
    m1_set_current(bank_buf, len);
    cur_preset = n;
    put(label_buf, slot_name)[0] = 0;
    patch_label = label_buf;
    screen_patch();                             /* (while PRESET's last name shows: in place, #170) */
    if (patches_up) {
        m1_slot_now(n, label_buf);                  /* the editor follows the slot (#65) */
        m1_arms_now(mset_none());                   /* (a patch loads wired: #191) */
    }
    return 0;
}

#include "live.c"                                   /* the editor's Live: PRESET and program change wait (#185); sandbox mode */

static void preset_step(int32_t d)                  /* the PRESET knob: the next / previous occupied slot */
{
    uint32_t s = cur_preset, i;
    if (!bank_mask)
        return;
    if (live_holds_preset())
        return;
    for (i = 0; i < M1_SLOTS; i++) {
        s = (s + (d > 0 ? 1u : M1_SLOTS - 1u)) % M1_SLOTS;
        if (slot_used(s))
            break;
    }
    (void)preset_load(s);
}

/* proto.c hooks: the bank */
/* the preset store for the editor link (proto.c, #195) */
static uint32_t m1_presets(uint32_t k, uint32_t *structure, char *name, uint32_t *n)
{
    static uint8_t list[PS_SLOTS];
    uint32_t cnt = ps_list(0, list, PS_SLOTS);
    if (k < cnt && structure && name && n)
        (void)ps_read(list[k], structure, name, n);
    return cnt;
}
static int m1_preset_get(uint32_t structure, const char *name, int32_t *vals, uint32_t *n)
{
    char nm[PS_NAME + 1u];
    uint32_t st, i;
    int s = ps_find(structure, name);
    if (s < 0 || ps_read((uint32_t)s, &st, nm, n))
        return -1;
    for (i = 0; i < *n; i++)
        vals[i] = ps_vbuf[i];
    return 0;
}
static int m1_preset_put(uint32_t structure, const char *name, const int32_t *vals, uint32_t n)
{
    int rc;
    if (!flash_ok)
        return -1;
    rc = ps_put(structure, name, vals, n);
    return rc;
}
static int m1_preset_del(uint32_t structure, const char *name)
{
    int rc;
    if (!flash_ok)
        return -1;
    rc = ps_del(structure, name);
    if (!rc)
        dp_deleted(structure, name);             /* (a device set to it drops the name: pages_ui.c) */
    return rc;
}

static int m1_slot_write(uint32_t slot, const char *name, const uint8_t *p, uint32_t len)
{
    return store_write(slot, name, p, len);
}
static int m1_slot_erase(uint32_t slot)
{
    int rc;
    if (!flash_ok)
        return -1;
    rc = sl_erase(slot);
    return rc;
}
static int m1_slot_info(uint32_t slot, char *name, uint32_t *len)
{
    sl_hdr_t h;
    uint32_t i;
    if (!flash_ok || !slot_used(slot) || sl_head(slot, &h, 0))
        return 0;
    *len = h.len;
    for (i = 0; i < M1_NAME; i++)
        name[i] = h.name[i];
    return 1;
}

/* The loading screen (splash.c): the logo, then what is being loaded and a bar, from the first LCD write until the patches
 * are up */
#define SPLASH_MS 5000u                         /* the loading screen stays up at least this long */
static const char BOOT_READY[] = "READY";
static uint32_t t_splash;                       /* fm1_ms when it came up */
static const char *boot_what;                   /* what boot_step last printed */

/* what is being loaded now; the bar is the time left of SPLASH_MS (the steps are quicker than that) */
static void boot_step(const char *what)
{
    static uint32_t drawn = ~0u;
    char line[32], *p;
    uint32_t el = fm1_ms - t_splash, w = el >= SPLASH_MS ? SPLASH_BAR_W : el * SPLASH_BAR_W / SPLASH_MS;
    if (!booting)
        return;
    if (what != boot_what) {
        boot_what = what;
        p = put(line, what == BOOT_READY ? "" : "LOADING ");
        p = put(p, what);
        pad(p, line, 26);
        splash_line(line);
    }
    if (w != drawn) {
        drawn = w;
        splash_bar(w);
    }
}

static const char *boot_msg;                    /* shown in the bar once the pages are up */
static uint32_t boot_msg_ms;

/* the factory patches (presets.h) into slots 0.., then the settings record (slot 0): the first boot, FACTORY RESET */
static void factory_bank(void)
{
    uint8_t set[SET_LEN];
    uint32_t i;
    boot_step("FACTORY BANK");
    for (i = 0; i < N_PRESETS && i < M1_SLOTS; i++) {
        char name[M1_NAME];
        uint32_t k;
        for (k = 0; k < M1_NAME; k++)
            name[k] = 0;
        for (k = 0; k < M1_NAME && PRESET_LIST[i].name[k]; k++)
            name[k] = PRESET_LIST[i].name[k];
        fm1_wdt_feed();
        (void)store_write(i, name, PRESET_LIST[i].data, PRESET_LIST[i].len);
    }
    cur_preset = 0;
    sel = 0;
    bank_fmt = ENG_PATCH_VERSION;
    bank_set = FACTORY_SET_ID;
    settings_pack(set);
    (void)store_write(SL_SETTINGS, 0, set, SET_LEN);
}

/* FNV-1a, 32 bits (web/scripts/legacy-factory.ts fnv32) */
static uint32_t fnv32(const uint8_t *p, uint32_t n)
{
    uint32_t h = 0x811C9DC5u;
    while (n--)
        h = (h ^ *p++) * 0x01000193u;
    return h;
}

/* after an update: every slot that is byte for byte a factory patch an earlier firmware wrote (presets.h LEGACY_FACTORY,
 * so untouched since the factory bank or FACTORY RESET), in any format, gets today's patch of that name; the slot keeps
 * its name (a renamed factory patch's, presets.h FACTORY_RENAMED, takes the new one's), anything edited and saved stays as it is, and a slot holding one of today's patches is not in the table.
 * Once per factory set and format (bank_set, bank_fmt). Returns how many slots were rewritten */
static uint32_t bank_upgrade(void)
{
    uint32_t s, k, r, i, len, h, n = 0;
    char name[M1_NAME + 1];
    boot_step("FACTORY PATCHES");
    for (s = 0; s < M1_SLOTS; s++) {
        if (!slot_used(s))
            continue;
        fm1_wdt_feed();
        for (k = 0; k <= M1_NAME; k++)
            name[k] = 0;
        if (sl_read(s, m1_up, &len, name) || len < 8u || m1_up[0] != 0xA1u)
            continue;
        h = fnv32(m1_up, len);
        for (k = 0; k < N_LEGACY_FACTORY; k++)
            if (LEGACY_FACTORY[k].fnv == h && LEGACY_FACTORY[k].len == len)
                break;
        if (k >= N_LEGACY_FACTORY)
            continue;
        for (r = 0; r < N_FACTORY_RENAMED; r++) {      /* a renamed factory patch's slot takes the new one's name */
            const char *was = FACTORY_RENAMED[r].was, *to = PRESET_LIST[FACTORY_RENAMED[r].now].name;
            for (i = 0; i < M1_NAME && was[i] && name[i] == was[i]; i++)
                ;
            if (FACTORY_RENAMED[r].now != LEGACY_FACTORY[k].now || was[i] || (i < M1_NAME && name[i]))
                continue;
            for (i = 0; i < M1_NAME; i++)
                name[i] = 0;
            for (i = 0; i < M1_NAME && to[i]; i++)
                name[i] = to[i];
        }
        if (store_write(s, name, PRESET_LIST[LEGACY_FACTORY[k].now].data, PRESET_LIST[LEGACY_FACTORY[k].now].len) == 0)
            n++;
    }
    bank_fmt = ENG_PATCH_VERSION;
    bank_set = FACTORY_SET_ID;
    return n;
}

#include "bank_new.h"
/* after an update: each factory patch new in this firmware for this bank (the set it was brought to, `set`, did not have
 * it) into its own slot if empty, else the first empty one, never over a used slot (bank_new.h, #630). Before bank_set
 * moves on, with bank_upgrade; a power cut before the settings record: the next boot finds the placed ones by name. What
 * the bar says once into msg (bn_msg); 0 when nothing was new */
static int bank_add(uint32_t set, char *msg)
{
    static bn_plan_t plan;
    uint64_t named = 0;
    uint32_t s, i, k;
    sl_hdr_t h;
    char name[M1_NAME];
    for (s = 0; s < M1_SLOTS; s++) {
        if (!slot_used(s) || sl_head(s, &h, 0))
            continue;
        for (i = 0; i < N_PRESETS; i++) {
            for (k = 0; k < M1_NAME && PRESET_LIST[i].name[k] && h.name[k] == PRESET_LIST[i].name[k]; k++)
                ;
            if (k == M1_NAME || (!PRESET_LIST[i].name[k] && !h.name[k]))
                named |= (uint64_t)1 << i;
        }
    }
    bn_plan(set, bank_mask, named, M1_SLOTS, &plan);
    for (i = 0; i < N_PRESETS; i++) {
        if (plan.slot[i] == BN_NONE)
            continue;
        for (k = 0; k < M1_NAME; k++)
            name[k] = 0;
        for (k = 0; k < M1_NAME && PRESET_LIST[i].name[k]; k++)
            name[k] = PRESET_LIST[i].name[k];
        fm1_wdt_feed();
        (void)store_write(plan.slot[i], name, PRESET_LIST[i].data, PRESET_LIST[i].len);
    }
    return bn_msg(&plan, msg);
}

/* after an update, with bank_upgrade: the user presets of an earlier structure of a factory engine move to today's
 * structure (presetmig.c, D-865); how many moved */
static uint32_t presets_upgrade(void)
{
    if (!N_PMIG)
        return 0;
    boot_step("PRESETS");
    return pm_run(pr_vals);                     /* (pr_vals: pages_ui.c's preset values, unused until the pages are up) */
}

/* safe mode: SAVE held while the loading screen is up, or the previous boot did not get through (bootguard): nothing is
 * read from the flash (the bank stays: a normal boot opens it again) */
static uint8_t boot_safe;

/* safe mode's patch, and the last resort when a slot does not load: the fallback compiled into the firmware (presets.h
 * FALLBACK_PATCH, web/src/fallback.ts) */
static void fallback_boot(void)
{
    boot_step("PATCH");
    if (m1_apply(FALLBACK_PATCH, sizeof FALLBACK_PATCH) == 0)
        m1_set_current(FALLBACK_PATCH, sizeof FALLBACK_PATCH);
    cur_preset = 0;
    patch_label = FALLBACK_NAME;
    screen_idle();
}

static void patch_boot(void)                    /* the slot the settings record names (the first boot: the factory bank first) */
{
    static uint8_t set[SET_LEN + 4u];
    uint32_t len = 0, slot = 0, module = 0;
    gt_apply();                                  /* (GLOBAL at the boot patch's tempo, until the settings record says otherwise) */
    if (boot_safe || !flash_ok) {
        fallback_boot();
        if (boot_safe) {
            boot_msg = "SAFE MODE: RESTART TO EXIT";   /* (#582: what to do next; 26 characters, as a nudge, D-249) */
            boot_msg_ms = 4000;
        }
        return;
    }
    boot_step("BANK");
    sl_scan();
    if (!bank_mask && sl_sec[SL_SETTINGS] == SL_NONE) {          /* an empty store: the first boot (or after a reset) */
        factory_bank();
        boot_msg = "FACTORY BANK WRITTEN";
        boot_msg_ms = 2000;
    } else if (sl_read(SL_SETTINGS, set, &len, 0) == 0 && settings_unpack(set, len, &slot, &module) == 0) {
        if (bank_fmt < ENG_PATCH_VERSION || bank_set != FACTORY_SET_ID) {   /* the first boot after an update that changed the factory patches or the format */
            static char new_msg[BN_BAR + 1u];
            uint32_t was = bank_set, n = bank_upgrade(), moved = presets_upgrade();   /* (all before the settings record: a cut runs them again) */
            int added = bank_add(was, new_msg);  /* (a factory patch new in this firmware, #630) */
            cur_preset = slot;
            sel = module;
            settings_pack(set);
            (void)store_write(SL_SETTINGS, 0, set, SET_LEN);
            if (added) {                         /* (said over FACTORY PATCHES UPDATED: the new slot is the news) */
                boot_msg = new_msg;
                boot_msg_ms = 4000;
            } else if (n) {
                boot_msg = "FACTORY PATCHES UPDATED";
                boot_msg_ms = 3000;
            } else if (moved) {
                boot_msg = "PRESETS UPDATED";
                boot_msg_ms = 3000;
            }
        }
        leds_avail();
        leds_octave();
    }
    if (!slot_used(slot)) {                       /* the slot is gone: the first occupied one */
        for (slot = 0; slot < M1_SLOTS && !slot_used(slot); slot++)
            ;
    }
    boot_step("PATCH");
    if (preset_load(slot) == 0)
        sel = module < (uint32_t)eng_nmodules() ? module : 0u;
    else if (bank_mask) {
        boot_msg = "SLOT DID NOT LOAD";
        boot_msg_ms = 3000;
    }
}

/* MENU > FACTORY RESET: the bank erased and the factory patches written again, the settings, mixer and transport as made */
static void defaults_now(void)
{
    eng_all_notes_off();
    eng_transport(0);
    cfg_defaults();
    octave = 0;
    gt_patch = 0;                                /* TEMPO: GLOBAL, at the tempo of the patch loaded next */
    gt_bpm = 0;
    gt_apply();
    if (flash_ok) {
        ui_msg("WRITING THE FACTORY BANK", 10000);
        eng_run = 0;
        sl_clear_all();
        eng_resume();
        factory_bank();
    }
    (void)preset_load(0);
    leds_avail();
    leds_octave();
    leds_play();
    ui_msg("FACTORY RESET", 1500);
}

/* each pass of the main loop: a global tempo moved here goes to the editor, and to the settings record once it has
 * rested 5 s, the transport is stopped and nothing was heard for 2 s (a flash write stops the sound for a moment, #651) */
static void tempo_poll(void)
{
    uint32_t heard = snd_heard_ms;                   /* (read before the clock: the audio interrupt only moves it forward,
                                                      * to the clock it reads, so heard <= now; gt_quiet is signed too) */
    uint32_t now = fm1_ms;
    uint32_t r = gt_poll(now, gt_quiet(now, eng_transport_running(), heard));
    if (r & 1u)
        m1_tempo_now();
    if ((r & 2u) && flash_ok && !boot_safe)
        settings_store();
}

/* a poly group's setting from a device page (pages_ui.c poly rows): voices, assign, legato, priority, unison, into the
 * group record of the running patch; the voices and unison are read at load: the engine loads the patch again */
#include "poly_edit.h"
/* Keep the audio interrupt out of eng_load, including the retry after a rejected edit. */
static int poly_reload(const uint8_t *bin, uint32_t len)
{
    int rc;
    eng_run = 0;
    __asm__ volatile("" ::: "memory");
    rc = eng_load(bin, len);
    if (!rc)
        eng_overload_clear();
    __asm__ volatile("" ::: "memory");
    eng_run = (uint8_t)(rc == 0);
    return rc;
}
static int poly_row_set(uint32_t mod, uint32_t field, int32_t v)
{
    if (poly_patch_set(m1_cur, m1_cur_len, mod, field, v, poly_reload)) {
        ui_msg("NO ROOM", 1500);
        ui_dirty = 2;
        return -1;
    }
    m1_edited = 1;
    return 0;
}

#include "midi_input.h"

/* MASTER pot (ADC 0..1023, square law): read before the audio starts, then smoothed per main-loop pass */
static int32_t master_knob = 512 * 16;
static void master_poll(void)
{
    int32_t a = fm1_adc_read(FM1_ADC_MASTER);
    if (a >= 0) {
        uint32_t k;
        master_knob += (a * 16 - master_knob) / 8;
        k = (uint32_t)(master_knob / 16);
        master_q12 = (k * k) >> 8;
        panel_master(k);
    }
}

/* The battery (#240; ui.c ui_battery keeps the level): SARADC ch 3, the divider on PB1, every 2 s. The conversion is
 * polled, so the main loop waits for it: one dropped after MASTER's (the sample capacitor still holds ch 4), the mean of
 * four, then one of MASTER dropped so the next master_poll reads ch 4 settled; batt_us is the time all six took (DIAG page
 * 127, m1_link.py cpu). PB1 stays an analog input (fm1_adc_init: held low 8 s it would reset the chip). */
static void batt_poll(void)
{
    static uint32_t t0;
    uint32_t i, n = 0, c0;
    int32_t a, sum = 0;
    if (t0 && fm1_ms - t0 < 2000u)
        return;
    t0 = fm1_ms | 1u;
    c0 = fm1_ticks();
    (void)fm1_adc_read(FM1_ADC_BATT);
    for (i = 0; i < 4u; i++)
        if ((a = fm1_adc_read(FM1_ADC_BATT)) >= 0) {
            sum += a;
            n++;
        }
    (void)fm1_adc_read(FM1_ADC_MASTER);
    batt_us = (fm1_ticks() - c0) / FM1_TICKS_PER_US;
    ui_battery(n ? (sum + (int32_t)n / 2) / (int32_t)n : -1, usb.config && !usb.suspended);   /* USB: a host powers it */
}

static void master_boot(void)
{
    uint32_t i;
    (void)fm1_adc_read(FM1_ADC_MASTER);                 /* the first conversion after the pin setup: dropped */
    for (i = 0; i < 3u; i++) {
        int32_t a = fm1_adc_read(FM1_ADC_MASTER);
        if (a >= 0) {
            master_knob = a * 16;
            master_q12 = ((uint32_t)a * (uint32_t)a) >> 8;
            return;
        }
    }
}

/* a draw of the device page gives way when an encoder has a step waiting (pages_ui.c pages_staged, #298): SELECT, ALGO,
 * K1..K4, PRESET. Only looks (knobs_poll takes them) */
static int encs_waiting(void)
{
    uint32_t e;
    for (e = 0; e < 7u; e++)
        if (fm1_enc_waiting(e))
            return 1;
    return 0;
}

/* the HAL's inputs into the panel core (panel.c) */
static void knobs_poll(void)
{
    int32_t st[7];
    uint32_t k;
    for (k = 0; k < 7u; k++)
        st[k] = fm1_enc_take(k);
    panel_held = fm1_in.buttons;
    panel_encoders(st);
}

/* the keys (#230): every edge the scan latched, in order (a press and its release within one pass both play), then the
 * keys as they are now (only differs if the queue was full: an edge dropped). keys_yield: the same from inside a redraw
 * (panel_draw's yield), only the edges, and only those that draw nothing (panel_key quick); the rest waits for keys_poll */
static void keys_poll(void)
{
    panel_held = fm1_in.buttons;
    panel_key_queue(fm1_input_key_peek, fm1_input_key_pop, 0);
    panel_keys(fm1_in.notes);
}
static void keys_yield(void)
{
    if (fm1_input_key_peek() < 0)
        return;
    panel_held = fm1_in.buttons;
    panel_key_queue(fm1_input_key_peek, fm1_input_key_pop, 1);
}

/* the panel's reports to the editor (#549, feature bit 18). KEYS_NOW: every key edge panel_key took, with the buttons held
 * then, while MENU > MIDI OUT is on (the panel's own MIDI goes out then; the editor's copy of the panel logic reads
 * both). Queued (a key edge from inside a redraw sends nothing there) and sent by the loop, in order; a full queue
 * drops an edge, and the next one's keys held bring the editor's copy back in line */
#define KQ 16u
static uint32_t kq_key[KQ], kq_keys[KQ];
static uint16_t kq_held[KQ];
static uint8_t kq_w, kq_r;
static void m1_keys_now(uint32_t n, int down)
{
    if (!m1_heard || !cfg.midi_out || (uint8_t)(kq_w - kq_r) >= KQ)
        return;
    kq_key[kq_w % KQ] = n | (down ? 0x80u : 0u);
    kq_keys[kq_w % KQ] = keys_now;
    kq_held[kq_w % KQ] = (uint16_t)(panel_held & 0x3FFFu);
    kq_w++;
}
static void keys_report(void)
{
    for (; kq_r != kq_w; kq_r++)
        m1_keys_report(kq_key[kq_r % KQ] & 31u, (kq_key[kq_r % KQ] & 0x80u) != 0, kq_keys[kq_r % KQ], kq_held[kq_r % KQ]);
}
/* GLO > SYSTEM > EDITOR changed (#702): an editor that said HELLO hears it in an INFO nobody asked for, and at IGNORE lets go */
static void editor_poll(void)
{
    if (!editor_info_due)
        return;
    editor_info_due = 0;
    if (m1_heard)
        m1_info();
}

/* GUIDE_NOW: the panel's state (help_ui.c guide_state) after HELLO and whenever it changed, its conditions asked again
 * only then (they read the preset store), so a pass with nothing new costs a compare */
static void guide_poll(void)
{
    static uint8_t last[GUIDE_BYTES];
    static uint32_t last_sig;
    uint8_t g[GUIDE_BYTES];
    uint32_t i, sig;
    if (!m1_heard)
        return;
    guide_state(g, 0);
    sig = help_state_sig();
    for (i = 0; i < GUIDE_BYTES; i++)
        if (i != 9u && i != 10u && g[i] != last[i])
            break;
    if (i == GUIDE_BYTES && sig == last_sig && !m1_guide_due)
        return;
    m1_guide_due = 0;
    last_sig = sig;
    guide_state(g, 1);
    for (i = 0; i < GUIDE_BYTES; i++)
        last[i] = g[i];
    m1_guide_now(g, GUIDE_BYTES);
}

static void buttons_poll(void)
{
    uint32_t rel, p = fm1_input_edges(&rel);
    panel_held = fm1_in.buttons;
    panel_edges(p, rel);
}

/* USB MIDI out (MENU > MIDI OUT): every panel control (panel.c BTN_CC / ENC_CC, docs/ARCHITECTURE.md "MIDI out map"), on the MIDI
 * channel (omni: channel 1). Only what the panel does goes out, never what came in. */
static void midi_send(uint32_t status, uint32_t d1, uint32_t d2)
{
    uint32_t st = status | (cfg.ch ? cfg.ch - 1u : 0u);
    if (!cfg.midi_out)
        return;
    midi_out_event((st >> 4) | st << 8 | (d1 & 127u) << 16 | (d2 & 127u) << 24);
}
static void midi_send_rt(uint32_t b)                /* a real-time byte: USB MIDI code index 0xF (one byte) */
{
    if (b == 0xFAu || b == 0xFCu)                   /* PLAY's Start / Stop: with the engine's edge, ahead of its tick 0 */
        clk_out_play(b);                            /* (clock_out.h; MIDI OUT is read as it goes out) */
    else if (cfg.midi_out)
        midi_out_event(0x0Fu | (b & 0xFFu) << 8);
}

/* PLAY: red while the transport is stopped, green while it runs. The green LED sits at matrix column 8, row bit 1,
 * where there is no key (found on the hardware by Felucca); the red one is PLAY's own. */
/* the patch buttons (the Main module's outputs fx .. rec, engine.h ENG_PANEL_BUTTONS): their matrix ids, M-VAVE's order */
static void led_breath_key(uint32_t id, int on)     /* a button's LED breathes (the HAL's one shared speed, fm1_br_step) */
{
    uint32_t p, r;
    for (p = 0; p < FM1_NCOL; p++)
        for (r = 1; r < 5u; r++)
            if (FM1_KEYMAP[r][p] == (int8_t)id) {
                if (on)
                    fm1_led_breath[p] |= (uint8_t)(1u << r);
                else
                    fm1_led_breath[p] &= (uint8_t)~(1u << r);
            }
}

static void leds_play(void)
{
    int run = eng_transport_running();
    fm1_led_key(BTN_PLAY, !run);                    /* stopped: PLAY's red LED; running: the green one breathes */
    fm1_led[8] &= (uint8_t)~2u;
    if (run)
        fm1_led_breath[8] |= 2u;
    else
        fm1_led_breath[8] &= (uint8_t)~2u;
}

/* a patch button's LED: lit while it is held or switched on */
static void leds_panel(void)
{
    uint32_t b, mask = eng_buttons_lit();   /* (ARP on Arpeggiators: lit while they play) */
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        fm1_led_key(PANEL_BTN_ID[b], (int)(mask >> b & 1u) || (b == BTN_GLO_IDX && page == PAGE_MENU) || (b == BTN_ENV_IDX && page == PAGE_ENV));   /* (GLO, ENV: lit on their pages) */
}

/* OCT- / OCT+ light up while the octave is shifted */
static void leds_octave(void)
{
    uint32_t m = (uint32_t)(octave < 0 ? -octave : octave);
    led_breath_key(0, octave < 0);                  /* the further from 0 the faster: 1 slow, 2 medium, 3 fast */
    led_breath_key(1, octave > 0);
    fm1_br_step = m >= 3u ? 4u : m == 2u ? 2u : 1u;   /* (the PLAY breath runs at the same speed) */
}

/* SAVE: the current state (the patch with its edited parameters, the octave, the selected module and preset) to flash */
static void save_state(void)
{
    if (!flash_ok || !m1_cur_len) {
        ui_msg("NO FLASH", 1500);
        return;
    }
    ui_msg("SAVING", 5000);
    ui_msg(m1_store(m1_cur, m1_cur_len) ? "ERROR" : "SAVED", 1500);
}

static void led_glow(uint32_t id, int on)           /* the HAL's dim glow (~1/30 of lit) for a button's LED */
{
    uint32_t p, r;
    for (p = 0; p < FM1_NCOL; p++)
        for (r = 1; r < 5u; r++)
            if (FM1_KEYMAP[r][p] == (int8_t)id) {
                if (on)
                    fm1_led_dim[p] |= (uint8_t)(1u << r);
                else
                    fm1_led_dim[p] &= (uint8_t)~(1u << r);
            }
}

static void leds_avail(void)                        /* HOME and the patch buttons the patch uses glow dimly; MENU > LEDS */
{
    int on = cfg.leds != 0;
    uint32_t b, used = panel_used();
    fm1_led_dim_level(cfg.leds == 2u ? 2u : 0u);  /* DIM LOW is the old glow (~1/30), DIM HIGH a brighter one (~1/12) */
    led_glow(BTN_HOME, on);
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        led_glow(PANEL_BTN_ID[b], on && (used >> b & 1u));
    leds_panel();
}

/* proto.c: the editor shows another device page (FOCUS) */
static void m1_focus(uint32_t dev, uint32_t pg)
{
    if (pages_focus(dev, pg) && page == 0)
        ui_dirty = 2;
}
static void m1_ui_changed(void) { ui_dirty = 2; }    /* proto.c: the editor bypassed a module: title and picture */
/* ARMS from the editor (proto.c, #191): its armed set becomes the FM-1's, so the panel's keys and the editor's notes play
 * the same devices; REC records into it from now on (seq_rec_sync). Not reported back (no ARMS_NOW) */
static void m1_arms(eng_mset_t mask)
{
    if (mset_eq(mask, eng_arm_mask_get()))
        return;
    eng_arm_mask(mask);
    seq_rec_sync();
    ui_dirty = ui_dirty ? ui_dirty : 1;
}
static void m1_ui_rows(void) { ui_dirty = ui_dirty ? ui_dirty : 1; }   /* proto.c: the editor moved a parameter (Live) */

/* The device test mode (#291): a script on the Mac drives the panel over the editor link and reads the screen and the
 * output level, as `m1emu serve` does the emulator's. A key goes into the HAL's scan as a closed contact (fm1_input.h
 * fm1_virt_btn / fm1_virt_note), an encoder's clicks into its steps, so both take the panel's own paths (debounce, the
 * MIDI out, the pages). For TEST_HOLD_MS after one, the panel refuses UPDATE MODE and FACTORY RESET (menu.c). */
static int m1_test_key(uint32_t id, int down)
{
    if (id >= FM1_NKEY)
        return -1;
    if (id < 14u)
        fm1_virt_btn = down ? fm1_virt_btn | 1u << id : fm1_virt_btn & ~(1u << id);
    else
        fm1_virt_note = down ? fm1_virt_note | 1u << (id - 14u) : fm1_virt_note & ~(1u << (id - 14u));
    test_input_ms = fm1_ms ? fm1_ms : 1u;
    return 0;
}
static int m1_test_turn(uint32_t enc, int32_t clicks)
{
    uint32_t k;
    if (enc >= FM1_NENC)
        return -1;
    k = fm1__lock();
    fm1_virt_enc[enc] = (int16_t)(fm1_virt_enc[enc] + clicks);
    fm1__unlock(k);
    test_input_ms = fm1_ms ? fm1_ms : 1u;
    return 0;
}
/* k 0xFF: the head (texts, the page, flags: bit 0 sandbox mode, bit 1 the boot screen, then Main's patch buttons as their
 * jacks stand, u16: eng_buttons_get, #368), else text k (x, y, w, h, n, text) */
static uint32_t m1_test_screen(uint32_t k, uint8_t *out)
{
    static uint8_t idx[SCR_N];
    static uint32_t n;
    uint32_t i;
    const scr_text_t *t;
    if (k == 0xFFu) {
        n = scr_list(idx);
        out[0] = (uint8_t)n;
        out[1] = page;
        out[2] = (uint8_t)((sb_on ? 1u : 0u) | (booting ? 2u : 0u));
        out[3] = (uint8_t)eng_buttons_get();
        out[4] = (uint8_t)(eng_buttons_get() >> 8);
        return 5;
    }
    if (k >= n)
        return 0;
    t = &scr_text[idx[k]];
    out[0] = t->x;
    out[1] = t->y;
    out[2] = t->w;
    out[3] = t->h;
    for (i = 0; i < SCR_CH && t->s[i]; i++)
        out[5u + i] = (uint8_t)t->s[i];
    out[4] = (uint8_t)i;
    return 5u + i;
}
static uint32_t m1_test_peak(void)
{
    uint32_t p = tp_take();                         /* (test_peak.h: no half lost between two reads, #385) */
    return (p > 0xFFFFu ? 0xFFFFu : p) | (eng_run ? 1u << 16 : 0u) | (snd_muted ? 1u << 17 : 0u) | (master_q12 < 64u ? 1u << 18 : 0u);
}

/* The chip's mask-ROM download mode (USB "WL80UBOOT", 4C4A:8057): only the explicit SysEx F0 22 24 35 7D F7 gets here. No
 * tool of this project (nor M-VAVE's web updater) talks to that mode: jl-uboot-tool / FM-1 Transporter do. A power cycle
 * should start the firmware again (not verified). */
static void chip_boot(void)
{
    fm1_cpu1_hold();                            /* (#271) */
    fm1_audio_stop();
    lcd_fill(0, 0, 240, 240, C_BG);
    text5x7(12, 100, "CHIP BOOT MODE", 2, C_ACC, C_BG);
    text5x7(12, 130, "(USB) POWER OFF TO LEAVE", 1, C_DIM, C_BG);
    fm1_delay_ms(20);
    usb_detach();
    fm1_delay_ms(30);
    bootguard.pending = 0;
    fm1_enter_uboot();
}


/* Update mode: USB and the firmware update (M-UPGRADE) only, no engine and nothing read from the flash, until the power
 * goes off. Reached when two boots in a row failed (the boot guard), with OCT- + OCT+ held at power-on, or from MENU >
 * SYSTEM > UPDATE MODE, so the Flash page of the editor (or tools/fm1_install.py) can always install a firmware. */
static void update_screen(const char *why)
{
    lcd_fill(0, 0, 240, 240, C_BG);
    lcd_fill(12, 40, 216, 3, C_ACC);
    text5x7(12, 52, "UPDATE MODE", 3, C_FG, C_BG);
    lcd_fill(12, 80, 216, 3, C_ACC);
    text5x7(12, 100, "CONNECT USB AND OPEN THE", 1, C_FG, C_BG);
    text5x7(12, 114, "FLASH PAGE OF THE EDITOR", 1, C_FG, C_BG);
    text5x7(12, 128, "TO INSTALL A FIRMWARE.", 1, C_FG, C_BG);
    text5x7(12, 156, why, 1, C_ACC, C_BG);
    if (!flash_ok)
        text5x7(12, 170, "NO FLASH ID: NO UPDATES", 1, C_RED, C_BG);
    text5x7(12, 210, "POWER OFF TO LEAVE", 1, C_DIM, C_BG);
}

static void update_only(const char *why)
{
    fm1_cpu1_hold();                            /* update mode is one core (#271) */
    cores_up = 1;
    eng_run = 0;
    booting = 0;
    bootguard.pending = 0;                      /* this boot did not fail: a watchdog reset from here starts normally */
    midi_in_quiet();                            /* nothing drains MIDI in here: it must not hold the SysEx back (#177) */
#if FELUCCA_UAC
    usb_uac_switch(0);                          /* MIDI only (from the menu: off the bus, back within a second via usb_retry) */
#endif
    update_screen(why);
    for (;;) {
        const uint8_t *fp;
        uint32_t fn;
        fm1_wdt_feed();
        usb_retry(fm1_ms);
        if (ota_frame_get(&fp, &fn) && fn >= 3u && fp[0] == 0x7Du && fp[1] == 0x4Du && fp[2] == 0x31u)
            ota_frame_done();                   /* the editor's SysEx: not in this mode */
        ota_service();                          /* M-UPGRADE handshake */
        if (usb.ota_req) {                      /* M-UPGRADE upgrade command */
            usb.ota_req = 0;
            if (flash_ok)
                ota_session();                  /* returns only if nothing was committed */
            update_screen(why);
        }
        if (usb.uboot_req)
            chip_boot();
    }
}

#include "host_frame.h"
/* USB host requests: the editor's SysEx (proto.c) before the update protocol's, the M-UPGRADE handshake and upgrade, the
 * chip boot SysEx. Run by the main loop, while the loading screen waits and for a second before the patches load, so a
 * host is answered from the start (and a patch that crashes the boot cannot keep a flasher out). */
static void host_poll(void)
{
    switch (host_frame()) {                         /* the editor's SysEx (proto.c), else the M-UPGRADE handshake (#486) */
    case HF_EDITOR:
        lk.ed_frames++;
        break;
    case HF_UPDATE:
        lk.up_frames++;
        break;
    }
    if (usb.ota_req) {                              /* M-UPGRADE upgrade command */
        usb.ota_req = 0;
        eng_run = 0;
        midi_in_quiet();                            /* the session does not drain MIDI in: TRS / USB events must not */
        if (flash_ok)                               /* fill the ring and hold the SysEx back (usb.c ep1_take, #177) */
            ota_session();                          /* returns only if nothing was committed */
        midi_in_resume();
        if (patches_up) {                           /* (before patch_boot: it loads them next) */
            if (m1_apply(m1_cur, m1_cur_len) == 0)
                m1_set_current(m1_cur, m1_cur_len);
            else
                preset_load(cur_preset);
        }
    }
    if (usb.uboot_req)                              /* SysEx F0 22 24 35 7D F7 from the host */
        chip_boot();
}

static void fm1_main(int update)                    /* update: the boot guard saw two failed boots */
{
    st_jedec = FL_FAR(fl_jedec_ram)();
    flash_ok = FL_JEDEC_OK(st_jedec);                   /* a known 1 MiB part (fm1_flash_id.h), else no store, no OTA staging */
    if (flash_ok)
        ota_boot_cleanup();                             /* staging area left by an update */
    lcd_init();
    splash_draw();                                      /* the loading screen: until the patches are up, and at least SPLASH_MS */
    t_splash = fm1_ms;
    boot_step("INPUT");
    fm1_input_init();
    fm1_adc_init();
    master_boot();
    boot_step("CORES");
    c1_boot(update);                                    /* the second core (#271): before the audio and the timers */
    boot_step("AUDIO");
    audio_init();
    boot_step("MIDI");
    uart_midi_init();                                   /* before TIMER5: PORTH read-modify-write */
    fm1_timer5_start(isr_timer5, 4);
    fm1_guard_lock_top();
    fm1_irq_enable_all();
    st_serve = st_jedec == ST_STEP_JEDEC;               /* store writes run in steps the interrupts get between (#656), on
                                                         * the chip whose suspend is known (#739: others write as before) */
    fm1_delay_ms(30);                                   /* the key scan has run: OCT- + OCT+ can be read */
#if FELUCCA_UAC
    if (update || (fm1_in.buttons & 3u) == 3u)          /* update mode: decided before the first attach, so the */
        usb_uac_switch(0);                              /* host only ever sees the MIDI-only device (usb.c) */
#endif
    boot_step("USB");
    usb_start();                                        /* (usb_poll in TIMER5 waits for usb.up, as with usb_retry) */
    if (update)
        update_only("TWO BOOTS IN A ROW FAILED");
    if ((fm1_in.buttons & 3u) == 3u)                    /* OCT- + OCT+ held at power-on */
        update_only("OCT- + OCT+ HELD AT POWER-ON");
    boot_step("HOST");
    {                                                   /* a second for a flasher before any patch loads (#70) */
        uint32_t t0 = fm1_ms;
        while (fm1_ms - t0 < 1000u) {
            fm1_wdt_feed();
            usb_retry(fm1_ms);
            host_poll();
        }
    }
    boot_step("STATE");
    boot_safe = (uint8_t)((fm1_in.buttons >> BTN_SAVE & 1u) || bootguard.failed >= 1u);   /* SAVE held, or the last boot failed */
    patch_boot();
    patches_up = 1;
    if (!flash_ok) {                                    /* a flash chip the firmware does not know: say so (#72) */
        boot_msg = "NO FLASH ID: NO UPDATES";
        boot_msg_ms = 8000;
    }
    while (fm1_ms - t_splash < SPLASH_MS) {             /* the screen stays up; the bar fills with the time; MIDI and the host */
        fm1_wdt_feed();                                 /* are served meanwhile (notes play, the editor and flasher get answers) */
        usb_retry(fm1_ms);
        midi_drain();
        host_poll();
        boot_step(BOOT_READY);
    }
    {   /* presses made while the loading screen was up are not commands: SAVE held for safe mode must not save the fallback
         * over the stored state. Dropped before the first page is drawn (#248): a press that starts once the page shows
         * waits in the HAL for the loop's first pass, so none is lost to the draw (about 120 ms on the device) */
        uint32_t rel;
        (void)fm1_input_edges(&rel);
        while (fm1_input_key_peek() >= 0)               /* (and the keys: the first pass plays those held now) */
            fm1_input_key_pop();
    }
    booting = 0;
    lcd_fill(0, 0, 240, 240, C_BG);
    batt_drawn = BATT_NONE;                             /* (the footer's battery too) */
    if (cfg.quick && !boot_safe)                        /* the quick start over the first page (D-247; not in safe mode) */
        help_open(HELP_QUICK);
    screen_idle();                                      /* the top bar and the page (under the quick start: dim around it) */
    if (boot_msg && help_on) {                          /* a boot message waits for the card to go */
        help_msg = boot_msg;
        help_msg_ms = boot_msg_ms;
    } else if (boot_msg)
        ui_msg(boot_msg, boot_msg_ms);
    leds_play();
    leds_avail();
    lcd_service = midi_yield;
    panel_yield = keys_yield;
    pages_waiting = encs_waiting;
    diag_alive = fm1_ms;
    diag_armed = 1;
    for (;;) {
        fm1_wdt_feed();
        diag_alive = fm1_ms;
        usb_retry(fm1_ms);
        if (fm1_ms > 30000u && bootguard.pending) {     /* a crash or hang in the first 30 s counts */
            bootguard.pending = 0;
            bootguard.failed = 0;
        }
        panel_status();
        midi_drain();
        keys_poll();
        keys_report();
        buttons_poll();
        knobs_poll();
        batt_poll();
        master_poll();
        seq_poll();
        panel_draw();
        keys_report();                                  /* (the edges taken during the redraw: keys_yield) */
        guide_poll();
        editor_poll();
        cpu_poll();
        c1_poll();
        host_poll();
        tempo_poll();
    }
}

void fm1_cstart(void)
{
    uint32_t *s, *d, p3, src, wdt;
    int update = 0;
    fm1_cpu1_halt();                            /* a second core left running by the reset would read the RAM cleared
                                                 * below (X0X's, after Jangada, fm1-x0x#10; #271) */
    fm1_time_init();
    fm1_reset_reason();
    p3 = fm1_boot.p3_rst;
    src = fm1_boot.rst_src;
    wdt = fm1_boot.wdt_con;
    fm1_wdt_arm(0x0D);
    if (bootguard.magic != BOOTGUARD_MAGIC) {
        bootguard.magic = BOOTGUARD_MAGIC;
        bootguard.failed = 0;
        bootguard.pending = 0;
    }
    if (bootguard.pending)
        bootguard.failed++;
    bootguard.pending = 1;
    if (bootguard.failed >= 2u) {                /* two in a row: update mode (USB + OTA only), not the chip's boot ROM */
        bootguard.failed = 0;
        bootguard.pending = 0;
        update = 1;
    }
    fm1_irq_init();
    for (d = _bss_start; d < _bss_end; d++)
        *d = 0;
    for (d = _pool_start; d < _pool_end; d++)
        *d = 0;
    lowram_prove();
    stack_paint(_ustack_lo, _ustack_top);
    stack_paint(_sstack_lo, _sstack_top);
    for (s = _data_load, d = _data_start; d < _data_end; s++, d++)
        *d = *s;
    for (s = _rt_load, d = _rt_start; d < _rt_end; s++, d++)
        *d = *s;                                /* flash driver code that must run from RAM */
    for (s = _c1_load, d = _c1_start; d < _c1_end; s++, d++)
        *d = *s;                                /* the second core's waiting loop (fm1_cpu1.h, #271) */
    fm1_mailbox_clear();
    diag_prev.p3 = p3;                          /* (diag_prev is in .bss: after the clear above) */
    diag_prev.src = src;
    diag_prev.wdt = wdt;
    if (diag.magic == DIAG_MAGIC)
        diag_prev.stall = diag;
    if (fm1_crash.magic == FM1_CRASH_MAGIC)
        diag_prev.crash = fm1_crash;
    fm1_crash.magic = 0;                        /* read once: the next report is a new crash */
    diag.magic = DIAG_MAGIC;
    diag.n = 0;
    fm1_guard_enable(FM1_GUARD_STACK | FM1_GUARD_WRITE | FM1_GUARD_BUS | FM1_GUARD_PC);
    fm1_boot.p3_rst = (uint8_t)p3;
    fm1_boot.rst_src = src;
    fm1_boot.wdt_con = (uint8_t)wdt;
    fm1_main(update);
    for (;;)
        ;
}
