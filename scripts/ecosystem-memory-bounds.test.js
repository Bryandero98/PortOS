import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Every pm2 app needs BOTH memory bounds, and they have to be in the right order.
 *
 * `max_memory_restart` alone is not a memory policy — it is only the kill switch.
 * Node sizes V8's heap limit from physical memory (~4 GB on any workstation), so
 * without an explicit `--max-old-space-size` the process hits the pm2 ceiling
 * before V8 ever runs the full compacting GC that would have reclaimed the
 * garbage: the restart becomes the routine way memory is freed, and every restart
 * drops in-flight SSE streams and long jobs.
 *
 * portos-ui shipped with neither bound and was measured at 2.7 GB after 18h of
 * uptime — the regression these assertions exist to prevent.
 */
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { apps } = require(path.join(repoRoot, 'ecosystem.config.cjs'));

const UNIT_MB = { K: 1 / 1024, M: 1, G: 1024 };
const toMB = (spec) => {
  const match = String(spec).trim().match(/^(\d+(?:\.\d+)?)\s*([KMG])B?$/i);
  return match ? Number(match[1]) * UNIT_MB[match[2].toUpperCase()] : null;
};

const heapCapMB = (app) => {
  const flag = (app.node_args || []).find((a) => a.startsWith('--max-old-space-size='));
  return flag ? Number(flag.split('=')[1]) : null;
};

const APP_CASES = apps.map((app) => [app.name, app]);

// pm2 also manages python/go/docker/static apps, and `--max-old-space-size` is
// meaningless for those — scope the heap-cap assertion to the Node-interpreted
// entries so a future non-Node app doesn't force the guard to be deleted.
const NODE_APP_CASES = APP_CASES.filter(([, app]) =>
  app.interpreter === 'node' || (!app.interpreter && /\.[cm]?js$/i.test(app.script)));

describe('ecosystem.config.cjs memory bounds', () => {
  it('recognizes every app as Node-interpreted (update the filter if that changes)', () => {
    expect(NODE_APP_CASES).toHaveLength(APP_CASES.length);
  });

  it.each(APP_CASES)('%s declares a restart ceiling', (_name, app) => {
    expect(toMB(app.max_memory_restart)).toBeGreaterThan(0);
  });

  it.each(NODE_APP_CASES)('%s caps V8 below a declared restart ceiling', (_name, app) => {
    const ceiling = toMB(app.max_memory_restart);
    const cap = heapCapMB(app);
    expect(cap).toBeGreaterThan(0);
    // Strictly below, so V8 collects first and pm2 restarts only as a last resort.
    // This is also what a `Math.max(...)` floor on the cap would break: at a small
    // user-set ceiling the floor could raise the cap to or past it.
    expect(cap).toBeLessThan(ceiling);
  });

  // A heap cap must never reach the child processes these apps spawn (agent CLIs,
  // builds, media tooling) — NODE_OPTIONS is inherited by children, node_args is
  // not. server/services/pm2.js additionally strips the `node_args` key pm2
  // re-exports into the app's own environment.
  it.each(NODE_APP_CASES)('%s sets the cap via node_args, not NODE_OPTIONS', (_name, app) => {
    expect(app.env?.NODE_OPTIONS ?? '').not.toContain('max-old-space-size');
  });
});
