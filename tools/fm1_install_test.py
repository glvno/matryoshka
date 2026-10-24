#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Tests of tools/fm1_install.py's package checks, its memory of which M-VAVE package an install was writing (#183)
and its boot code read (#264).
No device and no MIDI library needed. M-VAVE's Official Open is not in the repository (licence): FM1_OPEN_FILE names a
local copy (its .fwsc or the Workbench page) for the one test that needs it.
  python3 tools/fm1_install_test.py"""
import hashlib
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
    def __init__(self, head=None):
        self.closed, self.head, self.q = False, head, []

    def close(self):
        self.closed = True

    def drain(self):
        self.q = []

    def send(self, pkt):
        """as ota.c ota_reply_head: firmware with a head answers 64 bytes of it; other firmware stays silent"""
        d = fi.unpack7(pkt[1:-1])
        if self.head is not None and d[:3] == b"\x00\x59\x12" and len(d) == 9:
            off = int.from_bytes(d[6:8], "little")
            body = bytearray([0x00, 0x59, 0x12, 66, 0, 0]) + off.to_bytes(2, "little") + self.head[off:off + 64]
            body.append(~sum(body[6:]) & 0xFF)
            self.q.append(b"\xF0" + fi.pack7(body) + b"\xF7")
        return True

    def read(self, timeout):
        return self.q.pop(0) if self.q else None


def head_of(path):
    """the boot code inside a package"""
    im = fi.logical_image(open(path, "rb").read())
    h = fi.jl_dec(im[:0x40])
    for i in range(int.from_bytes(h[8:10], "little")):
        e = fi.jl_dec(im[0x40 + i * 0x50:0x90 + i * 0x50])
        if int.from_bytes(e[0:2], "little") == 0:
            off = int.from_bytes(e[8:12], "little")
            return im[off:off + 0x4000]
    raise AssertionError("no flash.bin")


def running(text, head=None):
    """an FM-1 running firmware `text`, with this boot code (None: firmware that does not tell)"""
    return fi.Device(Link(head), fi.Identity(text, text.split("_")[0], 0), "FM-1")


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

    def test_a_refused_open_does_not_guess(self):
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
        self.assertIn("refused Official Open", str(e.exception))
        self.assertIn("could not be read", str(e.exception))
        self.assertNotIn("Most likely", str(e.exception))


class BootCode(unittest.TestCase):
    """#264: the tool reads the FM-1's boot code and names it before an M-VAVE package is sent"""

    def setUp(self):
        self.old = dict(fi.DELAY)
        fi.DELAY["head"] = 0.01
        self.up = fi.Updater(None)
        self.sent = False

        def check(*a):
            self.sent = True
            raise fi.InstallError("stopped", "the test stops here")
        self.up.check = check
        self.state = os.path.join(tempfile.mkdtemp(), "target")

    def tearDown(self):
        fi.DELAY.update(self.old)

    def test_reads_the_whole_head(self):
        head = bytes(range(256)) * 64
        self.assertEqual(fi.read_head(Link(head)), head)
        self.assertIsNone(fi.read_head(Link(None)))

    def test_names(self):
        v15 = head_of(V15)
        self.assertEqual(hashlib.sha256(v15).hexdigest(), fi.V15_HEAD_SHA256)
        self.assertEqual(fi.head_text(v15), "V15's")
        self.assertIn("neither V15's nor Official Open's", fi.head_text(b"\0" * 0x4000))

    def test_v15_over_another_head_is_refused_before_sending(self):
        dev = running("FM-1_712", b"\0" * 0x4000)
        with self.assertRaises(fi.InstallError) as e:
            self.up.install(dev, b"", "FM-1_015", target="v15", state=self.state)
        self.assertEqual(e.exception.code, "bootcode")
        self.assertIn("neither V15's nor Official Open's", str(e.exception))
        self.assertIn("--save-head", str(e.exception))
        self.assertFalse(self.sent)
        self.assertIsNone(fi.remembered_target(self.state))

    def test_open_over_v15s_head_says_return_to_v15(self):
        dev = running("FM-1_712", head_of(V15))
        with self.assertRaises(fi.InstallError) as e:
            self.up.install(dev, b"", "FM-1_8000014", target="open", state=self.state)
        self.assertEqual(e.exception.code, "bootcode")
        self.assertIn("is V15's", str(e.exception))
        self.assertFalse(self.sent)

    def test_matching_or_unreadable_head_goes_on(self):
        for head in (head_of(V15), None):
            self.sent = False
            with self.assertRaises(fi.InstallError):
                self.up.install(running("FM-1_712", head), b"", "FM-1_015", target="v15", state=self.state)
            self.assertTrue(self.sent)

    def test_info_saves_the_head(self):
        head = head_of(V15)
        out = os.path.join(tempfile.mkdtemp(), "boot.bin")

        class Backend:
            def input_names(self):
                return ["FM-1"]

            def output_names(self):
                return ["FM-1"]

            def open(self, i, o):
                return Link(head)
        import io
        buf = io.StringIO()
        old = fi.handshake
        fi.handshake = lambda link, tries=3: fi.Identity("FM-1_712", "FM-1", 712)
        try:
            self.assertEqual(fi.main(["--info", "--save-head", out], backend=Backend(), out=buf), 0)
        finally:
            fi.handshake = old
        self.assertIn("boot code: V15's", buf.getvalue())
        self.assertEqual(open(out, "rb").read(), head)


if __name__ == "__main__":
    unittest.main()
