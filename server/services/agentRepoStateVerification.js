/**
 * Agent Repo-State Verification
 *
 * The programmatic audit that runs AFTER `cleanupAgentWorktree` and asks a
 * question cleanup cannot: is the repository actually in the state this task
 * asked for?
 *
 * Cleanup only reports what it *tried and failed* to do. A run whose steps were
 * never attempted finishes with zero warnings and still leaves debris — the case
 * this exists for is an agent that owns its own PR workflow (`ownsPrWorkflow`),
 * merges the PR itself, and exits before deleting the branch, or exits with the
 * PR still open. Cleanup stands down for exactly those runs (`skipMerge`,
 * `PR_CREATION.NEVER`), so nothing checked, and the branch plus its worktree
 * persist through every later sweep that treats "an agent owns it" as a reason
 * to skip.
 *
 * What it does NOT do: touch anything. It probes, classifies (via the pure
 * `lib/repoStateExpectations.js`), and — when the state diverges — files ONE
 * investigation task so an agent can finish the work. Deleting a branch from
 * here would be a destructive action taken on the basis of a heuristic, which is
 * precisely what `branchReconcile.js` is careful not to do either.
 *
 * Gated per managed app by `verifyRepoStateOnCompletion` (default ON).
 *
 * Concurrency: other agents legitimately hold their own worktrees and branches
 * at the same time. Every probe here is scoped to ONE branch — the one this
 * agent owned — so a live sibling agent is structurally invisible to it.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { addTask } from './cos.js';
import * as git from './git.js';
import { listWorktrees } from './worktreeManager.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/fileUtils.js';
import { isTruthyMeta } from './agentState.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';
import {
  REPO_STATE_ISSUES,
  REPO_STATE_SKIPS,
  classifyRepoStateIssues,
  repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from '../lib/repoStateExpectations.js';

// `git ls-remote` is a network round trip on a path that must never delay
// completion handling. Short and its own knob so a slow remote degrades to
// "unknown" (no issue reported) instead of stalling the cleanup chain.
const REMOTE_PROBE_TIMEOUT_MS = 10000;

/**
 * Is something ALREADY queued to land this branch?
 *
 * Two owners can hold a branch after cleanup returns, and neither is a leak:
 *
 *   1. a review-loop / merge follow-up TASK (`reviewLoopPRBranch`), which checks
 *      the branch out, drives the reviewers, and merges; and
 *   2. a pr-watcher PENDING MERGE (`pendingMergePrs` on the app record), the
 *      model-free path a merge-on-green GitHub PR takes — the next watcher tick
 *      merges it when CI is green.
 *
 * In both cases the branch is *supposed* to still exist right now. Auditing it
 * would report the thing that is about to land it as debris. The follow-up is
 * itself a worktree agent, so its own completion is what gets audited; a
 * pr-watcher merge is audited by nothing here, deliberately — pr-watcher owns
 * that PR's outcome end to end.
 *
 * @param {string} branchName
 * @param {object|null} app - the managed app record (carries `pendingMergePrs`)
 * @returns {Promise<boolean>}
 */
