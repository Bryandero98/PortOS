/**
 * Branch & PR Reconciler — deterministic core (Tier 1).
 *
 * Enumerates THIS machine's local branches (`refs/heads/`), classifies each by
 * its merge / PR state, and deterministically cleans up the fully-merged,
 * orphaned ones (remove the lingering worktree + delete the local branch).
 * Everything that needs judgment (open a PR, resolve conflicts, drive a review
 * loop, merge) is returned in `inFlight` for the scheduler to hand to a
 * coordinator CoS agent — this module never spawns an agent, so it stays pure
 * enough to unit-test.
 *
 * PEER SAFETY: only `refs/heads/` (local) branches are ever considered. A branch
 * created on a federated peer exists here only as a remote-tracking ref
 * (`origin/*`), never as a local branch, so it is structurally invisible. We
 * never author-filter — every machine shares one GitHub login, so authorship
 * can't distinguish machines; local-branch existence can.
 */

import { stat } from 'node:fs/promises';
import { getBranches, getDefaultBranch, isBranchMergedInto, deleteBranch } from './git.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees, forceRemoveWorktreeDir, classifyWorktreeDirt, isHumanClaimWorktree } from './worktreeManager.js';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec } from '../lib/workTracker.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

// Never reconciled — these are long-lived shared branches, not disposable work.
// The resolved default branch is added on top at runtime.
export const PROTECTED_BRANCHES = ['main', 'master', 'release'];

// A `claim-*` worktree is normally protected as a human `/claim` session that
// self-cleans in the /claim Phase-7 flow. But when that flow never runs (the
// agent finished WITHOUT committing), the branch is left as a bare pointer at an
// already-merged commit and the worktree lingers forever — making branch-reconcile
// park with "cleaned 0" every run (the exact confusion behind this guard). Reap
// such a claim worktree once it is older than this AND its branch is merged AND
// its worktree is clean. That trio is only ever true for an ABANDONED claim: a
// claim with real work in progress is never merged+clean (uncommitted edits →
// dirty → WIP; committed work → not an ancestor of default → not MERGED).
//
// Because a reaped worktree is merged+clean, the reap loses NOTHING recoverable —
// no commits beyond the default branch, no uncommitted edits — and re-running
// `/claim` recreates it in seconds. So even a false positive (a human who claimed
// an issue, left the branch untouched at the default commit, and returns to a
// *paused* session) costs only a re-claim, never work. The window is set very
// conservatively at a full week anyway — mtime alone can't prove abandonment, so
// we err far toward preservation: a paused session returned-to within 7 days keeps
// its worktree, while a genuinely-leaked one (which persists indefinitely) is
// reaped on the daily recheck once it crosses the threshold.
export const STALE_CLAIM_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Bound the gh query (single-user repos never realistically truncate at 200).
const PR_LIST_LIMIT = 200;

/**
 * Pure classifier: map one branch's git/PR facts to a reconcile state.
 * First match wins.
 *   MERGED     — work is fully in the default branch → deterministic cleanup
 *   CONFLICTED — open PR with merge conflicts        → agent resolves
 *   IN_REVIEW  — open PR, otherwise                  → agent drives to merge
 *   NEEDS_PR   — pushed, not merged, no PR, clean     → agent verifies + opens PR
 *   WIP        — local-only or dirty worktree         → skip + report (never touch)
 *
 * @param {{ hasUpstream:boolean, isMerged:boolean, worktreeDirty:boolean, openPr:({mergeable?:string}|null) }} input
 * @returns {'MERGED'|'CONFLICTED'|'IN_REVIEW'|'NEEDS_PR'|'WIP'}
 */
