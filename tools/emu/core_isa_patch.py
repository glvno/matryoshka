# SPDX-License-Identifier: GPL-3.0-only
# Gives a copy of fm1-emu's fm1-core (MIT, pinned in tools/emu/Cargo.toml) the semantics for decoder entries
# tools/emu/isa_fix.sh corrects or adds that fm1-core had none for: the read-modify-write shifts by a register,
# `[R+#i] <<= R`, `<<<= R`, `>>= R`, `>>>= R` (`6e e8`, pi32v2-isa rmw.lsl.r / rmw.shl3.r / rmw.lsr.r / rmw.asr.r,
# measured on an FM-1 in hw/fm1-2026-10-24-v2). Each reads the word at the base register plus the offset, shifts it by
# the low 8 bits of the count register (32 or more acts as 32; `<<<` saturates to 0x7FFFFFFF / 0x80000000) and writes
# it back; registers and flags are left alone. Its general store / read-modify-write arm took them as unknown.
# Second (#1196): a goto out of the then-part of a predicated `if (..) { .. } else { .. }` ends the construct. fm1-core
# kept the else-part's skip pending while the pc stayed below the then-part's end, and a pending skip holds the
# interrupts back, so a tail call to a function at a lower address (`if (r2 == 0) { goto pal_now_send } else { .. }`,
# pal_changed in firmware/src/palette.c) ran that whole function with the interrupts off: TIMER5 stopped, the SysEx
# ring never drained and fm1_ms stood still, so a PALETTE_NOW longer than the ring waited in usb.c sx_room for ever.
# Each skip now keeps its then-part's start; a jump made from inside the then-part to outside it drops the skip. A call
# keeps it (it comes back into the then-part; the firmware has none inside a then-part with an else).
# Run by tools/emu/isa_fix.sh on tools/emu/target/fm1-core/src and by tools/emu/live_build.sh on fm1-live's copy;
# every edit asserts its anchor.
import sys

src = sys.argv[1]


def edit(path, old, new, count=1):
    s = open(path).read()
    assert s.count(old) == count, f'{path}: anchor found {s.count(old)} times, expected {count}: {old[:70]!r}'
    open(path, 'w').write(s.replace(old, new))


lib = f'{src}/lib.rs'
edit(lib, '        // ---- stores / RMW: <mem> op= x -------------------------------------\n',
     '        // ---- read-modify-write shifts by a register `[R+#i] op= R` (6e e8; tools/emu/core_isa_patch.py):\n'
     '        // the count is the register\'s low 8 bits, 32 or more acting as 32; `<<<` saturates (pi32v2-isa\n'
     '        // rmw.*.r, measured on an FM-1). Before the general arm below, which has no shifts.\n'
     '        if let "[R+#i] <<= R" | "[R+#i] <<<= R" | "[R+#i] >>= R" | "[R+#i] >>>= R" = s {\n'
     '            let addr = self.regs[r(self, 0)?].wrapping_add(v(self, 1)?);\n'
     '            let n = self.regs[r(self, 2)?] & 0xff;\n'
     '            let x = bus.read32(addr);\n'
     '            let y = match &s[7..s.len() - 3] {\n'
     '                "<<" => if n >= 32 { 0 } else { x << n },\n'
     '                ">>" => if n >= 32 { 0 } else { x >> n },\n'
     '                ">>>" => ((x as i32) >> n.min(31)) as u32,\n'
     '                _ => {\n'
     '                    let w = if x == 0 || n == 0 { x as i32 as i64 } else if n >= 32 { (x as i32 as i64) << 32 } else { (x as i32 as i64) << n };\n'
     '                    w.clamp(i32::MIN as i64, i32::MAX as i64) as i32 as u32\n'
     '                }\n'
     '            };\n'
     '            bus.write32(addr, y);\n'
     '            return Ok(Some(None));\n'
     '        }\n'
     '        // ---- stores / RMW: <mem> op= x -------------------------------------\n')

# ---- the second fix: a goto out of an if-else's then-part ends the construct (#1196)
edit(lib, '    /// (then_end, else_end) — reaching then_end jumps over the else-part.\n'
          '    pub pred_skips: Vec<(u32, u32)>,\n',
     '    /// (then_end, else_end, then_start) — reaching then_end jumps over the else-part; a jump from inside the\n'
     '    /// then-part to outside it (a tail call) drops the skip (tools/emu/core_isa_patch.py).\n'
     '    pub pred_skips: Vec<(u32, u32, u32)>,\n')
edit(lib, '                        self.pred_skips.retain(|&(te, _)| te != then_end);\n'
          '                        self.pred_skips.push((then_end, else_end));\n',
     '                        self.pred_skips.retain(|&(te, _, _)| te != then_end);\n'
     '                        self.pred_skips.push((then_end, else_end, next_pc));\n', count=2)
edit(lib, '        self.hold_irq = 0;\n'
          '        self.pc = jumped.unwrap_or(next_pc);\n'
          '        if !self.pred_skips.is_empty() {\n'
          '            let pc = self.pc;\n'
          '            if let Some(i) = self.pred_skips.iter().position(|&(te, _)| te == pc) {\n'
          '                let (_, ee) = self.pred_skips.remove(i);\n'
          '                self.pc = ee;\n'
          '            }\n'
          '            let pc = self.pc;\n'
          '            // a branch out of the construct abandons its pending skip\n'
          '            self.pred_skips.retain(|&(te, _)| pc <= te);\n',
     '        self.hold_irq = 0;\n'
     '        let from = self.pc;\n'
     '        self.pc = jumped.unwrap_or(next_pc);\n'
     '        if !self.pred_skips.is_empty() {\n'
     '            // a goto or return from inside a then-part to outside it (the tail call `if (..) { goto f } else\n'
     '            // { .. }`) ends the construct wherever it lands; a call (rets = this instruction\'s next) comes back\n'
     '            if let (Some(to), true) = (jumped, self.rets != next_pc) {\n'
     '                self.pred_skips.retain(|&(te, _, ts)| !(ts <= from && from < te) || (ts <= to && to <= te));\n'
     '            }\n'
     '            let pc = self.pc;\n'
     '            if let Some(i) = self.pred_skips.iter().position(|&(te, _, _)| te == pc) {\n'
     '                let (_, ee, _) = self.pred_skips.remove(i);\n'
     '                self.pc = ee;\n'
     '            }\n'
     '            let pc = self.pc;\n'
     '            // a branch out of the construct abandons its pending skip\n'
     '            self.pred_skips.retain(|&(te, _, _)| pc <= te);\n')
# (the wasm JIT does not know the then-part's start where it hands a skip over: a goto out keeps it there, as before)
edit(f'{src}/jit_wasm.rs', '        cpu.pred_skips.retain(|&(t, _)| t != te);\n'
                           '        cpu.pred_skips.push((te, ee));\n',
     '        cpu.pred_skips.retain(|&(t, _, _)| t != te);\n'
     '        cpu.pred_skips.push((te, ee, te));\n')
