#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""tools/build.py's disassembly checks read the FPU's instructions (#979). No toolchain: the listings below are what
JieLi's objdump prints. LISTING is a part of the FPU benchmark build (firmware CI run 43928668815, artifact
matryoshka-fpu-measure, bench-fpu/matryoshka.dis, k_res_f_sub); AGAIN is what it prints for the same bytes with the FPU's
instructions replaced by nops (each instruction's text as the same listing prints those bytes elsewhere)."""
import struct
import tempfile
import unittest
from pathlib import Path

import build

LISTING = """\
k_res_f_sub:
 2052f08:    00 3a             \tr0 = [sp+104]
 2052f0a:    3f f5              <unknown instruction>
 2052f0c:    02 03             \trep 2 r2 {
 2052f0e:    01 20             \t\tr1 = [sp]
                               \t}
 2052f10:    3f e5              <unknown instruction>
 2052f12:    12 1b             \tr2 *= r1
 2052f14:    3f e5              <unknown instruction>
 2052f16:    40 31             \tr0 = 17
 2052f18:    83 35             \t[sp+84] = r3
 2052f1a:    01 3b             \tr1 = [sp+108]
 2052f1c:    3f e5              <unknown instruction>
 2052f1e:    12 13             \tr2 = b[r1++=r14] (u)
 2052f20:    3f f5              <unknown instruction>
 2052f22:    00 e1 00 22       \tr0 = r2 + 512
 2052f26:    3f e5              <unknown instruction>
 2052f28:    02 1b             \tr2 *= r0
 2052f2a:    3f e5              <unknown instruction>
 2052f2c:    a0 31             \t[sp+196] = r0
 2052f2e:    83 34             \t[sp+80] = r3
 2052f30:    00 3e             \tr0 = [sp+120]
 2052f32:    3f f5              <unknown instruction>
 2052f34:    02 17             \tr2 = r0.b0 (u)
"""

AGAIN = """\
k_res_f_sub:
 2052f08:    00 3a             \tr0 = [sp+104]
 2052f0a:    00 00             \tnop
 2052f0c:    00 00             \tnop
 2052f0e:    01 20             \tr1 = [sp]
 2052f10:    00 00             \tnop
 2052f12:    00 00             \tnop
 2052f14:    00 00             \tnop
 2052f16:    00 00             \tnop
 2052f18:    83 35             \t[sp+84] = r3
 2052f1a:    01 3b             \tr1 = [sp+108]
 2052f1c:    00 00             \tnop
 2052f1e:    00 00             \tnop
 2052f20:    00 00             \tnop
 2052f22:    00 00             \tnop
 2052f24:    00 22             \tr0 = [sp+8]
 2052f26:    00 00             \tnop
 2052f28:    00 00             \tnop
 2052f2a:    00 00             \tnop
 2052f2c:    00 00             \tnop
 2052f2e:    83 34             \t[sp+80] = r3
 2052f30:    00 3e             \tr0 = [sp+120]
 2052f32:    00 00             \tnop
 2052f34:    00 00             \tnop
"""

FPU = {   # what fm1-emu's fpu.rs makes of each: op = byte 2 & 15, a = byte 2 >> 4, d = byte 3 >> 4, b = byte 3 & 15
    0x2052F0A: ("3f f5 02 03", "r0 = r0 * r3 (f) #"),
    0x2052F10: ("3f e5 12 1b", "r1 = r1 * r11 (f)"),
    0x2052F14: ("3f e5 40 31", "r3 = r4 + r1 (f)"),
    0x2052F1C: ("3f e5 12 13", "r1 = r1 * r3 (f)"),
    0x2052F20: ("3f f5 00 e1", "r14 = r0 + r1 (f) #"),   # objdump read "00 e1 00 22": it swallowed 2052f24
    0x2052F26: ("3f e5 02 1b", "r1 = r0 * r11 (f)"),
    0x2052F2A: ("3f e5 a0 31", "r3 = r10 + r1 (f)"),
    0x2052F32: ("3f f5 02 17", "r1 = r0 * r7 (f) #"),
}


def found(listing):
    return {a: (b.hex(" "), t) for a, (b, t) in build.fpu_scan(listing).items()}


def ram_listing(*lines):
    return "Disassembly of section .ram_text:\n\nfm1_flash_job:\n" + "".join(f" {ln}\n" for ln in lines)


C1 = "Disassembly of section .c1_text:\n\nfm1_c1_main:\n 1c07000:    c5 00             \tcall r5\n"


class FpuText(unittest.TestCase):
    def test_every_form_of_fpu_rs(self):
        cases = {
            "3f e5 72 00": "r0 = r7 * r0 (f)",
            "3f e5 31 42": "r4 = r3 - r2 (f)",
            "3f e5 23 15": "r1 = r2 / r5 (f)",
            "3f e5 15 32": "r3 = fmin(r1, r2) (f)",
            "3f e5 26 32": "r3 = fmax(r2, r2) (f)",
            "3f e5 47 65": "r6 += r4 * r5 (f)",
            "3f e5 48 65": "r6 -= r4 * r5 (f)",
            "3f e5 1f 20": "r2 = ftoi(r0) (f)",
            "3f e5 5f 20": "r2 = ftou(r0) (f)",
            "3f e5 8f 31": "r3 = itof(r1) (f)",
            "3f e5 9f 31": "r3 = utof(r1) (f)",
            "3f f5 8f 31": "r3 = itof(r1) (f) #",
            "97 ee 80 04": "iff (r0 u<= r7) {",               # the benchmark's: r6 = 1, then r6 = 0 unless r0 > r7
            "12 e9 80 05": "iff (r0 u>= r2) {",
            "01 e8 fc 69": "iff (r6 == r1) goto -8",
            "00 ec 12 28": "iff (r2 u> r0) goto 36",
            "4a ff 80 21 10 00": "iff (r2 >= r1) goto 32",
            "4b ff 80 21 f0 ff": "iff (r2 u< r1) goto -32",
        }
        for raw, text in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(build.fpu_text(bytes.fromhex(raw)), text)

    def test_integer_instructions_are_not_the_fpus(self):
        for raw in ("00 e1 00 22", "3f e5 04 31", "01 e8 fc 61", "4a ff 00 21 10 00", "d8 ec 63 71"):
            with self.subTest(raw=raw):
                self.assertIsNone(build.fpu_text(bytes.fromhex(raw)))

    def test_lengths_follow_the_second_byte(self):
        self.assertEqual([build.insn_len(0x3F, b) for b in (0x20, 0xE5, 0xF5, 0xFF)], [2, 4, 4, 6])


class Reread(unittest.TestCase):
    def test_finds_each_fpu_instruction_and_the_one_objdump_swallowed(self):
        self.assertEqual(found(LISTING), FPU)

    def test_merged_listing_covers_every_byte_once(self):
        merged = build.fpu_merge(AGAIN, build.fpu_scan(LISTING), whole=True)
        rows = [m for m in map(build.LINE.match, merged.splitlines()) if m]
        at = 0x2052F08
        for m in rows:
            self.assertEqual(int(m.group(1), 16), at)
            at += len(m.group(2).split())
        self.assertEqual(at, 0x2052F36)
        texts = {int(m.group(1), 16): m.group(3) for m in rows}
        for a, (_, t) in FPU.items():
            self.assertEqual(texts[a], t)
        self.assertEqual(texts[0x2052F24], "r0 = [sp+8]")
        self.assertEqual(build.unknown(merged), [])
        self.assertTrue(merged.startswith("k_res_f_sub:\n"))

    def test_a_listing_without_fpu_needs_no_second_objdump(self):
        plain = "\n".join(ln for ln in AGAIN.splitlines() if "nop" not in ln)
        self.assertEqual(build.fpu_scan(plain), {})
        self.assertEqual(build.fpu_reread(Path("/nonexistent.elf"), plain, "", ""), (plain, "", ""))

    def test_merge_refuses_a_listing_without_one_of_them(self):
        short = "\n".join(ln for ln in AGAIN.splitlines() if not ln.startswith(" 2052f32"))
        with self.assertRaises(SystemExit):
            build.fpu_merge(short, build.fpu_scan(LISTING), whole=True)

    def test_elf_blank_puts_nops_at_the_file_offset(self):
        code = bytes.fromhex("00 3a 3f e5 12 1b 4a ff 80 21 10 00 c5 00")
        names = b"\0.text\0"
        shoff = 52 + len(code) + len(names)
        head = bytearray(52)
        head[:6] = b"\x7fELF\x01\x01"
        struct.pack_into("<I", head, 32, shoff)
        struct.pack_into("<HH", head, 46, 40, 3)               # section headers: 40 bytes each, three of them
        sections = bytes(40) + struct.pack("<10I", 1, 1, 6, 0x1C00F00, 52, len(code), 0, 0, 2, 0) \
            + struct.pack("<10I", 0, 3, 0, 0, 52 + len(code), len(names), 0, 0, 1, 0)
        with tempfile.TemporaryDirectory() as d:
            elf, out = Path(d) / "a.elf", Path(d) / "b.elf"
            elf.write_bytes(bytes(head) + code + names + sections)
            fpu = {0x1C00F02: (bytes.fromhex("3f e5 12 1b"), "r1 = r1 * r11 (f)"),
                   0x1C00F06: (bytes.fromhex("4a ff 80 21 10 00"), "iff (r2 >= r1) goto 32")}
            build.elf_blank(elf, fpu, out)
            self.assertEqual(out.read_bytes()[52:52 + len(code)], bytes.fromhex("00 3a" + " 00" * 10 + " c5 00"))
            with self.assertRaises(SystemExit):        # bytes that are not there: refused
                build.elf_blank(elf, {0x1C00F00: (bytes.fromhex("3f e5 12 1b"), "")}, out)


class RamCode(unittest.TestCase):
    def check(self, listing, again):
        """.ram_text as build_app reads it: objdump's listing, re-read when it holds the FPU's instructions"""
        f = build.fpu_scan(listing)
        return build.ram_code_check(build.fpu_merge(again, f) if f else listing, C1)

    def test_a_call_objdump_hid_behind_an_fpu_instruction_fails(self):
        # objdump reads the FPU instruction's second half "00 e1" and the call after it as one instruction
        listing = ram_listing("1c00f00:    3f e5              <unknown instruction>",
                              "1c00f02:    00 e1 c3 00       \tr0 = r12 + 0",
                              "1c00f06:    00 00             \tnop")
        old = build.ram_code_check(listing, C1)[0]
        self.assertEqual([e for e in old if "call" in e], [])
        again = ram_listing("1c00f00:    00 00             \tnop", "1c00f02:    00 00             \tnop",
                            "1c00f04:    c3 00             \tcall r3", "1c00f06:    00 00             \tnop")
        errors, _ = self.check(listing, again)
        self.assertEqual(len(errors), 1)
        self.assertIn(".ram_text contains calls", errors[0])
        self.assertIn("call r3", errors[0])

    def test_a_call_objdump_read_into_an_fpu_instruction_passes(self):
        # "3f e5 92 ea" is r14 = r9 * r10 (f); objdump reads its "92 ea" and the next two bytes as a call
        listing = ram_listing("1c00f00:    3f e5              <unknown instruction>",
                              "1c00f02:    92 ea 00 22       \tcall 1234 <fm1_flash_wait : 1c013d8 >",
                              "1c00f06:    00 00             \tnop")
        self.assertNotEqual(build.ram_code_check(listing, C1)[0], [])     # objdump's listing alone cannot pass
        again = ram_listing("1c00f00:    00 00             \tnop", "1c00f02:    00 00             \tnop",
                            "1c00f04:    00 22             \tr0 = [sp+8]", "1c00f06:    00 00             \tnop")
        errors, notes = self.check(listing, again)
        self.assertEqual(errors, [])
        self.assertIn(".ram_text: 3 insns, no calls, no flash address", notes)

    def test_an_instruction_nobody_can_read_fails(self):
        listing = ram_listing("1c00f00:    12 e7              <unknown instruction>", "1c00f02:    00 22             \tr0 = [sp+8]")
        errors, _ = self.check(listing, listing)
        self.assertEqual(len(errors), 1)
        self.assertIn("nobody can read", errors[0])


if __name__ == "__main__":
    unittest.main()
