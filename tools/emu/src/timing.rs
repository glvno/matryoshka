//! A timing model for the emulated FM-1 (#947), off unless M1EMU_TIMING names a parameter file (`Params::parse`).
//!
//! fm1-emu charges one cycle per instruction at 240 MHz (`fm1_soc::CPU_HZ`), with no cache and no flash wait states;
//! the test rig runs the same firmware about twice as long. This model charges each retired instruction (fm1-core's
//! `Bus::retire`, added by tools/emu/core_timing_patch.py) the device's cycles: a cost per class (`fm1_core::cost`),
//! a cost per extra word of a multi-register push / pop, a cost when the next instruction does not follow on (a taken
//! branch, a call, a return, an interrupt entry), a stall when an instruction reads what the load before it loaded,
//! and a line fill for every miss in the flash (XIP) window: instruction fetches through the instruction cache, data
//! reads through the data cache, both shared by the two cores. A data read from the flash that hits costs
//! `flash_hit` more than a RAM load (the chip: one cycle against two). RAM has no cache and pays no fill. Cycles count
//! at the device's clock (`clock_mhz`) and are converted to the emulator's 240 MHz cycles, so the timers, the audio
//! interrupt's rate and the firmware's own clock (`fm1_ticks`) see the device's time. Every instruction already took
//! one emulator cycle; the rest is added to the time (core 0) or taken from the core's slice (core 1). With
//! `clock_mhz 240`, every class at 1 and the rest at 0, the emulator runs exactly as without it.
//! tools/emu/timing.txt holds costs measured on FM-1s (docs/EMULATOR.md); tools/emu/timing_fit.py compares a build
//! with the test rig.

use fm1_core::cost;

/// The parameters (one `name value` per line, `#` starts a comment; names missing keep `Params::IDENTITY`'s value).
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// the device's core clock
    pub clock_mhz: f64,
    /// cycles per instruction of each class (`fm1_core::cost`)
    pub class: [f64; cost::CLASSES],
    /// cycles for each word of a multi-register op after its first
    pub word: f64,
    /// cycles when an instruction does not follow on from the one before (a taken jump, an interrupt)
    pub taken: f64,
    /// cycles when an instruction reads a register the load just before it wrote
    pub load_use: f64,
    /// each cache (instruction, data) over the XIP window: bytes in all, bytes a line, ways
    pub cache_bytes: u32,
    pub cache_line: u32,
    pub cache_ways: u32,
    /// cycles for a line fill from the flash (an instruction fetch or a data read that misses)
    pub miss: f64,
    /// cycles more (or, negative, less) for a data read from the flash that hits, against a load from RAM
    pub flash_hit: f64,
    /// cycles more for an instruction fetched from RAM (.ram_text) instead of through the cache
    pub ram_code: f64,
    /// while core 1 runs a job (its code in the flash, not its idle loop in RAM), every instruction on either core
    /// costs this share more: the two cores sharing the bus and the caches (0: none)
    pub dual: f64,
    /// every device cycle above counts this many times: what the measured costs leave unexplained, fitted against
    /// the test rig (1: none)
    pub residual: f64,
}

const CLASS_NAMES: [&str; cost::CLASSES] = ["alu", "load", "store", "mul", "div", "branch", "multi", "sys", "fpu", "fpu_div", "fpu_cvt"];

impl Params {
    /// The emulator's own timing: one 240 MHz cycle an instruction.
    pub const IDENTITY: Params = Params {
        clock_mhz: 240.0,
        class: [1.0; cost::CLASSES],
        word: 0.0,
        taken: 0.0,
        load_use: 0.0,
        cache_bytes: 16384,
        cache_line: 32,
        cache_ways: 2,
        miss: 0.0,
        flash_hit: 0.0,
        ram_code: 0.0,
        dual: 0.0,
        residual: 1.0,
    };

