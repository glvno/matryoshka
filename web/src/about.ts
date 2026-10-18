// The About & support card: the owner's words, the Slop Disclosure figures (ai-stats.ts), the credits, and Ko-fi's floating button.
// Ko-fi's overlay script is loaded the first time the card opens (nothing from Ko-fi before that) and draws its button into the
// card: the dialog has a transform, so the script's position: fixed button and popup sit in the card's corner, not the window's.
import COPY from './about-copy.json';
import REVIEW from './ai-review.json';
import { formatDay, formatHours, formatUsd, isAiStats, modelName, modelShares, totalCost, type AiReview, type AiStats } from './ai-stats';
import { version } from '../package.json';

const KOFI = 'glvno';
const KOFI_SCRIPT = 'https://storage.ko-fi.com/cdn/scripts/overlay-widget.js';

declare global {
  interface Window { kofiWidgetOverlay?: { draw(page: string, config: Record<string, string>, containerId?: string): void } }
}

/** a theme token as a plain rgb() colour (the button is drawn inside Ko-fi's frame, where our variables do not exist) */
function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

let kofiScript: Promise<void> | null = null;
const loadKofi = (): Promise<void> => (kofiScript ??= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = KOFI_SCRIPT;
  s.onload = () => resolve();
  s.onerror = () => { kofiScript = null; reject(new Error('Ko-fi did not load')); };
  document.head.append(s);
}));
const REPO = 'https://github.com/glvno/matryoshka';
const MODEL_COLORS = ['var(--accent)', 'var(--secondary)', 'var(--gate)', 'var(--tag-asm)', 'var(--muted)'];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const link = (href: string, text: string): string => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
/** the owner's passages; an empty one shows a reminder on the dev server and nothing in the build */
const passage = (text: string, where: string): string =>
  text ? text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('') : import.meta.env.DEV ? `<p class="about-todo">${where} (src/about-copy.json)</p>` : '';

function figure(label: string, value: string, caption: string): string {
  return `<div class="ai-fig"><span class="ai-label">${label}</span><span class="ai-value">${value}</span><span class="ai-sub">${caption}</span></div>`;
}

/** Blood (time), Sweat (human review), Tears (AI spend: WakaTime's estimate at API prices, not a bill) */
function figures(stats: AiStats | null, review: AiReview): string {
  const blood = figure('Blood', stats ? formatHours(stats.seconds) : '—', 'human-in-the-loop time');
  const sweat = figure('Sweat', review.percent !== null ? `${Math.round(review.percent)} %` : '—',
    review.sessions !== null ? `${review.sessions} human review sessions` : 'human review sessions');
  const tears = figure('Tears', stats ? formatUsd(totalCost(stats)) : '—', 'AI spend');
  return `<div class="ai-figs">${blood}${sweat}${tears}</div>`;
}

function models(stats: AiStats | null): string {
  const shares = stats ? modelShares(stats) : [];
  if (!shares.length) return '';
  const color = (i: number): string => MODEL_COLORS[Math.min(i, MODEL_COLORS.length - 1)];
  const pct = (s: number): string => `${Math.max(1, Math.round(s * 100))} %`;
  return `<div class="ai-models" aria-label="AI spend by model">
    <div class="ai-bar">${shares.map((m, i) => `<span style="flex: ${m.share}; background: ${color(i)}" title="${esc(modelName(m.model))} ${pct(m.share)}"></span>`).join('')}</div>
    <ul>${shares.map((m, i) => `<li><i style="background: ${color(i)}"></i>${esc(modelName(m.model))} <b>${pct(m.share)}</b></li>`).join('')}</ul></div>`;
}

function source(stats: AiStats | null): string {
  if (!stats) return '<p class="ai-source">The figures appear after the next deploy fetches them from WakaTime.</p>';
  return `<p class="ai-source">Source: WakaTime API as of ${formatDay(stats.asOf)}</p>`;
}

