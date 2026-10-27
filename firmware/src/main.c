/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Modular-1 (morgulbrut) and Matryoshka (glvno). */
/* Boot and main loop, reduced from Felucca's: WDT, boot-loop guard, fatal vectors, then LCD, input (TIMER5
 * IRQ, 10 kHz), audio (ALNK0 IRQ), USB. Kept so the device can always be re-flashed: the OTA command, answered from a
 * second before any patch loads; the boot-loop guard (one failed boot -> safe mode with the fallback patch, two -> update
 * mode); OCT- + OCT+ held at power-on and MENU > UPDATE MODE -> update mode (USB + OTA only); the audio overload guard
 * (audio.c) keeps the main loop alive. The chip's mask-ROM mode only by its explicit SysEx (chip_boot). */
extern uint32_t _data_start[], _data_end[], _data_load[], _bss_start[], _bss_end[];
extern uint32_t _pool_start[], _pool_end[], _rt_start[], _rt_end[], _rt_load[];


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
 *        started, 0xFFFFFFFF: none yet), fill_hi */
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
    if (page >= 120u && page <= 123u)                    /* the draw times (ui.c ui_time_diag) */
        return ui_time_diag(page, out);
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

/* the settings record: version, slot, octave + 8, LED mode, knob accel, CPU in the bar, clock in, program change,
 * MIDI channel, MIDI out, the bank's format, the selected module */
#define SET_VERSION 1u
#define SET_LEN 12u
/* the patch format the bank's untouched factory slots were brought to (settings byte 10; 0 in a record from before):
 * below ENG_PATCH_VERSION, the boot rewrites them once (bank_upgrade) */
static uint8_t bank_fmt;
static void settings_pack(uint8_t *d)
{
    d[0] = SET_VERSION;
    d[1] = (uint8_t)cur_preset;
    d[2] = (uint8_t)(octave + 8);
    d[3] = cfg.leds;
    d[4] = cfg.accel;
    d[5] = cfg.cpu_bar;
    d[6] = cfg.clock_in;
    d[7] = cfg.prog_chg;
    d[8] = cfg.ch;
    d[9] = cfg.midi_out;                        /* (was the mixer's level before #60: values over 1 read as on) */
    d[10] = bank_fmt;
    d[11] = (uint8_t)sel;
}
static int settings_unpack(const uint8_t *d, uint32_t len, uint32_t *slot, uint32_t *module)
{
    if (len < SET_LEN || d[0] != SET_VERSION)
        return -1;
    *slot = d[1];
    octave = clampi((int32_t)d[2] - 8, -3, 3);
    cfg.leds = d[3] > 2u ? 2u : d[3];
    cfg.accel = d[4] & 1u;
    cfg.clock_in = d[6] & 1u;                   /* (bytes 5 and 7, CPU in the bar and program change, are no longer settings) */
    cfg.ch = d[8] > 16u ? 0u : d[8];
    cfg.midi_out = d[9] == 0u ? 0u : 1u;
    bank_fmt = d[10];
    *module = d[11];
    return 0;
}

/* a store write: the erase and program windows have the IRQs off, so no audio meanwhile */
static int store_write(uint32_t id, const char *name, const uint8_t *p, uint32_t len)
{
    int rc;
    if (!flash_ok)
        return -1;
    eng_run = 0;
    rc = sl_write(id, name, p, len);
    eng_resume();
    return rc;
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
    if (patches_up)
        m1_slot_now(n, label_buf);                  /* the editor follows the slot (#65) */
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
    eng_run = 0;
    rc = ps_put(structure, name, vals, n);
    eng_resume();
    return rc;
}
static int m1_preset_del(uint32_t structure, const char *name)
{
    int rc;
    if (!flash_ok)
        return -1;
    eng_run = 0;
    rc = ps_del(structure, name);
    eng_resume();
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
    eng_run = 0;
    rc = sl_erase(slot);
    eng_resume();
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
 * so untouched since the factory bank or FACTORY RESET) gets today's patch of that name, in today's format (format 34's
 * extras: presets, the environment); the slot keeps its name, anything edited and saved stays as it is. Once per format
 * (bank_fmt). Returns how many slots were rewritten */
