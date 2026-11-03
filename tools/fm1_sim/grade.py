#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Score a naive-owner session (build/fm1_sim/sessions/NAME) against a goal: the end state, the steps it took, and the
log of predictions (each one next to the screen that followed, for a reader to judge).
  tools/fm1_sim/grade.py GOAL [SESSION_DIR]   GOAL: patch | preset | layer | tempo | rowboat"""
import json, os, subprocess, sys

ROW = "C C C D E E D E F G C C C G G G E E E C C C G F E D C".split()   # the tune, in C (any key, any octave)
PC = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def intervals(pitches):
    return [b - a for a, b in zip(pitches, pitches[1:])]


def tune_match(notes):
    """How many notes of the tune, from its start, the track's notes in step order play (transposed or not; octave
    jumps folded: the high C of the third line may be written an octave down)"""
    want = [PC[n] for n in ROW]
    have = [p % 12 for p in notes]
    best = 0
    for start in range(len(have)):
        k = 0
        shift = (have[start] - want[0]) % 12
        while k < len(want) and start + k < len(have) and (have[start + k] - want[k]) % 12 == shift:
            k += 1
        best = max(best, k)
    return best


SIM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "build", "fm1_sim", "fm1_sim")


def heard_after(d, st):
    """The session's actions replayed, then PLAY (if stopped) and 16 s of listening: the notes the sequencer plays"""
    acts = open(os.path.join(d, "actions.txt")).read().splitlines()
    extra = ([] if st["transport_running"] else ["press PLAY"]) + ["listen 16000"]
    tmp = os.path.join(d, "grade-actions.txt")
    open(tmp, "w").write("\n".join(acts + extra) + "\n")
    out = os.path.join(d, "grade-heard.txt")
    subprocess.run([SIM, tmp, os.path.join(d, "grade.ppm"), os.path.join(d, "grade-state.json"), out], check=False)
    lines = [l for l in open(out) if l.startswith("notes:")]
    line = lines[-1] if lines else "notes: (none)"          # the last listen: the grader's own
    names = line.split(":", 1)[1].split()
    pitches = []
    for n in names:
        if n == "(none)":
            continue
        k = 2 if len(n) > 2 and n[1] == "#" else 1
        pitches.append(PC[n[:k]] + 12 * (int(n[k:]) + 1))
    return pitches


def main():
    goal = sys.argv[1]
    d = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "..", "build", "fm1_sim", "sessions", "latest")
    # the session replayed with this build: the end state fresh (the simulator is deterministic)
    subprocess.run([SIM, os.path.join(d, "actions.txt"), os.path.join(d, "final.ppm"), os.path.join(d, "final-state.json")], check=False)
    st = json.load(open(os.path.join(d, "final-state.json")))
    log = [json.loads(l) for l in open(os.path.join(d, "log.jsonl"))]
    done = json.load(open(os.path.join(d, "done.json"))) if os.path.exists(os.path.join(d, "done.json")) else None
    acts = [e for e in log if e["tool"] not in ("look", "done")]
    out = {"goal": goal, "actions": len(acts), "said": done}
    if goal == "rowboat":
        played = heard_after(d, st)
        out["played"] = len(played)
        best = tune_match(played)
        out["tune_notes_in_order"] = best
        out["first_line"] = best >= 5
        out["whole_song"] = best >= len(ROW)
        out["reached"] = best >= 5
    elif goal == "layer":
        dv = st["devices"]
        out["armed"] = [x["name"] for x in dv if x["armed"]]
        # separate sounds, as listen counts them: an armed instrument fed by an armed track is that track's sound
        sounds = [x["name"] for x in dv if x["armed"] and not (x["fed_by"] >= 0 and dv[x["fed_by"]]["armed"])]
        out["sounds"] = sounds
        out["reached"] = len(sounds) >= 2
    elif goal == "patch":
        out["patch"] = st["patch"]
        out["reached"] = st["patch_slot"] != 1 and st["card"] == 0
    elif goal == "tempo":
        out["tempo"] = st["tempo"]
        out["reached"] = st["tempo"] == 100
    elif goal == "preset":
        out["presets"] = {x["name"]: x["preset"] for x in st["devices"] if x["preset"]}
        out["reached"] = any(v and v != "INIT" for v in out["presets"].values())
    out["predictions"] = [{"step": e["step"], "tool": e["tool"], "args": {k: v for k, v in e["args"].items() if k != "expect"},
                           "expect": e["args"].get("expect", ""), "screen": e["screen"], "heard": e.get("heard", "")} for e in acts]
    json.dump(out, sys.stdout, indent=1)
    print()


main()
