import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mock = vi.hoisted(() => ({
  updateDefaultBranch: vi.fn(),
  spawn: vi.fn(),
  dashboardOpen: vi.fn(),
  dashboardRunning: vi.fn(),
  dashboardHandle: { on: vi.fn() },
  restart: vi.fn(),
  syncFork: vi.fn(),
}));

vi.mock('./git.js', () => ({ updateDefaultBranch: mock.updateDefaultBranch }));
vi.mock('./pm2.js', () => ({ restartApp: mock.restart }));
vi.mock('../lib/bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, bufferedSpawnOrThrow: mock.spawn };
});
vi.mock('../lib/detachedSpawn.js', () => ({
  isDetachedRunning: mock.dashboardRunning,
  spawnDetached: mock.dashboardOpen,
}));
vi.mock('./managedAppRepositories.js', () => ({ syncManagedAppFork: mock.syncFork }));

import { updateApp } from './appUpdater.js';

describe('managed app updates', () => {
  let repo;

  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await mkdtemp(join(tmpdir(), 'portos-app-updater-'));
    await mkdir(join(repo, 'client'));
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { setup: 'example-setup' } }));
    await writeFile(join(repo, 'client', 'package.json'), JSON.stringify({}));
    mock.updateDefaultBranch.mockResolvedValue({ branch: 'main', output: 'Already up to date' });
    mock.spawn.mockResolvedValue({ stdout: '', stderr: '' });
    mock.dashboardRunning.mockResolvedValue(false);
    mock.dashboardOpen.mockResolvedValue(mock.dashboardHandle);
    mock.restart.mockResolvedValue({ success: true });
    mock.syncFork.mockResolvedValue({
      alreadyUpToDate: false,
      fullName: 'example-owner/example-app',
      source: 'example-org/example-app',
    });
  });

  afterEach(async () => {
    await Promise.all(mock.dashboardOpen.mock.calls
      .map(([, , options]) => options?.controlDir)
      .filter(Boolean)
      .map((controlDir) => rm(controlDir, { recursive: true, force: true })));
    await rm(repo, { recursive: true, force: true });
  });

  it('uses the Bun portos:update script without inheriting PortOS install or build steps', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'portos:update': 'example-update', setup: 'example-setup', build: 'vite build' } }));
    const emit = vi.fn();
    const companionRepo = join(repo, '..', 'eidoverse-video');
    const bunCommand = join(repo, 'tools with spaces', 'bun');
    const result = await updateApp({
      name: 'Eidoverse Worlds',
      type: 'bun',
      repoPath: repo,
      companionRepoPaths: [companionRepo],
      pm2ProcessNames: ['eidoverse-worlds'],
      startCommands: [`"${bunCommand}" --env-file=.env.portos server/server.ts`],
    }, emit);

    expect(result.success).toBe(true);
    expect(mock.updateDefaultBranch).toHaveBeenNthCalledWith(1, repo);
    expect(mock.updateDefaultBranch).toHaveBeenNthCalledWith(2, companionRepo);
    expect(mock.spawn).toHaveBeenCalledWith(bunCommand, ['run', 'portos:update'], expect.objectContaining({ cwd: repo }));
    expect(mock.spawn).not.toHaveBeenCalledWith('npm', expect.anything(), expect.anything());
    expect(emit).toHaveBeenCalledWith('git-pull:companion-1', 'done', 'Already up to date');
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('syncs a detected fork before pulling when the managed update requests it', async () => {
    const emit = vi.fn();
    const managed = { name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] };

    await updateApp(managed, emit, { syncFork: true });

    expect(mock.syncFork).toHaveBeenCalledWith(managed);
    expect(mock.syncFork.mock.invocationCallOrder[0]).toBeLessThan(mock.updateDefaultBranch.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith(
      'git-sync-fork',
      'done',
      'Synced example-owner/example-app from example-org/example-app',
    );
  });

  it('starts the trusted dashboard handoff before restarting PortOS', async () => {
    const emit = vi.fn();
    const managed = {
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server', 'portos-browser'],
    };

    await updateApp(managed, emit);

    expect(mock.dashboardOpen).toHaveBeenCalledWith(
      process.execPath,
      [join(repo, 'scripts/open-ui-in-browser.js')],
      expect.objectContaining({
        cwd: repo,
        cleanup: true,
        controlDir: expect.stringContaining('portos-dashboard-open'),
      }),
    );
    expect(mock.dashboardRunning).toHaveBeenCalledWith(
      expect.stringContaining('portos-dashboard-open'),
      {
        executable: process.execPath,
        args: [join(repo, 'scripts/open-ui-in-browser.js')],
      },
    );
    expect(mock.dashboardOpen.mock.invocationCallOrder[0]).toBeLessThan(mock.restart.mock.invocationCallOrder[0]);
  });

  it('does not overwrite an unreadable dashboard handoff control dir', async () => {
    const emit = vi.fn();
    mock.dashboardRunning.mockRejectedValueOnce(new Error('control dir unavailable'));
    const managed = {
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    };

    await updateApp(managed, emit);

    expect(mock.dashboardOpen).not.toHaveBeenCalled();
    expect(mock.restart).toHaveBeenCalledWith('portos-server', undefined);
  });

  it('runs an explicit update command before restarting', async () => {
    const emit = vi.fn();
    const managed = {
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      updateCommand: 'npm run update',
      pm2ProcessNames: ['portos-server'],
    };

    const result = await updateApp(managed, emit);

    expect(result.success).toBe(true);
    expect(result.steps.some((step) => step.step === 'app-update' && step.success)).toBe(true);
    expect(mock.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'update'],
      expect.objectContaining({ cwd: repo }),
    );
    const updateCall = mock.spawn.mock.invocationCallOrder[
      mock.spawn.mock.calls.findIndex((call) => call[0] === 'npm' && call[1]?.[1] === 'update')
    ];
    expect(updateCall).toBeLessThan(mock.restart.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('runs the dedicated package script when no explicit update command is configured', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'portos:update': 'vite build' } }));
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'portos:update'],
      expect.objectContaining({ cwd: repo }),
    );
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('recognizes a conventional repository update script', async () => {
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).toHaveBeenCalledWith(
      join(repo, 'update.sh'),
      [],
      expect.objectContaining({ cwd: repo }),
    );
  });

  it('defaults to checkout update and restart without guessing package lifecycle steps', async () => {
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.updateDefaultBranch).toHaveBeenCalledWith(repo);
    expect(emit).not.toHaveBeenCalledWith('app-update', expect.anything(), expect.anything());
  });

  it('refuses a disallowed update command before restarting', async () => {
    const emit = vi.fn();

    await expect(updateApp({
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      updateCommand: 'rm -rf /',
      pm2ProcessNames: ['example-app'],
    }, emit)).rejects.toThrow(/Update command is not allowed/);

    expect(mock.restart).not.toHaveBeenCalled();
  });
});
