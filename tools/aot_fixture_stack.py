#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Exercise a compiled worker with a supplied patch in an emulator-only flash image.

No MIDI device or physical flash is accessed. M1EMU names the stack-aware emulator.
Example: tools/aot_fixture_stack.py BIN ELF PATCH --worker pair --margin 128
"""
import argparse
import binascii
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bin", type=Path)
    parser.add_argument("elf", type=Path)
    parser.add_argument("patch", type=Path)
    parser.add_argument("--worker", choices=("poly", "pair"), default="poly")
    parser.add_argument("--margin", type=int, default=0, help="extra bytes kept above the existing 256-byte guard")
    args = parser.parse_args()
    if args.margin < 0:
        parser.error("margin must be nonnegative")
    image = args.bin.resolve()
    emulator = Path(os.environ.get("M1EMU", "tools/emu/target/release/m1emu")).resolve()
    symbols = {}
    for line in subprocess.check_output(["nm", str(args.elf)], text=True).splitlines():
        words = line.split()
        if len(words) == 3:
            symbols[words[2]] = int(words[0], 16)
    worker = symbols["aot_pair_worker" if args.worker == "pair" else "aot_lane1_job"]
    names = ("fm1_c1_on", "fm1_c1_gave_up", "c1_pass", "c1_fail", "aot_nx", "transport_on")
    addresses = [symbols[name] for name in names]
    patch = args.patch.read_bytes()
    if not 0 < len(patch) <= 3840:
        parser.error("patch must fit a device slot")
    # slotstore.c: slot 0, sequence 1, header at 0x97000, payload 256 bytes later.
    flash = bytearray(b"\xff" * (1 << 20))
    def record(address, slot, name, data):
        header = struct.pack("<IIIII20sII", 0x3253314D, slot, 1, len(data),
                             binascii.crc_hqx(data, 0xffff), name, 0, 0)
        flash[address:address + len(header)] = header
        flash[address + 256:address + 256 + len(data)] = data
    record(0x97000, 0, b"AOT STACK FIXTURE", patch)
    # Emulator settings only: no quick-start overlay, global tempo 120, analog output on.
    # Matching checkout, as for BIN/ELF: mark the current factory set to avoid unrelated migration work.
    root = Path(__file__).resolve().parent.parent
    fmt = int(re.search(r"#define ENG_PATCH_VERSION (\d+)", (root / "firmware/src/engine.h").read_text())[1])
    factory = int(re.search(r"#define FACTORY_SET_ID (0x[0-9a-f]+)", (root / "firmware/src/presets.h").read_text())[1], 16)
    settings = bytes((1, 0, 8, 0, 2, 120, 0, 128, 0, 0, fmt, 0, 0)) + factory.to_bytes(3, "little")
    record(0x98000, 64, b"", settings)
    floor = symbols["_c1_ustack"] + 256 + args.margin
    env = dict(os.environ, M1EMU_C1_STACK_LOW=f"{floor:x}", M1EMU_C1_WATCH_PC=f"{worker:x}")
    keys = "5000:PLAY,5200:PLAY^," + ",".join(f"{at}:m90{note:02x}64" for at, notes in
                                  ((6000, (60, 64, 67, 71)), (8000, (72, 76, 79, 83))) for note in notes)
    with tempfile.TemporaryDirectory(prefix="aot-fixture-stack-") as tmp:
        path = Path(tmp) / "flash.bin"
        path.write_bytes(flash)
        run = subprocess.run([str(emulator), "run", str(image), "--flash-in", str(path), "--ms", "10000",
                              "--keys", keys, "--peek", ",".join(f"{a & ~3:x}" for a in addresses)],
                             cwd=tmp, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(run.stdout, end="")
    run.check_returncode()
    words = {int(a, 16): int(v, 16) for a, v in re.findall(r"peek 0x([0-9a-f]+) = 0x([0-9a-f]+)", run.stdout)}
    byte = lambda a: (words[a & ~3] >> (8 * (a & 3))) & 255
    on, gave, passed, failed, count, transport = addresses
    assert byte(on) == 1 and byte(gave) == 0 and words[passed] > 0 and words[failed] == 0, "core health failed"
    assert byte(count) > 0, "fixture did not bind a compiled assembly"
    assert byte(transport) == 1, "sequencers were not running"
    assert f"core 1 reached watched pc {worker:#010x}" in run.stdout, "requested worker never executed"
    played = re.search(r"(\d+) ms emulated.*audio peak (\d+)", run.stdout)
    assert played and int(played[1]) >= 10000 and int(played[2]) > 0, "played check did not finish"
    print(f"PASS: {args.worker} worker, two healthy cores, stack stayed {args.margin} bytes above its guard")


if __name__ == "__main__":
    main()
