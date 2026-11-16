#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# The emulator's timing model (tools/emu/src/timing.rs, #947): measure a firmware build on the emulator, compare it with
# the test rig, and refit the model's one fitted number (`residual`). Plain Python (no numpy).
#
#   timing_fit.py measure DIR OUT.json [--timing FILE] [--jobs N] [--slots 0,1,..] [--survey] [--modtime] [--run]
#       [--poke8 NAME=BYTE,..]
#       m1emu cpu over the bank's slots, several emulators at once; DIR holds the build's matryoshka.bin and
#       matryoshka.elf (the CI artifacts matryoshka-firmware and matryoshka-elf, unpacked into one directory)
#   timing_fit.py compare EMU.json [--modtime RIG.json] [--survey RIG.json [--quiet]]
#       the emulator's figures against the rig's: per patch, and per module for modtime
#   timing_fit.py residual DIR RIG_MODTIME.json PARAMS [--jobs N]
#       runs the build under PARAMS with `residual 1` and prints the residual that brings its patch sums to the rig's
#       (the inverse of the geometric mean of emulator / rig), and the patch sums' spread once it is applied
#   timing_fit.py grid PARAMS TWO_CORE_DIR CODE_DIRS MODTIME_DIR MISS,DUAL [MISS,DUAL ..] [--jobs N]
#       the fit of `miss` and `dual` (how timing.txt's were found): for each point, the emulator against the rig on
#       the paired measurements in docs/measurements: the build of TWO_CORE_DIR with and without the second core's work
#       (cpu-survey-2026-11-14-rig-two-core.json, -split-off.json; the emulator's `lanes_off`), the three builds of
#       CODE_DIRS = O2_DIR,SIZE_DIR,RAM_DIR (2026-11-09-rig-experiments.json: 808 Kit and Oracle V) and the module times
#       of MODTIME_DIR (modtime-2026-11-14-rig.json). Prints the residual each point needs, the spread left (rms of the
#       logs of emulator / rig) and each group's bias: pick the point with the smallest spread and least bias between
#       paired groups
#
# The costs in tools/emu/timing.txt are measured on FM-1s (see its header), except `miss` and `dual`, which `grid`
# fits, and `residual`, which `residual` refits. Every emulator run is cached
# in build/emu/timing-cache (by the firmware's bytes, the parameters, the slots and the m1emu binary). Build m1emu
# first: cargo build --release --manifest-path tools/emu/Cargo.toml --config "$(tools/emu/isa_fix.sh)"
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
M1EMU = os.environ.get("M1EMU", os.path.join(ROOT, "tools/emu/target/release/m1emu"))
CACHE = os.path.join(ROOT, "build/emu/timing-cache")


def opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def run_cpu(build, args, timing_text):
    """m1emu cpu on the build with `args`, under `timing_text` (None: the model off): its JSON, cached"""
    fw = open(f"{build}/matryoshka.bin", "rb").read()
    h = hashlib.sha256(fw + json.dumps([args, timing_text]).encode() + open(M1EMU, "rb").read()).hexdigest()[:24]
    path = os.path.join(CACHE, f"{h}.json")
    if os.path.exists(path):
        return json.load(open(path))
    tmp = tempfile.mkdtemp(prefix="m1emu-timing-")
    env = {**os.environ, "M1EMU_TIMING": ""}
    if timing_text is not None:
        env["M1EMU_TIMING"] = os.path.join(tmp, "timing.txt")
        open(env["M1EMU_TIMING"], "w").write(timing_text)
    out = os.path.join(tmp, "out.json")
    r = subprocess.run([M1EMU, "cpu", f"{build}/matryoshka.bin", "--elf", f"{build}/matryoshka.elf", *args, "--out", out],
                       capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"m1emu cpu {' '.join(args)} failed: {r.stderr[-2000:]}")
    os.makedirs(CACHE, exist_ok=True)
    os.replace(out, path)
    return json.load(open(path))


def measure(build, timing_text, slots, jobs, survey=False, modtime=True, run=False, poke8=None):
    """m1emu cpu over `slots` in `jobs` emulators at once (each boots once and takes every jobs-th slot): the merged JSON"""
    groups = [slots[i::jobs] for i in range(min(jobs, len(slots)))]
    flags = ([] if survey else ["--no-survey"]) + (["--modtime"] if modtime else []) + (["--run"] if run else [])
    flags += ["--poke8", poke8] if poke8 else []
    with ThreadPoolExecutor(len(groups)) as ex:
        parts = list(ex.map(lambda g: run_cpu(build, ["--slots", ",".join(map(str, g)), *flags], timing_text), groups))
    merged = {"firmware": build, "timing": parts[0]["timing"], "survey": [], "modtime": {"patches": {}}}
    for p in parts:
        merged["survey"] += p["survey"]
        merged["modtime"]["patches"].update(p["modtime"]["patches"])
    merged["survey"].sort(key=lambda r: r["slot"])
    return merged


