// The About & support card: the owner's words, the Slop Disclosure figures (ai-stats.ts), the test coverage (coverage.ts), the credits, Ko-fi's floating button
// and a plain GitHub Sponsors link under it (no GitHub script).
// Ko-fi's overlay script is loaded the first time the card opens (nothing from Ko-fi before that) and draws its button into the
// card: the dialog has a transform, so the script's position: fixed button and popup are placed in the card, not the window
// (top right, see style.css).
import COPY from './about-copy.json';
import { isAiPrompts, type AiPrompts } from './ai-prompts';
import { formatDay, formatHours, formatUsd, isAiStats, modelName, modelShares, totalCost, type AiStats } from './ai-stats';
import { isCoverageStats, type CoverageStats } from './coverage';
import { versionLabel } from './version';
import { notesUrl } from './whats-new';
import { inlineWordmarks, logoHtml } from './brand';

const KOFI = 'glvno';
const SPONSORS = 'https://github.com/sponsors/glvno';
/** the button is as tall as the wordmark (30 px; style.css lines its top up with the wordmark's) */
const KOFI_BUTTON_H = 30;
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

/** Blood (time), Sweat (human interventions: the prompts typed into Claude Code and Codex), Tears (AI spend: WakaTime's estimate at API prices, not a bill) */
function figures(stats: AiStats | null, prompts: AiPrompts | null): string {
  const blood = figure('Blood', stats ? formatHours(stats.seconds) : '—', 'human in the loop');
  const sweat = figure('Sweat', prompts ? prompts.prompts.toLocaleString('en-US') : '—', 'human interventions');
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

function source(stats: AiStats | null, prompts: AiPrompts | null): string {
  const waka = stats ? `WakaTime API as of ${formatDay(stats.asOf)}` : '';
  const cli = prompts ? `human interventions, counted from Claude Code and Codex transcripts, as of ${formatDay(prompts.asOf)}` : '';
  if (!waka && !cli) return '<p class="ai-source">The figures appear after the next deploy fetches them.</p>';
  return `<p class="ai-source">Source: ${[waka, cli].filter(Boolean).join('; ')}</p>`;
}

const pctText = (pct: number): string => `${Math.round(pct)} %`;

function coverage(c: CoverageStats | null): string {
  const core = figure('Core', c ? pctText(c.core.pct) : '—', '(audio processing, modules, patch model, binary format, assemblies, polyphony, arpeggiator, CPU estimate, protocol)');
  const ui = figure('Browser interface', c ? pctText(c.interface.pct) : '—', '(lgtm lmao)');
  const src = c ? `<p class="ai-source">Source: Vitest as of ${formatDay(c.asOf)}</p>` : '<p class="ai-source">The figures appear after the next deploy runs the tests.</p>';
  return `<div class="ai-figs two">${core}${ui}</div>${src}`;
}

function credits(): string {
  return `<section class="hsec"><h3>Built on</h3>
    <div class="credit"><p>${link('https://github.com/hugelton/Felucca', 'Felucca')}, by ${link('https://github.com/kurogedelic', 'Leo Kuroshita (@kurogedelic)')} /
      ${link('https://hugelton.com', 'Hügelton Instruments')}: the flasher, the loader and the hardware support.</p>
      <p class="credit-links">${link('https://github.com/sponsors/hugelton', 'Sponsor on GitHub')} · ${link('https://www.buymeacoffee.com/kurogek', 'Buy Leo a coffee')} ·
      ${link('https://hugelton.itch.io/', 'Plugins on itch.io')}</p></div>
    <div class="credit"><p>${link('https://github.com/WiggisModular/Modular-1', 'Modular-1')}, by ${link('https://github.com/morgulbrut', '@morgulbrut')} /
      ${link('https://github.com/WiggisModular', 'WiggisModular')}: the modular synthesizer this project grew from.</p></div>
    <p class="muted about-foot">Version ${esc(versionLabel())} · ${link(notesUrl(), 'What’s new')} · GPL-3.0-only · ${link(REPO, 'Source')} · ${link(`${REPO}/issues`, 'Issues')} · Not affiliated with M-VAVE or Clavia.</p>
  </section>`;
}

export class AboutCard {
  readonly dialog: HTMLDialogElement;
  private stats: AiStats | null | undefined;
  private prompts: AiPrompts | null | undefined;
  private cov: CoverageStats | null | undefined;
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
      const get = (file: string): Promise<unknown> => fetch(file, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [stats, prompts, cov] = await Promise.all([get('./ai-stats.json'), get('./ai-prompts.json'), get('./coverage.json')]);
      this.stats = isAiStats(stats) ? stats : null;
      this.prompts = isAiPrompts(prompts) ? prompts : null;
      this.cov = isCoverageStats(cov) ? cov : null;
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
        .floatingchat-donate-button span { font-family: 'Barlow Condensed', system-ui, sans-serif !important; font-weight: 600 !important; letter-spacing: .06em; text-transform: uppercase; }
        .floatingchat-donate-button { height: ${KOFI_BUTTON_H}px !important; } .floatingchat-donate-button { padding: 0 14px !important; } .kofiimg { height: 22px !important; width: auto !important; }</style>`);
    };
    // the button sits in the card's top right corner (style.css): its wrapper is as wide as the button, so it ends at the edge
    const fit = (): void => {
      const button = frame?.contentDocument?.querySelector<HTMLElement>('.floatingchat-donate-button');
      const wrap = frame?.parentElement;
      if (button?.offsetWidth && wrap) wrap.style.width = `${button.offsetWidth}px`;
    };
    for (const ms of [50, 400, 1500]) setTimeout(() => (style(), fit()), ms);
  }

  private render(): void {
    this.dialog.innerHTML = `
      <div class="shead"><span class="mtag util">ABOUT</span><span class="stitle" id="about-title">Matryoshka</span>
        <form method="dialog"><button class="help-close" aria-label="Close">×</button></form></div>
      <div class="about-body">
        <div class="about-main">
          <div class="about-brand-row">${logoHtml()}
            <div><img class="brand-mark" src="./brand/wordmark.svg" alt="Matryoshka" />
            <p class="muted">A recursively modular and FM1-friendly synth engine framework</p></div></div>
          <p class="about-sponsor">${link(SPONSORS, 'Sponsor on GitHub')}</p>
          ${passage(COPY.intro, 'Your words for supporters go here')}
          <section class="hsec ai-usage"><h3>Slop Disclosure</h3><div class="ai-live"></div>
            ${passage(COPY.howMade, 'Your “How it’s made” paragraph goes here')}</section>
          <section class="hsec"><h3>Test coverage</h3><div class="cov-live"></div></section>
          ${credits()}
        </div>
        <div id="about-kofi" class="about-kofi" aria-label="Support on Ko-fi"></div>
      </div>`;
    void inlineWordmarks(this.dialog);
    this.renderUsage();
  }

  private renderUsage(): void {
    const stats = this.stats ?? null;
    const live = this.dialog.querySelector('.ai-live');
    const prompts = this.prompts ?? null;
    if (live) live.innerHTML = figures(stats, prompts) + models(stats) + source(stats, prompts);
    const cov = this.dialog.querySelector('.cov-live');
    if (cov) cov.innerHTML = coverage(this.cov ?? null);
  }
}
