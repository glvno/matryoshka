/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Modified for Modular-1 (morgulbrut). */
/* Boot and main loop, reduced from Felucca's: WDT, boot-loop guard, fatal vectors, then LCD, input (TIMER5
 * IRQ, 10 kHz), audio (ALNK0 IRQ), USB. Kept so the device can always be re-flashed: the OTA command, answered from a
 * second before any patch loads; the boot-loop guard (one failed boot -> safe mode with the fallback patch, two -> update
 * mode); OCT- + OCT+ held at power-on and MENU > UPDATE MODE -> update mode (USB + OTA only); the audio overload guard
 * (audio.c) keeps the main loop alive. The chip's mask-ROM mode only by its explicit SysEx (chip_boot). */
extern uint32_t _data_start[], _data_end[], _data_load[], _bss_start[], _bss_end[];
extern uint32_t _pool_start[], _pool_end[], _rt_start[], _rt_end[], _rt_load[];


void fm1_timer5_irq(void)
{
    static uint32_t sub, last, acc;
    uint32_t t0 = fm1_ticks();
    fm1_timer5_ack();
    fm1_input_tick();
    acc += t0 - last;                           /* milliseconds from the 24 MHz TIMER4 */
    last = t0;
    while (acc >= 1000u * FM1_TICKS_PER_US) {
        acc -= 1000u * FM1_TICKS_PER_US;
        fm1_ms++;
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

static void leds_octave(void);
static void leds_play(void);
static void panel_button(uint32_t b, int down);
static void panel_button_set(uint32_t b, int down, int from_panel);
static void midi_send(uint32_t status, uint32_t d1, uint32_t d2);
static uint8_t knob_touched, button_touched;
#define BTN_PLAY 12u                  /* PLAY: the transport; held, PRESET sets the tempo */
static uint8_t play_turned;                   /* PRESET turned the tempo while PLAY was held: its release does not start / stop */  /* the knob (1..6) / patch button (1..9) last moved: the player screen shows it */
static void page_set(uint32_t p);

/* proto.c hooks */
static int m1_flash_ok(void) { return flash_ok; }
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
    screen_idle();
    return rc;
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
 * MIDI channel, level, mute, the selected module */
#define SET_VERSION 1u
#define SET_LEN 12u
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
    d[10] = 0;
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
    screen_idle();
    if (patches_up)
        m1_slot_now(n, label_buf);                  /* the editor follows the slot (#65) */
    return 0;
}

static void preset_step(int32_t d)                  /* the PRESET knob: the next / previous occupied slot */
{
    uint32_t s = cur_preset, i;
    if (!bank_mask)
        return;
    for (i = 0; i < M1_SLOTS; i++) {
        s = (s + (d > 0 ? 1u : M1_SLOTS - 1u)) % M1_SLOTS;
        if (slot_used(s))
            break;
    }
    (void)preset_load(s);
}

/* proto.c hooks: the bank */
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
    settings_pack(set);
    (void)store_write(SL_SETTINGS, 0, set, SET_LEN);
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

static uint32_t midi_clk_ms;                    /* fm1_ms of the last MIDI clock tick (MIDI clock drives the clock while they come) */
static uint8_t midi_clk_seen;

/* a poly group's setting from a device page (pages_ui.c poly rows): voices, assign, legato, priority, unison, into the
 * group record of the running patch; the voices and unison are read at load: the engine loads the patch again */
static void poly_row_set(uint32_t mod, uint32_t field, int32_t v)
{
    int g = eng_module_group(mod);
    uint32_t at;
    if (g <= 0 || !m1_cur_len)
        return;
    at = 8u + ENG_GROUP_REC * (uint32_t)(g - 1);
    if (at + 4u > m1_cur_len)
        return;
    if (field == 0u)
        m1_cur[at] = (uint8_t)clampi(v, 1, ENG_MAX_PARTS);
    else if (field == 1u)
        m1_cur[at + 1u] = (uint8_t)clampi(v, 0, 2);
    else if (field == 2u)
        m1_cur[at + 2u] = (uint8_t)((m1_cur[at + 2u] & 0x80u) | (uint32_t)clampi(v, 0, 2));
    else if (field == 3u)
        m1_cur[at + 3u] = (uint8_t)clampi(v, 0, 2);
    else
        m1_cur[at + 2u] = (uint8_t)((m1_cur[at + 2u] & 0x7Fu) | (v ? 0x80u : 0u));
    m1_edited = 1;
    if (field == 0u || field == 4u)
        (void)eng_load(m1_cur, m1_cur_len);     /* (the parts sound again from the next note) */
    else
        (void)eng_poly_set((uint32_t)g - 1u, field, (uint32_t)v);
}

static void midi_drain(void)                    /* USB-MIDI events -> the engine */
{
    while (mi_r != mi_w) {
        uint32_t pkt = midi_in_q[mi_r % MQ], st = (pkt >> 8) & 0xF0u, n = (pkt >> 16) & 0x7Fu, v = pkt >> 24;
        RING_PUBLISH();
        mi_r++;
        uint32_t chn = ((pkt >> 8) & 15u) + 1u, redraw = 0;
        if (st == 0xF0u) {                      /* realtime (MENU > CLOCK IN): MIDI clock drives the clock, Start / Continue / Stop the transport */
            uint32_t rt = (pkt >> 8) & 0xFFu;
            if (!cfg.clock_in) {
            } else if (rt == 0xF8u) {
                if (!midi_clk_seen)
                    eng_clock_external(1);
                midi_clk_seen = 1;
                midi_clk_ms = fm1_ms;
                eng_clock_tick();
            } else if (rt == 0xFAu || rt == 0xFBu || rt == 0xFCu) {
                eng_transport(rt != 0xFCu);
                leds_play();
                if (!ui_dirty)
                    ui_dirty = 1;
            }
        } else if (st == 0x90u || st == 0x80u) {  /* notes on every channel: the engine judges them (a Voice allocator may take its own channel) */
            eng_midi_channel(cfg.ch);
            if (st == 0x90u && v)
                eng_note_on(n, (int32_t)(v * 65536u / 127u), chn);
            else
                eng_note_off(n, chn);
        } else if (!cfg.ch || cfg.ch == chn) {  /* other channel messages on the MIDI channel (MENU > MIDI CHANNEL; 0 = all) */
            if (st == 0xB0u && n == 123u) {
                eng_all_notes_off();
            } else if (st == 0xB0u && n == 1u) {        /* mod wheel: the Main module's mod output */
                eng_ctl(ENG_CTL_MOD, (int32_t)(v * 65536u / 127u));
            } else if (st == 0xB0u && n >= 16u && n <= 19u) {   /* CC 16..19: K1..K4, the rows of the device page in focus */
                uint32_t mod, par;
                int32_t val, r = pages_set_unit(n - 16u, (int32_t)(v * 65536u / 127u), &mod, &par, &val);
                if (r >= 0) {
                    if (r == 1)
                        poly_row_set(mod, par & 0x7Fu, val);
                    else {
                        eng_set_param(mod, par, val);
                        m1_patch_param(mod, par, val);
                    }
                    m1_param_now(mod, par, r == 1 ? val << 16 : val);
                    if (!ui_dirty)
                        ui_dirty = 1;
                }
            } else if (st == 0xB0u && n == 22u) {      /* CC 22: the Main module's MORPH */
                int m = eng_find(T_FM1);
                if (m >= 0) {
                    eng_set_param((uint32_t)m, FM1_P_MORPH, (int32_t)(v * 65536u / 127u));
                    m1_patch_param((uint32_t)m, FM1_P_MORPH, (int32_t)(v * 65536u / 127u));
                }
            } else if (st == 0xB0u && n >= 80u && n < 80u + ENG_PANEL_BUTTONS) {   /* CC 80..88: the patch buttons (64 and up: down) */
                panel_button_set(n - 80u, v >= 64u, 0);
            } else if (st == 0xE0u) {                   /* pitch bend: +-2 semitones on the pitch, and the bend output */
                eng_ctl(ENG_CTL_BEND, ((int32_t)(v << 7 | n) - 8192) << 3);
            } else if (st == 0xD0u) {                   /* channel aftertouch: the at output */
                eng_ctl(ENG_CTL_AT, (int32_t)(n * 65536u / 127u));
            } else if (st == 0xC0u && cfg.prog_chg && slot_used(n)) {   /* program change n: bank slot n (an empty one: nothing) */
                preset_load(n);
                redraw = 1;
            }
            if (redraw)
                screen_idle();
        }
    }
    midi_in_overflow = 0;
    if (midi_clk_seen && fm1_ms - midi_clk_ms > 500u) {   /* half a second without MIDI clock: the Main module's tempo again */
        midi_clk_seen = 0;
        eng_clock_external(0);
    }
}

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
    }
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

