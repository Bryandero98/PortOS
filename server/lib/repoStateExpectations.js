/**
 * Post-completion repo-state expectations for CoS worktree agents.
 *
 * Cleanup (`agentWorktreeCleanup.js`) reports a warning only when a step it
 * *attempted* failed. It says nothing when a step was never attempted — an agent
 * that owned its own PR workflow and exited before `gh pr merge`, a `removeWorktree`
 * that reported success while the directory survived, a branch whose PR merged on
 * the forge while the local ref stayed behind. Those runs finish "clean" and leave
 * a branch and a worktree on disk forever.
 *
 * This module is the pure half of the audit that closes that gap: given what the
 * task ASKED for, what should the repository look like now, and which of the
 * observed facts contradict it. No git, no forge, no I/O — the probing lives in
 * `services/agentRepoStateVerification.js`, which is what makes both halves
 * testable without a repository.
 *
 * Deliberately narrow: it judges ONE agent's branch and worktree, right after that
 * agent completed. The periodic whole-repo sweep is `services/branchReconcile.js`.
 */

import { PR_COMPLETIONS } from './prDisposition.js';

/**
 * Issue codes, in the order they are reported. Each names a concrete divergence
 * from the expected end state, and each is actionable by the investigation agent.
 */
export const REPO_STATE_ISSUES = Object.freeze({
  WORKTREE_PRESENT: 'worktree-present',
  LOCAL_BRANCH_PRESENT: 'local-branch-present',
  REMOTE_BRANCH_PRESENT: 'remote-branch-present',
  BRANCH_UNMERGED: 'branch-unmerged',
  PR_UNMERGED: 'pr-unmerged',
  PR_MISSING: 'pr-missing',
});

/**
 * Why a run was not audited. Returned rather than logged so the caller can emit
 * one line and tests can assert the decision instead of the side effect.
 */
export const REPO_STATE_SKIPS = Object.freeze({
  DISABLED: 'verification-disabled',
  NOT_WORKTREE: 'not-a-worktree-run',
  PERSISTENT_WORKTREE: 'persistent-worktree',
  DISCARDED_WORKTREE: 'discarded-worktree',
  FAILED_RUN: 'failed-run',
  CLEANUP_WARNED: 'cleanup-already-warned',
  FOLLOW_UP_PENDING: 'follow-up-pending',
  MISSING_CONTEXT: 'missing-branch-or-workspace',
  // Set by the service half when every probe came back unreadable.
  PROBE_FAILED: 'probe-failed',
});

/**
 * What the repository should look like now that this agent is done.
 *
 * `verify: false` carries a `skipReason` from `REPO_STATE_SKIPS` — every
 * not-audited path is named, so "nothing happened" is never ambiguous between
 * "checked and clean" and "never checked".
 *
 * The two states worth spelling out:
 *
 * - **A failed run is never audited.** Its branch and worktree are PRESERVED on
 *   purpose (`preserveBranchWithCommits`, `resolveResumePointer`) so the task's
 *   retry resumes rather than restarts. Auditing it would report the resume
 *   pointer as a leak and spawn an agent to delete the work.
 * - **A pending review-loop / merge follow-up defers the audit.** The follow-up
 *   is the terminal actor for this branch — it merges the PR and deletes the
 *   branch — so the branch is *supposed* to still exist right now. The follow-up
 *   is itself a worktree agent, so its own completion gets audited instead.
 *
 * @param {object} params
 * @param {boolean} params.enabled - the app's `verifyRepoStateOnCompletion` setting
 * @param {boolean} params.success - the run's effective success
 * @param {boolean} params.isWorktree - agent ran in a worktree
 * @param {boolean} [params.isPersistentWorktree] - long-lived feature worktree (never torn down)
 * @param {boolean} [params.discardWorktree] - reasoning agent whose tree is thrown away unmerged
 * @param {boolean} [params.followUpPending] - a review-loop/merge follow-up owns this branch next
 * @param {number} [params.cleanupWarningCount] - warnings cleanup already raised (it spawns its own recovery)
 * @param {string} [params.prCompletion] - resolved `PR_COMPLETIONS` policy
 * @param {boolean} [params.leaveOpen] - the PR is a human's to land (JIRA hand-off)
 * @param {boolean} [params.prExpected] - a PR was requested for this branch
 * @param {string|null} [params.branchName]
 * @param {string|null} [params.sourceWorkspace]
 * @returns {{verify: boolean, skipReason: string|null, expectWorktreeGone: boolean, expectLocalBranchGone: boolean, expectRemoteBranchGone: boolean, expectBranchMerged: boolean, expectPrMerged: boolean, expectPrExists: boolean}}
 */
