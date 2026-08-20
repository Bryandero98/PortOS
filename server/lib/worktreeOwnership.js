/**
 * Worktree ownership — the one policy for whether PortOS may move or remove a
 * worktree.
 *
 * Worktree operations are destructive: adoption moves a directory and reapers
 * remove one. The callers therefore share this pure gate instead of carrying
 * slightly different copies of "managed root, agent id, claim, liveness, lock".
 * Callers can explicitly opt into the differences that are intentional: a
 * reaper may include `.claude/worktrees/`, and stale claims may be reclaimed
 * only by branch reconciliation.
 */

import { win32 } from 'path';
import { isPathInsideDir } from './fileUtils.js';

/** Directory basename from either POSIX or Windows git worktree output. */
export function worktreeAgentId(worktreePath) {
  return win32.basename(worktreePath || '');
}

/** True for a worktree owned by the human `/claim` lifecycle. */
export function isHumanClaimWorktree(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('claim-');
}

/** True for the directory naming convention exclusively owned by CoS agents. */
export function isAgentWorktreeId(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('agent-');
}

function normalizedRoots(roots) {
  return (Array.isArray(roots) ? roots : [])
    .filter((root) => typeof root?.path === 'string' && root.path);
}

/**
 * Why PortOS must leave a worktree alone, or null when this caller may handle it.
 *
 * `roots` is an explicit allowlist. Each root may opt into arbitrary directory
 * names with `{ path, requireAgentId: false }`, which is how the safe merged-tree
 * reaper can include `.claude/worktrees/` without weakening the CoS-agent root.
 * `requireKnownLiveness` fails closed for `agent-*` trees when an authoritative
 * `Set` of live agents is unavailable.
 *
 * @param {{
 *   path?: string,
 *   locked?: boolean,
 *   activeAgentIds?: Set<string>,
 *   roots?: Array<{path:string, requireAgentId?:boolean}>,
 *   requireAgentId?: boolean,
 *   allowStaleClaim?: boolean,
 *   ageMs?: number|null,
 *   staleClaimIdleMs?: number,
 *   requireKnownLiveness?: boolean,
 * }} options
 * @returns {string|null}
 */
export function worktreeOwnershipReason({
  path,
  locked = false,
  activeAgentIds,
  roots = [],
  requireAgentId = false,
  allowStaleClaim = false,
  ageMs = null,
  staleClaimIdleMs,
  requireKnownLiveness = false,
} = {}) {
  if (!path) return 'worktree-missing-path';

  const configuredRoots = normalizedRoots(roots);
  const root = configuredRoots.find((candidate) => isPathInsideDir(candidate.path, path));
  if (configuredRoots.length > 0 && !root) return 'worktree-unmanaged-location';

  const agentId = worktreeAgentId(path);
  if (isHumanClaimWorktree(agentId)) {
    const stale = allowStaleClaim
      && typeof ageMs === 'number'
      && typeof staleClaimIdleMs === 'number'
      && ageMs >= staleClaimIdleMs;
    if (!stale) return 'worktree-human-claim';
  }

  const mustBeAgentWorktree = root?.requireAgentId ?? requireAgentId;
  if (mustBeAgentWorktree && !isAgentWorktreeId(agentId)) return 'worktree-missing-agent-id';
  if (locked) return 'worktree-locked';
  if (activeAgentIds instanceof Set && activeAgentIds.has(agentId)) return 'worktree-active-agent';
  if (requireKnownLiveness && isAgentWorktreeId(agentId) && !(activeAgentIds instanceof Set)) {
    return 'worktree-agent-liveness-unknown';
  }
  return null;
}

/**
 * When a hold reported by `worktreeOwnershipReason` lifts on its OWN, as an ISO
 * instant — or null when only an outside change can clear it.
 *
 * Lives here, next to the gate, because the expiry is the same policy as the
 * hold: the stale-claim window (`ageMs >= staleClaimIdleMs`) is the one gate keyed
 * to a clock, so this is the only module that can name the deadline without
 * re-deriving it from a returned slug. A lock, a live agent, and unknown
 * liveness all end at times nothing here can predict.
 *
 * The slug alone is not enough to answer this, which is the other reason it
 * belongs here: a claim worktree that is ALSO locked reports
 * `worktree-human-claim` (first match wins), and its hold does NOT lift when the
 * claim window lapses. So the window is re-asked with the deadline already
 * crossed, and only a tree that comes back free gets an expiry.
 *
 * Pure. Takes the same options object as `worktreeOwnershipReason`.
 * @param {object} [options] - plus `nowMs` for the clock
 * @returns {string|null} ISO timestamp
 */
export function worktreeHoldExpiresAt({ nowMs = Date.now(), ...options } = {}) {
  const { ageMs, staleClaimIdleMs } = options;
  if (worktreeOwnershipReason(options) !== 'worktree-human-claim') return null;
  if (!Number.isFinite(ageMs) || !Number.isFinite(staleClaimIdleMs)) return null;
  const remaining = staleClaimIdleMs - ageMs;
  if (remaining <= 0) return null;
  if (worktreeOwnershipReason({ ...options, ageMs: staleClaimIdleMs }) !== null) return null;
  return new Date(nowMs + remaining).toISOString();
}