static uint32_t bank_upgrade(void)
{
    uint32_t s, k, len, h, n = 0;
    char name[M1_NAME + 1];
    boot_step("FACTORY PATCHES");
    for (s = 0; s < M1_SLOTS; s++) {
        if (!slot_used(s))
            continue;
        fm1_wdt_feed();
        for (k = 0; k <= M1_NAME; k++)
            name[k] = 0;
        if (sl_read(s, m1_up, &len, name) || len < 8u || m1_up[0] != 0xA1u || m1_up[1] >= ENG_PATCH_VERSION)
            continue;
        h = fnv32(m1_up, len);
        for (k = 0; k < N_LEGACY_FACTORY; k++)
            if (LEGACY_FACTORY[k].fnv == h && LEGACY_FACTORY[k].len == len)
                break;
        if (k < N_LEGACY_FACTORY && store_write(s, name, PRESET_LIST[LEGACY_FACTORY[k].now].data, PRESET_LIST[LEGACY_FACTORY[k].now].len) == 0)
            n++;
    }
    bank_fmt = ENG_PATCH_VERSION;
    return n;
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
    if (boot_safe || !flash_ok) {
        fallback_boot();
        if (boot_safe) {
            boot_msg = "SAFE MODE: FALLBACK PATCH";
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
        if (bank_fmt < ENG_PATCH_VERSION) {           /* the first boot after an update that changed the format */
            uint32_t n = bank_upgrade();
            cur_preset = slot;
            sel = module;
            settings_pack(set);
            (void)store_write(SL_SETTINGS, 0, set, SET_LEN);
            if (n) {
                boot_msg = "FACTORY PATCHES UPDATED";
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
    if (cfg.midi_out)
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
        fm1_led_key(PANEL_BTN_ID[b], (int)(mask >> b & 1u) || (b == BTN_GLO_IDX && page == PAGE_GLO) || (b == BTN_ENV_IDX && page == PAGE_ENV));   /* (GLO, ENV: lit on their pages) */
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
/* k 0xFF: the head (texts, the page, flags: bit 0 sandbox mode, bit 1 the boot screen), else text k (x, y, w, h, n, text) */
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
        return 3;
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
    uint32_t p;
    tp_on = 1;
    p = tp_peak;
    tp_peak = 0;
    return (p > 0xFFFFu ? 0xFFFFu : p) | (eng_run ? 1u << 16 : 0u) | (snd_muted ? 1u << 17 : 0u) | (master_q12 < 64u ? 1u << 18 : 0u);
}

/* The chip's mask-ROM download mode (USB "WL80UBOOT", 4C4A:8057): only the explicit SysEx F0 22 24 35 7D F7 gets here. No
 * tool of this project (nor M-VAVE's web updater) talks to that mode: jl-uboot-tool / FM-1 Transporter do. A power cycle
 * should start the firmware again (not verified). */
static void chip_boot(void)
{
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

/* USB host requests: the editor's SysEx (proto.c) before the update protocol's, the M-UPGRADE handshake and upgrade, the
 * chip boot SysEx. Run by the main loop, while the loading screen waits and for a second before the patches load, so a
 * host is answered from the start (and a patch that crashes the boot cannot keep a flasher out). */
static void host_poll(void)
{
    {   /* the editor's SysEx (proto.c) before the update protocol's */
        const uint8_t *fp;
        uint32_t fn;
        if (ota_frame_get(&fp, &fn) && m1_handle(fp, fn))
            ota_frame_done();
    }
    ota_service();                                  /* M-UPGRADE handshake */
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
    flash_ok = FL_FAR(fl_jedec_ram)() == 0x856014u;     /* the expected 1 MiB part, else no OTA staging */
    if (flash_ok)
        ota_boot_cleanup();                             /* staging area left by an update */
    lcd_init();
    splash_draw();                                      /* the loading screen: until the patches are up, and at least SPLASH_MS */
    t_splash = fm1_ms;
    boot_step("INPUT");
    fm1_input_init();
    fm1_adc_init();
    master_boot();
    boot_step("AUDIO");
    audio_init();
    boot_step("MIDI");
    uart_midi_init();                                   /* before TIMER5: PORTH read-modify-write */
    fm1_timer5_start(isr_timer5, 4);
    fm1_guard_lock_top();
    fm1_irq_enable_all();
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
    if (!flash_ok) {                                    /* another flash chip than the one OTA knows: say so (#72) */
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
    booting = 0;
    lcd_fill(0, 0, 240, 240, C_BG);
    batt_drawn = BATT_NONE;                             /* (the footer's battery too) */
    screen_idle();                                      /* the top bar and the page */
    if (boot_msg)
        ui_msg(boot_msg, boot_msg_ms);
    leds_play();
    leds_avail();
    {   /* presses while booting are not commands: SAVE held for safe mode must not save the fallback over the stored state */
        uint32_t rel;
        (void)fm1_input_edges(&rel);
        while (fm1_input_key_peek() >= 0)               /* (and the keys: the first pass plays those held now) */
            fm1_input_key_pop();
    }
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
        buttons_poll();
        knobs_poll();
        batt_poll();
        master_poll();
        seq_poll();
        panel_draw();
        cpu_poll();
        host_poll();
    }
}

void fm1_cstart(void)
{
    uint32_t *s, *d, p3, src, wdt;
    int update = 0;
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
    for (s = _data_load, d = _data_start; d < _data_end; s++, d++)
        *d = *s;
    for (s = _rt_load, d = _rt_start; d < _rt_end; s++, d++)
        *d = *s;                                /* flash driver code that must run from RAM */
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
