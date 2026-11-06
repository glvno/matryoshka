# SPDX-License-Identifier: GPL-3.0-only
# Run with build/venv/bin/python; only with the registered rig the ONLY FM-1 connected (npm run rig -- check).
# usage: rig_c1_soak.py OUT.json [--seconds N] [--program P]
# The second core's soak (#271): factory patch P (program change, default 0 Oracle V), then for N seconds (default 600)
# a new 4-note chord every 2 s over USB MIDI, and every 30 s the second core's page (DIAG 114: on, self-tests passed /
# failed, refused jobs, its stack, the longest wait) and the CPU page (DIAG 127). Exit code 1 when the FM-1 is on one
# core at the end, a self-test failed, or the self-tests stopped counting.
import sys, time, json, argparse
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1_link as M
import mido


def page(link, n):
    p = link.ask(M.frame(0x2B, [n]), (0x4B, n))
    return [int.from_bytes(bytes(p[1 + 4 * i:5 + 4 * i]), "little") for i in range((len(p) - 1) // 4)]


def cores(link):
    w = page(link, 114)
    return {"on": w[0] & 0xFF, "gave_up": (w[0] >> 8) & 0xFF, "barred": (w[0] >> 16) & 0xFF, "skip": w[0] >> 24,
            "trace": w[1], "passed": w[2], "failed": w[3], "refused": w[4], "stack_used": w[5], "wait_max_us": w[6],
            "jobs": w[7]}


CHORDS = [[60, 64, 67, 71], [62, 65, 69, 72], [57, 60, 64, 67], [55, 59, 62, 65]]
ap = argparse.ArgumentParser()
ap.add_argument("output")
ap.add_argument("--seconds", type=int, default=600)
ap.add_argument("--program", type=int, default=0)
a = ap.parse_args()
link = M.Link()
start = cores(link)
print("start", start, flush=True)
link.out.send(mido.Message("program_change", program=a.program))
time.sleep(1.5)
log, held, k, t0, nxt = [], [], 0, time.monotonic(), 0.0
try:
    while (el := time.monotonic() - t0) < a.seconds:
        for n in held:
            link.out.send(mido.Message("note_off", note=n))
        held = CHORDS[k % len(CHORDS)]
        k += 1
        for n in held:
            link.out.send(mido.Message("note_on", note=n, velocity=100))
        if el >= nxt:
            c, cpu = cores(link), page(link, 127)
            c.update({"t": round(el), "cpu_pct": cpu[0], "isr_peak_us": cpu[1], "shed": cpu[7]})
            log.append(c)
            print(c, flush=True)
            nxt += 30
        time.sleep(2.0)
finally:
    for n in held:
        link.out.send(mido.Message("note_off", note=n))
end = cores(link)
print("end", end, flush=True)
ok = end["on"] == 1 and end["failed"] == 0 and end["passed"] - start["passed"] >= a.seconds * 5
json.dump({"program": a.program, "seconds": a.seconds, "start": start, "end": end, "samples": log, "ok": ok},
          open(a.output, "w"), indent=1)
print("soak:", "PASS" if ok else "FAIL", f"({end['passed'] - start['passed']} self-tests in {a.seconds} s)")
sys.exit(0 if ok else 1)
