//! `m1emu cpu`: the test rig's CPU measurements on the emulator (#947), read from the firmware's own counters in RAM
//! (addresses from the build's ELF), so a run under the timing model (timing.rs, M1EMU_TIMING) compares with the rig's.
//!
//! - the survey (tools/rig_cpu_survey.py): for each factory slot and each count of held notes, the slot loaded again
//!   (TRS MIDI program change), the notes held for `--hold` ms, and every 500 ms the longest audio interrupt since the
//!   last sample (DIAG page 127: `diag_us_peak` / `eng_us_max`) and the mean of `eng_us_last` over those 500 ms;
//! - with `--modtime`, each module's time a half buffer (`m1_link.py modtime`, DIAG pages 144..176: `mt_on`, `mt_sum`,
//!   `mt_blocks`): eight notes held for 1 s, then a window of `--window` ms.
//!
//! The output is JSON: `{"timing": PARAMS or null, "survey": [...], "modtime": {"patches": {NAME: {...}}}}`, the survey
//! rows in rig_cpu_survey.py's shape and the module rows in docs/measurements/modtime-*.json's.

use fm1_core::Bus;
use std::process::ExitCode;

use crate::machine::Machine;
use crate::smoke;

const NOTES: [u8; 8] = [60, 64, 67, 71, 72, 76, 79, 83];
const PLAY: u8 = 12;
const MT_MODULES: u32 = 128;

/// The local and global symbols of a 32-bit little-endian ELF file: name -> address (a name defined twice with two
/// addresses is left out).
fn elf_symbols(elf: &[u8]) -> Result<std::collections::HashMap<String, u32>, String> {
    let u16_at = |o: usize| elf.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize).ok_or("truncated ELF");
    let u32_at = |o: usize| elf.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or("truncated ELF");
    if elf.get(0..6) != Some(&[0x7f, b'E', b'L', b'F', 1, 1]) {
        return Err("not a 32-bit little-endian ELF file".into());
    }
    let (shoff, shentsize, shnum) = (u32_at(0x20)? as usize, u16_at(0x2e)?, u16_at(0x30)?);
    let mut out = std::collections::HashMap::new();
    let mut twice = std::collections::HashSet::new();
    for i in 0..shnum {
        let sh = shoff + i * shentsize;
        if u32_at(sh + 4)? != 2 {
            continue; // SHT_SYMTAB only
        }
        let (off, size, link) = (u32_at(sh + 16)? as usize, u32_at(sh + 20)? as usize, u32_at(sh + 24)? as usize);
        let str_off = u32_at(shoff + link * shentsize + 16)? as usize;
        for s in (off..off + size).step_by(16) {
            let name_at = str_off + u32_at(s)? as usize;
            let end = elf[name_at..].iter().position(|&b| b == 0).ok_or("bad string table")?;
            let name = String::from_utf8_lossy(&elf[name_at..name_at + end]).into_owned();
            let value = u32_at(s + 4)?;
            if name.is_empty() || u16_at(s + 14)? == 0 {
                continue; // unnamed or undefined
            }
            match out.insert(name.clone(), value) {
                Some(v) if v != value => {
                    twice.insert(name);
                }
                _ => {}
            }
        }
    }
    for n in twice {
        out.remove(&n);
    }
    Ok(out)
}

/// The function symbols of a 32-bit little-endian ELF file, sorted by address: (address, size, name).
fn elf_funcs(elf: &[u8]) -> Vec<(u32, u32, String)> {
    let u16_at = |o: usize| u16::from_le_bytes([elf[o], elf[o + 1]]) as usize;
    let u32_at = |o: usize| u32::from_le_bytes([elf[o], elf[o + 1], elf[o + 2], elf[o + 3]]);
    let (shoff, shentsize, shnum) = (u32_at(0x20) as usize, u16_at(0x2e), u16_at(0x30));
    let mut out = Vec::new();
    for i in 0..shnum {
        let sh = shoff + i * shentsize;
        if u32_at(sh + 4) != 2 {
            continue;
        }
        let (off, size, link) = (u32_at(sh + 16) as usize, u32_at(sh + 20) as usize, u32_at(sh + 24) as usize);
        let str_off = u32_at(shoff + link * shentsize + 16) as usize;
        for s in (off..off + size).step_by(16) {
            if elf[s + 12] & 15 != 2 || u16_at(s + 14) == 0 {
                continue; // STT_FUNC, defined
            }
            let name_at = str_off + u32_at(s) as usize;
            let end = elf[name_at..].iter().position(|&b| b == 0).unwrap_or(0);
            out.push((u32_at(s + 4), u32_at(s + 8), String::from_utf8_lossy(&elf[name_at..name_at + end]).into_owned()));
        }
    }
    out.sort();
    out
}