static void knobs_poll(void)
{
    static uint32_t last_ms[6];
    int32_t st[7];
    uint32_t k;
    int panel = eng_find(T_FM1);
    for (k = 0; k < 7u; k++)
        st[k] = fm1_enc_take(k);
    if (page == PAGE_MENU) {                        /* the settings menu: ALGO tabs, PRESET rows, K1..K4 the value */
        menu_knobs(st);
        return;
    }
    if (st[6] && (fm1_in.buttons >> BTN_PLAY & 1u)) {   /* PLAY held + PRESET: the tempo (the Main module's), 1 bpm a click */
        play_turned = 1;
        if (panel >= 0 && !eng_clock_is_external()) {
            char m[16], num[8];
            int32_t bpm = (eng_get_param((uint32_t)panel, FM1_P_TEMPO) + 32768) >> 16;
            bpm = clampi(bpm + st[6] * (cfg.accel && fm1_ms - last_ms[0] < 80u ? 5 : 1), 20, 300);
            last_ms[0] = fm1_ms;
            eng_set_param((uint32_t)panel, FM1_P_TEMPO, bpm << 16);
            m1_patch_param((uint32_t)panel, FM1_P_TEMPO, bpm << 16);
            fmt_int(num, bpm);
            put(put(m, "TEMPO "), num)[0] = 0;
            ui_msg(m, 1000);
            if (!ui_dirty)
                ui_dirty = 1;
        } else if (panel >= 0) {
            ui_msg("TEMPO: MIDI CLOCK", 1000);
        }
        return;
    }
    if (st[6]) {
        preset_step(st[6]);
        return;
    }
    if (page == PAGE_SEQ) {                         /* the SEQ page: ALGO picks the track, SELECT with a step held its chance */
        if (st[1] && eng_steps_count())
            seq_select((uint32_t)((seq_trk + (uint32_t)eng_steps_count() * 8u + (uint32_t)st[1]) % (uint32_t)eng_steps_count()));
        st[1] = 0;
        if (st[0] && seq_held >= 0) {
            seq_chance(st[0]);
            st[0] = 0;
        }
        if ((st[2] || st[3]) && seq_held >= 0) {   /* K1 / K2 with a step held: its note / velocity (not the Main knobs) */
            seq_value(st[2], st[3], cfg.accel && fm1_ms - last_ms[1] < 80u);
            last_ms[1] = fm1_ms;
            st[2] = st[3] = 0;
        }
    }
    if (page != 0)
        return;
    if (pages_select(st[0]) | pages_page(st[1])) {  /* SELECT: the device, ALGO: its page (the editor follows) */
        m1_focus_now(pg_cur_dev, pg_cur_page);
        ui_dirty = 2;
    }
    for (k = 0; k < 4u; k++) {                      /* K1..K4: the rows of the page in focus, relative */
        uint32_t mod, par;
        int32_t v, c = st[2u + k], r;
        if (!c || (r = pages_turn(k, c, cfg.accel && fm1_ms - last_ms[2u + k] < 80u, &mod, &par, &v)) < 0)
            continue;
        last_ms[2u + k] = fm1_ms;
        if (r == 1)
            poly_row_set(mod, par & 0x7Fu, v);      /* a poly group's setting (the Voice allocator's in the editor) */
        else {
            eng_set_param(mod, par, v);
            m1_patch_param(mod, par, v);
        }
        m1_param_now(mod, par, r == 1 ? v << 16 : v);   /* the editor follows (Live) */
        midi_send(0xB0u, 16u + k, pages_cc(k));
        if (!ui_dirty)
            ui_dirty = 1;
    }
    (void)panel;
}