    pub fn parse(text: &str) -> Result<Params, String> {
        let mut p = Params::IDENTITY;
        for (n, line) in text.lines().enumerate() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let mut it = line.split_whitespace();
            let (Some(k), Some(v), None) = (it.next(), it.next(), it.next()) else {
                return Err(format!("line {}: want `name value`: {line:?}", n + 1));
            };
            let x: f64 = v.parse().map_err(|_| format!("line {}: {v:?} is not a number", n + 1))?;
            let int = || if x >= 1.0 && x.fract() == 0.0 { Ok(x as u32) } else { Err(format!("line {}: {k} must be a whole number", n + 1)) };
            match k {
                "clock_mhz" => p.clock_mhz = x,
                "word" => p.word = x,
                "taken" => p.taken = x,
                "load_use" => p.load_use = x,
                "cache_bytes" => p.cache_bytes = int()?,
                "cache_line" => p.cache_line = int()?,
                "cache_ways" => p.cache_ways = int()?,
                "miss" => p.miss = x,
                "flash_hit" => p.flash_hit = x,
                "ram_code" => p.ram_code = x,
                "residual" => p.residual = x,
                "dual" => p.dual = x,
                _ => match CLASS_NAMES.iter().position(|c| *c == k) {
                    Some(i) => p.class[i] = x,
                    None => return Err(format!("line {}: unknown parameter {k:?}", n + 1)),
                },
            }
        }
        let lines = p.cache_bytes / p.cache_line.max(1);
        if !p.cache_line.is_power_of_two() || lines % p.cache_ways != 0 || !(lines / p.cache_ways).is_power_of_two() || p.clock_mhz <= 0.0
            || p.residual <= 0.0
        {
            return Err(format!("cache {} B / {} B lines / {} ways, clock {} MHz or residual {} is not usable", p.cache_bytes, p.cache_line, p.cache_ways, p.clock_mhz, p.residual));
        }
        Ok(p)
    }

    pub fn load(path: &str) -> Result<Params, String> {
        Params::parse(&std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| format!("{path}: {e}"))
    }

    /// As a parameter file.
    pub fn text(&self) -> String {
        let mut s = format!("clock_mhz {}\n", self.clock_mhz);
        for (n, c) in CLASS_NAMES.iter().zip(self.class) {
            s += &format!("{n} {c}\n");
        }
        s + &format!(
            "word {}\ntaken {}\nload_use {}\ncache_bytes {}\ncache_line {}\ncache_ways {}\nmiss {}\nflash_hit {}\nram_code {}\ndual {}\n\
             residual {}\n",
            self.word, self.taken, self.load_use, self.cache_bytes, self.cache_line, self.cache_ways, self.miss, self.flash_hit,
            self.ram_code, self.dual, self.residual
        )
    }
}

/// Set-associative, least recently used, tags only.
struct Cache {
    shift: u32,
    sets: u32,
    ways: usize,
    tag: Vec<u32>,
    used: Vec<u64>,
    clock: u64,
}

impl Cache {
    fn new(p: &Params) -> Cache {
        let ways = p.cache_ways as usize;
        let sets = p.cache_bytes / p.cache_line / p.cache_ways;
        Cache { shift: p.cache_line.trailing_zeros(), sets, ways, tag: vec![u32::MAX; sets as usize * ways], used: vec![0; sets as usize * ways], clock: 0 }
    }

    /// Look up the line holding `addr`, filling it on a miss. Whether it was there.
    fn access(&mut self, addr: u32) -> bool {
        let line = addr >> self.shift;
        let base = (line & (self.sets - 1)) as usize * self.ways;
        self.clock += 1;
        let set = base..base + self.ways;
        if let Some(i) = set.clone().find(|&i| self.tag[i] == line) {
            self.used[i] = self.clock;
            return true;
        }
        let victim = set.min_by_key(|&i| self.used[i]).unwrap_or(base);
        self.tag[victim] = line;
        self.used[victim] = self.clock;
        false
    }
}

/// What one core did under the model.
#[derive(Clone, Debug, Default)]
pub struct Counts {
    pub insns: [u64; cost::CLASSES],
    pub words: u64,
    pub taken: u64,
    pub load_uses: u64,
    pub fetch_misses: u64,
    pub data_misses: u64,
    pub flash_hits: u64,
    pub ram_insns: u64,
    /// instructions run while core 1 ran a job (`Params::dual`)
    pub dual_insns: u64,
    /// device cycles charged
    pub cycles: f64,
}

