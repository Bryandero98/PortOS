import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './215-post-durable-memory-mastery.js';

const readJson = path => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 215 — durable POST memory mastery', () => {
  let rootDir;
  let itemsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-215-'));
    mkdirSync(join(rootDir, 'data', 'meatspace'), { recursive: true });
    itemsPath = join(rootDir, 'data', 'meatspace', 'post-memory-items.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('no-ops when the store does not exist', async () => {
    expect(await migration.up({ rootDir })).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(itemsPath)).toBe(false);
  });

  it('grandfathers stats that already clear the mastery gate', async () => {
    writeFileSync(itemsPath, JSON.stringify({ items: [{
      id: 'example',
      updatedAt: '2026-01-01T00:00:00.000Z',
      mastery: {
        chunks: {
          strong: { attempts: 3, correct: 3, recent: [1, 1, 1] },
          weak: { attempts: 3, correct: 1, recent: [1, 0, 0] },
        },
        elements: {},
      },
    }] }));

    expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
    const item = readJson(itemsPath).items[0];
    expect(item.mastery.retention).toEqual({ status: 'learning' });
    expect(item.mastery.chunks.strong).toMatchObject({
      masteredAt: '2026-01-01T00:00:00.000Z',
      masterySource: 'verified',
    });
    expect(item.mastery.chunks.weak.masteredAt).toBeUndefined();
  });

  it('is idempotent and preserves existing durable timestamps', async () => {
    writeFileSync(itemsPath, JSON.stringify({ items: [{
      id: 'example',
      mastery: {
        retention: { status: 'learning' },
        chunks: { a: { attempts: 3, correct: 3, masteredAt: '2025-01-01T00:00:00.000Z', masterySource: 'verified' } },
        elements: {},
      },
    }] }));
    expect(await migration.up({ rootDir })).toEqual({ updated: 0, reason: 'already-durable' });
    expect(readJson(itemsPath).items[0].mastery.chunks.a.masteredAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('moves a fully mastered legacy item out of routine review and schedules one audit', async () => {
    writeFileSync(itemsPath, JSON.stringify({ items: [{
      id: 'example',
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: { chunks: [{ id: 'a' }, { id: 'b' }] },
      mastery: {
        overallPct: 100,
        chunks: {
          a: { attempts: 3, correct: 3, recent: [1, 1, 1] },
          b: { attempts: 5, correct: 4, recent: [1, 1, 1, 1, 0] },
        },
        elements: {},
      },
      schedule: { ease: 2.7, intervalDays: 0, nextReview: '2026-01-01T00:00:00.000Z', lastReviewed: null },
    }] }));

    const before = Date.now();
    expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
    const after = Date.now();
    const item = readJson(itemsPath).items[0];
    expect(item.mastery.retention).toMatchObject({
      status: 'mastered',
      masteredAt: '2026-01-01T00:00:00.000Z',
      spotCheckCompletedAt: null,
    });
    const spotCheckMs = Date.parse(item.mastery.retention.spotCheckAt);
    expect(spotCheckMs).toBeGreaterThanOrEqual(before + 60 * 86400000);
    expect(spotCheckMs).toBeLessThanOrEqual(after + 60 * 86400000);
    expect(item.schedule).toMatchObject({ ease: 2.7, intervalDays: 60, nextReview: item.mastery.retention.spotCheckAt });
  });
});
