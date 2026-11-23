#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 morgulbrut
"""tools/m1_link.py's bank commands against a fake FM-1 (no device, no mido needed): #955, they walk the slots the FM-1's
INFO reports (60 with the pattern store on), as proto.c answers S_RANGE past them. #950: fpubench reads the CPU
benchmark's DIAG pages (firmware/src/bench.c bench_diag) as they are laid out."""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import mido  # noqa: F401
except ImportError:
    stub = sys.modules["mido"] = types.ModuleType("mido")
    stub.Message = lambda kind, data: types.SimpleNamespace(type=kind, data=list(data))
import m1_link  # noqa: E402

S_RANGE = 1


class FakeFM1:
    """answers HELLO, SLOT_INFO and SLOT_ERASE as firmware/src/proto.c does, for a bank of `slots` (None: INFO without
    byte 15, firmware before the pattern store)"""

    def __init__(self, slots, used=()):
        self.slots, self.used, self.erased = slots, set(used), []

    def bank(self):
        return self.slots or 64

    def ask(self, msg, want, tries=3, wait=0.8):
        cmd, d = msg.data[3], m1_link.unpack7(msg.data[4:])
        if cmd == 0x01:
            info = [5, 32, 64, 1, 2, 0, 0, 0, 0, 1, 17, 0, 0, 0, 0]
            return info + [self.slots] if self.slots else info
        if cmd == 0x15:
            if d[0] >= self.bank():
                sys.exit(f"no answer from the FM-1 to command {cmd:#04x}")
            name = list(b"Monolith D".ljust(20, b"\0"))
            return [d[0], int(d[0] in self.used), 100, 0, *name]
        if cmd == 0x14:
            if d[0] >= self.bank():
                return [0x40, cmd, S_RANGE, 0]
            self.erased.append(d[0])
            return [0x40, cmd, 0, 0]
        raise AssertionError(f"unexpected command {cmd:#04x}")

    def ack(self, msg, cmd, wait=0.8, tries=3):
        p = self.ask(msg, (0x40, cmd))
        if p[2]:
            sys.exit(f"FM-1: bad offset or size (aux {p[3]})")


class Bank(unittest.TestCase):
    def run_bank(self, fm1, *a, answer="y"):
        out, asked = [], []
        m1_link.bank_command(fm1, list(a), ask=lambda q: asked.append(q) or answer, out=out.append)
        return out, asked

    def test_info_walks_the_60_slots(self):
        out, _ = self.run_bank(FakeFM1(60, used=(0, 59)), "bank-info")
        self.assertEqual(out[-1], "2 of 60 slots used")
        self.assertTrue(out[1].startswith("slot 60  Monolith D"))

    def test_info_without_byte_15_is_64(self):
        out, _ = self.run_bank(FakeFM1(None), "bank-info")
        self.assertTrue(out[-1].startswith("0 of 64 slots used"))

    def test_clear_asks_then_erases_the_60(self):
        fm1 = FakeFM1(60)
        out, asked = self.run_bank(fm1, "bank-clear")
        self.assertIn("60 slots", asked[0])
        self.assertEqual(fm1.erased, list(range(60)))
        self.assertEqual(out, ["bank emptied"])

    def test_clear_refused_erases_nothing(self):
        fm1 = FakeFM1(60)
        out, _ = self.run_bank(fm1, "bank-clear", answer="")
        self.assertEqual(fm1.erased, [])
        self.assertEqual(out, ["bank left as it is"])

    def test_clear_yes_skips_the_question(self):
        fm1 = FakeFM1(60)
        _, asked = self.run_bank(fm1, "bank-clear", "--yes")
        self.assertEqual(asked, [])
        self.assertEqual(len(fm1.erased), 60)


class Factory(unittest.TestCase):
    def test_factory_commands_follow_feature_bit_26(self):
        class Info:
            def __init__(self, byte14):
                self.byte14 = byte14

            def ask(self, msg, want, tries=3, wait=0.8):
                return [5, 32, 64, 1, 2, 0, 0, 0, 0, 1, 17, 0, 0, 0, self.byte14, 60]
        self.assertFalse(m1_link.has_factory(Info(0x02)))  # 1.17.0: the pattern store (bit 25), no factory region
        self.assertTrue(m1_link.has_factory(Info(0x06)))   # bit 26: the factory region's commands


