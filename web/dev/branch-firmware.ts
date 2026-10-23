// SPDX-License-Identifier: GPL-3.0-only
// The dev server's Flash tab installs this checkout's firmware, not the package the app bundles: firmware/matryoshka.json
// and .fwsc are answered with the firmware CI build of the checked-out commit (scripts/branch-firmware.mjs: never an
// older firmware), after emu:smoke passed on it (started on the first request, about two minutes; the tab polls). The
// published site and `npm run build` are unchanged. MATRYOSHKA_BUNDLED_FIRMWARE=1 npm run dev serves the bundled one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { download, findBuild, smoke, smokeState } from '../scripts/branch-firmware.mjs';

interface Build { id?: string; headSha?: string; sha: string; branch: string; same?: boolean; dirty: boolean; error?: string }

export function branchFirmware(): Plugin {
  let memo: { at: number; build: Promise<Build> } | null = null;
  const build = (): Promise<Build> => {
    if (!memo || Date.now() - memo.at > 15_000) memo = { at: Date.now(), build: findBuild() as Promise<Build> };
    return memo.build;
  };
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  };
  const json = (res: ServerResponse, o: object): void => send(res, 200, 'application/json', JSON.stringify(o));

  return {
    name: 'branch-firmware',
    apply: 'serve',
    configureServer(server) {
      if (process.env.MATRYOSHKA_BUNDLED_FIRMWARE) return;
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url ?? '').split('?')[0];
        const isJson = path.endsWith('/firmware/matryoshka.json');
        if (!isJson && !path.endsWith('/firmware/matryoshka.fwsc')) return next();
        try {
          const b = await build();
          const label = b.id
            ? `the ${b.branch} branch's CI build (commit ${b.headSha!.slice(0, 7)}${b.same ? '' : `, the same firmware as ${b.sha.slice(0, 7)}`}, run ${b.id})` +
              (b.dirty ? '; firmware/ has uncommitted changes, which it does not have' : '')
            : '';
          if (!b.id) {
            if (isJson) return json(res, { version: '?', product: '?', size: 0, sha256: '', dev: `dev server: ${b.error}`, wait: 'Nothing to install from this branch yet (MATRYOSHKA_BUNDLED_FIRMWARE=1 npm run dev serves the bundled package).' });
            return send(res, 409, 'text/plain', b.error ?? 'no build');
          }
          const dir: string = await download(b.id);
          let state: string = smokeState(dir);
          if (state === 'none') {
            void smoke(dir, true).then((ok: boolean) => server.config.logger.info(`[branch-firmware] emu:smoke ${ok ? 'passed' : 'FAILED'} on run ${b.id} (${join(dir, 'smoke.log')})`));
            server.config.logger.info(`[branch-firmware] emu:smoke started on run ${b.id}`);
            state = 'running';
          }
          if (isJson) {
            const side = JSON.parse(readFileSync(join(dir, 'matryoshka.json'), 'utf8')) as object;
            const wait = state === 'running' ? 'emu:smoke is running on it (about two minutes); installing opens when it passes.'
              : state === 'failed' ? `emu:smoke failed on this build: nothing to install (${join(dir, 'smoke.log')}; delete smoke.failed there to run it again).`
              : undefined;
            return json(res, { ...side, dev: `dev server: ${label}`, ...(wait ? { wait } : {}) });
          }
          if (state !== 'passed') return send(res, 409, 'text/plain', 'emu:smoke has not passed on this build');
          return send(res, 200, 'application/octet-stream', readFileSync(join(dir, 'matryoshka.fwsc')));
        } catch (e) {
          if (isJson) return json(res, { version: '?', product: '?', size: 0, sha256: '', dev: `dev server: ${(e as Error).message}`, wait: 'Nothing to install.' });
          return send(res, 500, 'text/plain', (e as Error).message);
        }
      });
    },
  };
}
