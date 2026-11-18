# SPDX-License-Identifier: GPL-3.0-only
# Adds the hook the emulator's timing model needs (tools/emu/src/timing.rs, #947) to a copy of fm1-emu's fm1-core
# (MIT, pinned in tools/emu/Cargo.toml): every instruction the interpreter retires calls `Bus::retire(pc, len, cls, rw)`.
# `cls` is its cost class, worked out once when the instruction is decoded: the low 4 bits are the class (`cost` below),
# the high 4 bits the number of words a multi-register push / pop / block move moves (at most 15). `rw` holds the
# registers it reads (low 16 bits) and writes (high 16 bits), 0 where fm1-core does not work them out: the model charges
# a load whose result the next instruction reads. A bus without a timing model ignores the call (the default method is
# empty). The JIT does not call it: timing needs the interpreter.
# Run by tools/emu/isa_fix.sh on tools/emu/target/fm1-core/src (lib.rs and jit.rs); every edit asserts its anchor.
import sys

src = sys.argv[1]


def edit(path, old, new, count=1):
    s = open(path).read()
    assert s.count(old) == count, f'{path}: anchor found {s.count(old)} times, expected {count}: {old[:70]!r}'
    open(path, 'w').write(s.replace(old, new))


lib = f'{src}/lib.rs'
edit(lib, '    /// Is any interrupt source pending (before enables and priorities)?\n',
     '    /// The instruction at `pc` (`len` bytes, cost class `cls`: see `cost`; `rw`: the registers it reads, low 16\n'
     '    /// bits, and writes, high 16 bits, 0 when unknown) retires, before it runs. For a timing model; buses without\n'
     '    /// one ignore it. Only the interpreter calls it (not the JIT).\n'
     '    #[inline(always)]\n'
     '    fn retire(&mut self, _pc: u32, _len: u8, _cls: u8, _rw: u32) {}\n'
     '    /// Is any interrupt source pending (before enables and priorities)?\n')
edit(lib, '    careful: bool,\n    fast: Option<Fast>,\n}\n\nimpl Line {\n'
          '    const EMPTY: Line = Line { pc: u32::MAX, len: 0, pair_head: false, careful: false, fast: None };\n',
     '    careful: bool,\n    fast: Option<Fast>,\n    /// cost class (`cost`) and registers read / written, for `Bus::retire`\n    cls: u8,\n    rw: u32,\n}\n\n'
     'impl Line {\n'
     '    const EMPTY: Line = Line { pc: u32::MAX, len: 0, pair_head: false, careful: false, fast: None, cls: 0, rw: 0 };\n')
edit(lib, '        self.icache[slot] = Line { pc, len: insn.entry.len, pair_head, careful, fast };\n',
     '        let cls = cost::class_of(insn.entry.syntax, fast.as_ref());\n'
     '        let rw = fast.and_then(|f| f.regs_rw()).map_or(0, |(r, w)| r as u32 | (w as u32) << 16);\n'
     '        self.icache[slot] = Line { pc, len: insn.entry.len, pair_head, careful, fast, cls, rw };\n')
edit(lib, '            let mut op = BOp { fast: f, len: l.len, careful: l.careful, pair_head: l.pair_head, glue: false };\n',
     '            let mut op = BOp { fast: f, len: l.len, careful: l.careful, pair_head: l.pair_head, glue: false, cls: l.cls, rw: l.rw };\n')
edit(lib, '    glue: bool,\n}\n', '    glue: bool,\n    /// cost class (`cost`) and registers read / written, for `Bus::retire`\n    cls: u8,\n    rw: u32,\n}\n')
edit(lib, '                let next_pc = pc + op.len as u32;\n',
     '                bus.retire(pc, op.len, op.cls, op.rw);\n                let next_pc = pc + op.len as u32;\n')
edit(lib, '        let next_pc = self.pc + l.len as u32;\n',
     '        bus.retire(self.pc, l.len, l.cls, l.rw);\n        let next_pc = self.pc + l.len as u32;\n')