class FpuBench(unittest.TestCase):
    class Bench:
        """DIAG pages 178.. as bench.c bench_diag answers them: two kernels, the clock probe at 384 MHz (16 cycles a tick)"""
        KERNELS = [("loop ld+add", 1, 240, 300, 7), ("f add x8", 8, 1264, 1900, 0x3F000000)]

        def __init__(self):
            self.waits = {}

        def ask(self, msg, want, tries=3, wait=0.8):
            cmd, d = msg.data[3], m1_link.unpack7(msg.data[4:])
            assert cmd == 0x2B
            page = d[0]
            self.waits[page] = (tries, wait)
            le = lambda *w: [b for x in w for b in x.to_bytes(4, "little")]
            if page == 178:   # version, kernels, FPU, frames, runs, 16384 adds, 49152 adds (2048 ticks: 16 a tick), PLL
                return [page, *le(1, len(self.KERNELS), 1, 128, 8, 1000, 1000 + 2048, 0x123)]
            name, ops, lo, hi, res = self.KERNELS[page - 179]
            return [page, *le(lo, hi, res), ops, *list(name.encode().ljust(19, b"\0"))]

    def test_reads_the_build_and_each_kernel(self):
        fm1 = self.Bench()
        r = m1_link.fpubench_read(fm1)
        self.assertEqual(fm1.waits[178], (1, 30.0))           # the run takes about a second: asked once, waited for
        self.assertEqual((r["fpu"], r["frames"], r["runs"]), (1, 128, 8))
        self.assertEqual(r["cycles_per_tick"] * 24, 384)
        self.assertEqual([k["name"] for k in r["kernels"]], ["loop ld+add", "f add x8"])
        self.assertEqual(r["kernels"][1]["ops"], 8)
        self.assertEqual(r["kernels"][1]["result_f32"], 0.5)

    def test_prints_cycles_per_sample_less_the_loop(self):
        out = []
        m1_link.print_fpubench(m1_link.fpubench_read(self.Bench()), out=out.append)
        self.assertIn("build: FPU; CPU 384 MHz", out[0])
        loop, fadd = out[2].split(), out[3].split()
        self.assertEqual(loop[2], "30.0")                        # 240 ticks x 16 / 128
        self.assertEqual(fadd[3:6], ["158.0", "128.0", "16.0"])  # less the loop: 128 cycles, 16 per add



class Palette(unittest.TestCase):
    """#1196: the palette's link vectors (firmware/test/palette_test.c, web/src/protocol.test.ts assert the same bytes)"""
    V1 = bytes.fromhex("00024D4F4E4F4C49544820440000000000000000000001007856341278563412055741524D31")
    V2 = bytes.fromhex("1000383038204B4954" + "00" * 14)

    def test_vectors(self):
        self.assertEqual(m1_link.crc16(b"123456789"), 0x29B1)
        self.assertEqual((len(self.V1), m1_link.crc16(self.V1)), (38, 0x9B74))
        self.assertEqual((len(self.V2), m1_link.crc16(self.V2)), (23, 0x3659))
        self.assertEqual(m1_link.palette_entry(list(self.V1)), (0, 2, "MONOLITH D", [(0, 0x12345678, 0x12345678, "WARM1")]))
        self.assertEqual(m1_link.palette_entry(list(self.V2)), (16, 0, "808 KIT", []))

    def test_now(self):
        p = [1, 0, 0xFF, 1, 7, 0] + [0] * 27 * 8
        p[6:6 + 27] = [1, 16, 0, 0x59, 0x36, 0x4B, 0x0E, *b"808 KIT", *[0] * 13]
        cur, nxt, edited, seq, rows = m1_link.palette_now(p)
        self.assertEqual((cur, nxt, edited, seq), (0, 0xFF, 1, 7))
        self.assertEqual(rows[0], (1, 16, 0, 0x3659, 3659, "808 KIT"))
        self.assertEqual(rows[1][0], 0)


if __name__ == "__main__":
    unittest.main()
