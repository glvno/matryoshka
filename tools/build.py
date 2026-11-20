#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
"""Build Matryoshka: the app, the update loader and an installable .fwsc package.

  tools/build.py [--release X.Y.Z[-suffix]] [--out-dir build/variant]

Outputs in build/ (or --out-dir, within build/): matryoshka.bin (app), loader/ota.bin (update loader),
matryoshka.fwsc (package) and matryoshka.json (its version, identity, size and sha256). A release build
(--release X.Y.Z) writes matryoshka-X.Y.Z.fwsc / .json and a folder release-X.Y.Z/ with those, the app, SHA256SUMS, the sample attribution and the licence files.
Identity: FM-1_7MMmmpp (7, then major, minor and patch as two digits each: 1.8.0 = FM-1_7010800); dev and CI builds
FM-1_7000000 (#216).
See BUILDING.md for the toolchain and the SDK.

Every build is for the AC791N's single-precision FPU (FPU_FLAGS, the toolchain's r3 libraries; #979, D-1111). M1_BENCH=1
(a measurement build, never released, #950) compiles in the CPU benchmark (firmware/src/bench.c, DIAG pages 178..,
tools/m1_link.py fpubench) and links the toolchain's libm. It defaults to 0.

The JieLi toolchain is Linux x86-64 only. JIELI_TOOLCHAIN points at it; on
macOS (or with JIELI_DOCKER=1) each tool runs in a linux/amd64 container.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SRC = Path(__file__).resolve().parents[1]
FW = SRC / "firmware"
OUT = SRC / "build"
GEN = OUT / "gen"
LDR = OUT / "loader"
sys.path.insert(0, str(SRC / "tools"))
import fm1pkg_make  # noqa: E402
import lz4blk  # noqa: E402

APP_XIP = 0x02000120                # app.bin offset 0 in the XIP map; the SPL jumps here
APP_SLOT = fm1pkg_make.APP_SLOT
LOADER_LOAD = 0x01C0A800
LOADER_NAME = b"usb_hid_ota.bin"    # the file name the SPL looks for
DOCKER_IMAGE = os.environ.get("JIELI_DOCKER_IMAGE", "debian:bookworm-slim")
CFLAGS = ["-Os", "-ffunction-sections", "-fno-builtin", "-Wall", "-Wno-unused-function"]
APP_SWITCHES = ("FELUCCA_FLASH", "FELUCCA_OTA", "FELUCCA_OTA_DRYRUN", "FELUCCA_OTA_RAMONLY", "FELUCCA_CDC",
                "FELUCCA_UAC", "FELUCCA_UAC_TONE", "FELUCCA_UAC_48K", "FELUCCA_ICONS", "FELUCCA_SLICE", "FELUCCA_FM4",
                "FELUCCA_CDC_DEFAULT", "FELUCCA_UAC_AS_FIRST", "FELUCCA_UAC_MIDI_LAST", "FELUCCA_USB_HS", "M1_EMU_MIDI",
                "ENG_AOT", "ENG_BUF_REUSE", "M1_BENCH")
SPEED = "-O2"                       # the app's audio path (#798, tools/size_fns.py); FELUCCA_SPEED=0 builds it at -Os
# what JieLi's AC79 SDK and FM1 Open compile with (#950, #979): the single-precision FPU (-mcpu=r3 -mfprev1), and every
# float result rounded as written (no fused multiply-add)
FPU_FLAGS = ["-mcpu=r3", "-mfprev1", "-ffp-contract=off"]
# Functions that run from SRAM (#1072, #803): their compiled sections (-ffunction-sections: .text.NAME) are renamed
# .fast_text.NAME in matryoshka.o before the link, so the code is the compiler's own, only placed elsewhere (app.ld .fast_text,
# in NOINIT, copied there at boot by main.c). Only functions the compiler keeps out of line everywhere: a section attribute in
# the source would instead stop this compiler inlining across the two sections and change the code. Code from the flash
# runs through a 32 KB instruction cache that a block's code overflows, so most of it is fetched again every block (about
# 2 us a 64-byte line); the list is the code with the most of those fetches per byte, in the emulator's timing model over
# the poly benchmark (web/scripts/poly-bench.ts, `m1emu cpu --modtime` with M1EMU_PROF on a build with ENG_RAMCODE=0;
# docs/measurements/2026-11-18-poly-headroom.md), whole functions, greedy up to 12.64 KB. Profiled on the 1.20 headroom
# build (float filters, Reverb, Delay and Low pass gate; #979), whose hot code differs from the fixed-point build's.
# It must fit in NOINIT after .noinit (build.py checks), and nothing in it may run before fm1_cstart copies it there (the
# P33 helpers that read the reset reason do). Only this file's functions: the compiler-rt helpers are not renamed.
# Calls and tail calls between the flash and NOINIT are the 4-byte forms, within their +-4 MiB reach
# (tools/emu/src/isa_tests.rs). ENG_RAMCODE=0 leaves everything in the flash. A benchmark build (M1_BENCH=1) defaults to
# 0: its buffers in NOINIT (bench.c, about 4.8 KB) leave no room for the list there.
RAMCODE = os.environ.get("ENG_RAMCODE", "0" if os.environ.get("M1_BENCH") == "1" else "1")
FAST_TEXT = (
    "toast_wanted", "bt_c1_job", "usb_retry", "eng_find", "eng_transport_running", "eng_steps_module", "eng_steps_take",
    "pages_select", "panel_key_queue", "exp2_scale", "fm1_led_key", "env_rate_q8", "seq_rec_sync", "pages_at",
    "unit_of", "fm1_adc_read", "uac_tap", "host_poll", "keys_report", "uac_render_start", "ctl_rate", "div64_lu",
    "fm1_timer2_irq", "ctl_ramp16", "value_of", "fm1_alnk0_irq", "eng_lane_run", "eng_section_at", "reverb_kernel",
    "group_cables", "fm1__sr_bits", "eng_records_end", "sch_lane", "eng_steps_rec", "eng_click_mix", "eng_rec_size",
    "ana_init", "eng_udivmod64", "batt_mark_sync", "ctl_ramp30", "lcd_blit",
) if RAMCODE == "1" else ()
LINE = re.compile(r"^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+)\s*\t(.*)$")

# SDK files of AC79NN_SDK_V1.2.1_2023-12-13 (the tested version)
SDK_SHA256 = {
    "uboot.boot": "4e3b4c220dc96641cb5a723f41e68ce41d5261ae9434bb33fbd7f2c59976ded4",
    "cfg_tool.bin": "276579954f076886a6a7694f65dc71c034a63a2c204b76749065c0ac7b010d1b",
    "cfg/eq_cfg_hw.bin": "41167491bffed4651750719c973d2758adeb9021a5670d02d6a53c85ed80ea7d",
}

PRODUCT = "FM-1_7000000"            # package identity (#216: Matryoshka = FM-1_7MMmmpp, dev and CI builds 7000000; before 1.8
                                     # FM-1_7XY; M-VAVE stock 0XX, M-VAVE Open 8 + 6 digits, Felucca 9XY); must match FELUCCA_ID
                                     # in firmware/src/modular.c
VERSION = None                      # FELUCCA_VERSION for release builds (default: firmware/src/modular.c)
FW_VERSION = (0, 0, 0)              # major, minor, patch: INFO's last three bytes (proto.c), 0.0.0 = a dev or CI build
MARKER_MAX = 20                     # the .fwsc marker: one character after each of the first 20 blocks (fm1pkg_make.ufw)
HANDSHAKE_MAX = 27                  # the identity handshake's body (ota.c ota_reply_identity)


def release_identity(release):
    """--release X.Y.Z[-suffix] -> (identity, version string, (major, minor, patch)); SystemExit when it does not fit"""
    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{1,2})(?:-([A-Za-z0-9]+))?", release)
    if not m:
        raise SystemExit(f"--release {release}: use X.Y.Z or X.Y.Z-suffix (patch required), each 0..99")
    ver = tuple(int(x) for x in m.groups()[:3])
    if ver == (0, 0, 0):
        raise SystemExit("--release 0.0.0: that is the identity of dev and CI builds")
    product = "FM-1_7" + "".join(f"{x:02d}" for x in ver)
    version = "v" + ".".join(map(str, ver)) + ("-" + m[4].upper() if m[4] else "")   # v1.8.0, v1.8.0-RC1
    check_identity(product)
    return product, version, ver


def check_identity(product):
    """the identity fits the .fwsc marker and the handshake, and no marker byte encodes to 0x7D (fm1pkg_make.ufw)"""
    if len(product) > MARKER_MAX or len(product) > HANDSHAKE_MAX:
        raise SystemExit(f"identity {product!r}: at most {MARKER_MAX} characters")
    if any((ord(c) + i + 1) & 0xFF == 0x7D for i, c in enumerate(product)):
        raise SystemExit(f"identity {product!r}: a character encodes to the unused marker 0x7D")


def toolchain():
    tc = os.environ.get("JIELI_TOOLCHAIN")
    if not tc or not (Path(tc) / "pi32v2" / "bin" / "clang").exists():
        raise SystemExit("JIELI_TOOLCHAIN must point at the JieLi Linux toolchain "
                         "(the directory with pi32v2/ and common/; see tools/get_toolchain.sh)")
    return Path(tc).resolve()


def use_docker():
    native = platform.system() == "Linux" and platform.machine() in ("x86_64", "AMD64")
    return os.environ.get("JIELI_DOCKER", "0" if native else "1") == "1"


def tc(tool, *args):
    """run a toolchain binary (pi32v2/bin/..., common/bin/...) with cwd SRC; paths relative to SRC"""
    rel = [str(Path(a).resolve().relative_to(SRC)) if isinstance(a, Path) else a for a in args]
    if tool == "cc":                # the toolchain's cc wrapper needs python3; call clang directly
        tool, rel = "pi32v2/bin/clang", ["-target", "pi32v2", *rel]
    if use_docker():
        cmd = ["docker", "run", "--rm", "--platform", "linux/amd64", "-v", f"{SRC}:/work",
               "-v", f"{toolchain()}:/opt/jieli:ro", "-w", "/work", DOCKER_IMAGE, f"/opt/jieli/{tool}", *rel]
    else:
        cmd = [str(toolchain() / tool), *rel]
    r = subprocess.run(cmd, cwd=SRC, capture_output=True, text=True)
    if r.returncode:
        sys.stderr.write(r.stdout + r.stderr)
        raise SystemExit(f"build: {tool} failed")
    if r.stderr.strip():
        sys.stderr.write(r.stderr)
    return r.stdout


def tc_all(*cmds):
    with ThreadPoolExecutor(len(cmds)) as ex:
        return list(ex.map(lambda c: tc(*c), cmds))


def generate():
    """generated headers (UI fonts, icons, keycaps, palettes, tables, samples)"""
    GEN.mkdir(parents=True, exist_ok=True)
    for old in ("felucca_font.h", "felucca_icons.h"):     # headers of the bitmap font and icon atlas
        (GEN / old).unlink(missing_ok=True)
    tools = SRC / "tools"
    cmds = [[tools / "gen_aa_font.py", GEN / "ui_fonts.h", "--preset", "inter-tight"],
            [tools / "gen_aa_icons.py", GEN / "ui_icons.h"],
            [tools / "gen_aa_keycaps.py", GEN / "ui_keycaps.h"],
            [tools / "gen_ui_palettes.py", GEN / "ui_palettes.h"],
            [tools / "gen_tables.py", GEN / "felucca_tables.h"],
            [tools / "gen_fm6_patches.py", GEN / "felucca_fm6.h"],
            [tools / "gen_samples.py", GEN / "felucca_samples.h"]]
    procs = [subprocess.Popen([sys.executable, *map(str, c)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True) for c in cmds]
    failed = []
    for c, p in zip(cmds, procs):
        sys.stdout.write(p.communicate()[0])
        if p.returncode:
            failed.append(c[0].name)
    if failed:
        raise SystemExit(f"build: {', '.join(failed)} failed")


# ---- update loader

def crc16(d, c=0):
    for b in d:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) if c & 0x8000 else c << 1
        c &= 0xFFFF
    return c


def ldr_head(dcrc, a, b, attr, name):
    body = struct.pack("<HIIBBH16s", dcrc, a, b, attr, 0, 0, name)
    return struct.pack("<H", crc16(body)) + body


def ldr_wrap(image):
    """ota.bin = outer JLFS head (32 B) + inner head (32 B, load address) +
    blocks [clen u32][dlen u32][LZ4 block], dlen 4096 except the last"""
    blocks = bytearray()
    for i in range(0, len(image), 4096):
        raw = image[i:i + 4096]
        c = lz4blk.compress(raw)
        if len(c) > 4096 or lz4blk.decompress(c) != raw:
            raise SystemExit(f"loader: block {i // 4096} does not compress below 4096 B")
        blocks += struct.pack("<II", len(c), len(raw)) + c
    inner = ldr_head(crc16(image), len(image), LOADER_LOAD, 0, LOADER_NAME)
    body = inner + bytes(blocks)
    return ldr_head(crc16(body), 0x20, len(body), 0x41, LOADER_NAME) + body


def build_loader():
    LDR.mkdir(parents=True, exist_ok=True)
    src = FW / "loader"
    for switch in ("ENG_AOT", "ENG_RAMCODE", "ENG_BUF_REUSE"):
        if os.environ.get(switch, "0") not in ("0", "1"):
            raise SystemExit(f"{switch} must be 0 or 1")
    flags = [*CFLAGS, "-Ifirmware/hal", "-Ifirmware/src"]
    tc_all(("cc", "-c", src / "crt0_ldr.S", "-o", LDR / "crt0_ldr.o"),
           ("cc", *flags, "-c", src / "loader.c", "-o", LDR / "loader.o"))
    elf = LDR / "loader.elf"
    tc("pi32v2/bin/ld", "--gc-sections", "-e", "_start", "-T", src / "loader.ld",
       LDR / "crt0_ldr.o", LDR / "loader.o", "-o", elf)
    _, dis, hdr, syms = tc_all(("common/bin/objcopy", "-O", "binary", "-j", ".text", elf, LDR / "loader.bin"),
                               ("common/bin/objdump", "-d", elf),
                               ("common/bin/objdump", "-h", elf),
                               ("common/bin/objdump", "-t", elf))
    (LDR / "loader.dis").write_text(dis)
    for ln in hdr.splitlines():     # the loader rewrites the flash: nothing may run from XIP
        p = ln.split()
        if len(p) > 4 and p[1].startswith(".") and int(p[3], 16) >= 0x02000000 and int(p[2], 16):
            raise SystemExit(f"loader: section {p[1]} at {p[3]} is outside RAM")
    image = (LDR / "loader.bin").read_bytes()
    if not image or len(image) > 0x14000:
        raise SystemExit("loader: image empty or too big")
    ota = ldr_wrap(image)
    (LDR / "ota.bin").write_bytes(ota)
    bss = [int(ln.split()[0], 16) for ln in syms.splitlines() if ln.rstrip().endswith("_bss_end")]
    print(f"loader: image {len(image)} B at {LOADER_LOAD:#x}" + (f", bss end {bss[0]:#x}" if bss else ""))
    print(f"loader: ota.bin {len(ota)} B")
    return ota


# ---- app

def ld_regions():
    """firmware/app.ld's MEMORY regions: name -> (origin, length)"""
    regs = {}
    for m in re.finditer(r"^\s*(\w+)\s*\([rwx]+\)\s*:\s*ORIGIN\s*=\s*(\w+),\s*LENGTH\s*=\s*(\w+)",
                         (FW / "app.ld").read_text(), re.M):
        n = m.group(3)
        regs[m.group(1)] = (int(m.group(2), 0), int(n[:-1], 0) * 1024 if n.endswith("K") else int(n, 0))
    return regs


