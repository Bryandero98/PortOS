import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ execGit: vi.fn() }));

vi.mock('./execGit.js', () => ({ execGit: mocks.execGit }));

const ok = (stdout) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'not a git repository') => ({ stdout: '', stderr, exitCode: 128 });

// Route each probe by its git subcommand so a test can fail one call without
// caring what order the module fires them in.
function routeGit({ head, branch, status }) {
  mocks.execGit.mockImplementation(async (args) => {
    if (args[0] === 'status') return status;
    if (args.includes('--abbrev-ref')) return branch;
    return head;
  });
}

async function loadModule() {
  vi.resetModules();
  return import('./buildIdentity.js');
}

describe('buildIdentity', () => {
  beforeEach(() => {
    mocks.execGit.mockReset();
  });

  it('reports commit, short commit, branch, and a clean tree', async () => {
    routeGit({
      head: ok('1234567890abcdef1234567890abcdef12345678\n'),
      branch: ok('main\n'),
      status: ok('')
    });
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.commit).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(identity.shortCommit).toBe('1234567');
    expect(identity.branch).toBe('main');
    expect(identity.dirty).toBe(false);
    expect(Number.isNaN(Date.parse(identity.builtAt))).toBe(false);
  });

  it('detects a dirty working tree', async () => {
    routeGit({
      head: ok('abc1234\n'),
      branch: ok('feature\n'),
      status: ok(' M server/index.js\n?? scratch.txt\n')
    });
    const { getBuildIdentity } = await loadModule();

    expect((await getBuildIdentity()).dirty).toBe(true);
  });

  it('reports every git field null outside a repo, and never throws', async () => {
    routeGit({ head: fail(), branch: fail(), status: fail() });
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.commit).toBeNull();
    expect(identity.shortCommit).toBeNull();
    expect(identity.branch).toBeNull();
    // `null`, not `false` — "we could not tell" must stay distinguishable from
    // "we checked and the tree is clean".
    expect(identity.dirty).toBeNull();
    expect(typeof identity.builtAt).toBe('string');
  });

  it('reports null (never an empty string) when git resolves but prints nothing', async () => {
    routeGit({ head: ok('   \n'), branch: ok(''), status: ok('') });
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    // An empty-string commit would compare unequal to every real commit and
    // make the client's stale-bundle check report a permanent false mismatch.
    expect(identity.commit).toBeNull();
    expect(identity.shortCommit).toBeNull();
    expect(identity.branch).toBeNull();
  });

  it('survives a rejecting execGit (timeout / spawn failure) without throwing', async () => {
    mocks.execGit.mockRejectedValue(new Error('git command timed out after 5s'));
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.commit).toBeNull();
    expect(identity.dirty).toBeNull();
  });

  it('maps a detached HEAD to a null branch rather than a branch named HEAD', async () => {
    routeGit({ head: ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'), branch: ok('HEAD\n'), status: ok('') });
    const { getBuildIdentity } = await loadModule();

    const identity = await getBuildIdentity();

    expect(identity.branch).toBeNull();
    expect(identity.commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('caches for the life of the process instead of re-probing git per call', async () => {
    routeGit({ head: ok('abc1234\n'), branch: ok('main\n'), status: ok('') });
    const { getBuildIdentity, resetBuildIdentityCache } = await loadModule();

    const first = await getBuildIdentity();
    const callsAfterFirst = mocks.execGit.mock.calls.length;
    const second = await getBuildIdentity();

    expect(second).toBe(first);
    expect(mocks.execGit.mock.calls.length).toBe(callsAfterFirst);

    // And the cache is droppable, or no suite could exercise a second shape.
    resetBuildIdentityCache();
    await getBuildIdentity();
    expect(mocks.execGit.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('probes git with ignoreExitCode and a bounded timeout, never the 30s default', async () => {
    routeGit({ head: ok('abc1234\n'), branch: ok('main\n'), status: ok('') });
    const { getBuildIdentity } = await loadModule();

    await getBuildIdentity();

    expect(mocks.execGit.mock.calls.length).toBeGreaterThan(0);
    for (const [, cwd, options] of mocks.execGit.mock.calls) {
      expect(typeof cwd).toBe('string');
      expect(cwd.trim()).not.toBe('');
      expect(options.ignoreExitCode).toBe(true);
      expect(options.timeout).toBeLessThanOrEqual(10_000);
    }
  });

  it('never reports a path, hostname, or username field', async () => {
    routeGit({ head: ok('abc1234\n'), branch: ok('main\n'), status: ok('') });
    const { getBuildIdentity } = await loadModule();

    // Privacy contract: the payload rides an API response, so its shape is
    // pinned exactly rather than merely spot-checked for known-bad keys.
    expect(Object.keys(await getBuildIdentity()).sort()).toEqual(
      ['branch', 'builtAt', 'commit', 'dirty', 'shortCommit']
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
