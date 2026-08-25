/**
 * Tests for the post-completion repo-state audit.
 *
 * The failure this guards is the one the pure layer cannot see: cleanup returned
 * ZERO warnings, the completion path called the run a success, and the worktree
 * plus its branch are still on disk. Every case here drives the real
 * `verifyAgentRepoState` against mocked git/forge answers and asserts what it
 * files — an investigation task, or deliberately nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cos.js', () => ({
  addTask: vi.fn().mockResolvedValue({ id: 'task-recovery-1' }),
  getAllTasks: vi.fn().mockResolvedValue([]),
}));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: vi.fn().mockReturnValue([]) }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: vi.fn().mockResolvedValue([]) }));
vi.mock('./git.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  isBranchMergedInto: vi.fn().mockResolvedValue(true),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, number: null }),
  getPullRequestState: vi.fn().mockResolvedValue({ status: 'unavailable', state: null }),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn().mockResolvedValue({ id: 'demo-app', name: 'Demo App' }) }));
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

import { verifyAgentRepoState } from './agentRepoStateVerification.js';
import { addTask, getAllTasks } from './cos.js';
import { listWorktrees } from './worktreeManager.js';
import { isBranchMergedInto } from './git.js';
import { findPullRequestForBranch, getPullRequestState } from './github.js';
import { getAppById } from './apps.js';
import { addNotification } from './notifications.js';
import { readPendingMergePrs } from './prWatcher.js';
import { execGit } from '../lib/execGit.js';
import { existsSync } from 'fs';
import { REPO_STATE_ISSUES, REPO_STATE_SKIPS } from '../lib/repoStateExpectations.js';

const BRANCH = 'cos/task-x/agent-1';

const agentState = (overrides = {}) => ({
  metadata: {
    isWorktree: true,
    sourceWorkspace: '/repo',
    worktreeBranch: BRANCH,
    workspacePath: '/repo/data/cos/worktrees/agent-1',
    ...overrides,
  },
});

const task = (metadata = {}) => ({
  id: 'task-1',
  description: 'Do the thing',
  metadata: { app: 'demo-app', appName: 'Demo App', openPR: true, prCompletion: 'merge-on-green', ...metadata },
});

// `git show-ref --verify refs/heads/<branch>` is the ONLY execGit call the audit
// makes when the remote probe is off; exit 0 = branch present.
const localBranch = (present) => execGit.mockImplementation((args) => {
  if (args[0] === 'show-ref') return Promise.resolve({ exitCode: present ? 0 : 1, stdout: '', stderr: '' });
  if (args[0] === 'ls-remote') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
});

beforeEach(() => {
  vi.clearAllMocks();
  listWorktrees.mockResolvedValue([]);
  existsSync.mockReturnValue(false);
  isBranchMergedInto.mockResolvedValue(true);
  getAllTasks.mockResolvedValue([]);
  getAppById.mockResolvedValue({ id: 'demo-app', name: 'Demo App' });
  readPendingMergePrs.mockReturnValue([]);
  findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, number: null });
  getPullRequestState.mockResolvedValue({ status: 'unavailable', state: null });
  addTask.mockResolvedValue({ id: 'task-recovery-1' });
  localBranch(false);
});

describe('verifyAgentRepoState — clean runs', () => {
  it('files nothing when the worktree, branch and PR all landed', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', number: 1 });
    getPullRequestState.mockResolvedValue({ status: 'known', state: 'MERGED' });

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.verified).toBe(true);
    expect(result.issues).toEqual([]);
    expect(addTask).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
  });
});

describe('verifyAgentRepoState — divergent runs', () => {
  it('files ONE investigation task for a leftover worktree and branch after a merged PR', async () => {
    // The reported failure shape: the agent merged its own PR (branch gone on the
    // forge) but its local branch and worktree survived cleanup silently.
    listWorktrees.mockResolvedValue([{ path: '/repo/data/cos/worktrees/agent-1', branch: `refs/heads/${BRANCH}` }]);
    localBranch(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', number: 1 });
    getPullRequestState.mockResolvedValue({ status: 'known', state: 'MERGED' });

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.verified).toBe(false);
    expect(result.issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.WORKTREE_PRESENT,
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
    ]);
    expect(addTask).toHaveBeenCalledTimes(1);
    const [payload, kind] = addTask.mock.calls[0];
    expect(kind).toBe('user');
    expect(payload.description).toContain(BRANCH);
    expect(payload.isRecovery).toBe(true);
    expect(payload.app).toBe('demo-app');
    // The recovery agent must not run in a worktree of its own — it is cleaning
    // worktrees up.
    expect(payload.useWorktree).toBe(false);
    // Remediation must be actionable without re-diagnosing, and must forbid
    // deleting unmerged work or touching a sibling agent's branch.
    expect(payload.context).toContain('git worktree remove');
    expect(payload.context).toContain(`git branch -d ${BRANCH}`);
    expect(payload.context).toContain(`touch ONLY ${BRANCH}`);
    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it('reports an unmerged PR the agent left open', async () => {
    localBranch(true);
    isBranchMergedInto.mockResolvedValue(false);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/9', number: 9 });
    getPullRequestState.mockResolvedValue({ status: 'known', state: 'OPEN' });

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      REPO_STATE_ISSUES.BRANCH_UNMERGED,
      REPO_STATE_ISSUES.PR_UNMERGED,
    ]);
    expect(addTask.mock.calls[0][0].context).toContain('https://example.com/pr/9');
  });

  it('reports a requested PR the forge never saw', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, number: null });
    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });
    expect(result.issues.map(i => i.code)).toEqual([REPO_STATE_ISSUES.PR_MISSING]);
  });

  it('does not re-file when an investigation task for the branch already exists', async () => {
    listWorktrees.mockResolvedValue([{ path: '/repo/data/cos/worktrees/agent-1', branch: `refs/heads/${BRANCH}` }]);
    addTask.mockResolvedValue({ id: 'task-recovery-1', duplicate: true });

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: false,
    });

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.recoveryTaskId).toBeNull();
  });
});

describe('verifyAgentRepoState — never fires', () => {
  it('is off for an app with verifyRepoStateOnCompletion: false', async () => {
    getAppById.mockResolvedValue({ id: 'demo-app', verifyRepoStateOnCompletion: false });
    listWorktrees.mockResolvedValue([{ path: '/repo/data/cos/worktrees/agent-1', branch: `refs/heads/${BRANCH}` }]);

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.DISABLED);
    expect(addTask).not.toHaveBeenCalled();
    // The switch must short-circuit the probes too, not just the reporting.
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it('leaves a FAILED run alone so its retry can resume from the preserved branch', async () => {
    listWorktrees.mockResolvedValue([{ path: '/repo/data/cos/worktrees/agent-1', branch: `refs/heads/${BRANCH}` }]);
    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: false, prExpected: true,
    });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FAILED_RUN);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a review-loop follow-up still owns the branch', async () => {
    getAllTasks.mockResolvedValue([
      { status: 'pending', metadata: { reviewLoopPRBranch: BRANCH } },
    ]);
    listWorktrees.mockResolvedValue([{ path: '/repo/data/cos/worktrees/agent-1', branch: `refs/heads/${BRANCH}` }]);

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task({ prCompletion: 'review-then-merge' }), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while pr-watcher still holds the PR for a deterministic merge', async () => {
    // The merge-on-green GitHub path never spawns a follow-up TASK — it queues
    // the PR on the app record for the next watcher tick. Reading only the task
    // queue would call every one of those branches leaked.
    readPendingMergePrs.mockReturnValue([{ prBranch: BRANCH, prUrl: 'https://example.com/pr/2' }]);
    listWorktrees.mockResolvedValue([{ path: '/repo/data/cos/worktrees/agent-1', branch: `refs/heads/${BRANCH}` }]);

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('stands down when cleanup already raised a warning (it files its own recovery)', async () => {
    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
      cleanupWarnings: ['Auto-merge failed for branch cos/task-x/agent-1 — branch preserved for manual recovery'],
    });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.CLEANUP_WARNED);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('ignores a non-worktree run', async () => {
    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState({ isWorktree: false }), success: true,
    });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.NOT_WORKTREE);
  });

  it('files nothing when git and the forge could not be asked', async () => {
    // Everything unknown: listWorktrees rejects, show-ref throws, gh unavailable.
    // A firewalled host must not manufacture an investigation agent per run.
    listWorktrees.mockRejectedValue(new Error('not a git repository'));
    execGit.mockRejectedValue(new Error('git unavailable'));
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, number: null });

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(result.issues).toEqual([]);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not treat a GitLab remote as a missing PR', async () => {
    const { resolveForgeForRepo } = await import('./git.js');
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });

    const result = await verifyAgentRepoState({
      agentId: 'agent-1', task: task(), agentState: agentState(), success: true, prExpected: true,
    });

    expect(findPullRequestForBranch).not.toHaveBeenCalled();
    expect(result.issues).toEqual([]);
  });
});