function credits(): string {
  return `<section class="hsec"><h3>Built on</h3>
    <div class="credit"><p>${link('https://github.com/hugelton/Felucca', 'Felucca')}, by ${link('https://github.com/kurogedelic', 'Leo Kuroshita (@kurogedelic)')} /
      ${link('https://hugelton.com', 'Hügelton Instruments')}: the flasher, the loader and the hardware support.</p>
      <p class="credit-links">${link('https://github.com/sponsors/hugelton', 'Sponsor on GitHub')} · ${link('https://www.buymeacoffee.com/kurogek', 'Buy Leo a coffee')} ·
      ${link('https://hugelton.itch.io/', 'Plugins on itch.io')}</p></div>
    <div class="credit"><p>${link('https://github.com/WiggisModular/Modular-1', 'Modular-1')}, by ${link('https://github.com/morgulbrut', '@morgulbrut')} /
      ${link('https://github.com/WiggisModular', 'WiggisModular')}: the modular synthesizer this project grew from.</p></div>
    <p class="muted about-foot">Version ${esc(version)} · GPL-3.0-only · ${link(REPO, 'Source')} · ${link(`${REPO}/issues`, 'Issues')} · Not affiliated with M-VAVE or Clavia.</p>
  </section>`;
}

export class AboutCard {
  readonly dialog: HTMLDialogElement;
  private stats: AiStats | null | undefined;
  private kofiDrawn = false;

  constructor(dialog: HTMLDialogElement) {
    this.dialog = dialog;
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // a click on the backdrop
    });
  }

  async open(): Promise<void> {
    if (!this.dialog.firstChild) this.render();
    if (!this.dialog.open) this.dialog.showModal();
    void this.drawKofi();
    if (this.stats === undefined) {
      this.stats = await fetch('./ai-stats.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => (isAiStats(j) ? j : null))
        .catch(() => null);
      this.renderUsage();
    }
  }

  /** Ko-fi's button, once per page: the script keeps the button (and the panel it opens) in the card from then on */
  private async drawKofi(): Promise<void> {
    if (this.kofiDrawn) return;
    this.kofiDrawn = true;
    try {
      await loadKofi();
    } catch {
      this.kofiDrawn = false;
      this.dialog.querySelector('.about-kofi')!.innerHTML = link(`https://ko-fi.com/${KOFI}`, 'Support Matryoshka on Ko-fi');
      return;
    }
    window.kofiWidgetOverlay!.draw(KOFI, {
      type: 'floating-chat',
      'floating-chat.donateButton.text': 'Support',
      'floating-chat.donateButton.background-color': tokenColor('--accent'),
      'floating-chat.donateButton.text-color': tokenColor('--accent-ink'),
    }, 'about-kofi');
    // the button's frame is written by the script (same origin): give it the app's capitals once its stylesheet is in
    const frame = this.dialog.querySelector<HTMLIFrameElement>('iframe.floatingchat-container');
    const style = (): void => {
      const doc = frame?.contentDocument;
      if (!doc?.head || doc.getElementById('m-font')) return;
      const font = new URL('./fonts/BarlowCondensed-SemiBold.ttf', document.baseURI).href;
      doc.head.insertAdjacentHTML('beforeend', `<style id="m-font">@font-face { font-family: 'Barlow Condensed'; src: url('${font}'); font-weight: 600; }
        .floatingchat-donate-button span { font-family: 'Barlow Condensed', system-ui, sans-serif !important; font-weight: 600 !important; letter-spacing: .06em; text-transform: uppercase; }</style>`);
    };
    for (const ms of [50, 400, 1500]) setTimeout(style, ms);
  }

  private render(): void {
    this.dialog.innerHTML = `
      <div class="shead"><span class="mtag util">ABOUT</span><span class="stitle" id="about-title">Matryoshka</span>
        <form method="dialog"><button class="help-close" aria-label="Close">×</button></form></div>
      <div class="about-body">
        <div class="about-main">
          <div class="about-brand-row"><img src="./brand/matryoshka.png" width="56" height="56" alt="" />
            <div><img class="brand-mark" src="./brand/wordmark.svg" alt="Matryoshka" />
            <p class="muted">A patchable modular synth for the M-VAVE FM-1, with a browser editor.</p></div></div>
          ${passage(COPY.intro, 'Your words for supporters go here')}
          <section class="hsec ai-usage"><h3>Slop Disclosure</h3><div class="ai-live"></div>
            ${passage(COPY.howMade, 'Your “How it’s made” paragraph goes here')}</section>
          ${credits()}
        </div>
        <div id="about-kofi" class="about-kofi" aria-label="Support on Ko-fi"></div>
      </div>`;
    this.renderUsage();
  }

  private renderUsage(): void {
    const stats = this.stats ?? null;
    const live = this.dialog.querySelector('.ai-live');
    if (live) live.innerHTML = figures(stats, REVIEW as AiReview) + models(stats) + source(stats);
  }
}
