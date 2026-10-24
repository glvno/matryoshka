//! One emulated FM-1 running our app.bin: fm1-emu's cpu0 + SoC (+ cpu1 once released), the
//! front panel driven at the current emulated time, the audio and the LCD read back.
//! The run loop is fm1-live's (`fm1_soc::machine::run_dual` over `run_blocks`).

use fm1_core::{Bus, Cpu};
use fm1_soc::{machine, Action, Soc, RAM_BASE};

pub const RAM_SIZE: usize = 1 << 20;
/// app.bin offset 0 runs from here (firmware/app.ld); the XIP window starts 0x120 before it.
pub const ENTRY: u32 = 0x0200_0120;
const XIP_PAD: usize = 0x120;
pub const FLASH_SIZE: usize = 1 << 20;

pub struct Machine {
    pub cpu: Cpu,
    pub cpu1: Option<Cpu>,
    pub soc: Soc,
    pending_tick: bool,
    /// every audio sample so far (interleaved stereo, 16 bit)
    pub audio: Vec<i16>,
}

/// The XIP window for an app.bin: the 0x120 bytes in front of it (fm1-live's `--bin` takes this).
pub fn xip_of(app: &[u8]) -> Vec<u8> {
    let mut xip = vec![0u8; XIP_PAD];
    xip.extend_from_slice(app);
    xip
}

impl Machine {
    /// Boot `app` (the build's matryoshka.bin). `flash`: the SPI flash chip's contents (a
    /// previous run's `flash()`), else erased.
    pub fn boot(app: &[u8], flash: Option<&[u8]>) -> Machine {
        let mut soc = Soc::new(RAM_SIZE, xip_of(app));
        soc.periph.skip_idle = true;
        if let Some(f) = flash {
            soc.flash.load(f);
        }
        let mut cpu = Cpu::new(ENTRY);
        // fm1-emu's AArch64 JIT (macOS only) renders our engine wrong at 7ca5b96 (most factory patches come out
        // 20-50 dB too quiet, at random); its interpreter matches the reference engine. M1EMU_JIT=1 turns it on.
        cpu.jit_on = std::env::var_os("M1EMU_JIT").is_some();
        cpu.user = true; // the SPL hands cpu0 over in user mode (fm1-emu)
        let params = RAM_BASE + 0x7fc00; // the SPL's boot parameters: an all-zero pair (fm1-emu)
        soc.write32(params, params + 0x40);
        cpu.regs[0] = params;
        Machine { cpu, cpu1: None, soc, pending_tick: false, audio: Vec::new() }
    }

    pub fn ms(&self) -> u64 {
        self.soc.periph.ms()
    }

    /// Run until emulated time `ms`; Err = the CPU halted (bad instruction, wild jump).
    pub fn run_to(&mut self, ms: u64) -> Result<(), String> {
        while self.ms() < ms {
            let jit = self.cpu.jit_on;
            let Machine { cpu, cpu1, soc, pending_tick, .. } = self;
            machine::run_dual(cpu1, soc, 100_000, RAM_SIZE, jit, |soc, k| machine::run_blocks(cpu, soc, k, pending_tick))?;
            let a = &mut self.soc.periph.audio;
            self.audio.extend(a.drain(..));
        }
        Ok(())
    }

    pub fn run_for(&mut self, ms: u64) -> Result<(), String> {
        self.run_to(self.ms() + ms)
    }

    fn at(&mut self, ms: u64, a: Action) {
        let at = self.soc.periph.cycle_of_ms(ms);
        let s = &mut self.soc.periph.script;
        s.push_back((at, a));
        s.make_contiguous().sort_by_key(|(c, _)| *c);
    }

    /// Press (or release) a panel key now: 0..13 buttons, 14..40 the note keys F3..G5.
    pub fn key(&mut self, id: u8, down: bool) {
        let now = self.ms();
        self.at(now, Action::Key { id, down });
    }

    /// Press a key for `hold` ms and run until it is released plus `after` ms.
    pub fn tap(&mut self, id: u8, hold: u64, after: u64) -> Result<(), String> {
        self.key(id, true);
        self.run_for(hold)?;
        self.key(id, false);
        self.run_for(after)
    }

    /// Turn encoder `enc` (0 SELECT, 1 ALGO, 2..5 K1..K4, 6 PRESET) by `clicks`, then run `after` ms.
    pub fn turn(&mut self, enc: u8, clicks: i32, after: u64) -> Result<(), String> {
        let now = self.ms();
        self.at(now, Action::Enc { enc, clicks });
        self.run_for(after)
    }

    /// MIDI bytes into the TRS MIDI IN jack, then run `after` ms.
    pub fn midi(&mut self, bytes: &[u8], after: u64) -> Result<(), String> {
        let now = self.ms();
        for &b in bytes {
            self.at(now, Action::Midi { b });
        }
        self.run_for(after)
    }

    /// Where `audio` stands now (a mark for `peak_since`).
    pub fn mark(&self) -> usize {
        self.audio.len()
    }

    pub fn peak_since(&self, mark: usize) -> i32 {
        self.audio[mark.min(self.audio.len())..].iter().map(|s| (*s as i32).abs()).max().unwrap_or(0)
    }

    pub fn flash(&self) -> Vec<u8> {
        self.soc.flash.mem.clone()
    }

    pub fn lcd(&self) -> &[u16] {
        &self.soc.lcd.fb
    }

    /// The LCD as a PNG.
    pub fn snap(&self, path: &str) {
        let _ = std::fs::write(path, crate::png::encode(&self.soc.lcd.fb, 240, 240, false));
    }

    /// The registers the firmware touched that fm1-emu does not model: (addr, write, count).
    pub fn unknown_mmio(&self) -> Vec<(u32, bool, usize)> {
        let mut v: Vec<(u32, bool, usize)> = Vec::new();
        for u in self.soc.unknown_accesses() {
            match v.iter_mut().find(|(a, w, _)| *a == u.addr && *w == u.is_write) {
                Some(e) => e.2 += 1,
                None => v.push((u.addr, u.is_write, 1)),
            }
        }
        v
    }

    /// Write the audio so far as a 16-bit stereo WAV.
    pub fn write_wav(&self, path: &str, rate: u32) -> std::io::Result<()> {
        write_wav(&self.audio, path, rate)
    }
}

/// 16-bit stereo samples (interleaved) as a WAV file.
pub fn write_wav(audio: &[i16], path: &str, rate: u32) -> std::io::Result<()> {
    let data: Vec<u8> = audio.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut h = Vec::with_capacity(44 + data.len());
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&(rate * 4).to_le_bytes());
    h.extend_from_slice(&4u16.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&(data.len() as u32).to_le_bytes());
    h.extend_from_slice(&data);
    std::fs::write(path, h)
}
