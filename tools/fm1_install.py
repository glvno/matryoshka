#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
"""Install a Felucca package (.fwsc) on an FM-1 over USB-MIDI.

The same update as the web installer (web/fm1ota.js): step 1, the
running firmware reads parts of the package and starts the update loader;
step 2, the loader reads the whole package and writes it. In both steps the
device asks (SysEx read requests on the logical image) and we answer. Then
the FM-1 restarts and the installed identity is checked.

  fm1_install.py PACKAGE.fwsc [--port NAME] [--yes] [--force]
  fm1_install.py FM-1.fwsc            (the official V15 file: back to the stock firmware)
  fm1_install.py FM1-Open-V14-Workbench.html   (M-VAVE Official Open, from its Workbench page or its .fwsc:
                                      for an FM-1 set up by Official Open, #183; not shipped with Matryoshka:
                                      it includes M-VAVE's own sound engine, which is not open source, so
                                      download it from https://github.com/m-vave/fm1_open/releases)
  fm1_install.py --info [--port NAME] [--save-head FILE]
                                      (--info also names the FM-1's boot code: V15's, Official Open's or another;
                                      --save-head writes it, flash 0x0000-0x3FFF, to FILE; Matryoshka 1.3 and later)

If the FM-1 is still in update mode (an earlier install was cut off), the
install finishes the write, when that loader may write this package. Needs mido with python-rtmidi.

Exit codes: 0 done, 1 cancelled or other error, 2 bad arguments or package,
3 FM-1 not found, 4 connection lost or the device stopped, 5 timeout (no
loader / no restart), 6 wrong model, or another identity after the install,
7 the FM-1 waits in an update loader that must not write this package (an
M-VAVE loader only gets M-VAVE's packages, and only the one it was writing; a
Felucca-type one everything else), 8 the FM-1's boot code is not the one in this M-VAVE package (nothing was sent).

M-VAVE's loader also writes the small piece of software at the start of the FM-1's memory
that starts it when switched on (its boot code, flash 0x0000-0x3FFF), from its package, and
V15 and Official Open carry different ones. The running firmware refuses a package whose one
differs ("update failed -5"), so it is never replaced by another. Matryoshka 1.7 and later also let the
tool read the boot code (#264), so such a package is refused before anything is sent, with which boot code
the FM-1 has. Which package an install was
writing is kept in ~/.config/matryoshka/fm1-mvave-target until the FM-1 is back, so a cut-off
install is finished only with the same package (--sure: you know which one it was).
"""
import argparse
import base64
import hashlib
import os
import queue
import re
import sys
import time

HS_QUERY = bytes([0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7])
UPGRADE = bytes([0xF0, 0x22, 0x24, 0x35, 0x7F, 0xF7])
HEAD_LEN, HEAD_PIECE = 0x4000, 64           # the boot code, read 64 bytes at a time (ota.c ota_reply_head, #264)
FINISH_CHECK, FINISH_WRITE = 0xE0000000, 0xF0000000
SUCCESS = b"success\0"
MAXDATA = 512
BLOCKS, BLK, KEEP = 20, 0x30, 0x2F
LOADER_MARK = b"FELUCCA-LOADER-1"
# the unmodified official FM-1 V15 (FM-1.fwsc from M-VAVE): returning to it is allowed without --force,
# as the web installer's "Return to official V15" (web/fm1pkg.js validateStockPackage)
STOCK_V15_SHA256 = "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a"
# M-VAVE Official Open (#183, as web/src/flasher/fm1pkg.js validateOpenPackage): the user's own file, never bundled
OPEN_PRODUCT_RE = re.compile(r"FM-1_8\d{6}")
MVAVE_LOADER_SHA256 = "ef1f2db89b011fa53e71df363f0122de0ea896618c53fb53e8da676322004541"
OPEN_HEAD_SHA256 = "2981ccf8d12a132c82d8b5e959c2d27d62f13bc51419225cacc87a6e82d58171"
V15_HEAD_SHA256 = "d9f43191777656de01c7bed4f9e9ba2e34e94832c5d2ed02c3fc7ab7a6d9bd67"
FL_LEN = 0x93000
OPEN_RELEASES = "https://github.com/m-vave/fm1_open/releases"
TARGET_FILE = os.path.join(os.path.expanduser("~"), ".config", "matryoshka", "fm1-mvave-target")
PORT_RE = re.compile(r"fm-1|felucca|matryoshka|modular|ota|composite|sinco|usb-midi", re.I)   # never probe other gear

