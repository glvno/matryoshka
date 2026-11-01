//! The smoke test: our firmware on the emulated FM-1, driven through its panel and the TRS
//! MIDI input, judged by what the LCD shows (the firmware's own font, font.rs), the audio it
//! makes and the flash it writes. No symbols needed: it runs on the release binary.
//!
//! 1. boot: the loading screen, then the main page of factory patch 0 under the quick start (D-247); OCT- + OCT+ opens
//!    the controls sheet in its place (D-245), ALGO its EVERYWHERE tab, HOME closes it; OCT acts on its release
//! 2. sound: silent without keys, a note on a panel key, silent again after the release
//! 3. pages: GLO (the menu, again: back), PLAY twice, HOME (on the patch's home page: nothing, the page stays), SELECT /
//!    ALGO (the header shows where they went, no toast; back again: as it was), ALGO then HOME (the device's first page),
//!    SELECT then HOME (the patch's home page, #391), GLO (the menu's MIDI tab), ALGO (its INFO tab), HOME (back out of
//!    it), HOME held (nothing, #395)
//! 4. PRESET encoder: alone, the focused device's preset (#395); HOME held, forward, forward, back
//!    then K1..K4 on Elvira 2's drone row: a fast click only after one the same way, HOME held a fine click (#340)
//! 5. TRS MIDI: program change, a note, then every factory patch in turn (name + sound)
//! 6. SAVE: patch, octave; the flash kept, a restart, STATE RESTORED and the state back
//! 7. the preset bank: three slots (and one with a bad CRC) written straight into the flash,
//!    PRESET and program change step through the three, wrapping
//! 8. safety: a patch far over the CPU budget sheds parts, one with nothing to shed is muted (OVERLOAD) and the
//!    next patch plays again; SAVE held at power-on = safe mode (the built-in fallback patch, not the bank, no quick
//!    start); HOME + SAVE turns the quick start off for good (the next power-on has none); OCT- +
//!    OCT+ held at power-on and MENU > SYSTEM > UPDATE MODE (K1, then GLO held) = update mode (no engine)
//!    then the bank's power-loss rules and the first boot's factory bank; an update that changed a factory patch but not
//!    the format (#441): the untouched slot gets today's patch, an edited one and today's stay, once
//! 9. the patch buttons (held / switched) and the SEQ page on the 808 Kit: a step, a track, PLAY, a mute, REC
//! 10. the Delay's longest time (#273): its echo 700 ms after the note, ping-pong half of it on the left and 700 ms on the right
//! 11. hardware the emulator does not model: any register besides P33 fails the test
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
const FX: u8 = 2;
const ARP: u8 = 10;
const SEQ: u8 = 11;
const REC: u8 = 13;
const GLO: u8 = 7;
const ENV: u8 = 4;
const HOME: u8 = 8;
const SAVE: u8 = 9;
const PLAY: u8 = 12;
const C4: u8 = 14 + 7; // note keys start at F3
const PRESET: u8 = 6; // encoder
const ALGO: u8 = 1; // encoder
const SELECT: u8 = 0; // encoder
const K1: u8 = 2;
const K3: u8 = 4;
const K4: u8 = 5; // encoder
const SEL: u8 = 3; // the SEL button (SCL in Felucca's table)

/// The device page's header, its rows (pages_ui.c LK_HH)
const HEADER_ROWS: usize = 36;

/// Below this the output counts as silent, above `LOUD` as sounding (16-bit samples).
const QUIET: i32 = 64;
const LOUD: i32 = 1000;

/// (name, binary) of every factory patch in presets.h
/// on the device page (pages_ui.c): the footer's octave at 0 ("= OCT =")
const DEVICE_PAGE: &str = "= OCT =";

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