/* USB MIDI out (MENU > MIDI OUT): the keys as notes (velocity 100), K1..K4 as CC 16..19 (their rows' positions), the patch buttons as CC 80..86
 * (127 / 0), on the MIDI channel (omni: channel 1). Only what the panel does goes out, never what came in. */
static void midi_send(uint32_t status, uint32_t d1, uint32_t d2)
{
    uint32_t st = status | (cfg.ch ? cfg.ch - 1u : 0u);
    if (!cfg.midi_out)
        return;
    midi_out_event((st >> 4) | st << 8 | (d1 & 127u) << 16 | (d2 & 127u) << 24);
}

static uint8_t key_note[27];                     /* the note each held key started, so a release (or an octave change in between) ends the right one */
static uint32_t key_sounding;                    /* bit n: key n started a note (not a key pressed on the SEQ page) */
static uint8_t seq_held_used;                    /* SEQ is held and a black key muted a track: its release does not switch the page */
static void keys_poll(void)                     /* the FM-1's 27 keys (bit 0 = F3 = MIDI 53), shifted by the octave, -> the engine */
{
    static uint32_t prev;
    uint32_t now = fm1_in.notes, diff, n;
    diff = now ^ prev;
    prev = now;
    if (diff)
        eng_midi_channel(cfg.ch);
    for (n = 0; diff && n < 27u; n++) {
        if (!(diff & (1u << n)))
            continue;
        diff &= ~(1u << n);
        if ((now & (1u << n)) && (fm1_in.buttons >> BTN_SEQ & 1u) && seq_black(n) >= 0) {   /* SEQ held + a black key: a mute */
            seq_mute_key(n);
            seq_held_used = 1;
            continue;
        }
        if (!(key_sounding & (1u << n)) && (page == PAGE_SEQ || !(now & (1u << n)))) {   /* the SEQ page: steps and tracks */
            if (page == PAGE_SEQ)
                seq_key(n, (int)(now >> n & 1u));
            continue;
        }
        if (now & (1u << n)) {
            int32_t note = 53 + (int32_t)n + 12 * octave;
            key_note[n] = (uint8_t)(note < 0 ? 0 : note > 127 ? 127 : note);
            key_sounding |= 1u << n;
            eng_note_on(key_note[n], ENG_ONE, cfg.ch ? cfg.ch : 1u);   /* the panel plays on the device's channel */
            midi_send(0x90u, key_note[n], 100u);
        } else {
            key_sounding &= ~(1u << n);
            eng_note_off(key_note[n], cfg.ch ? cfg.ch : 1u);
            midi_send(0x80u, key_note[n], 0u);
        }
    }
}

