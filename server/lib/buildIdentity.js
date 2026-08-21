/**
 * Build identity of the RUNNING install — which git commit this process was
 * started from (#4694).
 *
 * The hazard this closes: one PM2-managed `portos-server` serves :5555 for the
 * whole machine while any number of worktrees (CoS agents, `/do:next` claims,
 * the primary checkout) hold different code. Anyone verifying a change by
 * hitting the running instance is, by default, observing whatever build PM2
 * last started, from whatever checkout, at whatever commit — and nothing in the
 * responses said so. `version` can't answer it: by project rule package.json's
 * version reflects the last RELEASE and is identical across every development
 * commit and every worktree.
 *
 * Distinct from `buildId.js`, which hashes `client/dist/index.html` to detect a
 * browser holding a stale BUNDLE relative to what is on disk right now. That
 * hash says nothing about which commit either side was built from: a `dist/`
 * built three days ago and one built this minute are both "current" to buildId
 * as long as the browser matches the file. This module answers the other half —
 * WHICH CODE is up — and the two are complementary, not redundant.
 *
 * Privacy: commit / branch / dirty / timestamp only. No absolute paths (they
 * embed the OS username), no hostname, no checkout directory — see the
 * Sensitive Data section of the root CLAUDE.md.
 */

import { execGit } from './execGit.js';
import { PATHS } from './fileUtils.js';

// `PATHS.root` is CODE_ROOT — the checkout this process's code was loaded
// from, which is exactly the question being asked. Deliberately NOT
// `installRoot`: under a worktree boot (PORTOS_DATA_ROOT, #1947) the data tree
// and the code tree diverge, and the commit that matters is the code's.
const CODE_ROOT = PATHS.root;

// Probe-shaped git calls, per the house convention (`gitCommitProbe.js`):
// `ignoreExitCode` so a non-repo resolves to a readable non-zero exit rather
// than rejecting, and a short `timeout` so a git wedged on a locked index or a
// slow network mount can't hold boot (or a health request) open for execGit's
// 30s default.
const GIT_TIMEOUT_MS = 5000;

/**
 * Run one probe-shaped git command and return its trimmed stdout, or null.
 * Every failure mode — missing `.git`, broken checkout, timeout, non-zero exit,
 * empty output — collapses to `null`, never `''`. An empty-string commit reads
 * downstream as "a commit whose value is blank" and would compare unequal to
 * every real commit, silently reporting a false mismatch; `null` says "not
 * known" (root CLAUDE.md's absent-vs-empty rule).
 */
async function gitProbe(args) {
  const result = await execGit(args, CODE_ROOT, {
    ignoreExitCode: true,
    timeout: GIT_TIMEOUT_MS
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

let cached = null;

/**
 * Resolve the running build's git identity. Cached for the life of the process:
 * the code a running process loaded cannot change under it, so re-probing git
 * on every health request would spend three subprocesses to re-learn a constant.
 * (`dirty` CAN change on disk — but it describes the tree the process booted
 * from, and a mid-run edit is not code this process is executing.)
 *
 * Non-throwing. Every field is independently nullable: a tarball install with
 * no `.git`, a detached checkout, or a git timeout reports `commit: null`
 * rather than a fabricated or empty value.
 *
 * @returns {Promise<{commit: string|null, shortCommit: string|null, branch: string|null, dirty: boolean|null, builtAt: string}>}
 */
export async function getBuildIdentity() {
  if (cached) return cached;

  const [commit, branch, status] = await Promise.all([
    gitProbe(['rev-parse', 'HEAD']),
    // `--abbrev-ref HEAD` prints the literal string `HEAD` on a detached
    // checkout, which is not a branch name. Report that as null rather than
    // handing the UI a branch called "HEAD".
    gitProbe(['rev-parse', '--abbrev-ref', 'HEAD']),
    // `--porcelain` prints one line per changed path and NOTHING when clean —
    // so a clean tree trims to '' and `gitProbe` returns null, which is
    // indistinguishable from a failed probe. That ambiguity is why dirty is
    // resolved from the raw result below instead of through `gitProbe`.
    execGit(['status', '--porcelain'], CODE_ROOT, {
      ignoreExitCode: true,
      timeout: GIT_TIMEOUT_MS
    }).catch(() => null)
  ]);

  const dirty = status && status.exitCode === 0 ? status.stdout.trim() !== '' : null;

  cached = {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    branch: branch === 'HEAD' ? null : branch,
    dirty,
    // When this process started — the honest reading of "how old is the code
    // that is answering me". Distinct from the client's `__BUILD_STAMP__`,
    // which is stamped when the bundle was built.
    builtAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
  return cached;
}

/**
 * Single-line, human-readable summary for the boot log — `abc1234 (main, dirty)`.
 * Falls back to `unknown` rather than printing an empty parenthetical when git
 * is unavailable.
 */
export function formatBuildIdentity(identity) {
  if (!identity?.shortCommit) return 'unknown (no git metadata)';
  const parts = [identity.branch || 'detached'];
  if (identity.dirty === true) parts.push('dirty');
  if (identity.dirty === null) parts.push('cleanliness unknown');
  return `${identity.shortCommit} (${parts.join(', ')})`;
}

/** Test-only: drop the process-lifetime cache. */
export function resetBuildIdentityCache() {
  cached = null;
}
