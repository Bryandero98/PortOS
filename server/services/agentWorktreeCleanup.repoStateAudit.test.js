/**
 * Wiring guard: every completion path that cleans a worktree must also audit the
 * repo state afterwards.
 *
 * The audit hangs off `cleanupAgentWorktree` — the coalescing wrapper — rather
 * than off any single completion path, because the runner, the TUI `finish()`,
 * the direct-CLI spawn and the manual stop each call cleanup themselves. Moving
 * the hook back onto one caller would silently skip the others, which is exactly
 * the shape of the bug it exists to catch, so it is pinned here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cos.js', () => ({
  addTask: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn().mockResolvedValue({}),
  getAgent: vi.fn().mockResolvedValue(null),
  getAgentRecord: vi.fn().mockResolvedValue(null),
  getTaskById: vi.fn().mockResolvedValue(null),
}));
vi.mock('./git.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
  parsePullRequestUrl: vi.fn().mockReturnValue(null),
  deleteBranch: vi.fn(),
  push: vi.fn(),
  createPR: vi.fn(),
  generatePRDescription: vi.fn(),
  suggestPRTitle: vi.fn(),
  requestCopilotReview: vi.fn(),
  isBranchMergedInto: vi.fn().mockResolvedValue(true),
}));
vi.mock('./worktreeManager.js', () => ({
  removeWorktree: vi.fn().mockResolvedValue({ removed: true, warnings: [] }),
  classifyWorktreeDirt: vi.fn().mockReturnValue({ clean: true }),
}));
vi.mock('./agentRepoStateVerification.js', () => ({
  verifyAgentRepoState: vi.fn().mockResolvedValue({ verified: true, issues: [] }),
}));

import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { verifyAgentRepoState } from './agentRepoStateVerification.js';
import { getAgent, getAgentRecord } from './cos.js';

const worktreeAgent = {
  metadata: {
    isWorktree: true,
    sourceWorkspace: '/repo',
    worktreeBranch: 'cos/task-x/agent-1',
    workspacePath: '/repo/data/cos/worktrees/agent-1',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // A non-worktree agent makes the cleanup itself a no-op, so this exercises the
  // wrapper's hook rather than the teardown.
  getAgent.mockResolvedValue({ metadata: { isWorktree: false } });
  getAgentRecord.mockResolvedValue(worktreeAgent);
  verifyAgentRepoState.mockResolvedValue({ verified: true, issues: [] });
});

describe('cleanupAgentWorktree → repo-state audit', () => {
  it('audits after cleanup, carrying the task, the run verdict and the PR expectation', async () => {
    const originalTask = { id: 'task-1', metadata: { app: 'demo-app', openPR: true } };

    await cleanupAgentWorktree('agent-1', true, { originalTask });

    expect(verifyAgentRepoState).toHaveBeenCalledTimes(1);
    expect(verifyAgentRepoState).toHaveBeenCalledWith({
      agentId: 'agent-1',
      task: originalTask,
      agentState: worktreeAgent,
      success: true,
      prExpected: true,
      cleanupWarnings: [],
    });
  });

  it('audits once when two completion paths race the same agent', async () => {
    // The runner path and the spawner's `finally` safety net both call cleanup for
    // one completing agent. They coalesce onto a single run — and must therefore
    // produce a single audit, not two probes and two recovery tasks.
    const originalTask = { id: 'task-1', metadata: { openPR: false } };

    const [a, b] = await Promise.all([
      cleanupAgentWorktree('agent-1', true, { originalTask }),
      cleanupAgentWorktree('agent-1', true, { originalTask }),
    ]);

    expect(a).toEqual(b);
    expect(verifyAgentRepoState).toHaveBeenCalledTimes(1);
    expect(verifyAgentRepoState.mock.calls[0][0].prExpected).toBe(false);
  });

  it('still returns cleanup warnings when the audit itself throws', async () => {
    // The audit is an observer. A failure in it must never swallow the warnings
    // the caller uses to notify the user and spawn a merge recovery task.
    getAgent.mockResolvedValue({
      ...worktreeAgent,
      metadata: { ...worktreeAgent.metadata, isPersistentWorktree: false },
    });
    verifyAgentRepoState.mockRejectedValue(new Error('probe exploded'));

    const warnings = await cleanupAgentWorktree('agent-1', true, {
      originalTask: { id: 'task-1', metadata: {} },
    });

    expect(Array.isArray(warnings)).toBe(true);
    expect(verifyAgentRepoState).toHaveBeenCalled();
  });
});
