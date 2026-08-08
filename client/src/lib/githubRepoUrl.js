/**
 * GitHub repository URL parsing — MIRROR of `server/lib/githubRepoUrl.js`
 * (authoritative there).
 *
 * The Brain capture boxes preview what the server will do with a bare URL: a
 * GitHub repo gets cloned, which unlocks the post-clone agent options (malware
 * scan / learn-from-repo). A looser client offers those options for a URL the
 * server files as a plain bookmark; a tighter one hides them for a repo that
 * will in fact be cloned.
 *
 * Port any change from the server copy verbatim; parity is enforced by
 * `server/lib/githubRepoUrl.mirror.test.js`.
 */

// The owner/repo pair is a PATH OPERAND, not just a label: githubCloner clones
// into `join(reposDir, owner, repo)` and the resulting `localPath` is later
// handed to an agent as the directory to scan/study. So both segments are
// matched against the character sets GitHub actually allows, NOT "anything but
// a slash" — the loose form parsed `https://github.com/../evil` as owner `..`,
// which resolves OUTSIDE the managed clone root.
//   owner: a GitHub login — alphanumeric with internal hyphens, no dots
//   repo:  alphanumerics plus `_`, `.`, `-`
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const REPO = '[A-Za-z0-9_.-]+';

// SSH remote: git@github.com:owner/repo(.git)
const SSH_REPO_RE = new RegExp(`^git@github\\.com:(${OWNER})/(${REPO})$`, 'i');

// Any scheme (or none), optional userinfo, optional www: github.com/owner/repo[.git][/...]
// Anchored at the host so `https://evil.com/github.com/o/r` is NOT read as a
// GitHub repo. `REPO` cannot cross `/`, `?`, or `#`, so a deep link like
// `github.com/o/r/tree/main` still resolves to `o/r`.
const HTTPS_REPO_RE = new RegExp(
  `^(?:[A-Za-z][A-Za-z0-9+.-]*://)?(?:[^/@\\s]+@)?(?:www\\.)?github\\.com/(${OWNER})/(${REPO})`,
  'i',
);

// `REPO`'s character class admits the dot segments `.` and `..`, which would
// escape (or collapse to) the clone root the same way a bad owner does. The
// owner pattern already rejects them by requiring a leading alphanumeric.
const DOT_SEGMENTS = new Set(['.', '..']);

/**
 * Parse a GitHub URL into `{ owner, repo, isGitHub }`, or null when the URL
 * isn't a GitHub repository (or names a path-unsafe owner/repo).
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, isGitHub: true } | null}
 */
export function parseGitHubUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();

  const match = normalized.match(SSH_REPO_RE) || normalized.match(HTTPS_REPO_RE);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!repo || DOT_SEGMENTS.has(repo)) return null;

  return { owner, repo, isGitHub: true };
}

/**
 * True when the URL points at a GitHub repository.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isGitHubRepoUrl(url) {
  return parseGitHubUrl(url) !== null;
}
