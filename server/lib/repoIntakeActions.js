/**
 * The opt-in post-clone agent actions a Brain capture can request for a GitHub
 * repo URL. Pure — the queueing itself lives in `services/repoIntake.js`, which
 * pulls the whole CoS task graph; this half is safe to import from the link
 * write path and from the Zod schemas.
 *
 * `malwareScan` → the read-only `/do:scan` audit of the clone.
 * `learn`       → a `repo-study` review: read the clone for ideas worth adopting
 *                 into PortOS and file them in the work tracker (clean-room).
 */

import { isPlainObject } from './objects.js';

export const REPO_INTAKE_KEYS = ['malwareScan', 'learn'];

/**
 * Normalize a client-supplied intake object to `{ malwareScan, learn }` booleans,
 * or null when nothing was requested.
 *
 * Returning null rather than an all-false object matters: it's what keeps
 * "the user ticked nothing" from being persisted onto every captured link and
 * from scheduling a no-op intake pass after each clone.
 *
 * @param {unknown} input
 * @returns {{ malwareScan: boolean, learn: boolean } | null}
 */
export function normalizeRepoIntake(input) {
  if (!isPlainObject(input)) return null;
  const normalized = Object.fromEntries(REPO_INTAKE_KEYS.map(key => [key, input[key] === true]));
  if (!REPO_INTAKE_KEYS.some(key => normalized[key])) return null;
  if (normalized.learn && typeof input.targetAppId === 'string' && input.targetAppId.trim()) {
    normalized.targetAppId = input.targetAppId.trim();
  }
  return normalized;
}
