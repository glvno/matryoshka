//! `m1emu boot`: the boot check, a quick gate for installs on the test rig while the owner iterates (D-123). About 20 s
//! of emulated time, where `smoke` takes minutes. It uses the smoke test's checks (smoke.rs) on fewer steps:
//!
//! 1. the plain build (BIN, the bytes that get installed): the loading screen draws (a LCD that is not blank, READY),
//!    the quick start and then the home page (the device page of factory patch 0); silent without keys, a panel key
//!    sounds (the audio path runs); no register fm1-emu does not model besides P33
//! 2. the plain build's update mode: OCT- + OCT+ held at power-on shows UPDATE MODE, and the flash chip is known
//!    (no NO FLASH ID line: update mode could not stage an update without it)
//! 3. with `--link EMU_BIN` (the same commit's M1_EMU_MIDI=1 build, CI artifact `matryoshka-emu-midi`: the plain build
//!    has no link the emulator can reach, since fm1-emu has no USB controller): the editor protocol answers HELLO with
//!    INFO, and the update protocol (Felucca's M-UPGRADE, firmware/src/ota.c) answers its handshake with a Matryoshka
//!    identity (FM-1_7..), both after boot and in update mode. This is what keeps a firmware installable: the Install
//!    panel and tools/fm1_install.py find the FM-1 by that handshake. Without --link these checks are not made, and the
//!    summary says so.
//!
//! Snapshots go to OUT. The last line is the summary: `boot check: PASS ..` or `boot check: FAIL ..`.

use crate::font;
use crate::machine::Machine;
use crate::serve::{Mailbox, ToBytes, ToPackets};
use crate::smoke::{factory, note_peak, quick_start, wait_text, Run, C4, DEVICE_PAGE, LOUD, OCT_DOWN, OCT_UP, QUIET};
use std::collections::VecDeque;
use std::process::ExitCode;

/// The editor protocol's prefix and commands (web/src/protocol.ts)
const PREFIX: [u8; 3] = [0x7D, 0x4D, 0x31];
const HELLO: u8 = 0x01;
const INFO: u8 = 0x41;
const PROTO_VERSION: u8 = 1;

pub fn run(app: &[u8], link: Option<&[u8]>, out: &str) -> ExitCode {
    let _ = std::fs::create_dir_all(out);
    let mut t = Run { out: out.to_string(), fails: Vec::new(), warns: Vec::new(), checks: 0, shot: 0 };
    let t0 = std::time::Instant::now();
    let mut emulated = 0u64;
    let r = plain(app, &mut t, &mut emulated).and_then(|_| match link {
        Some(l) => linked(l, &mut t, &mut emulated),
        None => Ok(()),
    });
    if let Err(e) = r {
        t.check("the firmware keeps running", false, format!("halt: {e}"));
    }
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
        println!("     unmodelled register {} {a:#010x} x{n}", if *w { "write" } else { "read" });
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
        println!("     INFO: protocol {version}, flash {}, features {features:#x}, firmware {}", if flags & 1 != 0 { "ok" } else { "NOT ok" },
            fw.map_or("before 1.8".into(), |v| format!("{}.{}.{}", v[0], v[1], v[2])));
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
