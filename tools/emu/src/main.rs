//! m1emu: our firmware on the emulated FM-1 (fm1-emu, MIT, pinned in Cargo.toml).
//!
//!   m1emu smoke BIN [--out DIR] [--levels FILE] [--strict]
//!       the scripted smoke test (smoke.rs); exit code 1 on any failed check (with --strict also on a
//!       level warning); FILE = web/scripts/emu-levels.ts's output, the reference level per factory patch
//!   m1emu run BIN [--ms N] [--keys SCRIPT] [--snap MS,..] [--wav FILE] [--flash-in F] [--flash-out F] [--text S]
//!       a free run: SCRIPT is fm1-emu's (`800:n7,1500:n7^,2000:e6:1,2500:mc005`,
//!       times in ms: key down, `^` up, encoder clicks, MIDI bytes); snapshots go to lcd_MS.png;
//!       --text prints whether the string is on the screen at the end
//!   m1emu serve BIN [--flash-in F] [--name NAME]
//!       real time, USB MIDI on a virtual MIDI port NAME ("FM-1 (emu)"), commands on stdin (serve.rs); BIN must be an
//!       M1_EMU_MIDI=1 build (CI artifact matryoshka-emu-midi)
//!
//! BIN is the build's matryoshka.bin (app.bin, runs from 0x02000120).

mod font;
mod machine;
mod png;
mod serve;
mod smoke;

use machine::Machine;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!("usage: m1emu smoke BIN [--out DIR] [--levels FILE] [--strict]\n       m1emu run BIN [--ms N] [--keys SCRIPT] [--snap MS,..] [--wav FILE] [--flash-in F] [--flash-out F] [--text S]\n       m1emu serve BIN [--flash-in F] [--name NAME]");
    ExitCode::from(2)
}

fn opt<'a>(a: &'a [String], name: &str) -> Option<&'a str> {
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).map(|s| s.as_str())
}

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (Some(cmd), Some(bin)) = (a.first(), a.get(1)) else { return usage() };
    let app = match std::fs::read(bin) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{bin}: {e}");
            return ExitCode::from(2);
        }
    };
    match cmd.as_str() {
        "smoke" => {
            let out = opt(&a, "--out").unwrap_or("build/emu/smoke");
            let levels = opt(&a, "--levels").map(|p| std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}")));
            smoke::run(&app, out, levels.as_deref(), a.iter().any(|x| x == "--strict"))
        }
        "run" => run(&app, &a),
        "serve" => {
            let flash = opt(&a, "--flash-in").map(|p| std::fs::read(p).expect("--flash-in"));
            serve::run(&app, flash.as_deref(), opt(&a, "--name").unwrap_or("FM-1 (emu)"))
        }
        "xip" => {
            // BIN may be an update package: its app area is the XIP window as it stands
            let xip = if app.len() > 4 && bin.ends_with(".fwsc") {
                match fm1_soc::fwsc::unpack(&app) {
                    Ok(u) => u.xip,
                    Err(e) => {
                        eprintln!("{bin}: {e}");
                        return ExitCode::FAILURE;
                    }
                }
            } else {
                machine::xip_of(&app)
            };
            let Some(out) = a.get(2) else { return usage() };
            match std::fs::write(out, xip) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("{out}: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => usage(),
    }
}

fn run(app: &[u8], a: &[String]) -> ExitCode {
    let flash = opt(a, "--flash-in").map(|p| std::fs::read(p).expect("--flash-in"));
    let mut m = Machine::boot(app, flash.as_deref());
    if let Some(k) = opt(a, "--keys") {
        fm1_soc::script::queue(&mut m.soc, k);
    }
    let end: u64 = opt(a, "--ms").and_then(|v| v.parse().ok()).unwrap_or(8000);
    let mut snaps: Vec<u64> = opt(a, "--snap").map(|s| s.split(',').filter_map(|t| t.trim().parse().ok()).collect()).unwrap_or_default();
    snaps.sort_unstable();
    snaps.push(end);
    let t0 = std::time::Instant::now();
    let mut halted = None;
    for s in snaps {
        if let Err(e) = m.run_to(s) {
            halted = Some(e);
            break;
        }
        m.snap(&format!("lcd_{s}.png"));
    }
    let wall = t0.elapsed().as_secs_f64();
    println!("{} ms emulated in {wall:.1} s ({:.2}x real time), audio peak {}", m.ms(), m.ms() as f64 / 1000.0 / wall, m.peak_since(0));
    if let Some(w) = opt(a, "--wav") {
        let _ = m.write_wav(w, smoke::AUDIO_RATE);
    }
    if let Some(f) = opt(a, "--flash-out") {
        let _ = std::fs::write(f, m.flash());
    }
    if let Some(t) = opt(a, "--text") {
        println!("{t:?} on screen: {}", font::on_screen(m.lcd(), t));
    }
    for (addr, w, n) in m.unknown_mmio() {
        println!("unknown MMIO {} {addr:#010x} x{n}", if w { "write" } else { "read " });
    }
    match halted {
        Some(e) => {
            eprintln!("halt: {e}");
            ExitCode::FAILURE
        }
        None => ExitCode::SUCCESS,
    }
}
