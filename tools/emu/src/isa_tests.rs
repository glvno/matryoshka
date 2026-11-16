// SPDX-License-Identifier: GPL-3.0-only
//! Decode-and-run checks for the instructions tools/emu/isa_fix.sh adds to fm1-emu's decoder, on fm1-core's interpreter
//! with a flat RAM: the build must be the patched one (`--config "$(tools/emu/isa_fix.sh)"`).

use fm1_core::{Bus, Cpu};

struct Ram(Vec<u8>);

impl Bus for Ram {
    fn read8(&mut self, a: u32) -> u8 {
        self.0[a as usize]
    }
    fn read16(&mut self, a: u32) -> u16 {
        u16::from_le_bytes([self.read8(a), self.read8(a + 1)])
    }
    fn read32(&mut self, a: u32) -> u32 {
        u32::from_le_bytes(self.0[a as usize..a as usize + 4].try_into().unwrap())
    }
    fn write8(&mut self, a: u32, v: u8) {
        self.0[a as usize] = v;
    }
    fn write16(&mut self, a: u32, v: u16) {
        self.0[a as usize..a as usize + 2].copy_from_slice(&v.to_le_bytes());
    }
    fn write32(&mut self, a: u32, v: u32) {
        self.0[a as usize..a as usize + 4].copy_from_slice(&v.to_le_bytes());
    }
}

/// Runs the 4-byte instruction `code` at address 0 on `cpu` (its pc reset to 0).
fn run(cpu: &mut Cpu, ram: &mut Ram, code: [u8; 4]) {
    ram.0[..4].copy_from_slice(&code);
    cpu.pc = 0;
    cpu.step(ram).unwrap_or_else(|e| panic!("{code:02x?}: {e:?}"));
    assert_eq!(cpu.pc, 4, "{code:02x?}");
}

/// `[R+n] op= R` as pi32v2-isa (rmw.lsl.r, rmw.shl3.r, rmw.lsr.r, rmw.asr.r) measured it on an FM-1: the count is the
/// register's low 8 bits and 32 or more acts as 32; `<<<` saturates to the signed range.
fn shift_ref(op: u32, x: u32, count: u32) -> u32 {
    let n = count & 0xff;
    match op {
        0 => if n >= 32 { 0 } else { x << n },
        1 => {
            let v = (x as i32 as i64) << n.min(32);
            v.clamp(i32::MIN as i64, i32::MAX as i64) as i32 as u32
        }
        2 => if n >= 32 { 0 } else { x >> n },
        _ => ((x as i32) >> n.min(31)) as u32,
    }
}

#[test]
fn rmw_shift_by_register() {
    let mut ram = Ram(vec![0; 0x1000]);
    let mut cpu = Cpu::new(0);
    // `6e e8 00 02` [r0+0] <<= r2: ring_scale in firmware/src/engine.c (PR #978)
    cpu.regs[0] = 0x100;
    cpu.regs[2] = 3;
    ram.write32(0x100, 0x8000_0011);
    run(&mut cpu, &mut ram, [0x6e, 0xe8, 0x00, 0x02]);
    assert_eq!(ram.read32(0x100), 0x88, "[r0+0] <<= r2");
    assert_eq!((cpu.regs[0], cpu.regs[2]), (0x100, 3));
    // the two corpus samples fm1-emu had: `6e e8 13 02` [r0+16] >>>= r2, `6e e8 66 ee` [r14+100] >>= r14
    ram.write32(0x110, 0x8000_0040);
    run(&mut cpu, &mut ram, [0x6e, 0xe8, 0x13, 0x02]);
    assert_eq!(ram.read32(0x110), 0xf000_0008, "[r0+16] >>>= r2");
    cpu.regs[14] = 0x204; // count 4
    ram.write32(0x268, 0x8000_0040);
    run(&mut cpu, &mut ram, [0x6e, 0xe8, 0x66, 0xee]);
    assert_eq!(ram.read32(0x268), 0x0800_0004, "[r14+100] >>= r14");
    // `6e e8 fd ff` [r15+-4] <<<= r15 (pi32v2-isa's example): saturates
    cpu.regs[15] = 0x301; // count 1
    ram.write32(0x2fd, 0x4000_0000);
    run(&mut cpu, &mut ram, [0x6e, 0xe8, 0xfd, 0xff]);
    assert_eq!(ram.read32(0x2fd), 0x7fff_ffff, "[r15+-4] <<<= r15");

    // every encoding: base bits 28..31, count register 24..27, offset 4 * sext(bits 18..23), op bits 16..17
    let counts = [0u32, 1, 5, 31, 32, 33, 0xff, 0x105, 0x120, 0x8000_001f];
    let words = [0x8000_0001u32, 0x4000_0001, 0x1234_5678, 0xffff_fff0, 0, 1, 0x7fff_ffff, 0xc000_0000];
    for hw in 0..0x1_0000u32 {
        let (b, s, field, op) = ((hw >> 12) as usize, (hw >> 8 & 15) as usize, hw >> 2 & 63, hw & 3);
        let off = (((field << 26) as i32) >> 24) as u32;
        for i in 0..16 {
            cpu.regs[i] = 0xdead_0000 | i as u32;
        }
        let count = counts[hw as usize % counts.len()];
        cpu.regs[s] = count;
        cpu.regs[b] = 0x800;
        let regs = cpu.regs;
        let (addr, x) = (0x800u32.wrapping_add(off), words[hw as usize / 7 % words.len()]);
        ram.write32(addr, x);
        run(&mut cpu, &mut ram, [0x6e, 0xe8, hw as u8, (hw >> 8) as u8]);
        let want = shift_ref(op, x, regs[s]);
        assert_eq!(ram.read32(addr), want, "6e e8 {:02x} {:02x}: {x:#x} by {:#x}", hw & 0xff, hw >> 8, regs[s]);
        assert_eq!(cpu.regs, regs, "6e e8 {:02x} {:02x} changed a register", hw & 0xff, hw >> 8);
    }
}