pub struct Timing {
    pub p: Params,
    icache: Cache,
    dcache: Cache,
    /// emulator cycles per device cycle
    scale: f64,
    /// per core: where the next instruction would follow on, the last cache line fetched, the registers the last
    /// instruction loaded (0 when it was no load), emulator cycles owed
    next: [u32; 2],
    line: [u32; 2],
    loaded: [u16; 2],
    owed: [f64; 2],
    /// core 1 runs a job: its last instruction was in the flash
    busy1: bool,
    pub counts: [Counts; 2],
    /// the profile, when M1EMU_PROF asks for one, and whether it counts now
    pub prof: Option<Prof>,
    pub prof_on: bool,
    last_pc: [u32; 2],
    /// what-if (M1EMU_RAMSIM, set by `m1emu cpu` from the ELF): code at these flash halfwords (index (pc - 0x0200_0000) / 2)
    /// runs as if it were in RAM
    pub ram_sim: Vec<bool>,
}

/// Where the cycles went (`m1emu cpu --modtime` with M1EMU_PROF): per core, the device cycles and the line fills each
/// instruction address was charged, over the windows `Timing::prof_on` covers. A data fill counts at the instruction
/// that retired last on its core.
pub struct Prof {
    /// (address, core) -> [cycles, fetch misses, data misses]
    pub at: std::collections::HashMap<(u32, u8), [f64; 3]>,
}

pub fn xip(addr: u32) -> bool {
    (0x0200_0000..0x0400_0000).contains(&addr)
}

impl Timing {
    pub fn new(p: Params) -> Timing {
        let scale = fm1_soc::CPU_HZ as f64 / (p.clock_mhz * 1e6) * p.residual;
        Timing {
            icache: Cache::new(&p),
            dcache: Cache::new(&p),
            p,
            scale,
            next: [0; 2],
            line: [u32::MAX; 2],
            loaded: [0; 2],
            owed: [0.0; 2],
            busy1: false,
            counts: Default::default(),
            prof: std::env::var_os("M1EMU_PROF").map(|_| Prof { at: Default::default() }),
            prof_on: false,
            last_pc: [0; 2],
            ram_sim: Vec::new(),
        }
    }

    /// M1EMU_TIMING's parameter file, if set (exits on a bad file: a run must not go on with timing it was not given).
    pub fn from_env() -> Option<Timing> {
        let path = std::env::var("M1EMU_TIMING").ok().filter(|s| !s.is_empty())?;
        match Params::load(&path) {
            Ok(p) => Some(Timing::new(p)),
            Err(e) => {
                eprintln!("M1EMU_TIMING: {e}");
                std::process::exit(2);
            }
        }
    }

    /// The instruction at `pc` retires on `core` (fm1-core's `Bus::retire`; `rw`: registers read, low 16 bits, and
    /// written, high 16 bits).
    #[inline]
    pub fn retire(&mut self, core: usize, pc: u32, len: u8, cls: u8, rw: u32) {
        let p = &self.p;
        let class = (cls & 15) as usize;
        let words = (cls >> 4) as u64;
        let c = &mut self.counts[core];
        c.insns[class] += 1;
        let mut cyc = p.class[class];
        if words > 1 {
            cyc += p.word * (words - 1) as f64;
            c.words += words - 1;
        }
        if pc != self.next[core] {
            cyc += p.taken;
            c.taken += 1;
        }
        if rw as u16 & self.loaded[core] != 0 {
            cyc += p.load_use;
            c.load_uses += 1;
        }
        self.loaded[core] = if class == cost::LOAD as usize { (rw >> 16) as u16 } else { 0 };
        let mut fetch_missed = 0.0;
        let end = pc + len as u32;
        self.next[core] = end;
        let flash = xip(pc) && !self.ram_sim.get(((pc - 0x0200_0000) >> 1) as usize).copied().unwrap_or(false);
        if flash {
            let (first, last) = (pc >> self.icache.shift, (end - 1) >> self.icache.shift);
            for l in first..=last {
                if l != self.line[core] {
                    self.line[core] = l;
                    if !self.icache.access(l << self.icache.shift) {
                        cyc += p.miss;
                        c.fetch_misses += 1;
                        fetch_missed += 1.0;
                    }
                }
            }
        } else {
            cyc += p.ram_code;
            c.ram_insns += 1;
        }
        if core == 1 {
            self.busy1 = flash;
        }
        if self.busy1 {
            cyc *= 1.0 + p.dual;
            c.dual_insns += 1;
        }
        c.cycles += cyc;
        self.owed[core] += cyc * self.scale - 1.0;
        self.last_pc[core] = pc;
        if self.prof_on {
            if let Some(pr) = self.prof.as_mut() {
                let e = pr.at.entry((pc, core as u8)).or_insert([0.0; 3]);
                e[0] += cyc;
                e[1] += fetch_missed;
            }
        }
    }

