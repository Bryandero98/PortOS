/**
 * Regression coverage for the #5605 structural guard: a suite that exercises
 * a route wired to `recordUserAction` without redirecting PATHS.data to a
 * temp root must fail loudly instead of writing user-action-events.json into
 * the repo's real data/ tree (the bug class #5594 patched per-suite for
 * cos.test.js / cosTaskRoutes.test.js / cosAgentFeedback.test.js).
 *
 * Deliberately does NOT mock `../lib/fileUtils.js` — this is the one test in
 * the suite that is SUPPOSED to run with PATHS.data unredirected, so it can
 * prove the guard rejects that exact condition. If the guard regresses, this
 * would otherwise be the test that writes a real file into the repo's data/
 * tree, so it also asserts that never happens.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { recordUserAction } from './userActions.js';

const REAL_EVENTS_FILE = join(PATHS.data, 'user-action-events.json');

afterEach(() => {
  // Belt-and-suspenders: if the guard ever regresses, don't leave the leaked
  // file behind for the next run to trip over.
  rmSync(REAL_EVENTS_FILE, { force: true });
});

describe('recordUserAction — data-root guard (#5605)', () => {
  it('throws instead of writing user-action-events.json into the real data/ tree', async () => {
    await expect(recordUserAction({
      type: 'cos.task.create',
      summary: 'Guard regression probe',
      dedupeKey: `guard-probe-${Math.random().toString(36).slice(2)}`,
    })).rejects.toThrow(/real data\/ tree/);

    expect(existsSync(REAL_EVENTS_FILE)).toBe(false);
  });
});
