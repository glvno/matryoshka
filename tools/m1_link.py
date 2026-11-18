#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 morgulbrut
"""Talk to the Matryoshka firmware over USB-MIDI SysEx (protocol: web/src/protocol.ts), without the browser.

  tools/m1_link.py info
  tools/m1_link.py upload PATCH.m1p       (binary patches: build/golden/*.m1p from tools/golden.sh)
  tools/m1_link.py store
  tools/m1_link.py bank                   (write the factory presets from firmware/src/presets.h into the flash bank)
  tools/m1_link.py bank-info              (list the bank slots on the FM-1)
  tools/m1_link.py bank-clear [--yes]     (empty the bank, after a confirmation: the next boot writes the factory patches again)
  tools/m1_link.py param MODULE PARAM VALUE     (module / parameter index, value as a float)
  tools/m1_link.py note 60 [seconds]
  tools/m1_link.py program N              (factory patch N, MIDI program change)
  tools/m1_link.py cpu                    (the audio ISR's load: now, and the peak since the last cpu read)
  tools/m1_link.py uac [SECONDS]          (the USB audio stream: state, glitch counters, rate adjustments, the ring's fill
                                           range; SECONDS: read again after that long and print the changes per second)
  tools/m1_link.py mem                    (#273: the boot's proof of .lowram and how deep each stack has gone since boot)
  tools/m1_link.py cores [inject | split on|off | stress on|off]   (#271: the second core: 2 CORES / 1 CORE, its self-tests; inject: one
                                           wrong job, which must fall back to one core until power-off; split off: core 0
                                           renders every part, core 1 stays up, for measuring; on again at boot; stress on:
                                           the self-test every 1 ms with its hand-off's race window widened, off at boot)
  tools/m1_link.py uitime [reset]         (the LCD's draw times: the last and the worst of each kind, in ms; reset zeroes them)
  tools/m1_link.py clock [SECONDS [BPM [run]]]   (#473: MIDI clock out, DIAG page 116: ticks sent and dropped; SECONDS:
                                           also time the ticks this computer receives, by CoreMIDI's timestamps, and print
                                           the mean period, the deviation of each period and of each tick from a straight
                                           grid, and the link's refused sends over that time, DIAG page 117; BPM: at that
                                           global tempo (TEMPO, set back after); run: with the transport running)
  tools/m1_link.py usblog [arm|wrap]      (#535: the USB setup log, DIAG pages 40..71 and 104..107: every control transfer a host started
                                           since boot (or since `arm`) and the firmware's answer, bus resets, suspends, the
                                           address taking effect; kept while the FM-1 stays powered, so a failed host's log
                                           can be read on another. arm: keep the next 64 entries (a one-shot capture), wrap:
                                           the newest again)
  tools/m1_link.py cpuclock               (#735, DIAG page 131: the CPU clock from the PLL's multiplier, the rails' levels and
                                           dependent adds a microsecond timed on the 24 MHz timer; reads only, writes nothing;
                                           then the stock supply setup at boot: its result, and the rails before it)
  tools/m1_link.py blocktime [SECONDS] [--notes N] [--patch NAME] [--json FILE]
                                          (#802, #803, DIAG pages 132..139: what an audio block's time is made of, over
                                           SECONDS (default 3): each part of the audio interrupt, the voices, TIMER5's
                                           interrupts, the second core's busy and idle time and its hand-offs, mean and
                                           most per block; --patch: a factory patch (firmware/src/presets.h) or a patch
                                           binary file (NAME.bin) uploaded live first; --notes: hold the first N of the
                                           rig survey's 8 notes (C4 E4 G4 B4 C5 E5
                                           G5 B5) from 1 s before the window to its end; --json: the raw values too. Reads
                                           only, except that page 139 holds the main loop 5 ms)
  tools/m1_link.py modtime [SECONDS] [--notes N] [--patch NAME] [--json FILE]
                                          (#802, DIAG pages 144..176: each module's time a half buffer on the FM-1 over
                                           SECONDS (default 3), on core 0's lane and on core 1's; --patch and --notes as
                                           blocktime; --json: the raw values. Reads only)
  tools/m1_link.py t5 [SECONDS]           (#803, DIAG page 177: TIMER5's time over SECONDS (default 3): the LED and key
                                           scan a tick, the USB / MIDI polls, the dim pulses. Reads only)
  tools/m1_link.py fpubench [--json FILE] (#950, DIAG pages 178..: on a build with the CPU benchmark (tools/build.py
                                           M1_BENCH=1, the CI job fpu-measure): each kernel runs 8 times, a block each with
                                           the interrupts off (about a second in all; the sound stops meanwhile and the
                                           overload guard may drop a voice), then its fastest run in CPU cycles per sample
                                           (the clock from the same page's timed adds); --json: the raw values too)
  tools/m1_link.py fpucheck [--json FILE] (D-1114, #979, DIAG pages 140..142: the float kernels' result bits for a fixed
                                           input (engine.c eng_fpu_probe), 32 runs on core 0 from the main loop with the
                                           interrupts on, then one on core 1; prints the hashes of both and those of
                                           build/fpu_probe (firmware/test/fpu_probe.c, the host) when it exists. Exit 1 when
                                           any differ)
  tools/m1_link.py diag [DIS]             (what the last reset left: its cause, the crash record, where a stalled main loop
                                           was; DIS = the build's matryoshka.dis (CI artifact matryoshka-elf) names the functions)
  tools/m1_link.py factory-info           (#915: the factory region's state, layout, set, length and patch count)
  tools/m1_link.py factory-install [FILE] (#915: the factory content into the factory region; FILE default
                                           web/public/firmware/matryoshka-factory.bin; sectors whose sum already matches
                                           are skipped, so a cut install is resumed by running it again)
  tools/m1_link.py factory-read [OFFSET [LENGTH [OUT]]]   (#915: the region's bytes, default all 73,728, to OUT or stdout)
Every command takes --rig (the test rig: the FM-1 at its registered USB location, checked by its mark) or --location HEX
(the FM-1 in that USB socket, tools/fm1_usb.py list). Without either it takes the FM-1 by its port name, and refuses
while more than one FM-1 is connected, since they share the name (#771).
Needs mido and python-rtmidi (build/venv has them).
"""
import atexit
import collections
import os
import re
import sys
import time

try:
    import mido
except ImportError:
    sys.exit("needs mido and python-rtmidi")

PREFIX = [0x7D, 0x4D, 0x31]
STATUS = ["ok", "bad offset or size", "checksum mismatch", "the firmware refused the patch", "flash error",
          "unknown command", "nothing to store"]


def pack7(b):
    out, acc, nb = [], 0, 0
    for x in b:
        acc |= x << nb
        nb += 8
        while nb >= 7:
            out.append(acc & 0x7F)
            acc >>= 7
            nb -= 7
    if nb:
        out.append(acc & 0x7F)
    return out


def unpack7(s):
    out, acc, nb = [], 0, 0
    for x in s:
        acc |= (x & 0x7F) << nb
        nb += 7
        if nb >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nb -= 8
    return out


def crc16(data):
    c = 0xFFFF
    for x in data:
        c ^= x << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c


def frame(cmd, payload=()):
    return mido.Message("sysex", data=PREFIX + [cmd] + pack7(list(payload)))


class _RtOut:
    """a python-rtmidi output port with mido's send(Message)"""

    def __init__(self, port):
        self.port = port

    def send(self, msg):
        self.port.send_message(msg.bytes())


class _RtIn:
    """a python-rtmidi input port with mido's iter_pending(): every message, SysEx included (clock and active sensing
    dropped, as the protocol's answers are what the tools wait for)"""

    def __init__(self, port):
        self.port, self.q = port, collections.deque()
        port.ignore_types(sysex=False, timing=True, active_sense=True)
        port.set_callback(lambda ev, _data=None: self.q.append(ev[0]))

    def close(self):
        """stop CoreMIDI calling back into Python: a packet that arrives while the interpreter shuts down crashed it
        (python-rtmidi's callback taking the GIL during finalization, SIGSEGV)"""
        self.port.cancel_callback()
        self.port.close_port()

    def iter_pending(self):
        while self.q:
            yield mido.Message.from_bytes(self.q.popleft())


def fm1s_connected():
    """how many USB MIDI devices that look like an FM-1 are online (tools/fm1_usb.py); 0 when that cannot be told (not
    macOS, no python-rtmidi)"""
    try:
        import fm1_usb
        return sum(1 for d in fm1_usb.usb_devices() if fm1_usb.fm1_like(d))
    except (OSError, ImportError):
        return 0


