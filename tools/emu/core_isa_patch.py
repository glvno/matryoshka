# SPDX-License-Identifier: GPL-3.0-only
# Gives a copy of fm1-emu's fm1-core (MIT, pinned in tools/emu/Cargo.toml) the semantics for decoder entries
# tools/emu/isa_fix.sh corrects or adds that fm1-core had none for: the read-modify-write shifts by a register,
# `[R+#i] <<= R`, `<<<= R`, `>>= R`, `>>>= R` (`6e e8`, pi32v2-isa rmw.lsl.r / rmw.shl3.r / rmw.lsr.r / rmw.asr.r,
# measured on an FM-1 in hw/fm1-2026-10-24-v2). Each reads the word at the base register plus the offset, shifts it by
# the low 8 bits of the count register (32 or more acts as 32; `<<<` saturates to 0x7FFFFFFF / 0x80000000) and writes
# it back; registers and flags are left alone. Its general store / read-modify-write arm took them as unknown.
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
