#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Tests of tools/fm1_install.py's package checks, its memory of which M-VAVE package an install was writing (#183),
its boot code read (#264) and its pin to one USB location, the test rig's (#698, tools/fm1_usb.py).
No device and no MIDI library needed. M-VAVE's Official Open is not in the repository (licence): FM1_OPEN_FILE names a
local copy (its .fwsc or the Workbench page) for the one test that needs it.
  python3 tools/fm1_install_test.py"""
import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm1_install as fi  # noqa: E402
import fm1_usb  # noqa: E402

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


def rekey(head, key, bad_crc=False):
    """the boot code with its chip-key block written again in other bytes for `key` (as a JieLi tool did, #264)"""
    h = bytearray(head)
    for off in range(32, 0x400, 32):
        e = fi.jl_dec(h[off:off + 32])
        if e[16:31] == b"isd_config.ini\0":
            break
    blk, size = int.from_bytes(e[4:8], "little"), int.from_bytes(e[8:12], "little")
    h[blk:blk + 16] = bytes([0x20]) * 16
    for i in range(16):
        h[blk + 16 + i] = h[blk + 15 - i] ^ (0x01 if key >> i & 1 else 0xF0)
    h[blk + 32:blk + 34] = (fi.crc16(h[blk:blk + 32]) ^ bad_crc).to_bytes(2, "little")
    e[2:4] = fi.crc16(h[blk:blk + size]).to_bytes(2, "little")
    e[0:2] = fi.crc16(e[2:32]).to_bytes(2, "little")
    h[off:off + 32] = fi.jl_dec(e)
    return bytes(h)


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

    def test_a_package_starting_with_lt_is_not_a_page(self):
        # an encrypted .fwsc starts with "<" (0x3C) about once in 256 builds (CI run 41178937616): still a package
        self.assertFalse(fi.is_page(b"<\xe1\xd7\x42\xa7\x6e\x75\xf8" + bytes(56)))
        self.assertTrue(fi.is_page(b"\n  <!doctype html><html>"))

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

    def test_a_rewritten_key_block_with_the_same_key_is_still_the_same_boot_code(self):
        v15 = head_of(V15)
        rk = rekey(v15, 0x980F)
        self.assertNotEqual(rk, v15)
        self.assertEqual(fi.head_is(v15, "v15"), "exact")
        self.assertEqual(fi.head_is(rk, "v15"), "rekeyed")
        self.assertIn("V15's, with its chip-key block written again", fi.head_text(rk))
        self.assertIsNone(fi.head_is(rekey(v15, 0x980F ^ 0x100), "v15"))       # another key
        self.assertIsNone(fi.head_is(rekey(v15, 0x980F, True), "v15"))         # its CRC broken
        other = bytearray(rk)
        other[0x1234] ^= 0x5A
        self.assertIsNone(fi.head_which(bytes(other)))
        self.sent = False
        with self.assertRaises(fi.InstallError):
            self.up.install(running("FM-1_712", rk), b"", "FM-1_015", target="v15", state=self.state)
        self.assertTrue(self.sent)                                              # sent: the firmware takes it too

    @unittest.skipUnless(os.environ.get("FM1_HEAD_FILES"), "FM1_HEAD_FILES not set")
    def test_issue_264s_boot_codes(self):
        """FM1_HEAD_FILES=a:b: boot codes (or flash backups) that must both count as Official Open's"""
        for p in os.environ["FM1_HEAD_FILES"].split(":"):
            self.assertEqual(fi.head_which(open(p, "rb").read()[:0x4000]), "open", p)

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


class Identities(unittest.TestCase):
    """#216: Matryoshka's identity has seven digits from 1.8 (FM-1_7MMmmpp), three before (FM-1_7XY); both are read"""
    def test_both_forms(self):
        self.assertEqual(fi.matryoshka_version("FM-1_7010800"), (1, 8, 0))
        self.assertEqual(fi.matryoshka_version("FM-1_7011203"), (1, 12, 3))
        self.assertEqual(fi.matryoshka_version("FM-1_7100000"), (10, 0, 0))
        self.assertEqual(fi.matryoshka_version("FM-1_717"), (1, 7, None))
        self.assertEqual(fi.matryoshka_version("FM-1_7000000"), "dev")
        self.assertEqual(fi.matryoshka_version("FM-1_700"), "dev")
        self.assertEqual(fi.describe("FM-1_7010800"), "Matryoshka 1.8.0")
        self.assertEqual(fi.describe("FM-1_714"), "Matryoshka 1.4")
        self.assertEqual(fi.describe("FM-1_7000000"), "Matryoshka, a dev or CI build")

    def test_others_are_not_matryoshka(self):
        for other in ("FM-1_015", "FM-1_912", "FM-1_900", "FM-1_8000014", "FM-1_800", "ota-FM-1_700", "FM-1_70108", "FM-1_7"):
            self.assertIsNone(fi.matryoshka_version(other), other)
            self.assertEqual(fi.describe(other), "")

    def test_loaders_unchanged(self):
        self.assertTrue(fi.loader_fits("ota-FM-1_700", "FM-1_7010800"))
        self.assertTrue(fi.loader_fits("ota-FM-1_700", "FM-1_7000000"))
        self.assertFalse(fi.loader_fits("ota-FM-1_015", "FM-1_7010800"))

    def test_the_handshake_reads_seven_digits(self):
        body = bytes([0x00, 0x59, 0x11, 27, 0, 0]) + b"FM-1_7010800".ljust(27, b"\0")
        pkt = b"\xF0" + fi.pack7(body + bytes([~sum(body[6:]) & 0xFF])) + b"\xF7"
        self.assertEqual(fi.parse_identity(pkt).text, "FM-1_7010800")


class BuildIdentity(unittest.TestCase):
    """tools/build.py --release X.Y.Z: the identity FM-1_7MMmmpp (#216), checked against the marker and the handshake"""
    def test_release_identity(self):
        import build
        self.assertEqual(build.release_identity("1.8.0"), ("FM-1_7010800", "v1.8.0", (1, 8, 0)))
        self.assertEqual(build.release_identity("10.12.99-rc1"), ("FM-1_7101299", "v10.12.99-RC1", (10, 12, 99)))
        self.assertEqual(build.PRODUCT, "FM-1_7000000")
        for bad in ("1.8", "1.8.0.1", "100.0.0", "0.0.0", "1.x.0"):
            with self.assertRaises(SystemExit, msg=bad):
                build.release_identity(bad)
        with self.assertRaises(SystemExit):
            build.check_identity("FM-1_7" + "0" * 20)


# ---- #698: two FM-1s with the same port name, told apart by USB location (a stand-in CoreMIDI and python-rtmidi)

def identity_packet(text):
    body = bytes([0x00, 0x59, 0x11, 27, 0, 0]) + text.encode().ljust(27, b"\0")
    return b"\xF0" + fi.pack7(body + bytes([~sum(body[6:]) & 0xFF])) + b"\xF7"


def preset_data(values):
    key = fm1_usb.RIG_STRUCTURE.to_bytes(4, "little") + fm1_usb.RIG_PRESET.encode().ljust(16, b"\0")
    if values is None:
        return fm1_usb.frame(fm1_usb.R_PRESET_DATA, key + b"\xFF")
    return fm1_usb.frame(fm1_usb.R_PRESET_DATA, key + bytes([len(values)]) +
                         b"".join(int(v * 65536).to_bytes(4, "little", signed=True) for v in values))


class Usb:
    """FM-1s on USB: each {location, name, identity, mark} has one source and one destination, in this order; the
    CoreMIDI and rtmidi stand-ins read the same list"""

    def __init__(self, devices):
        self.devices = devices
        self.listening = {}     # source index -> callback
        self.sent = []          # (location, packet)

    def endpoints(self, kind):
        return [{"name": d["name"], "device": d["name"], "uid": hash((kind, d["location"], d["name"])) & 0x7FFFFFFF,
                 "location": d["location"], "offline": False} for d in self.devices]

    def answer(self, i, pkt):
        d = self.devices[i]
        self.sent.append((d["location"], bytes(pkt)))
        out = []
        if bytes(pkt) == fi.HS_QUERY:
            out.append(identity_packet(d["identity"]))
        elif bytes(pkt[:5]) == b"\xF0" + fm1_usb.PREFIX + bytes([fm1_usb.C_PRESET_GET]) and not d["identity"].startswith("ota-"):
            out.append(preset_data(d["mark"]))
        cb = self.listening.get(i)
        for o in out:
            if cb:
                cb((list(o), 0.0), None)

    def rtmidi(self):
        usb = self

        class Port:
            def __init__(self):
                self.i = None

            def get_ports(self):
                return [d["name"] for d in usb.devices]

            def open_port(self, i):
                self.i = i

            def close_port(self):
                usb.listening.pop(self.i, None)

            def delete(self):
                pass

        class MidiIn(Port):
            def ignore_types(self, **k):
                pass

            def set_callback(self, cb):
                usb.listening[self.i] = cb

        class MidiOut(Port):
            def send_message(self, msg):
                usb.answer(self.i, msg)

        return type("rtmidi", (), {"MidiIn": MidiIn, "MidiOut": MidiOut})


OWNER, RIG = 0x01100000, 0x01130000
MARK = [26492, 12530, 1078, 17828]


class RigPin(unittest.TestCase):
    def setUp(self):
        self.old = dict(fi.DELAY)
        fi.DELAY.update(hs=0.05)
        self.rig_file = os.path.join(tempfile.mkdtemp(), "rig.json")
        with open(self.rig_file, "w") as f:
            json.dump({"values": MARK, "usbLocation": "0x01130000"}, f)
        self.old_rig, fi.RIG_FILE = fi.RIG_FILE, self.rig_file
        self.installed = []
        self.old_install = fi.Updater.install
        fi.Updater.install = lambda up, dev, image, product, *a, **k: self.installed.append((up.backend.location, dev.id.text))
        self.old_read = fm1_usb.read_mark
        fm1_usb.read_mark = lambda link: self.old_read(link, tries=1, wait=0.05)

    def tearDown(self):
        fi.DELAY.update(self.old)
        fi.RIG_FILE = self.old_rig
        fi.Updater.install = self.old_install
        fm1_usb.read_mark = self.old_read

    def usb(self, *devices):
        return Usb([{"location": loc, "name": "Matryoshka", "identity": ident, "mark": mark} for loc, ident, mark in devices])

    def backend(self, usb, location=RIG):
        return fm1_usb.LocatedBackend(location, cm=usb, rtmidi=usb.rtmidi(), delay=0)

    def run_rig(self, usb, *extra):
        import io
        buf = io.StringIO()
        code = fi.main([OURS, "--rig", "--yes", *extra], backend=self.backend(usb), out=buf)
        return code, buf.getvalue()

    def test_only_the_ports_at_the_location_are_seen(self):
        usb = self.usb((OWNER, "FM-1_7011000", None), (RIG, "FM-1_7000000", MARK))
        be = self.backend(usb)
        self.assertEqual(be.input_names(), ["Matryoshka"])
        link = be.open("Matryoshka", "Matryoshka")
        link.send(fi.HS_QUERY)
        self.assertEqual(usb.sent, [(RIG, fi.HS_QUERY)])
        self.assertEqual(fi.parse_identity(link.read(0.1)).text, "FM-1_7000000")
        self.assertEqual(self.backend(usb, 0x01200000).input_names(), [])

    def test_the_rig_beside_the_owners_fm1(self):
        """the owner's FM-1 comes first in CoreMIDI's order with the same name: nothing reaches it"""
        usb = self.usb((OWNER, "FM-1_7011000", None), (RIG, "FM-1_7000000", MARK))
        code, out = self.run_rig(usb)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.installed, [(RIG, "FM-1_7000000")])
        self.assertFalse([p for loc, p in usb.sent if loc != RIG])
        self.assertIn("its mark reads back at USB location 0x01130000", out)

    def test_another_fm1_in_the_rigs_socket_is_refused(self):
        for mark in (None, [1, 2, 3, 4]):
            self.installed = []
            usb = self.usb((OWNER, "FM-1_7011000", MARK), (RIG, "FM-1_7011000", mark))
            self.assertEqual(self.run_rig(usb)[0], 9, mark)
            self.assertEqual(self.installed, [])

    def test_a_rig_in_update_mode_is_left_for_a_person(self):
        usb = self.usb((RIG, "ota-FM-1_700", None))
        self.assertEqual(self.run_rig(usb)[0], 9)
        self.assertEqual(self.installed, [])

    def test_nothing_at_the_location(self):
        usb = self.usb((OWNER, "FM-1_7011000", MARK))
        self.assertEqual(self.run_rig(usb)[0], 3)
        self.assertFalse(usb.sent)

    def test_without_a_recorded_location_it_refuses(self):
        with open(self.rig_file, "w") as f:
            json.dump({"values": MARK}, f)
        usb = self.usb((RIG, "FM-1_7000000", MARK))
        self.assertEqual(self.run_rig(usb)[0], 2)
        self.assertFalse(usb.sent)

    def test_ports_that_change_during_the_open_are_refused(self):
        usb = self.usb((OWNER, "FM-1_7011000", None), (RIG, "FM-1_7000000", MARK))
        be = self.backend(usb)
        real = usb.endpoints
        calls = []

        def shifting(kind):
            calls.append(kind)
            return real(kind) if len(calls) < 2 else list(reversed(real(kind)))
        usb.endpoints = shifting
        with self.assertRaises(OSError):
            be.open("Matryoshka", "Matryoshka")

    def test_mark_frames(self):
        self.assertEqual(fm1_usb.parse_preset_data(preset_data(MARK)), MARK)
        self.assertEqual(fm1_usb.parse_preset_data(preset_data(None)), [])
        self.assertIsNone(fm1_usb.parse_preset_data(identity_packet("FM-1_7000000")))
        self.assertEqual(fm1_usb.parse_location("1130000"), RIG)
        self.assertEqual(fm1_usb.location_text(RIG), "0x01130000")


if __name__ == "__main__":
    unittest.main()
