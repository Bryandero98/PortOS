/**
 * Branch-jack detector tests (#3680).
 *
 * Run against REAL git repositories in a temp dir rather than a mocked
 * `execGit`: the whole value of this module is that it reads git state
 * correctly, and a mock that returns whatever the test author expected `git
 * rev-parse` to print proves nothing about that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from './execGit.js';
import {
  capturePrimaryCheckoutState,
  detectPrimaryCheckoutDrift,
  formatDriftMessage,
  formatDriftRecovery,
  PRIMARY_CHECKOUT_MUTATED_CATEGORY,
  PRIMARY_CHECKOUT_MUTATED_REASON,
} from './primaryCheckoutGuard.js';

let repo;
let scratch;

async function commit(subject) {
  await writeFile(join(repo, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  await execGit(['add', '-A'], repo);
  await execGit(['commit', '-m', subject], repo);
}

/**
 * Give `repo` a real upstream to compare against — the guard now clears movement
 * only when the branch carries nothing its upstream lacks, so the benign cases
 * are untestable without one. A bare clone on disk keeps this real git (no
 * network, no mocked `rev-parse`).
 */
async function addOrigin() {
  const remote = join(scratch, 'origin.git');
  await execGit(['init', '--bare', '-b', 'main', remote], scratch);
  await execGit(['remote', 'add', 'origin', remote], repo);
  await execGit(['push', '-u', 'origin', 'main'], repo);
}