def llvm_objcopy():
    """the host's llvm-objcopy (any version: it copies an ELF of a machine it does not know, relocations and all)"""
    import glob
    for c in ("llvm-objcopy", *(f"llvm-objcopy-{v}" for v in range(25, 13, -1))):
        if shutil.which(c):
            return shutil.which(c)
    found = sorted(glob.glob("/usr/lib/llvm-*/bin/llvm-objcopy")) + sorted(glob.glob("/opt/homebrew/opt/llvm/bin/llvm-objcopy"))
    if found:
        return found[-1]
    raise SystemExit("build: FAST_TEXT needs llvm-objcopy on the host (apt install llvm, brew install llvm)")


TEXT_PINS = os.environ.get("TEXT_PINS", str(FW / "text_pins.txt"))   # functions at fixed flash addresses (text_layout.py);
                                                                      # TEXT_PINS= (empty) links in the compiler's order


def text_ld(lead, main):
    """the linker script and {function: planned address}: firmware/app.ld as it is without TEXT_PINS, else a copy whose
    .text links matryoshka.o's functions in tools/text_layout.py's order"""
    if not TEXT_PINS or not Path(TEXT_PINS).exists():
        return FW / "app.ld", {}
    import text_layout
    lines, where, notes = text_layout.plan(text_layout.read_pins(TEXT_PINS), [text_layout.text_sections(p) for p in lead],
                                           text_layout.text_sections(main))
    for n in notes:
        print(f"text_layout: {n}")
    src = (FW / "app.ld").read_text()
    old = "KEEP(*(.text.crt0)) *(.text*)"
    if src.count(old) != 1:
        raise SystemExit(f"build: app.ld's .text does not read '{old}'")
    files = " ".join(f"*{p.name}(.text*)" for p in lead)
    ld = GEN / "app.ld"
    ld.write_text(src.replace(old, f"KEEP(*(.text.crt0)) {files}\n        " + "\n        ".join(lines) + "\n        *(.text*)"))
    return ld, where


