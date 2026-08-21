import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ execGit: vi.fn() }));

vi.mock('./execGit.js', () => ({ execGit: mocks.execGit }));

const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'not a git repository') => ({ stdout: '', stderr, exitCode: 128 });

// Real `git status --porcelain=v2 --branch` output, captured from git itself —
// the parse is pinned against the actual format rather than an invented one.
const CLEAN = [
  '# branch.oid 1234567890abcdef1234567890abcdef12345678',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  ''
].join('\n');

const DIRTY = [
  '# branch.oid 1234567890abcdef1234567890abcdef12345678',
  '# branch.head main',
  '1 .M N... 100644 100644 100644 0289925 0289925 server/index.js',
  '? scratch.txt',
  ''
].join('\n');

async function loadModule() {
  vi.resetModules();
  return import('./buildIdentity.js');
}

describe('parsePorcelainV2', () => {
  it('reads commit, short commit, and branch from the header', async () => {
    const { parsePorcelainV2 } = await loadModule();

    expect(parsePorcelainV2(CLEAN)).toEqual({
      commit: '1234567890abcdef1234567890abcdef12345678',
      shortCommit: '1234567',
      branch: 'main',
      dirty: false
    });
  });

  it('treats any non-header line as a dirty tree', async () => {
    const { parsePorcelainV2 } = await loadModule();

    expect(parsePorcelainV2(DIRTY).dirty).toBe(true);
  });

  it('maps git\'s own absent spellings to null, not to a branch or commit', async () => {
    const { parsePorcelainV2 } = await loadModule();

    // `(initial)` is a repo with no commits; `(detached)` is not a branch name.
    const initial = parsePorcelainV2('# branch.oid (initial)\n# branch.head main\n');
    expect(initial.commit).toBeNull();
    expect(initial.shortCommit).toBeNull();

    const detached = parsePorcelainV2('# branch.oid abc1234\n# branch.head (detached)\n');
    expect(detached.branch).toBeNull();
    expect(detached.commit).toBe('abc1234');
  });

  it('reports null rather than an empty string for a blank header value', async () => {
    const { parsePorcelainV2 } = await loadModule();

    // An empty-string commit would compare unequal to every real commit and
    // make the client's stale-bundle check report a permanent false mismatch.
    const parsed = parsePorcelainV2('# branch.oid \n# branch.head \n');
    expect(parsed.commit).toBeNull();
    expect(parsed.branch).toBeNull();
  });

  it('does not mistake a header-only clean tree for dirty', async () => {
    const { parsePorcelainV2 } = await loadModule();

    expect(parsePorcelainV2('# branch.oid abc1234\n# branch.head main\n\n').dirty).toBe(false);
  });
});

