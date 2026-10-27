// SPDX-License-Identifier: GPL-3.0-only
// The move offer at matry0shka.pages.dev, the address from 1.0 to 1.4. The app there keeps working; a visitor whose browser
// holds data there is not forwarded (site-move.ts), so a bar at the top offers to move it to matryoshka.lol in one click:
// "Move them there" opens matryoshka.lol with `?migrate=1` and hands the data over (migrate.ts sendMigration); the new tab
// merges it without replacing anything and says what came over. "Not now" or a finished move hides the bar for good at
// this address (MOVE_OFFER); the command palette's "Move to matryoshka.lol" opens it again.
import { collectKeys, MOVE_OFFER, sendMigration } from './migrate';
import { PAGES_DEV_URL, SITE_URL } from './site';

const HOST = new URL(SITE_URL).host;

/** whether this page is the app at the pages.dev address */
export const onPagesDev = (): boolean => typeof location !== 'undefined' && location.origin === new URL(PAGES_DEV_URL).origin;

const remembered = (): string | null => {
  try {
    return localStorage.getItem(MOVE_OFFER);
  } catch {
    return null;
  }
};
const remember = (v: 'later' | 'moved'): void => {
  try {
    localStorage.setItem(MOVE_OFFER, v);
  } catch {
    /* storage blocked: the bar comes back next time */
  }
};

/**
 * The bar. `saveBackup` downloads a browser backup (the way over when the browser blocks the new tab). At the pages.dev
 * address it shows by itself until dismissed or moved; `open()` shows it anyway (the command palette).
 */
export function moveOffer(saveBackup: () => void): { open: () => void } {
  let bar: HTMLElement | null = null;
  const close = (): void => {
    bar?.remove();
    bar = null;
  };
  const open = (): void => {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'move-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', `Matryoshka lives at ${HOST} now`);
    const text = document.createElement('span');
    text.setAttribute('role', 'status');
    const link = Object.assign(document.createElement('a'), { href: SITE_URL, textContent: HOST, target: '_blank', rel: 'noopener' });
    const say = (...parts: (string | Node)[]): void => text.replaceChildren(...parts);
    say('Matryoshka lives at ', link, ' now. Your patches, bank, library and settings are in this browser at this address. ');
    const button = (label: string, run: () => void, cls = ''): HTMLButtonElement =>
      Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: cls, onclick: run });
    const actions = document.createElement('span');
    actions.className = 'move-actions';
    const move = button('Move them there', () => {
      const ok = sendMigration(SITE_URL, () => collectKeys(), (state) => {
        if (state === 'sending') say(`Sending them to ${HOST}…`);
        else {
          remember('moved');
          say(`Moved: ${HOST} has them now, and this address keeps its copy. Carry on there.`);
          actions.replaceChildren(button('Close', close));
        }
      });
      if (ok) {
        say(`Opening ${HOST}…`);
        return;
      }
      say(`The browser blocked the new tab. Allow pop-ups for this site and try again, or save a backup and open it at ${HOST} with Load .json.`);
      actions.replaceChildren(button('Try again', () => move.click()), button('Save backup', saveBackup), button('×', close, 'move-close'));
    });
    const later = button('Not now', () => {
      remember('later');
      close();
    }, 'move-close');
    later.title = 'Hide this here; the command palette has "Move to matryoshka.lol"';
    actions.append(move, later);
    bar.append(text, actions);
    document.body.append(bar);
  };
  if (onPagesDev() && remembered() === null) open();
  return { open };
}
