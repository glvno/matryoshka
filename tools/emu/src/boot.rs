//! `m1emu boot`: the boot check, a quick gate for installs on the test rig while the owner iterates (D-123). About 20 s
//! of emulated time, where `smoke` takes minutes. It uses the smoke test's checks (smoke.rs) on fewer steps:
//!
//! 1. the plain build (BIN, the bytes that get installed), on a flash holding the factory region (as the editor or
//!    tools/fm1_install.py leave it, #915): the loading screen draws (a LCD that is not blank, READY),
//!    the quick start and then the home page (the device page of factory patch 0); silent without keys, a panel key
//!    sounds (the audio path runs); no register fm1-emu does not model besides P33
//! 2. the plain build on a blank flash (no factory region, #915): the firmware tier alone is written into the bank, each
//!    patch into its own slot, no region-only factory slot is written (a region override of a tier patch, #1099, has the
//!    tier patch's slot: the tier's copy is there), and the bar says FACTORY SOUNDS MISSING:, then CONNECT TO
//!    MATRYOSHKA.LOL
//! 3. the plain build's update mode: OCT- + OCT+ held at power-on shows UPDATE MODE, and the flash chip is known
//!    (no NO FLASH ID line: update mode could not stage an update without it)
//! 4. with `--link EMU_BIN` (the same commit's M1_EMU_MIDI=1 build, CI artifact `matryoshka-emu-midi`: the plain build
//!    has no link the emulator can reach, since fm1-emu has no USB controller): the editor protocol answers HELLO with
//!    INFO, and the update protocol (Felucca's M-UPGRADE, firmware/src/ota.c) answers its handshake with a Matryoshka
//!    identity (FM-1_7..), both after boot and in update mode. This is what keeps a firmware installable: the Install
//!    panel and tools/fm1_install.py find the FM-1 by that handshake. Then the factory content's round trip (D-490): on
//!    a blank flash FACT_INFO says none, the editor's install (FACT_BEGIN, every page by FACT_WRITE, FACT_COMMIT) is taken,
//!    FACT_INFO says valid with every factory patch, the bar says the new patches were added and each region patch is in
//!    its slot. Then factory updates reaching untouched slots (D-887): a bank an earlier release left (released_cases.h:
//!    a firmware-tier patch's and a factory-region patch's released copies in their own slots, an edited and a renamed
//!    copy beside them, the release's factory set in the settings record) boots without a factory region and keeps every
//!    slot; the editor installs today's region: the two untouched copies get today's patches in place, the others stay,
//!    the bar says FACTORY PATCHES UPDATED, and the next boot rewrites nothing. Without --link these checks are not made,
//!    and the summary says so.
//!
//! Snapshots go to OUT. The last line is the summary: `boot check: PASS ..` or `boot check: FAIL ..`.

use crate::font;
use crate::machine::{Machine, FACTORY_REGION, FLASH_SIZE};
use crate::serve::{Mailbox, ToBytes, ToPackets};
use crate::smoke::{bank_name, bank_record, factory, note_peak, quick_start, record, released_cases, run_parts, wait_text, Part, Run, C4, DEVICE_PAGE, LOUD, OCT_DOWN, OCT_UP, QUIET};
use std::collections::VecDeque;
use std::process::ExitCode;

/// The editor protocol's prefix and commands (web/src/protocol.ts)
const PREFIX: [u8; 3] = [0x7D, 0x4D, 0x31];
const HELLO: u8 = 0x01;
const INFO: u8 = 0x41;
const PROTO_VERSION: u8 = 1;
/// The factory region's commands and answers (protocol.ts FACT, D-490)
const C_FACT_BEGIN: u8 = 0x16;
const C_FACT_WRITE: u8 = 0x17;
const C_FACT_COMMIT: u8 = 0x1A;
const C_FACT_INFO: u8 = 0x3F;
const R_ACK: u8 = 0x40;
const R_FACT_INFO: u8 = 0x5F;
/// What the firmware compiles in of the factory content (#915): the firmware tier's image FC_TIER
const FACTORY_TIER_H: &str = include_str!("../../../firmware/src/factory_tier.h");

