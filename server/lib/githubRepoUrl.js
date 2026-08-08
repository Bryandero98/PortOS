/**
 * GitHub repository URL parsing — AUTHORITATIVE copy.
 *
 * Answers "is this URL a GitHub repo we can clone, and which owner/repo is it?"
 * Lives in `lib/` (not `services/githubCloner.js`, which re-exports it) because
 * the Brain capture boxes have to preview the same answer BEFORE submitting: a
 * capture that is a bare GitHub repo URL gets cloned, and the client only offers
 * the post-clone agent options (malware scan / learn-from-repo) when it agrees
 * with the server about what counts as a repo.
 *
 * The client mirror is `client/src/lib/githubRepoUrl.js`; parity is enforced by
 * `server/lib/githubRepoUrl.mirror.test.js`. Port any change to both.
 */

// SSH remote: git@github.com:owner/repo(.git)
const SSH_REPO_RE = /^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i;

// HTTPS or scheme-less: [https://]github.com/owner/repo[.git][/...]
const HTTPS_REPO_RE = /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/?#]+)/i;

/**
 * Parse a GitHub URL into `{ owner, repo, isGitHub }`, or null when the URL
 * isn't a GitHub repository.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, isGitHub: true } | null}
 */
export function parseGitHubUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();

  const ssh = normalized.match(SSH_REPO_RE);
  if (ssh) return { owner: ssh[1], repo: ssh[2], isGitHub: true };

  const https = normalized.match(HTTPS_REPO_RE);
  if (https) return { owner: https[1], repo: https[2].replace(/\.git$/, ''), isGitHub: true };

  return null;
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
