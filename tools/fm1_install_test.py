#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Tests of tools/fm1_install.py's package checks and its memory of which M-VAVE package an install was writing (#183).
No device and no MIDI library needed. M-VAVE's Official Open is not in the repository (licence): FM1_OPEN_FILE names a
local copy (its .fwsc or the Workbench page) for the one test that needs it.
  python3 tools/fm1_install_test.py"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm1_install as fi  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V15 = os.path.join(ROOT, "web/public/firmware/FM-1_015.fwsc")
OURS = os.path.join(ROOT, "web/public/firmware/matryoshka.fwsc")


class Link:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def parked(text):
    """an FM-1 waiting in an update loader"""
    m = text.split("_")[0]
    return fi.Device(Link(), fi.Identity(text, m, 15), "FM-1")


class Packages(unittest.TestCase):
    def test_v15_is_the_v15_target(self):
        product, image, target = fi.load_package(V15, False)
        self.assertEqual((product, target), ("FM-1_015", "v15"))

    def test_ours_has_no_mvave_target(self):
        self.assertIsNone(fi.load_package(OURS, False)[2])

    def test_open_checks_refuse_other_packages(self):
        self.assertRegex(fi.open_problem(open(V15, "rb").read()), "identity is FM-1_015")
        self.assertRegex(fi.open_problem(open(OURS, "rb").read()), "not M-VAVE Official Open")

    def test_a_page_without_open_is_refused(self):
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False) as f:
            f.write(b"<!doctype html><p>nothing here</p>")
        with self.assertRaises(fi.InstallError) as e:
            fi.load_package(f.name, False)
        self.assertIn("no M-VAVE Official Open", str(e.exception))

    @unittest.skipUnless(os.environ.get("FM1_OPEN_FILE"), "FM1_OPEN_FILE not set")
    def test_mvave_official_open(self):
        product, image, target = fi.load_package(os.environ["FM1_OPEN_FILE"], False)
        self.assertRegex(product, r"^FM-1_8\d{6}$")
        self.assertEqual(target, "open")


class Target(unittest.TestCase):
    def setUp(self):
        self.state = os.path.join(tempfile.mkdtemp(), "target")
        self.up = fi.Updater(None)
        self.written = False

        def write(*a):
            self.written = True
        self.up.write = write
        self.up.verify = lambda product, step: product

    def test_loader_fits_open(self):
        self.assertTrue(fi.loader_fits("ota-FM-1_015", "FM-1_8000014"))
        self.assertFalse(fi.loader_fits("ota-FM-1_700", "FM-1_8000014"))

    def test_finished_only_with_the_package_it_started_with(self):
        fi.remember_target("v15", self.state)
        dev = parked("ota-FM-1_015")
        with self.assertRaises(fi.InstallError) as e:
            self.up.install(dev, b"", "FM-1_8000014", target="open", sure=True, state=self.state)
        self.assertEqual(e.exception.code, "wrongtarget")
        self.assertTrue(dev.link.closed)
        self.assertFalse(self.written)

    def test_without_a_record_it_asks_then_goes_ahead_with_sure(self):
        with self.assertRaises(fi.InstallError) as e:
            self.up.install(parked("ota-FM-1_015"), b"", "FM-1_015", target="v15", state=self.state)
        self.assertEqual(e.exception.code, "whichtarget")
        self.assertFalse(self.written)
        self.up.install(parked("ota-FM-1_015"), b"", "FM-1_015", target="v15", sure=True, state=self.state)
        self.assertTrue(self.written)
        self.assertIsNone(fi.remembered_target(self.state))   # forgotten once the FM-1 is back

    def test_the_same_one_finishes(self):
        fi.remember_target("open", self.state)
        self.up.install(parked("ota-FM-1_015"), b"", "FM-1_8000014", target="open", state=self.state)
        self.assertTrue(self.written)

    def test_an_interrupted_crossing_is_finished_only_by_crossing_again(self):
        fi.remember_target("v15-cross", self.state)
        for kw in ({"target": "v15", "sure": True}, {"target": "open", "sure": True}):
            with self.assertRaises(fi.InstallError) as e:
                self.up.install(parked("ota-FM-1_015"), b"", "FM-1_015", state=self.state, **kw)
            self.assertEqual(e.exception.code, "crossresume")
        self.assertFalse(self.written)
        self.up.install(parked("ota-FM-1_015"), b"", "FM-1_015", target="v15", cross=True, state=self.state)
        self.assertTrue(self.written)

    def test_the_crossing_starts_with_its_own_go_ahead(self):
        sent = []
        dev = parked("FM-1_713")
        dev.link.send = lambda p: sent.append(p) or True
        self.up.product = "FM-1_015"
        self.up.serve = lambda *a: (0, False, False)
        self.up.addrs = []
        old = fi.DELAY["start"]
        fi.DELAY["start"] = 0
        try:
            with self.assertRaises(fi.InstallError) as e:
                self.up.check(dev, b"", lambda *a: None, cross=True)
        finally:
            fi.DELAY["start"] = old
        self.assertEqual(sent, [fi.CROSS])
        self.assertIn("Matryoshka 1.3", str(e.exception))

    def test_cross_boot_goes_with_the_v15_only(self):
        class Backend:
            def input_names(self):
                return ["Matryoshka"]

            def output_names(self):
                return ["Matryoshka"]

            def open(self, i, o):
                raise RuntimeError("no device in this test")
        rc = fi.main([OURS, "--cross-boot", "--yes"], backend=Backend(), out=open(os.devnull, "w"))
        self.assertEqual(rc, fi.EXIT["usage"])        # refused before any FM-1 is looked for

    def test_a_refused_open_says_the_v15(self):
        self.up.product = "FM-1_8000014"
        self.up.serve = lambda *a: (4, False, False)
        self.up.addrs = [0, 512, 472064, 1024]
        dev = parked("FM-1_712")
        dev.link.send = lambda p: True
        old = fi.DELAY["start"]
        fi.DELAY["start"] = 0
        try:
            with self.assertRaises(fi.InstallError) as e:
                self.up.check(dev, b"", lambda *a: None)
        finally:
            fi.DELAY["start"] = old
        self.assertIn("not Official Open's", str(e.exception))
        self.assertIn("official V15", str(e.exception))


if __name__ == "__main__":
    unittest.main()