class Link:
    """the editor protocol over one FM-1's MIDI ports. `location` (a USB location, tools/fm1_usb.py list): the ports of the
    device in that USB socket only, opened by index, so another FM-1 of the same name is never reached (#771). Without it,
    the first port named like an FM-1, and only while one FM-1 is connected: two carry the same port name, so the name
    alone could pick either. `backend`: a stand-in fm1_usb.LocatedBackend (the tests)"""

    def __init__(self, location=None, backend=None):
        if location is not None:
            import fm1_usb
            be = backend or fm1_usb.LocatedBackend(location)
            ins, outs = be.input_names(), be.output_names()
            if not ins or not outs:
                sys.exit(f"no MIDI ports at USB location {fm1_usb.location_text(location)}")
            i = ins[0]
            o = i if i in outs else outs[0]
            midi_in, midi_out = be.open_ports(i, o)
            self.inp, self.out = _RtIn(midi_in), _RtOut(midi_out)
            atexit.register(self.inp.close)
            return
        n = fm1s_connected()
        if n > 1:
            sys.exit(f"{n} FM-1s are connected and their ports share one name: pass --location HEX (tools/fm1_usb.py list) "
                     "or --rig, or unplug the others")
        pick = lambda names: next((n for n in names if "Felucca" in n or "Matryoshka" in n or "Modular" in n or "FM-1" in n), None)
        o, i = pick(mido.get_output_names()), pick(mido.get_input_names())
        if not o or not i:
            sys.exit("FM-1 not found")
        self.out, self.inp = mido.open_output(o), mido.open_input(i)
        atexit.register(self.inp.close)

    def ask(self, msg, want, tries=3, wait=0.8):
        for _ in range(tries):
            for _ in self.inp.iter_pending():
                pass
            self.out.send(msg)
            t = time.time()
            while time.time() - t < wait:
                for m in self.inp.iter_pending():
                    if m.type == "sysex" and list(m.data[:3]) == PREFIX and m.data[3] == want[0]:
                        p = unpack7(m.data[4:])
                        if len(want) == 1 or p[0] == want[1]:
                            return p
                time.sleep(0.002)
        sys.exit(f"no answer from the FM-1 to command {msg.data[3]:#04x} (is it running the Matryoshka firmware with the editor protocol?)")

    def ack(self, msg, cmd, wait=0.8, tries=3):
        p = self.ask(msg, (0x40, cmd), tries, wait)
        if p[2]:
            sys.exit(f"FM-1: {STATUS[p[2]] if p[2] < len(STATUS) else p[2]} (aux {p[3]})")


RIG_FILE = os.environ.get("MATRYOSHKA_RIG_FILE") or os.path.expanduser("~/.config/matryoshka/rig.json")


def rig_link(backend=None):
    """a Link to the test rig (web/scripts/rig-link.mjs): the FM-1 at the rig's registered USB location, and only when the
    rig's mark reads back there; else it exits having sent nothing but the mark's read (PRESET_GET). Another FM-1 may stay
    connected (#771). `backend(location)`: a stand-in fm1_usb.LocatedBackend (the tests)"""
    import json
    import fm1_usb
    try:
        with open(RIG_FILE) as f:
            rig = json.load(f)
    except (OSError, ValueError):
        sys.exit(f"no rig registered ({RIG_FILE}): connect the rig alone and run npm run rig -- register")
    if not rig.get("usbLocation"):
        sys.exit("the rig's USB location is not recorded: npm run rig -- register again, with the rig alone (it keeps the mark)")
    loc = fm1_usb.parse_location(rig["usbLocation"])
    mark = fm1_usb.mark_at(loc, backend(loc) if backend else None)
    if not fm1_usb.same_mark(mark, rig.get("values")):
        what = "no running Matryoshka answers there" if mark is None else "the FM-1 there carries another mark" if mark else "the FM-1 there has no rig mark"
        sys.exit(f"at the rig's USB location {fm1_usb.location_text(loc)} {what}: nothing sent")
    return Link(loc, backend(loc) if backend else None)


def link_from_args(a):
    """--rig or --location HEX taken out of the argument list `a` (in place): the Link they name, else Link()"""
    if "--rig" in a:
        a.remove("--rig")
        return rig_link()
    if "--location" in a:
        k = a.index("--location")
        if k + 1 >= len(a):
            sys.exit("--location needs a USB location (tools/fm1_usb.py list)")
        import fm1_usb
        loc = fm1_usb.parse_location(a[k + 1])
        del a[k:k + 2]
        return Link(loc)
    return Link()


def upload_chunks(link, data):
    for seq, off in enumerate(range(0, len(data), 384)):
        part = data[off:off + 384]
        link.ack(frame(0x10, [seq & 0x7F, off & 0xFF, off >> 8, len(data) & 0xFF, len(data) >> 8, *part]), 0x10)


def lz_unpack(src):
    """a factory patch as presets.h stores it, unpacked (the format: firmware/src/lz_unpack.h)"""
    out, i = bytearray(), 0

    def more(n):
        nonlocal i
        while True:
            d = src[i]
            i += 1
            n += d
            if d != 255:
                return n
    while i < len(src):
        t = src[i]
        i += 1
        n = t >> 4
        if n == 15:
            n = more(n)
        if n > len(src) - i:
            raise ValueError("packed patch cut short")
        out += src[i:i + n]
        i += n
        if i == len(src):
            break
        d = src[i] | src[i + 1] << 8
        i += 2
        n = (t & 15) + 4
        if n == 19:
            n = more(n)
        if not 0 < d <= len(out):
            raise ValueError("packed patch match out of range")
        for _ in range(n):
            out.append(out[-d])
    return bytes(out)


def factory_presets(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware", "src", "presets.h")):
    """[(name, bytes)] of the factory presets, unpacked, from the generated firmware/src/presets.h (cd web && npm run export-defs)"""
    src = open(path).read()
    lengths = {m.group(1): int(m.group(2)) for m in re.finditer(r'\{"[^"]*", (PRESET_\d+), sizeof PRESET_\d+, (\d+)\}', src)}
    out = []
    for m in re.finditer(r"static const uint8_t (PRESET_\d+)\[\d+\] = \{([\d,]*)\};\s*/\* (.*?) \*/", src):
        data = lz_unpack(bytes(int(x) for x in m.group(2).split(",")))
        if len(data) != lengths.get(m.group(1)):
            sys.exit(f"{path}: {m.group(3)} unpacks to {len(data)} bytes, not {lengths.get(m.group(1))}")
        out.append((m.group(3), data))
    if not out:
        sys.exit(f"no presets found in {path}")
    return out


# ---- the factory region (#915, firmware/src/factory.c; the link commands D-490)
FACTORY_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "public", "firmware", "matryoshka-factory.bin")
FACTORY_SIZE, FACTORY_HDR = 18 * 0x1000, 64
C_FACT_BEGIN, C_FACT_WRITE, C_FACT_SUM, C_FACT_READ, C_FACT_COMMIT, C_FACT_INFO = 0x16, 0x17, 0x18, 0x19, 0x1A, 0x3F
R_FACT_INFO, R_FACT_SUM, R_FACT_DATA = 0x5F, 0x60, 0x61
FACTORY_STATE = ["none (the firmware tier alone plays)", "valid", "newer than this firmware reads", "damaged"]


def has_factory(link):
    """INFO feature bit 26 (byte 14 bit 2, protocol.ts FEATURE_FACTORY, D-490): the firmware has the factory region's
    commands; older firmware (1.17 and before) answers FACT_* with an unknown-command status"""
    p = link.ask(frame(0x01), (0x41,))
    return len(p) > 14 and bool(p[14] & 4)


def factory_info(link):
    """FACT_INFO as a dict"""
    p = link.ask(frame(C_FACT_INFO), (R_FACT_INFO,))
    u16 = lambda i: p[i] | p[i + 1] << 8
    u32 = lambda i: u16(i) | u16(i + 2) << 16
    i = {"state": p[0], "reads": p[1], "layout": p[2], "format": p[3], "version": u16(4), "set": u32(6),
         "len": u32(10), "patches": u16(14), "writing": bool(p[16] & 1), "tier_only": bool(p[16] & 2), "size": u32(17)}
    if len(p) >= 26:                    # (the firmware's newest patch format, its tier's version and patches, the merged list)
        i.update({"plays": p[21], "tier_version": u16(22), "tier_patches": p[24], "merged": p[25]})
    return i


def factory_info_text(i):
    s = FACTORY_STATE[i["state"]] if i["state"] < len(FACTORY_STATE) else str(i["state"])
    tier = (f"; the firmware tier: version {i['tier_version']}, {i['tier_patches']} patches; {i['merged']} factory patches in all"
            if "merged" in i else "")
    if not i["layout"]:
        return f"factory region: {s}{tier}"
    return (f"factory region: {s}; layout {i['layout']} (the firmware reads {i['reads']}), format {i['format']}, "
            f"version {i['version']}, set {i['set']:06x}, {i['len'] + FACTORY_HDR} of {i['size']} bytes, {i['patches']} patches"
            + ("; an install was begun" if i["writing"] else "") + tier)


