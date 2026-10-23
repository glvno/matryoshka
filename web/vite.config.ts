import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { branchFirmware } from './dev/branch-firmware.ts';
import { lessonEditor } from './dev/lesson-editor.ts';
import { SITE_URL } from './src/site.ts';

/** the commit being built, for the About card's "Version 1.0.0-dev (062e77c)": CI's GITHUB_SHA, else git, else '' */
function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  base: './',
  // the dev server's Flash tab installs this checkout's firmware CI build (dev/branch-firmware.ts)
  // index.html's link previews name the published address (src/site.ts), never the address it is served from
  plugins: [lessonEditor(), branchFirmware(), { name: 'site-url', transformIndexHtml: { order: 'pre', handler: (html: string) => html.replaceAll('%SITE_URL%', SITE_URL) } }],
  define: { __BUILD__: JSON.stringify(buildSha()) },
  // the tutorial's built-in riff is a MIDI file, imported as bytes (`?inline`)
  assetsInclude: ['**/*.mid'],
  build: { target: 'es2022' },
  // stored share links (functions/, src/share-store.ts) in dev: `npm run api` serves them on 8788 (else storing fails and
  // the share sheet falls back to a link without the layout)
  server: { proxy: { '/api': 'http://localhost:8788' } },
  // dev/demo is its own project (the Remotion demo video, its own node_modules)
  test: { environment: 'node', exclude: ['**/node_modules/**', 'dev/demo/**'] },
} as never);
