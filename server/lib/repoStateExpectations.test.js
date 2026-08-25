import { describe, it, expect } from 'vitest';
import {
  REPO_STATE_ISSUES,
  REPO_STATE_SKIPS,
  classifyRepoStateIssues,
  repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from './repoStateExpectations.js';
import { PR_COMPLETIONS } from './prDisposition.js';

// The shape a run that SHOULD be audited has: a successful worktree agent whose
// cleanup reported nothing and whose branch nothing else owns.
const auditable = {
  enabled: true,
  success: true,
  isWorktree: true,
  branchName: 'cos/task-abc/agent-1',
  sourceWorkspace: '/repo',
};

describe('resolveRepoStateExpectation', () => {
  it('audits a successful worktree run and expects a fully cleaned repo', () => {
    const e = resolveRepoStateExpectation({ ...auditable, prExpected: true });
    expect(e.verify).toBe(true);
    expect(e.skipReason).toBeNull();
    expect(e.expectWorktreeGone).toBe(true);
    expect(e.expectLocalBranchGone).toBe(true);
    expect(e.expectRemoteBranchGone).toBe(true);
    expect(e.expectBranchMerged).toBe(true);
    expect(e.expectPrMerged).toBe(true);
    expect(e.expectPrExists).toBe(true);
  });

  it('expects no PR when the task never asked for one', () => {
    const e = resolveRepoStateExpectation({ ...auditable, prExpected: false });
    expect(e.expectPrExists).toBe(false);
    expect(e.expectPrMerged).toBe(false);
    // The branch itself is still expected to be gone — it was merged locally.
    expect(e.expectLocalBranchGone).toBe(true);
  });

  it.each([
    ['leave-open policy', { prCompletion: PR_COMPLETIONS.LEAVE_OPEN }],
    ['human hand-off', { leaveOpen: true }],
  ])('keeps the branch but still expects the worktree gone (%s)', (_label, override) => {
    const e = resolveRepoStateExpectation({ ...auditable, prExpected: true, ...override });
    expect(e.verify).toBe(true);
    expect(e.expectWorktreeGone).toBe(true);
    expect(e.expectLocalBranchGone).toBe(false);
    expect(e.expectRemoteBranchGone).toBe(false);
    expect(e.expectBranchMerged).toBe(false);
    expect(e.expectPrMerged).toBe(false);
    // A PR was requested and must exist even when it stays open for a human.
    expect(e.expectPrExists).toBe(true);
  });

  it.each([
    [REPO_STATE_SKIPS.DISABLED, { enabled: false }],
    [REPO_STATE_SKIPS.NOT_WORKTREE, { isWorktree: false }],
    [REPO_STATE_SKIPS.PERSISTENT_WORKTREE, { isPersistentWorktree: true }],
    [REPO_STATE_SKIPS.DISCARDED_WORKTREE, { discardWorktree: true }],
    [REPO_STATE_SKIPS.FAILED_RUN, { success: false }],
    [REPO_STATE_SKIPS.CLEANUP_WARNED, { cleanupWarningCount: 1 }],
    [REPO_STATE_SKIPS.FOLLOW_UP_PENDING, { followUpPending: true }],
    [REPO_STATE_SKIPS.MISSING_CONTEXT, { branchName: null }],
    [REPO_STATE_SKIPS.MISSING_CONTEXT, { sourceWorkspace: null }],
  ])('skips with reason %s', (reason, override) => {
    const e = resolveRepoStateExpectation({ ...auditable, ...override });
    expect(e.verify).toBe(false);
    expect(e.skipReason).toBe(reason);
    // Every expect* flag is false on a skip, so a caller that ignores `verify`
    // still cannot be told to expect anything.
    expect(Object.entries(e).filter(([k]) => k.startsWith('expect')).every(([, v]) => v === false)).toBe(true);
  });

  it('reports the app switch ahead of the other gates', () => {
    // A disabled app on a run that would ALSO skip for another reason must still
    // report `verification-disabled` — that is the answer an operator is looking
    // for when they turned it off and want to confirm it took effect.
    const e = resolveRepoStateExpectation({ ...auditable, enabled: false, success: false, isWorktree: false });
    expect(e.skipReason).toBe(REPO_STATE_SKIPS.DISABLED);
  });
});

describe('classifyRepoStateIssues', () => {
  const expectation = resolveRepoStateExpectation({ ...auditable, prExpected: true });

  it('reports nothing when the repo is clean', () => {
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: false,
      localBranchPresent: false,
      remoteBranchPresent: false,
      branchMerged: null,
      prExists: true,
      prState: 'MERGED',
    });
    expect(issues).toEqual([]);
  });

  it('reports the leftover worktree, branch, remote branch and open PR', () => {
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: true,
      localBranchPresent: true,
      remoteBranchPresent: true,
      branchMerged: false,
      prExists: true,
      prState: 'OPEN',
      branchName: 'cos/task-abc/agent-1',
    });
    expect(issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.WORKTREE_PRESENT,
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      REPO_STATE_ISSUES.BRANCH_UNMERGED,
      REPO_STATE_ISSUES.PR_UNMERGED,
    ]);
    expect(issues[0].message).toContain('cos/task-abc/agent-1');
  });

  it('reports a requested PR the forge never saw', () => {
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: false,
      localBranchPresent: false,
      remoteBranchPresent: false,
      prExists: false,
      prState: null,
    });
    expect(issues.map(i => i.code)).toEqual([REPO_STATE_ISSUES.PR_MISSING]);
  });

  it('treats every unknown observation as no issue', () => {
    // This is the whole point of the tri-state: a firewalled `gh` or an
    // unreachable git must not spawn an investigation agent.
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: null,
      localBranchPresent: null,
      remoteBranchPresent: null,
      branchMerged: null,
      prExists: null,
      prState: null,
    });
    expect(issues).toEqual([]);
  });

  it('reports nothing for an expectation that was skipped', () => {
    const skipped = resolveRepoStateExpectation({ ...auditable, success: false });
    const issues = classifyRepoStateIssues(skipped, {
      worktreePresent: true,
      localBranchPresent: true,
      remoteBranchPresent: true,
      branchMerged: false,
      prExists: false,
    });
    expect(issues).toEqual([]);
  });

  it('does not report a still-open PR that was meant to stay open', () => {
    const staysOpen = resolveRepoStateExpectation({ ...auditable, prExpected: true, leaveOpen: true });
    const issues = classifyRepoStateIssues(staysOpen, {
      worktreePresent: false,
      localBranchPresent: true,
      remoteBranchPresent: true,
      prExists: true,
      prState: 'OPEN',
    });
    expect(issues).toEqual([]);
  });
});

describe('repoStateVerificationEnabled', () => {
  it('defaults to on for an unset app and for a PortOS-local task', () => {
    expect(repoStateVerificationEnabled(null)).toBe(true);
    expect(repoStateVerificationEnabled({})).toBe(true);
    expect(repoStateVerificationEnabled({ verifyRepoStateOnCompletion: true })).toBe(true);
  });

  it('is off only for an explicit false', () => {
    expect(repoStateVerificationEnabled({ verifyRepoStateOnCompletion: false })).toBe(false);
  });
});
