// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's factory content (#915, D-179 amended, D-490): the factory region the editor installs next to the firmware.
// The firmware carries its tier (web/src/factory-tiers.ts) and plays it alone until the region holds valid content; the
// region holds the other factory patches, every factory engine preset and the drum patterns. This module picks the set
// this site offers an FM-1 (web/public/firmware/factory-sets.json: today's set and older ones kept for older firmwares),
// says what to offer on connect, and installs an image over the editor link, as tools/m1_link.py factory-install does.
import { crc16, FACT, FACT_HEADER, factBeginFrame, factCommitFrame, factInfoFrame, factSumFrame, factWriteFrame, parse, parseFactoryInfo, STATUS_TEXT, type FactoryInfo, type Parsed } from './protocol';

/** one installable set (factory-sets.json, written by export-defs from each image's header) */
export interface FactorySet { file: string; version: number; set: string; layout: number; format: number; bytes: number }

/** a frame sent and the first answer `match` takes, sent again up to `tries` times when none comes within `timeout` ms */
export type Ask = (frame: Uint8Array, match: (p: Parsed | null) => boolean, timeout: number, tries: number) => Promise<Parsed>;

const SECTOR = 0x1000;
const PAGE = 256;
const RECORD = 0xf00, RECORD_LEN = 80;    // the page an update record would be in (firmware/loader/ldr_record.h): written whole
const ASK_MS = 700, FLASH_MS = 2500;

/** the sets this site offers (empty when the manifest is missing) */
export async function loadFactorySets(base = './firmware/'): Promise<FactorySet[]> {
  const r = await fetch(`${base}factory-sets.json`, { cache: 'no-cache' });
  if (!r.ok) return [];
  const j = (await r.json()) as { sets?: FactorySet[] };
  return Array.isArray(j.sets) ? j.sets : [];
}

/** the newest set this firmware reads: its layout, and a patch format it plays (FACT_INFO), else null */
export function pickSet(sets: readonly FactorySet[], info: FactoryInfo): FactorySet | null {
  return sets.filter((s) => s.layout === info.reads && s.format <= info.plays).reduce<FactorySet | null>((best, s) => (!best || s.version > best.version ? s : best), null);
}

export interface FactoryOffer { text: string; action: string; set: FactorySet }

/** what the editor offers on connect (null: nothing): an install when the FM-1 has no valid factory content (or one
 *  for a newer firmware, or a cut-off install), an update when this site's set is newer or another build of the same */
export function factoryOffer(info: FactoryInfo, set: FactorySet | null): FactoryOffer | null {
  if (!set) return null;
  const install = (text: string): FactoryOffer => ({ text, action: 'Install', set });
  if (info.writing) return install('An install of the factory sounds on this FM-1 was cut off: install them again.');
  if (info.state === 0) return install('This FM-1 has no factory sounds yet: only its built-in patches play. Install the factory instruments and presets.');
  if (info.state === 2) return install("This FM-1's factory sounds are for a newer firmware: install the set for the firmware it runs.");
  if (info.state === 3) return install("This FM-1's factory sounds are damaged: install them again.");
  if (parseInt(set.set, 16) !== info.set && set.version >= info.version)
    return { text: `Newer factory sounds for this FM-1 (version ${info.version} → ${set.version}).`, action: 'Update', set };
  return null;
}

/** the image of a set */
export async function fetchFactoryImage(set: FactorySet, base = './firmware/'): Promise<Uint8Array> {
  const r = await fetch(`${base}${set.file}?v=${set.set}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the factory sounds (${set.file}) could not be loaded`);
  return new Uint8Array(await r.arrayBuffer());
}

/** FACT_INFO */
export async function factoryInfo(ask: Ask): Promise<FactoryInfo> {
  const info = parseFactoryInfo(await ask(factInfoFrame(), (p) => p?.cmd === FACT.infoReply, ASK_MS, 3));
  if (!info) throw new Error('unexpected answer to FACT_INFO');
  return info;
}

/** CRC-16 of sector s as the FM-1 holds it once the image is written, before the commit (the header's 64 bytes erased) */
export function sectorSum(img: Uint8Array, s: number): number {
  const b = new Uint8Array(SECTOR).fill(0xff);
  b.set(img.subarray(s * SECTOR, Math.min(img.length, (s + 1) * SECTOR)));
  if (s === 0) b.fill(0xff, 0, FACT_HEADER);
  return crc16(b);
}

/** the pages FACT_WRITE sends for sector s: [offset, bytes], each inside one 256-byte page */
export function sectorPages(img: Uint8Array, s: number): [number, Uint8Array][] {
  const pages: [number, Uint8Array][] = [];
  for (let off = s ? 0 : FACT_HEADER; off < SECTOR && s * SECTOR + off < img.length; off = (off | (PAGE - 1)) + 1) {
    const at = s * SECTOR + off;
    let page = img.slice(at, Math.min(img.length, at + PAGE - (off & (PAGE - 1))));
    if ((off & RECORD) === RECORD && page.length < RECORD_LEN) page = Uint8Array.from({ length: PAGE }, (_, i) => (i < page.length ? page[i] : 0xff));
    pages.push([off, page]);
  }
  return pages;
}

const statusOf = (p: Parsed): number => p.payload[2];
const refused = (what: string, st: number): Error => new Error(`FM-1: ${what}: ${STATUS_TEXT[st] ?? `error ${st}`}`);

/** the install (power-cut safe, factory.c): FACT_BEGIN, each sector whose FACT_SUM differs written page by page, then
 *  FACT_COMMIT with the header. `progress(done, total)` in pages */
export async function installFactory(ask: Ask, img: Uint8Array, progress: (done: number, total: number) => void = () => {}): Promise<void> {
  const sectors = Math.ceil(img.length / SECTOR);
  const total = Array.from({ length: sectors }, (_, s) => sectorPages(img, s).length).reduce((a, b) => a + b, 0);
  const acked = (cmd: number) => (p: Parsed | null): boolean => p?.cmd === 0x40 && p.payload[0] === cmd;
  let st = statusOf(await ask(factBeginFrame(), acked(FACT.begin), FLASH_MS, 3));
  if (st) throw refused('FACT_BEGIN', st);
  let done = 0;
  progress(0, total);
  for (let s = 0; s < sectors; s++) {
    const pages = sectorPages(img, s);
    const sum = await ask(factSumFrame(s), (p) => p?.cmd === FACT.sumReply && p.payload[0] === s, FLASH_MS, 3);
    if (sum.payload[1] && (sum.payload[2] | sum.payload[3] << 8) === sectorSum(img, s)) {
      progress((done += pages.length), total);      // (written already: an install run again after a cut)
      continue;
    }
    for (const [off, page] of pages) {
      st = statusOf(await ask(factWriteFrame(s, off, page), acked(FACT.write), FLASH_MS, 3));
      if (st) throw refused(`FACT_WRITE sector ${s} offset ${off}`, st);
      progress(++done, total);
    }
  }
  st = statusOf(await ask(factCommitFrame(img), acked(FACT.commit), FLASH_MS, 1));
  if (st) throw refused('FACT_COMMIT', st);
}

/** an Ask over a raw link (fm1ota.js's send / read: the Install panel's) */
export function linkAsk(link: { send(b: number[] | Uint8Array): boolean; read(ms: number): Promise<number[] | null> }): Ask {
  return async (frame, match, timeout, tries) => {
    for (let t = 0; t < tries; t++) {
      link.send(frame);
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const f = await link.read(end - Date.now());
        if (!f) break;
        const p = parse(f);
        if (match(p)) return p!;
      }
    }
    throw new Error('no answer from the FM-1');
  };
}
