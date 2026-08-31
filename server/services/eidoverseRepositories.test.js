import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  pathExists: vi.fn(),
  execGit: vi.fn(),
  getOriginInfo: vi.fn(),
  fetchOrigin: vi.fn(),
  resolveForgeForRepo: vi.fn(),
  execGh: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pathExists: mock.pathExists,
}));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: mock.getOriginInfo }));
vi.mock('./git.js', () => ({
  execGitSafe: mock.execGit,
  fetchOrigin: mock.fetchOrigin,
  resolveForgeForRepo: mock.resolveForgeForRepo,
}));
vi.mock('./github.js', () => ({ execGh: mock.execGh }));
vi.mock('./eidoverse.js', () => ({
  DEFAULT_EIDOVERSE_WORLDS_REPO: 'https://github.com/anima-research/eidoverse-worlds',
  EIDOVERSE_PROCESS_NAME: 'eidoverse-worlds',
  EIDOVERSE_VIDEO_REPO: 'https://github.com/anima-research/eidoverse-video',
  getEidoversePaths: () => ({ video: '/example/video' }),
}));

import {
  getEidoverseRepositorySources,
  syncEidoverseWorldsFork,
} from './eidoverseRepositories.js';

const WORLDS = '/example/worlds';
const VIDEO = '/example/video';
const managedApp = {
  id: 'app-eidoverse',
  name: 'Eidoverse Worlds',
  repoPath: WORLDS,
  companionRepoPaths: [VIDEO],
  pm2ProcessNames: ['eidoverse-worlds'],
};
const HEADS = {
  [WORLDS]: '1'.repeat(40),
  [VIDEO]: '2'.repeat(40),
};
const BRANCHES = {
  [WORLDS]: 'main',
  [VIDEO]: 'prod-serving',
};

const canonicalOrigin = (repo) => ({
  hasOrigin: true,
  originUrl: `https://github.com/anima-research/${repo}.git`,
  fullName: `anima-research/${repo}`,
  isGithub: true,
  isUpstream: true,
  isFork: false,
});