/// M1EMU_PROF=DIR: the profile of one slot's module-time window (timing.rs `Prof`), by function, into DIR/SLOT.tsv:
/// device cycles a half on core 0 and core 1, instruction and data line fills a half; the profile is then cleared.
fn prof_dump(m: &mut Machine, funcs: &[(u32, u32, String)], slot: u32, name: &str, halves: u32) {
    let Some(dir) = std::env::var_os("M1EMU_PROF") else { return };
    let Some(t) = m.timing.as_mut() else { return };
    let Some(pr) = t.prof.as_mut() else { return };
    let mut by: std::collections::HashMap<String, [f64; 4]> = Default::default();
    let mut lines: std::collections::BTreeMap<u32, [f64; 3]> = Default::default();
    for (&(pc, core), v) in pr.at.iter() {
        let i = funcs.partition_point(|f| f.0 <= pc);
        let f = if i > 0 && pc < funcs[i - 1].0 + funcs[i - 1].1.max(2) { funcs[i - 1].2.clone() } else { format!("?{pc:08x}") };
        let e = by.entry(f).or_insert([0.0; 4]);
        e[core as usize] += v[0];
        e[2] += v[1];
        e[3] += v[2];
        let l = lines.entry(pc & !63).or_insert([0.0; 3]);
        l[core as usize] += v[0];
        l[2] += v[1];
    }
    pr.at.clear();
    let h = halves.max(1) as f64;
    let mut rows: Vec<_> = by.into_iter().collect();
    rows.sort_by(|a, b| (b.1[0] + b.1[1]).total_cmp(&(a.1[0] + a.1[1])));
    let mut s = format!("# {name}: device cycles a half (core 0, core 1), instruction / data line fills a half, over {halves} halves\n");
    for (f, v) in rows {
        s += &format!("{f}\t{:.0}\t{:.0}\t{:.2}\t{:.2}\n", v[0] / h, v[1] / h, v[2] / h, v[3] / h);
    }
    let path = std::path::Path::new(&dir).join(format!("{slot}.tsv"));
    if let Err(e) = std::fs::write(&path, s) {
        eprintln!("{}: {e}", path.display());
    }
    // each 64-byte line of code: cycles a half on core 0 and core 1, its instruction fills a half
    let s: String = lines.iter().map(|(a, v)| format!("{a:08x}\t{:.0}\t{:.0}\t{:.3}\n", v[0] / h, v[1] / h, v[2] / h)).collect();
    let _ = std::fs::write(std::path::Path::new(&dir).join(format!("{slot}.lines")), s);
}

