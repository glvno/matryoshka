// SPDX-License-Identifier: GPL-3.0-only
// changelog.html: the released versions of CHANGELOG.md (changelog.ts), one section per release with the anchor
// #v1.2.0 and a button that copies the release's link, for announcing it; its group headings (### On the FM-1) have
// anchors under it, #v1.3.0-on-the-fm-1.
import changelogMd from '../../CHANGELOG.md?raw';
import { inlineWordmarks } from './brand';
import { parseChangelog, releaseAnchor, renderBody } from './changelog';

const list = document.getElementById('releases')!;
const toc = document.querySelector('.cl-toc')!;

/** the address of a release's anchor on this page, without a query or another fragment */
const linkTo = (anchor: string): string => `${location.origin}${location.pathname}#${anchor}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

for (const r of parseChangelog(changelogMd)) {
  const anchor = releaseAnchor(r.version);
  const section = el('section', 'cl-release');
  section.id = anchor;
  const head = el('div', 'cl-rhead');
  const h2 = el('h2', '');
  const self = el('a', '', `v${r.version}`);
  self.href = `#${anchor}`;
  h2.append(self);
  head.append(h2);
  if (r.date) {
    const time = el('time', '', r.date);
    time.dateTime = r.date;
    head.append(time);
  }
  const copy = el('button', 'cl-copy', 'Copy link');
  copy.type = 'button';
  copy.title = `Copy the link to v${r.version}`;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(linkTo(anchor));
      copy.textContent = 'Copied';
    } catch {
      history.replaceState(null, '', `#${anchor}`); // no clipboard: the address bar holds the link
      copy.textContent = 'In the address bar';
    }
    setTimeout(() => { copy.textContent = 'Copy link'; }, 1600);
  };
  head.append(copy);
  const body = el('div', 'cl-body');
  body.innerHTML = renderBody(r.body, anchor); // markdown-it with raw HTML off: the file's text is escaped (changelog.ts)
  section.append(head, body);
  list.append(section);

  const item = el('a', '', `v${r.version}`);
  item.href = `#${anchor}`;
  toc.append(item);
}

// the sections are made after the page loaded, so the browser has not scrolled to the address's anchor yet
const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
target?.scrollIntoView();
void inlineWordmarks();