export function classifyBranch({ hasUpstream, isMerged, worktreeDirty, openPr }) {
  if (isMerged) return 'MERGED';
  // A worktree with real uncommitted changes is NEVER handed to the coordinator
  // agent — even for a branch with an open PR. The agent's per-state actions
  // (rebase/resolve/merge) run git operations that could stash/reset/checkout
  // and silently discard the user's in-progress work. Skip it as WIP regardless
  // of PR state; the `cleanupMerged` path applies the same guard for MERGED.
  if (worktreeDirty) return 'WIP';
  if (openPr) return openPr.mergeable === 'CONFLICTING' ? 'CONFLICTED' : 'IN_REVIEW';
  if (hasUpstream) return 'NEEDS_PR';
  return 'WIP';
}

/**
 * Classify a list of gathered branch inputs. Pure.
 * @param {object[]} inputs - each from `gatherBranchState`
 * @returns {object[]} inputs with a `state` field added
 */
export function classifyBranches(inputs) {
  return inputs.map((input) => ({ ...input, state: classifyBranch(input) }));
}

/**
 * Resolve the open PRs for a repo, keyed by head branch name.
 * Returns an empty Map on any gh failure (degrade: treat as "no PR").
 * @param {string} repoPath
 * @returns {Promise<Map<string, {number:number, mergeable:string, isDraft:boolean, url:string}>>}
 */
async function getOpenPrsByHead(repoPath) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
  // Accept any GitHub-family host (github.com AND enterprise github.*), mirroring
  // prWatcher.checkPullRequests. `origin.isGithub` is github.com-only, so gating
  // on it silently skipped enterprise repos. githubRepoSpec pairs that gate with
  // the host-qualified `HOST/OWNER/REPO` selector (null for a non-GitHub origin).
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return new Map();
  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec, '--state', 'open',
    '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,headRefName,mergeable,isDraft,url'
  ]).catch(() => null);
  const parsed = safeJSONParse(raw, null);
  if (!Array.isArray(parsed)) return new Map();
  const byHead = new Map();
  for (const pr of parsed) {
    if (pr?.headRefName) {
      byHead.set(pr.headRefName, {
        number: pr.number,
        mergeable: pr.mergeable || 'UNKNOWN',
        isDraft: pr.isDraft === true,
        url: pr.url || ''
      });
    }
  }
  return byHead;
}

/**
 * Reason a worktree must NOT be torn down, or null if it's safe to remove.
 * Pure — the dangerous-to-remove cases the deterministic cleanup must respect
 * (mirrors the guards the existing worktree reaper honors):
 *   - locked            → the user explicitly `git worktree lock`ed it
 *   - human `/claim`    → a `claim-<slug>` worktree self-cleaned by the /claim flow,
 *                         UNLESS it is an abandoned one older than `staleClaimIdleMs`
 *                         (`ageMs` supplied) — those are reaped (see STALE_CLAIM_IDLE_MS)
 *   - active CoS agent  → an agent (`agent-<id>`) is currently running in it
 * Sibling worktrees (`next-issue-*`, etc.) whose basename is none of these fall
 * through to null and are cleaned normally.
 *
 * @param {{ path:string, locked?:boolean, activeAgentIds?:Set<string>, ageMs?:number, staleClaimIdleMs?:number }} input
 * @returns {string|null}
 */
export function worktreeProtectionReason({ path, locked, activeAgentIds, ageMs, staleClaimIdleMs = STALE_CLAIM_IDLE_MS }) {
  if (locked) return 'worktree-locked';
  const basename = (path || '').split('/').pop() || '';
  if (isHumanClaimWorktree(basename)) {
    // Reap an abandoned claim (age known AND past the idle window); keep protecting
    // a recent one so a live human /claim session — or its Phase-7 self-clean — wins.
    // Unknown age (ageMs omitted) stays protected: fail safe toward not-deleting.
    if (typeof ageMs === 'number' && ageMs >= staleClaimIdleMs) return null;
    return 'worktree-human-claim';
  }
  if (activeAgentIds?.has(basename)) return 'worktree-active-agent';
  return null;
}

