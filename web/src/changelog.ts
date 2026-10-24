// SPDX-License-Identifier: GPL-3.0-only
// The site's changelog page (changelog.html, changelog-page.ts): the released versions of the repository's CHANGELOG.md,
// read when the site is built. `## Unreleased` is left out: the site serves the newest release (pages.yml), so the page
// changes with each release. Each release has a stable anchor, `changelog#v1.2.0`, for announcing it.
import MarkdownIt from 'markdown-it';

export const REPO = 'https://github.com/glvno/matryoshka';

export interface Release {
  /** "1.2.0" */
  version: string;
  /** "2026-10-23", or '' if the heading names none */
  date: string;
  /** the section's markdown, without its heading */
  body: string;
}

/** a released version's heading: `## 1.2.0 — 2026-10-23` (an em dash, an en dash or a hyphen before the date) */
const RELEASE = /^## +v?(\d+\.\d+\.\d+)(?: +[—–-] +(\d{4}-\d{2}-\d{2}))? *$/;

/** the released versions, newest first as the file lists them; `## Unreleased` and the text before the first release are
 *  left out, and so is any other `## ` section */
export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  let cur: { version: string; date: string; lines: string[] } | null = null;
  const close = (): void => {
    if (cur) out.push({ version: cur.version, date: cur.date, body: cur.lines.join('\n').trim() });
    cur = null;
  };
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      close();
      const m = RELEASE.exec(line);
      if (m) cur = { version: m[1], date: m[2] ?? '', lines: [] };
    } else cur?.lines.push(line);
  }
  close();
  return out;
}

/** the anchor of a release on the page: "v1.2.0" */
export const releaseAnchor = (version: string): string => `v${version}`;

// raw HTML in the file stays text; markdown-it escapes text and attributes and refuses javascript: and similar links
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const t = tokens[index];
  const href = String(t.attrGet('href') ?? '');
  // a link relative to the repository (docs/…, README.md) points at the file on GitHub; other sites open in a new tab
  if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('//')) {
    t.attrSet('href', `${REPO}/blob/main/${href.replace(/^\.?\//, '')}`);
  }
  if (!String(t.attrGet('href') ?? '').startsWith('#')) {
    t.attrSet('target', '_blank');
    t.attrSet('rel', 'noopener noreferrer');
  }
  return renderer.renderToken(tokens, index, options);
};
/** a group heading's slug: "XLs: the full instruments" → "xls-the-full-instruments" */
export const slug = (text: string): string =>
  text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

interface Anchors { anchor: string; used: Set<string> }
// a heading inside a release (### On the FM-1) gets the anchor <release>-<slug>, v1.3.0-on-the-fm-1, and links to itself
markdown.renderer.rules.heading_open = (tokens, index, options, menv, renderer) => {
  const t = tokens[index], env = menv as Anchors | undefined;
  if (env?.anchor) {
    const base = `${env.anchor}-${slug(tokens[index + 1]?.content ?? '') || 'section'}`;
    let id = base;
    for (let n = 2; env.used.has(id); n++) id = `${base}-${n}`;
    env.used.add(id);
    t.attrSet('id', id);
    return `${renderer.renderToken(tokens, index, options)}<a class="cl-anchor" href="#${id}">`;
  }
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.heading_close = (tokens, index, options, env, renderer) =>
  `${(env as Anchors | undefined)?.anchor ? '</a>' : ''}${renderer.renderToken(tokens, index, options)}`;
// a table (also one inside a list item) scrolls sideways on its own on a narrow screen instead of widening the page
markdown.renderer.rules.table_open = (tokens, index, options, _env, renderer) => `<div class="cl-table">${renderer.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = (tokens, index, options, _env, renderer) => `${renderer.renderToken(tokens, index, options)}</div>`;

/** a release's notes as HTML; with the release's anchor ("v1.3.0"), its headings get anchors under it */
export const renderBody = (body: string, anchor = ''): string => markdown.render(body, { anchor, used: new Set<string>() } satisfies Anchors);
