import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OLD_SITE_URL, SITE_URL } from './site';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const forward = read('../../deploy/github-pages-forward/index.html');

describe('the published address', () => {
  it('the GitHub Pages forwarder points at SITE_URL, and its 404 page is the same page', () => {
    expect(read('../../deploy/github-pages-forward/404.html')).toBe(forward);
    expect(forward).toContain(`const PRODUCTION = '${SITE_URL}';`);
    // every address the page names is the new one (the canonical link and the links shown without scripts)
    const urls = [...forward.matchAll(/https:\/\/[\w.-]+\/?/g)].map((m) => m[0]);
    expect(new Set(urls)).toEqual(new Set([SITE_URL]));
    const host = new URL(SITE_URL).host;
    expect(forward).toContain(`>${host}</a>`);
  });
  it('the forwarder strips the old path prefix', () => {
    expect(forward).toContain(`replace(/^\\/${new URL(OLD_SITE_URL).pathname.split('/')[1]}\\/?/, '')`);
  });
  it("index.html's link previews take SITE_URL from vite.config.ts, not a written-out address", () => {
    const html = read('../index.html');
    expect(html).toContain('content="%SITE_URL%"');
    expect(html).not.toMatch(/https:\/\/[\w.-]+\.(github\.io|pages\.dev)/);
  });
});
