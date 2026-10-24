// SPDX-License-Identifier: GPL-3.0-only
// The share sheet (glvno/matryoshka#165; design board "Sharing + community", option A): the PATCH panel's Share button, the ⋯ menu's Share… and the
// palette open it. The title (the patch's name) and "What's going on" (Patch.notes) write back to the patch; the facts
// (modules, engines, the FM-1 fit) and the card preview (patch-card.ts) follow them. "Keep my layout and assemblies in
// the link" with the link's length live; a patch too big for a link even without its layout gets Save file instead, and
// no over-long link is ever copied. Post to Reddit copies the link, opens r/MVaveFM1's submit page with the title and
// saves the card, for the user to drop in as the image (the link goes in the first comment). No server: per-patch link
// previews and short links are after 1.0.
import { DEFS } from './modules';
import { fitLine, paintPatchCard, patchFacts, savePatchCard } from './patch-card';
import { NOTES_MAX, type Patch } from './patch';
import { submitUrl } from './community';
import { encodeShare, handOut, LINK_MAX, type HandedOut, type Share } from './share';

export const SUBREDDIT = 'MVaveFM1';
/** Reddit's submit page with the title filled in (the documented `title` parameter; `url` is left out on purpose: the post
 * is the card image, the link goes in the first comment) */
export const redditSubmitUrl = (title: string): string => `https://www.reddit.com/r/${SUBREDDIT}/submit?title=${encodeURIComponent(title)}`;
/** the remembered "by" name (per browser) */
const BY_KEY = 'matryoshka.shareBy';