/// The names of the bank's slots, from the flash (firmware/src/slotstore.c: one record a sector, the newest of an id
/// wins): slot -> name.
fn slot_names(flash: &[u8]) -> Vec<(u32, String)> {
    let mut best: std::collections::BTreeMap<u32, (u32, String)> = Default::default();
    let word = |a: usize| u32::from_le_bytes([flash[a], flash[a + 1], flash[a + 2], flash[a + 3]]);
    for i in 0..66usize {
        let a = if i < 2 { 0x97000 + i * 0x1000 } else { 0xA0000 + (i - 2) * 0x1000 };
        if a + 64 > flash.len() {
            break;
        }
        let (id, seq, name_at) = match word(a) {
            0x3253_314D => (word(a + 4), word(a + 8), a + 20),  // "M1S2": magic, id, seq, len, crc, name
            0x4C53_314D => (word(a + 4), 0, a + 16),            // "M1SL": magic, slot, len, crc, name
            _ => continue,
        };
        if id >= 64 {
            continue; // the settings record
        }
        let raw = &flash[name_at..name_at + 20];
        let name = String::from_utf8_lossy(&raw[..raw.iter().position(|&b| b == 0).unwrap_or(20)]).into_owned();
        if best.get(&id).map_or(true, |(s, _)| seq >= *s) {
            best.insert(id, (seq, name));
        }
    }
    best.into_iter().map(|(id, (_, n))| (id, n)).collect()
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o += "\\\"",
            '\\' => o += "\\\\",
            c if (c as u32) < 0x20 => o += &format!("\\u{:04x}", c as u32),
            c => o.push(c),
        }
    }
    o + "\""
}

fn list<T: std::fmt::Display>(v: &[T]) -> String {
    format!("[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
}

struct Syms {
    eng_us_last: u32,
    eng_us_max: u32,
    diag_us_peak: u32,
    eng_shed_count: u32,
    mt_on: u32,
    mt_sum: u32,
    mt_blocks: u32,
}

fn load(m: &mut Machine, slot: u32) -> Result<(), String> {
    m.midi(&[0xC0, slot as u8], 0)
}

fn notes(m: &mut Machine, n: usize, on: bool) -> Result<(), String> {
    keys(m, &NOTES[..n], on)
}

fn keys(m: &mut Machine, ks: &[u8], on: bool) -> Result<(), String> {
    for &k in ks {
        let msg = if on { [0x90, k, 100] } else { [0x80, k, 0] };
        m.midi(&msg, 0)?;
    }
    Ok(())
}

/// How `--modtime` plays each slot: the notes held, how long before the window opens, the transport running.
struct Play {
    keys: Vec<u8>,
    settle: u64,
    window: u64,
    run: bool,
}

/// `--bank FILE` (web/scripts/cpu-costs.ts): a flash with a bank of its own instead of the factory one, a slot per line
/// of FILE (`NAME<TAB>PATCH.m1p`, slot 0 first), as the smoke test's safety steps seed theirs.
fn bank_flash(path: &str) -> Result<Vec<u8>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut flash = crate::machine::installed_flash();
    for (slot, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let (name, file) = line.split_once('\t').ok_or_else(|| format!("{path}: want NAME<TAB>FILE, got {line:?}"))?;
        if slot >= 48 || name.len() > 19 {
            return Err(format!("{path}: at most 48 slots, names of at most 19 bytes ({name})"));
        }
        let patch = std::fs::read(file).map_err(|e| format!("{file}: {e}"))?;
        let at = 0xA0000 + slot * 0x1000;
        flash[at..at + 0x1000].copy_from_slice(&smoke::slot_sector(slot as u32, name, &patch, false));
    }
    Ok(flash)
}

/// One phase of the survey: (peaks every 500 ms, means of eng_us_last over each 500 ms, voices shed)
fn phase(m: &mut Machine, s: &Syms, slot: u32, n: usize, hold: u64, run: bool) -> Result<(Vec<u32>, Vec<u32>, u32), String> {
    load(m, slot)?;
    m.soc.write32(s.diag_us_peak, 0);
    m.soc.write32(s.eng_us_max, 0);
    let shed0 = m.soc.read32(s.eng_shed_count);
    if run {
        m.tap(PLAY, 20, 0)?;
    }
    notes(m, n, true)?;
    let (mut peaks, mut means) = (Vec::new(), Vec::new());
    for _ in 0..(hold / 500).max(1) {
        let (mut sum, mut cnt) = (0u64, 0u64);
        for _ in 0..500 {
            m.run_for(1)?;
            sum += m.soc.read32(s.eng_us_last) as u64;
            cnt += 1;
        }
        peaks.push(m.soc.read32(s.diag_us_peak).max(m.soc.read32(s.eng_us_max)));
        m.soc.write32(s.diag_us_peak, 0);
        means.push((sum / cnt) as u32);
    }
    notes(m, n, false)?;
    if run {
        m.tap(PLAY, 20, 0)?;
    }
    let shed = m.soc.read32(s.eng_shed_count).wrapping_sub(shed0);
    m.run_for(100)?;
    Ok((peaks, means, shed))
}

