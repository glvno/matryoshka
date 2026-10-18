//! The smoke test: our firmware on the emulated FM-1, driven through its panel and the TRS
//! MIDI input, judged by what the LCD shows (the firmware's own font, font.rs), the audio it
//! makes and the flash it writes. No symbols needed: it runs on the release binary.
//!
//! 1. boot: the loading screen, then the main page of factory patch 0
//! 2. sound: silent without keys, a note on a panel key, silent again after the release
//! 3. pages: GLO, ENV, ARP, SEQ, LFO, HOME, HOME held (the menu), HOME again
//! 4. PRESET encoder: forward, forward, back
//! 5. TRS MIDI: program change, a note, then every factory patch in turn (name + sound)
//! 6. SAVE: patch, octave; the flash kept, a restart, STATE RESTORED and the state back
//! 7. the preset bank: three slots (and one with a bad CRC) written straight into the flash,
//!    PRESET and program change step through the three, wrapping
//! 8. safety: a patch far over the CPU budget sheds parts, one with nothing to shed is muted (OVERLOAD) and the
//!    next patch plays again; SAVE held at power-on = safe mode (the built-in fallback patch, not the bank); OCT- +
//!    OCT+ held at power-on and MENU > UPDATE MODE = update mode (no engine)
//! 9. hardware the emulator does not model: any register besides P33 fails the test
//!
//! Snapshots of every step go to OUT (PNG); a WAV of the first run too.

use crate::font;
use crate::machine::Machine;
use std::process::ExitCode;

/// The FM-1's I2S rate (fm1_open's fm1_audio.h: 44118 Hz).
pub const AUDIO_RATE: u32 = 44118;

const PRESETS_H: &str = include_str!("../../../firmware/src/presets.h");

/// Panel ids (fm1-emu / Felucca's table, confirmed by M-VAVE's fm1_open)
const OCT_DOWN: u8 = 0;
const OCT_UP: u8 = 1;
const SEL: u8 = 3;
const ENV: u8 = 4;
const LFO: u8 = 5;
const GLO: u8 = 7;
const HOME: u8 = 8;
const SAVE: u8 = 9;
const ARP: u8 = 10;
const SEQ: u8 = 11;
const C4: u8 = 14 + 7; // note keys start at F3
const PRESET: u8 = 6; // encoder
const ALGO: u8 = 1; // encoder
const K1: u8 = 2;

/// Below this the output counts as silent, above `LOUD` as sounding (16-bit samples).
const QUIET: i32 = 64;
const LOUD: i32 = 1000;

/// (name, binary) of every factory patch in presets.h
fn factory() -> Vec<(String, Vec<u8>)> {
    let list = &PRESETS_H[PRESETS_H.find("PRESET_LIST[").expect("PRESET_LIST")..];
    let mut out = Vec::new();
    for line in list.lines().skip(1) {
        let Some(rest) = line.trim().strip_prefix("{\"") else { break };
        let name = &rest[..rest.find('"').unwrap()];
        let arr = rest[rest.find(", PRESET_").unwrap() + 2..].split(',').next().unwrap().trim();
        let def = format!("static const uint8_t {arr}[");
        let d = &PRESETS_H[PRESETS_H.find(&def).unwrap_or_else(|| panic!("{arr}"))..];
        let body = &d[d.find('{').unwrap() + 1..d.find('}').unwrap()];
        let bytes = body.split(',').filter_map(|t| t.trim().parse::<u8>().ok()).collect();
        out.push((name.to_string(), bytes));
    }
    out
}

struct Run {
    out: String,
    fails: Vec<String>,
    warns: Vec<String>,
    checks: u32,
    shot: u32,
}

impl Run {
    fn check(&mut self, what: &str, ok: bool, detail: String) {
        self.checks += 1;
        let line = if detail.is_empty() { what.to_string() } else { format!("{what} ({detail})") };
        println!("{} {line}", if ok { "ok  " } else { "FAIL" });
        if !ok {
            self.fails.push(line);
        }
    }

