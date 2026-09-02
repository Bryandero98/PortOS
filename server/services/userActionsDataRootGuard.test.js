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
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { recordUserAction } from './userActions.js';

const REAL_EVENTS_FILE = join(PATHS.data, 'user-action-events.json');

describe('recordUserAction — data-root guard (#5605)', () => {
  it('throws instead of writing user-action-events.json into the real data/ tree', async () => {
    // Snapshot whatever is already there BEFORE exercising the guard. An
    // install using the documented MEMORY_BACKEND=file escape hatch may
    // legitimately already have this file as its real ledger — this test
    // must prove the guard leaves it untouched, not assert it's absent (the
    // previous version's `expect(existsSync(...)).toBe(false)` failed
    // spuriously on exactly that install shape, and its unconditional
    // afterEach `rmSync` then deleted the developer's real ledger).
    const existedBefore = existsSync(REAL_EVENTS_FILE);
    const contentBefore = existedBefore ? readFileSync(REAL_EVENTS_FILE, 'utf8') : null;

    try {
      await expect(recordUserAction({
        type: 'cos.task.create',
        summary: 'Guard regression probe',
        dedupeKey: `guard-probe-${Math.random().toString(36).slice(2)}`,
      })).rejects.toThrow(/real data\/ tree/);

      // The guard must leave the real tree exactly as it found it — present
      // and unchanged, or still absent — never newly created or modified.
      expect(existsSync(REAL_EVENTS_FILE)).toBe(existedBefore);
      if (existedBefore) {
        expect(readFileSync(REAL_EVENTS_FILE, 'utf8')).toBe(contentBefore);
      }
    } finally {
      // Only clean up a file THIS run's own guard regression created — never
      // touch one that was already there before it ran (which could be a
      // developer's real MEMORY_BACKEND=file ledger).
      if (!existedBefore && existsSync(REAL_EVENTS_FILE)) {
        rmSync(REAL_EVENTS_FILE, { force: true });
      }
    }
  });
});