def factory_sector_sum(img, s):
    """CRC-16 of sector s as the flash holds the image before the commit (the header's 64 bytes erased)"""
    b = bytearray(b"\xFF" * 0x1000)
    part = img[s * 0x1000:(s + 1) * 0x1000]
    b[:len(part)] = part
    if s == 0:
        b[:FACTORY_HDR] = b"\xFF" * FACTORY_HDR
    return crc16(b)


def factory_sum(link, s):
    p = link.ask(frame(C_FACT_SUM, [s]), (R_FACT_SUM, s), wait=2.0)
    return p[2] | p[3] << 8 if p[1] else None


def factory_install(link, img, log=lambda s: None):
    """the image into the factory region: FACT_BEGIN (the header goes), each sector whose FACT_SUM differs written a page
    at a time (offset 0 erases it; the page an update record would be in is written whole), then FACT_COMMIT (the firmware
    checks the body's CRC-32 and programs the header, its magic last). Run again after a cut: the matching sectors are
    skipped"""
    if len(img) < FACTORY_HDR or len(img) > FACTORY_SIZE or img[:4] != b"MFC1":
        sys.exit("not a factory region image (web/public/firmware/matryoshka-factory.bin)")
    link.ack(frame(C_FACT_BEGIN), C_FACT_BEGIN, wait=3.0)
    sectors = (len(img) + 0xFFF) // 0x1000
    for s in range(sectors):
        if factory_sum(link, s) == factory_sector_sum(img, s):
            log(f"sector {s + 1:2d} of {sectors}: already there")
            continue
        off = FACTORY_HDR if s == 0 else 0
        while off < 0x1000 and s * 0x1000 + off < len(img):
            page = bytearray(img[s * 0x1000 + off:s * 0x1000 + (off | 0xFF) + 1])
            if off & 0xF00 == 0xF00 and len(page) < 80:
                page += b"\xFF" * (256 - len(page))
            link.ack(frame(C_FACT_WRITE, [s, off & 0xFF, off >> 8, *page]), C_FACT_WRITE, wait=3.0)
            off = (off | 0xFF) + 1
        if factory_sum(link, s) != factory_sector_sum(img, s):
            sys.exit(f"factory region: sector {s} did not read back as written")
        log(f"sector {s + 1:2d} of {sectors}: written")
    link.ack(frame(C_FACT_COMMIT, list(img[:FACTORY_HDR])), C_FACT_COMMIT, wait=5.0)
    log("factory content committed")


def factory_read(link, off, n):
    out = bytearray()
    while len(out) < n:
        at, k = off + len(out), min(128, n - len(out))
        p = link.ask(frame(C_FACT_READ, [at & 0xFF, at >> 8 & 0xFF, at >> 16 & 0xFF, at >> 24, k]), (R_FACT_DATA, at & 0xFF), wait=2.0)
        if len(p) < 4 + k:
            sys.exit(f"factory region: {at:#x} not readable")
        out += bytes(p[4:4 + k])
    return bytes(out)


def bank_slots(link):
    """the slots of the FM-1's bank: INFO byte 15 (60 with the pattern store on, #901), absent before it: 64 (protocol.ts
    slotCount). SLOT / SLOT_ERASE / SLOT_INFO past them answer S_RANGE, so SLOT_INFO gets no R_SLOT (#955)"""
    p = link.ask(frame(0x01), (0x41,))
    return p[15] if len(p) >= 16 and p[15] else 64