    /// A data read at `addr` on `core` (only the XIP window is cached).
    #[inline]
    pub fn data(&mut self, core: usize, addr: u32) {
        if !xip(addr) {
            return;
        }
        let c = &mut self.counts[core];
        let cyc = if self.dcache.access(addr) {
            c.flash_hits += 1;
            self.p.flash_hit
        } else {
            c.data_misses += 1;
            self.p.miss
        };
        c.cycles += cyc;
        self.owed[core] += cyc * self.scale;
        if self.prof_on && cyc == self.p.miss {
            let pc = self.last_pc[core];
            if let Some(pr) = self.prof.as_mut() {
                let e = pr.at.entry((pc, core as u8)).or_insert([0.0; 3]);
                e[0] += cyc;
                e[2] += 1.0;
            }
        }
    }

    /// The whole emulator cycles owed by `core`, taken (the fraction stays owed).
    #[inline]
    pub fn take(&mut self, core: usize) -> u64 {
        let o = self.owed[core];
        if o >= 1.0 {
            let n = o.floor();
            self.owed[core] = o - n;
            n as u64
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_keeps_identity_defaults_and_rejects_bad_files() {
        let p = Params::parse("clock_mhz 360\nload 2 # a comment\nmiss 20\nflash_hit -1\n").unwrap();
        assert_eq!(p.clock_mhz, 360.0);
        assert_eq!(p.class[cost::LOAD as usize], 2.0);
        assert_eq!(p.class[cost::ALU as usize], 1.0);
        assert_eq!(p.flash_hit, -1.0);
        assert_eq!(Params::parse(&p.text()).unwrap(), p);
        assert!(Params::parse("lod 2").is_err());
        assert!(Params::parse("cache_line 24").is_err());
        assert!(Params::parse("miss").is_err());
    }

    #[test]
    fn identity_owes_nothing() {
        let mut t = Timing::new(Params::IDENTITY);
        for i in 0..1000u32 {
            t.retire(0, 0x0200_0000 + 6 * (i % 300) * 7, 4, (i % cost::CLASSES as u32) as u8, i * 0x0001_0001);
            t.data(0, 0x0200_8000 + 64 * i);
        }
        assert_eq!(t.take(0), 0);
    }

    #[test]
    fn fpu_ops_cost_their_classes() {
        // at 240 MHz one device cycle is one emulator cycle: an add 1.6, a divide 3.0, a conversion 2.3 (#979)
        let p = Params::parse("clock_mhz 240\nfpu 1.6\nfpu_div 3.0\nfpu_cvt 2.3\n").unwrap();
        let mut t = Timing::new(p);
        t.next[0] = 0x0100_0000;
        for (k, cls) in [cost::FPU, cost::FPU_DIV, cost::FPU_CVT].into_iter().enumerate() {
            t.retire(0, 0x0100_0000 + 4 * k as u32, 4, cls, 0);
        }
        assert_eq!(t.counts[0].insns[cost::FPU as usize..], [1, 1, 1]);
        assert!((t.counts[0].cycles - 6.9).abs() < 1e-9);
        assert_eq!(t.take(0), 3); // 6.9 device cycles at 240 MHz, less the 3 the instructions took: 3.9 owed
    }

    #[test]
    fn misses_and_taken_jumps_cost_their_cycles() {
        // 240 MHz: one device cycle = one emulator cycle; 4 instructions of 2 bytes in one 32-byte line, then a jump
        let p = Params { clock_mhz: 240.0, miss: 10.0, taken: 2.0, ..Params::IDENTITY };
        let mut t = Timing::new(p);
        for k in 0..4 {
            t.retire(0, 0x0200_0000 + 2 * k, 2, cost::ALU, 0);
        }
        // the first instruction: did not follow on (2) and missed (10); the rest hit and followed on
        assert_eq!(t.take(0), 12);
        t.retire(0, 0x0200_0000, 2, cost::BRANCH, 0); // back to the line: a jump, a hit
        assert_eq!(t.take(0), 2);
        assert_eq!(t.counts[0].fetch_misses, 1);
        assert_eq!(t.counts[0].taken, 2);
    }

    #[test]
    fn a_load_used_at_once_stalls() {
        let p = Params { load_use: 1.0, ..Params::IDENTITY };
        let mut t = Timing::new(p);
        let r = |reads: u32, writes: u32| reads | writes << 16;
        t.retire(0, 0x0100_0000, 2, cost::LOAD, r(1 << 2, 1 << 3)); // r3 = [r2]
        t.retire(0, 0x0100_0002, 2, cost::ALU, r(1 << 4, 1 << 5)); // r5 = r4: no stall
        t.retire(0, 0x0100_0004, 2, cost::LOAD, r(1 << 2, 1 << 3)); // r3 = [r2]
        t.retire(0, 0x0100_0006, 2, cost::ALU, r(1 << 3, 1 << 5)); // r5 = r3: a stall
        assert_eq!(t.counts[0].load_uses, 1);
        assert_eq!(t.take(0), 1);
    }

    #[test]
    fn flash_data_goes_through_its_own_cache() {
        let p = Params { miss: 10.0, flash_hit: -1.0, ..Params::IDENTITY };
        let mut t = Timing::new(p);
        t.retire(0, 0x0200_0000, 2, cost::LOAD, 0); // the code's line: an instruction miss (10)
        t.data(0, 0x0200_0004); // the same line as data: the data cache's own miss (10)
        t.data(0, 0x0200_0008); // a hit: one cycle less than a RAM load
        t.data(0, 0x01C0_0000); // RAM: no cache
        assert_eq!((t.counts[0].fetch_misses, t.counts[0].data_misses, t.counts[0].flash_hits), (1, 1, 1));
        assert_eq!(t.take(0), 19);
    }

    #[test]
    fn both_cores_pay_while_core_1_runs_a_job() {
        // 240 MHz, every class 1: an instruction costs 1 + dual while core 1's last instruction was in the flash
        let p = Params { dual: 1.0, ..Params::IDENTITY };
        let mut t = Timing::new(p);
        t.retire(1, 0x01C0_7000, 2, cost::ALU, 0); // core 1 idles in RAM
        t.retire(0, 0x0100_0000, 2, cost::ALU, 0);
        assert_eq!((t.take(0), t.take(1)), (0, 0));
        t.retire(1, 0x0200_1000, 2, cost::ALU, 0); // a job: core 1 pays double
        t.retire(0, 0x0100_0002, 2, cost::ALU, 0); // and core 0 beside it
        assert_eq!((t.take(0), t.take(1)), (1, 1));
    }

    #[test]
    fn lru_keeps_the_recent_lines_of_a_set() {
        // 2 ways of 32-byte lines, 2 sets: lines 0, 2, 4 share set 0
        let p = Params { cache_bytes: 128, cache_line: 32, cache_ways: 2, ..Params::IDENTITY };
        let mut c = Cache::new(&p);
        assert!(!c.access(0));
        assert!(!c.access(64));
        assert!(c.access(0));
        assert!(!c.access(128)); // evicts 64, the least recently used
        assert!(c.access(0));
        assert!(!c.access(64));
    }
}
