/**
 * Git repository URL parsing — MIRROR of `server/lib/repoUrl.js`
 * (authoritative there).
 *
 * The Brain capture boxes preview what the server will do with a bare URL: a
 * github.com / gitlab.com repo gets cloned, which unlocks the post-clone agent
 * options (malware scan / learn-from-repo). A looser client offers those options
 * for a URL the server files as a plain bookmark; a tighter one hides them for a
 * repo that will in fact be cloned.
 *
 * Port any change from the server copy verbatim; parity is enforced by
 * `server/lib/repoUrl.mirror.test.js`.
 */

// The host allowlist. `provider` is the stable id stored on a link record
// (`repoHost` holds the hostname itself), so adding a host here is the only
// change needed to clone from it — everything downstream is host-generic.
export const REPO_HOSTS = Object.freeze({
  'github.com': 'github',
  'gitlab.com': 'gitlab',
});

// The owner/repo pair is a PATH OPERAND, not just a label: the cloner clones
// into `join(reposDir, …owner, repo)` and the resulting `localPath` is later
// handed to an agent as the directory to scan/study. So every segment is
// matched against the character sets the hosts actually allow, NOT "anything
// but a slash" — the loose form parsed `https://github.com/../evil` as owner
// `..`, which resolves OUTSIDE the managed clone root.
//   owner: a login (or a GitLab group/subgroup) — alphanumeric with internal
//          hyphens, no dots, so no segment can ever be `.` or `..`
//   repo:  alphanumerics plus `_`, `.`, `-`
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

// `REPO_RE`'s character class admits the dot segments `.` and `..`, which would
// escape (or collapse to) the clone root the same way a bad owner does. The
// owner pattern already rejects them by requiring a leading alphanumeric.
const DOT_SEGMENTS = new Set(['.', '..']);

// SSH remote: git@host:path (optionally `ssh://git@host/path`).
const SSH_RE = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](\S+)$/i;

// Any scheme (or none), optional userinfo: host[:port][/path]. Anchored at the
// host so `https://evil.com/github.com/o/r` is NOT read as a GitHub repo, and
// whitespace-free end-to-end so `github.com/a b/c` is rejected outright.
const HTTP_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^/@\s]+@)?([^/?#\s]+)(\/\S*)?$/;

// Path words that begin a host's own UI route rather than another namespace
// segment. GitLab's modern deep links use the `/-/` separator (handled
// separately), but its legacy links — and every GitHub deep link — put the
// route word directly after the project, so the segment walk stops here.
const RESERVED_PATH_SEGMENTS = new Set([
  'tree', 'blob', 'raw', 'commit', 'commits', 'compare', 'branches', 'tags',
  'releases', 'issues', 'pull', 'pulls', 'merge_requests', 'wiki', 'wikis',
  'actions', 'pipelines', 'settings', 'activity', 'network', 'graphs', 'blame',
]);

/**
 * Parse a repository URL into `{ host, provider, owner, repo, isGitHub }`, or
 * null when the URL isn't a repository on a supported host (or names a
 * path-unsafe owner/repo).
 *
 * `owner` is a single login on GitHub and may be a `group/subgroup` path on
 * GitLab; every one of its segments is validated, so it stays path-safe.
 *
 * @param {string} url
 * @returns {{ host: string, provider: string, owner: string, repo: string, isGitHub: boolean } | null}
 */
export function parseRepoUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();

  const match = normalized.match(SSH_RE) || normalized.match(HTTP_RE);
  if (!match) return null;

  const host = match[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const provider = REPO_HOSTS[host];
  if (!provider) return null;

  // Drop the query/hash, then GitLab's `/-/` deep-link separator, then walk the
  // remaining segments until a host UI route word.
  let path = (match[2] || '').split(/[?#]/)[0].replace(/^\//, '');
  const dashIndex = path.indexOf('/-/');
  if (dashIndex !== -1) path = path.slice(0, dashIndex);

  const segments = [];
  for (const segment of path.split('/')) {
    if (!segment) continue;
    if (RESERVED_PATH_SEGMENTS.has(segment.toLowerCase())) break;
    segments.push(segment);
  }
  if (segments.length < 2) return null;

  // GitHub has no subgroups: anything past owner/repo is a deep link. GitLab
  // nests groups arbitrarily, so everything before the last segment is the
  // namespace.
  const ownerSegments = provider === 'github' ? segments.slice(0, 1) : segments.slice(0, -1);
  const repo = (provider === 'github' ? segments[1] : segments[segments.length - 1])
    .replace(/\.git$/i, '');

  if (!ownerSegments.every(segment => OWNER_RE.test(segment))) return null;
  if (!repo || DOT_SEGMENTS.has(repo) || !REPO_RE.test(repo)) return null;

  return {
    host,
    provider,
    owner: ownerSegments.join('/'),
    repo,
    isGitHub: provider === 'github',
  };
}

/**
 * True when the URL points at a repository on a supported host.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isRepoUrl(url) {
  return parseRepoUrl(url) !== null;
}

/**
 * Parse a URL only when it is a GitHub repository. The GitHub-only callers are
 * the ones whose downstream really is GitHub-specific (the Eidoverse worlds
 * repo, which is pushed to with a GitHub token), NOT the Brain's repo capture.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, isGitHub: true } | null}
 */
export function parseGitHubUrl(url) {
  const parsed = parseRepoUrl(url);
  return parsed?.isGitHub ? { owner: parsed.owner, repo: parsed.repo, isGitHub: true } : null;
}

/**
 * True when the URL points at a GitHub repository specifically.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isGitHubRepoUrl(url) {
  return parseGitHubUrl(url) !== null;
}
