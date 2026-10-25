#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""#273 canary soak on the test rig: is the SRAM below the RAM region (0x01C0xxxx..0x01C07F00) unused at run time?

  build/venv/bin/python tools/canary_soak.py RUN [--skip PHASE,..] [--minutes PHASE=N,..]

RUN: the firmware CI run of the canary build (branch canary-lowram). The phases, in order (about an hour):

  install    ~15 min  npm run device:scenarios -- --install RUN: the D-120 gate on RUN's own builds (emu:smoke,
                      emu:scenarios), the install onto the rig (only when it is the one FM-1 connected), then every
                      device scenario. Covers the boot and the full device:scenarios.
  heavy       10 min  every bank slot by program change, a four-note chord held and retriggered, 15 s each, twice round
  xl          10 min  device:scenarios --only connect,sandbox,switchPlaying,reconnect again and again: XL / sandbox link traffic
  usb-audio    6 min  ffmpeg records the "Matryoshka" audio device for 5 min while the heavy loop plays; uac counters
  clock        5 min  MIDI Start, 24 ppqn clock at 120 bpm, notes and program changes, then Stop
  stage1     ~10 min  device:scenarios --install RUN --only connect: the gate again, then an install of the canary build
                      over itself, so its OTA stage 1 runs on the canary build and records its scan (DIAG page 121)

After each phase the canary is read (tools/m1_link.py canary --json); the counts are since the last boot (the install
phases boot the rig anew). Before each phase the rig must be the only FM-1 connected (npm run rig -- check and the MIDI
ports), else the soak stops there. Results: build/canary/soak.json and the summary at the end.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WEB = os.path.join(ROOT, "web")
PY = sys.executable
OUT = os.path.join(ROOT, "build", "canary")
FM1_NAME = re.compile(r"fm-1|felucca|matryoshka|modular|ota|composite|sinco|usb-midi", re.I)   # (web/dev/rig-client.ts)
PHASES = ["install", "heavy", "xl", "usb-audio", "clock", "stage1"]
MINUTES = {"heavy": 10, "xl": 10, "usb-audio": 6, "clock": 5}

import mido   # noqa: E402  (build/venv: mido + python-rtmidi)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def fm1_ports():
    ins = [n for n in mido.get_input_names() if FM1_NAME.search(n) and "(emu" not in n]
    outs = [n for n in mido.get_output_names() if FM1_NAME.search(n) and "(emu" not in n]
    return ins, outs


def rig_alone():
    """the port names of the rig, when it is the one FM-1 connected; else stop"""
    r = subprocess.run(["npm", "run", "-s", "rig", "--", "check"], cwd=WEB, capture_output=True, text=True)
    lines = [ln for ln in r.stdout.splitlines() if ln.startswith(("RIG", "other"))]
    if r.returncode != 0 or len(lines) != 1 or not lines[0].startswith("RIG"):
        sys.exit(f"stop: the rig must be the only FM-1 connected (rig check said:\n{r.stdout}{r.stderr})")
    ins, outs = fm1_ports()
    if len(ins) != 1 or len(outs) != 1:
        sys.exit(f"stop: {len(ins)} FM-1 MIDI inputs, {len(outs)} outputs ({ins} / {outs}): the rig must be the only one")
    log(lines[0])
    return ins[0], outs[0], lines[0]


