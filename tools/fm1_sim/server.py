#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""The FM-1 as a set of tools for a naive player (an MCP server on stdio, standard library only).

Each tool is one thing a person does with the FM-1: press a button, hold one, turn a knob, play a key, wait, listen.
Every action asks for `expect`: what the player predicts will happen. The prediction is logged next to the screen that
followed, so a grader can tell a player who understood from one who got there by trying things.

The firmware runs in build/fm1_sim (firmware/test/fm1_sim.c), replaying the session's actions from power-on each time.
A session is a folder under build/fm1_sim/sessions/ (FM1_SIM_SESSION names it): actions.txt, log.jsonl, screen-N.png,
state.json (for the grader only: no tool returns it), heard.txt. build/fm1_sim/sessions/latest points at the newest
(tools/fm1_sim/watch.py shows it live).

Claude Code starts this server once and shares it between every copy of the agent that uses it: run one player at a
time, or their actions mix in one session."""
import base64, json, os, struct, subprocess, sys, time, zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SIM = os.path.join(ROOT, "build", "fm1_sim", "fm1_sim")
SESSIONS = os.path.join(ROOT, "build", "fm1_sim", "sessions")
BUTTONS = ["OCT-", "OCT+", "FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"]
KNOBS = ["SELECT", "ALGO", "K1", "K2", "K3", "K4", "PRESET"]
SCALE = 3

NEW = os.path.join(ROOT, "build", "fm1_sim", "NEW_SESSION")   # touched before a run: the next call starts afresh
SESSION = ACTIONS = LOG = None
step = 0


def new_session(label=None):
    """A session from power-on: its own folder, `latest` pointing at it"""
    global SESSION, ACTIONS, LOG, step
    name = time.strftime("%Y%m%d-%H%M%S") + "-%d" % os.getpid() + ("-" + label if label else "")
    SESSION = os.path.join(SESSIONS, name)
    os.makedirs(SESSION, exist_ok=True)
    latest = os.path.join(SESSIONS, "latest")
    try:
        if os.path.islink(latest) or os.path.exists(latest):
            os.remove(latest)
        os.symlink(name, latest)
    except OSError:
        pass
    ACTIONS = os.path.join(SESSION, "actions.txt")
    LOG = os.path.join(SESSION, "log.jsonl")
    open(ACTIONS, "a").close()
    step = 0


def session_check():
    """A new session when the flag file is there (its text: the run's label) or none is open yet"""
    if os.path.exists(NEW):
        label = open(NEW).read().strip() or None
        os.remove(NEW)
        new_session(label)
    elif SESSION is None:
        new_session(os.environ.get("FM1_SIM_SESSION"))


def png(ppm_path, out_path):
    d = open(ppm_path, "rb").read()
    w = h = 240
    px = d[len(d) - w * h * 3:]
    raw = bytearray()
    for y in range(h):
        row = px[y * w * 3:(y + 1) * w * 3]
        big = b"".join(row[i:i + 3] * SCALE for i in range(0, len(row), 3))
        raw += (b"\x00" + big) * SCALE

    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)

    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w * SCALE, h * SCALE, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))
    open(out_path, "wb").write(data)
    return data


def run(lines, tool, args):
    """Append the action lines, replay the session, log it; the new screen as PNG bytes and what was heard"""
    global step
    with open(ACTIONS, "a") as f:
        for ln in lines:
            f.write(ln + "\n")
    ppm = os.path.join(SESSION, "screen.ppm")
    heard = os.path.join(SESSION, "heard.txt")
    settled_ppm = os.path.join(SESSION, "settled.ppm")
    r = subprocess.run([SIM, ACTIONS, ppm, os.path.join(SESSION, "state.json"), heard, settled_ppm], capture_output=True, text=True)
    step += 1
    shot = os.path.join(SESSION, "screen-%03d.png" % step)
    data = png(ppm, shot)
    settled = None
    if os.path.exists(settled_ppm) and open(settled_ppm, "rb").read() != open(ppm, "rb").read():
        settled_shot = os.path.join(SESSION, "screen-%03d-settled.png" % step)
        settled = png(settled_ppm, settled_shot)
    listened = sum(1 for ln in lines if ln.startswith("listen"))
    text = ""
    if listened and os.path.exists(heard):              # this action's listen: the last block of the replay's heard file
        blocks = open(heard).read().strip().split("notes:")
        text = ("notes:" + blocks[-1]).strip() if len(blocks) > 1 else ""
    with open(LOG, "a") as f:
        f.write(json.dumps({"step": step, "tool": tool, "args": args, "screen": os.path.basename(shot),
                            "settled": "screen-%03d-settled.png" % step if settled else None, "heard": text,
                            "sim_rc": r.returncode, "t": time.time()}) + "\n")
    return data, settled, text, r.returncode


def screens(data, settled):
    """The screen right after the action, and (when it differs) a moment later with nothing touched"""
    if not settled:
        return [img(data)]
    return [{"type": "text", "text": "Right after:"}, img(data),
            {"type": "text", "text": "A moment later, if you touch nothing (messages gone):"}, img(settled)]


def heard_words(text):
    """What a person with a good ear would say: silence or sound, how many sounds, the melody if a sequence played"""
    info = dict(ln.split(": ", 1) for ln in text.splitlines() if ": " in ln)
    peak = float(info.get("peak", "0") or 0)
    notes = info.get("notes", "(none)")
    sounds = int(info.get("sounds", "0") or 0)
    if peak < 1000:
        return "You hear: silence."
    out = "You hear: " + ("two or more different sounds at once." if sounds >= 2 else "sound.")
    if notes != "(none)":
        out += " A sequence plays these notes, in order: " + notes + "."
    return out