/// The firmware tier's image (factory_tier.h FC_TIER)
fn tier_image() -> Vec<u8> {
    let s = &FACTORY_TIER_H[FACTORY_TIER_H.find("FC_TIER[").expect("FC_TIER")..];
    s[s.find('{').unwrap() + 1..s.find('}').unwrap()].split(',').map(|x| x.trim().parse().unwrap()).collect()
}

/// (name, slot) of an image's patches (firmware/src/factory.c: the count u16 at 20, the directory's offset u32 at 32,
/// 36 bytes each: name[20], the slot u16 at 30)
fn image_patches(img: &[u8]) -> Vec<(String, u32)> {
    let u16_at = |a: usize| u16::from_le_bytes([img[a], img[a + 1]]) as usize;
    let dir = u32::from_le_bytes(img[32..36].try_into().unwrap()) as usize;
    (0..u16_at(20))
        .map(|i| {
            let e = &img[dir + 36 * i..dir + 36 * i + 36];
            (String::from_utf8_lossy(&e[..20]).trim_end_matches('\0').to_string(), u16_at(dir + 36 * i + 30) as u32)
        })
        .collect()
}

/// The region's patches no firmware-tier patch has the name of: what a blank region must not write
fn region_only(tier: &[(String, u32)], region: &[(String, u32)]) -> Vec<(String, u32)> {
    region.iter().filter(|(n, _)| !tier.iter().any(|(tn, _)| tn == n)).cloned().collect()
}

/// Every factory patch with a valid region: the tier's names and the region's, an override counted once
fn merged_count(tier: &[(String, u32)], region: &[(String, u32)]) -> usize {
    tier.len() + region_only(tier, region).len()
}