/// Each module's mean ns a half on core 0's lane and core 1's, and the halves counted.
/// (and the mean of `eng_us_last`, the whole audio interrupt, sampled every ms of the window)
fn modtime(m: &mut Machine, s: &Syms, slot: u32, play: &Play) -> Result<(u32, Vec<[u64; 2]>, f64), String> {
    load(m, slot)?;
    if play.run {
        m.tap(PLAY, 20, 0)?;
    }
    keys(m, &play.keys, true)?;
    m.run_for(play.settle)?;
    let window = play.window;
    // The firmware starts a window from its main loop, where no module is between ENG_ITEM_BEGIN and ENG_ITEM_END. A
    // write here can land inside one (in the audio interrupt, or on core 1): its BEGIN, taken while mt_on was off,
    // reads 0, and its END would add the whole uptime. So the counters are cleared again once every span in progress
    // has ended (well within 5 ms: a block is 2.9 ms).
    m.soc.write8(s.mt_on, 1);
    m.run_for(5)?;
    if let Some(t) = m.timing.as_mut() {
        if let Some(p) = t.prof.as_mut() {
            p.at.clear();
        }
        t.prof_on = true;
    }
    for k in 0..2 * MT_MODULES {
        m.soc.write32(s.mt_sum + 4 * k, 0);
    }
    m.soc.write32(s.mt_blocks, 0);
    let mut isr = 0u64;
    for _ in 0..window {
        m.run_for(1)?;
        isr += m.soc.read32(s.eng_us_last) as u64;
    }
    m.soc.write8(s.mt_on, 0);
    if let Some(t) = m.timing.as_mut() {
        t.prof_on = false;
    }
    let blocks = m.soc.read32(s.mt_blocks);
    let mut rows: Vec<[u64; 2]> = Vec::new();
    for q in 0..MT_MODULES {
        let mut ns = |lane: u32| {
            let sum = m.soc.read32(s.mt_sum + 4 * (lane * MT_MODULES + q)) as u64;
            if blocks == 0 { 0 } else { sum * 125 / (3 * blocks as u64) } // main.c bt_ns: 24 MHz ticks
        };
        rows.push([ns(0), ns(1)]);
    }
    while rows.last().is_some_and(|r| r[0] == 0 && r[1] == 0) {
        rows.pop();
    }
    keys(m, &play.keys, false)?;
    if play.run {
        m.tap(PLAY, 20, 0)?;
    }
    m.run_for(100)?;
    Ok((blocks, rows, isr as f64 / window.max(1) as f64))
}

