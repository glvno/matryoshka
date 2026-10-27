# Licensing

Matryoshka is GPL-3.0-only (`LICENSE`). It is derived from [Modular-1](https://github.com/WiggisModular/Modular-1) by [@morgulbrut](https://github.com/morgulbrut) / [WiggisModular](https://github.com/WiggisModular), also GPL-3.0-only. Original copyright and licence notices are retained.

## Copied from Felucca

Source: <https://github.com/hugelton/Felucca> at commit `a4d7ca2e5d52a4c35e2468401f00d883cadbda03`.
Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments. GPL-3.0-only.

Copied files, to be changed only as part of Matryoshka's own work:

- `firmware/hal/`, `firmware/loader/`, `firmware/crt0.S`, `firmware/app.ld`
- `tools/build.py`, `tools/fm1_install.py`, `tools/fm1pkg_make.py`, `tools/lz4blk.py`, `tools/get_toolchain.sh`
- `web/src/flasher/fm1ota.js`, `web/src/flasher/fm1pkg.js`

Every one of these keeps its original `SPDX-License-Identifier` and copyright header.

## JieLi SDK files (Apache-2.0)

Packages made by `tools/build.py` embed three files from the JieLi AC79 SDK (`uboot.boot`, `cfg_tool.bin`, `cfg/eq_cfg_hw.bin`), Apache-2.0. They are not in this repository as files, but the prebuilt package that the web app bundles (`web/public/firmware/matryoshka.fwsc`, made by `tools/build.py` and `npm run firmware`, published on Cloudflare Pages) contains them, so the licence texts (`LICENSE-GPL-3.0.txt`, `LICENSE-Apache-2.0.txt`) are published next to it and linked from the Flash tab. Ship `LICENSES/Apache-2.0.txt` with every package. Other than the ymfm notice described below, the remaining texts in `LICENSES/` belong to Felucca's own bundled material (fonts, DSP ports) and apply only to files not copied here; they are kept so any later copy stays correctly attributed, and releases do not ship them.

**What a release ships** (`tools/build.py --release`, the folder `release-X.Y/`): the package, its sidecar and the app image, `SHA256SUMS`, `LICENSE` (GPL-3.0), this file, and in `LICENSES/` exactly the texts for what the package embeds: `Apache-2.0.txt` (the JieLi SDK files), `OFL-BarlowCondensed.txt` (the LCD font's bitmaps, below), and `BSD-3-Clause-ymfm.txt` (the rate-envelope clock, below).

## M-VAVE stock firmware V15 (Apache-2.0)

`web/public/firmware/FM-1_015.fwsc` is M-VAVE's official FM-1 firmware V15, unmodified, from [m-vave/fm1_open](https://github.com/m-vave/fm1_open) (`sdk/firmware/FM-1_015.fwsc` at commit `b178ac43c25f010c60a878056fb5331fe693fd62`, SHA-256 `db1642b2…edb8a`), which M-VAVE distributes under the Apache License 2.0. The Flash tab's Return to stock sends it. Next to it: `LICENSE-Apache-2.0.txt`, `NOTICE-FM-1_015.txt` (copyright, source, checksum) and M-VAVE's notice file reproduced unchanged as `FM-1_015-THIRD_PARTY.md`. Matryoshka is not affiliated with M-VAVE.

The self-hosted Alegreya SC Bold heading font is by Juan Pablo del Peral / Huerta Tipográfica, distributed under the SIL Open Font License 1.1. Its licence is included at `web/public/fonts/OFL-AlegreyaSC.txt`; source: https://github.com/google/fonts/tree/main/ofl/alegreyasc.

The patch editor and earlier wordmark use Barlow Semi Condensed Bold, Barlow Condensed SemiBold and Barlow Medium by Jeremy Tribby, distributed under the SIL Open Font License 1.1. Their licences are included at `web/public/fonts/OFL-BarlowSemiCondensed.txt`, `web/public/fonts/OFL-BarlowCondensed.txt` and `web/public/fonts/OFL-Barlow.txt`; sources: https://github.com/google/fonts/tree/main/ofl/barlowsemicondensed, https://github.com/google/fonts/tree/main/ofl/barlowcondensed and https://github.com/google/fonts/tree/main/ofl/barlow. `web/scripts/wordmark.py` regenerates the legacy K-stem wordmark as a study without replacing the current branding.

The firmware's LCD type (`firmware/src/font_bc.h`) is Barlow Condensed SemiBold rasterised to bitmaps by `tools/gen_font.py` from `web/public/fonts/BarlowCondensed-SemiBold.ttf`; the bitmaps are a derivative of the font and stay under the SIL Open Font License 1.1 (`web/public/fonts/OFL-BarlowCondensed.txt`), named as such in the header. Every release ships that licence in `LICENSES/`.

The active SVG wordmark uses Roboto Flex under SIL OFL 1.1, with the selected axes and preset recorded in `web/public/brand/wordmark-settings.json`. `npm run brand:flex` generates its outlines from preset `p13` and promotes `round-three/29-hidden-arm-ends.png` to the app’s `brand/matryoshka.png`. The app displays the outlined SVG without loading a font renderer or the variable font at runtime.

The ten logo concept PNGs in `web/public/brand/candidates/` were generated with the built-in image generation tool using the current project logo as reference. Their prompts are recorded in `docs/logo-candidate-prompts.json`. They are review candidates; the app continues to use `web/public/brand/matryoshka.png`.

The twelve further pictorial concepts in `web/public/brand/round-two/` were generated with the built-in image tool; their exact prompts are in `docs/logo-round-two-prompts.json`. The comparison uses Nick Dawson's [design-partner skill](https://github.com/nickpdawson/claude-studio-design-partner-skill/blob/main/SKILL.md). The twelve SVG wordmark studies use Barlow, Barlow Condensed, Barlow Semi Condensed, Space Grotesk, Rajdhani, Archivo Black, and one custom line drawing. The additional font sources and OFL licence texts are included in `web/public/brand/round-two/fonts/`.

The third-round wordmarks use Roboto Flex from https://github.com/google/fonts/tree/main/ofl/robotoflex under the SIL Open Font License 1.1. The unmodified variable font and licence are included in `web/public/brand/round-three/fonts/`. `web/scripts/wordmark-flex.py` generates the SVG outlines and replaces the R stem in MATRYOSHKA with a custom footless numeral 1, so the accented letters read FM1. The two-sibling pictorial study was edited with the built-in image generator; its initial prompts are recorded in `web/public/brand/round-three/prompts.json` and its brand-color correction in `web/public/brand/round-three/brand-color-edit.json`.

The fourth-round type lab uses the same Roboto Flex font and existing brand artwork. `npm run brand:flex` in `web/` builds its SVG starting points and browser renderer. The browser bundle includes Fontkit (MIT, Devon Govett) and dependencies; their notices are included in `web/public/brand/round-four/third-party-notices.txt` and the generated bundle’s linked licence comments.

The lab’s revised doll artwork, `web/public/brand/round-three/25-routed-smile.png`, was edited with the built-in image generator. Its exact cable-routing and smile prompt is recorded in `web/public/brand/round-three/routing-smile-edit.json`.

The subsequent revision, `web/public/brand/round-three/26-port-aligned-faces.png`, gives the smallest dolls white faces with black eyes and aligns the outer shell’s internal cable origins with its external ports. It was edited with the built-in image generator; the exact prompt is in `web/public/brand/round-three/port-aligned-faces-edit.json`.

The all-coral cable variant, `web/public/brand/round-three/27-coral-cables.png`, was edited with the built-in image generator. Its prompt is in `web/public/brand/round-three/coral-cables-edit.json`.

The doll-colored cable-arm variant, `web/public/brand/round-three/28-doll-colored-arms.png`, was edited with the built-in image generator. Its prompt is in `web/public/brand/round-three/doll-colored-arms-edit.json`.

The hidden cable-end revision, `web/public/brand/round-three/29-hidden-arm-ends.png`, was edited with the built-in image generator. Its prompt is in `web/public/brand/round-three/hidden-arm-ends-edit.json`.

The active Matryoshka wordmark uses preset p13: the approved narrow Roboto Flex capitals, both T arms shortened to 55%, custom A–T / T–R spacing, and a small foot on the teal R/1. The earlier FM1 wordmarks remain historical studies. The active logo is `web/public/brand/matryoshka.png`. The browser tab icon, `web/public/brand/icon-96.png`, is that logo scaled to 96 px (`sips -Z 96`), so a visit does not download the full 1254 px picture.

## M-VAVE Official Open (not shipped)

Matryoshka does not ship M-VAVE Official Open, and will not when it can put Official Open back on an FM-1 (issue #183): the user downloads it from [M-VAVE's release page](https://github.com/m-vave/fm1_open/releases) (the Workbench page or its `.fwsc`). Official Open is a mix: M-VAVE's app sources are GPL-3.0 with an extra linking permission ([LICENSE.md](https://github.com/m-vave/fm1_open/blob/main/LICENSE.md)); its boot and update files are Apache-2.0; and its sound engine (`sdk/lib/libfm1_engine.a`) is M-VAVE's own and not open source ([THIRD_PARTY.md](https://github.com/m-vave/fm1_open/blob/main/THIRD_PARTY.md), "Binary SDK"). That licence lets anyone pass the engine on as part of firmware for FM-1 devices, with its notices, so shipping it would be allowed; Matryoshka ships only open-source files, so it leaves that to M-VAVE.

## Community patches (CC BY-SA 4.0)

The entries of `web/src/community.json` are patches made by other people, submitted through the issue form `.github/ISSUE_TEMPLATE/community-patch.yml`. Each is licensed by its author under the [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/) licence; the author is named in its entry and shown with it in the app. They are data, distinct from the GPL-3.0-only code, which does not cover them. A submitter confirms on the form that they may license the patch so.

## Ideas taken from other FM-1 projects (no code copied)

- The FM-1 tab's panel geometry (`web/src/fm1-view.ts`) follows the panel that
  [fm1-emu](https://github.com/joakimeriksson/fm1-emu) (MIT) draws in fm1-live, itself after Felucca's controls diagram.
- The FM-1 tab's lights (the wasm exports the panel's LEDs as lit / dim / mid / breathing bits, the page colours buttons
  and keys from them) follow the browser emulator of [X0X](https://github.com/charlesvestal/fm1-x0x) by Charles Vestal
  (GPL-3.0-only), including its light colours.

## Rate-envelope clock (BSD-3-Clause)

The standalone rate envelope in `web/src/rate-envelope.ts` and `firmware/src/rate_envelope.h` adapts the envelope clock and increment patterns from Aaron Giles’s [ymfm](https://github.com/aaronsgiles/ymfm/blob/81aec25ccbb98f4873a255f7551ac4dadac59b4a/src/ymfm_fm.ipp), Copyright (c) 2021, Aaron Giles, BSD-3-Clause. The complete notice is in `LICENSES/BSD-3-Clause-ymfm.txt` and is published with the editor as `web/public/LICENSE-ymfm.txt`. Firmware release packages carry it in `LICENSES/`. The FM chip emulator is not included.