pub fn run(app: &[u8], link: Option<&[u8]>, out: &str) -> ExitCode {
    let _ = std::fs::create_dir_all(out);
    let mut t = Run::new(out);
    let t0 = std::time::Instant::now();
    let mut emulated = 0u64;
    // each part boots its own machines: they run side by side (smoke.rs run_parts), a thread each
    let mut parts: Vec<Part> = vec![
        ("plain", Box::new(move |t: &mut Run, e: &mut u64| plain(app, t, e))),
        ("blank-region", Box::new(move |t: &mut Run, e: &mut u64| blank_region(app, t, e))),
    ];
    if let Some(l) = link {
        parts.push(("link", Box::new(move |t: &mut Run, e: &mut u64| linked(l, t, e))));
        parts.push(("factory-install", Box::new(move |t: &mut Run, e: &mut u64| factory_install(l, t, e))));
        parts.push(("slot-upgrade", Box::new(move |t: &mut Run, e: &mut u64| slot_upgrade(l, t, e))));
    }
    run_parts(&mut t, &mut emulated, parts);
    let wall = t0.elapsed().as_secs_f64();
    for f in &t.fails {
        println!("  FAIL {f}");
    }
    let ok = t.fails.is_empty();
    println!(
        "boot check: {} ({} checks, {} failed; {}; {:.1} s emulated in {wall:.1} s; snapshots in {out})",
        if ok { "PASS" } else { "FAIL" },
        t.checks,
        t.fails.len(),
        if link.is_some() { "the editor link and the update handshake checked on the M1_EMU_MIDI build" } else { "the link NOT checked: no --link build" },
        emulated as f64 / 1000.0
    );
    if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// The plain build: boot, screen, sound, update mode
fn plain(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    let presets = factory();
    let mut m = Machine::boot(app, None);
    m.run_to(1500)?;
    let colours = {
        let mut c: Vec<u16> = m.lcd().to_vec();
        c.sort_unstable();
        c.dedup();
        c.len()
    };
    t.check("boot: the LCD is drawn (not one colour)", colours > 2, format!("{colours} colours at {} ms", m.ms()));
    t.screen(&m, "boot: the loading screen", "READY");
    let quick = quick_start(&mut m, 8000)?;
    t.check("boot: the quick start over the first page (D-247)", quick, format!("at {} ms", m.ms()));
    let up = wait_text(&mut m, DEVICE_PAGE, 3000)?;
    t.snap(&m, "home-page");
    t.check("boot: HOME closes it: the home page (the device page)", up, format!("at {} ms", m.ms()));
    let named = wait_text(&mut m, &presets[0].0, 4000)?;   // (the first boot's FACTORY BANK WRITTEN holds the bar 2 s)
    t.check("boot: factory patch 0 loaded", named, format!("{:?} at {} ms", presets[0].0, m.ms()));
    let mk = m.mark();
    m.run_for(300)?;
    let p = m.peak_since(mk);
    t.check("audio: silent without keys", p < QUIET, format!("peak {p}"));
    let p = note_peak(&mut m, C4, 600)?;
    t.check("audio: a panel key (C4) sounds", p > LOUD, format!("peak {p}"));
    let known = [0x13e08u32, 0x13e0c]; // P33 (watchdog, reset reason, reboot): fm1_sys.h
    let unknown: Vec<_> = m.unknown_mmio().into_iter().filter(|(a, ..)| !known.contains(a)).collect();
    for (a, w, n) in &unknown {
        t.say(format!("     unmodelled register {} {a:#010x} x{n}", if *w { "write" } else { "read" }));
    }
    t.check("no registers fm1-emu does not model besides P33", unknown.is_empty(), format!("{} other", unknown.len()));
    *emulated += m.ms();

    let mut m = update_mode(app)?;
    t.screen(&m, "update mode: OCT- + OCT+ held at power-on", "UPDATE MODE");
    t.check("update mode: the flash chip is known (updates can be staged)", !font::on_screen(m.lcd(), "NO FLASH ID"), String::new());
    let p = note_peak(&mut m, C4, 300)?;
    t.check("update mode: no engine (a key is silent)", p < QUIET, format!("peak {p}"));
    *emulated += m.ms();
    Ok(())
}

/// A blank flash (no factory region, #915): the firmware tier alone in the bank, in its slots; the bar says where to get
/// the rest
fn blank_region(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    let mut m = Machine::boot(app, Some(&vec![0xffu8; FLASH_SIZE]));
    quick_start(&mut m, 9000)?;
    let missing = wait_text(&mut m, "FACTORY SOUNDS MISSING", 4000)?;
    t.snap(&m, "blank-region");
    t.check("blank region: the bar says FACTORY SOUNDS MISSING:", missing, format!("at {} ms", m.ms()));
    let connect = wait_text(&mut m, "CONNECT TO MATRYOSHKA.LOL", 6000)?;
    t.check("blank region: then CONNECT TO MATRYOSHKA.LOL", connect, format!("at {} ms", m.ms()));
    let f = m.flash();
    let tier = image_patches(&tier_image());
    let region = image_patches(FACTORY_REGION);
    let missing_tier: Vec<_> = tier.iter().filter(|(_, s)| bank_record(&f, *s).is_none()).map(|(n, _)| n.clone()).collect();
    let written_region: Vec<_> = region_only(&tier, &region).into_iter().filter(|(_, s)| bank_record(&f, *s).is_some()).map(|(n, _)| n).collect();
    t.check("blank region: each firmware-tier patch is written into its own slot", !tier.is_empty() && missing_tier.is_empty(), format!("missing {missing_tier:?}"));
    t.check("blank region: no region-only patch is written (an override's slot holds the tier's own patch)", written_region.is_empty(), format!("{written_region:?}"));
    let p = note_peak(&mut m, C4, 600)?;
    t.check("blank region: the firmware tier plays (a panel key sounds)", p > LOUD, format!("peak {p}"));
    *emulated += m.ms();
    Ok(())
}

/// A machine booted with OCT- + OCT+ held, in update mode by 3.5 s
fn update_mode(app: &[u8]) -> Result<Machine, String> {
    let mut m = Machine::boot(app, None);
    m.key(OCT_DOWN, true);
    m.key(OCT_UP, true);
    m.run_to(3000)?;
    m.key(OCT_DOWN, false);
    m.key(OCT_UP, false);
    m.run_for(500)?;
    Ok(m)
}

/// The emulated USB MIDI of an M1_EMU_MIDI=1 build: serve.rs's mailbox, without a MIDI port
struct Link {
    mb: Option<Mailbox>,
    q: VecDeque<u32>,
    to_pk: ToPackets,
    to_by: ToBytes,
    got: Vec<Vec<u8>>,
}

impl Link {
    fn new() -> Link {
        Link { mb: None, q: VecDeque::new(), to_pk: ToPackets::default(), to_by: ToBytes::default(), got: Vec::new() }
    }
    fn send(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.to_pk.feed(b, &mut self.q);
        }
    }
    /// run `ms` emulated ms, the mailbox served every 2 ms
    fn run(&mut self, m: &mut Machine, ms: u64) -> Result<(), String> {
        let end = m.ms() + ms;
        while m.ms() < end {
            m.run_for(2)?;
            if self.mb.is_none() && m.ms() >= 20 {
                self.mb = Mailbox::find(m);
            }
            if let Some(b) = &self.mb {
                b.push(m, &mut self.q);
                let mut pk = Vec::new();
                b.pull(m, &mut pk);
                for p in pk {
                    self.to_by.feed(p, &mut self.got);
                }
            }
        }
        Ok(())
    }
    /// run up to `ms` until a message `f` takes arrives (messages before it are dropped)
    fn wait<T>(&mut self, m: &mut Machine, ms: u64, f: impl Fn(&[u8]) -> Option<T>) -> Result<Option<T>, String> {
        let end = m.ms() + ms;
        loop {
            for msg in std::mem::take(&mut self.got) {
                if let Some(v) = f(&msg) {
                    return Ok(Some(v));
                }
            }
            if m.ms() >= end {
                return Ok(None);
            }
            self.run(m, 10)?;
        }
    }
}

