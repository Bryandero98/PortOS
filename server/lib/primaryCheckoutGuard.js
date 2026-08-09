/**
 * Primary-checkout branch-jack detector (#3680).
 *
 * A CoS agent spawned with a worktree must only ever write inside that
 * worktree. On 2026-08-09 one didn't: running `/do:pr` from its worktree it
 * applied its three commits onto the PRIMARY checkout's local `main`, where
 * they sat unpushed and unreviewed. `main` is unprotected on this repo, so a
 * later `git push` from the primary would have landed them without a PR.
 *
 * The chosen remedy is DETECT-AND-REPORT, not prevention and not auto-repair:
 *
 *   - Prevention (making the primary read-only for the duration of a run) would
 *     break the many legitimate flows that read and write the primary checkout.
 *   - Auto-repair means `git reset --hard`, which DISCARDS commits. That stays a
 *     human decision, so the failure message states the recovery command instead
 *     of running it — and notes that the same work also exists on the agent's
 *     own branch, which is what makes the reset safe.
 *
 * Movement alone is NOT the signal. The primary checkout legitimately moves
 * during a run — a `git pull` on `main`, another PortOS flow fast-forwarding it
 * to commits that already merged upstream. Reporting those as branch-jacks fired
 * a false failure whose recovery prose ("commits PortOS never reviewed", `reset
 * --hard origin/main`) was actively wrong: the commits WERE `origin/main`. So the
 * guard reports only what a branch-jack actually leaves behind — commits the
 * branch's upstream does not have, or the checkout parked on a different branch.
 * A branch with no upstream to compare against can't be cleared, so it still
 * reports (an unpushed commit is unreviewed by definition).
 *
 * Movement that survives the checks above is still not enough to FAIL the run.
 * The primary checkout is a shared global resource — a concurrent coding-on-main
 * agent, the human's own terminal, `update.sh`'s `git pull --rebase --autostash`,
 * or any background flow can strand commits on it — so before blaming the run,
 * the guard asks whether THIS agent could have produced them (#3703). When a run
 * strands commits, they are attributed to the agent's own worktree branch by
 * PATCH-ID (`git cherry`, not raw SHA, so a cherry-picked or rebased copy still
 * matches). Stranded commits the agent demonstrably did not author — a read-only
 * reasoner that never branched, or commits with no patch-equivalent on the
 * agent's branch — are carried as `{ drifted: false, unattributed: true }`:
 * warn-logged (unreviewed commits on `main` are worth surfacing) but not failed.
 * The asymmetry is deliberate — a missed branch-jack still leaves a warn log and
 * recoverable commits, while a false failure escalates to a human and dents the
 * task type's success rate. (A checkout left on the WRONG BRANCH with nothing
 * local-only strands no commit to attribute, and still reports its benign
 * `git checkout <branch>` recovery as before — there is nothing to discard.)
 *
 * Two halves, deliberately split so they can sit on opposite ends of a run:
 * `capturePrimaryCheckoutState` stamps a baseline at spawn time (onto the agent
 * metadata, in `agentLifecycle.js`), and `detectPrimaryCheckoutDrift` re-reads it
 * in the shared finalize path (`agentFinalization.js`) — the one chokepoint all
 * three spawn modes (TUI, direct CLI, runner) already funnel through, so the
 * guard is not TUI-only without triplicating it.
 *
 * Every function here is NON-THROWING, for the same reason `gitCommitProbe.js`
 * is: it runs on the agent-completion path, outside the Express request
 * lifecycle, where a rejection has nothing to bubble to. An unreadable or
 * missing checkout, or a wedged git, degrades to "no drift observed" — the guard
 * never manufactures a failure out of a check that could not run.
 */

import { execGit } from './execGit.js';

/**
 * The completion reason a drifted run is recorded under. Registered in
 * `COMPLETION_REASON_ANALYSES` (agentErrorAnalysis.js) so the analyzer has a
 * verdict for it instead of falling through to a keyword sweep of the
 * transcript.
 */
