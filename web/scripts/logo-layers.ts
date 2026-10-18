// SPDX-License-Identifier: GPL-3.0-only
// Splits the logo (public/brand/matryoshka.png, flat art in a few colours) into one mask per colour, so the page can fill
// each with a theme token (style.css `.logo`, glvno/matryoshka#88). Every pixel goes to its nearest key colour; a layer's
// mask holds its own pixels and those of every layer above it, so the stack anti-aliases like the original instead of
// leaving seams where two soft edges meet. Run `npm run logo-layers` after the logo changes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readPng, writePng } from './png';

/** bottom to top; `key` = the colour in the art. The fills are in style.css (`--logo-<name>`). */
export const LAYERS = [
  { name: 'coral', key: [0xf2, 0x56, 0x36] },
  { name: 'gold', key: [0xe4, 0xb4, 0x44] },
  { name: 'shade', key: [0xc4, 0x92, 0x48] },
  { name: 'teal', key: [0x22, 0x76, 0x82] },
  { name: 'rim', key: [0xc6, 0xb6, 0xa6] },
  { name: 'cream', key: [0xf4, 0xf2, 0xe6] },
  { name: 'ink', key: [0x12, 0x12, 0x12] },
];
/** the masks are a third of the art's size: 418 px for a logo drawn at most ~200 css px */
const SCALE = 3;

const web = new URL('../', import.meta.url);
const src = readPng(readFileSync(new URL('public/brand/matryoshka.png', web)));
const { width, height, data } = src;
const n = width * height;
const layerOf = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const [r, g, b] = data.subarray(i * 4, i * 4 + 3);
  let best = 0, bd = Infinity;
  LAYERS.forEach((l, k) => {
    const d = (r - l.key[0]) ** 2 + (g - l.key[1]) ** 2 + (b - l.key[2]) ** 2;
    if (d < bd) (bd = d), (best = k);
  });
  layerOf[i] = best;
}

const w = Math.ceil(width / SCALE), h = Math.ceil(height / SCALE);
const out = new URL('public/brand/layers/', web);
mkdirSync(out, { recursive: true });
LAYERS.forEach((l, k) => {
  const mask = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = 0; dy < SCALE; dy++)
        for (let dx = 0; dx < SCALE; dx++) {
          const sx = x * SCALE + dx, sy = y * SCALE + dy;
          if (sx >= width || sy >= height) continue;
          const i = sy * width + sx;
          cnt++;
          if (layerOf[i] >= k) sum += data[i * 4 + 3];
        }
      mask[(y * w + x) * 4 + 3] = Math.round(sum / cnt); // black, the coverage in alpha (CSS masks read alpha)
    }
  writeFileSync(new URL(`${l.name}.png`, out), writePng({ width: w, height: h, data: mask }));
});
console.log(`${LAYERS.length} masks of ${w} x ${h} in public/brand/layers/`);
