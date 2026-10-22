// SPDX-License-Identifier: GPL-3.0-only
// Where the app is published. The one place in the app that names the address: share.ts and community.ts build links
// from it, vite.config.ts writes it into index.html's link previews (%SITE_URL%), and site.test.ts checks that the
// GitHub Pages forwarder (deploy/github-pages-forward) points at it too.

/** the app on Cloudflare Pages (the Pages project `matryoshka`, deployed by .github/workflows/pages.yml) */
export const SITE_URL = 'https://matryoshka.pages.dev/';
/** the address before 1.0, on GitHub Pages: it now serves only the forwarder, which hands its browser data over (migrate.ts) */
export const OLD_SITE_URL = 'https://glvno.github.io/matryoshka/';