# seconds; the tests shorten them
DELAY = {"open": 0.3, "start": 2.0, "reply": 0.01, "loader": 3.0, "reboot": 3.0, "retry": 1.0,
         "poll": 1.0, "hs": 1.0, "idle_check": 8.0, "idle_write": 180.0,
         "wait_loader": 30.0, "wait_reboot": 40.0, "settle": 0.6, "head": 1.0}

EXIT = {"usage": 2, "badpkg": 2, "notfound": 3, "model": 6, "lost": 4, "stopped": 4, "badreq": 4,
        "phase": 4, "noloader": 5, "noreturn": 5, "mismatch": 6, "otherloader": 7, "wrongtarget": 7, "whichtarget": 7,
        "bootcode": 8}


class InstallError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


# ------------------------------------------------------------ wire format ---

def pack7(data):
    out, acc, nb = [], 0, 0
    for b in data:
        acc |= b << nb
        nb += 8
        while nb >= 7:
            out.append(acc & 0x7F)
            acc >>= 7
            nb -= 7
    if nb:
        out.append(acc & 0x7F)
    return bytes(out)


def unpack7(s):
    out, acc, nb = [], 0, 0
    for b in s:
        acc |= (b & 0x7F) << nb
        nb += 7
        while nb >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nb -= 8
    return bytes(out)


def response(addr, data, fl=0):
    n = len(data)
    body = bytearray([0x00, 0x59, 0x30, (n + 8) & 0xFF, ((n + 8) >> 8) & 0xFF, 0, fl])
    body += addr.to_bytes(4, "little") + bytes([n & 0xFF, (n >> 8) & 0xFF, 0]) + bytes(data)
    body.append(~sum(body[6:]) & 0xFF)
    return b"\xF0" + pack7(body) + b"\xF7"


def parse_request(pkt):
    """-> (flags, addr, len) or None"""
    if len(pkt) < 2 or pkt[0] != 0xF0 or pkt[-1] != 0xF7:
        return None
    u = unpack7(pkt[1:-1])
    if len(u) != 15 or u[:3] != b"\x00\x59\x30" or ~sum(u[6:14]) & 0xFF != u[14]:
        return None
    return u[6], int.from_bytes(u[7:11], "little"), int.from_bytes(u[11:14], "little")


class Identity:
    def __init__(self, text, model, version):
        self.text, self.model, self.version = text, model, version

    @property
    def loader(self):
        return self.model.lower().startswith("ota-")


def printable(b):
    """bytes from the device as text for the terminal: printable ASCII only (no escape sequences)"""
    return "".join(chr(c) if 32 <= c < 127 else "?" for c in b)


def parse_identity(pkt):
    if len(pkt) < 2 or pkt[0] != 0xF0 or pkt[-1] != 0xF7:
        return None
    d = unpack7(pkt[1:-1])
    if len(d) != 34 or d[:3] != b"\x00\x59\x11":
        return None
    txt = printable(d[6:33].rstrip(b"\0"))
    m = re.fullmatch(r"([^_]+)_(\d+)", txt)
    return Identity(txt, m[1], int(m[2])) if m else None


def head_request(off):
    body = bytearray([0x00, 0x59, 0x12, 2, 0, 0, off & 0xFF, off >> 8])
    body.append(~sum(body[6:]) & 0xFF)
    return b"\xF0" + pack7(body) + b"\xF7"


def parse_head_piece(pkt):
    """-> (offset, 64 bytes) or None"""
    if len(pkt) < 2 or pkt[0] != 0xF0 or pkt[-1] != 0xF7:
        return None
    d = unpack7(pkt[1:-1])
    if len(d) < 73 or d[:6] != bytes([0x00, 0x59, 0x12, 66, 0, 0]) or ~sum(d[6:72]) & 0xFF != d[72]:
        return None
    return int.from_bytes(d[6:8], "little"), d[8:72]


def read_head(link, tries=2):
    """the FM-1's boot code (flash 0x0000-0x3FFF), or None when its firmware does not answer (before Matryoshka 1.3,
    Felucca, Sloop, stock; the update loaders)"""
    link.drain()
    out = bytearray()
    for off in range(0, HEAD_LEN, HEAD_PIECE):
        for _ in range(tries):
            if not link.send(head_request(off)):
                return None
            end, got = time.monotonic() + DELAY["head"], None
            while got is None and (left := end - time.monotonic()) > 0:
                p = link.read(left)
                if p is None:
                    break
                r = parse_head_piece(p)
                if r and r[0] == off:
                    got = r[1]
            if got is not None:
                break
        if got is None:
            return None
        out += got
    return bytes(out)


