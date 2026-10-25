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
  tools/m1_link.py uitime [reset]         (the LCD's draw times: the last and the worst of each kind, in ms; reset zeroes them)
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
              f"patch {'loaded' if p[3] & 2 else 'none'}, delays {p[4]}")
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