    /// A difference from the reference engine: reported, not failed (see `--strict`).
    fn warn(&mut self, what: &str, ok: bool, detail: String) {
        let line = if detail.is_empty() { what.to_string() } else { format!("{what} ({detail})") };
        println!("{} {line}", if ok { "ok  " } else { "WARN" });
        if !ok {
            self.warns.push(line);
        }
    }

    fn snap(&mut self, m: &Machine, name: &str) {
        self.shot += 1;
        m.snap(&format!("{}/{:02}-{name}.png", self.out, self.shot));
    }

    /// `s` on the screen now; snapshot either way.
    fn screen(&mut self, m: &Machine, what: &str, s: &str) -> bool {
        let ok = font::on_screen(m.lcd(), s);
        self.snap(m, &what.replace(' ', "-"));
        self.check(what, ok, if ok { String::new() } else { format!("{s:?} not on the LCD at {} ms", m.ms()) });
        ok
    }
}

/// Run up to `max` ms more until `s` shows (checked every 50 ms).
fn wait_text(m: &mut Machine, s: &str, max: u64) -> Result<bool, String> {
    let end = m.ms() + max;
    while m.ms() < end {
        if font::on_screen(m.lcd(), s) {
            return Ok(true);
        }
        m.run_for(50)?;
    }
    Ok(font::on_screen(m.lcd(), s))
}

/// The CPU figure at the right of the top bar ("11%"), if one is drawn.
fn cpu_figure(m: &Machine) -> Option<u32> {
    (0..=100).rev().find(|n| [2, 3].iter().any(|&z| font::find(m.lcd(), &format!("{n}%"), z).is_some_and(|(x, y, ..)| y < 24 && x > 150)))
}

/// Peak of a note held for `hold` ms (from now).
fn note_peak(m: &mut Machine, key: u8, hold: u64) -> Result<i32, String> {
    let mk = m.mark();
    m.key(key, true);
    m.run_for(hold)?;
    m.key(key, false);
    Ok(m.peak_since(mk))
}

fn midi_note_peak(m: &mut Machine, note: u8, hold: u64) -> Result<i32, String> {
    let mk = m.mark();
    m.midi(&[0x90, note, 100], hold)?;
    let p = m.peak_since(mk);
    m.midi(&[0x80, note, 0], 0)?;
    Ok(p)
}