def canary(port):
    r = subprocess.run([PY, os.path.join(ROOT, "tools", "m1_link.py"), "--port", port, "canary", "--json"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return {"error": (r.stdout + r.stderr).strip()}
    return json.loads(r.stdout)


def link_info(port, what):
    r = subprocess.run([PY, os.path.join(ROOT, "tools", "m1_link.py"), "--port", port, what], capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()


def scenarios(*extra):
    cmd = ["npm", "run", "device:scenarios", "--", *extra]
    log("$", " ".join(cmd))
    return subprocess.run(cmd, cwd=WEB).returncode


def summary(c):
    if "error" in c:
        return f"read failed: {c['error']}"
    if not c["armed"]:
        return "not armed (not the canary build?)"
    s = f"{c['changed_words']} words changed" + (
        f" in {c['runs']} runs, {c['first']:#010x}..{c['last']:#010x}" if c["changed_words"] else "")
    o = c["ota_stage1"]
    s += f"; OTA stage 1 record: {o['changed_words']} words changed" if o["valid"] else "; no OTA stage 1 record"
    return s


class Player:
    """notes and program changes over the rig's USB MIDI (and, for the clock phase, Start / clock / Stop)"""

    def __init__(self, inp, outp):
        self.out, self.inp = mido.open_output(outp), mido.open_input(inp)
        self.now = []                                   # SLOT_NOW names seen (unasked, after a program change)

    def close(self):
        self.out.close()
        self.inp.close()

    def poll(self):
        for m in self.inp.iter_pending():
            d = list(m.data) if m.type == "sysex" else []
            if d[:4] == [0x7D, 0x4D, 0x31, 0x43]:          # SLOT_NOW: slot, name (7-bit packed)
                acc, nb, raw = 0, 0, []
                for x in d[4:]:
                    acc |= x << nb
                    nb += 7
                    if nb >= 8:
                        raw.append(acc & 0xFF)
                        acc >>= 8
                        nb -= 8
                if raw:
                    self.now.append((raw[0], bytes(b for b in raw[1:21] if 32 <= b < 127).decode()))

    def chord(self, on, notes=(48, 55, 60, 64)):
        for n in notes:
            self.out.send(mido.Message("note_on" if on else "note_off", note=n, velocity=100 if on else 0))

    def slots(self, used, minutes, each=15.0, stop=None):
        """program change round the used bank slots, a chord retriggered every 2 s; the slots the FM-1 said it loaded"""
        t_end, k = time.time() + minutes * 60, 0
        while time.time() < t_end and not (stop and stop.is_set()):
            self.out.send(mido.Message("program_change", program=used[k % len(used)]))
            k += 1
            t0 = time.time()
            while time.time() - t0 < each and time.time() < t_end and not (stop and stop.is_set()):
                self.chord(True)
                time.sleep(1.6)
                self.chord(False)
                time.sleep(0.4)
                self.poll()
        self.chord(False)
        self.poll()
        return {"program_changes": k, "loads_confirmed": len(self.now), "names": sorted({n for _, n in self.now})}


def used_slots(port):
    """the occupied bank slots (tools/m1_link.py bank-info: SLOT queries, read only)"""
    out = link_info(port, "bank-info")
    used = [int(m.group(1)) - 1 for m in re.finditer(r"^slot (\d+)", out, re.M)]
    return used or [0]


def phase_install(run):
    rc = scenarios("--install", str(run))
    return {"device_scenarios_rc": rc}


def phase_heavy(inp, outp, minutes):
    p = Player(inp, outp)
    try:
        played = p.slots(used_slots(outp), minutes)
    finally:
        p.close()
    return {**played, "cpu": link_info(outp, "cpu")}


def phase_xl(minutes):
    t_end, runs = time.time() + minutes * 60, []
    while time.time() < t_end:
        rig_alone()
        runs.append(scenarios("--only", "connect,sandbox,switchPlaying,reconnect"))
    return {"scenario_runs": len(runs), "failed_runs": sum(1 for r in runs if r)}


def phase_usb_audio(inp, outp, minutes):
    devs = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                          capture_output=True, text=True).stderr
    audio = devs.split("audio devices:")[-1]
    m = re.search(r"\[(\d+)\] [^\n]*Matryoshka", audio)
    if not m:
        return {"error": "no Matryoshka audio device in ffmpeg's avfoundation list", "devices": audio.strip()}
    before = link_info(outp, "uac")
    wav = os.path.join(OUT, "usb-audio.wav")
    rec_s = max(60, int(minutes * 60) - 60)
    stop = threading.Event()
    used = used_slots(outp)
    p = Player(inp, outp)
    th = threading.Thread(target=lambda: p.slots(used, minutes, stop=stop))
    th.start()
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-i",
                            f":{m.group(1)}", "-t", str(rec_s), wav], capture_output=True, text=True)
    finally:
        stop.set()
        th.join()
        p.close()
    after = link_info(outp, "uac")
    return {"recorded_s": rec_s, "wav": wav, "ffmpeg_rc": r.returncode, "ffmpeg_err": r.stderr.strip()[-500:],
            "wav_bytes": os.path.getsize(wav) if os.path.exists(wav) else 0, "uac_before": before, "uac_after": after}


def phase_clock(inp, outp, minutes):
    used = used_slots(outp)
    p = Player(inp, outp)
    stop = threading.Event()
    sent = [0]

    def clock():
        tick = 60.0 / 120 / 24
        t = time.perf_counter()
        p.out.send(mido.Message("start"))
        while not stop.is_set():
            p.out.send(mido.Message("clock"))
            sent[0] += 1
            t += tick
            d = t - time.perf_counter()
            if d > 0:
                time.sleep(d)
        p.out.send(mido.Message("stop"))

    th = threading.Thread(target=clock)
    th.start()
    try:
        played = p.slots(used, minutes, each=30.0)
    finally:
        stop.set()
        th.join()
        p.close()
    return {"clocks_sent": sent[0], **played}


def phase_stage1(run):
    rc = scenarios("--install", str(run), "--only", "connect")
    return {"device_scenarios_rc": rc}


def main():
    a = sys.argv[1:]
    if not a or not a[0].isdigit():
        sys.exit(__doc__)
    run = a[0]
    skip = set(a[a.index("--skip") + 1].split(",")) if "--skip" in a else set()
    if "--minutes" in a:
        for kv in a[a.index("--minutes") + 1].split(","):
            k, v = kv.split("=")
            MINUTES[k] = float(v)
    os.makedirs(OUT, exist_ok=True)
    results = []
    path = os.path.join(OUT, "soak.json")
    t_start = time.time()
    for ph in PHASES:
        if ph in skip:
            continue
        log(f"== {ph}" + (f" ({MINUTES[ph]} min)" if ph in MINUTES else ""))
        inp, outp, rig = rig_alone()
        t0 = time.time()
        if ph == "install":
            r = phase_install(run)
        elif ph == "heavy":
            r = phase_heavy(inp, outp, MINUTES[ph])
        elif ph == "xl":
            r = phase_xl(MINUTES[ph])
        elif ph == "usb-audio":
            r = phase_usb_audio(inp, outp, MINUTES[ph])
        elif ph == "clock":
            r = phase_clock(inp, outp, MINUTES[ph])
        else:
            r = phase_stage1(run)
        time.sleep(3)
        inp, outp, rig = rig_alone()                    # (after an install the port can come back under a new name)
        c = canary(outp)
        mem = link_info(outp, "mem")
        results.append({"phase": ph, "minutes": round((time.time() - t0) / 60, 1), "rig": rig, "result": r,
                        "canary": c, "mem": mem})
        with open(path, "w") as f:
            json.dump(results, f, indent=1)
        log(f"-- {ph}: canary {summary(c)}")
        log(f"   {mem}")
        if "--stop-on-change" in a and c.get("changed_words"):
            break
    log(f"== done in {(time.time() - t_start) / 60:.0f} min; {path}")
    for x in results:
        print(f"{x['phase']:10s} {x['minutes']:5.1f} min  {summary(x['canary'])}")


if __name__ == "__main__":
    main()