s = open(lib).read()
s += '''
/// Cost classes for `Bus::retire` (the low 4 bits of `cls`; the high 4 bits: words moved by a multi-register op).
pub mod cost {
    pub const ALU: u8 = 0;
    pub const LOAD: u8 = 1;
    pub const STORE: u8 = 2;
    pub const MUL: u8 = 3;
    pub const DIV: u8 = 4;
    /// may jump (taken or not: the bus sees whether the next pc follows on)
    pub const BRANCH: u8 = 5;
    /// pushes, pops and block moves of several words
    pub const MULTI: u8 = 6;
    /// interrupt enable, special registers
    pub const SYS: u8 = 7;
    /// the FPU (#979): an add, subtract, multiply, min or max; a divide or a multiply-accumulate; a conversion between
    /// int and float
    pub const FPU: u8 = 8;
    pub const FPU_DIV: u8 = 9;
    pub const FPU_CVT: u8 = 10;
    pub const CLASSES: usize = 11;

    /// an FPU op's class from its op (fm1-isa's fpu.rs: binary 0..8 = byte 2 & 15, unary = byte 2)
    fn fpu(op: u8) -> u8 {
        match op {
            3 | 7 | 8 => FPU_DIV,
            0x1f | 0x5f | 0x8f | 0x9f => FPU_CVT,
            _ => FPU,
        }
    }

    fn words(n: u32) -> u8 {
        (n.min(15) as u8) << 4
    }

    /// The class of an instruction from its micro-op where it has one, else from its syntax.
    pub(crate) fn class_of(syntax: &str, fast: Option<&super::Fast>) -> u8 {
        use super::{Fast, Op};
        if let Some(f) = fast {
            return match *f {
                Fast::Ld { .. } | Fast::LdIdx { .. } | Fast::LdPost { .. } | Fast::LdW { .. } | Fast::LdWSp { .. }
                | Fast::LdBu { .. } | Fast::LdPre { .. } | Fast::LdPostR { .. } | Fast::MemA4 { .. } => LOAD,
                Fast::St { .. } | Fast::StIdx { .. } | Fast::StPost { .. } | Fast::StW { .. } | Fast::StWSp { .. }
                | Fast::StPre { .. } | Fast::StPostR { .. } => STORE,
                Fast::Rmw { .. } => LOAD,
                Fast::Alu3 { op: Op::Mul, .. } | Fast::Alu3I { op: Op::Mul, .. } | Fast::Alu2 { op: Op::Mul, .. }
                | Fast::Alu2I { op: Op::Mul, .. } | Fast::A4 { op: Op::Mul, .. } => MUL,
                Fast::Div { .. } => DIV,
                Fast::PushRets { n } | Fast::PopPc { n } => MULTI | words(n as u32 + 1),
                Fast::PushMask { mask } | Fast::PopMask { mask } => MULTI | words(mask.count_ones() + 1),
                Fast::BlockMove { mask, .. } => MULTI | words(mask.count_ones()),
                Fast::PopRets => MULTI | words(2),
                Fast::SetIe { .. } | Fast::IcfgRd { .. } | Fast::IcfgWr { .. } => SYS,
                Fast::FOp { op, .. } => fpu(op),
                Fast::Raw { route: 21 | 22, .. } => ALU,
                Fast::Raw { route: 27, .. } => MULTI | words(4),
                Fast::Raw { .. } => LOAD,
                ref f if f.may_jump() => BRANCH,
                _ => ALU,
            };
        }
        let s = syntax.trim_end().trim_end_matches('#').trim_end();
        if s.contains('/') {
            DIV
        } else if s.contains('*') {
            MUL
        } else if s.starts_with("if") || s.contains("goto") || s.contains("call") || s.starts_with("rt") {
            BRANCH
        } else if s.contains('{') {
            MULTI | words(4)
        } else if let Some(eq) = s.find('=') {
            if s[..eq].contains('[') {
                STORE
            } else if s[eq..].contains('[') {
                LOAD
            } else if s.contains("icfg") || s.contains("psr") || s.contains("sp") {
                SYS
            } else {
                ALU
            }
        } else if s == "cli" || s == "sti" {
            SYS
        } else {
            ALU
        }
    }
}
'''
open(lib, 'w').write(s)
edit(f'{src}/jit.rs', 'BOp { fast, len: 2, careful: false, pair_head: false, glue: false }',
     'BOp { fast, len: 2, careful: false, pair_head: false, glue: false, cls: 0, rw: 0 }')