def schema(props, required):
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


EXPECT = {"type": "string", "description": "What you expect to see on the screen, or hear, right after this action."}
TOOLS = [
    {"name": "look", "description": "Look at the FM-1's screen without touching anything.",
     "inputSchema": schema({}, [])},
    {"name": "press", "description": "Press and release one button. Buttons: " + ", ".join(BUTTONS) + ".",
     "inputSchema": schema({"button": {"type": "string", "enum": BUTTONS}, "expect": EXPECT}, ["button", "expect"])},
    {"name": "hold", "description": "Press a button and keep holding it (until release). Use for combinations: hold, then press or turn something else, then release.",
     "inputSchema": schema({"button": {"type": "string", "enum": BUTTONS}, "expect": EXPECT}, ["button", "expect"])},
    {"name": "release", "description": "Let go of a held button.",
     "inputSchema": schema({"button": {"type": "string", "enum": BUTTONS}, "expect": EXPECT}, ["button", "expect"])},
    {"name": "turn", "description": "Turn a knob by a number of clicks: positive clockwise, negative counter-clockwise. Knobs: " + ", ".join(KNOBS) + ".",
     "inputSchema": schema({"knob": {"type": "string", "enum": KNOBS}, "clicks": {"type": "integer", "minimum": -64, "maximum": 64}, "expect": EXPECT}, ["knob", "clicks", "expect"])},
    {"name": "play_key", "description": "Play one key: press it and let go, as you would for a single note. Keys are numbered 1 to 27 from the left; at the default octave key 1 is F3, key 8 is C4 (middle C), key 20 is C5. To hold a key (a chord, or a key held while you do something else) use key_down and key_up instead.",
     "inputSchema": schema({"key": {"type": "integer", "minimum": 1, "maximum": 27}, "expect": EXPECT}, ["key", "expect"])},
    {"name": "key_down", "description": "Press a key and keep it held (until key_up): for chords, or a key held while you turn or press something else. Keys are numbered as for play_key.",
     "inputSchema": schema({"key": {"type": "integer", "minimum": 1, "maximum": 27}, "expect": EXPECT}, ["key", "expect"])},
    {"name": "key_up", "description": "Let go of a held key.",
     "inputSchema": schema({"key": {"type": "integer", "minimum": 1, "maximum": 27}, "expect": EXPECT}, ["key", "expect"])},
    {"name": "wait", "description": "Let time pass (milliseconds, up to 10000) without touching anything.",
     "inputSchema": schema({"ms": {"type": "integer", "minimum": 1, "maximum": 10000}, "expect": EXPECT}, ["ms", "expect"])},
    {"name": "listen", "description": "Listen for a while (milliseconds, up to 10000), keeping held keys and buttons held. You are told whether you hear sound and, if a sequence plays, its notes.",
     "inputSchema": schema({"ms": {"type": "integer", "minimum": 1, "maximum": 10000}, "expect": EXPECT}, ["ms", "expect"])},
    {"name": "done", "description": "Say you are finished: you reached the goal, or you are giving up. Describe what you believe the FM-1's state is now.",
     "inputSchema": schema({"result": {"type": "string", "enum": ["reached", "gave_up"]}, "belief": {"type": "string"}}, ["result", "belief"])},
]


def call(tool, a):
    session_check()
    if tool == "look":
        data, settled, _, _ = run([], tool, a)
        return screens(data, settled)
    if tool == "done":
        with open(os.path.join(SESSION, "done.json"), "w") as f:
            json.dump(a, f)
        run([], tool, a)
        return [{"type": "text", "text": "Noted. Stop here."}]
    m = {"press": lambda: ["press " + a["button"]], "hold": lambda: ["down " + a["button"]],
         "release": lambda: ["up " + a["button"]], "turn": lambda: ["turn %s %d" % (a["knob"], a["clicks"])],
         "play_key": lambda: ["keydown %d" % a["key"], "listen 150", "keyup %d" % a["key"]],   # (heard while pressed)
         "key_down": lambda: ["keydown %d" % a["key"], "listen 300"], "key_up": lambda: ["keyup %d" % a["key"]],
         "wait": lambda: ["wait %d" % a["ms"]], "listen": lambda: ["listen %d" % a["ms"]]}
    if tool not in m:
        raise ValueError("no such tool")
    if not str(a.get("expect", "")).strip():
        return [{"type": "text", "text": "Say what you expect first (the expect field), then act."}]
    data, settled, text, rc = run(m[tool](), tool, a)
    out = screens(data, settled)
    if tool in ("listen", "play_key", "key_down"):
        out.append({"type": "text", "text": heard_words(text)})
    if rc == 3:
        out.append({"type": "text", "text": "(That action could not be done.)"})
    return out


def img(data):
    return {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/png"}


def reply(i, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": i}
    if error:
        msg["error"] = {"code": -32603, "message": error}
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    meth, i = req.get("method"), req.get("id")
    if i is None:
        continue                                    # a notification (initialized, cancelled)
    try:
        if meth == "initialize":
            reply(i, {"protocolVersion": req.get("params", {}).get("protocolVersion", "2025-06-18"),
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "fm1", "version": "0.1"}})
        elif meth == "tools/list":
            reply(i, {"tools": TOOLS})
        elif meth == "tools/call":
            p = req.get("params", {})
            reply(i, {"content": call(p.get("name"), p.get("arguments") or {})})
        elif meth == "ping":
            reply(i, {})
        else:
            reply(i, error="unknown method " + str(meth))
    except Exception as e:                          # a tool error goes back as text, the server keeps going
        reply(i, {"content": [{"type": "text", "text": "error: %s" % e}], "isError": True})