/// 8-bit bytes into 7-bit ones, low bits first (protocol.ts pack7, ota.c ota_pack7)
fn pack7(bytes: &[u8]) -> Vec<u8> {
    let (mut out, mut acc, mut nb) = (Vec::new(), 0u32, 0u32);
    for &b in bytes {
        acc |= (b as u32) << nb;
        nb += 8;
        while nb >= 7 {
            out.push((acc & 0x7f) as u8);
            acc >>= 7;
            nb -= 7;
        }
    }
    if nb > 0 {
        out.push((acc & 0x7f) as u8);
    }
    out
}

fn unpack7(septets: &[u8]) -> Vec<u8> {
    let (mut out, mut acc, mut nb) = (Vec::new(), 0u32, 0u32);
    for &s in septets {
        acc |= ((s & 0x7f) as u32) << nb;
        nb += 7;
        if nb >= 8 {
            out.push(acc as u8);
            acc >>= 8;
            nb -= 8;
        }
    }
    out
}

/// The editor's INFO: (protocol version, flags, features, firmware version)
fn info(msg: &[u8]) -> Option<(u8, u8, u32, Option<[u8; 3]>)> {
    let n = msg.len();
    if n < 6 || msg[0] != 0xF0 || msg[n - 1] != 0xF7 || msg[1..4] != PREFIX || msg[4] != INFO {
        return None;
    }
    let p = unpack7(&msg[5..n - 1]);
    if p.len() < 5 {
        return None;
    }
    let at = |i: usize| *p.get(i).unwrap_or(&0) as u32;
    let features = at(5) | at(6) << 8 | at(12) << 16;
    Some((p[0], p[3], features, (p.len() >= 12).then(|| [p[9], p[10], p[11]])))
}

/// An editor frame: F0, the prefix, the command, the payload packed into 7-bit bytes, F7 (protocol.ts frame)
fn frame(cmd: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = vec![0xF0, PREFIX[0], PREFIX[1], PREFIX[2], cmd];
    f.extend(pack7(payload));
    f.push(0xF7);
    f
}

/// The payload of an answer of ours with command `cmd`
fn reply(msg: &[u8], cmd: u8) -> Option<Vec<u8>> {
    let n = msg.len();
    (n >= 6 && msg[0] == 0xF0 && msg[n - 1] == 0xF7 && msg[1..4] == PREFIX && msg[4] == cmd).then(|| unpack7(&msg[5..n - 1]))
}