def bank_command(link, a, ask=input, out=print):
    """bank / bank-info / bank-clear over the bank's slots as the FM-1 reports them"""
    slots = bank_slots(link)
    if a[0] == "bank":
        presets = factory_presets()[:32]
        for slot, (name, data) in enumerate(presets):
            upload_chunks(link, data)
            n = [ord(c) if 32 <= ord(c) < 127 else 0 for c in name[:20]]
            n += [0] * (20 - len(n))
            c = crc16(data)
            link.ack(frame(0x13, [slot, *n, len(data) & 0xFF, len(data) >> 8, c & 0xFF, c >> 8]), 0x13, wait=4.0, tries=1)
            out(f"slot {slot + 1:02d}  {name}  ({len(data)} bytes)")
        for slot in range(len(presets), slots):
            link.ack(frame(0x14, [slot]), 0x14, wait=4.0, tries=1)
        out(f"bank written: {len(presets)} presets")
    elif a[0] == "bank-info":
        used = 0
        for slot in range(slots):
            p = link.ask(frame(0x15, [slot]), (0x42, slot))
            if p[1]:
                used += 1
                name = bytes(x for x in p[4:24] if 32 <= x < 127).decode()
                out(f"slot {slot + 1:02d}  {name}  ({p[2] | p[3] << 8} bytes)")
        out(f"{used} of {slots} slots used" + ("" if used else ": the next boot writes the factory patches again"))
    elif a[0] == "bank-clear":
        if "--yes" not in a and ask(f"erase all {slots} slots of the FM-1's bank? [y/N] ").strip().lower() not in ("y", "yes"):
            out("bank left as it is")
            return
        for slot in range(slots):
            link.ack(frame(0x14, [slot]), 0x14, wait=4.0, tries=1)
        out("bank emptied")


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    link = link_from_args(a)
    if not a:
        sys.exit(__doc__)
    if a[0] == "info":
        p = link.ask(frame(0x01), (0x41,))
        print(f"protocol {p[0]}, max modules {p[1]}, max cables {p[2]}, flash {'ok' if p[3] & 1 else 'no'}, "
              f"patch {'loaded' if p[3] & 2 else 'none'}, delays {p[4]}"
              + (f", firmware {p[9]}.{p[10]}.{p[11]}{' (a dev or CI build)' if not any(p[9:12]) else ''}" if len(p) >= 12 else ""))
    elif a[0] == "upload":
        data = open(a[1], "rb").read()
        for seq, off in enumerate(range(0, len(data), 384)):
            part = data[off:off + 384]
            link.ack(frame(0x10, [seq & 0x7F, off & 0xFF, off >> 8, len(data) & 0xFF, len(data) >> 8, *part]), 0x10)
        c = crc16(data)
        link.ack(frame(0x11, [len(data) & 0xFF, len(data) >> 8, c & 0xFF, c >> 8]), 0x11)
        print(f"uploaded {len(data)} bytes")
    elif a[0] in ("bank", "bank-info", "bank-clear"):
        bank_command(link, a)
    elif a[0] == "factory-info":
        print(factory_info_text(factory_info(link)))
    elif a[0] == "factory-install":
        img = open(a[1] if len(a) > 1 else FACTORY_BIN, "rb").read()
        factory_install(link, img, log=print)
        print(factory_info_text(factory_info(link)))
    elif a[0] == "factory-read":
        off = int(a[1], 0) if len(a) > 1 else 0
        n = int(a[2], 0) if len(a) > 2 else FACTORY_SIZE - off
        data = factory_read(link, off, n)
        if len(a) > 3:
            open(a[3], "wb").write(data)
            print(f"{len(data)} bytes from {off:#x} into {a[3]}")
        else:
            sys.stdout.buffer.write(data)
    elif a[0] == "store":
        link.ack(frame(0x12), 0x12)
        print("stored")
    elif a[0] == "param":
        v = int(round(float(a[3]) * 65536)) & 0xFFFFFFFF
        link.out.send(frame(0x20, [int(a[1]), int(a[2]), v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, v >> 24]))
    elif a[0] == "program":
        link.out.send(mido.Message("program_change", program=int(a[1])))
    elif a[0] == "note":
        link.out.send(mido.Message("note_on", note=int(a[1]), velocity=100))
        time.sleep(float(a[2]) if len(a) > 2 else 1.0)
        link.out.send(mido.Message("note_off", note=int(a[1])))
    elif a[0] == "cpu":
        p = link.ask(frame(0x2B, [127]), (0x4B, 127))
        w = [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range((len(p) - 1) // 4)]
        print(f"cpu {w[0]} %, peak {w[1]} us of {w[2]} us ({100 * w[1] / w[2]:.0f} %) since the last read, "
              f"overload {'MUTED' if w[3] else 'no'}, halves {w[4]}")
        if len(w) >= 7:                                 # (firmware with the battery, #240)
            print(f"battery {w[6]} of 1023 (smoothed; 0 = not read yet), its read took {w[5]} us")
    elif a[0] == "mem":
        p = link.ask(frame(0x2B, [124]), (0x4B, 124))
        if len(p) < 33:
            sys.exit("no memory page (a firmware from before #273)")
        w = [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(8)]
        state = {0: "not proved", 1: "proved", 2: "FAILED its pattern test: do not use this build on this FM-1"}
        print(f".lowram {w[1]} B {state.get(w[0], w[0])}, {w[2]} B free after it; pool {w[7]} B free")
        for name, size, used in (("main", w[3], w[4]), ("supervisor", w[5], w[6])):
            print(f"{name} stack: {used} of {size} B at most since boot ({size - used} B never reached)")
    elif a[0] == "cores":                               # #271: the second core (DIAG 114; "cores inject": 113 first)
        page = 113 if len(a) > 1 and a[1] == "inject" else 114
        if len(a) > 2 and a[1] == "split":                 # the render's split off / on (DIAG 110 / 111; on at boot)
            page = 110 if a[2] == "off" else 111
        if len(a) > 2 and a[1] == "stress":                # the self-test every 1 ms, its race window widened (DIAG 108 / 109)
            page = 108 if a[2] == "on" else 109
        p = link.ask(frame(0x2B, [page]), (0x4B, page))
        if len(p) < 33:
            sys.exit("no second-core page (a firmware from before #271)")
        w = [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(8)]
        on, gave, barred, skip = w[0] & 0xFF, (w[0] >> 8) & 0xFF, (w[0] >> 16) & 0xFF, (w[0] >> 24) & 0x7F
        why = {0: "", 1: " (wrong job refused)", 2: " (job late)", 3: " (barred: one core until power-off)",
               4: " (wrong self-test answer)"}.get(gave, f" ({gave})")
        skipped = {1: ", not started: update mode", 2: ", not started: the last boot failed",
                   3: ", not started: the supply setup failed (cpuclock)"}.get(skip, "")
        print(f"{'2 CORES' if on else '1 CORE'}{why if gave else ''}{skipped}; barred {'yes' if barred else 'no'}; "
              f"trace {w[1]:#010x}; split {'OFF' if w[0] >> 31 else 'on'}")
        print(f"self-test passed {w[2]}, failed {w[3]}; refused jobs {w[4]}; jobs done {w[7]}; "
              f"core 1 stack {w[5]} B used; longest wait {w[6]} us since the last read")
        if page == 113:
            print("one wrong check word armed for the next self-test (within 100 ms): run `cores` again")
        q = link.ask(frame(0x2B, [115]), (0x4B, 115))      # the last failed self-test (DIAG 115, firmware since the race fix)
        if len(q) >= 13:
            x = [int.from_bytes(bytes(q[1 + 4 * i:5 + 4 * i]), "little") for i in range(3)]
            if w[3]:
                print(f"last failed self-test: answer {x[2]:#010x}, wrong bits {x[0]:#010x}"
                      f"{' (never written: the job did not run)' if x[0] == 0xFFFFFFFF else ''}, seed {x[1]:#010x}")
    elif a[0] == "cpuclock":
        p = link.ask(frame(0x2B, [131]), (0x4B, 131))
        if len(p) < 21:
            sys.exit("no clock page: firmware before #735")
        w = [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(len(p) // 4)]
        mult = (w[0] & 0xFFF) + 2

        def rails(x):
            r9, r6, r5, r0 = x & 0xF, (x >> 8) & 7, (x >> 16) & 7, (x >> 24) & 0xFF
            return (f"SYSVDD {r9} = {0.93 + 0.03 * r9:.2f} V, VDC14 {r6} = {1.25 + 0.05 * r6:.2f} V, VDDIO {r5} ="
                    f" {2.8 + 0.1 * r5:.1f} V, VDDIOW {(x >> 20) & 3}; mode {r0:#04x}"
                    f" (LDO13 {'on' if r0 & 4 else 'off'}, DCDC13 {'on' if r0 & 8 else 'off'})")
        print(f"PLL2_CON1 {w[0]:#010x}: multiplier {mult}, VCO {mult * 2} MHz, SYS {mult * 4 // 3} MHz if CLK_CON2 picks 2/3"
              f" (CLK_CON2 {w[1]:#010x})")
        print(f"rails now: {rails(w[2])}")
        d = w[4] - w[3]
        print(f"adds: 16384 in {w[3]} ticks, 49152 in {w[4]} ticks (24 MHz); the difference, 32768 adds in {d} ticks ="
              f" {32768 * 24 / d:.0f} dependent adds a microsecond" if d > 0 else "adds: no time measured")
        if len(w) >= 8 and w[6] & 0xFF:                    # the stock supply setup at boot (hal/fm1_power.h)
            state, step, lost = w[6] & 0xFF, (w[6] >> 8) & 0xFF, (w[6] >> 16) & 0xFF
            print("supply setup at boot: " + ("set and checked" if state == 1 else
                  f"FAILED at {'the check after it' if step == 21 else f'step {step} of 20'}, {lost} P33 timeouts;"
                  " one core, on the boot loader's levels"))
            print(f"rails before it: {rails(w[7])}")
        elif len(w) >= 8:
            print("supply setup at boot: not run (update mode, or a firmware from before it)")
    elif a[0] == "uitime":
        if len(a) > 1 and a[1] == "reset":
            link.ask(frame(0x2B, [120]), (0x4B, 120))
            print("draw times reset")
        else:
            print_uitime([link.ask(frame(0x2B, [p]), (0x4B, p)) for p in (121, 122, 123)])
    elif a[0] == "uac":
        def read():
            w = []
            for page in (125, 126):
                p = link.ask(frame(0x2B, [page]), (0x4B, page))
                if len(p) < 33:
                    sys.exit("no USB audio pages (a firmware built without FELUCCA_UAC?)")
                w += [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(8)]
            return w
        w0 = read()
        print_uac(w0)
        if len(a) > 1:
            dt = float(a[1])
            t0 = time.time()
            time.sleep(dt)
            w1 = read()
            dt = time.time() - t0
            print_uac(w1)
            d = [(y - x) & 0xFFFFFFFF for x, y in zip(w0, w1)]
            pk, fr = d[2], d[3]
            print(f"over {dt:.1f} s: {pk / dt:.1f} packets/s, {fr / dt:.1f} frames/s"
                  f"{f' ({fr / pk * 1000:.1f} Hz per packet ms)' if pk else ''}; underruns +{d[8]}, overruns +{d[9]}, "
                  f"missed +{d[10]}, stalls +{d[11]}, adj_up {d[12] / dt:.2f}/s, adj_down {d[13] / dt:.2f}/s "
                  f"(net {(d[12] - d[13]) / dt:+.2f} frames/s: the I2S clock against the host's)")
    elif a[0] == "clock":
        def page(n):
            p = link.ask(frame(0x2B, [n]), (0x4B, n))
            if len(p) < 33:
                sys.exit(f"no DIAG page {n} (a firmware from before #473?)")
            return [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(8)]
        def show(w):
            print(f"clock out: {w[0]} ticks sent, {w[1]} dropped (host not reading), {w[2]} waiting for their time, "
                  f"USB MIDI ring {w[3]}; CLOCK OUT {'on' if w[4] else 'off'}, MIDI OUT {'on' if w[5] else 'off'}, "
                  f"clock in {'drives' if w[6] else 'idle'}, transport {'runs' if w[7] else 'stopped'}")
        w0, l0 = page(116), page(117)
        show(w0)
        if len(a) > 1:
            import rtmidi
            secs = float(a[1])
            mi = rtmidi.MidiIn()
            port = next((k for k, n in enumerate(mi.get_ports())
                         if any(x in n for x in ("Felucca", "Matryoshka", "Modular", "FM-1")) and "ota-" not in n), None)
            if port is None:
                sys.exit("no FM-1 input for the clock")
            mi.ignore_types(sysex=True, timing=False, active_sense=True)
            stamps, acc, others = [], [0.0], []
            def cb(ev, _):
                msg, dt = ev
                acc[0] += dt
                if msg and msg[0] == 0xF8:
                    stamps.append(acc[0])
                elif msg:
                    others.append((acc[0], msg[0]))
            mode0 = bpm0 = None
            if len(a) > 2:                              # the global tempo for the run: TEMPO_NOW after INFO says what it was
                link.out.send(frame(0x01))
                t = time.time()
                while time.time() - t < 1.0 and mode0 is None:
                    for m in link.inp.iter_pending():
                        if m.type == "sysex" and list(m.data[:3]) == PREFIX and m.data[3] == 0x55:
                            p = unpack7(m.data[4:])
                            mode0, bpm0 = p[0], p[1] | p[2] << 8
                    time.sleep(0.01)
                bpm = int(a[2])
                link.out.send(frame(0x38, [0, bpm & 0xFF, bpm >> 8]))
            if len(a) > 3 and a[3] == "run":
                link.out.send(frame(0x25, [1]))
            time.sleep(0.5)
            mi.set_callback(cb)
            mi.open_port(port)
            time.sleep(secs)
            mi.cancel_callback()
            mi.close_port()
            if len(a) > 3 and a[3] == "run":
                link.out.send(frame(0x25, [0]))
            if mode0 is not None:
                link.out.send(frame(0x38, [mode0, bpm0 & 0xFF, bpm0 >> 8]))
                print(f"(TEMPO set back to {'GLOBAL' if mode0 == 0 else 'PATCH'}, global tempo {bpm0})")
            w1, l1 = page(116), page(117)
            show(w1)
            if len(stamps) < 3:
                sys.exit(f"{len(stamps)} ticks received in {secs:g} s")
            per = [(b - a_) * 1e3 for a_, b in zip(stamps, stamps[1:])]
            mean = sum(per) / len(per)
            dev = [abs(x - mean) for x in per]
            n = len(stamps)
            xs = range(n)
            mx, my = (n - 1) / 2, sum(stamps) / n
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, stamps)) / sum((x - mx) ** 2 for x in xs)
            grid = [abs(y - (my + slope * (x - mx))) * 1e3 for x, y in zip(xs, stamps)]
            print(f"{n} ticks in {secs:g} s: mean period {mean:.3f} ms = {60000 / (24 * mean):.2f} bpm")
            ds = sorted(dev)
            print(f"  period deviation per tick: mean {sum(dev) / len(dev):.3f} ms, 99 % within {ds[len(ds) * 99 // 100]:.3f} ms, "
                  f"max {max(dev):.3f} ms")
            print(f"  tick from a straight grid: mean {sum(grid) / n:.3f} ms, max {max(grid):.3f} ms")
            if others:                                  # a patch load pauses the engine, a Start restarts the beat: not jitter
                print(f"  NOTE: {len(others)} other messages came meanwhile ({', '.join(sorted({f'{b:#04x}' for _, b in others}))}): "
                      f"someone used the FM-1, so the outliers may be theirs")
                clean = [x for (t0, t1), x in zip(zip(stamps, stamps[1:]), per)
                         if not any(t0 - 0.25 <= t <= t1 + 0.25 for t, _ in others)]
                if len(clean) > 10:
                    cm = sum(clean) / len(clean)
                    cd = sorted(abs(x - cm) for x in clean)
                    print(f"  the {len(clean)} periods with no other message within 250 ms: mean {cm:.3f} ms, deviation mean "
                          f"{sum(cd) / len(cd):.3f} ms, 99 % within {cd[len(cd) * 99 // 100]:.3f} ms, max {cd[-1]:.3f} ms")
            print(f"  FM-1 counted {(w1[0] - w0[0]) & 0xFFFFFFFF} ticks sent, {(w1[1] - w0[1]) & 0xFFFFFFFF} dropped; "
                  f"link sends refused for no room {(l1[2] - l0[2]) & 0xFFFFFFFF}, with no host {(l1[1] - l0[1]) & 0xFFFFFFFF}")
    elif a[0] == "usblog":
        def page(n):
            p = link.ask(frame(0x2B, [n]), (0x4B, n))
            if len(p) < 33:
                sys.exit("no USB setup log (DIAG pages 104 / 105: a firmware from before #535, or the update loader)")
            return p[1:33]
        words = lambda b: [int.from_bytes(bytes(b[4 * i:4 * i + 4]), "little") for i in range(8)]
        if len(a) > 1 and a[1] in ("arm", "wrap"):
            st = words(page(106 if a[1] == "arm" else 107))
            print("one-shot capture armed: the next %d entries are kept (unplug, plug into the host under test, come back, "
                  "run usblog)" % (st[2] >> 8 & 0xFFFF) if a[1] == "arm" else "the log keeps the newest entries again")
            return
        st, ct = words(page(104)), words(page(105))
        ents = {}
        n, base, oneshot, size = st[0], st[1], st[2] & 0xFF, st[2] >> 8 & 0xFFFF
        first = base if oneshot else max(0, n - size)
        last = min(n, base + size) if oneshot else n
        pages = sorted({40 + (k % size) // 2 for k in range(first, last)})
        data = {pg: page(pg) for pg in pages}
        for k in range(first, last):
            slot = k % size
            ents[k] = data[40 + slot // 2][16 * (slot % 2):16 * (slot % 2) + 16]
        st2 = words(page(104))
        print_usblog(st, ct, ents, first, last, st2[0] != n)
    elif a[0] == "blocktime":
        blocktime(link, a[1:])
    elif a[0] == "modtime":
        modtime(link, a[1:])
    elif a[0] == "t5":
        t5parts(link, a[1:])
    elif a[0] == "fpubench":
        fpubench(link, a[1:])
    elif a[0] == "fpucheck":
        fpucheck(link, a[1:])
    elif a[0] == "diag":
        raw = []
        for page in range(32):
            p = link.ask(frame(0x2B, [page]), (0x4B, page))
            raw += p[1:]
            if len(p) < 33:
                break
        print_diag(raw, a[1] if len(a) > 1 else None)
    else:
        sys.exit(__doc__)


BT_NOTES = [60, 64, 67, 71, 72, 76, 79, 83]           # (tools/rig_cpu_survey.py NOTES)
# firmware/src/blk_time.h BT_ENTRY .. BT_C1_IDLE, in that order (DIAG pages 133..137, four a page)
BT_SPANS = [
    ("entry", "ISR start to the half chosen (pending, ack, free half)"),
    ("pre", "USB audio's render start, the guard's shed"),
    ("eng_pre", "engine before the voices (clock, arps, flaws, idle checks)"),
    ("voices", "the voices: render_split, every module (both cores)"),
    ("eng_post", "engine after the voices (idle detection, triggers, group cables)"),
    ("eng_out", "the Output modules' sum and the clamp"),
    ("mix", "MASTER to the I2S words, loudness check, test meter"),
    ("clk", "MIDI clock out"),
    ("uac", "USB audio's tap (the half into its ring)"),
    ("tail", "click, mono fold, 3.5MM OUT, the half's ack"),
    ("guard", "the overload guard and its counters"),
    ("isr", "the whole audio ISR (C), start to end"),
    ("t5_in", "TIMER5 interrupts nested in the audio ISR (inside the spans above)"),
    ("t5_out", "TIMER5 interrupts outside the audio ISR"),
    ("self", "this measurement's own accounting (bt_block)"),
    ("hand", "core 0 handing segments to core 1"),
    ("wait", "core 0 waiting for core 1"),
    ("c0_busy", "core 0 in the voices, less its waits"),
    ("c1_busy", "core 1 in its jobs"),
    ("c1_idle", "core 1 waiting for work while the voices render"),
]


def window_args(a):
    """blocktime's and modtime's arguments: SECONDS, --notes N, --patch NAME, --json FILE"""
    def opt(name, conv, default):
        if name in a:
            k = a.index(name)
            if k + 1 >= len(a):
                sys.exit(f"{name} needs a value")
            v = conv(a[k + 1])
            del a[k:k + 2]
            return v
        return default
    notes, patch, out = opt("--notes", int, 0), opt("--patch", str, None), opt("--json", str, None)
    if not 0 <= notes <= len(BT_NOTES):
        sys.exit(f"--notes takes 0..{len(BT_NOTES)}")
    return float(a[0]) if a else 3.0, BT_NOTES[:notes], patch, out


def diag_words(link, n):
    p = link.ask(frame(0x2B, [n]), (0x4B, n))
    return [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range((len(p) - 1) // 4)]


def load_factory(link, patch):
    """a factory patch (firmware/src/presets.h), or a patch binary file (NAME.bin, as rig_cpu_survey.py DIR reads), uploaded live"""
    if os.path.isfile(patch):
        with open(patch, "rb") as f:
            hit = [f.read()]
    else:
        ps = factory_presets()
        hit = [d for n, d in ps if n.lower() == patch.lower()] or [d for n, d in ps if n.lower().startswith(patch.lower())]
        if len(hit) != 1:
            sys.exit(f"--patch {patch!r}: {'no' if not hit else 'more than one'} factory patch of that name; "
                     f"names: {', '.join(n for n, _ in ps)}")
    upload_chunks(link, hit[0])
    c = crc16(hit[0])
    link.ack(frame(0x11, [len(hit[0]) & 0xFF, len(hit[0]) >> 8, c & 0xFF, c >> 8]), 0x11, wait=3.0)
    time.sleep(0.5)


def blocktime(link, a):
    """DIAG pages 132..139 (main.c m1_diag, firmware/src/blk_time.h): one window of SECONDS, optionally on a factory patch
    with notes held"""
    import json
    secs, held, patch, out = window_args(a)
    page = lambda n: diag_words(link, n)
    if len(page(132)) < 8:
        sys.exit("no block-time pages (a firmware from before #802 / #803)")
    if patch:
        load_factory(link, patch)
    try:
        for k in held:
            link.out.send(mido.Message("note_on", note=k, velocity=100))
        time.sleep(1.0 if held else 0.1)
        page(132)                                      # the window starts here
        time.sleep(secs)
        w = page(132)
        spans = []
        for pg in range(133, 138):
            x = page(pg)
            spans += [(x[2 * i], x[2 * i + 1]) for i in range(4)]
        j = page(138)
        sp = page(139)
    finally:
        for k in held:
            link.out.send(mido.Message("note_off", note=k))
    print_blocktime(w, spans, j, sp, patch, held)
    if out:
        with open(out, "w") as f:
            json.dump({"patch": patch, "notes": held, "seconds": secs, "page132": w, "page138": j, "page139": sp,
                       "spans_ns": {BT_SPANS[i][0]: {"mean": m, "max": x} for i, (m, x) in enumerate(spans[:len(BT_SPANS)])}},
                      f, indent=1)
        print(f"raw values: {out}")


def t5parts(link, a):
    """DIAG page 177 (main.c fm1_timer5_irq, fm1_timer2_irq): TIMER5's parts over one window of SECONDS"""
    secs = float(a[0]) if a else 3.0
    first = diag_words(link, 177)
    if len(first) < 8:
        sys.exit("no TIMER5 page (a firmware from before #803's split)")
    t = time.monotonic()
    time.sleep(secs)
    w = diag_words(link, 177)
    span = (time.monotonic() - t) * 24e6                # TIMER4 ticks (24 MHz), from the host's clock
    ns = lambda ticks: ticks * 125 / 3
    n, scan, un, usb, b, bn = w[0], w[1], w[2], w[3], w[4], w[7]
    dn, dsum = (w[5] - first[5]) & 0xFFFFFFFF, (w[6] - first[6]) & 0xFFFFFFFF
    if not n:
        sys.exit("no TIMER5 interrupts in the window")
    print(f"window {secs:.1f} s: {n} TIMER5 interrupts ({n / secs:.0f} a second)")
    print(f"  the LED and key scan in TIMER5: mean {ns(scan) / n / 1000:.2f} us a tick; {100 * scan / span:.2f} % of core 0")
    if bn:
        print(f"  the split pulses' ends (TIMER2): {bn}, mean {ns(b) / bn / 1000:.2f} us each; {100 * b / span:.2f} % of core 0")
    print(f"  the scan in all: {100 * (scan + b) / span:.2f} % of core 0, {ns(scan + b) / n / 1000:.2f} us a tick")
    if un:
        print(f"  the USB / MIDI polls: {un}, mean {ns(usb) / un / 1000:.2f} us each; {100 * usb / span:.2f} % of core 0")
    if dn:
        print(f"  dim pulses: {dn} ({dn / n:.2f} a tick), mean {ns(dsum) / dn / 1000:.2f} us")


FPU_PAGE = 178        # firmware/src/bench.c BENCH_PAGE


def fpubench_read(link):
    """DIAG page 178 runs the benchmark (bench.c bench_diag): the build and the clock probe; pages 179.. its kernels"""
    import struct
    p = link.ask(frame(0x2B, [FPU_PAGE]), (0x4B, FPU_PAGE), tries=1, wait=30.0)
    if len(p) < 33:
        sys.exit("no CPU benchmark (DIAG page 178): install a build with M1_BENCH=1 (CI: the fpu-measure job's artifact)")
    ver, nk, fpu, n, runs, adds1, adds2, pll = [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(8)]
    if adds2 <= adds1:
        sys.exit("the clock probe timed no adds")
    r = {"version": ver, "fpu": fpu, "frames": n, "runs": runs, "pll2_con1": pll,
         "cycles_per_tick": 32768 / (adds2 - adds1), "kernels": []}   # 32768 dependent adds, one a CPU cycle
    for k in range(nk):
        q = link.ask(frame(0x2B, [FPU_PAGE + 1 + k]), (0x4B, FPU_PAGE + 1 + k))
        if len(q) < 33:
            sys.exit(f"DIAG page {FPU_PAGE + 1 + k}: no kernel {k}")
        lo, hi, res = [int.from_bytes(bytes(q[1 + 4 * i:5 + 4 * i]), "little") for i in range(3)]
        r["kernels"].append({"name": bytes(q[14:33]).split(b"\0")[0].decode(), "ops": q[13], "ticks_min": lo,
                             "ticks_max": hi, "result": f"{res:08x}",
                             "result_f32": struct.unpack("<f", res.to_bytes(4, "little"))[0]})
    return r


def print_fpubench(r, out=print):
    """cycles per sample of each kernel's fastest run; less the block loop (the first kernel); per chained operation"""
    c, n = r["cycles_per_tick"], r["frames"]
    cyc = lambda ticks: ticks * c / n
    base = cyc(r["kernels"][0]["ticks_min"])
    out(f"build: {'FPU' if r['fpu'] else 'software float (#950)'}; CPU {c * 24:.0f} MHz (timed adds); "
        f"{n} frames a block, the fastest of {r['runs']} runs")
    out(f"{'kernel':<20} {'cyc/sample':>10} {'less loop':>10} {'per op':>8} {'slowest':>8}  result")
    for k in r["kernels"]:
        net = cyc(k["ticks_min"]) - base
        out(f"{k['name']:<20} {cyc(k['ticks_min']):10.1f} {net:10.1f} {net / k['ops']:8.1f} {cyc(k['ticks_max']):8.1f}  "
            f"{k['result']} ({k['result_f32']:.7g})")


def fpubench(link, a):
    import json
    r = fpubench_read(link)
    print_fpubench(r)
    if "--json" in a:
        with open(a[a.index("--json") + 1], "w") as f:
            json.dump(r, f, indent=1)
        print(f"raw values: {a[a.index('--json') + 1]}")


FPU_CASES = ("filter osc drive", "filter lp12", "ladder stsat fm", "ladder diode", "formant", "resonator", "reverb")


def fpucheck(link, a):
    """DIAG page 140 runs main.c fpu_check (core 0 32 times, then core 1); 141 and 142 read the two cores' hashes"""
    import json, os, subprocess
    p = link.ask(frame(0x2B, [140]), (0x4B, 140), tries=1, wait=10.0)
    if len(p) < 33:
        sys.exit("no float check page (DIAG 140): a firmware from before #979's filters")
    w = [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range(8)]
    nc, runs, diff, c1, t1, t0, odd, stack = w
    hashes = []
    for page in (141, 142):
        q = link.ask(frame(0x2B, [page]), (0x4B, page))
        hashes.append([int.from_bytes(bytes(q[1 + 4 * i:5 + 4 * i]), "little") for i in range(nc)])
    host = None
    probe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "fpu_probe")
    if os.path.exists(probe):
        host = [int(x, 16) for x in subprocess.run([probe], capture_output=True, text=True).stdout.split()]   # (exit 1: differs from its EXPECT)
    ran = c1 & 7 == 7
    print(f"core 0: {runs} runs from the main loop, {diff} case hashes differing from the first run's; one run {t0} us")
    print(f"core 1: {'ran' if ran else 'did not run'} (on {c1 & 1}, job taken {(c1 >> 1) & 1}, back in time {(c1 >> 2) & 1}); "
          f"{t1} us with the hand-off; its stack {stack} B used at most")
    print(f"{'case':<18} {'core 0':>8} {'core 1':>8} {'host':>8}")
    bad = diff != 0 or not ran or odd != 0
    for c in range(nc):
        h = f"{host[c]:08x}" if host else "-"
        bad = bad or (host is not None and host[c] != hashes[0][c])
        print(f"{FPU_CASES[c] if c < len(FPU_CASES) else c:<18} {hashes[0][c]:08x} {hashes[1][c]:08x} {h:>8}")
    print("all equal" if not bad else "DIFFERENT (or core 1 did not run)")
    if "--json" in a:
        with open(a[a.index("--json") + 1], "w") as f:
            json.dump({"runs": runs, "core0_runs_differing": diff, "core1": c1, "core1_us": t1, "core0_us": t0,
                       "core1_stack": stack, "core0": [f"{x:08x}" for x in hashes[0]],
                       "core1": [f"{x:08x}" for x in hashes[1]], "host": [f"{x:08x}" for x in host] if host else None,
                       "cases": list(FPU_CASES)}, f, indent=1)
    if bad:
        sys.exit(1)


def modtime(link, a):
    """DIAG pages 144..176 (main.c m1_diag, modular.c mt_sum): each module's mean time a half over one window of SECONDS,
    on core 0's lane and on core 1's, optionally on a factory patch with notes held"""
    import json
    secs, held, patch, out = window_args(a)
    page = lambda n: diag_words(link, n)
    first = page(144)
    if len(first) < 8:
        sys.exit("no module-time pages (a firmware from before #802's per-module timing)")
    if first[2]:                                       # (a window left running: end it, then start afresh)
        page(144)
    if patch:
        load_factory(link, patch)
    try:
        for k in held:
            link.out.send(mido.Message("note_on", note=k, velocity=100))
        time.sleep(1.0 if held else 0.1)
        page(144)                                      # the window starts here
        time.sleep(secs)
        w = page(144)
        nmod = w[1]
        rows = []
        for pg in range(145, 145 + (nmod + 3) // 4):
            x = page(pg)
            rows += [(x[2 * i], x[2 * i + 1]) for i in range(4)]
        rows = rows[:nmod]
    finally:
        for k in held:
            link.out.send(mido.Message("note_off", note=k))
    print(f"{patch or 'the running patch'}, {len(held)} notes held; {w[0]} halves counted, {nmod} modules")
    print(f"{'module':>6} {'core 0 us':>10} {'core 1 us':>10}")
    for m, (c0, c1) in enumerate(rows):
        if c0 or c1:
            print(f"{m:6} {c0 / 1000:10.1f} {c1 / 1000:10.1f}")
    print(f"{'sum':>6} {sum(r[0] for r in rows) / 1000:10.1f} {sum(r[1] for r in rows) / 1000:10.1f}")
    if out:
        with open(out, "w") as f:
            json.dump({"patch": patch, "notes": held, "seconds": secs, "halves": w[0],
                       "modules_ns": [{"core0": c0, "core1": c1} for c0, c1 in rows]}, f, indent=1)
        print(f"raw values: {out}")


def print_blocktime(w, spans, j, sp, patch, held):
    """main.c m1_diag pages 132..139"""
    us = lambda ns: f"{ns / 1000:8.1f}"
    f = w[7]
    blocks = w[0]
    print(f"{patch or 'the running patch'}, {len(held)} notes held; window {w[2]} ms: {blocks} halves counted, "
          f"{w[1]} with the engine stopped{'; THE WINDOW FILLED (read sooner)' if f >> 3 & 1 else ''}")
    print(f"{'2 cores' if f & 1 else '1 core'}, split {'OFF' if f >> 1 & 1 else 'on'}, "
          f"USB audio {'streaming' if f >> 2 & 1 else 'not streaming'}")
    if not blocks:
        print("no halves rendered in the window")
        return
    print(f"{'per half (us)':68} {'mean':>8} {'most':>8}")
    for i, (name, what) in enumerate(BT_SPANS):
        if name == "isr":
            parts = sum(m for m, _ in spans[:11])
            print(f"  {'(the eleven spans above, summed)':66} {us(parts)}")
        if name == "hand":
            print("the second core:")
        m, x = spans[i]
        print(f"  {what:66} {us(m)} {us(x)}")
    fixed = spans[11][0] - spans[3][0]
    print(f"  the audio ISR less the voices (the fixed part, TIMER5 nested included): {fixed / 1000:.1f} us mean")
    jobs = w[3]
    print(f"jobs {jobs} ({jobs / blocks:.2f} a half, at most {f >> 8 & 0xFF}), hand-offs not taken {w[6]}, "
          f"waits that gave core 1 up {f >> 16}")
    if jobs:
        print(f"  awake parts per job: core 0 {w[4] / jobs:.2f}, core 1 {w[5] / jobs:.2f} (in all, core 0 {w[4]}, core 1 {w[5]})")
        print(f"  a job on core 1: mean {j[6] / 1000:.1f} us, most {j[7] / 1000:.1f} us; its hand-off (core 0 starting it to "
              f"core 1 starting it): mean {j[0] / 1000:.2f} us, most {j[1] / 1000:.2f} us")
    print(f"TIMER5: {j[4]} interrupts nested in the audio ISR, {j[5]} outside it ({(j[4] + j[5]) / blocks:.1f} a half); "
          f"each (its C body) mean {j[2] / 1000:.2f} us, most {j[3] / 1000:.2f} us")
    reads, step, nint, tot, body, nbody, naud, smax = sp
    print(f"page 139 (5 ms of back-to-back TIMER4 reads): {reads} reads, the shortest step {step} ns (about one mark's "
          f"cost); {nint} interrupts outside the audio ISR took {tot / 1000:.1f} us in all, their C bodies "
          f"{body / 1000:.1f} us ({nbody} counted); {naud} audio ISRs skipped; the longest {smax / 1000:.2f} us")
    if nint and nint == nbody:
        print(f"  entry + exit per interrupt (the assembly wrapper, the jump, the caches after it): "
              f"{(tot - body - nint * step) / nint / 1000:.2f} us")
    elif nint:
        print(f"  (steps {nint} vs TIMER5 bodies {nbody}: another interrupt or a nesting in the spin; no per-interrupt figure)")


UT_NAMES = ["whole screen", "top bar / header", "knob click (its bars)", "page reached (SELECT / ALGO / PRESET)",
            "PRESET toast shown", "toast gone (page put back)"]


def print_uitime(pages):
    """main.c m1_diag pages 121..123 (ui.c ui_time_diag): the last, the worst and the count of each kind of draw, in us"""
    if any(len(p) < 2 for p in pages):
        sys.exit("this firmware does not report draw times (DIAG pages 121..123)")
    last, worst, n = ([int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range((len(p) - 1) // 4)] for p in pages)
    print(f"{'draw':40} {'last ms':>8} {'worst ms':>9} {'count':>6}")
    for i, name in enumerate(UT_NAMES[:len(last)]):
        print(f"{name:40} {last[i] / 1000:8.1f} {worst[i] / 1000:9.1f} {n[i]:6}")


def print_uac(w):
    """main.c m1_diag pages 125 + 126 (usb.c uac)"""
    f = w[0]
    flags = [n for b, n in enumerate(("presented", "alt 1", "host reads", "primed", "configured")) if f >> b & 1]
    lo, hi = w[14], w[15]
    band = "none yet" if lo == 0xFFFFFFFF else f"{lo}..{hi}"
    print(f"usb audio: {', '.join(flags) or 'off'}; streams {w[1]}, packets {w[2]}, frames {w[3]}, SET_CUR {w[4]}, "
          f"bus resets {w[5]}, USB frame {w[7]}")
    print(f"  underruns {w[8]}, overruns {w[9]}, missed {w[10]}, stalls {w[11]}, adj_up {w[12]}, adj_down {w[13]}, "
          f"fill now {w[6]}, fill min..max {band} (band 160..208)")


STD_REQ = {0: "GET_STATUS", 1: "CLEAR_FEATURE", 3: "SET_FEATURE", 5: "SET_ADDRESS", 6: "GET_DESCRIPTOR",
           7: "SET_DESCRIPTOR", 8: "GET_CONFIGURATION", 9: "SET_CONFIGURATION", 10: "GET_INTERFACE", 11: "SET_INTERFACE",
           12: "SYNCH_FRAME"}
DESC = {1: "DEVICE", 2: "CONFIG", 3: "STRING", 4: "INTERFACE", 5: "ENDPOINT", 6: "DEVICE_QUALIFIER",
        7: "OTHER_SPEED_CONFIG", 8: "INTERFACE_POWER", 9: "OTG", 10: "DEBUG", 11: "IAD", 15: "BOS", 0x21: "HID",
        0x22: "HID_REPORT", 0x24: "CS_INTERFACE", 0x25: "CS_ENDPOINT"}
AUDIO_REQ = {0x01: "SET_CUR", 0x02: "SET_MIN", 0x03: "SET_MAX", 0x04: "SET_RES", 0x81: "GET_CUR", 0x82: "GET_MIN",
             0x83: "GET_MAX", 0x84: "GET_RES", 0xFF: "GET_STAT"}
CDC_REQ = {0x20: "SET_LINE_CODING", 0x21: "GET_LINE_CODING", 0x22: "SET_CONTROL_LINE_STATE", 0x23: "SEND_BREAK"}
OUTCOME = ["PENDING (no answer yet)", "ACK", "IN", "OUT", "STALL", "STALL (unknown request)"]


def usb_request(s):
    """a SETUP packet (8 bytes) in words: GET_DESCRIPTOR(CONFIG len 255), SET_CUR(EP 0x84 SAMPLING_FREQ), ..."""
    rt, rq, val, idx, ln = s[0], s[1], s[2] | s[3] << 8, s[4] | s[5] << 8, s[6] | s[7] << 8
    kind, rcp = rt >> 5 & 3, rt & 31
    to = ["", f" IF {idx & 0xFF}", f" EP {idx & 0xFF:#04x}", " OTHER"][rcp] if rcp < 4 else f" recipient {rcp}"
    if kind == 0:
        name = STD_REQ.get(rq, f"standard request {rq:#04x}")
        if rq == 6 or rq == 7:
            t, i = val >> 8, val & 0xFF
            d = DESC.get(t, f"type {t:#04x}")
            if t == 3:
                d += f" {i}" + (f" lang {idx:#06x}" if idx else "")
            elif i:
                d += f" {i}"
            return f"{name}({d} len {ln})" + (to if rcp else "")
        if rq == 5:
            return f"SET_ADDRESS {val}"
        if rq == 9:
            return f"SET_CONFIGURATION {val}"
        if rq == 11:
            return f"SET_INTERFACE IF {idx} alt {val}"
        if rq == 10:
            return f"GET_INTERFACE IF {idx}"
        if rq in (1, 3):
            feat = {0: "ENDPOINT_HALT" if rcp == 2 else "feature 0", 1: "DEVICE_REMOTE_WAKEUP", 2: "TEST_MODE"}.get(val, f"feature {val}")
            return f"{name}({feat}){to}"
        return f"{name}{to}" + (f" len {ln}" if ln else "")
    if kind == 1:
        if rq in CDC_REQ:
            return f"CDC {CDC_REQ[rq]}{to} wValue {val:#06x} len {ln}"
        name = AUDIO_REQ.get(rq, f"class request {rq:#04x}")
        if rcp == 2:
            cs = {1: "SAMPLING_FREQ", 2: "PITCH"}.get(val >> 8, f"control {val >> 8}")
            return f"audio {name}(EP {idx & 0xFF:#04x} {cs}) len {ln}"
        if rcp == 1:
            return f"audio {name}(IF {idx & 0xFF} entity {idx >> 8} control {val >> 8} ch {val & 0xFF}) len {ln}"
        return f"class {name}{to} wValue {val:#06x} wIndex {idx:#06x} len {ln}"
    return (f"{'VENDOR' if kind == 2 else 'RESERVED'} request {rq:#04x} ({'IN' if rt & 0x80 else 'OUT'}{to}) "
            f"wValue {val:#06x} wIndex {idx:#06x} len {ln}")


def print_usblog(st, ct, ents, first, last, moved):
    """main.c m1_diag pages 104, 105 and 40.. (usb.c ul, ul_ring, #535)"""
    n, base, oneshot, size, now = st[0], st[1], st[2] & 0xFF, st[2] >> 8 & 0xFFFF, st[3]
    flags = st[7]
    print(f"USB setup log: {n} entries since boot, {size} kept "
          + (f"(one-shot capture from entry {base}: {max(0, n - base - size)} not kept)" if oneshot else "(the newest)")
          + f"; FM-1 up {now / 1000:.1f} s")
    print(f"  now: {'configured' if flags & 1 else 'not configured'}{', suspended' if flags & 2 else ''}"
          f"{'' if flags & 4 else ', SIE off'}, address {flags >> 8 & 0xFF}; bus resets {st[4]}, suspends {st[5]}, "
          f"SETUPs {st[6]}, SIE restarts {flags >> 16}")
    print(f"  unknown requests {ct[0]}, stalls answered {ct[1]}, STALL handshakes {ct[2]} ({ct[3]} with a SETUP waiting), "
          f"SetupEnd {ct[4]}, status stages {ct[5]}, OUT data stages {ct[6]}, SIE timeouts {ct[7]}")
    if moved:
        print("  (the log grew while it was read: the newest entries may be mixed)")
    prev = None
    for k in range(first, last):
        e = ents[k]
        t, kind, a, cnt, s = int.from_bytes(bytes(e[0:4]), "little"), e[4], e[5], e[6] | e[7] << 8, e[8:16]
        dt = "" if prev is None else f"+{(t - prev) & 0xFFFFFFFF}"
        prev = t
        rep = ""
        if kind != 1 and cnt:
            t2 = int.from_bytes(bytes(s[4:8]), "little")
            rep = f"  x{cnt + 1}, the last at {t2 / 1000:.3f} s"
            prev = t2
        head = f"{k:6} {t / 1000:10.3f} {dt:>8}  "
        if kind == 1:
            o = a & 7
            ln = s[6] | s[7] << 8
            out = OUTCOME[o] if o < len(OUTCOME) else f"outcome {o}"
            if o == 2:
                out = f"IN {cnt} B" + (" (short)" if cnt < ln else "") + (" +ZLP" if a & 0x40 else "") + \
                      ("" if a & 0x08 else " (not all loaded)")
            elif o == 3:
                out = f"OUT {cnt} B received" if cnt else "OUT data stage awaited"
            notes = [x for b, x in ((0x10, "status done"), (0x20, "ABORTED by the host (SetupEnd)"),
                                    (0x80, "STALL handshake sent")) if a & b]
            print(head + f"{usb_request(s):58} -> {out}" + (f"; {', '.join(notes)}" if notes else "") + rep)
        elif kind == 2:
            print(head + f"BUS RESET (POWER {s[0]:#04x}; ends configuration {s[1]}, "
                  f"address {s[2]})" + rep)
        elif kind == 3:
            print(head + f"SUSPEND (configuration {a})" + rep)
        elif kind == 4:
            print(head + f"RESUME (configuration {a})" + rep)
        elif kind == 5:
            print(head + f"ADDRESS {a} takes effect (POWER {s[0]:#04x})" + rep)
        elif kind == 6:
            left = s[1] | s[2] << 8
            print(head + f"SETUP_END: the host ended the transfer (CSR0 {a:#04x}"
                  + (f", {left} B of IN data not yet loaded)" if s[0] else ")") + rep)
        elif kind == 7:
            print(head + f"STALL HANDSHAKE SENT WITH A SETUP WAITING (CSR0 {a:#04x}): that SETUP is left unanswered" + rep)
        elif kind == 8:
            print(head + f"EP0 status interrupt with no transfer (CSR0 {a:#04x})" + rep)
        elif kind == 9:
            print(head + (f"USB START: the SIE answers" if a else f"USB START FAILED ({s[0]} SIE timeouts)") + rep)
        elif kind == 10:
            print(head + f"SIE STOPPED ANSWERING (register {a}): USB off until the retry" + rep)
        elif kind == 11:
            print(head + f"frame number frozen at {s[0] | s[1] << 8} for 100 ms (unplugged / host asleep)" + rep)
        elif kind == 12:
            print(head + f"frame number moves again ({s[0] | s[1] << 8})" + rep)
        elif kind == 13:
            print(head + "DETACH (update)" + rep)
        elif kind == 14:
            print(head + f"PRESENTATION: {'console' if s[0] else 'audio function'} {'on' if a else 'off'} (re-enumerates)" + rep)
        else:
            print(head + f"event {kind} a {a:#04x} n {cnt} {bytes(s).hex()}")


def print_diag(raw, dis_path):
    """main.c diag_prev: p3, src, wdt; the stall record (magic, stall_ms, n, pc[24], rets[24]); fm1_crash_t"""
    w = [int.from_bytes(bytes(raw[i:i + 4]), "little") for i in range(0, len(raw) - 3, 4)]
    funcs = []
    if dis_path:                                 # llvm-objdump: a "name:" line, then " addr:  bytes  insn"
        cur = None
        for line in open(dis_path):
            m = re.match(r"^([A-Za-z_.$][\w.$]*):\s*$", line)
            if m:
                cur = m.group(1)
                continue
            m = re.match(r"^\s*([0-9a-f]+):", line)
            if m and cur:
                funcs.append((int(m.group(1), 16), cur))
                cur = None
        funcs.sort()
    def where(a):
        f = next((n for s, n in reversed(funcs) if s <= a), None) if funcs else None
        return f"{a:#010x}" + (f" {f}+{a - next(s for s, n in reversed(funcs) if s <= a):#x}" if f else "")
    p3, src, wdt = w[0], w[1], w[2]
    causes = [n for b, n in enumerate(["power-on", "VDDIO low", "watchdog", "VCM", "long press", "1.2 V", "soft (P33)"]) if p3 >> b & 1]
    print(f"last reset: P3_RST_SRC {p3:#04x} ({', '.join(causes) or 'none'}), RST_SRC {src:#x}, WDT_CON {wdt:#04x}")
    S = 24
    magic, stall_ms, n = w[3], w[4], w[5]
    pcs, rets = w[6:6 + S], w[6 + S:6 + 2 * S]
    if magic == 0x44494147 and n:
        print(f"stall: the main loop's last pass at {stall_ms} ms, {n} samples (every 250 ms from 1.5 s on):")
        for i in range(min(n, S)):
            print(f"  pc {where(pcs[i])}   rets {where(rets[i])}")
    else:
        print("stall: none recorded")
    c = w[6 + 2 * S:]
    if len(c) >= 11 and c[0] == 0x43525348:
        print(f"crash #{c[1]}: vector {c[2]}, pc {where(c[3])}, rets {where(c[4])}, sp {c[7]:#x}, uptime {c[10]} ms, "
              f"emu {c[5]:#x} dbg {c[6]:#x}")
        print("  last branches (ETM): " + ", ".join(where(x) for x in c[11:15]))
    else:
        print("crash: none recorded")


if __name__ == "__main__":
    main()