pub fn run(app: &[u8], a: &[String]) -> ExitCode {
    let opt = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).map(|s| s.as_str());
    let Some(elf_path) = opt("--elf") else {
        eprintln!("m1emu cpu: --elf ELF is required (the build's matryoshka.elf: the counters' addresses)");
        return ExitCode::from(2);
    };
    let funcs = std::fs::read(elf_path).map(|e| elf_funcs(&e)).unwrap_or_default();
    let syms = match std::fs::read(elf_path).map_err(|e| e.to_string()).and_then(|e| elf_symbols(&e)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{elf_path}: {e}");
            return ExitCode::from(2);
        }
    };
    let with_modtime = a.iter().any(|x| x == "--modtime");
    let sym = |n: &str| syms.get(n).copied().ok_or_else(|| format!("{elf_path}: no symbol {n}"));
    // (the module-time counters came with #802: older builds have only the survey's)
    let mt = |n: &str| if with_modtime { sym(n) } else { Ok(syms.get(n).copied().unwrap_or(0)) };
    let s = match (|| {
        Ok::<Syms, String>(Syms {
            eng_us_last: sym("eng_us_last")?,
            eng_us_max: sym("eng_us_max")?,
            diag_us_peak: sym("diag_us_peak")?,
            eng_shed_count: sym("eng_shed_count")?,
            mt_on: mt("mt_on")?,
            mt_sum: mt("mt_sum")?,
            mt_blocks: mt("mt_blocks")?,
        })
    })() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let counts: Vec<usize> = opt("--notes").unwrap_or("0,1,4,8").split(',').filter_map(|t| t.trim().parse().ok()).filter(|&n| n <= 8).collect();
    let hold: u64 = opt("--hold").and_then(|v| v.parse().ok()).unwrap_or(2000);
    let play = Play {
        keys: opt("--keys").map_or(NOTES.to_vec(), |v| v.split(',').filter_map(|t| t.trim().parse().ok()).filter(|&k: &u8| k < 128).collect()),
        settle: opt("--settle").and_then(|v| v.parse().ok()).unwrap_or(1000),
        window: opt("--window").and_then(|v| v.parse().ok()).unwrap_or(3000),
        run: a.iter().any(|x| x == "--mt-run"),
    };
    let flash = match opt("--bank").map(bank_flash).transpose() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let run = a.iter().any(|x| x == "--run");
    let survey = !a.iter().any(|x| x == "--no-survey");
    // --poke8 NAME=V,..: bytes the firmware's DIAG pages would set (e.g. lanes_off=1, `tools/m1_link.py cores split
    // off`: core 0 renders every module), written after the first boot
    let mut pokes = Vec::new();
    for p in opt("--poke8").map(|v| v.split(',').collect::<Vec<_>>()).unwrap_or_default() {
        let parsed = p.split_once('=').and_then(|(n, v)| Some((syms.get(n.trim()).copied()?, v.trim().parse::<u8>().ok()?)));
        match parsed {
            Some(x) => pokes.push(x),
            None => {
                eprintln!("--poke8 {p}: want NAME=BYTE with NAME a symbol of {elf_path}");
                return ExitCode::from(2);
            }
        }
    }

    let t0 = std::time::Instant::now();
    let mut m = Machine::boot(app, flash.as_deref());
    // M1EMU_RAMSIM=NAME,..|FILE: a what-if, these functions (or, in FILE, one per line, NAME or a 64-byte line's address
    // 0x...) run as if placed in RAM (timing.rs `ram_sim`)
    if let (Some(t), Ok(v)) = (m.timing.as_mut(), std::env::var("M1EMU_RAMSIM")) {
        let text = std::fs::read_to_string(&v).unwrap_or(v.replace(',', "\n"));
        let mut mark = |lo: u32, hi: u32| {
            for a in (lo.max(0x0200_0000)..hi).step_by(2) {
                let i = ((a - 0x0200_0000) >> 1) as usize;
                if i >= t.ram_sim.len() {
                    t.ram_sim.resize(i + 1, false);
                }
                t.ram_sim[i] = true;
            }
        };
        for w in text.split_whitespace() {
            if let Some(h) = w.strip_prefix("0x") {
                let a = u32::from_str_radix(h, 16).unwrap_or(0) & !63;
                mark(a, a + 64);
            } else if let Some(f) = funcs.iter().find(|f| f.2 == w) {
                mark(f.0, f.0 + f.1);
            } else {
                eprintln!("M1EMU_RAMSIM: no function {w}");
            }
        }
    }
    let result = (|| -> Result<String, String> {
        smoke::quick_start(&mut m, 9000)?;
        m.run_for(1500)?; // (the first boot writes the factory bank once the quick start closes)
        for &(addr, v) in &pokes {
            m.soc.write8(addr, v);
        }
        let names = slot_names(&m.flash());
        if names.is_empty() {
            return Err("no slots in the bank after the first boot".into());
        }
        let wanted: Option<Vec<u32>> = opt("--slots").map(|v| v.split(',').filter_map(|t| t.trim().parse().ok()).collect());
        let slots: Vec<&(u32, String)> = names.iter().filter(|(i, _)| wanted.as_ref().map_or(true, |w| w.contains(i))).collect();
        let mut rows = Vec::new();
        let mut mods = Vec::new();
        for (slot, name) in slots {
            if survey {
                let mut f = vec![
                    format!("\"slot\":{slot}"),
                    format!("\"name\":{}", json_str(name)),
                    format!("\"transport\":{run}"),
                    format!("\"hold_seconds\":{}", hold as f64 / 1000.0),
                ];
                for &n in &counts {
                    let (peaks, means, shed) = phase(&mut m, &s, *slot, n, hold, run)?;
                    f.push(format!("\"n{n}_us\":{}", peaks.iter().max().copied().unwrap_or(0)));
                    f.push(format!("\"n{n}_samples\":{}", list(&peaks)));
                    f.push(format!("\"n{n}_mean_us\":{}", list(&means)));
                    f.push(format!("\"n{n}_shed\":{shed}"));
                    eprintln!("{slot:2} {name:20} {n} notes: peak {} us, mean {} us{}", peaks.iter().max().unwrap_or(&0), means.last().unwrap_or(&0), if shed > 0 { format!(", {shed} shed") } else { String::new() });
                }
                f.push("\"budget_us\":2902".into());
                rows.push(format!("{{{}}}", f.join(",")));
            }
            if with_modtime {
                let (halves, r, isr) = modtime(&mut m, &s, *slot, &play)?;
                prof_dump(&mut m, &funcs, *slot, name, halves);
                let cells: Vec<String> = r.iter().map(|[c0, c1]| format!("[{c0},{c1}]")).collect();
                eprintln!("{slot:2} {name:20} modtime: {} modules, {halves} halves, interrupt {isr:.1} us", r.len());
                mods.push(format!("{}:{{\"halves\":{halves},\"isr_us\":{isr:.2},\"modules_ns\":[{}]}}", json_str(name), cells.join(",")));
            }
        }
        let timing = m.timing.as_ref().map_or("null".into(), |t| json_str(&t.p.text()));
        let counts_json = m.timing.as_ref().map_or("null".into(), |t| {
            let c = |k: usize| {
                let c = &t.counts[k];
                format!(
                    "{{\"insns\":{},\"words\":{},\"taken\":{},\"load_uses\":{},\"fetch_misses\":{},\"data_misses\":{},\"flash_hits\":{},\"ram_insns\":{},\"cycles\":{:.0}}}",
                    list(&c.insns), c.words, c.taken, c.load_uses, c.fetch_misses, c.data_misses, c.flash_hits, c.ram_insns, c.cycles
                )
            };
            format!("[{},{}]", c(0), c(1))
        });
        let bank: Vec<String> = names.iter().map(|(i, n)| format!("[{i},{}]", json_str(n))).collect();
        Ok(format!(
            "{{\"firmware\":{},\"slots\":[{}],\"timing\":{timing},\"counts\":{counts_json},\"survey\":[\n{}\n],\"modtime\":{{\"what\":{},\"patches\":{{\n{}\n}}}}}}\n",
            json_str(a.get(1).map_or("", |s| s.as_str())),
            bank.join(","),
            rows.join(",\n"),
            json_str(&format!("m1emu cpu --modtime: notes {:?} held {} ms{}, then a window of {} ms; per module index of the device patch: mean ns a half on core 0 lane, core 1 lane; isr_us: the mean audio interrupt (eng_us_last) over the window", play.keys, play.settle, if play.run { ", transport running" } else { "" }, play.window)),
            mods.join(",\n")
        ))
    })();
    match result {
        Ok(json) => {
            eprintln!("{} ms emulated in {:.1} s", m.ms(), t0.elapsed().as_secs_f64());
            match opt("--out") {
                Some(path) => {
                    if let Err(e) = std::fs::write(path, json) {
                        eprintln!("{path}: {e}");
                        return ExitCode::FAILURE;
                    }
                }
                None => print!("{json}"),
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("halt: {e}");
            ExitCode::FAILURE
        }
    }
}
