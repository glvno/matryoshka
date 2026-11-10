#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Focused release packaging checks; compiler and SDK are mocked, no hardware."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import build
import release_manifest


class ReleaseBuild(unittest.TestCase):
    def setUp(self):
        (build.SRC / "build").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=build.SRC / "build")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.multiple(build, PRODUCT=build.PRODUCT, VERSION=None,
                                              FW_VERSION=(0, 0, 0), OUT=build.OUT, GEN=build.GEN, LDR=build.LDR,
                                              SDK_SHA256={}))
        self.stack.enter_context(patch.dict(os.environ, {}, clear=True))
        self.stack.enter_context(patch.object(build, "build_loader", return_value=b"loader"))
        self.stack.enter_context(patch.object(build, "build_app", side_effect=self.compile_app))
        self.stack.enter_context(patch.object(build, "check", return_value=([], [])))
        self.stack.enter_context(patch.object(build, "mmio_check", return_value=[]))
        self.stack.enter_context(patch.object(build.fm1pkg_make, "flash_image", side_effect=lambda img, key: b"flash:" + img))
        self.stack.enter_context(patch.object(build.fm1pkg_make, "ufw", side_effect=lambda img, ota, product: product.encode() + img + ota))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    @staticmethod
    def compile_app():
        # Distinct binaries, carrying the actual version parameters chosen by main().
        img = f"{build.VERSION}/{build.FW_VERSION}/{os.environ['M1_EMU_MIDI']}".encode()
        (build.OUT / "matryoshka.bin").write_bytes(img)
        (build.OUT / "matryoshka.elf").write_bytes(b"elf:" + img)
        return img, None, None, None

    def run_build(self, path, bridge="0"):
        with patch.dict(os.environ, {"M1_EMU_MIDI": bridge}), patch("sys.argv", [
            "build.py", "--release", "1.13.0", "--out-dir", str(path)]):
            self.assertEqual(build.main(), 0)

    def pair(self):
        normal = self.root / "normal"
        bridge = self.root / "bridge"
        self.run_build(normal)
        rel = normal / "release-1.13.0"
        before = {p.relative_to(rel): p.read_bytes() for p in rel.rglob("*") if p.is_file()}
        self.run_build(bridge, "1")
        self.assertEqual(before, {p.relative_to(rel): p.read_bytes() for p in rel.rglob("*") if p.is_file()})
        self.assertEqual(build.GEN, bridge / "gen")
        self.assertEqual(build.LDR, bridge / "loader")
        shutil.copy(normal / "matryoshka.elf", rel / "matryoshka-1.13.0-app.elf")
        for src, dst in (("matryoshka.bin", "matryoshka-emu.bin"), ("matryoshka.elf", "matryoshka-emu.elf"),
                         ("matryoshka-1.13.0.json", "matryoshka-emu.json")):
            shutil.copy(bridge / src, bridge / dst)
        return rel, bridge

    def test_versioned_variants_preserve_normal_and_bind_hashes(self):
        normal, bridge = self.pair()
        record = release_manifest.artifacts("1.13.0", normal, bridge)
        self.assertEqual((record["version"], record["product"]), ("v1.13.0", "FM-1_7011300"))
        self.assertNotEqual(record["files"]["normal"]["sha256"], record["files"]["bridge"]["sha256"])
        app = (normal / "matryoshka-1.13.0-app.bin").read_bytes()
        self.assertIn(b"flash:" + app, (normal / "matryoshka-1.13.0.fwsc").read_bytes())
        self.assertEqual(record["files"]["normal"]["sha256"], hashlib.sha256(app).hexdigest())

    def test_reject_existing_outputs_without_changing_them(self):
        target = self.root / "normal"
        self.run_build(target)
        package = target / "release-1.13.0" / "matryoshka-1.13.0.fwsc"
        before = package.read_bytes()
        with self.assertRaises(SystemExit):
            self.run_build(target, "1")
        self.assertEqual(package.read_bytes(), before)

    def test_reject_source_directory_and_release_subdirectory(self):
        for target in (build.SRC / "firmware", self.root / "release-1.13.0" / "bridge"):
            with self.subTest(target=target), self.assertRaises(SystemExit):
                self.run_build(target)

    def test_default_release_directory_cannot_be_replaced(self):
        existing = self.root / "build" / "release-1.13.0"
        existing.mkdir(parents=True)
        marker = existing / "qualified.txt"
        marker.write_text("retain these artifacts")
        with patch.object(build, "SRC", self.root), patch("sys.argv", ["build.py", "--release", "1.13.0"]):
            with self.assertRaises(SystemExit):
                build.main()
        self.assertEqual(marker.read_text(), "retain these artifacts")

    def test_manifest_rejects_wrong_version_switch_options_and_binary(self):
        normal, bridge = self.pair()
        side_path = bridge / "matryoshka-emu.json"
        original = json.loads(side_path.read_text())
        for field in ("version", "transport", "options", "binary"):
            side = json.loads(json.dumps(original))
            if field == "version":
                side["version"] = "v1.12.0-DEV"
            elif field == "transport":
                side["build"]["defines"]["M1_EMU_MIDI"] = "0"
            elif field == "options":
                side["build"]["ENG_AOT"] = 1
            else:
                side["app_sha256"] = "0" * 64
            side_path.write_text(json.dumps(side))
            with self.subTest(field=field), self.assertRaises(ValueError):
                release_manifest.artifacts("1.13.0", normal, bridge)
        side_path.write_text(json.dumps(original))
        (normal / "matryoshka-1.13.0.fwsc").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "package disagrees"):
            release_manifest.artifacts("1.13.0", normal, bridge)


if __name__ == "__main__":
    unittest.main()