describe('Eidoverse repository source management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.pathExists.mockResolvedValue(true);
    mock.fetchOrigin.mockResolvedValue(true);
    mock.resolveForgeForRepo.mockResolvedValue({ env: { GH_TOKEN: 'test-token' } });
    mock.getOriginInfo.mockImplementation(async (repoPath) => (
      repoPath === WORLDS
        ? canonicalOrigin('eidoverse-worlds')
        : canonicalOrigin('eidoverse-video')
    ));
    mock.execGit.mockImplementation(async (args, repoPath) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-list') {
        return {
          stdout: repoPath === WORLDS ? '0\t1\n' : '0\t0\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: `${BRANCHES[repoPath]}\n`, stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: `${repoPath === WORLDS ? '3'.repeat(40) : HEADS[repoPath]}\n`, stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${HEADS[repoPath]}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });
  });

  it('reports Worlds and the independently versioned Video companion without leaking checkout paths', async () => {
    const result = await getEidoverseRepositorySources(managedApp);

    expect(result).toMatchObject({
      kind: 'eidoverse',
      updateAvailable: true,
      updatePullsBoth: true,
      updateRestartsApp: true,
      sources: [
        {
          id: 'worlds',
          branch: 'main',
          shortHead: '1111111',
          localVsOrigin: { ahead: 0, behind: 1, state: 'behind' },
          origin: { fullName: 'anima-research/eidoverse-worlds', isUpstream: true },
        },
        {
          id: 'video',
          branch: 'prod-serving',
          shortHead: '2222222',
          localVsOrigin: { ahead: 0, behind: 0, state: 'current' },
          origin: { fullName: 'anima-research/eidoverse-video', isUpstream: true },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('/example/');
  });

  it('uses the canonical Video path even when another companion is registered first', async () => {
    const result = await getEidoverseRepositorySources({
      ...managedApp,
      companionRepoPaths: ['/example/other-helper', VIDEO],
    });

    expect(mock.execGit).toHaveBeenCalledWith(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      VIDEO,
      { ignoreExitCode: true },
    );
    expect(result.updatePullsBoth).toBe(true);
    expect(result.sources[1]).toMatchObject({ id: 'video', shortHead: '2222222' });
  });

  it('reports a detached checkout without comparing it to origin/HEAD', async () => {
    const normalExecGit = mock.execGit.getMockImplementation();
    mock.execGit.mockImplementation((args, repoPath) => {
      if (repoPath === WORLDS && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return Promise.resolve({ stdout: 'HEAD\n', stderr: '', exitCode: 0 });
      }
      return normalExecGit(args, repoPath);
    });

    const result = await getEidoverseRepositorySources(managedApp);

    expect(result.sources[0]).toMatchObject({ branch: null, localVsOrigin: null });
    expect(mock.execGit).not.toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'refs/remotes/origin/HEAD'],
      WORLDS,
      { ignoreExitCode: true },
    );
  });

  it('distinguishes the local-to-fork gap from the fork-to-upstream gap', async () => {
    mock.getOriginInfo.mockImplementation(async (repoPath) => (
      repoPath === WORLDS
        ? {
          hasOrigin: true,
          originUrl: 'git@github.com:example-owner/eidoverse-worlds.git',
          fullName: 'example-owner/eidoverse-worlds',
          isGithub: true,
          isUpstream: false,
          isFork: true,
        }
        : canonicalOrigin('eidoverse-video')
    ));
    mock.execGh.mockResolvedValue('{"status":"diverged","ahead":2,"behind":3}');

    const result = await getEidoverseRepositorySources(managedApp);
    const worlds = result.sources[0];

    expect(worlds.localVsOrigin).toMatchObject({ ahead: 0, behind: 1 });
    expect(worlds.forkVsUpstream).toEqual({
      available: true,
      ahead: 2,
      behind: 3,
      state: 'diverged',
      error: null,
    });
    expect(mock.execGh).toHaveBeenCalledWith(
      expect.arrayContaining([
        'repos/anima-research/eidoverse-worlds/compare/anima-research%3Amain...example-owner%3Amain',
      ]),
      60000,
      expect.objectContaining({ cwd: WORLDS }),
    );
  });

  it('keeps a failed remote refresh distinct from a confirmed current checkout', async () => {
    mock.fetchOrigin.mockRejectedValue(new Error('offline'));

    const result = await getEidoverseRepositorySources(managedApp);

    expect(result.sources[0]).toMatchObject({
      remoteFresh: false,
      remoteError: 'Could not refresh the remote repository',
    });
  });

  it('fast-forwards the Worlds fork without ever passing --force', async () => {
    mock.getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      fullName: 'example-owner/eidoverse-worlds',
      isGithub: true,
      isUpstream: false,
      isFork: true,
    });
    mock.execGh.mockResolvedValue('Synced the main branch');

    const result = await syncEidoverseWorldsFork(managedApp);

    const args = mock.execGh.mock.calls[0][0];
    expect(args).toEqual([
      'repo', 'sync', 'example-owner/eidoverse-worlds',
      '--source', 'anima-research/eidoverse-worlds',
      '--branch', 'main',
    ]);
    expect(args).not.toContain('--force');
    expect(result).toMatchObject({
      synced: true,
      fullName: 'example-owner/eidoverse-worlds',
      source: 'anima-research/eidoverse-worlds',
    });
  });

  it('fails closed when GitHub says the fork cannot be fast-forwarded', async () => {
    mock.getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      fullName: 'example-owner/eidoverse-worlds',
      isGithub: true,
      isUpstream: false,
      isFork: true,
    });
    mock.execGh.mockRejectedValue(new Error('destination would not be a fast forward'));

    await expect(syncEidoverseWorldsFork(managedApp)).rejects.toMatchObject({
      status: 409,
      code: 'FORK_DIVERGED',
    });
  });

  it('refuses the Eidoverse-only contract for an unrelated managed app', async () => {
    await expect(getEidoverseRepositorySources({
      ...managedApp,
      pm2ProcessNames: ['example-app'],
    })).rejects.toMatchObject({ status: 400, code: 'EIDOVERSE_APP_REQUIRED' });
    expect(mock.fetchOrigin).not.toHaveBeenCalled();
  });
});
