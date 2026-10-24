// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseChangelog, releaseAnchor, renderBody, slug } from './changelog';
import { installLabel, shortVersion } from './version';

const SAMPLE = `# Changelog

Intro text with a [link](docs/x.md).

## Unreleased

- **Not out yet**

## 1.2.1 — 2026-10-23

- A fix.

## 1.2.0 – 2026-10-22

### The editor

- **Bold** item with \`code\` and a [doc](docs/CHANGELOG-pre-1.0.md):
  a continuation line.
  - nested

## Notes

- not a release
`;

const json = (rel: string): { version: string } => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version: string };

describe('parseChangelog', () => {
  it('keeps the released versions only, newest first, with their dates', () => {
    const r = parseChangelog(SAMPLE);
    expect(r.map((x) => [x.version, x.date])).toEqual([['1.2.1', '2026-10-23'], ['1.2.0', '2026-10-22']]);
    expect(r[0].body).toBe('- A fix.');
    expect(r[1].body).toContain('### The editor');
    expect(r[1].body).not.toContain('not a release');
    expect(r.some((x) => x.body.includes('Not out yet'))).toBe(false);
  });

  it('reads a heading without a date, and Windows line ends', () => {
    expect(parseChangelog('## v2.0.0\r\n\r\n- x\r\n')).toEqual([{ version: '2.0.0', date: '', body: '- x' }]);
  });

  it('reads the repository\'s CHANGELOG.md: every heading but Unreleased is a dated release', () => {
    const md = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    const r = parseChangelog(md);
    expect(r.map((x) => x.version)).toContain('1.0.0');
    for (const x of r) expect(x.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const headings = md.split('\n').filter((l) => l.startsWith('## ') && l !== '## Unreleased');
    expect(r.length).toBe(headings.length);
  });

  it('gives each release the anchor v<version>', () => {
    expect(releaseAnchor('1.3.0')).toBe('v1.3.0');
  });
});

describe('renderBody', () => {
  it('renders bold, code, nested lists and headings', () => {
    const html = renderBody(parseChangelog(SAMPLE)[1].body);
    expect(html).toContain('<h3>The editor</h3>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toMatch(/<ul>[\s\S]*<ul>\s*<li>nested<\/li>/);
  });

  it('points a link relative to the repository at GitHub, and opens links in a new tab', () => {
    const html = renderBody('[doc](docs/CHANGELOG-pre-1.0.md) [out](https://example.com/)');
    expect(html).toContain('href="https://github.com/glvno/matryoshka/blob/main/docs/CHANGELOG-pre-1.0.md" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com/" target="_blank"');
  });

  it('escapes raw HTML and refuses script links', () => {
    const html = renderBody('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;');
  });
});

// the 1.3 layout: group headings, paragraphs between them, tables nested in list items
const GROUPED = `### On the FM-1

- **Paging is faster.** For one ALGO click:

  | | 1.2 | 1.3 |
  |---|---|---|
  | The page's title on screen | about 77 ms | about 4 ms |
  | <7PH | 69 % | 61 % |

  The pixel counts are from the host panel test.
- **Second item.**

### XLs: the full instruments, in the browser

Each XL is the full version of a factory patch.

- **Oracle V XL:** the Prophet-5.

### In the editor

- One.

### In the editor

- Two.
`;

describe('a release with group headings and tables', () => {
  const html = renderBody(GROUPED, 'v1.3.0');

  it('gives each group heading the anchor <release>-<slug>, linked to itself, a repeated one numbered', () => {
    expect(html).toContain('<h3 id="v1.3.0-on-the-fm-1"><a class="cl-anchor" href="#v1.3.0-on-the-fm-1">On the FM-1</a></h3>');
    expect(html).toContain('id="v1.3.0-xls-the-full-instruments-in-the-browser"');
    expect(html).toContain('id="v1.3.0-in-the-editor"');
    expect(html).toContain('id="v1.3.0-in-the-editor-2"');
  });

  it('renders a table nested in a list item, escaped, and the paragraph after it in the same item', () => {
    const item = /<li>[\s\S]*?<\/li>/.exec(html)![0];
    expect(item).toContain('<div class="cl-table"><table>');
    expect(item).toMatch(/<th>1\.2<\/th>/);
    expect(item).toContain('<td>about 4 ms</td>');
    expect(item).toContain('<td>&lt;7PH</td>');
    expect(item).toContain('The pixel counts are from the host panel test.');
    expect(html).not.toContain('|---|');
  });

  it('keeps a plain paragraph between a heading and its list', () => {
    expect(html).toMatch(/in the browser<\/a><\/h3>\s*<p>Each XL is the full version of a factory patch\.<\/p>\s*<ul>/);
  });

  it('parses such a release out of the file whole', () => {
    const r = parseChangelog(`# Changelog\n\n## Unreleased\n\n## 1.3.0 — 2026-10-30\n\n${GROUPED}\n## 1.2.2 — 2026-10-24\n\n- x\n`);
    expect(r.map((x) => x.version)).toEqual(['1.3.0', '1.2.2']);
    expect(r[0].body).toBe(GROUPED.trim());
  });

  it('gives headings no anchor without a release', () => {
    expect(renderBody('### A b')).toBe('<h3>A b</h3>\n');
    expect(slug('Sandbox patches: Délai, <b>!')).toBe('sandbox-patches-delai-b');
  });
});

describe('the Install entry\'s version', () => {
  it('shows major.minor for a .0 release and the full version otherwise', () => {
    expect(shortVersion('v1.2.0')).toBe('v1.2');
    expect(shortVersion('1.2.0')).toBe('v1.2');
    expect(shortVersion('v1.2.1')).toBe('v1.2.1');
    expect(shortVersion('2.0.0')).toBe('v2.0');
    expect(shortVersion('1.10.0')).toBe('v1.10');
  });

  it('keeps a dev or pre-release suffix in full, and anything else as it is', () => {
    expect(shortVersion('1.3.0-dev')).toBe('v1.3.0-dev');
    expect(shortVersion('v1.3.0-rc1')).toBe('v1.3.0-rc1');
    expect(shortVersion('?')).toBe('?');
  });

  it('reads "Install v1.2", and "Install firmware" without a version', () => {
    expect(installLabel('v1.2.0')).toBe('Install v1.2');
    expect(installLabel('v1.2.1')).toBe('Install v1.2.1');
    expect(installLabel('')).toBe('Install firmware');
  });

  it('names the bundled package\'s version (a build) or the app\'s own (the dev server)', () => {
    expect([json('../public/firmware/matryoshka.json').version, json('../package.json').version]).toContain(__INSTALL_VERSION__);
  });
});
