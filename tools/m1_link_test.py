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


class MidiLog(unittest.TestCase):
    """DIAG pages 145 / 146 as clock_in.h cin_log_diag answers them (#870), with the audio onset: Reel's Start, its clock
    at 120 bpm (20.8 ms, as the log's 100 us units keep it), its audio's downbeat 1.5 ms after clock #7"""
    S, PER = 1_000_000, 20_800
    ENTS = [(S, 100, 0xFA, 0x00),                                  # Start, engine ticks 100
            (S, 6 * 208, 0xF8, 0x07 | 6 << 3),                     # clock #1..#7, folded
            (S + 6 * PER + 1500, 107, 0x01, 0x07 | 14 << 3),       # the onset: peak below 2^14
            (S + 7 * PER, 9 * 208, 0xF8, 0x07 | 9 << 3),           # clock #8..#17
            (S + 17 * PER, 0, 0xFC, 0x07)]
    HEAD = [11, 255, 5, 0 | 69 << 8 | 256 << 16, S + 30 * PER, 120, 0, 5]

    class Log:
        def __init__(self, head, ents):
            self.head, self.ents, self.rd = head, ents, 0

        def ask(self, msg, want, tries=3, wait=0.8):
            page = m1_link.unpack7(msg.data[4:])[0]
            le = lambda *w: [b for x in w for b in x.to_bytes(4, "little")]
            if page == 145:
                self.rd = 0
                return [page, *le(*self.head)]
            out = []
            for _ in range(4):
                if self.rd < len(self.ents):
                    us, v, st, fl = self.ents[self.rd]
                    out += [*us.to_bytes(4, "little"), v & 0xFF, v >> 8, st, fl]
                    self.rd += 1
                else:
                    out += [0] * 8
            return [page, *out]

    def lines(self, head, ents):
        out = []
        m1_link.print_midilog(*m1_link.midilog_read(self.Log(head, ents)), out=out.append)
        return out

    def test_onset_against_the_clock_and_start(self):
        out = self.lines(self.HEAD, self.ENTS)
        self.assertIn("peak reaches 256 of 32768 (-42 dBFS) after 69 halves (200 ms)", out[1])
        onset = [ln for ln in out if "Audio onset" in ln]
        self.assertEqual(len(onset), 1)
        self.assertIn("Audio onset  +1.50 ms after clock #7, 6.1 ticks after Start", onset[0])
        self.assertIn("peak < 16384 of 32768 (-6 dBFS), engine ticks 107 (Start + 7)", onset[0])
        self.assertIn("Clock #8..#17 since Start", out[out.index(onset[0]) + 1])
        self.assertIn("+   20.80 ms  Clock #8", out[out.index(onset[0]) + 1])   # (its gap from clock #7, not the onset)

    def test_onset_before_the_first_clock_and_logged_late(self):
        ents = [self.ENTS[0], (self.S + 900, 0, 0xF8, 0x07), (self.S + 400, 100, 0x01, 0x05 | 13 << 3)]
        onset = [ln for ln in self.lines(self.HEAD[:2] + [3] + self.HEAD[3:], ents) if "Audio onset" in ln]
        self.assertIn("before clock #1, 0.40 ms after Start", onset[0])

    def test_firmware_before_the_onset(self):
        out = self.lines([3, 256, 1, 1, self.S, 0, 0, 1], [self.ENTS[0]])
        self.assertIn("frozen 64 messages after a Stop", out[0])
        self.assertIn("before the audio onset", out[1])


if __name__ == "__main__":
    unittest.main()