# #264: a JieLi tool may write the boot code's chip-key block again, other bytes for the same key. As ota.c ota_stage,
# a boot code is still V15's / Official Open's when it is apart from that block and its entry's two CRCs, and the block
# holds the same key: SHA-256 with those bytes zeroed, and the key (0x980F in both)
HEADS = {"v15": (V15_HEAD_SHA256, "fc767f6fcc5dbd69adbc4a5bc7b8d56d68516bb7d5b1a3a84d615140b2c481a0", 0x980F),
         "open": (OPEN_HEAD_SHA256, "70f51774cbc1ed1b8b41c272c5b8eebee49bf620e45543a86336fd090cf3b30c", 0x980F)}
HEAD_NAMES = {"v15": "V15's", "open": "Official Open's"}


def chip_key(blob):
    """the chip key a 34-byte key block decodes to (ota.c ota_key_of), None if its CRC fails"""
    if crc16(blob[:32]) != int.from_bytes(blob[32:34], "little"):
        return None
    t = sum(blob[:16]) & 0xFF
    t = 0xAA if t >= 0xE0 else 0x55 if t <= 0x10 else t
    return sum(1 << i for i in range(16) if (blob[16 + i] ^ blob[15 - i]) < t)


def head_core(head):
    """(SHA-256 with the chip-key block and its entry's CRCs zeroed, the key), or None (as ota.c ota_key_area)"""
    for off in range(32, 0x400, 32):
        e = jl_dec(head[off:off + 32])
        if crc16(e[2:32]) != int.from_bytes(e[0:2], "little"):
            return None
        if e[16:31] == b"isd_config.ini\0":
            blk = int.from_bytes(e[4:8], "little")
            if not 0x400 <= blk <= len(head) - 34:
                return None
            x = bytearray(head)
            x[off:off + 4] = bytes(4)
            x[blk:blk + 34] = bytes(34)
            return hashlib.sha256(x).hexdigest(), chip_key(head[blk:blk + 34])
        if int.from_bytes(e[14:16], "little"):
            return None
    return None


def head_is(head, which):
    """"exact" / "rekeyed" (the same apart from the chip-key block, same key) / None"""
    sha, core, key = HEADS[which]
    if hashlib.sha256(head).hexdigest() == sha:
        return "exact"
    return "rekeyed" if head_core(head) == (core, key) else None


def head_which(head):
    return next((w for w in HEADS if head_is(head, w)), None)


def head_text(head):
    """which boot code this is, for the terminal"""
    w = head_which(head)
    if w is None:
        return f"neither V15's nor Official Open's (SHA-256 {hashlib.sha256(head).hexdigest()})"
    if head_is(head, w) == "rekeyed":
        return HEAD_NAMES[w] + ", with its chip-key block written again in other bytes (the same key)"
    return HEAD_NAMES[w]


# --------------------------------------------------------------- package ---

def product_of(raw):
    """the package identity ("FM-1_906"): one marker byte after each of the first 20 blocks"""
    if len(raw) < BLOCKS * BLK:
        raise InstallError("badpkg", "not an FM-1 package (too short)")
    return "".join(chr((m - i - 1) & 0xFF) for i in range(BLOCKS) if (m := raw[i * BLK + KEEP]) != 0x7D)


def logical_image(raw):
    """the image the device reads during an update: the package without the 20 marker bytes"""
    out = bytearray()
    for i in range(BLOCKS):
        out += raw[i * BLK:i * BLK + KEEP]
    return bytes(out + raw[BLOCKS * BLK:])


def model_of(text):
    return text.split("_")[0].removeprefix("ota-")


STOCK_PRODUCT = "FM-1_015"


def is_mvave(product):
    """M-VAVE's own packages: the official V15 and Official Open, written by M-VAVE's loader"""
    return product == STOCK_PRODUCT or OPEN_PRODUCT_RE.fullmatch(product) is not None


def loader_fits(loader, product):
    """may this waiting loader finish a write of this package? (as web/src/flasher/fm1ota.js loaderFits)
    M-VAVE's loader (ota-FM-1_015) writes the flash head from the package: only M-VAVE's packages (V15, Official Open).
    Felucca-lineage loaders (ota-FM-1_7XX ours since #79, _8XX ours before, _9XY Felucca; three digits; ours reports ota-FM-1_700 for release
    builds too) never write the head: every other package. Unknown loaders: nothing."""
    if is_mvave(product):
        return loader == "ota-" + STOCK_PRODUCT
    return re.fullmatch(r"ota-FM-1_[789]\d\d", loader) is not None


