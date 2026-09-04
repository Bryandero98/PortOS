/**
 * The reap of a verified-SUPERSEDED branch is gated on this backup, so what
 * matters is not that it wrote files but that what it wrote can bring the branch
 * back. Run against real git: the commits patch, the worktree diff and the
 * untracked copies are all git output, and a mocked `execGit` would only prove
 * the calls were made.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { backupSupersededBranch, backupSlug, backupRoot } from './supersededBackup.js';

const BRANCH = 'cos/task-x/agent-dead';

describe.skipIf(SKIP_HEAVY_INTEGRATION)('backupSupersededBranch', () => {
  let sandbox;
  let repo;
  let worktree;
  let cosDir;
  let tip;

  beforeAll(async () => {
    sandbox = await makeGitSandbox({ prefix: 'portos-superseded-backup-' });
    repo = sandbox.repo;
    worktree = join(sandbox.scratch, 'worktrees', 'agent-dead');
    cosDir = await mkdtemp(join(tmpdir(), 'portos-superseded-cos-'));

    // One commit of its own on the branch, then uncommitted work on top: the
    // shape of a CoS agent that committed once and died mid-edit.
    await execGit(['worktree', 'add', '-b', BRANCH, worktree, 'main'], repo);
    await writeFile(join(worktree, 'shipped.txt'), 'committed on the branch\n');
    await execGit(['add', '-A'], worktree);
    await execGit(['commit', '-m', 'branch commit'], worktree);
    await writeFile(join(worktree, 'initial.txt'), 'edited but never committed\n');
    await mkdir(join(worktree, 'notes'), { recursive: true });
    await writeFile(join(worktree, 'notes', 'draft.md'), '# untracked draft\n');
    tip = (await execGit(['rev-parse', BRANCH], repo)).stdout.trim();
  });

  afterAll(async () => {
    await destroyGitSandbox(sandbox.scratch);
    await rm(cosDir, { recursive: true, force: true });
  });

  it('captures the commits, the uncommitted edits and the untracked files', async () => {
    const result = await backupSupersededBranch(
      repo,
      { branch: BRANCH, tip, worktreePath: worktree, verdict: { replacedBy: ['abc123'] } },
      { defaultBranch: 'main', cosDir }
    );

    expect(result.dir).toBe(join(backupRoot(cosDir), backupSlug(BRANCH)));
    // Two branch names that kebab-case identically must not share a backup dir —
    // the second reap would overwrite the only surviving copy of the first.
    expect(backupSlug('feature/foo-bar')).not.toBe(backupSlug('feature/foo/bar'));

    // The patches' CONTENT is proven by the replay test below, which applies
    // them; here it is enough that both were written.
    expect(await stat(join(result.dir, 'commits.patch'))).toBeTruthy();
    expect(await stat(join(result.dir, 'worktree.diff'))).toBeTruthy();

    // Untracked work is COPIED, not patched — it is usually the whole deliverable
    // of an abandoned worktree, and a copy needs no tooling to read back.
    expect(await readFile(join(result.dir, 'untracked', 'notes', 'draft.md'), 'utf8'))
      .toBe('# untracked draft\n');
    expect(result.untracked).toContain(join('notes', 'draft.md'));

    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    expect(manifest).toMatchObject({ branch: BRANCH, repoPath: repo, tip, worktreePath: worktree });
    expect(manifest.verdict).toEqual({ replacedBy: ['abc123'] });
    // The ref is deleted right after this, so the tip SHA is the restore path.
    expect(manifest.restore.join('\n')).toContain(`git -C ${repo} branch ${BRANCH} ${tip}`);
  });

  it('applies its own patches back onto the default branch', async () => {
    const result = await backupSupersededBranch(
      repo,
      { branch: BRANCH, tip, worktreePath: worktree, verdict: {} },
      { defaultBranch: 'main', cosDir }
    );
    const replay = join(sandbox.scratch, 'worktrees', 'replay');
    await execGit(['worktree', 'add', '--detach', replay, 'main'], repo);
    await execGit(['am', join(result.dir, 'commits.patch')], replay);
    await execGit(['apply', join(result.dir, 'worktree.diff')], replay);

    expect(await readFile(join(replay, 'shipped.txt'), 'utf8')).toBe('committed on the branch\n');
    expect(await readFile(join(replay, 'initial.txt'), 'utf8')).toBe('edited but never committed\n');
  });

  it('writes a manifest even for a branch with nothing to capture', async () => {
    await execGit(['branch', 'empty/branch', 'main'], repo);
    const result = await backupSupersededBranch(
      repo,
      { branch: 'empty/branch', tip: null, worktreePath: null, verdict: {} },
      { defaultBranch: 'main', cosDir }
    );
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    expect(manifest.captured).toMatchObject({ commitsPatch: false, worktreeDiff: false, untrackedFiles: [] });
    expect(manifest.restore).toEqual([]);
    // No empty artifacts left beside it.
    await expect(stat(join(result.dir, 'commits.patch'))).rejects.toThrow();
  });
});
