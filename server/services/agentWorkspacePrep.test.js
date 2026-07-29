/**
 * Tests for agentWorkspacePrep — the workspace-path + worktree/JIRA
 * provisioning extracted out of spawnAgentForTask.
 *
 * The contract these pin: the function returns a discriminated outcome
 * ('ready' | 'deferred' | 'blocked') so spawnAgentForTask can fire
 * cleanupOnError + the matching agent:deferred / agent:error event at the
 * call site (where the spawn-local dedup guard / lane / execution state
 * lives). A read-only task takes the fast path — no git pull, no worktree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue({}),
  addTask: vi.fn().mockResolvedValue({}),
  getAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn().mockResolvedValue(null) }));
vi.mock('./git.js', () => ({
  ensureLatest: vi.fn(),
  fetchOrigin: vi.fn(),
  getRepoBranches: vi.fn().mockResolvedValue({ baseBranch: 'main' }),
  checkout: vi.fn(),
  createBranch: vi.fn(),
}));
vi.mock('./taskConflict.js', () => ({ detectConflicts: vi.fn().mockResolvedValue({ recommendation: 'proceed' }) }));
vi.mock('./worktreeManager.js', () => ({ createWorktree: vi.fn(), adoptWorktree: vi.fn(), mergeBaseIntoFeatureWorktree: vi.fn() }));
vi.mock('./agentPromptBuilder.js', () => ({
  getAppWorkspace: vi.fn().mockResolvedValue('/repos/app-x'),
  getAppDataForTask: vi.fn().mockResolvedValue(null),
  createJiraTicketForTask: vi.fn(),
}));

import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { ensureLatest } from './git.js';
import { detectConflicts } from './taskConflict.js';
import { getAppWorkspace } from './agentPromptBuilder.js';
import { createWorktree, adoptWorktree } from './worktreeManager.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('prepareAgentWorkspace', () => {
  it('read-only task: returns ready with the shared workspace and skips the git pull', async () => {
    const task = { id: 't-ro', taskType: 'user', metadata: { readOnly: true } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-ro', task });
    expect(r.outcome).toBe('ready');
    expect(r.worktreeInfo).toBeNull();
    expect(r.jiraBranchName).toBeNull();
    expect(r.explicitWorktree).toBe(false);
    expect(ensureLatest).not.toHaveBeenCalled();
  });

  it('defers when the pre-task git pull hits an unresolvable conflict', async () => {
    ensureLatest.mockResolvedValue({ conflict: true, branch: 'feature/x', error: 'rebase failed' });
    const task = { id: 't-conflict', taskType: 'user', metadata: {} };
    const r = await prepareAgentWorkspace({ agentId: 'agent-c', task });
    expect(r.outcome).toBe('deferred');
    expect(r.deferReason).toBe('git-conflict');
    expect(r.branch).toBe('feature/x');
  });

  it('proceeds in the shared workspace when the pull is clean and no conflict is detected', async () => {
    ensureLatest.mockResolvedValue({ success: true, upToDate: true });
    const task = { id: 't-clean', taskType: 'user', metadata: {} };
    const r = await prepareAgentWorkspace({ agentId: 'agent-clean', task });
    expect(r.outcome).toBe('ready');
    expect(r.worktreeInfo).toBeNull();
    expect(detectConflicts).toHaveBeenCalled();
  });
});

describe('prepareAgentWorkspace — workspace validation (#3180)', () => {
  // Both shapes used to fall through to the PortOS root, so the agent did its
  // work in the PortOS checkout instead of the user's app. A blocked task the
  // user can fix beats a wrong-repo commit they have to discover later.
  it('blocks when the task names an app that resolves to no repo path', async () => {
    getAppWorkspace.mockResolvedValue(null);
    const task = { id: 't-no-path', taskType: 'user', metadata: { app: 'primes' } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-np', task });
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('primes');
    expect(r.reason).toContain('Repository Path');
  });

  it('blocks when the resolved workspace does not exist on disk', async () => {
    getAppWorkspace.mockResolvedValue('/definitely/not/a/real/repo/path');
    const task = { id: 't-missing', taskType: 'user', metadata: { app: 'primes' } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-ms', task });
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('/definitely/not/a/real/repo/path');
  });

  it('blocks when the resolved workspace is a file, not a directory', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const file = join(mkdtempSync(join(tmpdir(), 'prep-')), 'a-file.txt');
    writeFileSync(file, 'x');
    getAppWorkspace.mockResolvedValue(file);
    const task = { id: 't-file', taskType: 'user', metadata: { app: 'primes' } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-f', task });
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toContain('not a directory');
  });

  // The repoPath field accepts a literal '~/...' — the CoS path must expand it
  // the same way the /runs path does, or every task for that app is blocked.
  it('expands a ~ repoPath instead of blocking it', async () => {
    const { homedir } = await import('os');
    getAppWorkspace.mockResolvedValue('~');
    const task = { id: 't-tilde', taskType: 'user', metadata: { app: 'primes', readOnly: true } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-t', task });
    expect(r.outcome).toBe('ready');
    expect(r.workspacePath).toBe(homedir());
  });

  it('proceeds when the app resolves to a real directory', async () => {
    getAppWorkspace.mockResolvedValue(process.cwd());
    const task = { id: 't-ok', taskType: 'user', metadata: { app: 'primes', readOnly: true } };
    const r = await prepareAgentWorkspace({ agentId: 'agent-ok', task });
    expect(r.outcome).toBe('ready');
    expect(r.workspacePath).toBe(process.cwd());
  });
});

// A run killed by a server restart never reaches its completion hook, so its
// worktree survives with UNCOMMITTED work in it. The retry must pick that tree
// up instead of building a fresh one off the default branch and redoing it.
describe('prepareAgentWorkspace — resuming an interrupted run', () => {
  const DEAD_TREE = '/mock/worktrees/agent-dead';
  const resumeTask = (extra = {}) => ({
    id: 't-resume', taskType: 'user',
    metadata: {
      useWorktree: true,
      existingBranch: 'cos/t-resume/agent-dead',
      resumedFromAgentId: 'agent-dead',
      resumeWorktreePath: DEAD_TREE,
      ...extra
    }
  });

  beforeEach(() => { ensureLatest.mockResolvedValue({ success: true, upToDate: true }); });

  it('adopts the interrupted run’s worktree instead of creating a new one', async () => {
    adoptWorktree.mockResolvedValue({
      worktreePath: '/mock/worktrees/agent-new', branchName: 'cos/t-resume/agent-dead',
      baseBranch: null, existingBranch: true, adopted: true
    });

    const r = await prepareAgentWorkspace({ agentId: 'agent-new', task: resumeTask() });

    expect(adoptWorktree).toHaveBeenCalledWith('agent-new', expect.any(String), DEAD_TREE, 'cos/t-resume/agent-dead');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(r.outcome).toBe('ready');
    expect(r.worktreeInfo.adopted).toBe(true);
    expect(r.workspacePath).toBe('/mock/worktrees/agent-new');
  });

  // The tree is gone (already cleaned up) but the branch survived — attach to it,
  // which is the pre-existing resume shape.
  it('falls back to attaching the branch when the leftover tree is gone', async () => {
    adoptWorktree.mockResolvedValue(null);
    createWorktree.mockResolvedValue({
      worktreePath: '/mock/worktrees/agent-new', branchName: 'cos/t-resume/agent-dead',
      baseBranch: null, existingBranch: true
    });

    const r = await prepareAgentWorkspace({ agentId: 'agent-new', task: resumeTask() });

    expect(createWorktree).toHaveBeenCalledWith('agent-new', expect.any(String), 't-resume',
      expect.objectContaining({ existingBranch: 'cos/t-resume/agent-dead' }));
    expect(r.outcome).toBe('ready');
  });

  // Git allows a branch in only ONE worktree. If adoption failed while the stale
  // tree is still on disk holding the branch, attaching a second worktree to it
  // errors out and the task is blocked entirely — worse than starting clean.
  it('starts clean when adoption fails and the stale tree still holds the branch', async () => {
    // Any real directory stands in for the stale tree — the production check is a
    // bare `existsSync`, so `cwd` is enough and leaves nothing behind to clean up.
    const stillThere = process.cwd();
    adoptWorktree.mockResolvedValue(null);
    createWorktree.mockResolvedValue({
      worktreePath: '/mock/worktrees/agent-new', branchName: 'cos/t-resume/agent-new', baseBranch: 'main'
    });

    const r = await prepareAgentWorkspace({
      agentId: 'agent-new', task: resumeTask({ resumeWorktreePath: stillThere })
    });

    expect(createWorktree).toHaveBeenCalledWith('agent-new', expect.any(String), 't-resume',
      expect.objectContaining({ existingBranch: undefined }));
    expect(r.outcome).toBe('ready');
  });

  it('ignores a stale worktree pointer with no branch to resume', async () => {
    createWorktree.mockResolvedValue({
      worktreePath: '/mock/worktrees/agent-new', branchName: 'cos/t-resume/agent-new', baseBranch: 'main'
    });

    await prepareAgentWorkspace({
      agentId: 'agent-new', task: resumeTask({ existingBranch: undefined })
    });

    expect(adoptWorktree).not.toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalled();
  });
});
