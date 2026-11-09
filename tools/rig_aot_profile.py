# SPDX-License-Identifier: GPL-3.0-only
"""Profile a sequenced capacity fixture on the registered rig, after its firmware's emulator gates.

Run with build/venv/bin/python:
  tools/rig_aot_profile.py PATCH.m1p OUT.json [--hold 5]
Starts transport and holds eight notes, waits one second, then captures the block-time window.
Stops transport and releases notes on exit. Does not install firmware or save device settings.
"""
import argparse
import json
import pathlib
import time

import mido
import m1_link as M


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("patch", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--hold", type=float, default=5.0)
    args = parser.parse_args()
    if not 1 <= args.hold <= 60:
        parser.error("--hold must be between 1 and 60 seconds")
    data = args.patch.read_bytes()
    link = M.rig_link()

    def page(n):
        p = link.ask(M.frame(0x2B, [n]), (0x4B, n))
        return [int.from_bytes(bytes(p[1 + 4*i:5 + 4*i]), "little") for i in range((len(p)-1)//4)]

    def health():
        c = page(114)
        if c[0] != 1 or c[3] != 0 or c[4] != 0:
            raise RuntimeError(f"Core fault: stop qualification and preserve diagnostics: {c}")
        return c

    result = {"fixture": args.patch.stem, "notes": M.BT_NOTES, "seconds": args.hold, "before": health()}
    M.upload_chunks(link, data)
    crc = M.crc16(data)
    link.ack(M.frame(0x11, [len(data) & 255, len(data) >> 8, crc & 255, crc >> 8]), 0x11, wait=3)
    guard_before = page(119)
    result["guard_before"] = guard_before
    try:
        link.out.send(mido.Message("start"))
        for note in result["notes"]:
            link.out.send(mido.Message("note_on", note=note, velocity=100))
        time.sleep(1)
        page(132)
        time.sleep(args.hold)
        result["page132"] = page(132)
        spans = []
        for pg in range(133, 138):
            x = page(pg)
            spans.extend((x[2*i], x[2*i+1]) for i in range(4))
        result["spans_ns"] = {M.BT_SPANS[i][0]: {"mean": a, "max": b}
                              for i, (a, b) in enumerate(spans[:len(M.BT_SPANS)])}
        result["page138"] = page(138)
        result["page139"] = page(139)
        result["cpu"] = page(127)
        result["guard"] = page(119)
        result["after"] = health()
        result["valid"] = (result["cpu"][3] == 0 and result["cpu"][7] == 0
                           and result["guard"][2] == guard_before[2])
    finally:
        link.out.send(mido.Message("stop"))
        for note in result["notes"]:
            link.out.send(mido.Message("note_off", note=note))
        args.output.write_text(json.dumps(result, indent=1) + "\n")
    if not result["valid"]:
        raise RuntimeError("Invalid timing window: overload mute, voice shedding or late audio")
    print(f"{args.patch.stem}: valid profile written to {args.output}")


if __name__ == "__main__":
    main()