def boot_mismatch(addrs):
    """#183 (as fm1ota.js bootMismatch): before staging M-VAVE's loader, which rewrites the flash head from the
    package, the running firmware (ota.c ota_stage) compares the package's head with its own and stops answering
    when they differ ("update failed -5" on its screen, nothing erased). No code reaches the host: it sees the entry
    list (0, 512), the loader's header, head reads below it, then silence."""
    return len(addrs) >= 4 and addrs[0] == 0 and addrs[1] == 512 and addrs[-1] < addrs[2]


STARTUP = "the small piece of software at the start of its memory that starts the FM-1 (its boot code)"
MVAVE_WORKBENCH = "https://open.m-vave.com/fm1-workbench"
ROM_BOOT = ("As a last resort: put the FM-1 in the chip's own repair mode (from Matryoshka, the SysEx F0 22 24 35 7D F7) "
            "and write V15's firmware part (0x4000-0x92FFF) with MvaveFM1Unbricker; that leaves the start-up part as "
            "it is. Details: https://github.com/glvno/matryoshka/issues/183")
ISSUES = "https://github.com/glvno/matryoshka/issues"
# #264: the ways on, by the boot code the FM-1 has; a package of M-VAVE's is written only over its own boot code
WAY_OPEN_HEAD = (f"Two safe ways on: keep Matryoshka, or put Official Open back (M-VAVE's Workbench page or .fwsc from "
                 f"{OPEN_RELEASES}) and, if you then want V15, use M-VAVE's own Workbench ({MVAVE_WORKBENCH}) while it "
                 f"runs Official Open. {ROM_BOOT}")
WAY_V15_HEAD = "Return to the official V15 (FM-1.fwsc) instead."
WAY_OTHER_HEAD = ("Neither M-VAVE package can be installed over it. Keep Matryoshka, save the boot code with "
                  f"\"fm1_install.py --info --save-head boot.bin\" and attach it to an issue at {ISSUES}.")


def boot_refusal(product, head=None):
    """the message for an M-VAVE package whose boot code is not the FM-1's: head = the FM-1's, when it could be read"""
    name = "the official V15" if product == STOCK_PRODUCT else "Official Open"
    if head is None:     # refused by the running firmware: which boot code it has is not known here
        return (f"nothing was changed: the FM-1 refused {name} (its screen says \"update failed -5\"), because "
                f"{STARTUP} is not the one in this package. Which one it has could not be read: install the current "
                "Matryoshka, then run \"fm1_install.py --info\" to see it.")
    w = head_which(head)
    way = WAY_OPEN_HEAD if w == "open" else WAY_V15_HEAD if w == "v15" else WAY_OTHER_HEAD
    return (f"nothing was sent: {STARTUP} is {head_text(head)}, and {name} carries a different one, so the FM-1 "
            f"would refuse it (\"update failed -5\"). {way}")


# ------------------------------------------------- which M-VAVE package ---

POWER_CUT = ("if the power is cut while that part is being replaced, the FM-1 will most likely not start any more "
             "until it is repaired in the chip's own repair mode")
WRONG_TARGET = ("the FM-1 waits in M-VAVE's update loader from an unfinished install of {was}; nothing was sent. "
                "Finish it with {was}. The other package would also replace " + STARTUP + ", and " + POWER_CUT)
WHICH_TARGET = ("the FM-1 waits in M-VAVE's update loader from an unfinished install, and it is not recorded whether "
                "that was the official V15 or Official Open; nothing was sent. Run the same command again with --sure "
                "if this is the package that was cut off. The loader takes the other one too, but then also replaces "
                + STARTUP + ", and " + POWER_CUT)
TARGET_NAMES = {"v15": "the official V15", "open": "Official Open"}


def remembered_target(path=None):
    try:
        with open(path or TARGET_FILE) as f:
            v = f.read().strip()
        return v if v in TARGET_NAMES else None
    except OSError:
        return None


def remember_target(target, path=None):
    """target None forgets it (the install finished)"""
    path = path or TARGET_FILE
    try:
        if target:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(target + "\n")
        elif os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# ------------------------------------------------------------------ MIDI ---

