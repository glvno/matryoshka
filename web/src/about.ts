// The About & support card: the owner's words, the AI usage figures (ai-stats.ts), the credits, and Ko-fi's donation panel. The
// panel is an iframe made when the card opens and removed when it closes, so nothing from Ko-fi loads (no script, no cookies)
// before someone opens the card.
import COPY from './about-copy.json';
import REVIEW from './ai-review.json';
import { formatDay, formatHours, formatUsd, isAiStats, modelName, modelShares, totalCost, type AiReview, type AiStats } from './ai-stats';
import { version } from '../package.json';

const KOFI = 'glvno';
const KOFI_PANEL = `https://ko-fi.com/${KOFI}/?hidefeed=true&widget=true&embed=true&preview=true`;
const REPO = 'https://github.com/glvno/matryoshka';
const MODEL_COLORS = ['var(--accent)', 'var(--secondary)', 'var(--gate)', 'var(--tag-asm)', 'var(--muted)'];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const link = (href: string, text: string): string => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
/** the owner's passages; an empty one shows a reminder on the dev server and nothing in the build */
const passage = (text: string, where: string): string =>
  text ? text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('') : import.meta.env.DEV ? `<p class="about-todo">${where} (src/about-copy.json)</p>` : '';

function figure(label: string, value: string, sub: string, def: string): string {
  return `<div class="ai-fig"><span class="ai-label">${label}</span><span class="ai-value">${value}</span><span class="ai-sub">${sub}</span><span class="ai-def">${def}</span></div>`;
}

function figures(stats: AiStats | null, review: AiReview): string {
  const time = stats
    ? figure('Time', formatHours(stats.seconds), stats.since ? `since ${formatDay(stats.since)}` : 'nothing tracked yet',
      'Every minute WakaTime tracked on the project: writing, prompting the AI, reviewing, debugging, reading.')
    : figure('Time', '—', 'not fetched yet', 'Every minute WakaTime tracked on the project.');
  const spend = stats
    ? figure('AI spend', formatUsd(totalCost(stats)), 'API-equivalent estimate',
      'What the AI\'s tokens would cost at API prices, as WakaTime estimates it. It is not a bill.')
    : figure('AI spend', '—', 'not fetched yet', 'What the AI\'s tokens would cost at API prices, as WakaTime estimates it.');
  const rev = review.percent !== null
    ? figure('Human review', `${Math.round(review.percent)} %`, review.sessions !== null ? `${review.sessions} review sessions` : '',
      `WakaTime's dashboard figure for how much of the AI's work got a human review session, copied by hand${review.asOf ? ` on ${formatDay(review.asOf)}` : ''} (it is not in their API).`)
    : figure('Human review', '—', 'not copied yet', 'WakaTime\'s dashboard figure for how much of the AI\'s work got a human review session.');
  return `<div class="ai-figs">${time}${spend}${rev}</div>`;
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
  return `<p class="ai-source">WakaTime projects ${stats.projects.map((p) => `<code>${esc(p)}</code>`).join(' + ')} · as of ${formatDay(stats.asOf)}</p>`;
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

  constructor(dialog: HTMLDialogElement) {
    this.dialog = dialog;
    dialog.addEventListener('close', () => dialog.querySelector('.about-kofi iframe')?.remove());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // a click on the backdrop
    });
  }

  async open(): Promise<void> {
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    const frame = document.createElement('iframe');
    frame.src = KOFI_PANEL;
    frame.title = `Support ${KOFI} on Ko-fi`;
    frame.height = '712';
    this.dialog.querySelector('.about-kofi')!.append(frame);
    if (this.stats === undefined) {
      this.stats = await fetch('./ai-stats.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => (isAiStats(j) ? j : null))
        .catch(() => null);
      if (this.dialog.open) this.renderUsage();
    }
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
          <section class="hsec ai-usage"><h3>AI usage</h3><div class="ai-live"></div>
            ${passage(COPY.howMade, 'Your “How it’s made” paragraph goes here')}</section>
          ${credits()}
        </div>
        <div class="about-kofi" aria-label="Support on Ko-fi"></div>
      </div>`;
    this.renderUsage();
  }

  private renderUsage(): void {
    const stats = this.stats ?? null;
    const live = this.dialog.querySelector('.ai-live');
    if (live) live.innerHTML = figures(stats, REVIEW as AiReview) + models(stats) + source(stats);
  }
}