/**
 * Is a worktree's working tree carrying real (non-lockfile) uncommitted changes?
 * @param {string} worktreePath
 * @returns {Promise<boolean>}
 */
async function isWorktreeDirty(worktreePath) {
  const { stdout } = await execGit(['status', '--porcelain'], worktreePath, { ignoreExitCode: true })
    .catch(() => ({ stdout: '' }));
  return classifyWorktreeDirt(stdout).hasRealChanges;
}

/**
 * Age of a worktree directory (ms since its last structural mtime), or null when
 * it can't be stat'd. The worktree root's mtime is set when `git worktree add`
 * lays down its top-level entries and doesn't move for deep-file edits, so for an
 * abandoned claim (no top-level churn after creation) it tracks "time since the
 * worktree was created" — exactly the staleness signal STALE_CLAIM_IDLE_MS needs.
 * @param {string} worktreePath
 * @returns {Promise<number|null>}
 */
async function worktreeAgeMs(worktreePath) {
  const st = await stat(worktreePath).catch(() => null);
  return st ? Math.max(0, Date.now() - st.mtimeMs) : null;
}

/**
 * Gather the raw git/PR facts for every local feature branch in `repoPath`.
 * Excludes the default branch, the currently-checked-out branch, and the
 * always-protected set. Effectful (git + gh).
 *
 * @param {string} repoPath
 * @param {{ defaultBranch:string }} ctx
 * @returns {Promise<object[]>} one entry per candidate branch:
 *   { branch, hasUpstream, isMerged, hasWorktree, worktreePath, worktreeDirty, openPr }
 */
export async function gatherBranchState(repoPath, { defaultBranch }) {
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);

  const [branches, worktrees, prsByHead] = await Promise.all([
    getBranches(repoPath),
    listWorktrees(repoPath).catch(() => []),
    getOpenPrsByHead(repoPath)
  ]);

  // Map local branch name -> worktree record (strip the refs/heads/ prefix).
  const worktreeByBranch = new Map();
  for (const wt of worktrees) {
    const name = wt.branch?.replace(/^refs\/heads\//, '');
    if (name) worktreeByBranch.set(name, { path: wt.path, locked: Boolean(wt.locked) });
  }

  const candidates = branches.filter(
    (b) => !b.isDefault && !b.current && !protectedSet.has(b.name)
  );

  const inputs = [];
  for (const b of candidates) {
    const wt = worktreeByBranch.get(b.name) || null;
    const worktreePath = wt?.path || null;
    const worktreeLocked = Boolean(wt?.locked);
    const worktreeAge = worktreePath ? await worktreeAgeMs(worktreePath) : null;
    const worktreeDirty = worktreePath ? await isWorktreeDirty(worktreePath) : false;
    // getBranches' `merged` is ancestor-based (misses squash/rebase); confirm
    // the harder cases via isBranchMergedInto (covers squash + rebase). Short
    // -circuit when the cheap check already proved it merged.
    const isMerged = b.merged || await isBranchMergedInto(repoPath, b.name, defaultBranch);
    inputs.push({
      branch: b.name,
      hasUpstream: Boolean(b.tracking),
      isMerged,
      hasWorktree: Boolean(worktreePath),
      worktreePath,
      worktreeLocked,
      worktreeAgeMs: worktreeAge,
      worktreeDirty,
      openPr: prsByHead.get(b.name) || null
    });
  }
  return inputs;
}

/**
 * Deterministically clean up fully-merged branches: remove the lingering
 * worktree, then delete the local branch. Safety gates (ALL must hold):
 *   1. `isBranchMergedInto(default)` re-verified true (fail closed).
 *   2. the branch's worktree (if any) has no real uncommitted changes.
 * A failed gate skips the branch (with a reason) — never a force-delete of
 * unmerged or dirty work.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {object[]} merged - gathered inputs whose state === 'MERGED'
 * @param {{ activeAgentIds?: Set<string> }} [opts] - CoS agents currently running;
 *   their worktrees are never torn down even when the branch is merged + clean.
 * @returns {Promise<{cleaned:string[], skipped:{branch:string,reason:string}[]}>}
 */