# ---- the FPU's instructions in the disassembly (#979)
# JieLi's objdump cannot print the FPU's instructions (`3f e5` / `3f f5`) nor the float compares: it prints their first two
# bytes as "<unknown instruction>" and reads the rest as an instruction of its own, which can run on into the instruction
# after it and hide that one. The checks read every instruction (check, ram_code_check), so fpu_reread finds the FPU's
# instructions by their encodings (fm1-emu's crates/fm1-isa/src/fpu.rs at the commit tools/emu/Cargo.toml pins),
# disassembles a copy of the ELF with each one replaced by nops, and puts them back in that listing, one line each.
INSN = re.compile(r"^\s*([0-9a-f]+): +((?:[0-9a-f]{2} )+)\s*(\t.*|<unknown instruction>)$")   # also objdump's unknowns
NOP = b"\x00\x00"
FPU_UNARY = {0x1F: "ftoi", 0x5F: "ftou", 0x8F: "itof", 0x9F: "utof"}       # ftoi / ftou truncate
FPU_BINARY = {0: "{d} = {a} + {b}", 1: "{d} = {a} - {b}", 2: "{d} = {a} * {b}", 3: "{d} = {a} / {b}", 5: "{d} = fmin({a}, {b})",
              6: "{d} = fmax({a}, {b})", 7: "{d} += {a} * {b}", 8: "{d} -= {a} * {b}"}
