#!/usr/bin/env bash
# fm1-emu's decoder table has the forward `if ((R & #h) == #i) goto #i` with a 13-bit offset (bits 32..44: its table was
# learned from samples with short jumps) while the `!=` form has the full 15 bits (32..46); a JieLi build that jumps 8 KB
# or more forward with it halts the emulator with UnknownInstruction. Second fix: the dual-issue head
# `R = R & ~(#i << R) #` (2 corpus samples) has an overfitted mask and wrong slots, so `r4 = r9 & ~(1 << r2) #` (dm_keys,
# 2026-10-20) is unknown; it gets the layout of its three siblings (`&`, `& #`, `&~`: mask 0xfffff, R = bits 28..31,
# R = 20..23, shift R = 24..27). Third fix (2026-10-29): the `|` and `^` heads of the same family, `R = R | (#i << R) #`
# (14 samples) and `R = R ^ (#i << R) #` (6), have a three-bit shift-register slot (24..26: their samples shifted by
# r0..r7 only) and masks that pin bit 27, so `r0 = r1 | (1 << r15) #` (pages_turn, the row a knob turns) decoded as
# another instruction and a knob click on the device page reached a module that did not exist; they get the `&` pair's
# layout as well. Fourth fix (2026-11-16): the read-modify-write shifts by a register, `[R+#i] op= R` (`6e e8`:
# base = bits 28..31, count register = 24..27, offset = 4 * sext(bits 18..23), op = bits 16..17 {0 <<, 1 <<<, 2 >>,
# 3 >>>}; pi32v2-isa rmw.lsl.r etc.), had `>>=` and `>>>=` only, each fitted to its one sample with constant operands,
# so `[r0+0] <<= r2` (ring_scale, PR #978) halted the emulator with UnknownInstruction; the two get that layout and
# `<<=` / `<<<=` are added. This copies fm1-isa from cargo's checkout of the
# pinned fm1-emu into tools/emu/target/fm1-isa and widens those entries like their siblings. It also copies fm1-core to
# tools/emu/target/fm1-core with the retire hook the timing model needs (tools/emu/core_timing_patch.py, #947; buses
# without a timing model ignore it) and the semantics of the fourth fix's shifts (tools/emu/core_isa_patch.py). It
# prints the cargo --config that patches both in.
# Run from the repo root; cargo build --release --manifest-path tools/emu/Cargo.toml --config "$(...)".
set -euo pipefail
M=tools/emu/Cargo.toml
REV=$(sed -n 's/.*fm1-core.*rev = "\([0-9a-f]*\)".*/\1/p' "$M")
cargo fetch --quiet --manifest-path "$M" >&2
SRC=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/git/checkouts/fm1-emu-*/"${REV:0:7}"/crates/fm1-isa | head -1)
DST=tools/emu/target/fm1-isa
if [ ! -f "$DST/.fixed4-$REV" ]; then
  rm -rf "$DST"; mkdir -p tools/emu/target; cp -R "$SRC" "$DST"
  # the crate inherits edition / license from fm1-emu's workspace
  sed -i.bak -e 's/^edition.workspace = true/edition = "2021"/' -e 's/^license.workspace = true/license = "MIT"/' "$DST/Cargo.toml"
  python3 - "$DST/src/generated_isa.rs" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
i = s.index('name: "if_r_h_eq_i_goto_i",'); j = s.index('IsaEntry {', i)
e = s[i:j]
f = e.replace('mask: 0x0000e0000000ffff_u64', 'mask: 0x000080000000ffff_u64').replace('pieces: &[(32, 44)], mult: 2', 'pieces: &[(32, 46)], mult: 2')
assert f != e and f.count('0x000080000000ffff') == 1 and '(32, 46)' in f, 'fm1-isa entry not as expected'
s = s[:i] + f + s[j:]
i = s.index('name: "r_mov_r_i_lsl_r_8",'); j = s.index('IsaEntry {', i)
k = s.index('name: "r_mov_r_i_lsl_r_l4",'); l = s.index('IsaEntry {', k)
e = s[i:j]; sib = s[k:l]
assert 'syntax: "R = R & ~(#i << R) #"' in e and 'mask: 0x00000000cf9fffff_u64' in e, 'fm1-isa pair entry not as expected'
slots = lambda x: x[x.index('slots: &['):x.rindex(']')+1]
f = e.replace('mask: 0x00000000cf9fffff_u64', 'mask: 0x00000000000fffff_u64').replace(slots(e), slots(sib))
assert '(24, 27)' in f
s = s[:i] + f + s[j:]
# the third fix: the `|` and `^` pairs take the `&` pair's mask and slots
k = s.index('name: "r_mov_r_i_lsl_r_5",'); l = s.index('IsaEntry {', k)
sib = s[k:l]
assert 'syntax: "R = R & (#i << R) #"' in sib and 'mask: 0x00000000000fffff_u64' in sib, 'fm1-isa & pair entry not as expected'
for name, syntax, mask in (('r_mov_r_i_lsl_r_6', 'R = R | (#i << R) #', 'mask: 0x00000000080fffff_u64'),
                           ('r_mov_r_i_lsl_r_7', 'R = R ^ (#i << R) #', 'mask: 0x00000000c40fffff_u64')):
    i = s.index(f'name: "{name}",'); j = s.index('IsaEntry {', i)
    e = s[i:j]
    assert f'syntax: "{syntax}"' in e and mask in e, f'fm1-isa {syntax} entry not as expected'
    f = e.replace(mask, 'mask: 0x00000000000fffff_u64').replace(slots(e), slots(sib))
    assert '(24, 27)' in f and '(28, 31)' in f
    s = s[:i] + f + s[j:]