export async function cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds = new Set() } = {}) {
  const cleaned = [];
  const skipped = [];
  for (const b of merged) {
    // Re-verify at action time — state may have shifted since the gather.
    const stillMerged = await isBranchMergedInto(repoPath, b.branch, defaultBranch);
    if (!stillMerged) {
      skipped.push({ branch: b.branch, reason: 'not-merged-on-recheck' });
      continue;
    }
    if (b.worktreePath) {
      // Never tear down a worktree that's locked, a RECENT human /claim session, or
      // an active CoS agent workspace — even if its branch is merged and clean. An
      // abandoned claim worktree (merged + clean + older than STALE_CLAIM_IDLE_MS)
      // falls through and IS reaped; that's the "cleaned 0 forever" leak this fixes.
      const protectedReason = worktreeProtectionReason({
        path: b.worktreePath, locked: b.worktreeLocked, activeAgentIds, ageMs: b.worktreeAgeMs
      });
      if (protectedReason) {
        skipped.push({ branch: b.branch, reason: protectedReason });
        continue;
      }
      const dirty = await isWorktreeDirty(b.worktreePath);
      if (dirty) {
        skipped.push({ branch: b.branch, reason: 'worktree-dirty' });
        continue;
      }
      await forceRemoveWorktreeDir(repoPath, b.worktreePath, {
        label: `🔀 branch-reconcile: remove worktree for ${b.branch}`, log: 'all'
      });
    }
    const result = await deleteBranch(repoPath, b.branch, { local: true }).catch((err) => ({ error: err.message }));
    if (result?.error || result?.results?.local?.startsWith?.('failed')) {
      skipped.push({ branch: b.branch, reason: `delete-failed: ${result.error || result.results.local}` });
      continue;
    }
    cleaned.push(b.branch);
  }
  return { cleaned, skipped };
}

/**
 * Full Tier-1 reconcile: gather → classify → clean up merged. Returns the
 * in-flight set (branches needing an agent) for the scheduler to dispatch.
 *
 * @param {string} [repoPath=PATHS.root]
 * @param {{ cleanup?: boolean, activeAgentIds?: Set<string> }} [opts] - when cleanup
 *   is false, merged branches are reported (in `skipped`, reason `cleanup-disabled`)
 *   but not deleted. `activeAgentIds` protects in-use CoS agent worktrees.
 * @returns {Promise<{ defaultBranch:string, cleaned:string[], inFlight:object[], wip:object[], skipped:{branch:string,reason:string}[] }>}
 */
export async function reconcile(repoPath = PATHS.root, { cleanup = true, activeAgentIds = new Set() } = {}) {
  const defaultBranch = await getDefaultBranch(repoPath).catch(() => 'main') || 'main';
  const inputs = await gatherBranchState(repoPath, { defaultBranch });
  const classified = classifyBranches(inputs);

  const merged = classified.filter((c) => c.state === 'MERGED');
  const inFlight = classified.filter((c) => ['CONFLICTED', 'IN_REVIEW', 'NEEDS_PR'].includes(c.state));
  const wip = classified.filter((c) => c.state === 'WIP');

  const { cleaned, skipped } = cleanup
    ? await cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds })
    : { cleaned: [], skipped: merged.map((m) => ({ branch: m.branch, reason: 'cleanup-disabled' })) };

  return { defaultBranch, cleaned, inFlight, wip, skipped };
}

