// SPDX-License-Identifier: GPL-3.0-only
// The colour theme: light, dark or the system's (no choice stored). The choice is `data-theme` on <html>, which the
// tokens in tokens.css follow; index.html applies a stored choice before the first paint, so a reload does not flash.
export type Theme = 'light' | 'dark';

const STORE = 'matryoshka.theme';
// absent outside a browser (tests import the scope, which imports this)
const system = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

/** the stored choice, or null when the theme follows the system */
export function themeChoice(): Theme | null {
  try {
    const t = localStorage.getItem(STORE);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

/** the theme the page shows now */
export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return system?.matches ? 'dark' : 'light';
}

/** choose a theme (null = follow the system) */
export function setTheme(t: Theme | null): void {
  try {
    if (t) localStorage.setItem(STORE, t);
    else localStorage.removeItem(STORE);
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  for (const fn of listeners) fn();
}

export const toggleTheme = (): void => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

/** called whenever the shown theme may have changed (a choice, or the system's while following it); canvases redraw */
export function onThemeChange(fn: () => void): void {
  listeners.add(fn);
}

system?.addEventListener('change', () => {
  if (!themeChoice()) for (const fn of listeners) fn();
});