/** Land a commit on the remote and fast-forward `repo` onto it, as a pull would. */
async function pullFromOrigin(subject) {
  const clone = join(scratch, `contributor-${subject.replace(/\W+/g, '-')}`);
  await execGit(['clone', join(scratch, 'origin.git'), clone], scratch);
  await execGit(['config', 'user.email', 'other@example.com'], clone);
  await execGit(['config', 'user.name', 'Other Contributor'], clone);
  await writeFile(join(clone, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  await execGit(['add', '-A'], clone);
  await execGit(['commit', '-m', subject], clone);
  await execGit(['push', 'origin', 'main'], clone);
  await execGit(['pull', '--ff-only'], repo);
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'portos-branch-jack-'));
  repo = join(scratch, 'primary');
  await execGit(['init', '-b', 'main', repo], scratch);
  // Local identity so the suite doesn't depend on (or read) the host's git config.
  await execGit(['config', 'user.email', 'agent@example.com'], repo);
  await execGit(['config', 'user.name', 'Example Agent'], repo);
  await commit('initial');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('capturePrimaryCheckoutState', () => {
  it('reads the current branch and HEAD', async () => {
    const state = await capturePrimaryCheckoutState(repo);
    expect(state.path).toBe(repo);
    expect(state.branch).toBe('main');
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null for a missing path, a non-repo, and a non-string', async () => {
    expect(await capturePrimaryCheckoutState(join(scratch, 'nope'))).toBeNull();
    expect(await capturePrimaryCheckoutState(scratch)).toBeNull();
    expect(await capturePrimaryCheckoutState(null)).toBeNull();
    expect(await capturePrimaryCheckoutState('')).toBeNull();
  });
});

describe('detectPrimaryCheckoutDrift', () => {
  it('reports no drift when the primary checkout is untouched', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    // Simulate the run happening entirely elsewhere: nothing touches `repo`.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'claim/issue-1' });
    expect(verdict).toEqual({ drifted: false });
  });

  it('detects commits landed on the primary checkout when they are the agent\'s own', async () => {
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent made its two commits on its OWN worktree branch...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('branch jacked one');
    await commit('branch jacked two');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    // ...and a stray `/do:pr` from the worktree applied patch-equivalent copies
    // onto the PRIMARY's main (cherry-pick → different SHAs, so only the patch-id
    // gate attributes them — a raw-SHA check would miss this).
    await execGit(['checkout', 'main'], repo);
    await execGit(['cherry-pick', `${baseline.head}..${agentTip}`], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.reason).toBe(PRIMARY_CHECKOUT_MUTATED_REASON);
    expect(verdict.category).toBe(PRIMARY_CHECKOUT_MUTATED_CATEGORY);
    expect(verdict.commitCount).toBe(2);
    // The message names the drifted branch and the commit count...
    expect(verdict.message).toContain('main');
    expect(verdict.message).toContain('2 new commits');
    // ...and the fix names the agent branch plus the exact recovery command.
    expect(verdict.suggestedFix).toContain(agentBranch);
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
  });

  it('does NOT blame the agent for a stranded commit it did not author (unattributed)', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent's own branch carries an UNRELATED commit of its own...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s actual work');
    await execGit(['checkout', 'main'], repo);
    // ...while a different actor stranded a commit on the primary's main.
    await commit('someone else\'s commit');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    // Stranded, but no patch-equivalent on the agent branch → surfaced, not failed.
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.unpushedCount).toBe(1);
    expect(verdict.message).toContain('main');
    expect(verdict.suggestedFix).toBeUndefined();
  });

  it('does not let a stranded MERGE commit inflate attribution into a false positive', async () => {
    // A human `git merge` / non-ff pull strands `merge + N` commits on the primary,
    // but `git cherry` only ever walks the N non-merge commits. Counting the merge
    // among the stranded set would make `stranded > foreign` true on arithmetic
    // alone and re-blame the agent for a merge it never made.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent has a genuine commit of its own (passes the own-commits gate)...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('the agent\'s own work');
    // ...while a foreign branch is merged into the primary's main (non-ff → a merge
    // commit), none of it patch-equivalent to the agent's commit.
    await execGit(['checkout', 'main'], repo);
    await execGit(['checkout', '-b', 'a-foreign-branch'], repo);
    await commit('a foreign commit');
    await execGit(['checkout', 'main'], repo);
    await execGit(['merge', '--no-ff', '-m', 'Merge a-foreign-branch', 'a-foreign-branch'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('does not blame an agent that inherited the primary\'s pre-run unpushed commit (#3703 regression)', async () => {
    // The primary already carried an unpushed commit at spawn, and the agent branch
    // was cut from that HEAD (so it "inherits" that commit) while the agent committed
    // NOTHING. A foreign actor then strands its own commit during the run. Anchoring
    // attribution at the branch upstream would count the inherited commit as stranded
    // yet omit it from the foreign tally (same SHA) — flipping stranded > foreign and
    // failing a read-only agent. Anchoring at the run baseline excludes it.
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    await commit('primary local unpushed commit'); // on main, ahead of origin/main
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['branch', agentBranch], repo); // agent branch at the inherited HEAD, no own commits
    await commit('a foreign actor\'s commit'); // strands during the run

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    // Both the inherited and the foreign commit are unpushed, but neither is the agent's.
    expect(verdict.unpushedCount).toBe(2);
  });

  it('never attributes a branch-jack to a read-only reasoner that never branched (Case A)', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    // A 24-file commit lands on main mid-run, authored by another actor.
    await commit('a big commit from elsewhere');

    // The reasoner carried no worktree branch at all — it is structurally
    // impossible for it to have authored the commit, so it must not be blamed.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: null });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.commitCount).toBe(1);
  });

  it('never attributes when the agent branch has zero commits of its own', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    // Branch exists but points at the same commit as origin/main — no own commits.
    await execGit(['branch', agentBranch, 'origin/main'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    await commit('a commit from another actor');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('degrades to unattributed when the agent branch cannot be resolved', async () => {
    await addOrigin();
    const baseline = await capturePrimaryCheckoutState(repo);
    await commit('stranded by an unknown actor');

    // A branch name that resolves to nothing is uncertainty, not proof — fail open.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/never-created' });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
  });

  it('detects a branch switch even with no new commits', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', 'someone-elses-branch'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline);
    expect(verdict.drifted).toBe(true);
    expect(verdict.commitCount).toBe(0);
    expect(verdict.message).toContain('main → someone-elses-branch');
  });

  it('clears a plain pull: HEAD moved but every commit is already upstream', async () => {
    await addOrigin();
    const baseline = await capturePrimaryCheckoutState(repo);
    await pullFromOrigin('landed via a merged PR');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/task-x/agent-y' });
    // The false failure this guard used to raise (#3702 follow-up): the commit is
    // origin/main's, so `reset --hard origin/main` would have been a no-op the
    // user was told to consider.
    expect(verdict.drifted).toBe(false);
    expect(verdict.fastForwarded).toBe(true);
    expect(verdict.commitCount).toBe(1);
    expect(verdict.message).toBeUndefined();
  });

  it('still reports the agent\'s own commit when a pull landed alongside it', async () => {
    await addOrigin();
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    // The agent's real commit lives on its own branch...
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('branch jacked');
    const agentTip = (await capturePrimaryCheckoutState(repo)).head;
    await execGit(['checkout', 'main'], repo);
    // ...a pull brought an unrelated merged commit onto main...
    await pullFromOrigin('landed via a merged PR');
    // ...and the agent's own commit was (wrongly) applied to main too.
    await execGit(['cherry-pick', agentTip], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    // HEAD moved 2, but only 1 is stranded — the recovery prose quotes the
    // stranded count, not the movement.
    expect(verdict.commitCount).toBe(2);
    expect(verdict.unpushedCount).toBe(1);
    expect(verdict.suggestedFix).toContain('1 commit ');
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
  });

  it('advises checkout, not reset, for a branch switch that stranded nothing', async () => {
    await addOrigin();
    await execGit(['push', 'origin', 'main:someone-elses-branch'], repo);
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', 'someone-elses-branch', '--track', 'origin/someone-elses-branch'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline);
    expect(verdict.drifted).toBe(true);
    expect(verdict.unpushedCount).toBe(0);
    expect(verdict.suggestedFix).toContain(`git -C ${repo} checkout main`);
    expect(verdict.suggestedFix).not.toContain('reset --hard');
  });

  it('reports an attributed commit on a branch with no upstream to clear it against', async () => {
    // No `origin` at all: an unpushed commit is unreviewed by definition, so the
    // guard must not go quiet just because it cannot compare against an upstream —
    // it attributes against the run baseline instead. The commit IS the agent's.
    const agentBranch = 'cos/task-x/agent-y';
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', agentBranch], repo);
    await commit('branch jacked, nowhere to push');
    await execGit(['checkout', 'main'], repo);
    await execGit(['merge', '--ff-only', agentBranch], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch });
    expect(verdict.drifted).toBe(true);
    expect(verdict.unpushedCount).toBeNull();
    expect(verdict.commitCount).toBe(1);
  });

  it('reports no drift when there is nothing to check', async () => {
    expect(await detectPrimaryCheckoutDrift(null)).toEqual({ drifted: false });
    expect(await detectPrimaryCheckoutDrift({ path: repo })).toEqual({ drifted: false });
    // A checkout that vanished mid-run verified nothing, so it must not
    // manufacture a failure.
    const baseline = await capturePrimaryCheckoutState(repo);
    await rm(repo, { recursive: true, force: true });
    expect(await detectPrimaryCheckoutDrift(baseline)).toEqual({ drifted: false });
  });

  it('fails OPEN (unattributed, not a failure) when the stranded count is unresolvable', async () => {
    // A pruned/rewritten baseline commit or a wedged git leaves the stranded count
    // null — a check that could not run. Attribution cannot confirm the agent
    // authored anything, so the guard surfaces the movement without manufacturing a
    // failure out of it (the module's fail-open contract).
    const baseline = { path: repo, branch: 'main', head: 'f'.repeat(40) };
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/task-x/agent-y' });
    expect(verdict.drifted).toBe(false);
    expect(verdict.unattributed).toBe(true);
    expect(verdict.commitCount).toBeNull();
    expect(verdict.message).toContain('commit count unresolved');
  });
});

describe('prose helpers', () => {
  const baseline = { path: '/example/repo', branch: 'main', head: 'a'.repeat(40) };
  const current = { path: '/example/repo', branch: 'main', head: 'b'.repeat(40) };

  it('singularizes a one-commit drift', () => {
    expect(formatDriftMessage({ baseline, current, commitCount: 1 })).toContain('(1 new commit)');
    expect(formatDriftRecovery({ current, commitCount: 1, agentBranch: null })).toContain('1 commit ');
  });

  it('never tells the user PortOS already fixed it', () => {
    const fix = formatDriftRecovery({ current, commitCount: 3, agentBranch: 'claim/issue-3680' });
    expect(fix).toContain('DISCARDS');
    expect(fix).toContain('PortOS will not run it for you');
  });
});
