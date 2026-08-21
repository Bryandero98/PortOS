/**
 * Pure comparison between the BUNDLE this browser loaded and the SERVER build it
 * is talking to (#4694).
 *
 * The failure this catches: the dashboard is served from a `client/dist` built
 * from one commit while `portos-server` was restarted from a different checkout
 * at a different commit. Both halves look perfectly healthy, so a UI change that
 * "isn't working" can be a UI that was never rebuilt. Why `version` can't answer
 * this, and how it differs from the bundle-hash check: see the module header of
 * `server/lib/buildIdentity.js`.
 */

/**
 * The `__BUILD_STAMP__` Vite define, or null where it does not exist (vitest,
 * or any consumer rendered without the bundler).
 *
 * Read through `typeof` — a bare reference to an undefined define throws a
 * ReferenceError at module load rather than degrading. Resolved once at module
 * scope so the value has a stable identity: it is a compile-time constant, and
 * re-evaluating the define per render would hand a fresh object to every
 * `useMemo`/`React.memo` dependency list that ever includes it.
 */
export const BUNDLE_STAMP = typeof __BUILD_STAMP__ === 'undefined' ? null : __BUILD_STAMP__;

/**
 * The build id the server stamped into the served index.html, or null.
 *
 * Null means the page did NOT come from a built `client/dist` — i.e. `npm run
 * dev`, where Vite serves its own index.html and the server never injects the
 * meta tag. That is the single gate for trusting `BUNDLE_STAMP` at all: the
 * Vite define is frozen when the dev server starts, so under HMR it reports the
 * commit you started at while serving code from every commit since. Anything
 * that displays or compares the bundle stamp must check this first.
 */
export const SERVED_BUILD_ID = (() => {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="portos-build-id"]');
  return el ? el.getAttribute('content') : null;
})();

/** The bundle stamp only when it can be trusted — see `SERVED_BUILD_ID`. */
export const TRUSTED_BUNDLE_STAMP = SERVED_BUILD_ID ? BUNDLE_STAMP : null;

/**
 * Trim a stamp field to a usable value, or null. Both halves of the feature emit
 * `null` for "not known", so this only has to reject blanks and non-strings —
 * never a placeholder string, which would swallow a branch that genuinely
 * carries that name.
 */
function normalizeStamp(value) {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

// Commits compare case-insensitively; branch names do not.
const normalizeCommit = (value) => normalizeStamp(value)?.toLowerCase() ?? null;

/**
 * Compare a bundle stamp against the server's build identity.
 *
 * @param {{commit?: string|null, branch?: string|null, builtAt?: string}|null|undefined} bundle
 * @param {{commit?: string|null, shortCommit?: string|null, branch?: string|null, dirty?: boolean|null}|null|undefined} server
 * @returns {{state: 'match'|'mismatch'|'unknown', bundleCommit: string|null, serverCommit: string|null}}
 *   `serverCommit` is the short form when the server sent one, for display.
 */
export function compareBuildStamps(bundle, server) {
  const bundleCommit = normalizeCommit(bundle?.commit);
  const serverCommit = normalizeCommit(server?.shortCommit) ?? normalizeCommit(server?.commit);

  // Absent on either side is `unknown` — never `match` (which would claim a
  // verification nobody performed) and never `mismatch` (which would cry wolf
  // on every source-tarball install).
  if (!bundleCommit || !serverCommit) {
    return { state: 'unknown', bundleCommit, serverCommit };
  }

  // Prefix comparison, not equality: the bundle carries a 7-char commit while
  // the server may only have sent the full sha, and those are never equal.
  const same = bundleCommit.startsWith(serverCommit) || serverCommit.startsWith(bundleCommit);
  return { state: same ? 'match' : 'mismatch', bundleCommit, serverCommit };
}

/**
 * One-line human summary of a build — `abc1234 · main · uncommitted changes`.
 * Returns null when there is nothing worth rendering, so a caller can drop the
 * row entirely instead of printing a line of em-dashes.
 */
export function describeBuild({ commit, branch, dirty } = {}) {
  const parts = [];
  const shortCommit = normalizeStamp(commit);
  if (shortCommit) parts.push(shortCommit.slice(0, 7));
  const cleanBranch = normalizeStamp(branch);
  if (cleanBranch) parts.push(cleanBranch);
  // Only `true` earns a badge: `null` means the check itself did not run, and
  // rendering that as "clean" would be a claim we cannot make. The server's
  // `dirty` is a boot-time snapshot, so the caller labels it as such.
  if (dirty === true) parts.push('uncommitted changes');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Decide what a `build:id` socket frame means for THIS tab (#4694).
 *
 * Two different staleness problems arrive on one frame, and they have different
 * remedies — conflating them tells the user to do something that cannot work:
 *
 *   `'reload'` — the bundle on disk moved since this tab loaded. Reloading picks
 *     up the new one.
 *   `'drift'`  — this tab IS current with the dist on disk, but that dist was
 *     built from a different commit than the server is running. Reloading
 *     re-serves the same stale dist and changes nothing; it needs a rebuild or a
 *     server restart.
 *   `null`     — nothing to say.
 *
 * `embeddedBuildId` is null under `npm run dev` (Vite serves its own index.html,
 * so the server never injects the build-id meta tag). That is the gate for BOTH
 * checks: in dev there is no dist to be stale, and the Vite define is frozen at
 * dev-server start, so a drift check there would fire the moment you commit.
 *
 * @returns {'reload'|'drift'|null}
 */
export function resolveBuildFrame({ buildId, commit } = {}, { embeddedBuildId, bundle = BUNDLE_STAMP } = {}) {
  if (!buildId || !embeddedBuildId) return null;
  if (buildId !== embeddedBuildId) return 'reload';
  return compareBuildStamps(bundle, { commit }).state === 'mismatch' ? 'drift' : null;
}
