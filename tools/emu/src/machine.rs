//! One emulated FM-1 running our app.bin: fm1-emu's cpu0 + SoC (+ cpu1 once released, until held), the
//! front panel driven at the current emulated time, the audio and the LCD read back.
//! The run loop is fm1-live's (`fm1_soc::machine::run_dual` over `run_blocks`), with P33 modelled for cpu0 (p33.rs).

use fm1_core::{Bus, Cpu};
use fm1_soc::{machine, Action, Soc, RAM_BASE, VEC_BASE};

use crate::p33::{Cpu0Bus, P33};

pub const RAM_SIZE: usize = 1 << 20;
/// app.bin offset 0 runs from here (firmware/app.ld); the XIP window starts 0x120 before it.
pub const ENTRY: u32 = 0x0200_0120;
const XIP_PAD: usize = 0x120;
pub const FLASH_SIZE: usize = 1 << 20;
/// Stack paint (#273): the firmware paints its stacks with this word at boot (main.c `stack_paint`); the emulator also
/// paints PAINT_LO..PAINT_HI before the first instruction, so a build without that (main before #273) is measured too.
pub const PAINT: u32 = 0x5AC3_A55C;
const PAINT_LO: u32 = 0x01C6_0000;
const PAINT_HI: u32 = 0x01C7_C000; // NOINIT starts here (firmware/app.ld)
/// The second core's control word (hal/fm1_cpu1.h FM1_C1_CON): bit 3 set = it runs.
const C1_CON: u32 = 0x01EE_E004;

pub struct Machine {
    pub cpu: Cpu,
    pub cpu1: Option<Cpu>,
    pub soc: Soc,
    pending_tick: bool,
    /// P33's power and analog registers (p33.rs)
    pub p33: P33,
    /// every audio sample so far (interleaved stereo, 16 bit)
    pub audio: Vec<i16>,
}

/// fm1-soc's `run_dual` (cpu0 in slices, cpu1 after each with as many instructions as cycles passed) with its own
/// `run_cpu1`: fm1-soc's takes cpu1 for idle, and gives up the rest of its slice, whenever it is back at the pc, registers
/// and stack pointer it started the slice with. A loop that keeps its state in memory looks the same: Env 8's sample
/// loop on a held step keeps its sample index on the stack, so with a lane job of Cassia 1 on cpu1 (#271) cpu1 lost most
/// of its time, cpu0 waited for the job in `fm1_cpu1_wait` and the audio interrupt climbed from about 1,150 to 2,900 us
/// about 2 s after 8 keys went down (from #744 on, whose larger `process` spilled that index; the release-1.11 batch,
/// 2026-11-08). Here the slice ends early only when cpu1 also wrote nothing since it started: a polling loop (our
/// `fm1_c1_main`'s idle loop, the stock firmware's job loop) only reads.
fn run_dual(
    cpu1: &mut Option<Cpu>,
    soc: &mut Soc,
    n: u32,
    jit_on: bool,
    mut run0: impl FnMut(&mut Soc, u32) -> Result<(), String>,
) -> Result<(), String> {
    let mut done = 0;
    while cpu1.is_none() {
        *cpu1 = machine::released_cpu1(soc, RAM_SIZE).map(|mut c| {
            c.jit_on = jit_on;
            c
        });
        if cpu1.is_some() || done >= n {
            break;
        }
        let k = (n - done).min(4096);
        soc.periph.room_cap = k as u64;
        run0(soc, k)?;
        done += k;
    }
    let Some(c1) = cpu1.as_mut() else { return Ok(()) };
    soc.periph.room_cap = machine::SLICE as u64;
    while done < n {
        let k = (n - done).min(machine::SLICE);
        let c0 = soc.periph.cycles;
        if soc.core_paused(0) {
            soc.advance(k as u64); // held by cpu1 (C0_CON bit 2): time runs on
        } else {
            run0(soc, k)?;
        }
        done += k;
        let dt = soc.periph.cycles - c0;
        run_cpu1(c1, soc, dt)?;
    }
    Ok(())
}

