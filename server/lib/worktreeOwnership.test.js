import { describe, expect, it } from 'vitest';
import { isAgentWorktreeId, isHumanClaimWorktree, worktreeAgentId, worktreeHoldExpiresAt, worktreeOwnershipReason } from './worktreeOwnership.js';

describe('worktree ownership', () => {
  const COS_ROOT = '/repo/data/cos/worktrees';

  it('permits only an inactive, unlocked CoS agent tree under the configured root', () => {
    const options = {
      roots: [{ path: COS_ROOT, requireAgentId: true }],
      activeAgentIds: new Set(),
      requireKnownLiveness: true,
    };
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/agent-dead` })).toBeNull();
    expect(worktreeOwnershipReason({ ...options, path: '/repo/elsewhere/agent-dead' })).toBe('worktree-unmanaged-location');
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/next-issue-42` })).toBe('worktree-missing-agent-id');
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/agent-live`, activeAgentIds: new Set(['agent-live']) }))
      .toBe('worktree-active-agent');
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/agent-locked`, locked: true })).toBe('worktree-locked');
  });

  it('keeps human claims unless the stale-claim caller explicitly permits reclamation', () => {
    const input = { path: `${COS_ROOT}/claim-issue-42`, ageMs: 8_000, staleClaimIdleMs: 7_000 };
    expect(worktreeOwnershipReason(input)).toBe('worktree-human-claim');
    expect(worktreeOwnershipReason({ ...input, allowStaleClaim: true })).toBeNull();
  });

  it('releases a completed claim at any age, but keeps an explicit lock', () => {
    // The grace window guards a claim session that may still be working. A claim
    // the caller has proven complete has no such session, so it must not wait it
    // out — that wait is what parked finished claims for a week.
    const fresh = { path: `${COS_ROOT}/claim-issue-42`, ageMs: 60_000, staleClaimIdleMs: 7 * 24 * 60 * 60 * 1000, allowStaleClaim: true };
    expect(worktreeOwnershipReason(fresh)).toBe('worktree-human-claim');
    expect(worktreeOwnershipReason({ ...fresh, claimComplete: true })).toBeNull();
    // Unknown age no longer blocks it either — completion is proof, age is a proxy.
    expect(worktreeOwnershipReason({ ...fresh, ageMs: null, claimComplete: true })).toBeNull();
    // A lock is a deliberate human hold and still outranks completion.
    expect(worktreeOwnershipReason({ ...fresh, claimComplete: true, locked: true })).toBe('worktree-locked');
    // Completion says nothing about agent trees — they keep their own gates.
    expect(worktreeOwnershipReason({
      path: `${COS_ROOT}/agent-live`, claimComplete: true, activeAgentIds: new Set(['agent-live'])
    })).toBe('worktree-active-agent');
  });

  it('fails closed when agent liveness is unknown and permits an explicitly non-agent root', () => {
    expect(worktreeOwnershipReason({
      path: `${COS_ROOT}/agent-unknown`,
      requireAgentId: true,
      requireKnownLiveness: true,
    })).toBe('worktree-agent-liveness-unknown');
    expect(worktreeOwnershipReason({
      path: '/repo/.claude/worktrees/review-fix',
      roots: [{ path: '/repo/.claude/worktrees', requireAgentId: false }],
      activeAgentIds: new Set(),
      requireKnownLiveness: true,
    })).toBeNull();
  });

  it('uses one separator-safe namespace definition', () => {
    expect(worktreeAgentId('H:/repo/data/cos/worktrees/agent-abc')).toBe('agent-abc');
    expect(worktreeAgentId('H:\\repo\\data\\cos\\worktrees\\claim-issue-42')).toBe('claim-issue-42');
    expect(isAgentWorktreeId('agent-abc')).toBe(true);
    expect(isAgentWorktreeId('next-issue-42')).toBe(false);
    expect(isHumanClaimWorktree('claim-issue-42')).toBe(true);
  });
});

describe('worktreeHoldExpiresAt', () => {
  const COS_ROOT = '/repo/data/cos/worktrees';
  const NOW = Date.parse('2026-01-10T00:00:00.000Z');
  const claim = (over = {}) => worktreeHoldExpiresAt({
    path: `${COS_ROOT}/claim-issue-42`, allowStaleClaim: true, ageMs: 2_000, staleClaimIdleMs: 7_000, nowMs: NOW, ...over
  });

  it('dates a stale-claim hold to the moment its window lapses', () => {
    expect(claim()).toBe(new Date(NOW + 5_000).toISOString());
  });

  it('gives no expiry to a claim tree that is ALSO locked', () => {
    // The slug still reads 'worktree-human-claim' (first match wins), but the
    // lock outlives the window — deriving a date from the slug alone would
    // promise a lift that never happens.
    expect(claim({ locked: true })).toBeNull();
  });

  it('gives no expiry to a claim tree whose agent is still live', () => {
    expect(worktreeHoldExpiresAt({
      path: `${COS_ROOT}/claim-issue-42`, allowStaleClaim: true, ageMs: 2_000, staleClaimIdleMs: 7_000,
      activeAgentIds: new Set(['claim-issue-42']), nowMs: NOW
    })).toBeNull();
  });

  it('gives no expiry when the caller has not opted into stale-claim reclamation', () => {
    // Without allowStaleClaim the window never lapses for this caller, so there
    // is no deadline to report.
    expect(claim({ allowStaleClaim: false })).toBeNull();
  });

  it('gives no expiry once the window has already lapsed, or when age is unknown', () => {
    expect(claim({ ageMs: 9_000 })).toBeNull();
    expect(claim({ ageMs: 7_000 })).toBeNull();
    for (const ageMs of [null, undefined, NaN, 'old']) expect(claim({ ageMs })).toBeNull();
    expect(claim({ staleClaimIdleMs: undefined })).toBeNull();
  });

  it('gives no expiry to holds that are not the stale-claim window', () => {
    expect(worktreeHoldExpiresAt({ path: `${COS_ROOT}/agent-live`, activeAgentIds: new Set(['agent-live']), ageMs: 2_000, staleClaimIdleMs: 7_000 })).toBeNull();
    expect(worktreeHoldExpiresAt({ path: null })).toBeNull();
    // A tree nothing holds at all has no expiry either — there is no wait.
    expect(worktreeHoldExpiresAt({ path: `${COS_ROOT}/agent-dead`, activeAgentIds: new Set(), ageMs: 2_000, staleClaimIdleMs: 7_000 })).toBeNull();
  });
});
