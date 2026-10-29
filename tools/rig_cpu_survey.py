# SPDX-License-Identifier: GPL-3.0-only
# Run with build/venv/bin/python; only with the registered rig the ONLY FM-1 connected (npm run rig -- check).
# usage: rig_cpu_survey.py PRESETS_H OUT.json [name,name,...] [--hold SECONDS] [--run]
# For each factory patch in PRESETS_H: upload it (live), then the longest audio ISR (DIAG page 127) at rest and with
# 1 / 4 / 8 notes held over USB MIDI, 2 s each, sampled every 0.5 s. Reload for EACH phase so a voice shed in an earlier
# phase cannot make the next one look cheaper. Peaks include the first block; a sample need not precede shedding.
import sys, time, json, re, argparse
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1_link as M
import mido


def presets(path):
    out = []
    for m in re.finditer(r"PRESET_\d+\[\d+\] = \{([\d,]*)\};\s*/\* (.*?) \*/", open(path).read()):
        out.append((m.group(2), bytes(int(x) for x in m.group(1).split(","))))
    return out


def cpu(link):
    p = link.ask(M.frame(0x2B, [127]), (0x4B, 127))
    return [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range((len(p) - 1) // 4)]


NOTES = [60, 64, 67, 71, 72, 76, 79, 83]


def phase(link, n, data, hold=2.0, run=False):
    M.upload_chunks(link, data)
    c = M.crc16(data)
    link.ack(M.frame(0x11, [len(data) & 0xFF, len(data) >> 8, c & 0xFF, c >> 8]), 0x11, wait=3.0)
    samples = []
    muted = shed = 0
    try:
        if run:
            link.out.send(mido.Message("start"))
        for k in NOTES[:n]:
            link.out.send(mido.Message("note_on", note=k, velocity=100))
        t = time.monotonic()
        while time.monotonic() - t < hold:
            time.sleep(0.5)
            w = cpu(link)
            samples.append(w[1])
            muted = max(muted, w[3])
            shed = max(shed, w[7]) if len(w) > 7 else None
    finally:
        if run:
            link.out.send(mido.Message("stop"))
        for k in NOTES[:n]:
            link.out.send(mido.Message("note_off", note=k))
    return max(samples), samples, muted, shed


parser = argparse.ArgumentParser(description="Measure the registered rig after its identity has been checked.")
parser.add_argument("presets")
parser.add_argument("output")
parser.add_argument("names", nargs="?")
parser.add_argument("--hold", type=float, default=2.0)
parser.add_argument("--run", action="store_true", help="run each patch's transport during every phase")
args = parser.parse_args()
if not 1 <= args.hold <= 60:
    parser.error("--hold must be between 1 and 60 seconds per phase")
ps = presets(args.presets)
filt = args.names.split(',') if args.names else None
unknown = set(filt or []) - {name for name, _ in ps}
if not ps or unknown:
    parser.error("no patches found" if not ps else "unknown patch names: " + ", ".join(sorted(unknown)))
link = M.Link()
res = []
for slot, (name, data) in enumerate(ps):
    if filt and name not in filt:
        continue
    r = {"slot": slot, "name": name, "transport": args.run, "hold_seconds": args.hold}
    for n in (0, 1, 4, 8):
        pk, s, ovl, shed = phase(link, n, data, args.hold, args.run)
        r[f"n{n}_us"] = pk
        r[f"n{n}_samples"] = s
        r[f"n{n}_ovl"] = ovl
        r[f"n{n}_shed"] = shed
    r["budget_us"] = 2902
    res.append(r)
    json.dump(res, open(args.output, 'w'), indent=1)
    worst = max(r['n0_us'], r['n1_us'], r['n4_us'], r['n8_us'])
    print(f"{slot:2} {name:16} rest {r['n0_us']:5} 1 {r['n1_us']:5} 4 {r['n4_us']:5} 8 {r['n8_us']:5}  "
          f"({100 * worst / 2902:.1f} %)  s1 {r['n1_samples']} s8 {r['n8_samples']}", flush=True)
json.dump(res, open(args.output, 'w'), indent=1)
