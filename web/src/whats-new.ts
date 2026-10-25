// SPDX-License-Identifier: GPL-3.0-only
// What changed since the last visit: the About card links to this version's release notes, and someone who used an
// earlier version sees a card once with the main changes of the new one (a minor or major version: a patch release
// shows nothing). A first visit shows nothing; the tutorial's welcome is for them.
import { version } from '../package.json';

const REPO = 'https://github.com/glvno/matryoshka';
const SEEN = 'matryoshka.seen-version';
/** keys that only someone who used the app before has */
const USED = ['matryoshka.patch', 'matryoshka.patches', 'modular-1.patch', 'modular-1.patches'];

/** the main changes, by "major.minor"; a version without an entry shows no card */
export const HIGHLIGHTS: Record<string, string[]> = {
  '1.3': [
    'A big UI overhaul on the FM-1: paging is 6x faster, knobs answer 29x faster, and the header always shows your patch, device and page. Install the new firmware from Get started → Install firmware.',
    'Sandbox mode: a patch too big for the FM-1 plays here with no limits, and your FM-1 becomes its controller.',
    'XL patches: browser-only versions of the factory patches modeled on synths too big for the FM-1, faithful to the original architecture. In Open, each sits right under its FM-1 version.',
    'Community patches have their own section in LIBRARY.',
    'MIDI clock out (FM-1 & MIDI) keeps several FM-1s in time.',
  ],
  '1.2': [
    'One switch at the top: PATCH | EMU | LIBRARY. EMU is the FM-1 view, renamed; installing firmware is under Get started → Install firmware.',
    'LIBRARY manages what is stored: your patches, assemblies and presets, in this browser and on the FM-1, side by side. Open a patch with Open in the PATCH panel.',
    'Sequencing on the FM-1: drums on the black keys, an 8 × 16 drum grid and a piano roll on the SEQ page (SEL + a key picks the pitch); hold SEQ and press REC twice to clear a track.',
    'Every melodic factory patch has an arpeggiator (ARP) and an empty PATTERN track to fill; a new factory patch, <7PH (909 drums and an acid bass), and the first community patch, Lire + Elvira.',
    'New FM-1 firmware: quick SELECT and ALGO cards, a battery mark, and no key press lost while the screen draws. Install it from Get started; FACTORY RESET brings the new factory patches.',
  ],
};

/** "1.2" of "1.2.0" or "1.2.0-dev" */
export const minorOf = (v: string): string => v.split('-')[0].split('.').slice(0, 2).join('.');

const older = (a: string, b: string): boolean => {
  const [a1, a2] = minorOf(a).split('.').map(Number), [b1, b2] = minorOf(b).split('.').map(Number);
  return a1 !== b1 ? a1 < b1 : a2 < b2;
};

/** this version's release notes; a dev build has none yet, so the changelog on main */
export function notesUrl(v: string = version): string {
  return v.endsWith('-dev') ? `${REPO}/blob/main/CHANGELOG.md` : `${REPO}/releases/tag/v${v}`;
}

/** whether to show the card: someone who used the app before, last saw an older minor version (or none recorded:
 * versions before 1.2 kept no record), and this version has highlights */
export function shouldShow(seen: string | null, current: string, returning: boolean): boolean {
  if (!returning || !HIGHLIGHTS[minorOf(current)]) return false;
  return seen === null || older(seen, current);
}

/** read before the app writes anything, so a first visit is told apart from a returning one */
const RETURNING = ((): boolean => {
  try { return USED.some((k) => localStorage.getItem(k) !== null); } catch { return false; }
})();

/** shows the card if it is due, and records this version as seen either way; true if it showed */
export function whatsNew(): boolean {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN);
    localStorage.setItem(SEEN, version);
  } catch { return false; /* storage blocked: it could never be dismissed for good */ }
  if (!shouldShow(seen, version, RETURNING)) return false;
  const card = document.createElement('section');
  card.className = 'tutorial-offer spanel whats-new';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'whats-new-title');
  const items = HIGHLIGHTS[minorOf(version)].map((t) => `<li>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('');
  card.innerHTML = `<div class="shead"><span class="mtag mod">NEW</span><span class="stitle" id="whats-new-title">Matryoshka ${minorOf(version)}: what’s new</span></div>
    <div class="tutorial-body"><ul>${items}</ul>
    <div class="tour-actions"><button type="button" class="primary">Got it</button><a class="btn" href="${notesUrl()}" target="_blank" rel="noopener">All changes ↗</a></div></div>`;
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
  const close = (): void => { card.remove(); document.removeEventListener('keydown', onKey); };
  card.querySelector('button')!.onclick = close;
  document.body.append(card);
  document.addEventListener('keydown', onKey);
  card.querySelector('button')!.focus();
  return true;
}
