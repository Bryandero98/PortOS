import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { mergeAppOverride, mergeTaskConfig } from './274-merge-branch-cleanup-into-reconcile.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 274 — branch-cleanup → branch-reconcile', () => {
  let rootDir;
  let schedulePath;
  let appsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-274-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    appsPath = join(rootDir, 'data', 'apps.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('preserves enabled cleanup and fills default target pins without copying cadence', () => {
    expect(mergeTaskConfig(
      { enabled: true, providerId: 'legacy-provider', model: 'legacy-model' },
      { enabled: false, providerId: null, type: 'perpetual' }
    )).toEqual({ enabled: true, providerId: 'legacy-provider', type: 'perpetual', model: 'legacy-model' });
  });

  it('moves app enablement without copying the retired weekly cadence', () => {
    expect(mergeAppOverride(
      { enabled: true, interval: 'weekly', providerId: 'legacy-provider' },
      null
    )).toEqual({ enabled: true, providerId: 'legacy-provider' });
  });

  it('merges the global task and each app override, then removes legacy keys', async () => {
    writeJson(schedulePath, {
      version: 2,
      tasks: {
        'branch-cleanup': { enabled: true, providerId: 'legacy-provider', model: 'legacy-model', type: 'weekly' },
        'branch-reconcile': { enabled: false, type: 'perpetual', taskMetadata: { branchesPerAgent: 2 } }
      }
    });
    writeJson(appsPath, {
      apps: {
        'app-a': {
          taskTypeOverrides: {
            'branch-cleanup': { enabled: true, interval: 'weekly', providerId: 'legacy-provider' },
            'branch-reconcile': { enabled: false, taskMetadata: { branchesPerAgent: 1 } }
          }
        },
        'app-b': { taskTypeOverrides: { 'branch-cleanup': { enabled: false } } }
      }
    });

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ taskMigrated: true, migratedApps: 2, updated: 3 });

    const schedule = readJson(schedulePath);
    expect(schedule.tasks['branch-cleanup']).toBeUndefined();
    expect(schedule.tasks['branch-reconcile']).toMatchObject({
      enabled: true,
      providerId: 'legacy-provider',
      model: 'legacy-model',
      type: 'perpetual',
      taskMetadata: { branchesPerAgent: 2 }
    });

    const apps = readJson(appsPath).apps;
    expect(apps['app-a'].taskTypeOverrides['branch-cleanup']).toBeUndefined();
    expect(apps['app-a'].taskTypeOverrides['branch-reconcile']).toEqual({
      enabled: true,
      providerId: 'legacy-provider',
      taskMetadata: { branchesPerAgent: 1 }
    });
    expect(apps['app-b'].taskTypeOverrides['branch-reconcile']).toEqual({ enabled: false });
  });

  it('is idempotent when the retired keys are already gone', async () => {
    writeJson(schedulePath, { version: 2, tasks: { 'branch-reconcile': { enabled: false } } });
    writeJson(appsPath, { apps: { 'app-a': { taskTypeOverrides: { 'branch-reconcile': { enabled: false } } } } });

    expect(await migration.up({ rootDir })).toEqual({ taskMigrated: false, migratedApps: 0, updated: 0 });
  });
});