export async function branchHasPendingOwner(branchName, app = null) {
  if (!branchName) return false;

  const { getAllTasks } = await import('./cos.js');
  const tasks = await getAllTasks().catch(() => []);
  const claimedByFollowUp = tasks.some(t =>
    (t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked') &&
    t.metadata?.reviewLoopPRBranch === branchName
  );
  if (claimedByFollowUp) return true;

  if (!app) return false;
  const { readPendingMergePrs } = await import('./prWatcher.js');
  const pending = readPendingMergePrs(app);
  return Array.isArray(pending) && pending.some(entry => entry?.prBranch === branchName);
}

/**
 * Probe the repository for the facts the expectation is judged against.
 *
 * Every field is tri-state: `true` / `false` / `null` for "could not determine".
 * A probe that throws yields `null`, never `false` — see `classifyRepoStateIssues`
 * for why collapsing the two would spawn an investigation agent on every network
 * hiccup.
 *
 * @param {object} params
 * @param {string} params.sourceWorkspace - the parent repository
 * @param {string} params.branchName
 * @param {string|null} [params.worktreePath]
 * @param {boolean} [params.probeRemote] - run the `ls-remote` round trip
 * @param {boolean} [params.probePr] - ask the forge about this branch's PR
 * @returns {Promise<{worktreePresent: boolean|null, localBranchPresent: boolean|null, remoteBranchPresent: boolean|null, branchMerged: boolean|null, prExists: boolean|null, prState: string|null, prUrl: string|null, defaultBranch: string|null}>}
 */
export async function probeRepoState({ sourceWorkspace, branchName, worktreePath = null, probeRemote = true, probePr = true }) {
  const observed = {
    worktreePresent: null,
    localBranchPresent: null,
    remoteBranchPresent: null,
    branchMerged: null,
    prExists: null,
    prState: null,
    prUrl: null,
    defaultBranch: null,
  };

  // A worktree counts as present if git still tracks it OR the directory survived
  // on disk. Either alone is a leak: a registered-but-deleted tree wedges the next
  // `git worktree add` for that path, and an unregistered directory is the full
  // checkout `removeWorktree` believed it deleted.
  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (worktrees) {
    observed.worktreePresent = worktrees.some(wt =>
      wt.branch?.replace(/^refs\/heads\//, '') === branchName ||
      (worktreePath && wt.path === worktreePath)
    );
  }
  if (worktreePath && existsSync(worktreePath)) observed.worktreePresent = true;

  observed.localBranchPresent = await execGit(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    sourceWorkspace,
    { ignoreExitCode: true }
  ).then(r => r.exitCode === 0).catch(() => null);

  observed.defaultBranch = await git.getDefaultBranch(sourceWorkspace).catch(() => null);

  // Only meaningful while the branch still exists locally — a deleted branch has
  // no ref to compare, and `isBranchMergedInto` answers `false` for a missing ref,
  // which would read as "unmerged work" for the successful case.
  if (observed.localBranchPresent === true && observed.defaultBranch) {
    observed.branchMerged = await git
      .isBranchMergedInto(sourceWorkspace, branchName, observed.defaultBranch)
      .catch(() => null);
  }

  if (probeRemote) {
    observed.remoteBranchPresent = await execGit(
      ['ls-remote', '--heads', 'origin', `refs/heads/${branchName}`],
      sourceWorkspace,
      { ignoreExitCode: true, timeout: REMOTE_PROBE_TIMEOUT_MS }
    ).then(r => (r.exitCode === 0 ? r.stdout.trim() !== '' : null)).catch(() => null);
  }

  if (probePr) {
    const { findPullRequestForBranch, getPullRequestState } = await import('./github.js');
    const { cli, env } = await git.resolveForgeForRepo(sourceWorkspace).catch(() => ({ cli: 'gh', env: null }));
    // GitHub only. `gh pr view` against a GitLab MR answers nothing useful, and a
    // wrong answer here is worse than no answer — leave both fields `null` so the
    // PR expectations simply do not fire on a GitLab remote.
    if (cli === 'gh') {
      const found = await findPullRequestForBranch(branchName, { cwd: sourceWorkspace, env: env || null })
        .catch(() => ({ status: 'unavailable' }));
      if (found.status === 'found') {
        observed.prExists = true;
        observed.prUrl = found.url || null;
        const state = await getPullRequestState(found.url || found.number, { cwd: sourceWorkspace, env: env || null })
          .catch(() => ({ status: 'unavailable' }));
        if (state.status === 'known') observed.prState = state.state;
      } else if (found.status === 'none') {
        observed.prExists = false;
      }
    }
  }

  return observed;
}

/**
 * Verify one completed worktree agent left the repository as its task asked, and
 * file an investigation task when it did not.
 *
 * Never throws: this runs at the tail of completion handling, where a throw would
 * strand the very cleanup it is auditing. Failures are logged and swallowed.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {object} params.task - the CoS task
 * @param {object|null} params.agentState - persisted agent record (worktree metadata)
 * @param {boolean} params.success - effective success of the run
 * @param {boolean} [params.prExpected] - the task asked for a PR (`openPR`)
 * @param {string[]} [params.cleanupWarnings] - warnings cleanup already raised
 * @returns {Promise<{verified: boolean, skipReason: string|null, issues: Array<{code: string, message: string}>, observed: object|null, recoveryTaskId: string|null}>}
 */
export async function verifyAgentRepoState({ agentId, task, agentState, success, prExpected = false, cleanupWarnings = [] }) {
  const metadata = agentState?.metadata || {};
  const branchName = metadata.worktreeBranch || null;
  const sourceWorkspace = metadata.sourceWorkspace || null;
  const appId = task?.metadata?.app || null;

  // Read the app record BEFORE the cheap structural gates so a disabled app is
  // reported as `verification-disabled` rather than as whatever gate happens to
  // fire first — the setting is the answer the operator is looking for. The record
  // is also what carries pr-watcher's pending-merge queue.
  const app = appId ? await (await import('./apps.js')).getAppById(appId).catch(() => null) : null;
  const enabled = repoStateVerificationEnabled(app);

  // Only worth asking for a run that could actually be audited — this reads the
  // whole task list plus the app's pending-merge queue.
  const followUpPending = enabled && success && branchName && metadata.isWorktree === true
    ? await branchHasPendingOwner(branchName, app).catch(() => false)
    : false;

  const expectation = resolveRepoStateExpectation({
    enabled,
    success,
    isWorktree: metadata.isWorktree === true,
    isPersistentWorktree: metadata.isPersistentWorktree === true,
    discardWorktree: isTruthyMeta(task?.metadata?.discardWorktree),
    followUpPending,
    cleanupWarningCount: cleanupWarnings?.length || 0,
    prCompletion: resolvePrCompletion(task?.metadata),
    leaveOpen: leavesPrForHuman(task),
    prExpected,
    branchName,
    sourceWorkspace,
  });

  if (!expectation.verify) {
    return { verified: false, skipReason: expectation.skipReason, issues: [], observed: null, recoveryTaskId: null };
  }

  const worktreePath = metadata.workspacePath || join(PATHS.worktrees, agentId);
  const observed = await probeRepoState({
    sourceWorkspace,
    branchName,
    worktreePath,
    probeRemote: expectation.expectRemoteBranchGone,
    probePr: expectation.expectPrExists || expectation.expectPrMerged,
  }).catch(err => {
    emitLog('warn', `🔎 Repo-state probe failed for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  if (!observed) {
    return { verified: false, skipReason: REPO_STATE_SKIPS.PROBE_FAILED, issues: [], observed: null, recoveryTaskId: null };
  }

  const issues = classifyRepoStateIssues(expectation, { ...observed, branchName });
  if (issues.length === 0) {
    emitLog('info', `🔎 Repo state verified clean for ${agentId} (${branchName})`, { agentId, branchName });
    return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
  }

  emitLog('warn', `🔎 Repo state diverged after ${agentId}: ${issues.map(i => i.code).join(', ')}`, { agentId, branchName, taskId: task?.id });

  const recoveryTaskId = await fileRepoStateInvestigation({
    agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId,
  }).catch(err => {
    emitLog('warn', `Failed to file repo-state investigation for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  await notifyRepoStateDivergence({ agentId, task, branchName, issues, appId }).catch(() => {});

  return { verified: false, skipReason: null, issues, observed, recoveryTaskId };
}

/**
 * The remediation step for each issue code, as an instruction the investigation
 * agent can follow without re-deriving the diagnosis. Kept beside the codes so a
 * new check cannot ship without saying what to do about it.
 */
function remediationFor(code, { branchName, defaultBranch, prUrl, worktreePath }) {
  const base = defaultBranch || 'the default branch';
  switch (code) {
    case REPO_STATE_ISSUES.WORKTREE_PRESENT:
      return `Remove the leftover worktree: confirm it is clean ("git -C ${worktreePath} status --porcelain"), commit or discard anything found, then "git worktree remove ${worktreePath}" and "git worktree prune".`;
    case REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT:
      return `Delete the local branch once its work is on ${base}: "git branch -d ${branchName}" (use -D only after confirming the commits landed).`;
    case REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT:
      return `Delete the remote branch after confirming its work merged: "git push origin --delete ${branchName}".`;
    case REPO_STATE_ISSUES.BRANCH_UNMERGED:
      return `The branch has commits that are NOT on ${base}. Decide whether they are wanted: land them (open/merge a PR, or merge locally and resolve conflicts) before deleting anything. Do NOT delete this branch until its work is on ${base}.`;
    case REPO_STATE_ISSUES.PR_MISSING:
      return `The task asked for a pull request but the forge has none for ${branchName}. Open one against ${base}, then drive it to merge.`;
    case REPO_STATE_ISSUES.PR_UNMERGED:
      return `Finish the pull request${prUrl ? ` ${prUrl}` : ''}: fix failing checks, resolve review threads, then merge it ("gh pr merge --merge --delete-branch").`;
    default:
      return `Investigate and resolve: ${code}.`;
  }
}

/**
 * File ONE investigation task covering every issue found for this branch.
 *
 * Dedup rides on `addTask`'s first-line + app matching: the description names the
 * branch, so a re-run of the same audit joins the existing task rather than
 * stacking a second one.
 *
 * @returns {Promise<string|null>} the task id, or null when the task was a duplicate
 */
async function fileRepoStateInvestigation({ agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId }) {
  const appName = task?.metadata?.appName || appId || 'PortOS';
  const base = observed.defaultBranch || 'main';

  const context = [
    `An agent finished successfully but the repository did not end up in the expected state.`,
    ``,
    `Repository: ${sourceWorkspace}`,
    `Branch: ${branchName}`,
    `Worktree: ${worktreePath}`,
    `Default branch: ${base}`,
    observed.prUrl ? `Pull request: ${observed.prUrl} (${observed.prState || 'state unknown'})` : `Pull request: none found`,
    `Original agent: ${agentId}`,
    `Original task: ${task?.description || 'unknown'}`,
    ``,
    `What diverged:`,
    ...issues.map((i, n) => `${n + 1}. ${i.message}`),
    ``,
    `Finish the work, in this order:`,
    ...issues.map((i, n) => `${n + 1}. ${remediationFor(i.code, { branchName, defaultBranch: base, prUrl: observed.prUrl, worktreePath })}`),
    ``,
    `Rules: never delete a branch whose commits are not already on ${base} — land the work first. `
      + `Other agents are running concurrently with their own worktrees and branches; touch ONLY ${branchName} and its worktree. `
      + `Do not switch branches in ${sourceWorkspace} itself.`,
  ].join('\n');

  const created = await addTask({
    description: `${RECOVERY_TASK_PREFIX} Finish incomplete cleanup for branch ${branchName} in ${appName}`,
    priority: 'HIGH',
    app: appId || undefined,
    isRecovery: true,
    context,
    useWorktree: false,
  }, 'user');

  if (created?.duplicate) {
    emitLog('info', `🔎 Repo-state investigation for ${branchName} already queued as ${created.id}`, { agentId, branchName });
    return null;
  }
  emitLog('info', `🔧 Filed repo-state investigation task for ${branchName} (${issues.length} issue(s))`, { agentId, branchName, appName });
  return created?.id || null;
}

/**
 * Surface the divergence to the user alongside the auto-filed task, so a
 * repeatedly-diverging app is visible rather than only inferable from a growing
 * recovery queue.
 */
async function notifyRepoStateDivergence({ agentId, task, branchName, issues, appId }) {
  const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
  const appName = task?.metadata?.appName || appId || 'PortOS';
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: `Repo state not clean after agent: ${appName}`,
    description: `Branch ${branchName}\n${issues.map(i => `• ${i.message}`).join('\n')}`,
    priority: PRIORITY_LEVELS.HIGH,
    link: '/cos/agents',
    metadata: { agentId, taskId: task?.id, branchName, issues: issues.map(i => i.code) },
  });
}