FCMP = {0: ("==", "!="), 1: ("u>=", "<"), 4: ("u>", "<="), 5: (">=", "u<"), 6: (">", "u<=")}   # family: (plain, negated)


def insn_len(b0, b1):
    """an instruction's length from its first two bytes (every instruction objdump prints in the firmware has it)"""
    return 6 if b1 == 0xFF else 4 if b1 >= 0xE0 else 2


def fpu_text(b):
    """what the FPU instruction or float compare b (its bytes) does, as objdump would print it; None if it is neither"""
    w = int.from_bytes(b, "little")
    if len(b) == 4 and b[0] == 0x3F and b[1] in (0xE5, 0xF5):     # f5: the head of a dual-issue pair
        pair = " #" if b[1] == 0xF5 else ""
        if b[2] in FPU_UNARY:
            return f"r{b[3] >> 4} = {FPU_UNARY[b[2]]}(r{b[3] & 15}) (f){pair}"
        op = FPU_BINARY.get(b[2] & 15)
        return op and op.format(d=f"r{b[3] >> 4}", a=f"r{b[2] >> 4}", b=f"r{b[3] & 15}") + f" (f){pair}"
    if len(b) == 4 and b[1] in (0xE8, 0xE9, 0xEC, 0xED, 0xEE):
        op = FCMP[b[1] & 7][b[0] >> 7]
        if b[0] & 0x70 == 0 and w >> 27 & 1:                     # if (rA op rB) goto, the float flag in bit 27
            off = (w >> 16 & 0xFF) | (w >> 24 & 1) << 8
            return f"iff (r{w >> 28} {op} r{w & 15}) goto {2 * (off - 512 if off & 256 else off)}"
        if b[0] & 0x70 == 0x10 and w >> 23 & 1:                  # if (rA op rB) {, the float flag in bit 23
            return f"iff (r{w >> 28} {op} r{w & 15}) {{"
    if len(b) == 6 and b[1] == 0xFF and b[0] >> 4 == 4 and w >> 23 & 1 and b[0] >> 1 & 7 in FCMP:
        off = w >> 32 & 0xFFFF
        return (f"iff (r{w >> 28 & 15} {FCMP[b[0] >> 1 & 7][b[0] & 1]} r{w >> 24 & 15}) goto "
                f"{2 * (off - 65536 if off & 32768 else off)}")
    return None


def fpu_scan(dis):
    """the FPU's instructions in an objdump listing: address -> (bytes, what it does). Each run of instruction lines
    (contiguous addresses, restarted at every label) is walked by instruction length (insn_len), so an instruction that
    objdump's misread swallowed is found as well; one objdump printed itself is left to objdump"""
    found, run = {}, []

    def walk():
        mem, said = {}, {}
        for a, b, t in run:
            said[a] = (len(b), t)
            mem.update((a + i, x) for i, x in enumerate(b))
        pc, end = (run[0][0], run[-1][0] + len(run[-1][1])) if run else (0, 0)
        while pc + 1 < end:
            n = insn_len(mem[pc], mem[pc + 1])
            s = said.get(pc)
            if pc + n <= end and not (s and s[0] == n and "unknown instruction" not in s[1]):
                b = bytes(mem[pc + i] for i in range(n))
                if t := fpu_text(b):
                    found[pc] = (b, t)
            pc += n
        run.clear()

    for ln in dis.splitlines():
        m = INSN.match(ln)
        if m:
            a = int(m.group(1), 16)
            if run and run[-1][0] + len(run[-1][1]) != a:
                walk()
            run.append((a, bytes.fromhex(m.group(2)), m.group(3)))
        elif ln.rstrip().endswith(":"):                          # a label, or a section's start
            walk()
    walk()
    return found


