/**
 * Pure comparison between the BUNDLE this browser loaded and the SERVER build it
 * is talking to (#4694).
 *
 * The failure this catches: the dashboard is served from a `client/dist` built
 * from one commit while `portos-server` was restarted from a different checkout
 * at a different commit. Both halves look perfectly healthy, so a UI change that
 * "isn't working" can be a UI that was never rebuilt — an entire debugging
 * session spent judging code that was not running.
 *
 * Distinct from the socket's build-id check (`server/lib/buildId.js`), which
 * compares the browser's loaded bundle against the bundle on disk RIGHT NOW.
 * That answers "should I reload?"; this answers "was this bundle built from the
 * same commit the API is running?" — a rebuild-and-restart mismatch the id hash
 * cannot see, because both sides agree on a `dist/` that is simply old.
 */

// `__BUILD_STAMP__` is a Vite define, so it is absent under vitest and in any
// consumer that renders these helpers without the bundler. Every unknown input
// resolves to `state: 'unknown'` — never to `'match'` (which would claim a
// verification we did not perform) and never to `'mismatch'` (which would cry
// wolf on every dev run).
const UNKNOWN = 'unknown';

function normalizeCommit(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  // '' and the literal 'unknown' placeholder both mean "not known". Collapsing
  // them to null keeps absent from ever comparing equal-or-unequal to a real
  // commit (root CLAUDE.md's absent-vs-empty rule).
  if (trimmed === '' || trimmed === UNKNOWN) return null;
  return trimmed;
}

/**
 * Compare a bundle stamp against the server's build identity.
 *
 * @param {{commit?: string, branch?: string, builtAt?: string}|null|undefined} bundle
 *   The `__BUILD_STAMP__` define, or null/undefined when unavailable.
 * @param {{commit?: string|null, shortCommit?: string|null, branch?: string|null, dirty?: boolean|null}|null|undefined} server
 *   The `build` block from GET /api/system/health/details.
 * @returns {{state: 'match'|'mismatch'|'unknown', bundleCommit: string|null, serverCommit: string|null}}
 *   `bundleCommit` / `serverCommit` are the SHORT forms, for display.
 */
export function compareBuildStamps(bundle, server) {
  const bundleCommit = normalizeCommit(bundle?.commit);
  // The server sends both forms; the bundle only ever has the short one, so the
  // comparison is done on a common prefix rather than on full-vs-short (which
  // would never be equal).
  const serverCommit = normalizeCommit(server?.shortCommit) ?? normalizeCommit(server?.commit);

  if (!bundleCommit || !serverCommit) {
    return { state: UNKNOWN, bundleCommit, serverCommit };
  }

  const width = Math.min(bundleCommit.length, serverCommit.length);
  const same = bundleCommit.slice(0, width) === serverCommit.slice(0, width);
  return { state: same ? 'match' : 'mismatch', bundleCommit, serverCommit };
}

/**
 * One-line human summary of a build identity — `abc1234 · main · dirty`.
 * Returns null when there is nothing worth rendering, so a caller can drop the
 * row entirely instead of printing a line of em-dashes.
 */
export function describeBuild({ commit, branch, dirty } = {}) {
  const shortCommit = normalizeCommit(commit);
  const parts = [];
  if (shortCommit) parts.push(shortCommit.slice(0, 7));
  const cleanBranch = typeof branch === 'string' && branch.trim() && branch.trim().toLowerCase() !== UNKNOWN
    ? branch.trim()
    : null;
  if (cleanBranch) parts.push(cleanBranch);
  // Only `true` earns a badge: `null` means the check itself did not run, and
  // rendering that as "clean" would be a claim we cannot make.
  if (dirty === true) parts.push('uncommitted changes');
  return parts.length > 0 ? parts.join(' · ') : null;
}
