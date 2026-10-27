//! `m1emu serve`: the emulated FM-1 in real time, its USB MIDI on a virtual MIDI port, driven from stdin (#290).
//!
//! The firmware must be an M1_EMU_MIDI=1 build (the CI artifact `matryoshka-emu-midi`): fm1-emu has no USB controller,
//! so that build moves its USB-MIDI event packets through a mailbox in RAM (firmware/src/usb.c `m1_emu_mb`), found here
//! by its two magic words. The packets go to and from a CoreMIDI virtual source and destination (macOS), named
//! "FM-1 (emu)" by default: Chrome's Web MIDI lists it like a real FM-1, and the editor connects to it.
//!
//! The emulator is paced to the wall clock (it never runs ahead; the interpreter runs at about 0.75x real time at
//! 240 MHz, so it falls behind under load: the firmware's own timers keep emulated time). Commands, one per line on
//! stdin, each answered by one line on stdout:
//!   key ID 0|1          a panel key down (1) or up (0): 0..13 buttons, 14..40 the note keys F3..G5      -> ok
//!   tap ID [HOLD]       down, up after HOLD ms (default 80)                                              -> ok
//!   turn ENC CLICKS     an encoder (0 SELECT, 1 ALGO, 2..5 K1..K4, 6 PRESET)                            -> ok
//!   midi HEX..          bytes into the TRS MIDI IN jack                                                  -> ok
//!   text STRING         is STRING on the LCD now (the firmware's fonts, font.rs)                         -> text 1 | text 0
//!   snap PATH           the LCD as a PNG                                                                 -> ok
//!   mark                where the audio stands (a sample count)                                          -> mark N
//!   peak MARK           the loudest sample since MARK (16 bit)                                           -> peak N
//!   wav MARK PATH       the audio since MARK as a WAV                                                    -> ok
//!   ms                  emulated time                                                                    -> ms N
//!   wait MS             answers after MS emulated ms (the commands after it wait too)                    -> ok
//!   until MS STRING     waits up to MS emulated ms for STRING on the LCD; N: the emulated ms it took     -> until 1 N | until 0 MS
//!   deaf 1|0            1: the host stops taking the FM-1's packets (a computer where no app reads its MIDI, #375):
//!                       the mailbox's out[] fills, then the firmware's SysEx ring; 0: it reads again    -> ok
//!   quit
//! Lines on stdout that are not answers start with "# " (with M1EMU_TRACE set: every short message the FM-1 sends).

use crate::machine::Machine;
use fm1_core::Bus;
use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAGIC0: u32 = 0x4D31_454D; // "M1EM"
const MAGIC1: u32 = 0x4D49_4449; // "MIDI"
const EMB_N: u32 = 256;
const RAM_LO: u32 = 0x01C0_0000;
const RAM_HI: u32 = 0x01C8_0000;
/// the audio kept for `peak` / `wav` (samples, stereo interleaved): 60 s
const KEEP: usize = 60 * 44118 * 2;

/// The mailbox's word offsets (usb.c: magic0, magic1, in_w, in_r, out_w, out_r, in[256], out[256])
struct Mailbox {
    base: u32,
}

impl Mailbox {
    fn find(m: &mut Machine) -> Option<Mailbox> {
        let mut a = RAM_LO;
        while a + 8 <= RAM_HI {
            if m.soc.read32(a) == MAGIC0 && m.soc.read32(a + 4) == MAGIC1 {
                return Some(Mailbox { base: a });
            }
            a += 4;
        }
        None
    }
    fn w(&self, i: u32) -> u32 {
        self.base + 4 * i
    }
    /// host -> firmware: as many packets as fit
    fn push(&self, m: &mut Machine, q: &mut VecDeque<u32>) {
        let (iw, ir) = (m.soc.read32(self.w(2)), m.soc.read32(self.w(3)));
        let mut w = iw;
        while w.wrapping_sub(ir) < EMB_N {
            let Some(p) = q.pop_front() else { break };
            m.soc.write32(self.w(6 + w % EMB_N), p);
            w = w.wrapping_add(1);
        }
        if w != iw {
            m.soc.write32(self.w(2), w);
        }
    }
    /// firmware -> host: every packet waiting
    fn pull(&self, m: &mut Machine, out: &mut Vec<u32>) {
        let (ow, mut or) = (m.soc.read32(self.w(4)), m.soc.read32(self.w(5)));
        if or == ow {
            return;
        }
        while or != ow {
            out.push(m.soc.read32(self.w(6 + EMB_N + or % EMB_N)));
            or = or.wrapping_add(1);
        }
        m.soc.write32(self.w(5), or);
    }
}