class MidoLink:
    """one MIDI in/out pair with a SysEx queue"""

    def __init__(self, backend, in_name, out_name):
        import mido
        self.backend, self.name, self.mido = backend, in_name, mido
        self.q = queue.Queue()
        self.inp = mido.open_input(in_name, callback=self._rx)
        try:
            self.out = mido.open_output(out_name)
        except Exception:
            self.inp.close()
            raise
        time.sleep(DELAY["open"])   # CoreMIDI may drop a message sent just after opening

    def _rx(self, msg):
        if msg.type == "sysex":
            self.q.put(bytes([0xF0, *msg.data, 0xF7]))

    @property
    def lost(self):
        return self.name not in self.backend.input_names()

    def send(self, pkt):
        try:
            self.out.send(self.mido.Message("sysex", data=pkt[1:-1]))
            return True
        except Exception:
            return False

    def read(self, timeout):
        try:
            return self.q.get(timeout=max(timeout, 0))
        except queue.Empty:
            return None

    def drain(self):
        while not self.q.empty():
            self.q.get_nowait()

    def close(self):
        for p in (self.inp, self.out):
            try:
                p.close()
            except Exception:
                pass


class MidoBackend:
    def __init__(self):
        import mido
        self.mido = mido

    def input_names(self):
        return list(dict.fromkeys(self.mido.get_input_names()))

    def output_names(self):
        return list(dict.fromkeys(self.mido.get_output_names()))

    def open(self, in_name, out_name):
        return MidoLink(self, in_name, out_name)


def pair_output(name, outs):
    if name in outs:
        return name
    base = re.sub(r"\s+\d+$", "", name)     # Windows numbers each port
    same = [o for o in outs if re.sub(r"\s+\d+$", "", o) == base]
    if len(same) == 1:
        return same[0]
    return outs[0] if len(outs) == 1 else None


# --------------------------------------------------------------- updater ---

class Device:
    def __init__(self, link, ident, name):
        self.link, self.id, self.name = link, ident, name


def handshake(link, tries=3):
    link.drain()
    for _ in range(tries):
        if not link.send(HS_QUERY):
            return None
        end = time.monotonic() + DELAY["hs"]
        while (left := end - time.monotonic()) > 0:
            p = link.read(left)
            if p is None:
                break
            ident = parse_identity(p)
            if ident:
                return ident
    return None