// ============================================================
// Coordinator prompt helpers (Tier-2 dispatch)
//
// These turn the classified `inFlight` set into the actionable subset + the
// Markdown block injected into the `branch-reconcile` CoS task prompt. They live
// here (next to the classifier that produces their input) rather than in the
// scheduler/generator so both the perpetual-drain gate and any prompt builder
// share one source of truth. The `actions` object mirrors the per-app task
// metadata toggles (cleanupMerged / openPr / resolveConflicts / autoMerge).
// ============================================================

/** An action is ON unless the config explicitly set it to false (opt-out). */
export const actionOn = (actions, key) => actions?.[key] !== false;

/**
 * Which in-flight branches have an enabled action? Pure — drives both the
 * drain gate (dispatch nothing when empty → park) and the prompt payload.
 * @param {object[]} inFlight - reconcile()'s inFlight entries (with `state`)
 * @param {object} actions - the per-app action toggles
 */
export function filterActionable(inFlight, actions) {
  return inFlight.filter((b) => {
    if (b.state === 'NEEDS_PR') return actionOn(actions, 'openPr');
    if (b.state === 'CONFLICTED') return actionOn(actions, 'resolveConflicts');
    if (b.state === 'IN_REVIEW') return actionOn(actions, 'resolveConflicts') || actionOn(actions, 'autoMerge');
    return false;
  });
}

// The terminal state of an auto-mergeable branch is MERGED — not "PR opened",
// not "PR green and waiting". Every drive-to-merge instruction ends with this
// tail so the agent waits CI out IN-SESSION instead of handing back an open PR
// (the miss that left a green, MERGEABLE PR sitting open after a NEEDS_PR run:
// the agent opened it and signaled done 51s later). GitHub-native `--auto` is
// deliberately not the answer on its own — the agent exits the moment it
// finishes, so a queued auto-merge that later goes red has nobody left to fix
// it, and the branch silently stays in-flight until the next recheck.
//
// `pr` is the PR's number when the branch already has one, else the `<num>`
// placeholder the agent fills in after opening it.
const driveToMerge = (pr) => [
  'Opening (or approving) the PR is NOT the end state — a green PR left open is still an unfinished branch that this task will simply re-drive on its next run.',
  `Wait for CI in-session by re-polling \`gh pr checks ${pr} --required\` every 30s — each poll prints output, which keeps this run clear of the idle reaper the way a silent \`--watch\` does not. Budget 15 minutes for the run; past that, leave the PR open and report that CI was still pending.`,
  'If a required check FAILS, fix it on the branch, push, and re-poll (max 3 rounds); if it is still red after that, leave the PR open and report exactly which check failed.',
  `Once every required check is green AND the PR is MERGEABLE, merge it — from the repo root, NOT from inside the branch's worktree (\`gh\` can't delete a branch that is checked out elsewhere): \`gh pr merge ${pr} --merge --delete-branch\`. Repos differ in which methods they allow, so on a "not allowed" error retry with \`--squash\`, then \`--rebase\`. Never \`--auto\`: a queued auto-merge outlives this run, so a check that goes red afterward has nobody left to fix it.`,
  'After the merge, remove the branch\'s worktree first, then delete the local branch — the delete fails while a worktree still has it checked out.'
].join(' ');

/**
 * Per-state instruction to the coordinator/sub-agent.
 * @param {string} state
 * @param {object} actions - per-app action toggles
 * @param {{ prNumber?: number }} [ctx] - the branch's open PR number, when it has one
 */