/// Wait for silence (a delay or reverb tail may ring): up to `max` ms, in 250 ms windows.
fn settles(m: &mut Machine, max: u64) -> Result<bool, String> {
    let end = m.ms() + max;
    while m.ms() < end {
        let mk = m.mark();
        m.run_for(250)?;
        if m.peak_since(mk) < QUIET {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A preset-bank slot (firmware/src/slotstore.c): header at the sector start, the patch at +256.
fn slot_sector(slot: u32, name: &str, patch: &[u8], bad_crc: bool) -> Vec<u8> {
    let mut crc = 0xffffu32;
    for &b in patch {
        crc ^= (b as u32) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { ((crc << 1) ^ 0x1021) & 0xffff } else { (crc << 1) & 0xffff };
        }
    }
    if bad_crc {
        crc ^= 1;
    }
    let mut s = vec![0xffu8; 0x1000];
    let mut h = Vec::new();
    h.extend_from_slice(&0x4C53_314Du32.to_le_bytes()); // "M1SL"
    h.extend_from_slice(&slot.to_le_bytes());
    h.extend_from_slice(&(patch.len() as u32).to_le_bytes());
    h.extend_from_slice(&crc.to_le_bytes());
    let mut n = [0u8; 20];
    n[..name.len()].copy_from_slice(name.as_bytes());
    h.extend_from_slice(&n);
    h.extend_from_slice(&[0u8; 12]);
    s[..48].copy_from_slice(&h);
    s[256..256 + patch.len()].copy_from_slice(patch);
    s
}

/// `levels`: build/emu/levels.txt from web/scripts/emu-levels.ts (the reference engine's peak per factory patch);
/// `strict`: level differences fail the test too.
pub fn run(app: &[u8], voices: u32, out: &str, levels: Option<&str>, strict: bool) -> ExitCode {
    let _ = std::fs::create_dir_all(out);
    let mut t = Run { out: out.to_string(), fails: Vec::new(), warns: Vec::new(), checks: 0, shot: 0 };
    let t0 = std::time::Instant::now();
    let mut emulated = 0;
    let levels: Vec<(String, i32)> = levels
        .map(|txt| txt.lines().filter_map(|l| l.split_once('\t')).filter_map(|(n, v)| Some((n.to_string(), v.trim().parse().ok()?))).collect())
        .unwrap_or_default();
    let r = steps(app, voices, &mut t, &mut emulated, &levels);
    if let Err(e) = r {
        t.check("the firmware keeps running", false, format!("halt: {e}"));
    }
    let wall = t0.elapsed().as_secs_f64();
    println!(
        "\n{} checks, {} failed, {} level warnings; {:.1} s emulated in {wall:.1} s; snapshots in {out}",
        t.checks,
        t.fails.len(),
        t.warns.len(),
        emulated as f64 / 1000.0
    );
    for f in &t.warns {
        println!("  WARN {f}");
    }
    for f in &t.fails {
        println!("  FAIL {f}");
    }
    if t.fails.is_empty() && (!strict || t.warns.is_empty()) { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Within a factor of two (6 dB) of the reference level; quiet references (< 500) are not judged.
fn level_ok(got: i32, want: i32) -> bool {
    want < 500 || (got * 2 >= want && got <= want * 2)
}

/// The patch diagram (the strip at the right of the module page) as pixels.
fn diagram(m: &Machine) -> Vec<u16> {
    let fb = m.lcd();
    (24..220).flat_map(|y| (164..240).map(move |x| fb[y * 240 + x])).collect()
}

/// Back to the module page from wherever: HOME taps (a tap closes the menu, another goes home).
fn go_home(m: &mut Machine) -> Result<(), String> {
    for _ in 0..4 {
        if font::on_screen(m.lcd(), "SAVE: STORE") {
            return Ok(());
        }
        m.tap(HOME, 120, 400)?;
    }
    Ok(())
}

/// The bank for the safety steps: slot 0 a patch far over the CPU budget with eight parts (web/scripts/emu-patches.ts),
/// slot 1 one with nothing to drop, slot 2 a factory patch.
fn heavy_bank(presets: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let read = |f: &str| std::fs::read(format!("build/emu/{f}")).map_err(|e| format!("build/emu/{f}: {e} (run web/scripts/emu-patches.ts)"));
    let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
    for (slot, name, patch) in [(0u32, "EMU HEAVY POLY", read("heavy-poly.m1p")?), (1, "EMU HEAVY MONO", read("heavy-mono.m1p")?), (2, "EMU LIGHT", presets[1].1.clone())] {
        let at = 0xA0000 + slot as usize * 0x1000;
        flash[at..at + 0x1000].copy_from_slice(&slot_sector(slot, name, &patch, false));
    }
    Ok(flash)
}

fn safety(app: &[u8], t: &mut Run, emulated: &mut u64, presets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let flash = heavy_bank(presets)?;
    // the overload guard: parts dropped while it plays, then a patch with nothing to drop muted, the main loop alive all along
    let mut m = Machine::boot(app, Some(&flash));
    wait_text(&mut m, "SAVE: STORE", 12000)?;
    t.screen(&m, "overload: the heavy poly patch loads", "EMU HEAVY POLY");
    let mk = m.mark();
    for n in [48u8, 52, 55, 59, 62, 65, 69, 72] {
        m.midi(&[0x90, n, 100], 0)?;
    }
    let shed = wait_text(&mut m, "OVERLOAD: A PART LESS", 4000)?;
    t.snap(&m, "overload-shed");
    t.check("overload: parts are dropped (A PART LESS)", shed, format!("at {} ms", m.ms()));
    m.run_for(1500)?;
    let p = m.peak_since(mk);
    t.check("overload: the heavy poly patch still sounds", p > QUIET, format!("peak {p}"));
    m.midi(&[0xB0, 123, 0], 300)?;
    m.turn(PRESET, 1, 800)?;
    t.screen(&m, "overload: PRESET still steps (the main loop runs)", "EMU HEAVY MONO");
    m.midi(&[0x90, 60, 100], 0)?;
    let muted = wait_text(&mut m, "OVERLOAD: CHANGE PATCH", 4000)?;
    t.snap(&m, "overload-muted");
    t.check("overload: a patch with nothing to drop is muted (OVERLOAD)", muted, format!("at {} ms", m.ms()));
    let mk = m.mark();
    m.run_for(500)?;
    let p = m.peak_since(mk);
    t.check("overload: silent while muted", p < QUIET, format!("peak {p}"));
    m.midi(&[0x80, 60, 0], 100)?;
    m.turn(PRESET, 1, 800)?;
    t.screen(&m, "overload: the next patch loads", "EMU LIGHT");
    let gone = !font::on_screen(m.lcd(), "OVERLOAD");
    t.check("overload: forgotten with the next patch", gone, String::new());
    let p = midi_note_peak(&mut m, 60, 500)?;
    t.check("overload: the next patch sounds", p > QUIET, format!("peak {p}"));
    *emulated += m.ms();

    // safe mode: SAVE held at power-on: the built-in fallback patch, nothing from the flash (not the heavy slot 0)
    let mut m = Machine::boot(app, Some(&flash));
    m.key(SAVE, true);
    m.run_to(3000)?;
    m.key(SAVE, false);
    wait_text(&mut m, "SAVE: STORE", 9000)?;
    m.run_for(200)?;
    t.screen(&m, "safe mode: the fallback patch", "SAFE PATCH");
    let p = midi_note_peak(&mut m, 60, 500)?;
    t.check("safe mode: the fallback patch sounds", p > QUIET, format!("peak {p}"));
    *emulated += m.ms();

    // update mode: OCT- + OCT+ held at power-on
    let mut m = Machine::boot(app, Some(&flash));
    m.key(OCT_DOWN, true);
    m.key(OCT_UP, true);
    m.run_to(3000)?;
    m.key(OCT_DOWN, false);
    m.key(OCT_UP, false);
    m.run_for(500)?;
    t.screen(&m, "update mode: OCT- + OCT+ held at power-on", "UPDATE MODE");
    t.screen(&m, "update mode: says why", "OCT- + OCT+ HELD AT POWER-ON");
    let p = note_peak(&mut m, C4, 500)?;
    t.check("update mode: no engine (a key is silent)", p < QUIET, format!("peak {p}"));
    *emulated += m.ms();

    // update mode from the menu: HOME held, ALGO to SYSTEM, PRESET to UPDATE MODE, OCT+ twice
    let mut m = Machine::boot(app, None);
    wait_text(&mut m, "SAVE: STORE", 9000)?;
    m.tap(HOME, 1000, 400)?;
    m.turn(ALGO, 3, 400)?;
    t.screen(&m, "menu: the SYSTEM tab", "UPDATE MODE");
    m.turn(PRESET, 2, 400)?;
    m.tap(OCT_UP, 120, 300)?;
    m.tap(OCT_UP, 120, 800)?;
    t.screen(&m, "menu: UPDATE MODE enters update mode", "FROM THE MENU");
    *emulated += m.ms();
    Ok(())
}

fn steps(app: &[u8], voices: u32, t: &mut Run, emulated: &mut u64, levels: &[(String, i32)]) -> Result<(), String> {
    let presets = factory();
    // ---- 1. boot
    let mut m = Machine::boot(app, None);
    m.run_to(1200)?;
    t.screen(&m, "loading screen", "MODULAR-1");
    let up = wait_text(&mut m, "SAVE: STORE", 8000)?;
    t.check("the main page after the loading screen", up, format!("at {} ms", m.ms()));
    m.run_for(300)?;
    t.screen(&m, "factory patch 0 loaded", &presets[0].0);
    t.screen(&m, "module page title", "MAIN");
    if let Some(c) = cpu_figure(&m) {
        println!("     CPU figure in the top bar: {c} %");
    }

    // ---- 2. sound
    let mk = m.mark();
    m.run_for(500)?;
    let p = m.peak_since(mk);
    t.check("silent without keys", p < QUIET, format!("peak {p}"));
    let p = note_peak(&mut m, C4, 1000)?;
    t.check("a panel key (C4) sounds", p > LOUD, format!("peak {p}"));
    let s = settles(&mut m, 6000)?;
    t.warn("silent again within 6 s of the release", s, format!("at {} ms", m.ms()));
    if !s {
        m.midi(&[0xB0, 123, 0], 0)?; // all notes off; a ringing delay keeps ringing
        settles(&mut m, 2000)?;
    }

    // ---- 3. pages
    for (key, what, text) in [
        (GLO, "GLO: mixer page", "MUTE"),
        (ENV, "ENV: performance page", "ENV: BACK"),
        (ARP, "ARP: melody page", "MELODY"),
        (SEQ, "SEQ: rhythm page", "RHYTHM"),
        (LFO, "LFO: chaos page", "CHAOS"),
        (HOME, "HOME: module page", "SAVE: STORE"),
    ] {
        m.tap(key, 120, 400)?;
        t.screen(&m, what, text);
    }
    m.tap(HOME, 1000, 400)?;
    t.screen(&m, "HOME held: settings menu", "DISPLAY");
    m.tap(HOME, 120, 400)?;
    t.screen(&m, "HOME again: menu closed", "SAVE: STORE");
    go_home(&mut m)?;

    // ---- the four-voice build: SEL steps the voices (voice 2 starts on factory patch 1)
    if voices > 1 {
        m.tap(SEL, 120, 500)?;
        t.screen(&m, "SEL: voice 2", &presets[1].0);
        for _ in 1..voices {
            m.tap(SEL, 120, 300)?;
        }
        m.run_for(300)?;
        t.screen(&m, "SEL round: voice 1 again", &presets[0].0);
    }

    // ---- 4. PRESET encoder
    m.turn(PRESET, 1, 500)?;
    t.screen(&m, "PRESET +1", &presets[1].0);
    m.turn(PRESET, 1, 500)?;
    t.screen(&m, "PRESET +1 again", &presets[2].0);
    m.turn(PRESET, -2, 500)?;
    t.screen(&m, "PRESET -2", &presets[0].0);

    // ---- 5. TRS MIDI
    m.midi(&[0xC0, 5], 500)?;
    t.screen(&m, "MIDI program change 5", &presets[5].0);
    let p = midi_note_peak(&mut m, 60, 500)?;
    t.check("a MIDI note on channel 1 sounds", p > QUIET, format!("peak {p}"));
    settles(&mut m, 4000)?;
    println!("     factory patches, MIDI note C4 for 500 ms (peak of 32767, CPU figure):");
    for (i, (name, _)) in presets.iter().enumerate() {
        m.midi(&[0xC0, i as u8], 300)?;
        let shown = font::on_screen(m.lcd(), name);
        let cpu = cpu_figure(&m);
        let p = midi_note_peak(&mut m, 60, 500)?;
        let cpu_note = cpu_figure(&m);
        let want = levels.iter().find(|(n, _)| n == name).map(|l| l.1);
        println!(
            "       {i:2} {name:24} peak {p:6}  reference {:>6}  cpu {:>4} / {:>4}",
            want.map_or("-".into(), |w| w.to_string()),
            cpu.map_or("-".into(), |c| format!("{c}%")),
            cpu_note.map_or("-".into(), |c| format!("{c}%"))
        );
        if !shown {
            t.snap(&m, &format!("program-{i}"));
        }
        t.check(&format!("program change {i}: {name} shown"), shown, String::new());
        t.check(&format!("program change {i}: {name} makes sound"), p > 4, format!("peak {p}"));
        if let Some(w) = want {
            t.warn(&format!("program change {i}: {name} level near the reference engine's"), level_ok(p, w), format!("peak {p}, reference {w}"));
        }
        settles(&mut m, 3000)?;
        m.run_for(100)?;
    }
    m.write_wav(&format!("{}/run1.wav", t.out), AUDIO_RATE).map_err(|e| e.to_string())?;

    // ---- 6. SAVE and restore
    go_home(&mut m)?;
    let target = 4usize;
    m.midi(&[0xC0, target as u8], 400)?;
    m.tap(OCT_UP, 120, 400)?;
    m.turn(K1, 5, 400)?;
    let before = diagram(&m);
    m.tap(SAVE, 120, 50)?;
    let saved = wait_text(&mut m, "SAVED", 3000)?;
    t.snap(&m, "SAVE");
    t.check("SAVE: SAVED in the bar", saved, String::new());
    m.run_for(500)?;
    let flash = m.flash();
    *emulated += m.ms();
    let same: usize = flash.iter().filter(|&&b| b != 0xff).count();
    t.check("SAVE wrote the flash", same > 0, format!("{same} bytes not erased"));

    let mut m = Machine::boot(app, Some(&flash));
    let restored = wait_text(&mut m, "STATE RESTORED", 9000)?;
    t.snap(&m, "restart");
    t.check("restart: STATE RESTORED", restored, format!("at {} ms", m.ms()));
    wait_text(&mut m, "SAVE: STORE", 3000)?;
    m.run_for(2500)?;
    t.screen(&m, "restart: the stored patch is playing", "STORED PATCH");
    t.check("restart: the same patch as saved (the diagram)", diagram(&m) == before, String::new());
    m.tap(ENV, 120, 400)?;
    t.screen(&m, "restart: the saved octave", "OCT +1");
    m.tap(ENV, 120, 400)?;
    *emulated += m.ms();

    // ---- 7. the preset bank in flash
    let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
    let bank = [("EMU BANK A", 9usize, false), ("EMU BANK B", 4, false), ("EMU BANK C", 0, false), ("EMU BANK D", 1, true)];
    for (slot, (name, preset, bad)) in [0u32, 2, 5, 6].iter().zip(bank) {
        let at = 0xA0000 + *slot as usize * 0x1000;
        flash[at..at + 0x1000].copy_from_slice(&slot_sector(*slot, name, &presets[preset].1, bad));
    }
    let mut m = Machine::boot(app, Some(&flash));
    wait_text(&mut m, "SAVE: STORE", 9000)?;
    m.run_for(300)?;
    t.screen(&m, "bank: boot plays slot entry 0", "EMU BANK A");
    m.turn(PRESET, 1, 500)?;
    t.screen(&m, "bank: PRESET +1", "EMU BANK B");
    m.midi(&[0xC0, 2], 500)?;
    t.screen(&m, "bank: program change 2", "EMU BANK C");
    let p = midi_note_peak(&mut m, 60, 500)?;
    t.check("bank: a note sounds", p > QUIET, format!("peak {p}"));
    m.turn(PRESET, 1, 500)?;
    let d = font::on_screen(m.lcd(), "EMU BANK D");
    t.screen(&m, "bank: PRESET wraps past the bad slot", "EMU BANK A");
    t.check("bank: the slot with a bad CRC is skipped", !d, String::new());
    *emulated += m.ms();

    // ---- 8. safety: the overload guard, safe mode, update mode
    safety(app, t, emulated, &presets)?;

    // ---- 9. unmodelled hardware
    let known = [0x13e08u32, 0x13e0c]; // P33 (watchdog, reset reason, reboot): fm1_sys.h
    let mut unknown = m.unknown_mmio();
    unknown.retain(|(a, ..)| !known.contains(a));
    for (a, w, n) in &unknown {
        println!("     unmodelled register {} {a:#010x} x{n}", if *w { "write" } else { "read" });
    }
    t.check("no registers fm1-emu does not model besides P33", unknown.is_empty(), format!("{} other", unknown.len()));
    Ok(())
}
