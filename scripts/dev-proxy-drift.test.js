/**
 * Drift guard for the Vite dev proxy, in both directions.
 *
 * Under `npm run dev` (and under PM2, which runs the UI as the Vite dev server)
 * the browser talks to :5554, so anything the API serves must be proxied to
 * :5555 — and anything the CLIENT routes must NOT be. Both mistakes fail
 * quietly, which is why they are pinned here rather than left to review:
 *
 *   - a MISSING mount is answered by Vite's SPA fallback with index.html and a
 *     200, so a binary loader parses HTML and reports something unrelated to
 *     the cause (`/data/image-to-3d` was absent, and the GLB viewer died on
 *     "Unexpected token '<' ... is not valid JSON", taking its route with it);
 *   - an OVER-BROAD context steals a page: Vite matches a plain context with a
 *     bare `url.startsWith`, so a `'/data'` key would also capture the `/data`
 *     and `/datadog` routes and hand the browser the API's built index.html.
 *
 * Full story in docs/PORTS.md.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { NAV_COMMANDS } from '../server/lib/navManifest.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Every `app.use('/data…', …)` mount declared by the server. */
function serverDataMounts(source) {
  return [...source.matchAll(/app\.use\(\s*'(\/data(?:\/[^']*)?)'/g)].map(([, path]) => path);
}

/**
 * The dev server's REAL proxy contexts — the config is a plain factory, so this
 * asks it rather than regexing the source. That matters: a regex over the file
 * cannot tell a plain prefix from a `^`-anchored regex key, which is exactly
 * the distinction the assertions below turn on.
 */
async function devProxyContexts() {
  const { default: defineConfigFn } = await import('../client/vite.config.js');
  const config = await defineConfigFn({ mode: 'development', command: 'serve' });
  return Object.keys(config.server.proxy);
}

/**
 * Vite's own matcher, mirrored from `doesProxyContextMatchUrl` — a leading `^`
 * makes the context a regex, anything else is a bare prefix test. Re-deriving
 * it here is the point: the bug this guards is a context whose match is wider
 * than it looks.
 */
const proxyMatches = (context, url) =>
  (context[0] === '^' && new RegExp(context).test(url)) || url.startsWith(context);

describe('vite dev proxy vs the server and the client router', () => {
  // `server/index.js` boots the app on import, so its mounts stay a source read.
  const mounts = serverDataMounts(read('server/index.js'));
  let contexts;
  beforeAll(async () => { contexts = await devProxyContexts(); });

  it('finds the mounts and the proxy contexts it is comparing', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true.
    expect(mounts.length).toBeGreaterThan(5);
    expect(contexts).toContain('/api');
  });

  it('proxies an asset under every /data mount the server serves', () => {
    const unproxied = mounts.filter(
      (mount) => !contexts.some((context) => proxyMatches(context, `${mount}/probe.bin`)),
    );
    expect(unproxied).toEqual([]);
  });

  it('leaves every client route to the dev server', () => {
    const stolen = NAV_COMMANDS
      .map((command) => command.path)
      .filter((path) => contexts.some((context) => proxyMatches(context, path)));
    expect(stolen).toEqual([]);
  });
});
