/**
 * The repository metadata a Brain link carries, and the compatibility shim that
 * keeps it readable across PortOS versions.
 *
 * The fields used to be GitHub-only (`isGitHubRepo` / `gitHubOwner` /
 * `gitHubRepo`). They are now host-generic (`isRepo` / `repoHost` / `repoOwner`
 * / `repoName`) so gitlab.com repos are first-class, and migration 328 rewrites
 * every stored link.
 *
 * PortOS is DISTRIBUTED and brain links FEDERATE verbatim between peers, so a
 * rename alone would break a mixed-version tailnet in both directions. Hence:
 *
 *   - `deriveRepoLinkFields` writes BOTH shapes, so a peer still on the old code
 *     keeps recognising a captured GitHub repo. A gitlab.com repo is written
 *     with `isGitHubRepo: false` on purpose — an old peer must file it as a
 *     plain bookmark rather than hand a GitLab URL to a GitHub-only cloner.
 *   - `normalizeRepoLinkFields` fills the new shape from the legacy one on READ,
 *     so a record arriving from an old peer (or written before the migration
 *     ran) still reads as a repo.
 */

import { parseRepoUrl } from './repoUrl.js';

/** Host assumed for a legacy record, whose fields could only ever be GitHub's. */
const LEGACY_REPO_HOST = 'github.com';

/**
 * The repo fields for a captured URL — new shape plus the legacy mirror.
 *
 * @param {string} url
 * @returns {{ isRepo: boolean, repoHost: string|null, repoOwner: string|null,
 *   repoName: string|null, isGitHubRepo: boolean, gitHubOwner: string|null,
 *   gitHubRepo: string|null }}
 */
export function deriveRepoLinkFields(url) {
  const parsed = parseRepoUrl(url);
  return {
    isRepo: Boolean(parsed),
    repoHost: parsed?.host ?? null,
    repoOwner: parsed?.owner ?? null,
    repoName: parsed?.repo ?? null,
    isGitHubRepo: Boolean(parsed?.isGitHub),
    gitHubOwner: parsed?.isGitHub ? parsed.owner : null,
    gitHubRepo: parsed?.isGitHub ? parsed.repo : null,
  };
}

/**
 * Read a link's repo fields, falling back to the legacy GitHub-only shape.
 * Returns the record unchanged when it already carries `isRepo`, so the common
 * (post-migration) path allocates nothing.
 *
 * @template {object|null|undefined} T
 * @param {T} link
 * @returns {T}
 */
export function normalizeRepoLinkFields(link) {
  if (!link || link.isRepo !== undefined) return link;
  if (!link.isGitHubRepo) return link;
  return {
    ...link,
    isRepo: true,
    repoHost: LEGACY_REPO_HOST,
    repoOwner: link.gitHubOwner ?? null,
    repoName: link.gitHubRepo ?? null,
  };
}

/**
 * True when a link record (either shape) names a cloneable repository.
 *
 * @param {object|null|undefined} link
 * @returns {boolean}
 */
export const linkIsRepo = (link) => Boolean(link?.isRepo ?? link?.isGitHubRepo);

/**
 * `owner/repo` for a link record (either shape), else its display title.
 *
 * @param {object|null|undefined} link
 * @returns {string}
 */
export function repoLinkLabel(link) {
  const owner = link?.repoOwner ?? link?.gitHubOwner;
  const repo = link?.repoName ?? link?.gitHubRepo;
  return owner && repo ? `${owner}/${repo}` : (link?.title || link?.url || 'unknown repo');
}