export function resolveRepoStateExpectation({
  enabled,
  success,
  isWorktree,
  isPersistentWorktree = false,
  discardWorktree = false,
  followUpPending = false,
  cleanupWarningCount = 0,
  prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN,
  leaveOpen = false,
  prExpected = false,
  branchName = null,
  sourceWorkspace = null,
} = {}) {
  const skip = (skipReason) => ({
    verify: false,
    skipReason,
    expectWorktreeGone: false,
    expectLocalBranchGone: false,
    expectRemoteBranchGone: false,
    expectBranchMerged: false,
    expectPrMerged: false,
    expectPrExists: false,
  });

  if (enabled === false) return skip(REPO_STATE_SKIPS.DISABLED);
  if (!isWorktree) return skip(REPO_STATE_SKIPS.NOT_WORKTREE);
  if (isPersistentWorktree) return skip(REPO_STATE_SKIPS.PERSISTENT_WORKTREE);
  if (discardWorktree) return skip(REPO_STATE_SKIPS.DISCARDED_WORKTREE);
  if (!success) return skip(REPO_STATE_SKIPS.FAILED_RUN);
  if (cleanupWarningCount > 0) return skip(REPO_STATE_SKIPS.CLEANUP_WARNED);
  if (followUpPending) return skip(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
  if (!branchName || !sourceWorkspace) return skip(REPO_STATE_SKIPS.MISSING_CONTEXT);

  // `leave-open` is a deliberate hand-off: the PR stays open and its branch must
  // stay with it, on both the local and the remote side. The worktree is still
  // expected to be gone — nothing about handing a PR to a human needs a checkout.
  const staysOpen = leaveOpen || prCompletion === PR_COMPLETIONS.LEAVE_OPEN;

  return {
    verify: true,
    skipReason: null,
    expectWorktreeGone: true,
    expectLocalBranchGone: !staysOpen,
    expectRemoteBranchGone: !staysOpen,
    expectBranchMerged: !staysOpen,
    expectPrMerged: !staysOpen && prExpected,
    // A requested PR that the forge has never heard of is a leak in its own right,
    // whatever the completion policy — the work has nowhere to land.
    expectPrExists: prExpected,
  };
}

/**
 * Which observed facts contradict the expectation.
 *
 * Every observation is tri-state on purpose (`true` / `false` / `null`): `null`
 * means "could not determine" — git unreachable, `gh` firewalled, a non-GitHub
 * forge. A `null` NEVER produces an issue. Reading "we could not ask" as "it's
 * still there" would spawn an investigation agent every time the network hiccups.
 *
 * @param {ReturnType<typeof resolveRepoStateExpectation>} expectation
 * @param {object} observed
 * @param {boolean|null} [observed.worktreePresent]
 * @param {boolean|null} [observed.localBranchPresent]
 * @param {boolean|null} [observed.remoteBranchPresent]
 * @param {boolean|null} [observed.branchMerged]
 * @param {string|null} [observed.prState] - upper-cased `MERGED` / `OPEN` / `CLOSED`, or null
 * @param {boolean|null} [observed.prExists]
 * @param {string|null} [observed.branchName]
 * @returns {Array<{code: string, message: string}>}
 */
export function classifyRepoStateIssues(expectation, observed = {}) {
  if (!expectation?.verify) return [];
  const branch = observed.branchName || expectation.branchName || 'the agent branch';
  const issues = [];

  if (expectation.expectWorktreeGone && observed.worktreePresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.WORKTREE_PRESENT,
      message: `Worktree for ${branch} still exists after cleanup reported success`,
    });
  }
  if (expectation.expectLocalBranchGone && observed.localBranchPresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      message: `Local branch ${branch} still exists after the run completed`,
    });
  }
  if (expectation.expectRemoteBranchGone && observed.remoteBranchPresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      message: `Remote branch origin/${branch} was never deleted`,
    });
  }
  if (expectation.expectBranchMerged && observed.branchMerged === false) {
    issues.push({
      code: REPO_STATE_ISSUES.BRANCH_UNMERGED,
      message: `Branch ${branch} carries commits that are not on the default branch`,
    });
  }
  if (expectation.expectPrExists && observed.prExists === false) {
    issues.push({
      code: REPO_STATE_ISSUES.PR_MISSING,
      message: `No pull request was ever opened for ${branch}, but the task asked for one`,
    });
  }
  if (expectation.expectPrMerged && observed.prState && observed.prState !== 'MERGED') {
    issues.push({
      code: REPO_STATE_ISSUES.PR_UNMERGED,
      message: `Pull request for ${branch} is ${observed.prState}, not MERGED`,
    });
  }

  return issues;
}

/**
 * True when the app's per-app setting leaves the audit on. Unset means ON: the
 * audit only ever *reports* on a run the completion path already believed was
 * finished, and an install that never hears about a leaked branch accumulates
 * them silently — the failure this exists to catch.
 *
 * @param {object|null} app - managed app record (null for a PortOS-local task)
 * @returns {boolean}
 */
export function repoStateVerificationEnabled(app) {
  return app?.verifyRepoStateOnCompletion !== false;
}
