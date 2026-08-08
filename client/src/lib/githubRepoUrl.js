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
