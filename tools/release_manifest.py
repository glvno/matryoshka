#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Record a release build's exact inputs and files. This is not test qualification."""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

import build


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifacts(version, normal, bridge):
    product, label, _ = build.release_identity(version)
    names = {
        "package": normal / f"matryoshka-{version}.fwsc",
        "normal": normal / f"matryoshka-{version}-app.bin",
        "normal_elf": normal / f"matryoshka-{version}-app.elf",
        "normal_sidecar": normal / f"matryoshka-{version}.json",
        "bridge": bridge / "matryoshka-emu.bin",
        "bridge_elf": bridge / "matryoshka-emu.elf",
        "bridge_sidecar": bridge / "matryoshka-emu.json",
    }
    configs = []
    for role, expected in (("normal", "0"), ("bridge", "1")):
        side = json.loads(names[f"{role}_sidecar"].read_text())
        if (side["version"], side["product"]) != (label, product):
            raise ValueError(f"{role}: wrong release identity")
        if side["app_sha256"] != sha(names[role]):
            raise ValueError(f"{role}: application disagrees with its sidecar")
        config = side["build"]
        if config["defines"].pop("M1_EMU_MIDI", None) != expected:
            raise ValueError(f"{role}: wrong emulator transport switch")
        configs.append(config)
        if role == "normal" and (side["sha256"] != sha(names["package"])
                                 or side["size"] != names["package"].stat().st_size):
            raise ValueError("release package disagrees with its sidecar")
    if configs[0] != configs[1]:
        raise ValueError("normal and bridge build options differ beyond M1_EMU_MIDI")
    return {
        "version": label, "product": product,
        "shared_build_options": configs[0],
        "variant_defines": {"normal": {"M1_EMU_MIDI": "0"}, "bridge": {"M1_EMU_MIDI": "1"}},
        "files": {role: {"name": p.name, "size": p.stat().st_size, "sha256": sha(p)}
                  for role, p in names.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--normal", type=Path, required=True)
    parser.add_argument("--bridge", type=Path, required=True)
    args = parser.parse_args()
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--"], cwd=build.SRC, check=True)
    record = artifacts(args.version, args.normal, args.bridge)
    git = lambda ref: subprocess.check_output(["git", "rev-parse", ref], cwd=build.SRC, text=True).strip()
    record.update({
        "schema": 1, "purpose": "build provenance only; no qualification asserted",
        "source_commit": git("HEAD"), "source_tree": git("HEAD^{tree}"),
        "workflow_ref": os.environ.get("GITHUB_WORKFLOW_REF"),
        "workflow_sha": os.environ.get("GITHUB_WORKFLOW_SHA"),
        "run_id": os.environ.get("GITHUB_RUN_ID"), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "toolchain_sha256": {name: sha(build.toolchain() / name) for name in
                             ("pi32v2/bin/clang", "pi32v2/bin/ld", "common/bin/objcopy", "pi32v2/lib/libcompiler-rt.a")},
        "sdk_sha256": {name: hashlib.sha256(build.fm1pkg_make.sdk_file(name)).hexdigest()
                       for name in build.SDK_SHA256},
    })
    # Exclusive creation: an existing build record is never silently replaced.
    with (args.normal / "build-manifest.json").open("x") as out:
        out.write(json.dumps(record, indent=2) + "\n")


if __name__ == "__main__":
    main()
