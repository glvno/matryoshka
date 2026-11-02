#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 morgulbrut
"""Talk to the Matryoshka firmware over USB-MIDI SysEx (protocol: web/src/protocol.ts), without the browser.

  tools/m1_link.py info
  tools/m1_link.py upload PATCH.m1p       (binary patches: build/golden/*.m1p from tools/golden.sh)
  tools/m1_link.py store
  tools/m1_link.py bank                   (write the factory presets from firmware/src/presets.h into the flash bank)
  tools/m1_link.py bank-info              (list the bank slots on the FM-1)
  tools/m1_link.py bank-clear             (empty the bank: the next boot writes the factory patches again)
  tools/m1_link.py param MODULE PARAM VALUE     (module / parameter index, value as a float)
  tools/m1_link.py note 60 [seconds]
  tools/m1_link.py program N              (factory patch N, MIDI program change)
  tools/m1_link.py cpu                    (the audio ISR's load: now, and the peak since the last cpu read)
  tools/m1_link.py uac [SECONDS]          (the USB audio stream: state, glitch counters, rate adjustments, the ring's fill
                                           range; SECONDS: read again after that long and print the changes per second)
  tools/m1_link.py mem                    (#273: the boot's proof of .lowram and how deep each stack has gone since boot)
  tools/m1_link.py uitime [reset]         (the LCD's draw times: the last and the worst of each kind, in ms; reset zeroes them)
  tools/m1_link.py clock [SECONDS [BPM [run]]]   (#473: MIDI clock out, DIAG page 116: ticks sent and dropped; SECONDS:
                                           also time the ticks this computer receives, by CoreMIDI's timestamps, and print
                                           the mean period, the deviation of each period and of each tick from a straight
                                           grid, and the link's refused sends over that time, DIAG page 117; BPM: at that
                                           global tempo (TEMPO, set back after); run: with the transport running)
  tools/m1_link.py usblog [arm|wrap]      (#535: the USB setup log, DIAG pages 40..107: every control transfer a host started
                                           since boot (or since `arm`) and the firmware's answer, bus resets, suspends, the
                                           address taking effect; kept while the FM-1 stays powered, so a failed host's log
                                           can be read on another. arm: keep the next 128 entries (a one-shot capture), wrap:
                                           the newest again)
  tools/m1_link.py diag [DIS]             (what the last reset left: its cause, the crash record, where a stalled main loop
                                           was; DIS = the build's matryoshka.dis (CI artifact matryoshka-elf) names the functions)
Needs mido and python-rtmidi (the Nix dev shell has them).
"""
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


class Link:
    def __init__(self):
        pick = lambda names: next((n for n in names if "Felucca" in n or "Matryoshka" in n or "Modular" in n or "FM-1" in n), None)
        o, i = pick(mido.get_output_names()), pick(mido.get_input_names())
        if not o or not i:
            sys.exit("FM-1 not found")
        self.out, self.inp = mido.open_output(o), mido.open_input(i)

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
                        if want[0] == 0x41 or p[0] == want[1]:
                            return p
                time.sleep(0.002)
        sys.exit(f"no answer from the FM-1 to command {msg.data[3]:#04x} (is it running the Matryoshka firmware with the editor protocol?)")

    def ack(self, msg, cmd, wait=0.8, tries=3):
        p = self.ask(msg, (0x40, cmd), tries, wait)
        if p[2]:
            sys.exit(f"FM-1: {STATUS[p[2]] if p[2] < len(STATUS) else p[2]} (aux {p[3]})")


def upload_chunks(link, data):
    for seq, off in enumerate(range(0, len(data), 384)):
        part = data[off:off + 384]
        link.ack(frame(0x10, [seq & 0x7F, off & 0xFF, off >> 8, len(data) & 0xFF, len(data) >> 8, *part]), 0x10)


def factory_presets():
    """[(name, bytes)] of the factory presets, from the generated firmware/src/presets.h (cd web && npm run export-defs)"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware", "src", "presets.h")
    out = []
    for m in re.finditer(r"PRESET_\d+\[\d+\] = \{([\d,]*)\};\s*/\* (.*?) \*/", open(path).read()):
        out.append((m.group(2), bytes(int(x) for x in m.group(1).split(","))))
    if not out:
        sys.exit("no presets found in firmware/src/presets.h")
    return out


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    link = Link()
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
    elif a[0] == "bank":
        presets = factory_presets()[:32]
        for slot, (name, data) in enumerate(presets):
            upload_chunks(link, data)
            n = [ord(c) if 32 <= ord(c) < 127 else 0 for c in name[:20]]
            n += [0] * (20 - len(n))
            c = crc16(data)
            link.ack(frame(0x13, [slot, *n, len(data) & 0xFF, len(data) >> 8, c & 0xFF, c >> 8]), 0x13, wait=4.0, tries=1)
            print(f"slot {slot + 1:02d}  {name}  ({len(data)} bytes)")
        for slot in range(len(presets), 64):
            link.ack(frame(0x14, [slot]), 0x14, wait=4.0, tries=1)
        print(f"bank written: {len(presets)} presets")
    elif a[0] == "bank-info":
        used = 0
        for slot in range(64):
            p = link.ask(frame(0x15, [slot]), (0x42, slot))
            if p[1]:
                used += 1
                name = bytes(x for x in p[4:24] if 32 <= x < 127).decode()
                print(f"slot {slot + 1:02d}  {name}  ({p[2] | p[3] << 8} bytes)")
        print(f"{used} of 64 slots used" + ("" if used else ": the next boot writes the factory patches again"))
    elif a[0] == "bank-clear":
        for slot in range(64):
            link.ack(frame(0x14, [slot]), 0x14, wait=4.0, tries=1)
        print("bank emptied")
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
            print(head + f"BUS RESET (POWER {s[0]:#04x}{', HIGH SPEED' if s[0] & 0x10 else ''}; ends configuration {s[1]}, "
                  f"address {s[2]})" + rep)
        elif kind == 3:
            print(head + f"SUSPEND (configuration {a})" + rep)
        elif kind == 4:
            print(head + f"RESUME (configuration {a})" + rep)
        elif kind == 5:
            print(head + f"ADDRESS {a} takes effect (POWER {s[0]:#04x}{', HIGH SPEED' if s[0] & 0x10 else ''})" + rep)
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
