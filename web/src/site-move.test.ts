import { describe, expect, it } from 'vitest';
import { forwardTo } from './site-move';

describe('forwarding from the pages.dev address', () => {
  it('sends a visitor with no data on, path, query and fragment kept', () => {
    expect(forwardTo('https://matry0shka.pages.dev/', [])).toBe('https://matryoshka.lol/');
    expect(forwardTo('https://matry0shka.pages.dev/?x=1#p=abc', ['other'])).toBe('https://matryoshka.lol/?x=1#p=abc');
    expect(forwardTo('https://matry0shka.pages.dev/index.html#s=AAAAAAAAAAAA', [])).toBe('https://matryoshka.lol/index.html#s=AAAAAAAAAAAA');
  });
  it('keeps a visitor whose browser holds data there', () => {
    expect(forwardTo('https://matry0shka.pages.dev/#p=abc', ['matryoshka.patch'])).toBeNull();
    expect(forwardTo('https://matry0shka.pages.dev/', ['modular-1.theme'])).toBeNull();
  });
  it('never acts anywhere else', () => {
    for (const href of ['https://matryoshka.lol/', 'http://localhost:5173/', 'https://preview.matry0shka.pages.dev/', 'https://glvno.github.io/matryoshka/']) {
      expect(forwardTo(href, [])).toBeNull();
    }
  });
});