def bank_slots(build):
    """[(slot, name)] of the build's bank (one boot, nothing measured)"""
    return [(int(s), n) for s, n in run_cpu(build, ["--no-survey", "--slots", "none"], None)["slots"]]


def key(name):
    return name.strip().lower()


def rig_modtime(path):
    return {key(n): v["modules_ns"] for n, v in json.load(open(path))["patches"].items()}


def emu_modtime(j):
    return {key(n): v["modules_ns"] for n, v in j["modtime"]["patches"].items()}


def cells(rig, emu):
    """(patch, module, lane, rig ns, emu ns) for every module time both have"""
    out = []
    for p in sorted(set(rig) & set(emu)):
        r, e = rig[p], emu[p]
        if len(r) != len(e):
            print(f"  {p}: {len(r)} modules on the rig, {len(e)} here: left out", file=sys.stderr)
            continue
        for m, (rr, ee) in enumerate(zip(r, e)):
            for lane in (0, 1):
                if rr[lane] or ee[lane]:
                    out.append((p, m, lane, rr[lane], ee[lane]))
    return out


def compare_modtime(rig, emu):
    c = cells(rig, emu)
    print(f"{'patch':16} {'rig us':>9} {'emu us':>9} {'emu/rig':>8}")
    ratios = []
    for p in sorted({x[0] for x in c}):
        r = sum(x[3] for x in c if x[0] == p) / 1000
        e = sum(x[4] for x in c if x[0] == p) / 1000
        ratios.append(e / r)
        print(f"{p:16} {r:9.1f} {e:9.1f} {e / r:8.3f}")
    rms = (sum((x - 1) ** 2 for x in ratios) / len(ratios)) ** 0.5
    print(f"patch sums: rms error {100 * rms:.1f} %, worst {100 * max(abs(x - 1) for x in ratios):.1f} %")
    mod = sorted(x[4] / x[3] for x in c if x[3] > 2000)
    q = lambda f: mod[int(f * (len(mod) - 1))]
    print(f"modules over 2 us on the rig: emu/rig median {q(0.5):.3f}, p10 {q(0.1):.3f}, p90 {q(0.9):.3f} ({len(mod)})")


def compare_survey(rig, emu, quiet=False):
    """the steady mean of each phase (the last 0.5 s) against the rig's; a phase muted on either side (under 100 us:
    the overload guard silenced the patch) is listed apart"""
    rows = {key(r["name"]): r for r in rig}
    if not quiet:
        print(f"{'patch':16} {'n':>2} {'rig peak':>9} {'emu peak':>9} {'rig mean':>9} {'emu mean':>9}")
    ratios, muted = [], []
    for e in emu:
        r = rows.get(key(e["name"]))
        if not r:
            continue
        for n in (0, 1, 4, 8):
            if f"n{n}_us" in e and f"n{n}_us" in r:
                rm = (r.get(f"n{n}_mean_us") or [0])[-1]
                em = e[f"n{n}_mean_us"][-1]
                if not quiet:
                    print(f"{e['name']:16} {n:2} {r[f'n{n}_us']:9} {e[f'n{n}_us']:9} {rm:9} {em:9}")
                if rm < 100 or em < 100:
                    muted.append(f"{e['name']} {n}: rig {rm}, emu {em}")
                elif rm:
                    ratios.append(em / rm)
    if ratios:
        geo = math.exp(sum(math.log(x) for x in ratios) / len(ratios))
        rms = (sum((x - 1) ** 2 for x in ratios) / len(ratios)) ** 0.5
        near = sum(abs(x - 1) <= 0.1 for x in ratios) / len(ratios)
        print(f"steady means, {len(ratios)} phases: emu / rig {geo:.3f} (geometric mean), rms error {100 * rms:.1f} %, "
              f"worst {100 * max(abs(x - 1) for x in ratios):.1f} %, within 10 %: {100 * near:.0f} %")
    for m in muted:
        print(f"  muted: {m}")


MEAS = os.path.join(ROOT, "docs/measurements")


def steady(r, n):
    m = r.get(f"n{n}_mean_us")
    return m[-1] if m else None


def survey_ratios(rig_rows, emu_rows, names=None):
    """emulator / rig of each phase's steady mean, phases muted on either side left out"""
    out = []
    for k in sorted(set(rig_rows) & set(emu_rows)):
        if names and k not in names:
            continue
        for n in (0, 1, 4, 8):
            a, b = steady(rig_rows[k], n), steady(emu_rows[k], n)
            if a and b and min(a, b) >= 100:
                out.append(b / a)
    return out