def elf_blank(elf, found, out):
    """write a copy of the ELF with each instruction of found (address -> (bytes, _)) replaced by nops"""
    d = bytearray(elf.read_bytes())
    if d[:6] != b"\x7fELF\x01\x01":
        raise SystemExit(f"{elf}: not a 32-bit little-endian ELF")
    shoff, = struct.unpack_from("<I", d, 32)
    size, count = struct.unpack_from("<HH", d, 46)
    code = [s for s in (struct.unpack_from("<6I", d, shoff + i * size) for i in range(count))
            if s[1] == 1 and s[2] & 4]                          # name, type, flags, address, offset, size: code
    for a, (b, _) in found.items():
        s = next((s for s in code if s[3] <= a and a + len(b) <= s[3] + s[5]), None)
        o = s and s[4] + a - s[3]
        if s is None or d[o:o + len(b)] != b:
            raise SystemExit(f"{elf}: no code section holds {b.hex(' ')} at {a:#x}")
        d[o:o + len(b)] = NOP * (len(b) // 2)
    out.write_bytes(d)


def fpu_merge(dis, found, whole=False):
    """the listing of elf_blank's copy with the FPU's instructions back in place of their nops (whole: the listing of
    every section, which must hold each of them)"""
    out, put, lo, hi = [], set(), 0, 0
    for ln in dis.splitlines():
        m = INSN.match(ln)
        a = int(m.group(1), 16) if m else -1
        if a in found:
            b, t = found[a]
            out.append(f" {a:x}:    {b.hex(' ') + ' ':<18}\t{t}")
            put.add(a)
            lo, hi = a, a + len(b)
        elif not lo < a < hi:
            out.append(ln)
    if whole and put != found.keys():
        raise SystemExit(f"build: the second listing has no instruction at {min(found.keys() - put):#x}")
    return "\n".join(out) + "\n"


def fpu_reread(elf, dis, rt, c1):
    """the listings (whole, .ram_text, .c1_text) with every FPU instruction on a line of its own and every other
    instruction as objdump prints it; unchanged, with no second objdump, when the firmware has none"""
    found = fpu_scan(dis)
    if not found:
        return dis, rt, c1
    copy = elf.with_name(elf.stem + "-nofpu.elf")
    elf_blank(elf, found, copy)
    again = tc_all(("common/bin/objdump", "-d", copy), ("common/bin/objdump", "-d", "-j", ".ram_text", copy),
                   ("common/bin/objdump", "-d", "-j", ".c1_text", copy))
    return tuple(fpu_merge(t, found, i == 0) for i, t in enumerate(again))


def build_app():
    for switch in ("ENG_AOT", "ENG_RAMCODE", "ENG_BUF_REUSE", "M1_BENCH"):
        if os.environ.get(switch, "0") not in ("0", "1"):
            raise SystemExit(f"{switch} must be 0 or 1")
    flags = [*CFLAGS, *FPU_FLAGS, "-Ifirmware/hal", "-Ifirmware/src"]
    for flag in APP_SWITCHES:      # unset: defaults in the pinned firmware source
        v = os.environ.get(flag)    # unset: the default in firmware/src/modular.c
        if v in ("0", "1"):
            flags.append(f"-D{flag}={v}")
    v = os.environ.get("FELUCCA_USB_LAYOUT")   # firmware/src/usb.c: how the USB composite presents itself (#67), 0..3
    if v in ("0", "1", "2", "3"):
        flags.append(f"-DFELUCCA_USB_LAYOUT={v}")
    flags.append(f'-DFELUCCA_ID="{PRODUCT}"')
    flags += [f"-DM1_FW_{k}={v}" for k, v in zip(("MAJOR", "MINOR", "PATCH"), FW_VERSION)]
    if VERSION:
        flags.append(f'-DFELUCCA_VERSION="{VERSION}"')
    # #798: the audio path for speed. modular.c goes to LLVM IR at SPEED without the optimizer, tools/size_fns.py marks
    # every function the audio interrupt cannot reach 'optsize' (what -Os gives each function), then the IR is compiled
    # at SPEED. FELUCCA_SPEED=0: -Os everywhere, compiled directly (the build before #798)
    speed = os.environ.get("FELUCCA_SPEED", SPEED)
    size = speed != "0"
    sflags = [f for f in flags if f != "-Os"] + [speed] if size else flags
    cmain = (("cc", *sflags, "-S", "-emit-llvm", "-Xclang", "-disable-llvm-optzns", "-c",
              FW / "src" / "modular.c", "-o", OUT / "matryoshka.ll") if size else
             ("cc", *flags, "-c", FW / "src" / "modular.c", "-o", OUT / "matryoshka.o"))
    tc_all(("cc", "-c", FW / "crt0.S", "-o", OUT / "crt0.o"),
           ("cc", "-c", FW / "hal" / "fm1_vec.S", "-o", OUT / "fm1_vec.o"),
           ("cc", "-c", FW / "hal" / "fm1_isr.S", "-o", OUT / "fm1_isr.o"),
           ("cc", "-c", FW / "hal" / "fm1_cpu1.S", "-o", OUT / "fm1_cpu1.o"),   # the second core's entry (#271)
           cmain)
    if size:
        subprocess.run([sys.executable, SRC / "tools" / "size_fns.py", OUT / "matryoshka.ll", OUT / "matryoshka_size.ll"],
                       check=True)
        tc("cc", *[f for f in sflags if not f.startswith(("-I", "-D", "-W"))], "-c",
           OUT / "matryoshka_size.ll", "-o", OUT / "matryoshka.o")
    if FAST_TEXT:                                       # see FAST_TEXT; the toolchain's objcopy cannot rename
        loc = llvm_objcopy()
        subprocess.run([loc, *[a for f in FAST_TEXT for a in ("--rename-section", f".text.{f}=.fast_text.{f}")],
                        OUT / "matryoshka.o"], check=True)
    elf = OUT / "matryoshka.elf"
    lib = toolchain() / "pi32v2" / "lib" / "r3"     # the FPU's libm and float helpers (FPU_FLAGS)
    libm = [str(lib / "libm.a")] if os.environ.get("M1_BENCH") == "1" else []   # the benchmark's sinf, expf, ...
    lead = [OUT / "crt0.o", OUT / "fm1_vec.o", OUT / "fm1_isr.o", OUT / "fm1_cpu1.o"]
    ld, pinned = text_ld(lead, OUT / "matryoshka.o")
    tc("pi32v2/bin/ld", "-T", ld, *lead, OUT / "matryoshka.o", *libm, str(lib / "libcompiler-rt.a"), "-o", elf)  # (float
    # and 64-bit helpers)
    for sect in ("text.bin", "data.bin", "ramtext.bin", "c1text.bin", "fasttext.bin"):
        (OUT / sect).unlink(missing_ok=True)
    *_, syms, dis, rt, c1 = tc_all(("common/bin/objcopy", "-O", "binary", "-j", ".text", elf, OUT / "text.bin"),
                                   ("common/bin/objcopy", "-O", "binary", "-j", ".data", elf, OUT / "data.bin"),
                                   ("common/bin/objcopy", "-O", "binary", "-j", ".ram_text", elf, OUT / "ramtext.bin"),
                                   ("common/bin/objcopy", "-O", "binary", "-j", ".c1_text", elf, OUT / "c1text.bin"),
                                   ("common/bin/objcopy", "-O", "binary", "-j", ".fast_text", elf, OUT / "fasttext.bin"),
                                   ("common/bin/objdump", "-t", elf),
                                   ("common/bin/objdump", "-d", elf),
                                   ("common/bin/objdump", "-d", "-j", ".ram_text", elf),
                                   ("common/bin/objdump", "-d", "-j", ".c1_text", elf))
    dis, rt, c1 = fpu_reread(elf, dis, rt, c1)
    (OUT / "matryoshka.dis").write_text(dis)

    def symv(name):
        return int(re.search(r"^([0-9a-f]+) .*\s" + name + r"$", syms, re.M).group(1), 16)
    moved = [f"{f} at {symv(f):#x}, not {a:#x}" for f, a in pinned.items() if symv(f) != a]
    if moved:
        raise SystemExit(f"build: pinned functions not where text_layout.py planned them: {'; '.join(moved[:5])}")
    img = bytearray((OUT / "text.bin").read_bytes())
    # .ram_text, .c1_text (the second core's waiting loop, #271) and .data follow .text at their load addresses; the boot
    # copies them by words (main.c fm1_cstart)
    # and .fast_text, the hot code in NOINIT (FAST_TEXT), after .data
    # The boot copies END - START bytes from the load address to START; objcopy's blob starts at the section's own start.
    # They agree only when START is the section's start: padding before START (an output section that begins unaligned)
    # would shift every copied byte (it did: .fast_text after an odd-sized .noinit, #1072).
    for sect, lname, start, end in (("ramtext.bin", "_rt_load", "_rt_start", "_rt_end"),
                                    ("c1text.bin", "_c1_load", "_c1_start", "_c1_end"),
                                    ("data.bin", "_data_load", "_data_start", "_data_end"),
                                    ("fasttext.bin", "_ft_load", "_ft_start", "_ft_end")):
        load = symv(lname)
        if load % 4:
            raise SystemExit(f"{lname} {load:#x} is not word aligned")
        blob = (OUT / sect).read_bytes() if (OUT / sect).exists() else b""
        if len(blob) != symv(end) - symv(start):
            raise SystemExit(f"{sect}: {len(blob)} B, but the boot copies {start}..{end} ({symv(end) - symv(start)} B)")
        if blob:
            if load - APP_XIP < len(img):
                raise SystemExit(f"{lname} overlaps the image")
            img += b"\xff" * (load - APP_XIP - len(img))
            img += blob
    img += b"\xff" * (-len(img) % 4)
    (OUT / "matryoshka.bin").write_bytes(img)
    return bytes(img), syms, dis, (rt, c1)


def unknown(dis):
    """the instructions objdump could not print that fpu_reread did not put back: neither the FPU's nor known to objdump"""
    return [ln.strip() for ln in dis.splitlines() if "<unknown instruction>" in ln]


def ram_code_check(rt, c1):
    """.ram_text and .c1_text (their listings after fpu_reread): (errors, notes)"""
    errors, notes = [], []
    rt_calls = [ln for ln in rt.splitlines() if re.search(r"\bcall\b", ln)]
    # (#656) nor an address in the XIP window: a constant or a jump table the compiler put in .rodata would be read there
    rt_xip = [mm.group(3) for mm in map(LINE.match, rt.splitlines()) if mm
              for v in re.findall(r"(?<![\w.])(-?\d+)\b", mm.group(3)) if 0x02000000 <= int(v) & 0xFFFFFFFF < 0x02100000]
    if unknown(rt):                 # (#979) an instruction the checks cannot read
        errors.append(f".ram_text holds instructions nobody can read: {unknown(rt)[:3]}")
    elif rt_calls:                  # RAM code runs with the flash off: no calls into XIP
        errors.append(f".ram_text contains calls: {rt_calls[:3]}")
    elif rt_xip:
        errors.append(f".ram_text reaches the flash: {rt_xip[:3]}")
    else:
        notes.append(f".ram_text: {len([ln for ln in rt.splitlines() if LINE.match(ln)])} insns, no calls, no flash address")
    # .c1_text (#271): the second core waits in it while core 0 may have the flash off. Its one way out to the flash is
    # the job it was handed (a call through a register); no call to a fixed address, no address in the XIP window
    c1_ins = [mm.group(3) for mm in map(LINE.match, c1.splitlines()) if mm]
    c1_fixed = [i for i in c1_ins if re.search(r"\bcall\b", i) and not re.search(r"\bcall\s+r\d+\b", i)]
    c1_xip = [i for i in c1_ins for v in re.findall(r"(?<![\w.])(-?\d+)\b", i)
              if 0x02000000 <= int(v) & 0xFFFFFFFF < 0x02100000]
    c1_jobs = sum(1 for i in c1_ins if re.search(r"\bcall\b", i))
    if not c1_ins:
        errors.append(".c1_text is empty: the second core's waiting loop is missing (hal/fm1_cpu1.h)")
    elif unknown(c1):
        errors.append(f".c1_text holds instructions nobody can read: {unknown(c1)[:3]}")
    elif c1_fixed or c1_xip:
        errors.append(f".c1_text reaches the flash: {(c1_fixed + c1_xip)[:3]}")
    else:
        notes.append(f".c1_text: {len(c1_ins)} insns, {c1_jobs} call through a register (the job), no flash address")
    return errors, notes


def check(img, syms, dis, rts):
    errors, notes = ram_code_check(*rts)
    m = re.search(r"^([0-9a-f]+) .*\s_start$", syms, re.M)
    if not m or int(m.group(1), 16) != APP_XIP:
        errors.append(f"_start is not at {APP_XIP:#x}")
    if img[:4] != bytes.fromhex("04818000"):
        errors.append(f"image starts with {img[:4].hex()}, not the entry stub")
    if unknown(dis):
        errors.append(f"{len(unknown(dis))} instructions nobody can read (not the FPU's, unknown to objdump): "
                      f"{unknown(dis)[:3]}")
    fn = "?"
    for ln in dis.splitlines():     # nothing may call an address in the chip ROM
        mm = LINE.match(ln)
        if not mm and ln.rstrip().endswith(":") and not re.search(r"[<\s]\.", " " + ln):
            fn = ln.strip()[:60]
        if not mm:
            continue
        # (immediate loads are not checked: objdump annotates every constant, and Q16 values such as -64 << 16 fall in
        # the ROM window, so a load check only ever reported harmless arithmetic)
        for v in re.findall(r"call -?\d+ <[^:>]*: ([0-9a-f]+) >", mm.group(3)):
            val = int(v, 16) & 0xFFFFFFFF
            if 0xFFC00000 <= val < 0xFFD00000:
                errors.append(f"call to ROM address {val:#010x} in {fn}: {mm.group(3).strip()[:100]}")
    if len(img) > APP_SLOT:
        errors.append(f"image {len(img)} B exceeds the app slot")

    def sym(name):
        mm = re.search(r"^([0-9a-f]+) .*\s" + name + r"$", syms, re.M)
        return int(mm.group(1), 16) if mm else 0
    region = ld_regions()
    ram_org, ram_len = region["RAM"]
    pool_len = region["POOL"][1]
    bss = sym("_bss_end") - ram_org
    pool = sym("_pool_end") - sym("_pool_start")
    notes.append(f"image {len(img)} B; RAM .data+.bss {bss} B of {ram_len}; pool {pool} B of {pool_len}")
    lowram, lr_free = sym("_lr_end") - sym("_lr_start"), sym("_lr_limit") - sym("_lr_end")
    ustack, sstack = sym("_ustack_top") - sym("_ustack_lo"), sym("_sstack_top") - sym("_sstack_lo")
    c1u, c1s = sym("_c1_ustack_top") - sym("_c1_ustack"), sym("_c1_sstack_top") - sym("_c1_ustack_top")
    notes.append(f".lowram {lowram} B ({lr_free} B free after it, .ram_text and .c1_text); stacks: main {ustack} B, "
                 f"supervisor {sstack} B, core 1 {c1u} + {c1s} B")
    ft, ni_org, ni_len = sym("_ft_end") - sym("_ft_start"), *region["NOINIT"]
    notes.append(f".fast_text {ft} B at {sym('_ft_start'):#x} (NOINIT {ni_org + ni_len - sym('_ft_end')} B free after it)")
    if ft and not ni_org <= sym("_ft_start") <= sym("_ft_end") <= ni_org + ni_len:
        errors.append(".fast_text is not inside NOINIT")
    placed = {mm.group(2): mm.group(1) for mm in re.finditer(r"^[0-9a-f]+ .*\sF\s+(\S+)\s+[0-9a-f]+\s+(\S+)$", syms, re.M)}
    off = [f"{f} ({placed.get(f, 'not in the build')})" for f in FAST_TEXT if placed.get(f) != ".fast_text"]
    if off:                                       # renamed, so out of line: else it was inlined, or is gone
        errors.append(f"FAST_TEXT functions not in .fast_text: {', '.join(off)}")
    if not sym("_pool_end") <= sym("_c1_ustack") < sym("_c1_sstack_top") <= sym("_guard0"):
        errors.append("app.ld: core 1's stacks are not between the pool and the main stack's guard band")
    if region["RAM"][0] + ram_len != region["POOL"][0]:
        errors.append("app.ld: POOL does not start where RAM ends")
    if ram_len - bss < 4096:                      # keep >= 4 KiB of .bss spare (state the audio side touches)
        errors.append(f"RAM headroom {ram_len - bss} B < 4096 B")
    if pool_len - pool < 8192:                    # keep >= 8 KiB of the pool spare
        errors.append(f"pool headroom {pool_len - pool} B < 8192 B")
    return errors, notes


# Every hardware register access lives in hal/. In src/ and loader/ (comments stripped):
#  - no volatile pointer cast, except of a C object's address (`*(volatile T *)&x`: a read-once
#    of a RAM flag shared with an ISR, e.g. usb.c ota_wire_send);
#  - no literal in a register or reserved window (core SFRs 0x10000-0x13FFF, SFC 0x40000-0x43FFF,
#    GPIO/IOMAP 0x50000-0x51FFF, CPU 0x1EE0000-0x1EEFFFF, RAM top 0x01C7F000- (boot info,
#    mailbox, vectors), XIP 0x02000000-0x020FFFFF);
#  - no inline asm, except the empty compiler barrier RING_PUBLISH() (emits no instruction);
#  - no HAL register macro (a hal/ #define that is, or expands to, a volatile access).
# Linker symbols (_bss_start[], _rt_load[], ...) are plain C objects and pass.
MMIO_LIT = re.compile(r"\b0x0*(1[0-3][0-9a-f]{3}|4[0-3][0-9a-f]{3}|5[01][0-9a-f]{3}|1ee[0-9a-f]{4}|"
                      r"1c7f[0-9a-f]{3}|20[0-9a-f]{5})u?l?\b", re.I)
MMIO_CAST = re.compile(r"\(\s*(?:const\s+)?volatile\b[^()]*\*\s*\)(?!\s*&)")
MMIO_ASM = re.compile(r"\b(?:__asm__|asm)\b(?!\s+volatile\s*\(\s*\"\"\s*:::\s*\"memory\"\s*\))")


def mmio_check():
    def strip(s):
        s = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), s, flags=re.S)
        return re.sub(r"//[^\n]*", "", s)
    defs = {}
    for h in sorted((FW / "hal").glob("*.h")):
        for m in re.finditer(r"^#define\s+(\w+)(?:\([^)]*\))?\s+(.*)$", strip(h.read_text()), re.M):
            defs[m.group(1)] = m.group(2)
    regs = {n for n, b in defs.items() if re.search(r"\bvolatile\b", b)}
    while True:                                   # macros built on register macros (FM1_WR_LIMIT_H -> FM1_X2)
        more = {n for n, b in defs.items() if n not in regs and set(re.findall(r"\w+", b)) & regs}
        if not more:
            break
        regs |= more
    errors = []
    for f in sorted([*(FW / "src").glob("*.[ch]"), *(FW / "loader").glob("*.c")]):
        text = f.read_text()
        # generated tables (presets.h, defs.h, ...) hold data words, not addresses: no literal check there
        generated = re.search(r"generated|do not edit", "\n".join(text.splitlines()[:3]), re.I)
        for no, ln in enumerate(strip(text).splitlines(), 1):
            where = f"{f.relative_to(FW)}:{no}"
            for rx, what in ((MMIO_LIT, "register/window address"), (MMIO_CAST, "volatile pointer cast"),
                             (MMIO_ASM, "inline asm")):
                m = None if generated and rx is MMIO_LIT else rx.search(ln)
                if m:
                    errors.append(f"{where}: {what} outside hal/ ({m.group(0).strip()}); add a hal/ helper")
            used = set(re.findall(r"\b[A-Z_][A-Z0-9_]*\b", ln)) & regs
            if used:
                errors.append(f"{where}: HAL register macro {sorted(used)[0]} outside hal/; use a hal/ helper")
    return errors


