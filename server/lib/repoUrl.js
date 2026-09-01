/**
 * Git repository URL parsing — AUTHORITATIVE copy.
 *
 * Answers "is this URL a repository we can clone, and which host/owner/repo is
 * it?" for the hosts PortOS clones from: github.com and gitlab.com. Lives in
 * `lib/` (not `services/repoCloner.js`, which re-exports it) because the Brain
 * capture boxes have to preview the same answer BEFORE submitting: a capture
 * that is a bare repo URL gets cloned, and the client only offers the post-clone
 * agent options (malware scan / learn-from-repo) when it agrees with the server
 * about what counts as a repo.
 *
 * The client mirror is `client/src/lib/repoUrl.js`; parity is enforced by
 * `server/lib/repoUrl.mirror.test.js`. Port any change to both.
 */

// The host allowlist, and the two behaviors that actually differ between hosts.
// They live IN the table rather than as `host === 'github.com'` branches further
// down, so adding a host is one entry here and nothing else — and so each flag
// has to be decided deliberately for the new host rather than inherited from
// whichever existing host the branch happened to compare against.
//
//   provider          stable id stored on a link record (`repoHost` holds the
//                     hostname itself)
//   nestedNamespaces  the host nests groups arbitrarily (GitLab subgroups), so
//                     everything before the last path segment is the namespace.
//                     GitHub has no subgroups: anything past owner/repo is a
//                     deep link.
//   flatClonePath     LEGACY CARVE-OUT — clone to `<owner>/<repo>` with no
//                     hostname level, so clones made before PortOS supported a
//                     second host stay exactly where their link record says they
//                     are. Never set this for a newly added host.
export const REPO_HOSTS = Object.freeze({
  'github.com': { provider: 'github', nestedNamespaces: false, flatClonePath: true },
  'gitlab.com': { provider: 'gitlab', nestedNamespaces: true, flatClonePath: false },
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
 * Parse a repository URL into `{ host, provider, owner, repo }`, or null when
 * the URL isn't a repository on a supported host (or names a path-unsafe
 * owner/repo).
 *
 * `owner` is a single login on GitHub and may be a `group/subgroup` path on
 * GitLab; every one of its segments is validated, so it stays path-safe.
 *
 * @param {string} url
 * @returns {{ host: string, provider: string, owner: string, repo: string } | null}
 */
export function parseRepoUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();

  const match = normalized.match(SSH_RE) || normalized.match(HTTP_RE);
  if (!match) return null;

  const host = match[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const hostConfig = REPO_HOSTS[host];
  if (!hostConfig) return null;

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

  const ownerSegments = hostConfig.nestedNamespaces ? segments.slice(0, -1) : segments.slice(0, 1);
  const repo = (hostConfig.nestedNamespaces ? segments[segments.length - 1] : segments[1])
    .replace(/\.git$/i, '');

  if (!ownerSegments.every(segment => OWNER_RE.test(segment))) return null;
  if (!repo || DOT_SEGMENTS.has(repo) || !REPO_RE.test(repo)) return null;

  return {
    host,
    provider: hostConfig.provider,
    owner: ownerSegments.join('/'),
    repo,
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
 * The `https` clone URL for a parsed repo.
 *
 * @param {{ host: string, owner: string, repo: string }} parsed
 * @returns {string}
 */
export function repoCloneUrl({ host, owner, repo }) {
  return `https://${host}/${owner}/${repo}.git`;
}

/**
 * The browsable web URL for a parsed repo — what to `href` when a record stores
 * the scp-style SSH remote a browser can't follow.
 *
 * @param {{ host: string, owner: string, repo: string }} parsed
 * @returns {string}
 */
export function repoBrowseUrl({ host, owner, repo }) {
  return `https://${host}/${owner}/${repo}`;
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
  return parsed?.provider === 'github' ? { owner: parsed.owner, repo: parsed.repo, isGitHub: true } : null;
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
