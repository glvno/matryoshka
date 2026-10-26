# SPDX-License-Identifier: GPL-3.0-only
# WIP (fm1-overload): run with build/venv/bin/python; only with the registered rig the ONLY FM-1 connected (npm run rig -- check).
# usage: cpu_survey.py PRESETS_H OUT.json [name,name,...]
# For each factory patch in PRESETS_H: upload it (live), then the longest audio ISR (DIAG page 127) at rest and with
# 1 / 4 / 8 notes held over USB MIDI, 2 s each, sampled every 0.5 s (the first sample is before any overload shed).
import sys, time, json, re
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


def phase(link, n, hold=2.0):
    for k in NOTES[:n]:
        link.out.send(mido.Message("note_on", note=k, velocity=100))
    cpu(link)
    samples = []
    t = time.time()
    w = None
    while time.time() - t < hold:
        time.sleep(0.5)
        w = cpu(link)
        samples.append(w[1])
    for k in NOTES[:n]:
        link.out.send(mido.Message("note_off", note=k))
    time.sleep(0.6)
    return max(samples), samples, w[3]


link = M.Link()
ps = presets(sys.argv[1])
filt = sys.argv[3].split(',') if len(sys.argv) > 3 else None
res = []
for slot, (name, data) in enumerate(ps):
    if filt and name not in filt:
        continue
    M.upload_chunks(link, data)
    c = M.crc16(data)
    link.ack(M.frame(0x11, [len(data) & 0xFF, len(data) >> 8, c & 0xFF, c >> 8]), 0x11, wait=3.0)
    time.sleep(1.5)
    r = {"slot": slot, "name": name}
    for n in (0, 1, 4, 8):
        pk, s, ovl = phase(link, n)
        r[f"n{n}_us"] = pk
        r[f"n{n}_samples"] = s
        r[f"n{n}_ovl"] = ovl
    r["budget_us"] = 2902
    res.append(r)
    worst = max(r['n0_us'], r['n1_us'], r['n4_us'], r['n8_us'])
    print(f"{slot:2} {name:16} rest {r['n0_us']:5} 1 {r['n1_us']:5} 4 {r['n4_us']:5} 8 {r['n8_us']:5}  "
          f"({100 * worst / 2902:.1f} %)  s1 {r['n1_samples']} s8 {r['n8_samples']}", flush=True)
json.dump(res, open(sys.argv[2], 'w'), indent=1)