/// MIDI bytes (as CoreMIDI hands them over, SysEx possibly in pieces) -> USB-MIDI event packets (cable 0)
#[derive(Default)]
struct ToPackets {
    sx: Vec<u8>,
    in_sx: bool,
    run: Vec<u8>,
}

impl ToPackets {
    fn feed(&mut self, b: u8, q: &mut VecDeque<u32>) {
        if b >= 0xF8 {
            q.push_back(0x0F | (b as u32) << 8);
            return;
        }
        if self.in_sx {
            if b == 0xF7 {
                self.sx.push(b);
                self.flush_sx(q, true);
                self.in_sx = false;
                return;
            }
            if b & 0x80 == 0 {
                self.sx.push(b);
                if self.sx.len() == 3 {
                    self.flush_sx(q, false);
                }
                return;
            }
            self.in_sx = false; // another status ends it, unfinished
            self.sx.clear();
        }
        if b == 0xF0 {
            self.in_sx = true;
            self.sx.clear();
            self.sx.push(b);
            return;
        }
        if b & 0x80 != 0 {
            self.run.clear();
        }
        self.run.push(b);
        let st = self.run[0];
        if st & 0x80 == 0 {
            self.run.clear(); // data without a status: dropped
            return;
        }
        let need = match st & 0xF0 {
            0xC0 | 0xD0 => 2,
            0xF0 => match st {
                0xF1 | 0xF3 => 2,
                0xF2 => 3,
                _ => 1,
            },
            _ => 3,
        };
        if self.run.len() == need {
            let cin = if st < 0xF0 { (st >> 4) as u32 } else { [5, 2, 3][need - 1] };
            let mut p = cin;
            for (k, &x) in self.run.iter().enumerate() {
                p |= (x as u32) << (8 * (k + 1));
            }
            q.push_back(p);
            self.run.truncate(if st < 0xF0 { 1 } else { 0 }); // running status
            if st >= 0xF0 {
                self.run.clear();
            }
        }
    }
    fn flush_sx(&mut self, q: &mut VecDeque<u32>, end: bool) {
        let n = self.sx.len() as u32;
        let cin = if !end { 4 } else { 4 + n };
        let mut p = cin;
        for (k, &x) in self.sx.iter().enumerate() {
            p |= (x as u32) << (8 * (k + 1));
        }
        q.push_back(p);
        self.sx.clear();
    }
}

/// USB-MIDI event packets -> whole MIDI messages (SysEx sent once complete). A SysEx cut short (no F7: the FM-1's
/// ota_wire_send gives up mid-message when the host has stopped reading, #375) ends at the next F0, as a status byte
/// ends a SysEx for a MIDI receiver (Chrome's Web MIDI parser, by its source, too): it is dropped, counted in `cut`, and
/// the new message is kept.
#[derive(Default)]
struct ToBytes {
    sx: Vec<u8>,
    cut: u32,
}

impl ToBytes {
    fn feed(&mut self, p: u32, out: &mut Vec<Vec<u8>>) {
        let cin = p & 15;
        let b = [(p >> 8) as u8, (p >> 16) as u8, (p >> 24) as u8];
        let n = match cin {
            4 | 7 => 3,
            6 => 2,
            5 => 1,
            8..=0xB | 0xE => 3,
            0xC | 0xD => 2,
            0xF => 1,
            2 => 2,
            3 => 3,
            _ => 0,
        };
        let bytes = &b[..n];
        match cin {
            4..=7 => {
                if bytes.first() == Some(&0xF0) && !self.sx.is_empty() {
                    self.sx.clear();
                    self.cut += 1;
                }
                self.sx.extend_from_slice(bytes);
                if cin != 4 || bytes.contains(&0xF7) {
                    out.push(std::mem::take(&mut self.sx)); // a whole SysEx, or a lone system common byte (CIN 5)
                }
            }
            _ if n > 0 => out.push(bytes.to_vec()),
            _ => {}
        }
    }
}