export function desiredEndState(state, actions, { prNumber } = {}) {
  const pr = prNumber ? String(prNumber) : '<num>';
  if (state === 'NEEDS_PR') {
    const verify = 'Verify the branch\'s work is complete and ready (tests pass, no stubs/TODO markers, changelog present). If NOT ready, report it as incomplete and leave the branch untouched — do not open a half-baked PR.';
    // `--no-merge` is passed explicitly on BOTH paths — not to disable merging,
    // but to keep the merge decision here rather than inside slashdo. Under
    // `--merge`, /do:pr first tries GitHub-native auto-merge and reports the PR
    // as "queued", ending the run with CI still pending — the same unattended
    // exit this whole change exists to close. So /do:pr runs its reviewer loop
    // and opens the PR; the merge gate below is what finishes the branch. The
    // flag is also stated explicitly so this machine's saved slashdo defaults
    // (which may set `merge: true`) can't decide it either way.
    const openPr = '`/do:pr --no-merge` — its reviewer loop runs, and the PR is left for the gate below rather than queued for auto-merge (by hand, if slash commands aren\'t available in your context: self-review the diff and fix what you find, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan)';
    if (!actionOn(actions, 'autoMerge')) {
      return `${verify} If ready, ship it with ${openPr}. Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${verify} If ready, ship it with ${openPr}. ${driveToMerge(pr)}`;
  }
  if (state === 'CONFLICTED') {
    return 'Rebase the branch onto the default branch, resolve all conflicts, run the tests, and push.';
  }
  // IN_REVIEW
  const canMerge = actionOn(actions, 'autoMerge');
  // The Copilot gate is time-boxed for the same reason the merge waits on CI
  // in-session: a repo without Copilot review enabled never produces one, and an
  // unbounded "await the review" leaves a green PR open forever. 10 minutes
  // mirrors the claim-issue flow's Copilot poll.
  return `Drive the open PR toward green: request/await the Copilot review and address feedback.${canMerge
    ? ` Merge ONLY when the LATEST Copilot review reports "0 comments" (pre-resolved threads do NOT count; a PR over 20k lines is exempt from the Copilot check and needs only CI-green + mergeable). If no Copilot review lands within 10 minutes of requesting it, the Copilot gate is satisfied — this repo may not have Copilot review enabled — and CI-green + MERGEABLE is the whole gate. ${driveToMerge(pr)}`
    : ' Do NOT merge (auto-merge is disabled) — stop once the PR is green and ready for the user to merge.'}`;
}

/**
 * Stable signature of an actionable set — used by the perpetual drain to detect
 * PROGRESS between dispatches. A productive coordinator run advances branches
 * through states (NEEDS_PR → IN_REVIEW → merged/cleaned) or removes them, all of
 * which change this signature; a run that leaves the SAME branches in the SAME
 * states (a `NEEDS_PR` branch the agent judged "not ready", an `IN_REVIEW` PR
 * blocked on human review / red CI) produces an identical signature, which the
 * generator treats as "no progress → park" instead of re-dispatching an
 * identical coordinator back-to-back. Order-independent (sorted).
 * @param {object[]} actionable - post-filterActionable branches
 * @returns {string}
 */
export function actionableSignature(actionable) {
  return actionable
    .map((b) => `${b.branch}:${b.state}:${b.openPr?.number ?? 'none'}:${b.openPr?.mergeable ?? 'none'}`)
    .sort()
    .join('|');
}

/**
 * Render the actionable in-flight branch set into the coordinator prompt body
 * (injected as `{inFlightBranches}`).
 * @param {object[]} inFlight - actionable branches (post-filterActionable)
 * @param {{ defaultBranch:string, actions:object }} ctx
 * @returns {string}
 */
export function formatInFlightForPrompt(inFlight, { defaultBranch, actions }) {
  const lines = [`Default branch: \`${defaultBranch}\`. Branches to reconcile (${inFlight.length}):`, ''];
  for (const b of inFlight) {
    const pr = b.openPr ? ` — PR #${b.openPr.number} (${b.openPr.mergeable})${b.openPr.url ? ` ${b.openPr.url}` : ''}` : ' — no PR';
    lines.push(`### \`${b.branch}\` [${b.state}]${pr}`);
    if (b.worktreePath) lines.push(`- Worktree: \`${b.worktreePath}\``);
    lines.push(`- Do: ${desiredEndState(b.state, actions, { prNumber: b.openPr?.number })}`);
    lines.push('');
  }
  return lines.join('\n');
}
