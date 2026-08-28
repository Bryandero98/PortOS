import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'idealoom-lists-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => getTempRoot() });
});

import * as lists from './idealoomLists.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

const draft = {
  prompt: 'Find small practical improvements',
  title: 'Practical improvements',
  category: 'product',
  status: 'draft',
  ideas: ['Improve the empty state', 'Add a clear keyboard shortcut']
};

describe('IdeaLoom local lists', () => {
  it('stores ordered list records separately with local-only defaults', async () => {
    expect(await lists.getSettings()).toEqual({ enabled: false, obsidianVaultId: null, autoSync: false });

    const created = await lists.createList(draft);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.schemaVersion).toBe(1);
    expect(created.ideas).toEqual(draft.ideas);

    const updated = await lists.updateList(created.id, { ideas: [...draft.ideas, 'Keep items ordered'] });
    expect(updated.ideas).toEqual([...draft.ideas, 'Keep items ordered']);
    expect((await lists.listLists()).map(({ id }) => id)).toContain(created.id);
  });

  it('updates integration settings without requiring a vault', async () => {
    expect(await lists.updateSettings({ autoSync: true })).toEqual({ enabled: false, obsidianVaultId: null, autoSync: true });
  });
});
