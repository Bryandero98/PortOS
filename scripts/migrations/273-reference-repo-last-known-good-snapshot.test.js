import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './273-reference-repo-last-known-good-snapshot.js';

const roots = [];
const makeRoot = async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'migration-273-'));
  roots.push(rootDir);
  await mkdir(join(rootDir, 'data'));
  return rootDir;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migration 273', () => {
  it('initializes only legacy reference repos and preserves existing snapshots', async () => {
    const rootDir = await makeRoot();
    const appsPath = join(rootDir, 'data', 'apps.json');
    await writeFile(appsPath, JSON.stringify({
      apps: {
        app: {
          referenceRepos: [
            { id: 'legacy', name: 'Legacy' },
            { id: 'current', name: 'Current', lastKnownGoodSnapshot: { schemaVersion: 1 } },
          ],
        },
      },
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'initialized', updated: 1 });
    const data = JSON.parse(await readFile(appsPath, 'utf8'));
    expect(data.apps.app.referenceRepos).toEqual([
      { id: 'legacy', name: 'Legacy', lastKnownGoodSnapshot: null },
      { id: 'current', name: 'Current', lastKnownGoodSnapshot: { schemaVersion: 1 } },
    ]);
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'already-current', updated: 0 });
  });

  it('does not create an apps file when no registry exists', async () => {
    const rootDir = await makeRoot();
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'no-apps', updated: 0 });
  });
});