/* PLAY: red while the transport is stopped, green while it runs. The green LED sits at matrix column 8, row bit 1,
 * where there is no key (found on the hardware by Felucca); the red one is PLAY's own. */
/* the patch buttons (the Main module's outputs fx .. rec, engine.h ENG_PANEL_BUTTONS): their matrix ids, M-VAVE's order */
static const uint8_t PANEL_BTN_ID[ENG_PANEL_BUTTONS] = {2, 3, 4, 5, 6, 7, 10};   /* (SEQ 11 and REC 13: the step page, seq_ui.c) */
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
    uint32_t b, mask = eng_buttons_get();
    for (b = 0; b < ENG_PANEL_BUTTONS; b++)
        fm1_led_key(PANEL_BTN_ID[b], (int)(mask >> b & 1u));
}

/* a patch button pressed / let go (index into PANEL_BTN_ID): a switching one flips on the press, the others act while held;
 * a switch is kept in the patch (SAVE stores it) */
static void panel_button(uint32_t b, int down) { panel_button_set(b, down, 1); }
static void panel_button_set(uint32_t b, int down, int from_panel)
{
    const uint8_t *pn = m1_panel();
    uint32_t tog = pn ? (uint32_t)pn[0] | (uint32_t)pn[1] << 8 : 0u, mask = eng_buttons_get(), was = mask;
    if (tog >> b & 1u) {
        if (down)
            mask ^= 1u << b;
    } else {
        mask = down ? mask | 1u << b : mask & ~(1u << b);
    }
    if (mask == was)
        return;
    eng_buttons(mask);
    if (tog >> b & 1u)
        m1_panel_on(mask & tog);
    if (from_panel)
        midi_send(0xB0u, 80u + b, (mask >> b & 1u) ? 127u : 0u);
    leds_panel();
    if (down) {
        button_touched = (uint8_t)(b + 1u);
        if (!ui_dirty)
            ui_dirty = 1;
    }
}

static void page_set(uint32_t p)    /* the same button again goes back to the module page */
{
    page = (uint8_t)(page == p ? 0u : p);
    if (page == PAGE_MENU)
        menu_open();
    if (page != PAGE_SEQ) {                         /* (leaving the SEQ page ends live recording) */
        seq_rec = 0;
        seq_leds_off();
    }
    header_draw();
    leds_play();
    lcd_fill(0, BAR_H, 240, 240u - BAR_H, C_BG);
    view_draw(1);
}