export const PRIMARY_CHECKOUT_MUTATED_REASON = 'primary-checkout-mutated';

/**
 * The taxonomy token the drift is classified under. Reuses the pre-existing
 * `git-error` category rather than minting a new one, so every downstream
 * consumer (auto-fix tiers, learning buckets, the failure ledger) keeps
 * classifying it with no new token to teach them. Deliberately NOT in
 * `ENVIRONMENTAL_ERROR_CATEGORIES`: this is the run's own misbehavior, and it
 * should dent the task type's measured success rate.
 */
export const PRIMARY_CHECKOUT_MUTATED_CATEGORY = 'git-error';

/**
 * What a human has to do before this task may run again. Lives here so the
 * finalize-path analysis and the `COMPLETION_REASON_ANALYSES` registration can't
 * drift apart on it. A retry cannot repair a mutated checkout, so this
 * deliberately escalates rather than blind-retrying.
 */
export const PRIMARY_CHECKOUT_MUTATED_ESCALATION =
  'A worktree agent committed to the primary checkout. Confirm the commits are preserved (agent branch / open PR), restore the primary, then approve the retry.';

/** Bound on every git call here — this sits on finalize; nothing may wedge it. */
const GIT_TIMEOUT_MS = 10_000;

/** First line of a probe-shaped execGit result, or null. */
function firstLine(result) {
  if (!result || result.exitCode !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

/**
 * Read a checkout's current branch + HEAD SHA. Returns null when the path is
 * absent, is not a repo, has no commits yet, or git could not be run.
 *
 * A DETACHED head reports its branch as the literal `HEAD` and is kept as-is
 * (rather than nulled, the way `resolveWorkspaceBranch` does it) — this value is
 * only ever compared against a later reading of itself, and "detached, then on a
 * branch" is exactly the kind of movement worth reporting.
 *
 * @param {string} checkoutPath
 * @returns {Promise<{path: string, branch: string, head: string}|null>}
 */
export async function capturePrimaryCheckoutState(checkoutPath) {
  if (!checkoutPath || typeof checkoutPath !== 'string') return null;
  const options = { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS };
  const [branchResult, headResult] = await Promise.all([
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], checkoutPath, options).catch(() => null),
    execGit(['rev-parse', 'HEAD'], checkoutPath, options).catch(() => null),
  ]);
  const branch = firstLine(branchResult);
  const head = firstLine(headResult);
  if (!branch || !head) return null;
  return { path: checkoutPath, branch, head };
}

/**
 * How many commits `head` is ahead of `baseHead`. Returns null (not 0) when the
 * range can't be resolved — a rewritten/pruned baseline commit, or a git that
 * timed out — so the prose can say "moved" without asserting a count it doesn't
 * have.
 */