describe('getBuildIdentity', () => {
  beforeEach(() => {
    mocks.execGit.mockReset();
  });

  it('resolves the identity from a single git spawn', async () => {
    mocks.execGit.mockResolvedValue(ok(CLEAN));
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.commit).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(identity.shortCommit).toBe('1234567');
    expect(identity.branch).toBe('main');
    expect(identity.dirty).toBe(false);
    expect(mocks.execGit).toHaveBeenCalledTimes(1);
  });

  it('reports every field null outside a repo, and never throws', async () => {
    mocks.execGit.mockResolvedValue(fail());
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.commit).toBeNull();
    expect(identity.shortCommit).toBeNull();
    expect(identity.branch).toBeNull();
    // `null`, not `false` — "we could not tell" must stay distinguishable from
    // "we checked and the tree is clean".
    expect(identity.dirty).toBeNull();
  });

  it('survives a rejecting execGit (timeout / spawn failure) without throwing', async () => {
    mocks.execGit.mockRejectedValue(new Error('git command timed out after 5s'));
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.commit).toBeNull();
    expect(identity.dirty).toBeNull();
  });

  it('shares one spawn across concurrent first callers', async () => {
    // The boot log and an early health request can both land before the first
    // probe resolves; caching the PROMISE (not the value) keeps that to one spawn.
    mocks.execGit.mockResolvedValue(ok(CLEAN));
    const { getBuildIdentity } = await loadModule();

    const [a, b] = await Promise.all([getBuildIdentity(), getBuildIdentity()]);

    expect(mocks.execGit).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('does not re-probe git on later calls', async () => {
    mocks.execGit.mockResolvedValue(ok(CLEAN));
    const { getBuildIdentity } = await loadModule();

    await getBuildIdentity();
    await getBuildIdentity();

    expect(mocks.execGit).toHaveBeenCalledTimes(1);
  });

  it('probes with ignoreExitCode and a bounded timeout, never the 30s default', async () => {
    mocks.execGit.mockResolvedValue(ok(CLEAN));
    const { getBuildIdentity } = await loadModule();

    await getBuildIdentity();

    const [args, cwd, options] = mocks.execGit.mock.calls[0];
    expect(args).toEqual(['status', '--porcelain=v2', '--branch']);
    expect(typeof cwd).toBe('string');
    expect(cwd.trim()).not.toBe('');
    expect(options.ignoreExitCode).toBe(true);
    expect(options.timeout).toBeLessThanOrEqual(10_000);
  });

  it('never reports a path, hostname, username, or timestamp field', async () => {
    mocks.execGit.mockResolvedValue(ok(CLEAN));
    const { getBuildIdentity } = await loadModule();

    // Privacy contract: the payload rides an API response and a socket frame,
    // so its shape is pinned exactly rather than spot-checked for known-bad keys.
    expect(Object.keys(await getBuildIdentity()).sort()).toEqual(
      ['branch', 'commit', 'dirty', 'shortCommit']
    );
  });
});

describe('formatBuildIdentity', () => {
  it('renders commit, branch, and dirty state on one line', async () => {
    const { formatBuildIdentity } = await loadModule();

    expect(formatBuildIdentity({ shortCommit: 'abc1234', branch: 'main', dirty: false }))
      .toBe('abc1234 (main)');
    expect(formatBuildIdentity({ shortCommit: 'abc1234', branch: 'main', dirty: true }))
      .toBe('abc1234 (main, dirty)');
    expect(formatBuildIdentity({ shortCommit: 'abc1234', branch: null, dirty: false }))
      .toBe('abc1234 (detached)');
    expect(formatBuildIdentity({ shortCommit: 'abc1234', branch: 'main', dirty: null }))
      .toBe('abc1234 (main, cleanliness unknown)');
  });

  it('says unknown rather than printing an empty parenthetical', async () => {
    const { formatBuildIdentity } = await loadModule();

    expect(formatBuildIdentity(null)).toBe('unknown (no git metadata)');
    expect(formatBuildIdentity({ shortCommit: null, branch: null, dirty: null }))
      .toBe('unknown (no git metadata)');
  });
});

describe('getCachedBuildIdentity', () => {
  beforeEach(() => {
    mocks.execGit.mockReset();
  });

  it('is null until the probe resolves, then returns the identity', async () => {
    // The boot banner reads this synchronously — it must never block, and must
    // degrade to null rather than to a half-built tuple.
    mocks.execGit.mockResolvedValue(ok(CLEAN));
    const { getBuildIdentity, getCachedBuildIdentity } = await loadModule();

    expect(getCachedBuildIdentity()).toBeNull();

    const identity = await getBuildIdentity();

    expect(getCachedBuildIdentity()).toBe(identity);
  });

  it('caches the all-null identity too, so a non-repo does not re-probe forever', async () => {
    mocks.execGit.mockResolvedValue(fail());
    const { getBuildIdentity, getCachedBuildIdentity } = await loadModule();

    await getBuildIdentity();

    expect(getCachedBuildIdentity()).toEqual({
      commit: null, shortCommit: null, branch: null, dirty: null
    });
    await getBuildIdentity();
    expect(mocks.execGit).toHaveBeenCalledTimes(1);
  });
});