static void play_toggle(void)                       /* PLAY: the transport (the Main module's run output and clock) */
{
    eng_transport(!eng_transport_running());
    leds_play();
    ui_dirty = ui_dirty ? ui_dirty : 1;
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

/* The device's own buttons (matrix ids, M-VAVE's fm1_open order): OCT- 0, OCT+ 1: octave; SAVE 9: write the patch into its slot;
 * HOME 8: tap = the legend, held = the menu; PLAY 12: the transport. The others are the patch's (PANEL_BTN_ID). */
#define BTN_OCT_DOWN 0u
#define BTN_OCT_UP 1u
#define BTN_SAVE 9u
#define BTN_HOME 8u

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

/* HOME tapped: from another page back to the device page; on a device page back to the first device; there the legend
 * (and from the legend back) */
static void home_press(void)
{
    if (page == PAGE_LEGEND || page == PAGE_SEQ) {
        page_set(page);
        return;
    }
    if (pages_focus(0, 0)) {
        m1_focus_now(0, 0);
        ui_dirty = 2;
        return;
    }
    page_set(PAGE_LEGEND);
}

/* proto.c: the editor shows another device page (FOCUS) */
static void m1_focus(uint32_t dev, uint32_t pg)
{
    if (pages_focus(dev, pg) && page == 0)
        ui_dirty = 2;
}
static void m1_ui_changed(void) { ui_dirty = 2; }    /* proto.c: the editor bypassed a module: title and picture */

static void buttons_poll(void)
{
    static uint32_t home_t0;                        /* fm1_ms | 1 of the HOME press, 0: not held; bit 1: the hold fired */
    uint32_t rel, p = fm1_input_edges(&rel);
    if (page == PAGE_MENU) {                        /* the menu: OCT- / OCT+ step the selected row's value */
        if (p & (1u << BTN_OCT_DOWN))
            menu_set_row(menu_sel, -1);
        if (p & (1u << BTN_OCT_UP))
            menu_set_row(menu_sel, 1);
        p &= ~((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP));
    }
    if (page == PAGE_SEQ) {                         /* the SEQ page: OCT- / OCT+ page through a long track, ENV is the accent key */
        if (p & (1u << BTN_OCT_DOWN))
            seq_page_step(-1);
        if (p & (1u << BTN_OCT_UP))
            seq_page_step(1);
        p &= ~((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP) | (1u << BTN_ENV));
    }
    if (p & (1u << BTN_SEQ))                        /* SEQ acts on release, unless a black key muted a track meanwhile */
        seq_held_used = 0;
    if ((rel & (1u << BTN_SEQ)) && !seq_held_used)
        page_set(PAGE_SEQ);
    if (p & (1u << BTN_REC)) {                      /* REC: live recording, on the SEQ page */
        if (page != PAGE_SEQ)
            page_set(PAGE_SEQ);
        seq_rec_toggle();
    }
    if (p & (1u << BTN_OCT_DOWN))
        octave = octave > -3 ? octave - 1 : octave;
    if (p & (1u << BTN_OCT_UP))
        octave = octave < 3 ? octave + 1 : octave;
    if (p & ((1u << BTN_OCT_DOWN) | (1u << BTN_OCT_UP))) {
        leds_octave();
        {
            char m[12], num[8], *q = m;
            q = put(q, "OCTAVE ");
            if (octave > 0)
                *q++ = '+';
            fmt_int(num, octave);
            put(q, num);
            ui_msg(m, 1000);
        }
    }
    if (p & (1u << BTN_SAVE))
        save_state();
    {
        uint32_t b;
        for (b = 0; b < ENG_PANEL_BUTTONS; b++) {
            if (p >> PANEL_BTN_ID[b] & 1u)
                panel_button(b, 1);
            if (rel >> PANEL_BTN_ID[b] & 1u)
                panel_button(b, 0);
        }
    }
    if (p & (1u << BTN_HOME))
        home_t0 = (fm1_ms & ~3u) | 1u;              /* HOME acts on release: a tap goes home, 0.7 s held opens the menu
                                                     * (bit 1 cleared: with fm1_ms's own bit 1 a press looked fired) */
    if (home_t0 && !(home_t0 & 2u) && (fm1_in.buttons >> BTN_HOME & 1u) && fm1_ms - (home_t0 & ~3u) > 700u) {
        home_t0 |= 2u;
        page_set(PAGE_MENU);                        /* (closes it when it is open) */
    }
    if (rel & (1u << BTN_HOME)) {
        if (home_t0 && !(home_t0 & 2u)) {
            if (page == PAGE_MENU)
                page_set(PAGE_MENU);                /* a tap closes the menu */
            else
                home_press();
        }
        home_t0 = 0;
    }
    if (p & (1u << BTN_PLAY))                       /* PLAY acts on release, unless PRESET turned the tempo meanwhile */
        play_turned = 0;
    if ((rel & (1u << BTN_PLAY)) && !play_turned)
        play_toggle();
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
        if (flash_ok)
            ota_session();                          /* returns only if nothing was committed */
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
    boot_step("USB");
    usb_start();
    boot_step("MIDI");
    uart_midi_init();                                   /* before TIMER5: PORTH read-modify-write */
    fm1_timer5_start(isr_timer5, 4);
    fm1_guard_lock_top();
    fm1_irq_enable_all();
    fm1_delay_ms(30);
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
    screen_idle();                                      /* the top bar and the page */
    if (boot_msg)
        ui_msg(boot_msg, boot_msg_ms);
    leds_play();
    leds_avail();
    {   /* presses while booting are not commands: SAVE held for safe mode must not save the fallback over the stored state */
        uint32_t rel;
        (void)fm1_input_edges(&rel);
    }
    for (;;) {
        static uint8_t ovl_seen;
        static uint32_t shed_seen;
        fm1_wdt_feed();
        usb_retry(fm1_ms);
        if (fm1_ms > 30000u && bootguard.pending) {     /* a crash or hang in the first 30 s counts */
            bootguard.pending = 0;
            bootguard.failed = 0;
        }
        if (knob_touched || button_touched) {           /* what was just moved, in the bar for a second */
            char m[40], name[16], num[12], *q = m;
            (void)num;
            if (!knob_touched) {
                uint32_t b = button_touched - 1u;
                if (!panel_label(b, name))
                    put(name, PANEL_BTN_NAME[b])[0] = 0;
                q = put(q, name);
                q = put(q, eng_buttons_get() >> b & 1u ? " ON" : " OFF");
            }
            *q = 0;
            if (page == 0 && !knob_touched)
                ui_msg(m, 1000);
            knob_touched = button_touched = 0;
        }
        {                                               /* the beat on the player screen while the transport runs */
            static uint32_t beat_seen;
            uint32_t beat = eng_transport_running() ? eng_ticks() / 6u : 0u;
            if (beat != beat_seen && page == 0) {
                beat_seen = beat;
                if (!ui_dirty)
                    ui_dirty = 1;
            }
        }
        if (eng_overload != ovl_seen) {                 /* audio.c's overload guard: muted, or a part fewer */
            ovl_seen = eng_overload;
            header_draw();
        } else if (eng_shed_count != shed_seen) {
            shed_seen = eng_shed_count;
            if (shed_seen)
                ui_msg("OVERLOAD: A PART LESS", 1500);
        }
        if (page == 0 && pages_expired())             /* a toast ended: the picture comes back */
            ui_dirty = ui_dirty ? ui_dirty : 1;
        {                                               /* the live ticks of modulated rows, ten times a second */
            static uint32_t tick_ms;
            if (page == 0 && !ui_dirty && fm1_ms - tick_ms >= 100u) {
                tick_ms = fm1_ms;
                pages_ticks();
            }
        }
        midi_drain();
        keys_poll();
        buttons_poll();
        knobs_poll();
        master_poll();
        seq_poll();
        {
            if (msg_until && fm1_ms >= msg_until)
                ui_msg_clear();
            if (ui_dirty) {
                int full = ui_dirty > 1;
                ui_dirty = 0;
                view_draw(full);
            }
            cpu_poll();
        }
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
    fm1_guard_enable(FM1_GUARD_STACK | FM1_GUARD_WRITE | FM1_GUARD_BUS | FM1_GUARD_PC);
    fm1_boot.p3_rst = (uint8_t)p3;
    fm1_boot.rst_src = src;
    fm1_boot.wdt_con = (uint8_t)wdt;
    fm1_main(update);
    for (;;)
        ;
}