/// The status of an ACK of `cmd` (proto.c m1_ack: cmd, seq, status, ..)
fn ack(msg: &[u8], cmd: u8) -> Option<u8> {
    reply(msg, R_ACK).filter(|p| p.len() >= 3 && p[0] == cmd).map(|p| p[2])
}

/// M-UPGRADE's handshake (ota.c: F0 pack7(00 59 cmd len24 body chk) F7, cmd 0x11, no body)
fn handshake() -> Vec<u8> {
    let mut f = vec![0xF0];
    f.extend(pack7(&[0x00, 0x59, 0x11, 0, 0, 0, 0xFF]));
    f.push(0xF7);
    f
}

/// Its answer: the identity (ota.c ota_reply_identity, 27 bytes, zero padded)
fn identity(msg: &[u8]) -> Option<String> {
    let n = msg.len();
    if n < 3 || msg[0] != 0xF0 || msg[n - 1] != 0xF7 || msg[1] == PREFIX[0] {
        return None;
    }
    let d = unpack7(&msg[1..n - 1]);
    if d.len() < 7 || d[0] != 0 || d[1] != 0x59 || d[2] != 0x11 {
        return None;
    }
    let len = d[3] as usize | (d[4] as usize) << 8 | (d[5] as usize) << 16;
    let body = d.get(6..6 + len)?;
    Some(body.iter().take_while(|&&b| b != 0).map(|&b| b as char).collect())
}

/// The identities of Matryoshka builds (D-178): FM-1_7 and digits
fn ours(id: &str) -> bool {
    id.strip_prefix("FM-1_7").is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()))
}

/// The M1_EMU_MIDI=1 build: HELLO answered with INFO, the update handshake answered after boot and in update mode
fn linked(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    let mut m = Machine::boot(app, None);
    let mut l = Link::new();
    l.run(&mut m, 1500)?;
    let found = l.mb.is_some();
    t.check("link: the M1_EMU_MIDI build's mailbox is there", found, if found { String::new() } else { "is --link an M1_EMU_MIDI=1 build?".into() });
    if !found {
        *emulated += m.ms();
        return Ok(());
    }
    // the firmware answers a host from the loading screen on (host_poll), before any patch loads
    l.send(&[0xF0, PREFIX[0], PREFIX[1], PREFIX[2], HELLO, 0xF7]);
    let got = l.wait(&mut m, 1500, info)?;
    t.check("link: HELLO is answered with INFO", got.is_some(), format!("at {} ms", m.ms()));
    if let Some((version, flags, features, fw)) = got {
        t.say(format!("     INFO: protocol {version}, flash {}, features {features:#x}, firmware {}", if flags & 1 != 0 { "ok" } else { "NOT ok" },
            fw.map_or("before 1.8".into(), |v| format!("{}.{}.{}", v[0], v[1], v[2]))));
        t.check("link: INFO's protocol version", version == PROTO_VERSION, format!("{version}"));
        t.check("link: INFO says the flash is ok", flags & 1 != 0, format!("flags {flags:#x}"));
    }
    l.send(&handshake());
    let id = l.wait(&mut m, 1500, identity)?;
    t.check("update: the M-UPGRADE handshake is answered with a Matryoshka identity", id.as_deref().is_some_and(ours), format!("{id:?}"));
    // the editor still answers once the page is up
    quick_start(&mut m, 8000)?;
    l.run(&mut m, 500)?;
    l.send(&[0xF0, PREFIX[0], PREFIX[1], PREFIX[2], HELLO, 0xF7]);
    let got = l.wait(&mut m, 1500, info)?;
    t.check("link: HELLO on the home page is answered with INFO", got.is_some(), format!("at {} ms", m.ms()));
    t.snap(&m, "link-home");
    *emulated += m.ms();

    // update mode: the updater must still find it (the way back from a bad build)
    let mut m = Machine::boot(app, None);
    let mut l = Link::new();
    m.key(OCT_DOWN, true);
    m.key(OCT_UP, true);
    l.run(&mut m, 3000)?;
    m.key(OCT_DOWN, false);
    m.key(OCT_UP, false);
    l.run(&mut m, 500)?;
    t.screen(&m, "update mode (M1_EMU_MIDI build): OCT- + OCT+ held at power-on", "UPDATE MODE");
    l.send(&handshake());
    let id = l.wait(&mut m, 1500, identity)?;
    t.check("update mode: the M-UPGRADE handshake is answered with a Matryoshka identity", id.as_deref().is_some_and(ours), format!("{id:?}"));
    *emulated += m.ms();
    Ok(())
}

