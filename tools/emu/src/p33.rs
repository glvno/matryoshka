//! P33, the chip's bus to its power and analog registers (hal/fm1_sys.h), for cpu0. fm1-emu does not model it: its two
//! registers read 0 and keep nothing, so every P33 read answers 0. The stock V15 supply setup at boot (hal/fm1_power.h,
//! #735) reads its registers back and starts the second core only when they hold what it wrote; here they do.
//!
//! A transfer: the byte in DAT goes out when CON is written with bit 4 (the kick), and DAT then holds the byte that came
//! back. Bit 0 (select) frames a transaction: a command byte (bit 7 read, bits 6..5 the operation: write, or, and, xor;
//! bits 1..0 the address's top), the address's low byte, then the data (a dummy byte for a read). Bit 8 picks the RTC
//! domain, never modelled. Busy (bit 1) never reads set: no transfer times out.
//!
//! Every P33 access still goes to fm1-soc too, which logs it as unmodelled (smoke and boot filter P33 out of that list);
//! its log keeps the newest 16,384 accesses at most, so the P33 traffic of the watchdog's feeds pushes older entries out,
//! as it did before this model.
//!
//! Only the ten registers the supply setup touches keep their values ([`MODELLED`]); every other address reads 0, as
//! before (the reset reason, the watchdog). They start at the boot loader's levels as the test rig read them (#735).

use fm1_core::{Bus, JitMem};
use fm1_soc::Soc;

pub const CON: u32 = 0x13e08;
pub const DAT: u32 = 0x13e0c;
/// P3_ANA_CON0..2, 5..9, 0x16 and VLD_KEEP 0x17
pub const MODELLED: [u16; 10] = [0x00, 0x01, 0x02, 0x05, 0x06, 0x07, 0x08, 0x09, 0x16, 0x17];

pub struct P33 {
    pub regs: [u8; 0x18],
    con: u32,
    dat: u32,
    n: u8,
    cmd: u8,
    addr: u16,
}

impl P33 {
    pub fn new() -> P33 {
        let mut regs = [0u8; 0x18];
        regs[0x00] = 0x04; // LDO13 on, DCDC13 off (a cold start in Melodee's tests/power_test.c)
        regs[0x05] = 0x07; // VDDIO 7
        regs[0x06] = 0x03; // VDC14 3 = 1.40 V
        regs[0x09] = 0x0b; // SYSVDD 11 = 1.26 V
        P33 { regs, con: 0, dat: 0, n: 0, cmd: 0, addr: 0 }
    }

    fn modelled(&self, rtc: bool, a: u16) -> bool {
        !rtc && MODELLED.contains(&a)
    }

    fn write_con(&mut self, v: u32) {
        if v & 0x10 != 0 {
            self.transfer((self.dat & 0xff) as u8);
        }
        let selected = self.con & 1 != 0;
        self.con = v & !0x12; // the kick clears itself; never busy
        if self.con & 1 == 0 || !selected {
            self.n = 0; // a transaction ends, or a new one starts
        }
    }

    fn transfer(&mut self, b: u8) {
        let rtc = self.con & 0x100 != 0;
        let mut back = 0u8;
        match self.n {
            0 => self.cmd = b,
            1 => self.addr = ((self.cmd as u16 & 3) << 8) | b as u16,
            2 => {
                let a = self.addr;
                if self.modelled(rtc, a) {
                    let r = &mut self.regs[a as usize];
                    if self.cmd & 0x80 != 0 {
                        back = *r;
                    } else {
                        match (self.cmd >> 5) & 3 {
                            0 => *r = b,
                            1 => *r |= b,
                            2 => *r &= b,
                            _ => *r ^= b,
                        }
                    }
                }
            }
            _ => {}
        }
        self.n = self.n.saturating_add(1);
        self.dat = back as u32;
    }
}

/// cpu0's bus: the SoC, with P33's two registers taken here ([`P33`])
pub struct Cpu0Bus<'a> {
    pub soc: &'a mut Soc,
    pub p33: &'a mut P33,
}

