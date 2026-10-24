// SPDX-License-Identifier: GPL-3.0-only
// The dev server's /__rig: a blank page that loads dev/rig-client.ts, the test rig's link for scripts/rig.mjs and
// scripts/device-scenarios.mjs (#291). Dev server only; the published site has no such page.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export function rigPage(): Plugin {
  return {
    name: 'rig-page',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if ((req.url ?? '').split('?')[0] !== '/__rig') return next();
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store');
        res.end('<!doctype html><meta charset="utf-8"><title>rig</title><script type="module" src="/dev/rig-client.ts"></script>');
      });
    },
  };
}