/// fm1-soc's `run_blocks` (cpu0's block loop: interrupts between blocks, the SoC serviced when a tick is due), with
/// cpu0 on [`Cpu0Bus`]: P33 modelled (p33.rs)
fn run_blocks(cpu: &mut Cpu, soc: &mut Soc, p33: &mut P33, n: u32, pending_tick: &mut bool) -> Result<(), String> {
    let mut done = 0u32;
    let mut ticked = std::mem::take(pending_tick);
    while done < n {
        if ticked || soc.periph.tick() {
            soc.advance(0);
        }
        ticked = false;
        soc.periph.in_isr = !cpu.irq_levels.is_empty();
        if soc.periph.any_pending() {
            if let Some((irq, prio)) = soc.pending_irq() {
                if cpu.irq_ready(prio) {
                    let handler = soc.read32(VEC_BASE + 4 * irq as u32);
                    cpu.interrupt(handler, prio);
                }
            }
        }
        let mut bus = Cpu0Bus { soc: &mut *soc, p33: &mut *p33 };
        match cpu.run_fast(&mut bus, n - done) {
            Ok((0, _)) => {
                if let Err(e) = cpu.step(&mut bus) {
                    return Err(format!("{e:?} at pc {:#010x}", cpu.pc));
                }
                done += 1;
            }
            Ok((k, due)) => {
                done += k;
                ticked = due;
            }
            Err(e) => return Err(format!("{e:?} at pc {:#010x}", cpu.pc)),
        }
        if soc.cpu1_release {
            break; // core 1 starts now (run_dual)
        }
    }
    // the next instruction's tick may already have happened: carry it
    *pending_tick = ticked;
    Ok(())
}

/// fm1-soc's `Core1Bus`, counting cpu1's writes (`run_cpu1`)
struct Core1Writes<'a> {
    bus: machine::Core1Bus<'a>,
    writes: u64,
}
impl Bus for Core1Writes<'_> {
    fn read8(&mut self, a: u32) -> u8 {
        self.bus.read8(a)
    }
    fn read16(&mut self, a: u32) -> u16 {
        self.bus.read16(a)
    }
    fn read32(&mut self, a: u32) -> u32 {
        self.bus.read32(a)
    }
    fn write8(&mut self, a: u32, v: u8) {
        self.writes += 1;
        self.bus.write8(a, v)
    }
    fn write16(&mut self, a: u32, v: u16) {
        self.writes += 1;
        self.bus.write16(a, v)
    }
    fn write32(&mut self, a: u32, v: u32) {
        self.writes += 1;
        self.bus.write32(a, v)
    }
    fn tick(&mut self) -> bool {
        self.bus.tick()
    }
    fn irq_pending(&self) -> bool {
        self.bus.irq_pending()
    }
    fn jit_mem(&mut self) -> Option<fm1_core::JitMem> {
        // (the JIT's inline stores would pass the count by: with M1EMU_JIT, cpu1 never ends a slice early, it only runs slower)
        self.writes += 1;
        self.bus.jit_mem()
    }
    fn code_writes(&self) -> Option<u64> {
        self.bus.code_writes()
    }
    fn code_mark(&mut self, lo: u32, hi: u32) {
        self.bus.code_mark(lo, hi)
    }
    fn tick_room(&self) -> u64 {
        self.bus.tick_room()
    }
    fn add_ticks(&mut self, n: u64) {
        self.bus.add_ticks(n)
    }
    fn hw_lock(&mut self, core: u32, set: bool) -> bool {
        self.bus.hw_lock(core, set)
    }
    fn irq_window(&mut self) {
        self.bus.irq_window()
    }
    fn next_tick_due(&self) -> bool {
        self.bus.next_tick_due()
    }
    fn idle(&mut self, core: u32) {
        self.bus.idle(core)
    }
}