/// The patch's name on the screen (the footer, PRESET's toast), else in the environment's bar: a patch loads with nothing
/// armed, and the footer then cuts a long name to show KEYS WIRED after it (#395). ENV opens and closes the environment.
fn patch_screen(t: &mut Run, m: &mut Machine, what: &str, name: &str) -> Result<bool, String> {
    if font::on_screen(m.lcd(), name) {
        return Ok(t.screen(m, what, name));
    }
    m.tap(ENV, 120, 500)?;
    let ok = t.screen(m, what, name);
    m.tap(ENV, 120, 500)?;
    Ok(ok)
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

/// After power-on the quick start shows over the first page (D-247): wait up to `max` ms for it, then HOME closes it
/// and the device page is drawn whole again. Whether it showed
fn quick_start(m: &mut Machine, max: u64) -> Result<bool, String> {
    let shown = wait_text(m, "QUICK START", max)?;
    if shown {
        m.tap(HOME, 120, 400)?;
    }
    Ok(shown)
}

/// Run up to `max` ms more until the device page's header is on the screen (a gold pixel, P_GOLD, the device's dash in
/// its 36 rows), checked every ms: the page is drawn top to bottom, the footer last.
fn wait_header(m: &mut Machine, max: u64) -> Result<bool, String> {
    let end = m.ms() + max;
    let up = |m: &Machine| m.lcd()[..240 * HEADER_ROWS].iter().any(|&p| p == 0xEDAB);
    while m.ms() < end && !up(m) {
        m.run_for(1)?;
    }
    Ok(up(m))
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
pub fn run(app: &[u8], out: &str, levels: Option<&str>, strict: bool) -> ExitCode {
    let _ = std::fs::create_dir_all(out);
    let mut t = Run { out: out.to_string(), fails: Vec::new(), warns: Vec::new(), checks: 0, shot: 0 };
    let t0 = std::time::Instant::now();
    let mut emulated = 0;
    // NAME, peak, and whether it has Steps tracks (PLAY around its note); an old two-field file reads as no tracks
    let levels: Vec<(String, i32, bool)> = levels
        .map(|txt| {
            txt.lines()
                .filter_map(|l| {
                    let mut f = l.split('\t');
                    Some((f.next()?.to_string(), f.next()?.trim().parse().ok()?, f.next().map_or(false, |s| s.trim() == "1")))
                })
                .collect()
        })
        .unwrap_or_default();
    let r = steps(app, &mut t, &mut emulated, &levels);
    if let Err(e) = r {
        t.check("the firmware keeps running", false, format!("halt: {e}"));
    }
    let wall = t0.elapsed().as_secs_f64();
    println!("\n{} (every machine of the run; a stack's run ends where its deepest use began)", crate::machine::report(&crate::machine::untouched_all()));
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

/// HOME held + PRESET (#395): the next / previous patch; HOME's release then goes nowhere
fn patch_turn(m: &mut Machine, clicks: i32, after: u64) -> Result<(), String> {
    m.key(HOME, true);
    m.run_for(100)?;
    m.turn(PRESET, clicks, 100)?;
    m.key(HOME, false);
    m.run_for(after)
}

/// Back to a device page from wherever: HOME taps (a tap closes the menu, another a page it opened; on a device page
/// it moves to the device's first page or the patch's home page, #391, and the footer shows on every device page)
fn go_home(m: &mut Machine) -> Result<(), String> {
    for _ in 0..4 {
        if font::on_screen(m.lcd(), DEVICE_PAGE) {
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

/// A record of the bank (firmware/src/slotstore.c): header ("M1S2", id, sequence number, length, CRC, name) at the start
/// of a sector, the data from +256. `torn`: the data without the header (a write cut before its commit).
fn record(id: u32, seq: u32, name: &str, data: &[u8], torn: bool) -> Vec<u8> {
    let mut crc = 0xffffu32;
    for &b in data {
        crc ^= (b as u32) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { ((crc << 1) ^ 0x1021) & 0xffff } else { (crc << 1) & 0xffff };
        }
    }
    let mut s = vec![0xffu8; 0x1000];
    if !torn {
        let mut h = Vec::new();
        h.extend_from_slice(&0x3253_314Du32.to_le_bytes()); // "M1S2"
        h.extend_from_slice(&id.to_le_bytes());
        h.extend_from_slice(&seq.to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&crc.to_le_bytes());
        let mut n = [0u8; 20];
        n[..name.len()].copy_from_slice(name.as_bytes());
        h.extend_from_slice(&n);
        h.extend_from_slice(&[0u8; 8]);
        s[..48].copy_from_slice(&h);
    }
    s[256..256 + data.len()].copy_from_slice(data);
    s
}

/// The bank's power-loss rules (#74): of two records of one slot the newer wins (a write cut after its commit, before the
/// old sector was erased); a record without its header (cut before the commit) does not count; the first boot writes
/// the factory patches.
fn store(app: &[u8], t: &mut Run, emulated: &mut u64, presets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
    let put = |f: &mut Vec<u8>, at: usize, s: Vec<u8>| f[at..at + 0x1000].copy_from_slice(&s);
    put(&mut flash, 0x97000, record(3, 9, "EMU NEW", &presets[1].1, false));
    put(&mut flash, 0xA5000, record(3, 5, "EMU OLD", &presets[2].1, false));
    put(&mut flash, 0xB0000, record(7, 20, "EMU TORN", &presets[3].1, true));
    put(&mut flash, 0xC0000, record(0, 1, "EMU ZERO", &presets[0].1, false));
    let mut m = Machine::boot(app, Some(&flash));
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, DEVICE_PAGE, 2000)?;
    m.run_for(300)?;
    t.screen(&m, "store: boot opens slot 0 (no settings record)", "EMU ZERO");
    m.midi(&[0xC0, 3], 500)?;
    t.screen(&m, "store: the newer of two records of a slot wins", "EMU NEW");
    m.midi(&[0xC0, 7], 500)?;
    t.check("store: a record cut before its header does not count", !font::on_screen(m.lcd(), "EMU TORN"), String::new());
    let f = m.flash();
    t.check("store: the older record was erased", f[0xA5000..0xA5004] == [0xff; 4], String::new());
    *emulated += m.ms();

    let mut m = Machine::boot(app, None);
    let quick = quick_start(&mut m, 9000)?;
    t.check("store: the quick start over the first boot's page (D-247)", quick, String::new());
    let written = wait_text(&mut m, "FACTORY BANK WRITTEN", 1000)?;
    t.check("store: the first boot writes the factory bank (said once the quick start closes)", written, String::new());
    m.run_for(1000)?;                          // (it holds the bar for 2 s: the first full redraw must not wipe it)
    t.screen(&m, "store: the boot message stays up", "FACTORY BANK WRITTEN");
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(2500)?;
    t.screen(&m, "store: factory slot 0 plays", &presets[0].0);
    let last = presets.len() - 1;
    m.midi(&[0xC0, last as u8], 500)?;
    t.screen(&m, "store: the last factory slot", &presets[last].0);
    *emulated += m.ms();
    Ok(())
}

/// The newest record of `id` in the bank (firmware/src/slotstore.c: 66 sectors, "M1S2" records): (sequence number, data)
fn bank_record(f: &[u8], id: u32) -> Option<(u32, Vec<u8>)> {
    let word = |a: usize| u32::from_le_bytes(f[a..a + 4].try_into().unwrap());
    (0..66usize)
        .map(|i| if i < 2 { 0x97000 + i * 0x1000 } else { 0xA0000 + (i - 2) * 0x1000 })
        .filter(|&a| word(a) == 0x3253_314D && word(a + 4) == id)
        .map(|a| (word(a + 8), f[a + 256..a + 256 + word(a + 12) as usize].to_vec()))
        .max_by_key(|r| r.0)
}

/// After an update that changed a factory patch but not the format (#441): a bank from 1.6.0 (a 12-byte settings record
/// at today's format, no factory set) with slot 0 an earlier factory Drift Poly (untouched), slot 1 an edited copy of
/// it and slot 2 today's Init. The boot rewrites slot 0 with today's Drift Poly and says FACTORY PATCHES UPDATED,
/// leaves slots 1 and 2 alone and stores the factory set (settings bytes 13..15); the next boot rewrites nothing.
fn upgrade(app: &[u8], t: &mut Run, emulated: &mut u64, presets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let old = std::fs::read("build/emu/old-drift-poly.m1p").map_err(|e| format!("build/emu/old-drift-poly.m1p: {e} (run web/scripts/emu-patches.ts)"))?;
    let today = |name: &str| presets.iter().find(|p| p.0 == name).map(|p| p.1.clone()).ok_or(format!("no factory {name}"));
    let (drift, init) = (today("DRIFT POLY")?, today("INIT")?);
    let version: u8 = include_str!("../../../firmware/src/engine.h").split("#define ENG_PATCH_VERSION ").nth(1).and_then(|s| s.split_whitespace().next()?.parse().ok()).ok_or("ENG_PATCH_VERSION")?;
    let set_id = u32::from_str_radix(PRESETS_H.split("#define FACTORY_SET_ID 0x").nth(1).and_then(|s| s.split('u').next()).ok_or("FACTORY_SET_ID")?, 16).map_err(|e| e.to_string())?;
    let mut edited = old.clone();
    let last = edited.len() - 1;
    edited[last] ^= 1;
    let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
    let put = |f: &mut Vec<u8>, at: usize, s: Vec<u8>| f[at..at + 0x1000].copy_from_slice(&s);
    put(&mut flash, 0xA0000, record(0, 1, "DRIFT POLY", &old, false));
    put(&mut flash, 0xA1000, record(1, 2, "MY DRIFT", &edited, false));
    put(&mut flash, 0xA2000, record(2, 3, "INIT", &init, false));
    // 1.6.0's settings record: version 1, slot 2, octave 0, LEDs, accel, CPU bar, clock in, program change, channel,
    // MIDI out, the bank's format (today's), module 0
    put(&mut flash, 0xA3000, record(64, 4, "", &[1, 2, 8, 0, 1, 0, 0, 0, 0, 1, version, 0], false));
    let mut m = Machine::boot(app, Some(&flash));
    quick_start(&mut m, 9000)?;
    let said = wait_text(&mut m, "FACTORY PATCHES UPDATED", 1000)?;
    t.check("upgrade: a same-format factory change says FACTORY PATCHES UPDATED", said, String::new());
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(2500)?;
    t.screen(&m, "upgrade: boot opens the settings record's slot", "INIT");
    let f = m.flash();
    *emulated += m.ms();
    let s0 = bank_record(&f, 0).ok_or("slot 0 gone")?;
    t.check("upgrade: the untouched earlier Drift Poly holds today's", s0.1 == drift, format!("{} bytes, format {} (today's: {} bytes)", s0.1.len(), s0.1[1], drift.len()));
    let s1 = bank_record(&f, 1).ok_or("slot 1 gone")?;
    t.check("upgrade: the edited copy stays as it is", s1 == (2, edited.clone()), format!("sequence {}", s1.0));
    let s2 = bank_record(&f, 2).ok_or("slot 2 gone")?;
    t.check("upgrade: a slot holding today's patch is not rewritten", s2 == (3, init.clone()), format!("sequence {}", s2.0));
    let set = bank_record(&f, 64).ok_or("settings gone")?.1;
    let got = if set.len() >= 16 { set[13] as u32 | (set[14] as u32) << 8 | (set[15] as u32) << 16 } else { 0 };
    t.check("upgrade: the settings record keeps the factory set (16 bytes, 13..15)", set.len() == 16 && got == set_id && set[1] == 2, format!("{} bytes, set {got:06x}, FACTORY_SET_ID {set_id:06x}", set.len()));
    let mut m = Machine::boot(app, Some(&f));
    quick_start(&mut m, 9000)?;
    let again = wait_text(&mut m, "FACTORY PATCHES UPDATED", 2500)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    t.check("upgrade: the next boot rewrites nothing", !again && m.flash() == f, String::new());
    *emulated += m.ms();
    Ok(())
}

/// The patch buttons (#60): a held button (FX) opens a VCA while held; a switching one (ARP, saved on) flips on each press.
fn panel(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    let patch = std::fs::read("build/emu/panel.m1p").map_err(|e| format!("build/emu/panel.m1p: {e} (run web/scripts/emu-patches.ts)"))?;
    let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
    flash[0xA0000..0xA1000].copy_from_slice(&slot_sector(0, "EMU PANEL", &patch, false));
    let mut m = Machine::boot(app, Some(&flash));
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(2500)?;
    t.screen(&m, "panel: the patch loads", "EMU PANEL");
    let hold = |m: &mut Machine, fx: bool| -> Result<i32, String> {
        m.midi(&[0x90, 60, 100], 0)?;
        if fx { m.key(FX, true); }
        m.run_for(300)?;
        let mk = m.mark();
        m.run_for(300)?;
        let p = m.peak_since(mk);
        if fx { m.key(FX, false); }
        m.midi(&[0x80, 60, 0], 300)?;
        Ok(p)
    };
    let p = hold(&mut m, false)?;
    t.check("panel: silent while FX is not held", p < QUIET, format!("peak {p}"));
    let p = hold(&mut m, true)?;
    t.check("panel: FX held opens the VCA (ARP saved on)", p > LOUD, format!("peak {p}"));
    m.tap(ARP, 120, 300)?;
    let p = hold(&mut m, true)?;
    t.check("panel: ARP switched off closes the second VCA", p < QUIET, format!("peak {p}"));
    m.tap(ARP, 120, 300)?;
    let p = hold(&mut m, true)?;
    t.check("panel: ARP switched on again", p > LOUD, format!("peak {p}"));
    *emulated += m.ms();
    Ok(())
}

/// The Delay at its longest time (#273, web/scripts/emu-patches.ts): a short burst on a note, all wet (ping-pong with feedback 0.5). The
/// echo comes 700 ms after the note (the FM-1's 30944-sample line); with ping-pong the left one after half the line, the right
/// one after the whole. Nothing is heard before the first echo.
fn long_delay(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    for (file, name, left, right) in [("long-delay.m1p", "EMU LONG DELAY", 700u64, 700u64), ("long-delay-pp.m1p", "EMU LONG PINGPONG", 350, 701)] {
        let patch = std::fs::read(format!("build/emu/{file}")).map_err(|e| format!("build/emu/{file}: {e} (run web/scripts/emu-patches.ts)"))?;
        let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
        flash[0xA0000..0xA1000].copy_from_slice(&slot_sector(0, name, &patch, false));
        let mut m = Machine::boot(app, Some(&flash));
        quick_start(&mut m, 9000)?;
        wait_text(&mut m, DEVICE_PAGE, 9000)?;
        m.run_for(2500)?;
        patch_screen(t, &mut m, &format!("long delay: {name} loads"), name)?;   // (the footer cuts the name before KEYS WIRED)
        let mk = m.mark();
        m.midi(&[0x90, 60, 100], 60)?;
        m.midi(&[0x80, 60, 0], 1500)?;
        let first = |ch: usize| -> Option<u64> {
            m.audio[mk..].iter().skip(ch).step_by(2).position(|s| (*s as i32).abs() > LOUD / 4).map(|i| i as u64 * 1000 / AUDIO_RATE as u64)
        };
        let (l, r) = (first(0), first(1));
        // (a quarter of LOUD: ping-pong's right echo is half its left one) the note reaches the engine a few ms after the MIDI
        // bytes (UART, the next block): an echo within 30 ms of its time
        let near = |got: Option<u64>, want: u64| got.is_some_and(|g| g >= want && g <= want + 30);
        t.check(&format!("long delay: {name}'s left echo after {left} ms"), near(l, left), format!("first heard at {l:?} ms"));
        t.check(&format!("long delay: {name}'s right echo after {right} ms"), near(r, right), format!("first heard at {r:?} ms"));
        *emulated += m.ms();
    }
    Ok(())
}

/// The SEQ page (#83) on the factory 808 Kit (one DRUMS track since #138; Main's keys into DRUMS since #141): on the
/// device page the black keys play the Drum map's rows (F#3 the kick), the white keys nothing (the owner, 2026-10-23).
/// SEQ opens the drum grid (every row on 16 steps, row 1 selected), a white key switches the kick on a step (its cell
/// lights), a black key picks the snare row (its name on coral), PLAY runs the track (sound), SEQ held + a black key
/// mutes it and again brings it back, REC records the track. Arming (#139): REC held + a black key arms the track (no
/// recording; the bar and the track's line say ARM, #179). REC is global (#395): stopped, it starts the transport and
/// records the armed track (the page stays), PLAY stops both; the device pages name the armed track, REC held + the key
/// again disarms; REC with nothing armed stays on the device page and says so. Then the piano roll (#241) on <7PH's
/// melodic PATTERN: its pitch rows, a marker under a step with a note below the window, a white key switches the
/// selected pitch on a step, REC records it with the 27 keys as its keyboard.
fn seq(app: &[u8], t: &mut Run, emulated: &mut u64, presets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let Some(kit) = presets.iter().position(|(n, _)| n == "808 KIT") else {
        t.check("seq: the factory 808 Kit is there", false, String::new());
        return Ok(());
    };
    let mut m = Machine::boot(app, None);
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(2500)?;
    m.midi(&[0xC0, kit as u8], 500)?;
    t.screen(&m, "seq: the 808 Kit loads", "808 KIT");
    m.run_for(1200)?;                        // (PRESET's toast over)
    t.screen(&m, "arm: a patch loads with nothing armed, the footer says KEYS WIRED (#395)", "KEYS WIRED");
    m.tap(SEL, 120, 300)?;                   // the home device, the Drum map: its keys come through DRUMS, armed with it
    t.screen(&m, "arm: SEL on a device fed through a track arms it with the track (#395)", "DRUM MAP ARMED");
    m.run_for(1200)?;
    let mk = m.mark();
    m.tap(14 + 1, 120, 300)?;                // F#3, black key 1, on the device page: the kick (Main's keys into DRUMS, #141)
    let p = m.peak_since(mk);
    t.check("seq: black key 1 plays the kick through DRUMS, stopped", p > LOUD, format!("peak {p}"));
    m.run_for(1500)?;                        // (the kick dies away)
    let mk = m.mark();
    m.tap(14, 120, 300)?;                    // F3, a white key: nothing on a Drum map
    let p = m.peak_since(mk);
    t.check("seq: a white key plays nothing on a Drum map", p < QUIET, format!("peak {p}"));
    m.tap(SEQ, 120, 400)?;
    t.screen(&m, "seq: SEQ opens the drum grid on its track", "ALGO track");
    t.screen(&m, "arm: the SEQ page arms the track it shows (#395)", "DRUMS ARM");
    t.screen(&m, "seq: the row names come with the patch (format 33)", "COWBELL");
    let name = |m: &Machine, r: usize| m.lcd()[(44 + 19 * r + 1) * 240 + 49]; // a row name's field (x 4..49), coral when selected
    t.check("seq: row 1 selected", name(&m, 0) == 0xe3ab && name(&m, 1) != 0xe3ab, format!("{:#06x}", name(&m, 0)));
    let cell = |m: &Machine| m.lcd()[57 * 240 + 67]; // the kick's step 2 (x 63..72, y 44..58)
    let before = cell(&m);
    m.tap(14 + 2, 120, 300)?;                // G3: the second white key = step 2
    let after = cell(&m);                    // lit = C_FG (ui.c), ivory
    t.snap(&m, "seq-step-on");
    t.check("seq: a white key switches its step on (the cell lights)", before != after && after == 0xffbd, format!("{before:#06x} -> {after:#06x}"));
    m.tap(14 + 3, 120, 300)?;                // G#3: the second black key = the snare row
    t.check("seq: a black key picks a drum row (its name on coral)", name(&m, 1) == 0xe3ab && name(&m, 0) != 0xe3ab, format!("{:#06x}", name(&m, 1)));
    m.tap(14 + 1, 120, 300)?;                // (back to the kick row; stopped, picking a row sounds it)
    m.run_for(1500)?;                        // (the kick dies away)
    let mk = m.mark();
    m.run_for(500)?;
    let p = m.peak_since(mk);
    t.check("seq: silent while the transport is stopped", p < QUIET, format!("peak {p}"));
    m.tap(PLAY, 120, 300)?;
    let mk = m.mark();
    m.run_for(2000)?;
    let p = m.peak_since(mk);
    t.check("seq: PLAY runs the track", p > LOUD, format!("peak {p}"));
    m.key(SEQ, true);
    m.run_for(200)?;
    m.tap(14 + 1, 120, 100)?;                // SEQ held + F#3: the track muted
    t.screen(&m, "seq: SEQ held + a black key mutes the track", "DRUMS MUTED");
    m.tap(14 + 1, 120, 100)?;
    m.key(SEQ, false);
    m.run_for(1200)?;
    t.screen(&m, "seq: the page stays after the mute", "ALGO track");
    m.tap(REC, 120, 300)?;
    m.run_for(1100)?;
    t.screen(&m, "seq: REC, running: the track shown records", "DRUMS REC");
    m.tap(REC, 120, 300)?;
    m.tap(PLAY, 120, 300)?;
    m.key(REC, true);                        // REC held + F#3: DRUMS (armed by the SEQ page) disarmed, then armed again;
    m.run_for(200)?;                         // REC's release records nothing
    m.tap(14 + 1, 120, 100)?;
    t.screen(&m, "arm: REC held + a black key disarms the track the page armed", "DRUMS DISARMED");
    m.tap(14 + 1, 120, 100)?;
    t.screen(&m, "arm: REC held + a black key arms the track", "DRUMS ARMED");
    m.key(REC, false);
    m.run_for(1300)?;
    t.screen(&m, "arm: REC's release after arming records nothing, the bar says ARM", "DRUMS ARM");
    t.screen(&m, "arm: the track's line says ARMED (#179)", "TRACK 1/1  ARMED");
    let mk = m.mark();
    m.tap(REC, 120, 1300)?;                  // stopped: REC starts the transport and records the armed track (#395)
    t.screen(&m, "rec: REC, stopped, with a drum track armed: it records, the grid stays", "DRUMS REC");
    t.snap(&m, "arm-drum-grid-rec");
    m.run_for(1000)?;
    let p = m.peak_since(mk);
    t.check("rec: REC, stopped, starts the transport (the track sounds)", p > LOUD, format!("peak {p}"));
    m.tap(PLAY, 120, 1300)?;
    t.screen(&m, "rec: PLAY stops the transport and the recording", "DRUMS ARM");
    m.tap(SEQ, 120, 400)?;
    t.screen(&m, "seq: SEQ again closes the page", DEVICE_PAGE);
    t.screen(&m, "arm: the device page names the armed track", "ARM DRUMS");
    m.key(REC, true);
    m.run_for(200)?;
    m.tap(14 + 1, 120, 100)?;
    t.screen(&m, "arm: REC held + the armed track's key disarms it", "DRUMS DISARMED");
    m.key(REC, false);
    m.run_for(1300)?;
    t.screen(&m, "arm: nothing armed, the footer says KEYS WIRED", "KEYS WIRED");
    m.tap(REC, 120, 300)?;                   // nothing armed: REC runs, the device page stays (#395)
    t.screen(&m, "rec: REC with nothing armed says so", "REC: NO TRACK ARMED");
    m.run_for(1200)?;
    t.screen(&m, "rec: REC never changes the page", DEVICE_PAGE);
    m.tap(REC, 120, 300)?;
    t.screen(&m, "rec: REC again: off", "REC OFF");
    m.tap(PLAY, 120, 300)?;
    m.tap(SEQ, 120, 1300)?;
    t.screen(&m, "seq: SEQ opens the grid again", "ALGO track");
    t.screen(&m, "arm: the track line says ARMED, the ALGO and clear hints after it (#395, #450)", "TRACK 1/1  ARMED  ALGO track  SEQ+REC clear");
    m.key(SEQ, true);                        // SEQ held + REC: the track's clear asks; REC again within 3 s clears it (#231)
    m.run_for(200)?;
    m.tap(REC, 120, 300)?;
    t.screen(&m, "clear: SEQ held + REC asks first", "CLEAR DRUMS? REC AGAIN");
    m.tap(REC, 120, 300)?;
    t.screen(&m, "clear: REC again clears the track", "DRUMS CLEARED");
    let c = cell(&m);
    t.check("clear: the grid's hits are gone (the kick's step 2 dark)", c != 0xffbd, format!("{c:#06x}"));
    m.key(SEQ, false);
    m.run_for(1500)?;
    t.screen(&m, "clear: the page stays after it", "ALGO track");
    m.tap(SEQ, 120, 400)?;
    if let Some(gb) = presets.iter().position(|(n, _)| n == "<7PH") {
        // the piano roll (#241): <7PH's PATTERN (melodic) on 8 pitch rows; a white key switches the selected pitch
        // (A#3, the median) on a step; REC records the armed roll, all 27 keys its keyboard (#395)
        m.midi(&[0xC0, gb as u8], 500)?;
        t.screen(&m, "roll: <7PH loads", "<7PH");
        m.tap(SEQ, 120, 400)?;
        m.turn(ALGO, 1, 600)?;               // DRUMS, then PATTERN
        t.screen(&m, "roll: PATTERN's piano roll", "BLACK row  SEL+KEY pen");
        t.screen(&m, "roll: its pitch rows (A#3 the median)", "A#3");
        // #387: the black keys pick the rows on screen, black key 1 the bottom one (its name on coral), not a track
        let name = |m: &Machine, r: usize| m.lcd()[(44 + 19 * r + 1) * 240 + 49];
        m.tap(14 + 1, 120, 400)?;            // black key 1 (F#3): the bottom row
        let (bottom, middle) = (name(&m, 7), name(&m, 4));
        t.check("roll: black key 1 picks the bottom row, not a track", bottom == 0xE3AB && middle != 0xE3AB,
            format!("{bottom:#06x} / {middle:#06x}"));
        t.screen(&m, "roll: black key 1 keeps the track (PATTERN)", "PATTERN ARM P"); // (the page armed it, #395)
        m.tap(14 + 8, 120, 400)?;            // black key 4 (C#4): the 4th row from the bottom, A#3 again
        let back = name(&m, 4);
        t.check("roll: black key 4 picks the 4th row from the bottom (A#3)", back == 0xE3AB, format!("{back:#06x}"));
        let below = m.lcd()[192 * 240 + 57]; // step 1's marker under the bottom row: A#2 is below the window
        let above = m.lcd()[42 * 240 + 57]; // (nothing above it on step 1)
        t.check("roll: a marker under a step with a note below the window", below == 0x9cf2 && above != 0x9cf2,
            format!("{below:#06x} / {above:#06x}"));
        let cell = |m: &Machine| m.lcd()[(44 + 19 * 4 + 14) * 240 + 79]; // A#3 (row 5) on step 3 (x 74..83)
        let before = cell(&m);
        m.tap(14 + 4, 120, 300)?;            // A3: the third white key = step 3
        let after = cell(&m);
        t.snap(&m, "roll-step-on");
        t.check("roll: a white key switches the selected pitch on a step (the cell lights)", before != after && after == 0xffbd,
            format!("{before:#06x} -> {after:#06x}"));
        m.tap(14 + 4, 120, 300)?;            // (off again)
        t.screen(&m, "roll: ALGO arms the track it shows (#395)", "PATTERN ARM");
        m.tap(REC, 120, 1300)?;              // PATTERN armed (by the page), stopped: the transport starts, it records
        t.screen(&m, "roll: REC records the melodic track armed", "PATTERN REC");
        t.screen(&m, "roll: while recording the keys are its keyboard", "KEYS record  SELECT row  OCT octave");
        m.tap(REC, 120, 300)?;
        m.tap(PLAY, 120, 300)?;
        m.tap(SEQ, 120, 400)?;
    } else {
        t.check("roll: the factory <7PH is there", false, String::new());
    }
    if let Some(sb) = presets.iter().position(|(n, _)| n == "SILVER BOX") {
        // patterns and songs (#375): PRESET on the SEQ page picks the pattern (stopped: at once; the bar shows it), SEL
        // tapped opens the SONG page, K4 right plays song 1 (Silver Box's demo), PLAY sounds it, K4 left the pattern again
        m.midi(&[0xC0, sb as u8], 500)?;
        t.screen(&m, "song: Silver Box loads", "SILVER BOX");
        m.tap(SEQ, 120, 400)?;
        t.screen(&m, "song: the SEQ bar shows pattern 1", "P01");
        m.turn(PRESET, 1, 600)?;
        m.run_for(1200)?;
        t.screen(&m, "song: PRESET on the SEQ page picks pattern 2, at once while stopped", "P02");
        let mk = m.mark();
        m.tap(PLAY, 120, 1500)?;
        let p = m.peak_since(mk);
        t.check("song: PLAY plays pattern 2 (pattern 1 is empty)", p > LOUD, format!("peak {p}"));
        m.turn(PRESET, 1, 300)?;
        t.screen(&m, "song: running, pattern 3 waits for the end of the pass", "PATTERN 03 NEXT");
        m.run_for(3000)?;
        t.screen(&m, "song: at the end of the pass, P03", "P03");
        m.tap(PLAY, 120, 300)?;
        m.turn(PRESET, -2, 600)?;
        m.tap(SEL, 120, 600)?;
        t.screen(&m, "song: SEL tapped opens the SONG page", "SONG 1");
        t.screen(&m, "song: the demo song's entries", "01  P02  0");
        m.turn(K4, 1, 600)?;
        t.screen(&m, "song: K4 right, song 1 plays", "SONG 1 PLAYS");
        let mk = m.mark();
        m.tap(PLAY, 120, 2000)?;
        let p = m.peak_since(mk);
        t.check("song: PLAY plays the song", p > LOUD, format!("peak {p}"));
        t.snap(&m, "song-page");
        m.tap(PLAY, 120, 300)?;
        m.turn(K4, -1, 600)?;
        t.screen(&m, "song: K4 left, the pattern plays again", "PATTERN P01");
        m.tap(SEL, 120, 400)?;
        t.screen(&m, "song: SEL goes back to the SEQ page", "P01");
        m.tap(SEQ, 120, 400)?;
    } else {
        t.check("song: the factory Silver Box is there", false, String::new());
    }
    *emulated += m.ms();
    Ok(())
}

fn safety(app: &[u8], t: &mut Run, emulated: &mut u64, presets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let flash = heavy_bank(presets)?;
    // the overload guard: parts dropped while it plays, then a patch with nothing to drop muted, the main loop alive all along
    let mut m = Machine::boot(app, Some(&flash));
    quick_start(&mut m, 12000)?;
    wait_text(&mut m, DEVICE_PAGE, 12000)?;
    patch_screen(t, &mut m, "overload: the heavy poly patch loads", "EMU HEAVY POLY")?;
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
    patch_turn(&mut m, 1, 0)?;                // the heavy mono patch: it is over the budget before any key
    m.midi(&[0x90, 60, 100], 0)?;
    let muted = wait_text(&mut m, "OVERLOAD: CHANGE PATCH", 4000)?;
    t.snap(&m, "overload-muted");
    t.check("overload: a patch with nothing to drop is muted (OVERLOAD)", muted, format!("at {} ms", m.ms()));
    let mk = m.mark();
    m.run_for(500)?;
    let p = m.peak_since(mk);
    t.check("overload: silent while muted", p < QUIET, format!("peak {p}"));
    m.midi(&[0x80, 60, 0], 100)?;
    patch_turn(&mut m, 1, 800)?;
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
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    let saved = wait_text(&mut m, "SAVED", 1000)?;
    t.check("safe mode: holding SAVE at power-on does not save", !saved, String::new());
    t.check("safe mode: no quick start (D-247)", !font::on_screen(m.lcd(), "QUICK START"), String::new());
    m.run_for(1500)?;                         // (the SAFE MODE message holds the bar for 4 s: still there)
    t.screen(&m, "safe mode: the message stays up", "SAFE MODE: FALLBACK PATCH");
    wait_text(&mut m, "SAFE PATCH", 6000)?;   // (then the patch's name shows)
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

    // update mode from the menu (#395): GLO, ALGO to INFO (the readings), back to SYSTEM, K1 right arms UPDATE MODE, GLO
    // held 2 s does it
    // the quick start off for good (D-247): HOME + SAVE on it, stored at once; the next power-on shows none
    let mut m = Machine::boot(app, None);
    let quick = wait_text(&mut m, "QUICK START", 9000)?;
    m.key(HOME, true);
    m.run_for(150)?;
    m.tap(SAVE, 120, 0)?;
    m.key(HOME, false);
    m.run_for(400)?;
    t.check("quick start: HOME + SAVE turns it off, the header says where it comes back", quick && wait_text(&mut m, "QUICK START OFF: GLO>SYSTEM", 600)?, String::new());
    t.screen(&m, "quick start: HOME + SAVE closes it", DEVICE_PAGE);
    let off = m.flash();
    *emulated += m.ms();
    let mut m = Machine::boot(app, Some(&off));
    // GLO the moment the first page's header appears after a boot (#248): a press that starts once the page shows is
    // taken (the presses made while the loading screen was up are dropped before the page is drawn, not after it)
    let up = wait_header(&mut m, 9000)?;
    t.check("quick start: off stays off at the next power-on (the settings record)", up && !font::on_screen(m.lcd(), "QUICK START"), String::new());
    m.tap(GLO, 120, 400)?;
    t.check("GLO the moment the first page appears (#248): the menu", up && font::on_screen(m.lcd(), "MENU"), format!("header at {} ms", m.ms() - 520));
    m.turn(ALGO, 1, 400)?;
    m.turn(ALGO, 1, 400)?;
    t.screen(&m, "menu: SYSTEM > QUICK START, off (D-240)", "QUICK START");
    m.turn(ALGO, 1, 400)?;
    t.screen(&m, "menu: the INFO tab", "VERSION");
    t.screen(&m, "menu: the bank's slots", &format!("{} OF 64", presets.len()));
    t.screen(&m, "menu: the battery's reading (fm1-emu's ch 3: 640, 3 bars)", "640  3/3");
    m.turn(ALGO, -1, 400)?;
    t.screen(&m, "menu: the SYSTEM tab", "SYSTEM");
    m.turn(K1, 1, 400)?;
    m.tap(GLO, 2200, 800)?;
    t.screen(&m, "menu: K1 arms UPDATE MODE, GLO held 2 s enters update mode", "FROM THE MENU");
    *emulated += m.ms();
    Ok(())
}

/// The count-in (#414): MENU > PANEL > COUNT-IN, saved in the settings record (SAVE, then a boot on the same flash);
/// REC, stopped, then starts the transport, the bar counts the beats of a bar, and REC records from the next bar line
/// (nothing armed here: it says so); REC again during the count cancels it.
fn count_in(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    let mut m = Machine::boot(app, None);
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(2500)?;
    m.tap(GLO, 120, 400)?;
    m.turn(ALGO, 1, 400)?;
    t.screen(&m, "count-in: the menu's PANEL tab has COUNT-IN", "COUNT-IN");
    t.screen(&m, "count-in: OFF as made", "OFF");
    m.turn(K3, 1, 400)?;
    t.screen(&m, "count-in: K3 turns it to 1 BAR", "1 BAR");
    m.tap(SAVE, 120, 1500)?;                 // (SAVED shows in the bar only until the device page is drawn over it)
    t.screen(&m, "count-in: SAVE closes the menu (and writes the settings record: the boot below)", DEVICE_PAGE);
    let flash = m.flash();
    *emulated += m.ms();
    let mut m = Machine::boot(app, Some(&flash));
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(2500)?;
    m.tap(GLO, 120, 400)?;
    m.turn(ALGO, 1, 400)?;
    t.screen(&m, "count-in: the setting survives a boot (the settings record's byte 12)", "1 BAR");
    m.tap(HOME, 120, 400)?;
    t.screen(&m, "count-in: HOME: the device page", DEVICE_PAGE);
    m.tap(REC, 120, 300)?;
    t.screen(&m, "count-in: REC, stopped: the transport starts and the bar says COUNT-IN", "COUNT-IN");
    t.check("count-in: the bar counts the beats (COUNT-IN 2)", wait_text(&mut m, "COUNT-IN 2", 3000)?, format!("at {} ms", m.ms()));
    t.check("count-in: a bar later REC records (nothing armed: it says so)", wait_text(&mut m, "REC: NO TRACK ARMED", 4000)?, format!("at {} ms", m.ms()));
    m.tap(REC, 120, 300)?;
    t.screen(&m, "count-in: REC again: off", "REC OFF");
    m.tap(REC, 120, 300)?;
    t.screen(&m, "count-in: REC while running: a count-in again", "COUNT-IN");
    m.tap(REC, 120, 300)?;
    t.screen(&m, "count-in: REC during the count: off, nothing recorded", "REC OFF");
    m.tap(PLAY, 120, 300)?;
    *emulated += m.ms();
    Ok(())
}

fn steps(app: &[u8], t: &mut Run, emulated: &mut u64, levels: &[(String, i32, bool)]) -> Result<(), String> {
    let presets = factory();
    // ---- 1. boot
    let mut m = Machine::boot(app, None);
    m.run_to(1500)?;
    // (the splash logo and wordmark are pictures; by 1.5 s the line reads READY: 1.25 s since patch format 34's device extras
    // and the ROM presets, #194; it was 1.2 s)
    t.screen(&m, "loading screen", "READY");
    let quick = wait_text(&mut m, "QUICK START", 8000)?;
    t.check("the quick start over the main page after the loading screen (D-247)", quick, format!("at {} ms", m.ms()));
    t.screen(&m, "  its rows", "device presets");
    t.snap(&m, "quick-start");
    m.key(OCT_DOWN, true);                    // OCT- + OCT+: the controls sheet in its place (D-245)
    m.run_for(100)?;
    m.key(OCT_UP, true);
    m.run_for(150)?;
    m.key(OCT_DOWN, false);
    m.key(OCT_UP, false);
    m.run_for(400)?;
    t.screen(&m, "OCT- + OCT+ on the quick start: the controls sheet, on its DEVICE tab", "adjust values");
    t.screen(&m, "  its EVERYWHERE tab", "EVERYWHERE");
    t.check("  the octave unchanged (OCT acts on its release, and not after the pair)", !font::on_screen(m.lcd(), "OCTAVE"), String::new());
    t.snap(&m, "controls-sheet");
    m.turn(ALGO, 1, 400)?;
    t.screen(&m, "ALGO on the sheet: EVERYWHERE (GLO settings)", "settings");
    m.tap(HOME, 120, 400)?;
    let up = wait_text(&mut m, DEVICE_PAGE, 2000)?;
    t.check("HOME closes the sheet: the main page", up && !font::on_screen(m.lcd(), "EVERYWHERE"), format!("at {} ms", m.ms()));
    m.key(OCT_UP, true);                      // OCT acts on its release (D-245)
    m.run_for(300)?;
    t.check("OCT+ held: the octave not yet", !font::on_screen(m.lcd(), "OCTAVE"), String::new());
    m.key(OCT_UP, false);
    m.run_for(300)?;
    t.screen(&m, "  let go: OCTAVE +1", "OCTAVE +1");
    m.tap(OCT_DOWN, 120, 300)?;
    t.screen(&m, "OCT- tapped: OCTAVE 0", "OCTAVE 0");
    m.run_for(2500)?;                         // (the first boot's FACTORY BANK WRITTEN, said once the card closed, leaves the bar after 2 s)
    t.screen(&m, "factory patch 0 loaded", &presets[0].0);
    let cell = m.lcd()[232 * 240 + 229]; // the footer's battery (pages_ui.c foot_row): its third bar, night on sand
    t.check("the battery in the footer: 3 bars (fm1-emu's ch 3 reads 640)", cell == 0x10E4, format!("{cell:#06x} at 229, 232"));
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
        (GLO, "GLO: the menu, on its MIDI tab", "MENU"),
        (GLO, "GLO again: back to the device page", DEVICE_PAGE),
        (PLAY, "PLAY: the device page stays", DEVICE_PAGE),
        (PLAY, "PLAY again: it stops, the page stays", DEVICE_PAGE),
        (HOME, "HOME on the patch's home page: nothing, the page stays", DEVICE_PAGE),
    ] {
        m.tap(key, 120, 400)?;
        t.screen(&m, what, text);
    }
    // SELECT / ALGO (the owner's design, 2026-10-24): no toast; the header shows the device and the page they reached,
    // the footer stays; back again, the header as it was
    for (enc, name) in [(SELECT, "SELECT"), (ALGO, "ALGO")] {
        let head = m.lcd()[..240 * HEADER_ROWS].to_vec();
        let foot = m.lcd()[225 * 240..].to_vec();
        m.turn(enc, 1, 300)?;
        t.snap(&m, &format!("{name}-header"));
        t.check(&format!("{name}: the header shows where it went, the footer stays"),
                m.lcd()[..240 * HEADER_ROWS] != head[..] && m.lcd()[225 * 240..] == foot[..], format!("at {} ms", m.ms()));
        m.turn(enc, -1, 300)?;
        t.check(&format!("{name} back: the header as it was"), m.lcd()[..240 * HEADER_ROWS] == head[..], String::new());
        t.screen(&m, &format!("{name} back: the device page"), DEVICE_PAGE);
    }
    // HOME on the device pages (#391, D-243): on a later page of a device its first page, on a device's first page the
    // patch's home page; the header then reads as it did on the home page's first page
    {
        let head = m.lcd()[..240 * HEADER_ROWS].to_vec();
        m.turn(ALGO, 1, 300)?;
        m.tap(HOME, 120, 400)?;
        t.check("ALGO, then HOME: the device's first page (the header as it was)", m.lcd()[..240 * HEADER_ROWS] == head[..], format!("at {} ms", m.ms()));
        m.turn(SELECT, 1, 300)?;
        m.tap(HOME, 120, 400)?;
        t.check("SELECT, then HOME: the patch's home page (the header as it was)", m.lcd()[..240 * HEADER_ROWS] == head[..], format!("at {} ms", m.ms()));
    }
    m.key(PLAY, true);                        // PLAY held + PRESET: the tempo; the release then does not start the transport
    m.run_for(200)?;
    m.turn(PRESET, 1, 300)?;
    t.screen(&m, "PLAY held + PRESET: the tempo", "TEMPO 121");
    m.key(PLAY, false);
    m.run_for(1300)?;
    t.screen(&m, "the release after a tempo turn: the footer's tempo 121", "121");
    m.tap(GLO, 120, 400)?;
    t.screen(&m, "GLO: the menu on its MIDI tab", "MIDI");
    patch_turn(&mut m, 1, 500)?;
    t.screen(&m, "HOME held + PRESET in the menu: the next patch, HOME's release stays in the menu", "MIDI");
    t.screen(&m, "  (the next patch)", &presets[1].0);
    patch_turn(&mut m, -1, 500)?;
    t.screen(&m, "  (and back, so step 4 starts from patch 1)", &presets[0].0);
    m.turn(ALGO, 3, 400)?;
    t.screen(&m, "ALGO three times: the INFO tab", "VERSION");
    m.tap(HOME, 120, 400)?;
    t.screen(&m, "HOME tapped: back out of the menu", DEVICE_PAGE);
    m.tap(HOME, 1000, 400)?;
    t.screen(&m, "HOME held: nothing opens (#395)", DEVICE_PAGE);
    go_home(&mut m)?;

    // ---- 4. PRESET encoder (#395): alone it steps the focused device's presets (here Oracle V's assembly, set to no
    // preset and at Init's values, so on INIT: the next, SYNC LEAD, #432; named in the bar; a module's page says NO
    // PRESETS ON A MODULE, panel_test.c); HOME held, patches
    m.turn(PRESET, 1, 500)?;
    t.screen(&m, "PRESET alone on an assembly's page at Init's values: the preset after INIT loaded, PRESET SYNC LEAD in the bar (#432)", "PRESET SYNC LEAD");
    t.screen(&m, "  (the patch stays)", &presets[0].0);
    m.run_for(1500)?;
    patch_turn(&mut m, 1, 500)?;
    t.screen(&m, "HOME held + PRESET +1", &presets[1].0);
    patch_turn(&mut m, 1, 500)?;
    t.screen(&m, "HOME held + PRESET +1 again", &presets[2].0);
    patch_turn(&mut m, -2, 500)?;
    t.screen(&m, "HOME held + PRESET -2", &presets[0].0);

    // ---- 4b. K1..K4 (#340, #405): a fast click counts only after a click the same way, HOME held turns fine. Elvira 2
    // opens on its voice page; ALGO once: mod, attack, release, drone (a Macro 0..1 since #425: a click 0.01, a fine click
    // 0.01 too, the editor's step; the values are rounded to the figure shown, #426)
    if let Some(el) = presets.iter().position(|(n, _)| n == "ELVIRA 2") {
        m.midi(&[0xC0, el as u8], 800)?;
        t.screen(&m, "program change: Elvira 2", &presets[el].0);
        m.turn(ALGO, 1, 500)?;
        m.turn(K4, 1, 300)?;
        t.screen(&m, "Elvira 2, K4 (drone) one click: 0.01", "0.01");
        m.turn(K4, 1, 30)?;                   // (300 ms after the last: a plain click, 0.02)
        m.turn(K4, 1, 300)?;                  // 30 ms after it, the same way: five clicks (KNOB ACCEL)
        t.screen(&m, "a click 30 ms after one the same way: five clicks, 0.07", "0.07");
        m.turn(K4, 1, 30)?;                   // (a plain click, 0.08)
        m.turn(K4, -1, 300)?;                 // 30 ms after it, the other way: a single click, so 0.07 is reached again
        t.screen(&m, "a click back 30 ms after one: a single click (#340), 0.07 again", "0.07");
        m.key(HOME, true);
        m.run_for(150)?;
        m.turn(K4, 1, 300)?;
        t.screen(&m, "HOME held + K4: a fine click, 0.01 (the editor's step), 0.08", "0.08");
        m.key(HOME, false);
        m.run_for(400)?;
        t.screen(&m, "HOME's release after a fine turn: the device page stays", DEVICE_PAGE);
        m.midi(&[0xB0, 19, 127], 400)?;          // CC 19: K4's row by position, the top of 0..1
        t.screen(&m, "MIDI CC 19 at 127: the drone row at 1.00", "1.00");
        // Monolith D's CONTROLLERS page: TUNE (an Offset) on K1, GLIDE ON (a switch) on K3
        if let Some(mono) = presets.iter().position(|(n, _)| n == "MONOLITH D") {
            m.midi(&[0xC0, mono as u8], 800)?;
            t.screen(&m, "program change: Monolith D, its CONTROLLERS page", "GLIDE ON");
            m.turn(K3, -1, 300)?;
            t.screen(&m, "Monolith D, K3 (GLIDE ON) one click left: OFF (a switch steps at once)", "OFF");
            m.turn(K1, 1, 300)?;
            t.screen(&m, "Monolith D, K1 (TUNE) one click: 0.08", "0.08");
        }
        m.midi(&[0xC0, 0], 800)?;
        t.screen(&m, "  (program change 0: back on patch 0 for step 5)", &presets[0].0);
    } else {
        t.check("the factory Elvira 2 is there", false, String::new());
    }

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
        // the drum kits and the sequenced engines play on the transport (Steps tracks): PLAY around the note
        let kit = name.ends_with(" KIT") || levels.iter().any(|(n, _, s)| n == name && *s);
        if kit {
            m.tap(PLAY, 120, 0)?;
        }
        let p = midi_note_peak(&mut m, 60, 500)?;
        let cpu_note = cpu_figure(&m);
        if kit {
            m.tap(PLAY, 120, 0)?;
        }
        let want = levels.iter().find(|(n, _, _)| n == name).map(|l| l.1);
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
    m.turn(K1, 5, 1200)?;                     // (the OCTAVE message leaves the bar after 1 s)
    let edited = format!("{} *", presets[target].0);
    t.screen(&m, "an edit marks the patch (*)", &edited);
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
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, "OCT +", 9000)?;                   // (the octave saved at +1)
    m.run_for(2500)?;
    t.screen(&m, "restart: the saved slot opens", &presets[target].0);
    t.check("restart: no edit mark", !font::on_screen(m.lcd(), &edited), String::new());
    t.check("restart: the same patch as saved (the diagram)", diagram(&m) == before, String::new());
    t.screen(&m, "restart: the saved octave", "OCT +");
    *emulated += m.ms();

    // ---- 7. the preset bank in flash
    let mut flash = vec![0xffu8; crate::machine::FLASH_SIZE];
    let bank = [("EMU BANK A", 9usize, false), ("EMU BANK B", 4, false), ("EMU BANK C", 0, false), ("EMU BANK D", 1, true)];
    for (slot, (name, preset, bad)) in [0u32, 2, 5, 6].iter().zip(bank) {
        let at = 0xA0000 + *slot as usize * 0x1000;
        flash[at..at + 0x1000].copy_from_slice(&slot_sector(*slot, name, &presets[preset].1, bad));
    }
    let mut m = Machine::boot(app, Some(&flash));
    quick_start(&mut m, 9000)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    m.run_for(300)?;
    t.screen(&m, "bank: boot plays slot entry 0", "EMU BANK A");
    patch_turn(&mut m, 1, 500)?;
    t.screen(&m, "bank: HOME held + PRESET +1", "EMU BANK B");
    m.midi(&[0xC0, 5], 500)?;
    t.screen(&m, "bank: program change 5 (slot 5)", "EMU BANK C");
    m.midi(&[0xC0, 3], 500)?;
    t.screen(&m, "bank: program change to an empty slot: nothing", "EMU BANK C");
    let p = midi_note_peak(&mut m, 60, 500)?;
    t.check("bank: a note sounds", p > QUIET, format!("peak {p}"));
    patch_turn(&mut m, 1, 500)?;
    let d = font::on_screen(m.lcd(), "EMU BANK D");
    t.screen(&m, "bank: PRESET wraps past the bad slot", "EMU BANK A");
    t.check("bank: the slot with a bad CRC is skipped", !d, String::new());
    *emulated += m.ms();

    // ---- 8. safety: the overload guard, safe mode, update mode; power-safe slot writes
    safety(app, t, emulated, &presets)?;
    store(app, t, emulated, &presets)?;
    upgrade(app, t, emulated, &presets)?;
    panel(app, t, emulated)?;
    seq(app, t, emulated, &presets)?;
    count_in(app, t, emulated)?;
    long_delay(app, t, emulated)?;

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