enum Cmd {
    Line(String),
    Eof,
}

/// `wait` / `until`: the commands after it wait while the emulator runs on
struct Pending {
    start: u64,
    end: u64,
    text: Option<String>,
    /// when the LCD was last looked at
    seen_at: u64,
}

pub fn run(app: &[u8], flash: Option<&[u8]>, name: &str) -> std::process::ExitCode {
    let mut m = Machine::boot(app, flash);

    // the virtual ports first: the editor may already be waiting for them
    let inbox: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let ports = match midi::open(name, inbox.clone()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("m1emu serve: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let (tx, rx) = mpsc::channel::<Cmd>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx.send(Cmd::Line(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(Cmd::Eof);
    });

    let out = std::io::stdout();
    let say = |s: String| {
        let mut o = out.lock();
        let _ = writeln!(o, "{s}");
        let _ = o.flush();
    };

    let mut mb: Option<Mailbox> = None;
    let mut to_pk = ToPackets::default();
    let mut to_by = ToBytes::default();
    let mut q_in: VecDeque<u32> = VecDeque::new();
    let mut releases: Vec<(u64, u8)> = Vec::new();
    let mut dropped: usize = 0; // audio samples trimmed from the front
    let t0 = Instant::now();
    let e0 = m.ms();
    let mut announced = false;
    let trace = std::env::var_os("M1EMU_TRACE").is_some(); // short messages out, on stdout as comments
    let mut pending: Option<Pending> = None;
    let mut deaf = false; // the host takes nothing from the FM-1 (`deaf 1`)

    loop {
        // commands (none while a `wait` / `until` runs)
        while pending.is_none() {
            match rx.try_recv() {
                Ok(Cmd::Eof) | Err(mpsc::TryRecvError::Disconnected) => return std::process::ExitCode::SUCCESS,
                Ok(Cmd::Line(l)) => {
                    let w: Vec<&str> = l.split_whitespace().collect();
                    let num = |i: usize| w.get(i).and_then(|v| v.parse::<i64>().ok());
                    match w.first().copied() {
                        Some("key") => {
                            if let (Some(id), Some(d)) = (num(1), num(2)) {
                                m.key(id as u8, d != 0);
                            }
                            say("ok".into());
                        }
                        Some("tap") => {
                            if let Some(id) = num(1) {
                                m.key(id as u8, true);
                                releases.push((m.ms() + num(2).unwrap_or(80) as u64, id as u8));
                            }
                            say("ok".into());
                        }
                        Some("turn") => {
                            if let (Some(e), Some(c)) = (num(1), num(2)) {
                                let _ = m.turn(e as u8, c as i32, 0);
                            }
                            say("ok".into());
                        }
                        Some("midi") => {
                            let bytes: Vec<u8> = w[1..].iter().filter_map(|h| u8::from_str_radix(h, 16).ok()).collect();
                            let _ = m.midi(&bytes, 0);
                            say("ok".into());
                        }
                        Some("text") => {
                            let s = l.trim_start()[4..].trim();
                            say(format!("text {}", crate::font::on_screen(m.lcd(), s) as u8));
                        }
                        Some("snap") => {
                            if let Some(p) = w.get(1) {
                                m.snap(p);
                            }
                            say("ok".into());
                        }
                        Some("mark") => say(format!("mark {}", dropped + m.audio.len())),
                        Some("peak") => {
                            let from = (num(1).unwrap_or(0) as usize).saturating_sub(dropped);
                            say(format!("peak {}", m.peak_since(from)));
                        }
                        Some("wav") => {
                            let from = (num(1).unwrap_or(0) as usize).saturating_sub(dropped).min(m.audio.len());
                            if let Some(p) = w.get(2) {
                                let _ = crate::machine::write_wav(&m.audio[from..], p, crate::smoke::AUDIO_RATE);
                            }
                            say("ok".into());
                        }
                        Some("ms") => say(format!("ms {}", m.ms())),
                        Some("wait") => {
                            let now = m.ms();
                            pending = Some(Pending { start: now, end: now + num(1).unwrap_or(0).max(0) as u64, text: None, seen_at: now });
                        }
                        Some("until") => {
                            let now = m.ms();
                            let s = l.trim().splitn(3, char::is_whitespace).nth(2).map(|t| t.trim().to_string());
                            pending = Some(Pending { start: now, end: now + num(1).unwrap_or(0).max(0) as u64, text: s, seen_at: now });
                        }
                        Some("deaf") => {
                            deaf = num(1).unwrap_or(1) != 0;
                            say("ok".into());
                        }
                        Some("quit") => return std::process::ExitCode::SUCCESS,
                        Some(c) => say(format!("err unknown command {c}")),
                        None => {}
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        // two emulated milliseconds
        if let Err(e) = m.run_for(2) {
            say(format!("# halted: {e}"));
            return std::process::ExitCode::FAILURE;
        }
        let now = m.ms();
        releases.retain(|&(at, id)| {
            if at <= now {
                m.key(id, false);
                false
            } else {
                true
            }
        });
        if let Some(p) = &mut pending {
            // the LCD every 10 emulated ms (font::on_screen is not free), and at the end
            let look = now >= p.end || now >= p.seen_at + 10;
            let seen = look && p.text.as_deref().is_some_and(|t| crate::font::on_screen(m.lcd(), t));
            if look {
                p.seen_at = now;
            }
            if seen {
                say(format!("until 1 {}", now - p.start));
                pending = None;
            } else if now >= p.end {
                say(if p.text.is_some() { format!("until 0 {}", now - p.start) } else { "ok".into() });
                pending = None;
            }
        }
        if m.audio.len() > KEEP * 2 {
            let cut = m.audio.len() - KEEP;
            m.audio.drain(..cut);
            dropped += cut;
        }

        // the mailbox
        if mb.is_none() && now >= 20 {
            mb = Mailbox::find(&mut m);
            if mb.is_none() && now > 3000 {
                say("# no MIDI mailbox: is this an M1_EMU_MIDI=1 build (the matryoshka-emu-midi artifact)?".into());
                return std::process::ExitCode::FAILURE;
            }
        }
        if let Some(b) = &mb {
            if !announced {
                say(format!("# ready: MIDI port \"{name}\", mailbox at {:#010x}", b.base));
                announced = true;
            }
            {
                let mut ib = inbox.lock().unwrap();
                for x in ib.drain(..) {
                    to_pk.feed(x, &mut q_in);
                }
            }
            b.push(&mut m, &mut q_in);
            let mut pk = Vec::new();
            if !deaf {
                b.pull(&mut m, &mut pk);
            }
            let mut msgs = Vec::new();
            let cut = to_by.cut;
            for p in pk {
                to_by.feed(p, &mut msgs);
            }
            if to_by.cut != cut {
                say(format!("# {now} a SysEx from the FM-1 ended without F7 (dropped; the host had stopped reading)"));
            }
            for msg in msgs {
                if trace && msg.len() < 8 {
                    say(format!("# {now} out {}", msg.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")));
                }
                ports.send(&msg);
            }
        }

        // the wall clock: never ahead of it
        let ahead = (now - e0) as i64 - t0.elapsed().as_millis() as i64;
        if ahead > 1 {
            std::thread::sleep(Duration::from_millis(ahead as u64));
        }
    }
}

#[cfg(target_os = "macos")]
mod midi {
    use midir::os::unix::{VirtualInput, VirtualOutput};
    use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
    use std::sync::{Arc, Mutex};

    pub struct Ports {
        out: Mutex<MidiOutputConnection>,
        _inp: MidiInputConnection<()>,
    }

    impl Ports {
        pub fn send(&self, msg: &[u8]) {
            let _ = self.out.lock().unwrap().send(msg);
        }
    }

    pub fn open(name: &str, inbox: Arc<Mutex<Vec<u8>>>) -> Result<Ports, String> {
        let o = MidiOutput::new("m1emu").map_err(|e| e.to_string())?;
        let out = o.create_virtual(name).map_err(|e| e.to_string())?;
        let mut i = MidiInput::new("m1emu").map_err(|e| e.to_string())?;
        i.ignore(Ignore::None);
        let inp = i
            .create_virtual(name, move |_, bytes, _| inbox.lock().unwrap().extend_from_slice(bytes), ())
            .map_err(|e| e.to_string())?;
        Ok(Ports { out: Mutex::new(out), _inp: inp })
    }
}

#[cfg(not(target_os = "macos"))]
mod midi {
    use std::sync::{Arc, Mutex};
    pub struct Ports;
    impl Ports {
        pub fn send(&self, _msg: &[u8]) {}
    }
    pub fn open(_name: &str, _inbox: Arc<Mutex<Vec<u8>>>) -> Result<Ports, String> {
        Err("the virtual MIDI port needs macOS (CoreMIDI)".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sysex_and_notes_round_trip() {
        let mut q = VecDeque::new();
        let mut t = ToPackets::default();
        let msg = [0xF0, 0x7D, 0x01, 0x02, 0x03, 0x04, 0xF7, 0x90, 0x3C, 0x64, 0x3E, 0x00, 0xFA];
        for b in msg {
            t.feed(b, &mut q);
        }
        assert_eq!(q[0], 0x04 | 0xF0 << 8 | 0x7D << 16 | 0x01 << 24);
        assert_eq!(q[1], 0x04 | 0x02 << 8 | 0x03 << 16 | 0x04 << 24);
        assert_eq!(q[2], 0x05 | 0xF7 << 8);
        assert_eq!(q[3], 0x09 | 0x90 << 8 | 0x3C << 16 | 0x64 << 24);
        assert_eq!(q[4], 0x09 | 0x90 << 8 | 0x3E << 16); // running status
        assert_eq!(q[5], 0x0F | 0xFA << 8);
        let mut out = Vec::new();
        let mut b = ToBytes::default();
        for p in q {
            b.feed(p, &mut out);
        }
        assert_eq!(out[0], vec![0xF0, 0x7D, 0x01, 0x02, 0x03, 0x04, 0xF7]);
        assert_eq!(out[1], vec![0x90, 0x3C, 0x64]);
        assert_eq!(out[2], vec![0x90, 0x3E, 0x00]);
        assert_eq!(out[3], vec![0xFA]);
    }

    #[test]
    fn sysex_cut_short_ends_at_the_next_f0() {
        // 0xF0 0x7D 0x01 0x02 0x03 0x04 with no F7 (the FM-1 gave up mid-message), then a whole SysEx
        let q = [0x04 | 0xF0 << 8 | 0x7D << 16 | 0x01 << 24, 0x04 | 0x02 << 8 | 0x03 << 16 | 0x04 << 24, 0x04 | 0xF0 << 8 | 0x7D << 16 | 0x09 << 24, 0x05 | 0xF7 << 8];
        let mut out = Vec::new();
        let mut b = ToBytes::default();
        for p in q {
            b.feed(p, &mut out);
        }
        assert_eq!(out, vec![vec![0xF0, 0x7D, 0x09, 0xF7]]);
        assert_eq!(b.cut, 1);
    }

    #[test]
    fn sysex_split_across_callbacks_and_end_packets() {
        for len in 2..9usize {
            let mut msg = vec![0xF0];
            msg.extend((0..len - 2).map(|i| i as u8));
            msg.push(0xF7);
            let mut q = VecDeque::new();
            let mut t = ToPackets::default();
            for &b in &msg {
                t.feed(b, &mut q);
            }
            let mut out = Vec::new();
            let mut b = ToBytes::default();
            for p in q {
                b.feed(p, &mut out);
            }
            assert_eq!(out, vec![msg.clone()], "length {len}");
        }
    }
}
