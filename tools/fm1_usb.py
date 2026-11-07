#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Which USB socket an FM-1's MIDI ports belong to, on macOS (#698): the test rig is pinned by its USB location.

Two FM-1s on one Mac carry the same port name ("Matryoshka", and "Felucca Update" in update mode) and no USB serial
number, so a name cannot tell them apart. The USB location ID can: it names the socket (the USB bus and the hub ports on
the way), not the device, and macOS's own MIDI driver keys its devices by it. An FM-1 that restarts into its update
loader comes back at the same location (seen on the rig, 2026-11-06: CoreMIDI's devices "Matryoshka" and
"Felucca Update" both at 0x01130000). CoreAudio's id of its USB audio input carries the same number
(AppleUSBAudioEngine:<maker>:<product>:<location in hex>:<interfaces>, tools/fm1_rec.swift).

  fm1_usb.py list [--json]              the USB MIDI devices CoreMIDI has online, with their locations
  fm1_usb.py mark --location HEX        the values of the test rig's mark on the FM-1 at that location (JSON: a list,
                                        or null when it has none); sends only HELLO and PRESET_GET, which change nothing

LocatedBackend(location) is fm1_install.py's MIDI backend for one location (--location, --rig): it lists and opens only
the ports of the device at that USB location, so the installer cannot see, let alone write, any other FM-1. Ports are
opened by index with python-rtmidi (whose port i is CoreMIDI's source / destination i on macOS), and the index is checked
against CoreMIDI before and after the open. Needs macOS and python-rtmidi.
"""
import ctypes
import ctypes.util
import json
import queue
import sys
import time

# the editor protocol (web/src/protocol.ts): the rig's mark is a preset of RIG_STRUCTURE named RIG_PRESET
PREFIX = bytes([0x7D, 0x4D, 0x31])
C_HELLO, C_PRESET_GET, R_INFO, R_PRESET_DATA = 0x01, 0x2E, 0x41, 0x4D
RIG_STRUCTURE, RIG_PRESET = 0x7E57417E, "MATRYOSHKA RIG"
FM1_NAME = ("fm-1", "felucca", "matryoshka", "modular", "ota", "composite", "sinco", "usb-midi")   # fm1_install.py PORT_RE


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
        if nb >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nb -= 8
    return bytes(out)


def frame(cmd, payload=b""):
    return b"\xF0" + PREFIX + bytes([cmd]) + pack7(payload) + b"\xF7"


def preset_get_frame():
    name = RIG_PRESET.encode("ascii")[:16].ljust(16, b"\0")
    return frame(C_PRESET_GET, RIG_STRUCTURE.to_bytes(4, "little") + name)


def parse_preset_data(pkt):
    """the values of a PRESET_DATA for the rig's mark ([] when the FM-1 has none), or None: not that answer"""
    if len(pkt) < 6 or pkt[0] != 0xF0 or pkt[-1] != 0xF7 or pkt[1:4] != PREFIX or pkt[4] != R_PRESET_DATA:
        return None
    p = unpack7(pkt[5:-1])
    if len(p) < 21 or int.from_bytes(p[0:4], "little") != RIG_STRUCTURE:
        return None
    n = p[20]
    if n == 0xFF:
        return []
    if len(p) < 21 + 4 * n:
        return None
    return [int.from_bytes(p[21 + 4 * k:25 + 4 * k], "little", signed=True) / 65536 for k in range(n)]


def read_mark(link, tries=3, wait=1.5):
    """the rig's mark on the FM-1 behind `link` (an fm1_install.py link: send / read / drain): its values, [] when it has
    none, None when it does not answer (not running Matryoshka, or in update mode)"""
    for _ in range(tries):
        link.drain()
        if not link.send(preset_get_frame()):
            return None
        end = time.monotonic() + wait
        while (left := end - time.monotonic()) > 0:
            pkt = link.read(left)
            if pkt is None:
                break
            v = parse_preset_data(pkt)
            if v is not None:
                return v
    return None


def same_mark(a, b):
    """as web/scripts/rig-link.mjs sameMark"""
    return bool(a) and bool(b) and len(a) == len(b) and all(round(x) == round(y) for x, y in zip(a, b))


def location_text(loc):
    return f"0x{loc:08x}"


def parse_location(s):
    """'0x01130000', '01130000' or '1130000' (as CoreAudio writes it) -> 0x01130000"""
    v = int(str(s), 16)
    if not 0 < v <= 0xFFFFFFFF:
        raise ValueError(f"not a USB location: {s!r}")
    return v


# ------------------------------------------------------------- CoreMIDI ---

class CoreMidi:
    """CoreMIDI through ctypes: each source's and destination's name, unique id and USB location (None: not a USB device)"""

    def __init__(self):
        path = ctypes.util.find_library("CoreMIDI")
        cf = ctypes.util.find_library("CoreFoundation")
        if not path or not cf:
            raise OSError("CoreMIDI is not available (the rig's USB location needs macOS)")
        self.cm, self.cf = ctypes.cdll.LoadLibrary(path), ctypes.cdll.LoadLibrary(cf)
        cm, u32 = self.cm, ctypes.c_uint32
        cm.MIDIGetNumberOfSources.restype = cm.MIDIGetNumberOfDestinations.restype = ctypes.c_ulong
        cm.MIDIGetSource.restype = cm.MIDIGetDestination.restype = u32
        cm.MIDIGetSource.argtypes = cm.MIDIGetDestination.argtypes = [ctypes.c_ulong]
        cm.MIDIEndpointGetEntity.argtypes = [u32, ctypes.POINTER(u32)]
        cm.MIDIEntityGetDevice.argtypes = [u32, ctypes.POINTER(u32)]
        cm.MIDIObjectGetIntegerProperty.argtypes = [u32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int32)]
        cm.MIDIObjectGetStringProperty.argtypes = [u32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        self.cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        self.cf.CFRelease.argtypes = [ctypes.c_void_p]
        self.cf.CFStringCreateWithCString.restype = ctypes.c_void_p
        self.cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        # the property keys by their values ("USBLocationID", set by Apple's USB MIDI driver on each device, has no exported
        # constant; the exported ones read back empty through ctypes)
        key = lambda n: self.cf.CFStringCreateWithCString(None, n, 0x08000100)
        self.k_name, self.k_uid, self.k_offline, self.k_loc = key(b"name"), key(b"uniqueID"), key(b"offline"), key(b"USBLocationID")

    def _int(self, obj, k):
        v = ctypes.c_int32()
        return v.value if self.cm.MIDIObjectGetIntegerProperty(obj, k, ctypes.byref(v)) == 0 else None

    def _str(self, obj, k):
        s = ctypes.c_void_p()
        if self.cm.MIDIObjectGetStringProperty(obj, k, ctypes.byref(s)) != 0 or not s.value:
            return None
        buf = ctypes.create_string_buffer(512)
        ok = self.cf.CFStringGetCString(s, buf, 512, 0x08000100)   # (kCFStringEncodingUTF8)
        self.cf.CFRelease(s)
        return buf.value.decode("utf-8", "replace") if ok else None

    def _endpoint(self, ep):
        ent, dev = ctypes.c_uint32(), ctypes.c_uint32()
        loc = dname = None
        if self.cm.MIDIEndpointGetEntity(ep, ctypes.byref(ent)) == 0 and ent.value and \
                self.cm.MIDIEntityGetDevice(ent.value, ctypes.byref(dev)) == 0 and dev.value:
            loc = self._int(dev.value, self.k_loc)
            dname = self._str(dev.value, self.k_name)
        return {"name": self._str(ep, self.k_name), "device": dname, "uid": self._int(ep, self.k_uid),
                "location": (loc & 0xFFFFFFFF) if loc else None, "offline": bool(self._int(ep, self.k_offline))}

    def endpoints(self, kind):
        """'in' (sources) or 'out' (destinations), in CoreMIDI's order (python-rtmidi's port order on macOS)"""
        n = self.cm.MIDIGetNumberOfSources() if kind == "in" else self.cm.MIDIGetNumberOfDestinations()
        get = self.cm.MIDIGetSource if kind == "in" else self.cm.MIDIGetDestination
        return [self._endpoint(get(i)) for i in range(n)]


def usb_devices(cm=None):
    """the USB MIDI devices online now: [{location, device, inputs, outputs}] (port names), by location"""
    cm = cm or CoreMidi()
    out = {}
    for kind, key in (("in", "inputs"), ("out", "outputs")):
        for e in cm.endpoints(kind):
            if e["location"] is None or e["offline"]:
                continue
            d = out.setdefault(e["location"], {"location": location_text(e["location"]), "device": e["device"], "inputs": [], "outputs": []})
            d[key].append(e["name"])
    return list(out.values())


def fm1_like(d):
    text = " ".join([d.get("device") or "", *d["inputs"], *d["outputs"]]).lower()
    return any(k in text for k in FM1_NAME)


# --------------------------------------------------- the located backend ---

class RtLink:
    """one MIDI in / out pair opened by index (python-rtmidi), as fm1_install.py's MidoLink: a SysEx queue"""

    def __init__(self, backend, name, midi_in, midi_out):
        self.backend, self.name, self.inp, self.out = backend, name, midi_in, midi_out
        self.q = queue.Queue()
        midi_in.ignore_types(sysex=False, timing=True, active_sense=True)
        midi_in.set_callback(self._rx)

    def _rx(self, event, _data=None):
        msg = event[0]
        if msg and msg[0] == 0xF0 and msg[-1] == 0xF7:
            self.q.put(bytes(msg))

    @property
    def lost(self):
        return self.name not in self.backend.input_names()

    def send(self, pkt):
        try:
            self.out.send_message(list(pkt))
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
                p.close_port()
            except Exception:
                pass


class LocatedBackend:
    """fm1_install.py's backend restricted to the device at one USB location: input_names / output_names list only its
    ports, open() opens only those. `cm` (CoreMidi) and `rtmidi` (the module) are the tests' stand-ins."""

    def __init__(self, location, cm=None, rtmidi=None, delay=0.3):
        if rtmidi is None:
            import rtmidi as rt   # (python-rtmidi, which mido uses)
            rtmidi = rt
        self.location, self.rtmidi, self.delay = location, rtmidi, delay
        self.cm = cm or CoreMidi()

    def _ports(self, kind):
        """[(index, name, uid)] of this location's ports; CoreMIDI and rtmidi must agree on the count, which they do unless
        a device came or went between the two reads (then once more)"""
        for _ in range(3):
            probe = self.rtmidi.MidiIn() if kind == "in" else self.rtmidi.MidiOut()
            eps = self.cm.endpoints(kind)
            names = probe.get_ports()
            try:
                probe.delete()
            except Exception:
                pass
            if len(names) == len(eps):
                return [(i, names[i], e["uid"]) for i, e in enumerate(eps) if e["location"] == self.location and not e["offline"]]
            time.sleep(0.2)
        raise OSError("CoreMIDI's ports kept changing while they were listed")

    def input_names(self):
        return list(dict.fromkeys(n for _, n, _ in self._ports("in")))

    def output_names(self):
        return list(dict.fromkeys(n for _, n, _ in self._ports("out")))

    def _open(self, kind, name):
        mine = [(i, uid) for i, n, uid in self._ports(kind) if n == name]
        if len(mine) != 1:
            raise OSError(f"{len(mine)} {kind}put ports named {name!r} at USB location {location_text(self.location)}")
        i, uid = mine[0]
        port = self.rtmidi.MidiIn() if kind == "in" else self.rtmidi.MidiOut()
        port.open_port(i)
        # (the same endpoint at the same index after the open: nothing came or went in between)
        after = self.cm.endpoints(kind)
        if i >= len(after) or after[i]["uid"] != uid or after[i]["location"] != self.location:
            port.close_port()
            raise OSError("the MIDI ports changed while one was opened")
        return port

    def open(self, in_name, out_name):
        midi_in = self._open("in", in_name)
        try:
            midi_out = self._open("out", out_name)
        except Exception:
            midi_in.close_port()
            raise
        time.sleep(self.delay)   # CoreMIDI may drop a message sent just after opening
        return RtLink(self, in_name, midi_in, midi_out)


def mark_at(location, backend=None):
    """the rig's mark on the FM-1 at `location`: its values ([] none), or None when no running Matryoshka answers there"""
    be = backend or LocatedBackend(location)
    ins, outs = be.input_names(), be.output_names()
    for name in ins:
        out = name if name in outs else (outs[0] if len(outs) == 1 else None)
        if not out:
            continue
        link = be.open(name, out)
        try:
            v = read_mark(link)
            if v is not None:
                return v
        finally:
            link.close()
    return None


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["list", "mark"])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--location", metavar="HEX")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "list":
            ds = usb_devices()
            for d in ds:
                d["fm1"] = fm1_like(d)
            if a.json:
                print(json.dumps(ds))
            else:
                for d in ds:
                    print(f"{d['location']}  {'FM-1 ' if d['fm1'] else '     '} {d['device']}  in: {', '.join(d['inputs']) or '-'}  out: {', '.join(d['outputs']) or '-'}")
            return 0
        if not a.location:
            ap.error("mark needs --location")
        print(json.dumps(mark_at(parse_location(a.location))))
        return 0
    except (OSError, ValueError, ImportError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