def grid_point(text, two_core, code_dirs, modtime_dir, jobs):
    """emulator / rig by group, for the paired measurements"""
    rows = lambda x: {key(r["name"]): r for r in x}
    load = lambda f: json.load(open(os.path.join(MEAS, f)))
    g = {}
    every = [s for s, _ in bank_slots(two_core)]
    on = measure(two_core, text, every, jobs, survey=True, modtime=False)
    off = measure(two_core, text, every, jobs, survey=True, modtime=False, poke8="lanes_off=1")
    g["split on"] = survey_ratios(rows(load("cpu-survey-2026-11-14-rig-two-core.json")), rows(on["survey"]))
    g["split off"] = survey_ratios(rows(load("cpu-survey-2026-11-14-rig-two-core-split-off.json")), rows(off["survey"]))
    pair = ("808 kit", "oracle v")
    variants = load("2026-11-09-rig-experiments.json")["variants"]
    for v, d in zip(("default", "size", "ram"), code_dirs):
        e = measure(d, text, [s for s, n in bank_slots(d) if key(n) in pair], jobs, survey=True, modtime=False)
        g[v] = survey_ratios(rows(variants[v]["surveys"]["stopped"]), rows(e["survey"]), pair)
    rig = rig_modtime(os.path.join(MEAS, "modtime-2026-11-14-rig.json"))
    e = measure(modtime_dir, text, [s for s, n in bank_slots(modtime_dir) if key(n) in rig], jobs)
    c = cells(rig, emu_modtime(e))
    g["modtime"] = [sum(x[4] for x in c if x[0] == p) / sum(x[3] for x in c if x[0] == p) for p in sorted({x[0] for x in c})]
    return g


def grid(params, two_core, code_dirs, modtime_dir, points, jobs):
    base = [l for l in params.splitlines() if l.split()[:1] not in (["miss"], ["dual"], ["residual"])]
    for miss, dual in points:
        g = grid_point("\n".join(base) + f"\nmiss {miss}\ndual {dual}\nresidual 1\n", two_core, code_dirs, modtime_dir, jobs)
        logs = [math.log(x) for v in g.values() for x in v]
        mu = sum(logs) / len(logs)
        rms = (sum((x - mu) ** 2 for x in logs) / len(logs)) ** 0.5
        bias = ", ".join(f"{k} {math.exp(sum(math.log(x) for x in v) / len(v) - mu):.3f}" for k, v in g.items())
        print(f"miss {miss:g} dual {dual:g}: residual {math.exp(-mu):.3f}, spread {100 * rms:.1f} %; after the residual: {bias}",
              flush=True)


def residual(build, rig_path, params, jobs):
    rig = rig_modtime(rig_path)
    slots = [s for s, n in bank_slots(build) if key(n) in rig]
    text = "".join(l + "\n" for l in params.splitlines() if not l.strip().startswith("residual")) + "residual 1\n"
    emu = emu_modtime(measure(build, text, slots, jobs))
    c = cells(rig, emu)
    ratios = [sum(x[4] for x in c if x[0] == p) / sum(x[3] for x in c if x[0] == p) for p in sorted({x[0] for x in c})]
    gm = math.exp(sum(math.log(x) for x in ratios) / len(ratios))
    n = [x / gm for x in ratios]
    rms = (sum((x - 1) ** 2 for x in n) / len(n)) ** 0.5
    print(f"{len(ratios)} patches: emulator / rig {gm:.3f} with residual 1; residual {1 / gm:.3f} leaves their sums "
          f"{100 * rms:.1f} % rms apart (worst {100 * max(abs(x - 1) for x in n):.1f} %)")


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(open(__file__).read().split("\nimport ")[0])
    jobs = int(opt(a, "--jobs", max(1, (os.cpu_count() or 4) - 2)))
    if a[0] == "measure":
        build, out = a[1], a[2]
        timing = open(opt(a, "--timing")).read() if opt(a, "--timing") else None
        slots = [int(s) for s in opt(a, "--slots").split(",")] if opt(a, "--slots") else [s for s, _ in bank_slots(build)]
        j = measure(build, timing, slots, jobs, survey="--survey" in a, modtime="--modtime" in a, run="--run" in a,
                    poke8=opt(a, "--poke8"))
        json.dump(j, open(out, "w"), indent=1)
    elif a[0] == "compare":
        emu = json.load(open(a[1]))
        if opt(a, "--modtime"):
            compare_modtime(rig_modtime(opt(a, "--modtime")), emu_modtime(emu))
        if opt(a, "--survey"):
            compare_survey(json.load(open(opt(a, "--survey"))), emu["survey"], quiet="--quiet" in a)
    elif a[0] == "residual":
        residual(a[1], a[2], open(a[3]).read(), jobs)
    elif a[0] == "grid":
        pts = [tuple(float(x) for x in p.split(",")) for p in a[5:] if "," in p and p[0].isdigit()]
        grid(open(a[1]).read(), a[2], a[3].split(","), a[4], pts, jobs)
    else:
        sys.exit(f"unknown command {a[0]}")


if __name__ == "__main__":
    main()
