// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's screen font (#602, firmware/src/font_area.c): from 1.26 the screen type's larger sizes live in flash sectors
// of their own, outside the firmware, and the installer writes them after the firmware, as it does the factory sounds.
// Until they are there the FM-1 draws every size with its small type and says SCREEN FONT MISSING. A firmware takes only
// the font it was built with: INFO names its id (protocol.ts Info.font), the image's header carries the same id
// (tools/gen_font.py writes web/public/firmware/matryoshka-font.bin; the build puts NAME-font.bin beside NAME.fwsc).
// This module says what to offer on connect and installs an image over the editor link, as tools/m1_link.py
// font-install does, in the factory region's power-cut-safe order (factory-content.ts).
import { sectorPages, sectorSum, type Ask } from './factory-content';
import { FONT, fontBeginFrame, fontCommitFrame, fontSumFrame, fontWriteFrame, STATUS_TEXT, type Info, type Parsed } from './protocol';

export const FONT_FILE = 'matryoshka-font.bin';
const SECTOR = 0x1000;
const FLASH_MS = 2500;

/** the id of the font in a font area image (its header's CRC-32), null when `img` is not one */
export function fontId(img: Uint8Array): number | null {
  if (img.length < 64 || String.fromCharCode(...img.subarray(0, 4)) !== 'MFN1') return null;
  return new DataView(img.buffer, img.byteOffset, img.byteLength).getUint32(12, true);
}

/** the screen font this site has for the firmware it installs (`base`: where the firmware package is served), null
 *  when there is none */
export async function fetchFont(base = './firmware/'): Promise<Uint8Array | null> {
  const r = await fetch(`${base}${FONT_FILE}`, { cache: 'no-cache' }).catch(() => null);
  if (!r?.ok) return null;
  const img = new Uint8Array(await r.arrayBuffer());
  return fontId(img) === null ? null : img;
}

/** what the editor says on connect about the screen font when the FM-1 has no room for it yet (INFO's font area bit 3):
 *  its bank holds more than 48 patches, and the font needs three of the bank's old sectors (#602, D-184) */
export const FONT_BLOCKED =
  "This FM-1 has more than 48 patches, so there isn't room for the screen font yet, and it shows only its small type. " +
  'Delete patches until 48 or fewer are left, restart the FM-1, then install the screen font.';

/** what the editor says on connect about the screen font (null: nothing to do): an install when the FM-1 lacks the
 *  font its firmware needs and this site has that font, else how to get it */
export function fontOffer(font: Info['font'], have: Uint8Array | null): { text: string; install: boolean } | null {
  if (!font || (font.valid && !font.writing)) return null;
  if (font.blocked) return { text: FONT_BLOCKED, install: false };
  if (have && fontId(have) === font.id)
    return { text: font.writing ? 'An install of the screen font on this FM-1 was cut off: install it again.'
      : 'This FM-1 has no screen font yet: it shows only its small type. Install the screen font.', install: true };
  return { text: "This FM-1's firmware needs a screen font this copy of the app does not have: install the firmware that comes with it (Install firmware).", install: false };
}

const refused = (what: string, st: number): Error => new Error(`FM-1: ${what}: ${STATUS_TEXT[st] ?? `error ${st}`}`);

/** the install (power-cut safe, font_area.c): BEGIN, each sector whose SUM differs written page by page, then COMMIT
 *  with the header. `progress(done, total)` in pages */
export async function installFont(ask: Ask, img: Uint8Array, progress: (done: number, total: number) => void = () => {}): Promise<void> {
  const sectors = Math.ceil(img.length / SECTOR);
  const total = Array.from({ length: sectors }, (_, s) => sectorPages(img, s).length).reduce((a, b) => a + b, 0);
  const acked = (op: number) => (p: Parsed | null): boolean => p?.cmd === 0x40 && p.payload[0] === FONT.cmd && p.payload[1] === op;
  let st = (await ask(fontBeginFrame(), acked(FONT.begin), FLASH_MS, 3)).payload[2];
  if (st) throw refused('FONT BEGIN', st);
  let done = 0;
  progress(0, total);
  for (let s = 0; s < sectors; s++) {
    const pages = sectorPages(img, s);
    const sum = await ask(fontSumFrame(s), (p) => p?.cmd === FONT.sumReply && p.payload[0] === s, FLASH_MS, 3);
    if (sum.payload[1] && (sum.payload[2] | sum.payload[3] << 8) === sectorSum(img, s)) {
      progress((done += pages.length), total);      // (written already: an install run again after a cut)
      continue;
    }
    for (const [off, page] of pages) {
      st = (await ask(fontWriteFrame(s, off, page), acked(FONT.write), FLASH_MS, 3)).payload[2];
      if (st) throw refused(`FONT WRITE sector ${s} offset ${off}`, st);
      progress(++done, total);
    }
  }
  st = (await ask(fontCommitFrame(img), acked(FONT.commit), FLASH_MS, 1)).payload[2];
  if (st) throw refused('FONT COMMIT', st);
}
