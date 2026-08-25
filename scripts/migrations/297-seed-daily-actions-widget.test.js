import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './297-seed-daily-actions-widget.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 297 — seed daily action dashboard widget', () => {
  let rootDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-297-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    layoutsPath = join(rootDir, 'data', 'dashboard-layouts.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('does nothing on a fresh install with no persisted layouts', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
  });

  it('prepends the action widget and preserves the existing order', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        {
          id: 'default', name: 'Everything', builtIn: true,
          widgets: ['quick-brain', 'apps'],
          grid: [
            { id: 'quick-brain', x: 0, w: 3, order: 0, h: 2 },
            { id: 'apps', x: 0, w: 12, order: 1, h: 8 },
          ],
        },
        {
          id: 'morning-review', name: 'Morning Review', builtIn: true,
          widgets: ['proactive-alerts'], grid: [{ id: 'proactive-alerts', x: 0, w: 4, order: 0, h: 4 }],
        },
        {
          id: 'custom', name: 'Mine', builtIn: false,
          widgets: ['quick-brain'], grid: [{ id: 'quick-brain', x: 0, w: 12, order: 0, h: 2 }],
        },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 2 });
    const after = readJson(layoutsPath);
    const seeded = after.layouts.find((layout) => layout.id === 'default');
    expect(seeded.widgets[0]).toBe('daily-actions');
    expect(seeded.grid).toEqual([
      { id: 'daily-actions', x: 0, w: 12, order: 0, h: 4 },
      { id: 'quick-brain', x: 0, w: 3, order: 1, h: 2 },
      { id: 'apps', x: 0, w: 12, order: 2, h: 8 },
    ]);
    expect(after.layouts.find((layout) => layout.id === 'custom').widgets).toEqual(['quick-brain']);
  });

  it('is idempotent once both built-ins contain the widget', async () => {
    writeJson(layoutsPath, {
      activeLayoutId: 'default',
      layouts: [
        { id: 'default', name: 'Everything', widgets: ['daily-actions'], grid: [{ id: 'daily-actions', x: 0, w: 12, order: 0, h: 4 }] },
        { id: 'morning-review', name: 'Morning Review', widgets: ['daily-actions'], grid: [{ id: 'daily-actions', x: 0, w: 12, order: 0, h: 4 }] },
      ],
    });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });
});
