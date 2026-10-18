// SPDX-License-Identifier: GPL-3.0-only
// The logo and the wordmark in the theme's colours (glvno/matryoshka#88). The logo is a stack of colour masks
// (public/brand/layers, made by `npm run logo-layers`) that style.css fills with tokens; the wordmark SVG is put inline
// so its fills follow the page's tokens and the theme switch (as an <img> it only saw the system's light / dark).

/** the logo's layers, bottom to top (scripts/logo-layers.ts LAYERS) */
const LAYERS = ['coral', 'gold', 'shade', 'teal', 'rim', 'cream', 'ink'];

export const logoHtml = (cls = ''): string => `<span class="logo ${cls}" aria-hidden="true">${LAYERS.map((l) => `<i class="l-${l}"></i>`).join('')}</span>`;

let wordmark: Promise<string | null> | null = null;

/** replace every `img.brand-mark` under `root` by the inline wordmark (its own <style> dropped: style.css colours it) */
export async function inlineWordmarks(root: ParentNode = document): Promise<void> {
  wordmark ??= fetch('./brand/wordmark.svg')
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  const text = await wordmark;
  if (!text) return; // the <img> stays: right shape, the system's colours
  for (const img of root.querySelectorAll<HTMLImageElement>('img.brand-mark')) {
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    if (svg.nodeName !== 'svg') return;
    svg.querySelector('style')?.remove();
    svg.classList.add('brand-mark');
    svg.setAttribute('aria-label', img.alt || 'Matryoshka');
    img.replaceWith(document.importNode(svg, true));
  }
}
