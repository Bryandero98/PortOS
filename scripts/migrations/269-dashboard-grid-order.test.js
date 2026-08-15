import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './269-dashboard-grid-order.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 269 — convert dashboard grids to the order-only shape', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-269-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops cleanly when dashboard-layouts.json is missing (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-state');
    expect(existsSync(layoutsPath)).toBe(false);
  });

  it('replays reading order — top-to-bottom, then left-to-right — as a dense order', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [{
        id: 'default',
        name: 'Everything',
        builtIn: true,
        widgets: ['alpha', 'beta', 'gamma'],
        // Deliberately stored out of visual order: a drag commit used to hoist
        // the moved item to the front of the array.
        grid: [
          { id: 'gamma', x: 0, y: 5, w: 12, h: 3 },
          { id: 'beta', x: 6, y: 0, w: 6, h: 2 },
          { id: 'alpha', x: 0, y: 0, w: 6, h: 4 },
        ],
      }],
    });

    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);

    const grid = readJson(layoutsPath).layouts[0].grid;
    expect(grid).toEqual([
      { id: 'alpha', x: 0, w: 6, order: 0, h: 4 },
      { id: 'beta', x: 6, w: 6, order: 1, h: 2 },
      { id: 'gamma', x: 0, w: 12, order: 2, h: 3 },
    ]);
  });

  it('keeps the pinned-height flag and the fallback height', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [{
        id: 'default', name: 'Everything', builtIn: true, widgets: ['alpha'],
        grid: [{ id: 'alpha', x: 2, y: 3, w: 4, h: 7, fixedH: true }],
      }],
    });

    await migration.up({ rootDir });
    expect(readJson(layoutsPath).layouts[0].grid[0])
      .toEqual({ id: 'alpha', x: 2, w: 4, order: 0, h: 7, fixedH: true });
  });

  it('is idempotent — a converted grid is left alone on a second run', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [{
        id: 'default', name: 'Everything', builtIn: true, widgets: ['alpha', 'beta'],
        grid: [
          { id: 'alpha', x: 0, w: 6, order: 0, h: 4 },
          { id: 'beta', x: 6, w: 6, order: 1, h: 2 },
        ],
      }],
    });

    const first = await migration.up({ rootDir });
    expect(first).toEqual({ updated: 0, reason: 'already-applied' });
  });

  it('rewrites a half-converted grid so the dead `y` stops shipping', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [{
        id: 'default', name: 'Everything', builtIn: true, widgets: ['alpha', 'beta'],
        grid: [
          { id: 'alpha', x: 0, y: 0, w: 6, order: 0, h: 4 },
          { id: 'beta', x: 6, w: 6, order: 1, h: 2 },
        ],
      }],
    });

    expect((await migration.up({ rootDir })).updated).toBe(1);
    const grid = readJson(layoutsPath).layouts[0].grid;
    expect(grid.every((g) => g.y === undefined)).toBe(true);
    expect(grid.map((g) => g.order)).toEqual([0, 1]);
  });

  // The read path in `sequenceGrid` treats any grid carrying `order` as
  // new-shape. The migration has to probe the same way, or converting a file
  // would reorder it relative to how the server was already serving it.
  it('keeps a real `order` when a stale `y` disagrees with it', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [{
        id: 'default', name: 'Everything', builtIn: true, widgets: ['alpha', 'beta', 'gamma'],
        grid: [
          // y says gamma is on top; order says it is last. order wins.
          { id: 'gamma', x: 0, y: 0, w: 12, order: 2, h: 3 },
          { id: 'alpha', x: 0, y: 9, w: 6, order: 0, h: 4 },
          // No sequence of its own — appended by a legacy seeding migration.
          { id: 'beta', x: 6, y: 0, w: 6, h: 2 },
        ],
      }],
    });

    expect((await migration.up({ rootDir })).updated).toBe(1);
    const grid = readJson(layoutsPath).layouts[0].grid;
    expect(grid.map((g) => g.id)).toEqual(['alpha', 'gamma', 'beta']);
    expect(grid.map((g) => g.order)).toEqual([0, 1, 2]);
  });

  it('converts every layout in the file, and leaves empty grids alone', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'focus',
      layouts: [
        { id: 'focus', name: 'Focus', builtIn: true, widgets: ['alpha'], grid: [{ id: 'alpha', x: 0, y: 0, w: 6, h: 4 }] },
        { id: 'custom', name: 'Custom', builtIn: false, widgets: ['beta'], grid: [{ id: 'beta', x: 3, y: 2, w: 3, h: 1 }] },
        { id: 'bare', name: 'Bare', builtIn: false, widgets: ['gamma'], grid: [] },
      ],
    });

    expect((await migration.up({ rootDir })).updated).toBe(2);
    const after = readJson(layoutsPath);
    expect(after.layouts.find((l) => l.id === 'bare').grid).toEqual([]);
    expect(after.layouts.find((l) => l.id === 'custom').grid)
      .toEqual([{ id: 'beta', x: 3, w: 3, order: 0, h: 1 }]);
  });
});