/// The editor's install of `img` over the link (FACT_BEGIN, every page by FACT_WRITE, FACT_COMMIT), as protocol.ts and
/// tools/fm1_install.py write it: pages inside one 256-byte page each, sector 0 after the header's 64 bytes, a record page
/// at 0xF00 written whole. FACT_BEGIN's status, the pages written (or the first refusal), FACT_COMMIT's status
fn install(m: &mut Machine, l: &mut Link, img: &[u8]) -> Result<(Option<u8>, Result<usize, String>, Option<u8>), String> {
    l.send(&frame(C_FACT_BEGIN, &[]));
    let begin = l.wait(m, 3000, |x| ack(x, C_FACT_BEGIN))?;
    let mut pages = 0;
    for s in 0..img.len().div_ceil(0x1000) {
        let mut off = if s == 0 { 64 } else { 0 };
        while off < 0x1000 && s * 0x1000 + off < img.len() {
            let at = s * 0x1000 + off;
            let mut page = img[at..at + (256 - (off & 0xFF)).min(img.len() - at)].to_vec();
            if off & 0xF00 == 0xF00 && page.len() < 80 {
                page.resize(256, 0xFF);                 // (the page an update record would be in: whole)
            }
            let mut p = vec![s as u8, off as u8, (off >> 8) as u8];
            p.extend_from_slice(&page);
            l.send(&frame(C_FACT_WRITE, &p));
            let st = l.wait(m, 3000, |x| ack(x, C_FACT_WRITE))?;
            if st != Some(0) {
                return Ok((begin, Err(format!("sector {s} offset {off:#x}: {st:?}")), None));
            }
            pages += 1;
            off = (off | 0xFF) + 1;
        }
    }
    l.send(&frame(C_FACT_COMMIT, &img[..64]));
    let commit = l.wait(m, 5000, |x| ack(x, C_FACT_COMMIT))?;
    Ok((begin, Ok(pages), commit))
}

/// The factory content over the link on the M1_EMU_MIDI build (#915, D-490): a blank flash, the image installed as the
/// editor and tools/fm1_install.py write it, then FACT_INFO and the bank
fn factory_install(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    let mut m = Machine::boot(app, Some(&vec![0xffu8; FLASH_SIZE]));
    let mut l = Link::new();
    l.run(&mut m, 1500)?;
    quick_start(&mut m, 8000)?;
    l.run(&mut m, 500)?;
    let tier = image_patches(&tier_image());
    let region = image_patches(FACTORY_REGION);
    l.send(&frame(C_FACT_INFO, &[]));
    let before = l.wait(&mut m, 1500, |x| reply(x, R_FACT_INFO))?;
    t.check("factory link: FACT_INFO on a blank flash: no region, the firmware tier alone plays",
        before.as_ref().is_some_and(|p| p.len() >= 26 && p[0] == 0 && p[16] & 2 != 0), format!("{before:?}"));
    let img = FACTORY_REGION;
    let (begin, pages, commit) = install(&mut m, &mut l, img)?;
    t.check("factory link: FACT_BEGIN is acknowledged S_OK", begin == Some(0), format!("{begin:?}"));
    t.check("factory link: FACT_WRITE takes every page of the image", pages.is_ok(), pages.map_or_else(|e| e, |n| format!("{n} pages")));
    t.check("factory link: FACT_COMMIT is acknowledged S_OK", commit == Some(0), format!("{commit:?}"));
    let added = wait_text(&mut m, "NEW PATCHES ADDED", 8000)?;
    t.snap(&m, "factory-installed");
    t.check("factory link: the bar says the region's patches were added", added, format!("at {} ms", m.ms()));
    l.send(&frame(C_FACT_INFO, &[]));
    let after = l.wait(&mut m, 1500, |x| reply(x, R_FACT_INFO))?;
    t.check("factory link: FACT_INFO says valid, the region's patches, every factory patch in all (tier and region names, an override counted once)",
        after.as_ref().is_some_and(|p| p.len() >= 26 && p[0] == 1 && p[16] & 2 == 0 && p[14] as usize == region.len() && p[25] as usize == merged_count(&tier, &region)),
        format!("{after:?}"));
    let f = m.flash();
    let missing: Vec<_> = region.iter().filter(|(_, s)| bank_record(&f, *s).is_none()).map(|(n, _)| n.clone()).collect();
    t.check("factory link: each region patch is in its own slot", missing.is_empty(), format!("missing {missing:?}"));
    let flash_img = &f[crate::machine::FACTORY_BASE..crate::machine::FACTORY_BASE + img.len()];
    t.check("factory link: the region holds the image byte for byte", flash_img == img, String::new());
    *emulated += m.ms();
    Ok(())
}