# the fourth fix: the `6e e8` shifts by a register; fm1-core runs them (tools/emu/core_isa_patch.py)
i = s.index('name: "r_i_gtge_r",'); j = s.index('IsaEntry {', i)
e = s[i:j]
assert 'syntax: "[R+#i] >>= R"' in e and 'mask: 0x00000000ffffffff_u64' in e and 'match_: 0x00000000ee66e86e_u64' in e, 'fm1-isa [R+#i] >>= R entry not as expected'
lay = ('slots: &[\n'
       '            SlotSpec { kind: SlotKind::Imm, pieces: &[(28, 31)], mult: 0, adj: 0, hi: 0, lo: 0 },\n'
       '            SlotSpec { kind: SlotKind::Rel, pieces: &[(18, 23)], mult: 4, adj: 0, hi: 0, lo: 0 },\n'
       '            SlotSpec { kind: SlotKind::Imm, pieces: &[(24, 27)], mult: 0, adj: 0, hi: 0, lo: 0 },\n'
       '        ]')
def shift_r(e, op, match):
    f = e.replace('mask: 0x00000000ffffffff_u64', 'mask: 0x000000000003ffff_u64').replace(match, f'match_: 0x{op << 16 | 0xe86e:016x}_u64').replace(slots(e), lay)
    assert f.count('0x000000000003ffff') == 1 and f.count('(18, 23)') == 1
    return f
new = shift_r(e, 2, 'match_: 0x00000000ee66e86e_u64')
for name, syntax, op in (('r_i_ltle_r', '[R+#i] <<= R', 0), ('r_i_lslle_r', '[R+#i] <<<= R', 1)):
    assert f'name: "{name}",' not in s
    f = shift_r(e, op, 'match_: 0x00000000ee66e86e_u64').replace('name: "r_i_gtge_r",', f'name: "{name}",').replace('syntax: "[R+#i] >>= R",', f'syntax: "{syntax}",')
    f = f.replace(f[f.index('samples: &['):f.index('slots: &[')], 'samples: &[\n        ],\n        ').replace('count: 2,', 'count: 0,')
    assert f'syntax: "{syntax}"' in f and 'samples: &[\n        ],' in f and 'count: 0,' in f
    new += 'IsaEntry {\n        ' + f
s = s[:i] + new + s[j:]
i = s.index('name: "r_i_lsrge_r",'); j = s.index('IsaEntry {', i)
e = s[i:j]
assert 'syntax: "[R+#i] >>>= R"' in e and 'mask: 0x00000000ffffffff_u64' in e and 'match_: 0x000000000213e86e_u64' in e, 'fm1-isa [R+#i] >>>= R entry not as expected'
s = s[:i] + shift_r(e, 3, 'match_: 0x000000000213e86e_u64') + s[j:]
open(p, 'w').write(s)
PY
  touch "$DST/.fixed4-$REV"
fi
CORE=tools/emu/target/fm1-core
MARK="$CORE/.timing-$(cat tools/emu/core_timing_patch.py tools/emu/core_isa_patch.py | shasum | cut -c1-12)-$REV"   # (a changed patch script redoes the copy)
if [ ! -f "$MARK" ]; then
  rm -rf "$CORE"; cp -R "${SRC%/fm1-isa}/fm1-core" "$CORE"
  sed -i.bak -e 's/^edition.workspace = true/edition = "2021"/' -e 's/^license.workspace = true/license = "MIT"/' "$CORE/Cargo.toml"
  python3 tools/emu/core_timing_patch.py "$CORE/src"
  python3 tools/emu/core_isa_patch.py "$CORE/src"
  touch "$MARK"
fi
# (one --config value cannot patch two crates: cargo refuses inline tables there, so it is a config file)
CFG="$PWD/tools/emu/target/fm1-patch.toml"
printf "[patch.'https://github.com/joakimeriksson/fm1-emu']\nfm1-isa = { path = '%s' }\nfm1-core = { path = '%s' }\n" "$PWD/$DST" "$PWD/$CORE" > "$CFG"
echo "$CFG"