/// fm1-soc's `run_cpu1` (up to `cycles` instructions: interrupts from its own bank, then single steps while it looks for
/// the way back to where it started, then stretches of 256), ending early only at the start's pc, registers and stack
/// pointer with no write since the start (`run_dual`)
fn run_cpu1(c1: &mut Cpu, soc: &mut Soc, cycles: u64) -> Result<(), String> {
    // The SoC does not enforce core 1's hardware stack guard. For a stack regression check, single-step that core
    // and stop when its user stack crosses the supplied lower bound (app.ld's _c1_ustack + the 256-byte guard).
    // Checking only after run_fast could miss a function that crosses the bound and returns within one block.
    static STACK_LOW: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    let stack_low = *STACK_LOW.get_or_init(|| std::env::var("M1EMU_C1_STACK_LOW").ok().map(|s|
        u32::from_str_radix(s.trim_start_matches("0x"), 16).expect("M1EMU_C1_STACK_LOW must be a hexadecimal address")));
    static WATCH_PC: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    static WATCH_HIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let watch_pc = *WATCH_PC.get_or_init(|| std::env::var("M1EMU_C1_WATCH_PC").ok().map(|s|
        u32::from_str_radix(s.trim_start_matches("0x"), 16).expect("M1EMU_C1_WATCH_PC must be a hexadecimal address")));
    if soc.core_paused(1) {
        return Ok(());
    }
    let probe = (c1.pc, c1.regs, c1.sp);
    let mut left = cycles.min(1 << 20);
    let mut probing = 512u64;
    let mut writes = 0u64;
    while left > 0 {
        if soc.periph.any_pending() {
            if let Some((irq, prio)) = soc.pending_irq_for(1) {
                if c1.irq_ready(prio) {
                    let handler = soc.read32(fm1_soc::VEC_BASE + 4 * irq as u32);
                    c1.interrupt(handler, prio);
                }
            }
        }
        let chunk = if probing > 0 { 1 } else { left.min(256) };
        let mut bus = Core1Writes { bus: machine::Core1Bus { soc: &mut *soc, budget: chunk.max(64) + 1 }, writes: 0 };
        let k = if let Some(low) = stack_low {
            let pc = c1.pc;
            if c1.user && watch_pc == Some(pc) && !WATCH_HIT.swap(true, std::sync::atomic::Ordering::Relaxed) {
                eprintln!("core 1 reached watched pc {pc:#010x}");
            }
            c1.step(&mut bus).map_err(|e| format!("cpu1: {e:?} at pc {pc:#010x}"))?;
            if c1.user && c1.sp < low {
                return Err(format!("core 1 stack crossed {low:#010x}: sp {:#010x} at pc {pc:#010x}, return {:#010x}", c1.sp, c1.rets));
            }
            1
        } else {
            match c1.run_fast(&mut bus, chunk as u32) {
                Ok((0, _)) => {
                    if let Err(e) = c1.step(&mut bus) {
                        return Err(format!("cpu1: {e:?} at pc {:#010x}", c1.pc));
                    }
                    1
                }
                Ok((k, _)) => k as u64,
                Err(e) => return Err(format!("cpu1: {e:?} at pc {:#010x}", c1.pc)),
            }
        };
        writes += bus.writes;
        left = left.saturating_sub(k);
        probing = probing.saturating_sub(k);
        if writes == 0 && c1.pc == probe.0 && c1.sp == probe.2 && c1.regs == probe.1 {
            break; // polling with nothing to do
        }
    }
    Ok(())
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
    /// The flash chip answers the JEDEC id M1EMU_JEDEC (six hex digits, e.g. B36014 for the UC25HQ80, #739) if set, else
    /// fm1-emu's Puya (85 60 14).
    pub fn boot(app: &[u8], flash: Option<&[u8]>) -> Machine {
        let env = std::env::var("M1EMU_JEDEC").ok().and_then(|v| u32::from_str_radix(v.trim_start_matches("0x"), 16).ok());
        Machine::boot_jedec(app, flash, env)
    }

    /// `boot` with the flash chip answering `jedec` (maker, type, capacity) when given.
    pub fn boot_jedec(app: &[u8], flash: Option<&[u8]>, jedec: Option<u32>) -> Machine {
        let mut soc = Soc::new(RAM_SIZE, xip_of(app));
        soc.periph.skip_idle = true;
        if let Some(f) = flash {
            soc.flash.load(f);
        }
        if let Some(id) = jedec {
            soc.flash.jedec = [(id >> 16) as u8, (id >> 8) as u8, id as u8];
        }
        let mut cpu = Cpu::new(ENTRY);
        // fm1-emu's AArch64 JIT (macOS only) renders our engine wrong at 7ca5b96 (most factory patches come out
        // 20-50 dB too quiet, at random); its interpreter matches the reference engine. M1EMU_JIT=1 turns it on.
        cpu.jit_on = std::env::var_os("M1EMU_JIT").is_some();
        cpu.user = true; // the SPL hands cpu0 over in user mode (fm1-emu)
        let params = RAM_BASE + 0x7fc00; // the SPL's boot parameters: an all-zero pair (fm1-emu)
        soc.write32(params, params + 0x40);
        let mut a = PAINT_LO;
        while a < PAINT_HI {
            soc.write32(a, PAINT);
            a += 4;
        }
        cpu.regs[0] = params;
        Machine { cpu, cpu1: None, soc, pending_tick: false, p33: P33::new(), audio: Vec::new() }
    }

    pub fn ms(&self) -> u64 {
        self.soc.periph.ms()
    }

    /// Run until emulated time `ms`; Err = the CPU halted (bad instruction, wild jump).
    pub fn run_to(&mut self, ms: u64) -> Result<(), String> {
        while self.ms() < ms {
            let jit = self.cpu.jit_on;
            let Machine { cpu, cpu1, soc, pending_tick, p33, .. } = self;
            run_dual(cpu1, soc, 100_000, jit, |soc, k| run_blocks(cpu, soc, p33, k, pending_tick))?;
            // the hold (#271): fm1-emu pauses a core only by the stock firmware's C1_CON bit 2 pulse; our firmware (X0X's
            // and Melodee's hold) sets bit 1 and clears bit 3. Bit 3 clear stops core 1 here; a later start (0x10008 bit
            // 3 again) boots it from its entry word, as the chip does. Checked between stretches of 100,000 instructions.
            if self.cpu1.is_some() && self.soc.read32(C1_CON) & 8 == 0 {
                self.cpu1 = None;
            }
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

    /// The painted words nobody wrote since boot, as runs of at least 256 bytes inside PAINT_LO..PAINT_HI: a stack's
    /// run ends where its deepest use began (its top minus the run's end = the most it ever held).
    pub fn untouched(&mut self) -> Vec<(u32, u32)> {
        let mut runs = Vec::new();
        let (mut a, mut start) = (PAINT_LO, None);
        while a <= PAINT_HI {
            let painted = a < PAINT_HI && self.soc.read32(a) == PAINT;
            match (painted, start) {
                (true, None) => start = Some(a),
                (false, Some(s)) => {
                    if a - s >= 256 {
                        runs.push((s, a));
                    }
                    start = None;
                }
                _ => {}
            }
            a += 4;
        }
        runs
    }

    /// `untouched` in words: "stack paint: untouched 0x..-0x.. (N B), ..."
    pub fn stack_report(&mut self) -> String {
        report(&self.untouched())
    }

    /// Write the audio so far as a 16-bit stereo WAV.
    pub fn write_wav(&self, path: &str, rate: u32) -> std::io::Result<()> {
        write_wav(&self.audio, path, rate)
    }
}

/// The untouched runs of every machine dropped so far (a smoke test boots several): per run start the least left.
static UNTOUCHED: std::sync::Mutex<Vec<(u32, u32)>> = std::sync::Mutex::new(Vec::new());

pub fn untouched_all() -> Vec<(u32, u32)> {
    UNTOUCHED.lock().map(|v| v.clone()).unwrap_or_default()
}

pub fn report(runs: &[(u32, u32)]) -> String {
    let r: Vec<String> = runs.iter().map(|(s, e)| format!("{s:#010x}..{e:#010x} ({} B)", e - s)).collect();
    format!("stack paint: untouched {}", if r.is_empty() { "nothing".to_string() } else { r.join(", ") })
}

impl Drop for Machine {
    fn drop(&mut self) {
        let runs = self.untouched();
        if let Ok(mut all) = UNTOUCHED.lock() {
            for (s, e) in runs {
                match all.iter_mut().find(|r| r.0 == s) {
                    Some(r) => r.1 = r.1.min(e),
                    None => all.push((s, e)),
                }
            }
            all.sort_unstable();
        }
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