/// Factory updates reach untouched slots (firmware/src/bank_upgrade.h, D-887 amended 2026-11-19) on the M1_EMU_MIDI build:
/// a bank an earlier release left and no factory region, then today's region installed over the link while it runs
fn slot_upgrade(app: &[u8], t: &mut Run, emulated: &mut u64) -> Result<(), String> {
    const OLD_SET: u32 = 0x55ce34;              // (1.20.1's factory set: an earlier one than today's)
    const EDITED: u32 = 30;
    const RENAMED: u32 = 31;
    let version: u8 = include_str!("../../../firmware/src/engine.h").split("#define ENG_PATCH_VERSION ").nth(1).and_then(|s| s.split_whitespace().next()?.parse().ok()).ok_or("ENG_PATCH_VERSION")?;
    let cases = released_cases();
    let presets = factory();
    let tier = image_patches(&tier_image());
    let region = image_patches(FACTORY_REGION);
    // each case: its name, its own slot (the image's record), the released copy, today's bytes
    let mut own = Vec::new();
    for (k, (name, old)) in cases.iter().enumerate() {
        let slot = (if k == 0 { &tier } else { &region }).iter().find(|p| &p.0 == name).map(|p| p.1).ok_or(format!("{name}: not in its image"))?;
        let today = presets.iter().find(|p| &p.0 == name).map(|p| p.1.clone()).ok_or(format!("{name}: not a factory patch"))?;
        own.push((name.clone(), slot, old.clone(), today));
    }
    let mut edited = own[0].2.clone();
    let last = edited.len() - 1;
    edited[last] ^= 1;
    let mut flash = vec![0xffu8; FLASH_SIZE];
    let put = |f: &mut Vec<u8>, sec: usize, s: Vec<u8>| f[0xA0000 + sec * 0x1000..0xA1000 + sec * 0x1000].copy_from_slice(&s);
    for (k, (name, slot, old, _)) in own.iter().enumerate() {
        put(&mut flash, k, record(*slot, 1 + k as u32, name, old, false));
    }
    put(&mut flash, 2, record(EDITED, 3, &own[0].0, &edited, false));
    put(&mut flash, 3, record(RENAMED, 4, "MY COPY", &own[1].2, false));
    // the release's settings record: slot (the tier case's), octave 0, accel, today's format, module 0, count-in off, its set
    let set = [1, own[0].1 as u8, 8, 0, 1, 0, 0, 0, 0, 1, version, 0, 0, OLD_SET as u8, (OLD_SET >> 8) as u8, (OLD_SET >> 16) as u8];
    put(&mut flash, 4, record(64, 5, "", &set, false));
    let slots = [(own[0].1, 1u32), (own[1].1, 2), (EDITED, 3), (RENAMED, 4)];
    let unchanged = |f: &[u8]| slots.iter().all(|&(s, seq)| bank_record(f, s).is_some_and(|r| r.0 == seq));

    let mut m = Machine::boot(app, Some(&flash));
    let mut l = Link::new();
    l.run(&mut m, 1500)?;
    quick_start(&mut m, 8000)?;
    let missing = wait_text(&mut m, "FACTORY SOUNDS MISSING", 4000)?;
    l.run(&mut m, 500)?;
    t.check("slot upgrade: a bank an earlier release left, no factory region: every slot as it was, the bar says FACTORY SOUNDS MISSING:",
        missing && unchanged(&m.flash()), String::new());
    let (begin, pages, commit) = install(&mut m, &mut l, FACTORY_REGION)?;
    t.check("slot upgrade: the editor installs today's region while it runs", begin == Some(0) && pages.is_ok() && commit == Some(0),
        format!("{begin:?} {pages:?} {commit:?}"));
    let said = wait_text(&mut m, "FACTORY PATCHES UPDATED", 8000)?;
    t.snap(&m, "slot-upgrade");
    t.check("slot upgrade: the bar says FACTORY PATCHES UPDATED", said, format!("at {} ms", m.ms()));
    l.run(&mut m, 500)?;
    let f = m.flash();
    for (k, (name, slot, _, today)) in own.iter().enumerate() {
        let r = bank_record(&f, *slot);
        t.check(&format!("slot upgrade: the untouched {} copy of {name} has today's patch, in slot {}, under its name", if k == 0 { "firmware-tier" } else { "factory-region" }, slot + 1),
            r.as_ref().is_some_and(|r| r.0 > 5 && &r.1 == today) && bank_name(&f, *slot).as_deref() == Some(name.as_str()),
            r.map_or("gone".into(), |r| format!("sequence {}, {} bytes", r.0, r.1.len())));
    }
    t.check("slot upgrade: the edited copy stays as it is", bank_record(&f, EDITED) == Some((3, edited.clone())), String::new());
    t.check("slot upgrade: the renamed copy stays as it is", bank_record(&f, RENAMED) == Some((4, own[1].2.clone())), String::new());
    *emulated += m.ms();

    let mut m = Machine::boot(app, Some(&f));
    quick_start(&mut m, 9000)?;
    let again = wait_text(&mut m, "FACTORY PATCHES UPDATED", 2500)?;
    wait_text(&mut m, DEVICE_PAGE, 9000)?;
    t.check("slot upgrade: the next boot rewrites nothing", !again && m.flash() == f, String::new());
    *emulated += m.ms();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(names: &[(&str, u32)]) -> Vec<(String, u32)> {
        names.iter().map(|(n, s)| (n.to_string(), *s)).collect()
    }

    /// The region's patches that override a firmware-tier patch of the same name (#1099)
    fn overrides(tier: &[(String, u32)], region: &[(String, u32)]) -> Vec<(String, u32)> {
        region.iter().filter(|(n, _)| tier.iter().any(|(tn, _)| tn == n)).cloned().collect()
    }

    #[test]
    fn overrides_of_tier_patches_are_counted_once() {
        let tier = p(&[("ALGO FOUR", 3), ("CASSIA 1", 7), ("BASS", 1)]);
        let region = p(&[("ALGO FOUR", 3), ("CASSIA 1", 7), ("PAD", 20)]);
        assert_eq!(overrides(&tier, &region), p(&[("ALGO FOUR", 3), ("CASSIA 1", 7)]));
        assert_eq!(region_only(&tier, &region), p(&[("PAD", 20)]));
        assert_eq!(merged_count(&tier, &region), 4);
    }

    #[test]
    fn a_region_without_overrides_adds_every_patch() {
        let tier = p(&[("BASS", 1)]);
        let region = p(&[("PAD", 20), ("LEAD", 21)]);
        assert!(overrides(&tier, &region).is_empty());
        assert_eq!(region_only(&tier, &region), region);
        assert_eq!(merged_count(&tier, &region), 3);
    }

    #[test]
    fn the_shipped_region_and_tier_merge() {
        let tier = image_patches(&tier_image());
        let region = image_patches(FACTORY_REGION);
        let union: std::collections::HashSet<_> = tier.iter().chain(&region).map(|(n, _)| n.clone()).collect();
        assert_eq!(merged_count(&tier, &region), union.len());
        for (n, s) in overrides(&tier, &region) {
            assert_eq!(tier.iter().find(|(tn, _)| *tn == n).map(|x| x.1), Some(s), "{n}: an override takes the tier patch's slot");
        }
    }
}