export interface ShareSheetEvents {
  /** the open patch */
  patch(): Patch;
  /** the title was edited: the patch is renamed (the sidebar's name field follows) */
  rename(name: string): void;
  /** the notes were edited (saved with the patch) */
  changed(): void;
  /** a link was copied (the tutorial's "shares") */
  copied(link: string): void;
  /** Save file (.json) */
  saveFile(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

const readBy = (): string => {
  try {
    return localStorage.getItem(BY_KEY) ?? '';
  } catch {
    return '';
  }
};
const writeBy = (v: string): void => {
  try {
    if (v.trim()) localStorage.setItem(BY_KEY, v.trim());
    else localStorage.removeItem(BY_KEY);
  } catch {
    /* not remembered */
  }
};

const n = (x: number): string => x.toLocaleString('en');
/** where a stored link's patch is kept (share-store.ts): this site */
const SITE_HOST = location.host;

export class ShareSheet {
  private heading = el('h2', { id: 'share-title', class: 'share-heading' });
  private canvas = el('canvas', { class: 'share-card', width: 1200, height: 900 });
  private title = el('input', { type: 'text', id: 'share-name', autocomplete: 'off', spellcheck: false });
  private notes = el('textarea', { id: 'share-notes', rows: 3, maxLength: NOTES_MAX });
  private by = el('input', { type: 'text', id: 'share-by', maxLength: 40, placeholder: 'your name or handle' });
  private facts = el('div', { class: 'share-facts' });
  private layout = el('input', { type: 'checkbox', id: 'share-layout', checked: true });
  private readout = el('p', { class: 'share-readout' });
  private msg = el('p', { class: 'share-msg', role: 'status' });
  private postBtn = el('button', { type: 'button', class: 'share-post', textContent: 'Post to Reddit ↗' });
  private copyBtn = el('button', { type: 'button', class: 'share-copy', textContent: 'Copy link' });
  private cardBtn = el('button', { type: 'button', textContent: 'Save card (PNG)' });
  private fileBtn = el('button', { type: 'button', textContent: 'Save file (.json)' });
  private submitBtn = el('button', { type: 'button', class: 'share-submit', textContent: 'Submit to the Community shelf \u2197' });
  private share: Share | null = null;
  /** the layout box as the user set it (it is unticked and disabled while the layout does not fit) */
  private wantLayout = true;
  /** the newest encode wins: an older one finishing late is dropped */
  private seq = 0;
  private timers = { link: 0, card: 0 };

  constructor(private dlg: HTMLDialogElement, private ev: ShareSheetEvents) {
    const close = el('button', { type: 'button', class: 'help-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close');
    close.onclick = () => this.dlg.close();
    const field = (label: string, input: HTMLElement, hint?: string): HTMLLabelElement => el('label', { class: 'share-field' }, el('span', { textContent: label }), input, ...(hint ? [el('small', { textContent: hint })] : []));
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'The patch card: its cards, its cables in their colours, the counts');
    dlg.replaceChildren(
      el('div', { class: 'shead' }, el('span', { class: 'mtag src', textContent: 'SHARE' }), el('span', { class: 'stitle', textContent: 'Share patch' }), close),
      el(
        'div',
        { class: 'share-body' },
        this.heading,
        el(
          'div',
          { class: 'share-grid' },
          el('figure', { class: 'share-figure' }, this.canvas, el('figcaption', { textContent: 'The card is drawn from the patch: its cards, its cables in their colours, the counts. It is the image a post shows.' })),
          el(
            'div',
            { class: 'share-form' },
            field('Title', this.title),
            field('What’s going on (optional)', this.notes),
            this.facts,
            el('label', { class: 'share-check' }, this.layout, ' Keep my layout and assemblies in the link'),
            this.readout,
            field('By (optional, on the card)', this.by),
          ),
        ),
        el('div', { class: 'share-actions' }, this.postBtn, this.copyBtn, this.cardBtn, this.fileBtn),
        this.msg,
        el('p', { class: 'share-hint', textContent: `Post to Reddit copies the link, opens a new post on r/${SUBREDDIT} with the title filled in and saves the card. Drop the card in as the image and paste the link as the first comment.` }),
        el('p', { class: 'share-hint' }, this.submitBtn, ' opens the form (a GitHub issue) with this patch filled in; accepted patches are listed in Library > Community, under CC BY-SA 4.0 (#157).'),
      ),
    );
    dlg.setAttribute('aria-labelledby', 'share-title');
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // a click on the backdrop
    });
    this.title.oninput = () => {
      this.ev.rename(this.title.value);
      this.heading.textContent = this.title.value.trim() || 'Untitled';
      this.refresh();
    };
    this.notes.oninput = () => {
      const p = this.ev.patch();
      if (this.notes.value.trim()) p.notes = this.notes.value.slice(0, NOTES_MAX);
      else delete p.notes;
      this.ev.changed();
      this.refresh();
    };
    this.by.oninput = () => {
      writeBy(this.by.value);
      this.refresh(false);
    };
    this.layout.onchange = () => {
      this.wantLayout = this.layout.checked;
      this.refresh();
    };
    this.copyBtn.onclick = () => void this.copy();
    this.postBtn.onclick = () => void this.post();
    this.submitBtn.onclick = () => void this.submit();
    this.cardBtn.onclick = () => void this.saveCard();
    this.fileBtn.onclick = () => {
      this.ev.saveFile();
      this.say('Saved the patch as a .json file.');
    };
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(): void {
    const p = this.ev.patch();
    this.title.value = p.name;
    this.heading.textContent = p.name.trim() || 'Untitled';
    this.notes.value = p.notes ?? '';
    this.by.value = readBy();
    this.wantLayout = this.layout.checked = true;
    this.say('');
    this.share = null;
    this.refresh();
    this.dlg.showModal();
    if (!matchMedia('(pointer: coarse)').matches) this.title.focus(); // a phone would open its keyboard over the sheet
  }

  /** the facts now; the link and (unless `link` is false) the card a moment after the last keystroke */
  private refresh(link = true): void {
    const p = this.ev.patch();
    const f = patchFacts(p, DEFS);
    const chip = (text: string, warn = false): HTMLSpanElement => el('span', { class: 'share-chip' + (warn ? ' over' : ''), textContent: text });
    this.facts.replaceChildren(
      chip(`${n(f.modules)} module${f.modules === 1 ? '' : 's'}`),
      ...(f.engines.length ? [chip(`Engines: ${f.engines.join(', ')}`)] : []),
      chip(fitLine(f), !f.fits),
    );
    clearTimeout(this.timers.card);
    this.timers.card = window.setTimeout(() => void paintPatchCard(this.canvas, this.ev.patch(), { by: this.by.value }), this.dlg.open ? 250 : 0);
    if (!link) return;
    clearTimeout(this.timers.link);
    this.timers.link = window.setTimeout(() => void this.encode(), this.dlg.open ? 150 : 0);
  }

  private async encode(): Promise<void> {
    const mine = ++this.seq;
    const s = await encodeShare(this.ev.patch(), { layout: this.wantLayout });
    if (mine !== this.seq) return;
    this.share = s;
    this.layout.disabled = !s.layoutFits;
    this.layout.checked = s.layout;
    this.readout.classList.toggle('over', s.tooLong || (!s.layoutFits && !s.stores));
    this.readout.textContent = s.tooLong
      ? `This patch is too big for a link. Save file (.json) instead and share the file.`
      : s.stores
        ? `Over ${n(LINK_MAX)} characters as a plain link: the patch is stored on ${SITE_HOST} and the link is short. It keeps the layout.`
        : !s.layoutFits
          ? `Link: ${n(s.length)} characters, without the layout: the cards are tidied when it opens.`
          : `Link: ${n(s.length)} characters.`;
    this.copyBtn.disabled = this.postBtn.disabled = this.submitBtn.disabled = s.tooLong;
    this.fileBtn.classList.toggle('primary', s.tooLong);
  }

  /** the link for the current settings, freshly encoded (an edit may still be waiting for its timer) */
  private async current(): Promise<Share> {
    clearTimeout(this.timers.link);
    await this.encode();
    return this.share!;
  }

  private say(text: string): void {
    this.msg.textContent = text;
  }

  /** the link to hand out for the current settings (storing the patch on the site when it does not fit), or null after
   *  saying why there is none */
  private async handed(): Promise<HandedOut | null> {
    const s = await this.current();
    if (s.stores && !s.tooLong) this.say(`Storing the patch on ${SITE_HOST}\u2026`);
    try {
      return await handOut(s);
    } catch (e) {
      this.say(`${(e as Error).message}. Save the file instead.`);
      return null;
    }
  }

  private async copy(): Promise<boolean> {
    const h = await this.handed();
    if (!h) return false;
    try {
      await navigator.clipboard.writeText(h.link);
    } catch (e) {
      this.say(`The link could not be copied: ${(e as Error).message}`);
      return false;
    }
    this.say(
      h.stored
        ? `Link copied (stored on ${SITE_HOST}).`
        : h.fallback
          ? `Link copied without the layout: the site could not store the patch (${h.fallback}).`
          : `Link copied (${n(h.length)} characters${h.layout ? '' : '; the cards are tidied when it opens'}).`,
    );
    this.ev.copied(h.link);
    return true;
  }

  private async saveCard(): Promise<void> {
    try {
      await savePatchCard(this.ev.patch(), { by: this.by.value });
    } catch (e) {
      this.say(`The card could not be saved: ${(e as Error).message}`);
    }
  }

  /** the Community shelf's issue form, filled in with this patch's link (the tab opens at once so it is not blocked) */
  private async submit(): Promise<void> {
    const tab = window.open('', '_blank');
    const h = await this.handed();
    if (!h) {
      tab?.close();
      return;
    }
    if (tab) tab.location.href = submitUrl(this.ev.patch(), h.link);
    else this.say('The browser blocked the new tab: allow pop-ups to open the form.');
  }

  /** copy the link, open the submit page (while the press still counts as one, so it is not blocked), save the card */
  private async post(): Promise<void> {
    if (!(await this.copy())) return;
    window.open(redditSubmitUrl(this.ev.patch().name.trim() || 'Untitled patch'), '_blank', 'noopener');
    await this.saveCard();
    this.say('Link copied and card saved. On Reddit: drop the card in as the image, then paste the link as the first comment.');
  }
}