async function countCommitsAhead(checkoutPath, baseHead, head, { noMerges = false } = {}) {
  const args = ['rev-list', '--count'];
  if (noMerges) args.push('--no-merges');
  args.push(`${baseHead}..${head}`);
  const result = await execGit(
    args,
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  const value = firstLine(result);
  const count = value === null ? NaN : parseInt(value, 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * The branch's upstream tracking ref (`origin/main`), resolved to an IMMUTABLE
 * SHA — or null when it has none configured, or git could not be run. Pinning to
 * a SHA (rather than returning the symbolic `origin/main`) means the count and the
 * later `git cherry` walk compare against the same history even if a concurrent
 * fetch moves the tracking ref between calls — this guard runs against a shared
 * checkout that other actors are actively moving. Both failure modes collapse to
 * null on purpose: the caller treats "no comparison available" identically.
 */
async function resolveUpstreamSha(checkoutPath, branch) {
  const result = await execGit(
    ['rev-parse', `${branch}@{upstream}`],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  return firstLine(result);
}

/**
 * Resolve the agent's own worktree branch to an IMMUTABLE commit SHA — trying the
 * local branch first, then its `origin/<branch>` remote-tracking form (the agent
 * may have pushed and had its local ref pruned). Returns the SHA (not the ref
 * name) so the count and the `git cherry` walk pin to the same commit even if the
 * shared branch ref is moved or pruned between the two calls. Returns null when
 * neither resolves, the name is empty, or git could not be run — every one of
 * which the caller treats as "cannot attribute, so do not blame".
 */
async function resolveAgentBranchSha(checkoutPath, agentBranch) {
  if (!agentBranch || typeof agentBranch !== 'string') return null;
  for (const ref of [agentBranch, `refs/remotes/origin/${agentBranch}`]) {
    const result = await execGit(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      checkoutPath,
      { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
    ).catch(() => null);
    const sha = firstLine(result);
    if (sha) return sha;
  }
  return null;
}

/**
 * Was the drift plausibly THIS agent's doing (#3703)? Compares the commits that
 * appeared on the primary DURING THE RUN (`runBase..driftedHead`, where `runBase`
 * is the checkout's HEAD at spawn) against the agent's own worktree branch by
 * PATCH-ID via `git cherry`, so a cherry-picked or rebased copy still matches — a
 * raw-SHA check would miss exactly the case the original #3680 incident could have
 * produced.
 *
 * The window is anchored at `runBase`, NOT at the branch's upstream: a commit that
 * was ALREADY stranded on the primary at spawn (and happens to also live on the
 * agent's branch — a fresh worktree branch is cut from the primary's `main`, so it
 * inherits the primary's unpushed commits) would otherwise be counted as stranded
 * yet omitted from the foreign tally by `git cherry` (same SHA), silently supplying
 * the `+1` that flips `stranded > foreign` and re-blaming the agent for a drift
 * another actor caused — the very #3703 regression. Only a commit created after
 * spawn can be this run's branch-jack, so pre-run history is excluded from
 * attribution (the reported `unpushedCount` still measures against the upstream —
 * that is what a human recovers).
 *
 * Returns true when AT LEAST ONE run-window commit is the agent's own — either
 * literally on its branch (same SHA) or patch-equivalent to one there (a
 * cherry-picked / rebased copy). Every uncertain outcome — no branch name, a
 * branch that does not resolve, a branch with no commits of its own (Case A: a
 * read-only reasoner that never branched), or a failed git call — returns FALSE
 * (unattributed), failing open by design. NON-THROWING, like the rest of the
 * module.
 *
 * Residual (documented, not guarded): a `git pull --rebase` on the primary that
 * REWRITES a commit the agent's branch also carries produces a post-spawn copy
 * patch-equivalent to the agent's, which still attributes. Closing it would mean
 * excluding the agent's own inherited commits from the patch-id set first; the
 * scenario needs the agent branch to already carry a primary-local commit, which
 * a fresh worktree branch (based on `origin/<default>`) does not.
 */
async function isDriftAttributableToAgent(checkoutPath, { runBase, driftedHead, agentBranch }) {
  const agentSha = await resolveAgentBranchSha(checkoutPath, agentBranch);
  if (!agentSha) return false;
  // Cheap short-circuit: a branch that carries no commit of its own past the run
  // baseline (a read-only reasoner's untouched worktree branch) cannot have
  // authored anything, so skip the cherry walk. `git cherry` reaches the same
  // verdict on its own — this only avoids the extra call on the common case.
  const ownCommits = await countCommitsAhead(checkoutPath, runBase, agentSha);
  if (!ownCommits) return false;
  // Count the run-window NON-MERGE commits — matching what `git cherry` walks. A
  // merge commit strays onto the primary via a human's `git merge` or a non-ff
  // pull (never a `/do:pr` branch-jack), and `git cherry` skips it; counting it
  // here would leave `stranded > foreign` true on arithmetic alone and re-blame
  // the very false-positive this guard exists to prevent.
  const runWindowNonMerge = await countCommitsAhead(checkoutPath, runBase, driftedHead, { noMerges: true });
  if (!runWindowNonMerge) return false;
  // `git cherry <upstream> <head> <limit>` walks the run-window non-merge commits
  // (`limit..head`) and prints a line for each that <upstream> (the agent's
  // branch) does NOT already contain: `-` when a patch-equivalent copy exists
  // there, `+` when the commit is foreign to it. Commits the agent's branch holds
  // outright (same SHA) are omitted entirely. So a run-window commit is the agent's
  // UNLESS git cherry marks it `+`; the drift is attributed unless EVERY run-window
  // non-merge commit is foreign.
  const cherry = await execGit(
    ['cherry', agentSha, driftedHead, runBase],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  if (!cherry || cherry.exitCode !== 0) return false;
  const foreign = (cherry.stdout || '').split('\n').filter(line => line.startsWith('+')).length;
  return runWindowNonMerge > foreign;
}

/** Short SHA for human-readable prose. */
const short = sha => String(sha || '').slice(0, 9);

/**
 * Re-read the baseline and report whether the primary checkout moved during the
 * run.
 *
 * Outcomes, never collapsed:
 *   - `{ drifted: false }` — it didn't move, OR there was nothing to check, OR
 *     the checkout could not be read (nothing was verified, so nothing is
 *     claimed).
 *   - `{ drifted: false, fastForwarded: true, … }` — HEAD moved on the SAME
 *     branch but every commit is already on that branch's upstream. That is a
 *     `git pull`, not a branch-jack; carried as a distinct shape (rather than a
 *     bare `false`) so a caller can log what it observed.
 *   - `{ drifted: false, unattributed: true, … }` — commits WERE stranded, but
 *     none are patch-equivalent to a commit on the agent's own branch, so this
 *     run demonstrably did not put them there (a concurrent actor did). Carries
 *     the `message` so the caller can warn-log the unreviewed commits without
 *     failing the run. See the module header on the fail-open asymmetry.
 *   - `{ drifted: true, … }` — the checkout ended on a different branch, or it
 *     carries commits the upstream does not have AND those commits are
 *     attributable to the agent's own branch by patch-id.
 *
 * @param {{path: string, branch: string, head: string}|null} baseline stamped by
 *   `capturePrimaryCheckoutState` at spawn time
 * @param {{ agentBranch?: string|null }} [options] the agent's own worktree
 *   branch, used both to ATTRIBUTE the stranded commits by patch-id and, once
 *   attributed, named in the recovery prose because it is where the same commits
 *   almost certainly also live
 */
export async function detectPrimaryCheckoutDrift(baseline, { agentBranch = null } = {}) {
  if (!baseline?.path || !baseline?.branch || !baseline?.head) return { drifted: false };
  const current = await capturePrimaryCheckoutState(baseline.path);
  // Unreadable now (deleted, mid-rebase, git wedged): we verified nothing, so we
  // report nothing rather than inventing a failure.
  if (!current) return { drifted: false };
  if (current.branch === baseline.branch && current.head === baseline.head) return { drifted: false };

  // Pin the upstream to a SHA and count everything against `current.head` (the SHA
  // captured above), never the live `current.branch` — a concurrent commit or
  // fetch on the shared checkout must not make the two counts and the cherry walk
  // read different histories.
  const upstream = await resolveUpstreamSha(baseline.path, current.branch);
  const [commitCount, unpushedCount] = await Promise.all([
    countCommitsAhead(baseline.path, baseline.head, current.head),
    // Commits the branch carries that its upstream does not — the only commits a
    // branch-jack actually strands. Null (not 0) when there is no upstream to
    // compare against, so "verified clean" never masquerades as "could not check".
    upstream ? countCommitsAhead(baseline.path, upstream, current.head) : Promise.resolve(null),
  ]);

  // Same branch, nothing local-only: the checkout was pulled forward onto commits
  // that are already upstream (reviewed, merged, pushed). Nothing was stranded, so
  // there is nothing for a human to recover.
  if (current.branch === baseline.branch && unpushedCount === 0) {
    return { drifted: false, fastForwarded: true, baseline, current, commitCount };
  }

  const message = formatDriftMessage({ baseline, current, commitCount });

  // Second gate (#3703): stranded commits are only a failure if THIS agent could
  // have produced them. Attribution runs whenever there is (or should be) a
  // stranded commit — a resolvable positive count, OR an UNRESOLVABLE count
  // (`null`: a pruned baseline or a wedged git), which must fail OPEN rather than
  // manufacture a failure out of a check that could not run. Only a pure branch
  // switch that stranded exactly zero commits skips it (nothing to blame on
  // anyone) and keeps its benign `git checkout` report.
  const strandedCount = unpushedCount === null ? commitCount : unpushedCount;
  if (strandedCount === null || strandedCount > 0) {
    const attributed = await isDriftAttributableToAgent(baseline.path, {
      runBase: baseline.head,
      driftedHead: current.head,
      agentBranch,
    });
    if (!attributed) {
      return { drifted: false, unattributed: true, baseline, current, commitCount, unpushedCount, message };
    }
  }

  return {
    drifted: true,
    reason: PRIMARY_CHECKOUT_MUTATED_REASON,
    category: PRIMARY_CHECKOUT_MUTATED_CATEGORY,
    baseline,
    current,
    commitCount,
    unpushedCount,
    message,
    suggestedFix: formatDriftRecovery({ current, baseline, commitCount, unpushedCount, agentBranch }),
  };
}

/** Human-readable "what moved". Pure. */
export function formatDriftMessage({ baseline, current, commitCount }) {
  const branchPart = current.branch === baseline.branch
    ? `branch ${current.branch}`
    : `branch ${baseline.branch} → ${current.branch}`;
  const countPart = commitCount === null
    ? 'commit count unresolved'
    : `${commitCount} new commit${commitCount === 1 ? '' : 's'}`;
  return `Worktree agent mutated the primary checkout ${baseline.path}: ${branchPart}, HEAD ${short(baseline.head)} → ${short(current.head)} (${countPart})`;
}

/**
 * The recovery advice. Names the exact commands and is explicit that the reset
 * discards commits — PortOS deliberately does not run it (see the module header).
 *
 * Two shapes, because the two failures need different commands: a checkout left
 * on the WRONG BRANCH with nothing local-only just needs checking back out (no
 * reset, nothing to discard, no reason to scare the reader with `--hard`), while
 * stranded commits need the inspect-then-reset flow. Pure.
 */
export function formatDriftRecovery({ current, baseline = null, commitCount, unpushedCount = null, agentBranch }) {
  if (unpushedCount === 0 && baseline?.branch && baseline.branch !== current.branch) {
    return [
      `A worktree-isolated agent left the PRIMARY checkout on \`${current.branch}\` instead of \`${baseline.branch}\`.`,
      `No commits were stranded — \`${current.branch}\` carries nothing its upstream lacks — so restore it with \`git -C ${current.path} checkout ${baseline.branch}\`.`,
    ].join(' ');
  }
  const alsoOn = agentBranch
    ? `The same commits were almost certainly pushed on the agent's own branch \`${agentBranch}\` too, so check there (and for an open PR) before discarding anything.`
    : 'Check the agent\'s own branch (and for an open PR) for the same commits before discarding anything.';
  // The actionable number is what the upstream is MISSING, not how far HEAD moved
  // — a pull that also carried the agent's commit moves HEAD further than the
  // damage goes.
  const strandedCount = unpushedCount === null ? commitCount : unpushedCount;
  const countPhrase = strandedCount === null ? 'commits' : `${strandedCount} commit${strandedCount === 1 ? '' : 's'}`;
  return [
    `A worktree-isolated agent committed to the PRIMARY checkout instead of its worktree, leaving \`${current.branch}\` carrying ${countPhrase} PortOS never reviewed.`,
    alsoOn,
    `Inspect them with \`git -C ${current.path} log --oneline origin/${current.branch}..${current.branch}\`, and once you have confirmed the content is upstream (or preserved on the agent branch) restore the checkout with \`git -C ${current.path} reset --hard origin/${current.branch}\`.`,
    'That reset DISCARDS those commits, so PortOS will not run it for you.',
  ].join(' ');
}
