#!/usr/bin/env bash
# Builds fm1-live (fm1-emu's window) with tools/emu/isa_fix.sh's decoder fix into tools/emu/live/bin. A cargo `patch`
# cannot reach it: inside fm1-emu's own workspace fm1-isa is a path dependency, so `cargo install --git ... --config
# patch...` builds the unfixed decoder (cargo says "patch was not used"). This copies the pinned checkout to
# tools/emu/target/fm1-emu-src, puts the fixed fm1-isa in its place and installs fm1-live from that copy.
# Run from the repo root (web/scripts/emu.mjs does).
set -euo pipefail
M=tools/emu/Cargo.toml
REV=$(sed -n 's/.*fm1-core.*rev = "\([0-9a-f]*\)".*/\1/p' "$M")
tools/emu/isa_fix.sh >/dev/null                     # (fetches the checkout, makes tools/emu/target/fm1-isa)
SRC=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/git/checkouts/fm1-emu-*/"${REV:0:7}" | head -1)
DST=tools/emu/target/fm1-emu-src
rm -rf "$DST"; cp -R "$SRC" "$DST"; rm -rf "$DST/.git"
cp tools/emu/target/fm1-isa/src/generated_isa.rs "$DST/crates/fm1-isa/src/generated_isa.rs"
grep -q 'mask: 0x000080000000ffff_u64' "$DST/crates/fm1-isa/src/generated_isa.rs"   # the fixes are in
test -f "tools/emu/target/fm1-isa/.fixed2-$REV"
cargo install --quiet --path "$DST/crates/fm1-live" --force --root tools/emu/live