class Updater:
    def __init__(self, backend, port=None):
        self.backend = backend
        self.port = port

    def candidates(self, only_port):
        names = self.backend.input_names()
        if self.port:
            mine = [n for n in names if self.port.lower() in n.lower()]
            if only_port:
                return mine
            return mine + [n for n in names if n not in mine and PORT_RE.search(n)]
        return [n for n in names if PORT_RE.search(n)]

    def find(self, want=None, only_port=True):
        """the first matching port that answers the handshake (and want(identity))"""
        outs = self.backend.output_names()
        for name in self.candidates(only_port):
            out = pair_output(name, outs)
            if not out:
                continue
            try:
                link = self.backend.open(name, out)
            except Exception:
                continue
            ident = handshake(link, 2)
            if ident and (want is None or want(ident)):
                return Device(link, ident, name)
            link.close()
        return None

    def wait_for(self, want, secs):
        end = time.monotonic() + secs
        while time.monotonic() < end:
            dev = self.find(want, only_port=False)
            if dev:
                return dev
            time.sleep(DELAY["retry"])
        return None

    def serve(self, link, image, finish, idle, progress):
        """answer read requests until the device asks for `finish`; -> (served, finished, lost)"""
        served, last = 0, time.monotonic()
        self.addrs = []
        while True:
            pkt = link.read(DELAY["poll"])
            if pkt is None:
                if link.lost:
                    return served, False, True
                if time.monotonic() - last > idle:
                    return served, False, False
                continue
            r = parse_request(pkt)
            if not r:
                continue
            fl, addr, n = r
            last = time.monotonic()
            if n == 0 or n > MAXDATA:
                raise InstallError("badreq", f"the device asked for {addr:#x}+{n}: bad length")
            if addr in (FINISH_CHECK, FINISH_WRITE):
                # as M-VAVE's WebUpdate.js: only this phase's finish address, 8 bytes, then answer repeats for a while
                if addr != finish or n != len(SUCCESS):
                    raise InstallError("phase", f"the device asked for the finish address {addr:#x}+{n} "
                                       f"in the {'check' if finish == FINISH_CHECK else 'write'} step")
                link.send(response(addr, SUCCESS, fl))
                self.settle(link, finish)
                return served, True, False
            if addr + n > len(image):
                raise InstallError("badreq", f"the device asked for {addr:#x}+{n}, outside the package")
            time.sleep(DELAY["reply"])
            if not link.send(response(addr, image[addr:addr + n], fl)):
                return served, False, True
            served += 1
            self.addrs.append(addr)
            progress(served, addr + n)

    def settle(self, link, finish):
        """the answer may still be queued and the device may ask again: answer the same finish request only"""
        end = time.monotonic() + DELAY["settle"]
        while time.monotonic() < end and not link.lost:
            pkt = link.read(min(0.1, end - time.monotonic()))
            r = pkt and parse_request(pkt)
            if r and r[1] == finish and r[2] == len(SUCCESS):
                link.send(response(finish, SUCCESS, r[0]))

    def check(self, dev, image, step):
        """step 1: the running firmware checks the package and starts the loader"""
        step("start", dev.id.text)
        dev.link.send(UPGRADE)
        time.sleep(DELAY["start"])
        served, finished, lost = self.serve(dev.link, image, FINISH_CHECK, DELAY["idle_check"],
                                            lambda k, end: step("check", k))
        dev.link.close()
        if not finished and not lost and is_mvave(self.product) and boot_mismatch(self.addrs):
            raise InstallError("stopped", boot_refusal(self.product))
        if not finished:
            raise InstallError("lost" if lost else "stopped",
                               f"the FM-1 {'was disconnected' if lost else 'stopped answering'} after "
                               f"{served} requests; nothing was written")
        step("loader")
        time.sleep(DELAY["loader"])
        ota = self.wait_for(lambda i: i.loader, DELAY["wait_loader"])
        if not ota:
            raise InstallError("noloader", "the update loader did not appear. Replug the USB cable and "
                                           "run the install again: the FM-1 stays in update mode until it is done")
        return ota

    def write(self, ota, image, step):
        """step 2: the loader reads and writes the whole package, then restarts"""
        step("write", 0)
        ota.link.send(UPGRADE)
        time.sleep(DELAY["start"])
        served, finished, lost = self.serve(ota.link, image, FINISH_WRITE, DELAY["idle_write"],
                                            lambda k, end: step("write", min(99, end * 100 // len(image))))
        ota.link.close()
        if not finished:
            raise InstallError("lost" if lost else "stopped",
                               f"the loader {'was disconnected' if lost else 'stopped answering'} after "
                               f"{served} requests. Replug the USB cable and run the install again to finish")
        step("write", 100)

    def verify(self, product, step):
        step("reboot")
        time.sleep(DELAY["reboot"])
        back = self.wait_for(lambda i: not i.loader, DELAY["wait_reboot"])
        if not back:
            raise InstallError("noreturn", "the FM-1 did not come back: power-cycle it")
        back.link.close()
        if back.id.text != product:
            raise InstallError("mismatch", f"written, but the FM-1 reports {back.id.text} (expected {product})")
        step("done", back.id.text)
        return back.id.text

    def install(self, dev, image, product, step=lambda *a: None, target=None, sure=False, state=None):
        """running firmware -> loader -> new firmware; dev from find(). A device already in
        update mode only needs the write. target: "v15" / "open" for M-VAVE's packages (kept in `state` until
        the FM-1 is back, so a cut-off install is finished only with the same one)."""
        self.product = product
        if model_of(dev.id.text) != model_of(product):
            dev.link.close()
            raise InstallError("model", f"the device is {dev.id.text}, the package is for {product}")
        if dev.id.loader and not loader_fits(dev.id.text, product):
            dev.link.close()
            hint = ("finish it with the official V15 (FM-1.fwsc)" if dev.id.text == "ota-" + STOCK_PRODUCT else
                    "finish it with the Felucca / Matryoshka package that was being installed"
                    if re.fullmatch(r"ota-FM-1_[789]\d\d", dev.id.text) else "finish it with the tool that started it")
            raise InstallError("otherloader", f"the FM-1 waits in the update loader {dev.id.text} from an unfinished "
                                              f"update, which must not be given {product}: nothing was sent; {hint}")
        if target and dev.id.loader and dev.id.text == "ota-" + STOCK_PRODUCT:
            was = remembered_target(state)
            if was and was != target:
                dev.link.close()
                raise InstallError("wrongtarget", WRONG_TARGET.format(was=TARGET_NAMES[was]))
            if not was and not sure:
                dev.link.close()
                raise InstallError("whichtarget", WHICH_TARGET)
        if target and not dev.id.loader:      # #264: the FM-1's boot code against the package's, before anything is sent
            head = read_head(dev.link)
            if head is not None and not head_is(head, target):
                dev.link.close()
                raise InstallError("bootcode", boot_refusal(product, head))
        if target:
            remember_target(target, state)
        ota = dev if dev.id.loader else self.check(dev, image, step)
        self.write(ota, image, step)
        back = self.verify(product, step)
        if target:
            remember_target(None, state)
        return back


# ------------------------------------------------------------------- CLI ---

def crc16(d, c=0):
    for b in d:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) if c & 0x8000 else c << 1
        c &= 0xFFFF
    return c


def jl_dec(b):
    b, k = bytearray(b), 0xFFFF
    for i in range(len(b)):
        b[i] ^= k & 0xFF
        k = ((k << 1) ^ (0x1021 if k & 0x8000 else 0)) & 0xFFFF
    return b


def open_problem(raw):
    """what is wrong with this as M-VAVE Official Open, or None (as fm1pkg.js validateOpenPackage)"""
    if len(raw) < 2048:
        return "it is not an FM-1 package"
    product = product_of(raw)
    if not OPEN_PRODUCT_RE.fullmatch(product):
        return f"its identity is {product}, not M-VAVE Official Open's (FM-1_8xxxxxx)"
    im = logical_image(raw)
    h = jl_dec(im[:0x40])
    n = int.from_bytes(h[8:10], "little")
    if crc16(h[2:0x40]) != int.from_bytes(h[0:2], "little") or not 0 < n <= 11 or \
            crc16(im[0x40:0x40 + n * 0x50]) != int.from_bytes(h[2:4], "little"):
        return "its header does not check out"
    flash = loader = None
    for i in range(n):
        e = jl_dec(im[0x40 + i * 0x50:0x90 + i * 0x50])
        typ, off, size = int.from_bytes(e[0:2], "little"), int.from_bytes(e[8:12], "little"), int.from_bytes(e[12:16], "little")
        if typ == 0:
            flash = (off, size, int.from_bytes(e[4:6], "little"))
        if typ == 100:
            loader = im[off:off + size]
    if not flash or crc16(im[flash[0]:flash[0] + flash[1]]) != flash[2]:
        return "its firmware image does not check out"
    if not loader or hashlib.sha256(loader).hexdigest() != MVAVE_LOADER_SHA256:
        return "it does not carry M-VAVE's update loader"
    if not (0x4000 < flash[1] <= FL_LEN and flash[1] % 0x1000 == 0):
        return f"its firmware image ({flash[1]} bytes) does not fit the FM-1"
    head = hashlib.sha256(im[flash[0]:flash[0] + 0x4000]).hexdigest()
    if head != OPEN_HEAD_SHA256:
        return "its boot code is V15's, not Official Open's" if head == V15_HEAD_SHA256 else "its boot code is not Official Open's"
    return None


def workbench_packages(raw):
    """M-VAVE publishes Official Open inside its Workbench page as base64: the packages in it (a .fwsc: itself)"""
    if not raw[:64].lstrip().startswith(b"<"):
        return [raw]
    out = []
    for m in re.finditer(rb'"data":"([A-Za-z0-9+/=]{100000,})"', raw):
        try:
            out.append(base64.b64decode(m[1]))
        except ValueError:
            pass
    return out


def load_package(path, force):
    """-> (product, logical image, target): target "v15" / "open" for M-VAVE's packages, else None"""
    try:
        raw = open(path, "rb").read()
    except OSError as e:
        raise InstallError("badpkg", f"cannot read {path}: {e.strerror}")
    why = None
    for pkg in workbench_packages(raw):
        why = open_problem(pkg)
        if why is None:
            return product_of(pkg), logical_image(pkg), "open"
    if raw[:64].lstrip().startswith(b"<"):
        raise InstallError("badpkg", f"{path}: no M-VAVE Official Open in this page ({why or 'no packages'})")
    product = product_of(raw)
    if OPEN_PRODUCT_RE.fullmatch(product):
        raise InstallError("badpkg", f"{path}: not M-VAVE's Official Open as published: {why}")
    if not re.fullmatch(r"[^_]+_\d+", product):
        raise InstallError("badpkg", f"{path}: not an FM-1 package (identity {product!r})")
    official = hashlib.sha256(raw).hexdigest() == STOCK_V15_SHA256
    if LOADER_MARK not in raw and not official and not force:
        raise InstallError("badpkg", f"{path}: no Felucca update loader in this package; only Felucca's own "
                                     "packages, the unmodified official V15 (FM-1.fwsc) and M-VAVE Official Open "
                                     "are installed (--force overrides)")
    return product, logical_image(raw), "v15" if official else None


def not_found(up):
    names = up.backend.input_names()
    where = f"no MIDI port matching {up.port!r} answered" if up.port else "FM-1 not found"
    return InstallError("notfound", f"{where} (USB data cable? another app using it?)"
                        f"\n  MIDI inputs: {', '.join(names) if names else '(none)'}")


class Progress:
    def __init__(self, out):
        self.out, self.line = out, False

    def __call__(self, k, a=None):
        if k == "check":
            self.put(f"checking the package ({a} reads)")
        elif k == "write":
            self.put(f"writing {a:3d}%")
        else:
            self.end()
            msg = {"start": f"starting the update on {a}", "loader": "switching to update mode",
                   "reboot": "restarting", "done": f"done: the FM-1 runs {a}"}[k]
            print(msg, file=self.out, flush=True)

    def put(self, s):
        print(f"\r{s}\033[K", end="", file=self.out, flush=True)
        self.line = True

    def end(self):
        if self.line:
            print(file=self.out, flush=True)
            self.line = False


def run(a, backend, out, ask):
    up = Updater(backend, a.port)
    if a.info:
        dev = up.find()
        if not dev:
            raise not_found(up)
        mode = "update loader (update not finished)" if dev.id.loader else "running"
        print(f"{dev.id.text}  [{mode}]  port: {dev.name}", file=out)
        head = None if dev.id.loader else read_head(dev.link)
        dev.link.close()
        if head is None:
            print("boot code: not readable (needs Matryoshka 1.7 or later running)", file=out)
            if a.save_head:
                raise InstallError("usage", "the boot code could not be read, nothing was saved")
            return 0
        print(f"boot code: {head_text(head)}", file=out)
        if a.save_head:
            try:
                with open(a.save_head, "wb") as f:
                    f.write(head)
            except OSError as e:
                raise InstallError("usage", f"cannot write {a.save_head}: {e.strerror}")
            print(f"saved to {a.save_head} ({len(head)} bytes)", file=out)
        return 0
    product, image, target = load_package(a.package, a.force)
    print(f"package: {product}  ({a.package})", file=out)
    dev = up.find()
    if not dev:
        raise not_found(up)
    print(f"device:  {dev.id.text}  ({dev.name})" + ("  in update mode: the write will be finished" if dev.id.loader else ""),
          file=out)
    if not a.yes and not ask("Install? Do not unplug the FM-1 while writing. [y/N] "):
        dev.link.close()
        print("cancelled", file=out)
        return 1
    prog = Progress(out)
    try:
        up.install(dev, image, product, prog, target=target, sure=a.sure)
    finally:
        prog.end()
    return 0


def ask_tty(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def main(argv=None, backend=None, out=sys.stdout, ask=ask_tty):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("package", nargs="?", help="Felucca package (.fwsc)")
    ap.add_argument("--info", action="store_true", help="print the identity of the connected FM-1")
    ap.add_argument("--save-head", metavar="FILE", help="with --info: write the FM-1's boot code (0x0000-0x3FFF) to FILE")
    ap.add_argument("--port", metavar="NAME", help="MIDI port to use (part of its name)")
    ap.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    ap.add_argument("--force", action="store_true", help="install a package without the Felucca loader marker")
    ap.add_argument("--sure", action="store_true", help="finish a cut-off install in M-VAVE's loader with this package "
                                                        "although it is not recorded which one it was writing")
    a = ap.parse_args(argv)
    if bool(a.info) == bool(a.package):
        ap.error("give a PACKAGE.fwsc or --info")
    if a.save_head and not a.info:
        ap.error("--save-head goes with --info")
    try:
        if backend is None:
            try:
                backend = MidoBackend()
            except ImportError:
                raise InstallError("usage", "needs mido and python-rtmidi (pip install mido python-rtmidi)")
        return run(a, backend, out, ask)
    except InstallError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT.get(e.code, 1)
    except KeyboardInterrupt:
        print("\ninterrupted: if the FM-1 is in update mode, run the install again to finish", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