impl Bus for Cpu0Bus<'_> {
    #[inline(always)]
    fn read8(&mut self, a: u32) -> u8 {
        <Soc as Bus>::read8(self.soc, a)
    }
    #[inline(always)]
    fn read16(&mut self, a: u32) -> u16 {
        <Soc as Bus>::read16(self.soc, a)
    }
    #[inline(always)]
    fn read32(&mut self, a: u32) -> u32 {
        let v = <Soc as Bus>::read32(self.soc, a); // (P33's too: fm1-soc logs it, as before)
        match a {
            CON => self.p33.con,
            DAT => self.p33.dat,
            _ => v,
        }
    }
    #[inline(always)]
    fn write8(&mut self, a: u32, v: u8) {
        <Soc as Bus>::write8(self.soc, a, v)
    }
    #[inline(always)]
    fn write16(&mut self, a: u32, v: u16) {
        <Soc as Bus>::write16(self.soc, a, v)
    }
    #[inline(always)]
    fn write32(&mut self, a: u32, v: u32) {
        <Soc as Bus>::write32(self.soc, a, v); // (P33's too: fm1-soc logs it and keeps nothing, as before)
        match a {
            CON => self.p33.write_con(v),
            DAT => self.p33.dat = v & 0xff,
            _ => {}
        }
    }
    fn tick(&mut self) -> bool {
        <Soc as Bus>::tick(self.soc)
    }
    fn irq_pending(&self) -> bool {
        <Soc as Bus>::irq_pending(self.soc)
    }
    fn jit_mem(&mut self) -> Option<JitMem> {
        <Soc as Bus>::jit_mem(self.soc)
    }
    fn tick_room(&self) -> u64 {
        <Soc as Bus>::tick_room(self.soc)
    }
    fn add_ticks(&mut self, n: u64) {
        <Soc as Bus>::add_ticks(self.soc, n)
    }
    fn hw_lock(&mut self, core: u32, set: bool) -> bool {
        <Soc as Bus>::hw_lock(self.soc, core, set)
    }
    fn next_tick_due(&self) -> bool {
        <Soc as Bus>::next_tick_due(self.soc)
    }
    fn idle(&mut self, core: u32) {
        <Soc as Bus>::idle(self.soc, core)
    }
    fn irq_window(&mut self) {
        <Soc as Bus>::irq_window(self.soc)
    }
    fn code_writes(&self) -> Option<u64> {
        <Soc as Bus>::code_writes(self.soc)
    }
    fn code_mark(&mut self, lo: u32, hi: u32) {
        <Soc as Bus>::code_mark(self.soc, lo, hi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// one transaction as hal/fm1_sys.h makes it: select, three bytes, deselect; the last byte back
    fn op(p: &mut P33, cmd: u8, a: u8, d: u8) -> u8 {
        p.write_con(p.con | 1);
        for b in [cmd, a, d] {
            p.dat = b as u32;
            p.write_con(p.con | 0x10);
        }
        let back = p.dat as u8;
        p.write_con(p.con & !0x101);
        back
    }

    #[test]
    fn reads_writes_and_unmodelled() {
        let mut p = P33::new();
        assert_eq!(op(&mut p, 0x80, 0x09, 0x5e), 0x0b);
        op(&mut p, 0x00, 0x09, 0xbf);
        assert_eq!(op(&mut p, 0x80, 0x09, 0x5e), 0xbf);
        op(&mut p, 0x20, 0x00, 0x80); // or
        op(&mut p, 0x40, 0x00, 0xfb); // and
        assert_eq!(p.regs[0], 0x80);
        assert_eq!(op(&mut p, 0x80, 0x12, 0x5e), 0); // the reset reason: not modelled, 0 as before
        op(&mut p, 0x00, 0x80, 0x55); // the watchdog: kept nowhere
        assert_eq!(op(&mut p, 0x80, 0x80, 0x5e), 0);
    }
}
