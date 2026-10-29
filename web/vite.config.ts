import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { branchFirmware } from './dev/branch-firmware.ts';
import { lessonEditor } from './dev/lesson-editor.ts';
import { rigPage } from './dev/rig-page.ts';
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

/** the firmware version Get started > Install names (src/changelog.ts shortVersion): the bundled package's
 *  (public/firmware/matryoshka.json, replaced at each release) for a build; the dev server installs this branch's
 *  firmware build instead (dev/branch-firmware.ts), so it names the app's own version (1.3.0-dev), unless
 *  MATRYOSHKA_BUNDLED_FIRMWARE serves the bundled one */
function installVersion(command: string): string {
  const read = (f: string): string => (JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8')) as { version: string }).version;
  return command === 'serve' && !process.env.MATRYOSHKA_BUNDLED_FIRMWARE ? read('./package.json') : read('./public/firmware/matryoshka.json');
}

export default defineConfig(({ command }) => ({
  base: './',
  // the dev server's Flash tab installs this checkout's firmware CI build (dev/branch-firmware.ts)
  // index.html's link previews name the published address (src/site.ts), never the address it is served from
  // /__rig: the test rig's link for the device test mode's scripts (dev/rig-page.ts, #291)
  plugins: [lessonEditor(), branchFirmware(), rigPage(), { name: 'site-url', transformIndexHtml: { order: 'pre', handler: (html: string) => html.replaceAll('%SITE_URL%', SITE_URL) } }],
  define: { __BUILD__: JSON.stringify(buildSha()), __INSTALL_VERSION__: JSON.stringify(installVersion(command)) },
  // two pages: the app and the changelog (changelog.html, served at /changelog on Cloudflare Pages)
  build: { target: 'es2022', rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), changelog: fileURLToPath(new URL('./changelog.html', import.meta.url)) } } },
  // stored share links (functions/, src/share-store.ts) in dev: `npm run api` serves them on 8788 (else storing fails and
  // the share sheet falls back to a link without the layout)
  server: { proxy: { '/api': 'http://localhost:8788' } },
  // dev/demo is its own project (the Remotion demo video, its own node_modules)
  // testTimeout: a few tests take 3-6 s alone (the XLs, the flasher's real waits, the demo); 30 s keeps them passing
  // when golden / emulator runs share the machine (the 5 s default timed them out under load)
  test: { environment: 'node', exclude: ['**/node_modules/**', 'dev/demo/**'], testTimeout: 30000 },
}) as never);
