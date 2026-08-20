/**
 * Drift guard for the server's owned URL prefixes, in both directions.
 *
 * Under `npm run dev` (and under PM2, which runs the UI as the Vite dev server)
 * the browser talks to :5554, so anything the API serves must be proxied to
 * :5555 — and anything the CLIENT routes must NOT be. Both mistakes fail
 * quietly, which is why they are pinned here rather than left to review:
 *
 *   - a MISSING proxy context is answered by Vite's SPA fallback with
 *     index.html and a 200, so a binary loader parses HTML and reports
 *     something unrelated to the cause (`/data/image-to-3d` was absent, and the
 *     GLB viewer died on "Unexpected token '<' ... is not valid JSON");
 *   - an OVER-BROAD context steals a page: Vite matches a plain context with a
 *     bare `url.startsWith`, so a `'/data'` key would also capture the `/data`
 *     and `/datadog` routes and hand the browser the API's built index.html.
 *
 * Production has the same hole on the other side — the SPA fallback in
 * `server/index.js` skips a request only when its path carries a file
 * extension. `SERVER_OWNED_PREFIXES` is what closes it, and the third section
 * below covers the one failure neither the proxy nor the terminator can see
 * alone: a client route added UNDER a server-owned prefix, which the terminator
 * would 404 with nothing failing near the new route.
 *
 * Full story in docs/PORTS.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { NAV_COMMANDS } from '../server/lib/navManifest.js';
import { ASSET_ROUTE_PREFIXES, SERVER_OWNED_PREFIXES } from '../server/lib/assetRoutePrefixes.js';
import { ASSET_MOUNTS } from '../server/lib/assetMounts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/**
 * Every proxy context in the dev server config.
 *
 * Read out of the source text rather than by importing the config and calling
 * it: this suite runs on the SERVER test runner, whose CI job installs only the
 * server's dependencies, so `import('../client/vite.config.js')` dies on
 * `@vitejs/plugin-react` with ERR_MODULE_NOT_FOUND (it passes locally, where
 * every workspace is installed — don't "improve" it back into an import).
 * The capture keeps a leading `^` because that character is what makes a
 * context a regex, and telling those apart is the whole point below.
 */
function devProxyContexts(source) {
  const proxyBlock = source.slice(source.indexOf('proxy: {'));
  return [...proxyBlock.matchAll(/['"](\^?\/[^'"]*)['"]\s*:\s*\{/g)].map(([, context]) => context);
}

/**
 * Vite's own matcher, mirrored from `doesProxyContextMatchUrl` — a leading `^`
 * makes the context a regex, anything else is a bare prefix test. Re-deriving
 * it here is the point: the bug this guards is a context whose match is wider
 * than it looks.
 */
const proxyMatches = (context, url) =>
  (context[0] === '^' && new RegExp(context).test(url)) || url.startsWith(context);

const navPaths = NAV_COMMANDS.map((command) => command.path);

describe('vite dev proxy vs the server and the client router', () => {
  // The mounts come from the table `server/index.js` mounts from, not from a
  // regex over its source — that table is why the two cannot disagree.
  const contexts = devProxyContexts(read('client/vite.config.js'));

  it('finds the prefixes and the proxy contexts it is comparing', () => {
    // An empty list on either side would make every assertion below vacuously
    // true — this is the one that fails if the wiring itself breaks.
    expect(ASSET_ROUTE_PREFIXES.length).toBeGreaterThan(5);
    expect(contexts).toContain('/api');
    expect(navPaths.length).toBeGreaterThan(5);
  });

  it('proxies an asset under every mount the server serves', () => {
    const unproxied = ASSET_ROUTE_PREFIXES.filter(
      (route) => !contexts.some((context) => proxyMatches(context, `${route}/probe.bin`)),
    );
    expect(unproxied).toEqual([]);
  });

  it('leaves every client route to the dev server', () => {
    const stolen = navPaths.filter(
      (path) => contexts.some((context) => proxyMatches(context, path)),
    );
    expect(stolen).toEqual([]);
  });
});

describe('the asset table vs what the server mounts', () => {
  it('has a mount, in order, for every asset route prefix', () => {
    // `ASSET_MOUNTS` is what actually gets mounted; the prefix list is what the
    // dev proxy is checked against. A route in one and not the other is drift.
    expect(ASSET_MOUNTS.map((mount) => mount.route)).toEqual(ASSET_ROUTE_PREFIXES);
    expect(ASSET_MOUNTS.every((mount) => typeof mount.dir === 'function')).toBe(true);
  });

  it('serves every asset route from inside a terminated namespace', () => {
    // A mount outside every `SERVER_OWNED_PREFIXES` entry keeps the pre-#4688
    // behaviour: an extensionless path under it answered with the SPA index.
    const prefixes = SERVER_OWNED_PREFIXES.map(({ prefix }) => prefix);
    const unterminated = ASSET_ROUTE_PREFIXES.filter(
      (route) => !prefixes.some((prefix) => route.startsWith(`${prefix}/`)),
    );
    expect(unterminated).toEqual([]);
  });
});

describe('server-owned prefixes vs the client router', () => {
  it('declares every client route that lives under a server-owned prefix', () => {
    // The failure this catches: someone adds a `/data/backups` page. The
    // terminator 404s it, the page simply does not exist, and nothing points at
    // `assetRoutePrefixes.js`. Adding the route to that entry's `spaPaths` is
    // the fix — this test is what says so.
    const undeclared = SERVER_OWNED_PREFIXES.flatMap(({ prefix, spaPaths }) => (
      navPaths.filter((path) => (
        (path === prefix || path.startsWith(`${prefix}/`)) && !spaPaths.includes(path)
      ))
    ));
    expect(undeclared).toEqual([]);
  });
});