def main():
    global PRODUCT, VERSION, FW_VERSION, OUT, GEN, LDR
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", metavar="X.Y.Z", help="release build: identity FM-1_7MMmmpp, version string vX.Y.Z")
    ap.add_argument("--sdk", type=Path, help="JieLi AC79 SDK checkout (default: $AC79_SDK)")
    ap.add_argument("--out-dir", type=Path, help="new, empty output directory within build/ (default: build/)")
    a = ap.parse_args()
    OUT = (SRC / (a.out_dir or Path("build"))).resolve()
    if not OUT.is_relative_to((SRC / "build").resolve()):
        ap.error("--out-dir must be within the repository's build/ directory")
    if a.out_dir and (any(p.name.startswith("release-") for p in OUT.relative_to(SRC / "build").parents)
                      or OUT.name.startswith("release-")):
        ap.error("--out-dir cannot be a release artifact directory or inside one")
    if a.out_dir and OUT.exists() and any(OUT.iterdir()):
        ap.error("--out-dir must be empty; choose a new build directory")
    if a.release and (OUT / f"release-{a.release}").exists():
        ap.error("release artifacts already exist; choose a new --out-dir instead of replacing them")
    GEN, LDR = OUT / "gen", OUT / "loader"
    name = "matryoshka.fwsc"
    check_identity(PRODUCT)
    if a.release:                   # two digits each for major, minor and patch (#216); VERSION: MENU > SYSTEM, the splash
        if os.environ.get("M1_BENCH") == "1":
            ap.error("M1_BENCH=1 is a measurement build (#950), never a release")
        PRODUCT, VERSION, FW_VERSION = release_identity(a.release)
        name = f"matryoshka-{a.release}.fwsc"
    fm1pkg_make.SDK = a.sdk
    for rel, sha in SDK_SHA256.items():          # fail early without the SDK
        if hashlib.sha256(fm1pkg_make.sdk_file(rel)).hexdigest() != sha:
            print(f"warning: SDK {rel} differs from AC79NN_SDK_V1.2.1; the package will not match the reference")
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(2) as ex:
        ota = ex.submit(build_loader).result()
    img, syms, dis, rt = build_app()
    errors, notes = check(img, syms, dis, rt)
    hal_err = mmio_check()
    errors += hal_err
    if not hal_err:
        notes.append("register access: hal/ only (src/, loader/ clean)")
    for n in notes:
        print("  ok   ", n)
    for e in errors:
        print("  FAIL ", e)
    if errors:
        raise SystemExit("build: checks failed")
    pkg = fm1pkg_make.ufw(fm1pkg_make.flash_image(img, fm1pkg_make.KEY), ota, PRODUCT)
    (OUT / name).write_bytes(pkg)
    # the package's image is encrypted: its version goes in a sidecar for web/scripts/sync-firmware.mjs (x.fwsc -> x.json)
    version = VERSION or re.search(r'#define FELUCCA_VERSION "([^"]+)"', (FW / "src" / "modular.c").read_text())[1]
    side = json.dumps({"version": version, "product": PRODUCT, "size": len(pkg), "sha256": hashlib.sha256(pkg).hexdigest(),
                       "app_sha256": hashlib.sha256(img).hexdigest(),
                       "build": {"ENG_AOT": int(os.environ.get("ENG_AOT", "0")),
                                 "ENG_RAMCODE": int(RAMCODE),
                                 "ENG_BUF_REUSE": int(os.environ.get("ENG_BUF_REUSE", "1")),
                                 "FELUCCA_SPEED": os.environ.get("FELUCCA_SPEED", SPEED),
                                 # Missing overrides use defaults in the recorded source commit.
                                 "defines": {k: os.environ[k] for k in APP_SWITCHES
                                             if os.environ.get(k) in ("0", "1")},
                                 "FELUCCA_USB_LAYOUT": os.environ.get("FELUCCA_USB_LAYOUT")
                                     if os.environ.get("FELUCCA_USB_LAYOUT") in ("0", "1", "2", "3") else None}})
    (OUT / name).with_suffix(".json").write_text(side)
    att = SRC / "assets" / "samples-cc0" / "ATTRIBUTION.txt"
    if att.exists():
        shutil.copy(att, OUT / "ATTRIBUTION.txt")
    print(f"app      {OUT / 'matryoshka.bin'}  {len(img)} B")
    print(f"loader   {LDR / 'ota.bin'}  {len(ota)} B")
    print(f"package  {OUT / name}  {len(pkg)} B, identity {PRODUCT}")
    if a.release:                   # what a release carries: the package, the app and every licence they need
        rel = OUT / f"release-{a.release}"
        (rel / "LICENSES").mkdir(parents=True)
        app = f"matryoshka-{a.release}-app.bin"
        (rel / name).write_bytes(pkg)
        (rel / app).write_bytes(img)
        (rel / name).with_suffix(".json").write_text(side)
        (rel / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(b).hexdigest()}  {n}\n"
                                                for n, b in ((name, pkg), (app, bytes(img)))))
        # only the texts for what the package embeds (LICENSING.md): the JieLi SDK files, LCD font bitmaps and rate-envelope implementation
        for f in (SRC / "LICENSES" / "Apache-2.0.txt", SRC / "web" / "public" / "fonts" / "OFL-BarlowCondensed.txt", SRC / "LICENSES" / "BSD-3-Clause-ymfm.txt"):
            shutil.copy(f, rel / "LICENSES" / f.name)
        for doc in ("LICENSE", "LICENSING.md"):
            shutil.copy(SRC / doc, rel / doc)
        if att.exists():
            shutil.copy(att, rel / "ATTRIBUTION.txt")
        print(f"release  {rel}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
